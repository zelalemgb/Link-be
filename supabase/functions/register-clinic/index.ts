// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGINS") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-edge-admin-secret",
};

const ADMIN_SECRET = Deno.env.get("EDGE_ADMIN_SECRET");

const isAuthorized = (req: Request) => {
  const headerSecret = req.headers.get("x-edge-admin-secret");
  return ADMIN_SECRET && headerSecret === ADMIN_SECRET;
};

type AuthUser = {
  id?: string;
  email?: string | null;
};

const findAuthUserByEmail = async (client: ReturnType<typeof createClient>, email: string) => {
  const normalized = email.trim().toLowerCase();
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = (data?.users ?? []) as AuthUser[];
    const match = users.find((user) => user.email?.toLowerCase() === normalized);
    if (match) return match;
    if (users.length < perPage) break;
  }

  return null;
};

interface ClinicData {
  name: string;
  location: string;
  address: string;
  phoneNumber: string;
  email: string | null;
  country?: string | null;
}

interface AdminData {
  name: string;
  email: string;
  password: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const { clinic, admin } = (await req.json()) as { clinic: ClinicData; admin: AdminData };

    if (!clinic?.name || !clinic?.location || !clinic?.address || !clinic?.phoneNumber) {
      return new Response(JSON.stringify({ error: "Invalid clinic data" }), { status: 400, headers: corsHeaders });
    }
    if (!admin?.email || !admin?.password || !admin?.name) {
      return new Response(JSON.stringify({ error: "Invalid admin data" }), { status: 400, headers: corsHeaders });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers: corsHeaders });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 1) Create tenant
    const { data: tenantInsert, error: tenantErr } = await sb
      .from("tenants")
      .insert({ name: clinic.name, is_active: true })
      .select("id")
      .single();

    if (tenantErr) {
      return new Response(JSON.stringify({ error: tenantErr.message }), { status: 500, headers: corsHeaders });
    }

    const tenantId = tenantInsert.id as string;

    // 2) Generate clinic code
    const { data: codeData, error: codeErr } = await sb.rpc("generate_clinic_code", {
      clinic_name_input: clinic.name,
    });

    if (codeErr) {
      return new Response(JSON.stringify({ error: codeErr.message }), { status: 500, headers: corsHeaders });
    }

    const clinicCode = (codeData as string) || null;

    // 3) Create facility
    const facilityPayload = {
      tenant_id: tenantId,
      name: clinic.name,
      address: clinic.address,
      location: clinic.location,
      phone_number: clinic.phoneNumber,
      email: clinic.email,
      facility_type: "clinic",
      clinic_code: clinicCode,
      verification_status: "approved",
      verified: true,
    } as Record<string, unknown>;
    console.log("register-clinic facility payload:", JSON.stringify(facilityPayload));

    const { data: facilityInsert, error: facilityErr } = await sb
      .from("facilities")
      .insert(facilityPayload)
      .select("id, tenant_id, clinic_code")
      .single();

    if (facilityErr) {
      return new Response(JSON.stringify({ error: facilityErr.message }), { status: 500, headers: corsHeaders });
    }

    const facilityId = facilityInsert.id as string;

    // 4) Create admin auth user and attach to facility via metadata
    const { data: userCreate, error: adminErr } = await sb.auth.admin.createUser({
      email: admin.email.trim().toLowerCase(),
      password: admin.password,
      email_confirm: true,
      user_metadata: {
        name: admin.name,
        full_name: admin.name,
        user_role: "admin",
        role: "admin",
        facility_id: facilityId,
        tenant_id: tenantId,
        clinic_code: clinicCode,
      },
    });

    let authUserId = userCreate.user?.id as string | undefined;

    if (adminErr) {
      // If the email is already registered, attach existing user to this clinic
      const msg = adminErr.message?.toLowerCase?.() || "";
      if (msg.includes("already registered") || msg.includes("duplicate") || msg.includes("user exists")) {
        const existingUser = await findAuthUserByEmail(sb, admin.email);
        if (!existingUser?.id) {
          return new Response(JSON.stringify({ error: adminErr.message }), { status: 500 });
        }
        authUserId = existingUser.id as string;

        // Ensure public.users row exists and is associated
        const { data: existingUserRow } = await sb
          .from("users")
          .select("id")
          .eq("auth_user_id", authUserId)
          .maybeSingle();

        if (existingUserRow?.id) {
          await sb
            .from("users")
            .update({
              tenant_id: tenantId,
              facility_id: facilityId,
              user_role: "admin",
              full_name: admin.name,
              email: admin.email.trim().toLowerCase(),
              status: "active",
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingUserRow.id);
        } else {
          await sb
            .from("users")
            .insert({
              auth_user_id: authUserId,
              full_name: admin.name,
              email: admin.email.trim().toLowerCase(),
              user_role: "admin",
              tenant_id: tenantId,
              facility_id: facilityId,
              status: "active",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
        }
      } else {
        return new Response(JSON.stringify({ error: adminErr.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Ensure user row exists even when admin user was created successfully
    if (authUserId) {
      const { data: existingUserRow } = await sb
        .from("users")
        .select("id")
        .eq("auth_user_id", authUserId)
        .maybeSingle();

      if (existingUserRow?.id) {
        await sb
          .from("users")
          .update({
            tenant_id: tenantId,
            facility_id: facilityId,
            user_role: "admin",
            full_name: admin.name,
            email: admin.email.trim().toLowerCase(),
            status: "active",
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingUserRow.id);
      } else {
        await sb
          .from("users")
          .insert({
            auth_user_id: authUserId,
            full_name: admin.name,
            email: admin.email.trim().toLowerCase(),
            user_role: "admin",
            tenant_id: tenantId,
            facility_id: facilityId,
            status: "active",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
      }

      // 5) Set facility admin_user_id to auth uid
      await sb.from("facilities").update({ admin_user_id: authUserId }).eq("id", facilityId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        facilityId,
        tenantId,
        clinicCode,
        authUserId,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
