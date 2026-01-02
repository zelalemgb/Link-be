-- Phase 6: Rollout/backfill for user management
-- - Backfill existing users to is_active = true where missing
-- - Clear deactivated_at for active users

update public.users
set is_active = coalesce(is_active, true),
    deactivated_at = case when coalesce(is_active, true) then null else deactivated_at end
where true;

-- No-op if already set; keeps backward compatibility with existing rows.

