import { Router } from 'express';
import { requireSyncScopedUser, requireSyncUser } from '../middleware/sync-auth';
import { ingestSyncPush, loadSyncPull } from '../services/syncService';

const router = Router();

router.use(requireSyncUser, requireSyncScopedUser);

const sendContractError = (res: any, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

const resolveSyncActor = (req: any) => ({
  authUserId: req.user?.authUserId,
  profileId: req.user?.profileId,
  tenantId: req.user?.tenantId,
  facilityId: req.user?.facilityId,
  role: req.user?.role,
  requestId: req.requestId,
  ipAddress: req.ip || req.socket?.remoteAddress || null,
  userAgent: req.get?.('user-agent') || null,
});

router.post('/push', async (req, res) => {
  try {
    const actor = resolveSyncActor(req);
    const result = await ingestSyncPush({ actor, payload: req.body });
    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }
    return res.status(200).json(result.data);
  } catch (error: any) {
    console.error('sync push route error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_SYNC_PUSH_FAILED', 'Failed to ingest sync operations');
  }
});

router.get('/pull', async (req, res) => {
  try {
    const actor = resolveSyncActor(req);
    const result = await loadSyncPull({ actor, query: req.query });
    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }
    return res.status(200).json(result.data);
  } catch (error: any) {
    console.error('sync pull route error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_SYNC_PULL_FAILED', 'Failed to load sync deltas');
  }
});

export default router;

