-- The API's own login to Postgres, which replaces PostgREST and the secret key (D-164).
--
-- momentlens_api holds no rights of its own and runs every statement as service_role, which is
-- what PostgREST did for the secret key: BYPASSRLS, and every grant the migrations give
-- service_role. Membership alone would not do it. Postgres never passes a role's attributes to its
-- members, BYPASSRLS included, so every table would read as empty. The role setting below switches
-- each new session to service_role at login instead.
--
-- No password here. infra/supabase/setup.sh sets it on the server and writes API_DATABASE_URL.
-- Supabase's image gives postgres CREATEROLE and service_role WITH ADMIN OPTION, which is all
-- this needs.
do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'momentlens_api') then
    create role momentlens_api login noinherit;
  end if;
end
$$;

grant service_role to momentlens_api;
alter role momentlens_api set role = 'service_role';

comment on role momentlens_api is
  'The API''s login (D-164). Runs as service_role from login on; the password lives only in the server''s env.';
