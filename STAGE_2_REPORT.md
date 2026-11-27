# ECHO — Stage 2 Report (Quality debts + real-user validation preparation)

**Date:** 2026-11-27
**Branch:** `echo/autonomous-execution` (local; GitHub intentionally disconnected — no remote writes this stage)
**Governing documents:** Autonomous Execution Master Brief (2026-11-27) §5; Transformation Master Plan v1.3 PATCH1 §9/§12.2 (A2/A3/A4)
**Version:** 1.2.0

---

## 1. What was completed

### A2 — quality & UX debts: **all 8 audited defects closed** (audit-and-fix, no scope creep)

| # | Defect (audit id) | Fix | Files |
|---|---|---|---|
| 1 | Sticky toasts, limit 1 (D9) | 5 s auto-dismiss armed on add; limit 3; per-toast `duration` override; testable `subscribe()` | `hooks/use-toast.ts` |
| 2 | Rating not clearable in drawer (D10) | explicit clear control beside the stars | `components/echo/DetailsDrawer.tsx` |
| 3 | No way back into the sample map (D11) | Settings "Revisit the sample map" (isolated demo stores; real library untouched) | `components/echo/screens/SettingsScreen.tsx` |
| 4 | No backup reminder (H1) | device-local quarterly nudge: <5 titles silent; ≥20 titles if never exported; ≥90 days since last export; snoozable; export resets | `lib/echo/backupNudge.ts` + Settings |
| 5 | TVMaze fuzzy noise (H2) | post-filter: normalized title must contain every query token; untitled rows dropped | `lib/echo/providers/tvmaze.ts` |
| 6 | Q-id titles leak into results (H3/C7) | localized fallback label "Wikidata record — no title yet" + year, EN/AR | `lib/echo/ids.ts` + `AddTitleDialog.tsx` |
| 7 | Search pagination (C4 "long tails unreachable") | `SearchFilters.page` threaded through engine/routers; native cursors: AniList GraphQL `Page(page:)`, Open Library `&page`, RAWG `&page`, Wikidata `continue`, Trakt `&page` via proxy, IGDB Apicalypse `offset`; honest `canLoadMore` (only a natively-paginated provider filling its page); "Show more" UI with accumulated localId-deduped results | `federated/*`, 6 adapters, 2 proxy routes, `AddTitleDialog.tsx` |
| 8 | Arabic-first search aid (C3) | `lib/echo/searchAid.ts`: transliteration (letter-map heuristic, diacritics stripped) + bilingual chips from the curated catalogue; offered only when an Arabic query found <3 live results; one-tap Latin re-search; plus Arabic-aware folding in the shared `normalizeTitle` (harakat/tatweel/alef variants/taa marbuta/alef maqsura) | `lib/echo/searchAid.ts`, `federated/dedupe.ts`, `AddTitleDialog.tsx` |

Arabic/English parity: every new UI string exists in both dictionaries (enforced by the i18n parity gate).

### §5.4 — free operational basics

- **`/api/health`**: status/version/uptime + which optional integrations are configured (**booleans only** — tested that key material never appears) + the provider license-gate view (honours user toggles).
- **`/status`**: built-in bilingual (RTL-aware) status page rendering `/api/health`. $0, no third-party script — external uptime probing stays the owner's later choice.
- **CSP from the registry**: per-provider `apiHosts` added to the registry; `contentSecurityPolicy()` generates `default-src 'self'` + connect-src allowlist (proxied providers contribute nothing); applied as a production header in `next.config.ts`. Production-only so dev HMR is unaffected.

### A3 — real-user validation package: **prepared, NOT run**

- Full bilingual kit at `docs/validation/A3_USER_TEST_KIT/` (9 files): invitation, participant instructions, privacy notice + consent, 9-task facilitator script — including the **pre-registered progress-attempt task** (verbatim, non-leading) and the **AniList local-only badge task** (D-20 evidence) — structured feedback form with the feature-priority question, one-week retention pulse, observation sheet, results template with the honesty checklist, and the frozen A4 gate criteria.
- The AniList local-only badge itself is implemented in Settings (`cloudSyncPolicy: none` providers show "stays on this device", EN/AR).
- **A3 status: awaiting real cohort results.** The owner must recruit 6–10 participants (≥3 Arabic-first) and return the completed sheets. Nothing is claimed until then.

### A4 — conditional progress tracking: **DEFERRED (correctly)**

No real A3 evidence exists, so the pre-registered gate (≥40% attempt-with-friction OR top-3 feature) cannot fire. A4 is recorded as **deferred — awaiting evidence** in `A4_GATE.md` (decision record left blank for the real numbers). The additive v4 design stays shelved; zero rework incurred.

## 2. Files changed and why

Code (A2 + §5.4): `hooks/use-toast.ts`, `components/echo/DetailsDrawer.tsx`, `components/echo/screens/SettingsScreen.tsx`, `components/echo/AddTitleDialog.tsx`, `lib/echo/backupNudge.ts` (new), `lib/echo/searchAid.ts` (new), `lib/echo/ids.ts`, `lib/echo/i18n.tsx` (new keys, both dicts), `lib/echo/federated/dedupe.ts`, `lib/echo/federated/engine.ts`, `lib/echo/federated/router.ts`, `lib/echo/federated/types.ts`, `lib/echo/providers/types.ts` (page + paginated), `lib/echo/providers/{anilist,tvmaze,openlibrary,rawg,wikidata,trakt,igdb}.ts`, `app/api/echo/providers/{trakt,igdb}/route.ts`, `app/api/health/route.ts` (new), `app/status/page.tsx` (new), `next.config.ts` (CSP headers).
Tests: new `toast`, `backupNudge`, `tvmaze`, `arabicNormalize`, `pagination`, `searchAid` unit files; extended `routes.test.ts` (health + proxy page-forwarding), `registry.test.ts` (CSP), `search.test.ts`/`federated.test.ts` (fixtures updated to the TVMaze filter contract); e2e: new pagination test (02), Arabic-aid test (04), status-page test (01).
Docs: `docs/validation/A3_USER_TEST_KIT/*` (new), `CHANGELOG.md` (1.2.0), `EXECUTION_STATUS.md`, this report.
**Protected surfaces untouched**: taste engine, IndexedDB schema/migrations, export formats (v1–v3 round-trip tests green), fonts/RTL routing, service worker/PWA, provider adapters beyond the specified fixes, local AniList behavior, Vercel legacy deployment.

## 3. Tests actually run (this session)

| Command | Result |
|---|---|
| `bun run lint` | PASS — 0 errors |
| `bun run typecheck` | PASS |
| `bun run test` | **396 pass / 0 fail / 0 skipped** (8,904 assertions, 24 files) — was 333 at Stage 1 |
| `bun run secret-scan` + `:self-test` | PASS |
| `bun run version-check` | PASS — 1.2.0 consistent |
| `bun run cost-table:check` | PASS |
| `bun run build:standalone` | PASS |
| `bun run test:e2e` | **28 passed / 0 failed / 0 skipped** (chromium, against the standalone production build with the new CSP header active) |

Final full-suite logs: `scripts/verify-logs-stage2/`. No assertion was weakened; the five TVMaze-fixture updates in pre-existing tests were required by the *new, stricter* provider contract (fuzzy noise is now filtered) and preserve each test's original intent.

## 4. Build / deployment state

| Layer | State |
|---|---|
| Local dev | functional |
| Local production build (standalone) | green; e2e runs against it **with the CSP header** |
| Vercel | **legacy snapshot — untouched, not deployed** |
| Cloudflare staging/production | not attempted (owner-held; unchanged from Stage 1 PoC status) |

**CSP honesty note:** the connect-src allowlist is unit-verified against the registry, and the app (scripts/styles/fonts/shell) runs under the full CSP in the production-build e2e. Provider fetches in e2e are network-mocked, so the *live* allowlist behaviour is verified at the registry level and remains to be re-verified on a real deployment (as the plan requires for the production domain anyway).

## 5. Data / security / licensing status

- No secrets added; `.env.example` unchanged (placeholders only); health endpoint leaks booleans only (tested).
- Registry: `apiHosts` added as declarative per-provider data; no license posture changed; AniList remains `cloudSyncPolicy: none` with the new explicit UI notice.
- The backup nudge stores a device-local localStorage record — never in IndexedDB, never in any future sync payload.
- No new dependency; no paid service; $0 maintained.

## 6. Outstanding blockers

| Blocker | Needs owner? |
|---|---|
| A3 cohort recruitment + real results (the only Stage-2 remainder) | **Yes** — kit is ready to hand over |
| Stage 3 checkpoints (Supabase project, Google OAuth config) | Yes (later, per plan sequence) |
| Stage 4 (Cloudflare staging, beta, cutover, GitHub transfer) | Yes (later) |
| Local engineering blockers | **None** |

## 7. Backup / bundle location and verification

- Stage-1 baseline backup re-verified this session (`download/echo-phase1-backup/`: bundle OK at `ccf4786e`, SHA256SUMS all OK).
- **Stage-2 checkpoint backup cut after the final commit:** `download/echo-stage2-backup/` — `echo-stage2-repo.bundle` (full history at the Stage-2 HEAD), source zip, SHA256SUMS, RECOVERY note. Verification results recorded in the final delivery notes of this session's log.

## 8. Next action

Proceed to **Stage 3** (local-first): implement the v1.3 PATCH1 corrected database design as versioned migrations, the sync protocol modules, Google-only OAuth with placeholder configuration, and the X-1…X-11 / T-2/T-3/T-4 / T-5 / W test inventories — using local Postgres/Supabase tooling where the environment supports it, and marking any test NOT RUN with its exact blocker. A3's cohort dependency does not block this (brief §5.5). No owner action is required before Stage 3's own integration checkpoint.
