import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { recordAuthFailure } from '../services/monitoring';
import { getPublicKey, verifyJwt } from '../services/licenseService';
import type { AuthUser } from './auth';

const sendContractError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

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

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const normalized = (token || '').trim();
  const parts = normalized.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asUuid = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return UUID_RE.test(normalized) ? normalized : null;
};

const looksLikeHubJwt = (payload: Record<string, unknown> | null) => {
  if (!payload) return false;
  if (typeof payload.sub !== 'string' || typeof payload.tid !== 'string') return false;
  if (payload.typ === 'hub_sync') return true;
  // Backward-compatible support for license JWTs used as hub auth tokens.
  return typeof payload.tier === 'string';
};

const resolveOfflineHubUser = async (token: string): Promise<AuthUser | null> => {
  let publicKey: string;
  try {
    publicKey = getPublicKey();
  } catch {
    return null;
  }

  const verified = verifyJwt(token, publicKey) as Record<string, unknown> | null;
  if (!verified) return null;

  const hubId = typeof verified.sub === 'string' ? verified.sub : '';
  const tenantId = typeof verified.tid === 'string' ? verified.tid : '';
  const claimedFacilityId = typeof verified.fid === 'string' ? verified.fid : '';
  const claimedProfileId = asUuid(verified.pid);

  if (!hubId || !tenantId) return null;

  const { data: hub, error } = await supabaseAdmin
    .from('hub_registrations')
    .select('id, tenant_id, facility_id, is_active')
    .eq('id', hubId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!hub || hub.is_active === false) return null;
  if (hub.tenant_id !== tenantId) return null;
  if (hub.facility_id && claimedFacilityId && hub.facility_id !== claimedFacilityId) return null;

  const resolvedFacilityId = hub.facility_id || claimedFacilityId || '';
  if (!resolvedFacilityId) return null;

  let resolvedProfileId: string | undefined;
  if (claimedProfileId) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('id, tenant_id, facility_id')
      .eq('id', claimedProfileId)
      .limit(1)
      .maybeSingle();
    if (profileError) {
      throw new Error(profileError.message);
    }
    if (
      profile &&
      profile.tenant_id === hub.tenant_id &&
      (!profile.facility_id || profile.facility_id === resolvedFacilityId)
    ) {
      resolvedProfileId = profile.id;
    }
  }

  return {
    authUserId: `hub:${hub.id}`,
    profileId: resolvedProfileId,
    tenantId: hub.tenant_id,
    facilityId: resolvedFacilityId,
    role: 'hub_device',
  };
};

export const requireSyncUser = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.header('authorization') || '';
  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    recordAuthFailure(req.requestId);
    return sendContractError(res, 401, 'AUTH_MISSING_BEARER_TOKEN', 'Missing bearer token');
  }

  const parsedTokenPayload = decodeJwtPayload(token);
  const shouldTryHubFirst = looksLikeHubJwt(parsedTokenPayload);
  const tryHubFallback = async () => {
    try {
      return await resolveOfflineHubUser(token);
    } catch (err: any) {
      console.error('Sync auth hub fallback error:', err?.message || err);
      return null;
    }
  };

  try {
    // For known hub-issued JWTs, skip cloud auth lookup first.
    if (shouldTryHubFirst) {
      const hubUser = await tryHubFallback();
      if (hubUser) {
        req.user = hubUser;
        return next();
      }
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      const hubUser = await tryHubFallback();
      if (hubUser) {
        req.user = hubUser;
        return next();
      }
      recordAuthFailure(req.requestId);
      return sendContractError(res, 401, 'AUTH_INVALID_TOKEN', 'Invalid token');
    }

    const authUserId = data.user.id;

    // Check cache first
    let profile = userProfileCache.get(authUserId);

    // If not in cache, fetch user profile to get role and facility context
    if (!profile) {
      const { data: fetchedProfile, error: profileErr } = await supabaseAdmin
        .from('users')
        .select('id, tenant_id, facility_id, user_role')
        .eq('auth_user_id', authUserId)
        .limit(1)
        .maybeSingle();

      if (profileErr) {
        throw new Error(profileErr.message);
      }

      profile = fetchedProfile;

      // Cache the profile if found
      if (profile) {
        userProfileCache.set(authUserId, profile);
      }
    }

    if (!profile) {
      return sendContractError(res, 403, 'PERM_MISSING_USER_PROFILE', 'Missing user profile');
    }

    // Periodically clean up expired cache entries
    if (Math.random() < 0.01) {
      userProfileCache.cleanup();
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
    const hubUser = await tryHubFallback();
    if (hubUser) {
      req.user = hubUser;
      return next();
    }

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
