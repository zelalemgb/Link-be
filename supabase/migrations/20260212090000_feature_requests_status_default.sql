-- Ensure feature request status defaults to submitted and backfill nulls
alter table public.feature_requests
  alter column status set default 'submitted';

update public.feature_requests
set status = 'submitted'
where status is null;
