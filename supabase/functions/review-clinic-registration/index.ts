import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Resend } from 'https://esm.sh/resend@2.0.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const FRONTEND_URL = Deno.env.get('FRONTEND_URL') ?? 'https://linkhc.org';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const normalizeFrontendOrigin = (value: string) => value.replace(/#.*$/, '').replace(/\/+$/, '');

const buildClinicOnboardingUrl = (facilityId: string, adminEmail: string) => {
  // The web app uses HashRouter in production (/#/...), so keep hash routes to avoid
  // depending on server-side rewrites for deep links.
  const origin = normalizeFrontendOrigin(FRONTEND_URL);
  return `${origin}/#/auth/clinic-onboarding?facility=${facilityId}&email=${encodeURIComponent(adminEmail)}`;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
    ...init,
  });

// NOTE: The frontend's Supabase invoke wrapper surfaces very little detail on non-2xx responses.
// For this internal admin workflow, we return 200 with { success:false, error } so UI can
// display actionable messages instead of a generic "non-2xx" toast.
const ok = (body: unknown) => jsonResponse(body, { status: 200 });
const fail = (message: string) => ok({ success: false, error: message });

type AuthUser = {
  id?: string;
  email?: string | null;
};

const findAuthUserByEmail = async (email: string) => {
  const normalized = email.trim().toLowerCase();
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error('Error listing auth users:', error);
      throw new Error(error.message);
    }
    const users = (data?.users ?? []) as AuthUser[];
    const match = users.find((user) => user.email?.toLowerCase() === normalized);
    if (match) return match;
    if (users.length < perPage) break;
  }

  return null;
};

const getAuthClient = (req: Request) => {
  const authHeader = req.headers.get('Authorization') ?? '';
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
};

const sendApprovalEmail = async (
  adminEmail: string,
  adminName: string,
  clinicName: string,
  clinicCode: string | null,
  facilityId: string,
  activationStatus: 'testing' | 'active'
) => {
  if (!resend) {
    console.log('Resend not configured, skipping email');
    return { success: false, message: 'Resend not configured' };
  }

  try {
    const onboardingUrl = buildClinicOnboardingUrl(facilityId, adminEmail);
    
    const isFullActivation = activationStatus === 'active';
    const emailSubject = isFullActivation 
      ? `🎉 ${clinicName} is Now Fully Activated on Link Health!`
      : `Welcome to Link Health - ${clinicName} is Approved for Testing!`;
    const headerTitle = isFullActivation 
      ? '🚀 Full Activation Complete!'
      : '🎉 Welcome to Link Health!';
    const headerSubtitle = isFullActivation 
      ? 'Your clinic now has full access'
      : 'Your clinic has been approved for testing';

    const emailResponse = await resend.emails.send({
      from: 'Link Health <noreply@admin.linkhc.org>',
      to: [adminEmail],
      subject: emailSubject,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">${headerTitle}</h1>
            <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">${headerSubtitle}</p>
          </div>
          
          <div style="background: #f8fafc; padding: 30px; border: 1px solid #e2e8f0; border-top: none;">
            <p style="font-size: 16px; margin-top: 0;">Dear <strong>${adminName}</strong>,</p>
            
            ${isFullActivation ? `
            <p>Great news! <strong>${clinicName}</strong> has been fully activated on the Link Health platform!</p>
            <p>You now have access to all features and can fully operate your clinic with no limitations.</p>
            ` : `
            <p>We are pleased to inform you that <strong>${clinicName}</strong> has been approved to join the Link Health platform in <strong>testing mode</strong>!</p>
            <p>During the testing phase, you can explore the system, configure your clinic, and get familiar with all features.</p>
            `}
            
            ${clinicCode ? `
            <div style="background: white; border: 2px solid #0ea5e9; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
              <p style="margin: 0 0 5px 0; color: #64748b; font-size: 14px;">Your Clinic Code</p>
              <p style="margin: 0; font-size: 28px; font-weight: bold; color: #0ea5e9; letter-spacing: 2px;">${clinicCode}</p>
              <p style="margin: 10px 0 0 0; color: #64748b; font-size: 12px;">Share this code with your staff to join your clinic</p>
            </div>
            ` : ''}
            
            <h2 style="color: #0ea5e9; font-size: 18px; margin-top: 25px;">📋 ${isFullActivation ? 'What You Can Do Now' : 'Getting Started'}</h2>
            
            <div style="background: white; border-radius: 8px; padding: 20px; margin: 15px 0;">
              <ol style="margin: 0; padding-left: 20px;">
                ${isFullActivation ? `
                <li style="margin-bottom: 12px;">
                  <strong>Full Feature Access</strong> - All system features are now available for your clinic.
                </li>
                <li style="margin-bottom: 12px;">
                  <strong>Unlimited Usage</strong> - No trial limitations on patients, visits, or staff members.
                </li>
                <li style="margin-bottom: 12px;">
                  <strong>Priority Support</strong> - Access to our support team for any questions or assistance.
                </li>
                <li style="margin-bottom: 0;">
                  <strong>Continue Growing</strong> - Your existing data and configurations are preserved.
                </li>
                ` : `
                <li style="margin-bottom: 12px;">
                  <strong>Create your account</strong> - Click the button below to set up your password and access your admin dashboard.
                </li>
                <li style="margin-bottom: 12px;">
                  <strong>Configure your clinic</strong> - Set up your medical services, departments, and staff roles.
                </li>
                <li style="margin-bottom: 12px;">
                  <strong>Invite your team</strong> - Use the staff management section to invite doctors, nurses, and other healthcare professionals.
                </li>
                <li style="margin-bottom: 12px;">
                  <strong>Set up master data</strong> - Configure lab tests, medications, imaging studies, and other clinical data.
                </li>
                <li style="margin-bottom: 0;">
                  <strong>Test the workflow</strong> - Register test patients and go through the clinical workflow to get familiar with the system.
                </li>
                `}
              </ol>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${onboardingUrl}" style="display: inline-block; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: white; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">${isFullActivation ? 'Access Your Dashboard' : 'Create Your Account'}</a>
            </div>
            
            ${!isFullActivation ? `
            <div style="background: #dbeafe; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
              <p style="margin: 0; color: #1e40af; font-size: 14px;">
                <strong>📋 Testing Phase:</strong> During testing, you can explore all features. Once you're ready for full operation, contact us to activate your clinic fully.
              </p>
            </div>
            ` : ''}
            
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
              <p style="margin: 0; color: #92400e; font-size: 14px;">
                <strong>💡 Tip:</strong> Share the clinic code <strong>${clinicCode || 'from your dashboard'}</strong> with your staff so they can join your facility through the "Join Facility" option during registration.
              </p>
            </div>
            
            <p>If you have any questions or need assistance getting started, our support team is here to help.</p>
            
            <p style="margin-bottom: 0;">${isFullActivation ? 'Thank you for choosing Link Health!' : 'Welcome aboard!'}</p>
            <p style="margin-top: 5px; color: #64748b;">The Link Health Team</p>
          </div>
          
          <div style="text-align: center; padding: 20px; color: #94a3b8; font-size: 12px;">
            <p style="margin: 0;">© ${new Date().getFullYear()} Link Health. All rights reserved.</p>
            <p style="margin: 5px 0 0 0;">Transforming Healthcare in Africa</p>
          </div>
        </body>
        </html>
      `,
    });

    console.log(`Approval email sent successfully to ${adminEmail}:`, emailResponse);
    return { success: true, emailId: emailResponse?.data?.id };
  } catch (error) {
    console.error('Failed to send approval email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

const resolveAdminContact = async (facilityId: string, fallback?: { admin_name?: string; admin_email?: string }) => {
  let adminEmail = fallback?.admin_email?.trim() ?? '';
  const hasExplicitName = Boolean(fallback?.admin_name?.trim());
  let adminName = fallback?.admin_name?.trim() || 'Administrator';
  const maybeUpdateName = (candidate?: string | null) => {
    if (!hasExplicitName && candidate) {
      adminName = candidate;
    }
  };

  if (!adminEmail) {
    const { data: adminUser, error: adminUserError } = await supabaseAdmin
      .from('users')
      .select('auth_user_id, email, name, full_name')
      .eq('facility_id', facilityId)
      .eq('user_role', 'admin')
      .maybeSingle();

    if (adminUserError) {
      console.log('Error querying users table for admin:', adminUserError.message);
    }

    if (adminUser?.email) {
      adminEmail = adminUser.email;
      maybeUpdateName(adminUser.full_name || adminUser.name);
    } else if (adminUser?.auth_user_id) {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(adminUser.auth_user_id);
      if (authError) {
        console.log('Error fetching auth user for admin:', authError.message);
      }
      if (authData?.user?.email) {
        adminEmail = authData.user.email;
        maybeUpdateName(adminUser.full_name || adminUser.name);
      }
    }
  }

  if (!adminEmail) {
    const { data: registration, error: registrationError } = await supabaseAdmin
      .from('clinic_registrations')
      .select('admin_email, admin_name')
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (registrationError) {
      console.log('Error querying clinic_registrations for admin:', registrationError.message);
    }

    if (registration?.admin_email) {
      adminEmail = registration.admin_email;
      maybeUpdateName(registration.admin_name);
    }
  }

  if (!adminEmail) {
    const { data: facility, error: facilityError } = await supabaseAdmin
      .from('facilities')
      .select('email, notes')
      .eq('id', facilityId)
      .maybeSingle();

    if (facilityError) {
      console.log('Error querying facilities for admin:', facilityError.message);
    }

    if (facility?.email) {
      adminEmail = facility.email;
    } else if (facility?.notes) {
      try {
        const parsed = typeof facility.notes === 'string' ? JSON.parse(facility.notes) : facility.notes;
        if (parsed?.admin_email) {
          adminEmail = parsed.admin_email;
          maybeUpdateName(parsed.admin_name);
        }
      } catch (parseError) {
        console.error('Failed to parse facilities.notes:', parseError);
      }
    }
  }

  if (!adminEmail) {
    return null;
  }

  return { adminEmail, adminName };
};

interface ReviewPayload {
  registrationId?: string;
  action?: 'approve' | 'reject';
  rejectionReason?: string;
  activationType?: 'testing' | 'active';
}

Deno.serve(async (req) => {
  console.log('review-clinic-registration called:', req.method);
  
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return fail('Method not allowed');
  }

  const authClient = getAuthClient(req);
  const { data: authResult } = await authClient.auth.getUser();

  if (!authResult?.user) {
    console.log('Unauthorized: No user found');
    return fail('Unauthorized');
  }

  // Use limit(1) to handle multi-facility users who have multiple user records
  const { data: reviewerProfiles, error: reviewerError } = await supabaseAdmin
    .from('users')
    .select('id, user_role')
    .eq('auth_user_id', authResult.user.id)
    .limit(1);

  if (reviewerError) {
    console.error('Error fetching reviewer profile:', reviewerError);
    return fail(reviewerError.message);
  }

  const reviewerProfile = reviewerProfiles?.[0];
  const reviewerUserId = reviewerProfile?.id ?? null;
  let isSuperAdmin = false;
  
  // Check super_admin via multiple methods
  if (reviewerProfile) {
    // Method 1: Check legacy user_role column
    isSuperAdmin = reviewerProfile.user_role === 'super_admin';
    
    // Method 2: Check RBAC system
    if (!isSuperAdmin) {
      const { data: rbacRoles } = await supabaseAdmin
        .from('user_roles')
        .select('role:role_id(slug)')
        .eq('user_id', reviewerProfile.id);
      
      if (rbacRoles && rbacRoles.length > 0) {
        isSuperAdmin = rbacRoles.some((r: any) => r.role?.slug === 'super-admin');
      }
      console.log('RBAC check result:', { rbacRoles, isSuperAdmin });
    }
  }
  
  // Method 3: Fallback - check auth metadata for super admins without public.users record
  if (!isSuperAdmin) {
    const userMetadata = authResult.user.user_metadata;
    const appMetadata = authResult.user.app_metadata;
    
    isSuperAdmin = 
      userMetadata?.user_role === 'super_admin' ||
      userMetadata?.role === 'super_admin' ||
      appMetadata?.role === 'super_admin';
    
    console.log('Auth metadata check:', { 
      userMetadata: userMetadata?.user_role || userMetadata?.role,
      appMetadata: appMetadata?.role,
      isSuperAdmin 
    });
  }

  if (!isSuperAdmin) {
    console.log('Forbidden: User is not super_admin (checked users table, RBAC, and auth metadata)');
    return fail('Forbidden');
  }
  
  console.log('Super admin verified:', { reviewer_user_id: reviewerUserId, auth_user_id: authResult.user.id });

  let payload: ReviewPayload;

  try {
    payload = await req.json();
    console.log('Received payload:', JSON.stringify(payload));
  } catch {
    return fail('Invalid JSON payload');
  }

  const { registrationId, action, rejectionReason, activationType = 'testing' } = payload;

  if (!registrationId || !action) {
    return fail('registrationId and action are required');
  }

  console.log(`Processing ${action} for registration ${registrationId} with activationType: ${activationType}`);

  // First check clinic_registrations table (legacy flow)
  const { data: registration, error: registrationError } = await supabaseAdmin
    .from('clinic_registrations')
    .select('*')
    .eq('id', registrationId)
    .maybeSingle();

  if (registrationError) {
    console.error('Error checking clinic_registrations:', registrationError);
  }

  // If not found in clinic_registrations, check facilities table (new flow)
  if (!registration) {
    console.log('Registration not found in clinic_registrations, checking facilities table...');
    
    const { data: facility, error: facilityError } = await supabaseAdmin
      .from('facilities')
      .select('*')
      .eq('id', registrationId)
      .maybeSingle();

    if (facilityError) {
      console.error('Error fetching facility:', facilityError);
      return fail(facilityError.message);
    }

    if (!facility) {
      return fail('Registration not found in either table');
    }

    if (facility.verification_status !== 'pending') {
      return fail('Facility already reviewed');
    }

    // Parse admin info from notes
    let adminInfo = { admin_name: 'Administrator', admin_email: '', admin_phone: '' };
    try {
      if (facility.notes) {
        const parsed = typeof facility.notes === 'string' ? JSON.parse(facility.notes) : facility.notes;
        adminInfo = {
          admin_name: parsed.admin_name || 'Administrator',
          admin_email: parsed.admin_email || '',
          admin_phone: parsed.admin_phone || ''
        };
      }
    } catch (e) {
      console.error('Failed to parse facility notes:', e);
    }

    if (action === 'reject') {
      const { error: updateError } = await supabaseAdmin
        .from('facilities')
        .update({
          verification_status: 'rejected',
          admin_notes: rejectionReason ?? null,
        })
        .eq('id', registrationId);

      if (updateError) {
        return fail(updateError.message);
      }

      console.log(`Facility ${registrationId} rejected successfully`);
      return ok({ success: true });
    }

    // Approve facility from facilities table
    try {
      const resolvedAdmin = await resolveAdminContact(facility.id, adminInfo);
      if (!resolvedAdmin?.adminEmail) {
        console.error('Admin email not found for facility:', registrationId);
        return fail('Admin email not found for facility');
      }

      // Update facility to approved with activation status
      const { error: approveError } = await supabaseAdmin
        .from('facilities')
        .update({
          verification_status: 'approved',
          verified: true,
          activation_status: activationType,
        })
        .eq('id', registrationId);

      if (approveError) {
        throw new Error(approveError.message);
      }

      console.log(`Facility ${registrationId} approved with activation_status: ${activationType}`);

      // Send approval email with onboarding link
      const emailResult = await sendApprovalEmail(
        resolvedAdmin.adminEmail,
        resolvedAdmin.adminName,
        facility.name,
        facility.clinic_code,
        facility.id,
        activationType
      );

      console.log('Email result:', emailResult);

      return jsonResponse({
        success: true,
        facilityId: facility.id,
        clinicCode: facility.clinic_code,
        activationType,
        emailSent: emailResult.success,
      });
    } catch (error) {
      console.error('Facility approval error:', error);
      return fail(error instanceof Error ? error.message : 'Failed to approve facility');
    }
  }

  // Handle clinic_registrations table (legacy flow)
  if (registration.status !== 'pending') {
    return fail('Registration already reviewed');
  }

  if (action === 'reject') {
    const { error: updateError } = await supabaseAdmin
      .from('clinic_registrations')
      .update({
        status: 'rejected',
        rejection_reason: rejectionReason ?? null,
        reviewer_user_id: reviewerUserId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', registrationId);

    if (updateError) {
      return fail(updateError.message);
    }

    console.log(`Registration ${registrationId} rejected successfully`);
    return ok({ success: true });
  }

  // Approve flow for clinic_registrations
  try {
    console.log(`Approving legacy clinic registration ${registrationId} (${registration.clinic_name})`);

    const nowIso = new Date().toISOString();
    const normalizedClinicName = (registration.clinic_name ?? '').trim();
    const normalizedClinicEmail = registration.email ? registration.email.trim().toLowerCase() : null;
    const normalizedClinicPhone = registration.phone_number
      ? registration.phone_number.toString().replace(/\s+/g, '')
      : null;
    const normalizedAdminEmail = registration.admin_email.trim().toLowerCase();
    const normalizedAdminName = registration.admin_name.trim();
    const normalizedAdminPhone = registration.admin_phone
      ? registration.admin_phone.toString().replace(/\s+/g, '')
      : null;

    if (!normalizedClinicName) {
      return fail('Clinic name is required');
    }

    let facilityId: string | null = registration.facility_id ?? null;
    let tenantId: string | null = registration.tenant_id ?? null;
    let clinicCode: string | null = null;

    // Create facility + tenant for legacy registrations on approval.
    // This avoids depending on Supabase invite emails and keeps onboarding self-service.
    if (!facilityId || !tenantId) {
      const { data: tenantInsert, error: tenantErr } = await supabaseAdmin
        .from('tenants')
        .insert({ name: normalizedClinicName, is_active: true })
        .select('id')
        .single();

      if (tenantErr || !tenantInsert?.id) {
        throw new Error(tenantErr?.message || 'Failed to create tenant');
      }

      tenantId = tenantInsert.id as string;

      const { data: codeData, error: codeErr } = await supabaseAdmin.rpc('generate_clinic_code', {
        clinic_name_input: normalizedClinicName,
      });

      if (codeErr) {
        throw new Error(codeErr.message);
      }

      clinicCode = (codeData as string) || null;

      const { data: facilityInsert, error: facilityErr } = await supabaseAdmin
        .from('facilities')
        .insert({
          tenant_id: tenantId,
          name: normalizedClinicName,
          facility_type: 'clinic',
          location: registration.location?.trim() ?? null,
          address: registration.address?.trim() ?? null,
          phone_number: normalizedClinicPhone,
          email: normalizedClinicEmail,
          clinic_code: clinicCode,
          verification_status: 'approved',
          verified: true,
          activation_status: activationType,
          is_tester: activationType === 'testing',
          notes: JSON.stringify({
            admin_name: normalizedAdminName,
            admin_email: normalizedAdminEmail,
            admin_phone: normalizedAdminPhone,
          }),
        })
        .select('id, clinic_code')
        .single();

      if (facilityErr || !facilityInsert?.id) {
        throw new Error(facilityErr?.message || 'Failed to create facility');
      }

      facilityId = facilityInsert.id as string;
      clinicCode = (facilityInsert.clinic_code as string | null) ?? clinicCode;
    } else {
      // Legacy registration already has facility/tenant; ensure it's approved/active.
      const { data: facility, error: facilityErr } = await supabaseAdmin
        .from('facilities')
        .select('id, clinic_code')
        .eq('id', facilityId)
        .maybeSingle();

      if (facilityErr) {
        throw new Error(facilityErr.message);
      }

      clinicCode = (facility?.clinic_code as string | null) ?? null;

      const { error: approveErr } = await supabaseAdmin
        .from('facilities')
        .update({
          verification_status: 'approved',
          verified: true,
          activation_status: activationType,
        })
        .eq('id', facilityId);

      if (approveErr) {
        throw new Error(approveErr.message);
      }
    }

    const { error: finalizeError } = await supabaseAdmin
      .from('clinic_registrations')
      .update({
        status: 'approved',
        reviewer_user_id: reviewerUserId,
        reviewed_at: nowIso,
        admin_invite_sent_at: nowIso, // "admin contact notified" timestamp (approval email)
        facility_id: facilityId,
        tenant_id: tenantId,
        rejection_reason: null,
        // Admin account is created via the onboarding link (self-service).
        admin_auth_user_id: null,
        admin_user_id: null,
      })
      .eq('id', registrationId);

    if (finalizeError) {
      throw new Error(finalizeError.message);
    }

    // Send approval/onboarding email
    const emailResult = await sendApprovalEmail(
      normalizedAdminEmail,
      normalizedAdminName,
      normalizedClinicName,
      clinicCode,
      facilityId,
      activationType
    );

    console.log('Email result:', emailResult);

    return ok({
      success: true,
      facilityId,
      clinicCode,
      activationType,
      emailSent: emailResult.success,
    });
  } catch (error) {
    console.error('Approval error:', error);
    return fail(error instanceof Error ? error.message : 'Failed to approve registration');
  }
});
