-- S-17's server coverage and conditional manual check-in (D-157).
-- Replace the old signature so Data API calls with default filters stay unambiguous.
drop function public.list_attendees(uuid, uuid, text, text, text, uuid);

create function public.list_attendees(
  p_event_id uuid, p_actor_id uuid, p_search text, p_role text,
  p_after_name text, p_after_user_id uuid,
  p_sub_event_id uuid default null, p_check_in text default null
)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_actor public.membership%rowtype;
  v_attendees jsonb;
begin
  if not exists (select 1 from public.event e where e.id = p_event_id and e.deleted_at is null) then
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
  if p_search is null or (p_role is not null and p_role not in ('admin', 'guest', 'photographer'))
    or num_nonnulls(p_after_name, p_after_user_id) = 1
    or (p_check_in is not null and (p_check_in not in ('checked_in', 'not_checked_in')
      or p_sub_event_id is null)) then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  if p_sub_event_id is not null and not exists (
    select 1 from public.sub_event se where se.id = p_sub_event_id and se.event_id = p_event_id
  ) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- One snapshot checks access, selects the page and reads only its server coverage.
  -- Keep evidence and avatar columns out of this query. strpos keeps the search literal.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'user_id', r.user_id, 'full_name', r.full_name, 'role', r.role,
    'requested_at', r.requested_at, 'access_version', r.access_version::text,
    'every_sub_event', r.every_sub_event,
    'verified_sub_event_ids', array(
      select vv.sub_event_id
      from public.venue_verification vv
      join public.sub_event se on se.id = vv.sub_event_id
      where vv.user_id = r.user_id and se.event_id = p_event_id
      order by vv.sub_event_id
    )
  ) order by r.full_name, r.user_id), '[]'::jsonb) into v_attendees
  from (
    select m.id, m.user_id, p.full_name, m.role, m.requested_at, m.access_version,
      m.admin_verified_at is not null or m.role in ('admin', 'photographer') as every_sub_event
    from public.membership m
    join public.profile p on p.user_id = m.user_id
    where m.event_id = p_event_id and m.status = 'active'
      and (p_role is null or m.role = p_role)
      and strpos(lower(p.full_name), lower(p_search)) > 0
      and (p_after_name is null or (p.full_name, m.user_id) > (p_after_name, p_after_user_id))
      and (p_check_in is null or (
        m.admin_verified_at is not null or m.role in ('admin', 'photographer') or exists (
          select 1 from public.venue_verification vv
          where vv.user_id = m.user_id and vv.sub_event_id = p_sub_event_id
        )
      ) = (p_check_in = 'checked_in'))
    order by p.full_name, m.user_id
    limit 51
  ) r;
  return jsonb_build_object('outcome', 'listed', 'attendees', v_attendees);
end;
$$;

create function public.force_verify_attendee(
  p_event_id uuid, p_actor_id uuid, p_user_id uuid, p_expected_id uuid,
  p_expected_version bigint
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_deleted_at timestamptz;
  v_actor public.membership%rowtype;
  v_target public.membership%rowtype;
begin
  -- Joins, access changes and upload acceptance take this event lock too.
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
  if v_target.admin_verified_at is null then
    update public.membership m set admin_verified_at = now()
    where m.id = v_target.id returning * into v_target;
  end if;
  -- A valid repeat keeps the first timestamp and changes no membership field.
  return jsonb_build_object('outcome', 'verified', 'membership', jsonb_build_object(
    'id', v_target.id, 'user_id', v_target.user_id, 'role', v_target.role,
    'status', v_target.status, 'access_version', v_target.access_version::text
  ), 'admin_verified_at', v_target.admin_verified_at);
end;
$$;

-- No table or policy changes. App keys cannot supply a trusted actor to either function.
revoke execute on function public.list_attendees(uuid, uuid, text, text, text, uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.force_verify_attendee(uuid, uuid, uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.list_attendees(uuid, uuid, text, text, text, uuid, uuid, text)
  to service_role;
grant execute on function public.force_verify_attendee(uuid, uuid, uuid, uuid, bigint)
  to service_role;
