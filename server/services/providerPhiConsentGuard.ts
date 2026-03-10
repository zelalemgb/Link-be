import { supabaseAdmin } from '../config/supabase';
import {
  assertPatientPortalConsentActiveForProviderRead,
  type ConsentResult,
} from './patientPortalConsentService';

// Consent enforcement for provider/facility-facing PHI read paths.
// Policy: enforce only when we can resolve a patient_account_id within the caller's tenant+facility scope.

export const maybeAssertProviderPhiConsentForPatient = async ({
  tenantId,
  facilityId,
  patientId,
  consentType,
}: {
  tenantId?: string;
  facilityId?: string;
  patientId: string;
  consentType: string;
}): Promise<ConsentResult<{ enforced: boolean; consentId?: string }>> => {
  try {
    if (!tenantId || !facilityId) {
      return { ok: true, data: { enforced: false } };
    }

    const { data: patient, error } = await supabaseAdmin
      .from('patients')
      .select('id, patient_account_id')
      .eq('id', patientId)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    const patientAccountId = patient?.patient_account_id as string | null | undefined;
    if (!patientAccountId) {
      // No linked portal account => consent does not apply to this record yet.
      return { ok: true, data: { enforced: false } };
    }

    const consentCheck = await assertPatientPortalConsentActiveForProviderRead({
      tenantId,
      patientAccountId,
      facilityId,
      consentType,
    });
    if (consentCheck.ok === false) {
      return {
        ok: false,
        status: consentCheck.status,
        code: consentCheck.code,
        message: consentCheck.message,
      };
    }

    return { ok: true, data: { enforced: true, consentId: consentCheck.data.consentId } };
  } catch (error: any) {
    console.error('maybeAssertProviderPhiConsentForPatient error:', error?.message || error);
    return {
      ok: false,
      status: 500,
      code: 'CONFLICT_CONSENT_ACCESS_CHECK_FAILED',
      message: 'Failed to validate consent access',
    };
  }
};

export const maybeAssertProviderPhiConsentForVisit = async ({
  tenantId,
  facilityId,
  visitId,
  consentType,
}: {
  tenantId?: string;
  facilityId?: string;
  visitId: string;
  consentType: string;
}): Promise<ConsentResult<{ enforced: boolean; consentId?: string }>> => {
  try {
    if (!tenantId || !facilityId) {
      return { ok: true, data: { enforced: false } };
    }

    const { data: visit, error } = await supabaseAdmin
      .from('visits')
      .select('id, patient_id, tenant_id, facility_id')
      .eq('id', visitId)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    const scopedPatientId = visit?.patient_id as string | null | undefined;
    if (!scopedPatientId) {
      return { ok: true, data: { enforced: false } };
    }

    // Preserve tenant/facility scope: only enforce when the visit is in-scope.
    if ((visit?.tenant_id && visit.tenant_id !== tenantId) || (visit?.facility_id && visit.facility_id !== facilityId)) {
      return { ok: true, data: { enforced: false } };
    }

    return await maybeAssertProviderPhiConsentForPatient({
      tenantId,
      facilityId,
      patientId: scopedPatientId,
      consentType,
    });
  } catch (error: any) {
    console.error('maybeAssertProviderPhiConsentForVisit error:', error?.message || error);
    return {
      ok: false,
      status: 500,
      code: 'CONFLICT_CONSENT_ACCESS_CHECK_FAILED',
      message: 'Failed to validate consent access',
    };
  }
};
