-- S-13: Album serving, keyset paging, and Realtime publication on media
-- (D-73, D-147, D-148, arch §1, arch §3, docs/ARCHITECTURE.md).
--
-- Adds:
-- 1. active_event_role(p_event_id) security definer helper.
-- 2. media SELECT RLS policy for Realtime (media_select_realtime).
-- 3. media added to supabase_realtime publication.
-- 4. media_album_idx on media (event_id, sub_event_id, captured_at desc, id desc).
-- 5. Read-only list_album RPC for keyset pagination and section counts.
-- 6. Read-only list_uploaders RPC for the Uploader filter list.

-- 1. active_event_role(event_id) (D-73, D-148, arch §1).
-- Security definer helper returning the caller's role if their membership in the event is active,
-- and null otherwise. media's SELECT policy uses this function because membership has no RLS policy
-- and a plain subquery inside a policy sees no rows for authenticated users.
create function public.active_event_role(p_event_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select m.role
  from public.membership m
  where m.event_id = p_event_id
    and m.user_id = auth.uid()
    and m.status = 'active';
$$;

revoke all on function public.active_event_role(uuid) from public;
grant execute on function public.active_event_role(uuid) to authenticated, service_role;

-- 2. SELECT policy on media for Realtime (D-73, D-148, arch §1).
-- Allows active members to observe updates:
-- - Row must have uploaded_at is not null (a row without uploaded_at is shown to nobody, D-82).
-- - Admins and Guests see published photos (processed_at is not null) or photos they uploaded themselves.
-- - Photographers see only their own uploads (uploader_user_id = auth.uid()).
-- - Soft-deleted rows remain visible so Realtime delivers the deletion (deleted_at update).
create policy media_select_realtime on public.media
  for select
  to authenticated
  using (
    uploaded_at is not null
    and (
      case public.active_event_role(event_id)
        when 'admin' then processed_at is not null or uploader_user_id = auth.uid()
        when 'guest' then processed_at is not null or uploader_user_id = auth.uid()
        when 'photographer' then uploader_user_id = auth.uid()
        else false
      end
    )
  );

-- 3. Add media to the supabase_realtime publication (D-148).
-- Without it Realtime delivers nothing and nothing reports an error.
alter publication supabase_realtime add table public.media;

-- 4. Keyset index for album queries (D-147, D-148).
-- Home sections sort sub-events by starts_at asc, id asc, and photos within a section by
-- captured_at desc, id desc.
create index media_album_idx on public.media (event_id, sub_event_id, captured_at desc, id desc);

-- 5. Read-only list_album RPC (D-148).
-- Returns one keyset page of the album in schedule section order (starts_at asc, id asc,
-- captured_at desc, id desc) plus section counts on the first page (when cursor is null).
create function public.list_album(
  p_event_id uuid,
  p_sub_event_id uuid default null,
  p_uploader_id uuid default null,
  p_after_starts_at timestamptz default null,
  p_after_sub_event_id uuid default null,
  p_after_captured_at timestamptz default null,
  p_after_media_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_media jsonb;
  v_section_counts jsonb := null;
begin
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
    'starts_at', r.starts_at
  )), '[]'::jsonb)
  into v_media
  from (
    select
      m.id,
      m.sub_event_id,
      m.captured_at,
      m.uploader_role_at_upload,
      m.width,
      m.height,
      se.starts_at
    from public.media m
    join public.sub_event se on se.id = m.sub_event_id and se.event_id = m.event_id
    where m.event_id = p_event_id
      and m.processed_at is not null
      and m.deleted_at is null
      and (p_sub_event_id is null or m.sub_event_id = p_sub_event_id)
      and (p_uploader_id is null or m.uploader_user_id = p_uploader_id)
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

revoke execute on function public.list_album(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.list_album(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer)
  to service_role;

-- 6. Read-only list_uploaders RPC (D-148).
-- Returns active members who have at least one published photo in the event.
create function public.list_uploaders(p_event_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uploaders jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', r.user_id,
    'full_name', r.full_name,
    'role', r.role,
    'photo_count', r.photo_count
  ) order by r.photo_count desc, r.full_name asc), '[]'::jsonb)
  into v_uploaders
  from (
    select
      m.user_id,
      p.full_name,
      m.role,
      count(med.id)::int as photo_count
    from public.membership m
    join public.profile p on p.user_id = m.user_id
    join public.media med on med.uploader_user_id = m.user_id and med.event_id = m.event_id
    where m.event_id = p_event_id
      and m.status = 'active'
      and med.processed_at is not null
      and med.deleted_at is null
    group by m.user_id, p.full_name, m.role
  ) r;

  return jsonb_build_object('uploaders', v_uploaders);
end;
$$;

revoke execute on function public.list_uploaders(uuid) from public, anon, authenticated;
grant execute on function public.list_uploaders(uuid) to service_role;
