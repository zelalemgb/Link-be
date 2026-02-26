import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve(__dirname, '../../index.ts');
const source = fs.readFileSync(indexPath, 'utf8');

test('feature request list endpoints enrich related metadata without brittle FK-join selectors', () => {
  assert.match(source, /const enrichFeatureRequestRows = async/);
  assert.match(source, /const getAuthUserProfileIds = async \(authUserId: string\)/);
  assert.match(source, /const getFeatureRequestActorIds = async \(authUserId: string, profileId\?: string\)/);
  assert.match(source, /const resolveFeatureRequestAuthor = async/);
  assert.match(source, /app\.get\('\/api\/feature-requests\/me', requireUser/);
  assert.match(source, /app\.get\('\/api\/feature-requests', requireUser/);
  assert.match(source, /app\.get\('\/api\/feature-requests\/community', requireUser/);
  assert.match(source, /const enriched = await enrichFeatureRequestRows\(\(data \|\| \[\]\) as FeatureRequestRow\[\]\);/);
  assert.match(source, /app\.post\('\/api\/feature-requests', requireUser, async \(req, res\) => \{/);
  assert.match(source, /const author = await resolveFeatureRequestAuthor\(req\);/);
  assert.match(source, /if \(author\.role !== 'super_admin' && !author\.facilityId\)/);
  const mySuggestionsHandler = source.match(
    /app\.get\('\/api\/feature-requests\/me', requireUser, async \(req, res\) => \{[\s\S]*?\n\}\);\n\napp\.get\('\/api\/feature-requests', requireUser/
  )?.[0];
  assert.ok(mySuggestionsHandler, 'expected /api/feature-requests/me handler block');
  assert.match(mySuggestionsHandler, /const actorIds = await getFeatureRequestActorIds\(authUserId, req\.user\?\.profileId\);/);
  assert.match(mySuggestionsHandler, /\.in\('user_id', actorIds\)/);
  assert.match(source, /feature request enrichment fallback used/);

  // Guard against relation-selector drift that can break loading in some DB environments.
  assert.doesNotMatch(source, /users:users!feature_requests_user_id_fkey/);
  assert.doesNotMatch(mySuggestionsHandler, /\.eq\('user_id', profileId\)/);
});
