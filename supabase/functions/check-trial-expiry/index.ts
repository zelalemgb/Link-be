// deno-lint-ignore-file no-explicit-any
/**
 * check-trial-expiry  — Nightly Supabase Edge Function (cron)
 *
 * Transitions tenants through the subscription lifecycle:
 *   trial   → grace   (when trial_expires_at < now)
 *   grace   → restricted (when grace_expires_at < now)
 *   active  → grace   (when subscription_expires_at < now)
 *
 * Queues trial-reminder emails for tenants approaching expiry.
 *
 * Schedule: configure in Supabase Dashboard → Edge Functions → Schedules
 *   Recommended: "0 2 * * *"  (2 AM UTC daily)
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EDGE_ADMIN_SECRET
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGINS") || "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-edge-admin-secret",
};

const ADMIN_SECRET = Deno.env.get("EDGE_ADMIN_SECRET");
// Grace period after trial ends: 7 days
const GRACE_DAYS = 7;
// Reminder milestones (days since trial start)
const REMINDER_DAYS: Record<string, number> = {
  day7: 7,
  day14: 14,
  day21: 21,
  day25: 25,
  day29: 29,
};

function isAuthorized(req: Request): boolean {
  // Allow Supabase scheduler (no secret) OR admin secret
  const headerSecret = req.headers.get("x-edge-admin-secret");
  if (!ADMIN_SECRET) return true; // no secret configured → allow cron
  return headerSecret === ADMIN_SECRET;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const now = new Date().toISOString();
  const results: Record<string, number> = {
    trial_to_grace: 0,
    grace_to_restricted: 0,
    active_to_grace: 0,
    reminders_queued: 0,
  };

  // ── 1. Trial → Grace ────────────────────────────────────────────────────────
  const { data: expiredTrials, error: e1 } = await sb
    .from("tenants")
    .select("id, trial_expires_at, contact_email, contact_phone, name")
    .eq("subscription_status", "trial")
    .lt("trial_expires_at", now);

  if (!e1 && expiredTrials && expiredTrials.length > 0) {
    for (const t of expiredTrials) {
      const graceExpires = new Date(
        new Date(t.trial_expires_at).getTime() + GRACE_DAYS * 86400 * 1000
      ).toISOString();

      await sb
        .from("tenants")
        .update({
          subscription_status: "grace",
          grace_expires_at: graceExpires,
        })
        .eq("id", t.id);

      // Queue expired reminder
      await _queueReminder(sb, t.id, "expired", t.contact_email, t.contact_phone);
      results.trial_to_grace++;
    }
  }

  // ── 2. Grace → Restricted ───────────────────────────────────────────────────
  const { data: expiredGrace, error: e2 } = await sb
    .from("tenants")
    .select("id, grace_expires_at, contact_email, contact_phone, name")
    .eq("subscription_status", "grace")
    .lt("grace_expires_at", now);

  if (!e2 && expiredGrace && expiredGrace.length > 0) {
    const ids = expiredGrace.map((t: any) => t.id);
    await sb
      .from("tenants")
      .update({ subscription_status: "restricted" })
      .in("id", ids);

    for (const t of expiredGrace) {
      await _queueReminder(sb, t.id, "final_warning", t.contact_email, t.contact_phone);
    }
    results.grace_to_restricted = ids.length;
  }

  // ── 3. Active → Grace (subscription renewal lapsed) ────────────────────────
  const { data: lapsedActive, error: e3 } = await sb
    .from("tenants")
    .select("id, subscription_expires_at, contact_email, contact_phone")
    .eq("subscription_status", "active")
    .not("subscription_expires_at", "is", null)
    .lt("subscription_expires_at", now);

  if (!e3 && lapsedActive && lapsedActive.length > 0) {
    for (const t of lapsedActive) {
      const graceExpires = new Date(
        new Date(t.subscription_expires_at).getTime() + GRACE_DAYS * 86400 * 1000
      ).toISOString();

      await sb
        .from("tenants")
        .update({
          subscription_status: "grace",
          grace_expires_at: graceExpires,
        })
        .eq("id", t.id);

      await _queueReminder(sb, t.id, "grace_warning", t.contact_email, t.contact_phone);
      results.active_to_grace++;
    }
  }

  // ── 4. Queue upcoming trial reminder emails ──────────────────────────────────
  // For each milestone in REMINDER_DAYS, find trials that crossed the threshold today
  // and haven't yet received that reminder.
  const msPerDay = 86400 * 1000;

  for (const [reminderType, daysOffset] of Object.entries(REMINDER_DAYS)) {
    // Tenants whose trial started daysOffset ± 1 day ago
    const windowStart = new Date(Date.now() - (daysOffset + 1) * msPerDay).toISOString();
    const windowEnd = new Date(Date.now() - (daysOffset - 1) * msPerDay).toISOString();

    const { data: upcoming } = await sb
      .from("tenants")
      .select("id, trial_started_at, contact_email, contact_phone, name")
      .eq("subscription_status", "trial")
      .gte("trial_started_at", windowStart)
      .lte("trial_started_at", windowEnd);

    if (!upcoming) continue;

    for (const t of upcoming) {
      // Check if reminder already sent (dedup)
      const { data: existing } = await sb
        .from("trial_reminder_logs")
        .select("id")
        .eq("tenant_id", t.id)
        .eq("reminder_type", reminderType)
        .maybeSingle();

      if (existing) continue;

      // Invoke send-trial-reminder function
      const sent = await _queueReminder(sb, t.id, reminderType as any, t.contact_email, t.contact_phone);
      if (sent) results.reminders_queued++;
    }
  }

  return new Response(JSON.stringify({ success: true, timestamp: now, ...results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

/** Invokes send-trial-reminder and logs it to trial_reminder_logs */
async function _queueReminder(
  sb: ReturnType<typeof createClient>,
  tenantId: string,
  reminderType: string,
  email: string | null,
  phone: string | null
): Promise<boolean> {
  const channel = email ? "email" : phone ? "sms" : null;
  const sentTo = email || phone;
  if (!sentTo || !channel) return false;

  try {
    // Invoke send-trial-reminder as a background task
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    await fetch(`${SUPABASE_URL}/functions/v1/send-trial-reminder`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ tenantId, reminderType, channel, sentTo }),
    });

    // Log (will be deduplicated by UNIQUE constraint in trial_reminder_logs)
    await sb.from("trial_reminder_logs").upsert(
      {
        tenant_id: tenantId,
        reminder_type: reminderType,
        sent_to: sentTo,
        channel,
        sent_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,reminder_type", ignoreDuplicates: true }
    );

    return true;
  } catch (_err) {
    return false;
  }
}
