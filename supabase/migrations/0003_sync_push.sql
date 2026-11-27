-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — B0/B2 migration 0003: sync_push — idempotent, device-validated,
-- per-user write-serialized, implementing the v1.2 §5.3.1 decision table
-- D-1…D-10 with the v1.3 PATCH1 §5.3.4 six-value reason constraint and the
-- §5.3.5 archive lifecycle (200-row unresolved soft cap → backpressure).
--
-- Resolutions applied here (master-brief B0 gate list):
--   • O-2 unified: foreign and unknown devices raise the SAME
--     `device_not_found` (v1.1 §6.6 case 3's separate `device_not_owned`
--     vocabulary is retired — the push path is no longer a cross-user
--     existence oracle; PATCH1 §15.3-13 recommendation adopted).
--   • Backpressure: a push that would create a NEW unresolved conflict row
--     for a user already at the 200-row soft cap is rejected per-op with
--     `conflict_archive_full`; the op is NOT applied and NOT discarded —
--     the client retains it in the outbox. Non-conflicting ops commit.
--   • Row caps: batches that would take a user beyond 5,000 live media rows
--     or 20,000 total live rows are rejected whole (`row_cap_exceeded`).
--   • Defense in depth: artwork keys are stripped server-side
--     (echo_data.sanitize_record) and a media_items upsert whose record
--     carries provider='anilist' is rejected (`provider_policy`) — the DB
--     hard floor for cloudSyncPolicy = none. The registry flip gate (D-20)
--     owns any change to this floor.
--   • Epoch: an optional p_epoch (the client's observed epoch, learned from
--     status/bootstrap) is validated against profiles.epoch; a mismatch
--     raises `epoch_mismatch` (the v1.1 §10.4 enforcement, server-checked).
--     Clients that send no epoch are not blocked (client-side observation
--     via sync_status remains the primary mechanism).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.sync_push(ops jsonb, p_device_id uuid, p_epoch bigint default null)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user        uuid := auth.uid();
  v_key         int;
  v_owner       uuid;
  v_revoked     timestamptz;
  v_epoch       bigint;
  v_head        bigint;
  v_n           int;
  v_i           int;
  v_op          jsonb;
  v_opid        text;
  v_entity      text;
  v_record_id   text;
  v_key_col     text;
  v_opkind      text;
  v_base        bigint;
  v_record      jsonb;
  v_payload_log jsonb;
  v_exists      boolean;
  v_ver         bigint;
  v_del         timestamptz;
  v_rec         jsonb;
  v_seq         bigint;
  v_reason      text;
  v_apply       boolean;
  v_conflict_id bigint;
  v_rej_obj     jsonb;
  v_rowcount    int;
  v_dupe        boolean;
  v_acked       text[]  := '{}';
  v_archived    jsonb[] := '{}';
  v_rejected    jsonb[] := '{}';
  v_unresolved  bigint;
  v_media_live  bigint;
  v_total_live  bigint;
  v_new_media   int := 0;
  v_new_total   int := 0;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- ── Device validation (uniform; O-2 resolution) ──
  select d.user_id, d.revoked_at into v_owner, v_revoked
    from echo_data.devices d where d.id = p_device_id;
  if v_owner is null or v_owner <> v_user then
    raise exception 'device_not_found' using errcode = 'P0001';
  end if;
  if v_revoked is not null then
    raise exception 'device_revoked' using errcode = 'P0001';
  end if;

  -- ── Request shape guards ──
  if ops is null or jsonb_typeof(ops) <> 'array' then
    raise exception 'push_batch_invalid' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(ops);
  if v_n > 200 then
    raise exception 'push_batch_too_large' using errcode = '22023',
      detail = 'batch exceeds the 200-op server-advertised limit';
  end if;

  -- ── Profile/sync_state rows exist (init is idempotent; guard anyway) ──
  insert into echo_data.profiles (id) values (v_user) on conflict (id) do nothing;
  insert into echo_data.sync_state (user_id) values (v_user) on conflict (user_id) do nothing;
  v_epoch := echo_data.current_epoch(v_user);
  if p_epoch is not null and p_epoch <> v_epoch then
    raise exception 'epoch_mismatch' using errcode = 'P0001',
      detail = jsonb_build_object('serverEpoch', v_epoch, 'mustRebootstrap', true)::text;
  end if;

  -- ── Row caps (batch-level, whole-batch rejection) ──
  select count(*) into v_media_live from echo_data.media_items
    where user_id = v_user and deleted_at is null;
  select count(*) into v_total_live from echo_data.media_items where user_id = v_user and deleted_at is null;
  select v_total_live + count(*) into v_total_live from echo_data.entries where user_id = v_user and deleted_at is null;
  select v_total_live + count(*) into v_total_live from echo_data.feedback where user_id = v_user and deleted_at is null;
  select v_total_live + count(*) into v_total_live from echo_data.works where user_id = v_user and deleted_at is null;
  select v_total_live + count(*) into v_total_live from echo_data.work_links where user_id = v_user and deleted_at is null;
  select v_total_live + count(*) into v_total_live from echo_data.user_settings where user_id = v_user and deleted_at is null;

  -- Unresolved-conflict count for the soft cap (§5.3.5).
  select count(*) into v_unresolved from echo_data.conflict_archive
    where user_id = v_user and resolved_at is null;

  -- ── Per-user write serialization: EXCLUSIVE advisory lock FIRST ──
  -- Allocation order equals commit order for this user (v1.2 §4.3.2);
  -- the change_log lock-guard trigger (migration 0006) asserts it.
  perform pg_advisory_xact_lock(72451, echo_data.user_key(v_user));

  for v_i in 0 .. v_n - 1 loop
    v_op        := ops -> v_i;
    v_opid      := v_op ->> 'opid';
    v_entity    := v_op ->> 'entity';
    v_record_id := coalesce(v_op ->> 'recordId', '');
    v_opkind    := v_op ->> 'op';
    v_base      := coalesce((v_op ->> 'baseVersion')::bigint, 0);
    v_record    := echo_data.sanitize_record(v_op -> 'record');

    -- ── Per-op schema validation → rejected[] (never wedges the batch) ──
    if v_opid is null or v_opid = ''
       or v_entity not in ('media_items','entries','feedback','works','work_links','user_settings')
       or v_opkind not in ('upsert','delete')
       or v_base < 0
       or (v_opkind = 'upsert' and (v_record is null or jsonb_typeof(v_record) <> 'object'))
    then
      v_rejected := array_append(v_rejected,
        jsonb_build_object('opid', v_opid, 'reason', 'schema'));
      continue;
    end if;

    -- AniList hard floor (cloudSyncPolicy = none): no AniList-derived media
    -- record is ever stored server-side, whatever the client did.
    if v_entity = 'media_items' and v_opkind = 'upsert'
       and v_record ->> 'provider' = 'anilist' then
      v_rejected := array_append(v_rejected,
        jsonb_build_object('opid', v_opid, 'reason', 'provider_policy'));
      continue;
    end if;

    -- media_items needs the NOT NULL typed columns present in the record.
    if v_entity = 'media_items' and v_opkind = 'upsert'
       and (v_record ->> 'mediaType' is null or v_record ->> 'provider' is null) then
      v_rejected := array_append(v_rejected,
        jsonb_build_object('opid', v_opid, 'reason', 'schema'));
      continue;
    end if;

    if v_entity = 'user_settings' then
      v_record_id := 'settings';
      v_key_col   := null;
    else
      v_key_col := case v_entity
        when 'media_items' then 'local_id'
        when 'entries'     then 'id'
        when 'feedback'    then 'id'
        when 'works'       then 'work_id'
        when 'work_links'  then 'id'
      end;
    end if;

    -- ── Opid idempotency (INV-1/INV-2): already-applied opids ack silently.
    -- The ledger row is written only when the op is actually PROCESSED
    -- (applied or archived) — a rejected op (schema / provider_policy /
    -- conflict_archive_full) leaves NO ledger row, so the client's retry
    -- re-processes it. Race-free: the exclusive per-user lock means no
    -- concurrent writer can apply the same opid between the check and the
    -- insert.
    if exists (select 1 from echo_data.push_ops p
                where p.user_id = v_user and p.device_id = p_device_id
                  and p.opid = v_opid) then
      v_acked := array_append(v_acked, v_opid);
      continue;
    end if;

    -- ── Read the stored state for the CAS decision ──
    v_exists := false; v_ver := null; v_del := null; v_rec := null;
    if v_key_col is null then
      execute format('select version, deleted_at, record from echo_data.%I where user_id = $1', v_entity)
        into v_ver, v_del, v_rec using v_user;
      get diagnostics v_rowcount = row_count;
      v_exists := v_rowcount > 0;
    else
      execute format('select version, deleted_at, record from echo_data.%I where user_id = $1 and %I = $2', v_entity, v_key_col)
        into v_ver, v_del, v_rec using v_user, v_record_id;
      get diagnostics v_rowcount = row_count;
      v_exists := v_rowcount > 0;
    end if;
    v_ver := coalesce(v_ver, 0);

    -- ── The D-1…D-10 decision table (v1.2 §5.3.1, retained by PATCH1) ──
    -- v_apply = the op is applied; v_reason = an archive row is also/harder
    -- written (D-2 applies AND archives; D-3/D-4/D-6/D-9 only archive).
    v_reason := null;
    v_apply  := false;

    if v_opkind = 'upsert' then
      if not v_exists then
        if v_base = 0 then
          v_apply := true;                                    -- D-8: apply fresh insert
        else
          v_reason := 'stale_base_unknown_record';            -- D-9: archive, do not apply
        end if;
      elsif v_del is null then                                -- stored LIVE
        if v_base = v_ver then
          v_apply := true;                                    -- D-1: fast path, apply
        elsif v_base < v_ver then
          v_reason := 'edit_edit';                            -- D-3: server wins, incoming archived
        else
          v_apply := true;                                    -- D-10: apply + server_rebuild marker
        end if;
      else                                                    -- stored TOMBSTONE
        if v_base = v_ver then
          v_apply := true;                                    -- D-5: informed resurrection, apply
        elsif v_base < v_ver then
          v_reason := 'delete_vs_upsert';                     -- D-6: delete wins, incoming archived
        else
          v_apply := true;                                    -- D-10 (tombstone variant): apply + marker
        end if;
      end if;
    else                                                      -- op = delete
      if not v_exists then
        if v_base = 0 then
          -- Delete of an absent record with base 0: acknowledged no-op —
          -- there is no row to tombstone and nothing to tell other devices.
          v_acked := array_append(v_acked, v_opid);
          continue;
        else
          v_reason := 'stale_base_unknown_record';            -- D-9
        end if;
      elsif v_del is null then                                -- stored LIVE
        if v_base = v_ver then
          v_apply := true;                                    -- D-2: apply + archive superseded record
          v_reason := 'applied_delete';
        elsif v_base < v_ver then
          v_reason := 'delete_vs_edit';                       -- D-4: NOT applied; intent archived + card
        else
          v_apply := true;                                    -- D-10 (delete variant): apply + marker
        end if;
      else                                                    -- stored TOMBSTONE
        v_apply := true;                                      -- D-7: no-op confirmation
      end if;
    end if;

    -- ── Backpressure (§5.3.5): unresolved-conflict soft cap ──
    if v_reason is not null and v_reason <> 'applied_delete' and v_unresolved >= 200 then
      v_rejected := array_append(v_rejected,
        jsonb_build_object('opid', v_opid, 'reason', 'conflict_archive_full'));
      continue;
    end if;

    -- ── Row caps: count prospective new rows ──
    if v_apply and v_opkind = 'upsert' and not v_exists then
      v_new_total := v_new_total + 1;
      if v_entity = 'media_items' then v_new_media := v_new_media + 1; end if;
      if v_media_live + v_new_media > 5000 or v_total_live + v_new_total > 20000 then
        raise exception 'row_cap_exceeded' using errcode = '22023',
          detail = 'per-user live row caps (5000 media / 20000 total) would be exceeded';
      end if;
    end if;

    -- ── Apply / archive: record the opid in the idempotency ledger — the op
    -- is now definitely processed (applied and/or archived).
    insert into echo_data.push_ops (user_id, device_id, opid)
      values (v_user, p_device_id, v_opid);

    if v_apply then
      -- APPLY path (D-1/D-2/D-5/D-7/D-8/D-10).
      v_payload_log := v_record;
      if v_exists and v_base > v_ver then
        -- D-10 marker: the browser is the source of truth after a server reset.
        v_payload_log := coalesce(v_record, '{}'::jsonb) || jsonb_build_object('_echoServerRebuild', true);
      end if;

      insert into echo_data.change_log
        (user_id, epoch, entity, record_id, op, version, device_id, payload)
      values
        (v_user, v_epoch, v_entity, v_record_id, v_opkind, 0, p_device_id, v_payload_log)
      returning seq into v_seq;
      update echo_data.change_log set version = v_seq where seq = v_seq;

      if v_opkind = 'upsert' then
        if v_entity = 'user_settings' then
          insert into echo_data.user_settings (user_id, record, version, deleted_at, origin_device_id)
          values (v_user, v_record, v_seq, null, p_device_id)
          on conflict (user_id) do update
            set record = excluded.record, version = excluded.version,
                deleted_at = null, origin_device_id = excluded.origin_device_id,
                updated_at = now();
        elsif v_entity = 'media_items' then
          insert into echo_data.media_items
            (user_id, local_id, work_id, media_type, provider, record, version, deleted_at, origin_device_id)
          values (v_user, v_record_id, v_record ->> 'workId',
                  v_record ->> 'mediaType', v_record ->> 'provider',
                  v_record, v_seq, null, p_device_id)
          on conflict (user_id, local_id) do update
            set record = excluded.record, version = excluded.version,
                work_id = excluded.work_id, media_type = excluded.media_type,
                provider = excluded.provider, deleted_at = null,
                origin_device_id = excluded.origin_device_id, updated_at = now();
        elsif v_entity = 'entries' then
          insert into echo_data.entries (user_id, id, media_local_id, status, record, version, deleted_at, origin_device_id)
          values (v_user, v_record_id, v_record ->> 'mediaLocalId', v_record ->> 'status',
                  v_record, v_seq, null, p_device_id)
          on conflict (user_id, id) do update
            set record = excluded.record, version = excluded.version,
                media_local_id = excluded.media_local_id, status = excluded.status,
                deleted_at = null, origin_device_id = excluded.origin_device_id,
                updated_at = now();
        else
          execute format(
            'insert into echo_data.%I (user_id, %I, record, version, deleted_at, origin_device_id)
             values ($1, $2, $3, $4, null, $5)
             on conflict (user_id, %I) do update
               set record = excluded.record, version = excluded.version,
                   deleted_at = null, origin_device_id = excluded.origin_device_id,
                   updated_at = now()',
            v_entity, v_key_col, v_key_col)
            using v_user, v_record_id, v_record, v_seq, p_device_id;
        end if;
      else
        -- DELETE apply (D-2 / D-7 / D-10-delete). D-7 keeps the original
        -- deleted_at (GC clock); a live delete stamps it now.
        if v_exists and v_del is not null then
          if v_key_col is null then
            execute format('update echo_data.%I set record = null, version = $2, origin_device_id = $3, updated_at = now() where user_id = $1', v_entity)
              using v_user, v_seq, p_device_id;
          else
            execute format('update echo_data.%I set record = null, version = $3, origin_device_id = $4, updated_at = now() where user_id = $1 and %I = $2', v_entity, v_key_col)
              using v_user, v_record_id, v_seq, p_device_id;
          end if;
        else
          if v_key_col is null then
            execute format('update echo_data.%I set deleted_at = now(), record = null, version = $2, origin_device_id = $3, updated_at = now() where user_id = $1', v_entity)
              using v_user, v_seq, p_device_id;
          else
            execute format('update echo_data.%I set deleted_at = now(), record = null, version = $3, origin_device_id = $4, updated_at = now() where user_id = $1 and %I = $2', v_entity, v_key_col)
              using v_user, v_record_id, v_seq, p_device_id;
          end if;
        end if;
      end if;

      -- D-2 additionally archives the superseded record snapshot (14-day
      -- courtesy copy — §5.3.5 class 4).
      if v_reason = 'applied_delete' then
        insert into echo_data.conflict_archive
          (user_id, entity, record_id, reason, base_version, server_version, client_payload, client_device)
        values
          (v_user, v_entity, v_record_id, 'applied_delete', v_base, v_ver,
           jsonb_build_object('kind', 'applied_delete_snapshot', 'opid', v_opid,
                              'record', v_rec, 'baseVersion', v_base),
           p_device_id)
        returning id into v_conflict_id;
        v_archived := array_append(v_archived,
          jsonb_build_object('opid', v_opid, 'reason', 'applied_delete',
                             'conflictId', v_conflict_id, 'serverVersion', v_ver));
      end if;

      v_acked := array_append(v_acked, v_opid);

    else
      -- ARCHIVE path (D-3/D-4/D-6/D-9): the op is not applied; the losing
      -- op is persisted verbatim with both versions and a restore path.
      -- Same transaction as the decision → archive-write failure rolls the
      -- whole op application back (T-3.12 atomicity).
      insert into echo_data.conflict_archive
        (user_id, entity, record_id, reason, base_version, server_version, client_payload, client_device)
      values
        (v_user, v_entity, v_record_id, v_reason, v_base,
         case when v_exists then v_ver else null end,
         case when (v_op -> 'record') is null then v_op
              else jsonb_set(v_op, '{record}', v_record) end,
         p_device_id)
      returning id into v_conflict_id;
      v_unresolved := v_unresolved + 1;
      v_archived := array_append(v_archived,
        jsonb_build_object('opid', v_opid, 'reason', v_reason,
                           'conflictId', v_conflict_id,
                           'serverVersion', case when v_exists then v_ver else null end));
    end if;
  end loop;

  v_head := echo_data.current_head(v_user);

  return jsonb_build_object(
    'ok', true, 'epoch', v_epoch, 'headSeq', v_head,
    'acked', to_jsonb(v_acked),
    'archived', to_jsonb(v_archived),
    'rejected', to_jsonb(v_rejected));
end;
$$;

revoke all on function public.sync_push(jsonb, uuid, bigint) from public, anon;
grant  execute on function public.sync_push(jsonb, uuid, bigint) to authenticated;
