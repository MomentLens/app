-- media, the jobs queue, and the two functions behind S-12's endpoints: start_upload for
-- POST /events/{eventId}/media/preflight and complete_upload for POST /media/{mediaId}/complete
-- (D-82, D-95, D-96, D-98, D-122, docs/ARCHITECTURE.md arch:media, §4 and §5). It also replaces
-- delete_sub_event with one that refuses a sub-event with any media row (D-121).
--
-- RLS is on for media with no policy (D-73, root invariant 14). The API reads and writes it with the
-- secret key and makes every decision about it in its service layer. S-13 adds the one policy it
-- gets, SELECT for Realtime. apps/api/tests/integration/rls.test.ts runs both functions, the
-- refusals and the constraints below against the dev project.

-- The worker's one queue (arch §5, D-103). pgmq lives in its own schema, which the Data API does not
-- expose, so only a SQL function sends to it, inside the transaction that marks the row uploaded
-- (D-95). The worker reads it over DATABASE_URL.
create extension if not exists pgmq;
select pgmq.create('jobs');

-- The target of media's sub-event foreign key, which keeps a photo inside its sub-event's event, so
-- no path can file a photo under another event's sub-event (D-122).
alter table public.sub_event add constraint sub_event_id_event_id_key unique (id, event_id);

create table public.media (
  -- No default. The API makes the id and builds both upload keys from it before the insert (D-70).
  id uuid primary key,
  event_id uuid not null references public.event (id) on delete cascade,
  sub_event_id uuid not null,
  -- No ON DELETE action, so an account with photos cannot be deleted until support removes them.
  -- Deletion goes through support (spec §4.19), and Ukasha ruled this at S-12's api build.
  uploader_user_id uuid not null references auth.users (id),
  -- Display only. It drives the Uploader filter chip and never an authorization check (D-13).
  uploader_role_at_upload text not null,
  -- The photo's EXIF time, or the pre-flight's when it has none (D-98).
  captured_at timestamptz not null,
  -- SHA-256 over the exact bytes uploaded, after the EXIF strip and the JPEG conversion (root
  -- invariant 7).
  content_hash text not null,
  -- The photo's size from R2's HEAD at completion, the thumbnail not included (D-122).
  size_bytes bigint,
  -- Written by the API at pre-flight, from the id (arch §3, root invariant 12).
  upload_key text not null,
  upload_thumb_key text not null,
  -- Set by complete_upload, in the transaction that enqueues the row's job (D-82, D-95).
  uploaded_at timestamptz,
  -- Written by the worker, which builds these keys itself (D-60, D-69, D-70).
  public_key text,
  public_thumb_key text,
  -- 0 at insert, so the worker's first write makes it 1 (D-122). Every object key the worker writes
  -- carries it (root invariant 2).
  variant_version integer not null default 0,
  width integer,
  height integer,
  -- Written last by the worker. It is what makes the row album-visible (root invariant 1, D-55).
  processed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  -- No ON DELETE action. A sub-event with any media row, unfinished or soft-deleted included,
  -- cannot be deleted, and delete_sub_event says so before the key would (D-121). Deleting the
  -- event still works: its cascade removes the media rows in the same statement.
  constraint media_sub_event_id_fkey foreign key (sub_event_id, event_id)
    references public.sub_event (id, event_id),
  constraint media_uploader_role_at_upload_check check (
    uploader_role_at_upload in ('admin', 'photographer', 'guest')
  ),
  constraint media_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  -- The serving endpoint presigns these for the row's viewers. A key outside the row's own family,
  -- such as another photo's, would hand that file to all of them.
  constraint media_upload_key_check check (upload_key = id::text || '/upload.jpg'),
  constraint media_upload_thumb_key_check check (
    upload_thumb_key = id::text || '/upload_thumb.webp'
  ),
  constraint media_size_bytes_check check (size_bytes >= 0),
  constraint media_size_bytes_uploaded_check check ((size_bytes is null) = (uploaded_at is null)),
  -- No row is published before its upload finished.
  constraint media_processed_at_check check (processed_at is null or uploaded_at is not null),
  constraint media_variant_version_check check (variant_version >= 0),
  constraint media_width_check check (width > 0),
  constraint media_height_check check (height > 0)
);

comment on table public.media is
  'One photo in an event. Album-visible once processed_at is set (D-55). At most 2,000 per event that are not soft-deleted (spec §4.17). RLS on, no policy until S-13.';

-- A finished photo's bytes appear once per event, soft-deleted rows included, so a restored photo
-- never collides with its re-upload (D-96). start_upload's duplicate lookup and complete_upload's.
create unique index media_event_id_content_hash_key
  on public.media (event_id, content_hash) where uploaded_at is not null;
-- start_upload's resume lookup. Unique, so one account holds one unfinished row per photo even if
-- the event lock were ever left out (D-122).
create unique index media_unfinished_key
  on public.media (event_id, uploader_user_id, content_hash) where uploaded_at is null;
-- start_upload's count against the cap, and the event's delete cascade.
create index media_event_id_idx on public.media (event_id);
-- delete_sub_event's check, and the sub-event foreign key.
create index media_sub_event_id_idx on public.media (sub_event_id);

alter table public.media enable row level security;

-- As for event: anon and authenticated keep SELECT, so a stray query from the app reads empty rows
-- rather than an error (invariant 14), and hold no write privilege, so a policy added by mistake
-- still could not let the app write.
revoke all on table public.media from anon, authenticated;
grant select on table public.media to anon, authenticated;
grant select, insert, update, delete on table public.media to service_role;

-- POST /events/{eventId}/media/preflight. Called after the API's checks that p_user_id is an active
-- member of p_event_id, holding p_role, and that the album is open (D-122). p_media_id and both keys
-- are new, built by the API from the id. p_captured_at is null when the photo has no EXIF time, and
-- the row then takes the time of this call (D-98). p_max_media is MAX_EVENT_MEDIA in the API's media
-- service (spec §4.17).
--
-- It locks the event row, then decides under the lock, in this order (arch §4, D-82, D-96, D-122):
--   not_found          the event is soft-deleted, or does not exist
--   sub_event_missing  p_sub_event_id is not a sub-event of p_event_id: another event's, or deleted
--   resumed            p_user_id's own unfinished row with this hash, returned with its own id and
--                      keys, whatever the call sent, even when another user's finished row has the
--                      hash. Completion answers that one. A resume skips the cap.
--   duplicate          a finished row in the event has this hash, a soft-deleted one included.
--                      Another user's unfinished row is not one.
--   full               the event holds p_max_media rows that are not soft-deleted, unfinished ones
--                      included
--   created            the row was inserted with the call's id and keys
-- S-15 adds the verification check between duplicate and full. The id and keys are null for every
-- refusal, and a refusal writes nothing. Two devices on one account sending one photo at once take
-- turns on the lock and end with one row, one created and one resumed. Two pre-flights at one row
-- under the cap take turns too, and the second answers full.
--
-- security invoker, and callable by the API's secret key only. It takes the user as a parameter, so
-- a caller who could run it could upload as anyone.
create function public.start_upload(
  p_media_id uuid,
  p_event_id uuid,
  p_sub_event_id uuid,
  p_user_id uuid,
  p_role text,
  p_content_hash text,
  p_captured_at timestamptz,
  p_upload_key text,
  p_upload_thumb_key text,
  p_max_media integer
)
returns table (outcome text, media_id uuid, upload_key text, upload_thumb_key text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
begin
  -- The lock D-121's sub-event writes take. The event row is not changed, so FOR NO KEY UPDATE
  -- leaves foreign key checks against it free.
  select e.deleted_at into v_deleted_at
  from public.event e
  where e.id = p_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    return next;
    return;
  end if;

  if not exists (
    select 1 from public.sub_event se where se.id = p_sub_event_id and se.event_id = p_event_id
  ) then
    outcome := 'sub_event_missing';
    return next;
    return;
  end if;

  select m.id, m.upload_key, m.upload_thumb_key into media_id, upload_key, upload_thumb_key
  from public.media m
  where m.event_id = p_event_id
    and m.uploader_user_id = p_user_id
    and m.content_hash = p_content_hash
    and m.uploaded_at is null;
  if found then
    outcome := 'resumed';
    return next;
    return;
  end if;

  if exists (
    select 1 from public.media m
    where m.event_id = p_event_id and m.content_hash = p_content_hash and m.uploaded_at is not null
  ) then
    outcome := 'duplicate';
    return next;
    return;
  end if;

  if (
    select count(*) from public.media m where m.event_id = p_event_id and m.deleted_at is null
  ) >= p_max_media then
    outcome := 'full';
    return next;
    return;
  end if;

  insert into public.media (
    id, event_id, sub_event_id, uploader_user_id, uploader_role_at_upload, captured_at,
    content_hash, upload_key, upload_thumb_key
  )
  values (
    p_media_id, p_event_id, p_sub_event_id, p_user_id, p_role, coalesce(p_captured_at, now()),
    p_content_hash, p_upload_key, p_upload_thumb_key
  );

  outcome := 'created';
  media_id := p_media_id;
  upload_key := p_upload_key;
  upload_thumb_key := p_upload_thumb_key;
  return next;
end;
$$;

revoke execute on function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer
) from public, anon, authenticated;
grant execute on function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer
) to service_role;

-- POST /media/{mediaId}/complete. Called after the API found the row, checked p_user_id uploaded it
-- and is still an active member of a live event, and found both objects in R2 (D-122). p_size_bytes
-- is the photo's size from the HEAD.
--
-- It locks the row's event as start_upload does, then decides under the lock (D-95, D-96, D-122):
--   gone          no row has this id: another completion deleted it as a duplicate
--   not_found     the event is soft-deleted
--   not_uploader  p_user_id did not upload the row
--   completed     with message_id null: the row was already uploaded, and nothing changed
--   duplicate     another finished row in the event has the hash. This row is deleted, and its two
--                 objects are the API's to delete.
--   completed     with message_id: uploaded_at and size_bytes are set, and the row's one job is on
--                 the jobs queue, in this transaction
-- The job is thumbnail_dims until S-21 replaces this function with one that sends face_process.
-- Never both (D-72). processed_at stays null; the worker sets it last (D-55). Two completions of one
-- hash take turns on the lock and end as one completed and one duplicate, never a unique violation.
--
-- security definer, because pgmq.send writes to the queue's table in the pgmq schema, where the
-- API's role has no privilege, and should get none: this function is the one way a job reaches the
-- queue from the API. Callable by the API's secret key only, as start_upload is.
create function public.complete_upload(p_media_id uuid, p_user_id uuid, p_size_bytes bigint)
returns table (outcome text, message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid;
  v_deleted_at timestamptz;
  v_uploader_user_id uuid;
  v_content_hash text;
  v_uploaded_at timestamptz;
begin
  -- A row's event never changes, so it is safe to read before the lock.
  select m.event_id into v_event_id from public.media m where m.id = p_media_id;
  if not found then
    outcome := 'gone';
    return next;
    return;
  end if;

  select e.deleted_at into v_deleted_at
  from public.event e
  where e.id = v_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    return next;
    return;
  end if;

  -- Read again under the lock: a duplicate completion may have deleted the row while this one
  -- waited.
  select m.uploader_user_id, m.content_hash, m.uploaded_at
  into v_uploader_user_id, v_content_hash, v_uploaded_at
  from public.media m
  where m.id = p_media_id;
  if not found then
    outcome := 'gone';
    return next;
    return;
  end if;

  if v_uploader_user_id <> p_user_id then
    outcome := 'not_uploader';
    return next;
    return;
  end if;

  if v_uploaded_at is not null then
    outcome := 'completed';
    return next;
    return;
  end if;

  if exists (
    select 1 from public.media m
    where m.event_id = v_event_id and m.content_hash = v_content_hash and m.uploaded_at is not null
  ) then
    delete from public.media m where m.id = p_media_id;
    outcome := 'duplicate';
    return next;
    return;
  end if;

  update public.media m
  set uploaded_at = now(), size_bytes = p_size_bytes
  where m.id = p_media_id;

  -- The integer delay picks one of pgmq's three-argument overloads; the others take headers or a
  -- time.
  select pgmq.send('jobs', jsonb_build_object('job', 'thumbnail_dims', 'media_id', p_media_id), 0)
  into message_id;

  outcome := 'completed';
  return next;
end;
$$;

revoke execute on function public.complete_upload(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.complete_upload(uuid, uuid, bigint) to service_role;

-- DELETE /sub-events/{subEventId}, as 20261001203656_sub_event_writes.sql wrote it, plus one refusal
-- before the delete (D-121):
--   has_media  any media row has this sub-event, unfinished or soft-deleted included
-- It comes after last, so the event's only sub-event always answers last. The privileges set on the
-- function in that migration stay, because create or replace keeps them.
create or replace function public.delete_sub_event(p_event_id uuid, p_sub_event_id uuid)
returns table (outcome text, schedule jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
  v_venue_id uuid;
begin
  -- The same lock as add_sub_event, and as start_upload, so no photo arrives between the check
  -- below and the delete.
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

  if exists (select 1 from public.media m where m.sub_event_id = p_sub_event_id) then
    outcome := 'has_media';
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
