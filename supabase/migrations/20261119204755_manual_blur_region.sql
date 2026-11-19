-- S-19: manual_blur_region, and the two functions behind POST /media/{mediaId}/blur-regions and
-- DELETE /blur-regions/{regionId} (D-83, D-99, D-170, arch:manual_blur_region, arch §5).
--
-- RLS is on with no policy (root invariant 14). The API reads the table as service_role and makes
-- every decision about it in its service layer. apps/api/tests/integration/rls.test.ts runs both
-- functions, the refusals and the check constraint against the dev project.

create table public.manual_blur_region (
  -- No default. The phone makes the id, so a resend after a lost answer inserts nothing new.
  id uuid primary key,
  -- The worker's media_delete removes a deleted photo's regions (arch §5). The cascade covers an
  -- event's hard delete, which takes its media rows with it.
  media_id uuid not null references public.media (id) on delete cascade,
  -- No ON DELETE action, as media.uploader_user_id has none, so a drawer's regions stay after they
  -- leave the event and only the Admin can then remove them (D-170).
  drawn_by_user_id uuid not null references auth.users (id),
  -- Fractions of the stored image, upright, so one rectangle fits every file of the photo (D-99).
  x double precision not null,
  y double precision not null,
  width double precision not null,
  height double precision not null,
  created_at timestamptz not null default now(),
  -- The same rectangles BlurRect refuses: no size, or past an edge. No minimum size (D-170).
  constraint manual_blur_region_rect_check check (
    x >= 0 and y >= 0 and width > 0 and height > 0 and x + width <= 1 and y + height <= 1
  )
);

-- The list's order, and the worker's read of one photo's regions.
create index manual_blur_region_media_idx on public.manual_blur_region (media_id, created_at, id);

alter table public.manual_blur_region enable row level security;

-- Both functions take the event row and then the media row FOR SHARE, in that order.
-- - Every membership change takes the event row FOR NO KEY UPDATE, which waits for a share lock,
--   so a member removed or blocked during the call is either refused or removed after the write.
-- - Deleting a photo updates its media row, which waits the same way, so a region is never stored
--   on a photo deleted while the screen was open, and the add answers not_found after it.
-- - Two draws on one event take shared locks and do not wait for each other.
--
-- Outcomes, one row each, checked in this order, which is the contract's (blur-region.ts):
--   not_found    no such photo, or it is soft-deleted, unprocessed, or in a soft-deleted event; for
--                remove, also no such region
--   not_member   the caller's membership in the photo's event is not active
--   wrong_role   the caller is a Photographer (spec §4.11.4.4)
--   duplicate    add only: the id is taken by another person's region or another photo's
--   not_drawer   remove only: a Guest removing someone else's region
--   repeat       add only: the caller already stored this id on this photo; nothing changes and no
--                message is sent
--   added, removed   the write and one blur_region message, in this transaction
-- `role` is the caller's, from not_member on, so the API answers with the list as they may see it.
-- `media_id` is the photo the region is on, for remove's answer.
--
-- security definer, because pgmq.send writes to the queue's table in the pgmq schema, where the
-- API's role has no privilege (as complete_upload). Callable by service_role only.
create function public.add_blur_region(
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

  insert into public.manual_blur_region as r (id, media_id, drawn_by_user_id, x, y, width, height)
  values (p_region_id, p_media_id, p_user_id, p_x, p_y, p_width, p_height)
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

create function public.remove_blur_region(p_region_id uuid, p_user_id uuid)
returns table (outcome text, role text, media_id uuid, message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid;
  v_drawer uuid;
  v_status text;
begin
  -- A region's photo and a photo's event never change, so both are safe to read before the lock.
  select r.media_id, m.event_id into media_id, v_event_id
  from public.manual_blur_region r
  join public.media m on m.id = r.media_id
  where r.id = p_region_id;
  if not found then
    media_id := null;
    outcome := 'not_found';
    return next;
    return;
  end if;

  perform 1 from public.event e
  where e.id = v_event_id and e.deleted_at is null
  for share;
  if not found then
    media_id := null;
    outcome := 'not_found';
    return next;
    return;
  end if;

  perform 1 from public.media m
  where m.id = media_id and m.processed_at is not null and m.deleted_at is null
  for share;
  if not found then
    media_id := null;
    outcome := 'not_found';
    return next;
    return;
  end if;

  select mb.role, mb.status into role, v_status
  from public.membership mb
  where mb.event_id = v_event_id and mb.user_id = p_user_id;
  if v_status is distinct from 'active' then
    role := null;
    media_id := null;
    outcome := 'not_member';
    return next;
    return;
  end if;

  if role = 'photographer' then
    media_id := null;
    outcome := 'wrong_role';
    return next;
    return;
  end if;

  -- Read the drawer and delete in one statement under the row's lock, so two removes of one
  -- region send one message between them.
  delete from public.manual_blur_region r
  where r.id = p_region_id and (role = 'admin' or r.drawn_by_user_id = p_user_id)
  returning r.drawn_by_user_id into v_drawer;
  if not found then
    if exists (select 1 from public.manual_blur_region r where r.id = p_region_id) then
      outcome := 'not_drawer';
    else
      outcome := 'not_found';
    end if;
    media_id := null;
    return next;
    return;
  end if;

  select pgmq.send('jobs', jsonb_build_object('job', 'blur_region', 'media_id', media_id), 0)
  into message_id;

  outcome := 'removed';
  return next;
end;
$$;

revoke execute on function public.remove_blur_region(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.remove_blur_region(uuid, uuid) to service_role;
