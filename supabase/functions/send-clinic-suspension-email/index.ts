import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Resend } from 'npm:resend@2.0.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

interface SuspensionEmailPayload {
  facilityId: string;
  clinicName: string;
  suspensionReason: string;
  adminName?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  if (!resend) {
    console.log('Resend not configured, skipping email');
    return jsonResponse({ success: true, message: 'Resend not configured' });
  }

  let payload: SuspensionEmailPayload;

  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const { facilityId, clinicName, suspensionReason, adminName } = payload;

  if (!facilityId || !clinicName) {
    return jsonResponse({ error: 'facilityId and clinicName are required' }, { status: 400 });
  }

  try {
    let adminEmail: string | null = null;
    let finalAdminName = adminName || 'Administrator';

    // First try: Get admin email from the users table via auth
    const { data: adminUser } = await supabaseAdmin
      .from('users')
      .select('auth_user_id, name')
      .eq('facility_id', facilityId)
      .eq('user_role', 'admin')
      .maybeSingle();

    if (adminUser?.auth_user_id) {
      const { data: authData } = await supabaseAdmin.auth.admin.getUserById(adminUser.auth_user_id);
      if (authData?.user?.email) {
        adminEmail = authData.user.email;
        finalAdminName = adminName || adminUser.name || 'Administrator';
      }
    }

    // Second try: Check clinic_registrations table
    if (!adminEmail) {
      console.log('No admin found in users table, checking clinic_registrations...');
      const { data: registration } = await supabaseAdmin
        .from('clinic_registrations')
        .select('admin_email, admin_name')
        .eq('facility_id', facilityId)
        .maybeSingle();

      if (registration?.admin_email) {
        adminEmail = registration.admin_email;
        finalAdminName = adminName || registration.admin_name || 'Administrator';
        console.log(`Found admin email from clinic_registrations: ${adminEmail}`);
      }
    }

    // Third try: Check facilities table
    if (!adminEmail) {
      console.log('No admin found in clinic_registrations, checking facilities...');
      const { data: facility } = await supabaseAdmin
        .from('facilities')
        .select('email, notes')
        .eq('id', facilityId)
        .maybeSingle();

      if (facility?.email) {
        adminEmail = facility.email;
        console.log(`Found email from facilities.email: ${adminEmail}`);
      } else if (facility?.notes) {
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
      return jsonResponse({ success: false, message: 'No admin email found for this facility' }, { status: 404 });
    }

    console.log(`Sending suspension email to ${adminEmail} for clinic ${clinicName}`);

    const emailResponse = await resend.emails.send({
      from: 'Link Health <noreply@admin.linkhc.org>',
      to: [adminEmail],
      subject: `Important Notice: ${clinicName} Access Suspended`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">⚠️ Access Suspended</h1>
            <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">Action Required</p>
          </div>
          
          <div style="background: #f8fafc; padding: 30px; border: 1px solid #e2e8f0; border-top: none;">
            <p style="font-size: 16px; margin-top: 0;">Dear <strong>${finalAdminName}</strong>,</p>
            
            <p>We regret to inform you that access to <strong>${clinicName}</strong> on the Link Health platform has been temporarily suspended.</p>
            
            ${suspensionReason ? `
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
              <p style="margin: 0 0 5px 0; color: #92400e; font-size: 14px; font-weight: bold;">Reason for Suspension:</p>
              <p style="margin: 0; color: #92400e; font-size: 14px;">${suspensionReason}</p>
            </div>
            ` : ''}
            
            <h2 style="color: #d97706; font-size: 18px; margin-top: 25px;">📋 What This Means</h2>
            
            <div style="background: white; border-radius: 8px; padding: 20px; margin: 15px 0;">
              <ul style="margin: 0; padding-left: 20px;">
                <li style="margin-bottom: 12px;">
                  <strong>Login Access Disabled</strong> - Staff members will not be able to log in to the system.
                </li>
                <li style="margin-bottom: 12px;">
                  <strong>Data Preserved</strong> - All your clinic data, patient records, and configurations are safely preserved.
                </li>
                <li style="margin-bottom: 0;">
                  <strong>New Registrations Blocked</strong> - No new staff can join the facility during suspension.
                </li>
              </ul>
            </div>
            
            <h2 style="color: #0ea5e9; font-size: 18px; margin-top: 25px;">🤝 How to Resolve This</h2>
            
            <div style="background: white; border-radius: 8px; padding: 20px; margin: 15px 0;">
              <p style="margin: 0 0 15px 0;">If you believe this suspension was made in error, or if you would like to discuss the matter further, please contact our support team:</p>
              
              <div style="text-align: center;">
                <a href="mailto:support@linkhc.org" style="display: inline-block; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: white; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Contact Link Support</a>
              </div>
            </div>
            
            <p>We understand this may be inconvenient, and we are committed to resolving any issues as quickly as possible.</p>
            
            <p style="margin-bottom: 0;">Best regards,</p>
            <p style="margin-top: 5px; color: #64748b;">The Link Health Team</p>
          </div>
          
          <div style="text-align: center; padding: 20px; color: #94a3b8; font-size: 12px;">
            <p style="margin: 0;">© ${new Date().getFullYear()} Link Health. All rights reserved.</p>
            <p style="margin: 5px 0 0 0;">This is an automated notification. Please do not reply directly to this email.</p>
          </div>
        </body>
        </html>
      `,
    });

    console.log('Suspension email sent successfully:', emailResponse);

    return jsonResponse({ success: true, emailId: emailResponse?.data?.id });
  } catch (error) {
    console.error('Failed to send suspension email:', error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Failed to send email' },
      { status: 500 }
    );
  }
});
