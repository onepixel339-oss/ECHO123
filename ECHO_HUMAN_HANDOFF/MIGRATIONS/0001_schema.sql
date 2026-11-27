-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — B0 migration 0001: the private echo_data schema, all tables, the
-- six-value conflict reason constraint (v1.3 PATCH1 §5.3.4), RLS with
-- per-command policies for `authenticated` — including the REQUIRED
-- `devices` UPDATE policy needed by SECURITY INVOKER RPCs — and the
-- least-privilege grants.
--
-- Design lineage (authoritative):
--   • v1.1 §5.2 DDL (tables, columns) — inherited contract.
--   • v1.2 §3.3.1/§3.3.3 (private schema, per-command RLS) — retained.
--   • v1.3 PATCH1 §5.3.4 (six-value reason check) — applied in the initial
--     DDL so fresh databases are correct from the start.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists echo_data;
revoke all on schema echo_data from public, anon;

-- ─────────────────────────────── profiles ────────────────────────────────
create table echo_data.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  display_name   text,
  locale         text not null default 'en' check (locale in ('en','ar')),
  schema_version int  not null default 4,
  epoch          bigint not null default 1,        -- bumped by keep-local / server reset
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ─────────────────────────────── devices ─────────────────────────────────
-- Identifier contract (PATCH1 §4.3.3): `id` is the uuid primary key from the
-- inherited v1.1 §5.2 DDL — the identifier the client persists for outbox
-- opid generation and sends with every push and pull.
create table echo_data.devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null default 'Device',
  platform        text check (platform in ('windows','macos','linux','android','ios','other')),
  app_version     text,
  acked_seq       bigint not null default 0,       -- last change-log seq pulled (confirmed)
  epoch           bigint not null default 1,       -- epoch this device last synced in
  bootstrapped_at timestamptz,                     -- null = never completed bootstrap
  created_at      timestamptz not null default now(),
  last_synced_at  timestamptz,
  revoked_at      timestamptz
);
create unique index devices_name_uq on echo_data.devices (user_id, name)
  where revoked_at is null;

-- ─────────────── library entities: jsonb records + version/tombstone ─────
-- Every entity table follows the v1.1 §5.2 pattern: typed key columns,
-- `record jsonb` (the §8-classified payload), `version bigint` (seq of the
-- last applied op — the only precedence input), `deleted_at` (tombstone:
-- record = null), `origin_device_id`, `updated_at`.

create table echo_data.media_items (
  user_id          uuid not null references auth.users(id) on delete cascade,
  local_id         text not null,
  work_id          text,
  media_type       text not null check (media_type in
                   ('anime','movie','series','game','book','manga','comics')),
  provider         text not null,
  record           jsonb,                        -- null = tombstone form
  version          bigint not null default 0,
  deleted_at       timestamptz,
  origin_device_id uuid references echo_data.devices(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (user_id, local_id)
);
create index media_items_work_idx on echo_data.media_items (user_id, work_id);

create table echo_data.entries (
  user_id          uuid not null references auth.users(id) on delete cascade,
  id               text not null,
  media_local_id   text,
  status           text,
  record           jsonb,                        -- null = tombstone form
  version          bigint not null default 0,
  deleted_at       timestamptz,
  origin_device_id uuid references echo_data.devices(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (user_id, id)
);

create table echo_data.feedback (
  user_id          uuid not null references auth.users(id) on delete cascade,
  id               text not null,
  record           jsonb,                        -- null = tombstone form
  version          bigint not null default 0,
  deleted_at       timestamptz,
  origin_device_id uuid references echo_data.devices(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (user_id, id)
);

create table echo_data.works (
  user_id          uuid not null references auth.users(id) on delete cascade,
  work_id          text not null,
  record           jsonb,                        -- null = tombstone form
  version          bigint not null default 0,
  deleted_at       timestamptz,
  origin_device_id uuid references echo_data.devices(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (user_id, work_id)
);

create table echo_data.work_links (
  user_id          uuid not null references auth.users(id) on delete cascade,
  id               text not null,
  record           jsonb,                        -- null = tombstone form
  version          bigint not null default 0,
  deleted_at       timestamptz,
  origin_device_id uuid references echo_data.devices(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (user_id, id)
);

-- Single row per user; the protocol's recordId for it is the literal 'settings'.
create table echo_data.user_settings (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  record           jsonb,                        -- null = tombstone form
  version          bigint not null default 0,
  deleted_at       timestamptz,
  origin_device_id uuid references echo_data.devices(id) on delete set null,
  updated_at       timestamptz not null default now()
);

-- ─────────────── change_log: the delta-pull source (global identity) ─────
create table echo_data.change_log (
  seq         bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  epoch       bigint not null default 1,
  entity      text not null check (entity in
              ('media_items','entries','feedback','works','work_links','user_settings')),
  record_id   text not null,
  op          text not null check (op in ('upsert','delete','epoch_reset')),
  version     bigint not null,                -- new record version after this op
  device_id   uuid,
  payload     jsonb,                          -- §8-classified record (upsert) / null
  received_at timestamptz not null default now()
);
create index change_log_pull_idx on echo_data.change_log (user_id, seq);

-- ─────────────────────────── push idempotency ────────────────────────────
create table echo_data.push_ops (
  user_id    uuid not null references auth.users(id) on delete cascade,
  device_id  uuid not null references echo_data.devices(id) on delete cascade,
  opid       text not null,
  applied_at timestamptz not null default now(),
  primary key (user_id, device_id, opid)
);

-- ─────────────── snapshots: immutable bootstrap generations ──────────────
create table echo_data.snapshots (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  epoch        bigint not null,
  head_seq     bigint not null,               -- boundary: effect of all ops seq <= head_seq
  status       text not null default 'active' check (status in ('building','active','retired')),
  record_count int not null,
  page_count   int not null,
  content_hash text not null,                 -- merkle root over page hashes
  created_at   timestamptz not null default now()
);
create index snapshots_user_idx on echo_data.snapshots (user_id, status);

create table echo_data.snapshot_pages (
  snapshot_id bigint not null references echo_data.snapshots(id) on delete cascade,
  page_no     int  not null,
  entity      text not null,                  -- pages are ordered by (entity, record_id)
  first_key   text not null,
  last_key    text not null,
  row_count   int  not null,
  page_hash   text not null,                  -- sha256 over canonical page payload
  payload     jsonb not null,                 -- array of {record_id, version, record|null}
  primary key (snapshot_id, page_no)
);

-- ─────────────── conflict archive (nothing silently lost) ────────────────
-- PATCH1 §5.3.4: the SIX-value reason constraint in the initial DDL.
create table echo_data.conflict_archive (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  entity         text not null,
  record_id      text not null,
  reason         text not null check (reason in
                 ('edit_edit','delete_vs_upsert','delete_vs_edit',
                  'applied_delete','stale_base_unknown_record','schema')),
  base_version   bigint,                       -- client's claimed base
  server_version bigint,                       -- server's actual version (null if absent)
  client_payload jsonb not null,               -- the losing/deferred op (or superseded record), verbatim
  client_device  uuid,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,                  -- null = pending; set by restore/discard
  resolution     text check (resolution in ('restored','discarded','expired'))
);
create index conflict_user_idx on echo_data.conflict_archive (user_id, created_at desc);
create index conflict_unresolved_idx on echo_data.conflict_archive (user_id)
  where resolved_at is null;

-- ─────────────── recovery backups (keep-local / restore undo) ────────────
create table echo_data.recovery_backups (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('keep_local','server_reset')),
  payload     jsonb not null,                 -- full pre-destruction server state
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null            -- created_at + 14 days
);

-- ─────────────── per-user sync state: watermark + serverBootId ───────────
-- PATCH1 §4.3.6: the persisted watermark row compaction advances monotonically;
-- v1.1 §9.3: serverBootId rotates on /sync/reset and forces re-bootstrap.
create table echo_data.sync_state (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  watermark      bigint not null default 1,    -- never below 1 (v1.1 §11.2 floor)
  server_boot_id uuid not null default gen_random_uuid(),
  updated_at     timestamptz not null default now()
);

-- ═══════════════════════════ RLS: enable everywhere ══════════════════════
alter table echo_data.profiles        enable row level security;
alter table echo_data.devices         enable row level security;
alter table echo_data.media_items     enable row level security;
alter table echo_data.entries         enable row level security;
alter table echo_data.feedback        enable row level security;
alter table echo_data.works           enable row level security;
alter table echo_data.work_links      enable row level security;
alter table echo_data.user_settings   enable row level security;
alter table echo_data.change_log      enable row level security;
alter table echo_data.push_ops        enable row level security;
alter table echo_data.snapshots       enable row level security;
alter table echo_data.snapshot_pages  enable row level security;
alter table echo_data.conflict_archive enable row level security;
alter table echo_data.recovery_backups enable row level security;
alter table echo_data.sync_state      enable row level security;

-- ═══════════════ per-command policies for `authenticated` ════════════════
-- (v1.2 §3.3.3: under SECURITY INVOKER the policy set must cover the write
-- commands too — this is what makes "RLS is the enforcement layer" true.)

-- profiles: ownership column is `id` (v1.1 §5.4 correction).
create policy profiles_select on echo_data.profiles
  for select to authenticated using ( (select auth.uid()) = id );
create policy profiles_insert on echo_data.profiles
  for insert to authenticated with check ( (select auth.uid()) = id );
create policy profiles_update on echo_data.profiles
  for update to authenticated
  using ( (select auth.uid()) = id ) with check ( (select auth.uid()) = id );

-- devices: reads, registration (insert) and the REQUIRED own-device UPDATE
-- policy — sync_pull / sync_bootstrap_ack / sync_device_revoke / rename are
-- SECURITY INVOKER and therefore update the requesting device's row as the
-- caller; without this FOR UPDATE policy those writes are impossible.
-- (B0 known-gap #1 from the master brief — resolved here, tested by X-7/T-2.10.)
create policy devices_select on echo_data.devices
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy devices_insert on echo_data.devices
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy devices_update on echo_data.devices
  for update to authenticated
  using ( (select auth.uid()) = user_id )
  with check ( (select auth.uid()) = user_id );

-- library entities: full CRUD for the owner (the invoker RPCs write these).
create policy media_select on echo_data.media_items
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy media_insert on echo_data.media_items
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy media_update on echo_data.media_items
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );
create policy media_delete on echo_data.media_items
  for delete to authenticated using ( (select auth.uid()) = user_id );

create policy entries_select on echo_data.entries
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy entries_insert on echo_data.entries
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy entries_update on echo_data.entries
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );
create policy entries_delete on echo_data.entries
  for delete to authenticated using ( (select auth.uid()) = user_id );

create policy feedback_select on echo_data.feedback
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy feedback_insert on echo_data.feedback
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy feedback_update on echo_data.feedback
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );
create policy feedback_delete on echo_data.feedback
  for delete to authenticated using ( (select auth.uid()) = user_id );

create policy works_select on echo_data.works
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy works_insert on echo_data.works
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy works_update on echo_data.works
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );
create policy works_delete on echo_data.works
  for delete to authenticated using ( (select auth.uid()) = user_id );

create policy work_links_select on echo_data.work_links
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy work_links_insert on echo_data.work_links
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy work_links_update on echo_data.work_links
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );
create policy work_links_delete on echo_data.work_links
  for delete to authenticated using ( (select auth.uid()) = user_id );

create policy user_settings_select on echo_data.user_settings
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy user_settings_insert on echo_data.user_settings
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy user_settings_update on echo_data.user_settings
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );
create policy user_settings_delete on echo_data.user_settings
  for delete to authenticated using ( (select auth.uid()) = user_id );

-- change_log: owner may read (pull/debug) and INSERT (the invoker push path
-- writes journal rows); no update/delete policies — compaction is exclusively
-- the S-2 job (echo_jobs_admin), never the caller.
create policy change_log_select on echo_data.change_log
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy change_log_insert on echo_data.change_log
  for insert to authenticated with check ( (select auth.uid()) = user_id );

-- push_ops: owner read + insert (opid dedupe ledger).
create policy push_ops_select on echo_data.push_ops
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy push_ops_insert on echo_data.push_ops
  for insert to authenticated with check ( (select auth.uid()) = user_id );

-- snapshots: owner read + insert (snapshot creation runs as the owner).
create policy snapshots_select on echo_data.snapshots
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy snapshots_insert on echo_data.snapshots
  for insert to authenticated with check ( (select auth.uid()) = user_id );

-- snapshot_pages: owner-only via the parent snapshot.
create policy snapshot_pages_select on echo_data.snapshot_pages
  for select to authenticated
  using ( exists (select 1 from echo_data.snapshots s
                  where s.id = snapshot_id
                    and s.user_id = (select auth.uid())) );
create policy snapshot_pages_insert on echo_data.snapshot_pages
  for insert to authenticated
  with check ( exists (select 1 from echo_data.snapshots s
                       where s.id = snapshot_id
                         and s.user_id = (select auth.uid())) );

-- conflict_archive: owner read/insert (push writes archive rows in the same
-- transaction) and UPDATE — sync_conflict_resolve marks rows resolved.
create policy conflicts_select on echo_data.conflict_archive
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy conflicts_insert on echo_data.conflict_archive
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy conflicts_update on echo_data.conflict_archive
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );

-- recovery_backups: owner read + insert (keep_local/restore write them).
create policy recovery_select on echo_data.recovery_backups
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy recovery_insert on echo_data.recovery_backups
  for insert to authenticated with check ( (select auth.uid()) = user_id );

-- sync_state: owner read + insert + update (sync_reset rotates serverBootId;
-- the watermark itself is advanced only by the S-2 job, which has its own
-- policy below in migration 0005).
create policy sync_state_select on echo_data.sync_state
  for select to authenticated using ( (select auth.uid()) = user_id );
create policy sync_state_insert on echo_data.sync_state
  for insert to authenticated with check ( (select auth.uid()) = user_id );
create policy sync_state_update on echo_data.sync_state
  for update to authenticated
  using ( (select auth.uid()) = user_id ) with check ( (select auth.uid()) = user_id );

-- ═══════════════════ grants for `authenticated` ══════════════════════════
-- Safe precisely because `echo_data` is NOT in the project's exposed API
-- schemas (v1.2 §3.3.1): PostgREST cannot address it, API roles cannot open
-- direct SQL connections on the hosted platform, and RLS remains the
-- row-level barrier for every RPC-driven write.
grant usage on schema echo_data to authenticated;
grant select, insert, update, delete on all tables in schema echo_data
  to authenticated;
alter default privileges in schema echo_data
  grant select, insert, update, delete on tables to authenticated;
