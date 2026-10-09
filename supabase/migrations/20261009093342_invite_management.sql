-- Admin-only reads and atomic invite replacement (D-152, arch:invite).
-- Both functions run as the API's service role. No table or policy changes.

-- STABLE keeps the event, actor and credentials in the caller's snapshot. A missing role or
-- extra current row returns internal_error without issuing or exposing a partial set.
create function public.list_event_invites(p_event_id uuid, p_actor_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_actor public.membership%rowtype;
  v_invites jsonb;
  v_guest_count bigint;
  v_photographer_count bigint;
  v_count bigint;
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

  select count(*), count(*) filter (where i.role = 'guest'),
    count(*) filter (where i.role = 'photographer'),
    jsonb_agg(jsonb_build_object(
      'id', i.id, 'role', i.role, 'token', i.token, 'shortcode', i.shortcode
    ) order by i.role)
  into v_count, v_guest_count, v_photographer_count, v_invites
  from public.invite i
  where i.event_id = p_event_id and i.revoked_at is null;

  if v_count <> 2 or v_guest_count <> 1 or v_photographer_count <> 1 then
    return jsonb_build_object('outcome', 'internal_error');
  end if;
  return jsonb_build_object('outcome', 'listed', 'invites', v_invites);
end;
$$;

-- The event lock matches join_event, so a waiting join rechecks the old invite after rotation.
-- Checking and replacing the displayed row in one transaction gives one winner per version.
-- An issuance exception reaches the caller and rolls back the revocation with it.
create function public.regenerate_event_invite(
  p_event_id uuid, p_actor_id uuid, p_role text, p_expected_invite_id uuid
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
  v_invite public.invite%rowtype;
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
  if p_role is null or p_role not in ('guest', 'photographer') then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select * into v_invite from public.invite i
  where i.id = p_expected_invite_id and i.event_id = p_event_id
    and i.role = p_role and i.revoked_at is null
  for update;
  if not found then
    return jsonb_build_object('outcome', 'invite_changed');
  end if;

  update public.invite i set revoked_at = now() where i.id = v_invite.id;
  perform public.issue_invite(p_event_id, p_role);

  select * into strict v_invite from public.invite i
  where i.event_id = p_event_id and i.role = p_role and i.revoked_at is null;
  return jsonb_build_object('outcome', 'regenerated', 'invite', jsonb_build_object(
    'id', v_invite.id, 'role', v_invite.role, 'token', v_invite.token,
    'shortcode', v_invite.shortcode
  ));
end;
$$;

revoke execute on function public.list_event_invites(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.regenerate_event_invite(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.list_event_invites(uuid, uuid) to service_role;
grant execute on function public.regenerate_event_invite(uuid, uuid, text, uuid) to service_role;
