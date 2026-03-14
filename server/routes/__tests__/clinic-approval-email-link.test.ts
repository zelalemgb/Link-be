import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const reviewSource = readFileSync(
  path.resolve(process.cwd(), 'supabase/functions/review-clinic-registration/index.ts'),
  'utf8'
);
const approvalSource = readFileSync(
  path.resolve(process.cwd(), 'supabase/functions/send-clinic-approval-email/index.ts'),
  'utf8'
);

test('clinic approval email links use BrowserRouter onboarding path', () => {
  assert.match(reviewSource, /\/auth\/clinic-onboarding\?facility=/);
  assert.match(approvalSource, /\/auth\/clinic-onboarding\?facility=/);
  assert.doesNotMatch(reviewSource, /\/#\/auth\/clinic-onboarding/);
  assert.doesNotMatch(approvalSource, /\/#\/auth\/clinic-onboarding/);
});
