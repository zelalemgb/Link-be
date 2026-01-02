-- Phase 1: User management schema hardening
-- - Add activation columns to users
-- - Add audit table for role changes

-- 1) Add activation flags to users
alter table public.users
  add column if not exists is_active boolean not null default true,
  add column if not exists deactivated_at timestamptz;

-- 2) Audit table for role changes
create table if not exists public.user_role_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  facility_id uuid references public.facilities(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete set null,
  old_roles text[] default '{}',
  new_roles text[] default '{}',
  changed_by uuid references public.users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_role_changes_user on public.user_role_changes(user_id);
create index if not exists idx_user_role_changes_facility on public.user_role_changes(facility_id);
create index if not exists idx_user_role_changes_tenant on public.user_role_changes(tenant_id);
create index if not exists idx_user_role_changes_created_at on public.user_role_changes(created_at);

-- 3) RLS for audit table: restrict to super_admins by default
alter table public.user_role_changes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_role_changes'
      and policyname = 'Super admins can view role changes'
  ) then
    create policy "Super admins can view role changes"
    on public.user_role_changes
    for select
    using (is_super_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_role_changes'
      and policyname = 'Super admins can insert role changes'
  ) then
    create policy "Super admins can insert role changes"
    on public.user_role_changes
    for insert
    with check (is_super_admin());
  end if;
end$$;

