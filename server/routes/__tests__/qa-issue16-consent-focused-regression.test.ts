import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const patientPortalRoutePath = path.resolve(__dirname, '../patient-portal.ts');
const patientPortalConsentServicePath = path.resolve(__dirname, '../../services/patientPortalConsentService.ts');
const patientAuthRoutePath = path.resolve(__dirname, '../patient-auth.ts');

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('QA-P0-CONSENT-001 grant access allowed under correct scope', () => {
  const routeSource = read(patientPortalRoutePath);
  const serviceSource = read(patientPortalConsentServicePath);
  assert.match(
    routeSource,
    /router\.post\('\/consents\/grant'/,
    'Expected patient portal consent grant route to exist'
  );
  assert.match(
    serviceSource,
    /PERM_CONSENT_\$\{action\.toUpperCase\(\)\}_FORBIDDEN|'TENANT_RESOURCE_SCOPE_VIOLATION'/,
    'Expected scoped consent-grant enforcement codes to exist'
  );
});

test('QA-P0-CONSENT-002 revoke blocks access immediately', () => {
  const routeSource = read(patientPortalRoutePath);
  const serviceSource = read(patientPortalConsentServicePath);
  assert.match(
    routeSource,
    /router\.post\('\/consents\/revoke'/,
    'Expected patient portal consent revoke route to exist'
  );
  assert.match(
    serviceSource,
    /'CONFLICT_CONSENT_ACCESS_REVOKED'|'PERM_CONSENT_REVOKED'/,
    'Expected explicit revoke-immediate block code to exist'
  );
});

test('QA-P0-CONSENT-003 cross-tenant access denied', () => {
  const source = read(patientPortalConsentServicePath);
  assert.match(source, /\.eq\('tenant_id', scopedActor\.tenantId\)/, 'Expected tenant scoping predicate for consent operations');
  assert.match(
    source,
    /'TENANT_RESOURCE_SCOPE_VIOLATION'/,
    'Expected explicit cross-tenant denial contract code for consent paths'
  );
});

test('QA-P0-CONSENT-004 history reflects grant/revoke chronology correctly', () => {
  const routeSource = read(patientPortalRoutePath);
  const serviceSource = read(patientPortalConsentServicePath);
  assert.match(
    routeSource,
    /router\.get\('\/consents\/history'/,
    'Expected consent history endpoint to exist'
  );
  assert.match(
    serviceSource,
    /\.order\('created_at', \{ ascending: true \}\)/,
    'Expected consent history chronology ordering by created_at ASC'
  );
});

test('QA-P0-CONSENT-005 grant requires comprehension fields', () => {
  const source = read(patientPortalConsentServicePath);
  assert.match(source, /comprehensionText:\s*z\.string\(\)\.trim\(\)\.min\(/);
  assert.match(source, /comprehensionConfirmed:\s*z\.literal\(true\)/);
});

test('QA-P0-CONSENT-006 revoke requires acknowledgement', () => {
  const source = read(patientPortalConsentServicePath);
  assert.match(source, /acknowledged:\s*z\.literal\(true\)/);
});

test('QA-P0-CONSENT-007 high-risk override requires reason', () => {
  const source = read(patientPortalConsentServicePath);
  assert.match(source, /highRiskOverride:\s*z\.boolean\(\)/);
  assert.match(source, /overrideReason:\s*z\.string\(\)\.trim\(\)/);
  assert.match(source, /\.superRefine\(/);
  assert.match(source, /overrideReason is required/);
});

test('QA-P0-CONSENT-008 provider read is gated by consent (deny->allow->deny after revoke)', () => {
  const source = read(patientPortalConsentServicePath);
  assert.match(source, /export const assertPatientPortalConsentActiveForProviderRead/);
  assert.match(source, /\.from\('patient_portal_consents'\)/);
  assert.match(source, /\.eq\('is_active', true\)/);
});

test('QA-P0-AUTH-001 patient register is blocked unless phone verification (OTP) is satisfied', () => {
  const source = read(patientAuthRoutePath);
  assert.match(source, /const patientRegisterSchema = z\.object\([\s\S]*otp:\s*z\.string\(\)\.regex/);
  assert.match(source, /router\.post\('\/register'/);
  assert.match(source, /\.from\('patient_auth_otps'\)[\s\S]*?\.select\('id, code_hash, attempts, expires_at'\)/);
  assert.match(source, /\.from\('patient_portal_phone_verifications'\)/, 'Expected durable phone verification table check');
 });

test('QA-P0-CONSENT-009 consent audit is strict + durable (outbox fallback)', () => {
  const source = read(patientPortalConsentServicePath);
  assert.match(source, /strict:\s*true/, 'Expected strict audit mode for consent events');
  assert.match(source, /outboxEventType:\s*'audit\.patient_consent\./, 'Expected consent outbox event type namespaces');
});
