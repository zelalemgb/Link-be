import { supabaseAdmin } from '../config/supabase';

export type ContractErrorCode =
  | `AUTH_${string}`
  | `PERM_${string}`
  | `TENANT_${string}`
  | `VALIDATION_${string}`
  | `CONFLICT_${string}`;

export type JoinRequestEligibilityResult =
  | {
      ok: true;
      canRequest: boolean;
      facility: {
        id: string;
        name: string;
        tenantId: string;
      };
    }
  | {
      ok: false;
      status: number;
      code: ContractErrorCode;
      message: string;
    };

export const resolveJoinRequestEligibility = async ({
  authUserId,
  tenantId,
  role,
  clinicCode,
}: {
  authUserId: string;
  tenantId?: string;
  role?: string;
  clinicCode: string;
}): Promise<JoinRequestEligibilityResult> => {
  const normalizedClinicCode = clinicCode.trim().toUpperCase();
  const { data: facility, error: facilityError } = await supabaseAdmin
    .from('facilities')
    .select('id, name, tenant_id, verification_status, verified')
    .eq('clinic_code', normalizedClinicCode)
    .maybeSingle();

  if (facilityError) {
    throw new Error(facilityError.message);
  }
  if (!facility) {
    return {
      ok: false,
      status: 404,
      code: 'VALIDATION_CLINIC_CODE_NOT_FOUND',
      message: 'Clinic code not found',
    };
  }

  if (role !== 'super_admin' && tenantId && facility.tenant_id !== tenantId) {
    return {
      ok: false,
      status: 403,
      code: 'TENANT_FACILITY_SCOPE_VIOLATION',
      message: 'Clinic code is outside your tenant scope',
    };
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .eq('facility_id', facility.id)
    .maybeSingle();
  if (membershipError) {
    throw new Error(membershipError.message);
  }
  if (membership) {
    return {
      ok: false,
      status: 409,
      code: 'CONFLICT_EXISTING_MEMBERSHIP',
      message: 'You already belong to this facility',
    };
  }

  const { data: pendingRequest, error: pendingError } = await supabaseAdmin
    .from('staff_registration_requests')
    .select('id')
    .eq('auth_user_id', authUserId)
    .eq('facility_id', facility.id)
    .eq('status', 'pending')
    .maybeSingle();
  if (pendingError) {
    throw new Error(pendingError.message);
  }
  if (pendingRequest) {
    return {
      ok: false,
      status: 409,
      code: 'CONFLICT_PENDING_JOIN_REQUEST',
      message: 'You already have a pending request for this facility',
    };
  }

  const canRequest = facility.verification_status !== 'rejected' && facility.verified !== false;
  return {
    ok: true,
    canRequest,
    facility: {
      id: facility.id,
      name: facility.name,
      tenantId: facility.tenant_id,
    },
  };
};
