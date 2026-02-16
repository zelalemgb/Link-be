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
  quantity: z.coerce.number().min(0),
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
    quantity: z.coerce.number().min(0).optional(),
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
      quantity: z.coerce.number().min(0),
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
  return 500;
};

const sendContractError = (res: any, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

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
    const { data: effectiveRequestId, error: submitError } = await supabaseAdmin.rpc(
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
      return res.status(mapRpcErrorStatus(submitError.message)).json({ error: submitError.message });
    }

    return res.json({
      success: true,
      requestId: effectiveRequestId,
    });
  } catch (error: any) {
    console.error('Submit resupply request error:', error?.message || error);
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
      return res.status(mapRpcErrorStatus(receiveError.message)).json({ error: receiveError.message });
    }

    const result = (data || {}) as {
      invoice_id?: string;
      created?: boolean;
      repopulated?: boolean;
    };

    return res.json({
      success: true,
      invoiceId: result.invoice_id,
      created: Boolean(result.created),
      repopulated: Boolean(result.repopulated),
    });
  } catch (error: any) {
    console.error('Create receiving invoice from request error:', error?.message || error);
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

    return res.status(201).json({ invoice: data });
  } catch (error: any) {
    console.error('Create receiving invoice error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/receiving/invoices/:invoiceId', async (req, res) => {
  const parsed = receivingInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
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

    return res.json({ invoice: data });
  } catch (error: any) {
    console.error('Update receiving invoice error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/receiving/invoices/:invoiceId/items', async (req, res) => {
  const parsed = receivingInvoiceItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
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

    return res.status(201).json({ item: data });
  } catch (error: any) {
    console.error('Add receiving invoice item error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/receiving/items/:itemId', async (req, res) => {
  const parsed = receivingItemUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
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

    return res.json({ item: data });
  } catch (error: any) {
    console.error('Update receiving invoice item error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/receiving/items/:itemId', async (req, res) => {
  try {
    const { actorFacilityId, actorTenantId } = await resolveActorScope(req);
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

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Delete receiving invoice item error:', error?.message || error);
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

    const { data: existingItems, error: existingItemsError } = await supabaseAdmin
      .from('receiving_invoice_items')
      .select('id')
      .eq('invoice_id', invoiceId);
    if (existingItemsError) {
      return res.status(500).json({ error: existingItemsError.message });
    }
    const existingItemIds = new Set((existingItems || []).map((row: any) => row.id));
    for (const item of parsed.data.items) {
      if (item.id && !existingItemIds.has(item.id)) {
        return res.status(400).json({ error: `Invoice item ${item.id} does not belong to this invoice` });
      }
    }

    const rows = parsed.data.items.map((item) => ({
      id: item.id,
      invoice_id: invoiceId,
      tenant_id: actorTenantId,
      inventory_item_id: item.inventory_item_id,
      quantity: item.quantity,
      batch_no: item.batch_no,
      expiry_date: item.expiry_date || null,
      unit_cost: item.unit_cost,
      unit_selling_price: item.unit_selling_price ?? null,
    }));
    if (rows.length > 0) {
      const { error: upsertError } = await supabaseAdmin
        .from('receiving_invoice_items')
        .upsert(rows, { onConflict: 'id' });
      if (upsertError) {
        return res.status(500).json({ error: upsertError.message });
      }
    }

    for (const item of rows) {
      if ((item.quantity || 0) <= 0) continue;

      const { data: lastMove } = await supabaseAdmin
        .from('stock_movements')
        .select('balance_after')
        .eq('inventory_item_id', item.inventory_item_id)
        .eq('facility_id', actorFacilityId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const currentBalance = Number(lastMove?.balance_after || 0);
      const newBalance = currentBalance + Number(item.quantity || 0);
      const { error: movementError } = await supabaseAdmin
        .from('stock_movements')
        .insert({
          inventory_item_id: item.inventory_item_id,
          facility_id: actorFacilityId,
          tenant_id: actorTenantId,
          movement_type: 'receipt',
          quantity: item.quantity,
          balance_after: newBalance,
          batch_number: item.batch_no,
          expiry_date: item.expiry_date,
          unit_cost: item.unit_cost,
          created_by: actorProfileId,
          reference_number: `INV-${invoice.invoice_no || 'REF'}`,
          notes: 'Received via Receiving (GRN)',
        });
      if (movementError) {
        return res.status(500).json({ error: movementError.message });
      }
    }

    const submittedAt = new Date().toISOString();
    const { error: statusError } = await supabaseAdmin
      .from('receiving_invoices')
      .update({
        status: 'submitted',
        submitted_at: submittedAt,
        updated_at: submittedAt,
      })
      .eq('id', invoiceId)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId);
    if (statusError) {
      return res.status(500).json({ error: statusError.message });
    }

    let requestClosed = false;
    if (invoice.request_id) {
      const { data: allItems, error: allItemsError } = await supabaseAdmin
        .from('receiving_invoice_items')
        .select('inventory_item_id, quantity, requested_quantity, receiving_invoices!inner(status)')
        .eq('receiving_invoices.request_id', invoice.request_id)
        .eq('receiving_invoices.status', 'submitted');
      if (allItemsError) {
        return res.status(500).json({ error: allItemsError.message });
      }

      const totals: Record<string, { received: number; requested: number }> = {};
      (allItems || []).forEach((row: any) => {
        if (!totals[row.inventory_item_id]) {
          totals[row.inventory_item_id] = {
            received: 0,
            requested: Number(row.requested_quantity || 0),
          };
        }
        totals[row.inventory_item_id].received += Number(row.quantity || 0);
      });

      const hasTotals = Object.keys(totals).length > 0;
      requestClosed = hasTotals && Object.values(totals).every((total) => total.received >= total.requested);
      if (requestClosed) {
        const { error: closeRequestError } = await supabaseAdmin
          .from('request_for_resupply')
          .update({ status: 'fulfilled', updated_at: submittedAt })
          .eq('id', invoice.request_id)
          .eq('facility_id', actorFacilityId)
          .eq('tenant_id', actorTenantId);
        if (closeRequestError) {
          return res.status(500).json({ error: closeRequestError.message });
        }
      }
    }

    return res.json({ success: true, requestClosed });
  } catch (error: any) {
    console.error('Finalize receiving invoice error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Alerts (Low stock, expiring) - can be part of stats or separate
// router.get('/alerts', inventoryController.getStockAlerts);

export default router;
