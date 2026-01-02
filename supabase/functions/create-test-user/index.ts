// Supabase Edge Function: create-test-user
// Creates specific test users with confirmed emails using the service role
// This is intended for quickly provisioning demo accounts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET = Deno.env.get('EDGE_ADMIN_SECRET');

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface CreateTestUserPayload {
  email: string;
  password: string;
  role: string;
  name: string;
}

const ALLOWED_EMAILS = new Set([
  'lab@gmail.com',
  'imaging@gmail.com',
  'pharmacy@gmail.com',
  'logistic@gmail.com',
  'doctor@gmail.com',
  'nurse@gmail.com',
  'receptionist@gmail.com',
  'ceo@gmail.com',
  'admin@gmail.com',
  'finance@gmail.com',
  'cashier@gmail.com',
  'medical@gmail.com',
  'nursing@gmail.com',
  'medical-director@gmail.com',
  'nursing-head@gmail.com',
  'rhb@gmail.com',
  'admin@clinic.com',
  'ceo@clinic.com',
  'medical@clinic.com',
  'nursing@clinic.com',
  'finance@clinic.com',
  'cashier@clinic.com',
  'rhb@clinic.com',
]);

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGINS') || '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-edge-admin-secret',
    },
    ...init,
  });
}

// Ensure public.users profile exists and associate with Demo Clinic
async function ensureProfileAndFacility(args: {
  authUserId: string;
  role: string;
  email: string;
  name: string;
}) {
  const { authUserId, role, email, name } = args;

  // First, ensure Demo Clinic exists or get existing one
  let demoFacilityId: string | null = null;
  let demoAdminUserId: string | null = null;
  let demoTenantId: string | null = null;

  // Try to find Demo Clinic
  const { data: existingDemoClinic } = await supabaseAdmin
    .from('facilities')
    .select('id, admin_user_id, tenant_id')
    .eq('name', 'Demo Clinic')
    .maybeSingle();

  if (existingDemoClinic) {
    demoFacilityId = existingDemoClinic.id;
    demoAdminUserId = existingDemoClinic.admin_user_id;
    demoTenantId = existingDemoClinic.tenant_id;
  } else {
    // Create Demo Clinic if it doesn't exist - need a tenant and admin user first
    // Create a temporary admin user for the facility if this is an admin
    if (role === 'admin') {
      // First create tenant for demo clinic
      const { data: insertedTenant, error: insertTenantError } = await supabaseAdmin
        .from('tenants')
        .insert({
          name: 'Demo Tenant',
          is_active: true,
        })
        .select('id')
        .single();

      if (insertTenantError) {
        return { error: insertTenantError.message };
      }

      demoTenantId = insertedTenant.id;

      const { data: insertedProfile, error: insertProfileError } = await supabaseAdmin
        .from('users')
        .insert({
          auth_user_id: authUserId,
          name,
          user_role: role,
          verified: true,
          tenant_id: demoTenantId,
        })
        .select('id')
        .single();

      if (insertProfileError) {
        return { error: insertProfileError.message };
      }

      demoAdminUserId = insertedProfile.id;

      // Create Demo Clinic
      const { data: newFacility, error: createFacilityError } = await supabaseAdmin
        .from('facilities')
        .insert({
          name: 'Demo Clinic',
          location: 'Demo City',
          address: 'Demo Street, Demo City',
          phone_number: '',
          email,
          admin_user_id: demoAdminUserId,
          tenant_id: demoTenantId,
          verification_status: 'approved',
          verified: true,
        })
        .select('id')
        .single();

      if (createFacilityError) {
        return { error: createFacilityError.message };
      }

      demoFacilityId = newFacility.id;

      return { publicUserId: demoAdminUserId, facilityCreated: true, facilityId: demoFacilityId };
    }
  }

  // Ensure user profile exists
  const { data: existingProfile } = await supabaseAdmin
    .from('users')
    .select('id, facility_id, user_role, tenant_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  let publicUserId = existingProfile?.id as string | undefined;

  if (!publicUserId) {
    // Create user profile and associate with Demo Clinic
    const { data: insertedProfile, error: insertProfileError } = await supabaseAdmin
      .from('users')
      .insert({
        auth_user_id: authUserId,
        name,
        user_role: role,
        verified: true,
        facility_id: demoFacilityId,
        tenant_id: demoTenantId, // Critical: set tenant_id
      })
      .select('id')
      .single();

    if (insertProfileError) {
      return { error: insertProfileError.message };
    }

    publicUserId = insertedProfile.id;
  } else if (existingProfile && (!existingProfile.facility_id || !existingProfile.tenant_id) && demoFacilityId && demoTenantId) {
    // Update existing user to associate with Demo Clinic and tenant
    await supabaseAdmin
      .from('users')
      .update({ 
        facility_id: demoFacilityId,
        tenant_id: demoTenantId 
      })
      .eq('id', publicUserId);
  }

  return { publicUserId, facilityCreated: false, facilityId: demoFacilityId };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGINS') || '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-edge-admin-secret',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  if (!ADMIN_SECRET || req.headers.get('x-edge-admin-secret') !== ADMIN_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { email, password, role, name } = (await req.json()) as CreateTestUserPayload;

    if (!email || !password || !role || !name) {
      return jsonResponse({ error: 'Missing required fields' }, { status: 400 });
    }

    // Only allow specific demo accounts to be auto-created
    if (!ALLOWED_EMAILS.has(email)) {
      return jsonResponse({ error: 'Auto-creation not allowed for this email' }, { status: 403 });
    }

    // Find user by email (list and search)
    const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) {
      return jsonResponse({ error: listError.message }, { status: 400 });
    }
    const existingUser = listData?.users?.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());

    if (existingUser) {
      // Update password and confirm email for existing user
      const { data, error } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        password,
        email_confirm: true,
        user_metadata: {
          user_role: role,
          name,
        },
      });
      if (error) {
        return jsonResponse({ error: error.message }, { status: 400 });
      }

      // Ensure profile and facility
      const ensured = await ensureProfileAndFacility({ authUserId: existingUser.id, role, email, name });
      return jsonResponse({ success: true, created: false, updated: true, user_id: data.user?.id ?? existingUser.id, ensured });
    }

    // Create user if not found
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        user_role: role,
        name,
      },
    });

    if (error) {
      return jsonResponse({ error: error.message }, { status: 400 });
    }

    const authUserId = data.user?.id ?? '';

    // Ensure profile and facility
    const ensured = await ensureProfileAndFacility({ authUserId, role, email, name });

    return jsonResponse({ success: true, created: true, user_id: authUserId, ensured });
  } catch (e) {
    return jsonResponse({ error: (e as any)?.message ?? 'Unknown error' }, { status: 500 });
  }
});
