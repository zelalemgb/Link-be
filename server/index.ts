import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

// Config & Middleware
import { supabaseAdmin } from './config/supabase';
import { requireUser, adminKeyGuard } from './middleware/auth';

// Routes
import authRouter from './routes/auth';
import masterDataRouter from './routes/master-data';
import patientsRouter from './routes/patients';
import staffRouter from './routes/staff';
import financeRouter from './routes/finance';
import inventoryRouter from './routes/inventory';
import aiRouter from './routes/ai';
import receptionRouter from './routes/reception';
import ordersRouter from './routes/orders';

const app = express();
const port = process.env.PORT || 4000;

app.use(helmet());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[Incoming Request] ${req.method} ${req.url} from ${req.headers.origin}`);
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow any origin for now to rule out CORS issues
      callback(null, true);
    },
    credentials: true
  })
);
app.use(morgan('combined'));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
});

app.use(globalLimiter);

const findAuthUserByEmail = async (email: string) => {
  const normalized = email.trim().toLowerCase();
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users ?? [];
    const match = users.find((user) => user.email?.toLowerCase() === normalized);
    if (match) return match;
    if (users.length < perPage) break;
  }

  return null;
};

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Mount Routes
app.use('/api/auth', authRouter);
app.use('/api/master-data', masterDataRouter);
app.use('/api/patients', patientsRouter);
app.use('/api/staff', staffRouter);
app.use('/api/finance', financeRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/ai', aiRouter);
app.use('/api/reception', receptionRouter);
app.use('/api/orders', ordersRouter);

const clinicRegistrationSchema = z.object({
  clinic: z.object({
    name: z.string().min(2).max(100),
    country: z.string().min(2),
    location: z.string().min(2),
    address: z.string().min(5),
    phoneNumber: z.string().min(8).max(20),
    email: z.string().email().optional().nullable(),
  }),
  admin: z.object({
    name: z.string().min(2).max(100),
    email: z.string().email(),
    phoneNumber: z.string().min(8).max(20),
  }),
});

app.post(
  '/api/clinics',
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }),
  async (req, res) => {
    const parsed = clinicRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const { clinic, admin } = parsed.data;

    try {
      const { data, error } = await supabaseAdmin
        .from('clinic_registrations')
        .insert({
          clinic_name: clinic.name.trim(),
          country: clinic.country.trim(),
          location: clinic.location.trim(),
          address: clinic.address.trim(),
          phone_number: clinic.phoneNumber.replace(/\s+/g, ''),
          email: clinic.email ? clinic.email.trim().toLowerCase() : null,
          admin_name: admin.name.trim(),
          admin_email: admin.email.trim().toLowerCase(),
          admin_phone: admin.phoneNumber.replace(/\s+/g, ''),
        })
        .select('id')
        .single();

      if (error || !data?.id) {
        return res.status(500).json({ error: error?.message || 'Unable to submit registration' });
      }

      return res.status(201).json({ registrationId: data.id });
    } catch (err) {
      console.error('clinic registration failed', err);
      return res.status(500).json({ error: 'Unexpected error submitting registration' });
    }
  }
);

const superAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  name: z.string().min(2),
});

const betaRegistrationSchema = z.object({
  clinic_name: z.string().min(2).max(100),
  clinic_type: z.string().min(2).max(50),
  contact_person_name: z.string().min(2).max(100),
  contact_person_role: z.string().min(2).max(50),
  contact_phone: z.string().min(7).max(20),
  contact_email: z.string().email(),
  region: z.string().min(1).max(100),
  patient_volume_monthly: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  clinic_address: z.string().optional(),
  beta_motivation: z.string().optional().nullable(),
  status: z.string().optional(),
});

app.post('/api/admin/super-admin', adminKeyGuard, async (req, res) => {
  const parsed = superAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { email, password, name } = parsed.data;

  try {
    const { data: existingTenant } = await supabaseAdmin
      .from('tenants')
      .select('id')
      .eq('name', 'System Administration')
      .maybeSingle();

    const tenantId = existingTenant?.id;

    const { data: existingFacility } = await supabaseAdmin
      .from('facilities')
      .select('id')
      .eq('clinic_code', 'SUPERADMIN')
      .maybeSingle();

    const facilityId = existingFacility?.id;

    const existingUser = await findAuthUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    let ensuredTenantId = tenantId;
    if (!tenantId) {
      const { data: tenantInsert, error: tenantErr } = await supabaseAdmin
        .from('tenants')
        .insert({ name: 'System Administration', is_active: true })
        .select('id')
        .single();

      if (tenantErr && tenantErr.code !== '23505' && tenantErr.code !== 'PGRST116') {
        return res.status(500).json({ error: tenantErr.message });
      }
      ensuredTenantId = tenantInsert?.id;
    }

    let ensuredFacilityId = facilityId;
    if (!facilityId) {
      const { data: facilityInsert, error: facilityErr } = await supabaseAdmin
        .from('facilities')
        .insert({
          tenant_id: ensuredTenantId,
          name: 'System Administration',
          address: 'System',
          location: 'System',
          phone_number: '000000000',
          email,
          facility_type: 'admin',
          clinic_code: 'SUPERADMIN',
          verification_status: 'approved',
          verified: true,
        })
        .select('id')
        .single();

      if (facilityErr && facilityErr.code !== '23505' && facilityErr.code !== 'PGRST116') {
        return res.status(500).json({ error: facilityErr.message });
      }
      ensuredFacilityId = facilityInsert?.id;
    }

    const { data: userCreate, error: adminErr } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: {
        name,
        full_name: name,
        user_role: 'super_admin',
        role: 'super_admin',
        facility_id: ensuredFacilityId,
        tenant_id: ensuredTenantId,
        clinic_code: 'SUPERADMIN',
      },
    });

    if (adminErr) {
      return res.status(500).json({ error: adminErr.message });
    }

    return res.status(201).json({
      success: true,
      authUserId: userCreate.user?.id,
      facilityId: ensuredFacilityId,
      tenantId: ensuredTenantId,
    });
  } catch (err) {
    console.error('create super admin failed', err);
    return res.status(500).json({ error: 'Unexpected error creating super admin' });
  }
});

app.post('/api/beta-registrations', async (req, res) => {
  const parsed = betaRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const payload = parsed.data;
    const { data, error } = await supabaseAdmin
      .from('beta_registrations')
      .insert({
        ...payload,
        clinic_name: payload.clinic_name.trim(),
        contact_person_name: payload.contact_person_name.trim(),
        contact_person_role: payload.contact_person_role.trim(),
        contact_phone: payload.contact_phone.replace(/\s+/g, ''),
        contact_email: payload.contact_email.trim().toLowerCase(),
        region: payload.region.trim(),
        status: payload.status || 'pending',
      })
      .select('id')
      .single();

    if (error) throw error;
    return res.status(201).json({ id: data?.id });
  } catch (err: any) {
    console.error('beta registration failed', err);
    return res.status(500).json({ error: err.message || 'Unable to submit registration' });
  }
});

// Feature Requests API (BFF)
const featureRequestSchema = z.object({
  form_type: z.string(),
  page_url: z.string(),
  field_name: z.string().optional(),
  request_type: z.enum(['rename_field', 'add_field', 'remove_field', 'change_validation', 'feature_suggestion', 'bug_report']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  importance_tag: z.enum(['must_have', 'nice_to_have', 'maturity']),
  current_value: z.string().optional(),
  desired_value: z.string().optional(),
  description: z.string(),
  use_case: z.string().optional(),
  screenshot_url: z.string().optional(),
  attachment_urls: z.array(z.string()).optional(),
});

const getFeatureRequestScope = (req: express.Request, res: express.Response) => {
  const user = req.user;
  if (!user?.profileId) {
    res.status(403).json({ error: 'User profile required' });
    return null;
  }
  if (user.role !== 'super_admin' && !user.facilityId) {
    res.status(403).json({ error: 'Facility context required' });
    return null;
  }
  return {
    profileId: user.profileId,
    facilityId: user.facilityId,
    role: user.role,
  };
};

type FeatureRequestScopedQuery<T> = {
  eq: (column: string, value: string) => T;
};

const applyFeatureRequestScope = <T extends FeatureRequestScopedQuery<T>>(
  query: T,
  scope: { facilityId?: string; role: string }
) => {
  if (scope.role !== 'super_admin' && scope.facilityId) {
    return query.eq('facility_id', scope.facilityId);
  }
  return query;
};

const getScopedFeatureRequest = async (id: string, scope: { facilityId?: string; role: string }) => {
  let query = supabaseAdmin
    .from('feature_requests')
    .select('id, user_id, facility_id')
    .eq('id', id);

  query = applyFeatureRequestScope(query, scope);
  return query.maybeSingle();
};

app.post('/api/feature-requests', requireUser, async (req, res) => {
  const parsed = featureRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  // Access user from request (populated by middleware)
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  const { profileId, facilityId } = scope;
  const body = parsed.data;

  try {
    const { data, error } = await supabaseAdmin
      .from('feature_requests')
      .insert({
        ...body,
        user_id: profileId,
        facility_id: facilityId,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  } catch (err) {
    console.error('create feature request failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.get('/api/feature-requests/me', requireUser, async (req, res) => {
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  const { profileId, facilityId, role } = scope;
  try {
    let query = supabaseAdmin
      .from('feature_requests')
      .select('*, users(name, user_role), facilities(name)')
      .eq('user_id', profileId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });

    if (role !== 'super_admin' && facilityId) {
      query = query.eq('facility_id', facilityId);
    }

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    console.error('list my feature requests failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.get('/api/feature-requests', requireUser, async (req, res) => {
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  try {
    let query = supabaseAdmin
      .from('feature_requests')
      .select('*, users(name, user_role), facilities(name)')
      .order('created_at', { ascending: false });

    query = applyFeatureRequestScope(query, scope);
    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    console.error('list all feature requests failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.get('/api/feature-requests/community', requireUser, async (req, res) => {
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  try {
    let query = supabaseAdmin
      .from('feature_requests')
      .select('*, users(name, user_role), facilities(name)')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });

    query = applyFeatureRequestScope(query, scope);
    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    console.error('community feature requests failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.get('/api/feature-requests/duplicates', requireUser, async (req, res) => {
  const form_type = req.query.form_type as string | undefined;
  const request_type = req.query.request_type as string | undefined;
  const field_name = req.query.field_name as string | undefined;
  if (!form_type || !request_type) {
    return res.status(400).json({ error: 'form_type and request_type are required' });
  }
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  try {
    let query = supabaseAdmin
      .from('feature_requests')
      .select('*')
      .eq('form_type', form_type)
      .eq('request_type', request_type);

    if (field_name) query = query.eq('field_name', field_name);
    query = applyFeatureRequestScope(query, scope);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    console.error('check duplicates failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.patch('/api/feature-requests/:id', requireUser, async (req, res) => {
  const allowedFields = ['description', 'priority', 'importance_tag', 'current_value', 'desired_value', 'use_case'];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([key]) => allowedFields.includes(key))
  );
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;

  try {
    const { data: requestRow, error: requestErr } = await getScopedFeatureRequest(req.params.id, scope);
    if (requestErr) return res.status(500).json({ error: requestErr.message });
    if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });
    if (scope.role !== 'admin' && scope.role !== 'super_admin' && requestRow.user_id !== scope.profileId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data, error } = await supabaseAdmin
      .from('feature_requests')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    console.error('update feature request failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.patch('/api/feature-requests/:id/status', requireUser, async (req, res) => {
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  const { role } = scope;
  if (role !== 'admin' && role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { status, admin_notes, deprioritize_reason, estimated_completion } = req.body || {};
  const updateData: Record<string, unknown> = {
    status,
    admin_notes,
    deprioritize_reason,
    estimated_completion,
    reviewed_at: new Date().toISOString(),
  };

  if (status === 'implemented') updateData.completed_at = new Date().toISOString();

  try {
    const { data: requestRow, error: requestErr } = await getScopedFeatureRequest(req.params.id, scope);
    if (requestErr) return res.status(500).json({ error: requestErr.message });
    if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });

    const { data, error } = await supabaseAdmin
      .from('feature_requests')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    console.error('update status failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.post('/api/feature-requests/:id/confirm', requireUser, async (req, res) => {
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  const { profileId } = scope;

  try {
    const { data: requestRow, error: requestErr } = await getScopedFeatureRequest(req.params.id, scope);
    if (requestErr) return res.status(500).json({ error: requestErr.message });
    if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });

    const { data, error } = await supabaseAdmin
      .from('feature_requests')
      .update({
        confirmed_at: new Date().toISOString(),
        confirmed_by_user_id: profileId,
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  } catch (err) {
    console.error('confirm feature request failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.post('/api/feature-requests/:id/vote', requireUser, async (req, res) => {
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  const { profileId } = scope;
  const voteType = req.body?.voteType as 'upvote' | 'downvote' | undefined;
  if (!voteType) return res.status(400).json({ error: 'voteType is required' });

  try {
    const { data: requestRow, error: requestErr } = await getScopedFeatureRequest(req.params.id, scope);
    if (requestErr) return res.status(500).json({ error: requestErr.message });
    if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });

    const { data: existingVote } = await supabaseAdmin
      .from('feature_request_votes')
      .select('*')
      .eq('feature_request_id', req.params.id)
      .eq('user_id', profileId)
      .maybeSingle();

    if (existingVote) {
      if (existingVote.vote_type === voteType) {
        const { error: deleteErr } = await supabaseAdmin
          .from('feature_request_votes')
          .delete()
          .eq('id', existingVote.id);
        if (deleteErr) return res.status(500).json({ error: deleteErr.message });
        return res.json({ action: 'removed' });
      } else {
        const { error: updateErr } = await supabaseAdmin
          .from('feature_request_votes')
          .update({ vote_type: voteType })
          .eq('id', existingVote.id);
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        return res.json({ action: 'updated' });
      }
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('feature_request_votes')
        .insert({
          feature_request_id: req.params.id,
          user_id: profileId,
          vote_type: voteType,
        });
      if (insertErr) return res.status(500).json({ error: insertErr.message });
      return res.json({ action: 'created' });
    }
  } catch (err) {
    console.error('vote failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

app.delete('/api/feature-requests/:id', requireUser, async (req, res) => {
  const scope = getFeatureRequestScope(req, res);
  if (!scope) return;
  try {
    const { data: requestRow, error: requestErr } = await getScopedFeatureRequest(req.params.id, scope);
    if (requestErr) return res.status(500).json({ error: requestErr.message });
    if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });
    if (scope.role !== 'admin' && scope.role !== 'super_admin' && requestRow.user_id !== scope.profileId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { error } = await supabaseAdmin.from('feature_requests').delete().eq('id', req.params.id);
    if (!error) return res.json({ action: 'deleted' });

    const { error: softErr } = await supabaseAdmin
      .from('feature_requests')
      .update({ status: 'deleted' })
      .eq('id', req.params.id);

    if (softErr) return res.status(500).json({ error: softErr.message });
    return res.json({ action: 'archived' });
  } catch (err) {
    console.error('delete feature request failed', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

// Clinic Admin overview (BFF for dashboard)
app.get('/api/clinic-admin/overview', requireUser, async (req, res) => {
  const { facilityId: userFacilityId } = req.user!;
  const facilityId = (req.query.facilityId as string | undefined) || userFacilityId;

  if (!facilityId) return res.status(400).json({ error: 'Missing facilityId' });

  try {
    const { data: facility, error: facilityErr } = await supabaseAdmin
      .from('facilities')
      .select('*')
      .eq('id', facilityId)
      .single();

    if (facilityErr || !facility) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    const today = new Date().toISOString().split('T')[0];

    const [
      staffCount,
      pendingRequestsCount,
      todayPatients,
      servicesCount,
      consultationServiceCount,
      invitesCount,
      departmentsCount,
      insurersCount,
      pendingInvitationsCount,
    ] = await Promise.all([
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('facility_id', facilityId),
      supabaseAdmin
        .from('staff_registration_requests')
        .select('*', { count: 'exact', head: true })
        .match({ facility_id: facilityId, status: 'pending' }),
      supabaseAdmin
        .from('visits')
        .select('*', { count: 'exact', head: true })
        .eq('facility_id', facilityId)
        .gte('visit_date', today),
      supabaseAdmin
        .from('medical_services')
        .select('*', { count: 'exact', head: true })
        .match({ facility_id: facilityId, is_active: true }),
      supabaseAdmin
        .from('medical_services')
        .select('*', { count: 'exact', head: true })
        .match({ facility_id: facilityId, is_active: true, category: 'Consultation' }),
      supabaseAdmin
        .from('staff_invitations')
        .select('*', { count: 'exact', head: true })
        .eq('facility_id', facilityId),
      supabaseAdmin
        .from('departments')
        .select('*', { count: 'exact', head: true })
        .match({ facility_id: facilityId, is_active: true }),
      supabaseAdmin
        .from('insurers')
        .select('*', { count: 'exact', head: true })
        .match({ facility_id: facilityId, is_active: true }),
      supabaseAdmin
        .from('staff_invitations')
        .select('*', { count: 'exact', head: true })
        .match({ facility_id: facilityId, status: 'pending' }),
    ]);

    const hasDepartment = (departmentsCount.count ?? 0) > 0;
    const hasConsultationService = (consultationServiceCount.count ?? 0) > 0;
    const systemSetupComplete = hasDepartment && hasConsultationService;

    return res.json({
      facility,
      facilityId,
      tenantId: facility.tenant_id,
      staffCount: staffCount.count ?? 0,
      pendingRequestsCount: pendingRequestsCount.count ?? 0,
      todayPatients: todayPatients.count ?? 0,
      servicesCount: servicesCount.count ?? 0,
      onboardingCompleted: systemSetupComplete,
      systemSetupComplete,
      hasDepartment,
      hasConsultationService,
      departmentsCount: departmentsCount.count ?? 0,
      insurersCount: insurersCount.count ?? 0,
      pendingInvitationsCount: pendingInvitationsCount.count ?? 0,
      invitesCount: invitesCount.count ?? 0,
    });
  } catch (err) {
    console.error('clinic-admin/overview failed', err);
    return res.status(500).json({ error: 'Unexpected error fetching clinic admin data' });
  }
});

// Super admin dashboard data
app.get('/api/super-admin/dashboard', requireUser, async (req, res) => {
  const { role } = req.user!;
  if (role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  // Filtering params
  const q = (req.query.q as string | undefined)?.toLowerCase() || '';
  const filterTenantId = (req.query.tenantId as string | undefined) || 'all';
  const filterFacilityId = (req.query.facilityId as string | undefined) || 'all';
  const filterRole = (req.query.role as string | undefined) || 'all';
  const filterStatus = (req.query.status as string | undefined) || 'all';

  try {
    const [{ data: tenants }, { data: facilities }, { data: users }, { data: approvals }] = await Promise.all([
      supabaseAdmin.from('tenants').select('id, name, subdomain, is_active, created_at'),
      supabaseAdmin
        .from('facilities')
        .select('id, tenant_id, name, facility_type, location, address, verified, clinic_code, admin_user_id'),
      supabaseAdmin
        .from('users')
        .select('id, auth_user_id, user_role, tenant_id, facility_id, verified, created_at, full_name'),
      supabaseAdmin
        .from('staff_registration_requests')
        .select('id, facility_id, auth_user_id, status, created_at')
        .eq('status', 'pending'),
    ]);

    const tenantMap = new Map((tenants ?? []).map((t) => [t.id, t]));
    const facilityMap = new Map((facilities ?? []).map((f) => [f.id, f]));

    const filteredTenants = (tenants ?? []).filter((t) => {
      if (filterTenantId !== 'all' && t.id !== filterTenantId) return false;
      if (q && !(t.name?.toLowerCase().includes(q) || t.subdomain?.toLowerCase().includes(q))) return false;
      return true;
    });

    const filteredFacilities = (facilities ?? []).filter((f) => {
      if (filterTenantId !== 'all' && f.tenant_id !== filterTenantId) return false;
      if (filterFacilityId !== 'all' && f.id !== filterFacilityId) return false;
      if (q && !(f.name?.toLowerCase().includes(q) || f.location?.toLowerCase().includes(q))) return false;
      return true;
    });

    const filteredUsers = (users ?? []).filter((u) => {
      if (filterTenantId !== 'all' && u.tenant_id !== filterTenantId) return false;
      if (filterFacilityId !== 'all' && u.facility_id !== filterFacilityId) return false;
      if (filterRole !== 'all' && u.user_role !== filterRole) return false;
      if (filterStatus !== 'all') {
        const active = u.verified === true;
        if (filterStatus === 'Active' && !active) return false;
        if (filterStatus === 'Pending' && active) return false;
      }
      if (q && !(u.full_name?.toLowerCase().includes(q) || u.user_role?.toLowerCase().includes(q))) return false;
      return true;
    });

    const filteredApprovals = (approvals ?? []).filter((a) => {
      if (filterFacilityId !== 'all' && a.facility_id !== filterFacilityId) return false;
      if (filterTenantId !== 'all') {
        const fac = facilityMap.get(a.facility_id);
        if (fac && fac.tenant_id !== filterTenantId) return false;
      }
      return true;
    });

    return res.json({
      tenants: filteredTenants,
      facilities: filteredFacilities,
      users: filteredUsers.map((u) => ({
        ...u,
        tenant_name: tenantMap.get(u.tenant_id)?.name || '',
        facility_name: facilityMap.get(u.facility_id)?.name || '',
      })),
      approvals: filteredApprovals.map((a) => ({
        ...a,
        tenant_name: facilityMap.get(a.facility_id)?.tenant_id
          ? tenantMap.get(facilityMap.get(a.facility_id)?.tenant_id ?? '')?.name
          : '',
        facility_name: facilityMap.get(a.facility_id)?.name || '',
      })),
      health: {
        api: { uptime: 99.9, p95ms: 250, errorRate: 0.5 },
        db: { slowQueries: 0, connections: 10, storageGb: 20 },
        queues: { natsLag: 0, outboxBacklog: 0, failedJobs: 0 },
        sync: { offlineDevices: 0, stuckOver2h: 0 },
        sms: { successRate: 97.5, failures24h: 0 },
        incidents: { active: false },
      },
    });
  } catch (err) {
    console.error('super-admin/dashboard failed', err);
    return res.status(500).json({ error: 'Unexpected error fetching super admin data' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
  console.log(`API server listening on :${port}`);
});
