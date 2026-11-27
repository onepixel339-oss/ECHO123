-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — B0/B2 migration 0004: snapshots, bootstrap RPCs, status, conflict
-- resolution, keep-local / restore-backup (advisory-first), reset support.
--
-- Resolutions applied here (master-brief B0 gate list):
--   • O-1 RESOLVED: `sync_bootstrap_ack` now RECEIVES the requesting
--     deviceId, validates existence/ownership/non-revocation by the PATCH1
--     §4.3.3 pattern, and updates exactly that device with a guarded
--     exactly-one-row assertion (shared advisory lock → row lock order).
--   • Lock ordering (PATCH1 §4.3.3 normative rule): every devices-row
--     writer here acquires the per-user advisory lock BEFORE the row lock —
--     bootstrap ack: shared → row; keep_local / restore_backup: exclusive →
--     row. (sync_reset's log deletion lives in the S-2 job, migration 0005.)
--   • Snapshot boundaries are lock-guarded: creation and status take the
--     shared per-user advisory lock BEFORE capturing head_seq and reading
--     entities. Under the shared lock no writer for this user can commit,
--     so multi-statement entity reads are stable for that user even under
--     READ COMMITTED (the PATCH1 §4.3.3 isolation model). The route wraps
--     snapshot creation in a REPEATABLE READ transaction as belt-and-braces.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────── snapshot creation (internal) ──────────────────
-- Builds a new immutable generation: reads every entity row (tombstones
-- included) ordered by (entity, record_id), materializes ≤500-record pages
-- (never spanning entities) with sha256 page hashes and a Merkle root,
-- inserts the snapshots row (building → active) and retires the previously
-- active generation. Caller must already hold the per-user shared advisory
-- lock (sync_bootstrap_status does).
create or replace function echo_data.build_snapshot(p_user uuid) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_epoch      bigint;
  v_head       bigint;
  v_snap_id    bigint;
  v_entities   text[] := array['media_items','entries','feedback','works','work_links','user_settings'];
  v_entity     text;
  v_key_col    text;
  r            record;
  v_page       jsonb := '[]'::jsonb;
  v_page_no    int := 0;
  v_rows_total int := 0;
  v_in_page    int := 0;
  v_first_key  text;
  v_last_key   text;
  v_page_hash  text;
  v_root       text;
begin
  v_epoch := echo_data.current_epoch(p_user);
  v_head  := echo_data.current_head(p_user);

  insert into echo_data.snapshots (user_id, epoch, head_seq, status, record_count, page_count, content_hash)
  values (p_user, v_epoch, v_head, 'building', 0, 0, '')
  returning id into v_snap_id;

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
      for r in execute format(
            'select %L::text as rid, version, record from echo_data.%I where user_id = $1',
            'settings', v_entity) using p_user
      loop
        v_page := v_page || jsonb_build_object('recordId', r.rid, 'version', r.version,
                                               'record', r.record);
        if v_in_page = 0 then v_first_key := r.rid; end if;
        v_last_key := r.rid;
        v_in_page := v_in_page + 1;
        v_rows_total := v_rows_total + 1;
        if v_in_page = 500 then
          v_page_no := v_page_no + 1;
          v_page_hash := encode(sha256(convert_to(v_page::text, 'utf8')), 'hex');
          insert into echo_data.snapshot_pages
            (snapshot_id, page_no, entity, first_key, last_key, row_count, page_hash, payload)
          values
            (v_snap_id, v_page_no, v_entity, v_first_key, v_last_key, v_in_page, v_page_hash, v_page);
          v_page := '[]'::jsonb; v_in_page := 0; v_first_key := null;
        end if;
      end loop;
    else
      for r in execute format(
            'select %I as rid, version, record from echo_data.%I where user_id = $1 order by %I',
            v_key_col, v_entity, v_key_col) using p_user
      loop
        v_page := v_page || jsonb_build_object('recordId', r.rid, 'version', r.version,
                                               'record', r.record);
        if v_in_page = 0 then v_first_key := r.rid; end if;
        v_last_key := r.rid;
        v_in_page := v_in_page + 1;
        v_rows_total := v_rows_total + 1;
        if v_in_page = 500 then
          v_page_no := v_page_no + 1;
          v_page_hash := encode(sha256(convert_to(v_page::text, 'utf8')), 'hex');
          insert into echo_data.snapshot_pages
            (snapshot_id, page_no, entity, first_key, last_key, row_count, page_hash, payload)
          values
            (v_snap_id, v_page_no, v_entity, v_first_key, v_last_key, v_in_page, v_page_hash, v_page);
          v_page := '[]'::jsonb; v_in_page := 0; v_first_key := null;
        end if;
      end loop;
    end if;

    -- flush the entity's trailing partial page (pages never span entities)
    if v_in_page > 0 then
      v_page_no := v_page_no + 1;
      v_page_hash := encode(sha256(convert_to(v_page::text, 'utf8')), 'hex');
      insert into echo_data.snapshot_pages
        (snapshot_id, page_no, entity, first_key, last_key, row_count, page_hash, payload)
      values
        (v_snap_id, v_page_no, v_entity, v_first_key, v_last_key, v_in_page, v_page_hash, v_page);
      v_page := '[]'::jsonb; v_in_page := 0; v_first_key := null;
    end if;
  end loop;

  select encode(sha256(convert_to(coalesce(string_agg(page_hash, '' order by page_no), ''), 'utf8')), 'hex')
    into v_root
    from echo_data.snapshot_pages where snapshot_id = v_snap_id;

  update echo_data.snapshots
     set status = 'active', record_count = v_rows_total, page_count = v_page_no, content_hash = v_root
   where id = v_snap_id;

  -- retire the previous active generation(s)
  update echo_data.snapshots set status = 'retired'
   where user_id = p_user and status = 'active' and id <> v_snap_id;

  return jsonb_build_object('id', v_snap_id, 'headSeq', v_head, 'epoch', v_epoch,
                            'pageCount', v_page_no, 'recordCount', v_rows_total,
                            'contentHash', v_root);
end;
$$;

revoke all on function echo_data.build_snapshot(uuid) from public, anon;
grant execute on function echo_data.build_snapshot(uuid) to authenticated;

-- ───────────────────────── sync_bootstrap_status ─────────────────────────
-- Shared lock FIRST, then boundary reporting; creates the first active
-- generation on demand (v1.1 §10.2 trigger list).
create or replace function public.sync_bootstrap_status() returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user  uuid := auth.uid();
  v_snap  jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock_shared(72451, echo_data.user_key(v_user));

  insert into echo_data.profiles (id) values (v_user) on conflict (id) do nothing;
  insert into echo_data.sync_state (user_id) values (v_user) on conflict (user_id) do nothing;

  select jsonb_build_object('id', s.id, 'headSeq', s.head_seq, 'pageCount', s.page_count,
                            'recordCount', s.record_count, 'contentHash', s.content_hash,
                            'epoch', s.epoch)
    into v_snap
    from echo_data.snapshots s
   where s.user_id = v_user and s.status = 'active'
     and s.epoch = echo_data.current_epoch(v_user)
   order by s.id desc limit 1;

  if v_snap is null then
    v_snap := echo_data.build_snapshot(v_user);
  end if;

  return jsonb_build_object(
    'ok', true,
    'epoch', echo_data.current_epoch(v_user),
    'headSeq', echo_data.current_head(v_user),
    'watermark', echo_data.current_watermark(v_user),
    'serverBootId', (select st.server_boot_id from echo_data.sync_state st where st.user_id = v_user),
    'activeSnapshot', v_snap);
end;
$$;

-- ───────────────────────── sync_bootstrap_manifest ───────────────────────
create or replace function public.sync_bootstrap_manifest(p_snapshot_id bigint) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user uuid := auth.uid();
  v_pages jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from echo_data.snapshots s
                  where s.id = p_snapshot_id and s.user_id = v_user) then
    raise exception 'snapshot_not_found' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_pages
    from (select jsonb_build_object('pageNo', p.page_no, 'entity', p.entity,
                                    'firstKey', p.first_key, 'lastKey', p.last_key,
                                    'rowCount', p.row_count, 'pageHash', p.page_hash) as x
            from echo_data.snapshot_pages p
           where p.snapshot_id = p_snapshot_id
           order by p.page_no) q;
  return jsonb_build_object('ok', true, 'pages', v_pages);
end;
$$;

-- ───────────────────────── sync_bootstrap_page ───────────────────────────
create or replace function public.sync_bootstrap_page(p_snapshot_id bigint, p_page_no int)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user uuid := auth.uid();
  v_page jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select jsonb_build_object('records', p.payload, 'pageHash', p.page_hash)
    into v_page
    from echo_data.snapshot_pages p
    join echo_data.snapshots s on s.id = p.snapshot_id
   where p.snapshot_id = p_snapshot_id and p.page_no = p_page_no
     and s.user_id = v_user;
  if v_page is null then
    raise exception 'snapshot_page_not_found' using errcode = 'P0001';
  end if;
  return jsonb_build_object('ok', true) || v_page;
end;
$$;

-- ───────────────────────── sync_bootstrap_ack (O-1 RESOLVED) ─────────────
-- PATCH1 §15.3-12: the ack now receives and validates the requesting device
-- identifier (existence / ownership / non-revocation — uniform
-- device_not_found for unknown & foreign, device_revoked for the caller's
-- own), validates drainedSeq ≤ current head UNDER the shared lock, and
-- updates exactly that device row with a guarded exactly-one-row assertion.
-- Idempotent with clamping (v1.2 §4.3.4).
create or replace function public.sync_bootstrap_ack(p_device_id   uuid,
                                                      p_snapshot_id bigint,
                                                      p_drained_seq bigint) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user    uuid := auth.uid();
  v_owner   uuid;
  v_revoked timestamptz;
  v_head    bigint;
  v_epoch   bigint;
  v_updated int;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- SHARED lock FIRST (§4.3.4 ordering: shared → row).
  perform pg_advisory_xact_lock_shared(72451, echo_data.user_key(v_user));

  if not exists (select 1 from echo_data.snapshots s
                  where s.id = p_snapshot_id and s.user_id = v_user) then
    raise exception 'snapshot_not_found' using errcode = 'P0001';
  end if;

  v_head  := echo_data.current_head(v_user);
  v_epoch := echo_data.current_epoch(v_user);

  if p_drained_seq < 0 or p_drained_seq > v_head then
    raise exception 'invalid_drained_seq' using errcode = '22023',
      detail = jsonb_build_object('drainedSeq', p_drained_seq, 'head', v_head)::text;
  end if;

  -- Requesting-device validation (PATCH1 §4.3.3 pattern).
  select d.user_id, d.revoked_at into v_owner, v_revoked
    from echo_data.devices d where d.id = p_device_id;
  if v_owner is null or v_owner <> v_user then
    raise exception 'device_not_found' using errcode = 'P0001';
  end if;
  if v_revoked is not null then
    raise exception 'device_revoked' using errcode = 'P0001';
  end if;

  -- Guarded, exactly-one-row, clamped update of the REQUESTING device only.
  update echo_data.devices d
     set bootstrapped_at = coalesce(d.bootstrapped_at, now()),
         acked_seq       = greatest(d.acked_seq, least(p_drained_seq, v_head)),
         epoch           = v_epoch,
         last_synced_at  = now()
   where d.id = p_device_id
     and d.user_id = v_user
     and d.revoked_at is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'device_update_invariant' using errcode = 'P0001',
      detail = 'sync_bootstrap_ack must update exactly one validated device row';
  end if;

  return jsonb_build_object('ok', true, 'ackedSeq', least(p_drained_seq, v_head),
                            'currentHeadSeq', v_head, 'epoch', v_epoch);
end;
$$;

-- ───────────────────────────── sync_status ───────────────────────────────
create or replace function public.sync_status() returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user       uuid := auth.uid();
  v_counts     jsonb := '{}'::jsonb;
  v_hashes     jsonb := '{}'::jsonb;
  v_unresolved bigint;
  v_state      text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock_shared(72451, echo_data.user_key(v_user));

  insert into echo_data.profiles (id) values (v_user) on conflict (id) do nothing;
  insert into echo_data.sync_state (user_id) values (v_user) on conflict (user_id) do nothing;

  select jsonb_object_agg(entity, cnt) into v_counts from (
    select 'media_items' as entity, count(*) as cnt from echo_data.media_items where user_id = v_user
    union all select 'entries', count(*) from echo_data.entries where user_id = v_user
    union all select 'feedback', count(*) from echo_data.feedback where user_id = v_user
    union all select 'works', count(*) from echo_data.works where user_id = v_user
    union all select 'work_links', count(*) from echo_data.work_links where user_id = v_user
    union all select 'user_settings', count(*) from echo_data.user_settings where user_id = v_user
  ) q;

  select jsonb_object_agg(entity, h) into v_hashes from (
    select 'media_items' as entity, encode(sha256(convert_to(coalesce(string_agg(h, '' order by h), ''), 'utf8')), 'hex') as h
      from (select encode(sha256(convert_to(local_id || ':' || version || ':' || coalesce(record::text, ''), 'utf8')), 'hex') as h
              from echo_data.media_items where user_id = v_user) t
    union all
    select 'entries', encode(sha256(convert_to(coalesce(string_agg(h, '' order by h), ''), 'utf8')), 'hex')
      from (select encode(sha256(convert_to(id || ':' || version || ':' || coalesce(record::text, ''), 'utf8')), 'hex') as h
              from echo_data.entries where user_id = v_user) t
    union all
    select 'feedback', encode(sha256(convert_to(coalesce(string_agg(h, '' order by h), ''), 'utf8')), 'hex')
      from (select encode(sha256(convert_to(id || ':' || version || ':' || coalesce(record::text, ''), 'utf8')), 'hex') as h
              from echo_data.feedback where user_id = v_user) t
    union all
    select 'works', encode(sha256(convert_to(coalesce(string_agg(h, '' order by h), ''), 'utf8')), 'hex')
      from (select encode(sha256(convert_to(work_id || ':' || version || ':' || coalesce(record::text, ''), 'utf8')), 'hex') as h
              from echo_data.works where user_id = v_user) t
    union all
    select 'work_links', encode(sha256(convert_to(coalesce(string_agg(h, '' order by h), ''), 'utf8')), 'hex')
      from (select encode(sha256(convert_to(id || ':' || version || ':' || coalesce(record::text, ''), 'utf8')), 'hex') as h
              from echo_data.work_links where user_id = v_user) t
    union all
    select 'user_settings', encode(sha256(convert_to(coalesce(string_agg(h, '' order by h), ''), 'utf8')), 'hex')
      from (select encode(sha256(convert_to('settings' || ':' || version || ':' || coalesce(record::text, ''), 'utf8')), 'hex') as h
              from echo_data.user_settings where user_id = v_user) t
  ) q2;

  select count(*) into v_unresolved from echo_data.conflict_archive
   where user_id = v_user and resolved_at is null;
  v_state := case when v_unresolved >= 200 then 'full' when v_unresolved >= 160 then 'near_full' else 'ok' end;

  return jsonb_build_object(
    'ok', true,
    'epoch', echo_data.current_epoch(v_user),
    'headSeq', echo_data.current_head(v_user),
    'watermark', echo_data.current_watermark(v_user),
    'serverBootId', (select st.server_boot_id from echo_data.sync_state st where st.user_id = v_user),
    'perEntity', v_counts,
    'perEntityHash', v_hashes,
    'archiveState', jsonb_build_object('unresolved', v_unresolved,
                                       'nearFullAt', 160, 'cap', 200, 'state', v_state));
end;
$$;

-- ─────────────────────── sync_conflict_resolve ───────────────────────────
-- discard = acknowledge; restore returns a pushable op — restoring is itself
-- a normal CAS'd push performed by the client (INV-18).
create or replace function public.sync_conflict_resolve(p_conflict_id bigint, p_action text)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user   uuid := auth.uid();
  v_row    echo_data.conflict_archive%rowtype;
  v_curver bigint;
  v_key_col text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_action not in ('restore', 'discard') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  select * into v_row from echo_data.conflict_archive c
   where c.id = p_conflict_id and c.user_id = v_user;
  if v_row.id is null then
    raise exception 'conflict_not_found' using errcode = 'P0001';
  end if;

  if v_row.resolved_at is not null then
    return jsonb_build_object('ok', true, 'alreadyResolved', true,
                              'resolution', v_row.resolution);
  end if;

  update echo_data.conflict_archive
     set resolved_at = now(),
         resolution = case p_action when 'restore' then 'restored' else 'discarded' end
   where id = p_conflict_id and user_id = v_user;

  if p_action = 'discard' then
    return jsonb_build_object('ok', true, 'resolution', 'discarded');
  end if;

  -- restore: hand back a fresh pushable op with the CURRENT server version
  -- as the suggested base (CAS'd push; may itself conflict — by design).
  v_key_col := case v_row.entity
    when 'media_items' then 'local_id'
    when 'entries'     then 'id'
    when 'feedback'    then 'id'
    when 'works'       then 'work_id'
    when 'work_links'  then 'id'
    else null
  end;
  if v_key_col is null then
    execute format('select version from echo_data.%I where user_id = $1', v_row.entity)
      into v_curver using v_user;
  else
    execute format('select version from echo_data.%I where user_id = $1 and %I = $2', v_row.entity, v_key_col)
      into v_curver using v_user, v_row.record_id;
  end if;

  return jsonb_build_object(
    'ok', true, 'resolution', 'restored',
    'pushOp', jsonb_build_object(
      'op', 'upsert', 'entity', v_row.entity, 'recordId', v_row.record_id,
      'record', coalesce(v_row.client_payload -> 'record', v_row.client_payload),
      'suggestedBaseVersion', coalesce(v_curver, 0)));
end;
$$;

-- ───────────────────────── sync_keep_local ───────────────────────────────
-- One transaction: recovery backup → hard entity delete → epoch_reset log
-- entry → epoch bump → devices epoch update. EXCLUSIVE advisory lock FIRST
-- (normative devices-writer rule). Idempotent per intentId.
create or replace function public.sync_keep_local(p_intent_id text) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user      uuid := auth.uid();
  v_epoch     bigint;
  v_backup    jsonb := '{}'::jsonb;
  v_backup_id bigint;
  v_backup_row jsonb;
  v_seq       bigint;
  v_entities  text[] := array['media_items','entries','feedback','works','work_links','user_settings'];
  v_entity    text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- EXCLUSIVE per-user advisory lock FIRST (single lock per transaction).
  perform pg_advisory_xact_lock(72451, echo_data.user_key(v_user));

  insert into echo_data.profiles (id) values (v_user) on conflict (id) do nothing;

  -- Idempotency: an epoch_reset with the same intentId was already applied.
  if exists (select 1 from echo_data.change_log c
              where c.user_id = v_user and c.op = 'epoch_reset'
                and c.payload ->> 'intentId' = p_intent_id) then
    return jsonb_build_object('ok', true, 'epoch', echo_data.current_epoch(v_user),
                              'alreadyApplied', true);
  end if;

  -- (1) Recovery backup of the full pre-destruction server state (14 days).
  foreach v_entity in array v_entities loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)
                     from (select * from echo_data.%I where user_id = $1) t', v_entity)
      into v_backup_row using v_user;
    v_backup := v_backup || jsonb_build_object(v_entity, v_backup_row);
  end loop;
  insert into echo_data.recovery_backups (user_id, kind, payload, expires_at)
  values (v_user, 'keep_local', v_backup, now() + interval '14 days')
  returning id into v_backup_id;

  -- (2) Hard-delete all entity rows (user-directed destruction; NOT
  --     tombstones — the re-push must not trip delete precedence).
  foreach v_entity in array v_entities loop
    execute format('delete from echo_data.%I where user_id = $1', v_entity) using v_user;
  end loop;

  -- (3) epoch_reset change_log entry (carries the intentId — retry-idempotent).
  insert into echo_data.change_log (user_id, epoch, entity, record_id, op, version, device_id, payload)
  values (v_user, echo_data.current_epoch(v_user), 'user_settings', 'settings', 'epoch_reset', 0, null,
          jsonb_build_object('intentId', p_intent_id, 'kind', 'keep_local'))
  returning seq into v_seq;
  update echo_data.change_log set version = v_seq where seq = v_seq;

  -- (4) Bump the epoch.
  update echo_data.profiles set epoch = epoch + 1, updated_at = now() where id = v_user
    returning epoch into v_epoch;

  -- (5) Devices observe the new epoch at their next status/pull (row updates
  --     AFTER the advisory lock — normative order).
  update echo_data.devices set epoch = v_epoch where user_id = v_user and revoked_at is null;

  -- (6) Retire snapshots of the destroyed state.
  update echo_data.snapshots set status = 'retired' where user_id = v_user and status = 'active';

  return jsonb_build_object('ok', true, 'epoch', v_epoch, 'backupId', v_backup_id,
                            'expiresAt', now() + interval '14 days');
end;
$$;

-- ─────────────────────── sync_restore_backup ─────────────────────────────
-- Advisory-first (EXCLUSIVE), archived-as-a-new-backup restore: the current
-- state is itself backed up (kind 'server_reset', 14 days) before the
-- backup's content is re-instated in a NEW epoch — restore is reversible.
create or replace function public.sync_restore_backup(p_backup_id bigint) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user      uuid := auth.uid();
  v_backup    echo_data.recovery_backups%rowtype;
  v_cur       jsonb := '{}'::jsonb;
  v_row       jsonb;
  v_new_id    bigint;
  v_epoch     bigint;
  v_seq       bigint;
  v_entities  text[] := array['media_items','entries','feedback','works','work_links','user_settings'];
  v_entity    text;
  v_restored  int := 0;
  v_key_col   text;
  v_key_val   text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- EXCLUSIVE per-user advisory lock FIRST (normative devices-writer rule).
  perform pg_advisory_xact_lock(72451, echo_data.user_key(v_user));

  select * into v_backup from echo_data.recovery_backups b
   where b.id = p_backup_id and b.user_id = v_user;
  if v_backup.id is null then
    raise exception 'backup_not_found' using errcode = 'P0001';
  end if;
  if v_backup.expires_at <= now() then
    raise exception 'backup_expired' using errcode = 'P0001';
  end if;

  -- (1) Archive the CURRENT state first (restore is itself reversible).
  foreach v_entity in array v_entities loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)
                     from (select * from echo_data.%I where user_id = $1) t', v_entity)
      into v_row using v_user;
    v_cur := v_cur || jsonb_build_object(v_entity, v_row);
  end loop;
  insert into echo_data.recovery_backups (user_id, kind, payload, expires_at)
  values (v_user, 'server_reset', v_cur, now() + interval '14 days')
  returning id into v_new_id;

  -- (2) Wipe current entities.
  foreach v_entity in array v_entities loop
    execute format('delete from echo_data.%I where user_id = $1', v_entity) using v_user;
  end loop;

  -- (3) Re-instate the backup's rows in the NEW epoch (version 0; tombstones
  --     restored as tombstones — anti-resurrection preserved).
  foreach v_entity in array v_entities loop
    v_key_col := case v_entity
      when 'media_items' then 'local_id'
      when 'entries'     then 'id'
      when 'feedback'    then 'id'
      when 'works'       then 'work_id'
      when 'work_links'  then 'id'
      else null
    end;
    for v_row in select * from jsonb_array_elements(v_backup.payload -> v_entity) loop
      if v_key_col is null then
        insert into echo_data.user_settings (user_id, record, version, deleted_at)
        values (v_user, v_row -> 'record', 0, null)
        on conflict (user_id) do update set record = excluded.record, version = 0,
          deleted_at = null, updated_at = now();
      elsif v_entity = 'media_items' then
        v_key_val := v_row ->> 'local_id';
        insert into echo_data.media_items
          (user_id, local_id, work_id, media_type, provider, record, version, deleted_at)
        values (v_user, v_key_val, v_row ->> 'work_id', v_row ->> 'media_type',
                v_row ->> 'provider', v_row -> 'record', 0,
                case when (v_row ->> 'deleted_at') is null then null::timestamptz
                     else (v_row ->> 'deleted_at')::timestamptz end)
        on conflict (user_id, local_id) do update
          set record = excluded.record, version = 0, work_id = excluded.work_id,
              media_type = excluded.media_type, provider = excluded.provider,
              deleted_at = excluded.deleted_at, updated_at = now();
      elsif v_entity = 'entries' then
        v_key_val := v_row ->> 'id';
        insert into echo_data.entries (user_id, id, media_local_id, status, record, version, deleted_at)
        values (v_user, v_key_val, v_row ->> 'media_local_id', v_row ->> 'status',
                v_row -> 'record', 0,
                case when (v_row ->> 'deleted_at') is null then null::timestamptz
                     else (v_row ->> 'deleted_at')::timestamptz end)
        on conflict (user_id, id) do update
          set record = excluded.record, version = 0, media_local_id = excluded.media_local_id,
              status = excluded.status, deleted_at = excluded.deleted_at, updated_at = now();
      else
        v_key_val := v_row ->> v_key_col;
        execute format(
          'insert into echo_data.%I (user_id, %I, record, version, deleted_at)
           values ($1, $2, $3, 0, $4)
           on conflict (user_id, %I) do update set record = excluded.record,
             version = 0, deleted_at = excluded.deleted_at, updated_at = now()',
          v_entity, v_key_col, v_key_col)
        using v_user, v_key_val, v_row -> 'record',
              case when (v_row ->> 'deleted_at') is null then null::timestamptz
                   else (v_row ->> 'deleted_at')::timestamptz end;
      end if;
      v_restored := v_restored + 1;
    end loop;
  end loop;

  -- (4) epoch_reset log entry + (5) epoch bump.
  insert into echo_data.change_log (user_id, epoch, entity, record_id, op, version, device_id, payload)
  values (v_user, echo_data.current_epoch(v_user), 'user_settings', 'settings', 'epoch_reset', 0, null,
          jsonb_build_object('kind', 'restore_backup', 'backupId', p_backup_id))
  returning seq into v_seq;
  update echo_data.change_log set version = v_seq where seq = v_seq;

  update echo_data.profiles set epoch = epoch + 1, updated_at = now() where id = v_user
    returning epoch into v_epoch;

  -- (6) Devices observe the new epoch.
  update echo_data.devices set epoch = v_epoch where user_id = v_user and revoked_at is null;

  -- (7) Retire snapshots of the pre-restore state.
  update echo_data.snapshots set status = 'retired' where user_id = v_user and status = 'active';

  return jsonb_build_object('ok', true, 'epoch', v_epoch, 'restoredCount', v_restored,
                            'newBackupId', v_new_id);
end;
$$;

revoke all on function public.sync_bootstrap_status() from public, anon;
revoke all on function public.sync_bootstrap_manifest(bigint) from public, anon;
revoke all on function public.sync_bootstrap_page(bigint, int) from public, anon;
revoke all on function public.sync_bootstrap_ack(uuid, bigint, bigint) from public, anon;
revoke all on function public.sync_status() from public, anon;
revoke all on function public.sync_conflict_resolve(bigint, text) from public, anon;
revoke all on function public.sync_keep_local(text) from public, anon;
revoke all on function public.sync_restore_backup(bigint) from public, anon;
grant execute on function public.sync_bootstrap_status() to authenticated;
grant execute on function public.sync_bootstrap_manifest(bigint) to authenticated;
grant execute on function public.sync_bootstrap_page(bigint, int) to authenticated;
grant execute on function public.sync_bootstrap_ack(uuid, bigint, bigint) to authenticated;
grant execute on function public.sync_status() to authenticated;
grant execute on function public.sync_conflict_resolve(bigint, text) to authenticated;
grant execute on function public.sync_keep_local(text) to authenticated;
grant execute on function public.sync_restore_backup(bigint) to authenticated;
