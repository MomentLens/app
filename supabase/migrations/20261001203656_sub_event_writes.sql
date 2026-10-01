-- sub_event.create_request_id, and the four functions behind S-04's endpoints (D-95, D-121,
-- docs/ARCHITECTURE.md arch:sub_event and arch:venue): sub_event_schedule for
-- GET /events/{eventId}/sub-events, and add_sub_event, update_sub_event and delete_sub_event for
-- POST, PATCH and DELETE.
--
-- No policy and no new privilege for the app (D-73, root invariant 14). The API checks that the
-- caller is the event's active Admin before it calls a write, and the Admin of an event never
-- changes (D-102), so the functions take no user. Each write locks the event row and checks again,
-- under the lock, that the event is not soft-deleted and the sub-event is still in it.
-- apps/api/tests/integration/rls.test.ts runs all four against the dev project, and checks that the
-- app's own key can call none of them.

-- The uuid the app sends once per Add sheet. Unique across all sub-events, so a retried add finds
-- the sub-event its first attempt made. Null on every sub-event the wizard made: create_event takes
-- the event's request id, not one per sub-event. A sub-event is deleted outright, so its request id
-- goes with it, and a retry that arrives after the delete adds the sub-event again (D-121).
alter table public.sub_event add column create_request_id uuid;
alter table public.sub_event
  add constraint sub_event_create_request_id_key unique (create_request_id);

-- The event's schedule as ListSubEventsResponse carries it, before the API converts its timestamps:
-- a JSON array of {id, name, description, starts_at, ends_at, verification_radius_m,
-- venue: {id, name, lat, lng}}, ordered by starts_at, then ends_at, then id. It never carries
-- qr_secret (D-17, D-121). Null when the event does not exist or is soft-deleted.
--
-- GET calls it after the API's membership check, and each write calls it after it writes, so a read
-- and a write answer with one shape in one order.
--
-- security invoker, and callable by the API's secret key only. It takes no user, so a caller who
-- could run it could read any event's schedule.
create function public.sub_event_schedule(p_event_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', se.id,
          'name', se.name,
          'description', se.description,
          'starts_at', se.starts_at,
          'ends_at', se.ends_at,
          'verification_radius_m', se.verification_radius_m,
          'venue', jsonb_build_object('id', v.id, 'name', v.name, 'lat', v.lat, 'lng', v.lng)
        )
        order by se.starts_at, se.ends_at, se.id
      )
      from public.sub_event se
      join public.venue v on v.id = se.venue_id
      where se.event_id = e.id
    ),
    '[]'::jsonb
  )
  from public.event e
  where e.id = p_event_id
    and e.deleted_at is null
$$;

revoke execute on function public.sub_event_schedule(uuid) from public, anon, authenticated;
grant execute on function public.sub_event_schedule(uuid) to service_role;

-- POST /events/{eventId}/sub-events. Adds one sub-event to p_event_id, at the venue p_venue_id or
-- at a new venue made from p_venue_name, p_venue_lat and p_venue_lng, which gets a new QR (D-121).
-- Pass exactly one of the two forms. An empty p_description is stored as null. The API sends only
-- values AddSubEventRequest parsed, so a refusal by a table check is a bug and reaches the app as a
-- 500.
--
-- Returns one row, and `outcome` says which:
--   added      this call added the sub-event; `schedule` is the schedule after it
--   repeated   a sub-event of p_event_id already has p_request_id; `schedule` is the schedule, and
--              nothing was written
--   taken      a sub-event of another event has p_request_id; nothing was written, and nothing
--              about that event reaches this caller
--   not_found  p_event_id does not exist or is soft-deleted
--   no_venue   p_venue_id is not a venue of p_event_id: another event's, or one an edit or delete
--              removed since the app fetched the schedule
--   too_many   p_event_id already has 15 sub-events
--   too_long   the event's span would pass 336 hours
-- `schedule` is null for every outcome but the first two. A refusal writes nothing.
--
-- The repeat check runs before the cap and the span, so a retry of the 15th add finds it rather
-- than being refused. The event lock makes two adds to one event take turns, so neither can pass
-- the cap or the span the other already used, and a repeat waits for the add it repeats to commit.
create function public.add_sub_event(
  p_event_id uuid,
  p_request_id uuid,
  p_name text,
  p_description text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_venue_id uuid,
  p_venue_name text,
  p_venue_lat double precision,
  p_venue_lng double precision,
  p_verification_radius_m integer
)
returns table (outcome text, schedule jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
  v_existing_event_id uuid;
  v_span interval;
  v_venue_id uuid;
  v_constraint text;
begin
  if p_venue_id is not null and num_nonnulls(p_venue_name, p_venue_lat, p_venue_lng) <> 0
    or p_venue_id is null and num_nonnulls(p_venue_name, p_venue_lat, p_venue_lng) <> 3 then
    raise exception 'Pass p_venue_id, or p_venue_name, p_venue_lat and p_venue_lng'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Every write to this event's schedule waits here for the one before it to commit. FOR NO KEY
  -- UPDATE conflicts with itself and with any update of the event, a soft delete included, but not
  -- with the FOR KEY SHARE lock a foreign key check takes, as in join_event.
  select e.deleted_at into v_deleted_at
  from public.event e
  where e.id = p_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select se.event_id into v_existing_event_id
  from public.sub_event se
  where se.create_request_id = p_request_id;
  if found then
    if v_existing_event_id = p_event_id then
      outcome := 'repeated';
      schedule := public.sub_event_schedule(p_event_id);
    else
      outcome := 'taken';
    end if;
    return next;
    return;
  end if;

  if p_venue_id is not null and not exists (
    select 1 from public.venue v where v.id = p_venue_id and v.event_id = p_event_id
  ) then
    outcome := 'no_venue';
    return next;
    return;
  end if;

  -- MAX_SUB_EVENTS in packages/shared-types (spec §4.17, D-88).
  if (select count(*) from public.sub_event se where se.event_id = p_event_id) >= 15 then
    outcome := 'too_many';
    return next;
    return;
  end if;

  -- MAX_EVENT_SPAN_MS in packages/shared-types: 336 hours, first start to last end (D-110).
  -- greatest and least skip a null, which max and min give for an event with no sub-event.
  select greatest(max(se.ends_at), p_ends_at) - least(min(se.starts_at), p_starts_at)
  into v_span
  from public.sub_event se
  where se.event_id = p_event_id;
  if v_span > interval '336 hours' then
    outcome := 'too_long';
    return next;
    return;
  end if;

  -- An add for another event with this p_request_id can commit while this one runs, since the two
  -- hold different event locks. Its unique violation rolls back this block, the new venue
  -- included, so the refusal writes nothing.
  begin
    if p_venue_id is null then
      insert into public.venue (event_id, name, lat, lng)
      values (p_event_id, p_venue_name, p_venue_lat, p_venue_lng)
      returning id into v_venue_id;
    else
      v_venue_id := p_venue_id;
    end if;

    insert into public.sub_event (
      event_id,
      name,
      description,
      starts_at,
      ends_at,
      venue_id,
      verification_radius_m,
      create_request_id
    )
    values (
      p_event_id,
      p_name,
      nullif(p_description, ''),
      p_starts_at,
      p_ends_at,
      v_venue_id,
      p_verification_radius_m,
      p_request_id
    );
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'sub_event_create_request_id_key' then
      raise;
    end if;
    outcome := 'taken';
    return next;
    return;
  end;

  outcome := 'added';
  schedule := public.sub_event_schedule(p_event_id);
  return next;
end;
$$;

revoke execute on function public.add_sub_event(
  uuid, uuid, text, text, timestamptz, timestamptz, uuid, text, double precision, double precision,
  integer
) from public, anon, authenticated;
grant execute on function public.add_sub_event(
  uuid, uuid, text, text, timestamptz, timestamptz, uuid, text, double precision, double precision,
  integer
) to service_role;

-- PATCH /sub-events/{subEventId}. Changes the fields passed and leaves every null one as it is. An
-- empty p_description clears the description. The two times come together or not at all, and the
-- venue comes as p_venue_id or as a new name and pin, as in add_sub_event, or not at all. p_event_id
-- is the event the API checked the caller is Admin of, and the sub-event must be in it.
--
-- When the edit moves the sub-event off a venue no other sub-event uses, that venue is deleted in
-- the same transaction, and its printed QR stops working (D-121). The edit moves no photo and no
-- venue_verification row (D-100). Two edits of one sub-event take turns on the event lock, and the
-- later one wins (D-121).
--
-- Returns one row, and `outcome` says which:
--   updated    `schedule` is the schedule after the edit
--   not_found  p_event_id does not exist or is soft-deleted, or p_sub_event_id is not one of its
--              sub-events, a sub-event another phone deleted included
--   no_venue   as in add_sub_event
--   too_long   the new times would take the event's span past 336 hours, counting every other
--              sub-event and this one's new times
-- `schedule` is null for every outcome but the first. A refusal writes nothing.
create function public.update_sub_event(
  p_event_id uuid,
  p_sub_event_id uuid,
  p_name text,
  p_description text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_venue_id uuid,
  p_venue_name text,
  p_venue_lat double precision,
  p_venue_lng double precision,
  p_verification_radius_m integer
)
returns table (outcome text, schedule jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
  v_old_venue_id uuid;
  v_new_venue_id uuid;
  v_span interval;
begin
  if num_nonnulls(p_starts_at, p_ends_at) = 1 then
    raise exception 'Pass p_starts_at and p_ends_at together, or neither'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_venue_id is not null and num_nonnulls(p_venue_name, p_venue_lat, p_venue_lng) <> 0
    or num_nonnulls(p_venue_name, p_venue_lat, p_venue_lng) not in (0, 3) then
    raise exception 'Pass p_venue_id, or p_venue_name, p_venue_lat and p_venue_lng, or none'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The same lock as add_sub_event.
  select e.deleted_at into v_deleted_at
  from public.event e
  where e.id = p_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select se.venue_id into v_old_venue_id
  from public.sub_event se
  where se.id = p_sub_event_id and se.event_id = p_event_id;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  if p_venue_id is not null and not exists (
    select 1 from public.venue v where v.id = p_venue_id and v.event_id = p_event_id
  ) then
    outcome := 'no_venue';
    return next;
    return;
  end if;

  if p_starts_at is not null then
    -- As in add_sub_event, with this sub-event's old times left out. An event whose only
    -- sub-event this is gets nulls from max and min, which greatest and least skip.
    select greatest(max(se.ends_at), p_ends_at) - least(min(se.starts_at), p_starts_at)
    into v_span
    from public.sub_event se
    where se.event_id = p_event_id and se.id <> p_sub_event_id;
    if v_span > interval '336 hours' then
      outcome := 'too_long';
      return next;
      return;
    end if;
  end if;

  if p_venue_name is not null then
    insert into public.venue (event_id, name, lat, lng)
    values (p_event_id, p_venue_name, p_venue_lat, p_venue_lng)
    returning id into v_new_venue_id;
  else
    v_new_venue_id := p_venue_id;
  end if;

  update public.sub_event se
  set
    name = coalesce(p_name, se.name),
    description = case
      when p_description is null then se.description
      else nullif(p_description, '')
    end,
    starts_at = coalesce(p_starts_at, se.starts_at),
    ends_at = coalesce(p_ends_at, se.ends_at),
    venue_id = coalesce(v_new_venue_id, se.venue_id),
    verification_radius_m = coalesce(p_verification_radius_m, se.verification_radius_m)
  where se.id = p_sub_event_id;

  delete from public.venue v
  where v.id = v_old_venue_id
    and not exists (select 1 from public.sub_event se where se.venue_id = v.id);

  outcome := 'updated';
  schedule := public.sub_event_schedule(p_event_id);
  return next;
end;
$$;

revoke execute on function public.update_sub_event(
  uuid, uuid, text, text, timestamptz, timestamptz, uuid, text, double precision, double precision,
  integer
) from public, anon, authenticated;
grant execute on function public.update_sub_event(
  uuid, uuid, text, text, timestamptz, timestamptz, uuid, text, double precision, double precision,
  integer
) to service_role;

-- DELETE /sub-events/{subEventId}. Deletes p_sub_event_id, and its venue when no other sub-event
-- uses it, so the venue's printed QR stops working (D-121). p_event_id is the event the API checked
-- the caller is Admin of, and the sub-event must be in it.
--
-- S-12 replaces this function with one that also refuses a sub-event with any media row, and
-- S-15's venue_verification rows go with the sub-event by cascade (D-121).
--
-- Returns one row, and `outcome` says which:
--   deleted    `schedule` is the schedule after the delete
--   not_found  as in update_sub_event, so a delete that already happened answers this
--   last       this is the event's only sub-event, which is never deleted (D-88, D-100)
-- `schedule` is null for every outcome but the first. A refusal writes nothing. Two deletes of
-- the event's last two sub-events take turns on the event lock, and the second finds one left.
create function public.delete_sub_event(p_event_id uuid, p_sub_event_id uuid)
returns table (outcome text, schedule jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
  v_venue_id uuid;
begin
  -- The same lock as add_sub_event.
  select e.deleted_at into v_deleted_at
  from public.event e
  where e.id = p_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select se.venue_id into v_venue_id
  from public.sub_event se
  where se.id = p_sub_event_id and se.event_id = p_event_id;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  if (select count(*) from public.sub_event se where se.event_id = p_event_id) <= 1 then
    outcome := 'last';
    return next;
    return;
  end if;

  delete from public.sub_event se where se.id = p_sub_event_id;

  delete from public.venue v
  where v.id = v_venue_id
    and not exists (select 1 from public.sub_event se where se.venue_id = v.id);

  outcome := 'deleted';
  schedule := public.sub_event_schedule(p_event_id);
  return next;
end;
$$;

revoke execute on function public.delete_sub_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_sub_event(uuid, uuid) to service_role;
