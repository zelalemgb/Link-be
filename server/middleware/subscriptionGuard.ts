/**
 * Subscription Guard Middleware
 *
 * Enforces trial/subscription access levels on every authenticated request.
 *
 * Access levels:
 *   full      — all operations permitted (active trial or paid subscription)
 *   grace     — read + write permitted, but banner shown in UI
 *   read_only — GET requests only; POST/PUT/PATCH/DELETE return 402
 *
 * Bypass list: routes that always work regardless of subscription status
 * (payment webhooks, subscription management, auth, health checks).
 */

import { Request, Response, NextFunction } from 'express';
import { getSubscriptionStatus } from '../services/subscriptionService';

// Routes always allowed regardless of subscription state
const BYPASS_PREFIXES = [
  '/api/auth',
  '/api/subscription',
  '/api/webhook',
  '/api/license',
  '/api/agent',
  '/api/health',
  '/health',
];

// Read-only mode: these methods are always allowed
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cache subscription status for 60 seconds to avoid DB hammering
const cache = new Map<string, { status: any; cachedAt: number }>();
const CACHE_TTL_MS = 60_000;

const sanitizeHeaderValue = (value: unknown) =>
  String(value ?? '')
    .replace(/[^\t\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export async function subscriptionGuard(req: Request, res: Response, next: NextFunction) {
  // Skip unauthenticated requests (auth middleware handles them separately)
  if (!req.user) return next();

  const { tenantId } = req.user as any;
  if (!tenantId) return next();

  // Bypass for always-allowed routes
  const path = req.path;
  if (BYPASS_PREFIXES.some((p) => path.startsWith(p))) return next();

  try {
    // Check cache
    const cached = cache.get(tenantId);
    let subscriptionStatus;
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      subscriptionStatus = cached.status;
    } else {
      subscriptionStatus = await getSubscriptionStatus(tenantId);
      cache.set(tenantId, { status: subscriptionStatus, cachedAt: Date.now() });
    }

    // Attach to request so routes can read it
    (req as any).subscription = subscriptionStatus;

    if (subscriptionStatus.accessLevel === 'full' || subscriptionStatus.accessLevel === 'grace') {
      // Full access — proceed
      // Attach subscription info to response headers for frontend banner
      res.setHeader('X-Subscription-Status', subscriptionStatus.status);
      res.setHeader('X-Subscription-Days-Remaining', String(subscriptionStatus.daysRemaining ?? ''));
      if (subscriptionStatus.message) {
        const safeMessage = sanitizeHeaderValue(subscriptionStatus.message);
        if (safeMessage) {
          res.setHeader('X-Subscription-Message', safeMessage);
        }
      }
      return next();
    }

    // read_only mode
    if (SAFE_METHODS.has(req.method)) {
      res.setHeader('X-Subscription-Status', 'read_only');
      return next();
    }

    // Block writes
    return res.status(402).json({
      error: 'subscription_required',
      message: subscriptionStatus.message || 'Your subscription has expired. Please renew to continue.',
      subscriptionStatus: subscriptionStatus.status,
      daysRemaining: subscriptionStatus.daysRemaining,
      upgradeUrl: `${process.env.FRONTEND_URL || ''}/subscribe`,
    });

  } catch (err: any) {
    // On error, allow through (fail open — don't block clinical operations)
    console.error('subscriptionGuard error:', err?.message);
    return next();
  }
}

/** Clear cache entry when subscription changes (after payment) */
export function invalidateSubscriptionCache(tenantId: string) {
  cache.delete(tenantId);
}
