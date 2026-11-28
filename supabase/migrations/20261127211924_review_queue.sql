-- S-24: Review Queue state on manual_blur_region, partial open indexes on photo_flag and
-- manual_blur_region, Admin-drawn blur regions starting kept, and keep_photo_flags / keep_blur_region
-- (spec §2.5.7, D-24, D-83, D-181, arch:manual_blur_region, arch:photo_flag).
--
-- No new RLS policy. Both tables keep RLS enabled with no policy (root invariant 14).

alter table public.manual_blur_region
  add column state text not null default 'open',
  add constraint manual_blur_region_state_check check (state in ('open', 'kept'));

-- Partial open indexes for the Admin Review Queue list queries and open counts (D-181).
create index photo_flag_open_media_idx
  on public.photo_flag (media_id, created_at desc)
  where state = 'open';

create index manual_blur_region_open_media_idx
  on public.manual_blur_region (media_id, created_at desc, id desc)
  where state = 'open';

-- Same signature and lock order as 20261119204755_manual_blur_region.sql. Guest-drawn regions
-- start 'open' so they enter the Review Queue; Admin-drawn regions start 'kept' so they stay
-- active on the photo without queuing the Admin's own draws (D-181).
create or replace function public.add_blur_region(
  p_region_id uuid,
  p_media_id uuid,
  p_user_id uuid,
  p_x double precision,
  p_y double precision,
  p_width double precision,
  p_height double precision
)
returns table (outcome text, role text, message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid;
  v_status text;
  v_existing_media uuid;
  v_existing_drawer uuid;
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

  select mb.role, mb.status into role, v_status
  from public.membership mb
  where mb.event_id = v_event_id and mb.user_id = p_user_id;
  if v_status is distinct from 'active' then
    role := null;
    outcome := 'not_member';
    return next;
    return;
  end if;

  if role = 'photographer' then
    outcome := 'wrong_role';
    return next;
    return;
  end if;

  insert into public.manual_blur_region as r (
    id, media_id, drawn_by_user_id, x, y, width, height, state
  )
  values (
    p_region_id,
    p_media_id,
    p_user_id,
    p_x,
    p_y,
    p_width,
    p_height,
    case when role = 'admin' then 'kept' else 'open' end
  )
  on conflict (id) do nothing;

  if not found then
    select r.media_id, r.drawn_by_user_id into v_existing_media, v_existing_drawer
    from public.manual_blur_region r
    where r.id = p_region_id;
    -- A region deleted between the insert and this read reads as taken, which the phone shows as
    -- a failed save.
    if v_existing_media = p_media_id and v_existing_drawer = p_user_id then
      outcome := 'repeat';
    else
      outcome := 'duplicate';
    end if;
    return next;
    return;
  end if;

  -- The integer delay picks one of pgmq's three-argument overloads, as in complete_upload.
  select pgmq.send('jobs', jsonb_build_object('job', 'blur_region', 'media_id', p_media_id), 0)
  into message_id;

  outcome := 'added';
  return next;
end;
$$;

revoke execute on function public.add_blur_region(
  uuid, uuid, uuid, double precision, double precision, double precision, double precision
) from public, anon, authenticated;
grant execute on function public.add_blur_region(
  uuid, uuid, uuid, double precision, double precision, double precision, double precision
) to service_role;

-- POST /media/{mediaId}/flags/keep (D-181, arch:photo_flag). Marks every currently open flag on
-- the published photo 'kept' in one transaction under event and media share locks.
--
-- Outcomes, checked in the contract's order (packages/shared-types/src/review-queue.ts):
--   not_found   unknown, unprocessed or soft-deleted photo, or soft-deleted event
--   not_member  caller's membership in the photo's event is not active
--   wrong_role  caller is Guest or Photographer
--   kept        open flags marked kept (kept_count may be 0 idempotently)
create function public.keep_photo_flags(p_media_id uuid, p_user_id uuid)
returns table (outcome text, kept_count integer)
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
    kept_count := 0;
    return next;
    return;
  end if;

  perform 1 from public.event e
  where e.id = v_event_id and e.deleted_at is null
  for share;
  if not found then
    outcome := 'not_found';
    kept_count := 0;
    return next;
    return;
  end if;

  perform 1 from public.media m
  where m.id = p_media_id and m.processed_at is not null and m.deleted_at is null
  for share;
  if not found then
    outcome := 'not_found';
    kept_count := 0;
    return next;
    return;
  end if;

  select mb.role, mb.status into v_role, v_status
  from public.membership mb
  where mb.event_id = v_event_id and mb.user_id = p_user_id;
  if v_status is distinct from 'active' then
    outcome := 'not_member';
    kept_count := 0;
    return next;
    return;
  end if;

  if v_role <> 'admin' then
    outcome := 'wrong_role';
    kept_count := 0;
    return next;
    return;
  end if;

  update public.photo_flag pf
  set state = 'kept'
  where pf.media_id = p_media_id and pf.state = 'open';
  get diagnostics kept_count = row_count;

  outcome := 'kept';
  return next;
end;
$$;

revoke execute on function public.keep_photo_flags(uuid, uuid) from public, anon, authenticated;
grant execute on function public.keep_photo_flags(uuid, uuid) to service_role;

-- POST /blur-regions/{regionId}/keep (D-181, arch:manual_blur_region). Sets state = 'kept' under
-- event and media share locks plus a row lock on the region, without enqueuing blur_region.
--
-- Outcomes, checked in the contract's order (packages/shared-types/src/review-queue.ts):
--   not_found   unknown or concurrently removed region, unprocessed/deleted photo, or deleted event
--   not_member  caller's membership in the photo's event is not active
--   wrong_role  caller is Guest or Photographer
--   kept        region is kept (idempotent when already kept)
create function public.keep_blur_region(p_region_id uuid, p_user_id uuid)
returns table (outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_media_id uuid;
  v_event_id uuid;
  v_role text;
  v_status text;
  v_state text;
begin
  -- A region's photo and a photo's event never change, so both are safe to read before the lock.
  select r.media_id, m.event_id into v_media_id, v_event_id
  from public.manual_blur_region r
  join public.media m on m.id = r.media_id
  where r.id = p_region_id;
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
  where m.id = v_media_id and m.processed_at is not null and m.deleted_at is null
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

  if v_role <> 'admin' then
    outcome := 'wrong_role';
    return next;
    return;
  end if;

  select r.state into v_state
  from public.manual_blur_region r
  where r.id = p_region_id
  for update;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  if v_state <> 'kept' then
    update public.manual_blur_region r
    set state = 'kept'
    where r.id = p_region_id;
  end if;

  outcome := 'kept';
  return next;
end;
$$;

revoke execute on function public.keep_blur_region(uuid, uuid) from public, anon, authenticated;
grant execute on function public.keep_blur_region(uuid, uuid) to service_role;
