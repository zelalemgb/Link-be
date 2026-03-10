// deno-lint-ignore-file no-explicit-any
/**
 * send-activation-code — Supabase Edge Function
 *
 * Delivers an offline license activation code to a clinic after payment.
 *
 * Delivery channels:
 *   sms       — Africa's Talking (works on any GSM phone, 2G+)
 *   whatsapp  — Twilio WhatsApp API
 *   email     — Resend
 *
 * The activation code format:  LNKH-XXXX-XXXX-XXXX
 * Clinic staff type this code into the Link Hub desktop app to activate
 * their offline license without internet.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   AFRICAS_TALKING_API_KEY, AFRICAS_TALKING_USERNAME
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *   APP_BASE_URL
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGINS") || "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-edge-admin-secret",
};

const APP_URL = Deno.env.get("APP_BASE_URL") || "https://admin.linkhc.org";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "noreply@admin.linkhc.org";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      licenseKeyId,
      tenantId,
      activationCode,
      tier,
      expiresAt,
      recipientPhone,
      recipientEmail,
      clinicName,
      channel = "sms",
    } = (await req.json()) as {
      licenseKeyId: string;
      tenantId: string;
      activationCode: string;
      tier: string;
      expiresAt: string;
      recipientPhone?: string;
      recipientEmail?: string;
      clinicName?: string;
      channel?: "sms" | "whatsapp" | "email";
    };

    if (!licenseKeyId || !activationCode) {
      return new Response(
        JSON.stringify({ error: "licenseKeyId and activationCode required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // If no tenantId passed, fetch from license_keys
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    let name = clinicName || "Your clinic";
    let phone = recipientPhone;
    let email = recipientEmail;
    let resolvedTenantId = tenantId;

    // Enrich from DB if needed
    if (!phone && !email) {
      const { data: lk } = await sb
        .from("license_keys")
        .select("tenant_id, tier, expires_at")
        .eq("id", licenseKeyId)
        .single();

      if (lk) {
        resolvedTenantId = resolvedTenantId || lk.tenant_id;
      }

      if (resolvedTenantId) {
        const { data: tenant } = await sb
          .from("tenants")
          .select("name, contact_phone, contact_email")
          .eq("id", resolvedTenantId)
          .single();

        if (tenant) {
          name = tenant.name || name;
          phone = phone || tenant.contact_phone;
          email = email || tenant.contact_email;
        }
      }
    }

    const expiry = expiresAt
      ? new Date(expiresAt).toLocaleDateString("en-ET", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "12 months";

    const tierLabel: Record<string, string> = {
      health_post: "Health Post",
      health_centre: "Health Centre",
      primary_hospital: "Primary Hospital",
      general_hospital: "General Hospital",
      enterprise: "Enterprise",
    };

    const planName = tierLabel[tier] || tier;

    // ── Build messages ────────────────────────────────────────────────────────

    const smsMessage = [
      `Link HC Activation Code for ${name}:`,
      ``,
      `CODE: ${activationCode}`,
      ``,
      `Plan: ${planName}`,
      `Valid until: ${expiry}`,
      ``,
      `Enter this code in the Link Hub app Settings → Activate License.`,
      `Support: support@admin.linkhc.org`,
    ].join("\n");

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Link HC License Activation Code</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <div style="background:#1a73e8;padding:20px;border-radius:8px 8px 0 0;text-align:center">
    <h1 style="color:#fff;margin:0">Link HC</h1>
    <p style="color:#cce4ff;margin:4px 0">Offline License Activation</p>
  </div>
  <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0">
    <p>Dear <strong>${name}</strong> team,</p>
    <p>Your payment has been confirmed. Your offline license activation code is below.</p>

    <div style="background:#fff;border:2px solid #1a73e8;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
      <p style="font-size:13px;color:#666;margin:0 0 8px">Your Activation Code</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:4px;color:#1a73e8;font-family:monospace;margin:0">
        ${activationCode}
      </p>
      <p style="font-size:13px;color:#888;margin:8px 0 0">Plan: ${planName} · Valid until: ${expiry}</p>
    </div>

    <h3>How to activate your Link Hub:</h3>
    <ol style="padding-left:20px;line-height:2">
      <li>Open the <strong>Link Hub</strong> application on your clinic server</li>
      <li>Go to <strong>Settings → License → Activate</strong></li>
      <li>Enter the activation code above</li>
      <li>All departments connected to the Hub will be activated automatically</li>
    </ol>

    <p style="color:#666;font-size:13px">
      This code can only be used once per Hub installation. If you need to re-activate
      (e.g. after re-installing the Hub), contact support@admin.linkhc.org or your regional agent.
    </p>

    <p style="font-size:13px;color:#666">
      Need help? Call your regional Link HC agent or email <a href="mailto:support@admin.linkhc.org">support@admin.linkhc.org</a>
    </p>
  </div>
  <div style="padding:16px;text-align:center;color:#999;font-size:12px">
    <p>Link HC · Addis Ababa, Ethiopia · <a href="${APP_URL}">linkhc.et</a></p>
  </div>
</body>
</html>`;

    // ── Deliver ───────────────────────────────────────────────────────────────

    let delivered = false;
    let deliveredVia = channel;

    if (channel === "sms" && phone) {
      delivered = await _sendSms(phone, smsMessage);
    } else if (channel === "whatsapp" && phone) {
      delivered = await _sendWhatsApp(phone, smsMessage);
    } else if (channel === "email" && email) {
      delivered = await _sendEmail(
        email,
        `Link HC License Activation Code — ${name}`,
        emailHtml
      );
    } else {
      // Fallback: try all channels
      if (phone) {
        delivered = await _sendSms(phone, smsMessage);
        deliveredVia = "sms";
      }
      if (!delivered && email) {
        delivered = await _sendEmail(
          email,
          `Link HC License Activation Code — ${name}`,
          emailHtml
        );
        deliveredVia = "email";
      }
    }

    // Update license_keys delivery tracking
    if (delivered) {
      await sb
        .from("license_keys")
        .update({
          delivered_via: deliveredVia,
          delivered_at: new Date().toISOString(),
        })
        .eq("id", licenseKeyId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        delivered,
        channel: deliveredVia,
        recipientMasked: phone
          ? `****${phone.slice(-4)}`
          : email
          ? `${email.split("@")[0].substring(0, 3)}***@${email.split("@")[1]}`
          : "unknown",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Unknown error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});

// ── Delivery helpers ──────────────────────────────────────────────────────────

async function _sendSms(to: string, message: string): Promise<boolean> {
  const AT_API_KEY = Deno.env.get("AFRICAS_TALKING_API_KEY");
  const AT_USERNAME = Deno.env.get("AFRICAS_TALKING_USERNAME");
  if (!AT_API_KEY || !AT_USERNAME) return false;

  const normalised = to.startsWith("+") ? to : to.startsWith("0") ? `+251${to.slice(1)}` : `+${to}`;

  try {
    const params = new URLSearchParams({
      username: AT_USERNAME,
      to: normalised,
      message: message.substring(0, 459), // AT supports long SMS (3 parts)
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
  } catch {
    return false;
  }
}

async function _sendWhatsApp(to: string, message: string): Promise<boolean> {
  const SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  const FROM = Deno.env.get("TWILIO_WHATSAPP_FROM"); // e.g. "whatsapp:+14155238886"
  if (!SID || !TOKEN || !FROM) return false;

  const normalised = to.startsWith("+") ? to : to.startsWith("0") ? `+251${to.slice(1)}` : `+${to}`;

  try {
    const params = new URLSearchParams({
      From: FROM,
      To: `whatsapp:${normalised}`,
      Body: message,
    });

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${SID}:${TOKEN}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await res.json();
    return data?.status === "queued" || data?.status === "sent";
  } catch {
    return false;
  }
}

async function _sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) return false;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
