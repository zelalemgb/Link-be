import { supabaseAdmin } from '../config/supabase.js';

export type InventoryLockResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      session?: {
        id: string;
        inventory_id: string | null;
        status: string | null;
      } | null;
    };

export const getLockedInventorySession = async ({
  tenantId,
  facilityId,
}: {
  tenantId?: string | null;
  facilityId?: string | null;
}) => {
  if (!tenantId || !facilityId) return null;

  const queryRoot: any = supabaseAdmin.from('physical_inventory_sessions');
  if (!queryRoot || typeof queryRoot.select !== 'function') {
    return null;
  }

  const { data, error } = await queryRoot
    .select('id, inventory_id, status')
    .eq('tenant_id', tenantId)
    .eq('facility_id', facilityId)
    .eq('is_locked', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
};

export const assertInventoryUnlocked = async ({
  tenantId,
  facilityId,
  action,
}: {
  tenantId?: string | null;
  facilityId?: string | null;
  action: string;
}): Promise<InventoryLockResult> => {
  if (!tenantId || !facilityId) {
    return {
      ok: false,
      status: 403,
      code: 'TENANT_MISSING_SCOPE_CONTEXT',
      message: 'Missing facility or tenant context',
      session: null,
    };
  }

  const lockedSession = await getLockedInventorySession({ tenantId, facilityId });
  if (!lockedSession) {
    return { ok: true };
  }

  const inventoryId = lockedSession.inventory_id || lockedSession.id;
  return {
    ok: false,
    status: 409,
    code: 'CONFLICT_INVENTORY_COUNT_LOCKED',
    message: `Cannot ${action} while physical inventory ${inventoryId} is locking stock transactions`,
    session: lockedSession,
  };
};
