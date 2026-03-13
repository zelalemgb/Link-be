import { Router } from 'express';
import { z } from 'zod';
import { requireUser, requireScopedUser } from '../middleware/auth.js';
import * as inventoryController from '../controllers/inventory.js';
import { supabaseAdmin } from '../config/supabase.js';
import {
  createIssueOrder,
  updateIssueOrder,
  addIssueOrderItem,
  deleteIssueOrderItem,
  dispatchIssueOrder,
  createLossAdjustment,
  updateLossAdjustment,
  approveLossAdjustment,
  type IssueOrderMutationPayload,
  type IssueOrderItemMutationPayload,
  type LossAdjustmentMutationPayload,
} from '../services/inventoryMutationService';
import { isAuditDurabilityError, recordAuditEvent } from '../services/audit-log.js';
import { assertInventoryUnlocked, getLockedInventorySession } from '../services/inventoryLockService.js';
import {
  commitPhysicalInventorySessionFallback,
  createReceivingFromRequestFallback,
  finalizeReceivingInvoiceFallback,
  isMissingRpcFunctionError,
  submitResupplyRequestFallback,
} from '../services/inventoryRpcFallbacks.js';

const router = Router();

// Protect all inventory routes
router.use(requireUser, requireScopedUser);

// Items
router.get('/items', inventoryController.getInventoryItems);
router.post('/items', inventoryController.createInventoryItem);

// Stock Interactions
router.get('/stats', inventoryController.getInventoryStats); // Dashboard stats
router.post('/movements', inventoryController.processStockMovement); // GRN (Receipt), SIV (Issue), Adj
router.get('/movements', inventoryController.getStockMovements);

const requestLineSchema = z.object({
  inventory_item_id: z.string().uuid(),
  quantity_requested: z.coerce.number().positive(),
  amc: z.coerce.number().min(0).default(0),
  soh: z.coerce.number().min(0).default(0),
  unit_cost: z.coerce.number().min(0).default(0),
});

const submitResupplyRequestSchema = z.object({
  requestId: z.string().uuid().optional(),
  requestDetails: z.object({
    reporting_period: z.string().min(1),
    account_type: z.string().min(1),
    request_type: z.string().min(1),
    request_to: z.string().min(1),
    notes: z.string().optional().nullable(),
  }),
  lines: z.array(requestLineSchema).min(1),
});

const receiveFromRequestSchema = z.object({
  requestId: z.string().uuid(),
});

const receivingInvoiceSchema = z.object({
  invoice_no: z.string().min(1),
  receive_date: z.string().min(1),
  receive_type: z.string().min(1),
  supplier_id: z.string().uuid().nullable().optional(),
  delivery_note_no: z.string().nullable().optional(),
  goods_receiving_note_no: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const receivingInvoiceItemSchema = z.object({
  inventory_item_id: z.string().uuid(),
  batch_no: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
  unit_cost: z.coerce.number().min(0),
  unit_selling_price: z.coerce.number().min(0).optional().nullable(),
  profit_margin: z.coerce.number().optional().nullable(),
  expiry_date: z.string().optional().nullable(),
  manufacturer: z.string().optional().nullable(),
  store_location: z.string().optional().nullable(),
  storage_requirement: z.string().optional().nullable(),
  requested_quantity: z.coerce.number().min(0).optional().nullable(),
});

const receivingItemUpdateSchema = z
  .object({
    batch_no: z.string().min(1).optional(),
    quantity: z.coerce.number().int().positive().optional(),
    unit_cost: z.coerce.number().min(0).optional(),
    unit_selling_price: z.coerce.number().min(0).nullable().optional(),
    profit_margin: z.coerce.number().nullable().optional(),
    expiry_date: z.string().nullable().optional(),
    manufacturer: z.string().nullable().optional(),
    store_location: z.string().nullable().optional(),
    storage_requirement: z.string().nullable().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field is required',
  });

const finalizeInvoiceSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid().optional(),
      inventory_item_id: z.string().uuid(),
      quantity: z.coerce.number().int().positive(),
      batch_no: z.string().min(1),
      expiry_date: z.string().nullable().optional(),
      unit_cost: z.coerce.number().min(0),
      unit_selling_price: z.coerce.number().min(0).nullable().optional(),
    })
  ),
});

const issueOrderMutationSchema = z.object({
  period: z.string().trim().min(1).max(64),
  dispensing_unit_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

const issueOrderItemMutationSchema = z.object({
  inventory_item_id: z.string().uuid(),
  beginning_balance: z.coerce.number().min(0),
  qty_received: z.coerce.number().min(0),
  loss: z.coerce.number().min(0).optional(),
  adjustment: z.coerce.number().min(0).optional(),
  qty_requested: z.coerce.number().min(0),
  qty_issued: z.coerce.number().min(0),
  batch_no: z.string().trim().max(120).nullable().optional(),
});

const lossAdjustmentMutationSchema = z.object({
  inventory_item_id: z.string().uuid(),
  batch_no: z.string().trim().max(120).nullable().optional(),
  reason: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().positive(),
  soh: z.coerce.number().min(0).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

const physicalInventorySessionSchema = z.object({
  account_type: z.string().trim().min(1).max(120),
  period_type: z.string().trim().min(1).max(120),
  notes: z.string().max(1000).nullable().optional(),
});

const physicalInventoryItemSchema = z.object({
  inventory_item_id: z.string().uuid(),
  batch_no: z.string().trim().max(120).nullable().optional(),
  manufacturer: z.string().trim().max(255).nullable().optional(),
  expiry_date: z.string().nullable().optional(),
  qty_sound: z.coerce.number().int().min(0),
  qty_damaged: z.coerce.number().int().min(0),
  qty_expired: z.coerce.number().int().min(0),
  system_qty: z.coerce.number().int().min(0),
  new_unit_cost: z.coerce.number().min(0).nullable().optional(),
}).refine(
  (payload) => (payload.qty_sound + payload.qty_damaged + payload.qty_expired) > 0,
  { message: 'At least one counted quantity is required' }
);

const physicalInventoryItemUpdateSchema = z.object({
  batch_no: z.string().trim().max(120).nullable().optional(),
  manufacturer: z.string().trim().max(255).nullable().optional(),
  expiry_date: z.string().nullable().optional(),
  qty_sound: z.coerce.number().int().min(0).optional(),
  qty_damaged: z.coerce.number().int().min(0).optional(),
  qty_expired: z.coerce.number().int().min(0).optional(),
  system_qty: z.coerce.number().int().min(0).optional(),
  new_unit_cost: z.coerce.number().min(0).nullable().optional(),
}).refine((payload) => Object.keys(payload).length > 0, {
  message: 'At least one field is required',
});

const resolveActorProfile = async (authUserId: string, profileId?: string) => {
  if (profileId) {
    const { data: existingProfile } = await supabaseAdmin
      .from('users')
      .select('id, facility_id, tenant_id')
      .eq('id', profileId)
      .maybeSingle();
    if (existingProfile) return existingProfile;
  }

  const { data } = await supabaseAdmin
    .from('users')
    .select('id, facility_id, tenant_id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  return data;
};

const resolveActorScope = async (req: any) => {
  const actor = await resolveActorProfile(req.user!.authUserId, req.user?.profileId);
  return {
    actorFacilityId: actor?.facility_id || req.user?.facilityId,
    actorTenantId: actor?.tenant_id || req.user?.tenantId,
    actorProfileId: actor?.id || req.user?.profileId,
  };
};

const loadScopedInvoice = async (invoiceId: string, facilityId: string, tenantId: string) => {
  const { data, error } = await supabaseAdmin
    .from('receiving_invoices')
    .select('id, invoice_no, status, request_id, facility_id, tenant_id')
    .eq('id', invoiceId)
    .eq('facility_id', facilityId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return { data, error };
};

const mapRpcErrorStatus = (message: string) => {
  const normalized = message.toLowerCase();
  if (normalized.includes('not found')) return 404;
  if (normalized.includes('outside your facility') || normalized.includes('missing facility') || normalized.includes('missing tenant')) {
    return 403;
  }
  if (normalized.includes('no line items') || normalized.includes('at least one line item')) return 400;
  if (normalized.includes('positive quantity') || normalized.includes('must include item, positive quantity, cost, and batch')) return 400;
  if (normalized.includes('already submitted') || normalized.includes('cannot be committed') || normalized.includes('cannot be ended')) return 409;
  if (normalized.includes('insufficient stock')) return 409;
  return 500;
};

const sendContractError = (res: any, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

const buildAuditActorContext = (req: any, actorProfileId?: string | null) => ({
  actorUserId: actorProfileId || req.user?.profileId || null,
  actorRole: req.user?.role || null,
  actorIpAddress: req.ip || req.socket?.remoteAddress || null,
  actorUserAgent: req.get?.('user-agent') || null,
  requestId: req.requestId || null,
});

const recordInventoryStrictAudit = async ({
  req,
  tenantId,
  facilityId,
  actorProfileId,
  action,
  eventType,
  entityType,
  entityId,
  metadata,
  outboxEventType,
  outboxAggregateType,
  outboxAggregateId,
}: {
  req: any;
  tenantId: string;
  facilityId: string;
  actorProfileId?: string | null;
  action: string;
  eventType: 'create' | 'update' | 'delete';
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  outboxEventType: string;
  outboxAggregateType: string;
  outboxAggregateId?: string | null;
}) => {
  const actorCtx = buildAuditActorContext(req, actorProfileId);
  await recordAuditEvent(
    {
      action,
      eventType,
      entityType,
      tenantId,
      facilityId,
      actorUserId: actorCtx.actorUserId,
      actorRole: actorCtx.actorRole,
      actorIpAddress: actorCtx.actorIpAddress,
      actorUserAgent: actorCtx.actorUserAgent,
      entityId: entityId || null,
      actionCategory: 'inventory',
      metadata: metadata || null,
      requestId: actorCtx.requestId,
    },
    {
      strict: true,
      outboxEventType,
      outboxAggregateType,
      outboxAggregateId: outboxAggregateId || entityId || null,
    }
  );
};

const parseOptionalDateParam = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return normalized;
};

const addMonthsUtc = (date: Date, months: number) => {
  const next = new Date(date.toISOString());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

const calculateMonthSpan = (dateFrom?: string | null, dateTo?: string | null, fallbackMonths = 3) => {
  if (!dateFrom || !dateTo) return fallbackMonths;
  const start = new Date(dateFrom);
  const end = new Date(dateTo);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return fallbackMonths;
  const diffDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
  return Math.max(1, Math.ceil(diffDays / 30));
};

const getMovementSign = (movementType: string, quantity: number) => {
  const normalized = (movementType || '').toLowerCase();
  if (['receipt', 'return', 'transfer_in', 'adjustment'].includes(normalized)) return Math.abs(quantity);
  if (['issue', 'out', 'transfer_out', 'expired', 'damaged', 'loss'].includes(normalized)) return -Math.abs(quantity);
  return 0;
};

const buildPhysicalInventoryId = () => {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PHY-${day}-${random}`;
};

const loadScopedPhysicalInventorySession = async (sessionId: string, facilityId: string, tenantId: string) => {
  const { data, error } = await supabaseAdmin
    .from('physical_inventory_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('facility_id', facilityId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return { data, error };
};

const uuidParamSchema = z.string().uuid();
const resolveRequiredUuidParam = ({
  value,
  requiredCode,
  invalidCode,
  label,
}: {
  value: string | undefined;
  requiredCode: string;
  invalidCode: string;
  label: string;
}) => {
  const normalized = (value || '').trim();
  if (!normalized) {
    return {
      ok: false as const,
      status: 400,
      code: requiredCode,
      message: `${label} is required`,
    };
  }

  const parsed = uuidParamSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false as const,
      status: 400,
      code: invalidCode,
      message: `${label} must be a valid UUID`,
    };
  }

  return { ok: true as const, value: parsed.data };
};

const resolveInventoryMutationActor = async (req: any) => {
  const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
  return {
    authUserId: req.user?.authUserId,
    profileId: actorProfileId,
    tenantId: actorTenantId,
    facilityId: actorFacilityId,
    role: req.user?.role,
    requestId: req.requestId,
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.get?.('user-agent') || null,
  };
};

router.post('/issue-orders', async (req, res) => {
  const parsed = issueOrderMutationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_ISSUE_ORDER_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid issue order payload'
    );
  }

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await createIssueOrder({
      actor,
      payload: parsed.data as IssueOrderMutationPayload,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.status(201).json(result.data);
  } catch (error: any) {
    console.error('Create issue order route error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_ISSUE_ORDER_CREATE_FAILED', 'Failed to create issue order');
  }
});

router.put('/issue-orders/:orderId', async (req, res) => {
  const parsed = issueOrderMutationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_ISSUE_ORDER_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid issue order payload'
    );
  }

  const orderIdResult = resolveRequiredUuidParam({
    value: req.params.orderId,
    requiredCode: 'VALIDATION_ISSUE_ORDER_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_ISSUE_ORDER_ID',
    label: 'Issue order id',
  });
  if (!orderIdResult.ok) {
    return sendContractError(res, orderIdResult.status, orderIdResult.code, orderIdResult.message);
  }
  const orderId = orderIdResult.value;

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await updateIssueOrder({
      actor,
      orderId,
      payload: parsed.data as IssueOrderMutationPayload,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.json(result.data);
  } catch (error: any) {
    console.error('Update issue order route error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_ISSUE_ORDER_UPDATE_FAILED', 'Failed to update issue order');
  }
});

router.post('/issue-orders/:orderId/items', async (req, res) => {
  const parsed = issueOrderItemMutationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_ISSUE_ORDER_ITEM_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid issue order item payload'
    );
  }

  const orderIdResult = resolveRequiredUuidParam({
    value: req.params.orderId,
    requiredCode: 'VALIDATION_ISSUE_ORDER_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_ISSUE_ORDER_ID',
    label: 'Issue order id',
  });
  if (!orderIdResult.ok) {
    return sendContractError(res, orderIdResult.status, orderIdResult.code, orderIdResult.message);
  }
  const orderId = orderIdResult.value;

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await addIssueOrderItem({
      actor,
      orderId,
      payload: parsed.data as IssueOrderItemMutationPayload,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.status(201).json(result.data);
  } catch (error: any) {
    console.error('Add issue order item route error:', error?.message || error);
    return sendContractError(
      res,
      500,
      'CONFLICT_ISSUE_ORDER_ITEM_CREATE_FAILED',
      'Failed to add issue order item'
    );
  }
});

router.delete('/issue-orders/items/:itemId', async (req, res) => {
  const itemIdResult = resolveRequiredUuidParam({
    value: req.params.itemId,
    requiredCode: 'VALIDATION_ISSUE_ORDER_ITEM_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_ISSUE_ORDER_ITEM_ID',
    label: 'Issue order item id',
  });
  if (!itemIdResult.ok) {
    return sendContractError(res, itemIdResult.status, itemIdResult.code, itemIdResult.message);
  }
  const itemId = itemIdResult.value;

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await deleteIssueOrderItem({
      actor,
      itemId,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.json(result.data);
  } catch (error: any) {
    console.error('Delete issue order item route error:', error?.message || error);
    return sendContractError(
      res,
      500,
      'CONFLICT_ISSUE_ORDER_ITEM_DELETE_FAILED',
      'Failed to delete issue order item'
    );
  }
});

router.post('/issue-orders/:orderId/dispatch', async (req, res) => {
  const orderIdResult = resolveRequiredUuidParam({
    value: req.params.orderId,
    requiredCode: 'VALIDATION_ISSUE_ORDER_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_ISSUE_ORDER_ID',
    label: 'Issue order id',
  });
  if (!orderIdResult.ok) {
    return sendContractError(res, orderIdResult.status, orderIdResult.code, orderIdResult.message);
  }
  const orderId = orderIdResult.value;

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await dispatchIssueOrder({
      actor,
      orderId,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.json(result.data);
  } catch (error: any) {
    console.error('Dispatch issue order route error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_ISSUE_ORDER_DISPATCH_FAILED', 'Failed to dispatch issue order');
  }
});

router.post('/loss-adjustments', async (req, res) => {
  const parsed = lossAdjustmentMutationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_LOSS_ADJUSTMENT_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid loss adjustment payload'
    );
  }

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await createLossAdjustment({
      actor,
      payload: parsed.data as LossAdjustmentMutationPayload,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.status(201).json(result.data);
  } catch (error: any) {
    console.error('Create loss adjustment route error:', error?.message || error);
    return sendContractError(
      res,
      500,
      'CONFLICT_LOSS_ADJUSTMENT_CREATE_FAILED',
      'Failed to create loss adjustment'
    );
  }
});

router.put('/loss-adjustments/:adjustmentId', async (req, res) => {
  const parsed = lossAdjustmentMutationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_LOSS_ADJUSTMENT_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid loss adjustment payload'
    );
  }

  const adjustmentIdResult = resolveRequiredUuidParam({
    value: req.params.adjustmentId,
    requiredCode: 'VALIDATION_LOSS_ADJUSTMENT_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_LOSS_ADJUSTMENT_ID',
    label: 'Loss adjustment id',
  });
  if (!adjustmentIdResult.ok) {
    return sendContractError(res, adjustmentIdResult.status, adjustmentIdResult.code, adjustmentIdResult.message);
  }
  const adjustmentId = adjustmentIdResult.value;

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await updateLossAdjustment({
      actor,
      adjustmentId,
      payload: parsed.data as LossAdjustmentMutationPayload,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.json(result.data);
  } catch (error: any) {
    console.error('Update loss adjustment route error:', error?.message || error);
    return sendContractError(
      res,
      500,
      'CONFLICT_LOSS_ADJUSTMENT_UPDATE_FAILED',
      'Failed to update loss adjustment'
    );
  }
});

router.post('/loss-adjustments/:adjustmentId/approve', async (req, res) => {
  const adjustmentIdResult = resolveRequiredUuidParam({
    value: req.params.adjustmentId,
    requiredCode: 'VALIDATION_LOSS_ADJUSTMENT_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_LOSS_ADJUSTMENT_ID',
    label: 'Loss adjustment id',
  });
  if (!adjustmentIdResult.ok) {
    return sendContractError(res, adjustmentIdResult.status, adjustmentIdResult.code, adjustmentIdResult.message);
  }
  const adjustmentId = adjustmentIdResult.value;

  try {
    const actor = await resolveInventoryMutationActor(req);
    const result = await approveLossAdjustment({
      actor,
      adjustmentId,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.json(result.data);
  } catch (error: any) {
    console.error('Approve loss adjustment route error:', error?.message || error);
    return sendContractError(
      res,
      500,
      'CONFLICT_LOSS_ADJUSTMENT_APPROVE_FAILED',
      'Failed to approve loss adjustment'
    );
  }
});

router.post('/requests/submit', async (req, res) => {
  const parsed = submitResupplyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const actor = await resolveActorProfile(req.user!.authUserId, req.user?.profileId);
    const actorFacilityId = actor?.facility_id || req.user?.facilityId;
    const actorTenantId = actor?.tenant_id || req.user?.tenantId;
    const actorProfileId = actor?.id || req.user?.profileId;

    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { requestId, requestDetails, lines } = parsed.data;
    const fallbackRequestDetails: Parameters<typeof submitResupplyRequestFallback>[0]['requestDetails'] = {
      reporting_period: requestDetails.reporting_period,
      account_type: requestDetails.account_type,
      request_type: requestDetails.request_type,
      request_to: requestDetails.request_to,
      ...(requestDetails.notes !== undefined ? { notes: requestDetails.notes } : {}),
    };
    const fallbackLines: Parameters<typeof submitResupplyRequestFallback>[0]['lines'] = lines.map((line) => ({
      inventory_item_id: line.inventory_item_id,
      quantity_requested: line.quantity_requested,
      ...(line.amc !== undefined ? { amc: line.amc } : {}),
      ...(line.soh !== undefined ? { soh: line.soh } : {}),
      ...(line.unit_cost !== undefined ? { unit_cost: line.unit_cost } : {}),
    }));
    let transactionalPath: 'backend_submit_resupply_request' | 'direct_fallback' = 'backend_submit_resupply_request';
    let effectiveRequestId: string | null = null;
    const { data: rpcRequestId, error: submitError } = await supabaseAdmin.rpc(
      'backend_submit_resupply_request',
      {
        p_actor_facility_id: actorFacilityId,
        p_actor_tenant_id: actorTenantId,
        p_actor_profile_id: actorProfileId,
        p_request_id: requestId || null,
        p_request_details: requestDetails,
        p_lines: lines,
      }
    );
    if (submitError) {
      if (!isMissingRpcFunctionError(submitError.message)) {
        return res.status(mapRpcErrorStatus(submitError.message)).json({ error: submitError.message });
      }

      transactionalPath = 'direct_fallback';
      try {
        effectiveRequestId = await submitResupplyRequestFallback({
          actorFacilityId,
          actorTenantId,
          actorProfileId,
          requestId: requestId || null,
          requestDetails: fallbackRequestDetails,
          lines: fallbackLines,
        });
      } catch (fallbackError: any) {
        return res.status(mapRpcErrorStatus(fallbackError?.message || '')).json({
          error: fallbackError?.message || 'Failed to submit resupply request',
        });
      }
    } else {
      effectiveRequestId = rpcRequestId || null;
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'submit_resupply_request',
      eventType: 'create',
      entityType: 'resupply_request',
      entityId: effectiveRequestId || null,
      metadata: {
        requestType: requestDetails.request_type,
        reportingPeriod: requestDetails.reporting_period,
        lineCount: lines.length,
        transactionalPath,
      },
      outboxEventType: 'audit.inventory.resupply_request.submit.write_failed',
      outboxAggregateType: 'resupply_request',
      outboxAggregateId: effectiveRequestId || null,
    });

    return res.json({
      success: true,
      requestId: effectiveRequestId,
    });
  } catch (error: any) {
    console.error('Submit resupply request error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/receiving/from-request', async (req, res) => {
  const parsed = receiveFromRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const actor = await resolveActorProfile(req.user!.authUserId, req.user?.profileId);
    const actorFacilityId = actor?.facility_id || req.user?.facilityId;
    const actorTenantId = actor?.tenant_id || req.user?.tenantId;
    const actorProfileId = actor?.id || req.user?.profileId;

    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { requestId } = parsed.data;
    let transactionalPath: 'backend_create_receiving_from_request' | 'direct_fallback' = 'backend_create_receiving_from_request';
    let result: {
      invoice_id?: string;
      created?: boolean;
      repopulated?: boolean;
    } = {};
    const { data, error: receiveError } = await supabaseAdmin.rpc(
      'backend_create_receiving_from_request',
      {
        p_actor_facility_id: actorFacilityId,
        p_actor_tenant_id: actorTenantId,
        p_actor_profile_id: actorProfileId,
        p_request_id: requestId,
      }
    );
    if (receiveError) {
      if (!isMissingRpcFunctionError(receiveError.message)) {
        return res.status(mapRpcErrorStatus(receiveError.message)).json({ error: receiveError.message });
      }

      transactionalPath = 'direct_fallback';
      try {
        result = await createReceivingFromRequestFallback({
          actorFacilityId,
          actorTenantId,
          actorProfileId,
          requestId,
        });
      } catch (fallbackError: any) {
        return res.status(mapRpcErrorStatus(fallbackError?.message || '')).json({
          error: fallbackError?.message || 'Failed to create receiving invoice from request',
        });
      }
    } else {
      result = (data || {}) as {
        invoice_id?: string;
        created?: boolean;
        repopulated?: boolean;
      };
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'create_receiving_from_resupply_request',
      eventType: 'create',
      entityType: 'receiving_invoice',
      entityId: result.invoice_id || null,
      metadata: {
        requestId,
        created: Boolean(result.created),
        repopulated: Boolean(result.repopulated),
        transactionalPath,
      },
      outboxEventType: 'audit.inventory.receiving.from_request.write_failed',
      outboxAggregateType: 'receiving_invoice',
      outboxAggregateId: result.invoice_id || requestId,
    });

    return res.json({
      success: true,
      invoiceId: result.invoice_id,
      created: Boolean(result.created),
      repopulated: Boolean(result.repopulated),
    });
  } catch (error: any) {
    console.error('Create receiving invoice from request error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

router.post('/receiving/invoices', async (req, res) => {
  const parsed = receivingInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const payload = parsed.data;
    const { data, error } = await supabaseAdmin
      .from('receiving_invoices')
      .insert({
        ...payload,
        supplier_id: payload.supplier_id || null,
        delivery_note_no: payload.delivery_note_no || null,
        goods_receiving_note_no: payload.goods_receiving_note_no || null,
        notes: payload.notes || null,
        status: 'draft',
        facility_id: actorFacilityId,
        tenant_id: actorTenantId,
        created_by: actorProfileId,
      })
      .select('*')
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'create_receiving_invoice',
      eventType: 'create',
      entityType: 'receiving_invoice',
      entityId: data?.id || null,
      metadata: {
        invoiceNo: data?.invoice_no || payload.invoice_no,
        receiveType: payload.receive_type,
      },
      outboxEventType: 'audit.inventory.receiving_invoice.create.write_failed',
      outboxAggregateType: 'receiving_invoice',
      outboxAggregateId: data?.id || null,
    });

    return res.status(201).json({ invoice: data });
  } catch (error: any) {
    console.error('Create receiving invoice error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/receiving/invoices/:invoiceId', async (req, res) => {
  const parsed = receivingInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { invoiceId } = req.params;
    const { data: invoice, error: invoiceError } = await loadScopedInvoice(invoiceId, actorFacilityId, actorTenantId);
    if (invoiceError) {
      return res.status(500).json({ error: invoiceError.message });
    }
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (invoice.status !== 'draft') {
      return res.status(409).json({ error: 'Only draft invoices can be edited' });
    }

    const payload = parsed.data;
    const { data, error } = await supabaseAdmin
      .from('receiving_invoices')
      .update({
        ...payload,
        supplier_id: payload.supplier_id || null,
        delivery_note_no: payload.delivery_note_no || null,
        goods_receiving_note_no: payload.goods_receiving_note_no || null,
        notes: payload.notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', invoiceId)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .select('*')
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'update_receiving_invoice',
      eventType: 'update',
      entityType: 'receiving_invoice',
      entityId: data?.id || invoiceId,
      metadata: {
        invoiceNo: data?.invoice_no || invoice.invoice_no,
        receiveType: payload.receive_type,
      },
      outboxEventType: 'audit.inventory.receiving_invoice.update.write_failed',
      outboxAggregateType: 'receiving_invoice',
      outboxAggregateId: data?.id || invoiceId,
    });

    return res.json({ invoice: data });
  } catch (error: any) {
    console.error('Update receiving invoice error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/receiving/invoices/:invoiceId/items', async (req, res) => {
  const parsed = receivingInvoiceItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { invoiceId } = req.params;
    const { data: invoice, error: invoiceError } = await loadScopedInvoice(invoiceId, actorFacilityId, actorTenantId);
    if (invoiceError) {
      return res.status(500).json({ error: invoiceError.message });
    }
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (invoice.status !== 'draft') {
      return res.status(409).json({ error: 'Items can only be edited on draft invoices' });
    }

    const { data: inventoryItem } = await supabaseAdmin
      .from('inventory_items')
      .select('id')
      .eq('id', parsed.data.inventory_item_id)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .maybeSingle();
    if (!inventoryItem) {
      return res.status(404).json({ error: 'Inventory item not found in your facility' });
    }

    const { data, error } = await supabaseAdmin
      .from('receiving_invoice_items')
      .insert({
        ...parsed.data,
        invoice_id: invoiceId,
        tenant_id: actorTenantId,
      })
      .select('*')
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'create_receiving_invoice_item',
      eventType: 'create',
      entityType: 'receiving_invoice_item',
      entityId: data?.id || null,
      metadata: {
        invoiceId,
        inventoryItemId: parsed.data.inventory_item_id,
        quantity: parsed.data.quantity,
      },
      outboxEventType: 'audit.inventory.receiving_invoice_item.create.write_failed',
      outboxAggregateType: 'receiving_invoice_item',
      outboxAggregateId: data?.id || null,
    });

    return res.status(201).json({ item: data });
  } catch (error: any) {
    console.error('Add receiving invoice item error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/receiving/items/:itemId', async (req, res) => {
  const parsed = receivingItemUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { itemId } = req.params;
    const { data: existingItem, error: existingItemError } = await supabaseAdmin
      .from('receiving_invoice_items')
      .select('id, invoice_id')
      .eq('id', itemId)
      .maybeSingle();
    if (existingItemError) {
      return res.status(500).json({ error: existingItemError.message });
    }
    if (!existingItem) {
      return res.status(404).json({ error: 'Invoice item not found' });
    }

    const { data: invoice, error: invoiceError } = await loadScopedInvoice(
      existingItem.invoice_id,
      actorFacilityId,
      actorTenantId
    );
    if (invoiceError) {
      return res.status(500).json({ error: invoiceError.message });
    }
    if (!invoice) {
      return res.status(403).json({ error: 'Cannot edit invoice items outside your facility' });
    }
    if (invoice.status !== 'draft') {
      return res.status(409).json({ error: 'Items can only be edited on draft invoices' });
    }

    const { data, error } = await supabaseAdmin
      .from('receiving_invoice_items')
      .update(parsed.data)
      .eq('id', itemId)
      .eq('invoice_id', existingItem.invoice_id)
      .select('*')
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'update_receiving_invoice_item',
      eventType: 'update',
      entityType: 'receiving_invoice_item',
      entityId: data?.id || itemId,
      metadata: {
        invoiceId: existingItem.invoice_id,
        fieldsUpdated: Object.keys(parsed.data),
      },
      outboxEventType: 'audit.inventory.receiving_invoice_item.update.write_failed',
      outboxAggregateType: 'receiving_invoice_item',
      outboxAggregateId: data?.id || itemId,
    });

    return res.json({ item: data });
  } catch (error: any) {
    console.error('Update receiving invoice item error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/receiving/items/:itemId', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { itemId } = req.params;
    const { data: existingItem, error: existingItemError } = await supabaseAdmin
      .from('receiving_invoice_items')
      .select('id, invoice_id')
      .eq('id', itemId)
      .maybeSingle();
    if (existingItemError) {
      return res.status(500).json({ error: existingItemError.message });
    }
    if (!existingItem) {
      return res.status(404).json({ error: 'Invoice item not found' });
    }

    const { data: invoice, error: invoiceError } = await loadScopedInvoice(
      existingItem.invoice_id,
      actorFacilityId,
      actorTenantId
    );
    if (invoiceError) {
      return res.status(500).json({ error: invoiceError.message });
    }
    if (!invoice) {
      return res.status(403).json({ error: 'Cannot delete invoice items outside your facility' });
    }
    if (invoice.status !== 'draft') {
      return res.status(409).json({ error: 'Items can only be edited on draft invoices' });
    }

    const { error } = await supabaseAdmin
      .from('receiving_invoice_items')
      .delete()
      .eq('id', itemId)
      .eq('invoice_id', existingItem.invoice_id);
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'delete_receiving_invoice_item',
      eventType: 'delete',
      entityType: 'receiving_invoice_item',
      entityId: itemId,
      metadata: {
        invoiceId: existingItem.invoice_id,
      },
      outboxEventType: 'audit.inventory.receiving_invoice_item.delete.write_failed',
      outboxAggregateType: 'receiving_invoice_item',
      outboxAggregateId: itemId,
    });

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Delete receiving invoice item error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/receiving/invoices/:invoiceId/finalize', async (req, res) => {
  const parsed = finalizeInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { invoiceId } = req.params;
    const { data: invoice, error: invoiceError } = await loadScopedInvoice(invoiceId, actorFacilityId, actorTenantId);
    if (invoiceError) {
      return res.status(500).json({ error: invoiceError.message });
    }
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (invoice.status !== 'draft') {
      return res.status(409).json({ error: 'Invoice is already submitted' });
    }

    const inventoryUnlocked = await assertInventoryUnlocked({
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      action: 'finalize receiving invoices',
    });
    if (inventoryUnlocked.ok === false) {
      return sendContractError(res, inventoryUnlocked.status, inventoryUnlocked.code, inventoryUnlocked.message);
    }

    let rpcResult: {
      success?: boolean;
      requestClosed?: boolean;
      stockMovementCount?: number;
      submittedAt?: string;
    } = {};
    const fallbackItems: Parameters<typeof finalizeReceivingInvoiceFallback>[0]['items'] =
      parsed.data.items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        inventory_item_id: item.inventory_item_id,
        quantity: item.quantity,
        batch_no: item.batch_no,
        ...(item.expiry_date !== undefined ? { expiry_date: item.expiry_date } : {}),
        unit_cost: item.unit_cost,
        ...(item.unit_selling_price !== undefined ? { unit_selling_price: item.unit_selling_price } : {}),
      }));
    let transactionalPath: 'backend_finalize_receiving_invoice' | 'direct_fallback' = 'backend_finalize_receiving_invoice';
    const { data, error: finalizeError } = await supabaseAdmin.rpc(
      'backend_finalize_receiving_invoice',
      {
        p_actor_facility_id: actorFacilityId,
        p_actor_tenant_id: actorTenantId,
        p_actor_profile_id: actorProfileId,
        p_invoice_id: invoiceId,
        p_items: parsed.data.items,
      }
    );
    if (finalizeError) {
      if (!isMissingRpcFunctionError(finalizeError.message)) {
        return res.status(mapRpcErrorStatus(finalizeError.message)).json({ error: finalizeError.message });
      }

      transactionalPath = 'direct_fallback';
      try {
        rpcResult = await finalizeReceivingInvoiceFallback({
          actorFacilityId,
          actorTenantId,
          actorProfileId,
          invoiceId,
          items: fallbackItems,
        });
      } catch (fallbackError: any) {
        return res.status(mapRpcErrorStatus(fallbackError?.message || '')).json({
          error: fallbackError?.message || 'Failed to finalize receiving invoice',
        });
      }
    } else {
      rpcResult = (data || {}) as {
        success?: boolean;
        requestClosed?: boolean;
        stockMovementCount?: number;
        submittedAt?: string;
      };
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'finalize_receiving_invoice',
      eventType: 'update',
      entityType: 'receiving_invoice',
      entityId: invoiceId,
      metadata: {
        invoiceNo: invoice.invoice_no,
        requestId: invoice.request_id || null,
        itemCount: parsed.data.items.length,
        stockMovementCount: Number(rpcResult.stockMovementCount || 0),
        requestClosed: Boolean(rpcResult.requestClosed),
        transactionalPath,
      },
      outboxEventType: 'audit.inventory.receiving_invoice.finalize.write_failed',
      outboxAggregateType: 'receiving_invoice',
      outboxAggregateId: invoiceId,
    });

    return res.json({
      success: true,
      requestClosed: Boolean(rpcResult.requestClosed),
      stockMovementCount: Number(rpcResult.stockMovementCount || 0),
      submittedAt: rpcResult.submittedAt || null,
    });
  } catch (error: any) {
    console.error('Finalize receiving invoice error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/physical-inventory/sessions', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { data, error } = await supabaseAdmin
      .from('physical_inventory_sessions')
      .select('*')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .order('created_at', { ascending: false });
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ sessions: data || [] });
  } catch (error: any) {
    console.error('List physical inventory sessions error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/physical-inventory/sessions/:sessionId', async (req, res) => {
  const sessionIdResult = resolveRequiredUuidParam({
    value: req.params.sessionId,
    requiredCode: 'VALIDATION_PHYSICAL_INVENTORY_SESSION_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_PHYSICAL_INVENTORY_SESSION_ID',
    label: 'Physical inventory session id',
  });
  if (!sessionIdResult.ok) {
    return sendContractError(res, sessionIdResult.status, sessionIdResult.code, sessionIdResult.message);
  }

  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { data: session, error: sessionError } = await loadScopedPhysicalInventorySession(
      sessionIdResult.value,
      actorFacilityId,
      actorTenantId
    );
    if (sessionError) {
      return res.status(500).json({ error: sessionError.message });
    }
    if (!session) {
      return res.status(404).json({ error: 'Physical inventory session not found' });
    }

    const { data: items, error: itemsError } = await supabaseAdmin
      .from('physical_inventory_session_items')
      .select(`
        *,
        inventory_items:inventory_item_id (name, generic_name, strength, unit_cost)
      `)
      .eq('session_id', session.id)
      .order('created_at', { ascending: true });
    if (itemsError) {
      return res.status(500).json({ error: itemsError.message });
    }

    return res.json({ session, items: items || [] });
  } catch (error: any) {
    console.error('Get physical inventory session error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/physical-inventory/sessions', async (req, res) => {
  const parsed = physicalInventorySessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_PHYSICAL_INVENTORY_SESSION_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid physical inventory session payload'
    );
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const lockedSession = await getLockedInventorySession({
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
    });
    if (lockedSession) {
      return sendContractError(
        res,
        409,
        'CONFLICT_INVENTORY_COUNT_LOCKED',
        `Physical inventory ${lockedSession.inventory_id || lockedSession.id} is already locking stock transactions`
      );
    }

    const payload = parsed.data;
    const inventoryId = buildPhysicalInventoryId();
    const { data, error } = await supabaseAdmin
      .from('physical_inventory_sessions')
      .insert({
        inventory_id: inventoryId,
        tenant_id: actorTenantId,
        facility_id: actorFacilityId,
        account_type: payload.account_type,
        period_type: payload.period_type,
        notes: payload.notes || null,
        status: 'draft',
        is_locked: true,
        created_by: actorProfileId,
      })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') {
        return sendContractError(
          res,
          409,
          'CONFLICT_INVENTORY_COUNT_LOCKED',
          'Another physical inventory session is already active for this facility'
        );
      }
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'create_physical_inventory_session',
      eventType: 'create',
      entityType: 'physical_inventory_session',
      entityId: data?.id || null,
      metadata: {
        inventoryId,
        accountType: payload.account_type,
        periodType: payload.period_type,
      },
      outboxEventType: 'audit.inventory.physical_inventory_session.create.write_failed',
      outboxAggregateType: 'physical_inventory_session',
      outboxAggregateId: data?.id || null,
    });

    return res.status(201).json({ session: data });
  } catch (error: any) {
    console.error('Create physical inventory session error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/physical-inventory/sessions/:sessionId/items', async (req, res) => {
  const parsed = physicalInventoryItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_PHYSICAL_INVENTORY_ITEM_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid physical inventory item payload'
    );
  }

  const sessionIdResult = resolveRequiredUuidParam({
    value: req.params.sessionId,
    requiredCode: 'VALIDATION_PHYSICAL_INVENTORY_SESSION_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_PHYSICAL_INVENTORY_SESSION_ID',
    label: 'Physical inventory session id',
  });
  if (!sessionIdResult.ok) {
    return sendContractError(res, sessionIdResult.status, sessionIdResult.code, sessionIdResult.message);
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { data: session, error: sessionError } = await loadScopedPhysicalInventorySession(
      sessionIdResult.value,
      actorFacilityId,
      actorTenantId
    );
    if (sessionError) {
      return res.status(500).json({ error: sessionError.message });
    }
    if (!session) {
      return res.status(404).json({ error: 'Physical inventory session not found' });
    }
    if (session.status !== 'draft') {
      return res.status(409).json({ error: 'Items can only be edited on draft physical inventory sessions' });
    }

    const { data: inventoryItem } = await supabaseAdmin
      .from('inventory_items')
      .select('id')
      .eq('id', parsed.data.inventory_item_id)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .maybeSingle();
    if (!inventoryItem) {
      return res.status(404).json({ error: 'Inventory item not found in your facility' });
    }

    const { data, error } = await supabaseAdmin
      .from('physical_inventory_session_items')
      .insert({
        session_id: session.id,
        tenant_id: actorTenantId,
        inventory_item_id: parsed.data.inventory_item_id,
        batch_no: parsed.data.batch_no || null,
        manufacturer: parsed.data.manufacturer || null,
        expiry_date: parsed.data.expiry_date || null,
        qty_sound: parsed.data.qty_sound,
        qty_damaged: parsed.data.qty_damaged,
        qty_expired: parsed.data.qty_expired,
        system_qty: parsed.data.system_qty,
        new_unit_cost: parsed.data.new_unit_cost ?? null,
        created_by: actorProfileId,
      })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This inventory item and batch already exists in the active count' });
      }
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'create_physical_inventory_item',
      eventType: 'create',
      entityType: 'physical_inventory_item',
      entityId: data?.id || null,
      metadata: {
        sessionId: session.id,
        inventoryItemId: parsed.data.inventory_item_id,
      },
      outboxEventType: 'audit.inventory.physical_inventory_item.create.write_failed',
      outboxAggregateType: 'physical_inventory_item',
      outboxAggregateId: data?.id || null,
    });

    return res.status(201).json({ item: data });
  } catch (error: any) {
    console.error('Create physical inventory item error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/physical-inventory/items/:itemId', async (req, res) => {
  const parsed = physicalInventoryItemUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_PHYSICAL_INVENTORY_ITEM_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid physical inventory item payload'
    );
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { itemId } = req.params;
    const { data: existingItem, error: existingItemError } = await supabaseAdmin
      .from('physical_inventory_session_items')
      .select('id, session_id, qty_sound, qty_damaged, qty_expired')
      .eq('id', itemId)
      .maybeSingle();
    if (existingItemError) {
      return res.status(500).json({ error: existingItemError.message });
    }
    if (!existingItem) {
      return res.status(404).json({ error: 'Physical inventory item not found' });
    }

    const { data: session, error: sessionError } = await loadScopedPhysicalInventorySession(
      existingItem.session_id,
      actorFacilityId,
      actorTenantId
    );
    if (sessionError) {
      return res.status(500).json({ error: sessionError.message });
    }
    if (!session) {
      return res.status(403).json({ error: 'Cannot edit physical inventory items outside your facility' });
    }
    if (session.status !== 'draft') {
      return res.status(409).json({ error: 'Items can only be edited on draft physical inventory sessions' });
    }

    const updatedPayload = { ...parsed.data };
    const total =
      Number(updatedPayload.qty_sound ?? existingItem.qty_sound ?? 0) +
      Number(updatedPayload.qty_damaged ?? existingItem.qty_damaged ?? 0) +
      Number(updatedPayload.qty_expired ?? existingItem.qty_expired ?? 0);
    if (
      ('qty_sound' in updatedPayload || 'qty_damaged' in updatedPayload || 'qty_expired' in updatedPayload) &&
      total <= 0
    ) {
      return res.status(400).json({ error: 'At least one counted quantity is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('physical_inventory_session_items')
      .update(updatedPayload)
      .eq('id', itemId)
      .eq('session_id', existingItem.session_id)
      .select('*')
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'update_physical_inventory_item',
      eventType: 'update',
      entityType: 'physical_inventory_item',
      entityId: data?.id || itemId,
      metadata: {
        sessionId: existingItem.session_id,
        fieldsUpdated: Object.keys(parsed.data),
      },
      outboxEventType: 'audit.inventory.physical_inventory_item.update.write_failed',
      outboxAggregateType: 'physical_inventory_item',
      outboxAggregateId: data?.id || itemId,
    });

    return res.json({ item: data });
  } catch (error: any) {
    console.error('Update physical inventory item error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/physical-inventory/items/:itemId', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { itemId } = req.params;
    const { data: existingItem, error: existingItemError } = await supabaseAdmin
      .from('physical_inventory_session_items')
      .select('id, session_id')
      .eq('id', itemId)
      .maybeSingle();
    if (existingItemError) {
      return res.status(500).json({ error: existingItemError.message });
    }
    if (!existingItem) {
      return res.status(404).json({ error: 'Physical inventory item not found' });
    }

    const { data: session, error: sessionError } = await loadScopedPhysicalInventorySession(
      existingItem.session_id,
      actorFacilityId,
      actorTenantId
    );
    if (sessionError) {
      return res.status(500).json({ error: sessionError.message });
    }
    if (!session) {
      return res.status(403).json({ error: 'Cannot delete physical inventory items outside your facility' });
    }
    if (session.status !== 'draft') {
      return res.status(409).json({ error: 'Items can only be deleted on draft physical inventory sessions' });
    }

    const { error } = await supabaseAdmin
      .from('physical_inventory_session_items')
      .delete()
      .eq('id', itemId)
      .eq('session_id', existingItem.session_id);
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'delete_physical_inventory_item',
      eventType: 'delete',
      entityType: 'physical_inventory_item',
      entityId: itemId,
      metadata: {
        sessionId: existingItem.session_id,
      },
      outboxEventType: 'audit.inventory.physical_inventory_item.delete.write_failed',
      outboxAggregateType: 'physical_inventory_item',
      outboxAggregateId: itemId,
    });

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Delete physical inventory item error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/physical-inventory/sessions/:sessionId/commit', async (req, res) => {
  const sessionIdResult = resolveRequiredUuidParam({
    value: req.params.sessionId,
    requiredCode: 'VALIDATION_PHYSICAL_INVENTORY_SESSION_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_PHYSICAL_INVENTORY_SESSION_ID',
    label: 'Physical inventory session id',
  });
  if (!sessionIdResult.ok) {
    return sendContractError(res, sessionIdResult.status, sessionIdResult.code, sessionIdResult.message);
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { data: session, error: sessionError } = await loadScopedPhysicalInventorySession(
      sessionIdResult.value,
      actorFacilityId,
      actorTenantId
    );
    if (sessionError) {
      return res.status(500).json({ error: sessionError.message });
    }
    if (!session) {
      return res.status(404).json({ error: 'Physical inventory session not found' });
    }

    let rpcResult: {
      success?: boolean;
      movementCount?: number;
      committedAt?: string;
    } = {};
    let transactionalPath: 'backend_commit_physical_inventory_session' | 'direct_fallback' = 'backend_commit_physical_inventory_session';
    const { data, error: commitError } = await supabaseAdmin.rpc(
      'backend_commit_physical_inventory_session',
      {
        p_actor_facility_id: actorFacilityId,
        p_actor_tenant_id: actorTenantId,
        p_actor_profile_id: actorProfileId,
        p_session_id: session.id,
      }
    );
    if (commitError) {
      if (!isMissingRpcFunctionError(commitError.message)) {
        return res.status(mapRpcErrorStatus(commitError.message)).json({ error: commitError.message });
      }

      transactionalPath = 'direct_fallback';
      try {
        rpcResult = await commitPhysicalInventorySessionFallback({
          actorFacilityId,
          actorTenantId,
          actorProfileId,
          sessionId: session.id,
        });
      } catch (fallbackError: any) {
        return res.status(mapRpcErrorStatus(fallbackError?.message || '')).json({
          error: fallbackError?.message || 'Failed to commit physical inventory session',
        });
      }
    } else {
      rpcResult = (data || {}) as {
        success?: boolean;
        movementCount?: number;
        committedAt?: string;
      };
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'commit_physical_inventory_session',
      eventType: 'update',
      entityType: 'physical_inventory_session',
      entityId: session.id,
      metadata: {
        inventoryId: session.inventory_id,
        movementCount: Number(rpcResult.movementCount || 0),
        transactionalPath,
      },
      outboxEventType: 'audit.inventory.physical_inventory_session.commit.write_failed',
      outboxAggregateType: 'physical_inventory_session',
      outboxAggregateId: session.id,
    });

    return res.json({
      success: true,
      movementCount: Number(rpcResult.movementCount || 0),
      committedAt: rpcResult.committedAt || null,
    });
  } catch (error: any) {
    console.error('Commit physical inventory session error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/physical-inventory/sessions/:sessionId/end', async (req, res) => {
  const sessionIdResult = resolveRequiredUuidParam({
    value: req.params.sessionId,
    requiredCode: 'VALIDATION_PHYSICAL_INVENTORY_SESSION_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_PHYSICAL_INVENTORY_SESSION_ID',
    label: 'Physical inventory session id',
  });
  if (!sessionIdResult.ok) {
    return sendContractError(res, sessionIdResult.status, sessionIdResult.code, sessionIdResult.message);
  }

  try {
    const { actorFacilityId, actorTenantId, actorProfileId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId || !actorProfileId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const { data: session, error: sessionError } = await loadScopedPhysicalInventorySession(
      sessionIdResult.value,
      actorFacilityId,
      actorTenantId
    );
    if (sessionError) {
      return res.status(500).json({ error: sessionError.message });
    }
    if (!session) {
      return res.status(404).json({ error: 'Physical inventory session not found' });
    }
    if (session.status !== 'committed') {
      return res.status(409).json({ error: 'Only committed physical inventory sessions can be ended' });
    }

    const endedAt = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('physical_inventory_sessions')
      .update({
        status: 'closed',
        is_locked: false,
        ended_at: endedAt,
        ended_by: actorProfileId,
        updated_at: endedAt,
      })
      .eq('id', session.id)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .select('*')
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await recordInventoryStrictAudit({
      req,
      tenantId: actorTenantId,
      facilityId: actorFacilityId,
      actorProfileId,
      action: 'end_physical_inventory_session',
      eventType: 'update',
      entityType: 'physical_inventory_session',
      entityId: session.id,
      metadata: {
        inventoryId: session.inventory_id,
        endedAt,
      },
      outboxEventType: 'audit.inventory.physical_inventory_session.end.write_failed',
      outboxAggregateType: 'physical_inventory_session',
      outboxAggregateId: session.id,
    });

    return res.json({ success: true, session: data });
  } catch (error: any) {
    console.error('End physical inventory session error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reports/stock-status', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const category = typeof req.query.category === 'string' ? req.query.category.trim() : 'all';
    const itemSearch = typeof req.query.item === 'string' ? req.query.item.trim().toLowerCase() : '';
    const dateFrom = parseOptionalDateParam(req.query.dateFrom) || addMonthsUtc(new Date(), -3).toISOString().slice(0, 10);
    const dateTo = parseOptionalDateParam(req.query.dateTo) || new Date().toISOString().slice(0, 10);
    const monthSpan = calculateMonthSpan(dateFrom, dateTo, 3);

    let itemQuery = supabaseAdmin
      .from('inventory_items')
      .select('id, name, generic_name, category, reorder_level, max_stock_level, unit_cost')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .eq('is_active', true);
    if (category && category !== 'all') {
      itemQuery = itemQuery.eq('category', category);
    }
    const { data: items, error: itemsError } = await itemQuery;
    if (itemsError) {
      return res.status(500).json({ error: itemsError.message });
    }

    const filteredItems = (items || []).filter((item: any) => {
      if (!itemSearch) return true;
      const haystack = `${item.name || ''} ${item.generic_name || ''}`.toLowerCase();
      return haystack.includes(itemSearch);
    });

    const { data: stockRows, error: stockError } = await supabaseAdmin
      .from('current_stock')
      .select('inventory_item_id, current_quantity, reorder_level, tenant_id')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId);
    if (stockError) {
      return res.status(500).json({ error: stockError.message });
    }

    const { data: movementRows, error: movementError } = await supabaseAdmin
      .from('stock_movements')
      .select('inventory_item_id, movement_type, quantity, created_at')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`)
      .in('movement_type', ['issue', 'out', 'transfer_out']);
    if (movementError) {
      return res.status(500).json({ error: movementError.message });
    }

    const stockMap = new Map<string, number>();
    (stockRows || []).forEach((row: any) => {
      stockMap.set(row.inventory_item_id, Number(row.current_quantity || 0));
    });

    const issueMap = new Map<string, number>();
    (movementRows || []).forEach((row: any) => {
      issueMap.set(
        row.inventory_item_id,
        Number(issueMap.get(row.inventory_item_id) || 0) + Math.abs(Number(row.quantity || 0))
      );
    });

    const rows = filteredItems.map((item: any) => {
      const soh = Number(stockMap.get(item.id) || 0);
      const amc = Number((Number(issueMap.get(item.id) || 0) / monthSpan).toFixed(2));
      const mos = amc > 0 ? Number((soh / amc).toFixed(2)) : null;
      let status = 'Normal';
      if (soh <= 0) status = 'Out of Stock';
      else if (soh <= Number(item.reorder_level || 0)) status = 'Low Stock';
      else if (item.max_stock_level && soh > Number(item.max_stock_level)) status = 'Over Stock';

      return {
        inventory_item_id: item.id,
        item: item.name,
        category: item.category || 'Uncategorized',
        account: 'Unassigned',
        soh,
        amc,
        mos,
        status,
      };
    });

    return res.json({ rows, dateFrom, dateTo, monthSpan });
  } catch (error: any) {
    console.error('Stock status report error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reports/bin-card', async (req, res) => {
  const itemIdResult = resolveRequiredUuidParam({
    value: typeof req.query.inventory_item_id === 'string' ? req.query.inventory_item_id : undefined,
    requiredCode: 'VALIDATION_INVENTORY_ITEM_ID_REQUIRED',
    invalidCode: 'VALIDATION_INVALID_INVENTORY_ITEM_ID',
    label: 'Inventory item id',
  });
  if (!itemIdResult.ok) {
    return sendContractError(res, itemIdResult.status, itemIdResult.code, itemIdResult.message);
  }

  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const dateFrom = parseOptionalDateParam(req.query.dateFrom);
    const dateTo = parseOptionalDateParam(req.query.dateTo);

    let query = supabaseAdmin
      .from('stock_movements')
      .select(`
        id,
        movement_type,
        quantity,
        balance_after,
        batch_number,
        reference_number,
        notes,
        created_at,
        inventory_items:inventory_item_id (name, generic_name)
      `)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .eq('inventory_item_id', itemIdResult.value)
      .order('created_at', { ascending: true });
    if (dateFrom) {
      query = query.gte('created_at', `${dateFrom}T00:00:00.000Z`);
    }
    if (dateTo) {
      query = query.lte('created_at', `${dateTo}T23:59:59.999Z`);
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const rows = (data || []).map((row: any) => {
      const sign = getMovementSign(row.movement_type, Number(row.quantity || 0));
      return {
        id: row.id,
        date: row.created_at,
        transactionType: row.movement_type,
        reference: row.reference_number || '-',
        received: sign > 0 ? Number(row.quantity || 0) : 0,
        issued: sign < 0 ? Number(row.quantity || 0) : 0,
        balance: Number(row.balance_after || 0),
        batch: row.batch_number || '-',
        notes: row.notes || null,
        itemName: (row.inventory_items as any)?.name || null,
      };
    });

    return res.json({ rows });
  } catch (error: any) {
    console.error('Bin card report error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reports/expiry', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const mode = typeof req.query.mode === 'string' && req.query.mode === 'expired' ? 'expired' : 'near-expiry';
    const thresholdMonths = Math.max(1, Number(req.query.thresholdMonths || 6));
    const dateFrom = parseOptionalDateParam(req.query.dateFrom);
    const dateTo = parseOptionalDateParam(req.query.dateTo);
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : 'all';

    const { data, error } = await supabaseAdmin
      .from('stock_movements')
      .select(`
        inventory_item_id,
        movement_type,
        quantity,
        batch_number,
        expiry_date,
        unit_cost,
        inventory_items:inventory_item_id (name, category, unit_cost)
      `)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .not('expiry_date', 'is', null);
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const grouped = new Map<string, any>();
    (data || []).forEach((row: any) => {
      const item = row.inventory_items as any;
      if (category && category !== 'all' && item?.category !== category) return;
      const key = `${row.inventory_item_id}::${row.batch_number || ''}::${row.expiry_date}`;
      const sign = getMovementSign(row.movement_type, Number(row.quantity || 0));
      const current = grouped.get(key) || {
        inventory_item_id: row.inventory_item_id,
        item: item?.name || 'Unknown',
        category: item?.category || 'Uncategorized',
        batch: row.batch_number || '-',
        expiryDate: row.expiry_date,
        quantity: 0,
        unitCost: Number(row.unit_cost ?? item?.unit_cost ?? 0),
      };
      current.quantity += sign;
      if (Number(row.unit_cost ?? 0) > 0) {
        current.unitCost = Number(row.unit_cost);
      }
      grouped.set(key, current);
    });

    const today = new Date();
    const thresholdDate = addMonthsUtc(today, thresholdMonths);
    const rows = Array.from(grouped.values())
      .filter((row: any) => Number(row.quantity || 0) > 0 && row.expiryDate)
      .filter((row: any) => {
        const expiry = new Date(row.expiryDate);
        if (Number.isNaN(expiry.getTime())) return false;
        if (mode === 'expired') {
          if (expiry >= today) return false;
          if (dateFrom && expiry < new Date(dateFrom)) return false;
          if (dateTo && expiry > new Date(dateTo)) return false;
          return true;
        }
        return expiry >= today && expiry <= thresholdDate;
      })
      .sort((a: any, b: any) => String(a.expiryDate).localeCompare(String(b.expiryDate)))
      .map((row: any) => {
        const expiry = new Date(row.expiryDate);
        const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        return {
          ...row,
          value: Number((Number(row.quantity || 0) * Number(row.unitCost || 0)).toFixed(2)),
          daysUntilExpiry: diffDays,
          status: mode === 'expired' ? 'Expired' : 'Near Expiry',
        };
      });

    return res.json({ rows, mode, thresholdMonths });
  } catch (error: any) {
    console.error('Expiry report error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reports/financial/cost', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const dateFrom = parseOptionalDateParam(req.query.dateFrom) || addMonthsUtc(new Date(), -3).toISOString().slice(0, 10);
    const dateTo = parseOptionalDateParam(req.query.dateTo) || new Date().toISOString().slice(0, 10);

    const { data: stockRows, error: stockError } = await supabaseAdmin
      .from('current_stock')
      .select('inventory_item_id, current_quantity, tenant_id')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId);
    if (stockError) {
      return res.status(500).json({ error: stockError.message });
    }

    const inventoryIds = (stockRows || []).map((row: any) => row.inventory_item_id).filter(Boolean);
    let balanceValue = 0;
    if (inventoryIds.length > 0) {
      const { data: items, error: itemError } = await supabaseAdmin
        .from('inventory_items')
        .select('id, unit_cost')
        .eq('facility_id', actorFacilityId)
        .eq('tenant_id', actorTenantId)
        .in('id', inventoryIds);
      if (itemError) {
        return res.status(500).json({ error: itemError.message });
      }
      const itemCostMap = new Map<string, number>();
      (items || []).forEach((item: any) => itemCostMap.set(item.id, Number(item.unit_cost || 0)));
      balanceValue = (stockRows || []).reduce(
        (sum: number, row: any) => sum + Number(row.current_quantity || 0) * Number(itemCostMap.get(row.inventory_item_id) || 0),
        0
      );
    }

    const { data: movements, error: movementError } = await supabaseAdmin
      .from('stock_movements')
      .select('movement_type, quantity, unit_cost, created_at')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`);
    if (movementError) {
      return res.status(500).json({ error: movementError.message });
    }

    let receivedValue = 0;
    let issuedValue = 0;
    (movements || []).forEach((row: any) => {
      const quantity = Math.abs(Number(row.quantity || 0));
      const unitCost = Number(row.unit_cost || 0);
      const value = quantity * unitCost;
      const movementType = String(row.movement_type || '').toLowerCase();
      if (['receipt', 'return', 'transfer_in', 'adjustment'].includes(movementType)) {
        receivedValue += value;
      }
      if (['issue', 'out', 'transfer_out'].includes(movementType)) {
        issuedValue += value;
      }
    });

    return res.json({
      totalValue: Number((receivedValue + balanceValue).toFixed(2)),
      receivedValue: Number(receivedValue.toFixed(2)),
      issuedValue: Number(issuedValue.toFixed(2)),
      balanceValue: Number(balanceValue.toFixed(2)),
      dateFrom,
      dateTo,
    });
  } catch (error: any) {
    console.error('Cost report error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reports/financial/wastage', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const year = Number(req.query.year || new Date().getUTCFullYear());
    const dateFrom = `${year}-01-01`;
    const dateTo = `${year}-12-31`;

    const { data: movements, error } = await supabaseAdmin
      .from('stock_movements')
      .select('movement_type, quantity, unit_cost, created_at')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`);
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    let expiredValue = 0;
    let damagedValue = 0;
    let totalWastageValue = 0;
    let receivedBaseValue = 0;

    (movements || []).forEach((row: any) => {
      const quantity = Math.abs(Number(row.quantity || 0));
      const unitCost = Number(row.unit_cost || 0);
      const value = quantity * unitCost;
      const movementType = String(row.movement_type || '').toLowerCase();
      if (['receipt', 'return', 'transfer_in', 'adjustment'].includes(movementType)) {
        receivedBaseValue += value;
      }
      if (movementType === 'expired') expiredValue += value;
      if (movementType === 'damaged') damagedValue += value;
      if (['expired', 'damaged', 'loss'].includes(movementType)) totalWastageValue += value;
    });

    const wastageRate = receivedBaseValue > 0 ? (totalWastageValue / receivedBaseValue) * 100 : 0;
    return res.json({
      year,
      expiredValue: Number(expiredValue.toFixed(2)),
      damagedValue: Number(damagedValue.toFixed(2)),
      totalWastageValue: Number(totalWastageValue.toFixed(2)),
      wastageRate: Number(wastageRate.toFixed(2)),
    });
  } catch (error: any) {
    console.error('Wastage report error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reports/financial/activity', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const dateFrom = parseOptionalDateParam(req.query.dateFrom) || addMonthsUtc(new Date(), -1).toISOString().slice(0, 10);
    const dateTo = parseOptionalDateParam(req.query.dateTo) || new Date().toISOString().slice(0, 10);

    const { data, error } = await supabaseAdmin
      .from('stock_movements')
      .select('movement_type, quantity, created_at')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .gte('created_at', `${dateFrom}T00:00:00.000Z`)
      .lte('created_at', `${dateTo}T23:59:59.999Z`);
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    let totalReceived = 0;
    let totalIssued = 0;
    let totalLoss = 0;
    let adjustments = 0;

    (data || []).forEach((row: any) => {
      const quantity = Math.abs(Number(row.quantity || 0));
      const movementType = String(row.movement_type || '').toLowerCase();
      if (['receipt', 'return', 'transfer_in'].includes(movementType)) totalReceived += quantity;
      if (['issue', 'out', 'transfer_out'].includes(movementType)) totalIssued += quantity;
      if (['loss', 'expired', 'damaged'].includes(movementType)) totalLoss += quantity;
      if (movementType === 'adjustment') adjustments += quantity;
    });

    return res.json({
      dateFrom,
      dateTo,
      totalReceived,
      totalIssued,
      totalLoss,
      adjustments,
    });
  } catch (error: any) {
    console.error('Activity report error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reports/financial/consumption', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
    if (!actorFacilityId || !actorTenantId) {
      return res.status(403).json({ error: 'Missing facility or tenant context' });
    }

    const year = Number(req.query.year || new Date().getUTCFullYear());
    const unitId = typeof req.query.dispensing_unit_id === 'string' ? req.query.dispensing_unit_id : null;
    const yearStart = `${year}-01-01T00:00:00.000Z`;
    const yearEnd = `${year}-12-31T23:59:59.999Z`;

    let orderQuery = supabaseAdmin
      .from('issue_orders')
      .select('id, dispensing_unit_id, issued_at')
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .eq('status', 'issued')
      .gte('issued_at', yearStart)
      .lte('issued_at', yearEnd);
    if (unitId) {
      orderQuery = orderQuery.eq('dispensing_unit_id', unitId);
    }

    const { data: orders, error: orderError } = await orderQuery;
    if (orderError) {
      return res.status(500).json({ error: orderError.message });
    }
    const orderIds = (orders || []).map((order: any) => order.id);
    if (orderIds.length === 0) {
      return res.json({ year, rows: [] });
    }

    const issuedAtByOrder = new Map<string, string>();
    (orders || []).forEach((order: any) => issuedAtByOrder.set(order.id, order.issued_at));

    const { data: items, error: itemError } = await supabaseAdmin
      .from('issue_order_items')
      .select(`
        order_id,
        qty_issued,
        inventory_items:inventory_item_id (category)
      `)
      .in('order_id', orderIds);
    if (itemError) {
      return res.status(500).json({ error: itemError.message });
    }

    const rowsByCategory = new Map<string, any>();
    (items || []).forEach((item: any) => {
      const issuedAt = issuedAtByOrder.get(item.order_id);
      if (!issuedAt) return;
      const month = new Date(issuedAt).getUTCMonth();
      const category = (item.inventory_items as any)?.category || 'Uncategorized';
      const current = rowsByCategory.get(category) || {
        category,
        jan: 0,
        feb: 0,
        mar: 0,
        q1Total: 0,
        average: 0,
      };
      const quantity = Number(item.qty_issued || 0);
      if (month === 0) current.jan += quantity;
      if (month === 1) current.feb += quantity;
      if (month === 2) current.mar += quantity;
      current.q1Total = current.jan + current.feb + current.mar;
      current.average = Number((current.q1Total / 3).toFixed(2));
      rowsByCategory.set(category, current);
    });

    return res.json({
      year,
      rows: Array.from(rowsByCategory.values()).sort((a, b) => a.category.localeCompare(b.category)),
    });
  } catch (error: any) {
    console.error('Consumption report error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Alerts (Low stock, expiring) - can be part of stats or separate
// router.get('/alerts', inventoryController.getStockAlerts);

export default router;
