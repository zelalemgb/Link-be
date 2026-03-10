import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachStructuredPayloadToNoteText,
  buildHewStructuredPayload,
  extractStructuredNoteFields,
} from '../../services/hewStructuredNoteService';

test('structured HEW payload round-trips through note text marker', () => {
  const payload = buildHewStructuredPayload({
    guidedProtocol: { id: 'respiratory', title: 'Respiratory symptoms' },
    guidedAnswers: { chest_indrawing: true, fast_breathing: true },
    dangerSigns: { breathing_problem: true },
    referralSummary: { urgency: 'emergency', reason: 'Chest indrawing' },
    agentGuidance: { source: 'link_agent_generated', urgency: 'emergency' },
  });

  assert.ok(payload);

  const stored = attachStructuredPayloadToNoteText('Patient in distress', payload as Record<string, unknown>);
  assert.match(stored, /\[link_hew_structured:/);

  const parsed = extractStructuredNoteFields(stored);
  assert.equal(parsed.noteText, 'Patient in distress');
  assert.equal((parsed.guidedProtocol as any)?.id, 'respiratory');
  assert.equal((parsed.dangerSigns as any)?.breathing_problem, true);
  assert.equal((parsed.referralSummary as any)?.urgency, 'emergency');
});

test('structured marker helper respects note length limits', () => {
  const payload = buildHewStructuredPayload({
    guidedProtocol: { id: 'fever', title: 'Fever follow-up' },
    guidedAnswers: { fever_very_high: true },
  });

  const longNote = 'x'.repeat(6000);
  const stored = attachStructuredPayloadToNoteText(longNote, payload as Record<string, unknown>);

  assert.ok(stored.length <= 4000);
  const parsed = extractStructuredNoteFields(stored);
  assert.equal((parsed.guidedProtocol as any)?.id, 'fever');
});
