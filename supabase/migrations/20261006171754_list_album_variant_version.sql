-- A fix to S-13's list_album from /code-review, ruled by Ukasha on 2026-10-06.
-- 20261005195558_album_serving_realtime.sql reached the dev project, so it stays as it is and this
-- migration replaces what changed (D-116).
--
-- Each album item now carries the row's variant_version. The app keys its thumbnail batches on it,
-- so a photo the worker regenerates, for a retroactive Do Not Publish or a blur region, is signed
-- again instead of keeping its pre-blur thumbnail on screen (D-60, root invariant 2).
--
-- jsonb_agg also takes the page's order explicitly. Postgres documents an aggregate fed by a
-- sorted subquery as usually ordered, not as guaranteed, and the API cuts the cursor from the last
-- row of the array.
--
-- The rest is as 20261005195558_album_serving_realtime.sql describes it. The signature is the
-- same, so create or replace keeps the owner and the grants.
create or replace function public.list_album(
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
