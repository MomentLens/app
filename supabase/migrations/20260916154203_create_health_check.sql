-- health_check: one fixed row for GET /health and the Supabase keep-alive.
--
-- The API reads the row with the secret key, which bypasses RLS, and must see it. The keep-alive
-- reads it through PostgREST with the publishable key and must see nothing, because RLS is on
-- with no policy (D-73). The row is seeded because that difference is the point: an empty table
-- would look the same through both keys.
--
-- Infrastructure, not a feature table (docs/ARCHITECTURE.md §2).

create table public.health_check (
  id smallint primary key default 1,
  created_at timestamptz not null default now(),
  constraint health_check_single_row check (id = 1)
);

comment on table public.health_check is
  'One fixed row. GET /health reads it with the secret key; the keep-alive reads it with the publishable key and must see no rows.';

alter table public.health_check enable row level security;

-- Explicit, so neither reader depends on whether the project exposes new tables to the Data API
-- by default. SELECT only. With RLS on and no policy, anon and authenticated still read no rows.
grant select on table public.health_check to anon, authenticated, service_role;

insert into public.health_check (id) values (1);
