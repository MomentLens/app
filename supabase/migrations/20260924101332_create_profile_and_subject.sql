-- profile, subject, and the trigger that gives every account a profile (D-63, D-109,
-- docs/ARCHITECTURE.md arch:profile and arch:subject).
--
-- RLS is on for both tables with no policy (D-73, root invariant 14). The API reads and writes
-- them with the secret key and makes every decision about them in its service layer. The app
-- reaches them only through the API: a query from the app, with the publishable key or with a
-- user's token, reads no rows and writes nothing. apps/api/tests/integration/rls.test.ts checks
-- that, the trigger and the cascades against the dev project.

-- Trims what JavaScript's String.prototype.trim trims, which is more than the spaces btrim strips
-- by default: U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F,
-- U+205F, U+3000 and U+FEFF. FullName in packages/shared-types trims with trim(), and a stored
-- name has to be one FullName accepts unchanged, or every response carrying it fails to parse.
create function public.trim_whitespace(value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select pg_catalog.btrim(
    value,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  )
$$;

comment on function public.trim_whitespace(text) is
  'Trims the characters String.prototype.trim trims, so a stored name matches FullName in packages/shared-types.';

-- Called by profile's CHECK constraint, which runs with the privileges of whoever writes the row:
-- the API's secret key, or the trigger's owner. Nobody calls it over the Data API.
revoke execute on function public.trim_whitespace(text) from public, anon, authenticated;
grant execute on function public.trim_whitespace(text) to service_role;

create table public.profile (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  -- users/{user_id}/avatar_{upload_id}.jpg, built by the API's one avatar key function (arch §3).
  -- S-20 writes it; nothing does before then.
  avatar_key text,
  notify_approval boolean not null default true,
  notify_album boolean not null default true,
  created_at timestamptz not null default now(),
  -- The same rule as FullName: trimmed, then 1 to 80 code points, which is what char_length counts.
  constraint profile_full_name_check check (
    full_name = public.trim_whitespace(full_name) and char_length(full_name) between 1 and 80
  ),
  -- Every endpoint that returns a person presigns this key for whoever may see the person. A key
  -- outside this user's avatar family, such as their reference photo or someone's media, would
  -- hand that file to the same audience.
  constraint profile_avatar_key_check check (
    avatar_key ~ ('^users/' || user_id::text || '/avatar_[^/]+\.jpg$')
  )
);

comment on table public.profile is
  'One row per account, created by a trigger on auth.users (D-109). RLS on, no policy: the API reads it with the secret key.';

create table public.subject (
  id uuid primary key default gen_random_uuid(),
  -- Null only for the deferred Proxy Blur subject (D-63). UNIQUE treats nulls as distinct, so it
  -- allows one subject per user and any number with no user.
  user_id uuid references auth.users (id) on delete cascade,
  -- Set once and never cleared (D-31). S-29 sets it.
  dnp_activated_at timestamptz,
  created_at timestamptz not null default now(),
  constraint subject_user_id_key unique (user_id)
);

comment on table public.subject is
  'The identity reference photos and Do Not Publish attach to (D-63). RLS on, no policy: the API reads it with the secret key.';

alter table public.profile enable row level security;
alter table public.subject enable row level security;

-- Explicit, so nothing depends on whether the project exposes new tables to the Data API by
-- default. anon and authenticated keep SELECT so a stray query from the app returns empty rows
-- rather than an error, as invariant 14 describes, and lose every write privilege, so a policy
-- added here by mistake still could not let the app write.
revoke all on table public.profile, public.subject from anon, authenticated;
grant select on table public.profile, public.subject to anon, authenticated;
grant select, insert, update, delete on table public.profile, public.subject to service_role;

-- Creates the profile in the same transaction as the account, from the full_name the app sends
-- as signup metadata (D-109). A missing or non-string name raises here; a name that trims to
-- nothing or runs past 80 characters fails profile_full_name_check. Either way the insert into
-- auth.users rolls back, and signup fails with no account left behind.
--
-- security definer, because Auth inserts into auth.users as supabase_auth_admin, which has no
-- privilege on public.profile. The empty search_path keeps a caller's schemas out of it.
--
-- Nothing else reads full_name from the metadata: a user can rewrite their own metadata at any
-- time, so after signup the profile row is the only source of the name.
create function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  signup_name jsonb := new.raw_user_meta_data -> 'full_name';
begin
  if signup_name is null or pg_catalog.jsonb_typeof(signup_name) <> 'string' then
    raise exception 'signup metadata needs full_name as a string'
      using errcode = 'check_violation';
  end if;
  insert into public.profile (user_id, full_name)
  values (new.id, public.trim_whitespace(signup_name #>> '{}'));
  return new;
end;
$$;

revoke execute on function public.create_profile_for_new_user() from public, anon, authenticated;

create trigger create_profile_on_signup
after insert on auth.users
for each row execute function public.create_profile_for_new_user();
