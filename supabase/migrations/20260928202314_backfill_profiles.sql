-- A profile for every live account that has none (D-109, docs/ARCHITECTURE.md arch:profile).
--
-- S-01's trigger, create_profile_on_signup, gives each new account a profile. It never ran for
-- accounts that existed before 20260924101332_create_profile_and_subject.sql. On the dev project
-- on 2026-09-29 both accounts had no profile, so GET /profiles/me answered them 401 no_session and
-- the app showed a profile that would not load and an empty avatar.
--
-- The name comes from the account's full_name metadata, trimmed as the trigger trims it, which is
-- where the trigger takes it from. The metadata is read as it stands when this runs, and never
-- again (arch:profile).
--
-- An account without a usable name fails the whole migration, which then writes nothing. Making up
-- a name would show it to every member of the account's events (arch §1), and the trigger refuses
-- such a signup too. Two kinds of account are left out, as the trigger's world never gives them a
-- profile. An anonymous user has no name and could not sign up past the trigger. An account Auth
-- soft-deleted (deleted_at set) no longer exists for anyone, and a profile would show its old name
-- again. On a project where every live account came through the trigger, this inserts nothing.

do $$
declare
  v_nameless integer;
begin
  select count(*)
  into v_nameless
  from auth.users u
  where u.deleted_at is null
    and u.is_anonymous is not true
    and not exists (select 1 from public.profile p where p.user_id = u.id)
    and (
      pg_catalog.jsonb_typeof(u.raw_user_meta_data -> 'full_name') is distinct from 'string'
      or char_length(public.trim_whitespace(u.raw_user_meta_data ->> 'full_name')) not between 1 and 80
    );
  if v_nameless > 0 then
    raise exception '% live account(s) have no profile and no usable full_name in their metadata', v_nameless
      using errcode = 'check_violation';
  end if;
end;
$$;

insert into public.profile (user_id, full_name)
select u.id, public.trim_whitespace(u.raw_user_meta_data ->> 'full_name')
from auth.users u
where u.deleted_at is null
  and u.is_anonymous is not true
  and not exists (select 1 from public.profile p where p.user_id = u.id)
on conflict (user_id) do nothing;
