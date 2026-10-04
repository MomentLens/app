-- Pending Approvals: the list and the three actions behind GET /events/{eventId}/join-requests and
-- its approve, reject and block POSTs (D-95, D-144, docs/ARCHITECTURE.md arch:membership).
--
-- No table changes, no policy and no client grant (D-73, root invariant 14). Each function takes
-- the actor as a parameter and checks no caller, so execute is granted to service_role only, as it
-- is for the attendee functions. They run as security invoker.
-- apps/api/tests/integration/rls.test.ts runs them against the dev project, and checks that the
-- app's own key can call none of them.

-- GET /events/{eventId}/join-requests. A stable function reads one snapshot, so the event and actor
-- checks, the page and the active Guest count agree. Returns up to 51 pending rows, oldest
-- requested_at first, then user_id, after the cursor's time and user; the 51st tells the API there
-- is another page. requested_at comes back as fixed-width UTC text to the microsecond, so a cursor
-- the API builds from it names the row exactly and two requests in one millisecond are both
-- listed. active_guests counts the active Guests, for guestPlacesLeft (spec §4.17). No avatar key
-- and no verification column is read (D-143, D-144).
--
-- `outcome` is not_found for a deleted or unknown event, not_member or wrong_role for the actor,
-- invalid_request for half a cursor, and otherwise listed.
create function public.list_pending_requests(
  p_event_id uuid, p_actor_id uuid, p_after_requested_at timestamptz, p_after_user_id uuid
)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_actor public.membership%rowtype;
  v_requests jsonb;
  v_active_guests bigint;
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
  if num_nonnulls(p_after_requested_at, p_after_user_id) = 1 then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'user_id', r.user_id, 'full_name', r.full_name, 'role', r.role,
    'requested_at', to_char(r.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'access_version', r.access_version::text
  ) order by r.requested_at, r.user_id), '[]'::jsonb) into v_requests
  from (
    select m.id, m.user_id, p.full_name, m.role, m.requested_at, m.access_version
    from public.membership m
    join public.profile p on p.user_id = m.user_id
    where m.event_id = p_event_id and m.status = 'pending'
      and (p_after_requested_at is null
        or (m.requested_at, m.user_id) > (p_after_requested_at, p_after_user_id))
    order by m.requested_at, m.user_id
    limit 51
  ) r;
  select count(*) into v_active_guests from public.membership m
  where m.event_id = p_event_id and m.role = 'guest' and m.status = 'active';
  return jsonb_build_object(
    'outcome', 'listed', 'requests', v_requests, 'active_guests', v_active_guests
  );
end;
$$;

-- The shared body of approve_requests, reject_requests and block_request (D-144). p_targets is a
-- JSON array of {"user_id", "id", "version"}: the person, and the membership id and access counter
-- their accessVersion token held. A batch is all or nothing.
--
-- It takes join_event's FOR NO KEY UPDATE lock on the event, so an approve, a join, a switch to
-- auto and an attendee conversion never both take the last Guest place. It rechecks the event and
-- the actor under that lock, then locks the target rows in user_id order before it checks them, so
-- a Cancel Request's delete either finishes first and leaves no row to match, or waits and then
-- finds the row no longer pending (arch:membership).
--
-- `outcome`:
--   not_found           a deleted or unknown event
--   not_member          the actor is not an active member
--   wrong_role          the actor is an active Guest or Photographer
--   invalid_request     an unknown action, no cap on an approve, not 1 to 50 distinct targets,
--                       a target missing a field, or more than one target on a block
--   membership_changed  a target has no row in this event, is not pending, the Admin included,
--                       or holds another row id or counter than its token
--   event_full          an approve whose Guests would take the event past p_max_guests active
--                       Guests. Photographers do not count (D-102)
--   updated             `memberships` holds each target after the write, by user_id
-- Every refusal writes nothing. An archived event is allowed (D-142, D-143).
create function public.act_on_join_requests(
  p_event_id uuid, p_actor_id uuid, p_targets jsonb, p_action text, p_max_guests integer
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_deleted_at timestamptz;
  v_actor public.membership%rowtype;
  v_length integer;
  v_user_ids uuid[];
  v_ids uuid[];
  v_versions bigint[];
  v_distinct integer;
  v_complete boolean;
  v_matched integer;
  v_new_guests integer;
  v_active_guests integer;
  v_memberships jsonb;
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

  -- Separate tests, because SQL does not promise to stop at the first true one, and
  -- jsonb_array_length fails on anything but an array.
  if p_action is null or p_action not in ('approve', 'reject', 'block')
    or (p_action = 'approve' and (p_max_guests is null or p_max_guests < 0)) then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  if jsonb_typeof(p_targets) is distinct from 'array' then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  v_length := jsonb_array_length(p_targets);
  if v_length not between 1 and 50 or (p_action = 'block' and v_length <> 1) then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  select array_agg(t.user_id order by t.user_id), array_agg(t.id order by t.user_id),
    array_agg(t.version order by t.user_id), count(distinct t.user_id),
    bool_and(t.id is not null and t.version is not null)
  into v_user_ids, v_ids, v_versions, v_distinct, v_complete
  from jsonb_to_recordset(p_targets) as t(user_id uuid, id uuid, version bigint);
  if v_distinct <> v_length or not v_complete then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  -- ORDER BY runs before the lock, so the rows are locked in user_id order.
  perform 1 from public.membership m
  where m.event_id = p_event_id and m.user_id = any(v_user_ids)
  order by m.user_id
  for update;
  select count(*) into v_matched
  from unnest(v_user_ids, v_ids, v_versions) as t(user_id, id, version)
  join public.membership m on m.id = t.id
  where m.event_id = p_event_id and m.user_id = t.user_id and m.status = 'pending'
    and m.access_version = t.version;
  if v_matched <> v_length then
    return jsonb_build_object('outcome', 'membership_changed');
  end if;

  if p_action = 'approve' then
    select count(*) into v_new_guests from public.membership m
    where m.id = any(v_ids) and m.role = 'guest';
    select count(*) into v_active_guests from public.membership m
    where m.event_id = p_event_id and m.role = 'guest' and m.status = 'active';
    if v_new_guests > 0 and v_active_guests + v_new_guests > p_max_guests then
      return jsonb_build_object('outcome', 'event_full');
    end if;
  end if;

  -- Only status changes, so admin_verified_at, last_viewed_at and requested_at stay, and the
  -- version trigger advances each counter.
  with changed as (
    update public.membership m
    set status = case p_action when 'approve' then 'active' when 'reject' then 'removed' else 'blocked' end
    where m.id = any(v_ids)
    returning m.id, m.user_id, m.role, m.status, m.access_version
  )
  select jsonb_agg(jsonb_build_object(
    'id', c.id, 'user_id', c.user_id, 'role', c.role, 'status', c.status,
    'access_version', c.access_version::text
  ) order by c.user_id) into v_memberships
  from changed c;
  -- S-25 adds the reprocess enqueue here, for each approved subject with references (D-84).
  return jsonb_build_object('outcome', 'updated', 'memberships', v_memberships);
end;
$$;

-- POST /events/{eventId}/join-requests/approve. Sets every target active, within p_max_guests
-- active Guests. The API passes MAX_ACTIVE_GUESTS, 150, and the dev-project tests a small one.
create function public.approve_requests(
  p_event_id uuid, p_actor_id uuid, p_targets jsonb, p_max_guests integer
)
returns jsonb language sql set search_path = '' as $$
  select public.act_on_join_requests(p_event_id, p_actor_id, p_targets, 'approve', p_max_guests)
$$;

-- POST /events/{eventId}/join-requests/reject. Sets every target removed and keeps the row, so the
-- person may ask again through a live invite (D-102, D-144).
create function public.reject_requests(p_event_id uuid, p_actor_id uuid, p_targets jsonb)
returns jsonb language sql set search_path = '' as $$
  select public.act_on_join_requests(p_event_id, p_actor_id, p_targets, 'reject', null)
$$;

-- POST /events/{eventId}/join-requests/{userId}/block. One target, set blocked, so join_event
-- answers it blocked from then on (D-115, D-144).
create function public.block_request(
  p_event_id uuid, p_actor_id uuid, p_user_id uuid, p_expected_id uuid, p_expected_version bigint
)
returns jsonb language sql set search_path = '' as $$
  select public.act_on_join_requests(p_event_id, p_actor_id, jsonb_build_array(jsonb_build_object(
    'user_id', p_user_id, 'id', p_expected_id, 'version', p_expected_version
  )), 'block', null)
$$;

revoke execute on function public.list_pending_requests(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.act_on_join_requests(uuid, uuid, jsonb, text, integer) from public, anon, authenticated;
revoke execute on function public.approve_requests(uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.reject_requests(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.block_request(uuid, uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.list_pending_requests(uuid, uuid, timestamptz, uuid) to service_role;
grant execute on function public.act_on_join_requests(uuid, uuid, jsonb, text, integer) to service_role;
grant execute on function public.approve_requests(uuid, uuid, jsonb, integer) to service_role;
grant execute on function public.reject_requests(uuid, uuid, jsonb) to service_role;
grant execute on function public.block_request(uuid, uuid, uuid, uuid, bigint) to service_role;
