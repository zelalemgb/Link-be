# Database Tracker (Supabase SQL / DB Gate Evidence)

Owner: Database Owner

## Current Focus
- W2-DB-020: op ledger + cursor + conflict audit tables + indexes
- W2-DB-021: tombstones/versioning strategy for synced entities
- W2-DB-022: RLS policies + SQL tests for sync isolation

## Deliverables (Wave Start)
- DB primitives for pull-by-cursor that are fast and deterministic
- Conflict audit table ready for LWW "losing value" capture

## Migration List
- /Users/zola/Documents/My Projects/Link/Link/link-be/supabase/migrations/20260217150000_w2_sync_primitives_op_ledger_cursor_conflict_audit_tombstones.sql

## Evidence (Commands + Results)
### Local SQL run (2026-02-17 07:38:24 UTC) - temp Postgres on port 55432
Commands executed:
- `lsof -nP -iTCP:55432 -sTCP:LISTEN`
- `mktemp -d` (TMP_ROOT=`/var/folders/h4/tbzs5q8s19v29bn3lvcyr_3r0000gn/T/tmp.QquGQvcMs2`)
- `date -u`
- `/opt/homebrew/opt/postgresql@16/bin/initdb -D /var/folders/h4/tbzs5q8s19v29bn3lvcyr_3r0000gn/T/tmp.QquGQvcMs2/pgdata -U postgres -A trust --no-locale`
- `/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D /var/folders/h4/tbzs5q8s19v29bn3lvcyr_3r0000gn/T/tmp.QquGQvcMs2/pgdata -o "-p 55432 -k /var/folders/h4/tbzs5q8s19v29bn3lvcyr_3r0000gn/T/tmp.QquGQvcMs2 -h 127.0.0.1" -w start`
- `/opt/homebrew/opt/postgresql@16/bin/createdb -h 127.0.0.1 -p 55432 -U postgres link_sql_tests`
- `/opt/homebrew/opt/postgresql@16/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d link_sql_tests -v ON_ERROR_STOP=1 -f link-be/supabase/tests/w2_sync_primitives_cursor_rls_and_index_proof.test.sql`
- `/opt/homebrew/opt/postgresql@16/bin/psql -h 127.0.0.1 -p 55432 -U postgres -d link_sql_tests -v ON_ERROR_STOP=1 -f link-be/supabase/tests/tenant_rls_isolation.test.sql`
- `/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D /var/folders/h4/tbzs5q8s19v29bn3lvcyr_3r0000gn/T/tmp.QquGQvcMs2/pgdata -m fast -w stop`
- `rm -rf /var/folders/h4/tbzs5q8s19v29bn3lvcyr_3r0000gn/T/tmp.QquGQvcMs2`
- `lsof -nP -iTCP:55432 -sTCP:LISTEN`

Results:
- PASS: /Users/zola/Documents/My Projects/Link/Link/link-be/supabase/tests/w2_sync_primitives_cursor_rls_and_index_proof.test.sql
- PASS: /Users/zola/Documents/My Projects/Link/Link/link-be/supabase/tests/tenant_rls_isolation.test.sql

Cleanup confirmation:
- Port `55432` free after run; temp `mktemp` dir removed.

Index-backed query proof:
- `EXPLAIN (FORMAT JSON)` assertions in
  `/Users/zola/Documents/My Projects/Link/Link/link-be/supabase/tests/w2_sync_primitives_cursor_rls_and_index_proof.test.sql`
  confirm pull-by-cursor uses `idx_sync_op_ledger_tenant_revision`
  and tombstone pull uses `idx_sync_tombstones_tenant_deleted_revision`.

## Early Hand-off Needed
Backend cursor semantics decision required:
- `revision` cursor (per-tenant monotonic bigint; implemented via `public.allocate_sync_revision(tenant_id)`)
- timestamp cursor (requires tie-breaker + careful commit-order handling)
