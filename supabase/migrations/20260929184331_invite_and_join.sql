-- invite, membership.requested_at, and what S-03's endpoints call with rpc: resolve_invite,
-- join_event, and create_event replaced to issue both invites with the event (D-95, D-101, D-102,
-- D-110, D-115, docs/ARCHITECTURE.md arch:invite and arch:membership).
--
-- RLS is on for invite with no policy (D-73, root invariant 14). The API reads and writes it with
-- the secret key, and a lookup returns the preview, never the row (arch §1).
-- apps/api/tests/integration/rls.test.ts checks the refusals, the functions and the constraints
-- below against the dev project.

create table public.invite (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event (id) on delete cascade,
  -- The role a join through this invite takes. The Admin joins through none (D-102).
  role text not null,
  -- The last segment of momentlens://invite/{token} (D-101): 32 random bytes as base64url with no
  -- padding. issue_invite makes it.
  token text not null,
  -- What a guest types on Manual Join Entry. Stored uppercase, from SHORTCODE_ALPHABET in
  -- packages/shared-types, which leaves out 0, O, 1, I and L. issue_invite makes it.
  shortcode text not null,
  -- Revoke and regenerate sets this and inserts a new row (spec §4.4). A revoked invite is dead, as
  -- is every invite of a deleted or archived event. There is no time limit (arch:invite).
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invite_role_check check (role in ('guest', 'photographer')),
  constraint invite_token_check check (token ~ '^[A-Za-z0-9_-]{43}$'),
  constraint invite_shortcode_check check (shortcode ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  -- Unique across every row, revoked ones included, so a reissued token or code never sends an old
  -- share to another event (D-115).
  constraint invite_token_key unique (token),
  constraint invite_shortcode_key unique (shortcode)
);

comment on table public.invite is
  'An event''s Guest Link or Photographer Link and its shortcode (spec §4.4, D-115). RLS on, no policy.';

-- One live invite per role per event.
create unique index invite_one_live_idx on public.invite (event_id, role) where revoked_at is null;
-- The event's delete cascade, which reaches revoked rows too.
create index invite_event_id_idx on public.invite (event_id);

alter table public.invite enable row level security;

-- As for every other table: anon and authenticated keep SELECT, so a stray query from the app reads
-- empty rows rather than an error (invariant 14), and hold no write privilege.
revoke all on table public.invite from anon, authenticated;
grant select on table public.invite to anon, authenticated;
grant select, insert, update, delete on table public.invite to service_role;

-- The join time the Pending Approvals queue shows (spec §2.1.3, D-115). join_event sets it on every
-- join and every rejoin, because created_at would show a returning person their first join. A row
-- older than this migration is given its created_at, and the Admin's row keeps the time
-- create_event made it.
alter table public.membership add column requested_at timestamptz;
update public.membership set requested_at = created_at;
alter table public.membership
  alter column requested_at set default now(),
  alter column requested_at set not null;

comment on column public.membership.requested_at is
  'When this person last asked to join: set by join_event on every join and rejoin (D-115).';

-- 32 bytes from pgcrypto's gen_random_bytes, as base64url with no padding: 43 characters. 32 bytes
-- make 44 base64 characters, the last of them one '=', and encode breaks lines only past 76.
create function public.new_invite_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '='),
    '+/',
    '-_'
  )
$$;

-- 6 characters, each drawn evenly from the 31 of SHORTCODE_ALPHABET. A random byte picks one by its
-- remainder mod 31, and a byte of 248 or more (the largest multiple of 31 under 256) is drawn again,
-- so the first 8 characters are not favoured.
create function public.new_invite_shortcode()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text := '';
  v_byte integer;
begin
  while char_length(v_code) < 6 loop
    v_byte := get_byte(extensions.gen_random_bytes(1), 0);
    if v_byte < 248 then
      v_code := v_code || substr(v_alphabet, v_byte % 31 + 1, 1);
    end if;
  end loop;
  return v_code;
end;
$$;

-- Inserts a live invite for this event and role, with a new token and a new code. About 887
-- million codes exist, so a new one can match one already issued: that draw is retried, up to 10
-- times, where a plain insert would fail the event's create. A clash with invite_one_live_idx is
-- not retried, because it means the event already has a live invite for this role and the caller
-- should have revoked it first.
create function public.issue_invite(p_event_id uuid, p_role text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_constraint text;
begin
  for attempt in 1..10 loop
    begin
      insert into public.invite (event_id, role, token, shortcode)
      values (p_event_id, p_role, public.new_invite_token(), public.new_invite_shortcode());
      return;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint not in ('invite_token_key', 'invite_shortcode_key') then
        raise;
      end if;
    end;
  end loop;
  raise exception 'No unused invite code in 10 draws' using errcode = 'unique_violation';
end;
$$;

-- Both invites for every event made before this migration. Deleted and archived events get them
-- too, so every event has one live invite per role and a restored event comes back joinable.
select public.issue_invite(e.id, r.role)
from public.event e
cross join (values ('guest'), ('photographer')) as r (role);

-- POST /invites/resolve (D-115). One row for a live invite and none for a dead one: an unknown
-- token or code, a revoked invite, or an invite of a deleted or archived event (arch:invite).
--
-- The row is the preview everyone holding the invite sees: the role, the event's id, name and cover
-- key, its span as list_my_events computes it, and its venue names, each once, in the order its
-- first sub-event starts, then by name. It carries no member, no venue position and no qr_secret
-- (arch §1). member_role and member_status are p_user_id's own membership in the event, and null
-- when p_user_id is null or has none. Pass exactly one of p_token and p_shortcode; p_shortcode is
-- matched as stored, so the API uppercases it first.
--
-- security invoker, and callable by the API's secret key only. It takes the user as a parameter,
-- so a caller who could run it could read anyone's membership.
create function public.resolve_invite(p_token text, p_shortcode text, p_user_id uuid)
returns table (
  role text,
  event_id uuid,
  name text,
  cover_key text,
  starts_at timestamptz,
  ends_at timestamptz,
  venue_names text[],
  member_role text,
  member_status text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if num_nonnulls(p_token, p_shortcode) <> 1 then
    raise exception 'Pass exactly one of p_token and p_shortcode'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
    select
      i.role,
      e.id,
      e.name,
      e.cover_key,
      span.starts_at,
      span.ends_at,
      venues.names,
      m.role,
      m.status
    from public.invite i
    join public.event e on e.id = i.event_id
    cross join lateral (
      select min(se.starts_at) as starts_at, max(se.ends_at) as ends_at
      from public.sub_event se
      where se.event_id = e.id
    ) span
    cross join lateral (
      select array_agg(v.name order by v.first_start, v.name, v.id) as names
      from (
        select ve.id, ve.name, min(se.starts_at) as first_start
        from public.venue ve
        join public.sub_event se on se.venue_id = ve.id
        where ve.event_id = e.id
        group by ve.id, ve.name
      ) v
    ) venues
    left join public.membership m on m.event_id = e.id and m.user_id = p_user_id
    where (i.token = p_token or i.shortcode = p_shortcode)
      and i.revoked_at is null
      and e.deleted_at is null
      and e.archived_at is null;
end;
$$;

revoke execute on function public.resolve_invite(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_invite(text, text, uuid) to service_role;

-- POST /invites/join, the only way into an event through an invite (arch:membership). In one
-- transaction it locks the event row, checks the invite is live, refuses a blocked caller, refuses
-- an active Guest past p_max_guests, then inserts p_user_id's row or updates a removed one: active
-- when the event's approval mode is auto, pending when it is manual (D-95, D-102, D-115).
--
-- p_max_guests is the cap on active Guests. The API passes MAX_ACTIVE_GUESTS, 150 (spec §4.17), and
-- the dev-project tests pass a small one. The Admin, Photographers and pending requests never count,
-- and a request to a manual event is let in past the cap, which applies at approval.
--
-- Returns one row, and `outcome` says which:
--   created   this call inserted the row; role and status are the new row's
--   rejoined  p_user_id was removed and this call let them back in, with the invite's role,
--             requested_at now and admin_verified_at cleared
--   member    p_user_id is already active or pending; role and status are their row's, and nothing
--             was written, so an Admin or a Photographer on the Guest Link keeps their role
--   dead      no live invite has this token or code; role and status are null
--   blocked   the event's Admin blocked p_user_id; nothing was written
--   full      p_user_id would be one active Guest past p_max_guests; nothing was written
-- A p_user_id with no account fails the membership foreign key, and nothing is written.
-- Pass exactly one of p_token and p_shortcode, the code as stored.
--
-- S-25 adds the reprocess enqueue here, for a subject with references who becomes active (D-84).
--
-- security invoker, and callable by the API's secret key only. It takes the user as a parameter,
-- so a caller who could run it could put anyone into any event.
create function public.join_event(
  p_user_id uuid,
  p_token text,
  p_shortcode text,
  p_max_guests integer
)
returns table (outcome text, role text, status text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid;
  v_invite_role text;
  v_revoked_at timestamptz;
  v_deleted_at timestamptz;
  v_archived_at timestamptz;
  v_approval_mode text;
  v_member_id uuid;
  v_member_role text;
  v_member_status text;
  v_status text;
begin
  if num_nonnulls(p_token, p_shortcode) <> 1 then
    raise exception 'Pass exactly one of p_token and p_shortcode'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_max_guests is null or p_max_guests < 0 then
    raise exception 'p_max_guests must be 0 or more, got %', p_max_guests
      using errcode = 'invalid_parameter_value';
  end if;

  select i.event_id into v_event_id
  from public.invite i
  where i.token = p_token or i.shortcode = p_shortcode;
  if not found then
    outcome := 'dead';
    return next;
    return;
  end if;

  -- Every join into this event waits here for the one before it to commit, so two joins never both
  -- take the last place. FOR NO KEY UPDATE conflicts with itself and with any update of the event,
  -- a delete or an archive included, but not with the FOR KEY SHARE lock a foreign key check takes,
  -- so inserts that reference the event, uploads among them, carry on. Anything else that makes a
  -- Guest active, S-07's approval among them, must take this same lock.
  select e.deleted_at, e.archived_at, e.approval_mode
  into v_deleted_at, v_archived_at, v_approval_mode
  from public.event e
  where e.id = v_event_id
  for no key update;
  if not found then
    outcome := 'dead';
    return next;
    return;
  end if;

  -- Read again under the lock, so a revoke that committed while this call waited is seen.
  select i.role, i.revoked_at into v_invite_role, v_revoked_at
  from public.invite i
  where i.token = p_token or i.shortcode = p_shortcode;
  if not found
    or v_revoked_at is not null
    or v_deleted_at is not null
    or v_archived_at is not null then
    outcome := 'dead';
    return next;
    return;
  end if;

  select m.id, m.role, m.status into v_member_id, v_member_role, v_member_status
  from public.membership m
  where m.event_id = v_event_id and m.user_id = p_user_id;

  if v_member_status in ('active', 'pending') then
    outcome := 'member';
    role := v_member_role;
    status := v_member_status;
    return next;
    return;
  end if;
  if v_member_status = 'blocked' then
    outcome := 'blocked';
    return next;
    return;
  end if;

  v_status := case when v_approval_mode = 'manual' then 'pending' else 'active' end;

  if v_status = 'active' and v_invite_role = 'guest' and (
    select count(*)
    from public.membership m
    where m.event_id = v_event_id and m.role = 'guest' and m.status = 'active'
  ) >= p_max_guests then
    outcome := 'full';
    return next;
    return;
  end if;

  if v_member_id is null then
    insert into public.membership (event_id, user_id, role, status, requested_at)
    values (v_event_id, p_user_id, v_invite_role, v_status, now());
    outcome := 'created';
  else
    update public.membership m
    set role = v_invite_role, status = v_status, admin_verified_at = null, requested_at = now()
    where m.id = v_member_id;
    outcome := 'rejoined';
  end if;
  role := v_invite_role;
  status := v_status;
  return next;
end;
$$;

revoke execute on function public.join_event(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.join_event(uuid, text, text, integer) to service_role;

-- Called by create_event and the backfill above, never over the Data API. create_event runs as the
-- API's secret key, so service_role needs them.
revoke execute on function public.new_invite_token() from public, anon, authenticated;
revoke execute on function public.new_invite_shortcode() from public, anon, authenticated;
revoke execute on function public.issue_invite(uuid, text) from public, anon, authenticated;
grant execute on function public.new_invite_token() to service_role;
grant execute on function public.new_invite_shortcode() to service_role;
grant execute on function public.issue_invite(uuid, text) to service_role;

-- create_event as 20260925105127_create_event_venue_sub_event_membership.sql wrote it, with the
-- two invite inserts S-03 adds on the create path, after the repeat check (D-110, D-115). Its
-- arguments, its result and every refusal are unchanged, and that migration's header describes
-- them.
create or replace function public.create_event(
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
