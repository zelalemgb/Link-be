import { Request, Response, NextFunction } from 'express';
import { createHash, createPublicKey, KeyObject } from 'crypto';
import jwt, { Algorithm, JwtHeader, JwtPayload } from 'jsonwebtoken';
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

type VerifiedTokenIdentity = {
    authUserId: string;
    email?: string;
    tenantId?: string;
    facilityId?: string;
    role?: Role;
};

interface TokenCacheEntry {
    user: AuthUser;
    expiresAt: number;
}

class ValidatedTokenCache {
    private cache: Map<string, TokenCacheEntry> = new Map();
    private readonly maxEntries = 1000;
    private readonly fallbackTtlMs = 15 * 60 * 1000; // 15 minutes

    private keyFor(token: string) {
        return createHash('sha256').update(token).digest('hex');
    }

    private resolveExpiry(token: string) {
        const fallbackExpiry = Date.now() + this.fallbackTtlMs;
        const [, payloadSegment] = token.split('.');
        if (!payloadSegment) return fallbackExpiry;

        try {
            const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
            const expMs = typeof payload?.exp === 'number' ? payload.exp * 1000 : NaN;
            if (!Number.isFinite(expMs)) return fallbackExpiry;
            return Math.min(expMs, fallbackExpiry);
        } catch {
            return fallbackExpiry;
        }
    }

    get(token: string): AuthUser | null {
        const entry = this.cache.get(this.keyFor(token));
        if (!entry) return null;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(this.keyFor(token));
            return null;
        }

        return entry.user;
    }

    set(token: string, user: AuthUser): void {
        if (this.cache.size >= this.maxEntries) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }

        this.cache.set(this.keyFor(token), {
            user,
            expiresAt: this.resolveExpiry(token),
        });
    }
}

const validatedTokenCache = new ValidatedTokenCache();

const readMetadataString = (value: unknown) => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const extractScopeMetadata = (metadata: unknown) => {
    const source = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
    return {
        tenantId: readMetadataString(source.tenant_id),
        facilityId: readMetadataString(source.facility_id),
        role: readMetadataString(source.user_role) || readMetadataString(source.role),
    };
};

type JwkRecord = {
    kid?: string;
    alg?: string;
    use?: string;
    kty: string;
    n?: string;
    e?: string;
    crv?: string;
    x?: string;
    y?: string;
};

class SupabaseJwksCache {
    private keys = new Map<string, KeyObject>();
    private expiresAt = 0;
    private readonly ttlMs = 60 * 60 * 1000; // 1 hour

    private get jwksUrl() {
        const base = process.env.SUPABASE_URL?.replace(/\/+$/, '');
        return base ? `${base}/auth/v1/.well-known/jwks.json` : '';
    }

    private async refresh() {
        if (!this.jwksUrl) {
            throw new Error('SUPABASE_URL is not configured');
        }

        const response = await fetch(this.jwksUrl);
        if (!response.ok) {
            throw new Error(`JWKS fetch failed with status ${response.status}`);
        }

        const payload = (await response.json()) as { keys?: JwkRecord[] };
        const nextKeys = new Map<string, KeyObject>();

        for (const key of payload.keys ?? []) {
            if (!key.kid) continue;
            try {
                nextKeys.set(
                    key.kid,
                    createPublicKey({
                        key,
                        format: 'jwk',
                    })
                );
            } catch {
                continue;
            }
        }

        if (nextKeys.size === 0) {
            throw new Error('JWKS did not return any usable public keys');
        }

        this.keys = nextKeys;
        this.expiresAt = Date.now() + this.ttlMs;
    }

    async getKey(kid: string) {
        const hasFreshKeys = Date.now() < this.expiresAt && this.keys.size > 0;
        if (!hasFreshKeys || !this.keys.has(kid)) {
            await this.refresh();
        }

        return this.keys.get(kid) ?? null;
    }
}

const supabaseJwksCache = new SupabaseJwksCache();

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
    email?: string;
    role: Role;
}

type ResolvedAuthResult =
    | { ok: true; user: AuthUser }
    | { ok: false; status: number; error: string; authFailure: boolean };

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
            requestId?: string;
        }
    }
}

const classifyAuthProviderFailure = (error: any) => {
    const status = typeof error?.status === 'number' ? error.status : null;
    const message = String(error?.message || '').toLowerCase();

    if (
        status === 401 ||
        status === 403 ||
        message.includes('invalid token') ||
        message.includes('jwt') ||
        message.includes('token')
    ) {
        return {
            status: 401,
            error: 'Invalid token',
            authFailure: true,
        };
    }

    if (
        status === 429 ||
        message.includes('rate limit') ||
        message.includes('too many')
    ) {
        return {
            status: 429,
            error: 'Auth service rate limit reached. Please try again later.',
            authFailure: false,
        };
    }

    return {
        status: 503,
        error: 'Authentication service temporarily unavailable. Please retry.',
        authFailure: false,
    };
};

const getCachedValidatedUser = (token: string | undefined) => {
    if (!token) return null;
    return validatedTokenCache.get(token);
};

const resolveSupabaseIssuer = () => `${process.env.SUPABASE_URL?.replace(/\/+$/, '')}/auth/v1`;

const verifySupabaseJwtLocally = async (token: string): Promise<VerifiedTokenIdentity | null> => {
    if (token.split('.').length !== 3) {
        return null;
    }

    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded !== 'object') {
        return null;
    }

    const header = decoded.header as JwtHeader;
    if (!header?.kid || !header.alg || header.alg.startsWith('HS')) {
        return null;
    }

    const key = await supabaseJwksCache.getKey(header.kid);
    if (!key) {
        return null;
    }

    const verified = jwt.verify(token, key, {
        algorithms: [header.alg as Algorithm],
        issuer: resolveSupabaseIssuer(),
    }) as JwtPayload;

    if (typeof verified?.sub !== 'string' || verified.sub.trim().length === 0) {
        return null;
    }

    const metadataScope = extractScopeMetadata((verified as JwtPayload & { user_metadata?: unknown }).user_metadata);

    return {
        authUserId: verified.sub,
        email: typeof verified.email === 'string' ? verified.email.trim().toLowerCase() : undefined,
        ...metadataScope,
        role: metadataScope.role || readMetadataString((verified as JwtPayload & { role?: unknown }).role),
    };
};

export const requireUser = async (req: Request, res: Response, next: NextFunction) => {
    if (req.user) {
        return next();
    }

    const resolved = await resolveRequestUser(req);
    if (resolved.ok === false) {
        if (resolved.authFailure) {
            recordAuthFailure(req.requestId);
        }
        return res.status(resolved.status).json({ error: resolved.error });
    }

    req.user = resolved.user;
    return next();
};

export const optionalUser = async (req: Request, _res: Response, next: NextFunction) => {
    if (req.user) {
        return next();
    }

    const authHeader = req.header('authorization') || '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
        return next();
    }

    const resolved = await resolveRequestUser(req);
    if (resolved.ok === true) {
        req.user = resolved.user;
    } else if (isAuthDebug) {
        console.warn('[AUTH DEBUG] optionalUser skipped auth context:', resolved.error);
    }

    return next();
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

const resolveRequestUser = async (req: Request): Promise<ResolvedAuthResult> => {
    const authHeader = req.header('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7)
        : undefined;

    if (!token) {
        return {
            ok: false,
            status: 401,
            error: 'Missing bearer token',
            authFailure: true,
        };
    }

    try {
        let verifiedIdentity: VerifiedTokenIdentity | null = null;
        try {
            verifiedIdentity = await verifySupabaseJwtLocally(token);
        } catch (jwtError) {
            if (isAuthDebug) {
                console.warn('[AUTH DEBUG] local JWT verification failed:', (jwtError as any)?.message || jwtError);
            }
        }

        let authUserId: string | undefined;
        let authEmail: string | undefined;
        let metadataScope = {
            tenantId: verifiedIdentity?.tenantId,
            facilityId: verifiedIdentity?.facilityId,
            role: verifiedIdentity?.role,
        };

        if (verifiedIdentity) {
            authUserId = verifiedIdentity.authUserId;
            authEmail = verifiedIdentity.email;
        } else {
            const { data, error } = await supabaseAdmin.auth.getUser(token);
            if (error || !data?.user) {
                if (isAuthDebug) {
                    console.error('[AUTH DEBUG] getUser error:', error?.message || 'No user data');
                }

                if (!data?.user && !error) {
                    return {
                        ok: false,
                        status: 401,
                        error: 'Invalid token',
                        authFailure: true,
                    };
                }

                const classified = classifyAuthProviderFailure(error);
                if (!classified.authFailure) {
                    const cachedUser = getCachedValidatedUser(token);
                    if (cachedUser) {
                        return {
                            ok: true,
                            user: cachedUser,
                        };
                    }
                }
                return {
                    ok: false,
                    status: classified.status,
                    error: classified.error,
                    authFailure: classified.authFailure,
                };
            }

            const providerMetadataScope = extractScopeMetadata((data.user as any)?.user_metadata);
            authUserId = data.user.id;
            authEmail = data.user.email?.trim().toLowerCase() || undefined;
            metadataScope = {
                ...metadataScope,
                ...providerMetadataScope,
                role: providerMetadataScope.role || readMetadataString((data.user as any)?.role) || metadataScope.role,
            };
        }

        if (!authUserId) {
            return {
                ok: false,
                status: 401,
                error: 'Invalid token',
                authFailure: true,
            };
        }

        if (isAuthDebug) {
            console.log('[AUTH DEBUG] authUserId:', authUserId.slice(0, 8) + '…');
        }

        let profile = isTestEnv ? null : userProfileCache.get(authUserId);
        const fromCache = !!profile;

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
                const cachedUser = getCachedValidatedUser(token);
                if (cachedUser) {
                    return {
                        ok: true,
                        user: cachedUser,
                    };
                }
                return {
                    ok: false,
                    status: 500,
                    error: 'Failed to fetch user profile',
                    authFailure: true,
                };
            }

            profile = fetchedProfile;
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

        if (!isTestEnv && Math.random() < 0.01) {
            userProfileCache.cleanup();
        }

        const resolvedUser: AuthUser = {
            authUserId,
            profileId: profile?.id,
            tenantId: profile?.tenant_id || metadataScope.tenantId,
            facilityId: profile?.facility_id || metadataScope.facilityId,
            email: authEmail,
            role: ((profile?.user_role as Role | null) || metadataScope.role || 'staff') as Role,
        };

        validatedTokenCache.set(token, resolvedUser);

        return {
            ok: true,
            user: resolvedUser,
        };
    } catch (err: any) {
        const cachedUser = getCachedValidatedUser(token);
        if (cachedUser) {
            return {
                ok: true,
                user: cachedUser,
            };
        }
        console.error('Auth middleware error:', err?.message || err);
        return {
            ok: false,
            status: 500,
            error: 'Internal auth error',
            authFailure: false,
        };
    }
};
