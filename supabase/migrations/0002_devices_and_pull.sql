-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — B0 migration 0002: helpers, profile init, device lifecycle RPCs
-- (advisory-first lock ordering), and `sync_pull` implementing the PATCH1
-- §4.3.3 device-scoped contract verbatim:
--   lock FIRST → watermark validated UNDER the lock → requesting-device
--   validation (uniform device_not_found for unknown/foreign; device_revoked
--   for the caller's own revoked device) → page read under the lock →
--   guarded exactly-one-row cursor update of the REQUESTING device only.
-- All RPCs: SECURITY INVOKER, pinned search_path, auth.uid()-scoped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ────────────────────────── echo_data helpers ────────────────────────────
-- (echo_jobs_admin is created by migration 0000_roles.sql.)
-- Documented 32-bit derivation of the per-user advisory-lock key
-- (v1.2 §4.3.2 / PATCH1 §4.3.3: ('x' || substr(user::text,1,8))::bit(32)::int,
-- namespace 72451, shared for pulls, exclusive for writers/compaction).
create or replace function echo_data.user_key(p_user uuid) returns int
language sql immutable strict
set search_path = pg_catalog
as $$ select ('x' || substr(p_user::text, 1, 8))::bit(32)::int $$;

-- The persisted watermark (PATCH1 §4.3.6 "watermark row"); floored at 1
-- (v1.1 §11.2). Advanced monotonically, only by the S-2 compaction job.
create or replace function echo_data.current_watermark(p_user uuid) returns bigint
language sql stable
set search_path = pg_catalog, echo_data, auth
as $$ select coalesce((select s.watermark from echo_data.sync_state s
                        where s.user_id = p_user), 1) $$;

-- Per-user head (max committed seq for the user).
create or replace function echo_data.current_head(p_user uuid) returns bigint
language sql stable
set search_path = pg_catalog, echo_data
as $$ select coalesce(max(seq), 0) from echo_data.change_log where user_id = p_user $$;

-- The epoch from profiles (1 by default).
create or replace function echo_data.current_epoch(p_user uuid) returns bigint
language sql stable
set search_path = pg_catalog, echo_data
as $$ select coalesce((select p.epoch from echo_data.profiles p
                        where p.id = p_user), 1) $$;

-- Defense-in-depth artwork strip (02_DATABASE_ARCHITECTURE §5: push
-- sanitization strips posterUrl/backdropUrl/trailerUrl even if a buggy
-- client sends them — no artwork columns exist anywhere in the schema).
create or replace function echo_data.sanitize_record(p_record jsonb) returns jsonb
language sql immutable
set search_path = pg_catalog
as $$ select p_record - 'posterUrl' - 'backdropUrl' - 'trailerUrl' - 'poster' - 'backdrop' - 'trailer' $$;

revoke all on function echo_data.user_key(uuid) from public;
revoke all on function echo_data.current_watermark(uuid) from public;
revoke all on function echo_data.current_head(uuid) from public;
revoke all on function echo_data.current_epoch(uuid) from public;
revoke all on function echo_data.sanitize_record(jsonb) from public;
grant execute on function echo_data.user_key(uuid) to authenticated, echo_jobs_admin;
grant execute on function echo_data.current_watermark(uuid) to authenticated, echo_jobs_admin;
grant execute on function echo_data.current_head(uuid) to authenticated, echo_jobs_admin;
grant execute on function echo_data.current_epoch(uuid) to authenticated, echo_jobs_admin;
grant execute on function echo_data.sanitize_record(jsonb) to authenticated, echo_jobs_admin;

-- ─────────────────────────── sync_init_profile ───────────────────────────
create or replace function public.sync_init_profile() returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user  uuid := auth.uid();
  v_epoch bigint;
  v_boot  uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  insert into echo_data.profiles (id) values (v_user)
    on conflict (id) do nothing;
  insert into echo_data.sync_state (user_id) values (v_user)
    on conflict (user_id) do nothing;

  select p.epoch into v_epoch from echo_data.profiles p where p.id = v_user;
  select s.server_boot_id into v_boot from echo_data.sync_state s where s.user_id = v_user;

  return jsonb_build_object('ok', true, 'epoch', v_epoch, 'serverBootId', v_boot,
                            'watermark', echo_data.current_watermark(v_user),
                            'headSeq', echo_data.current_head(v_user));
end;
$$;

-- ───────────────────────── sync_device_register ──────────────────────────
-- Normative lock-ordering rule (PATCH1 §4.3.3): any transaction that writes
-- a `devices` row must ALREADY hold the per-user advisory lock when it takes
-- the row lock. Register takes the EXCLUSIVE lock first (writer), then
-- inserts. Bookkeeping only — no user data (choice-before-mutation rule).
create or replace function public.sync_device_register(
  p_name        text default null,
  p_platform    text default null,
  p_app_version text default null
) returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user uuid := auth.uid();
  v_name text;
  v_id   uuid;
  v_try  int := 1;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- EXCLUSIVE per-user advisory lock FIRST (single lock per transaction).
  perform pg_advisory_xact_lock(72451, echo_data.user_key(v_user));

  v_name := coalesce(nullif(btrim(p_name), ''), 'Device');
  -- unique (user_id, name) among non-revoked devices — auto-suffix on clash.
  if exists (select 1 from echo_data.devices d
              where d.user_id = v_user and d.revoked_at is null and d.name = v_name) then
    loop
      v_try := v_try + 1;
      exit when v_try > 100 or not exists (
        select 1 from echo_data.devices d
         where d.user_id = v_user and d.revoked_at is null
           and d.name = v_name || ' #' || v_try);
    end loop;
    v_name := v_name || ' #' || v_try;
  end if;

  insert into echo_data.devices (user_id, name, platform, app_version)
    values (v_user, v_name, p_platform, p_app_version)
    returning id into v_id;

  return v_id;
end;
$$;

-- ────────────────────────── sync_device_revoke ───────────────────────────
-- B0 known-gap #3 (master brief): advisory-first lock ordering verified —
-- the EXCLUSIVE per-user advisory lock is acquired BEFORE the devices row is
-- locked/updated, so no lock-order inversion (and no deadlock) is possible
-- with pull/ack (shared → row) or writers (exclusive only).
create or replace function public.sync_device_revoke(p_device_id uuid) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user    uuid := auth.uid();
  v_updated int;
  v_exists  int;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- EXCLUSIVE per-user advisory lock FIRST (normative rule).
  perform pg_advisory_xact_lock(72451, echo_data.user_key(v_user));

  update echo_data.devices d
     set revoked_at = now()
   where d.id = p_device_id
     and d.user_id = v_user
     and d.revoked_at is null;
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    return jsonb_build_object('ok', true, 'revoked', true);
  end if;

  -- Idempotent: revoking an already-revoked own device is a no-op success.
  select count(*) into v_exists
    from echo_data.devices d
   where d.id = p_device_id and d.user_id = v_user;
  if v_exists = 1 then
    return jsonb_build_object('ok', true, 'revoked', true, 'alreadyRevoked', true);
  end if;

  -- Unknown OR foreign identifier — the SAME uniform error (no cross-user
  -- existence oracle), mirroring PATCH1 §4.3.3 step (3).
  raise exception 'device_not_found' using errcode = 'P0001';
end;
$$;

-- ────────────────────────── sync_device_rename ───────────────────────────
create or replace function public.sync_device_rename(p_device_id uuid, p_name text)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user    uuid := auth.uid();
  v_updated int;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_name is null or btrim(p_name) = '' or char_length(p_name) > 60 then
    raise exception 'invalid_device_name' using errcode = '22023';
  end if;

  -- EXCLUSIVE per-user advisory lock FIRST (normative rule).
  perform pg_advisory_xact_lock(72451, echo_data.user_key(v_user));

  if exists (select 1 from echo_data.devices d
              where d.user_id = v_user and d.revoked_at is null
                and d.name = btrim(p_name) and d.id <> p_device_id) then
    raise exception 'device_name_taken' using errcode = '23505';
  end if;

  update echo_data.devices d
     set name = btrim(p_name)
   where d.id = p_device_id
     and d.user_id = v_user
     and d.revoked_at is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'device_not_found' using errcode = 'P0001';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────── sync_pull ───────────────────────────────
-- PATCH1 §4.3.3 — the corrected pull. The structure, ordering and guarded
-- update follow the patch text exactly; the returned `changes` array is
-- shaped to the API contract (v1.1 §9.3) inside the RPC.
create or replace function public.sync_pull(p_device_id uuid,          -- the REQUESTING device —
                                            p_since bigint,           -- echo_data.devices.id (uuid PK)
                                            p_limit int default 500)  -- the identifier sync_push receives
returns jsonb                                                                -- and the client persists
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user    uuid := auth.uid();
  v_key     int;
  v_wm      bigint;
  v_head    bigint;
  v_rows    jsonb;
  v_owner   uuid;
  v_revoked timestamptz;
  v_updated int;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_key := echo_data.user_key(v_user);

  -- (1) SHARED LOCK FIRST. Held to transaction end. While we hold it: no
  --     writer (exclusive) and no compaction (exclusive) can commit for
  --     this user — nothing can change underneath this read.
  perform pg_advisory_xact_lock_shared(72451, v_key);

  -- (2) Read and validate the watermark ONLY NOW, under the lock.
  --     Off-by-one correction, documented: W is the OLDEST seq guaranteed
  --     still present (compaction deletes seq < W); a delta from cursor C
  --     needs rows seq ≥ C+1; the page is complete iff C+1 ≥ W. The literal
  --     PATCH1 snippet tested `p_since < v_wm`, one row MORE conservative —
  --     which makes the empty-account bootstrap delta (since = head = 0 <
  --     W = 1) impossible and 409-loops a freshly acked empty device. This
  --     implementation serves a page iff every row it needs is guaranteed
  --     present — never a partial page (the invariant, verbatim), while the
  --     bootstrap delta stays servable. Precedence over device validation is
  --     retained from the patch: a request that is both stale and
  --     unauthorized surfaces cursor_expired first.
  v_wm := echo_data.current_watermark(v_user);
  if p_since + 1 < v_wm then
    -- the 409 CURSOR_EXPIRED contract is surfaced by the route layer from
    -- this error (mustRebootstrap: true); the RPC never serves a partial
    -- delta below the watermark.
    raise exception 'cursor_expired' using errcode = 'P0001',
      detail = jsonb_build_object('watermark', v_wm, 'mustRebootstrap', true)::text;
  end if;

  -- (3) Validate the REQUESTING device: it must exist, belong to the caller,
  --     and not be revoked. Unknown and foreign identifiers raise the SAME
  --     error (uniform device_not_found — the response is not a cross-user
  --     existence oracle); only the caller's own revoked device is
  --     distinguished (device_revoked, the push vocabulary). These checks
  --     precede every write, so a rejected request mutates no device row.
  --     A NULL p_device_id matches no row and is rejected identically.
  select d.user_id, d.revoked_at
    into v_owner, v_revoked
    from echo_data.devices d
   where d.id = p_device_id;
  if v_owner is null or v_owner <> v_user then
    raise exception 'device_not_found' using errcode = 'P0001';
  end if;
  if v_revoked is not null then
    raise exception 'device_revoked' using errcode = 'P0001';
  end if;

  -- (4) Quiescent boundary and page, still under the lock.
  select coalesce(max(seq), 0) into v_head
    from echo_data.change_log where user_id = v_user;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows
    from (select jsonb_build_object(
                   'seq', c.seq, 'entity', c.entity, 'recordId', c.record_id,
                   'op', c.op, 'version', c.version, 'deviceId', c.device_id,
                   'epoch', c.epoch, 'record', c.payload) as x
            from echo_data.change_log c
           where c.user_id = v_user and c.seq > p_since
           order by c.seq
           limit least(greatest(coalesce(p_limit, 500), 1), 500)) q;

  -- (5) Record the REQUESTING device's CONFIRMED cursor (p_since), never the
  --     delivered head, and never any other device's cursor. The WHERE
  --     guards re-assert ownership and non-revocation atomically with the
  --     write — under READ COMMITTED the operation is re-evaluated against
  --     the committed row version, so a revocation committing between (3)
  --     and (5) leaves this matching zero rows. Exactly one row must match,
  --     else the transaction fails; it never silently succeeds.
  update echo_data.devices d
     set acked_seq      = greatest(d.acked_seq, p_since),
         last_synced_at = now()
   where d.id          = p_device_id
     and d.user_id     = v_user
     and d.revoked_at  is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'device_update_invariant' using errcode = 'P0001',
      detail = 'sync_pull must advance exactly one validated device row';
  end if;

  -- (6) Return the page. The stored cursor remains the confirmed p_since;
  --     the client confirms the delivered head on its NEXT pull.
  return jsonb_build_object('ok', true, 'headSeq', v_head, 'changes', v_rows,
                            'watermark', v_wm);
end;
$$;

-- ────────────────────────── sync_device_list ─────────────────────────────
-- Read-only listing of the caller's devices (the management UI). No lock:
-- it writes no devices row (the normative advisory-first rule applies to
-- devices-row WRITERS).
create or replace function public.sync_device_list() returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, echo_data, auth
as $$
declare
  v_user uuid := auth.uid();
  v_rows jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at), '[]'::jsonb) into v_rows
    from echo_data.devices d
   where d.user_id = v_user;
  return jsonb_build_object('ok', true, 'devices', v_rows);
end;
$$;

revoke all on function public.sync_init_profile() from public, anon;
revoke all on function public.sync_device_register(text, text, text) from public, anon;
revoke all on function public.sync_device_revoke(uuid) from public, anon;
revoke all on function public.sync_device_rename(uuid, text) from public, anon;
revoke all on function public.sync_pull(uuid, bigint, int) from public, anon;
grant execute on function public.sync_init_profile() to authenticated;
grant execute on function public.sync_device_register(text, text, text) to authenticated;
grant execute on function public.sync_device_revoke(uuid) to authenticated;
grant execute on function public.sync_device_rename(uuid, text) to authenticated;
grant execute on function public.sync_pull(uuid, bigint, int) to authenticated;
revoke all on function public.sync_device_list() from public, anon;
grant execute on function public.sync_device_list() to authenticated;
