import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Resend } from 'npm:resend@2.0.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

interface ApprovalEmailPayload {
  facilityId: string;
  clinicName: string;
  clinicCode: string;
  adminName: string;
  activationStatus?: 'testing' | 'active';
}

Deno.serve(async (req) => {
  console.log('send-clinic-approval-email called:', req.method);
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  if (!resend) {
    console.log('RESEND_API_KEY not configured, skipping email');
    return jsonResponse({ success: false, message: 'Resend not configured - check RESEND_API_KEY secret' });
  }

  let payload: ApprovalEmailPayload;

  try {
    payload = await req.json();
    console.log('Received payload:', JSON.stringify(payload));
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const { facilityId, clinicName, clinicCode, adminName, activationStatus = 'testing' } = payload;

  if (!facilityId || !clinicName) {
    console.log('Missing required fields:', { facilityId, clinicName });
    return jsonResponse({ error: 'facilityId and clinicName are required' }, { status: 400 });
  }

  // Determine email subject and header based on activation status
  const isFullActivation = activationStatus === 'active';
  const emailSubject = isFullActivation 
    ? `🎉 ${clinicName} is Now Fully Activated!`
    : `Welcome to Link Health - ${clinicName} is Approved for Testing!`;
  const headerTitle = isFullActivation 
    ? '🚀 Full Activation Complete!'
    : '🎉 Welcome to Link Health!';
  const headerSubtitle = isFullActivation 
    ? 'Your clinic now has full access'
    : 'Your clinic has been approved for testing';

  try {
    let adminEmail: string | null = null;
    let finalAdminName = adminName || 'Administrator';

    // First try: Get admin email from the users table via auth
    console.log('Looking for admin user in users table for facility:', facilityId);
    const { data: adminUser, error: userError } = await supabaseAdmin
      .from('users')
      .select('auth_user_id, name')
      .eq('facility_id', facilityId)
      .eq('user_role', 'admin')
      .maybeSingle();

    if (userError) {
      console.log('Error querying users table:', userError.message);
    }

    if (adminUser?.auth_user_id) {
      console.log('Found admin user with auth_user_id:', adminUser.auth_user_id);
      // Get admin email from auth.users
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(adminUser.auth_user_id);
      if (authError) {
        console.log('Error getting auth user:', authError.message);
      }
      if (authData?.user?.email) {
        adminEmail = authData.user.email;
        finalAdminName = adminName || adminUser.name || 'Administrator';
        console.log(`Found admin email from auth.users: ${adminEmail}`);
      }
    }

    // Second try: Check clinic_registrations table for the admin email
    if (!adminEmail) {
      console.log('Checking clinic_registrations table for facility:', facilityId);
      const { data: registration, error: regError } = await supabaseAdmin
        .from('clinic_registrations')
        .select('admin_email, admin_name')
        .eq('facility_id', facilityId)
        .maybeSingle();

      if (regError) {
        console.log('Error querying clinic_registrations:', regError.message);
      }

      if (registration?.admin_email) {
        adminEmail = registration.admin_email;
        finalAdminName = adminName || registration.admin_name || 'Administrator';
        console.log(`Found admin email from clinic_registrations: ${adminEmail}`);
      }
    }

    // Third try: Check facilities table for email or notes JSON
    if (!adminEmail) {
      console.log('Checking facilities table for facility:', facilityId);
      const { data: facility, error: facilityError } = await supabaseAdmin
        .from('facilities')
        .select('email, notes')
        .eq('id', facilityId)
        .maybeSingle();

      if (facilityError) {
        console.log('Error querying facilities:', facilityError.message);
      }

      if (facility?.email) {
        adminEmail = facility.email;
        console.log(`Found email from facilities.email: ${adminEmail}`);
      } else if (facility?.notes) {
        // Parse notes JSON which contains admin_email, admin_name, admin_phone
        try {
          const notesData = typeof facility.notes === 'string' 
            ? JSON.parse(facility.notes) 
            : facility.notes;
          if (notesData?.admin_email) {
            adminEmail = notesData.admin_email;
            finalAdminName = adminName || notesData.admin_name || 'Administrator';
            console.log(`Found admin email from facilities.notes: ${adminEmail}`);
          }
        } catch (parseError) {
          console.error('Failed to parse facilities.notes:', parseError);
        }
      }
    }

    if (!adminEmail) {
      console.error('No admin email found for facility:', facilityId);
      return jsonResponse({ 
        success: false, 
        message: 'No admin email found for this facility',
        searchedTables: ['users', 'clinic_registrations', 'facilities']
      }, { status: 404 });
    }

    console.log(`Sending ${activationStatus} approval email to ${adminEmail} for clinic ${clinicName}`);

    const onboardingUrl = buildClinicOnboardingUrl(facilityId, adminEmail);

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
            <p style="font-size: 16px; margin-top: 0;">Dear <strong>${finalAdminName}</strong>,</p>
            
            ${isFullActivation ? `
            <p>Great news! <strong>${clinicName}</strong> has been upgraded to <strong>full activation status</strong> on the Link Health platform!</p>
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

    console.log('Approval email sent successfully:', emailResponse);

    return jsonResponse({ 
      success: true, 
      emailId: emailResponse?.data?.id,
      sentTo: adminEmail,
      activationStatus 
    });
  } catch (error) {
    console.error('Failed to send approval email:', error);
    return jsonResponse(
      { 
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send email' 
      },
      { status: 500 }
    );
  }
});
