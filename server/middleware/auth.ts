import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { recordAuthFailure } from '../services/monitoring';

const { ADMIN_API_SECRET, AUTH_DEBUG } = process.env;
const isAuthDebug = AUTH_DEBUG === 'true';
const isTestEnv = process.env.NODE_ENV === 'test';

// In-memory LRU cache for user profiles (60-second TTL, max 500 entries)
interface CacheEntry {
    profile: any;
    expiresAt: number;
}

class UserProfileCache {
    private cache: Map<string, CacheEntry> = new Map();
    private readonly ttlMs = 60 * 1000; // 60 seconds
    private readonly maxEntries = 500;

    get(authUserId: string): any | null {
        const entry = this.cache.get(authUserId);
        if (!entry) return null;

        // Check if expired
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(authUserId);
            return null;
        }

        return entry.profile;
    }

    set(authUserId: string, profile: any): void {
        // Evict oldest entry if at capacity
        if (this.cache.size >= this.maxEntries) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }

        this.cache.set(authUserId, {
            profile,
            expiresAt: Date.now() + this.ttlMs,
        });
    }

    // Lazily evict expired entries
    cleanup(): void {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
            }
        }
    }
}

const userProfileCache = new UserProfileCache();

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
            // Log only a truncated prefix — never the full UUID or role.
            console.log('[AUTH DEBUG] authUserId:', authUserId.slice(0, 8) + '…');
        }

        // Check cache first
        let profile = isTestEnv ? null : userProfileCache.get(authUserId);
        let fromCache = !!profile;

        // If not in cache, fetch user profile to get role and facility context
        if (!profile) {
            const { data: fetchedProfile, error: profileErr } = await supabaseAdmin
                .from('users')
                .select('id, tenant_id, facility_id, user_role')
                .eq('auth_user_id', authUserId)
                .limit(1)
                .maybeSingle();

            if (profileErr) {
                if (isAuthDebug) {
                    console.error('[AUTH DEBUG] Profile fetch error: (redacted)');
                }
                recordAuthFailure(req.requestId);
                return res.status(500).json({ error: 'Failed to fetch user profile' });
            }

            profile = fetchedProfile;

            // Cache the profile (even if null, for 60 seconds)
            if (profile && !isTestEnv) {
                userProfileCache.set(authUserId, profile);
            }
        }

        if (isAuthDebug) {
            if (!profile) {
                console.warn('[AUTH DEBUG] No profile found');
            } else {
                console.log(
                    '[AUTH DEBUG] Profile resolved:',
                    profile.id.slice(0, 8) + '…',
                    `(${fromCache ? 'cached' : 'fetched'})`
                );
            }
        }

        // Periodically clean up expired cache entries
        if (!isTestEnv && Math.random() < 0.01) {
            userProfileCache.cleanup();
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
