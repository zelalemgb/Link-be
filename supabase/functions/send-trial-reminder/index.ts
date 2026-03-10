// deno-lint-ignore-file no-explicit-any
/**
 * send-trial-reminder — Supabase Edge Function
 *
 * Sends trial lifecycle reminder emails and SMS to clinic admins.
 * Called by check-trial-expiry (scheduler) or directly.
 *
 * Channels:
 *   email   — Resend (https://resend.com) — recommended for production
 *   sms     — Telebirr SMS gateway / Africa's Talking
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY          — for email delivery
 *   AFRICAS_TALKING_API_KEY — for SMS delivery (optional)
 *   AFRICAS_TALKING_USERNAME
 *   APP_BASE_URL            — e.g. https://admin.linkhc.org
 *   FROM_EMAIL              — e.g. noreply@admin.linkhc.org
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGINS") || "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const APP_URL = Deno.env.get("APP_BASE_URL") || "https://admin.linkhc.org";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "noreply@admin.linkhc.org";

// ── Message templates ────────────────────────────────────────────────────────

interface ReminderTemplate {
  subject: string;
  emailHtml: (clinicName: string, daysLeft: number, upgradeUrl: string) => string;
  smsText: (clinicName: string, daysLeft: number, upgradeUrl: string) => string;
}

function makeTemplate(
  subject: string,
  headline: string,
  body: string,
  ctaLabel: string,
  daysLabel: string
): ReminderTemplate {
  return {
    subject,
    emailHtml: (clinicName, daysLeft, upgradeUrl) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <div style="background:#1a73e8;padding:20px;border-radius:8px 8px 0 0;text-align:center">
    <h1 style="color:#fff;margin:0">Link HC</h1>
    <p style="color:#cce4ff;margin:4px 0">Ethiopian Primary Healthcare Platform</p>
  </div>
  <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0">
    <p>Dear ${clinicName} Team,</p>
    <h2 style="color:#d32f2f">${headline}</h2>
    <p>${body.replace("{daysLeft}", String(daysLeft)).replace("{clinicName}", clinicName)}</p>
    <p>${daysLabel.replace("{daysLeft}", String(daysLeft))}</p>
    <div style="text-align:center;margin:32px 0">
      <a href="${upgradeUrl}" style="background:#1a73e8;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold">${ctaLabel}</a>
    </div>
    <p style="font-size:13px;color:#666">
      Payments accepted: <strong>Telebirr, CBE Birr, Amole, bank transfer</strong>, or contact your regional Link HC agent.
    </p>
  </div>
  <div style="padding:16px;text-align:center;color:#999;font-size:12px">
    <p>Link HC · Addis Ababa, Ethiopia · <a href="${APP_URL}">linkhc.et</a></p>
    <p>This is an automated service message. Contact support@admin.linkhc.org for help.</p>
  </div>
</body>
</html>`,
    smsText: (clinicName, daysLeft, upgradeUrl) =>
      `Link HC: ${headline} ${body
        .replace("{daysLeft}", String(daysLeft))
        .replace("{clinicName}", clinicName)
        .substring(0, 80)} Subscribe at: ${upgradeUrl}`,
  };
}

const TEMPLATES: Record<string, ReminderTemplate> = {
  day7: makeTemplate(
    "Your Link HC trial is going well — 23 days left",
    "23 Days of Free Trial Remaining",
    "Your clinic {clinicName} has been using Link HC for 7 days. You have 23 more free days.",
    "View Subscription Plans",
    "{daysLeft} days left in your free trial."
  ),
  day14: makeTemplate(
    "Link HC trial update — 16 days left",
    "16 Days of Free Trial Remaining",
    "Two weeks in! {clinicName} has recorded patient data and clinical decisions. Subscribe to keep access.",
    "Upgrade Now",
    "{daysLeft} days remaining."
  ),
  day21: makeTemplate(
    "Action needed: Link HC trial ending in 9 days",
    "Only 9 Days Left",
    "Your free trial for {clinicName} ends in 9 days. Subscribe now to ensure uninterrupted clinical operations.",
    "Subscribe — From 500 ETB/month",
    "{daysLeft} days until trial ends."
  ),
  day25: makeTemplate(
    "Urgent: Link HC trial ends in 5 days",
    "5 Days Remaining — Subscribe Now",
    "Your trial for {clinicName} ends in 5 days. After that you will enter a 7-day grace period with read-only access.",
    "Subscribe Before Trial Ends",
    "Only {daysLeft} days left!"
  ),
  day29: makeTemplate(
    "Final notice: Link HC trial ends tomorrow",
    "Trial Ends Tomorrow",
    "{clinicName} — Your 30-day free trial expires tomorrow. Subscribe today to maintain full access to patient records and clinical tools.",
    "Subscribe Now to Continue",
    "Last day: trial expires in {daysLeft} day(s)."
  ),
  expired: makeTemplate(
    "Your Link HC trial has ended — 7-day grace period started",
    "Trial Ended — Grace Period Active",
    "Your free trial for {clinicName} has ended. You now have a 7-day grace period with read-only access. New patient records cannot be created until you subscribe.",
    "Subscribe to Restore Full Access",
    "Grace period: {daysLeft} days remaining."
  ),
  grace_warning: makeTemplate(
    "Link HC subscription lapsed — grace period active",
    "Subscription Lapsed",
    "Your subscription for {clinicName} has expired. You are in a 7-day grace period. Renew now to avoid data access restrictions.",
    "Renew Subscription",
    "{daysLeft} days of grace period remaining."
  ),
  final_warning: makeTemplate(
    "URGENT: Link HC access being restricted for your clinic",
    "Access Restriction Starting",
    "The grace period for {clinicName} has ended. Your account is now restricted to read-only access. Subscribe immediately to restore clinical operations.",
    "Restore Access Now",
    "Your clinic has {daysLeft} days of read-only access before full suspension."
  ),
};

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { tenantId, reminderType, channel, sentTo } = (await req.json()) as {
      tenantId: string;
      reminderType: string;
      channel: "email" | "sms" | "whatsapp";
      sentTo: string;
    };

    if (!tenantId || !reminderType || !sentTo) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const template = TEMPLATES[reminderType];
    if (!template) {
      return new Response(JSON.stringify({ error: `Unknown reminder type: ${reminderType}` }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Fetch clinic name and days remaining
    const { data: tenant } = await sb
      .from("tenants")
      .select("name, trial_expires_at, subscription_expires_at, grace_expires_at, subscription_status")
      .eq("id", tenantId)
      .single();

    const clinicName = tenant?.name || "Your clinic";
    const upgradeUrl = `${APP_URL}/subscribe?tenant=${tenantId}`;

    let daysLeft = 0;
    const now = new Date();
    if (tenant?.subscription_status === "trial" && tenant.trial_expires_at) {
      daysLeft = Math.max(
        0,
        Math.ceil((new Date(tenant.trial_expires_at).getTime() - now.getTime()) / 86400000)
      );
    } else if (tenant?.subscription_status === "grace" && tenant.grace_expires_at) {
      daysLeft = Math.max(
        0,
        Math.ceil((new Date(tenant.grace_expires_at).getTime() - now.getTime()) / 86400000)
      );
    }

    let delivered = false;

    if (channel === "email") {
      delivered = await _sendEmail(
        sentTo,
        template.subject,
        template.emailHtml(clinicName, daysLeft, upgradeUrl)
      );
    } else if (channel === "sms" || channel === "whatsapp") {
      delivered = await _sendSms(sentTo, template.smsText(clinicName, daysLeft, upgradeUrl));
    }

    // Record in trial_reminder_logs regardless of delivery success
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

    return new Response(
      JSON.stringify({ success: true, delivered, reminderType, channel }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Unknown error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});

// ── Email via Resend ──────────────────────────────────────────────────────────

async function _sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — email not sent");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
      }),
    });
    return res.ok;
  } catch (_err) {
    return false;
  }
}

// ── SMS via Africa's Talking ─────────────────────────────────────────────────

async function _sendSms(to: string, message: string): Promise<boolean> {
  const AT_API_KEY = Deno.env.get("AFRICAS_TALKING_API_KEY");
  const AT_USERNAME = Deno.env.get("AFRICAS_TALKING_USERNAME");

  if (!AT_API_KEY || !AT_USERNAME) {
    console.warn("Africa's Talking credentials not set — SMS not sent");
    return false;
  }

  // Normalise phone to E.164 (+251...)
  const normalised = to.startsWith("+") ? to : to.startsWith("0") ? `+251${to.slice(1)}` : `+${to}`;

  try {
    const params = new URLSearchParams({
      username: AT_USERNAME,
      to: normalised,
      message: message.substring(0, 160),
      from: "LINKHC",
    });

    const res = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        apiKey: AT_API_KEY,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await res.json();
    return data?.SMSMessageData?.Recipients?.[0]?.status === "Success";
  } catch (_err) {
    return false;
  }
}
