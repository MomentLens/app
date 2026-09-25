-- event, venue, sub_event and membership, and the two functions the API calls with rpc:
-- create_event and list_my_events (D-88, D-95, D-102, D-110, docs/ARCHITECTURE.md arch:event,
-- arch:venue, arch:sub_event and arch:membership).
--
-- RLS is on for all four tables with no policy (D-73, root invariant 14). The API reads and writes
-- them with the secret key and makes every decision about them in its service layer. S-31 adds the
-- one policy any of them gets, SELECT on event, for Realtime. apps/api/tests/integration/rls.test.ts
-- checks the refusals, both functions and the constraints below against the dev project.

-- gen_random_bytes for venue.qr_secret. Supabase installs pgcrypto in the extensions schema, so
-- this changes nothing there; it is here so the migration says what it needs.
create extension if not exists pgcrypto with schema extensions;

create table public.event (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null,
  description text,
  -- events/{event_id}/cover_{upload_id}.jpg, built by the API's one cover key function (arch §3).
  cover_key text,
  -- The event's own venue, the wizard's venues[0]. The foreign key is added below, once venue
  -- exists, and waits for the commit, because create_event inserts the event before its venues.
  venue_id uuid not null,
  -- One radius for every venue of the event (D-110).
  verification_radius_m integer not null default 200,
  -- auto until S-07 builds the approval queue, so no event made before it lets nobody in (D-110).
  approval_mode text not null default 'auto',
  album_open boolean not null default false,
  -- The uuid the app sends once per wizard. Unique across all events, so a retry finds the event
  -- its first attempt made, and create_event returns it only to that event's Admin (D-110).
  create_request_id uuid not null,
  deleted_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  -- Names and descriptions follow EventName and EventDescription in packages/shared-types: trimmed
  -- as String.prototype.trim trims, then counted in code points. A null passes a CHECK, so a
  -- description is null or 1 to 500 characters; create_event stores an empty one as null.
  constraint event_name_check check (
    name = public.trim_whitespace(name) and char_length(name) between 1 and 80
  ),
  constraint event_type_check check (type in ('wedding', 'engagement', 'other')),
  constraint event_description_check check (
    description = public.trim_whitespace(description) and char_length(description) between 1 and 500
  ),
  -- The API presigns this key for every active member. A key outside this event's cover family,
  -- such as another event's cover or a media file, would hand that file to all of them.
  constraint event_cover_key_check check (
    cover_key ~ (
      '^events/' || id::text
      || '/cover_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    )
  ),
  constraint event_verification_radius_m_check check (verification_radius_m between 50 and 2000),
  constraint event_approval_mode_check check (approval_mode in ('auto', 'manual')),
  constraint event_create_request_id_key unique (create_request_id)
);

comment on table public.event is
  'One event. Its span is computed from its sub-events and never stored (D-88). RLS on, no policy until S-31.';

create table public.venue (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event (id) on delete cascade,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  -- Printed in the venue's Check-In QR, for the Admin only (D-17). No S-02 endpoint returns it.
  qr_secret bytea not null default extensions.gen_random_bytes(32),
  created_at timestamptz not null default now(),
  constraint venue_name_check check (
    name = public.trim_whitespace(name) and char_length(name) between 1 and 80
  ),
  constraint venue_lat_check check (lat between -90 and 90),
  constraint venue_lng_check check (lng between -180 and 180),
  constraint venue_qr_secret_check check (octet_length(qr_secret) = 32),
  -- The target of the two foreign keys below that keep a venue inside its own event.
  constraint venue_id_event_id_key unique (id, event_id)
);

comment on table public.venue is
  'A place an event or its sub-events happen, with one Check-In QR (spec §4.3, D-110). RLS on, no policy.';

create index venue_event_id_idx on public.venue (event_id);

-- The event's venue must be one of its own. Deferred to the commit, since create_event inserts the
-- event first and its venues after.
alter table public.event
  add constraint event_venue_id_fkey foreign key (venue_id, id)
  references public.venue (id, event_id)
  deferrable initially deferred;

create table public.sub_event (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event (id) on delete cascade,
  name text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  venue_id uuid not null,
  created_at timestamptz not null default now(),
  constraint sub_event_name_check check (
    name = public.trim_whitespace(name) and char_length(name) between 1 and 80
  ),
  constraint sub_event_description_check check (
    description = public.trim_whitespace(description) and char_length(description) between 1 and 500
  ),
  -- In Progress runs from starts_at until ends_at (spec §4.3), so it needs a moment to run in.
  constraint sub_event_time_check check (ends_at > starts_at),
  -- A sub-event's venue belongs to the same event, so its QR never verifies another event.
  constraint sub_event_venue_id_fkey foreign key (venue_id, event_id)
    references public.venue (id, event_id)
);

comment on table public.sub_event is
  'A part of an event. Status is computed on read and never stored (D-88, D-105). RLS on, no policy, no Realtime (D-100).';

create index sub_event_event_id_idx on public.sub_event (event_id);
create index sub_event_venue_id_idx on public.sub_event (venue_id);

create table public.membership (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  status text not null,
  -- Force Verify (D-15). S-12 reads it at pre-flight.
  admin_verified_at timestamptz,
  -- The "new since last visit" dot (spec §2.5).
  last_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint membership_event_id_user_id_key unique (event_id, user_id),
  constraint membership_role_check check (role in ('admin', 'photographer', 'guest')),
  constraint membership_status_check check (status in ('pending', 'active', 'blocked', 'removed')),
  -- The Admin is the event's creator and is never pending, blocked or removed (D-102).
  constraint membership_admin_active_check check (role <> 'admin' or status = 'active')
);

comment on table public.membership is
  'A user''s place in one event. Exactly one admin row per event, its creator''s (D-102). RLS on, no policy.';

-- At most one Admin per event. create_event writes the one there is.
create unique index membership_one_admin_idx on public.membership (event_id) where role = 'admin';
-- GET /events: a user's active memberships.
create index membership_user_id_status_idx on public.membership (user_id, status);

alter table public.event enable row level security;
alter table public.venue enable row level security;
alter table public.sub_event enable row level security;
alter table public.membership enable row level security;

-- As for profile and subject: anon and authenticated keep SELECT, so a stray query from the app
-- reads empty rows rather than an error (invariant 14), and hold no write privilege, so a policy
-- added by mistake still could not let the app write.
revoke all on table public.event, public.venue, public.sub_event, public.membership
  from anon, authenticated;
grant select on table public.event, public.venue, public.sub_event, public.membership
  to anon, authenticated;
grant select, insert, update, delete
  on table public.event, public.venue, public.sub_event, public.membership
  to service_role;

-- GET /events: every event where p_user_id's membership is active, soft-deleted events left out,
-- with the caller's role and the span from the first sub-event start to the last sub-event end
-- (D-88, D-110). An event with no sub-events would list with a null span, which the API's parse
-- refuses loudly; create_event never makes one.
--
-- security invoker, and callable by the API's secret key only. It takes the user as a parameter,
-- so a caller who could run it could list anyone's events.
create function public.list_my_events(p_user_id uuid)
returns table (
  id uuid,
  name text,
  type text,
  role text,
  cover_key text,
  starts_at timestamptz,
  ends_at timestamptz,
  archived_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select e.id, e.name, e.type, m.role, e.cover_key, span.starts_at, span.ends_at, e.archived_at
  from public.membership m
  join public.event e on e.id = m.event_id
  cross join lateral (
    select min(se.starts_at) as starts_at, max(se.ends_at) as ends_at
    from public.sub_event se
    where se.event_id = e.id
  ) span
  where m.user_id = p_user_id
    and m.status = 'active'
    and e.deleted_at is null
$$;

revoke execute on function public.list_my_events(uuid) from public, anon, authenticated;
grant execute on function public.list_my_events(uuid) to service_role;

-- POST /events. Inserts the event, its venues, its sub-events and p_user_id's admin membership in
-- one transaction, so no event exists without its Admin (D-95, D-102, D-110). S-03 adds the invite
-- inserts here.
--
-- p_venues is a JSON array of {name, lat, lng}. The first is the event's own venue; every other
-- must be used by a sub-event. p_sub_events is a JSON array of {name, description, starts_at,
-- ends_at, venue_index}, where venue_index points into p_venues from 0. The API sends only values
-- CreateEventRequest parsed, so every refusal here is a bug in the API and reaches the app as a 500.
--
-- Returns one row, and `outcome` says which:
--   created   this call made the event; the rest of the row is its summary, as list_my_events
--             returns it
--   repeated  p_user_id made an event with this p_request_id before; the row is that event, and
--             nothing was written
--   gone      as repeated, but that event has been soft-deleted since; the rest of the row is null
--   taken     another user's event has this p_request_id; the rest of the row is null, so nothing
--             about that event reaches this caller
-- A p_user_id with no account fails the membership foreign key, and the whole call rolls back.
--
-- Two calls with one p_request_id at once cannot both insert: the second waits on the unique
-- constraint until the first commits, then finds its event.
create function public.create_event(
  p_user_id uuid,
  p_request_id uuid,
  p_name text,
  p_type text,
  p_description text,
  p_verification_radius_m integer,
  p_venues jsonb,
  p_sub_events jsonb
)
returns table (
  outcome text,
  id uuid,
  name text,
  type text,
  role text,
  cover_key text,
  starts_at timestamptz,
  ends_at timestamptz,
  archived_at timestamptz
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid := gen_random_uuid();
  v_venue_count integer;
  v_sub_event_count integer;
  v_venue_ids uuid[];
  v_span interval;
  v_existing uuid;
begin
  if jsonb_typeof(p_venues) is distinct from 'array'
    or jsonb_typeof(p_sub_events) is distinct from 'array' then
    raise exception 'p_venues and p_sub_events must be JSON arrays'
      using errcode = 'check_violation';
  end if;
  v_venue_count := jsonb_array_length(p_venues);
  v_sub_event_count := jsonb_array_length(p_sub_events);

  -- MAX_SUB_EVENTS in packages/shared-types (spec §4.17, D-88).
  if v_sub_event_count not between 1 and 15 then
    raise exception 'An event has 1 to 15 sub-events, got %', v_sub_event_count
      using errcode = 'check_violation';
  end if;
  if v_venue_count not between 1 and v_sub_event_count + 1 then
    raise exception 'An event has 1 to % venues, got %', v_sub_event_count + 1, v_venue_count
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_sub_events) as s (value)
    where ((s.value ->> 'venue_index')::integer between 0 and v_venue_count - 1) is not true
  ) then
    raise exception 'A sub-event names a venue index outside p_venues'
      using errcode = 'check_violation';
  end if;
  -- An unused venue would get a QR that verifies nothing.
  if exists (
    select 1
    from generate_series(1, v_venue_count - 1) as i
    where not exists (
      select 1
      from jsonb_array_elements(p_sub_events) as s (value)
      where (s.value ->> 'venue_index')::integer = i
    )
  ) then
    raise exception 'Every venue after the first must be used by a sub-event'
      using errcode = 'check_violation';
  end if;
  -- MAX_EVENT_SPAN_MS in packages/shared-types: 336 hours, first start to last end (D-110).
  select max((s.value ->> 'ends_at')::timestamptz) - min((s.value ->> 'starts_at')::timestamptz)
  into v_span
  from jsonb_array_elements(p_sub_events) as s (value);
  if v_span > interval '336 hours' then
    raise exception 'An event runs at most 336 hours, got %', v_span
      using errcode = 'check_violation';
  end if;

  v_venue_ids := array(select gen_random_uuid() from generate_series(1, v_venue_count));

  insert into public.event
    (id, name, type, description, venue_id, verification_radius_m, create_request_id)
  values (
    v_event_id,
    p_name,
    p_type,
    nullif(p_description, ''),
    v_venue_ids[1],
    p_verification_radius_m,
    p_request_id
  )
  on conflict (create_request_id) do nothing;

  if not found then
    select e.id into v_existing from public.event e where e.create_request_id = p_request_id;
    -- The Admin is the creator (D-102), so the Admin row names who made the first request.
    if not exists (
      select 1
      from public.membership m
      where m.event_id = v_existing and m.user_id = p_user_id and m.role = 'admin'
    ) then
      outcome := 'taken';
      return next;
      return;
    end if;
    return query
      select 'repeated'::text, s.*
      from public.list_my_events(p_user_id) as s
      where s.id = v_existing;
    if not found then
      outcome := 'gone';
      return next;
    end if;
    return;
  end if;

  insert into public.venue (id, event_id, name, lat, lng)
  select
    v_venue_ids[v.ord::integer],
    v_event_id,
    v.value ->> 'name',
    (v.value ->> 'lat')::double precision,
    (v.value ->> 'lng')::double precision
  from jsonb_array_elements(p_venues) with ordinality as v (value, ord);

  insert into public.sub_event (event_id, name, description, starts_at, ends_at, venue_id)
  select
    v_event_id,
    s.value ->> 'name',
    nullif(s.value ->> 'description', ''),
    (s.value ->> 'starts_at')::timestamptz,
    (s.value ->> 'ends_at')::timestamptz,
    v_venue_ids[(s.value ->> 'venue_index')::integer + 1]
  from jsonb_array_elements(p_sub_events) as s (value);

  insert into public.membership (event_id, user_id, role, status)
  values (v_event_id, p_user_id, 'admin', 'active');

  return query
    select 'created'::text, s.*
    from public.list_my_events(p_user_id) as s
    where s.id = v_event_id;
end;
$$;

revoke execute on function public.create_event(uuid, uuid, text, text, text, integer, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_event(uuid, uuid, text, text, text, integer, jsonb, jsonb)
  to service_role;
