-- Phase 2: Admin helper functions for user management
-- Functions assume caller is super_admin (RLS/policies will enforce).

-- Helper: validate facility belongs to tenant
create or replace function public.facility_belongs_to_tenant(p_facility uuid, p_tenant uuid)
returns boolean
language sql
as $$
  select exists (
    select 1 from facilities f
    where f.id = p_facility
      and f.tenant_id = p_tenant
  );
$$;

-- Admin: create a user row with facility + tenant + roles
create or replace function public.admin_create_user_row(
  p_auth_user_id uuid,
  p_facility_id uuid,
  p_tenant_id uuid,
  p_user_role text,
  p_roles text[] default '{}'
) returns uuid
language plpgsql
security definer
as $$
declare
  v_user_id uuid;
begin
  if not is_super_admin() then
    raise exception 'Not authorized';
  end if;

  if not facility_belongs_to_tenant(p_facility_id, p_tenant_id) then
    raise exception 'Facility does not belong to tenant';
  end if;

  insert into public.users (auth_user_id, facility_id, tenant_id, user_role, created_at, updated_at)
  values (p_auth_user_id, p_facility_id, p_tenant_id, p_user_role, now(), now())
  returning id into v_user_id;

  -- seed roles if provided
  if array_length(p_roles,1) is not null then
    insert into public.user_roles(user_id, role_id)
    select v_user_id, r.id
    from public.roles r
    where r.name = any(p_roles);
  end if;

  return v_user_id;
end;
$$;

-- Admin: update roles (overwrites existing), logs audit
create or replace function public.admin_update_roles(
  p_user_id uuid,
  p_roles text[],
  p_reason text default null
) returns void
language plpgsql
security definer
as $$
declare
  v_old_roles text[];
  v_new_roles text[];
  v_facility uuid;
  v_tenant uuid;
  v_user uuid;
begin
  if not is_super_admin() then
    raise exception 'Not authorized';
  end if;

  select user_role, facility_id, tenant_id into v_user, v_facility, v_tenant from public.users where id = p_user_id;
  if v_facility is null then
    raise exception 'User not found';
  end if;

  select array_agg(r.name) into v_old_roles
  from public.user_roles ur
  join public.roles r on ur.role_id = r.id
  where ur.user_id = p_user_id;

  delete from public.user_roles where user_id = p_user_id;

  insert into public.user_roles(user_id, role_id)
  select p_user_id, r.id
  from public.roles r
  where r.name = any(p_roles);

  select array_agg(r.name) into v_new_roles
  from public.user_roles ur
  join public.roles r on ur.role_id = r.id
  where ur.user_id = p_user_id;

  insert into public.user_role_changes(
    user_id, facility_id, tenant_id, old_roles, new_roles, changed_by, reason, created_at
  ) values (
    p_user_id, v_facility, v_tenant, coalesce(v_old_roles,'{}'), coalesce(v_new_roles,'{}'),
    (select id from public.users where auth_user_id = auth.uid() limit 1),
    p_reason, now()
  );
end;
$$;

-- Admin: deactivate/reactivate user
create or replace function public.admin_toggle_user_active(
  p_user_id uuid,
  p_is_active boolean,
  p_reason text default null
) returns void
language plpgsql
security definer
as $$
begin
  if not is_super_admin() then
    raise exception 'Not authorized';
  end if;

  update public.users
  set is_active = p_is_active,
      deactivated_at = case when p_is_active then null else now() end,
      updated_at = now()
  where id = p_user_id;

  -- Optional: log in role_changes for visibility
  insert into public.user_role_changes(
    user_id, facility_id, tenant_id, old_roles, new_roles, changed_by, reason, created_at
  )
  select
    u.id, u.facility_id, u.tenant_id,
    null, null,
    (select id from public.users where auth_user_id = auth.uid() limit 1),
    coalesce(p_reason, case when p_is_active then 'reactivated' else 'deactivated' end),
    now()
  from public.users u
  where u.id = p_user_id;
end;
$$;

-- Admin: reassign facility (and tenant) for a user
create or replace function public.admin_reassign_facility(
  p_user_id uuid,
  p_facility_id uuid,
  p_tenant_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer
as $$
begin
  if not is_super_admin() then
    raise exception 'Not authorized';
  end if;

  if not facility_belongs_to_tenant(p_facility_id, p_tenant_id) then
    raise exception 'Facility does not belong to tenant';
  end if;

  update public.users
  set facility_id = p_facility_id,
      tenant_id = p_tenant_id,
      updated_at = now()
  where id = p_user_id;

  insert into public.user_role_changes(
    user_id, facility_id, tenant_id, old_roles, new_roles, changed_by, reason, created_at
  )
  values (
    p_user_id, p_facility_id, p_tenant_id, null, null,
    (select id from public.users where auth_user_id = auth.uid() limit 1),
    coalesce(p_reason, 'facility reassigned'),
    now()
  );
end;
$$;

