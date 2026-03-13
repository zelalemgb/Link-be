import test from 'node:test';
import assert from 'node:assert/strict';

import { isTransientSupabaseTransportError } from '../supabaseTransportError';

test('detects transient Supabase transport failures', () => {
  assert.equal(isTransientSupabaseTransportError('TypeError: fetch failed'), true);
  assert.equal(isTransientSupabaseTransportError('socket hang up while calling Supabase'), true);
  assert.equal(isTransientSupabaseTransportError(new Error('network timeout reached')), true);
});

test('does not flag non-transport validation errors as transient', () => {
  assert.equal(isTransientSupabaseTransportError('duplicate key value violates unique constraint'), false);
  assert.equal(isTransientSupabaseTransportError('invalid input syntax for type uuid'), false);
});
