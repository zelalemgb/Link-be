import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';
import { recordPlatformActivityEvent } from '../services/platform-activity';
import { normalizeWorkspaceMetadata } from '../services/workspaceMetadata';
import { provisionWorkspaceDefaults } from '../services/workspaceProvisioning';
import { provisionTrial } from '../services/subscriptionService';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://linkhc.org';
const LEGACY_DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const VERIFICATION_CODE_TTL_MINUTES = 15;
const verificationCodeSecret = process.env.EMAIL_VERIFICATION_CODE_SECRET?.trim();
if (!verificationCodeSecret && process.env.NODE_ENV !== 'development') {
    throw new Error('EMAIL_VERIFICATION_CODE_SECRET is required in non-development environments');
}
const VERIFICATION_CODE_SECRET = verificationCodeSecret || 'local-dev-email-verification-secret';

type VerificationCodeRecord = {
    id: string;
    email: string;
    code: string;
    expires_at: string;
    verified_at: string | null;
    attempts: number;
    max_attempts: number;
};

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const platformSessionIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const resolvePlatformSessionId = (headerValue: string | undefined) => {
    const normalized = headerValue?.trim() || '';
    return platformSessionIdPattern.test(normalized) ? normalized : null;
};

const hashVerificationCode = (email: string, verificationCode: string) =>
    crypto
        .createHmac('sha256', VERIFICATION_CODE_SECRET)
        .update(`${normalizeEmail(email)}:${verificationCode.trim()}`)
        .digest('hex');

const buildVerificationCodeExpiry = () => {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + VERIFICATION_CODE_TTL_MINUTES);
    return expiresAt.toISOString();
};

const generateVerificationCode = () =>
    String(crypto.randomInt(100000, 1000000));

const loadLatestPendingVerificationCode = async (email: string) => {
    const normalizedEmail = normalizeEmail(email);
    const { data, error } = await supabaseAdmin
        .from('email_verification_codes')
        .select('id, email, code, expires_at, verified_at, attempts, max_attempts, created_at')
        .eq('email', normalizedEmail)
        .is('verified_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data as VerificationCodeRecord | null;
};

const loadVerifiedCodeMatch = async (email: string, verificationCode: string) => {
    const normalizedEmail = normalizeEmail(email);
    const hashedCode = hashVerificationCode(normalizedEmail, verificationCode);

    const { data: hashedMatch, error: hashedError } = await supabaseAdmin
        .from('email_verification_codes')
        .select('id, email, code, expires_at, verified_at, attempts, max_attempts, created_at')
        .eq('email', normalizedEmail)
        .eq('code', hashedCode)
        .not('verified_at', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (hashedError) throw hashedError;
    if (hashedMatch) {
        return { record: hashedMatch as VerificationCodeRecord, usedLegacyPlaintext: false };
    }

    const { data: legacyMatch, error: legacyError } = await supabaseAdmin
        .from('email_verification_codes')
        .select('id, email, code, expires_at, verified_at, attempts, max_attempts, created_at')
        .eq('email', normalizedEmail)
        .eq('code', verificationCode.trim())
        .not('verified_at', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (legacyError) throw legacyError;
    return { record: legacyMatch as VerificationCodeRecord | null, usedLegacyPlaintext: Boolean(legacyMatch) };
};

const userQuerySchema = z.object({
    facilityId: z.string().uuid().optional(),
});

const facilityQuerySchema = z.object({
    facilityId: z.string().uuid().optional(),
});

const completeClinicAdminOnboardingSchema = z.object({
    facilityId: z.string().uuid(),
    adminEmail: z.string().email(),
    name: z.string().min(2).max(120).optional(),
});

const clinicAdminOnboardingRegistrationSchema = z.object({
    facilityId: z.string().uuid(),
    adminEmail: z.string().email(),
    password: z.string().min(8).max(128),
    name: z.string().min(2).max(120).optional(),
});

const directClinicRegistrationSchema = z.object({
    clinic: z.object({
        name: z.string().min(2).max(100),
        country: z.string().min(2),
        location: z.string().min(2),
        address: z.string().min(5),
        phoneNumber: z.string().min(8).max(20),
        email: z.string().email().optional().nullable(),
    }),
    admin: z.object({
        name: z.string().min(2).max(100),
        email: z.string().email(),
        phoneNumber: z.string().min(8).max(20),
        password: z.string().min(8).max(128),
    }),
});

const completeProviderOnboardingSchema = z.object({
    fullName: z.string().min(2).max(120).optional(),
    phoneNumber: z.string().min(8).max(24).optional().nullable(),
    workspaceName: z.string().min(2).max(160).optional(),
});

const soloProviderRegistrationSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
    fullName: z.string().min(2).max(120),
    phoneNumber: z.string().min(8).max(24).optional().nullable(),
});

const sendSignupVerificationEmail = async (email: string) => {
    try {
        const { error } = await supabaseAdmin.auth.resend({
            type: 'signup',
            email,
        });

        if (error) {
            console.warn('Verification email resend failed:', error.message);
        }
    } catch (emailError: any) {
        console.warn('Verification email send failed:', emailError?.message || emailError);
    }
};

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

        let workspace = normalizeWorkspaceMetadata(null);
        if (userData.tenant_id) {
            const { data: tenantMetadata, error: tenantMetadataError } = await supabaseAdmin
                .from('tenants')
                .select('workspace_type, setup_mode, team_mode, enabled_modules')
                .eq('id', userData.tenant_id)
                .maybeSingle();

            if (tenantMetadataError) {
                console.warn('Profile workspace metadata lookup failed:', tenantMetadataError.message);
            } else {
                workspace = normalizeWorkspaceMetadata(tenantMetadata as any);
            }
        }

        // 7. Success
        return res.json({
            status: 'active',
            user: {
                ...userData,
                workspace,
            },
            isFirstLogin
        });

    } catch (err: any) {
        console.error('Profile fetch error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/auth/user
 * Returns user profile data for the active facility (if provided).
 */
router.get('/user', requireUser, async (req, res) => {
    try {
        const { authUserId } = req.user!;
        const parsed = userQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
        }

        let query = supabaseAdmin
            .from('users')
            .select('id, name, user_role, facility_id, tenant_id, auth_user_id')
            .eq('auth_user_id', authUserId);

        if (parsed.data.facilityId) {
            query = query.eq('facility_id', parsed.data.facilityId);
        }

        const { data, error } = await query
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        if (!data) {
            return res.status(404).json({ error: 'User not found' });
        }

        let workspace = normalizeWorkspaceMetadata(null);
        if (data.tenant_id) {
            const { data: tenantMetadata, error: tenantMetadataError } = await supabaseAdmin
                .from('tenants')
                .select('workspace_type, setup_mode, team_mode, enabled_modules')
                .eq('id', data.tenant_id)
                .maybeSingle();

            if (tenantMetadataError) {
                console.warn('User workspace metadata lookup failed:', tenantMetadataError.message);
            } else {
                workspace = normalizeWorkspaceMetadata(tenantMetadata as any);
            }
        }

        return res.json({
            user: {
                ...data,
                workspace,
            },
        });
    } catch (err: any) {
        console.error('User fetch error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/auth/facilities
 * Returns facility assignments and RBAC roles for the authenticated user.
 */
router.get('/facilities', requireUser, async (req, res) => {
    try {
        const { authUserId } = req.user!;
        const { data: userRows, error: userError } = await supabaseAdmin
            .from('users')
            .select(`
        id,
        facility_id,
        user_role,
        tenant_id,
        facilities:facility_id (
          name
        )
      `)
            .eq('auth_user_id', authUserId)
            .order('created_at', { ascending: true });

        if (userError) {
            return res.status(500).json({ error: userError.message });
        }

        const userIds = (userRows || []).map((row: any) => row.id).filter(Boolean);
        const { data: userRolesData } = await supabaseAdmin
            .from('user_roles')
            .select('user_id, role_id')
            .in('user_id', userIds)
            .eq('is_active', true)
            .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

        const roleIds = (userRolesData || []).map((ur: any) => ur.role_id).filter(Boolean);
        const { data: rolesData } = await supabaseAdmin
            .from('roles')
            .select('id, name')
            .in('id', roleIds);

        const roleNameById = new Map((rolesData || []).map((r: any) => [r.id, r.name]));
        const roleNamesByUser = new Map<string, string[]>();

        (userRolesData || []).forEach((ur: any) => {
            if (!roleNameById.has(ur.role_id)) return;
            const existing = roleNamesByUser.get(ur.user_id) || [];
            existing.push(roleNameById.get(ur.role_id) as string);
            roleNamesByUser.set(ur.user_id, existing);
        });

        const tenantIds = Array.from(
            new Set((userRows || []).map((row: any) => row.tenant_id).filter(Boolean))
        );
        const workspaceByTenantId = new Map<string, ReturnType<typeof normalizeWorkspaceMetadata>>();
        if (tenantIds.length > 0) {
            const { data: tenantRows, error: tenantRowsError } = await supabaseAdmin
                .from('tenants')
                .select('id, workspace_type, setup_mode, team_mode, enabled_modules')
                .in('id', tenantIds);

            if (tenantRowsError) {
                console.warn('Facilities workspace metadata lookup failed:', tenantRowsError.message);
            } else {
                (tenantRows || []).forEach((tenant: any) => {
                    if (!tenant?.id) return;
                    workspaceByTenantId.set(
                        String(tenant.id),
                        normalizeWorkspaceMetadata({
                            workspace_type: tenant.workspace_type,
                            setup_mode: tenant.setup_mode,
                            team_mode: tenant.team_mode,
                            enabled_modules: tenant.enabled_modules,
                        })
                    );
                });
            }
        }

        const facilities = (userRows || []).map((row: any) => ({
            id: row.id,
            facility_id: row.facility_id,
            facility_name: row.facilities?.name || 'Unknown Facility',
            user_role: row.user_role || roleNamesByUser.get(row.id)?.[0] || 'user',
            user_roles: roleNamesByUser.get(row.id) || undefined,
            tenant_id: row.tenant_id,
            workspace: row.tenant_id
                ? workspaceByTenantId.get(row.tenant_id) || normalizeWorkspaceMetadata(null)
                : normalizeWorkspaceMetadata(null),
        }));

        return res.json({ facilities });
    } catch (err: any) {
        console.error('Facilities fetch error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/clinic-admin-onboarding/register
 * Creates the auth account for an approved clinic admin without forcing
 * email confirmation before first sign-in. The app enforces verification
 * later through the 3-day grace-period gate.
 */
router.post('/clinic-admin-onboarding/register', async (req, res) => {
    const parsed = clinicAdminOnboardingRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    try {
        const { facilityId, adminEmail, password, name } = parsed.data;
        const normalizedEmail = normalizeEmail(adminEmail);

        const { data: facility, error: facilityError } = await supabaseAdmin
            .from('facilities')
            .select('id, tenant_id, verified, admin_user_id, name')
            .eq('id', facilityId)
            .maybeSingle();

        if (facilityError || !facility) {
            return res.status(404).json({ error: 'Facility not found' });
        }

        if (!facility.verified) {
            return res.status(403).json({ error: 'Facility is not approved' });
        }

        if (facility.admin_user_id) {
            return res.status(409).json({ error: 'Facility admin has already been assigned' });
        }

        const resolvedName = name?.trim() || normalizedEmail.split('@')[0];
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: normalizedEmail,
            password,
            email_confirm: true,
            user_metadata: {
                name: resolvedName,
                full_name: resolvedName,
                role: 'admin',
                user_role: 'admin',
                facility_id: facility.id,
                tenant_id: facility.tenant_id,
            },
        });

        if (authError || !authData.user) {
            const message = authError?.message || 'Failed to create auth account';
            if (/already.*registered|duplicate/i.test(message)) {
                return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
            }
            return res.status(400).json({ error: message });
        }

        await sendSignupVerificationEmail(normalizedEmail);

        return res.status(201).json({
            success: true,
            authUserId: authData.user.id,
            facilityId: facility.id,
            tenantId: facility.tenant_id,
            facilityName: facility.name,
            email: normalizedEmail,
        });
    } catch (err: any) {
        console.error('Clinic admin onboarding registration error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/clinic-admin-onboarding/complete
 * Finalizes clinic-admin account linkage after sign-up.
 */
router.post('/clinic-admin-onboarding/complete', requireUser, async (req, res) => {
    const parsed = completeClinicAdminOnboardingSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    try {
        const { authUserId } = req.user!;
        const { facilityId, adminEmail, name } = parsed.data;
        const normalizedEmail = adminEmail.trim().toLowerCase();

        const { data: authUserData, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(authUserId);
        if (authUserError || !authUserData.user) {
            return res.status(401).json({ error: 'Invalid user context' });
        }

        const callerEmail = authUserData.user.email?.trim().toLowerCase();
        if (!callerEmail || callerEmail !== normalizedEmail) {
            return res.status(403).json({ error: 'Onboarding link email does not match authenticated user' });
        }

        const { data: facility, error: facilityError } = await supabaseAdmin
            .from('facilities')
            .select('id, tenant_id, verified, admin_user_id, name')
            .eq('id', facilityId)
            .maybeSingle();

        if (facilityError || !facility) {
            return res.status(404).json({ error: 'Facility not found' });
        }

        if (!facility.verified) {
            return res.status(403).json({ error: 'Facility is not approved' });
        }

        if (facility.admin_user_id && facility.admin_user_id !== authUserId) {
            return res.status(409).json({ error: 'Facility admin has already been assigned' });
        }

        let { data: userProfile } = await supabaseAdmin
            .from('users')
            .select('id')
            .eq('auth_user_id', authUserId)
            .maybeSingle();

        const userName = name?.trim() || authUserData.user.user_metadata?.name || normalizedEmail.split('@')[0];

        if (!userProfile) {
            const { data: insertedUser, error: insertError } = await supabaseAdmin
                .from('users')
                .insert({
                    auth_user_id: authUserId,
                    name: userName,
                    full_name: userName,
                    facility_id: facility.id,
                    tenant_id: facility.tenant_id,
                    user_role: 'admin',
                    verified: true,
                    email_verified: false,
                })
                .select('id')
                .single();

            if (insertError || !insertedUser) {
                return res.status(500).json({ error: insertError?.message || 'Failed to create user profile' });
            }
            userProfile = insertedUser;
        } else {
            const { error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    name: userName,
                    full_name: userName,
                    facility_id: facility.id,
                    tenant_id: facility.tenant_id,
                    user_role: 'admin',
                    verified: true,
                    email_verified: false,
                })
                .eq('id', userProfile.id);

            if (updateError) {
                return res.status(500).json({ error: updateError.message });
            }
        }

        if (!facility.admin_user_id) {
            const { error: assignFacilityAdminError } = await supabaseAdmin
                .from('facilities')
                .update({ admin_user_id: authUserId })
                .eq('id', facility.id);

            if (assignFacilityAdminError) {
                return res.status(500).json({ error: assignFacilityAdminError.message });
            }
        }

        const { data: clinicAdminRole, error: clinicAdminRoleError } = await supabaseAdmin
            .from('roles')
            .select('id, name')
            .or('slug.eq.clinic-admin,name.eq.clinic_admin')
            .maybeSingle();

        if (clinicAdminRoleError) {
            return res.status(500).json({ error: clinicAdminRoleError.message });
        }

        if (clinicAdminRole?.id) {
            const { data: existingRoleLink } = await supabaseAdmin
                .from('user_roles')
                .select('id')
                .eq('user_id', userProfile.id)
                .eq('role_id', clinicAdminRole.id)
                .eq('facility_id', facility.id)
                .maybeSingle();

            if (!existingRoleLink) {
                const { error: roleInsertError } = await supabaseAdmin.from('user_roles').insert({
                    user_id: userProfile.id,
                    role_id: clinicAdminRole.id,
                    facility_id: facility.id,
                    tenant_id: facility.tenant_id,
                    is_active: true,
                    assigned_by: userProfile.id,
                });

                if (roleInsertError) {
                    return res.status(500).json({ error: roleInsertError.message });
                }
            }
        }

        let provisioning: Awaited<ReturnType<typeof provisionWorkspaceDefaults>> | null = null;
        try {
            provisioning = await provisionWorkspaceDefaults({
                tenantId: facility.tenant_id,
                facilityId: facility.id,
                userId: userProfile.id,
                workspaceType: 'clinic',
                setupMode: 'recommended',
                teamMode: 'solo',
            });
        } catch (provisioningError: any) {
            console.error(
                'Workspace provisioning failed during clinic admin onboarding:',
                provisioningError?.message || provisioningError
            );
        }

        return res.json({
            success: true,
            facilityId: facility.id,
            facilityName: facility.name,
            provisioning,
        });
    } catch (err: any) {
        console.error('Clinic admin onboarding completion error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/register-provider
 * Creates a solo provider auth account without blocking first login on
 * email confirmation. The app still enforces verification after the 3-day
 * grace period.
 */
router.post('/register-provider', async (req, res) => {
    const parsed = soloProviderRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    try {
        const normalizedEmail = normalizeEmail(parsed.data.email);
        const normalizedFullName = parsed.data.fullName.trim();
        const normalizedPhoneNumber = parsed.data.phoneNumber?.replace(/\s+/g, '') || null;

        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: normalizedEmail,
            password: parsed.data.password,
            email_confirm: true,
            user_metadata: {
                name: normalizedFullName,
                full_name: normalizedFullName,
                phone_number: normalizedPhoneNumber,
                role: 'provider',
                user_role: 'doctor',
            },
        });

        if (authError || !authData.user) {
            const message = authError?.message || 'Failed to create auth account';
            if (/already.*registered|duplicate/i.test(message)) {
                return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
            }
            return res.status(400).json({ error: message });
        }

        await sendSignupVerificationEmail(normalizedEmail);

        return res.status(201).json({
            success: true,
            authUserId: authData.user.id,
            email: normalizedEmail,
        });
    } catch (err: any) {
        console.error('Provider registration error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/provider-onboarding/complete
 * Creates or finalizes a solo provider workspace for the authenticated user.
 */
router.post('/provider-onboarding/complete', requireUser, async (req, res) => {
    const sessionId = resolvePlatformSessionId(req.header('x-link-session-id'));
    const parsed = completeProviderOnboardingSchema.safeParse(req.body || {});
    if (!parsed.success) {
        void recordPlatformActivityEvent(
            {
                sessionId,
                source: 'web',
                category: 'registration',
                eventName: 'registration.solo_provider.failed',
                outcome: 'failure',
                actorUserId: req.user?.profileId || null,
                actorAuthUserId: req.user?.authUserId || null,
                actorRole: req.user?.role || 'provider_candidate',
                actorEmail: req.user?.email || null,
                tenantId: req.user?.tenantId || null,
                facilityId: req.user?.facilityId || null,
                pagePath: '/auth',
                entryPoint: 'solo_provider_registration',
                errorMessage: parsed.error.issues[0]?.message || 'Invalid payload',
                responseStatus: 400,
            },
            {
                actorUserId: req.user?.profileId || null,
                actorAuthUserId: req.user?.authUserId || null,
                actorRole: req.user?.role || null,
                actorEmail: req.user?.email || null,
                tenantId: req.user?.tenantId || null,
                facilityId: req.user?.facilityId || null,
            }
        ).catch(() => undefined);
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    try {
        const { authUserId } = req.user!;
        const { data: authUserData, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(authUserId);

        if (authUserError || !authUserData.user) {
            return res.status(401).json({ error: 'Invalid user context' });
        }

        const normalizedEmail = authUserData.user.email?.trim().toLowerCase();
        if (!normalizedEmail) {
            return res.status(400).json({ error: 'Authenticated user email is required' });
        }

        const userMetadata = (authUserData.user.user_metadata || {}) as Record<string, unknown>;
        const resolvedFullName =
            parsed.data.fullName?.trim() ||
            (typeof userMetadata.full_name === 'string' ? userMetadata.full_name : null) ||
            (typeof userMetadata.name === 'string' ? userMetadata.name : null) ||
            normalizedEmail.split('@')[0];
        const normalizedPhoneNumber = parsed.data.phoneNumber
            ? parsed.data.phoneNumber.replace(/\s+/g, '')
            : null;
        const workspaceName = (parsed.data.workspaceName || `${resolvedFullName} Solo Practice`).trim();

        const { data: existingUser, error: existingUserError } = await supabaseAdmin
            .from('users')
            .select('id, tenant_id, facility_id')
            .eq('auth_user_id', authUserId)
            .maybeSingle();

        if (existingUserError) {
            return res.status(500).json({ error: existingUserError.message });
        }

        let tenantId = existingUser?.tenant_id ?? null;
        let facilityId = existingUser?.facility_id ?? null;
        let clinicCode: string | null = null;

        // Recovery path for partially provisioned provider accounts:
        // if a facility was already created in a previous failed run,
        // re-use it instead of creating duplicates.
        if (!facilityId) {
            const { data: ownedFacility, error: ownedFacilityError } = await supabaseAdmin
                .from('facilities')
                .select('id, tenant_id, clinic_code')
                .eq('admin_user_id', authUserId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (ownedFacilityError) {
                return res.status(500).json({ error: ownedFacilityError.message });
            }

            if (ownedFacility?.id) {
                facilityId = ownedFacility.id;
                clinicCode = (ownedFacility.clinic_code as string | null) ?? null;
                tenantId = ownedFacility.tenant_id || tenantId;
            }
        }

        // New auth records may carry the legacy placeholder tenant from trigger defaults.
        // Treat it as "no tenant assigned yet" when onboarding a solo provider workspace.
        if (tenantId === LEGACY_DEFAULT_TENANT_ID && !facilityId) {
            tenantId = null;
        }

        if (!tenantId) {
            const { data: tenantInsert, error: tenantInsertError } = await supabaseAdmin
                .from('tenants')
                .insert({
                    name: workspaceName,
                    is_active: true,
                    workspace_type: 'provider',
                    setup_mode: 'recommended',
                    team_mode: 'solo',
                    enabled_modules: [],
                })
                .select('id')
                .single();

            if (tenantInsertError || !tenantInsert?.id) {
                return res.status(500).json({ error: tenantInsertError?.message || 'Failed to create provider tenant' });
            }

            await provisionTrial(tenantInsert.id, 'health_centre');
            tenantId = tenantInsert.id;
        }

        if (!facilityId) {
            const { data: codeData, error: codeError } = await supabaseAdmin.rpc('generate_clinic_code', {
                clinic_name_input: workspaceName,
            });

            if (codeError) {
                return res.status(500).json({ error: codeError.message });
            }

            clinicCode = (codeData as string) || null;

            const { data: facilityInsert, error: facilityInsertError } = await supabaseAdmin
                .from('facilities')
                .insert({
                    tenant_id: tenantId,
                    name: workspaceName,
                    facility_type: 'clinic',
                    location: null,
                    address: null,
                    phone_number: normalizedPhoneNumber,
                    email: normalizedEmail,
                    clinic_code: clinicCode,
                    verification_status: 'approved',
                    verified: true,
                    activation_status: 'active',
                    admin_user_id: authUserId,
                    notes: JSON.stringify({
                        source: 'provider_self_serve',
                        provider_name: resolvedFullName,
                    }),
                })
                .select('id, clinic_code')
                .single();

            if (facilityInsertError || !facilityInsert?.id) {
                const { data: existingFacilityByName, error: existingFacilityByNameError } = await supabaseAdmin
                    .from('facilities')
                    .select('id, clinic_code')
                    .eq('tenant_id', tenantId)
                    .eq('name', workspaceName)
                    .order('created_at', { ascending: true })
                    .limit(1)
                    .maybeSingle();

                if (existingFacilityByNameError || !existingFacilityByName?.id) {
                    return res.status(500).json({
                        error:
                            facilityInsertError?.message ||
                            existingFacilityByNameError?.message ||
                            'Failed to create provider facility',
                    });
                }

                facilityId = existingFacilityByName.id;
                clinicCode = (existingFacilityByName.clinic_code as string | null) ?? clinicCode;
            } else {
                facilityId = facilityInsert.id;
                clinicCode = (facilityInsert.clinic_code as string | null) ?? clinicCode;
            }
        } else {
            const { data: existingFacility, error: existingFacilityError } = await supabaseAdmin
                .from('facilities')
                .select('id, tenant_id, clinic_code, admin_user_id')
                .eq('id', facilityId)
                .maybeSingle();

            if (existingFacilityError || !existingFacility) {
                return res.status(500).json({ error: existingFacilityError?.message || 'Failed to load provider facility' });
            }

            clinicCode = existingFacility.clinic_code || null;
            if (!tenantId) {
                tenantId = existingFacility.tenant_id || null;
            }

            if (!existingFacility.admin_user_id) {
                await supabaseAdmin
                    .from('facilities')
                    .update({ admin_user_id: authUserId })
                    .eq('id', facilityId);
            }
        }

        if (!tenantId || !facilityId) {
            return res.status(500).json({ error: 'Provider workspace context is incomplete' });
        }

        let userProfileId = existingUser?.id || null;
        if (!existingUser) {
            const { data: insertedUser, error: insertUserError } = await supabaseAdmin
                .from('users')
                .insert({
                    auth_user_id: authUserId,
                    name: resolvedFullName,
                    full_name: resolvedFullName,
                    phone_number: normalizedPhoneNumber,
                    facility_id: facilityId,
                    tenant_id: tenantId,
                    role: 'provider',
                    user_role: 'doctor',
                    verified: true,
                    email_verified: false,
                })
                .select('id')
                .single();

            if (insertUserError || !insertedUser?.id) {
                return res.status(500).json({ error: insertUserError?.message || 'Failed to create provider profile' });
            }

            userProfileId = insertedUser.id;
        } else {
            const providerUserUpdatePayload: Record<string, unknown> = {
                name: resolvedFullName,
                full_name: resolvedFullName,
                facility_id: facilityId,
                tenant_id: tenantId,
                role: 'provider',
                user_role: 'doctor',
                verified: true,
                email_verified: false,
            };
            if (normalizedPhoneNumber) {
                providerUserUpdatePayload.phone_number = normalizedPhoneNumber;
            }

            const { error: updateUserError } = await supabaseAdmin
                .from('users')
                .update(providerUserUpdatePayload)
                .eq('id', existingUser.id);

            if (updateUserError) {
                return res.status(500).json({ error: updateUserError.message });
            }
            userProfileId = existingUser.id;
        }

        const { data: doctorRole, error: doctorRoleError } = await supabaseAdmin
            .from('roles')
            .select('id')
            .or('slug.eq.doctor,name.eq.doctor')
            .maybeSingle();

        if (doctorRoleError) {
            return res.status(500).json({ error: doctorRoleError.message });
        }

        if (doctorRole?.id && userProfileId) {
            const { data: existingRoleLink, error: existingRoleError } = await supabaseAdmin
                .from('user_roles')
                .select('id')
                .eq('user_id', userProfileId)
                .eq('role_id', doctorRole.id)
                .eq('facility_id', facilityId)
                .maybeSingle();

            if (existingRoleError) {
                return res.status(500).json({ error: existingRoleError.message });
            }

            if (!existingRoleLink) {
                const { error: roleInsertError } = await supabaseAdmin
                    .from('user_roles')
                    .insert({
                        user_id: userProfileId,
                        role_id: doctorRole.id,
                        facility_id: facilityId,
                        tenant_id: tenantId,
                        is_active: true,
                        assigned_by: userProfileId,
                    });

                if (roleInsertError) {
                    return res.status(500).json({ error: roleInsertError.message });
                }
            }
        }

        let provisioning: Awaited<ReturnType<typeof provisionWorkspaceDefaults>> | null = null;
        try {
            provisioning = await provisionWorkspaceDefaults({
                tenantId,
                facilityId,
                userId: userProfileId!,
                workspaceType: 'provider',
                setupMode: 'recommended',
                teamMode: 'solo',
            });
        } catch (provisioningError: any) {
            console.error(
                'Workspace provisioning failed during provider onboarding:',
                provisioningError?.message || provisioningError
            );
        }

        try {
            await supabaseAdmin.auth.admin.updateUserById(authUserId, {
                user_metadata: {
                    ...userMetadata,
                    name: resolvedFullName,
                    full_name: resolvedFullName,
                    user_role: 'doctor',
                    facility_id: facilityId,
                    tenant_id: tenantId,
                    workspace_type: 'provider',
                },
            });
        } catch (authMetadataError: any) {
            console.warn('Provider onboarding metadata update failed:', authMetadataError?.message || authMetadataError);
        }

        try {
            await recordPlatformActivityEvent(
                {
                    sessionId,
                    source: 'web',
                    category: 'registration',
                    eventName: 'registration.solo_provider.completed',
                    outcome: 'success',
                    actorUserId: userProfileId,
                    actorAuthUserId: authUserId,
                    actorRole: 'doctor',
                    actorEmail: normalizedEmail,
                    tenantId,
                    facilityId,
                    pagePath: '/auth',
                    entryPoint: 'solo_provider_registration',
                    metadata: {
                        clinicCode,
                        providerName: resolvedFullName,
                        workspaceName,
                    },
                },
                {
                    actorUserId: userProfileId,
                    actorAuthUserId: authUserId,
                    actorRole: 'doctor',
                    actorEmail: normalizedEmail,
                    tenantId,
                    facilityId,
                }
            );
        } catch (auditError: any) {
            console.warn('Provider onboarding audit logging failed:', auditError?.message || auditError);
        }

        return res.json({
            success: true,
            profileId: userProfileId,
            tenantId,
            facilityId,
            clinicCode,
            provisioning,
        });
    } catch (err: any) {
        console.error('Provider onboarding completion error:', err?.message || err);
        try {
            await recordPlatformActivityEvent(
                {
                    sessionId,
                    source: 'web',
                    category: 'registration',
                    eventName: 'registration.solo_provider.failed',
                    outcome: 'failure',
                    actorUserId: req.user?.profileId || null,
                    actorAuthUserId: req.user?.authUserId || null,
                    actorRole: req.user?.role || 'provider_candidate',
                    actorEmail: req.user?.email || null,
                    tenantId: req.user?.tenantId || null,
                    facilityId: req.user?.facilityId || null,
                    pagePath: '/auth',
                    entryPoint: 'solo_provider_registration',
                    responseStatus: 500,
                    errorMessage: err?.message || 'Provider onboarding failed',
                    metadata: {
                        workspaceName: parsed.data.workspaceName || null,
                        providerName: parsed.data.fullName || null,
                    },
                },
                {
                    actorUserId: req.user?.profileId || null,
                    actorAuthUserId: req.user?.authUserId || null,
                    actorRole: req.user?.role || null,
                    actorEmail: req.user?.email || null,
                    tenantId: req.user?.tenantId || null,
                    facilityId: req.user?.facilityId || null,
                }
            );
        } catch (auditError: any) {
            console.warn('Provider onboarding failure audit logging failed:', auditError?.message || auditError);
        }
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/auth/roles
 * Returns RBAC roles for the authenticated user.
 */
router.get('/roles', requireUser, async (req, res) => {
    try {
        const { authUserId } = req.user!;
        const { data: userData, error: userError } = await supabaseAdmin
            .from('users')
            .select('id')
            .eq('auth_user_id', authUserId)
            .maybeSingle();

        if (userError || !userData) {
            return res.status(404).json({ error: 'User data not found' });
        }

        const { data: userRolesData, error: rolesError } = await supabaseAdmin
            .from('user_roles')
            .select(`
        id, user_id, role_id, facility_id, tenant_id,
        assigned_at, assigned_by, expires_at, is_active, metadata,
        roles:role_id (id, name, description, slug, is_active, scope)
      `)
            .eq('user_id', userData.id)
            .eq('is_active', true)
            .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
            .order('assigned_at', { ascending: false });

        if (rolesError) {
            return res.status(500).json({ error: rolesError.message });
        }

        const data = (userRolesData || []).map((ur: any) => ({
            id: ur.id,
            user_id: ur.user_id,
            role_id: ur.role_id,
            facility_id: ur.facility_id,
            tenant_id: ur.tenant_id,
            assigned_at: ur.assigned_at,
            assigned_by: ur.assigned_by,
            expires_at: ur.expires_at,
            is_active: ur.is_active,
            metadata: ur.metadata,
            role: ur.roles || null,
        }));

        const superAdminRole = data.find((role: any) =>
            role.role?.slug === 'super-admin' || role.role?.name === 'super_admin'
        );

        const rolesWithPrimary = data.map((role: any, index: number) => ({
            ...role,
            is_primary: superAdminRole
                ? (role.role?.slug === 'super-admin' || role.role?.name === 'super_admin')
                : (role.metadata?.is_primary || index === 0),
        }));

        return res.json({ roles: rolesWithPrimary });
    } catch (err: any) {
        console.error('Roles fetch error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/auth/permissions
 * Returns permissions for the authenticated user.
 */
router.get('/permissions', requireUser, async (req, res) => {
    try {
        const { authUserId } = req.user!;
        const parsed = facilityQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
        }

        const { data: userData, error: userError } = await supabaseAdmin
            .from('users')
            .select('id')
            .eq('auth_user_id', authUserId)
            .maybeSingle();

        if (userError || !userData) {
            return res.status(404).json({ error: 'User data not found' });
        }

        const { data, error } = await supabaseAdmin
            .rpc('get_user_permissions', {
                _user_id: userData.id,
                _facility_id: parsed.data.facilityId || null,
            });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const permissions = (data || []).map((p: any) => ({
            permission_code: `${p.resource}:${p.action}`,
            permission_name: p.permission_name,
            module: p.category,
        }));

        return res.json({ permissions });
    } catch (err: any) {
        console.error('Permissions fetch error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

const passwordResetSchema = z.object({
    email: z.string().email(),
});

/**
 * POST /api/auth/request-password-reset
 * Sends a password reset email with a redirect back to the frontend.
 */
router.post('/request-password-reset', async (req, res) => {
    try {
        const { email } = passwordResetSchema.parse(req.body);
        const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
            redirectTo: `${FRONTEND_URL}/auth/reset-password`,
        });

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        return res.json({ success: true });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors[0].message });
        }
        console.error('Password reset request error:', error?.message || error);
        return res.status(500).json({ error: 'Failed to send reset email' });
    }
});

// Schema for staff registration request
const staffRegistrationSchema = z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    role: z.string(),
    clinicCode: z.string().min(3),
    password: z
        .string()
        .min(12, 'Password must be at least 12 characters long')
        .regex(/[a-z]/, 'Password must include at least one lowercase letter')
        .regex(/[A-Z]/, 'Password must include at least one uppercase letter')
        .regex(/[0-9]/, 'Password must include at least one number')
        .regex(/[^A-Za-z0-9]/, 'Password must include at least one special character'),
    invitationToken: z.string().optional(),
    verificationCode: z.string().optional(),
});

const nonAssignableRoles = new Set(['super_admin']);
const normalizeRole = (role: string) => role.trim().toLowerCase();

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

const verifyRegistrationCodeSchema = z.object({
    email: z.string().email(),
    verificationCode: z.string().regex(/^\d{6}$/, 'Verification code must be a 6-digit number'),
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
        void role; // Role validation is handled during registration completion.
        const normalizedEmail = normalizeEmail(email);

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
        const verificationCode = generateVerificationCode();
        const hashedCode = hashVerificationCode(normalizedEmail, verificationCode);
        const expiresAt = buildVerificationCodeExpiry();

        await supabaseAdmin
            .from('email_verification_codes')
            .delete()
            .eq('email', normalizedEmail)
            .is('verified_at', null);

        // 3. Store Code securely
        const { data: insertedCode, error: codeError } = await supabaseAdmin
            .from('email_verification_codes')
            .insert({
                email: normalizedEmail,
                code: hashedCode,
                expires_at: expiresAt,
            })
            .select('id')
            .maybeSingle();

        if (codeError) {
            console.error('Store code error:', codeError?.message || codeError);
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
            console.error('Send email error:', emailError?.message || emailError);
            if (insertedCode?.id) {
                await supabaseAdmin.from('email_verification_codes').delete().eq('id', insertedCode.id);
            }
            return res.status(500).json({ error: 'Failed to send verification email' });
        }

        return res.json({ success: true, message: 'Verification code sent' });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors[0].message });
        }
        console.error('Initiate registration error:', error?.message || error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/verify-registration-code
 * Validates the latest pending code for a staff registration email.
 */
router.post('/verify-registration-code', async (req, res) => {
    try {
        const { email, verificationCode } = verifyRegistrationCodeSchema.parse(req.body);
        const normalizedEmail = normalizeEmail(email);
        const pendingCode = await loadLatestPendingVerificationCode(normalizedEmail);

        if (!pendingCode) {
            return res.status(400).json({ error: 'No pending verification code found. Please request a new code.' });
        }

        if (new Date(pendingCode.expires_at) < new Date()) {
            return res.status(400).json({ error: 'This verification code has expired. Please request a new one.' });
        }

        const currentAttempts = pendingCode.attempts ?? 0;
        const maxAttempts = pendingCode.max_attempts ?? 5;
        if (currentAttempts >= maxAttempts) {
            return res.status(429).json({
                error: 'You have exceeded the maximum verification attempts. Please request a new code.',
            });
        }

        const hashedInput = hashVerificationCode(normalizedEmail, verificationCode);
        const codeMatches = pendingCode.code === hashedInput || pendingCode.code === verificationCode.trim();

        if (!codeMatches) {
            const attempts = currentAttempts + 1;
            await supabaseAdmin
                .from('email_verification_codes')
                .update({ attempts })
                .eq('id', pendingCode.id);

            const remainingAttempts = Math.max(maxAttempts - attempts, 0);
            return res.status(400).json({
                error:
                    remainingAttempts > 0
                        ? `Invalid verification code. ${remainingAttempts} attempt(s) remaining.`
                        : 'You have exceeded the maximum verification attempts. Please request a new code.',
                remainingAttempts,
            });
        }

        const verificationUpdate: { verified_at: string; attempts: number; code?: string } = {
            verified_at: new Date().toISOString(),
            attempts: currentAttempts + 1,
        };
        if (pendingCode.code !== hashedInput) {
            verificationUpdate.code = hashedInput;
        }

        const { error: updateError } = await supabaseAdmin
            .from('email_verification_codes')
            .update(verificationUpdate)
            .eq('id', pendingCode.id);

        if (updateError) {
            return res.status(500).json({ error: 'Failed to verify code' });
        }

        return res.json({ success: true });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors[0].message });
        }
        console.error('Verify registration code error:', error?.message || error);
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
        const normalizedEmail = email.trim().toLowerCase();
        const requestedRole = normalizeRole(role);

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

        let effectiveRole = requestedRole;

        // 2. Verify Invitation or Code
        if (invitationToken) {
            const { data: inv } = await supabaseAdmin
                .from('staff_invitations')
                .select('id, email, role, facility_id, expires_at, accepted')
                .eq('invitation_token', invitationToken)
                .maybeSingle();

            if (!inv || inv.accepted) {
                return res.status(400).json({ error: 'Invalid or used invitation token' });
            }

            if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
                return res.status(400).json({ error: 'Invitation expired' });
            }

            if ((inv.email || '').trim().toLowerCase() !== normalizedEmail) {
                return res.status(400).json({ error: 'Invitation email does not match registration email' });
            }

            if (inv.facility_id !== facility.id) {
                return res.status(400).json({ error: 'Invitation does not match selected clinic' });
            }

            effectiveRole = normalizeRole(inv.role || requestedRole);
        } else if (verificationCode) {
            const { record: verifiedCode, usedLegacyPlaintext } = await loadVerifiedCodeMatch(
                normalizedEmail,
                verificationCode
            );

            if (!verifiedCode) {
                return res.status(400).json({ error: 'Verification code is invalid, expired, or not yet verified' });
            }

            if (new Date(verifiedCode.expires_at) < new Date()) {
                return res.status(400).json({ error: 'Invalid or expired verification code' });
            }

            if (usedLegacyPlaintext) {
                const hashedCode = hashVerificationCode(normalizedEmail, verificationCode);
                await supabaseAdmin
                    .from('email_verification_codes')
                    .update({ code: hashedCode })
                    .eq('id', verifiedCode.id);
            }

            await supabaseAdmin.from('email_verification_codes').delete().eq('id', verifiedCode.id);
        } else {
            return res.status(400).json({ error: 'Missing invitation token or verification code' });
        }

        if (nonAssignableRoles.has(effectiveRole)) {
            return res.status(403).json({ error: 'Requested role is not assignable' });
        }

        // 3. Create Auth User
        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: normalizedEmail,
            password,
            email_confirm: true, // Auto-confirm since we verified email via code/invite
            user_metadata: {
                name: fullName,
                full_name: fullName,
                user_role: effectiveRole,
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
                email: normalizedEmail,
                requested_role: effectiveRole,
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
        console.error('Register staff error:', error?.message || error);
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
            .select('email, role, expires_at, accepted, facility_id, tenant_id, facility:facility_id(name, clinic_code)')
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

        let authUserExists = false;
        const { data: authRow, error: authError } = await supabaseAdmin
            .schema('auth')
            .from('users')
            .select('id')
            .eq('email', data.email.toLowerCase())
            .maybeSingle();

        if (!authError && authRow?.id) {
            authUserExists = true;
        }

        return res.json({
            ...data,
            auth_user_exists: authUserExists,
        });
    } catch (error: any) {
        console.error('Get invitation error:', error?.message || error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/auth/register-clinic
 * Single-step clinic registration: creates auth user, tenant, facility,
 * user profile, and assigns clinic-admin role. Returns session for immediate login.
 * Email verification is soft-required for the first 3 days, then hard-required.
 */
router.post('/register-clinic', async (req, res) => {
    const parsed = directClinicRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const { clinic, admin } = parsed.data;
    const normalizedAdminEmail = normalizeEmail(admin.email);
    const normalizedClinicName = clinic.name.trim();

    try {
        // 1. Create Supabase auth user
        // email_confirm: true so Supabase allows signInWithPassword immediately.
        // Real email verification is tracked via users.email_verified + EmailVerificationGate
        // which gives a 3-day grace period before requiring verification.
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: normalizedAdminEmail,
            password: admin.password,
            email_confirm: true,
            user_metadata: {
                name: admin.name.trim(),
                user_role: 'admin',
                role: 'admin',
            },
        });

        if (authError || !authData.user) {
            const msg = authError?.message || 'Failed to create auth account';
            if (/already.*registered|duplicate/i.test(msg)) {
                return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
            }
            return res.status(400).json({ error: msg });
        }

        const authUserId = authData.user.id;

        // 2. Create tenant
        const { data: tenantInsert, error: tenantErr } = await supabaseAdmin
            .from('tenants')
            .insert({
                name: normalizedClinicName,
                is_active: true,
                workspace_type: 'clinic',
                setup_mode: 'recommended',
                team_mode: 'solo',
                enabled_modules: [
                    'patients', 'visits', 'records', 'referrals', 'follow_up', 'link_agent', 'cdss_core',
                    'reception', 'triage', 'cashier', 'lab', 'imaging', 'pharmacy', 'patient_app_sync', 'hew_referral_handoff',
                ],
            })
            .select('id')
            .single();

        if (tenantErr || !tenantInsert?.id) {
            // Cleanup: delete auth user on failure
            await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
            throw new Error(tenantErr?.message || 'Failed to create tenant');
        }

        const tenantId = tenantInsert.id as string;

        // 3. Provision 30-day trial
        try {
            await provisionTrial(tenantId);
        } catch (trialErr: any) {
            console.error('Trial provisioning failed during direct registration:', trialErr?.message);
        }

        // 4. Generate clinic code
        const { data: codeData, error: codeErr } = await supabaseAdmin.rpc('generate_clinic_code', {
            clinic_name_input: normalizedClinicName,
        });

        const clinicCode = (codeData as string) || normalizedClinicName.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

        if (codeErr) {
            console.warn('Clinic code generation via RPC failed, using fallback:', codeErr.message);
        }

        // 5. Create facility (auto-verified, no approval needed)
        const { data: facilityInsert, error: facilityErr } = await supabaseAdmin
            .from('facilities')
            .insert({
                name: normalizedClinicName,
                tenant_id: tenantId,
                clinic_code: clinicCode,
                country: clinic.country.trim(),
                location: clinic.location.trim(),
                address: clinic.address.trim(),
                phone_number: clinic.phoneNumber.replace(/\s+/g, ''),
                email: clinic.email ? clinic.email.trim().toLowerCase() : null,
                verified: true,
                verification_status: 'approved',
                activation_status: 'testing',
                admin_user_id: authUserId,
                notes: JSON.stringify({
                    admin_name: admin.name.trim(),
                    admin_email: normalizedAdminEmail,
                    admin_phone: admin.phoneNumber.replace(/\s+/g, ''),
                    registered_via: 'direct_registration',
                }),
            })
            .select('id')
            .single();

        if (facilityErr || !facilityInsert?.id) {
            // Cleanup
            try { await supabaseAdmin.from('tenants').delete().eq('id', tenantId); } catch {}
            try { await supabaseAdmin.auth.admin.deleteUser(authUserId); } catch {}
            throw new Error(facilityErr?.message || 'Failed to create facility');
        }

        const facilityId = facilityInsert.id as string;

        // 6. Update auth user metadata with facility/tenant IDs
        await supabaseAdmin.auth.admin.updateUserById(authUserId, {
            user_metadata: {
                name: admin.name.trim(),
                user_role: 'admin',
                role: 'admin',
                facility_id: facilityId,
                facility_name: normalizedClinicName,
                facility_name_hint: normalizedClinicName,
                tenant_id: tenantId,
            },
        });

        // 7. Create user profile
        const userName = admin.name.trim();
        const { data: userProfile, error: profileErr } = await supabaseAdmin
            .from('users')
            .insert({
                auth_user_id: authUserId,
                name: userName,
                full_name: userName,
                email: normalizedAdminEmail,
                facility_id: facilityId,
                tenant_id: tenantId,
                user_role: 'admin',
                verified: true,
                email_verified: false,
            })
            .select('id')
            .single();

        if (profileErr || !userProfile?.id) {
            console.error('User profile creation failed:', profileErr?.message);
        }

        // 8. Assign clinic-admin RBAC role
        if (userProfile?.id) {
            const { data: clinicAdminRole } = await supabaseAdmin
                .from('roles')
                .select('id')
                .or('slug.eq.clinic-admin,name.eq.clinic_admin')
                .maybeSingle();

            if (clinicAdminRole?.id) {
                try {
                    const { error: roleInsertErr } = await supabaseAdmin.from('user_roles').insert({
                        user_id: userProfile.id,
                        role_id: clinicAdminRole.id,
                        facility_id: facilityId,
                        tenant_id: tenantId,
                        is_active: true,
                        assigned_by: userProfile.id,
                    });
                    if (roleInsertErr) {
                        console.error('Role assignment failed:', roleInsertErr.message);
                    }
                } catch (roleErr: any) {
                    console.error('Role assignment failed:', roleErr?.message);
                }
            }
        }

        // 9. Provision workspace defaults
        if (userProfile?.id) {
            try {
                await provisionWorkspaceDefaults({
                    tenantId,
                    facilityId,
                    userId: userProfile.id,
                    workspaceType: 'clinic',
                    setupMode: 'recommended',
                    teamMode: 'solo',
                });
            } catch (provErr: any) {
                console.error('Workspace provisioning failed:', provErr?.message);
            }
        }

        // 10. Also record in clinic_registrations for audit trail
        try {
            const { error: auditErr } = await supabaseAdmin.from('clinic_registrations').insert({
                clinic_name: normalizedClinicName,
                country: clinic.country.trim(),
                location: clinic.location.trim(),
                address: clinic.address.trim(),
                phone_number: clinic.phoneNumber.replace(/\s+/g, ''),
                email: clinic.email ? clinic.email.trim().toLowerCase() : null,
                admin_name: admin.name.trim(),
                admin_email: normalizedAdminEmail,
                admin_phone: admin.phoneNumber.replace(/\s+/g, ''),
                status: 'approved',
                facility_id: facilityId,
                tenant_id: tenantId,
            });
            if (auditErr) console.warn('Audit registration record failed:', auditErr.message);
        } catch (auditErr: any) {
            console.warn('Audit registration record failed:', auditErr?.message);
        }

        // 11. Send verification email via Supabase
        try {
            const { error: resendErr } = await supabaseAdmin.auth.resend({
                type: 'signup',
                email: normalizedAdminEmail,
            });
            if (resendErr) console.warn('Verification email resend failed:', resendErr.message);
        } catch (emailErr: any) {
            console.warn('Verification email send failed:', emailErr?.message);
        }

        return res.status(201).json({
            success: true,
            facilityId,
            tenantId,
            clinicCode,
            authUserId,
            email: normalizedAdminEmail,
            adminName: admin.name.trim(),
            // The frontend will sign in using email/password directly after receiving success
        });
    } catch (err: any) {
        const errMsg = err?.message || String(err);
        console.error('Direct clinic registration failed:', errMsg, err?.stack || '');
        return res.status(500).json({
            error: process.env.NODE_ENV === 'production'
                ? 'Registration failed. Please try again.'
                : `Registration failed: ${errMsg}`,
        });
    }
});

export const __testables = {
    normalizeEmail,
    hashVerificationCode,
    staffRegistrationSchema,
};

export default router;
