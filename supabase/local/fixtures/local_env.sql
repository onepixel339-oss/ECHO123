-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — LOCAL TEST ENVIRONMENT FIXTURE (NOT part of the hosted migration
-- chain). Recreates, on a vanilla PostgreSQL cluster, the platform pieces a
-- hosted Supabase project provides natively:
--
--   • the `auth` schema with `auth.users` and the `auth.uid()` / `auth.jwt()`
--     claim readers (hosted: managed by Supabase Auth / GoTrue),
--   • the API roles `authenticated`, `anon`, `service_role` (hosted: created
--     by the platform).
--
-- Tests simulate a user's verified JWT with:
--     set role authenticated;
--     select set_config('request.jwt.claims',
--                       '{"sub":"<uuid>","role":"authenticated"}', false);
-- …exactly the mechanism PostgREST uses on the hosted platform.
--
-- NEVER apply this file to a hosted Supabase project.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant authenticated to postgres;
grant service_role  to postgres;

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);
grant select on auth.users to authenticated;

-- Supabase-compatible claim readers (request.jwt.claims GUC).
create or replace function auth.uid() returns uuid
language sql stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

revoke all on function auth.uid() from public;
revoke all on function auth.jwt() from public;
grant execute on function auth.uid() to authenticated, anon, service_role;
grant execute on function auth.jwt() to authenticated, anon, service_role;
grant usage on schema auth to authenticated, anon, service_role;
