-- Admin-only attendee management and stale-action protection (D-143).
-- No policy or client write grant. Each Data API function permits service_role only.
alter table public.membership add column access_version bigint not null default 1
  constraint membership_access_version_check check (access_version > 0);

-- Ignore direct counter writes. Only a role, status or membership lifetime change advances it.
create function public.advance_membership_access_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.role, new.status, new.requested_at) is distinct from
     (old.role, old.status, old.requested_at) then
    new.access_version := old.access_version + 1;
  else
    new.access_version := old.access_version;
  end if;
  return new;
end;
$$;
create trigger membership_access_version_update
before update on public.membership
for each row execute function public.advance_membership_access_version();

-- The creator's row keeps its identity, Admin role and active status (D-102, D-114).
-- Account deletion still cascades; the team handles that case manually under D-114.
create function public.guard_membership_admin()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (old.role = 'admin' and (new.id, new.event_id, new.user_id, new.role, new.status)
      is distinct from (old.id, old.event_id, old.user_id, old.role, old.status))
    or (old.role <> 'admin' and new.role = 'admin') then
    raise exception 'The creator Admin cannot change or be replaced'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger membership_admin_update
before update on public.membership
for each row execute function public.guard_membership_admin();

revoke execute on function public.advance_membership_access_version() from public, anon, authenticated;
revoke execute on function public.guard_membership_admin() from public, anon, authenticated;
grant execute on function public.advance_membership_access_version() to service_role;
grant execute on function public.guard_membership_admin() to service_role;

-- One snapshot for the access check, names and versions. Fetch one extra row for nextCursor.
-- strpos treats %, _ and backslashes as literal text. No avatar or verification column is read.
create function public.list_attendees(
  p_event_id uuid, p_actor_id uuid, p_search text, p_role text,
  p_after_name text, p_after_user_id uuid
)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_actor public.membership%rowtype;
  v_attendees jsonb;
begin
  if not exists (select 1 from public.event e where e.id = p_event_id and e.deleted_at is null) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into v_actor from public.membership m where m.event_id = p_event_id and m.user_id = p_actor_id;
  if not found or v_actor.status <> 'active' then
    return jsonb_build_object('outcome', 'not_member');
  end if;
  if v_actor.role <> 'admin' then
    return jsonb_build_object('outcome', 'wrong_role');
  end if;
  if p_search is null or (p_role is not null and p_role not in ('admin', 'guest', 'photographer'))
    or num_nonnulls(p_after_name, p_after_user_id) = 1 then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'user_id', r.user_id, 'full_name', r.full_name, 'role', r.role,
    'requested_at', r.requested_at, 'access_version', r.access_version::text
  ) order by r.full_name, r.user_id), '[]'::jsonb) into v_attendees
  from (
    select m.id, m.user_id, p.full_name, m.role, m.requested_at, m.access_version
    from public.membership m
    join public.profile p on p.user_id = m.user_id
    where m.event_id = p_event_id and m.status = 'active'
      and (p_role is null or m.role = p_role)
      and strpos(lower(p.full_name), lower(p_search)) > 0
      and (p_after_name is null or (p.full_name, m.user_id) > (p_after_name, p_after_user_id))
    order by p.full_name, m.user_id
    limit 51
  ) r;
  return jsonb_build_object('outcome', 'listed', 'attendees', v_attendees);
end;
$$;

-- Shared implementation for the three action RPCs. The event lock matches join_event and
-- update_event_settings, so a conversion cannot take a place either has already admitted.
-- Lock the target too, so a direct membership update cannot invalidate the checked version
-- between the check and the write. Unrelated membership columns remain unchanged.
create function public.mutate_attendee(
  p_event_id uuid, p_actor_id uuid, p_user_id uuid, p_expected_id uuid,
  p_expected_version bigint, p_action text, p_role text, p_max_guests integer
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_deleted_at timestamptz;
  v_actor public.membership%rowtype;
  v_target public.membership%rowtype;
begin
  select e.deleted_at into v_deleted_at from public.event e
  where e.id = p_event_id for no key update;
  if not found or v_deleted_at is not null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into v_actor from public.membership m
  where m.event_id = p_event_id and m.user_id = p_actor_id;
  if not found or v_actor.status <> 'active' then
    return jsonb_build_object('outcome', 'not_member');
  end if;
  if v_actor.role <> 'admin' then
    return jsonb_build_object('outcome', 'wrong_role');
  end if;
  select * into v_target from public.membership m
  where m.event_id = p_event_id and m.user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_target.role = 'admin' then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  if v_target.status <> 'active' or p_expected_id is distinct from v_target.id
    or p_expected_version is distinct from v_target.access_version then
    return jsonb_build_object('outcome', 'membership_changed');
  end if;
  if p_action is null or p_action not in ('role', 'remove', 'block')
    or (p_action = 'role' and (p_role is null or p_role not in ('guest', 'photographer')
      or p_max_guests is null or p_max_guests < 0)) then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  if p_action = 'role' and p_role <> v_target.role then
    if p_role = 'guest' and (
      select count(*) from public.membership m
      where m.event_id = p_event_id and m.role = 'guest' and m.status = 'active'
    ) >= p_max_guests then
      return jsonb_build_object('outcome', 'event_full');
    end if;
    update public.membership m set role = p_role where m.id = v_target.id returning * into v_target;
  elsif p_action in ('remove', 'block') then
    update public.membership m set status = case p_action when 'remove' then 'removed' else 'blocked' end
    where m.id = v_target.id returning * into v_target;
  end if;
  return jsonb_build_object('outcome', 'updated', 'membership', jsonb_build_object(
    'id', v_target.id, 'user_id', v_target.user_id, 'role', v_target.role,
    'status', v_target.status, 'access_version', v_target.access_version::text
  ));
end;
$$;

create function public.change_attendee_role(
  p_event_id uuid, p_actor_id uuid, p_user_id uuid, p_expected_id uuid,
  p_expected_version bigint, p_role text, p_max_guests integer
)
returns jsonb language sql set search_path = '' as $$
  select public.mutate_attendee(p_event_id, p_actor_id, p_user_id, p_expected_id,
    p_expected_version, 'role', p_role, p_max_guests)
$$;

create function public.remove_attendee(
  p_event_id uuid, p_actor_id uuid, p_user_id uuid, p_expected_id uuid, p_expected_version bigint
)
returns jsonb language sql set search_path = '' as $$
  select public.mutate_attendee(p_event_id, p_actor_id, p_user_id, p_expected_id,
    p_expected_version, 'remove', null, null)
$$;

create function public.block_attendee(
  p_event_id uuid, p_actor_id uuid, p_user_id uuid, p_expected_id uuid, p_expected_version bigint
)
returns jsonb language sql set search_path = '' as $$
  select public.mutate_attendee(p_event_id, p_actor_id, p_user_id, p_expected_id,
    p_expected_version, 'block', null, null)
$$;

revoke execute on function public.list_attendees(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.mutate_attendee(uuid, uuid, uuid, uuid, bigint, text, text, integer) from public, anon, authenticated;
revoke execute on function public.change_attendee_role(uuid, uuid, uuid, uuid, bigint, text, integer) from public, anon, authenticated;
revoke execute on function public.remove_attendee(uuid, uuid, uuid, uuid, bigint) from public, anon, authenticated;
revoke execute on function public.block_attendee(uuid, uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.list_attendees(uuid, uuid, text, text, text, uuid) to service_role;
grant execute on function public.mutate_attendee(uuid, uuid, uuid, uuid, bigint, text, text, integer) to service_role;
grant execute on function public.change_attendee_role(uuid, uuid, uuid, uuid, bigint, text, integer) to service_role;
grant execute on function public.remove_attendee(uuid, uuid, uuid, uuid, bigint) to service_role;
grant execute on function public.block_attendee(uuid, uuid, uuid, uuid, bigint) to service_role;
