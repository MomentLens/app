-- S-15's server-recorded check-in and upload gate (D-155, arch:venue_verification).
-- The API judges GPS with readingMatches and passes only accepted sub-event ids. No coordinate
-- or reading time reaches this table. S-16 adds QR check-ins.
create table public.venue_verification (
  user_id uuid not null references auth.users (id) on delete cascade,
  sub_event_id uuid not null references public.sub_event (id) on delete cascade,
  method text not null,
  verified_at timestamptz not null default now(),
  constraint venue_verification_pkey primary key (user_id, sub_event_id),
  constraint venue_verification_method_check check (method = 'gps')
);

create index venue_verification_sub_event_id_idx on public.venue_verification (sub_event_id);

comment on table public.venue_verification is
  'One check-in per user and sub-event. verified_at is the server write time. RLS on, no policy (D-155).';

alter table public.venue_verification enable row level security;
revoke all on table public.venue_verification from anon, authenticated;
grant select on table public.venue_verification to anon, authenticated;
grant select, insert, update, delete on table public.venue_verification to service_role;

-- The new argument changes the signature, so remove the old RPC (D-116). Keep p_role for the
-- existing caller, but ignore it. Both the gate and the media row use the membership's role.
drop function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer
);

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
  p_max_unfinished integer,
  p_verified_sub_event_ids uuid[] default '{}'
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

revoke execute on function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer, uuid[]
) from public, anon, authenticated;
grant execute on function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer, uuid[]
) to service_role;

-- Changing the return type requires a new function. The access fields stay as before. The
-- event and verification fields are null for an inactive caller or a soft-deleted event.
drop function public.get_my_event(uuid, uuid);

create function public.get_my_event(p_event_id uuid, p_user_id uuid)
returns table (
  deleted boolean,
  role text,
  status text,
  id uuid,
  name text,
  type text,
  cover_key text,
  starts_at timestamptz,
  ends_at timestamptz,
  archived_at timestamptz,
  every_sub_event boolean,
  verified_sub_event_ids uuid[]
)
language sql
stable
set search_path = ''
as $$
  select
    e.deleted_at is not null,
    m.role,
    m.status,
    shown.id,
    shown.name,
    shown.type,
    shown.cover_key,
    shown.starts_at,
    shown.ends_at,
    shown.archived_at,
    shown.every_sub_event,
    shown.verified_sub_event_ids
  from public.event e
  left join public.membership m on m.event_id = e.id and m.user_id = p_user_id
  left join lateral (
    select
      e.id, e.name, e.type, e.cover_key, span.starts_at, span.ends_at, e.archived_at,
      m.admin_verified_at is not null or m.role in ('admin', 'photographer') as every_sub_event,
      array (
        select vv.sub_event_id
        from public.venue_verification vv
        join public.sub_event se on se.id = vv.sub_event_id
        where vv.user_id = p_user_id and se.event_id = e.id
        order by vv.sub_event_id
      ) as verified_sub_event_ids
    from (
      select min(se.starts_at) as starts_at, max(se.ends_at) as ends_at
      from public.sub_event se
      where se.event_id = e.id
    ) span
    where m.status = 'active' and e.deleted_at is null
  ) shown on true
  where e.id = p_event_id
$$;

revoke execute on function public.get_my_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_my_event(uuid, uuid) to service_role;
