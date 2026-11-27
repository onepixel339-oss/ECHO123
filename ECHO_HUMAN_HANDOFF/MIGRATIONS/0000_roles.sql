-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — B0 migration 0000: platform roles.
--
-- Creates the dedicated least-privilege owner role for the S-2 job functions
-- (v1.2 §3.3.5): `echo_jobs_admin` — nologin, nobypassrls, noinherit. On the
-- hosted platform the migration runs as `postgres` (CREATEROLE, not
-- superuser): creating the role auto-grants postgres ADMIN over it, and the
-- explicit membership grant below additionally confers the SET privilege
-- required to transfer ownership of the echo_jobs definer functions to it
-- and to create `TO echo_jobs_admin` RLS policies (migration 0005).
--
-- Roles are cluster-level objects: a database dump does NOT carry them.
-- The restore runbook therefore pre-creates this role before restoring
-- (R-24). Idempotent by construction.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'echo_jobs_admin') then
    create role echo_jobs_admin nologin nobypassrls noinherit;
  end if;
end $$;

-- Membership for the migration role so it can create objects owned by
-- echo_jobs_admin and author policies addressed to it. Plain GRANT confers
-- the SET privilege (PG16+ default; ≤15 membership implies it).
grant echo_jobs_admin to postgres;
