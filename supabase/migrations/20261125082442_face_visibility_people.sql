-- S-23: Find My Photos, the People list and the Recognized Faces strip, all read through one
-- viewer-scoped rule for which matched faces a viewer may see (D-46, D-176, spec §4.11.3,
-- arch:face).
--
-- Adds:
-- 1. face_hidden, the one rule. The album's person filter, list_people and list_photo_faces all
--    call it, so the three reads cannot disagree about who is hidden.
-- 2. face_cluster_idx, for the Unknown filter.
-- 3. list_album with p_viewer_id, p_person_id and p_cluster_id, in place of the eight-argument one.
-- 4. list_people, the People half of the filter sheet.
-- 5. list_photo_faces, the Recognized Faces strip on one photo.
--
-- Every function runs as security invoker and executes for service_role only. The API checks the
-- event, the caller's membership and role before it calls one (root invariant 14), and passes the
-- caller's user id from the session as p_viewer_id, never a value from the request (D-176).

-- 1. face_hidden (D-46, D-176).
-- True when the subject's membership in this event has Do Not Publish on and the subject is not
-- the viewer. The membership's status does not matter: a subject who left the event stays hidden,
-- as they stay blurred (D-175). A read predicate on the viewer, never a write-time exclusion: the
-- subject sees their own face listed normally (root invariant 4).
--
-- A null viewer hides every Do Not Publish subject, because `is distinct from null` is true. A
-- caller that forgot the viewer hides too much, never too little.
create function public.face_hidden(p_subject_id uuid, p_event_id uuid, p_viewer_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.subject s
    join public.membership mb on mb.user_id = s.user_id and mb.event_id = p_event_id
    where s.id = p_subject_id
      and mb.dnp_activated_at is not null
      and s.user_id is distinct from p_viewer_id
  );
$$;

revoke all on function public.face_hidden(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.face_hidden(uuid, uuid, uuid) to service_role;

-- 2. The Unknown filter finds a cluster's faces through this index, as the person filter finds a
-- subject's through face_matched_subject_idx.
create index face_cluster_idx on public.face (cluster_id) where cluster_id is not null;

-- 3. list_album with the person and cluster filters (D-148, D-176).
-- 20261006171754_list_album_variant_version.sql reached the dev project, so it stays as it is and
-- this migration replaces the function (D-116). The new arguments change the signature, so the old
-- one is dropped first: with both present, a call that names only the old arguments matches two
-- functions and fails. The new arguments default to null, so the API's current call, which names
-- only the old ones, still works between this push and S-23's api deploy.
--
-- - p_person_id is a user id, as p_uploader_id is. It keeps photos with a face matched to that
--   user's subject. A user with no subject, or one face_hidden hides from this viewer, returns the
--   same empty page, so the answer never says who turned Do Not Publish on (D-176).
-- - p_cluster_id keeps photos with a face in that Unknown cluster. face_cluster_check already keeps
--   a matched face out of every cluster; the query says so too.
-- - The two are exclusive. Either one stacks with p_sub_event_id and p_uploader_id.
-- - The person filter does not check the person's membership status, as the uploader filter does
--   not: a removed member's photos stay in the album, and none of them is hidden from anyone.
drop function public.list_album(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer);

create function public.list_album(
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
      m.uploader_role_at_upload,
      m.width,
      m.height,
      m.variant_version,
      se.starts_at
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

revoke execute on function public.list_album(
  uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.list_album(
  uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, uuid, uuid, uuid
) to service_role;

-- 4. list_people, the People half of the filter sheet (spec §2.5.2, D-176).
-- Each person with at least one face matched in this event's published photos, with the number of
-- those photos. Left off: a person face_hidden hides from this viewer, and a person whose
-- membership is not active, as list_uploaders leaves them off (D-148). Unknown clusters are not
-- listed here; they are reached only by tapping a face (spec §2.5.2).
--
-- The rule runs once per person, after grouping, not once per face.
create function public.list_people(p_event_id uuid, p_viewer_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_people jsonb;
begin
  if p_viewer_id is null then
    raise exception 'list_people needs the viewer' using errcode = '22004';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', r.user_id,
    'full_name', r.full_name,
    'photo_count', r.photo_count
  ) order by r.photo_count desc, r.full_name asc, r.user_id asc), '[]'::jsonb)
  into v_people
  from (
    select s.id as subject_id, s.user_id, p.full_name, count(distinct med.id)::int as photo_count
    from public.media med
    join public.face f on f.media_id = med.id
    join public.subject s on s.id = f.matched_subject_id
    join public.membership mb on mb.user_id = s.user_id and mb.event_id = med.event_id
    join public.profile p on p.user_id = s.user_id
    where med.event_id = p_event_id
      and med.processed_at is not null
      and med.deleted_at is null
      and mb.status = 'active'
    group by s.id, s.user_id, p.full_name
  ) r
  where not public.face_hidden(r.subject_id, p_event_id, p_viewer_id);

  return jsonb_build_object('people', v_people);
end;
$$;

revoke execute on function public.list_people(uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_people(uuid, uuid) to service_role;

-- 5. list_photo_faces, the Recognized Faces strip (spec §2.5.6, D-176).
-- Null when the photo is not a published, undeleted photo of this event, which the API answers
-- with 404 not_found. Otherwise each identity in the photo once: a person by user id and name, or
-- an Unknown cluster by its id. No box and no crop leave the database.
--
-- Left off: a face face_hidden hides from this viewer, a face matched to someone whose membership
-- is not active (D-176), and a face with neither a match nor a cluster, which every face is while
-- arch §6 has no thresholds (D-172).
--
-- Ordered by each identity's leftmost face, so the strip reads the photo left to right, then by
-- id so two identities at the same x keep one order.
create function public.list_photo_faces(p_event_id uuid, p_media_id uuid, p_viewer_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_faces jsonb;
begin
  if p_viewer_id is null then
    raise exception 'list_photo_faces needs the viewer' using errcode = '22004';
  end if;

  if not exists (
    select 1
    from public.media m
    where m.id = p_media_id
      and m.event_id = p_event_id
      and m.processed_at is not null
      and m.deleted_at is null
  ) then
    return null;
  end if;

  select coalesce(jsonb_agg(e.entry order by e.first_x asc, e.sort_id asc), '[]'::jsonb)
  into v_faces
  from (
    select
      jsonb_build_object('kind', 'person', 'user_id', s.user_id, 'full_name', p.full_name) as entry,
      min(f.x) as first_x,
      s.user_id as sort_id
    from public.face f
    join public.subject s on s.id = f.matched_subject_id
    join public.membership mb
      on mb.user_id = s.user_id and mb.event_id = p_event_id and mb.status = 'active'
    join public.profile p on p.user_id = s.user_id
    where f.media_id = p_media_id
      and not public.face_hidden(s.id, p_event_id, p_viewer_id)
    group by s.user_id, p.full_name
    union all
    select
      jsonb_build_object('kind', 'unknown', 'cluster_id', f.cluster_id),
      min(f.x),
      f.cluster_id
    from public.face f
    where f.media_id = p_media_id
      and f.matched_subject_id is null
      and f.cluster_id is not null
    group by f.cluster_id
  ) e;

  return jsonb_build_object('faces', v_faces);
end;
$$;

revoke execute on function public.list_photo_faces(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_photo_faces(uuid, uuid, uuid) to service_role;
