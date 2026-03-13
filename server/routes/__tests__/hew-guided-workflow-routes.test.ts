import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('HEW route supports guided structured note payload and facility patient list', () => {
  const source = read(path.resolve(__dirname, '../hew.ts'));

  assert.match(source, /router\.get\('\/facility-patients'/);
  assert.match(source, /guided_protocol/);
  assert.match(source, /guided_answers/);
  assert.match(source, /danger_signs/);
  assert.match(source, /referral_summary/);
  assert.match(source, /agent_guidance/);
  assert.match(source, /attachStructuredPayloadToNoteText/);
  assert.match(source, /serializeCommunityNote/);
});

test('HEW caseload route returns latest note context for field prioritization', () => {
  const source = read(path.resolve(__dirname, '../hew.ts'));

  assert.match(source, /router\.get\('\/caseload'/);
  assert.match(source, /select\('patient_id, follow_up_due, note_type, note_text, flags, location, visit_date, created_at'\)/);
  assert.match(source, /latest_note_type/);
  assert.match(source, /latest_note_text/);
  assert.match(source, /latest_flags/);
  assert.match(source, /latest_location/);
  assert.match(source, /extractStructuredNoteFields\(row\.note_text \|\| ''\)/);
});

test('patient pre-visit context maps structured HEW referral metadata for clinicians', () => {
  const source = read(path.resolve(__dirname, '../patients.ts'));

  assert.match(source, /extractStructuredNoteFields/);
  assert.match(source, /note_type, note_text, flags/);
  assert.match(source, /referral_summary: structured\.referralSummary/);
  assert.match(source, /guided_protocol: structured\.guidedProtocol/);
  assert.match(source, /agent_guidance: structured\.agentGuidance/);
});
