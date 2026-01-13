// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

interface SuperAdminData {
  email: string;
  password: string;
  name: string;
}

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  try {
    const { email, password, name } = (await req.json()) as SuperAdminData;

    if (!email || !password || !name) {
      return new Response(JSON.stringify({ error: "Email, password, and name are required" }), { status: 400 });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Check if this specific email already exists
    const existingUser = await findAuthUserByEmail(sb, email);
    if (existingUser) {
      return new Response(
        JSON.stringify({ error: "User with this email already exists" }), 
        { status: 400 }
      );
    }

    // Get or create system tenant
    let tenantId: string;
    const { data: existingTenant } = await sb
      .from("tenants")
      .select("id")
      .eq("name", "System Administration")
      .single();

    if (existingTenant) {
      tenantId = existingTenant.id;
    } else {
      const { data: tenantInsert, error: tenantErr } = await sb
        .from("tenants")
        .insert({ name: "System Administration", is_active: true })
        .select("id")
        .single();
      if (tenantErr) {
        return new Response(JSON.stringify({ error: tenantErr.message }), { status: 500 });
      }
      tenantId = tenantInsert.id;
    }

    // Get or create system facility
    let facilityId: string;
    const { data: existingFacility } = await sb
      .from("facilities")
      .select("id")
      .eq("clinic_code", "SUPERADMIN")
      .single();

    if (existingFacility) {
      facilityId = existingFacility.id;
    } else {
      const { data: facilityInsert, error: facilityErr } = await sb
        .from("facilities")
        .insert({
          tenant_id: tenantId,
          name: "System Administration",
          address: "System",
          location: "System",
          phone_number: "000000000",
          email: email,
          facility_type: "admin",
          clinic_code: "SUPERADMIN",
          verification_status: "approved",
          verified: true,
        })
        .select("id")
        .single();
      if (facilityErr) {
        return new Response(JSON.stringify({ error: facilityErr.message }), { status: 500 });
      }
      facilityId = facilityInsert.id;
    }

    // Create super admin auth user
    console.log("Creating auth user for:", email);
    const { data: userCreate, error: adminErr } = await sb.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password: password,
      email_confirm: true,
      user_metadata: {
        name: name,
        full_name: name,
        user_role: "super_admin",
        role: "super_admin",
        facility_id: facilityId,
        tenant_id: tenantId,
        clinic_code: "SUPERADMIN",
      },
    });

    if (adminErr) {
      console.error("Admin user creation failed:", JSON.stringify(adminErr));
      return new Response(JSON.stringify({ 
        error: "Error creating auth user: " + (adminErr.message || JSON.stringify(adminErr))
      }), { status: 500 });
    }

    if (!userCreate?.user?.id) {
      console.error("No user ID returned from auth.admin.createUser");
      return new Response(JSON.stringify({ error: "No user ID returned" }), { status: 500 });
    }

    const authUserId = userCreate.user.id as string;
    console.log("Auth user created with ID:", authUserId);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Super admin created successfully",
        authUserId,
        tenantId,
        facilityId,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: corsHeaders });
  }
});
