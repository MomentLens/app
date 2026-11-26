-- S-25: the column reprocess compares, the one function that sends a reprocess message, and the
-- four functions that send it (spec §4.11.4.5, D-84, D-141, D-175, D-178, arch §5, arch:face).
--
-- Schema only. The worker's reprocess job, the face_process and blur_region writes of
-- dnp_subject_id, and reference_process's send on an accepted reference are S-25's worker build.
-- Until that build is deployed, the worker archives a reprocess message on its first read as a job
-- it does not have (arch §5), so this migration goes to the dev project with the worker build.
--
-- What sends reprocess for (subject, event), and only when the subject keeps an accepted reference
-- in that event, since a subject with none has nothing to match:
--   join_event               a join or rejoin that makes the caller active
--   act_on_join_requests     an approve, for each approved person
--   update_event_settings    a switch to auto, for each pending request it admits
--   delete_face_reference    the delete of an accepted reference, whatever is left, because the
--                            faces it matched lose their match (D-178)
-- A join or rejoin that leaves the caller pending sends nothing until the approval does
-- (arch:membership). Remove from Event, a block and a reject send nothing: the job matches active
-- members' references, so the next one for that event drops them, and a Do Not Publish subject
-- stays blurred whatever their status (D-175). S-29's activation function will be the fifth
-- caller, and reference_process the sixth, from the worker.

-- The Do Not Publish subject this face is blurred for, as the worker's variants.plan decided it
-- when it wrote the photo's files (D-178). face_process, blur_region and reprocess write it with
-- the files, and reprocess rebuilds only a photo where its new plan differs. It is not
-- matched_subject_id: a removed or blocked subject is still blurred but no longer recognised, so
-- this can be set where that is null (D-175), and no check ties the two.
--
-- ON DELETE SET NULL, as matched_subject_id. Deleting an account takes its subject, its
-- dnp_subject rows and its memberships, so no later plan blurs that face for it either and the
-- photo does not read as changed.
alter table public.face
  add column dnp_subject_id uuid references public.subject (id) on delete set null;

comment on column public.face.dnp_subject_id is
  'The Do Not Publish subject this face is blurred for in the photo''s current files, as variants.plan decided (D-178). Written by the worker with the files.';

-- The subject's SET NULL when an account is deleted, as face_matched_subject_idx.
create index face_dnp_subject_idx on public.face (dnp_subject_id)
  where dnp_subject_id is not null;

-- Sends one reprocess message for one subject in one event, and nothing else. The callers decide
-- whether to send; this checks nothing, because a deleted reference's send must go out when the
-- subject has no accepted reference left. Returns the message id.
--
-- security definer, because pgmq.send writes to the queue's table in the pgmq schema, where the
-- API's role has no privilege (as complete_upload). The four callers are security invoker and run
-- as service_role, which alone may execute this.
create function public.enqueue_reprocess(p_subject_id uuid, p_event_id uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  -- The integer delay picks one of pgmq's three-argument overloads, as in complete_upload.
  select pgmq.send(
    'jobs',
    jsonb_build_object('job', 'reprocess', 'subject_id', p_subject_id, 'event_id', p_event_id),
    0
  );
$$;

revoke execute on function public.enqueue_reprocess(uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_reprocess(uuid, uuid) to service_role;

-- join_event, as 20260929184331_invite_and_join.sql wrote it, with the send at the end. Its
-- comments there still hold.
create or replace function public.join_event(
  p_user_id uuid,
  p_token text,
  p_shortcode text,
  p_max_guests integer
)
returns table (outcome text, role text, status text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event_id uuid;
  v_invite_role text;
  v_revoked_at timestamptz;
  v_deleted_at timestamptz;
  v_archived_at timestamptz;
  v_approval_mode text;
  v_member_id uuid;
  v_member_role text;
  v_member_status text;
  v_status text;
begin
  if num_nonnulls(p_token, p_shortcode) <> 1 then
    raise exception 'Pass exactly one of p_token and p_shortcode'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_max_guests is null or p_max_guests < 0 then
    raise exception 'p_max_guests must be 0 or more, got %', p_max_guests
      using errcode = 'invalid_parameter_value';
  end if;

  select i.event_id into v_event_id
  from public.invite i
  where i.token = p_token or i.shortcode = p_shortcode;
  if not found then
    outcome := 'dead';
    return next;
    return;
  end if;

  -- Every join into this event waits here for the one before it to commit, so two joins never both
  -- take the last place. FOR NO KEY UPDATE conflicts with itself and with any update of the event,
  -- a delete or an archive included, but not with the FOR KEY SHARE lock a foreign key check takes,
  -- so inserts that reference the event, uploads among them, carry on. Anything else that makes a
  -- Guest active, S-07's approval among them, must take this same lock.
  select e.deleted_at, e.archived_at, e.approval_mode
  into v_deleted_at, v_archived_at, v_approval_mode
  from public.event e
  where e.id = v_event_id
  for no key update;
  if not found then
    outcome := 'dead';
    return next;
    return;
  end if;

  -- Read again under the lock, so a revoke that committed while this call waited is seen.
  select i.role, i.revoked_at into v_invite_role, v_revoked_at
  from public.invite i
  where i.token = p_token or i.shortcode = p_shortcode;
  if not found
    or v_revoked_at is not null
    or v_deleted_at is not null
    or v_archived_at is not null then
    outcome := 'dead';
    return next;
    return;
  end if;

  select m.id, m.role, m.status into v_member_id, v_member_role, v_member_status
  from public.membership m
  where m.event_id = v_event_id and m.user_id = p_user_id;

  if v_member_status in ('active', 'pending') then
    outcome := 'member';
    role := v_member_role;
    status := v_member_status;
    return next;
    return;
  end if;
  if v_member_status = 'blocked' then
    outcome := 'blocked';
    return next;
    return;
  end if;

  v_status := case when v_approval_mode = 'manual' then 'pending' else 'active' end;

  if v_status = 'active' and v_invite_role = 'guest' and (
    select count(*)
    from public.membership m
    where m.event_id = v_event_id and m.role = 'guest' and m.status = 'active'
  ) >= p_max_guests then
    outcome := 'full';
    return next;
    return;
  end if;

  if v_member_id is null then
    insert into public.membership (event_id, user_id, role, status, requested_at)
    values (v_event_id, p_user_id, v_invite_role, v_status, now());
    outcome := 'created';
  else
    update public.membership m
    set role = v_invite_role, status = v_status, admin_verified_at = null, requested_at = now()
    where m.id = v_member_id;
    outcome := 'rejoined';
  end if;

  -- A removed member who comes back active is matched against the photos taken while they were
  -- out (D-84). A first join finds no reference, since only an active member can add one.
  if v_status = 'active' then
    perform public.enqueue_reprocess(s.id, v_event_id)
    from public.subject s
    where s.user_id = p_user_id
      and exists (
        select 1 from public.face_reference fr
        where fr.subject_id = s.id and fr.event_id = v_event_id and fr.status = 'accepted'
      );
  end if;

  role := v_invite_role;
  status := v_status;
  return next;
end;
$$;

-- act_on_join_requests, as 20261004154405_pending_approvals.sql wrote it, with the send after the
-- update. Its comments there still hold. approve_requests, reject_requests and block_request call
-- it by name and need no change.
create or replace function public.act_on_join_requests(
  p_event_id uuid, p_actor_id uuid, p_targets jsonb, p_action text, p_max_guests integer
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_deleted_at timestamptz;
  v_actor public.membership%rowtype;
  v_length integer;
  v_user_ids uuid[];
  v_ids uuid[];
  v_versions bigint[];
  v_distinct integer;
  v_complete boolean;
  v_matched integer;
  v_new_guests integer;
  v_active_guests integer;
  v_memberships jsonb;
begin
  select e.deleted_at into v_deleted_at from public.event e
  where e.id = p_event_id for no key update;
  if not found or v_deleted_at is not null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into v_actor from public.membership m
  where m.event_id = p_event_id and m.user_id = p_actor_id;
  if not found or v_actor.status <> 'active' then
    return jsonb_build_object('outcome', 'not_member');
  end if;
  if v_actor.role <> 'admin' then
    return jsonb_build_object('outcome', 'wrong_role');
  end if;

  -- Separate tests, because SQL does not promise to stop at the first true one, and
  -- jsonb_array_length fails on anything but an array.
  if p_action is null or p_action not in ('approve', 'reject', 'block')
    or (p_action = 'approve' and (p_max_guests is null or p_max_guests < 0)) then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  if jsonb_typeof(p_targets) is distinct from 'array' then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  v_length := jsonb_array_length(p_targets);
  if v_length not between 1 and 50 or (p_action = 'block' and v_length <> 1) then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  select array_agg(t.user_id order by t.user_id), array_agg(t.id order by t.user_id),
    array_agg(t.version order by t.user_id), count(distinct t.user_id),
    bool_and(t.id is not null and t.version is not null)
  into v_user_ids, v_ids, v_versions, v_distinct, v_complete
  from jsonb_to_recordset(p_targets) as t(user_id uuid, id uuid, version bigint);
  if v_distinct <> v_length or not v_complete then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  -- ORDER BY runs before the lock, so the rows are locked in user_id order.
  perform 1 from public.membership m
  where m.event_id = p_event_id and m.user_id = any(v_user_ids)
  order by m.user_id
  for update;
  select count(*) into v_matched
  from unnest(v_user_ids, v_ids, v_versions) as t(user_id, id, version)
  join public.membership m on m.id = t.id
  where m.event_id = p_event_id and m.user_id = t.user_id and m.status = 'pending'
    and m.access_version = t.version;
  if v_matched <> v_length then
    return jsonb_build_object('outcome', 'membership_changed');
  end if;

  if p_action = 'approve' then
    select count(*) into v_new_guests from public.membership m
    where m.id = any(v_ids) and m.role = 'guest';
    select count(*) into v_active_guests from public.membership m
    where m.event_id = p_event_id and m.role = 'guest' and m.status = 'active';
    if v_new_guests > 0 and v_active_guests + v_new_guests > p_max_guests then
      return jsonb_build_object('outcome', 'event_full');
    end if;
  end if;

  -- Only status changes, so admin_verified_at, last_viewed_at and requested_at stay, and the
  -- version trigger advances each counter.
  with changed as (
    update public.membership m
    set status = case p_action when 'approve' then 'active' when 'reject' then 'removed' else 'blocked' end
    where m.id = any(v_ids)
    returning m.id, m.user_id, m.role, m.status, m.access_version
  )
  select jsonb_agg(jsonb_build_object(
    'id', c.id, 'user_id', c.user_id, 'role', c.role, 'status', c.status,
    'access_version', c.access_version::text
  ) order by c.user_id) into v_memberships
  from changed c;

  -- A rejoin that waited for approval is matched now, against the photos taken while the person
  -- was out (D-84). Every target was approved, since a batch is all or nothing.
  if p_action = 'approve' then
    perform public.enqueue_reprocess(s.id, p_event_id)
    from public.subject s
    where s.user_id = any(v_user_ids)
      and exists (
        select 1 from public.face_reference fr
        where fr.subject_id = s.id and fr.event_id = p_event_id and fr.status = 'accepted'
      );
  end if;

  return jsonb_build_object('outcome', 'updated', 'memberships', v_memberships);
end;
$$;

-- update_event_settings, as 20261004083652_update_event_settings.sql wrote it, with the two admits
-- collecting who they made active and one send for each of those with an accepted reference. Its
-- comments there still hold.
create or replace function public.update_event_settings(
  p_event_id uuid,
  p_name text,
  p_description text,
  p_approval_mode text,
  p_max_guests integer
)
returns table (outcome text, admitted integer, settings jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_deleted_at timestamptz;
  v_approval_mode text;
  v_photographers uuid[] := '{}';
  v_guests uuid[] := '{}';
  v_active_guests integer;
begin
  if num_nonnulls(p_name, p_description, p_approval_mode) = 0 then
    raise exception 'Pass at least one of p_name, p_description and p_approval_mode'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_max_guests is null or p_max_guests < 0 then
    raise exception 'p_max_guests must be 0 or more, got %', p_max_guests
      using errcode = 'invalid_parameter_value';
  end if;

  -- The lock join_event takes, so the mode read here and the counts below hold until commit.
  select e.deleted_at, e.approval_mode into v_deleted_at, v_approval_mode
  from public.event e
  where e.id = p_event_id
  for no key update;
  if not found or v_deleted_at is not null then
    outcome := 'not_found';
    admitted := 0;
    return next;
    return;
  end if;

  update public.event e
  set
    name = coalesce(p_name, e.name),
    description = case
      when p_description is null then e.description
      else nullif(p_description, '')
    end,
    approval_mode = coalesce(p_approval_mode, e.approval_mode)
  where e.id = p_event_id;

  if p_approval_mode = 'auto' and v_approval_mode = 'manual' then
    with admitted_rows as (
      update public.membership m
      set status = 'active'
      where m.event_id = p_event_id and m.role = 'photographer' and m.status = 'pending'
      returning m.user_id
    )
    select coalesce(array_agg(a.user_id), '{}') into v_photographers from admitted_rows a;

    select count(*) into v_active_guests
    from public.membership m
    where m.event_id = p_event_id and m.role = 'guest' and m.status = 'active';

    -- greatest, because an event can already hold more active Guests than p_max_guests, and a
    -- negative limit is an error.
    with admitted_rows as (
      update public.membership m
      set status = 'active'
      where m.id in (
        select q.id
        from public.membership q
        where q.event_id = p_event_id and q.role = 'guest' and q.status = 'pending'
        order by q.requested_at, q.id
        limit greatest(p_max_guests - v_active_guests, 0)
      )
      returning m.user_id
    )
    select coalesce(array_agg(a.user_id), '{}') into v_guests from admitted_rows a;

    -- A rejoin that waited for approval is matched now, as when the Admin approves it (D-84).
    perform public.enqueue_reprocess(s.id, p_event_id)
    from public.subject s
    where s.user_id = any(v_photographers || v_guests)
      and exists (
        select 1 from public.face_reference fr
        where fr.subject_id = s.id and fr.event_id = p_event_id and fr.status = 'accepted'
      );
  end if;

  outcome := 'updated';
  admitted := cardinality(v_photographers) + cardinality(v_guests);
  settings := public.event_settings(p_event_id);
  return next;
end;
$$;

-- delete_face_reference, as 20261121175630_reference_functions.sql wrote it, sending reprocess
-- when the deleted reference was accepted. A pending one was never matched against, and a rejected
-- one has no embedding. A pending one deleted while its reference_process is queued leaves that
-- message a row that is gone, which the worker deletes as done (arch §5). S-29 adds the refusal of
-- the last accepted reference while Do Not Publish is on (D-172).
create or replace function public.delete_face_reference(
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
  v_subject_id uuid;
  v_reference_status text;
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
  returning fr.photo_key, fr.subject_id, fr.status
  into photo_key, v_subject_id, v_reference_status;
  if not found then
    photo_key := null;
    outcome := 'not_found';
    return next;
    return;
  end if;

  -- The faces only this reference matched lose their match, and their blur with it (D-178).
  if v_reference_status = 'accepted' then
    perform public.enqueue_reprocess(v_subject_id, p_event_id);
  end if;

  outcome := 'removed';
  return next;
end;
$$;
