import { Router } from 'express';
import { requireUser, superAdminGuard } from '../middleware/auth';
import { getMonitoringSnapshot } from '../services/monitoring';

const router = Router();

router.get('/metrics', requireUser, superAdminGuard, async (_req, res) => {
  return res.json(getMonitoringSnapshot());
});

export default router;
