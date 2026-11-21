-- S-20: the two functions behind PUT and DELETE /events/{eventId}/references/{id} (spec §4.2, D-91,
-- D-95, D-141, D-172, arch:face_reference).
--
-- Setting a profile photo needs no function: it is one UPDATE of profile.avatar_key, as a cover is
-- one UPDATE of event.cover_key (Ukasha, S-20 card revision 2).
--
-- apps/api/tests/integration/rls.test.ts runs both functions, their refusals and the limit of 5
-- under two concurrent calls against the dev project.

-- Both functions take the event row FOR SHARE first, as add_blur_region does.
-- - Every membership change takes the event row FOR NO KEY UPDATE, which waits for a share lock,
--   so a member removed or blocked during the call is either refused or removed after the write.
-- - Two people's calls on one event take shared locks and do not wait for each other.
--
-- add_face_reference then takes the caller's subject row FOR NO KEY UPDATE, so two adds by one
-- person count their references one after the other and the 6th is refused even when the 5th and
-- 6th arrive together (D-95). NO KEY UPDATE, not UPDATE, so the foreign key checks of inserts that
-- reference the subject, which take KEY SHARE, never wait on it.
--
-- Outcomes, one row each, checked in this order, which is the contract's (reference.ts):
--   not_found    the event does not exist or is soft-deleted; for delete, also no row with this
--                id, subject's user and event
--   not_member   the caller's membership in the event is not active
--   taken        add only: the id belongs to another person's reference or another event's
--   repeat       add only: the caller already stored this id in this event; nothing changes and no
--                message is sent
--   too_many     add only: the caller already keeps 5 references here that are not rejected
--   added, removed   the write, in this transaction. `added` also sends one reference_process
--                message. `removed` returns the deleted row's photo_key, so the API deletes the
--                object after the commit.
--
-- delete_face_reference sends no reprocess until S-25 and refuses no last accepted reference until
-- S-29, which adds the column that rule reads (D-172).
--
-- security definer, because pgmq.send writes to the queue's table in the pgmq schema, where the
-- API's role has no privilege (as complete_upload). Callable by service_role only.
create function public.add_face_reference(
  p_reference_id uuid,
  p_event_id uuid,
  p_user_id uuid,
  p_photo_key text
)
returns table (outcome text, message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status text;
  v_subject_id uuid;
  v_owner uuid;
  v_owner_event uuid;
  v_kept integer;
begin
  -- The API builds the key (root invariant 12). This only refuses one built for another caller,
  -- event or id, which face_reference_photo_key_check cannot, since it cannot read the subject.
  if p_photo_key is distinct from (
    'users/' || p_user_id::text || '/events/' || p_event_id::text
    || '/reference_' || p_reference_id::text || '.jpg'
  ) then
    raise exception 'add_face_reference: photo key % is not this caller''s key for this reference',
      p_photo_key
      using errcode = '22023';
  end if;

  perform 1 from public.event e
  where e.id = p_event_id and e.deleted_at is null
  for share;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select mb.status into v_status
  from public.membership mb
  where mb.event_id = p_event_id and mb.user_id = p_user_id;
  if v_status is distinct from 'active' then
    outcome := 'not_member';
    return next;
    return;
  end if;

  -- A user's subject is created with their first reference, in any event (arch:subject).
  insert into public.subject (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select s.id into v_subject_id
  from public.subject s
  where s.user_id = p_user_id
  for no key update;

  select s.user_id, fr.event_id into v_owner, v_owner_event
  from public.face_reference fr
  join public.subject s on s.id = fr.subject_id
  where fr.id = p_reference_id;
  if found then
    if v_owner = p_user_id and v_owner_event = p_event_id then
      outcome := 'repeat';
    else
      outcome := 'taken';
    end if;
    return next;
    return;
  end if;

  select count(*) into v_kept
  from public.face_reference fr
  where fr.subject_id = v_subject_id and fr.event_id = p_event_id and fr.status <> 'rejected';
  if v_kept >= 5 then
    outcome := 'too_many';
    return next;
    return;
  end if;

  -- Another person's concurrent insert of the same id does not wait on this subject's lock, so a
  -- conflict is read again rather than raised.
  insert into public.face_reference as fr (id, subject_id, event_id, photo_key)
  values (p_reference_id, v_subject_id, p_event_id, p_photo_key)
  on conflict do nothing;

  if not found then
    select s.user_id, fr.event_id into v_owner, v_owner_event
    from public.face_reference fr
    join public.subject s on s.id = fr.subject_id
    where fr.id = p_reference_id;
    -- A row deleted between the insert and this read reads as taken, which the app shows as a
    -- failed upload.
    if v_owner = p_user_id and v_owner_event = p_event_id then
      outcome := 'repeat';
    else
      outcome := 'taken';
    end if;
    return next;
    return;
  end if;

  -- The integer delay picks one of pgmq's three-argument overloads, as in complete_upload.
  select pgmq.send(
    'jobs',
    jsonb_build_object('job', 'reference_process', 'face_reference_id', p_reference_id),
    0
  )
  into message_id;

  outcome := 'added';
  return next;
end;
$$;

revoke execute on function public.add_face_reference(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.add_face_reference(uuid, uuid, uuid, text) to service_role;

create function public.delete_face_reference(
  p_reference_id uuid,
  p_event_id uuid,
  p_user_id uuid
)
returns table (outcome text, photo_key text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status text;
begin
  perform 1 from public.event e
  where e.id = p_event_id and e.deleted_at is null
  for share;
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select mb.status into v_status
  from public.membership mb
  where mb.event_id = p_event_id and mb.user_id = p_user_id;
  if v_status is distinct from 'active' then
    outcome := 'not_member';
    return next;
    return;
  end if;

  -- One statement, so two deletes of one reference remove it once and the second reads not_found.
  -- Another person's row, or the caller's in another event, matches nothing.
  delete from public.face_reference fr
  using public.subject s
  where fr.id = p_reference_id
    and fr.event_id = p_event_id
    and s.id = fr.subject_id
    and s.user_id = p_user_id
  returning fr.photo_key into photo_key;
  if not found then
    photo_key := null;
    outcome := 'not_found';
    return next;
    return;
  end if;

  outcome := 'removed';
  return next;
end;
$$;

revoke execute on function public.delete_face_reference(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_face_reference(uuid, uuid, uuid) to service_role;
