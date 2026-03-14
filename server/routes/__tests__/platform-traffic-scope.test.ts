import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPlatformTraffic,
  matchesPlatformTrafficScope,
  resolvePlatformTrafficScope,
} from '../../services/platformTrafficScope';

test('resolvePlatformTrafficScope defaults to production', () => {
  assert.equal(resolvePlatformTrafficScope(undefined), 'production');
  assert.equal(resolvePlatformTrafficScope(''), 'production');
  assert.equal(resolvePlatformTrafficScope('production'), 'production');
});

test('classifyPlatformTraffic marks localhost rows as local', () => {
  assert.equal(
    classifyPlatformTraffic({
      referrer: 'http://localhost:5173/dashboard',
      metadata: { app_origin: 'http://localhost:5173' },
    }),
    'local'
  );
});

test('classifyPlatformTraffic marks linkhc rows as production', () => {
  assert.equal(
    classifyPlatformTraffic({
      referrer: 'https://linkhc.org/dashboard',
      metadata: { app_origin: 'https://linkhc.org', environment: 'production' },
    }),
    'production'
  );
});

test('matchesPlatformTrafficScope excludes localhost rows from production scope', () => {
  const localRow = {
    referrer: 'http://127.0.0.1:5173/dashboard',
    metadata: { app_origin: 'http://127.0.0.1:5173', environment: 'local' },
  };

  assert.equal(matchesPlatformTrafficScope(localRow, 'production'), false);
  assert.equal(matchesPlatformTrafficScope(localRow, 'local'), true);
  assert.equal(matchesPlatformTrafficScope(localRow, 'all'), true);
});
