import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_CSRF_EXEMPT_PATHS = [
  /^\/api\/auth\/(initiate-registration|verify-registration-code|register-staff|request-password-reset)$/,
  /^\/api\/staff-invitations\/[^/]+\/register$/,
];

/**
 * CSRF protection middleware using double-submit cookie pattern.
 * - On every response, sets an httpOnly=false CSRF cookie if not present
 * - On state-changing requests (POST/PUT/PATCH/DELETE), validates
 *   that the x-csrf-token header matches the csrf_token cookie
 * - Skips validation for bearer-token-only auth (mobile app)
 */
export const csrfProtection = (req: Request, res: Response, next: NextFunction) => {
  // Issue a CSRF token cookie if one doesn't exist
  if (!req.cookies?.[CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false, // JS must be able to read it to send in header
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      path: '/',
    });
  }

  // Safe methods don't need CSRF validation
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const requestPath = req.path || req.originalUrl || '';
  if (PUBLIC_CSRF_EXEMPT_PATHS.some((matcher) => matcher.test(requestPath))) {
    return next();
  }

  // Skip CSRF for bearer-token-only requests (mobile/API clients)
  const authHeader = req.header('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ') && !req.cookies?.patient_session) {
    return next();
  }

  // Validate CSRF for cookie-based auth
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.header(CSRF_HEADER);

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF validation failed' });
  }

  return next();
};
