import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Resend } from 'https://esm.sh/resend@2.0.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const FRONTEND_URL = Deno.env.get('FRONTEND_URL') ?? 'https://linkhc.org';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

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
    const onboardingUrl = `${FRONTEND_URL}/auth/clinic-onboarding?facility=${facilityId}&email=${encodeURIComponent(adminEmail)}`;
    
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
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  const authClient = getAuthClient(req);
  const { data: authResult } = await authClient.auth.getUser();

  if (!authResult?.user) {
    console.log('Unauthorized: No user found');
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
  }

  // Use limit(1) to handle multi-facility users who have multiple user records
  const { data: reviewerProfiles, error: reviewerError } = await supabaseAdmin
    .from('users')
    .select('id, user_role')
    .eq('auth_user_id', authResult.user.id)
    .limit(1);

  if (reviewerError) {
    console.error('Error fetching reviewer profile:', reviewerError);
    return jsonResponse({ error: reviewerError.message }, { status: 500 });
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
    return jsonResponse({ error: 'Forbidden' }, { status: 403 });
  }
  
  console.log('Super admin verified:', { reviewer_user_id: reviewerUserId, auth_user_id: authResult.user.id });

  let payload: ReviewPayload;

  try {
    payload = await req.json();
    console.log('Received payload:', JSON.stringify(payload));
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const { registrationId, action, rejectionReason, activationType = 'testing' } = payload;

  if (!registrationId || !action) {
    return jsonResponse({ error: 'registrationId and action are required' }, { status: 400 });
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
      return jsonResponse({ error: facilityError.message }, { status: 500 });
    }

    if (!facility) {
      return jsonResponse({ error: 'Registration not found in either table' }, { status: 404 });
    }

    if (facility.verification_status !== 'pending') {
      return jsonResponse({ error: 'Facility already reviewed' }, { status: 400 });
    }

    // Parse admin info from notes
    let adminInfo = { admin_name: 'Administrator', admin_email: '', admin_phone: '' };
    try {
      if (facility.notes) {
        const parsed = JSON.parse(facility.notes);
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
        return jsonResponse({ error: updateError.message }, { status: 500 });
      }

      console.log(`Facility ${registrationId} rejected successfully`);
      return jsonResponse({ success: true });
    }

    // Approve facility from facilities table
    try {
      if (!adminInfo.admin_email) {
        console.error('Admin email not found in facility notes for facility:', registrationId);
        return jsonResponse({ error: 'Admin email not found in facility notes' }, { status: 400 });
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
        adminInfo.admin_email,
        adminInfo.admin_name,
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
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Failed to approve facility' },
        { status: 500 }
      );
    }
  }

  // Handle clinic_registrations table (legacy flow)
  if (registration.status !== 'pending') {
    return jsonResponse({ error: 'Registration already reviewed' }, { status: 400 });
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
      return jsonResponse({ error: updateError.message }, { status: 500 });
    }

    console.log(`Registration ${registrationId} rejected successfully`);
    return jsonResponse({ success: true });
  }

  // Approve flow for clinic_registrations
  try {
    console.log(`Creating auth user for ${registration.admin_email}`);
    
    const invite = await supabaseAdmin.auth.admin.inviteUserByEmail(registration.admin_email, {
      redirectTo: `${FRONTEND_URL}/auth?tab=signin`,
      data: {
        name: registration.admin_name,
        full_name: registration.admin_name,
        user_role: 'admin',
        role: 'admin',
      },
    });

    if (invite.error) {
      throw new Error(invite.error.message);
    }

    const authUserId = invite.data.user?.id;

    if (!authUserId) {
      throw new Error('Failed to create administrator account');
    }

    console.log(`Auth user created: ${authUserId}`);

    // Wait for profile to be created by trigger
    let adminUserId: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('auth_user_id', authUserId)
        .maybeSingle();

      if (data?.id) {
        adminUserId = data.id as string;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }

    console.log(`Calling register_clinic RPC for ${registration.clinic_name}`);

    const { data: registerResult, error: registerError } = await supabaseAdmin.rpc('register_clinic', {
      p_auth_user_id: authUserId,
      p_clinic_name: registration.clinic_name,
      p_location: registration.location,
      p_address: registration.address,
      p_phone: registration.phone_number,
      p_email: registration.email,
      p_admin_name: registration.admin_name,
    });

    if (registerError) {
      throw new Error(registerError.message);
    }

    const resultItem = Array.isArray(registerResult) ? registerResult[0] : registerResult;
    console.log('Register clinic result:', resultItem);

    // Update facility activation_status based on activationType
    if (resultItem?.facility_id) {
      const { error: activationError } = await supabaseAdmin
        .from('facilities')
        .update({ activation_status: activationType })
        .eq('id', resultItem.facility_id);

      if (activationError) {
        console.error('Failed to set activation_status:', activationError);
      } else {
        console.log(`Facility ${resultItem.facility_id} activation_status set to: ${activationType}`);
      }
    }

    const { error: finalizeError } = await supabaseAdmin
      .from('clinic_registrations')
      .update({
        status: 'approved',
        reviewer_user_id: reviewerUserId,
        reviewed_at: new Date().toISOString(),
        admin_invite_sent_at: new Date().toISOString(),
        admin_auth_user_id: authUserId,
        admin_user_id: adminUserId,
        facility_id: resultItem?.facility_id ?? null,
        tenant_id: resultItem?.tenant_id ?? null,
        rejection_reason: null,
      })
      .eq('id', registrationId);

    if (finalizeError) {
      throw new Error(finalizeError.message);
    }

    // Send approval/onboarding email
    const emailResult = await sendApprovalEmail(
      registration.admin_email,
      registration.admin_name,
      registration.clinic_name,
      resultItem?.clinic_code ?? null,
      resultItem?.facility_id ?? registrationId,
      activationType
    );

    console.log('Email result:', emailResult);

    return jsonResponse({
      success: true,
      facilityId: resultItem?.facility_id ?? null,
      clinicCode: resultItem?.clinic_code ?? null,
      activationType,
      emailSent: emailResult.success,
    });
  } catch (error) {
    console.error('Approval error:', error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Failed to approve registration' },
      { status: 500 }
    );
  }
});
