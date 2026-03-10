import type { Request, Response, NextFunction } from 'express';

interface CacheEntry {
  body: any;
  statusCode: number;
  headers: Record<string, string>;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();
const MAX_ENTRIES = 1000;

const evictExpired = () => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
};

// Periodic cleanup every 60s
setInterval(evictExpired, 60_000).unref();

/**
 * Build a cache key from request properties.
 * Includes user scope to prevent cross-tenant cache leaks.
 */
const buildKey = (req: Request): string => {
  const userId = req.user?.profileId || req.patient?.patientAccountId || 'anon';
  const tenantId = req.user?.tenantId || req.patient?.tenantId || '';
  const facilityId = req.user?.facilityId || '';
  return `${req.method}:${req.originalUrl}:${tenantId}:${facilityId}:${userId}`;
};

/**
 * HTTP response cache middleware factory.
 * @param ttlSeconds - Time-to-live in seconds (default 30)
 * @param condition - Optional function to decide if response should be cached
 */
export const responseCache = (ttlSeconds = 30, condition?: (req: Request) => boolean) =>
  (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== 'GET') return next();

    // Optional skip condition
    if (condition && !condition(req)) return next();

    const key = buildKey(req);
    const cached = store.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      // Cache hit — set Cache-Control header and return cached response
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', `private, max-age=${ttlSeconds}`);
      for (const [h, v] of Object.entries(cached.headers)) {
        res.setHeader(h, v);
      }
      return res.status(cached.statusCode).json(cached.body);
    }

    // Cache miss — intercept res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Evict if at capacity
        if (store.size >= MAX_ENTRIES) {
          const firstKey = store.keys().next().value;
          if (firstKey) store.delete(firstKey);
        }

        store.set(key, {
          body,
          statusCode: res.statusCode,
          headers: { 'content-type': 'application/json' },
          expiresAt: Date.now() + ttlSeconds * 1000,
        });
      }

      res.setHeader('X-Cache', 'MISS');
      res.setHeader('Cache-Control', `private, max-age=${ttlSeconds}`);
      return originalJson(body);
    };

    next();
  };

/**
 * Invalidate cache entries matching a prefix pattern.
 * Call this after mutations to keep cache consistent.
 */
export const invalidateCache = (pattern: string) => {
  for (const key of store.keys()) {
    if (key.includes(pattern)) store.delete(key);
  }
};

/** Clear entire cache (useful for tests). */
export const clearCache = () => store.clear();
