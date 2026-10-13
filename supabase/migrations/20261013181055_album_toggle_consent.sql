-- S-31: the album toggle, the consent record, and Realtime on event (D-73, D-142, D-161, arch §1,
-- arch:event, arch:consent).
--
-- Adds:
-- 1. consent, one row per account and policy version accepted. RLS on with no policy, as profile.
-- 2. event's SELECT policy for Realtime, through active_event_role, with no deleted_at clause.
-- 3. event added to the supabase_realtime publication.
-- 4. list_my_events, get_my_event and create_event replaced to return album_open.
-- 5. album_status(p_event_id), for GET /events/{eventId}/album.
--
-- PUT /events/{eventId}/album and POST /profiles/me/consent write with one statement from the API
-- and need no function. apps/api/tests/integration/rls.test.ts checks the policy per role and
-- status, subscribes through Realtime once, and checks that consent reads empty.

-- 1. consent (spec §4.18, D-161, arch:consent).
-- The app shows the consent screen while GET /profiles/me says the caller has no row for
-- PRIVACY_POLICY_VERSION in packages/shared-types. The key makes a second acceptance of the same
-- version a conflict, so accepting twice leaves one row and its first accepted_at.
create table public.consent (
  user_id uuid not null references auth.users (id) on delete cascade,
  policy_version integer not null,
  accepted_at timestamptz not null default now(),
  constraint consent_pkey primary key (user_id, policy_version),
  constraint consent_policy_version_check check (policy_version > 0)
);

comment on table public.consent is
  'Each version of the Terms and Privacy Policy an account accepted (spec §4.18, D-161). RLS on, no policy: the API reads and writes it with the secret key.';

alter table public.consent enable row level security;

-- As for profile: anon and authenticated keep SELECT, so a stray query from the app reads empty
-- rows rather than an error (invariant 14), and hold no write privilege.
revoke all on table public.consent from anon, authenticated;
grant select on table public.consent to anon, authenticated;
grant select, insert, update, delete on table public.consent to service_role;

-- 2. SELECT policy on event for Realtime (D-73, D-161, arch §1).
-- An active member of the event sees its row, so opening or closing the album reaches every open
-- phone, which then refetches GET /events/{eventId}. A soft-deleted event stays visible, as a
-- soft-deleted media row does, so an open phone learns of the deletion and refetches into the 404
-- state. active_event_role is security definer because membership has no policy of its own.
-- The app still reads event through the API; this policy exists for Realtime alone.
create policy event_select_realtime on public.event
  for select
  to authenticated
  using (public.active_event_role(id) is not null);

comment on table public.event is
  'One event. Its span is computed from its sub-events and never stored (D-88). RLS on, with one SELECT policy for Realtime (D-161).';

-- 3. Add event to the supabase_realtime publication (D-161).
-- Without it Realtime delivers nothing and nothing reports an error.
alter publication supabase_realtime add table public.event;

-- 4. list_my_events, get_my_event and create_event, each with album_open (D-161).
-- A change of return type needs a new function, so each is dropped and created again. create_event
-- returns list_my_events(...).* under its own column list, so it goes first and comes back after.

drop function public.create_event(uuid, uuid, text, text, text, text, jsonb, jsonb);
drop function public.list_my_events(uuid);

-- list_my_events as 20260925105127_create_event_venue_sub_event_membership.sql wrote it, with
-- album_open last. Every event where p_user_id's membership is active, soft-deleted events left
-- out, with the caller's role and the span from the sub-events (D-88, D-110).
create function public.list_my_events(p_user_id uuid)
returns table (
  id uuid,
  name text,
  type text,
  role text,
  cover_key text,
  starts_at timestamptz,
  ends_at timestamptz,
  archived_at timestamptz,
  album_open boolean
)
language sql
stable
set search_path = ''
as $$
  select
    e.id, e.name, e.type, m.role, e.cover_key, span.starts_at, span.ends_at, e.archived_at,
    e.album_open
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

-- create_event as 20260929184331_invite_and_join.sql wrote it, with album_open last in its result,
-- which both its return query statements fill from list_my_events. A create answers false, and a
-- repeat answers the album's state at the repeat. Its arguments, the rest of its result and every
-- refusal are unchanged, and 20260925105127_create_event_venue_sub_event_membership.sql's header
-- describes them (D-110, D-115).
create function public.create_event(
  p_user_id uuid,
  p_request_id uuid,
  p_name text,
  p_type text,
  p_description text,
  p_approval_mode text,
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
  archived_at timestamptz,
  album_open boolean
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
  -- Every venue is used by a sub-event, so there are at most as many venues as sub-events.
  if v_venue_count not between 1 and v_sub_event_count then
    raise exception 'An event has 1 to % venues, got %', v_sub_event_count, v_venue_count
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
    from generate_series(0, v_venue_count - 1) as i
    where not exists (
      select 1
      from jsonb_array_elements(p_sub_events) as s (value)
      where (s.value ->> 'venue_index')::integer = i
    )
  ) then
    raise exception 'Every venue must be used by a sub-event'
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

  insert into public.event (id, name, type, description, approval_mode, create_request_id)
  values (
    v_event_id,
    p_name,
    p_type,
    nullif(p_description, ''),
    p_approval_mode,
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

  insert into public.sub_event
    (event_id, name, description, starts_at, ends_at, venue_id, verification_radius_m)
  select
    v_event_id,
    s.value ->> 'name',
    nullif(s.value ->> 'description', ''),
    (s.value ->> 'starts_at')::timestamptz,
    (s.value ->> 'ends_at')::timestamptz,
    v_venue_ids[(s.value ->> 'venue_index')::integer + 1],
    (s.value ->> 'verification_radius_m')::integer
  from jsonb_array_elements(p_sub_events) as s (value);

  insert into public.membership (event_id, user_id, role, status)
  values (v_event_id, p_user_id, 'admin', 'active');

  -- One live invite per role, made with the event, so no event exists that nobody can join. The
  -- repeat path above returns before this, so a retry issues none (D-115).
  perform public.issue_invite(v_event_id, 'guest');
  perform public.issue_invite(v_event_id, 'photographer');

  return query
    select 'created'::text, s.*
    from public.list_my_events(p_user_id) as s
    where s.id = v_event_id;
end;
$$;

revoke execute on function public.create_event(uuid, uuid, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_event(uuid, uuid, text, text, text, text, jsonb, jsonb)
  to service_role;

-- get_my_event as 20261010192238_venue_verification.sql wrote it, with album_open last. Like the
-- event's other columns it is null unless the caller's membership is active and the event is not
-- soft-deleted (D-118, D-155).
drop function public.get_my_event(uuid, uuid);

create function public.get_my_event(p_event_id uuid, p_user_id uuid)
returns table (
  deleted boolean,
  role text,
  status text,
  id uuid,
  name text,
  type text,
  cover_key text,
  starts_at timestamptz,
  ends_at timestamptz,
  archived_at timestamptz,
  every_sub_event boolean,
  verified_sub_event_ids uuid[],
  album_open boolean
)
language sql
stable
set search_path = ''
as $$
  select
    e.deleted_at is not null,
    m.role,
    m.status,
    shown.id,
    shown.name,
    shown.type,
    shown.cover_key,
    shown.starts_at,
    shown.ends_at,
    shown.archived_at,
    shown.every_sub_event,
    shown.verified_sub_event_ids,
    shown.album_open
  from public.event e
  left join public.membership m on m.event_id = e.id and m.user_id = p_user_id
  left join lateral (
    select
      e.id, e.name, e.type, e.cover_key, span.starts_at, span.ends_at, e.archived_at,
      m.admin_verified_at is not null or m.role in ('admin', 'photographer') as every_sub_event,
      array (
        select vv.sub_event_id
        from public.venue_verification vv
        join public.sub_event se on se.id = vv.sub_event_id
        where vv.user_id = p_user_id and se.event_id = e.id
        order by vv.sub_event_id
      ) as verified_sub_event_ids,
      e.album_open
    from (
      select min(se.starts_at) as starts_at, max(se.ends_at) as ends_at
      from public.sub_event se
      where se.event_id = e.id
    ) span
    where m.status = 'active' and e.deleted_at is null
  ) shown on true
  where e.id = p_event_id
$$;

revoke execute on function public.get_my_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_my_event(uuid, uuid) to service_role;

-- 5. GET /events/{eventId}/album (spec §4.9, D-161). Manage's status card, and the Close Album
-- dialog, which fetches it again when it opens. p_event_id is the event the API checked the caller
-- is Admin of. In one statement it returns:
--   album_open                     the album's state
--   upload_count                   the event's media rows with uploaded_at set and no deleted_at,
--                                  processed or not
--   photographers_without_uploads  the full_name of every active Photographer who holds no such
--                                  row, sorted by name, with no cap
-- Null for a soft-deleted or unknown event. An archived event answers as any other (D-142). A
-- missing profile gives a null name, which the API's parse refuses loudly rather than leaving a
-- Photographer out; the trigger on auth.users gives every account one.
--
-- security invoker, and callable by the API's secret key only, like event_settings: it checks no
-- caller, so whoever could run it could read any event's counts.
create function public.album_status(p_event_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'album_open', e.album_open,
    'upload_count', (
      select count(*)
      from public.media md
      where md.event_id = e.id and md.uploaded_at is not null and md.deleted_at is null
    ),
    'photographers_without_uploads', coalesce(
      (
        select jsonb_agg(p.full_name order by lower(p.full_name), m.id)
        from public.membership m
        left join public.profile p on p.user_id = m.user_id
        where m.event_id = e.id
          and m.status = 'active'
          and m.role = 'photographer'
          and not exists (
            select 1
            from public.media md
            where md.event_id = e.id
              and md.uploader_user_id = m.user_id
              and md.uploaded_at is not null
              and md.deleted_at is null
          )
      ),
      '[]'::jsonb
    )
  )
  from public.event e
  where e.id = p_event_id
    and e.deleted_at is null
$$;

revoke execute on function public.album_status(uuid) from public, anon, authenticated;
grant execute on function public.album_status(uuid) to service_role;
