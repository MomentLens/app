-- get_my_event, the read GET /events/{eventId} calls with rpc for the Event shell (D-118,
-- docs/ARCHITECTURE.md arch:event and arch:membership).
--
-- No table changes and no policy (D-73, root invariant 14). apps/api/tests/integration/rls.test.ts
-- checks the function against the dev project, and that the app's own key cannot call it.

-- One row when p_event_id exists, deleted or not, and none when it does not.
--
-- deleted says whether the event is soft-deleted. role and status are p_user_id's own membership,
-- and null when they have none. The rest is the event as list_my_events returns it, span computed
-- the same way, and every column of it is null unless p_user_id's membership is active and the
-- event is not deleted. The API answers 404 for a deleted event and 403 for any other caller who
-- is not active, and this function never hands it the name or cover key of an event it may not
-- show (root invariant 3).
--
-- security invoker, and callable by the API's secret key only. It takes the user as a parameter,
-- so a caller who could run it could read anyone's membership of any event.
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
  archived_at timestamptz
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
    shown.archived_at
  from public.event e
  left join public.membership m on m.event_id = e.id and m.user_id = p_user_id
  left join lateral (
    select e.id, e.name, e.type, e.cover_key, span.starts_at, span.ends_at, e.archived_at
    from (
      select min(se.starts_at) as starts_at, max(se.ends_at) as ends_at
      from public.sub_event se
      where se.event_id = e.id
    ) span
    where m.status = 'active'
      and e.deleted_at is null
  ) shown on true
  where e.id = p_event_id
$$;

revoke execute on function public.get_my_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_my_event(uuid, uuid) to service_role;
