import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../config/supabase';
import { recordAuthFailure } from '../services/monitoring';

const sessionSecret = process.env.PATIENT_SESSION_SECRET || '';

export interface PatientSession {
  patientAccountId: string;
  phoneNumber: string;
  tenantId?: string;
  authMethod: 'bearer' | 'cookie';
}

declare global {
  namespace Express {
    interface Request {
      patient?: PatientSession;
    }
  }
}

const extractPatientToken = (req: Request) => {
  const header = req.header('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return { token: header.slice(7), source: 'bearer' as const };
  }

  const cookieToken = req.cookies?.patient_session;
  if (cookieToken) {
    return { token: cookieToken, source: 'cookie' as const };
  }

  return { token: undefined, source: undefined };
};

export const requirePatientSession = async (req: Request, res: Response, next: NextFunction) => {
  if (!sessionSecret) {
    return res.status(500).json({ error: 'Patient session not configured' });
  }

  const { token, source } = extractPatientToken(req);
  if (!token || !source) {
    recordAuthFailure(req.requestId);
    return res.status(401).json({ error: 'Missing patient session' });
  }

  let payload: { patientId: string; phoneNumber: string };
  try {
    payload = jwt.verify(token, sessionSecret) as { patientId: string; phoneNumber: string };
  } catch (error) {
    recordAuthFailure(req.requestId);
    return res.status(401).json({ error: 'Invalid patient session' });
  }

  try {
    const { data: account, error } = await supabaseAdmin
      .from('patient_accounts')
      .select('id, phone_number, tenant_id')
      .eq('id', payload.patientId)
      .maybeSingle();

    if (error || !account) {
      recordAuthFailure(req.requestId);
      return res.status(401).json({ error: 'Invalid patient session' });
    }

    if (account.phone_number !== payload.phoneNumber) {
      recordAuthFailure(req.requestId);
      return res.status(401).json({ error: 'Invalid patient session' });
    }

    req.patient = {
      patientAccountId: account.id,
      phoneNumber: account.phone_number,
      tenantId: account.tenant_id || undefined,
      authMethod: source,
    };

    return next();
  } catch (error) {
    return res.status(500).json({ error: 'Unable to validate patient session' });
  }
};

export const requirePatientCsrf = (req: Request, res: Response, next: NextFunction) => {
  if (!req.patient) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.patient.authMethod !== 'cookie') {
    return next();
  }

  const csrfCookie = req.cookies?.patient_csrf;
  const csrfHeader = req.header('x-csrf-token');
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  return next();
};
