-- event_settings and update_event_settings, behind GET and PATCH /events/{eventId}/settings
-- (D-95, D-142, docs/ARCHITECTURE.md arch:event and arch:membership).
--
-- No table changes, no policy and no new privilege for the app (D-73, root invariant 14). The API
-- checks that the caller is the event's active Admin before it calls either, and the Admin of an
-- event never changes (D-102), so neither takes a user. apps/api/tests/integration/rls.test.ts runs
-- both against the dev project, and checks that the app's own key can call neither.

-- The Event Settings form as EventSettings carries it, before the API presigns the cover: a JSON
-- object {name, description, approval_mode, cover_key, pending_count, pending_photographers}.
-- pending_count counts every pending membership of the event, Guests and Photographers.
-- pending_photographers holds each pending Photographer's full_name, oldest requested_at first,
-- then by membership id, for the confirm before a switch to auto (D-139, D-142). Null when the
-- event does not exist or is soft-deleted. An archived event answers as any other.
--
-- One statement, so the count and the names come from one snapshot: a request that arrives
-- between two reads cannot put a name in the list that the count left out. GET calls it after the
-- API's Admin check, and update_event_settings calls it after it writes.
--
-- A pending Photographer with no profile row would give a null name, which the API's parse
-- refuses with a 500 rather than leave them out of the confirm. Every account has a profile, made
-- by the trigger on auth.users (arch:profile).
--
-- security invoker, and callable by the API's secret key only. It takes no user, so a caller who
-- could run it could read any event's pending requests.
create function public.event_settings(p_event_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'name', e.name,
    'description', e.description,
    'approval_mode', e.approval_mode,
    'cover_key', e.cover_key,
    'pending_count', (
      select count(*)
      from public.membership m
      where m.event_id = e.id and m.status = 'pending'
    ),
    'pending_photographers', coalesce(
      (
        select jsonb_agg(p.full_name order by m.requested_at, m.id)
        from public.membership m
        left join public.profile p on p.user_id = m.user_id
        where m.event_id = e.id and m.status = 'pending' and m.role = 'photographer'
      ),
      '[]'::jsonb
    )
  )
  from public.event e
  where e.id = p_event_id
    and e.deleted_at is null
$$;

revoke execute on function public.event_settings(uuid) from public, anon, authenticated;
grant execute on function public.event_settings(uuid) to service_role;

-- PATCH /events/{eventId}/settings (D-142). Changes the fields passed and leaves every null one as
-- it is; at least one must be passed. An empty p_description clears the description. p_event_id
-- is the event the API checked the caller is Admin of. The type and the cover are not here: the
-- type never changes, and the cover has its own two endpoints (D-110).
--
-- p_approval_mode 'auto' on a 'manual' event admits pending requests in the same transaction:
-- every pending Photographer, then pending Guests oldest requested_at first, then by membership
-- id, until the event holds p_max_guests active Guests. The rest stay pending for Pending
-- Approvals. 'auto' on an 'auto' event, 'manual' on either, and a call without p_approval_mode
-- change no membership. The API passes MAX_ACTIVE_GUESTS, 150 (spec §4.17), and the dev-project
-- tests pass a small one, as with join_event.
--
-- It locks the event row FOR NO KEY UPDATE before it reads the mode or counts, as join_event does
-- (arch:membership). A join and a switch never both take the last place, and two switches from
-- two phones take turns: the second finds the event auto and admits nobody. For the fields, the
-- later write wins (D-121, D-142). An archived event takes the change as any other.
--
-- S-25 adds the reprocess enqueue for each subject with references this admits (D-84), and S-27
-- the Approval Alerts (spec §4.16).
--
-- Returns one row, and `outcome` says which:
--   updated    `admitted` is how many pending requests this call made active, and `settings` is
--              event_settings after the write
--   not_found  p_event_id does not exist or is soft-deleted; `admitted` is 0 and `settings` null
-- A refusal writes nothing. A name or description the event's checks refuse fails the call.
--
-- security invoker, and callable by the API's secret key only. It takes no user, so a caller who
-- could run it could rename any event and let anyone waiting into it.
create function public.update_event_settings(
  p_event_id uuid,
  p_name text,
  p_description text,
  p_approval_mode text,
  p_max_guests integer
)
returns table (outcome text, admitted integer, settings jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
  v_approval_mode text;
  v_photographers integer := 0;
  v_guests integer := 0;
  v_active_guests integer;
begin
  if num_nonnulls(p_name, p_description, p_approval_mode) = 0 then
    raise exception 'Pass at least one of p_name, p_description and p_approval_mode'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_max_guests is null or p_max_guests < 0 then
    raise exception 'p_max_guests must be 0 or more, got %', p_max_guests
      using errcode = 'invalid_parameter_value';
  end if;

  -- The lock join_event takes, so the mode read here and the counts below hold until commit.
  select e.deleted_at, e.approval_mode into v_deleted_at, v_approval_mode
  from public.event e
  where e.id = p_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    admitted := 0;
    return next;
    return;
  end if;

  update public.event e
  set
    name = coalesce(p_name, e.name),
    description = case
      when p_description is null then e.description
      else nullif(p_description, '')
    end,
    approval_mode = coalesce(p_approval_mode, e.approval_mode)
  where e.id = p_event_id;

  if p_approval_mode = 'auto' and v_approval_mode = 'manual' then
    update public.membership m
    set status = 'active'
    where m.event_id = p_event_id and m.role = 'photographer' and m.status = 'pending';
    get diagnostics v_photographers = row_count;

    select count(*) into v_active_guests
    from public.membership m
    where m.event_id = p_event_id and m.role = 'guest' and m.status = 'active';

    -- greatest, because an event can already hold more active Guests than p_max_guests, and a
    -- negative limit is an error.
    update public.membership m
    set status = 'active'
    where m.id in (
      select q.id
      from public.membership q
      where q.event_id = p_event_id and q.role = 'guest' and q.status = 'pending'
      order by q.requested_at, q.id
      limit greatest(p_max_guests - v_active_guests, 0)
    );
    get diagnostics v_guests = row_count;
  end if;

  outcome := 'updated';
  admitted := v_photographers + v_guests;
  settings := public.event_settings(p_event_id);
  return next;
end;
$$;

revoke execute on function public.update_event_settings(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.update_event_settings(uuid, text, text, text, integer)
  to service_role;
