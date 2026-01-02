-- Phase 4: Facility-level user management helpers for clinic admins
-- Clinic admins can manage users only within their own facility.

create or replace function public.facility_admin_update_roles(
  p_user_id uuid,
  p_roles text[],
  p_reason text default null
) returns void
language plpgsql
security definer
as $$
declare
  v_actor users%rowtype;
  v_target users%rowtype;
  v_old_roles text[];
  v_new_roles text[];
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() limit 1;
  if v_actor.id is null or v_actor.user_role <> 'clinic_admin' then
    raise exception 'Not authorized';
  end if;

  select * into v_target from public.users where id = p_user_id;
  if v_target.id is null then
    raise exception 'Target user not found';
  end if;
  if v_target.facility_id <> v_actor.facility_id then
    raise exception 'Cannot manage users outside your facility';
  end if;

  -- Prevent escalation to super_admin
  if array_position(p_roles, 'super_admin') is not null then
    raise exception 'Cannot assign super_admin role';
  end if;

  select array_agg(r.name) into v_old_roles
  from public.user_roles ur
  join public.roles r on ur.role_id = r.id
  where ur.user_id = p_user_id;

  delete from public.user_roles where user_id = p_user_id;

  insert into public.user_roles(user_id, role_id)
  select p_user_id, r.id
  from public.roles r
  where r.name = any(p_roles)
    and r.name <> 'super_admin';

  select array_agg(r.name) into v_new_roles
  from public.user_roles ur
  join public.roles r on ur.role_id = r.id
  where ur.user_id = p_user_id;

  insert into public.user_role_changes(
    user_id, facility_id, tenant_id, old_roles, new_roles, changed_by, reason, created_at
  )
  values (
    p_user_id, v_target.facility_id, v_target.tenant_id,
    coalesce(v_old_roles,'{}'), coalesce(v_new_roles,'{}'),
    v_actor.id,
    coalesce(p_reason, 'updated by clinic admin'),
    now()
  );
end;
$$;

create or replace function public.facility_admin_toggle_user_active(
  p_user_id uuid,
  p_is_active boolean,
  p_reason text default null
) returns void
language plpgsql
security definer
as $$
declare
  v_actor users%rowtype;
  v_target users%rowtype;
begin
  select * into v_actor from public.users where auth_user_id = auth.uid() limit 1;
  if v_actor.id is null or v_actor.user_role <> 'clinic_admin' then
    raise exception 'Not authorized';
  end if;

  select * into v_target from public.users where id = p_user_id;
  if v_target.id is null then
    raise exception 'Target user not found';
  end if;
  if v_target.facility_id <> v_actor.facility_id then
    raise exception 'Cannot manage users outside your facility';
  end if;

  update public.users
  set is_active = p_is_active,
      deactivated_at = case when p_is_active then null else now() end,
      updated_at = now()
  where id = p_user_id;

  insert into public.user_role_changes(
    user_id, facility_id, tenant_id, old_roles, new_roles, changed_by, reason, created_at
  )
  values (
    p_user_id, v_target.facility_id, v_target.tenant_id,
    null, null,
    v_actor.id,
    coalesce(p_reason, case when p_is_active then 'reactivated by clinic admin' else 'deactivated by clinic admin' end),
    now()
  );
end;
$$;

