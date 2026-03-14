import './config/loadEnv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

// Config & Middleware
import { supabaseAdmin } from './config/supabase';
import { optionalUser, requireUser, superAdminGuard } from './middleware/auth';
import { csrfProtection } from './middleware/csrf';

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
import patientAuthRouter from './routes/patient-auth';
import patientPortalRouter from './routes/patient-portal';
import facilitiesRouter from './routes/facilities';
import staffInvitationsRouter from './routes/staff-invitations';
import adminDataRouter from './routes/admin-data';
import doctorRouter from './routes/doctor';
import mobileRouter from './routes/mobile';
import monitoringRouter from './routes/monitoring';
import inpatientRouter from './routes/inpatient';
import nursingRouter from './routes/nursing';
import pharmacyRouter from './routes/pharmacy';
import syncRouter from './routes/sync';
import hewRouter from './routes/hew';
import smsRouter from './routes/sms';
import platformAuditRouter from './routes/platform-audit';
import subscriptionRouter from './routes/subscription';
import { provisionTrial } from './services/subscriptionService';
import webhookRouter from './routes/webhook';
import agentRouter from './routes/agent';
import dhis2Router from './routes/dhis2';
import { subscriptionGuard } from './middleware/subscriptionGuard';
import { recordResponseStatus } from './services/monitoring';
import { recordPlatformActivityEvent } from './services/platform-activity';
import { buildPlatformActivitySearchClauses, buildPlatformFailureFilter } from './services/platformActivityFilters';
import { matchesPlatformTrafficScope, resolvePlatformTrafficScope } from './services/platformTrafficScope';
import { normalizeWorkspaceMetadata } from './services/workspaceMetadata';

export const app = express();
const port = process.env.PORT || 4000;

const isProduction = process.env.NODE_ENV === 'production';
const corsOriginsRaw = process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '';
const normalizeOrigin = (origin: string) => {
  const trimmed = origin.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
};

const expandOriginVariants = (origin: string) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (host === 'linkhc.org' || host === 'www.linkhc.org') {
      const port = parsed.port ? `:${parsed.port}` : '';
      variants.add(`${parsed.protocol}//linkhc.org${port}`);
      variants.add(`${parsed.protocol}//www.linkhc.org${port}`);
    }
  } catch {
    // Ignore non-URL values; normalized raw string variant is already included.
  }

  return Array.from(variants);
};

const allowedOriginSet = new Set<string>();
for (const configuredOrigin of corsOriginsRaw.split(',').map((origin) => origin.trim()).filter(Boolean)) {
  for (const variant of expandOriginVariants(configuredOrigin)) {
    allowedOriginSet.add(variant);
  }
}
for (const firstPartyOrigin of ['https://linkhc.org', 'https://www.linkhc.org']) {
  for (const variant of expandOriginVariants(firstPartyOrigin)) {
    allowedOriginSet.add(variant);
  }
}

// LOW-4: Warn loudly at startup if CORS is misconfigured in production.
// The runtime CORS handler already rejects requests when allowedOriginSet is empty,
// but catching it here gives an actionable message in deployment logs.
if (isProduction && allowedOriginSet.size === 0) {
  console.error(
    '[CORS] FATAL: No CORS origins configured for production. ' +
    'Set the CORS_ORIGINS environment variable (comma-separated HTTPS origins) ' +
    'before starting the server, otherwise all browser requests will be rejected.'
  );
  process.exit(1);
}

const pickFirstForwarded = (value: string | undefined) => {
  if (!value) return '';
  return value.split(',')[0]?.trim() || '';
};

const resolveRequestOrigin = (req: express.Request) => {
  const host = pickFirstForwarded(req.header('x-forwarded-host') || req.header('host') || '');
  if (!host) return '';

  const proto =
    pickFirstForwarded(req.header('x-forwarded-proto') || '') ||
    (req.secure ? 'https' : 'http');

  return normalizeOrigin(`${proto}://${host}`);
};

const safePath = (url: string | undefined) => (url || '').split('?')[0];
const resolveClientIp = (req: express.Request) =>
  pickFirstForwarded(req.header('x-forwarded-for') || '') ||
  req.ip ||
  req.socket.remoteAddress ||
  '0.0.0.0';

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // API responses are JSON; no scripts, styles, or media are served.
      },
    },
    // Prevent this API server from being embedded in frames anywhere.
    frameguard: { action: 'deny' },
    // Enforce HTTPS in supported browsers for 1 year.
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    // Disable MIME-type sniffing.
    noSniff: true,
    // Block cross-origin resource access from untrusted embedders.
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  })
);
// Capture raw body via verify callbacks — needed for AT webhook signature verification
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));
// Africa's Talking sends webhooks as application/x-www-form-urlencoded
app.use(express.urlencoded({
  extended: true,
  verify: (req: any, _res, buf) => { req.rawBody = req.rawBody ?? buf; },
}));
app.use(cookieParser());
app.use(csrfProtection);
app.use((req, res, next) => {
  const headerRequestId = req.header('x-request-id');
  const requestId = headerRequestId?.trim() || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

app.use(
  cors((req, callback) => {
    const requestOrigin = resolveRequestOrigin(req);

    callback(null, {
      origin: (origin, originCallback) => {
        if (!origin) {
          return originCallback(null, true);
        }

        const normalizedOrigin = normalizeOrigin(origin);

        // Always allow same-origin browser calls, even if that host is not explicitly whitelisted.
        if (requestOrigin && normalizedOrigin === requestOrigin) {
          return originCallback(null, true);
        }

        if (!isProduction && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) {
          return originCallback(null, true);
        }

        if (allowedOriginSet.size === 0) {
          if (!isProduction) {
            return originCallback(null, true);
          }
          return originCallback(new Error('CORS not configured'));
        }

        if (allowedOriginSet.has(normalizedOrigin)) {
          return originCallback(null, true);
        }

        return originCallback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
    });
  })
);
morgan.token('safe-url', (req) => safePath((req as express.Request).originalUrl));
app.use(morgan(':res[x-request-id] :method :safe-url :status :res[content-length] - :response-time ms'));
app.use((req, res, next) => {
  res.on('finish', () => {
    recordResponseStatus(res.statusCode, req.requestId);
  });
  next();
});

const decodeJwtSubject = (authorizationHeader: string | undefined) => {
  const header = (authorizationHeader || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) return null;

  const token = header.slice(7).trim();
  const parts = token.split('.');
  if (parts.length < 2) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
    return sub || null;
  } catch {
    return null;
  }
};

const globalRateLimitWindowMs = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const globalRateLimitPerWindow = Number(process.env.GLOBAL_RATE_LIMIT_MAX_PER_WINDOW || 240);

const globalLimiter = rateLimit({
  windowMs: Number.isFinite(globalRateLimitWindowMs) && globalRateLimitWindowMs > 0
    ? globalRateLimitWindowMs
    : 60 * 1000,
  limit: Number.isFinite(globalRateLimitPerWindow) && globalRateLimitPerWindow > 0
    ? globalRateLimitPerWindow
    : 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req) => {
    const authSubject = decodeJwtSubject(req.header('authorization'));
    if (authSubject) return `auth:${authSubject}`;

    return `ip:${resolveClientIp(req)}`;
  },
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

const clinicAdminOverviewRoles = new Set([
  'clinic_admin',
  'admin',
  'super_admin',
  'hospital_ceo',
  'medical_director',
  'nursing_head',
]);

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Keep a health alias under /api so staging probes can use a single API base URL.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Rate limiters for authentication routes
const AUTH_PUBLIC_RATE_LIMIT_PATHS = new Set([
  '/request-password-reset',
  '/initiate-registration',
  '/verify-registration-code',
  '/register-staff',
]);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 15, // 15 attempts per 15 minutes
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
  keyGenerator: (req) => req.ip || req.header('x-forwarded-for') || 'unknown',
  // Only throttle anonymous auth attempts (registration/reset/verification).
  // Authenticated profile and onboarding calls should not be blocked by this limiter.
  skip: (req) => !AUTH_PUBLIC_RATE_LIMIT_PATHS.has(req.path),
});

const patientAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many login attempts. Please try again later.' },
  keyGenerator: (req) => req.ip || req.header('x-forwarded-for') || 'unknown',
});

// Mount public and self-managed routes first.
app.use('/api/subscription', subscriptionRouter);
app.use('/api/webhook', webhookRouter);      // Chapa + Stripe webhooks (no auth)
app.use('/api/agent', agentRouter);          // Regional agent portal
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/patient-auth', patientAuthLimiter, patientAuthRouter);

// Resolve request user context once so subscription enforcement can run
// before protected routers while requireUser reuses the same context.
app.use(optionalUser);
app.use('/api/platform-audit', platformAuditRouter);
app.use(subscriptionGuard);

// Mount protected application routes after subscription enforcement.
app.use('/api/master-data', masterDataRouter);
app.use('/api/patients', patientsRouter);
app.use('/api/staff', staffRouter);
app.use('/api/finance', financeRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/ai', aiRouter);
app.use('/api/reception', receptionRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/patient-portal', patientPortalRouter);
app.use('/api/monitoring', monitoringRouter);
app.use('/api/facilities', facilitiesRouter);
app.use('/api/staff-invitations', staffInvitationsRouter);
app.use('/api/admin-data', adminDataRouter);
app.use('/api/doctor', doctorRouter);
app.use('/api/mobile', mobileRouter);
app.use('/api/inpatient', inpatientRouter);
app.use('/api/nursing', nursingRouter);
app.use('/api/pharmacy', pharmacyRouter);
app.use('/api/sync', syncRouter);
app.use('/api/hew', hewRouter);
app.use('/api/sms', smsRouter);
app.use('/api/dhis2', dhis2Router);


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
  workspace: z
    .object({
      setupMode: z.enum(['recommended', 'custom', 'full']),
      enabledModules: z.array(z.string().trim().min(1).max(64)).optional(),
    })
    .optional(),
});

const normalizeRegistrationModules = (values: string[] | undefined) => {
  const unique = new Set<string>();
  for (const value of values || []) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
};

const isWorkspacePreferenceColumnError = (message?: string) =>
  Boolean(message && /(requested_setup_mode|requested_modules)/i.test(message));

const resolvePlatformSessionId = (req: express.Request) => {
  const headerValue = req.header('x-link-session-id')?.trim() || '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(headerValue)
    ? headerValue
    : null;
};

const superAdminApprovalDecisionSchema = z.object({
  requestType: z.enum(['clinic_registration', 'staff_registration']),
  action: z.enum(['approve', 'reject']),
  activationType: z.enum(['testing', 'active']).optional(),
  rejectionReason: z.string().trim().max(500).optional(),
});

const mapSuperAdminApprovalError = (message: string) => {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('not found') ||
    normalized.includes('registration not found') ||
    normalized.includes('request not found')
  ) {
    return { status: 404, error: message };
  }

  if (
    normalized.includes('already reviewed') ||
    normalized.includes('only pending') ||
    normalized.includes('already approved') ||
    normalized.includes('already rejected')
  ) {
    return { status: 409, error: message };
  }

  if (normalized.includes('forbidden') || normalized.includes('not authorized')) {
    return { status: 403, error: message };
  }

  if (normalized.includes('required') || normalized.includes('invalid')) {
    return { status: 400, error: message };
  }

  return { status: 500, error: message };
};

const invokeClinicRegistrationReview = async (
  req: express.Request,
  input: {
    registrationId: string;
    action: 'approve' | 'reject';
    activationType: 'testing' | 'active';
    rejectionReason?: string;
  }
) => {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const apikey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const authHeader = req.header('authorization') || '';

  if (!supabaseUrl || !apikey || !authHeader) {
    throw new Error('Clinic review function is not configured');
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/review-clinic-registration`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey,
      Authorization: authHeader,
    },
    body: JSON.stringify(input),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      String(payload?.error || payload?.message || `Clinic review failed with status ${response.status}`)
    );
  }

  if (payload?.success === false) {
    throw new Error(String(payload?.error || payload?.message || 'Clinic review failed'));
  }

  return payload;
};

app.post(
  '/api/clinics',
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }),
  async (req, res) => {
    const parsed = clinicRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
    }

    const { clinic, admin, workspace } = parsed.data;
    const requestedSetupMode = workspace?.setupMode || 'recommended';
    const requestedModules =
      requestedSetupMode === 'custom'
        ? normalizeRegistrationModules(workspace?.enabledModules)
        : [];

    try {
      const baseInsertPayload = {
        clinic_name: clinic.name.trim(),
        country: clinic.country.trim(),
        location: clinic.location.trim(),
        address: clinic.address.trim(),
        phone_number: clinic.phoneNumber.replace(/\s+/g, ''),
        email: clinic.email ? clinic.email.trim().toLowerCase() : null,
        admin_name: admin.name.trim(),
        admin_email: admin.email.trim().toLowerCase(),
        admin_phone: admin.phoneNumber.replace(/\s+/g, ''),
      };
      const workspaceInsertPayload = {
        ...baseInsertPayload,
        requested_setup_mode: requestedSetupMode,
        requested_modules: requestedModules,
      };

      let insertQuery = supabaseAdmin
        .from('clinic_registrations')
        .insert(workspaceInsertPayload)
        .select('id')
        .single();

      let { data, error } = await insertQuery;

      // Backward compatibility for environments where FEAT-31 migration has not run yet.
      if (error && isWorkspacePreferenceColumnError(error.message)) {
        const fallbackResult = await supabaseAdmin
          .from('clinic_registrations')
          .insert(baseInsertPayload)
          .select('id')
          .single();
        data = fallbackResult.data;
        error = fallbackResult.error;
      }

      if (error || !data?.id) {
        return res.status(500).json({ error: error?.message || 'Unable to submit registration' });
      }

      void recordPlatformActivityEvent(
        {
          sessionId: resolvePlatformSessionId(req),
          source: 'server',
          category: 'registration',
          eventName: 'registration.clinic.completed',
          outcome: 'success',
          actorRole: 'clinic_owner_candidate',
          actorEmail: admin.email.trim().toLowerCase(),
          pagePath: '/register',
          entryPoint: 'clinic_registration',
          metadata: {
            clinic_name: clinic.name.trim(),
            clinic_location: clinic.location.trim(),
            requested_setup_mode: requestedSetupMode,
            requested_modules: requestedModules,
            registration_id: data.id,
          },
        },
        {
          actorEmail: admin.email.trim().toLowerCase(),
          ipAddress: req.ip || req.socket?.remoteAddress || null,
          userAgent: req.get('user-agent') || null,
        }
      ).catch((platformError) => {
        console.warn('clinic registration platform audit failed:', platformError?.message || platformError);
      });

      return res.status(201).json({ registrationId: data.id });
    } catch (err) {
      console.error('clinic registration failed', err);
      void recordPlatformActivityEvent(
        {
          sessionId: resolvePlatformSessionId(req),
          source: 'server',
          category: 'registration',
          eventName: 'registration.clinic.failed',
          outcome: 'failure',
          actorRole: 'clinic_owner_candidate',
          actorEmail: admin.email.trim().toLowerCase(),
          pagePath: '/register',
          entryPoint: 'clinic_registration',
          errorMessage: err instanceof Error ? err.message : 'Unexpected error submitting registration',
          metadata: {
            clinic_name: clinic.name.trim(),
            requested_setup_mode: requestedSetupMode,
          },
        },
        {
          actorEmail: admin.email.trim().toLowerCase(),
          ipAddress: req.ip || req.socket?.remoteAddress || null,
          userAgent: req.get('user-agent') || null,
        }
      ).catch(() => {});
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

app.post('/api/admin/super-admin', requireUser, superAdminGuard, async (req, res) => {
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
      if (tenantInsert?.id) {
        await provisionTrial(tenantInsert.id, 'health_centre');
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

const getAuthUserProfileIds = async (authUserId: string) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId);

  if (error) throw error;
  return (data || []).map((row) => row.id).filter(Boolean) as string[];
};

type FeatureRequestAuthorRow = {
  id: string;
  facility_id?: string | null;
  user_role?: string | null;
};

// Resolve a stable author context for feature-request writes even when middleware
// profile selection is ambiguous (multi-facility users).
const resolveFeatureRequestAuthor = async (
  req: express.Request
): Promise<{ profileId: string; facilityId?: string; role: string } | null> => {
  const authUserId = req.user?.authUserId;
  if (!authUserId) return null;

  const preferredFacilityId =
    typeof req.body?.facility_id === 'string' && req.body.facility_id.trim().length > 0
      ? req.body.facility_id.trim()
      : req.user?.facilityId;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, facility_id, user_role')
    .eq('auth_user_id', authUserId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  const profiles = (data || []) as FeatureRequestAuthorRow[];
  if (!profiles.length) return null;

  const byFacility = preferredFacilityId
    ? profiles.find((profile) => profile.facility_id === preferredFacilityId)
    : undefined;
  const byMiddlewareProfile = req.user?.profileId
    ? profiles.find((profile) => profile.id === req.user?.profileId)
    : undefined;
  const firstWithFacility = profiles.find((profile) => !!profile.facility_id);
  const selected = byFacility || byMiddlewareProfile || firstWithFacility || profiles[0];

  return {
    profileId: selected.id,
    facilityId: selected.facility_id || undefined,
    role: (selected.user_role as string | null) || req.user?.role || 'staff',
  };
};
// Backward compatible ownership resolution:
// - modern rows use users.id (profile id)
// - some legacy rows used auth.users id directly in feature_requests.user_id
const getFeatureRequestActorIds = async (authUserId: string, profileId?: string) => {
  const ids = new Set<string>();
  ids.add(authUserId);
  if (profileId) ids.add(profileId);

  try {
    const profileIds = await getAuthUserProfileIds(authUserId);
    for (const id of profileIds) ids.add(id);
  } catch (error) {
    console.warn('feature request actor id expansion failed', error);
  }

  return Array.from(ids);
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

type FeatureRequestRow = {
  id: string;
  user_id?: string | null;
  facility_id?: string | null;
  [key: string]: unknown;
};

type FeatureRequestUserRow = {
  id: string;
  name?: string | null;
  full_name?: string | null;
  user_role?: string | null;
};

type FeatureRequestFacilityRow = {
  id: string;
  name?: string | null;
};

// Avoid brittle PostgREST relation-select syntax in list endpoints; enrich related
// display metadata explicitly so feedback tabs keep loading even if FK names drift.
const enrichFeatureRequestRows = async (rows: FeatureRequestRow[]) => {
  if (!rows.length) return rows;

  const userIds = Array.from(new Set(rows.map((row) => row.user_id).filter(Boolean))) as string[];
  const facilityIds = Array.from(new Set(rows.map((row) => row.facility_id).filter(Boolean))) as string[];

  const [usersResult, facilitiesResult] = await Promise.all([
    userIds.length
      ? supabaseAdmin
          .from('users')
          .select('*')
          .in('id', userIds)
      : Promise.resolve({ data: [] as FeatureRequestUserRow[], error: null }),
    facilityIds.length
      ? supabaseAdmin
          .from('facilities')
          .select('*')
          .in('id', facilityIds)
      : Promise.resolve({ data: [] as FeatureRequestFacilityRow[], error: null }),
  ]);

  if (usersResult.error || facilitiesResult.error) {
    console.warn('feature request enrichment fallback used', {
      usersError: usersResult.error?.message,
      facilitiesError: facilitiesResult.error?.message,
    });

    return rows.map((row) => ({
      ...row,
      users: null,
      facilities: null,
    }));
  }

  const userMap = new Map<string, { name: string; user_role: string }>();
  for (const user of (usersResult.data || []) as FeatureRequestUserRow[]) {
    userMap.set(user.id, {
      name: user.name || user.full_name || 'Unknown user',
      user_role: user.user_role || 'staff',
    });
  }

  const facilityMap = new Map<string, { name: string }>();
  for (const facility of (facilitiesResult.data || []) as FeatureRequestFacilityRow[]) {
    facilityMap.set(facility.id, {
      name: facility.name || 'Unknown facility',
    });
  }

  return rows.map((row) => ({
    ...row,
    users: row.user_id ? userMap.get(row.user_id) || null : null,
    facilities: row.facility_id ? facilityMap.get(row.facility_id) || null : null,
  }));
};

app.post('/api/feature-requests', requireUser, async (req, res) => {
  const parsed = featureRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const author = await resolveFeatureRequestAuthor(req);
    if (!author?.profileId) {
      return res.status(403).json({ error: 'User profile required' });
    }
    if (author.role !== 'super_admin' && !author.facilityId) {
      return res.status(403).json({ error: 'Facility context required' });
    }

    const body = parsed.data;
    const { data, error } = await supabaseAdmin
      .from('feature_requests')
      .insert({
        ...body,
        status: 'submitted',
        user_id: author.profileId,
        facility_id: author.facilityId || null,
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
  const authUserId = req.user?.authUserId;
  if (!authUserId) return res.status(401).json({ error: 'Missing user context' });
  try {
    const actorIds = await getFeatureRequestActorIds(authUserId, req.user?.profileId);

    let query = supabaseAdmin
      .from('feature_requests')
      .select('*')
      .in('user_id', actorIds)
      .or('status.is.null,status.neq.deleted')
      .order('created_at', { ascending: false });

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    const enriched = await enrichFeatureRequestRows((data || []) as FeatureRequestRow[]);
    return res.json(enriched);
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
      .select('*')
      .order('created_at', { ascending: false });

    query = applyFeatureRequestScope(query, scope);
    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    const enriched = await enrichFeatureRequestRows((data || []) as FeatureRequestRow[]);
    return res.json(enriched);
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
      .select('*')
      .or('status.is.null,status.neq.deleted')
      .order('created_at', { ascending: false });

    query = applyFeatureRequestScope(query, scope);
    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    const enriched = await enrichFeatureRequestRows((data || []) as FeatureRequestRow[]);
    return res.json(enriched);
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
  try {
    const authUserId = req.user?.authUserId;
    const role = req.user?.role;
    if (!authUserId || !role) return res.status(401).json({ error: 'Missing user context' });

    if (role === 'admin' || role === 'super_admin') {
      const scope = getFeatureRequestScope(req, res);
      if (!scope) return;

      const { data: requestRow, error: requestErr } = await getScopedFeatureRequest(req.params.id, scope);
      if (requestErr) return res.status(500).json({ error: requestErr.message });
      if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });
    } else {
      const { data: requestRow, error: requestErr } = await supabaseAdmin
        .from('feature_requests')
        .select('id, user_id')
        .eq('id', req.params.id)
        .maybeSingle();

      if (requestErr) return res.status(500).json({ error: requestErr.message });
      if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });

      const actorIds = await getFeatureRequestActorIds(authUserId, req.user?.profileId);
      if (!actorIds.includes(requestRow.user_id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
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
  try {
    const authUserId = req.user?.authUserId;
    const role = req.user?.role;
    if (!authUserId || !role) return res.status(401).json({ error: 'Missing user context' });

    if (role === 'admin' || role === 'super_admin') {
      const scope = getFeatureRequestScope(req, res);
      if (!scope) return;

      const { data: requestRow, error: requestErr } = await getScopedFeatureRequest(req.params.id, scope);
      if (requestErr) return res.status(500).json({ error: requestErr.message });
      if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });
    } else {
      const { data: requestRow, error: requestErr } = await supabaseAdmin
        .from('feature_requests')
        .select('id, user_id')
        .eq('id', req.params.id)
        .maybeSingle();

      if (requestErr) return res.status(500).json({ error: requestErr.message });
      if (!requestRow) return res.status(404).json({ error: 'Feature request not found' });

      const actorIds = await getFeatureRequestActorIds(authUserId, req.user?.profileId);
      if (!actorIds.includes(requestRow.user_id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
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
  const { authUserId, facilityId: userFacilityId, tenantId: userTenantId, role } = req.user!;

  const facilityId = (req.query.facilityId as string | undefined) || userFacilityId;

  if (!facilityId) return res.status(400).json({ error: 'Missing facilityId' });

  try {
    if (role !== 'super_admin' && facilityId !== userFacilityId) {
      const { data: membership, error: membershipError } = await supabaseAdmin
        .from('users')
        .select('id, tenant_id')
        .eq('auth_user_id', authUserId)
        .eq('facility_id', facilityId)
        .maybeSingle();

      if (membershipError || !membership) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (userTenantId && membership.tenant_id && membership.tenant_id !== userTenantId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    let facilityQuery = supabaseAdmin
      .from('facilities')
      .select('*')
      .eq('id', facilityId);

    if (role !== 'super_admin' && userTenantId) {
      facilityQuery = facilityQuery.eq('tenant_id', userTenantId);
    }

    const { data: facility, error: facilityErr } = await facilityQuery.single();

    if (facilityErr || !facility) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    const isFacilityOwnerDoctor =
      role === 'doctor' &&
      typeof facility.admin_user_id === 'string' &&
      facility.admin_user_id === authUserId;

    if (!clinicAdminOverviewRoles.has(role) && !isFacilityOwnerDoctor) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const today = new Date().toISOString().split('T')[0];

    const nowIso = new Date().toISOString();
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
        .eq('facility_id', facilityId)
        .eq('accepted', false)
        .gte('expires_at', nowIso),
    ]);

    const hasDepartment = (departmentsCount.count ?? 0) > 0;
    const hasConsultationService = (consultationServiceCount.count ?? 0) > 0;
    const systemSetupComplete = hasDepartment && hasConsultationService;
    let workspace = normalizeWorkspaceMetadata(null);

    if (facility.tenant_id) {
      const { data: workspaceRow, error: workspaceError } = await supabaseAdmin
        .from('tenants')
        .select('workspace_type, setup_mode, team_mode, enabled_modules')
        .eq('id', facility.tenant_id)
        .maybeSingle();

      if (workspaceError) {
        console.warn('clinic-admin/overview workspace metadata lookup failed:', workspaceError.message);
      } else {
        workspace = normalizeWorkspaceMetadata(workspaceRow as any);
      }
    }

    return res.json({
      facility,
      facilityId,
      tenantId: facility.tenant_id,
      workspace,
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
  const trafficScope = resolvePlatformTrafficScope(req.query.trafficScope as string | undefined);
  const activitySearch = q.replace(/[,]/g, ' ').trim();

  const applyPlatformActivityBaseFilters = (query: any) => {
    let nextQuery = query;
    if (filterTenantId !== 'all') {
      nextQuery = nextQuery.eq('tenant_id', filterTenantId);
    }
    if (filterFacilityId !== 'all') {
      nextQuery = nextQuery.eq('facility_id', filterFacilityId);
    }
    if (filterRole !== 'all') {
      nextQuery = nextQuery.eq('actor_role', filterRole);
    }
    return nextQuery;
  };

  const applyPlatformActivityFilters = (query: any) => {
    let nextQuery = applyPlatformActivityBaseFilters(query);
    if (activitySearch) {
      nextQuery = nextQuery.or(buildPlatformActivitySearchClauses(activitySearch).join(','));
    }
    return nextQuery;
  };

  const applyPlatformFailureFilters = (query: any) => {
    return applyPlatformActivityBaseFilters(query).or(buildPlatformFailureFilter(activitySearch));
  };

  const applyPlatformFailureBaseFilters = (query: any) => {
    return applyPlatformActivityBaseFilters(query).or(buildPlatformFailureFilter(''));
  };

  try {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [
      { data: tenants },
      { data: facilities },
      { data: users },
      { data: approvals },
      { data: clinicApprovals },
      { data: recentActivity },
      { data: recentErrors },
      { data: sessionEndDurations },
      { data: activityWindow24h },
      { data: activityWindow7d },
      { data: errorWindow24h },
      { data: clinicRegistrationRows30d },
      { data: soloProviderRegistrationRows30d },
    ] = await Promise.all([
      supabaseAdmin.from('tenants').select('id, name, subdomain, is_active, created_at'),
      supabaseAdmin
        .from('facilities')
        .select('id, tenant_id, name, facility_type, location, address, verified, clinic_code, admin_user_id'),
      supabaseAdmin
        .from('users')
        .select('id, auth_user_id, user_role, tenant_id, facility_id, verified, created_at, full_name'),
      supabaseAdmin
        .from('staff_registration_requests')
        .select('id, facility_id, tenant_id, auth_user_id, name, email, requested_role, status, created_at, requested_at')
        .eq('status', 'pending'),
      supabaseAdmin
        .from('clinic_registrations')
        .select(
          'id, clinic_name, admin_name, admin_email, admin_phone, location, address, country, email, phone_number, status, created_at, tenant_id, facility_id'
        )
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(200),
      applyPlatformActivityFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select(
            'id, session_id, source, category, event_name, outcome, actor_email, actor_role, tenant_id, facility_id, page_path, page_title, entry_point, request_path, request_method, response_status, duration_ms, error_message, ip_address, user_agent, referrer, metadata, occurred_at'
          )
          .order('occurred_at', { ascending: false })
          .limit(120)
      ),
      applyPlatformFailureFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select(
            'id, session_id, category, source, event_name, outcome, actor_email, actor_role, tenant_id, facility_id, page_path, page_title, entry_point, request_path, request_method, response_status, duration_ms, error_message, ip_address, user_agent, referrer, metadata, occurred_at'
          )
          .order('occurred_at', { ascending: false })
          .limit(80)
      ),
      applyPlatformActivityFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select('duration_ms, source, referrer, metadata')
          .eq('event_name', 'session.ended')
          .gte('occurred_at', last24h)
          .order('occurred_at', { ascending: false })
          .limit(400)
      ),
      applyPlatformActivityBaseFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select('session_id, actor_email, actor_role, tenant_id, facility_id, event_name, page_path, request_path, source, referrer, metadata, occurred_at')
          .gte('occurred_at', last24h)
          .order('occurred_at', { ascending: false })
          .limit(2500)
      ),
      applyPlatformActivityBaseFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select('session_id, actor_email, actor_role, tenant_id, facility_id, event_name, page_path, request_path, source, referrer, metadata, occurred_at')
          .gte('occurred_at', last7d)
          .order('occurred_at', { ascending: false })
          .limit(5000)
      ),
      applyPlatformFailureBaseFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select('session_id, actor_email, actor_role, tenant_id, facility_id, event_name, page_path, request_path, response_status, error_message, source, referrer, metadata, occurred_at')
          .gte('occurred_at', last24h)
          .order('occurred_at', { ascending: false })
          .limit(2500)
      ),
      applyPlatformActivityBaseFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select('id, source, referrer, metadata')
          .eq('event_name', 'registration.clinic.completed')
          .gte('occurred_at', last30d)
          .limit(1000)
      ),
      applyPlatformActivityBaseFilters(
        supabaseAdmin
          .from('platform_activity_log')
          .select('id, source, referrer, metadata')
          .eq('event_name', 'registration.solo_provider.completed')
          .gte('occurred_at', last30d)
          .limit(1000)
      ),
    ]);

    const filterRowsByTrafficScope = (rows: any[] | null | undefined) =>
      (rows || []).filter((row) => matchesPlatformTrafficScope(row, trafficScope));

    const filteredRecentActivity = filterRowsByTrafficScope(recentActivity).slice(0, 20);
    const filteredRecentErrors = filterRowsByTrafficScope(recentErrors).slice(0, 10);
    const filteredActivityRows24h = filterRowsByTrafficScope(activityWindow24h);
    const filteredActivityRows7d = filterRowsByTrafficScope(activityWindow7d);
    const filteredErrorRows24h = filterRowsByTrafficScope(errorWindow24h);
    const filteredSessionEndDurations = filterRowsByTrafficScope(sessionEndDurations);
    const filteredClinicRegistrationRows30d = filterRowsByTrafficScope(clinicRegistrationRows30d);
    const filteredSoloProviderRegistrationRows30d = filterRowsByTrafficScope(soloProviderRegistrationRows30d);

    const avgSessionDurationMinutes =
      filteredSessionEndDurations.length > 0
        ? Math.round(
            filteredSessionEndDurations.reduce((sum: number, row: any) => sum + (row.duration_ms || 0), 0) /
              Math.max(filteredSessionEndDurations.length, 1) /
              60000
          )
        : 0;

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

    const filteredStaffApprovals = (approvals ?? []).filter((a) => {
      if (filterFacilityId !== 'all' && a.facility_id !== filterFacilityId) return false;
      if (filterTenantId !== 'all') {
        const fac = facilityMap.get(a.facility_id);
        if (fac && fac.tenant_id !== filterTenantId) return false;
      }
      if (
        q &&
        ![
          a.auth_user_id,
          a.name,
          a.email,
          a.requested_role,
        ]
          .filter(Boolean)
          .some((value: string) => value.toLowerCase().includes(q))
      ) {
        return false;
      }
      return true;
    });

    const filteredClinicApprovals = (clinicApprovals ?? []).filter((registration) => {
      if (filterFacilityId !== 'all' && registration.facility_id !== filterFacilityId) return false;
      if (filterTenantId !== 'all' && registration.tenant_id !== filterTenantId) return false;
      if (
        q &&
        ![
          registration.clinic_name,
          registration.admin_name,
          registration.admin_email,
          registration.location,
          registration.country,
        ]
          .filter(Boolean)
          .some((value: string) => value.toLowerCase().includes(q))
      ) {
        return false;
      }
      return true;
    });

    const filteredApprovals = [
      ...filteredClinicApprovals.map((registration) => ({
        id: registration.id,
        request_type: 'clinic_registration',
        clinic_name: registration.clinic_name,
        admin_name: registration.admin_name,
        admin_email: registration.admin_email,
        admin_phone: registration.admin_phone,
        location: registration.location,
        country: registration.country,
        tenant_id: registration.tenant_id,
        facility_id: registration.facility_id,
        status: registration.status,
        created_at: registration.created_at,
        address: registration.address,
        email: registration.email,
        phone_number: registration.phone_number,
        notes: registration.admin_phone || registration.admin_email,
        tenant_name: registration.tenant_id ? tenantMap.get(registration.tenant_id)?.name || '' : '',
        facility_name: registration.facility_id ? facilityMap.get(registration.facility_id)?.name || '' : '',
      })),
      ...filteredStaffApprovals.map((approval) => ({
        ...approval,
        request_type: 'staff_registration',
        created_at: approval.requested_at || approval.created_at,
      })),
    ].sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));

    const activityRows24h = filteredActivityRows24h;
    const activityRows7d = filteredActivityRows7d;
    const errorRows24h = filteredErrorRows24h;

    const getTenantIdForRow = (row: any) => row.tenant_id || (row.facility_id ? facilityMap.get(row.facility_id)?.tenant_id || null : null);
    const getActorKeyForRow = (row: any) =>
      row.actor_email || (row.session_id ? `session:${row.session_id}` : null);
    const getSurfaceLabelForRow = (row: any) => row.page_path || row.request_path || row.event_name || 'Unknown surface';

    const collectUnique = (rows: any[], valueForRow: (row: any) => string | null | undefined) => {
      const values = new Set<string>();
      for (const row of rows) {
        const value = valueForRow(row);
        if (value) values.add(value);
      }
      return values;
    };

    const countBy = (rows: any[], valueForRow: (row: any) => string | null | undefined) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = valueForRow(row);
        if (!value) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
      }
      return counts;
    };

    const topCountEntry = (counts: Map<string, number>) =>
      Array.from(counts.entries())
        .sort((left, right) => {
          if (right[1] !== left[1]) return right[1] - left[1];
          return left[0].localeCompare(right[0]);
        })[0] || null;

    const topSurfaceFromCounts = (counts: Map<string, number>) => topCountEntry(counts)?.[0] || null;

    const activeTenantIds24h = collectUnique(activityRows24h, getTenantIdForRow);
    const activeFacilityIds24h = collectUnique(activityRows24h, (row) => row.facility_id || null);
    const activeActorKeys24h = collectUnique(activityRows24h, getActorKeyForRow);
    const activeFacilityIds7d = collectUnique(activityRows7d, (row) => row.facility_id || null);
    const activeTenantIds7d = collectUnique(activityRows7d, getTenantIdForRow);
    const affectedTenantIds24h = collectUnique(errorRows24h, getTenantIdForRow);
    const affectedFacilityIds24h = collectUnique(errorRows24h, (row) => row.facility_id || null);
    const affectedActorKeys24h = collectUnique(errorRows24h, getActorKeyForRow);

    const roleActivityCounts24h = countBy(activityRows24h, (row) => row.actor_role || null);
    const workflowCounts24h = countBy(activityRows24h, getSurfaceLabelForRow);
    const surfaceErrorCounts24h = countBy(errorRows24h, getSurfaceLabelForRow);

    const topActiveRoleEntry = topCountEntry(roleActivityCounts24h);
    const topWorkflowEntry = topCountEntry(workflowCounts24h);
    const topErrorSurfaceEntry = topCountEntry(surfaceErrorCounts24h);

    const tenantErrorBuckets = new Map<
      string,
      { count: number; lastSeen: string | null; facilities: Set<string>; actors: Set<string>; surfaces: Map<string, number> }
    >();
    const facilityErrorBuckets = new Map<
      string,
      { count: number; lastSeen: string | null; actors: Set<string>; surfaces: Map<string, number> }
    >();

    for (const row of errorRows24h) {
      const tenantId = getTenantIdForRow(row);
      const facilityId = row.facility_id || null;
      const actorKey = getActorKeyForRow(row);
      const surface = getSurfaceLabelForRow(row);

      if (tenantId) {
        if (!tenantErrorBuckets.has(tenantId)) {
          tenantErrorBuckets.set(tenantId, {
            count: 0,
            lastSeen: null,
            facilities: new Set<string>(),
            actors: new Set<string>(),
            surfaces: new Map<string, number>(),
          });
        }
        const bucket = tenantErrorBuckets.get(tenantId)!;
        bucket.count += 1;
        bucket.lastSeen = bucket.lastSeen && bucket.lastSeen > row.occurred_at ? bucket.lastSeen : row.occurred_at;
        if (facilityId) bucket.facilities.add(facilityId);
        if (actorKey) bucket.actors.add(actorKey);
        bucket.surfaces.set(surface, (bucket.surfaces.get(surface) || 0) + 1);
      }

      if (facilityId) {
        if (!facilityErrorBuckets.has(facilityId)) {
          facilityErrorBuckets.set(facilityId, {
            count: 0,
            lastSeen: null,
            actors: new Set<string>(),
            surfaces: new Map<string, number>(),
          });
        }
        const bucket = facilityErrorBuckets.get(facilityId)!;
        bucket.count += 1;
        bucket.lastSeen = bucket.lastSeen && bucket.lastSeen > row.occurred_at ? bucket.lastSeen : row.occurred_at;
        if (actorKey) bucket.actors.add(actorKey);
        bucket.surfaces.set(surface, (bucket.surfaces.get(surface) || 0) + 1);
      }
    }

    const atRiskTenants = Array.from(tenantErrorBuckets.entries())
      .sort((left, right) => {
        if (right[1].count !== left[1].count) return right[1].count - left[1].count;
        return (right[1].lastSeen || '').localeCompare(left[1].lastSeen || '');
      })
      .slice(0, 5)
      .map(([tenantId, bucket]) => ({
        tenant_id: tenantId,
        tenant_name: tenantMap.get(tenantId)?.name || tenantId,
        error_count: bucket.count,
        facilities_impacted: bucket.facilities.size,
        actors_impacted: bucket.actors.size,
        last_seen: bucket.lastSeen,
        top_surface: topSurfaceFromCounts(bucket.surfaces) || 'Unknown surface',
      }));

    const atRiskFacilities = Array.from(facilityErrorBuckets.entries())
      .sort((left, right) => {
        if (right[1].count !== left[1].count) return right[1].count - left[1].count;
        return (right[1].lastSeen || '').localeCompare(left[1].lastSeen || '');
      })
      .slice(0, 5)
      .map(([facilityId, bucket]) => ({
        facility_id: facilityId,
        facility_name: facilityMap.get(facilityId)?.name || facilityId,
        tenant_id: facilityMap.get(facilityId)?.tenant_id || null,
        tenant_name: facilityMap.get(facilityId)?.tenant_id
          ? tenantMap.get(facilityMap.get(facilityId)?.tenant_id || '')?.name || ''
          : '',
        error_count: bucket.count,
        actors_impacted: bucket.actors.size,
        last_seen: bucket.lastSeen,
        top_surface: topSurfaceFromCounts(bucket.surfaces) || 'Unknown surface',
      }));

    const quietFacilitiesAll = filteredFacilities
      .filter((facility: any) => facility.verified && !activeFacilityIds7d.has(facility.id))
      .map((facility: any) => ({
        facility_id: facility.id,
        facility_name: facility.name,
        tenant_id: facility.tenant_id,
        tenant_name: tenantMap.get(facility.tenant_id)?.name || '',
        reason: 'No platform activity in the last 7 days',
      }));
    const quietFacilities = quietFacilitiesAll.slice(0, 5);

    const newTenants7d = filteredTenants.filter((tenant: any) => {
      const createdAt = tenant.created_at ? new Date(tenant.created_at).getTime() : Number.NaN;
      return Number.isFinite(createdAt) && createdAt >= new Date(last7d).getTime();
    });
    const newTenantsWithoutActivity7d = newTenants7d.filter((tenant: any) => !activeTenantIds7d.has(tenant.id));

    let likelyNextIssue = 'No clear escalation cluster from current telemetry.';
    if (atRiskTenants.length > 0) {
      likelyNextIssue = `${atRiskTenants[0].tenant_name} is the hottest failure cluster, led by ${atRiskTenants[0].top_surface}.`;
    } else if (quietFacilities.length > 0) {
      likelyNextIssue = `${quietFacilities[0].facility_name} is live but quiet. Confirm whether the team is blocked, offline, or disengaged.`;
    } else if (newTenantsWithoutActivity7d.length > 0) {
      likelyNextIssue = `${newTenantsWithoutActivity7d.length} new tenant${newTenantsWithoutActivity7d.length === 1 ? '' : 's'} have not shown activity in 7 days.`;
    } else if (filteredApprovals.length > 0) {
      likelyNextIssue = `${filteredApprovals.length} approval${filteredApprovals.length === 1 ? '' : 's'} are still waiting and may delay first-value.`;
    }

    return res.json({
      tenants: filteredTenants,
      facilities: filteredFacilities,
      users: filteredUsers.map((u) => ({
        ...u,
        tenant_name: tenantMap.get(u.tenant_id)?.name || '',
        facility_name: facilityMap.get(u.facility_id)?.name || '',
      })),
      approvals: filteredApprovals.map((a) => {
        if (a.request_type === 'clinic_registration') {
          return a;
        }
        return {
          ...a,
          tenant_name: facilityMap.get(a.facility_id)?.tenant_id
            ? tenantMap.get(facilityMap.get(a.facility_id)?.tenant_id ?? '')?.name
            : '',
          facility_name: facilityMap.get(a.facility_id)?.name || '',
        };
      }),
      activitySummary: {
        events24h: filteredActivityRows24h.length,
        goroQuickAccess24h: filteredActivityRows24h.filter((row: any) => row.event_name === 'action.goro_quick_access.clicked').length,
        errors24h: filteredErrorRows24h.length,
        clinicRegistrations30d: filteredClinicRegistrationRows30d.length,
        soloProviderRegistrations30d: filteredSoloProviderRegistrationRows30d.length,
        avgSessionDurationMinutes,
      },
      trafficScope,
      recentPlatformActivity: filteredRecentActivity.map((row: any) => ({
        ...row,
        tenant_name: row.tenant_id ? tenantMap.get(row.tenant_id)?.name || '' : '',
        facility_name: row.facility_id ? facilityMap.get(row.facility_id)?.name || '' : '',
      })),
      recentPlatformErrors: filteredRecentErrors.map((row: any) => ({
        ...row,
        tenant_name: row.tenant_id ? tenantMap.get(row.tenant_id)?.name || '' : '',
        facility_name: row.facility_id ? facilityMap.get(row.facility_id)?.name || '' : '',
      })),
      insights: {
        activeTenants24h: activeTenantIds24h.size,
        activeFacilities24h: activeFacilityIds24h.size,
        activeActors24h: activeActorKeys24h.size,
        affectedTenants24h: affectedTenantIds24h.size,
        affectedFacilities24h: affectedFacilityIds24h.size,
        affectedActors24h: affectedActorKeys24h.size,
        quietVerifiedFacilities7d: quietFacilitiesAll.length,
        newTenants7d: newTenants7d.length,
        newTenantsWithoutActivity7d: newTenantsWithoutActivity7d.length,
        topActiveRole24h: topActiveRoleEntry
          ? { label: topActiveRoleEntry[0], count: topActiveRoleEntry[1] }
          : null,
        topWorkflow24h: topWorkflowEntry
          ? { label: topWorkflowEntry[0], count: topWorkflowEntry[1] }
          : null,
        topErrorSurface24h: topErrorSurfaceEntry
          ? { label: topErrorSurfaceEntry[0], count: topErrorSurfaceEntry[1] }
          : null,
        topErrorTenant24h: atRiskTenants[0] || null,
        topErrorFacility24h: atRiskFacilities[0] || null,
        likelyNextIssue,
        atRiskTenants,
        atRiskFacilities,
        quietFacilities,
      },
      health: {
        api: { uptime: 99.9, p95ms: 250, errorRate: 0.5 },
        db: { slowQueries: 0, connections: 10, storageGb: 20 },
        queues: { natsLag: 0, outboxBacklog: 0, failedJobs: 0 },
        sync: { offlineDevices: 0, stuckOver2h: 0, pendingFacilities: 0 },
        sms: { successRate: 97.5, failures24h: 0 },
        incidents: { active: false },
      },
    });
  } catch (err) {
    console.error('super-admin/dashboard failed', err);
    return res.status(500).json({ error: 'Unexpected error fetching super admin data' });
  }
});

app.post('/api/super-admin/approvals/:id/review', requireUser, superAdminGuard, async (req, res) => {
  const parsed = superAdminApprovalDecisionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid review payload' });
  }

  const { id } = req.params;
  const { requestType, action, activationType = 'testing', rejectionReason } = parsed.data;

  try {
    if (requestType === 'clinic_registration') {
      const result = await invokeClinicRegistrationReview(req, {
        registrationId: id,
        action,
        activationType,
        rejectionReason,
      });

      return res.json({
        success: true,
        requestType,
        action,
        result,
      });
    }

    if (action === 'approve') {
      const { error } = await supabaseAdmin.rpc('backend_approve_staff_registration_request', {
        p_actor_role: req.user?.role || null,
        p_actor_facility_id: req.user?.facilityId || null,
        p_actor_tenant_id: req.user?.tenantId || null,
        p_actor_profile_id: req.user?.profileId || null,
        p_request_id: id,
        p_reason: rejectionReason || null,
        p_actor_ip_address: req.ip || null,
        p_actor_user_agent: req.get('user-agent') || null,
        p_request_trace_id: null,
      });

      if (error) {
        const mapped = mapSuperAdminApprovalError(error.message || 'Failed to approve staff registration request');
        return res.status(mapped.status).json({ error: mapped.error });
      }

      return res.json({ success: true, requestType, action });
    }

    const { data: requestRow, error: loadError } = await supabaseAdmin
      .from('staff_registration_requests')
      .select('id, tenant_id, facility_id, status')
      .eq('id', id)
      .maybeSingle();

    if (loadError) {
      return res.status(500).json({ error: loadError.message });
    }

    if (!requestRow?.id) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (String(requestRow.status || '').toLowerCase() !== 'pending') {
      return res.status(409).json({ error: 'Only pending requests can be rejected' });
    }

    const reviewedAt = new Date().toISOString();
    const { data: rejectedRow, error: rejectError } = await supabaseAdmin
      .from('staff_registration_requests')
      .update({
        status: 'rejected',
        rejection_reason: rejectionReason || 'Rejected by super admin',
        reviewed_at: reviewedAt,
        reviewed_by: req.user?.profileId || null,
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (rejectError) {
      return res.status(500).json({ error: rejectError.message });
    }

    if (!rejectedRow?.id) {
      return res.status(409).json({ error: 'Only pending requests can be rejected' });
    }

    return res.json({ success: true, requestType, action });
  } catch (error: any) {
    const mapped = mapSuperAdminApprovalError(error?.message || 'Failed to review approval');
    return res.status(mapped.status).json({ error: mapped.error });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`API server listening on :${port}`);
  });
}
