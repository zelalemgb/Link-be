// Supabase Edge Function: invitation-user-check
// Purpose: Determine whether the invited email already has a Supabase Auth account.
// Security: This endpoint only returns existence information for VALID, unexpired, unaccepted invitation tokens.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function authUserExistsByEmail(supabaseAdmin: ReturnType<typeof createClient>, email: string) {
  // GoTrue Admin API doesn't support a direct "get by email" call in supabase-js.
  // We scan pages until we either find the user or exhaust the list.
  const perPage = 200;
  let page = 1;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users ?? [];
    const match = users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (match) return true;

    // If we got fewer than perPage users, there are no more pages.
    if (users.length < perPage) return false;

    page += 1;
    // Safety cap (prevents runaway loops on unexpected pagination behavior)
    if (page > 50) return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "Server misconfigured" }, 500);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const payload = await req.json().catch(() => null);
    const invitation_token = payload?.invitation_token;

    if (typeof invitation_token !== "string" || invitation_token.trim().length < 10) {
      return jsonResponse({ error: "Invalid invitation token" }, 400);
    }

    const { data: invitation, error: inviteError } = await supabaseAdmin
      .from("staff_invitations")
      .select("email, expires_at, accepted")
      .eq("invitation_token", invitation_token)
      .maybeSingle();

    if (inviteError || !invitation) {
      return jsonResponse({ error: "Invalid invitation" }, 404);
    }

    if (invitation.accepted) {
      return jsonResponse({ error: "Invitation already accepted" }, 409);
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return jsonResponse({ error: "Invitation expired" }, 410);
    }

    const exists = await authUserExistsByEmail(supabaseAdmin, invitation.email);

    return jsonResponse({ auth_user_exists: exists });
  } catch (e) {
    console.error("invitation-user-check error", e);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
