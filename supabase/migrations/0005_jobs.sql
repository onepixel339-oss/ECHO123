-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — B0 migration 0005: the S-2 job allowlist.
--
--   • `echo_jobs_admin` (created in 0000): nologin, nobypassrls, noinherit —
--     the dedicated least-privilege owner for SECURITY DEFINER jobs.
--   • `echo_jobs` schema hosts the definer jobs. SECURITY DEFINER survives
--     ONLY here, owned by echo_jobs_admin, with pinned search_path and
--     EXECUTE granted only to the job runner (service_role), never
--     `authenticated` (v1.2 §3.3.5; PATCH1 §3.3.7 assertion (2)).
--   • sync_job_compact implements the PATCH1 §4.3.6 protocol: EXCLUSIVE
--     per-user advisory lock (same namespace 72451, same key derivation)
--     acquired BEFORE the watermark advance and row deletion, in ONE
--     transaction per user, monotonic advance only. Tombstone GC follows
--     the v1.1 §11.2 conditions under the same lock.
--   • sync_job_cleanup implements the §5.3.5 archive lifecycle: unresolved
--     rows are NEVER deleted; resolved rows clean up 90 days after
--     resolution with a 200-row oldest-first evictable pool;
--     applied_delete snapshots are a 14-day courtesy window; expired
--     recovery backups and old retired snapshots are removed.
--   • sync_job_reset backs the owner-scoped /api/sync/reset panic button:
--     it is the only sanctioned change_log deletion path outside
--     compaction (the invoker RPCs never delete log rows — v1.2 §3.3.3).
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists echo_jobs authorization echo_jobs_admin;

-- ── Table privileges + RLS standing exemption for the job role ───────────
-- The job role is NOT bypassrls: these explicit permissive policies are the
-- documented, auditable standing exemption (v1.2 §3.3.5), scoped to exactly
-- the tables the jobs maintain.
grant usage on schema echo_data to echo_jobs_admin;
grant select on echo_data.devices to echo_jobs_admin;
grant select, delete on echo_data.change_log to echo_jobs_admin;
grant select, update on echo_data.sync_state to echo_jobs_admin;
grant select, delete on echo_data.conflict_archive to echo_jobs_admin;
grant select, delete on echo_data.recovery_backups to echo_jobs_admin;
grant select, update, delete on echo_data.snapshots to echo_jobs_admin;
grant select, delete on echo_data.snapshot_pages to echo_jobs_admin;
grant select, delete on echo_data.media_items to echo_jobs_admin;
grant select, delete on echo_data.entries to echo_jobs_admin;
grant select, delete on echo_data.feedback to echo_jobs_admin;
grant select, delete on echo_data.works to echo_jobs_admin;
grant select, delete on echo_data.work_links to echo_jobs_admin;
grant select, delete on echo_data.user_settings to echo_jobs_admin;

create policy devices_job_select on echo_data.devices
  for select to echo_jobs_admin using (true);

create policy change_log_job_select on echo_data.change_log
  for select to echo_jobs_admin using (true);
create policy change_log_job_delete on echo_data.change_log
  for delete to echo_jobs_admin using (true);

create policy sync_state_job_select on echo_data.sync_state
  for select to echo_jobs_admin using (true);
create policy sync_state_job_update on echo_data.sync_state
  for update to echo_jobs_admin using (true) with check (true);

create policy conflict_job_select on echo_data.conflict_archive
  for select to echo_jobs_admin using (true);
create policy conflict_job_delete on echo_data.conflict_archive
  for delete to echo_jobs_admin using (true);

create policy recovery_job_select on echo_data.recovery_backups
  for select to echo_jobs_admin using (true);
create policy recovery_job_delete on echo_data.recovery_backups
  for delete to echo_jobs_admin using (true);

create policy snapshots_job_select on echo_data.snapshots
  for select to echo_jobs_admin using (true);
create policy snapshots_job_update on echo_data.snapshots
  for update to echo_jobs_admin using (true) with check (true);
create policy snapshots_job_delete on echo_data.snapshots
  for delete to echo_jobs_admin using (true);

create policy snapshot_pages_job_select on echo_data.snapshot_pages
  for select to echo_jobs_admin using (true);
create policy snapshot_pages_job_delete on echo_data.snapshot_pages
  for delete to echo_jobs_admin using (true);

create policy media_job_select on echo_data.media_items
  for select to echo_jobs_admin using (true);
create policy media_job_delete on echo_data.media_items
  for delete to echo_jobs_admin using (true);
create policy entries_job_select on echo_data.entries
  for select to echo_jobs_admin using (true);
create policy entries_job_delete on echo_data.entries
  for delete to echo_jobs_admin using (true);
create policy feedback_job_select on echo_data.feedback
  for select to echo_jobs_admin using (true);
create policy feedback_job_delete on echo_data.feedback
  for delete to echo_jobs_admin using (true);
create policy works_job_select on echo_data.works
  for select to echo_jobs_admin using (true);
create policy works_job_delete on echo_data.works
  for delete to echo_jobs_admin using (true);
create policy work_links_job_select on echo_data.work_links
  for select to echo_jobs_admin using (true);
create policy work_links_job_delete on echo_data.work_links
  for delete to echo_jobs_admin using (true);
create policy user_settings_job_select on echo_data.user_settings
  for select to echo_jobs_admin using (true);
create policy user_settings_job_delete on echo_data.user_settings
  for delete to echo_jobs_admin using (true);

-- ───────────────────────── sync_job_compact ──────────────────────────────
-- SECURITY DEFINER (the only sanctioned use), owned by echo_jobs_admin.
create or replace function echo_jobs.sync_job_compact(p_user uuid) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, echo_data
as $$
declare
  v_wm_old   bigint;
  v_head_snap bigint;
  v_min_dev  bigint;
  v_candidate bigint;
  v_wm_new   bigint;
  v_deleted  bigint;
  v_gc       bigint := 0;
  v_entities text[] := array['media_items','entries','feedback','works','work_links','user_settings'];
  v_entity   text;
  v_key_col  text;
begin
  -- EXCLUSIVE per-user lock: SAME namespace (72451) and SAME key derivation
  -- as sync_pull (shared) and sync_push (exclusive). Blocks (and blocks
  -- behind) pulls and pushes; one transaction per user; single lock.
  perform pg_advisory_xact_lock(72451, echo_data.user_key(p_user));

  v_wm_old := echo_data.current_watermark(p_user);

  -- Recompute the candidate watermark per the v1.1 §11.2 formula under the
  -- lock: W = min(active_snapshot.head_seq,
  --                min(acked_seq of non-revoked devices seen within
  --                    DEVICE_LIVENESS = 90 days)), floored at 1. Absent
  -- components do not cap (treated as +∞); the current head is the upper
  -- bound (rows above head do not exist yet).
  select coalesce(min(s.head_seq), null) into v_head_snap
    from echo_data.snapshots s
   where s.user_id = p_user and s.status = 'active';

  select min(d.acked_seq) into v_min_dev
    from echo_data.devices d
   where d.user_id = p_user
     and d.revoked_at is null
     and coalesce(d.last_synced_at, d.created_at) >= now() - interval '90 days';

  v_candidate := echo_data.current_head(p_user);
  if v_head_snap is not null then
    v_candidate := least(v_candidate, v_head_snap);
  end if;
  if v_min_dev is not null then
    v_candidate := least(v_candidate, v_min_dev);
  end if;
  v_candidate := greatest(v_candidate, 1);

  -- Monotonic advance only.
  v_wm_new := greatest(v_wm_old, v_candidate);

  if v_wm_new > v_wm_old then
    update echo_data.sync_state set watermark = v_wm_new, updated_at = now()
     where user_id = p_user;
  end if;

  delete from echo_data.change_log
   where user_id = p_user and seq < v_wm_new;
  get diagnostics v_deleted = row_count;

  -- Tombstone GC (v1.1 §11.2): delete tombstones older than 90 days whose
  -- version is below the active snapshot boundary and which every live
  -- device has acked past. Post-GC, a stale push targeting the record falls
  -- to the stale_base_unknown_record archive rule (D-9).
  if v_head_snap is not null then
    foreach v_entity in array v_entities loop
      v_key_col := case v_entity
        when 'media_items' then 'local_id'
        when 'entries'     then 'id'
        when 'feedback'    then 'id'
        when 'works'       then 'work_id'
        when 'work_links'  then 'id'
        else null
      end;
      if v_key_col is null then
        delete from echo_data.user_settings t
         where t.user_id = p_user
           and t.deleted_at is not null
           and t.deleted_at < now() - interval '90 days'
           and t.version < v_head_snap
           and v_min_dev is not null
           and not exists (select 1 from echo_data.devices d
                            where d.user_id = p_user and d.revoked_at is null
                              and coalesce(d.last_synced_at, d.created_at) >= now() - interval '90 days'
                              and d.acked_seq < t.version);
      else
        execute format(
          'delete from echo_data.%I t
            where t.user_id = $1
              and t.deleted_at is not null
              and t.deleted_at < now() - interval ''90 days''
              and t.version < $2
              and $3 is not null
              and not exists (select 1 from echo_data.devices d
                               where d.user_id = $1 and d.revoked_at is null
                                 and coalesce(d.last_synced_at, d.created_at) >= now() - interval ''90 days''
                                 and d.acked_seq < t.version)',
          v_entity)
        using p_user, v_head_snap, v_min_dev;
      end if;
      get diagnostics v_deleted = row_count;
      v_gc := v_gc + coalesce(v_deleted, 0);
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'watermarkBefore', v_wm_old,
                            'watermarkNew', v_wm_new,
                            'deletedLogRows', v_deleted, 'gcTombstones', v_gc);
end;
$$;

-- ───────────────────────── sync_job_cleanup ──────────────────────────────
-- §5.3.5 archive lifecycle + backup expiry + snapshot retirement, under the
-- exclusive per-user lock (deleting snapshot pages a pull might be reading
-- is excluded by the lock; archive cleanup shares the single-lock rule).
create or replace function echo_jobs.sync_job_cleanup(p_user uuid) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, echo_data
as $$
declare
  v_del_resolved  bigint := 0;
  v_evicted       bigint := 0;
  v_del_applied   bigint := 0;
  v_del_backups   bigint := 0;
  v_del_snaps     bigint := 0;
  v_keep          bigint;
begin
  perform pg_advisory_xact_lock(72451, echo_data.user_key(p_user));

  -- Class 2/3: resolved/acknowledged rows — 90 days after resolution.
  delete from echo_data.conflict_archive
   where user_id = p_user
     and resolved_at is not null
     and resolved_at < now() - interval '90 days';
  get diagnostics v_del_resolved = row_count;

  -- Evictable pool: at most 200 resolved rows per user, oldest-first by
  -- resolved_at. (Unresolved rows are NEVER part of any eviction pool.)
  select count(*) into v_keep from echo_data.conflict_archive
   where user_id = p_user and resolved_at is not null;
  if v_keep > 200 then
    with evict as (
      select id from echo_data.conflict_archive
       where user_id = p_user and resolved_at is not null
       order by resolved_at desc
       offset 200
    )
    delete from echo_data.conflict_archive c using evict e
     where c.id = e.id and c.user_id = p_user;
    get diagnostics v_evicted = row_count;
  end if;

  -- Class 4: applied_delete snapshots — 14-day courtesy window.
  delete from echo_data.conflict_archive
   where user_id = p_user
     and reason = 'applied_delete'
     and created_at < now() - interval '14 days';
  get diagnostics v_del_applied = row_count;

  -- Expired recovery backups.
  delete from echo_data.recovery_backups
   where user_id = p_user and expires_at < now();
  get diagnostics v_del_backups = row_count;

  -- Retired snapshots older than the 90-day retention window: pages first
  -- (explicit deletes — no reliance on FK-cascade/RLS interactions), then
  -- the snapshot rows.
  create temp table if not exists tmp_old_snaps (id bigint primary key) on commit drop;
  delete from tmp_old_snaps;
  insert into tmp_old_snaps
  select s.id from echo_data.snapshots s
   where s.user_id = p_user and s.status = 'retired'
     and s.created_at < now() - interval '90 days';
  delete from echo_data.snapshot_pages p using tmp_old_snaps t
   where p.snapshot_id = t.id;
  delete from echo_data.snapshots s using tmp_old_snaps t
   where s.id = t.id and s.user_id = p_user;
  get diagnostics v_del_snaps = row_count;

  return jsonb_build_object(
    'ok', true,
    'deletedResolved', v_del_resolved, 'evictedResolved', v_evicted,
    'deletedAppliedDelete', v_del_applied, 'deletedBackups', v_del_backups,
    'deletedSnapshots', v_del_snaps);
end;
$$;

-- ───────────────────────── sync_job_reset ────────────────────────────────
-- Backing the owner-scoped /api/sync/reset panic button (v1.1 §9.3): wipes
-- the user's replica, rotates serverBootId, resets the watermark, bumps the
-- epoch. Keeps push_ops (opid idempotency survives), conflict_archive and
-- recovery_backups (recovery data). Called by the route with the caller's
-- verified uid — the job takes no user input.
create or replace function echo_jobs.sync_job_reset(p_user uuid) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, echo_data
as $$
declare
  v_epoch bigint;
  v_boot  uuid;
begin
  perform pg_advisory_xact_lock(72451, echo_data.user_key(p_user));

  delete from echo_data.snapshot_pages p using echo_data.snapshots s
   where p.snapshot_id = s.id and s.user_id = p_user;
  delete from echo_data.snapshots where user_id = p_user;
  delete from echo_data.change_log where user_id = p_user;
  delete from echo_data.media_items where user_id = p_user;
  delete from echo_data.entries where user_id = p_user;
  delete from echo_data.feedback where user_id = p_user;
  delete from echo_data.works where user_id = p_user;
  delete from echo_data.work_links where user_id = p_user;
  delete from echo_data.user_settings where user_id = p_user;

  update echo_data.sync_state
     set watermark = 1, server_boot_id = gen_random_uuid(), updated_at = now()
   where user_id = p_user
  returning server_boot_id into v_boot;

  update echo_data.profiles set epoch = epoch + 1, updated_at = now()
   where id = p_user returning epoch into v_epoch;

  update echo_data.devices set epoch = v_epoch where user_id = p_user and revoked_at is null;

  return jsonb_build_object('ok', true, 'epoch', v_epoch, 'serverBootId', v_boot);
end;
$$;

-- EXECUTE: only the job runner — never public, anon, or authenticated.
revoke all on function echo_jobs.sync_job_compact(uuid) from public, anon, authenticated;
revoke all on function echo_jobs.sync_job_cleanup(uuid) from public, anon, authenticated;
revoke all on function echo_jobs.sync_job_reset(uuid) from public, anon, authenticated;
grant execute on function echo_jobs.sync_job_compact(uuid) to service_role;
grant execute on function echo_jobs.sync_job_cleanup(uuid) to service_role;
grant execute on function echo_jobs.sync_job_reset(uuid) to service_role;
grant usage on schema echo_jobs to service_role;

-- Definer jobs must be owned by the least-privilege role (PATCH1 §3.3.7
-- assertion (2) checks exactly this).
alter function echo_jobs.sync_job_compact(uuid) owner to echo_jobs_admin;
alter function echo_jobs.sync_job_cleanup(uuid) owner to echo_jobs_admin;
alter function echo_jobs.sync_job_reset(uuid)   owner to echo_jobs_admin;
