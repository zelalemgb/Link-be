import { supabaseAdmin } from '../config/supabase.js';

const resupplyRequestTable = 'request_for_resupply';
const resupplyLineTable = 'request_line_items';
const receivingInvoiceTable = 'receiving_invoices';
const receivingInvoiceItemTable = 'receiving_invoice_items';
const issueOrderTable = 'issue_orders';
const issueOrderItemTable = 'issue_order_items';
const stockMovementTable = 'stock_movements';
const physicalInventorySessionTable = 'physical_inventory_sessions';
const physicalInventorySessionItemTable = 'physical_inventory_session_items';

const buildResupplyReferenceNo = () => {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const stamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 90 + 10);
  return `RRF-${day}-${stamp}${random}`;
};

export const buildIssueVoucherNo = (orderId: string) => {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `SIV-${day}-${orderId.slice(0, 8).toUpperCase()}`;
};

export const isMissingRpcFunctionError = (message?: string | null) => {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('could not find the function') ||
    normalized.includes('schema cache') ||
    normalized.includes('function public.') && normalized.includes('does not exist') ||
    normalized.includes('function not found')
  );
};

const isMissingColumnError = (message: string | undefined, column: string) => {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes(column.toLowerCase()) &&
    (normalized.includes('does not exist') || normalized.includes('schema cache') || normalized.includes('could not find'))
  );
};

const ensureScopedActor = (actorFacilityId?: string | null, actorTenantId?: string | null, actorProfileId?: string | null) => {
  if (!actorFacilityId || !actorTenantId || !actorProfileId) {
    throw new Error('Missing facility or tenant context');
  }
};

const roundMoney = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(2));
};

const loadInventoryItemScope = async ({
  inventoryItemId,
  facilityId,
  tenantId,
}: {
  inventoryItemId: string;
  facilityId: string;
  tenantId: string;
}) => {
  const { data, error } = await supabaseAdmin
    .from('inventory_items')
    .select('id, facility_id, tenant_id, unit_cost')
    .eq('id', inventoryItemId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data || data.facility_id !== facilityId || data.tenant_id !== tenantId) {
    throw new Error('Inventory item not found in your facility');
  }
  return data;
};

const assertInventoryItemsInScope = async ({
  inventoryItemIds,
  facilityId,
  tenantId,
}: {
  inventoryItemIds: string[];
  facilityId: string;
  tenantId: string;
}) => {
  const uniqueIds = [...new Set(inventoryItemIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    throw new Error('At least one line item is required');
  }

  const { data, error } = await supabaseAdmin
    .from('inventory_items')
    .select('id')
    .eq('facility_id', facilityId)
    .eq('tenant_id', tenantId)
    .in('id', uniqueIds);

  if (error) {
    throw new Error(error.message);
  }

  if ((data || []).length !== uniqueIds.length) {
    throw new Error('Inventory item not found in your facility');
  }
};

const getCurrentStockQuantity = async ({
  inventoryItemId,
  facilityId,
  tenantId,
}: {
  inventoryItemId: string;
  facilityId: string;
  tenantId: string;
}) => {
  const { data, error } = await supabaseAdmin
    .from('current_stock')
    .select('current_quantity')
    .eq('inventory_item_id', inventoryItemId)
    .eq('facility_id', facilityId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Number(data?.current_quantity || 0);
};

const resolveStockMovementDirection = ({
  movementType,
  quantity,
  adjustmentDirection,
}: {
  movementType: string;
  quantity: number;
  adjustmentDirection?: string | null;
}) => {
  const normalized = String(movementType || '').trim().toLowerCase();
  const absoluteQuantity = Math.abs(Number(quantity || 0));

  if (absoluteQuantity <= 0) {
    throw new Error('Quantity must be greater than zero');
  }

  if (['receipt', 'return', 'transfer_in'].includes(normalized)) {
    return { movementType: normalized, delta: absoluteQuantity, storedQuantity: absoluteQuantity };
  }

  if (['issue', 'out', 'transfer_out', 'expired', 'damaged', 'loss'].includes(normalized)) {
    return { movementType: normalized, delta: -absoluteQuantity, storedQuantity: absoluteQuantity };
  }

  if (normalized === 'adjustment') {
    const normalizedDirection = String(adjustmentDirection || '').trim().toLowerCase();
    if (!['increase', 'decrease'].includes(normalizedDirection)) {
      throw new Error('Adjustment direction is required for adjustment movements');
    }
    const signedQuantity = normalizedDirection === 'increase' ? absoluteQuantity : -absoluteQuantity;
    return { movementType: normalized, delta: signedQuantity, storedQuantity: signedQuantity };
  }

  throw new Error('Unsupported movement type');
};

export const createStockMovementFallback = async ({
  actorFacilityId,
  actorTenantId,
  actorProfileId,
  inventoryItemId,
  movementType,
  quantity,
  batchNumber,
  expiryDate,
  notes,
  unitCost,
  referenceNumber,
  adjustmentDirection,
}: {
  actorFacilityId: string;
  actorTenantId: string;
  actorProfileId: string;
  inventoryItemId: string;
  movementType: string;
  quantity: number;
  batchNumber?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  unitCost?: number | null;
  referenceNumber?: string | null;
  adjustmentDirection?: string | null;
}) => {
  ensureScopedActor(actorFacilityId, actorTenantId, actorProfileId);

  const inventoryItem = await loadInventoryItemScope({
    inventoryItemId,
    facilityId: actorFacilityId,
    tenantId: actorTenantId,
  });

  const movement = resolveStockMovementDirection({
    movementType,
    quantity,
    adjustmentDirection,
  });

  const currentQuantity = await getCurrentStockQuantity({
    inventoryItemId,
    facilityId: actorFacilityId,
    tenantId: actorTenantId,
  });
  const newBalance = currentQuantity + movement.delta;

  if (newBalance < 0) {
    throw new Error('Insufficient stock');
  }

  const effectiveUnitCost =
    unitCost !== null && unitCost !== undefined
      ? Number(unitCost)
      : Number(inventoryItem.unit_cost || 0);
  const storedQuantity = Number(movement.storedQuantity);
  const absoluteQuantity = Math.abs(storedQuantity);

  const { data, error } = await supabaseAdmin
    .from(stockMovementTable)
    .insert({
      inventory_item_id: inventoryItemId,
      facility_id: actorFacilityId,
      tenant_id: actorTenantId,
      movement_type: movement.movementType,
      quantity: storedQuantity,
      balance_after: newBalance,
      batch_number: batchNumber || null,
      expiry_date: expiryDate || null,
      unit_cost: roundMoney(effectiveUnitCost),
      total_cost: roundMoney(effectiveUnitCost * absoluteQuantity),
      created_by: actorProfileId,
      reference_number: referenceNumber || null,
      notes: notes || null,
    })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Failed to create stock movement');
  }

  return data;
};

export const submitResupplyRequestFallback = async ({
  actorFacilityId,
  actorTenantId,
  actorProfileId,
  requestId,
  requestDetails,
  lines,
}: {
  actorFacilityId: string;
  actorTenantId: string;
  actorProfileId: string;
  requestId?: string | null;
  requestDetails: {
    reporting_period: string;
    account_type: string;
    request_type: string;
    request_to: string;
    notes?: string | null;
  };
  lines: Array<{
    inventory_item_id: string;
    quantity_requested: number;
    amc?: number;
    soh?: number;
    unit_cost?: number;
  }>;
}) => {
  ensureScopedActor(actorFacilityId, actorTenantId, actorProfileId);

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('At least one line item is required');
  }

  const reportingPeriod = String(requestDetails.reporting_period || '').trim();
  const accountType = String(requestDetails.account_type || '').trim();
  const requestType = String(requestDetails.request_type || '').trim();
  const requestTo = String(requestDetails.request_to || '').trim();
  const notes = String(requestDetails.notes || '').trim() || null;

  if (!reportingPeriod || !accountType || !requestType || !requestTo) {
    throw new Error('Invalid request details');
  }

  await assertInventoryItemsInScope({
    inventoryItemIds: lines.map((line) => line.inventory_item_id),
    facilityId: actorFacilityId,
    tenantId: actorTenantId,
  });

  let effectiveRequestId = requestId || null;

  if (effectiveRequestId) {
    const { data: existingRequest, error: existingRequestError } = await supabaseAdmin
      .from(resupplyRequestTable)
      .select('id, facility_id, tenant_id')
      .eq('id', effectiveRequestId)
      .maybeSingle();

    if (existingRequestError) {
      throw new Error(existingRequestError.message);
    }
    if (!existingRequest) {
      throw new Error('Request not found');
    }
    if (existingRequest.facility_id !== actorFacilityId || existingRequest.tenant_id !== actorTenantId) {
      throw new Error('Request is outside your facility');
    }

    const { error: updateError } = await supabaseAdmin
      .from(resupplyRequestTable)
      .update({
        reporting_period: reportingPeriod,
        account_type: accountType,
        request_type: requestType,
        request_to: requestTo,
        notes,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', effectiveRequestId)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId);

    if (updateError) {
      throw new Error(updateError.message);
    }
  } else {
    const { data: insertedRequest, error: insertError } = await supabaseAdmin
      .from(resupplyRequestTable)
      .insert({
        reference_no: buildResupplyReferenceNo(),
        facility_id: actorFacilityId,
        tenant_id: actorTenantId,
        reporting_period: reportingPeriod,
        account_type: accountType,
        request_type: requestType,
        request_to: requestTo,
        generated_by: actorProfileId,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        notes,
      })
      .select('id')
      .single();

    if (insertError || !insertedRequest?.id) {
      throw new Error(insertError?.message || 'Failed to create resupply request');
    }
    effectiveRequestId = insertedRequest.id;
  }

  const { error: deleteLinesError } = await supabaseAdmin
    .from(resupplyLineTable)
    .delete()
    .eq('request_id', effectiveRequestId);

  if (deleteLinesError) {
    throw new Error(deleteLinesError.message);
  }

  const normalizedLines = lines.map((line) => ({
    request_id: effectiveRequestId,
    inventory_item_id: line.inventory_item_id,
    tenant_id: actorTenantId,
    quantity_requested: Math.max(1, Math.round(Number(line.quantity_requested || 0))),
    amc: Math.max(0, Math.round(Number(line.amc || 0))),
    soh: Math.max(0, Math.round(Number(line.soh || 0))),
    max_stock: 0,
    unit_cost: roundMoney(Number(line.unit_cost || 0)),
    total_cost: roundMoney(Math.max(1, Math.round(Number(line.quantity_requested || 0))) * Number(line.unit_cost || 0)),
  }));

  const { error: insertLinesError } = await supabaseAdmin
    .from(resupplyLineTable)
    .insert(normalizedLines);

  if (insertLinesError) {
    throw new Error(insertLinesError.message);
  }

  return effectiveRequestId;
};

export const createReceivingFromRequestFallback = async ({
  actorFacilityId,
  actorTenantId,
  actorProfileId,
  requestId,
}: {
  actorFacilityId: string;
  actorTenantId: string;
  actorProfileId: string;
  requestId: string;
}) => {
  ensureScopedActor(actorFacilityId, actorTenantId, actorProfileId);

  const { data: requestRow, error: requestError } = await supabaseAdmin
    .from(resupplyRequestTable)
    .select('id, reference_no, facility_id, tenant_id')
    .eq('id', requestId)
    .maybeSingle();

  if (requestError) {
    throw new Error(requestError.message);
  }
  if (!requestRow) {
    throw new Error('Request not found');
  }
  if (requestRow.facility_id !== actorFacilityId || requestRow.tenant_id !== actorTenantId) {
    throw new Error('Cannot receive requests outside your facility');
  }

  const { data: requestLines, error: requestLinesError } = await supabaseAdmin
    .from(resupplyLineTable)
    .select('inventory_item_id, quantity_requested, unit_cost')
    .eq('request_id', requestId);

  if (requestLinesError) {
    throw new Error(requestLinesError.message);
  }
  if (!requestLines || requestLines.length === 0) {
    throw new Error('Request has no line items');
  }

  const invoiceNo = `INV-${requestRow.reference_no}`;
  const { data: existingInvoice, error: existingInvoiceError } = await supabaseAdmin
    .from(receivingInvoiceTable)
    .select('id')
    .eq('facility_id', actorFacilityId)
    .eq('tenant_id', actorTenantId)
    .eq('invoice_no', invoiceNo)
    .maybeSingle();

  if (existingInvoiceError) {
    throw new Error(existingInvoiceError.message);
  }

  let invoiceId = existingInvoice?.id || null;
  let created = false;
  let repopulated = false;

  if (!invoiceId) {
    const { data: createdInvoice, error: createInvoiceError } = await supabaseAdmin
      .from(receivingInvoiceTable)
      .insert({
        invoice_no: invoiceNo,
        receive_date: new Date().toISOString().slice(0, 10),
        receive_type: 'transfer',
        supplier_id: null,
        delivery_note_no: '',
        goods_receiving_note_no: '',
        notes: `Received from Request ${requestRow.reference_no}`,
        facility_id: actorFacilityId,
        tenant_id: actorTenantId,
        created_by: actorProfileId,
        status: 'draft',
        request_id: requestId,
      })
      .select('id')
      .single();

    if (createInvoiceError || !createdInvoice?.id) {
      throw new Error(createInvoiceError?.message || 'Failed to create receiving invoice');
    }

    invoiceId = createdInvoice.id;
    created = true;
  }

  const { data: invoiceItems, error: invoiceItemsError } = await supabaseAdmin
    .from(receivingInvoiceItemTable)
    .select('id')
    .eq('invoice_id', invoiceId);

  if (invoiceItemsError) {
    throw new Error(invoiceItemsError.message);
  }

  const currentItemCount = (invoiceItems || []).length;

  if (created || currentItemCount === 0) {
    let historicalReceivedByItem = new Map<string, number>();

    const { data: submittedInvoices, error: submittedInvoicesError } = await supabaseAdmin
      .from(receivingInvoiceTable)
      .select('id')
      .eq('request_id', requestId)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .eq('status', 'submitted');

    if (submittedInvoicesError) {
      throw new Error(submittedInvoicesError.message);
    }

    const submittedInvoiceIds = (submittedInvoices || []).map((row) => row.id).filter(Boolean);
    if (submittedInvoiceIds.length > 0) {
      const { data: submittedInvoiceItems, error: submittedInvoiceItemsError } = await supabaseAdmin
        .from(receivingInvoiceItemTable)
        .select('inventory_item_id, quantity')
        .in('invoice_id', submittedInvoiceIds);

      if (submittedInvoiceItemsError) {
        throw new Error(submittedInvoiceItemsError.message);
      }

      historicalReceivedByItem = new Map<string, number>();
      for (const row of submittedInvoiceItems || []) {
        historicalReceivedByItem.set(
          row.inventory_item_id,
          Number(historicalReceivedByItem.get(row.inventory_item_id) || 0) + Number(row.quantity || 0)
        );
      }
    }

    const rowsToInsert = (requestLines || [])
      .map((line) => {
        const requestedQuantity = Math.max(0, Number(line.quantity_requested || 0));
        const alreadyReceived = Math.max(0, Number(historicalReceivedByItem.get(line.inventory_item_id) || 0));
        const quantity = created
          ? Math.max(requestedQuantity - alreadyReceived, 0)
          : requestedQuantity;

        return {
          invoice_id: invoiceId,
          inventory_item_id: line.inventory_item_id,
          batch_no: 'BATCH-XXX',
          quantity,
          unit_cost: roundMoney(Number(line.unit_cost || 0)),
          unit_selling_price: roundMoney(Number(line.unit_cost || 0) * 1.2),
          profit_margin: 20,
          tenant_id: actorTenantId,
          requested_quantity: requestedQuantity,
        };
      })
      .filter((line) => Number(line.quantity || 0) > 0);

    if (rowsToInsert.length > 0) {
      const { error: insertItemsError } = await supabaseAdmin
        .from(receivingInvoiceItemTable)
        .insert(rowsToInsert);

      if (insertItemsError) {
        throw new Error(insertItemsError.message);
      }

      repopulated = !created;
    }
  }

  return {
    invoice_id: invoiceId,
    created,
    repopulated,
  };
};

export const finalizeReceivingInvoiceFallback = async ({
  actorFacilityId,
  actorTenantId,
  actorProfileId,
  invoiceId,
  items,
}: {
  actorFacilityId: string;
  actorTenantId: string;
  actorProfileId: string;
  invoiceId: string;
  items: Array<{
    id?: string;
    inventory_item_id: string;
    quantity: number;
    batch_no: string;
    expiry_date?: string | null;
    unit_cost: number;
    unit_selling_price?: number | null;
  }>;
}) => {
  ensureScopedActor(actorFacilityId, actorTenantId, actorProfileId);

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Receiving invoice requires at least one line item');
  }

  const { data: invoice, error: invoiceError } = await supabaseAdmin
    .from(receivingInvoiceTable)
    .select('id, invoice_no, status, request_id, facility_id, tenant_id')
    .eq('id', invoiceId)
    .maybeSingle();

  if (invoiceError) {
    throw new Error(invoiceError.message);
  }
  if (!invoice) {
    throw new Error('Invoice not found');
  }
  if (invoice.facility_id !== actorFacilityId || invoice.tenant_id !== actorTenantId) {
    throw new Error('Receiving invoice is outside your facility');
  }
  if (invoice.status !== 'draft') {
    throw new Error('Invoice is already submitted');
  }

  await assertInventoryItemsInScope({
    inventoryItemIds: items.map((item) => item.inventory_item_id),
    facilityId: actorFacilityId,
    tenantId: actorTenantId,
  });

  for (const item of items) {
    if (!item.inventory_item_id || Number(item.quantity || 0) <= 0 || Number(item.unit_cost) < 0 || !String(item.batch_no || '').trim()) {
      throw new Error('Receiving invoice items must include item, positive quantity, cost, and batch');
    }

    if (!item.id) continue;

    const { data: existingItem, error: existingItemError } = await supabaseAdmin
      .from(receivingInvoiceItemTable)
      .select('id')
      .eq('id', item.id)
      .eq('invoice_id', invoiceId)
      .maybeSingle();

    if (existingItemError) {
      throw new Error(existingItemError.message);
    }
    if (!existingItem) {
      throw new Error('Invoice item does not belong to this invoice');
    }
  }

  for (const item of items) {
    const payload = {
      inventory_item_id: item.inventory_item_id,
      quantity: Math.max(1, Math.round(Number(item.quantity || 0))),
      batch_no: String(item.batch_no || '').trim(),
      expiry_date: item.expiry_date || null,
      unit_cost: roundMoney(Number(item.unit_cost || 0)),
      unit_selling_price:
        item.unit_selling_price === null || item.unit_selling_price === undefined
          ? null
          : roundMoney(Number(item.unit_selling_price)),
    };

    if (item.id) {
      const { error: updateError } = await supabaseAdmin
        .from(receivingInvoiceItemTable)
        .update(payload)
        .eq('id', item.id)
        .eq('invoice_id', invoiceId);

      if (updateError) {
        throw new Error(updateError.message);
      }
    } else {
      const { error: insertError } = await supabaseAdmin
        .from(receivingInvoiceItemTable)
        .insert({
          invoice_id: invoiceId,
          tenant_id: actorTenantId,
          ...payload,
        });

      if (insertError) {
        throw new Error(insertError.message);
      }
    }
  }

  const { data: effectiveItems, error: effectiveItemsError } = await supabaseAdmin
    .from(receivingInvoiceItemTable)
    .select('id, inventory_item_id, quantity, batch_no, expiry_date, unit_cost')
    .eq('invoice_id', invoiceId)
    .gt('quantity', 0)
    .order('id', { ascending: true });

  if (effectiveItemsError) {
    throw new Error(effectiveItemsError.message);
  }
  if (!effectiveItems || effectiveItems.length === 0) {
    throw new Error('Receiving invoice requires at least one line item');
  }

  let stockMovementCount = 0;
  for (const item of effectiveItems) {
    await createStockMovementFallback({
      actorFacilityId,
      actorTenantId,
      actorProfileId,
      inventoryItemId: item.inventory_item_id,
      movementType: 'receipt',
      quantity: Number(item.quantity || 0),
      batchNumber: item.batch_no || null,
      expiryDate: item.expiry_date || null,
      unitCost: Number(item.unit_cost || 0),
      referenceNumber: `INV-${invoice.invoice_no || 'REF'}`,
      notes: 'Received via Receiving (GRN)',
    });
    stockMovementCount += 1;
  }

  const submittedAt = new Date().toISOString();
  const { error: submitInvoiceError } = await supabaseAdmin
    .from(receivingInvoiceTable)
    .update({
      status: 'submitted',
      submitted_at: submittedAt,
      updated_at: submittedAt,
    })
    .eq('id', invoiceId)
    .eq('facility_id', actorFacilityId)
    .eq('tenant_id', actorTenantId);

  if (submitInvoiceError) {
    throw new Error(submitInvoiceError.message);
  }

  let requestClosed = false;

  if (invoice.request_id) {
    const { data: requestLines, error: requestLinesError } = await supabaseAdmin
      .from(resupplyLineTable)
      .select('inventory_item_id, quantity_requested')
      .eq('request_id', invoice.request_id);

    if (requestLinesError) {
      throw new Error(requestLinesError.message);
    }

    const { data: submittedInvoices, error: submittedInvoicesError } = await supabaseAdmin
      .from(receivingInvoiceTable)
      .select('id')
      .eq('request_id', invoice.request_id)
      .eq('facility_id', actorFacilityId)
      .eq('tenant_id', actorTenantId)
      .eq('status', 'submitted');

    if (submittedInvoicesError) {
      throw new Error(submittedInvoicesError.message);
    }

    const submittedInvoiceIds = (submittedInvoices || []).map((row) => row.id).filter(Boolean);
    const receivedByItem = new Map<string, number>();

    if (submittedInvoiceIds.length > 0) {
      const { data: submittedItems, error: submittedItemsError } = await supabaseAdmin
        .from(receivingInvoiceItemTable)
        .select('inventory_item_id, quantity')
        .in('invoice_id', submittedInvoiceIds);

      if (submittedItemsError) {
        throw new Error(submittedItemsError.message);
      }

      for (const row of submittedItems || []) {
        receivedByItem.set(
          row.inventory_item_id,
          Number(receivedByItem.get(row.inventory_item_id) || 0) + Number(row.quantity || 0)
        );
      }
    }

    requestClosed = (requestLines || []).length > 0 && (requestLines || []).every((line) => {
      const requested = Math.max(0, Number(line.quantity_requested || 0));
      const received = Math.max(0, Number(receivedByItem.get(line.inventory_item_id) || 0));
      return received >= requested;
    });

    if (requestClosed) {
      const { error: closeRequestError } = await supabaseAdmin
        .from(resupplyRequestTable)
        .update({
          status: 'fulfilled',
          updated_at: submittedAt,
        })
        .eq('id', invoice.request_id)
        .eq('facility_id', actorFacilityId)
        .eq('tenant_id', actorTenantId);

      if (closeRequestError) {
        throw new Error(closeRequestError.message);
      }
    }
  }

  return {
    success: true,
    requestClosed,
    stockMovementCount,
    submittedAt,
  };
};

export const dispatchIssueOrderFallback = async ({
  actorFacilityId,
  actorTenantId,
  actorProfileId,
  orderId,
}: {
  actorFacilityId: string;
  actorTenantId: string;
  actorProfileId: string;
  orderId: string;
}) => {
  ensureScopedActor(actorFacilityId, actorTenantId, actorProfileId);

  const { data: order, error: orderError } = await supabaseAdmin
    .from(issueOrderTable)
    .select('id, status, voucher_no, tenant_id, facility_id')
    .eq('id', orderId)
    .maybeSingle();

  let resolvedOrder = order;
  let resolvedOrderError = orderError;
  if (resolvedOrderError && isMissingColumnError(resolvedOrderError.message, 'tenant_id')) {
    const fallbackOrder = await supabaseAdmin
      .from(issueOrderTable)
      .select('id, status, voucher_no, facility_id')
      .eq('id', orderId)
      .maybeSingle();
    resolvedOrder = fallbackOrder.data
      ? {
          ...fallbackOrder.data,
          tenant_id: null,
        }
      : null;
    resolvedOrderError = fallbackOrder.error;
  }

  if (resolvedOrderError) {
    throw new Error(resolvedOrderError.message);
  }
  if (!resolvedOrder) {
    throw new Error('Issue order not found');
  }
  if ((resolvedOrder.tenant_id && resolvedOrder.tenant_id !== actorTenantId) || resolvedOrder.facility_id !== actorFacilityId) {
    throw new Error('Issue order is outside your tenant scope');
  }
  if (resolvedOrder.status === 'issued') {
    return {
      success: true,
      voucher_no: resolvedOrder.voucher_no || buildIssueVoucherNo(orderId),
      already_dispatched: true,
      dispatched_item_count: 0,
    };
  }
  if (resolvedOrder.status !== 'draft') {
    throw new Error('Only draft issue orders can be dispatched');
  }

  let { data: orderItems, error: orderItemsError } = await supabaseAdmin
    .from(issueOrderItemTable)
    .select('inventory_item_id, qty_issued, batch_no')
    .eq('order_id', orderId)
    .eq('tenant_id', actorTenantId)
    .order('id', { ascending: true });

  if (orderItemsError && isMissingColumnError(orderItemsError.message, 'tenant_id')) {
    const fallbackOrderItems = await supabaseAdmin
      .from(issueOrderItemTable)
      .select('inventory_item_id, qty_issued, batch_no')
      .eq('order_id', orderId)
      .order('id', { ascending: true });
    orderItems = fallbackOrderItems.data;
    orderItemsError = fallbackOrderItems.error;
  }

  if (orderItemsError) {
    throw new Error(orderItemsError.message);
  }
  if (!orderItems || orderItems.length === 0) {
    throw new Error('Issue order has no items to dispatch');
  }

  const issuableItems = orderItems.filter((item) => Number(item.qty_issued || 0) > 0);
  if (issuableItems.length === 0) {
    throw new Error('Issue order requires a positive issued quantity');
  }

  const voucherNo = resolvedOrder.voucher_no || buildIssueVoucherNo(orderId);
  let dispatchedItemCount = 0;

  for (const item of issuableItems) {
    await createStockMovementFallback({
      actorFacilityId,
      actorTenantId,
      actorProfileId,
      inventoryItemId: item.inventory_item_id,
      movementType: 'issue',
      quantity: Number(item.qty_issued || 0),
      batchNumber: item.batch_no || null,
      referenceNumber: voucherNo,
      notes: 'Issued via SIV',
    });
    dispatchedItemCount += 1;
  }

  const issuedAt = new Date().toISOString();
  let { error: updateOrderError } = await supabaseAdmin
    .from(issueOrderTable)
    .update({
      status: 'issued',
      voucher_no: voucherNo,
      issued_at: issuedAt,
      issued_by: actorProfileId,
      updated_at: issuedAt,
    })
    .eq('id', orderId)
    .eq('tenant_id', actorTenantId)
    .eq('facility_id', actorFacilityId);

  if (updateOrderError && isMissingColumnError(updateOrderError.message, 'tenant_id')) {
    const fallbackOrderUpdate = await supabaseAdmin
      .from(issueOrderTable)
      .update({
        status: 'issued',
        voucher_no: voucherNo,
        issued_at: issuedAt,
        issued_by: actorProfileId,
        updated_at: issuedAt,
      })
      .eq('id', orderId)
      .eq('facility_id', actorFacilityId);
    updateOrderError = fallbackOrderUpdate.error;
  }

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  return {
    success: true,
    voucher_no: voucherNo,
    already_dispatched: false,
    dispatched_item_count: dispatchedItemCount,
  };
};

export const commitPhysicalInventorySessionFallback = async ({
  actorFacilityId,
  actorTenantId,
  actorProfileId,
  sessionId,
}: {
  actorFacilityId: string;
  actorTenantId: string;
  actorProfileId: string;
  sessionId: string;
}) => {
  ensureScopedActor(actorFacilityId, actorTenantId, actorProfileId);

  const { data: session, error: sessionError } = await supabaseAdmin
    .from(physicalInventorySessionTable)
    .select('id, inventory_id, status, facility_id, tenant_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (sessionError) {
    throw new Error(sessionError.message);
  }
  if (!session) {
    throw new Error('Physical inventory session not found');
  }
  if (session.facility_id !== actorFacilityId || session.tenant_id !== actorTenantId) {
    throw new Error('Physical inventory session is outside your facility');
  }
  if (session.status !== 'draft') {
    throw new Error('Physical inventory session cannot be committed from current status');
  }

  const { data: items, error: itemsError } = await supabaseAdmin
    .from(physicalInventorySessionItemTable)
    .select('id, inventory_item_id, batch_no, expiry_date, qty_sound, qty_damaged, qty_expired, new_unit_cost')
    .eq('session_id', sessionId)
    .order('id', { ascending: true });

  if (itemsError) {
    throw new Error(itemsError.message);
  }
  if (!items || items.length === 0) {
    throw new Error('Physical inventory session has no items to commit');
  }

  let movementCount = 0;

  for (const item of items) {
    const inventoryItem = await loadInventoryItemScope({
      inventoryItemId: item.inventory_item_id,
      facilityId: actorFacilityId,
      tenantId: actorTenantId,
    });

    const currentQuantity = await getCurrentStockQuantity({
      inventoryItemId: item.inventory_item_id,
      facilityId: actorFacilityId,
      tenantId: actorTenantId,
    });

    const { error: updateCountedItemError } = await supabaseAdmin
      .from(physicalInventorySessionItemTable)
      .update({
        system_qty: currentQuantity,
        updated_at: new Date().toISOString(),
      })
      .eq('id', item.id)
      .eq('session_id', sessionId);

    if (updateCountedItemError) {
      throw new Error(updateCountedItemError.message);
    }

    const soundQty = Math.max(0, Number(item.qty_sound || 0));
    const damagedQty = Math.max(0, Number(item.qty_damaged || 0));
    const expiredQty = Math.max(0, Number(item.qty_expired || 0));
    const physicalTotal = soundQty + damagedQty + expiredQty;
    const variance = physicalTotal - currentQuantity;
    const effectiveUnitCost =
      item.new_unit_cost !== null && item.new_unit_cost !== undefined
        ? Number(item.new_unit_cost)
        : Number(inventoryItem.unit_cost || 0);

    if (variance > 0) {
      await createStockMovementFallback({
        actorFacilityId,
        actorTenantId,
        actorProfileId,
        inventoryItemId: item.inventory_item_id,
        movementType: 'adjustment',
        adjustmentDirection: 'increase',
        quantity: variance,
        batchNumber: item.batch_no || null,
        expiryDate: item.expiry_date || null,
        unitCost: effectiveUnitCost,
        referenceNumber: session.inventory_id,
        notes: 'Physical inventory reconciliation gain',
      });
      movementCount += 1;
    } else if (variance < 0) {
      await createStockMovementFallback({
        actorFacilityId,
        actorTenantId,
        actorProfileId,
        inventoryItemId: item.inventory_item_id,
        movementType: 'loss',
        quantity: Math.abs(variance),
        batchNumber: item.batch_no || null,
        expiryDate: item.expiry_date || null,
        unitCost: effectiveUnitCost,
        referenceNumber: session.inventory_id,
        notes: 'Physical inventory shrinkage',
      });
      movementCount += 1;
    }

    if (damagedQty > 0) {
      await createStockMovementFallback({
        actorFacilityId,
        actorTenantId,
        actorProfileId,
        inventoryItemId: item.inventory_item_id,
        movementType: 'damaged',
        quantity: damagedQty,
        batchNumber: item.batch_no || null,
        expiryDate: item.expiry_date || null,
        unitCost: effectiveUnitCost,
        referenceNumber: session.inventory_id,
        notes: 'Physical inventory damaged stock',
      });
      movementCount += 1;
    }

    if (expiredQty > 0) {
      await createStockMovementFallback({
        actorFacilityId,
        actorTenantId,
        actorProfileId,
        inventoryItemId: item.inventory_item_id,
        movementType: 'expired',
        quantity: expiredQty,
        batchNumber: item.batch_no || null,
        expiryDate: item.expiry_date || null,
        unitCost: effectiveUnitCost,
        referenceNumber: session.inventory_id,
        notes: 'Physical inventory expired stock',
      });
      movementCount += 1;
    }
  }

  const committedAt = new Date().toISOString();
  const { error: commitError } = await supabaseAdmin
    .from(physicalInventorySessionTable)
    .update({
      status: 'committed',
      committed_at: committedAt,
      committed_by: actorProfileId,
      updated_at: committedAt,
    })
    .eq('id', sessionId)
    .eq('facility_id', actorFacilityId)
    .eq('tenant_id', actorTenantId);

  if (commitError) {
    throw new Error(commitError.message);
  }

  return {
    success: true,
    movementCount,
    committedAt,
  };
};
