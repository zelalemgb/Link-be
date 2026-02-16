import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { isAuditDurabilityError, recordAuditEvent } from '../services/audit-log';
import {
    resolveJoinRequestEligibility,
    type ContractErrorCode,
} from '../services/staffJoinRequestService';

const router = Router();
router.use(requireUser, requireScopedUser);

const adminRoles = new Set([
    'clinic_admin',
    'admin',
    'super_admin',
    'hospital_ceo',
    'medical_director',
    'nursing_head',
]);
const nonAssignableRoles = new Set(['super_admin']);

const normalizeRole = (role: string | undefined | null) => (role || '').trim().toLowerCase();

const resolveAssignableRole = async (requestedRole: string | undefined | null) => {
    const normalizedRole = normalizeRole(requestedRole);
    if (!normalizedRole) {
        return { error: 'Requested role is required' as const };
    }
    if (nonAssignableRoles.has(normalizedRole)) {
        return { error: 'Cannot assign super_admin role' as const };
    }

    const { data: byName, error: byNameError } = await supabaseAdmin
        .from('roles')
        .select('id, name')
        .eq('name', normalizedRole)
        .maybeSingle();

    if (byNameError) {
        throw new Error(byNameError.message);
    }
    if (byName) {
        return { role: byName };
    }

    const { data: bySlug, error: bySlugError } = await supabaseAdmin
        .from('roles')
        .select('id, name')
        .eq('slug', normalizedRole)
        .maybeSingle();

    if (bySlugError) {
        throw new Error(bySlugError.message);
    }
    if (!bySlug) {
        return { error: 'Requested role is not assignable' as const };
    }
    if (nonAssignableRoles.has(normalizeRole(bySlug.name))) {
        return { error: 'Cannot assign super_admin role' as const };
    }

    return { role: bySlug };
};

const ensureClinicAdmin = (req: any, res: any) => {
    const role = req.user?.role;
    if (!role || !adminRoles.has(role)) {
        res.status(403).json({ error: 'You do not have permission to manage staff.' });
        return false;
    }
    return true;
};

const resolveFacilityId = async (req: any) => {
    const { authUserId, facilityId: defaultFacilityId, role } = req.user!;
    const requestedFacilityId = (req.query.facilityId as string | undefined) || defaultFacilityId;
    if (!requestedFacilityId) return undefined;

    if (role === 'super_admin') return requestedFacilityId;

    const { data } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('auth_user_id', authUserId)
        .eq('facility_id', requestedFacilityId)
        .maybeSingle();

    return data ? requestedFacilityId : undefined;
};

const mapRpcErrorStatus = (message: string) => {
    const normalized = message.toLowerCase();
    if (normalized.includes('not found')) return 404;
    if (normalized.includes('outside your facility') || normalized.includes('not authorized')) return 403;
    if (normalized.includes('assignable') || normalized.includes('required')) return 400;
    return 500;
};

const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const resolveUuidOrNull = (value: string | undefined | null) => {
    if (!value) return null;
    const normalized = value.trim();
    return uuidPattern.test(normalized) ? normalized : null;
};

const mapApproveRequestRpcError = (errorMessage: string) => {
    const normalized = (errorMessage || '').toLowerCase();

    if (
        normalized.includes('audit_durability_failure') ||
        normalized.includes('audit_strict_write_failed') ||
        normalized.includes('audit log')
    ) {
        return {
            status: 500,
            code: 'CONFLICT_AUDIT_DURABILITY_FAILURE' as const,
            message: 'Audit durability requirement failed',
        };
    }

    if (normalized.includes('request not found')) {
        return {
            status: 404,
            code: 'VALIDATION_REQUEST_NOT_FOUND' as const,
            message: 'Request not found',
        };
    }

    if (normalized.includes('only pending requests can be approved')) {
        return {
            status: 409,
            code: 'CONFLICT_REQUEST_ALREADY_REVIEWED' as const,
            message: 'Only pending requests can be approved',
        };
    }

    if (
        normalized.includes('outside your facility') ||
        normalized.includes('missing facility or tenant context')
    ) {
        return {
            status: 403,
            code: 'TENANT_RESOURCE_SCOPE_VIOLATION' as const,
            message: 'Cannot manage requests outside your facility',
        };
    }

    if (normalized.includes('not authorized')) {
        return {
            status: 403,
            code: 'PERM_STAFF_REQUEST_APPROVAL_FORBIDDEN' as const,
            message: 'You do not have permission to manage staff.',
        };
    }

    if (normalized.includes('assignable') || normalized.includes('cannot assign super_admin')) {
        return {
            status: 400,
            code: 'VALIDATION_ROLE_NOT_ASSIGNABLE' as const,
            message: 'Requested role is not assignable',
        };
    }

    return {
        status: 500,
        code: 'CONFLICT_REQUEST_APPROVAL_FAILED' as const,
        message: errorMessage || 'Internal server error',
    };
};

const roleUpdateSchema = z.object({
    userId: z.string().uuid(),
    roles: z.array(z.string()).min(1),
    reason: z.string().optional(),
});

const toggleActiveSchema = z.object({
    userId: z.string().uuid(),
    isActive: z.boolean(),
    reason: z.string().optional(),
});

const requestDecisionSchema = z.object({
    reason: z.string().optional(),
});

const normalizeClinicCode = (value: string) => value.trim().toUpperCase();
const normalizeRequestStatus = (status: string | undefined | null) => (status || '').trim().toLowerCase();

const sendContractError = (
    res: any,
    status: number,
    code: ContractErrorCode,
    message: string
) => res.status(status).json({ code, message });

const joinRequestVerifySchema = z.object({
    clinicCode: z
        .string()
        .trim()
        .min(3, 'Clinic code is required')
        .max(32, 'Clinic code is too long')
        .regex(/^[A-Za-z0-9-]+$/, 'Clinic code must use letters, numbers, or hyphens'),
});

const joinRequestSubmitSchema = joinRequestVerifySchema.extend({
    requestedRole: z.string().trim().min(1, 'Requested role is required').max(64),
});


/**
 * GET /api/staff/clinicians
 * Returns doctors and clinical officers for the user's facility
 */
router.get('/clinicians', async (req, res) => {
    const { facilityId } = req.user!;
    try {
        if (!facilityId) {
            return res.status(400).json({ error: 'User does not belong to a facility' });
        }

        const { data, error } = await supabaseAdmin
            .from('users')
            .select('id, name, user_role')
            .eq('facility_id', facilityId)
            .in('user_role', ['doctor', 'clinical_officer'])
            .order('name');

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/staff/join-requests/verify
 * Contract-first endpoint for JoinFacilityDialog clinic-code verification.
 */
router.post('/join-requests/verify', async (req, res) => {
    const parsed = joinRequestVerifySchema.safeParse(req.body);
    if (!parsed.success) {
        return sendContractError(
            res,
            400,
            'VALIDATION_INVALID_CLINIC_CODE',
            parsed.error.issues[0]?.message || 'Invalid clinic code'
        );
    }

    const authUserId = req.user?.authUserId;
    if (!authUserId) {
        return sendContractError(res, 401, 'AUTH_MISSING_USER_CONTEXT', 'Missing authenticated user context');
    }
    const normalizedClinicCode = normalizeClinicCode(parsed.data.clinicCode);

    try {
        const eligibility = await resolveJoinRequestEligibility({
            authUserId,
            tenantId: req.user?.tenantId,
            role: req.user?.role,
            clinicCode: parsed.data.clinicCode,
        });

        const auditTenantId = eligibility.ok
            ? eligibility.facility.tenantId
            : req.user?.tenantId;
        const verifyResultCode = eligibility.ok === false ? eligibility.code : null;
        const verifyCanRequest = eligibility.ok === true ? eligibility.canRequest : false;
        if (auditTenantId) {
            await recordAuditEvent({
                action: 'verify_staff_join_request',
                eventType: 'read',
                entityType: 'staff_registration_request',
                tenantId: auditTenantId,
                facilityId: eligibility.ok ? eligibility.facility.id : null,
                actorUserId: req.user?.profileId || null,
                actorRole: req.user?.role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                actionCategory: 'staff_management',
                metadata: {
                    clinicCode: normalizedClinicCode,
                    eligible: verifyCanRequest,
                    resultCode: verifyResultCode,
                },
                requestId: req.requestId || null,
            });
        }

        if (eligibility.ok === false) {
            return sendContractError(res, eligibility.status, eligibility.code, eligibility.message);
        }

        return res.json({
            facility: {
                id: eligibility.facility.id,
                name: eligibility.facility.name,
            },
            canRequest: eligibility.canRequest,
        });
    } catch (error: any) {
        console.error('Join request verify error:', error?.message || error);
        return sendContractError(res, 500, 'CONFLICT_JOIN_REQUEST_VERIFY_FAILED', 'Unable to verify clinic code');
    }
});

/**
 * POST /api/staff/join-requests
 * Contract-first endpoint for JoinFacilityDialog request submission.
 */
router.post('/join-requests', async (req, res) => {
    const parsed = joinRequestSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
        return sendContractError(
            res,
            400,
            'VALIDATION_INVALID_JOIN_REQUEST',
            parsed.error.issues[0]?.message || 'Invalid join request payload'
        );
    }

    const authUserId = req.user?.authUserId;
    if (!authUserId) {
        return sendContractError(res, 401, 'AUTH_MISSING_USER_CONTEXT', 'Missing authenticated user context');
    }

    try {
        const eligibility = await resolveJoinRequestEligibility({
            authUserId,
            tenantId: req.user?.tenantId,
            role: req.user?.role,
            clinicCode: parsed.data.clinicCode,
        });

        if (eligibility.ok === false) {
            return sendContractError(res, eligibility.status, eligibility.code, eligibility.message);
        }

        if (!eligibility.canRequest) {
            return sendContractError(
                res,
                403,
                'PERM_FACILITY_NOT_ACCEPTING_STAFF',
                'This facility is not accepting new staff requests'
            );
        }

        const resolvedRole = await resolveAssignableRole(parsed.data.requestedRole);
        if ('error' in resolvedRole) {
            return sendContractError(res, 400, 'VALIDATION_ROLE_NOT_ASSIGNABLE', resolvedRole.error);
        }

        const { data: requestingProfile, error: profileError } = await supabaseAdmin
            .from('users')
            .select('id, name, full_name, email')
            .eq('auth_user_id', authUserId)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (profileError) {
            throw new Error(profileError.message);
        }
        if (!requestingProfile) {
            return sendContractError(
                res,
                403,
                'AUTH_PROFILE_CONTEXT_REQUIRED',
                'User profile context is required to submit a join request'
            );
        }

        const displayName = requestingProfile.full_name || requestingProfile.name || 'Staff User';
        const { data: insertedRequest, error: insertError } = await supabaseAdmin
            .from('staff_registration_requests')
            .insert({
                auth_user_id: authUserId,
                name: displayName,
                email: requestingProfile.email || null,
                requested_role: resolvedRole.role.name,
                facility_id: eligibility.facility.id,
                tenant_id: eligibility.facility.tenantId,
                status: 'pending',
                requested_at: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (insertError || !insertedRequest) {
            if (insertError?.code === '23505') {
                return sendContractError(
                    res,
                    409,
                    'CONFLICT_PENDING_JOIN_REQUEST',
                    'A pending request already exists for this facility'
                );
            }
            throw new Error(insertError?.message || 'Failed to create join request');
        }

        await recordAuditEvent({
            action: 'submit_staff_join_request',
            eventType: 'create',
            entityType: 'staff_registration_request',
            tenantId: eligibility.facility.tenantId,
            facilityId: eligibility.facility.id,
            actorUserId: req.user?.profileId || null,
            actorRole: req.user?.role || null,
            actorIpAddress: req.ip,
            actorUserAgent: req.get('user-agent') || null,
            entityId: insertedRequest.id,
            actionCategory: 'staff_management',
            metadata: {
                requestedRole: resolvedRole.role.name,
                clinicCode: parsed.data.clinicCode.trim().toUpperCase(),
            },
            requestId: req.requestId || null,
        }, {
            strict: true,
            outboxEventType: 'audit.staff_join_request.submit.write_failed',
            outboxAggregateType: 'staff_registration_request',
            outboxAggregateId: insertedRequest.id,
        });

        return res.status(201).json({
            success: true,
            requestId: insertedRequest.id,
        });
    } catch (error: any) {
        console.error('Join request submit error:', error?.message || error);
        if (isAuditDurabilityError(error)) {
            return sendContractError(
                res,
                500,
                'CONFLICT_AUDIT_DURABILITY_FAILURE',
                'Audit durability requirement failed'
            );
        }
        return sendContractError(res, 500, 'CONFLICT_JOIN_REQUEST_CREATE_FAILED', 'Unable to submit join request');
    }
});

/**
 * GET /api/staff/admin/list
 * Returns staff list with role assignments for a facility.
 */
router.get('/admin/list', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    const facilityId = await resolveFacilityId(req);
    if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

    try {
        const { data: usersData, error } = await supabaseAdmin
            .from('users')
            .select('id, name, phone_number, user_role, created_at, is_active')
            .eq('facility_id', facilityId)
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });

        const userIds = (usersData || []).map((u: any) => u.id);
        const { data: userRolesData } = userIds.length
            ? await supabaseAdmin
                  .from('user_roles')
                  .select('user_id, role_id')
                  .in('user_id', userIds)
                  .eq('is_active', true)
            : { data: [] };

        const roleIds = [...new Set((userRolesData || []).map((ur: any) => ur.role_id))];
        const { data: rolesData } = roleIds.length
            ? await supabaseAdmin.from('roles').select('id, name').in('id', roleIds)
            : { data: [] };

        const rolesMap = new Map((rolesData || []).map((r: any) => [r.id, r.name]));
        const userRolesMap = new Map<string, string[]>();
        (userRolesData || []).forEach((ur: any) => {
            const roleName = rolesMap.get(ur.role_id);
            if (!roleName) return;
            const existing = userRolesMap.get(ur.user_id) || [];
            existing.push(roleName);
            userRolesMap.set(ur.user_id, existing);
        });

        const staff = (usersData || []).map((u: any) => ({
            ...u,
            user_roles: (userRolesMap.get(u.id) || []).map((name) => ({ role: { name } })),
        }));

        return res.json({ staff });
    } catch (error: any) {
        console.error('Staff list error:', error?.message || error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/staff/admin/roles
 * Returns available roles (excluding super_admin).
 */
router.get('/admin/roles', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    try {
        const { data, error } = await supabaseAdmin
            .from('roles')
            .select('name')
            .neq('name', 'super_admin')
            .order('name');
        if (error) return res.status(500).json({ error: error.message });
        return res.json({ roles: (data || []).map((r: any) => r.name) });
    } catch (error: any) {
        console.error('Roles list error:', error?.message || error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/staff/admin/roles
 * Updates role assignments for a user.
 */
router.post('/admin/roles', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    try {
        const { userId, roles, reason } = parsed.data;
        if (roles.some((role) => normalizeRole(role) === 'super_admin')) {
            return res.status(400).json({ error: 'Cannot assign super_admin role' });
        }

        const { data: targetUser, error: targetError } = await supabaseAdmin
            .from('users')
            .select('id, facility_id, tenant_id, user_role')
            .eq('id', userId)
            .maybeSingle();

        if (targetError || !targetUser) {
            return res.status(404).json({ error: 'Target user not found' });
        }

        const facilityId = await resolveFacilityId(req);
        if (!facilityId || targetUser.facility_id !== facilityId) {
            return res.status(403).json({ error: 'Cannot manage users outside your facility' });
        }

        const resolvedRoles: string[] = [];
        for (const requestedRole of roles) {
            const resolved = await resolveAssignableRole(requestedRole);
            if ('error' in resolved) {
                return res.status(400).json({ error: resolved.error });
            }
            if (!resolvedRoles.includes(resolved.role.name)) {
                resolvedRoles.push(resolved.role.name);
            }
        }

        if (resolvedRoles.length === 0) {
            return res.status(400).json({ error: 'No valid assignable roles provided' });
        }

        const { error: roleUpdateError } = await supabaseAdmin.rpc('backend_update_staff_roles', {
            p_actor_role: req.user?.role || null,
            p_actor_facility_id: req.user?.facilityId || null,
            p_actor_tenant_id: req.user?.tenantId || null,
            p_actor_profile_id: req.user?.profileId || null,
            p_target_user_id: userId,
            p_roles: resolvedRoles,
            p_reason: reason || 'updated by clinic admin UI',
        });
        if (roleUpdateError) {
            return res.status(mapRpcErrorStatus(roleUpdateError.message)).json({ error: roleUpdateError.message });
        }

        await recordAuditEvent({
            action: 'update_staff_roles',
            eventType: 'update',
            entityType: 'user_roles',
            tenantId: targetUser.tenant_id,
            facilityId: targetUser.facility_id,
            actorUserId: req.user?.profileId || null,
            actorRole: req.user?.role || null,
            actorIpAddress: req.ip,
            actorUserAgent: req.get('user-agent') || null,
            entityId: userId,
            actionCategory: 'staff_management',
            metadata: {
                roles: resolvedRoles,
                reason: reason || null,
            },
            requestId: req.requestId || null,
        }, {
            strict: true,
            outboxEventType: 'audit.staff_roles.update.write_failed',
            outboxAggregateType: 'user_roles',
            outboxAggregateId: userId,
        });

        return res.json({ success: true });
    } catch (error: any) {
        console.error('Role update error:', error?.message || error);
        if (isAuditDurabilityError(error)) {
            return res.status(500).json({
                code: 'CONFLICT_AUDIT_DURABILITY_FAILURE',
                message: 'Audit durability requirement failed',
            });
        }
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/staff/admin/toggle-active
 * Activates or deactivates a user.
 */
router.post('/admin/toggle-active', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    const parsed = toggleActiveSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    try {
        const { userId, isActive, reason } = parsed.data;
        const { data: targetUser, error: targetError } = await supabaseAdmin
            .from('users')
            .select('id, facility_id, tenant_id')
            .eq('id', userId)
            .maybeSingle();

        if (targetError || !targetUser) {
            return res.status(404).json({ error: 'Target user not found' });
        }

        const facilityId = await resolveFacilityId(req);
        if (!facilityId || targetUser.facility_id !== facilityId) {
            return res.status(403).json({ error: 'Cannot manage users outside your facility' });
        }

        await supabaseAdmin
            .from('users')
            .update({
                is_active: isActive,
                deactivated_at: isActive ? null : new Date().toISOString(),
            })
            .eq('id', userId);

        await supabaseAdmin.from('user_role_changes').insert({
            user_id: userId,
            facility_id: targetUser.facility_id,
            tenant_id: targetUser.tenant_id,
            old_roles: null,
            new_roles: null,
            changed_by: req.user?.profileId,
            reason: reason || (isActive ? 'reactivated by clinic admin' : 'deactivated by clinic admin'),
            created_at: new Date().toISOString(),
        });

        await recordAuditEvent({
            action: isActive ? 'reactivate_staff_member' : 'deactivate_staff_member',
            eventType: 'update',
            entityType: 'user',
            tenantId: targetUser.tenant_id,
            facilityId: targetUser.facility_id,
            actorUserId: req.user?.profileId || null,
            actorRole: req.user?.role || null,
            actorIpAddress: req.ip,
            actorUserAgent: req.get('user-agent') || null,
            entityId: userId,
            actionCategory: 'staff_management',
            metadata: {
                isActive,
                reason: reason || null,
            },
            requestId: req.requestId || null,
        }, {
            strict: true,
            outboxEventType: 'audit.staff_member.toggle_active.write_failed',
            outboxAggregateType: 'user',
            outboxAggregateId: userId,
        });

        return res.json({ success: true });
    } catch (error: any) {
        console.error('Toggle active error:', error?.message || error);
        if (isAuditDurabilityError(error)) {
            return res.status(500).json({
                code: 'CONFLICT_AUDIT_DURABILITY_FAILURE',
                message: 'Audit durability requirement failed',
            });
        }
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/staff/admin/requests
 * Lists pending staff registration requests.
 */
router.get('/admin/requests', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    const facilityId = await resolveFacilityId(req);
    if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

    try {
        const { data, error } = await supabaseAdmin
            .from('staff_registration_requests')
            .select('*')
            .eq('facility_id', facilityId)
            .eq('status', 'pending')
            .order('requested_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        return res.json({ requests: data || [] });
    } catch (error: any) {
        console.error('Pending requests error:', error?.message || error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/staff/admin/requests/:id/approve
 */
router.post('/admin/requests/:id/approve', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    const parsed = requestDecisionSchema.safeParse(req.body || {});
    if (!parsed.success) {
        return sendContractError(
            res,
            400,
            'VALIDATION_INVALID_REQUEST_DECISION',
            parsed.error.issues[0]?.message || 'Invalid payload'
        );
    }

    try {
        const { id } = req.params;
        const { error: approvalError } = await supabaseAdmin.rpc(
            'backend_approve_staff_registration_request',
            {
                p_actor_role: req.user?.role || null,
                p_actor_facility_id: req.user?.facilityId || null,
                p_actor_tenant_id: req.user?.tenantId || null,
                p_actor_profile_id: req.user?.profileId || null,
                p_request_id: id,
                p_reason: parsed.data.reason || null,
                p_actor_ip_address: req.ip || null,
                p_actor_user_agent: req.get('user-agent') || null,
                p_request_trace_id: resolveUuidOrNull(req.requestId || null),
            }
        );

        if (approvalError) {
            const mapped = mapApproveRequestRpcError(approvalError.message || 'Internal server error');
            return sendContractError(res, mapped.status, mapped.code, mapped.message);
        }

        return res.json({ success: true });
    } catch (error: any) {
        console.error('Approve request error:', error?.message || error);
        return sendContractError(
            res,
            500,
            'CONFLICT_REQUEST_APPROVAL_FAILED',
            error?.message || 'Internal server error'
        );
    }
});

/**
 * POST /api/staff/admin/requests/:id/reject
 */
router.post('/admin/requests/:id/reject', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    const parsed = requestDecisionSchema.safeParse(req.body || {});
    if (!parsed.success) {
        return sendContractError(
            res,
            400,
            'VALIDATION_INVALID_REQUEST_DECISION',
            parsed.error.issues[0]?.message || 'Invalid payload'
        );
    }

    try {
        const { id } = req.params;
        const { data: request, error } = await supabaseAdmin
            .from('staff_registration_requests')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error || !request) {
            return sendContractError(res, 404, 'VALIDATION_REQUEST_NOT_FOUND', 'Request not found');
        }

        const facilityId = await resolveFacilityId(req);
        if (!facilityId || request.facility_id !== facilityId) {
            return sendContractError(
                res,
                403,
                'TENANT_RESOURCE_SCOPE_VIOLATION',
                'Cannot manage requests outside your facility'
            );
        }

        if (normalizeRequestStatus(request.status) !== 'pending') {
            return sendContractError(
                res,
                409,
                'CONFLICT_REQUEST_ALREADY_REVIEWED',
                'Only pending requests can be rejected'
            );
        }

        const { data: reviewedRequest, error: reviewUpdateError } = await supabaseAdmin
            .from('staff_registration_requests')
            .update({
                status: 'rejected',
                rejection_reason: parsed.data.reason || 'Rejected by clinic admin',
                reviewed_at: new Date().toISOString(),
                reviewed_by: req.user?.profileId,
            })
            .eq('id', request.id)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle();
        if (reviewUpdateError) {
            throw new Error(reviewUpdateError.message);
        }
        if (!reviewedRequest?.id) {
            return sendContractError(
                res,
                409,
                'CONFLICT_REQUEST_ALREADY_REVIEWED',
                'Only pending requests can be rejected'
            );
        }

        await recordAuditEvent({
            action: 'reject_staff_registration_request',
            eventType: 'update',
            entityType: 'staff_registration_request',
            tenantId: request.tenant_id,
            facilityId: request.facility_id,
            actorUserId: req.user?.profileId || null,
            actorRole: req.user?.role || null,
            actorIpAddress: req.ip,
            actorUserAgent: req.get('user-agent') || null,
            entityId: request.id,
            actionCategory: 'staff_management',
            metadata: {
                reason: parsed.data.reason || 'Rejected by clinic admin',
            },
            requestId: req.requestId || null,
        }, {
            strict: true,
            outboxEventType: 'audit.staff_request.reject.write_failed',
            outboxAggregateType: 'staff_registration_request',
            outboxAggregateId: request.id,
        });

        return res.json({ success: true });
    } catch (error: any) {
        console.error('Reject request error:', error?.message || error);
        if (isAuditDurabilityError(error)) {
            return sendContractError(
                res,
                500,
                'CONFLICT_AUDIT_DURABILITY_FAILURE',
                'Audit durability requirement failed'
            );
        }
        return sendContractError(
            res,
            500,
            'CONFLICT_REQUEST_REJECTION_FAILED',
            error?.message || 'Internal server error'
        );
    }
});

/**
 * GET /api/staff/admin/coverage
 * Returns counts per role for active staff.
 */
router.get('/admin/coverage', async (req, res) => {
    if (!ensureClinicAdmin(req, res)) return;
    const facilityId = await resolveFacilityId(req);
    if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

    try {
        const { data: usersData, error } = await supabaseAdmin
            .from('users')
            .select('id, user_role')
            .match({ facility_id: facilityId, is_active: true });

        if (error) return res.status(500).json({ error: error.message });

        const userIds = (usersData || []).map((u: any) => u.id);
        const { data: userRolesData } = userIds.length
            ? await supabaseAdmin
                  .from('user_roles')
                  .select('user_id, role_id')
                  .in('user_id', userIds)
                  .eq('is_active', true)
            : { data: [] };

        const roleIds = [...new Set((userRolesData || []).map((ur: any) => ur.role_id))];
        const { data: rolesData } = roleIds.length
            ? await supabaseAdmin.from('roles').select('id, name').in('id', roleIds)
            : { data: [] };

        const rolesMap = new Map((rolesData || []).map((r: any) => [r.id, r.name]));
        const counts: Record<string, number> = {};

        (userRolesData || []).forEach((ur: any) => {
            const roleName = rolesMap.get(ur.role_id);
            if (!roleName) return;
            counts[roleName] = (counts[roleName] || 0) + 1;
        });

        (usersData || []).forEach((u: any) => {
            if (u.user_role && !counts[u.user_role]) {
                counts[u.user_role] = (counts[u.user_role] || 0) + 1;
            }
        });

        return res.json({ counts });
    } catch (error: any) {
        console.error('Coverage error:', error?.message || error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

export const __testables = {
    normalizeRole,
    resolveAssignableRole,
    resolveFacilityId,
    resolveJoinRequestEligibility,
};

export default router;
