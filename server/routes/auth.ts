import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';

const router = Router();

/**
 * GET /api/auth/profile
 * Returns the current user's profile and status checks
 * Used after sign-in to verify access and redirect properly
 */
router.get('/profile', requireUser, async (req, res) => { // User is already authenticated by middleware
    const { authUserId, profileId } = req.user!;

    try {
        // 1. Check for Pending Registration Requests
        const { data: pendingRequest } = await supabaseAdmin
            .from('staff_registration_requests')
            .select('status, facility_id, facilities:facility_id(name)')
            .eq('auth_user_id', authUserId)
            .eq('status', 'pending')
            .maybeSingle();

        if (pendingRequest) {
            const facilityName = (pendingRequest.facilities as any)?.name || 'the clinic';
            return res.json({
                status: 'pending_approval',
                message: `Your registration request for ${facilityName} is pending approval by the clinic administrator.`,
                facilityName
            });
        }

        // 2. If no profile, they are a fresh authenticated user? 
        // Usually they should have a profile if they are not pending approval.
        if (!profileId) {
            // Could be a super admin in the making or a glitch?
            // Or maybe they just signed up and trigger hasn't run?
            return res.json({ status: 'no_profile' });
        }

        // 3. Get Full Profile with Facility Status
        const { data: userData } = await supabaseAdmin
            .from('users')
            .select(`
        id,
        name,
        user_role,
        tenant_id,
        facility_id,
        last_login_at,
        facilities:facility_id (
          id,
          name,
          verification_status,
          admin_notes
        )
      `)
            .eq('id', profileId)
            .single();

        if (!userData) {
            return res.json({ status: 'no_profile' });
        }

        // 4. Check if this is first login (last_login_at is NULL)
        const isFirstLogin = userData.last_login_at === null;

        // 5. Update last_login_at to current timestamp
        if (isFirstLogin) {
            await supabaseAdmin
                .from('users')
                .update({ last_login_at: new Date().toISOString() })
                .eq('id', profileId);
        }

        // 6. Check Facility Status (Revocation)
        if (userData.facilities) {
            const facility = userData.facilities as any;
            if (facility.verification_status === 'rejected') {
                return res.json({
                    status: 'access_revoked',
                    message: facility.admin_notes || 'Your facility access has been revoked.'
                });
            }
        }

        // 7. Success
        return res.json({
            status: 'active',
            user: userData,
            isFirstLogin
        });

    } catch (err) {
        console.error('Profile fetch error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Schema for staff registration request
const staffRegistrationSchema = z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    role: z.string(),
    clinicCode: z.string().min(3),
    password: z.string().min(6), // We'll handle auth creation here too
    invitationToken: z.string().optional(),
    verificationCode: z.string().optional(),
});

/**
 * POST /api/auth/register-staff
 * Handles the full flow of registering a staff member:
 * 1. Verifies invitation or email code
 * 2. Creates Supabase Auth user
 * 3. Creates Staff Registration Request
 */
// Schema for initiating registration
const initiateRegistrationSchema = z.object({
    email: z.string().email(),
    fullName: z.string().min(2),
    role: z.string(),
    clinicCode: z.string().min(3),
});

/**
 * POST /api/auth/initiate-registration
 * 1. Validates clinic code
 * 2. Generates verification code
 * 3. Sends email (via edge function or direct)
 */
router.post('/initiate-registration', async (req, res) => {
    try {
        const { email, fullName, role, clinicCode } = initiateRegistrationSchema.parse(req.body);

        // 1. Validate Clinic
        const { data: facility, error: facilityError } = await supabaseAdmin
            .from('facilities')
            .select('id, name, verification_status')
            .eq('clinic_code', clinicCode)
            .maybeSingle();

        if (facilityError || !facility) {
            return res.status(404).json({ error: 'Clinic code not found' });
        }

        if (facility.verification_status === 'rejected') {
            return res.status(403).json({ error: 'Clinic is not accepting new staff' });
        }

        // 2. Generate Code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 15);

        // 3. Store Code securely
        const { error: codeError } = await supabaseAdmin
            .from('email_verification_codes')
            .insert({
                email: email.toLowerCase().trim(),
                code: verificationCode,
                expires_at: expiresAt.toISOString(),
            });

        if (codeError) {
            console.error('Store code error:', codeError);
            return res.status(500).json({ error: 'Failed to generate verification code' });
        }

        // 4. Send Email (invoking existing edge function for consistency)
        const { error: emailError } = await supabaseAdmin.functions.invoke('send-verification-code', {
            body: {
                email,
                code: verificationCode,
                name: fullName,
                facilityName: facility.name,
            },
        });

        if (emailError) {
            console.error('Send email error:', emailError);
            // We continue even if email fails? No, user needs code.
            return res.status(500).json({ error: 'Failed to send verification email' });
        }

        return res.json({ success: true, message: 'Verification code sent' });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors[0].message });
        }
        console.error('Initiate registration error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/register-staff
 * Handles the full flow of registering a staff member:
 * 1. Verifies invitation or email code
 * 2. Creates Supabase Auth user
 * 3. Creates Staff Registration Request
 */
router.post('/register-staff', async (req, res) => {
    try {
        const payload = staffRegistrationSchema.parse(req.body);
        const { email, password, fullName, role, clinicCode, invitationToken, verificationCode } = payload;

        // 1. Resolve Facility
        const { data: facility, error: facilityError } = await supabaseAdmin
            .from('facilities')
            .select('id, name, tenant_id, clinic_code, verification_status')
            .eq('clinic_code', clinicCode)
            .single();

        if (facilityError || !facility) {
            return res.status(404).json({ error: 'Clinic code not found' });
        }

        if (facility.verification_status === 'rejected') {
            return res.status(403).json({ error: 'Clinic is not accepting new staff' });
        }

        // 2. Verify Invitation or Code
        if (invitationToken) {
            const { data: inv } = await supabaseAdmin
                .from('staff_invitations')
                .select('*')
                .eq('invitation_token', invitationToken)
                .maybeSingle();

            if (!inv || inv.accepted) {
                return res.status(400).json({ error: 'Invalid or used invitation token' });
            }
        } else if (verificationCode) {
            // Verify code from DB
            const { data: codeRecord } = await supabaseAdmin
                .from('email_verification_codes')
                .select('*')
                .eq('email', email)
                .eq('code', verificationCode)
                .gt('expires_at', new Date().toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!codeRecord) {
                return res.status(400).json({ error: 'Invalid or expired verification code' });
            }

            // Use the code (mark verified/used logic?)
            // For now just proceeding implies it was valid.
            // Optionally delete it to prevent reuse?
            await supabaseAdmin.from('email_verification_codes').delete().eq('id', codeRecord.id);
        } else {
            return res.status(400).json({ error: 'Missing invitation token or verification code' });
        }

        // 3. Create Auth User
        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true, // Auto-confirm since we verified email via code/invite
            user_metadata: {
                name: fullName,
                full_name: fullName,
                user_role: role,
                clinic_code: clinicCode,
                facility_id: facility.id,
                tenant_id: facility.tenant_id,
                pending_approval: true,
            }
        });

        if (authError) {
            // If user exists, we might want to handle it gracefully, but for now 400
            return res.status(400).json({ error: authError.message });
        }

        if (!authUser.user) {
            return res.status(500).json({ error: 'Failed to create user' });
        }

        // Wait for trigger to create user profile? 
        // Actually, backend create user usually triggers the same DB triggers.
        // But we need to ensure the user profile is ready or Create the registration request manually.

        // 4. Create Registration Request
        const { error: reqError } = await supabaseAdmin
            .from('staff_registration_requests')
            .insert({
                auth_user_id: authUser.user.id,
                name: fullName,
                email: email.toLowerCase(),
                requested_role: role,
                facility_id: facility.id,
                tenant_id: facility.tenant_id,
                status: 'pending'
            });

        if (reqError) {
            // Cleanup auth user if request fails? (Optional but good practice)
            await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
            return res.status(500).json({ error: 'Failed to create registration request' });
        }

        // Acknowledge invite
        if (invitationToken) {
            await supabaseAdmin
                .from('staff_invitations')
                .update({ accepted: true })
                .eq('invitation_token', invitationToken);
        }

        return res.json({
            success: true,
            requiresApproval: true,
            message: 'Registration submitted for approval'
        });

    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors[0].message });
        }
        console.error('Register staff error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/auth/invitation/:token
 * Validates an invitation token
 */
router.get('/invitation/:token', async (req, res) => {
    try {
        const { token } = req.params;

        // Call Supabase to get invitation details
        const { data, error } = await supabaseAdmin
            .from('staff_invitations')
            .select('email, role, expires_at, accepted, facility:facility_id(name, clinic_code)')
            .eq('invitation_token', token)
            .maybeSingle();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        if (!data) {
            return res.status(404).json({ error: 'Invitation not found' });
        }

        if (data.accepted) {
            return res.status(400).json({ error: 'Invitation already accepted' });
        }

        if (data.expires_at && new Date(data.expires_at) < new Date()) {
            return res.status(400).json({ error: 'Invitation expired' });
        }

        return res.json(data);
    } catch (error) {
        console.error('Get invitation error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
