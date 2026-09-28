-- A profile for every account that has none (D-109, docs/ARCHITECTURE.md arch:profile).
--
-- S-01's trigger, create_profile_on_signup, gives each new account a profile. It never ran for
-- accounts that existed before 20260924101332_create_profile_and_subject.sql: on the dev project
-- on 2026-09-29, both accounts had no profile. GET /profiles/me answers them 401 no_session,
-- which the app shows as a profile that will not load and an empty avatar.
--
-- The name comes from the signup's full_name, trimmed as the trigger trims it, which is where
-- the trigger takes it from. An account without a usable one fails the whole migration and
-- writes nothing: making up a name would show it to every member of the account's events
-- (arch §1), and the trigger refuses such a signup too. On a project where every account came
-- through the trigger, this inserts nothing.

do $$
declare
  v_nameless integer;
begin
  select count(*)
  into v_nameless
  from auth.users u
  where not exists (select 1 from public.profile p where p.user_id = u.id)
    and (
      pg_catalog.jsonb_typeof(u.raw_user_meta_data -> 'full_name') is distinct from 'string'
      or char_length(public.trim_whitespace(u.raw_user_meta_data ->> 'full_name')) not between 1 and 80
    );
  if v_nameless > 0 then
    raise exception '% account(s) have no profile and no usable full_name in their signup metadata', v_nameless
      using errcode = 'check_violation';
  end if;
end;
$$;

insert into public.profile (user_id, full_name)
select u.id, public.trim_whitespace(u.raw_user_meta_data ->> 'full_name')
from auth.users u
where not exists (select 1 from public.profile p where p.user_id = u.id)
on conflict (user_id) do nothing;
