import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlatformActivitySearchClauses,
  buildPlatformFailureFilter,
} from '../../services/platformActivityFilters';

test('buildPlatformActivitySearchClauses returns searchable audit fields', () => {
  assert.deepEqual(buildPlatformActivitySearchClauses('doctor queue'), [
    'event_name.ilike.%doctor queue%',
    'page_path.ilike.%doctor queue%',
    'actor_email.ilike.%doctor queue%',
    'error_message.ilike.%doctor queue%',
  ]);
});

test('buildPlatformFailureFilter includes API request failures even without search', () => {
  assert.equal(buildPlatformFailureFilter(''), 'category.eq.error,event_name.eq.api.request.failed');
});

test('buildPlatformFailureFilter keeps failure matching and text search in the same filter', () => {
  assert.equal(
    buildPlatformFailureFilter('nurse dashboard'),
    [
      'and(category.eq.error,or(event_name.ilike.%nurse dashboard%,page_path.ilike.%nurse dashboard%,actor_email.ilike.%nurse dashboard%,error_message.ilike.%nurse dashboard%))',
      'and(event_name.eq.api.request.failed,or(event_name.ilike.%nurse dashboard%,page_path.ilike.%nurse dashboard%,actor_email.ilike.%nurse dashboard%,error_message.ilike.%nurse dashboard%))',
    ].join(',')
  );
});
