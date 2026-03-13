import { Router } from 'express';
import { z } from 'zod';
import { optionalUser } from '../middleware/auth';
import { recordPlatformActivityEvents, type PlatformActivityEvent } from '../services/platform-activity';

const router = Router();

const eventSchema = z.object({
  sessionId: z.string().uuid().optional().nullable(),
  source: z.string().trim().min(1).max(32).optional().nullable(),
  category: z.enum(['session', 'navigation', 'auth', 'registration', 'action', 'api', 'error']),
  eventName: z.string().trim().min(1).max(160),
  outcome: z.enum(['started', 'success', 'failure', 'info']).optional().nullable(),
  actorUserId: z.string().uuid().optional().nullable(),
  actorAuthUserId: z.string().uuid().optional().nullable(),
  actorRole: z.string().trim().min(1).max(128).optional().nullable(),
  actorEmail: z.string().trim().email().max(320).optional().nullable(),
  tenantId: z.string().uuid().optional().nullable(),
  facilityId: z.string().uuid().optional().nullable(),
  pagePath: z.string().trim().max(512).optional().nullable(),
  pageTitle: z.string().trim().max(320).optional().nullable(),
  entryPoint: z.string().trim().max(160).optional().nullable(),
  requestPath: z.string().trim().max(512).optional().nullable(),
  requestMethod: z.string().trim().max(16).optional().nullable(),
  responseStatus: z.number().int().min(0).max(999).optional().nullable(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional().nullable(),
  errorMessage: z.string().trim().max(1200).optional().nullable(),
  referrer: z.string().trim().max(512).optional().nullable(),
  timezone: z.string().trim().max(120).optional().nullable(),
  locale: z.string().trim().max(64).optional().nullable(),
  occurredAt: z.string().datetime().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(50),
});

router.post('/events', optionalUser, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    await recordPlatformActivityEvents(parsed.data.events as PlatformActivityEvent[], {
      actorUserId: req.user?.profileId || null,
      actorAuthUserId: req.user?.authUserId || null,
      actorRole: req.user?.role || null,
      actorEmail: req.user?.email || null,
      tenantId: req.user?.tenantId || null,
      facilityId: req.user?.facilityId || null,
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.get('user-agent') || null,
    });

    return res.status(202).json({ accepted: parsed.data.events.length });
  } catch (error: any) {
    console.warn('platform audit ingestion failed:', error?.message || error);
    return res.status(202).json({ accepted: 0 });
  }
});

export default router;
