import { supabaseAdmin } from '../config/supabase';

interface PatientAccountLinkInput {
  patientId: string;
  tenantId: string;
  phoneNumber?: string | null;
  fullName?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
}

interface LinkResult {
  patientAccountId: string | null;
  created: boolean;
  linked: boolean;
}

const normalizePhone = (phone?: string | null) => (phone || '').trim();

const normalizeGender = (gender?: string | null) => {
  if (!gender) return null;
  const normalized = gender.trim().toLowerCase();
  if (normalized.startsWith('m')) return 'male';
  if (normalized.startsWith('f')) return 'female';
  return normalized;
};

export const ensurePatientAccountLink = async (input: PatientAccountLinkInput): Promise<LinkResult> => {
  const { patientId, tenantId } = input;
  if (!tenantId) {
    throw new Error('Tenant ID is required to link patient accounts');
  }

  const { data: patientRow, error: patientError } = await supabaseAdmin
    .from('patients')
    .select('patient_account_id, full_name, phone, date_of_birth, gender')
    .eq('id', patientId)
    .maybeSingle();

  if (patientError) throw patientError;
  if (!patientRow) {
    return { patientAccountId: null, created: false, linked: false };
  }

  if (patientRow.patient_account_id) {
    return { patientAccountId: patientRow.patient_account_id, created: false, linked: false };
  }

  const phoneNumber = normalizePhone(input.phoneNumber || patientRow.phone);
  if (!phoneNumber) {
    throw new Error('Patient phone number is required to link patient account');
  }

  const fullName = (input.fullName || patientRow.full_name || phoneNumber).trim();
  const dateOfBirth = input.dateOfBirth || patientRow.date_of_birth || null;
  const gender = normalizeGender(input.gender || patientRow.gender);

  const { data: existingAccount, error: accountError } = await supabaseAdmin
    .from('patient_accounts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (accountError) throw accountError;

  let patientAccountId = existingAccount?.id || null;
  let created = false;

  if (!patientAccountId) {
    const { data: createdAccount, error: createError } = await supabaseAdmin
      .from('patient_accounts')
      .insert({
        tenant_id: tenantId,
        phone_number: phoneNumber,
        name: fullName || phoneNumber,
        date_of_birth: dateOfBirth,
        gender,
      })
      .select('id')
      .single();

    if (createError) throw createError;
    patientAccountId = createdAccount?.id || null;
    created = true;
  }

  let linked = false;
  if (patientAccountId) {
    const { data: updatedRows, error: updateError } = await supabaseAdmin
      .from('patients')
      .update({ patient_account_id: patientAccountId })
      .eq('id', patientId)
      .is('patient_account_id', null)
      .select('id');

    if (updateError) throw updateError;
    linked = (updatedRows || []).length > 0;
  }

  return { patientAccountId, created, linked };
};

export const linkPatientsToAccountByPhone = async (params: {
  tenantId: string;
  phoneNumber: string;
  patientAccountId: string;
}) => {
  if (!params.tenantId) {
    throw new Error('Tenant ID is required to link patient accounts');
  }
  const normalizedPhone = normalizePhone(params.phoneNumber);
  if (!normalizedPhone) return { linkedCount: 0 };

  const { data: updatedRows, error } = await supabaseAdmin
    .from('patients')
    .update({ patient_account_id: params.patientAccountId })
    .eq('tenant_id', params.tenantId)
    .eq('phone', normalizedPhone)
    .is('patient_account_id', null)
    .select('id');

  if (error) throw error;

  return { linkedCount: (updatedRows || []).length };
};
