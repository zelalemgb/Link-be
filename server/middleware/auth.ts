import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { recordAuthFailure } from '../services/monitoring';

const { ADMIN_API_SECRET, AUTH_DEBUG } = process.env;
const isAuthDebug = AUTH_DEBUG === 'true';

export type Role =
    | 'admin'
    | 'super_admin'
    | 'receptionist'
    | 'nurse'
    | 'finance'
    | 'doctor'
    | 'staff'
    | string;

export interface AuthUser {
    authUserId: string;
    profileId?: string;
    tenantId?: string;
    facilityId?: string;
    role: Role;
}

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
            requestId?: string;
        }
    }
}

export const requireUser = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.header('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7)
        : undefined;

    if (!token) {
        recordAuthFailure(req.requestId);
        return res.status(401).json({ error: 'Missing bearer token' });
    }

    try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) {
            if (isAuthDebug) {
                console.error('[AUTH DEBUG] getUser error:', error?.message || 'No user data');
            }
            recordAuthFailure(req.requestId);
            return res.status(401).json({ error: 'Invalid token' });
        }

        const authUserId = data.user.id;
        if (isAuthDebug) {
            console.log('[AUTH DEBUG] authUserId:', authUserId);
        }

        // Fetch user profile to get role and facility context
        const { data: profile, error: profileErr } = await supabaseAdmin
            .from('users')
            .select('id, tenant_id, facility_id, user_role')
            .eq('auth_user_id', authUserId)
            .limit(1)
            .maybeSingle();

        if (isAuthDebug) {
            if (profileErr) {
                console.error('[AUTH DEBUG] Profile fetch error:', profileErr.message);
            }
            if (!profile) {
                console.warn('[AUTH DEBUG] No profile found for authUserId:', authUserId);
            } else {
                console.log('[AUTH DEBUG] Profile found:', profile.id, 'Role:', profile.user_role);
            }
        }

        req.user = {
            authUserId,
            profileId: profile?.id,
            tenantId: profile?.tenant_id,
            facilityId: profile?.facility_id,
            role: (profile?.user_role as Role | null) || 'staff',
        };

        next();
    } catch (err: any) {
        console.error('Auth middleware error:', err?.message || err);
        return res.status(500).json({ error: 'Internal auth error' });
    }
};

export const requireScopedUser = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Missing user context' });
    }

    if (req.user.role === 'super_admin') {
        return next();
    }

    if (!req.user.tenantId || !req.user.facilityId) {
        return res.status(403).json({ error: 'Missing tenant or facility context' });
    }

    return next();
};

export const superAdminGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Forbidden: Super Admin access required' });
    }
    next();
};

export const adminKeyGuard = (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('x-api-key');
    if (key && key === ADMIN_API_SECRET) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
};
