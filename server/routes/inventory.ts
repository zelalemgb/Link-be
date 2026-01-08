
import { Router } from 'express';
import { requireUser } from '../middleware/auth.js';
import * as inventoryController from '../controllers/inventory.js';

const router = Router();

// Protect all inventory routes
router.use(requireUser);

// Items
router.get('/items', inventoryController.getInventoryItems);
router.post('/items', inventoryController.createInventoryItem);

// Stock Interactions
router.get('/stats', inventoryController.getInventoryStats); // Dashboard stats
router.post('/movements', inventoryController.processStockMovement); // GRN (Receipt), SIV (Issue), Adj
router.get('/movements', inventoryController.getStockMovements);

// Alerts (Low stock, expiring) - can be part of stats or separate
// router.get('/alerts', inventoryController.getStockAlerts);

export default router;
