import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { recordAuthFailure } from '../services/monitoring';
import type { AuthUser } from './auth';

const sendContractError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

export const requireSyncUser = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.header('authorization') || '';
  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    recordAuthFailure(req.requestId);
    return sendContractError(res, 401, 'AUTH_MISSING_BEARER_TOKEN', 'Missing bearer token');
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      recordAuthFailure(req.requestId);
      return sendContractError(res, 401, 'AUTH_INVALID_TOKEN', 'Invalid token');
    }

    const authUserId = data.user.id;
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('users')
      .select('id, tenant_id, facility_id, user_role')
      .eq('auth_user_id', authUserId)
      .limit(1)
      .maybeSingle();

    if (profileErr) {
      throw new Error(profileErr.message);
    }

    if (!profile) {
      return sendContractError(res, 403, 'PERM_MISSING_USER_PROFILE', 'Missing user profile');
    }

    const resolved: AuthUser = {
      authUserId,
      profileId: profile?.id as string | undefined,
      tenantId: profile?.tenant_id as string | undefined,
      facilityId: profile?.facility_id as string | undefined,
      role: (profile?.user_role as string | null) || 'staff',
    };

    req.user = resolved;
    return next();
  } catch (err: any) {
    console.error('Sync auth middleware error:', err?.message || err);
    return sendContractError(res, 500, 'CONFLICT_AUTH_FAILED', 'Internal auth error');
  }
};

export const requireSyncScopedUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return sendContractError(res, 401, 'AUTH_MISSING_USER_CONTEXT', 'Missing user context');
  }

  if (req.user.role === 'super_admin') {
    return next();
  }

  if (!req.user.tenantId || !req.user.facilityId) {
    return sendContractError(res, 403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing tenant or facility context');
  }

  return next();
};

