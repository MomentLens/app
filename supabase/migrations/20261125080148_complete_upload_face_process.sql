-- S-21: complete_upload enqueues face_process instead of thumbnail_dims, so a finished upload is
-- detected, matched and blurred before it publishes (D-72, arch §5).
--
-- Pushed to the dev project only in the sitting that deploys a worker with face_process to the dev
-- server. A worker without the job archives the message as one it does not have, and the photo
-- never publishes (S-21 row, hb §13.4). This file lives on S-21's worker branch, so no push from
-- main sends it. From its push until the stack merges, the dev server runs an S-21 branch, worker
-- included. If a later migration reaches the dev project first, rename this file to a fresh
-- timestamp before pushing it, which is allowed only because it has reached no database yet.
--
-- The body is 20261023090000_complete_upload_membership.sql's, with the job's name changed. The
-- privileges set on the function in 20261002121238_media_upload.sql stay, because create or
-- replace keeps them.

begin;

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
  select pgmq.send('jobs', jsonb_build_object('job', 'face_process', 'media_id', p_media_id), 0)
  into message_id;

  outcome := 'completed';
  return next;
end;
$$;

commit;
