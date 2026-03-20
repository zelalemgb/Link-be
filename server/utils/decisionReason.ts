import type { Response } from 'express';

const DECISION_REASON_HEADER = 'X-Server-Decision-Reason';

const sanitizeDecisionReason = (value: string | null | undefined) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || null;
};

export const setServerDecisionReason = (res: Response, reason: string | null | undefined) => {
  const normalized = sanitizeDecisionReason(reason);
  if (!normalized) return res;
  res.setHeader(DECISION_REASON_HEADER, normalized);
  return res;
};

export const respondWithDecisionReason = (
  res: Response,
  status: number,
  body: Record<string, unknown>,
  reason: string | null | undefined
) => {
  setServerDecisionReason(res, reason);
  return res.status(status).json(body);
};

export const getDecisionReasonHeaderName = () => DECISION_REASON_HEADER;
