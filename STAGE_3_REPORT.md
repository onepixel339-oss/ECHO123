> **SUPERSEDED-BY-1.3.0 NOTE (2026-11-28):** this report records the Stage-3
> state at its time (450 unit / 28 e2e / Google-OAuth-based B1). The current
> final tree is 1.3.0: username+password only, no AI, B3 Settings wired —
> **472 unit / 47 DB / 32 e2e** fresh. See EXECUTION_STATUS.md and the
> CHANGELOG 1.3.0 entry. The B1/B2/B0 content below remains accurate as a
> design record.

# ECHO — Stage 3 Report (Supabase foundations, Google-only auth, sync protocol)

**Date:** 2026-11-27
**Branch:** `echo/autonomous-execution` (local; GitHub intentionally disconnected — no remote writes)
**Governing documents:** Autonomous Execution Master Brief §6 (Stage 3); Transformation Master Plan v1.3 PATCH1 (the authoritative corrected design); v1.2 §3.3.1–3.3.6 (retained architecture); v1.1 §5.2/§9–§11 (inherited DDL/protocol contracts)
**Version:** 1.2.0 (unchanged — no release; sync ships dark behind its feature flag)

---

## 1. What was completed

### B0 — database foundations and security: **complete, locally verified**

The complete corrected v1.3 PATCH1 design as **8 versioned migrations** (`supabase/migrations/0000…0007`), applied and tested against a **real local PostgreSQL 19** (embedded binaries via the `embedded-postgres` dev dependency — no Docker required):

| Piece | Where | Notes |
|---|---|---|
| Private `echo_data` schema, 15 tables (profiles, devices, 6 entity tables, change_log, push_ops, snapshots, snapshot_pages, conflict_archive, recovery_backups, sync_state) | `0001_schema.sql` | v1.1 §5.2 DDL, one correction: entity `record` columns are **nullable** — the inherited DDL's `NOT NULL` contradicted its own tombstone form (`deleted_at set, record = null`) |
| **Six-value `conflict_archive.reason` constraint** (PATCH1 §5.3.4) in the initial DDL + the explicit inherited-DB migration | `0001` + `0007` | `delete_vs_edit` and `applied_delete` legal from the first migration; `0007` verified as a no-op on fresh DBs and as the corrective on a v1.1-shaped constraint (T-3.10) |
| Per-command RLS for `authenticated` on every table — **including the required `devices` FOR UPDATE policy** (B0 gate #1) | `0001` | invoker RPCs update the requesting device's row as the caller; without this policy those writes are impossible |
| `SECURITY INVOKER` RPCs, pinned `search_path`, least-privilege EXECUTE grants, `security_invoker` views, default-deny `alter default privileges` | `0002`–`0004`, `0006` | zero definer functions in the user path |
| **`sync_pull`** — the PATCH1 §4.3.3 contract verbatim: shared lock FIRST → watermark validated under the lock → requesting-device validation (uniform `device_not_found` for unknown & foreign; `device_revoked` for own) → page read under the lock → guarded exactly-one-row cursor update of the requesting device only | `0002` | see §3 for the one documented off-by-one correction |
| **`sync_push`** — D-1…D-10 decision table, opid idempotency, per-user exclusive advisory lock, artwork sanitization, AniList hard floor, row caps (5,000 media / 20,000 total), 200-row unresolved soft cap with `conflict_archive_full` backpressure | `0003` | D-2 (applied delete + archived snapshot) is a both-path — classification now carries an explicit apply flag |
| Device lifecycle: register / revoke / rename / list — **advisory-first lock ordering** (B0 gate #3) | `0002` | revoke/rename take the exclusive per-user lock BEFORE touching the devices row |
| **`sync_bootstrap_ack` with deviceId** (O-1 resolved, B0 gate #2): validates existence/ownership/non-revocation, clamped, guarded exactly-one-row | `0004` | shared → row lock order |
| Snapshots (≤500-record pages, sha256 page hashes, Merkle root, building→active, retirement), bootstrap status/manifest/page, status (per-entity hashes + `archiveState`), conflict resolve (restore = pushable op), keep-local (idempotent per intentId, 14-day recovery backup, epoch bump), restore-backup (reversible — archives current state first) | `0004` | |
| **S-2 jobs**: `echo_jobs_admin` (nologin/nobypassrls/noinherit) + `echo_jobs` schema + three `SECURITY DEFINER` jobs — compact (§4.3.6 exclusive-lock protocol, monotonic watermark, tombstone GC), cleanup (§5.3.5 lifecycle: unresolved never deleted; resolved 90-day + 200-row evictable pool; applied_delete 14-day; backup expiry; snapshot retirement), reset (the only sanctioned change_log deletion outside compaction) | `0005` + `0000` | EXECUTE granted only to `service_role`; never `authenticated` |
| **Lock-guard trigger** on change_log (40P01 without the advisory lock) | `0006` | |
| **Ownership/shape assertions** — the PATCH1 §3.3.7 REWRITTEN two-branch policy + the checked-in expected-function inventory (`supabase/expected_function_inventory.psv`, diffed by view `v_sync_function_inventory`) | `0006` | self-consistent by construction (X-9); red-branch proof included |

**O-2 resolved (B0 gate #5):** `sync_push` raises the uniform `device_not_found` for foreign and unknown devices (the v1.1 §6.6 case-3 `device_not_owned` vocabulary is retired) — the push path is no longer a cross-user existence oracle. Verified by X-7/T-2.12.

### B2 — snapshot/bootstrap/synchronization client: **complete (local legs)**

`lib/echo/sync/` (7 modules): protocol types (incl. the six-reason TS enum, parity-tested); **policy** (the `cloudSyncPolicy` table with **anilist = none**, field-level classifier, AniList leak-path strips for externalIds/provenance/works); opid (deterministic `boot-<deviceId>-<intentId>-<n>`); **outbox v4** (per-op-ack preservation, INV-14 collapse with earliest-base + never-drop-deletes, ≤200-op/≤2MB batches, quarantine export); **transport** (PATCH1 §10.2.6 classifier: contract / app-429 / platform failure with `platform_quota_exceeded` sub-classification; Retry-After-independent backoff ladder; quota-class ≥30 min bounded by next midnight UTC); **bootstrap** (the corrected five-quadrant seeding table: unbased divergent records seed `base_version = 0` → guaranteed D-3, never a silent overwrite; genuine baselines preserved; choice-before-mutation state machine); **SyncClient** (single-flight drainer, paginated pull with echo suppression, degraded/must-rebootstrap states, device re-registration without ever discarding the outbox).

### B1 — authentication: **complete (placeholder configuration)**

`lib/echo/sync/auth.ts` + `@supabase/supabase-js` (new dependency, client SDK only): **Google OAuth only** (PKCE, the SDK default), anonymous bridge (F1, full-user semantics), manual identity linking, sign-out, session semantics; **no GitHub OAuth, no email/password, no magic links, no SMTP** — enforced by the module's surface (`PERMANENT_PROVIDERS = ["google"]`). Config is placeholders-only (`.env.example`); `readSupabaseConfig()` returns null without env → every route answers **503 `sync_not_configured`** and the app remains fully local.

### Server routes (13): `/api/sync/{push,pull,status,bootstrap/{status,manifest,page,ack},devices,conflicts,conflicts/resolve,keep-local,restore-backup,reset}`

zod-validated before any RPC invocation (a missing/malformed `deviceId` is rejected 400 before a device row can be touched — the PATCH1 route-validation row); per-request caller-bound clients (RLS applies); the PATCH1 error mapping (`device_not_found`→404 uniform, `device_revoked`→403, `cursor_expired`/`epoch_mismatch`→409 + `mustRebootstrap`, `conflict_archive_full`→429); `/api/sync/reset` runs the S-2 job with the caller's **verified JWT uid only** and requires the dashboard-entered service-role key (never in code).

### AniList isolation (B0/B2 hard invariant)

Three independent layers, each tested: (1) client classifier — AniList media records and entries attached to them never enter the outbox (T-5.1 client, T-5.2(e)); (2) route zod + RPC hard floor — `provider_policy` rejection with zero server rows (T-5.1 DB); (3) server artifacts asserted clean for a mixed library (T-5.2(d)). `cloudSyncPolicy = none` is preserved on **every** server-bound path, including seeding, snapshots, and the conflict archive.

## 2. Files changed and why

- **New:** `supabase/migrations/0000…0007` (8 files), `supabase/expected_function_inventory.psv`, `supabase/local/` (harness: `run.ts`, `util.ts`, `fixtures/local_env.sql`, 5 suite files), `lib/echo/sync/` (7 modules), `lib/echo/__tests__/sync/` (4 test files), `app/api/sync/**` (13 routes), `lib/echo/server/sync.ts`.
- **Modified:** `lib/echo/localdb.ts` (DB_VERSION 4 — additive `outbox`/`syncMeta`/`quarantine` stores; `clearAllLocalData` now explicitly never touches the sync stores), `lib/echo/__tests__/migration.test.ts` (v4 upgrade expectations), `package.json` (`test:syncdb` script; deps: `@supabase/supabase-js`, dev: `embedded-postgres`, `pg`, `@types/pg`), `tsconfig.json` (exclude the bun-run DB harness from the app typecheck), `.env.example` (Supabase placeholders), `EXECUTION_STATUS.md`.
- **Protected surfaces untouched:** taste engine, provider registry, export formats (v1–v3 round-trip tests green), i18n/RTL/fonts, service worker/PWA, provider adapters, local AniList behavior, Vercel legacy deployment. The IndexedDB change is the documented additive v4 (doc 04 §6) with its upgrade test extended, not a rewrite.

## 3. Tests actually run (fresh, this session)

| Suite | Command | Result |
|---|---|---|
| Security (X-1…X-11) | `bun run supabase/local/run.ts` | **11/11 pass** (incl. the X-9 red-branch proof: a definer flip raises; X-10 execution-identity proof; X-5 inventory diff exact) |
| Sequencing (T-2.1…T-2.14) | same | **13/13 pass** (incl. the T-2.7 randomized harness: 1,000 scheduled push/pull/ack/compaction steps across 3 virtual devices — zero skipped committed changes, zero spurious 409s; T-2.8 pull/compaction race with verified lock blocking; T-2.10…T-2.14 device-isolation suite) |
| Conflicts (T-3.1…T-3.14) | same | **14/14 pass** (table-driven D-1…D-10; lifecycle survival matrix; reason-code migration; backpressure at 160/200; atomicity) |
| Bootstrap (T-4.x) | same | **7/7 pass** (five-quadrant classification; unbased-collision end-to-end with crash-retry idempotence; keep-local idempotency; 3-device convergence; ack deviceId validation; restore-backup reversibility) |
| Licensing DB legs (T-5.1, T-5.2d) | same | **2/2 pass** |
| Unit/domain incl. sync client | `bun run test` | **443 pass / 0 fail / 0 skipped** (9,031 assertions, 28 files) — was 396 at Stage 2 |
| Platform-outage + client legs (W-1…W-6, T-4/T-5 client, route contracts, IDB v4) | included above | all pass |
| lint / typecheck | `bun run lint` / `bun run typecheck` | PASS / PASS (0 errors) |
| secret-scan (+ self-test) | `bun run secret-scan` | PASS — no credentials in tree |
| version-check / cost-table | — | PASS (1.2.0 consistent; table matches generator) |
| Production build | `bun run build:standalone` | PASS (13 sync routes compiled) |
| E2E | `bun run test:e2e` | **28 passed / 0 failed** (chromium, 1.9 m, against the standalone production build) |

**Honest NOT-RUN list (with exact blockers):**
- **X-2 hosted leg** (`/rest/v1/change_log` → 404): requires a hosted Supabase project with PostgREST — the local environment asserts the equivalent preconditions (no `anon` USAGE on `echo_data`/`echo_jobs`; `public` contains no tables). Verified at the human checkpoint.
- **X-11 hosted/CI legs**: the migration chain + assertions ran under the local embedded PostgreSQL (PG 19) as the migration role; hosted Supabase and the CI container re-verify (the CI workflow gains a `postgres:19` service — file prepared, GitHub disconnected).
- **B1 live flows** (actual Google sign-in round-trip, anonymous→Google linking against real GoTrue): require the hosted project + the owner's Google OAuth client. The code paths are typechecked, built, and contract-tested at the 503 boundary; nothing is claimed until the checkpoint runs them.
- **T-4.1 network-level choice-before-mutation e2e**: the client-side contract is unit-tested (intent persisted before mutation; seeding only after choice); the full UI flow test rides the Stage-4 UI work.

## 4. Build / deployment state

| Layer | State |
|---|---|
| Local dev | functional |
| Local production build | green; e2e against it |
| Sync routes | compiled, 503-not-configured without env (tested) |
| Hosted Supabase | **not created — owner checkpoint** |
| Cloudflare | unchanged from Stage-1 PoC status |
| Vercel | legacy snapshot — untouched |

## 5. Design deviations (documented, all test-covered)

1. **Watermark off-by-one correction (sync_pull).** The literal PATCH1 snippet tests `p_since < v_wm`; W is the *oldest seq guaranteed present* and compaction deletes `seq < W`, so a delta from cursor C is complete iff `C+1 ≥ W`. The literal test is one row *more* conservative and makes the empty-account bootstrap delta (`since = head = 0 < W = 1`) impossible — a 409 loop. This implementation tests `p_since + 1 < v_wm` (mathematically complete; never a partial page — the invariant verbatim). T-2.8(b)/T-2.9/T-2.11 pin it.
2. **`sync_push` opid ledger timing.** The ledger row is written only when an op is actually processed (applied or archived); a rejected op (schema / provider_policy / conflict_archive_full) leaves no ledger row so the client's retry re-processes it. Found by T-3.13 (the backpressure drain test) — race-free under the exclusive per-user lock.
3. **`push` epoch validation is request-carried** (optional `p_epoch` from the client's observed epoch) rather than device-row-based: a device-row check would reject the merge-seeding pushes that legitimately precede the bootstrap ack. Stale clients get `epoch_mismatch` (409 + mustRebootstrap).
4. **Entity `record` columns nullable** (see §1) — the inherited DDL's NOT NULL contradicted its own tombstone form.
5. **Snapshot creation runs under the shared advisory lock at READ COMMITTED** (the §4.3.3 isolation model — per-user quiescence comes from the lock, not the isolation level); the route may additionally wrap it in REPEATABLE READ as belt-and-braces.
6. **`sync_reset` executes as the S-2 job** (`echo_jobs.sync_job_reset`) rather than an invoker RPC: change_log has deliberately no DELETE policy for `authenticated` ("even the RPC never deletes log rows"), and the reset is the documented owner-scoped panic button.

## 6. Data / security / licensing status

- No secrets anywhere; `.env.example` placeholders only; service-role key explicitly dashboard-only. Secret-scan green.
- AniList `cloudSyncPolicy = none` enforced at three tested layers (client classifier / route+RPC floor / artifact assertions); `pointer` assigned to no provider (T-5.6 design-level pin).
- Cross-user matrix green (X-7 cases 1–10 + X-8): ownership from `auth.uid()` only; foreign/unknown devices indistinguishable; revoked devices rejected with zero writes; account deletion cascade leaves zero rows.
- Artwork never stored (no columns + sanitize strip + test); synopses not synced by default.
- $0 posture maintained: no paid service, no SMTP, AI untouched and off by default.

## 7. Outstanding blockers

| Blocker | Needs owner? |
|---|---|
| Hosted Supabase project + migration application + X-2/X-11 hosted legs + B1 live flows | **Yes** (handoff) |
| Google OAuth client creation + callback config | **Yes** (handoff) |
| A3 cohort (Stage-2 remainder; does NOT block Stage 4 local work) | Yes |
| Cloudflare staging deployment (Stage 4) | Yes (handoff) |
| Local engineering blockers | **None** |

## 8. Backup / bundle

- Stage-1 and Stage-2 backups re-verified this session (SHA256SUMS OK; bundles OK).
- **Stage-3 checkpoint backup cut after the Stage-3 commits:** `download/echo-stage3-backup/` (repo bundle at the Stage-3 HEAD + source archives + SHA256SUMS + recovery note) — see EXECUTION_STATUS.md.

## 9. Next action

Stage 4 local work (B3 client legs, runbooks, Cloudflare staging preparation, AR/EN documentation, release-candidate preparation), then the consolidated **ECHO_HUMAN_HANDOFF** package (brief §9.3). No owner action is required before the handoff.
