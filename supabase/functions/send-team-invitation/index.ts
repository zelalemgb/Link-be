import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface InvitationRequest {
  email: string;
  role: string;
  facilityName: string;
  invitationToken: string;
  invitationLink: string;
  adminName?: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const payload: InvitationRequest = await req.json();
    const { email, role, facilityName, invitationLink, adminName } = payload;

    console.log("send-team-invitation request", {
      email,
      role,
      facilityName,
      hasInvitationLink: !!invitationLink,
    });

    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not set");
      return new Response(
        JSON.stringify({ error: "Email service not configured" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    const roleLabels: Record<string, string> = {
      receptionist: 'Registration',
      nurse: 'Triage/Nurse',
      doctor: 'Doctor',
      lab_technician: 'Lab Technician',
      imaging_technician: 'Imaging Technician',
      pharmacist: 'Pharmacy',
      hospital_ceo: 'CEO',
      medical_director: 'Medical Director',
      nursing_head: 'Nursing Head',
      finance: 'Cashier',
      logistic_officer: 'Logistic Officer',
    };

    const roleLabel = roleLabels[role] || role;

    const emailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; background: #667eea; color: white !important; padding: 12px 30px; text-decoration: none !important; border-radius: 6px; margin: 20px 0; font-weight: bold; }
            .footer { text-align: center; color: #999; font-size: 12px; margin-top: 30px; }
            .info-box { background: white; padding: 15px; border-left: 4px solid #667eea; margin: 20px 0; }
            .instructions { background: #e8eaf6; padding: 15px; border-radius: 6px; margin: 20px 0; }
            .instructions ol { margin: 10px 0; padding-left: 20px; }
            .instructions li { margin: 8px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 You're Invited to Test Link!</h1>
            </div>
            <div class="content">
              <p>Hello,</p>
              <p><strong>${adminName || 'The administrator'}</strong> from <strong>${facilityName}</strong> has invited you to be a tester for the Link health management system.</p>
              
              <div class="info-box">
                <p><strong>👤 Your Testing Role:</strong> ${roleLabel}</p>
                <p><strong>🏥 Health Facility:</strong> ${facilityName}</p>
                <p><strong>👨‍💼 Invited By:</strong> ${adminName || 'System Administrator'}</p>
              </div>

              <div class="instructions">
                <h3 style="margin-top: 0;">📋 How to Get Started:</h3>
                <ol>
                  <li><strong>Click the registration button</strong> below to open the staff registration page</li>
                  <li><strong>Review the "Join Staff" tab</strong> - Your invitation details will be waiting there</li>
                  <li><strong>Create your password</strong> - Choose a secure password for your account</li>
                  <li><strong>Complete your profile</strong> - Fill in your basic information</li>
                  <li><strong>Start testing immediately</strong> - Begin exploring the system as a ${roleLabel}</li>
                </ol>
              </div>

              <p style="margin-top: 25px;"><strong>As a tester, you will:</strong></p>
              <ul style="color: #555;">
                <li>Have full access to test the ${roleLabel} features</li>
                <li>Work with test data in a safe testing environment</li>
                <li>Help improve Link by providing feedback</li>
                <li>Be part of revolutionizing healthcare in Ethiopia</li>
              </ul>

              <div style="text-align: center; margin-top: 30px;">
                <a href="${invitationLink}" style="display: inline-block; background: #667eea; color: #ffffff !important; padding: 14px 32px; text-decoration: none !important; border-radius: 6px; font-size: 16px; font-weight: bold; margin: 20px 0;" target="_blank" rel="noopener noreferrer">✨ Accept Invitation & Register</a>
              </div>
              
              <p style="color: #666; font-size: 13px; margin-top: 15px; text-align: center;">
                Or copy and paste this link in your browser:<br/>
                <a href="${invitationLink}" style="color: #667eea; word-break: break-all;">${invitationLink}</a>
              </p>

              <p style="color: #666; font-size: 13px; margin-top: 25px; text-align: center;">
                ⏰ This invitation link will expire in 7 days
              </p>
              
              <p style="margin-top: 30px;">If you have any questions or didn't expect this invitation, please contact <strong>${facilityName}</strong> directly.</p>
              
              <p style="margin-top: 20px;">Best regards,<br><strong>The Link Team</strong><br>Transforming Healthcare Together 🚀</p>
            </div>
            <div class="footer">
              <p>© 2024 Link Health Management System. All rights reserved.</p>
              <p style="margin-top: 5px;">This is a testing invitation for healthcare professionals.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Link Health <onboarding@admin.linkhc.org>",
        to: [email],
        subject: `You're invited to join ${facilityName} on Link`,
        html: emailHtml,
        text: `Hello,\n\n${adminName || "The administrator"} from ${facilityName} invited you to join Link as ${roleLabel}.\n\nAccept invitation: ${invitationLink}\n\nThis link expires in 7 days.\n`,
      }),
    });

    const data = await res.json();
    console.log("Resend API response", { status: res.status, ok: res.ok, data });

    if (!res.ok) {
      console.error("Resend API error:", data);
      return new Response(
        JSON.stringify({ error: data.message || "Failed to send email" }),
        {
          status: res.status,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in send-team-invitation:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
