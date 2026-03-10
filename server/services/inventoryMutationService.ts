import { supabaseAdmin } from '../config/supabase.js';
import { isAuditDurabilityError, recordAuditEvent } from './audit-log';

export type InventoryContractErrorCode =
  | `AUTH_${string}`
  | `PERM_${string}`
  | `TENANT_${string}`
  | `VALIDATION_${string}`
  | `CONFLICT_${string}`;

export type InventoryMutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: InventoryContractErrorCode; message: string };

type InventoryMutationFailure = {
  ok: false;
  status: number;
  code: InventoryContractErrorCode;
  message: string;
};

export type InventoryMutationActor = {
  authUserId?: string;
  profileId?: string;
  tenantId?: string;
  facilityId?: string;
  role?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
};

export type IssueOrderMutationPayload = {
  period: string;
  dispensing_unit_id?: string | null;
  notes?: string | null;
};

export type IssueOrderItemMutationPayload = {
  inventory_item_id: string;
  beginning_balance: number;
  qty_received: number;
  loss?: number;
  adjustment?: number;
  qty_requested: number;
  qty_issued: number;
  batch_no?: string | null;
};

export type LossAdjustmentMutationPayload = {
  inventory_item_id: string;
  batch_no?: string | null;
  reason: string;
  quantity: number;
  soh?: number | null;
  notes?: string | null;
};

const inventoryMutationRoles = new Set([
  'logistic_officer',
  'pharmacist',
  'admin',
  'clinic_admin',
  'super_admin',
]);

const allowedLossAdjustmentReasons = new Set([
  'expired',
  'damage',
  'damaged',
  'theft',
  'loss',
  'positive_adjustment',
  'negative_adjustment',
  'stock_count_correction',
  'reconciliation',
  'other',
]);

const subtractiveLossReasons = new Set([
  'expired',
  'damage',
  'damaged',
  'theft',
  'loss',
  'negative_adjustment',
  'stock_count_correction',
  'reconciliation',
  'other',
]);

const computeIssueOrderEndingBalance = (payload: IssueOrderItemMutationPayload) =>
  Number(payload.beginning_balance || 0) +
  Number(payload.qty_received || 0) -
  Number(payload.loss || 0) +
  Number(payload.adjustment || 0) -
  Number(payload.qty_issued || 0);

const error = <T>(
  status: number,
  code: InventoryContractErrorCode,
  message: string
): InventoryMutationFailure => ({
  ok: false,
  status,
  code,
  message,
});

export const ensureInventoryMutationAccess = (
  actor: InventoryMutationActor
): { ok: true; data: Required<Pick<InventoryMutationActor, 'authUserId' | 'profileId' | 'tenantId' | 'facilityId' | 'role'>> & InventoryMutationActor } | InventoryMutationFailure => {
  const normalizedRole = (actor.role || '').trim().toLowerCase();
  if (!actor.authUserId) {
    return error(401, 'AUTH_MISSING_USER_CONTEXT', 'Missing authenticated user context');
  }
  if (!actor.profileId || !actor.tenantId || !actor.facilityId) {
    return error(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing facility or tenant context');
  }
  if (!inventoryMutationRoles.has(normalizedRole)) {
    return error(403, 'PERM_INVENTORY_MUTATION_FORBIDDEN', 'You do not have permission to mutate inventory workflows');
  }

  return {
    ok: true,
    data: {
      ...actor,
      authUserId: actor.authUserId,
      profileId: actor.profileId,
      tenantId: actor.tenantId,
      facilityId: actor.facilityId,
      role: normalizedRole,
    },
  };
};

const getScopedIssueOrder = async (orderId: string) => {
  const { data, error: queryError } = await supabaseAdmin
    .from('issue_orders')
    .select('id, tenant_id, facility_id, status, voucher_no')
    .eq('id', orderId)
    .maybeSingle();
  if (queryError) {
    throw new Error(queryError.message);
  }
  return data as
    | {
        id: string;
        tenant_id: string;
        facility_id: string;
        status: string;
        voucher_no: string | null;
      }
    | null;
};

const assertIssueOrderScope = (
  order: {
    id: string;
    tenant_id: string;
    facility_id: string;
    status: string;
    voucher_no: string | null;
  } | null,
  actor: { tenantId: string; facilityId: string }
): InventoryMutationResult<{
  id: string;
  tenant_id: string;
  facility_id: string;
  status: string;
  voucher_no: string | null;
}> => {
  if (!order) {
    return error(404, 'VALIDATION_ISSUE_ORDER_NOT_FOUND', 'Issue order not found');
  }
  if (order.tenant_id !== actor.tenantId || order.facility_id !== actor.facilityId) {
    return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Issue order is outside your tenant scope');
  }
  return { ok: true, data: order };
};

const getScopedLossAdjustment = async (adjustmentId: string) => {
  const { data, error: queryError } = await supabaseAdmin
    .from('loss_adjustments')
    .select('id, tenant_id, facility_id, status, inventory_item_id, quantity, reason, batch_no, transaction_id')
    .eq('id', adjustmentId)
    .maybeSingle();
  if (queryError) {
    throw new Error(queryError.message);
  }
  return data as
    | {
        id: string;
        tenant_id: string;
        facility_id: string;
        status: string;
        inventory_item_id: string;
        quantity: number;
        reason: string;
        batch_no: string | null;
        transaction_id: string | null;
      }
    | null;
};

const assertLossAdjustmentScope = (
  adjustment: {
    id: string;
    tenant_id: string;
    facility_id: string;
    status: string;
    inventory_item_id: string;
    quantity: number;
    reason: string;
    batch_no: string | null;
    transaction_id: string | null;
  } | null,
  actor: { tenantId: string; facilityId: string }
): InventoryMutationResult<{
  id: string;
  tenant_id: string;
  facility_id: string;
  status: string;
  inventory_item_id: string;
  quantity: number;
  reason: string;
  batch_no: string | null;
  transaction_id: string | null;
}> => {
  if (!adjustment) {
    return error(404, 'VALIDATION_LOSS_ADJUSTMENT_NOT_FOUND', 'Loss adjustment not found');
  }
  if (adjustment.tenant_id !== actor.tenantId || adjustment.facility_id !== actor.facilityId) {
    return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Loss adjustment is outside your tenant scope');
  }
  return { ok: true, data: adjustment };
};

const validateInventoryItemScope = async ({
  inventoryItemId,
  tenantId,
  facilityId,
}: {
  inventoryItemId: string;
  tenantId: string;
  facilityId: string;
}): Promise<InventoryMutationResult<{ id: string }>> => {
  const { data: item, error: itemError } = await supabaseAdmin
    .from('inventory_items')
    .select('id, tenant_id, facility_id')
    .eq('id', inventoryItemId)
    .maybeSingle();

  if (itemError) {
    throw new Error(itemError.message);
  }
  if (!item) {
    return error(404, 'VALIDATION_INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found');
  }
  if (item.tenant_id !== tenantId || item.facility_id !== facilityId) {
    return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Inventory item is outside your tenant scope');
  }
  return { ok: true, data: { id: item.id } };
};

const validateDispensingUnitScope = async ({
  dispensingUnitId,
  tenantId,
  facilityId,
}: {
  dispensingUnitId: string | null | undefined;
  tenantId: string;
  facilityId: string;
}): Promise<InventoryMutationResult<null>> => {
  if (!dispensingUnitId) {
    return { ok: true, data: null };
  }

  const { data: unit, error: unitError } = await supabaseAdmin
    .from('dispensing_units')
    .select('id, tenant_id, facility_id')
    .eq('id', dispensingUnitId)
    .maybeSingle();
  if (unitError) {
    throw new Error(unitError.message);
  }
  if (!unit) {
    return error(404, 'VALIDATION_DISPENSING_UNIT_NOT_FOUND', 'Dispensing unit not found');
  }
  if (unit.tenant_id !== tenantId || unit.facility_id !== facilityId) {
    return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Dispensing unit is outside your tenant scope');
  }
  return { ok: true, data: null };
};

const buildIssueVoucherNo = (orderId: string) => {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `SIV-${day}-${orderId.slice(0, 8).toUpperCase()}`;
};

const mapDispatchRpcError = (message: string): InventoryMutationResult<never> => {
  const normalized = (message || '').toLowerCase();
  if (normalized.includes('not found')) {
    return error(404, 'VALIDATION_ISSUE_ORDER_NOT_FOUND', 'Issue order not found');
  }
  if (normalized.includes('outside your tenant scope')) {
    return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Issue order is outside your tenant scope');
  }
  if (normalized.includes('cannot be dispatched') || normalized.includes('only draft issue orders')) {
    return error(409, 'CONFLICT_ISSUE_ORDER_NOT_DISPATCHABLE', 'Only draft issue orders can be dispatched');
  }
  if (normalized.includes('no items to dispatch')) {
    return error(409, 'CONFLICT_ISSUE_ORDER_EMPTY', 'Issue order has no items to dispatch');
  }
  if (normalized.includes('positive issued quantity')) {
    return error(400, 'VALIDATION_NO_ISSUE_QUANTITY', 'At least one item must have a positive issued quantity');
  }
  if (normalized.includes('insufficient stock')) {
    return error(409, 'CONFLICT_INSUFFICIENT_STOCK', 'Insufficient stock to dispatch issue order');
  }
  return error(500, 'CONFLICT_ISSUE_ORDER_DISPATCH_FAILED', 'Failed to dispatch issue order');
};

const mapLossApprovalRpcError = (message: string): InventoryMutationResult<never> => {
  const normalized = (message || '').toLowerCase();
  if (normalized.includes('not found')) {
    return error(404, 'VALIDATION_LOSS_ADJUSTMENT_NOT_FOUND', 'Loss adjustment not found');
  }
  if (normalized.includes('outside your tenant scope')) {
    return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Loss adjustment is outside your tenant scope');
  }
  if (normalized.includes('cannot be approved') || normalized.includes('not approvable')) {
    return error(409, 'CONFLICT_LOSS_ADJUSTMENT_NOT_APPROVABLE', 'Loss adjustment cannot be approved from current status');
  }
  if (normalized.includes('quantity must be greater than zero')) {
    return error(400, 'VALIDATION_INVALID_QUANTITY', 'Loss adjustment quantity must be greater than zero');
  }
  if (normalized.includes('insufficient stock')) {
    return error(409, 'CONFLICT_INSUFFICIENT_STOCK', 'Insufficient stock to approve this adjustment');
  }
  return error(500, 'CONFLICT_LOSS_ADJUSTMENT_APPROVE_FAILED', 'Failed to approve loss adjustment');
};

export const createIssueOrder = async ({
  actor,
  payload,
}: {
  actor: InventoryMutationActor;
  payload: IssueOrderMutationPayload;
}): Promise<InventoryMutationResult<{ order: { id: string } }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const unitScope = await validateDispensingUnitScope({
      dispensingUnitId: payload.dispensing_unit_id || null,
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
    });
    if (unitScope.ok === false) return unitScope;

    let draftQuery = supabaseAdmin
      .from('issue_orders')
      .select('id')
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', scopedActor.facilityId)
      .eq('period', payload.period.trim())
      .eq('status', 'draft');

    if (payload.dispensing_unit_id) {
      draftQuery = draftQuery.eq('dispensing_unit_id', payload.dispensing_unit_id);
    } else {
      draftQuery = draftQuery.is('dispensing_unit_id', null);
    }

    const { data: duplicateDraft, error: duplicateError } = await draftQuery.limit(1).maybeSingle();
    if (duplicateError) {
      throw new Error(duplicateError.message);
    }
    if (duplicateDraft?.id) {
      return error(409, 'CONFLICT_DUPLICATE_DRAFT_ISSUE_ORDER', 'A draft issue order already exists for this period');
    }

    const { data: order, error: insertError } = await supabaseAdmin
      .from('issue_orders')
      .insert({
        period: payload.period.trim(),
        dispensing_unit_id: payload.dispensing_unit_id || null,
        notes: payload.notes || null,
        facility_id: scopedActor.facilityId,
        tenant_id: scopedActor.tenantId,
        created_by: scopedActor.profileId,
        status: 'draft',
      })
      .select('id')
      .single();

    if (insertError || !order) {
      if (insertError?.code === '23505') {
        return error(409, 'CONFLICT_DUPLICATE_DRAFT_ISSUE_ORDER', 'A draft issue order already exists for this period');
      }
      throw new Error(insertError?.message || 'Failed to create issue order');
    }

    await recordAuditEvent({
      action: 'create_issue_order',
      eventType: 'create',
      entityType: 'issue_order',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: order.id,
      actionCategory: 'inventory',
      metadata: {
        period: payload.period.trim(),
        dispensingUnitId: payload.dispensing_unit_id || null,
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.issue_order.create.write_failed',
      outboxAggregateType: 'issue_order',
      outboxAggregateId: order.id,
    });

    return { ok: true, data: { order: { id: order.id } } };
  } catch (serviceError: any) {
    console.error('createIssueOrder service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_ISSUE_ORDER_CREATE_FAILED', 'Failed to create issue order');
  }
};

export const updateIssueOrder = async ({
  actor,
  orderId,
  payload,
}: {
  actor: InventoryMutationActor;
  orderId: string;
  payload: IssueOrderMutationPayload;
}): Promise<InventoryMutationResult<{ order: { id: string } }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const existingOrder = await getScopedIssueOrder(orderId);
    const scopedOrder = assertIssueOrderScope(existingOrder, scopedActor);
    if (scopedOrder.ok === false) return scopedOrder;
    if (scopedOrder.data.status !== 'draft') {
      return error(409, 'CONFLICT_ISSUE_ORDER_NOT_EDITABLE', 'Only draft issue orders can be edited');
    }

    const unitScope = await validateDispensingUnitScope({
      dispensingUnitId: payload.dispensing_unit_id || null,
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
    });
    if (unitScope.ok === false) return unitScope;

    const { data: order, error: updateError } = await supabaseAdmin
      .from('issue_orders')
      .update({
        period: payload.period.trim(),
        dispensing_unit_id: payload.dispensing_unit_id || null,
        notes: payload.notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId)
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', scopedActor.facilityId)
      .select('id')
      .single();

    if (updateError || !order) {
      throw new Error(updateError?.message || 'Failed to update issue order');
    }

    await recordAuditEvent({
      action: 'update_issue_order',
      eventType: 'update',
      entityType: 'issue_order',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: order.id,
      actionCategory: 'inventory',
      metadata: {
        period: payload.period.trim(),
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.issue_order.update.write_failed',
      outboxAggregateType: 'issue_order',
      outboxAggregateId: orderId,
    });

    return { ok: true, data: { order: { id: order.id } } };
  } catch (serviceError: any) {
    console.error('updateIssueOrder service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_ISSUE_ORDER_UPDATE_FAILED', 'Failed to update issue order');
  }
};

export const addIssueOrderItem = async ({
  actor,
  orderId,
  payload,
}: {
  actor: InventoryMutationActor;
  orderId: string;
  payload: IssueOrderItemMutationPayload;
}): Promise<InventoryMutationResult<{ item: { id: string } }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const existingOrder = await getScopedIssueOrder(orderId);
    const scopedOrder = assertIssueOrderScope(existingOrder, scopedActor);
    if (scopedOrder.ok === false) return scopedOrder;
    if (scopedOrder.data.status !== 'draft') {
      return error(409, 'CONFLICT_ISSUE_ORDER_NOT_EDITABLE', 'Items can only be modified on draft issue orders');
    }

    const inventoryScope = await validateInventoryItemScope({
      inventoryItemId: payload.inventory_item_id,
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
    });
    if (inventoryScope.ok === false) return inventoryScope;

    const logicalBalance =
      Number(payload.beginning_balance || 0) +
      Number(payload.qty_received || 0) -
      Number(payload.loss || 0) +
      Number(payload.adjustment || 0);

    if (logicalBalance < 0) {
      return error(400, 'VALIDATION_NEGATIVE_ENDING_BALANCE', 'Ending balance must be non-negative');
    }

    if (Number(payload.qty_issued || 0) > logicalBalance) {
      return error(409, 'CONFLICT_QTY_ISSUED_EXCEEDS_BALANCE', 'Issued quantity exceeds the available balance');
    }

    const endingBalance = computeIssueOrderEndingBalance(payload);
    if (endingBalance < 0) {
      return error(400, 'VALIDATION_NEGATIVE_ENDING_BALANCE', 'Ending balance must be non-negative');
    }

    let duplicateQuery = supabaseAdmin
      .from('issue_order_items')
      .select('id')
      .eq('order_id', orderId)
      .eq('inventory_item_id', payload.inventory_item_id);

    if (payload.batch_no) {
      duplicateQuery = duplicateQuery.eq('batch_no', payload.batch_no);
    } else {
      duplicateQuery = duplicateQuery.is('batch_no', null);
    }

    const { data: duplicateItem, error: duplicateError } = await duplicateQuery.limit(1).maybeSingle();
    if (duplicateError) {
      throw new Error(duplicateError.message);
    }
    if (duplicateItem?.id) {
      return error(
        409,
        'CONFLICT_DUPLICATE_ISSUE_ORDER_ITEM',
        'Issue order already includes this inventory item and batch'
      );
    }

    const { data: item, error: insertError } = await supabaseAdmin
      .from('issue_order_items')
      .insert({
        order_id: orderId,
        inventory_item_id: payload.inventory_item_id,
        beginning_balance: payload.beginning_balance,
        qty_received: payload.qty_received,
        loss: payload.loss || 0,
        adjustment: payload.adjustment || 0,
        ending_balance: endingBalance,
        qty_requested: payload.qty_requested,
        qty_issued: payload.qty_issued,
        batch_no: payload.batch_no || null,
        soh: payload.beginning_balance,
      })
      .select('id')
      .single();

    if (insertError || !item) {
      if (insertError?.code === '23505') {
        return error(
          409,
          'CONFLICT_DUPLICATE_ISSUE_ORDER_ITEM',
          'Issue order already includes this inventory item and batch'
        );
      }
      throw new Error(insertError?.message || 'Failed to add issue order item');
    }

    await recordAuditEvent({
      action: 'add_issue_order_item',
      eventType: 'create',
      entityType: 'issue_order_item',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: item.id,
      actionCategory: 'inventory',
      metadata: {
        orderId,
        inventoryItemId: payload.inventory_item_id,
        qtyIssued: payload.qty_issued,
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.issue_order_item.create.write_failed',
      outboxAggregateType: 'issue_order_item',
      outboxAggregateId: item.id,
    });

    return { ok: true, data: { item: { id: item.id } } };
  } catch (serviceError: any) {
    console.error('addIssueOrderItem service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_ISSUE_ORDER_ITEM_CREATE_FAILED', 'Failed to add issue order item');
  }
};

export const deleteIssueOrderItem = async ({
  actor,
  itemId,
}: {
  actor: InventoryMutationActor;
  itemId: string;
}): Promise<InventoryMutationResult<{ success: boolean }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const { data: itemRow, error: itemLookupError } = await supabaseAdmin
      .from('issue_order_items')
      .select('id, order_id')
      .eq('id', itemId)
      .maybeSingle();
    if (itemLookupError) {
      throw new Error(itemLookupError.message);
    }
    if (!itemRow) {
      return error(404, 'VALIDATION_ISSUE_ORDER_ITEM_NOT_FOUND', 'Issue order item not found');
    }

    const existingOrder = await getScopedIssueOrder(itemRow.order_id);
    const scopedOrder = assertIssueOrderScope(existingOrder, scopedActor);
    if (scopedOrder.ok === false) return scopedOrder;
    if (scopedOrder.data.status !== 'draft') {
      return error(409, 'CONFLICT_ISSUE_ORDER_NOT_EDITABLE', 'Items can only be removed from draft issue orders');
    }

    const { error: deleteError } = await supabaseAdmin
      .from('issue_order_items')
      .delete()
      .eq('id', itemId)
      .eq('order_id', itemRow.order_id);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    await recordAuditEvent({
      action: 'delete_issue_order_item',
      eventType: 'delete',
      entityType: 'issue_order_item',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: itemId,
      actionCategory: 'inventory',
      metadata: {
        orderId: itemRow.order_id,
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.issue_order_item.delete.write_failed',
      outboxAggregateType: 'issue_order_item',
      outboxAggregateId: itemId,
    });

    return { ok: true, data: { success: true } };
  } catch (serviceError: any) {
    console.error('deleteIssueOrderItem service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_ISSUE_ORDER_ITEM_DELETE_FAILED', 'Failed to delete issue order item');
  }
};

export const dispatchIssueOrder = async ({
  actor,
  orderId,
}: {
  actor: InventoryMutationActor;
  orderId: string;
}): Promise<InventoryMutationResult<{ success: boolean; voucherNo?: string }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const fallbackVoucherNo = buildIssueVoucherNo(orderId);
    const { data: dispatchResult, error: dispatchError } = await supabaseAdmin.rpc(
      'backend_dispatch_issue_order',
      {
        p_actor_facility_id: scopedActor.facilityId,
        p_actor_tenant_id: scopedActor.tenantId,
        p_actor_profile_id: scopedActor.profileId,
        p_order_id: orderId,
      }
    );
    if (dispatchError) {
      return mapDispatchRpcError(dispatchError.message);
    }

    const rpcResult = (dispatchResult || {}) as {
      success?: boolean;
      voucher_no?: string | null;
      voucherNo?: string | null;
      already_dispatched?: boolean;
      alreadyDispatched?: boolean;
      dispatched_item_count?: number;
      dispatchedItemCount?: number;
    };

    const voucherNo = rpcResult.voucher_no || rpcResult.voucherNo || fallbackVoucherNo;
    const alreadyDispatched = Boolean(rpcResult.already_dispatched ?? rpcResult.alreadyDispatched);
    const dispatchedItemCount = Number(rpcResult.dispatched_item_count ?? rpcResult.dispatchedItemCount ?? 0);

    await recordAuditEvent({
      action: 'dispatch_issue_order',
      eventType: 'update',
      entityType: 'issue_order',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: orderId,
      actionCategory: 'inventory',
      metadata: {
        voucherNo,
        dispatchedItemCount,
        idempotentReplay: alreadyDispatched,
        transactionalPath: 'backend_dispatch_issue_order',
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.issue_order.dispatch.write_failed',
      outboxAggregateType: 'issue_order',
      outboxAggregateId: orderId,
    });

    return {
      ok: true,
      data: {
        success: true,
        voucherNo,
      },
    };
  } catch (serviceError: any) {
    console.error('dispatchIssueOrder service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_ISSUE_ORDER_DISPATCH_FAILED', 'Failed to dispatch issue order');
  }
};

export const createLossAdjustment = async ({
  actor,
  payload,
}: {
  actor: InventoryMutationActor;
  payload: LossAdjustmentMutationPayload;
}): Promise<InventoryMutationResult<{ adjustment: { id: string } }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const normalizedReason = payload.reason.trim().toLowerCase();
    if (!allowedLossAdjustmentReasons.has(normalizedReason)) {
      return error(400, 'VALIDATION_INVALID_LOSS_REASON', 'Invalid loss adjustment reason');
    }

    const inventoryScope = await validateInventoryItemScope({
      inventoryItemId: payload.inventory_item_id,
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
    });
    if (inventoryScope.ok === false) return inventoryScope;

    if (Number(payload.quantity || 0) <= 0) {
      return error(400, 'VALIDATION_INVALID_QUANTITY', 'Quantity must be greater than zero');
    }

    let duplicateQuery = supabaseAdmin
      .from('loss_adjustments')
      .select('id')
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', scopedActor.facilityId)
      .eq('inventory_item_id', payload.inventory_item_id)
      .eq('reason', normalizedReason)
      .eq('quantity', payload.quantity)
      .eq('status', 'draft');

    if (payload.batch_no) {
      duplicateQuery = duplicateQuery.eq('batch_no', payload.batch_no);
    } else {
      duplicateQuery = duplicateQuery.is('batch_no', null);
    }

    const { data: duplicate, error: duplicateError } = await duplicateQuery.limit(1).maybeSingle();
    if (duplicateError) {
      throw new Error(duplicateError.message);
    }
    if (duplicate?.id) {
      return error(409, 'CONFLICT_DUPLICATE_LOSS_ADJUSTMENT', 'A matching draft loss adjustment already exists');
    }

    const transactionId = `LA-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const { data: adjustment, error: insertError } = await supabaseAdmin
      .from('loss_adjustments')
      .insert({
        transaction_id: transactionId,
        inventory_item_id: payload.inventory_item_id,
        batch_no: payload.batch_no || null,
        reason: normalizedReason,
        quantity: payload.quantity,
        soh: payload.soh ?? null,
        notes: payload.notes || null,
        facility_id: scopedActor.facilityId,
        tenant_id: scopedActor.tenantId,
        created_by: scopedActor.profileId,
        status: 'draft',
      })
      .select('id')
      .single();
    if (insertError || !adjustment) {
      if (insertError?.code === '23505') {
        return error(409, 'CONFLICT_DUPLICATE_LOSS_ADJUSTMENT', 'A matching draft loss adjustment already exists');
      }
      throw new Error(insertError?.message || 'Failed to create loss adjustment');
    }

    await recordAuditEvent({
      action: 'create_loss_adjustment',
      eventType: 'create',
      entityType: 'loss_adjustment',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: adjustment.id,
      actionCategory: 'inventory',
      metadata: {
        transactionId,
        reason: normalizedReason,
        quantity: payload.quantity,
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.loss_adjustment.create.write_failed',
      outboxAggregateType: 'loss_adjustment',
      outboxAggregateId: adjustment.id,
    });

    return { ok: true, data: { adjustment: { id: adjustment.id } } };
  } catch (serviceError: any) {
    console.error('createLossAdjustment service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_LOSS_ADJUSTMENT_CREATE_FAILED', 'Failed to create loss adjustment');
  }
};

export const updateLossAdjustment = async ({
  actor,
  adjustmentId,
  payload,
}: {
  actor: InventoryMutationActor;
  adjustmentId: string;
  payload: LossAdjustmentMutationPayload;
}): Promise<InventoryMutationResult<{ adjustment: { id: string } }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const normalizedReason = payload.reason.trim().toLowerCase();
    if (!allowedLossAdjustmentReasons.has(normalizedReason)) {
      return error(400, 'VALIDATION_INVALID_LOSS_REASON', 'Invalid loss adjustment reason');
    }
    if (Number(payload.quantity || 0) <= 0) {
      return error(400, 'VALIDATION_INVALID_QUANTITY', 'Quantity must be greater than zero');
    }

    const existingAdjustment = await getScopedLossAdjustment(adjustmentId);
    const scopedAdjustment = assertLossAdjustmentScope(existingAdjustment, scopedActor);
    if (scopedAdjustment.ok === false) return scopedAdjustment;
    if (scopedAdjustment.data.status !== 'draft') {
      return error(409, 'CONFLICT_LOSS_ADJUSTMENT_NOT_EDITABLE', 'Only draft loss adjustments can be edited');
    }

    const inventoryScope = await validateInventoryItemScope({
      inventoryItemId: payload.inventory_item_id,
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
    });
    if (inventoryScope.ok === false) return inventoryScope;

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('loss_adjustments')
      .update({
        inventory_item_id: payload.inventory_item_id,
        batch_no: payload.batch_no || null,
        reason: normalizedReason,
        quantity: payload.quantity,
        soh: payload.soh ?? null,
        notes: payload.notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', adjustmentId)
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', scopedActor.facilityId)
      .select('id')
      .single();
    if (updateError || !updated) {
      throw new Error(updateError?.message || 'Failed to update loss adjustment');
    }

    await recordAuditEvent({
      action: 'update_loss_adjustment',
      eventType: 'update',
      entityType: 'loss_adjustment',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: updated.id,
      actionCategory: 'inventory',
      metadata: {
        reason: normalizedReason,
        quantity: payload.quantity,
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.loss_adjustment.update.write_failed',
      outboxAggregateType: 'loss_adjustment',
      outboxAggregateId: adjustmentId,
    });

    return { ok: true, data: { adjustment: { id: updated.id } } };
  } catch (serviceError: any) {
    console.error('updateLossAdjustment service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_LOSS_ADJUSTMENT_UPDATE_FAILED', 'Failed to update loss adjustment');
  }
};

export const approveLossAdjustment = async ({
  actor,
  adjustmentId,
}: {
  actor: InventoryMutationActor;
  adjustmentId: string;
}): Promise<InventoryMutationResult<{ success: boolean }>> => {
  try {
    const actorResult = ensureInventoryMutationAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const { data: approvalResult, error: approvalError } = await supabaseAdmin.rpc(
      'backend_approve_loss_adjustment',
      {
        p_actor_facility_id: scopedActor.facilityId,
        p_actor_tenant_id: scopedActor.tenantId,
        p_actor_profile_id: scopedActor.profileId,
        p_adjustment_id: adjustmentId,
      }
    );
    if (approvalError) {
      return mapLossApprovalRpcError(approvalError.message);
    }

    const rpcResult = (approvalResult || {}) as {
      success?: boolean;
      already_approved?: boolean;
      alreadyApproved?: boolean;
      movement_type?: string | null;
      movementType?: string | null;
      resulting_balance?: number | null;
      resultingBalance?: number | null;
      reason?: string | null;
      quantity?: number | null;
    };

    const alreadyApproved = Boolean(rpcResult.already_approved ?? rpcResult.alreadyApproved);
    const movementType = rpcResult.movement_type || rpcResult.movementType || null;
    const resultingBalance = rpcResult.resulting_balance ?? rpcResult.resultingBalance ?? null;
    const quantity = Number(rpcResult.quantity ?? 0);
    const adjustmentReason = rpcResult.reason || null;

    await recordAuditEvent({
      action: 'approve_loss_adjustment',
      eventType: 'update',
      entityType: 'loss_adjustment',
      tenantId: scopedActor.tenantId,
      facilityId: scopedActor.facilityId,
      actorUserId: scopedActor.profileId,
      actorRole: scopedActor.role,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      entityId: adjustmentId,
      actionCategory: 'inventory',
      metadata: {
        reason: adjustmentReason,
        quantity,
        movementType,
        resultingBalance,
        idempotentReplay: alreadyApproved,
        transactionalPath: 'backend_approve_loss_adjustment',
      },
      requestId: scopedActor.requestId || null,
    }, {
      strict: true,
      outboxEventType: 'audit.inventory.loss_adjustment.approve.write_failed',
      outboxAggregateType: 'loss_adjustment',
      outboxAggregateId: adjustmentId,
    });

    return { ok: true, data: { success: true } };
  } catch (serviceError: any) {
    console.error('approveLossAdjustment service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_LOSS_ADJUSTMENT_APPROVE_FAILED', 'Failed to approve loss adjustment');
  }
};
