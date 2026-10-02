-- Two fixes to S-12's upload functions from /code-review, ruled by Ukasha at S-12's done stage
-- (D-122). 20261002121238_media_upload.sql reached the dev project, so it stays as it is and this
-- migration replaces what changed (D-116).
--
-- One person holds at most p_max_unfinished unfinished rows in an event that are not soft-deleted.
-- Pre-flight needs no upload, so without the limit one member could fill the event's 2,000 places
-- with rows that never finish. A soft-deleted unfinished row never resumes, and completion treats
-- it as gone, so a retry never publishes a photo its uploader deleted.

-- One unfinished row per uploader and hash, among rows that are not soft-deleted, so a photo whose
-- unfinished row was deleted gets a new row. It also serves start_upload's count of the caller's
-- unfinished rows.
drop index public.media_unfinished_key;
create unique index media_unfinished_key
  on public.media (event_id, uploader_user_id, content_hash)
  where uploaded_at is null and deleted_at is null;

-- start_upload gains p_max_unfinished, MAX_UNFINISHED_UPLOADS in the API's media service. A new
-- argument makes a new function, so the old one is dropped rather than replaced.
drop function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer
);

-- POST /events/{eventId}/media/preflight, as 20261002121238_media_upload.sql describes it, with two
-- changes. The resume skips a soft-deleted row, and one more refusal follows full:
--   too_many  p_user_id already holds p_max_unfinished unfinished rows in the event that are not
--             soft-deleted. A resume skips this check, as it skips the cap.
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
  p_max_media integer,
  p_max_unfinished integer
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
    and m.uploaded_at is null
    and m.deleted_at is null;
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

  if (
    select count(*) from public.media m
    where m.event_id = p_event_id
      and m.uploader_user_id = p_user_id
      and m.uploaded_at is null
      and m.deleted_at is null
  ) >= p_max_unfinished then
    outcome := 'too_many';
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

-- security invoker, and callable by the API's secret key only, as before. It takes the user as a
-- parameter, so a caller who could run it could upload as anyone.
revoke execute on function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer
) to service_role;

-- POST /media/{mediaId}/complete, as 20261002121238_media_upload.sql describes it, except that a
-- soft-deleted row answers gone, before the lock and again under it, and nothing changes. The
-- signature is the same, so create or replace keeps the owner, security definer and the grants.
create or replace function public.complete_upload(
  p_media_id uuid,
  p_user_id uuid,
  p_size_bytes bigint
)
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
  select m.event_id into v_event_id
  from public.media m
  where m.id = p_media_id and m.deleted_at is null;
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

  -- Read again under the lock. A duplicate completion may have deleted the row while this one
  -- waited, or its uploader may have soft-deleted it.
  select m.uploader_user_id, m.content_hash, m.uploaded_at
  into v_uploader_user_id, v_content_hash, v_uploaded_at
  from public.media m
  where m.id = p_media_id and m.deleted_at is null;
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
