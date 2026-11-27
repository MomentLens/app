-- S-22: photo_flag, flag_photo, delete_media, dedup update letting deleted photos re-upload,
-- and list_album uploader metadata (spec §2.5.6, §4.21, D-130, D-160, D-177, D-179, arch §1,
-- arch:media, arch:photo_flag).
--
-- No new RLS policy. photo_flag has RLS on with no policy, SELECT only for anon and authenticated,
-- and full DML for service_role (root invariant 14). Every function here is callable by
-- service_role only.

create table public.photo_flag (
  id uuid primary key default gen_random_uuid(),
  -- media_delete leaves a deleted photo's flags (D-177); the cascade covers an event's hard delete,
  -- which removes its media rows with it.
  media_id uuid not null references public.media (id) on delete cascade,
  -- No ON DELETE action, matching media.uploader_user_id and manual_blur_region.drawn_by_user_id.
  flagged_by_user_id uuid not null references auth.users (id),
  state text not null default 'open',
  created_at timestamptz not null default now(),
  constraint photo_flag_state_check check (state in ('open', 'kept')),
  -- One flag per Guest per photo, so a repeat never duplicates or reopens a kept flag (D-179).
  constraint photo_flag_media_id_flagged_by_user_id_key unique (media_id, flagged_by_user_id)
);

comment on table public.photo_flag is
  'A Guest flag asking the Admin to review a published photo (D-179). RLS on, no policy: the API reads and writes it as service_role.';

alter table public.photo_flag enable row level security;

-- As for media and dnp_subject: anon and authenticated keep SELECT so a stray query returns empty
-- rows rather than an error, and hold no write privilege (root invariant 14).
revoke all on table public.photo_flag from anon, authenticated;
grant select on table public.photo_flag to anon, authenticated;
grant select, insert, update, delete on table public.photo_flag to service_role;

-- POST /media/{mediaId}/flags (D-179, arch:photo_flag). Active Guests only; Admin and Photographer
-- get wrong_role. Takes event then media FOR SHARE, matching add_blur_region's lock order so
-- membership changes and photo deletion serialize cleanly without deadlocking.
--
-- Outcomes, checked in the contract's order (packages/shared-types/src/media.ts):
--   not_found        unknown, unprocessed or soft-deleted photo, or soft-deleted event
--   not_member       caller's membership in the photo's event is not active
--   wrong_role       caller is Admin or Photographer
--   flagged          first flag inserted (201)
--   already_flagged  caller already flagged this photo, open or kept; nothing changes (200)
create function public.flag_photo(p_media_id uuid, p_user_id uuid)
returns table (outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid;
  v_role text;
  v_status text;
begin
  -- A photo's event never changes, so it is safe to read before the lock.
  select m.event_id into v_event_id from public.media m where m.id = p_media_id;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  perform 1 from public.event e
  where e.id = v_event_id and e.deleted_at is null
  for share;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  perform 1 from public.media m
  where m.id = p_media_id and m.processed_at is not null and m.deleted_at is null
  for share;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select mb.role, mb.status into v_role, v_status
  from public.membership mb
  where mb.event_id = v_event_id and mb.user_id = p_user_id;
  if v_status is distinct from 'active' then
    outcome := 'not_member';
    return next;
    return;
  end if;

  if v_role <> 'guest' then
    outcome := 'wrong_role';
    return next;
    return;
  end if;

  insert into public.photo_flag (media_id, flagged_by_user_id)
  values (p_media_id, p_user_id)
  on conflict (media_id, flagged_by_user_id) do nothing;

  if found then
    outcome := 'flagged';
  else
    outcome := 'already_flagged';
  end if;
  return next;
end;
$$;

revoke execute on function public.flag_photo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.flag_photo(uuid, uuid) to service_role;

-- DELETE /media/{mediaId} (D-130, D-160, D-179, arch:media). Sets deleted_at and sends one
-- media_delete message in one transaction. security definer, because pgmq.send writes to the pgmq
-- schema, where service_role has no direct privilege (as complete_upload and add_blur_region).
--
-- Outcomes, checked in the contract's order (packages/shared-types/src/media.ts):
--   not_found     unknown photo, soft-deleted event, or an unfinished row when caller is Admin
--   not_member    caller's membership in the photo's event is not active
--   not_uploader  any other active member (another Guest or Photographer on another's photo), live
--                 or already deleted
--   deleted       deleted_at set and one media_delete job sent (message_id non-null), or already
--                 deleted by either authorized deleter (existing deleted_at, message_id null)
create function public.delete_media(p_media_id uuid, p_user_id uuid)
returns table (outcome text, deleted_at timestamptz, message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid;
  v_event_deleted_at timestamptz;
  v_role text;
  v_status text;
  v_uploader_user_id uuid;
  v_uploaded_at timestamptz;
  v_deleted_at timestamptz;
begin
  -- A photo's event never changes, so it is safe to read before the lock.
  select m.event_id into v_event_id
  from public.media m
  where m.id = p_media_id;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  -- Lock the event row FOR NO KEY UPDATE, as start_upload, complete_upload and membership writes
  -- do (arch:media). This serializes deletion with membership removal, upload completion and dedup.
  select e.deleted_at into v_event_deleted_at
  from public.event e
  where e.id = v_event_id
  for no key update;
  if not found or v_event_deleted_at is not null then
    outcome := 'not_found';
    return next;
    return;
  end if;

  -- Re-read under the lock and lock the row FOR UPDATE. A duplicate completion may have deleted
  -- the row while this call waited.
  select m.uploader_user_id, m.uploaded_at, m.deleted_at
  into v_uploader_user_id, v_uploaded_at, v_deleted_at
  from public.media m
  where m.id = p_media_id
  for update;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select mb.role, mb.status into v_role, v_status
  from public.membership mb
  where mb.event_id = v_event_id and mb.user_id = p_user_id;
  if v_status is distinct from 'active' then
    outcome := 'not_member';
    return next;
    return;
  end if;

  if v_uploader_user_id <> p_user_id then
    if v_role = 'admin' then
      if v_uploaded_at is null then
        outcome := 'not_found';
        return next;
        return;
      end if;
    else
      outcome := 'not_uploader';
      return next;
      return;
    end if;
  end if;

  if v_deleted_at is not null then
    outcome := 'deleted';
    deleted_at := v_deleted_at;
    return next;
    return;
  end if;

  update public.media m
  set deleted_at = now()
  where m.id = p_media_id
  returning m.deleted_at into deleted_at;

  -- The integer delay picks one of pgmq's three-argument overloads, as in complete_upload.
  select pgmq.send('jobs', jsonb_build_object('job', 'media_delete', 'media_id', p_media_id), 0)
  into message_id;

  outcome := 'deleted';
  return next;
end;
$$;

revoke execute on function public.delete_media(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_media(uuid, uuid) to service_role;

-- D-130: a deleted photo can be uploaded again. Leave soft-deleted rows out of the unique hash
-- index, start_upload's duplicate check and complete_upload's duplicate check.
drop index public.media_event_id_content_hash_key;
create unique index media_event_id_content_hash_key
  on public.media (event_id, content_hash)
  where uploaded_at is not null and deleted_at is null;

-- Same signature as 20261011154423_venue_qr.sql, so create or replace keeps the owner and grants.
create or replace function public.start_upload(
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
  p_max_unfinished integer,
  p_verified_sub_event_ids uuid[] default '{}',
  p_qr_scans jsonb default '[]'::jsonb
)
returns table (outcome text, media_id uuid, upload_key text, upload_thumb_key text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
  v_role text;
  v_admin_verified_at timestamptz;
begin
  select e.deleted_at into v_deleted_at
  from public.event e
  where e.id = p_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    return next;
    return;
  end if;

  -- Membership changes take the event lock too. A removal after the API's check must write
  -- neither a check-in nor a photo, and a supplied role must never grant an exemption.
  select m.role, m.admin_verified_at into v_role, v_admin_verified_at
  from public.membership m
  where m.event_id = p_event_id and m.user_id = p_user_id and m.status = 'active';
  if not found then
    outcome := 'not_member';
    return next;
    return;
  end if;

  -- A check-in survives a photo refusal. Ignore another event's or a deleted sub-event's id,
  -- and preserve the first method and server write time on a retry (D-155).
  insert into public.venue_verification (user_id, sub_event_id, method)
  select p_user_id, se.id, 'gps'
  from public.sub_event se
  where se.event_id = p_event_id and se.id = any(p_verified_sub_event_ids)
  on conflict (user_id, sub_event_id) do nothing;

  -- The API selects a target at the scan time. Recheck that selection and the current secret
  -- under this lock, which QR rotation and schedule writes also take (D-85, D-156). A rotated
  -- secret or a changed winner grants no row. GPS was inserted first, so it wins a first-method tie.
  insert into public.venue_verification (user_id, sub_event_id, method)
  select p_user_id, selected.id, 'qr'
  from jsonb_to_recordset(p_qr_scans) as scan (
    sub_event_id uuid, venue_id uuid, secret text, recorded_at timestamptz
  )
  join public.venue v
    on v.id = scan.venue_id and v.event_id = p_event_id
    and encode(v.qr_secret, 'hex') = scan.secret
  cross join lateral (
    select se.id
    from public.sub_event se
    where se.event_id = p_event_id and se.venue_id = v.id
      and se.starts_at <= scan.recorded_at and scan.recorded_at < se.ends_at
    order by se.starts_at desc, se.ends_at, se.id
    limit 1
  ) selected
  where selected.id = scan.sub_event_id
  on conflict (user_id, sub_event_id) do nothing;

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

  -- Live finished photos only: a deleted photo can be uploaded again (D-130).
  if exists (
    select 1 from public.media m
    where m.event_id = p_event_id
      and m.content_hash = p_content_hash
      and m.uploaded_at is not null
      and m.deleted_at is null
  ) then
    outcome := 'duplicate';
    return next;
    return;
  end if;

  if v_role not in ('admin', 'photographer') and v_admin_verified_at is null and not exists (
    select 1 from public.venue_verification vv
    where vv.user_id = p_user_id and vv.sub_event_id = p_sub_event_id
  ) then
    outcome := 'unverified';
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
    p_media_id, p_event_id, p_sub_event_id, p_user_id, v_role, coalesce(p_captured_at, now()),
    p_content_hash, p_upload_key, p_upload_thumb_key
  );

  outcome := 'created';
  media_id := p_media_id;
  upload_key := p_upload_key;
  upload_thumb_key := p_upload_thumb_key;
  return next;
end;
$$;

-- Same signature as 20261125084552_complete_upload_face_process.sql, keeping face_process and
-- leaving soft-deleted rows out of the duplicate check (D-130). create or replace keeps grants.
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

  -- Membership changes take the same event lock, so removal cannot pass completion.
  if not exists (
    select 1 from public.membership m
    where m.event_id = v_event_id and m.user_id = p_user_id and m.status = 'active'
  ) then
    outcome := 'not_member';
    return next;
    return;
  end if;

  if v_uploaded_at is not null then
    outcome := 'completed';
    return next;
    return;
  end if;

  -- Live finished photos only: a deleted photo can be uploaded again (D-130).
  if exists (
    select 1 from public.media m
    where m.event_id = v_event_id
      and m.content_hash = v_content_hash
      and m.uploaded_at is not null
      and m.deleted_at is null
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
  select pgmq.send('jobs', jsonb_build_object('job', 'face_process', 'media_id', p_media_id), 0)
  into message_id;

  outcome := 'completed';
  return next;
end;
$$;

-- D-179: list_album joins profile so AlbumMediaItem carries uploader_user_id and uploader_name.
--
-- S-23's 20261125082442_face_visibility_people.sql dropped the eight-argument list_album and
-- created an eleven-argument one with p_viewer_id, p_person_id and p_cluster_id (D-176). This
-- replaces S-23's function with its body unchanged plus the profile join. A `create or replace` on
-- the eight-argument signature would create that one again beside S-23's, and a call naming only
-- the eight original arguments would then fail with "function public.list_album(...) is not
-- unique".
--
-- The eight-argument function is dropped if present: S-23 has dropped it wherever S-23's migration
-- ran, and it still exists where S-22 reaches a database first. The body calls S-23's
-- public.face_hidden, which Postgres resolves only when p_person_id is set, so S-22's API, which
-- never sets it, works either way. S-22's stack merges after S-23's schema PR.
drop function if exists public.list_album(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer);

-- A left join on profile, so a missing profile fails the API's contract parsing with a 500 rather
-- than silently dropping a photo from the page and desyncing section_counts.
create or replace function public.list_album(
  p_event_id uuid,
  p_sub_event_id uuid default null,
  p_uploader_id uuid default null,
  p_after_starts_at timestamptz default null,
  p_after_sub_event_id uuid default null,
  p_after_captured_at timestamptz default null,
  p_after_media_id uuid default null,
  p_limit integer default 50,
  p_viewer_id uuid default null,
  p_person_id uuid default null,
  p_cluster_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_subject_id uuid;
  v_media jsonb;
  v_section_counts jsonb := null;
begin
  if p_person_id is not null and p_cluster_id is not null then
    raise exception 'list_album takes a person or a cluster, not both'
      using errcode = '22023';
  end if;

  if p_person_id is not null then
    if p_viewer_id is null then
      raise exception 'list_album needs the viewer to filter by a person'
        using errcode = '22004';
    end if;

    select s.id
    into v_subject_id
    from public.subject s
    where s.user_id = p_person_id
      and not public.face_hidden(s.id, p_event_id, p_viewer_id);

    -- The page a stranger's id gets: no media, and on the first page no sections.
    if v_subject_id is null then
      return jsonb_build_object(
        'media', '[]'::jsonb,
        'section_counts', case when p_after_media_id is null then '[]'::jsonb end
      );
    end if;
  end if;

  -- Section counts only when no cursor was passed (first page)
  if p_after_media_id is null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'sub_event_id', sc.sub_event_id,
      'count', sc.c
    ) order by sc.starts_at asc, sc.sub_event_id asc), '[]'::jsonb)
    into v_section_counts
    from (
      select m.sub_event_id, se.starts_at, count(*)::int as c
      from public.media m
      join public.sub_event se on se.id = m.sub_event_id and se.event_id = m.event_id
      where m.event_id = p_event_id
        and m.processed_at is not null
        and m.deleted_at is null
        and (p_sub_event_id is null or m.sub_event_id = p_sub_event_id)
        and (p_uploader_id is null or m.uploader_user_id = p_uploader_id)
        and (v_subject_id is null or exists (
          select 1 from public.face f
          where f.media_id = m.id and f.matched_subject_id = v_subject_id
        ))
        and (p_cluster_id is null or exists (
          select 1 from public.face f
          where f.media_id = m.id and f.cluster_id = p_cluster_id and f.matched_subject_id is null
        ))
      group by m.sub_event_id, se.starts_at
    ) sc;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'sub_event_id', r.sub_event_id,
    'captured_at', r.captured_at,
    'uploader_user_id', r.uploader_user_id,
    'uploader_name', r.uploader_name,
    'uploader_role', r.uploader_role_at_upload,
    'width', r.width,
    'height', r.height,
    'variant_version', r.variant_version,
    'starts_at', r.starts_at
  ) order by r.starts_at asc, r.sub_event_id asc, r.captured_at desc, r.id desc), '[]'::jsonb)
  into v_media
  from (
    select
      m.id,
      m.sub_event_id,
      m.captured_at,
      m.uploader_user_id,
      p.full_name as uploader_name,
      m.uploader_role_at_upload,
      m.width,
      m.height,
      m.variant_version,
      se.starts_at
    from public.media m
    join public.sub_event se on se.id = m.sub_event_id and se.event_id = m.event_id
    left join public.profile p on p.user_id = m.uploader_user_id
    where m.event_id = p_event_id
      and m.processed_at is not null
      and m.deleted_at is null
      and (p_sub_event_id is null or m.sub_event_id = p_sub_event_id)
      and (p_uploader_id is null or m.uploader_user_id = p_uploader_id)
      and (v_subject_id is null or exists (
        select 1 from public.face f
        where f.media_id = m.id and f.matched_subject_id = v_subject_id
      ))
      and (p_cluster_id is null or exists (
        select 1 from public.face f
        where f.media_id = m.id and f.cluster_id = p_cluster_id and f.matched_subject_id is null
      ))
      and (
        p_after_media_id is null
        or (se.starts_at, se.id) > (p_after_starts_at, p_after_sub_event_id)
        or (se.id = p_after_sub_event_id and (m.captured_at, m.id) < (p_after_captured_at, p_after_media_id))
      )
    order by se.starts_at asc, se.id asc, m.captured_at desc, m.id desc
    limit (p_limit + 1)
  ) r;

  return jsonb_build_object(
    'media', v_media,
    'section_counts', v_section_counts
  );
end;
$$;

-- `create or replace` keeps S-23's grants, but repeat them so the function stays service_role only
-- on a database where this statement created it.
revoke execute on function public.list_album(
  uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.list_album(
  uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, uuid, uuid, uuid
) to service_role;
