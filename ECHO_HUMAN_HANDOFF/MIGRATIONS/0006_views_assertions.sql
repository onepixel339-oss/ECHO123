-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — B0 migration 0006: lock-guard trigger (v1.2 §4.3.5),
-- security_invoker views (v1.2 §3.3.6), EXECUTE default-deny (§3.3.4), and
-- the REWRITTEN ownership/shape assertions (v1.3 PATCH1 §3.3.7 — the
-- deployable two-branch ownership policy with the checked-in expected
-- function inventory).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────── Defense-in-depth: the lock-guard trigger ────────────────
-- BEFORE INSERT/UPDATE on change_log: the current backend must already hold
-- the per-user advisory lock (shared is sufficient — a pull never writes
-- change_log, but the assertion is deliberately permissive only in lock
-- CLASS, not in lock PRESENCE; writers hold exclusive). 40P01 otherwise.
-- Compaction performs no change_log inserts/updates (it deletes), so the
-- trigger and the compaction protocol do not interact.
create or replace function echo_data.assert_change_log_lock() returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, echo_data
as $$
declare
  v_key int;
begin
  v_key := echo_data.user_key(new.user_id);
  if not exists (
    select 1 from pg_locks l
     where l.locktype = 'advisory'
       and l.classid = 72451
       and l.objid = v_key
       and l.database = (select oid from pg_database where datname = current_database())
       and l.pid = pg_backend_pid()
       and l.granted
  ) then
    raise exception 'change_log write without the per-user advisory lock (lock-guard)'
      using errcode = '40P01';
  end if;
  return new;
end;
$$;

revoke all on function echo_data.assert_change_log_lock() from public;
grant execute on function echo_data.assert_change_log_lock() to authenticated, echo_jobs_admin;

create trigger change_log_lock_guard
  before insert or update on echo_data.change_log
  for each row execute function echo_data.assert_change_log_lock();

-- ─────────────── security_invoker views (the read path) ──────────────────
-- PostgreSQL 15+ `security_invoker` views: RLS on the base table applies to
-- the QUERYING role (the documented remedy for "views bypass RLS by
-- default" — v1.2 §3.3.6). Read-only surface for debugging, reconciliation
-- and export-parity checks; the delta pull itself runs through sync_pull.
create view public.v_change_log       with (security_invoker = true) as select * from echo_data.change_log;
create view public.v_profiles         with (security_invoker = true) as select * from echo_data.profiles;
create view public.v_devices          with (security_invoker = true) as select * from echo_data.devices;
create view public.v_media_items      with (security_invoker = true) as select * from echo_data.media_items;
create view public.v_entries          with (security_invoker = true) as select * from echo_data.entries;
create view public.v_feedback         with (security_invoker = true) as select * from echo_data.feedback;
create view public.v_works            with (security_invoker = true) as select * from echo_data.works;
create view public.v_work_links       with (security_invoker = true) as select * from echo_data.work_links;
create view public.v_user_settings    with (security_invoker = true) as select * from echo_data.user_settings;
create view public.v_push_ops         with (security_invoker = true) as select * from echo_data.push_ops;
create view public.v_snapshots        with (security_invoker = true) as select * from echo_data.snapshots;
create view public.v_snapshot_pages   with (security_invoker = true) as select * from echo_data.snapshot_pages;
create view public.v_conflict_archive with (security_invoker = true) as select * from echo_data.conflict_archive;
create view public.v_recovery_backups with (security_invoker = true) as select * from echo_data.recovery_backups;
create view public.v_sync_state       with (security_invoker = true) as select * from echo_data.sync_state;

revoke all on public.v_change_log, public.v_profiles, public.v_devices,
  public.v_media_items, public.v_entries, public.v_feedback, public.v_works,
  public.v_work_links, public.v_user_settings, public.v_push_ops,
  public.v_snapshots, public.v_snapshot_pages, public.v_conflict_archive,
  public.v_recovery_backups, public.v_sync_state
  from public, anon;
grant select on public.v_change_log, public.v_profiles, public.v_devices,
  public.v_media_items, public.v_entries, public.v_feedback, public.v_works,
  public.v_work_links, public.v_user_settings, public.v_push_ops,
  public.v_snapshots, public.v_snapshot_pages, public.v_conflict_archive,
  public.v_recovery_backups, public.v_sync_state
  to authenticated;

-- ─────────────── EXECUTE default-deny (§3.3.4) ───────────────────────────
-- Account-wide: functions created later are not executable by public by
-- default; each RPC narrows explicitly (already done per-function above).
alter default privileges revoke execute on functions from public;

-- ─────────────── The expected-function inventory (CI diff source) ────────
-- One row per sync function with every attribute the two assertions check.
-- `execute_grantees` is a comma-sorted role list (public = PUBLIC); empty
-- acl arrays fall back to the type default (PUBLIC execute — which the
-- default-deny alter above prevents for future functions).
create or replace view public.v_sync_function_inventory as
select n.nspname                                   as schema,
       p.proname                                   as proname,
       p.prosecdef                                 as security_definer,
       pg_get_userbyid(p.proowner)                 as owner,
       coalesce((select string_agg(grantee::regrole::text, ',' order by grantee::regrole::text)
                   from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
                  where privilege_type = 'EXECUTE'
                    and grantee <> 0
                    and grantee <> p.proowner), '')         as execute_grantees,
       coalesce((select c from unnest(p.proconfig) c
                  where c like 'search_path=%' limit 1), '') as search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname = 'public'  and p.proname like 'sync\_%' escape '\')
    or (n.nspname = 'echo_jobs')
    or (n.nspname = 'echo_data' and p.proname in
        ('user_key','current_watermark','current_head','current_epoch',
         'sanitize_record','build_snapshot','assert_change_log_lock'));

grant select on public.v_sync_function_inventory to authenticated;

-- ─────────────── Ownership and shape assertions (§3.3.7 REWRITTEN) ───────
-- The v1.3 PATCH1 corrected assertion block: runs as the final step of every
-- migration that touches functions. Self-consistent by construction —
-- a migration can never reject its own correctly created functions (X-9),
-- while a definer flip (1), a non-echo_jobs_admin definer job (2), an
-- out-of-band owner (3), or an unpinned search_path (4) all fail it.
do $$
declare r record;
begin
  for r in
    select p.proname, n.nspname as schema,
           pg_get_userbyid(p.proowner) as owner,
           p.prosecdef, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public','echo_jobs')
       and p.proname like 'sync\_%' escape '\'
  loop
    -- (1) No user-facing sync RPC may be SECURITY DEFINER. Ever.
    if r.schema = 'public' and r.prosecdef then
      raise exception
        'public.% is SECURITY DEFINER — user-facing sync RPCs must be SECURITY INVOKER',
        r.proname;
    end if;

    -- (2) DEFINER survives only in the job allowlist, owned by the
    --     least-privilege role (v1.2 §3.3.5).
    if r.schema = 'echo_jobs' and r.prosecdef and r.owner <> 'echo_jobs_admin' then
      raise exception
        'echo_jobs.% is SECURITY DEFINER but owned by % — only echo_jobs_admin may own definer jobs',
        r.proname, r.owner;
    end if;

    -- (3) Invoker functions must be owned by the role that ran the migration.
    --     On hosted Supabase that is `postgres` by platform behavior; asserting
    --     against current_user makes the check self-consistent by construction.
    if not r.prosecdef and r.owner <> current_user then
      raise exception
        '% is SECURITY INVOKER but owned by % (migration role is %) — unexpected creation path',
        r.proname, r.owner, current_user;
    end if;

    -- (4) Every sync function pins its search_path.
    if r.proconfig is null or not exists (
      select 1 from unnest(r.proconfig) c
       where c like 'search_path=%'
    ) then
      raise exception '% has no pinned search_path', r.proname;
    end if;
  end loop;

  -- Extended: the echo_data helpers are SECURITY INVOKER, migration-role
  -- owned, and search_path pinned (same policy, second namespace).
  for r in
    select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'echo_data'
       and p.proname in ('user_key','current_watermark','current_head','current_epoch',
                         'sanitize_record','build_snapshot','assert_change_log_lock')
  loop
    if r.prosecdef then
      raise exception 'echo_data.% is SECURITY DEFINER — helpers must be SECURITY INVOKER', r.proname;
    end if;
    if r.owner <> current_user then
      raise exception 'echo_data.% owned by % — unexpected creation path', r.proname, r.owner;
    end if;
    if r.proconfig is null or not exists (
      select 1 from unnest(r.proconfig) c where c like 'search_path=%'
    ) then
      raise exception 'echo_data.% has no pinned search_path', r.proname;
    end if;
  end loop;
end $$;
