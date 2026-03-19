import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_PUBLIC_KEY =
  process.env.SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY) {
  throw new Error('Frontend Supabase compatibility routes require SUPABASE_URL and a Supabase API key.');
}

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1),
});

const resendSchema = z.object({
  type: z.enum(['signup', 'email_change', 'sms', 'phone_change']),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(1).optional(),
  options: z
    .object({
      emailRedirectTo: z.string().trim().url().optional(),
      captchaToken: z.string().trim().min(1).optional(),
    })
    .optional(),
});

const updateUserSchema = z.object({
  attributes: z.record(z.any()),
  options: z
    .object({
      emailRedirectTo: z.string().trim().url().optional(),
    })
    .optional(),
  refreshToken: z.string().trim().min(1),
});

const rpcSchema = z.object({
  fn: z.string().trim().min(1).max(120),
  args: z.record(z.any()).optional(),
});

const querySchema = z.object({
  table: z.string().trim().min(1).max(160),
  operations: z
    .array(
      z.object({
        type: z.string().trim().min(1).max(64),
        payload: z.any().optional(),
      })
    )
    .default([]),
});

const getBearerToken = (authorizationHeader: string | undefined) => {
  const header = (authorizationHeader || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
};

const createUserScopedClient = (accessToken: string) =>
  createClient(SUPABASE_URL!, SUPABASE_PUBLIC_KEY!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

const normalizeErrorPayload = (error: any) =>
  error
    ? {
        message: String(error.message || 'Request failed'),
        details: typeof error.details === 'string' ? error.details : '',
        hint: typeof error.hint === 'string' ? error.hint : '',
        code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
      }
    : null;

const applyQueryOperation = (query: any, operation: { type?: string; payload?: any }) => {
  const payload = operation.payload && typeof operation.payload === 'object' ? operation.payload : {};

  switch (operation.type) {
    case 'select':
      return query.select(typeof payload.columns === 'string' && payload.columns.trim() ? payload.columns : '*', payload.options);
    case 'eq':
      return query.eq(payload.column, payload.value);
    case 'neq':
      return query.neq(payload.column, payload.value);
    case 'gt':
      return query.gt(payload.column, payload.value);
    case 'gte':
      return query.gte(payload.column, payload.value);
    case 'lt':
      return query.lt(payload.column, payload.value);
    case 'lte':
      return query.lte(payload.column, payload.value);
    case 'in':
      return query.in(payload.column, Array.isArray(payload.values) ? payload.values : []);
    case 'is':
      return query.is(payload.column, payload.value);
    case 'not':
      return query.not(payload.column, payload.operator, payload.value);
    case 'or':
      return query.or(String(payload.filters || ''), payload.options);
    case 'match':
      return query.match(payload.values || {});
    case 'contains':
      return query.contains(payload.column, payload.value);
    case 'containedBy':
      return query.containedBy(payload.column, payload.value);
    case 'overlaps':
      return query.overlaps(payload.column, payload.value);
    case 'like':
      return query.like(payload.column, payload.pattern);
    case 'ilike':
      return query.ilike(payload.column, payload.pattern);
    case 'order':
      return query.order(payload.column, payload.options);
    case 'limit':
      return query.limit(payload.count, payload.options);
    case 'range':
      return query.range(payload.from, payload.to, payload.options);
    case 'single':
      return query.single();
    case 'maybeSingle':
      return query.maybeSingle();
    default:
      throw new Error(`Unsupported query operation: ${operation.type}`);
  }
};

router.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid login payload' });
  }

  const { email, password } = parsed.data;
  const { data, error } = await supabaseAdmin.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error) {
    return res.status(401).json({ error: error.message || 'Invalid login credentials' });
  }

  return res.json({
    data: {
      session: data.session ?? null,
      user: data.user ?? data.session?.user ?? null,
    },
    error: null,
  });
});

router.post('/auth/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid refresh payload' });
  }

  const { data, error } = await supabaseAdmin.auth.refreshSession({
    refresh_token: parsed.data.refreshToken,
  });

  if (error) {
    return res.status(401).json({ error: error.message || 'Unable to refresh session' });
  }

  return res.json({
    data: {
      session: data.session ?? null,
      user: data.user ?? data.session?.user ?? null,
    },
    error: null,
  });
});

router.post('/auth/logout', async (req, res) => {
  const accessToken = getBearerToken(req.header('authorization'));
  if (accessToken) {
    await supabaseAdmin.auth.admin.signOut(accessToken).catch(() => null);
  }

  return res.json({ error: null });
});

router.post('/auth/resend', async (req, res) => {
  const parsed = resendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid resend payload' });
  }

  const { data, error } = await supabaseAdmin.auth.resend(parsed.data as any);
  if (error) {
    return res.status(400).json({ error: error.message || 'Unable to resend verification message' });
  }

  return res.json({
    data: data ?? {},
    error: null,
  });
});

router.patch('/auth/user', requireUser, async (req, res) => {
  const accessToken = getBearerToken(req.header('authorization'));
  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid user update payload' });
  }

  const userClient = createUserScopedClient(accessToken);
  const sessionResult = await userClient.auth.setSession({
    access_token: accessToken,
    refresh_token: parsed.data.refreshToken,
  });

  if (sessionResult.error) {
    return res.status(401).json({ error: sessionResult.error.message || 'Unable to establish user session' });
  }

  const { data, error } = await userClient.auth.updateUser(parsed.data.attributes as any, parsed.data.options);
  if (error) {
    return res.status(400).json({ error: error.message || 'Unable to update user' });
  }

  return res.json({
    data: {
      user: data.user ?? null,
    },
    error: null,
  });
});

router.post('/rpc', requireUser, async (req, res) => {
  const accessToken = getBearerToken(req.header('authorization'));
  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = rpcSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid RPC payload' });
  }

  const userClient = createUserScopedClient(accessToken);
  const { data, error, count, status, statusText } = await userClient.rpc(parsed.data.fn, parsed.data.args || {});
  return res.json({
    data: data ?? null,
    error: normalizeErrorPayload(error),
    count: count ?? null,
    status: typeof status === 'number' ? status : error ? 400 : 200,
    statusText: typeof statusText === 'string' && statusText ? statusText : error ? 'Bad Request' : 'OK',
  });
});

router.post('/query', requireUser, async (req, res) => {
  const accessToken = getBearerToken(req.header('authorization'));
  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = querySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query payload' });
  }

  try {
    const userClient = createUserScopedClient(accessToken);
    let query: any = userClient.from(parsed.data.table);

    for (const operation of parsed.data.operations) {
      query = applyQueryOperation(query, operation);
    }

    const result = await query;
    return res.json({
      data: result?.data ?? null,
      error: normalizeErrorPayload(result?.error),
      count: result?.count ?? null,
      status: typeof result?.status === 'number' ? result.status : result?.error ? 400 : 200,
      statusText:
        typeof result?.statusText === 'string' && result.statusText
          ? result.statusText
          : result?.error
            ? 'Bad Request'
            : 'OK',
    });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Unable to execute query' });
  }
});

export default router;
