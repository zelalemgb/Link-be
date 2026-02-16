import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../config/supabase';
import { requirePatientSession, requirePatientCsrf } from '../middleware/patient-auth';
import { recordAuditEvent } from '../services/audit-log';
import { linkPatientsToAccountByPhone } from '../services/patientAccountLinking';

const router = Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

const patientSessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
});

const otpRequestSchema = z.object({
  phoneNumber: z.string().min(8).max(20),
});

const otpVerifySchema = z.object({
  phoneNumber: z.string().min(8).max(20),
  otp: z.string().regex(/^\d{6}$/),
});

const patientRegisterSchema = z.object({
  phoneNumber: z.string().min(8).max(20),
  otp: z.string().regex(/^\d{6}$/),
  name: z.string().min(2),
  dateOfBirth: z.string().optional(),
  gender: z.string().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
});

const devLoginSchema = z.object({
  phoneNumber: z.string().min(8).max(20).optional(),
});

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_HOURS = 2;

const sessionSecret = process.env.PATIENT_SESSION_SECRET || '';
const otpPepper = process.env.PATIENT_OTP_PEPPER || '';
const otpDelivery = process.env.PATIENT_OTP_DELIVERY || 'none';

const normalizePhoneNumber = (value: string) => (value || '').replace(/\s+/g, '');

const hashOtp = (otp: string) => {
  return crypto.createHash('sha256').update(`${otp}:${otpPepper}`).digest('hex');
};

const resolveDefaultTenantId = async () => {
  let tenantId = process.env.PATIENT_DEFAULT_TENANT_ID || '';
  if (tenantId) return tenantId;

  const { data: tenant, error } = await supabaseAdmin
    .from('tenants')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Tenant lookup failed');
  }

  tenantId = tenant?.id || '';
  return tenantId;
};

const markPhoneVerified = async ({ tenantId, phoneNumber }: { tenantId: string; phoneNumber: string }) => {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('patient_portal_phone_verifications')
    .upsert(
      {
        tenant_id: tenantId,
        phone_number: phoneNumber,
        is_verified: true,
        verified_at: now,
      },
      { onConflict: 'tenant_id,phone_number' }
    );

  if (error) {
    throw new Error(error.message || 'Failed to persist phone verification state');
  }
};

const signSession = (patientId: string, phoneNumber: string) => {
  if (!sessionSecret) {
    throw new Error('PATIENT_SESSION_SECRET is not configured');
  }

  return jwt.sign(
    { patientId, phoneNumber },
    sessionSecret,
    { expiresIn: `${SESSION_TTL_HOURS}h` }
  );
};

const setPatientSessionCookies = (res: Response, token: string) => {
  const csrfToken = crypto.randomBytes(16).toString('hex');
  res.cookie('patient_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
  res.cookie('patient_csrf', csrfToken, {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
};


router.post('/request-otp', otpLimiter, async (req, res) => {
  try {
    const { phoneNumber } = otpRequestSchema.parse(req.body);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

    await supabaseAdmin
      .from('patient_auth_otps')
      .delete()
      .eq('phone_number', normalizedPhone);

    const { error } = await supabaseAdmin
      .from('patient_auth_otps')
      .insert({
        phone_number: normalizedPhone,
        code_hash: hashOtp(otp),
        expires_at: expiresAt,
      });

    if (error) {
      console.error('Patient OTP store error:', error?.message || error);
      return res.status(500).json({ error: 'Unable to send OTP' });
    }

    if (otpDelivery === 'console' && process.env.NODE_ENV !== 'production') {
      console.log(`[Patient OTP] ${normalizedPhone}: ${otp}`);
    }

    return res.json({ success: true });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid request' });
    }
    console.error('Patient OTP request error:', error?.message || error);
    return res.status(500).json({ error: 'Unable to send OTP' });
  }
});

router.post('/verify-otp', otpLimiter, async (req, res) => {
  try {
    const parsed = otpVerifySchema.parse(req.body);
    const phoneNumber = normalizePhoneNumber(parsed.phoneNumber);
    const otp = parsed.otp;

    const { data: otpRow, error } = await supabaseAdmin
      .from('patient_auth_otps')
      .select('id, code_hash, attempts, expires_at')
      .eq('phone_number', phoneNumber)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !otpRow) {
      return res.status(400).json({ error: 'OTP expired or invalid' });
    }

    if (otpRow.attempts >= OTP_MAX_ATTEMPTS) {
      await supabaseAdmin.from('patient_auth_otps').delete().eq('id', otpRow.id);
      return res.status(429).json({ error: 'Too many attempts. Request a new OTP.' });
    }

    const isValid = otpRow.code_hash === hashOtp(otp);
    if (!isValid) {
      await supabaseAdmin
        .from('patient_auth_otps')
        .update({ attempts: otpRow.attempts + 1 })
        .eq('id', otpRow.id);
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    await supabaseAdmin
      .from('patient_auth_otps')
      .delete()
      .eq('phone_number', phoneNumber);

    const { data: patient, error: patientError } = await supabaseAdmin
      .from('patient_accounts')
      .select('id, tenant_id, phone_number, name, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile_photo_url')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    if (patientError) {
      console.error('Patient lookup error:', patientError?.message || patientError);
      return res.status(500).json({ error: 'Unable to verify patient' });
    }

    const tenantIdForVerification = patient?.tenant_id || (await resolveDefaultTenantId());
    if (!tenantIdForVerification) {
      return res.status(500).json({ error: 'Tenant not configured' });
    }
    await markPhoneVerified({ tenantId: tenantIdForVerification, phoneNumber });

    if (!patient) {
      // Preserve existing frontend contract: this drives the "new_account" registration flow.
      return res.status(404).json({ error: 'patient_not_found' });
    }

    try {
      await linkPatientsToAccountByPhone({
        tenantId: patient.tenant_id,
        phoneNumber,
        patientAccountId: patient.id,
      });
    } catch (linkError: any) {
      console.warn('Patient account link warning:', linkError?.message || linkError);
    }

    const token = signSession(patient.id, phoneNumber);
    setPatientSessionCookies(res, token);

    return res.json({ success: true, patient });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid request' });
    }
    if (error?.message?.includes('PATIENT_SESSION_SECRET')) {
      return res.status(500).json({ error: 'Patient session not configured' });
    }
    console.error('Patient OTP verify error:', error?.message || error);
    return res.status(500).json({ error: 'Unable to verify OTP' });
  }
});

router.post('/register', otpLimiter, async (req, res) => {
  try {
    const payload = patientRegisterSchema.parse(req.body);
    const normalizedPhone = normalizePhoneNumber(payload.phoneNumber);

    const { data: otpRow, error: otpLookupError } = await supabaseAdmin
      .from('patient_auth_otps')
      .select('id, code_hash, attempts, expires_at')
      .eq('phone_number', normalizedPhone)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otpLookupError || !otpRow) {
      return res.status(400).json({ error: 'OTP expired or invalid' });
    }
    if (otpRow.attempts >= OTP_MAX_ATTEMPTS) {
      await supabaseAdmin.from('patient_auth_otps').delete().eq('id', otpRow.id);
      return res.status(429).json({ error: 'Too many attempts. Request a new OTP.' });
    }
    const isValid = otpRow.code_hash === hashOtp(payload.otp);
    if (!isValid) {
      await supabaseAdmin
        .from('patient_auth_otps')
        .update({ attempts: otpRow.attempts + 1 })
        .eq('id', otpRow.id);
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    await supabaseAdmin
      .from('patient_auth_otps')
      .delete()
      .eq('phone_number', normalizedPhone);

    const { data: existing } = await supabaseAdmin
      .from('patient_accounts')
      .select('id, phone_number, name, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile_photo_url, tenant_id')
      .eq('phone_number', normalizedPhone)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'patient_exists' });
    }

    const tenantId = await resolveDefaultTenantId();

    if (!tenantId) {
      return res.status(500).json({ error: 'Tenant not configured' });
    }

    const { data: verification, error: verificationError } = await supabaseAdmin
      .from('patient_portal_phone_verifications')
      .select('id, is_verified')
      .eq('tenant_id', tenantId)
      .eq('phone_number', normalizedPhone)
      .maybeSingle();
    if (verificationError) {
      return res.status(500).json({ error: verificationError.message || 'Unable to verify phone state' });
    }
    if (!verification || verification.is_verified !== true) {
      return res.status(403).json({
        error: 'phone_verification_required',
        code: 'PERM_PHONE_VERIFICATION_REQUIRED',
        message: 'Phone verification is required before registration',
      });
    }

    const { data: created, error: insertError } = await supabaseAdmin
      .from('patient_accounts')
      .insert({
        phone_number: normalizedPhone,
        name: payload.name,
        date_of_birth: payload.dateOfBirth || null,
        gender: payload.gender || null,
        emergency_contact_name: payload.emergencyContactName || null,
        emergency_contact_phone: payload.emergencyContactPhone || null,
        tenant_id: tenantId,
      })
      .select('id, phone_number, name, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile_photo_url')
      .single();

    if (insertError || !created) {
      return res.status(500).json({ error: insertError?.message || 'Unable to create account' });
    }

    const token = signSession(created.id, normalizedPhone);
    setPatientSessionCookies(res, token);

    await recordAuditEvent({
      action: 'register_patient_account',
      eventType: 'create',
      entityType: 'patient_account',
      entityId: created.id,
      tenantId,
      actorRole: 'patient',
      actorUserId: null,
      actorIpAddress: req.ip,
      actorUserAgent: req.get('user-agent') || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: req.requestId || null,
    });

    return res.status(201).json({ patient: created });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid request' });
    }
    console.error('Patient register error:', error?.message || error);
    return res.status(500).json({ error: 'Unable to register patient' });
  }
});

router.post('/dev-login', otpLimiter, async (req, res) => {
  const devLoginEnabled = process.env.PATIENT_DEV_LOGIN_ENABLED === 'true';
  if (process.env.NODE_ENV === 'production' || !devLoginEnabled) {
    return res.status(403).json({ error: 'Dev login disabled' });
  }

  try {
    const payload = devLoginSchema.parse(req.body || {});
    const phoneNumber = (payload.phoneNumber || '+251911111111').replace(/\s+/g, '');

    let tenantId = process.env.PATIENT_DEFAULT_TENANT_ID || '';
    if (!tenantId) {
      const { data: tenant } = await supabaseAdmin
        .from('tenants')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      tenantId = tenant?.id || '';
    }

    if (!tenantId) {
      return res.status(500).json({ error: 'Tenant not configured' });
    }

    const { data: existing } = await supabaseAdmin
      .from('patient_accounts')
      .select('id, phone_number, name, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile_photo_url')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    let patient = existing;

    if (!patient) {
      const { data: created, error: insertError } = await supabaseAdmin
        .from('patient_accounts')
        .insert({
          phone_number: phoneNumber,
          name: 'Test Patient',
          date_of_birth: '1990-01-01',
          gender: 'male',
          emergency_contact_name: 'Emergency Contact',
          emergency_contact_phone: '+251922222222',
          tenant_id: tenantId,
        })
        .select('id, phone_number, name, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile_photo_url')
        .single();

      if (insertError || !created) {
        return res.status(500).json({ error: insertError?.message || 'Unable to create test account' });
      }
      patient = created;
    }

    const token = signSession(patient.id, phoneNumber);
    setPatientSessionCookies(res, token);

    await recordAuditEvent({
      action: 'dev_login',
      eventType: 'create',
      entityType: 'patient_account',
      entityId: patient.id,
      tenantId,
      actorRole: 'patient',
      actorUserId: null,
      actorIpAddress: req.ip,
      actorUserAgent: req.get('user-agent') || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: req.requestId || null,
    });

    return res.json({ patient });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid request' });
    }
    console.error('Dev login error:', error?.message || error);
    return res.status(500).json({ error: 'Unable to complete dev login' });
  }
});

router.get('/me', patientSessionLimiter, requirePatientSession, async (req, res) => {
  const payload = req.patient!;
  const { data: patient, error } = await supabaseAdmin
    .from('patient_accounts')
    .select('id, phone_number, name, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile_photo_url')
    .eq('id', payload.patientAccountId)
    .maybeSingle();

  if (error || !patient) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (payload.tenantId) {
    await recordAuditEvent({
      action: 'view_profile',
      eventType: 'read',
      entityType: 'patient_account',
      entityId: patient.id,
      tenantId: payload.tenantId,
      actorRole: 'patient',
      actorUserId: null,
      actorIpAddress: req.ip,
      actorUserAgent: req.get('user-agent') || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: req.requestId || null,
    });
  }

  return res.json({ patient });
});

router.patch('/profile', patientSessionLimiter, requirePatientSession, requirePatientCsrf, async (req, res) => {
  const payload = req.patient!;
  const updateSchema = z.object({
    name: z.string().min(2).optional(),
    date_of_birth: z.string().optional(),
    gender: z.string().optional(),
    emergency_contact_name: z.string().optional(),
    emergency_contact_phone: z.string().optional(),
    profile_photo_url: z.string().optional(),
  });

  try {
    const updates = updateSchema.parse(req.body);
    const { data, error } = await supabaseAdmin
      .from('patient_accounts')
      .update(updates)
      .eq('id', payload.patientAccountId)
      .select('id, phone_number, name, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, profile_photo_url')
      .maybeSingle();

    if (error || !data) {
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    if (payload.tenantId) {
      await recordAuditEvent({
        action: 'update_profile',
        eventType: 'update',
        entityType: 'patient_account',
        entityId: data.id,
        tenantId: payload.tenantId,
        actorRole: 'patient',
        actorUserId: null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.json({ patient: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid request' });
    }
    console.error('Patient profile update error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.post('/logout', patientSessionLimiter, requirePatientSession, requirePatientCsrf, async (_req, res) => {
  res.clearCookie('patient_session', { httpOnly: true, secure: true, sameSite: 'lax' });
  res.clearCookie('patient_csrf', { httpOnly: false, secure: true, sameSite: 'lax' });
  return res.json({ success: true });
});

export const __testables = {
  otpRequestSchema,
  otpVerifySchema,
  patientRegisterSchema,
};

export default router;
