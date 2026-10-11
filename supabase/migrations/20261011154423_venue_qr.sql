-- S-16's venue QR management and upload acceptance (D-156). Existing migrations stay frozen.
-- No new RLS policy or app privilege. Only the service role executes these functions.

alter table public.venue_verification drop constraint venue_verification_method_check;
alter table public.venue_verification
  add constraint venue_verification_method_check check (method in ('gps', 'qr'));

-- STABLE reads the event, active Admin and secrets in one snapshot. The RPC returns
-- {outcome, venue_qrs: [{venue_id, venue_name, secret}]}; the API builds VenueQrPayload.
create function public.list_venue_qrs(p_event_id uuid, p_actor_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_actor public.membership%rowtype;
  v_qrs jsonb;
begin
  if not exists (
    select 1 from public.event e where e.id = p_event_id and e.deleted_at is null
  ) then
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'venue_id', v.id, 'venue_name', v.name, 'secret', encode(v.qr_secret, 'hex')
  ) order by v.id), '[]'::jsonb)
  into v_qrs
  from public.venue v
  where v.event_id = p_event_id;

  return jsonb_build_object('outcome', 'listed', 'venue_qrs', v_qrs);
end;
$$;

-- Rotation and QR acceptance serialize on the event row. A waiting request rechecks both
-- authority and expectedSecret before changing anything. The RPC returns
-- {outcome, venue_qr: {venue_id, venue_name, secret}} after a successful replacement.
create function public.regenerate_venue_qr(
  p_event_id uuid, p_actor_id uuid, p_venue_id uuid, p_expected_secret text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_actor public.membership%rowtype;
  v_venue public.venue%rowtype;
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

  select * into v_venue from public.venue v
  where v.id = p_venue_id and v.event_id = p_event_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_expected_secret is null or p_expected_secret !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;
  if encode(v_venue.qr_secret, 'hex') <> p_expected_secret then
    return jsonb_build_object('outcome', 'venue_qr_changed');
  end if;

  update public.venue v set qr_secret = extensions.gen_random_bytes(32)
  where v.id = v_venue.id
  returning * into strict v_venue;

  return jsonb_build_object('outcome', 'regenerated', 'venue_qr', jsonb_build_object(
    'venue_id', v_venue.id, 'venue_name', v_venue.name, 'secret', encode(v_venue.qr_secret, 'hex')
  ));
end;
$$;

revoke execute on function public.list_venue_qrs(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.regenerate_venue_qr(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.list_venue_qrs(uuid, uuid) to service_role;
grant execute on function public.regenerate_venue_qr(uuid, uuid, uuid, text) to service_role;

-- Keep the GPS argument and add an optional QR array, so S-15's caller remains compatible.
-- Each QR item is {sub_event_id, venue_id, secret, recorded_at}, supplied by the API after it
-- selects a target with currentSubEvent. No QR secret or scan time is stored. The old signature
-- must go, because keeping both with defaults would make the RPC ambiguous.
drop function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer, uuid[]
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
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer, uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.start_upload(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, integer, integer, uuid[], jsonb
) to service_role;
