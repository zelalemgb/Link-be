import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { normalizeWorkspaceMetadata } from '../services/workspaceMetadata';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://linkhc.org';
const invitationManagerRoles = new Set(['clinic_admin', 'admin', 'super_admin']);
const nonAssignableRoles = new Set(['super_admin']);

const normalizeRole = (role: string) => role.trim().toLowerCase();
const isInvitationManager = (role: string | undefined) => {
  if (!role) return false;
  return invitationManagerRoles.has(normalizeRole(role));
};

type InvitationManagerContext = {
  role?: string;
  authUserId: string;
  facilityId: string;
  tenantId?: string;
};

const isFacilityOwnerManager = async ({
  role,
  authUserId,
  facilityId,
  tenantId,
}: InvitationManagerContext) => {
  if (normalizeRole(role || '') !== 'doctor') return false;

  let query = supabaseAdmin
    .from('facilities')
    .select('id, admin_user_id, tenant_id')
    .eq('id', facilityId);

  if (tenantId) {
    query = query.eq('tenant_id', tenantId);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) return false;
  return data.admin_user_id === authUserId;
};

const canManageInvitationsForFacility = async (context: InvitationManagerContext) => {
  if (isInvitationManager(context.role)) return true;
  return isFacilityOwnerManager(context);
};

const ensureInvitationManagerForFacility = async (
  context: InvitationManagerContext,
  res: any
) => {
  if (await canManageInvitationsForFacility(context)) {
    return true;
  }

  res.status(403).json({ error: 'Only clinic administrators can manage invitations' });
  return false;
};

const isRoleAssignable = (role: string) => !nonAssignableRoles.has(normalizeRole(role));

const buildInvitationLink = (token: string) => {
  const base = FRONTEND_URL.replace(/\/+$/, '');
  return `${base}/#/auth/accept-invitation?token=${token}`;
};

const invitationListSchema = z.object({
  facilityId: z.string().uuid().optional(),
  status: z.enum(['pending', 'accepted', 'all']).optional(),
});

const invitationCreateSchema = z.object({
  facilityId: z.string().uuid(),
  invitations: z
    .array(
      z.object({
        email: z.string().email(),
        role: z.string().min(1),
        phoneNumber: z.string().optional().nullable(),
      })
    )
    .min(1),
});

const teamModeQuerySchema = z.object({
  facilityId: z.string().uuid().optional(),
});

const teamModeUpdateSchema = z.object({
  facilityId: z.string().uuid().optional(),
  teamMode: z.enum(['solo', 'small_team', 'full_team']),
});

const invitationRegisterSchema = z.object({
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters long')
    .regex(/[a-z]/, 'Password must include at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must include at least one uppercase letter')
    .regex(/[0-9]/, 'Password must include at least one number')
    .regex(/[^A-Za-z0-9]/, 'Password must include at least one special character'),
  fullName: z.string().min(2).optional(),
});

const getAuthUserByEmail = async (email: string) => {
  const normalized = email.trim().toLowerCase();
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users ?? [];
    const match = users.find((user) => user.email?.toLowerCase() === normalized);
    if (match) return match;
    if (users.length < perPage) break;
  }

  return null;
};

const resolveInvitation = async (token: string) => {
  const { data, error } = await supabaseAdmin
    .from('staff_invitations')
    .select('id, email, role, facility_id, tenant_id, expires_at, accepted')
    .eq('invitation_token', token)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
};

const ensureFacilityAccess = async (authUserId: string, facilityId: string, role: string) => {
  if (role === 'super_admin') return true;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .eq('facility_id', facilityId)
    .maybeSingle();

  if (error) return false;
  return !!data;
};

const resolveFacilityTenant = async (
  facilityId: string,
  role: string | undefined,
  tenantId?: string
) => {
  let query = supabaseAdmin
    .from('facilities')
    .select('id, tenant_id')
    .eq('id', facilityId);

  if (role !== 'super_admin' && tenantId) {
    query = query.eq('tenant_id', tenantId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(error.message);
  }

  return data;
};

const resolveInvitationById = async (id: string) => {
  const { data, error } = await supabaseAdmin
    .from('staff_invitations')
    .select('id, email, role, facility_id, tenant_id, invitation_token, expires_at, accepted')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
};

router.get('/', requireUser, requireScopedUser, async (req, res) => {
  const parsed = invitationListSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { authUserId, facilityId: defaultFacilityId, role, tenantId } = req.user!;
  const facilityId = parsed.data.facilityId || defaultFacilityId;

  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facilityId' });
  }

  if (!(await ensureInvitationManagerForFacility({ role, authUserId, facilityId, tenantId }, res))) return;

  const hasAccess = await ensureFacilityAccess(authUserId, facilityId, role);
  if (!hasAccess) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    let query = supabaseAdmin
      .from('staff_invitations')
      .select('id, role, email, accepted, created_at, expires_at, invitation_token')
      .eq('facility_id', facilityId);

    if (parsed.data.status === 'pending' || !parsed.data.status) {
      query = query.eq('accepted', false);
    } else if (parsed.data.status === 'accepted') {
      query = query.eq('accepted', true);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ invitations: data || [] });
  } catch (error: any) {
    console.error('List staff invitations error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', requireUser, requireScopedUser, async (req, res) => {
  const parsed = invitationCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { authUserId, role, tenantId } = req.user!;
  const { facilityId, invitations } = parsed.data;

  if (!(await ensureInvitationManagerForFacility({ role, authUserId, facilityId, tenantId }, res))) return;

  const hasAccess = await ensureFacilityAccess(authUserId, facilityId, role);
  if (!hasAccess) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { data: facility, error: facilityError } = await supabaseAdmin
      .from('facilities')
      .select('id, name, tenant_id')
      .eq('id', facilityId)
      .maybeSingle();

    if (facilityError || !facility) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    const { data: inviter } = await supabaseAdmin
      .from('users')
      .select('id, full_name, name')
      .eq('auth_user_id', authUserId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    const inviterName = inviter?.full_name || inviter?.name || undefined;
    const invitedBy = inviter?.id || undefined;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const normalizedInvites = invitations.map((invitation) => ({
      ...invitation,
      email: invitation.email.toLowerCase(),
      role: normalizeRole(invitation.role),
    }));

    const hasInvalidRole = normalizedInvites.some((invitation) => !isRoleAssignable(invitation.role));
    if (hasInvalidRole) {
      return res.status(400).json({ error: 'super_admin cannot be assigned through invitations' });
    }

    const existing = await supabaseAdmin
      .from('staff_invitations')
      .select('id, email, expires_at, accepted')
      .eq('facility_id', facilityId)
      .in('email', normalizedInvites.map((inv) => inv.email))
      .eq('accepted', false);

    if (existing.error) {
      return res.status(500).json({ error: existing.error.message });
    }

    const now = new Date();
    const activeEmails = new Set<string>();
    const expiredIds: string[] = [];

    (existing.data || []).forEach((row: any) => {
      if (row.expires_at && new Date(row.expires_at) < now) {
        expiredIds.push(row.id);
      } else {
        activeEmails.add(row.email);
      }
    });

    if (expiredIds.length > 0) {
      await supabaseAdmin.from('staff_invitations').delete().in('id', expiredIds);
    }

    const failures: Array<{ email: string; error: string }> = [];
    const filteredInvites = normalizedInvites.filter((inv) => {
      if (activeEmails.has(inv.email)) {
        failures.push({ email: inv.email, error: 'Invitation already pending' });
        return false;
      }
      return true;
    });

    const entries = filteredInvites.map((invitation) => ({
      facility_id: facilityId,
      tenant_id: facility.tenant_id,
      email: invitation.email,
      role: invitation.role,
      phone_number: invitation.phoneNumber || null,
      invitation_token: crypto.randomUUID(),
      expires_at: expiresAt.toISOString(),
      invited_by: invitedBy,
    }));

    if (entries.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from('staff_invitations')
        .insert(entries);

      if (insertError) {
        return res.status(500).json({ error: insertError.message });
      }
    }

    let sentCount = 0;

    for (const entry of entries) {
      const invitationLink = buildInvitationLink(entry.invitation_token);
      const { error: emailError } = await supabaseAdmin.functions.invoke('send-team-invitation', {
        body: {
          email: entry.email,
          role: entry.role,
          facilityName: facility.name,
          invitationToken: entry.invitation_token,
          invitationLink,
          adminName: inviterName,
        },
      });

      if (emailError) {
        failures.push({ email: entry.email, error: emailError.message || 'Failed to send email' });
      } else {
        sentCount += 1;
      }
    }

    if (facility.tenant_id && entries.length > 0) {
      const { data: tenantRow, error: tenantLookupError } = await supabaseAdmin
        .from('tenants')
        .select('workspace_type, setup_mode, team_mode')
        .eq('id', facility.tenant_id)
        .maybeSingle();

      if (tenantLookupError) {
        console.warn('Failed to load tenant metadata after invitations:', tenantLookupError.message);
      } else if (tenantRow) {
        const tenantUpdatePayload: Record<string, string> = {
          team_mode:
            tenantRow.team_mode === 'full_team'
              ? 'full_team'
              : 'small_team',
        };

        if (tenantRow.workspace_type === 'provider') {
          tenantUpdatePayload.workspace_type = 'clinic';
          if (!tenantRow.setup_mode || tenantRow.setup_mode === 'legacy') {
            tenantUpdatePayload.setup_mode = 'recommended';
          }
        }

        const { error: teamModeError } = await supabaseAdmin
          .from('tenants')
          .update(tenantUpdatePayload)
          .eq('id', facility.tenant_id);

        if (teamModeError) {
          console.warn('Failed to promote tenant team_mode after invitations:', teamModeError.message);
        }
      }
    }

    return res.json({ sentCount, total: entries.length, failures });
  } catch (error: any) {
    console.error('Create staff invitations error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/team-mode', requireUser, requireScopedUser, async (req, res) => {
  const parsed = teamModeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { authUserId, role, facilityId: defaultFacilityId, tenantId } = req.user!;
  const facilityId = parsed.data.facilityId || defaultFacilityId;

  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facilityId' });
  }

  if (!(await ensureInvitationManagerForFacility({ role, authUserId, facilityId, tenantId }, res))) return;

  const hasAccess = await ensureFacilityAccess(authUserId, facilityId, role);
  if (!hasAccess) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const facility = await resolveFacilityTenant(facilityId, role, tenantId);
    if (!facility) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    if (!facility.tenant_id) {
      return res.json({
        facilityId,
        workspace: normalizeWorkspaceMetadata(null),
      });
    }

    const { data: workspaceRow, error: workspaceError } = await supabaseAdmin
      .from('tenants')
      .select('workspace_type, setup_mode, team_mode, enabled_modules')
      .eq('id', facility.tenant_id)
      .maybeSingle();

    if (workspaceError) {
      return res.status(500).json({ error: workspaceError.message });
    }

    return res.json({
      facilityId,
      workspace: normalizeWorkspaceMetadata(workspaceRow as any),
    });
  } catch (error: any) {
    console.error('Read staff team mode error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/team-mode', requireUser, requireScopedUser, async (req, res) => {
  const parsed = teamModeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { authUserId, role, facilityId: defaultFacilityId, tenantId } = req.user!;
  const facilityId = parsed.data.facilityId || defaultFacilityId;

  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facilityId' });
  }

  if (!(await ensureInvitationManagerForFacility({ role, authUserId, facilityId, tenantId }, res))) return;

  const hasAccess = await ensureFacilityAccess(authUserId, facilityId, role);
  if (!hasAccess) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const facility = await resolveFacilityTenant(facilityId, role, tenantId);
    if (!facility) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    if (!facility.tenant_id) {
      return res.status(400).json({ error: 'Facility has no tenant association' });
    }

    const { data: currentTenantRow, error: currentTenantError } = await supabaseAdmin
      .from('tenants')
      .select('workspace_type, setup_mode, team_mode, enabled_modules')
      .eq('id', facility.tenant_id)
      .maybeSingle();

    if (currentTenantError) {
      return res.status(500).json({ error: currentTenantError.message });
    }

    if (!currentTenantRow) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantUpdatePayload: Record<string, string> = {
      team_mode: parsed.data.teamMode,
    };
    const shouldPromoteToClinic =
      currentTenantRow.workspace_type === 'provider' && parsed.data.teamMode !== 'solo';
    if (shouldPromoteToClinic) {
      tenantUpdatePayload.workspace_type = 'clinic';
      if (!currentTenantRow.setup_mode || currentTenantRow.setup_mode === 'legacy') {
        tenantUpdatePayload.setup_mode = 'recommended';
      }
    }

    const { data: tenantRow, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .update(tenantUpdatePayload)
      .eq('id', facility.tenant_id)
      .select('workspace_type, setup_mode, team_mode, enabled_modules')
      .single();

    if (tenantError) {
      return res.status(500).json({ error: tenantError.message });
    }

    return res.json({
      facilityId,
      workspace: normalizeWorkspaceMetadata(tenantRow as any),
    });
  } catch (error: any) {
    console.error('Update staff team mode error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:token/accept', requireUser, async (req, res) => {
  const { authUserId } = req.user!;
  const { token } = req.params;

  try {
    const invitation = await resolveInvitation(token);
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    if (invitation.accepted) {
      return res.status(400).json({ error: 'Invitation already accepted' });
    }
    if (invitation.expires_at && new Date(invitation.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invitation expired' });
    }
    if (!isRoleAssignable(invitation.role)) {
      return res.status(403).json({ error: 'Invitation role is not assignable' });
    }

    const { data: authRow, error: authError } = await supabaseAdmin
      .schema('auth')
      .from('users')
      .select('email, raw_user_meta_data')
      .eq('id', authUserId)
      .maybeSingle();

    if (authError || !authRow?.email) {
      return res.status(401).json({ error: 'Unable to verify user email' });
    }

    if (authRow.email.toLowerCase() !== invitation.email.toLowerCase()) {
      return res.status(403).json({ error: 'Invitation does not match signed-in user' });
    }

    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .eq('facility_id', invitation.facility_id)
      .maybeSingle();

    if (existingUser) {
      await supabaseAdmin
        .from('staff_invitations')
        .update({ accepted: true, accepted_at: new Date().toISOString() })
        .eq('id', invitation.id);

      return res.json({ status: 'already_member' });
    }

    const fullName =
      (authRow.raw_user_meta_data as any)?.full_name ||
      (authRow.raw_user_meta_data as any)?.name ||
      authRow.email.split('@')[0];

    const { data: newUser, error: insertError } = await supabaseAdmin
      .from('users')
      .insert({
        auth_user_id: authUserId,
        facility_id: invitation.facility_id,
        tenant_id: invitation.tenant_id,
        user_role: invitation.role,
        name: fullName,
        full_name: fullName,
      })
      .select('id')
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    const { data: roleData } = await supabaseAdmin
      .from('roles')
      .select('id')
      .or(`slug.eq.${invitation.role},name.eq.${invitation.role}`)
      .maybeSingle();

    if (roleData?.id && newUser?.id) {
      await supabaseAdmin.from('user_roles').insert({
        user_id: newUser.id,
        role_id: roleData.id,
        facility_id: invitation.facility_id,
        tenant_id: invitation.tenant_id,
        is_active: true,
      });
    }

    await supabaseAdmin
      .from('staff_invitations')
      .update({ accepted: true, accepted_at: new Date().toISOString() })
      .eq('id', invitation.id);

    return res.json({ status: 'joined' });
  } catch (error: any) {
    console.error('Accept staff invitation error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:token/register', async (req, res) => {
  const parsed = invitationRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { token } = req.params;

  try {
    const invitation = await resolveInvitation(token);
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    if (invitation.accepted) {
      return res.status(400).json({ error: 'Invitation already accepted' });
    }
    if (invitation.expires_at && new Date(invitation.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invitation expired' });
    }
    if (!isRoleAssignable(invitation.role)) {
      return res.status(403).json({ error: 'Invitation role is not assignable' });
    }

    const existingAuth = await getAuthUserByEmail(invitation.email);
    if (existingAuth) {
      return res.status(409).json({ error: 'Account already exists' });
    }

    const displayName =
      parsed.data.fullName?.trim() || invitation.email.split('@')[0];

    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: invitation.email,
      password: parsed.data.password,
      email_confirm: true,
      user_metadata: {
        name: displayName,
        full_name: displayName,
        user_role: invitation.role,
        facility_id: invitation.facility_id,
        tenant_id: invitation.tenant_id,
      },
    });

    if (authError || !authUser?.user) {
      return res.status(400).json({ error: authError?.message || 'Failed to create user' });
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('auth_user_id', authUser.user.id)
      .maybeSingle();

    let profileId = existingProfile?.id;

    if (!profileId) {
      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from('users')
        .insert({
          auth_user_id: authUser.user.id,
          facility_id: invitation.facility_id,
          tenant_id: invitation.tenant_id,
          user_role: invitation.role,
          name: displayName,
          full_name: displayName,
        })
        .select('id')
        .single();

      if (profileError) {
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
        return res.status(500).json({ error: profileError.message });
      }

      profileId = newProfile?.id;
    }

    const { data: roleData } = await supabaseAdmin
      .from('roles')
      .select('id')
      .or(`slug.eq.${invitation.role},name.eq.${invitation.role}`)
      .maybeSingle();

    if (roleData?.id && profileId) {
      await supabaseAdmin.from('user_roles').insert({
        user_id: profileId,
        role_id: roleData.id,
        facility_id: invitation.facility_id,
        tenant_id: invitation.tenant_id,
        is_active: true,
      });
    }

    await supabaseAdmin
      .from('staff_invitations')
      .update({ accepted: true, accepted_at: new Date().toISOString() })
      .eq('id', invitation.id);

    return res.json({ status: 'registered' });
  } catch (error: any) {
    console.error('Register invited staff error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireUser, requireScopedUser, async (req, res) => {
  const { authUserId, role, tenantId } = req.user!;
  const { id } = req.params;

  try {
    const invitation = await resolveInvitationById(id);
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    if (
      !(await ensureInvitationManagerForFacility(
        { role, authUserId, facilityId: invitation.facility_id, tenantId },
        res
      ))
    ) {
      return;
    }

    const hasAccess = await ensureFacilityAccess(authUserId, invitation.facility_id, role);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { error } = await supabaseAdmin.from('staff_invitations').delete().eq('id', id);
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Delete staff invitation error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/resend', requireUser, requireScopedUser, async (req, res) => {
  const { authUserId, role, tenantId } = req.user!;
  const { id } = req.params;

  try {
    const invitation = await resolveInvitationById(id);
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    if (
      !(await ensureInvitationManagerForFacility(
        { role, authUserId, facilityId: invitation.facility_id, tenantId },
        res
      ))
    ) {
      return;
    }

    const hasAccess = await ensureFacilityAccess(authUserId, invitation.facility_id, role);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + 7);

    const { error: updateError } = await supabaseAdmin
      .from('staff_invitations')
      .update({ expires_at: newExpiry.toISOString() })
      .eq('id', invitation.id);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    const { data: facility } = await supabaseAdmin
      .from('facilities')
      .select('name')
      .eq('id', invitation.facility_id)
      .maybeSingle();

    const invitationLink = buildInvitationLink(invitation.invitation_token);

    const { error: emailError } = await supabaseAdmin.functions.invoke('send-team-invitation', {
      body: {
        email: invitation.email,
        role: invitation.role,
        facilityName: facility?.name || 'Your Health Facility',
        invitationToken: invitation.invitation_token,
        invitationLink,
      },
    });

    if (emailError) {
      return res.status(500).json({ error: emailError.message || 'Failed to send invitation email' });
    }

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Resend staff invitation error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

export const __testables = {
  normalizeRole,
  isInvitationManager,
  isRoleAssignable,
  isFacilityOwnerManager,
  canManageInvitationsForFacility,
  ensureFacilityAccess,
  buildInvitationLink,
};
