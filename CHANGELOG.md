# Changelog

All notable changes to ECHO are documented here. The version scheme is
semantic: MAJOR for breaking user-data or product-contract changes, MINOR for
feature/stabilization releases, PATCH for fixes. User-data compatibility
(export bundles v1–v3, IndexedDB migrations) is never broken by a release.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1/).

## [1.3.0] — 2026-11-28 — "Final scope: username + password, no AI, Settings sync wiring"

The owner's final-delivery decisions (27 Nov 2026 brief), implemented end
to end: Google OAuth removed, generative AI removed, the B3 Settings sync
surface completed, and the GitHub handoff package prepared. Local-only use
stays fully functional with no account and no cloud configuration; user-data
compatibility (export bundles v1–v3, IndexedDB) is unchanged.

### Changed

- **Accounts are username + password ONLY** (owner decision). The
  registration form asks for exactly username, password, and confirmation;
  sign-in asks for username and password. No email address, phone number,
  Google, GitHub, social sign-in, magic link, or SMTP exists anywhere in
  the product. There is **no password recovery**: before signup the UI
  shows the bilingual irreversible-loss warning and requires an explicit
  acknowledgement checkbox. Passwords are handled exclusively by Supabase
  Auth (never in ECHO tables, IndexedDB, logs, or exports). Password
  changes require the current password (session re-authentication).
- **Username → Supabase Auth adapter**: Supabase's password identity is
  email/phone-bound, so ECHO derives a deterministic, opaque internal alias
  under the RFC 2606 reserved `.invalid` domain (SHA-256 of the canonical
  username). Canonicalization is NFC + case-fold (usernames are
  case-insensitive, one account per name); the policy is 3–32 chars of
  `a-z0-9_` with a reserved-name list; sign-in failures are always generic
  (no user enumeration). The alias is an internal implementation detail —
  never displayed, never a verified email. Verified against a faithful
  local GoTrue-compatible server driving the real supabase-js client;
  hosted-GoTrue verification is the documented owner checkpoint.
- **Generative AI removed** (owner decision): Gemini SDK usage, the three
  AI routes (`ask`/`companion`/`weekly`), the LLM provider chain, model
  configuration, `GEMINI_*` environment variables, and every user-facing
  AI claim are deleted. "Ask ECHO", the Taste Companion, and the weekly
  digest no longer exist; nothing replaces them with canned responses
  pretending to be AI. The deterministic local taste engine (Taste DNA,
  insights, the identity card) remains, honestly labelled. `z-ai-web-dev-sdk`
  is dropped from the dependencies.
- **B3 Settings wiring completed**: the Account & sync section (rendered
  only when cloud sync is configured), the bootstrap choice UI
  (merge / keep-local / replace-local, choice-before-mutation), the device
  manager (current-device indication, rename, revoke, revoked states), the
  conflict archive (unresolved/near-full/paused banners, details,
  keep-my-version / keep-the-other-version, resolved history), and honest
  sync status for every protocol state — bilingual EN/AR with logical CSS
  (RTL mirrors automatically) and keyboard-accessible dialogs.

### Added

- **Sync engine** (`lib/echo/sync/engine.ts`): the runtime connecting auth,
  the SyncClient, the outbox, and the store — local writes always land
  first; mutations are policy-classified (AniList-derived records never
  leave the device) and enqueued; pulled changes apply without re-emitting
  (no echo loop); per-record observed versions feed `baseVersion`; the
  anonymous→permanent conversion preserves the user id; "clear all data"
  quarantines the outbox and resets device state without touching cloud
  data. 9 engine tests + 32 auth tests lock the behavior.
- **Local GoTrue-compatible test server**: exercises the real supabase-js
  client end-to-end against the exact REST shapes (autoconfirm signup,
  422 duplicates, generic 400 `invalid_grant`, anonymous signup, in-place
  conversion), asserting that no recovery/OTP/magic-link endpoint is ever
  called.

### Removed

- Google OAuth (client, docs, handoff instructions); the Vercel deployment
  path from active planning (Cloudflare is the hosting target); the AI
  cost-model tables (the cost table now asserts no retired service can
  reappear in any tier).

## [1.2.0] — 2026-11-27 — "Phase 2: quality debts closed, validation prepared"

Track A stage A2 (quality & UX debts) + the A3 real-user validation kit + the
free operational basics, per the Autonomous Execution Master Brief (27 Nov
2026). Every fix is targeted at an audited defect; every fix carries
regression tests (388 unit tests, 28 e2e). No protected surface was
rewritten; no paid service was added.

### Fixed

- **Sticky toasts (audit D9).** Toasts now auto-dismiss after 5 s and up to
  3 stack at once (was: limit 1, removal armed only on dismiss with a
  ~16.7-minute delay). Per-toast `duration` overrides are supported
  (`Infinity` keeps a toast until dismissed).
- **Ratings could not be cleared (audit D10).** The details drawer has an
  explicit clear-rating control; taste data no longer sticks forever after a
  hasty tap.
- **No way back into the sample map (audit D11).** Settings gains a
  "Revisit the sample map" entry — the demo universe stays isolated, the
  real library is never touched.
- **No backup reminder (audit H1).** A device-local, quarterly backup nudge
  in Settings: silent under 5 titles, snoozable, reset by a successful
  export. Never synced — it is a fact about the device, not the user.
- **TVMaze fuzzy noise (audit H2).** TVMaze search results are
  post-filtered: only hits whose normalized title contains every query
  token survive (untitled rows are dropped too).
- **Raw Wikidata Q-ids leaked into search results (audit H3/C7).** Rows
  without a real title now render the localized fallback label ("Wikidata
  record — no title yet") plus the year.
- **Arabic title folding.** The shared title normalizer strips harakat and
  tatweel and unifies alef/taa-marbuta/alef-maqsura variants, so Arabic
  queries match Arabic titles regardless of orthography.

### Added

- **Search pagination (audit C4: "long tails unreachable").** Providers with
  native upstream paging (AniList, Open Library, RAWG, Wikidata `continue`,
  Trakt & IGDB via their proxies) honour a page parameter; the Add dialog
  offers an honest "Show more" (only when a paginated provider filled its
  page) and accumulates deduplicated results across pages.
- **Arabic-first search aid (audit C3).** When an Arabic-script query finds
  few live results, ECHO offers explicit Latin-script re-searches: a
  transliteration chip plus bilingual chips from the curated catalogue.
  One tap re-runs the search — the user stays in control.
- **`/api/health` + the built-in `/status` page (§5.4).** Booleans-only
  health (version, uptime, which optional integrations are configured, the
  provider license gate) rendered bilingually; no third-party service, $0.
- **Content-Security-Policy from the provider registry.** The connect-src
  allowlist is generated from the registry's per-provider `apiHosts`
  (proxied providers contribute nothing — their traffic is same-origin) and
  applied as a production header.
- **AniList local-only badge (A3/D-20).** Providers with
  `cloudSyncPolicy: none` show an explicit "stays on this device" notice in
  Settings — in Arabic and English.
- **A3 real-user validation kit** (`docs/validation/A3_USER_TEST_KIT/`):
  bilingual invitation, instructions, privacy notice, 9-task script
  (including the pre-registered progress-attempt task and the AniList badge
  task), structured feedback form with the feature-priority question,
  one-week retention pulse, observation sheet, results template, and the
  frozen A4 gate criteria. **A3 awaits real cohort results — nothing is
  claimed until the owner returns them.**

### Deferred

- **A4 (progress tracking)** stays deferred pending real A3 evidence; the
  pre-registered gate (≥40% attempt-with-friction OR top-3 feature) is
  frozen in `A4_GATE.md`.

## [1.1.0] — 2026-11-25 — "Phase 1: stabilize, test, prove"

Track A stage A0 (truth & configuration) + A1 (test spine) + the isolated
Cloudflare Workers proof of concept (P0), per the ECHO Transformation Master
Plan Revision 1.3 PATCH1. No product behavior was rewritten; every change is
targeted, with regression tests.

### Fixed

- **AniList anime results vanished from "All" searches (found by the A1 e2e
  suite).** The federated router splits AniList into an anime job and a manga
  job when a search covers both categories, but the engine identified jobs
  by `registryId:providerId` — both AniList jobs computed the same key, so
  the manga job's state and results silently overwrote the anime job's.
  Every "All"-tab search (the default in the Add dialog and onboarding)
  showed zero live anime results. Jobs now carry an explicit key when one
  provider serves multiple paths. Regression test: the anime+manga split
  keeps both provider states and both result sets.
- **RAWG provenance stamping (audit G4).** RAWG records now carry the uniform
  v2 catalog fields (`workId`, `externalIds.rawg`, field-level `provenance`,
  `providerRef`) like every other adapter — previously they were missing,
  degrading dedupe/auto-linking to weaker title/year evidence. Regression
  tests: search, `getTitle` and the Discover pools all assert the stamps.
- **NF-1 export round-trip field loss.** The import schema silently dropped
  the `madb`, `trakt`, `igdb`, `inventaire` and `bnf` external-id namespaces
  (zod default key-stripping) and the v3 settings `contentVisibility` and
  `providerToggles`. All are now part of the validated schema; the export
  actually ships the two settings fields; and **replace-mode imports restore
  the backed-up settings** (merge mode still never touches settings, per its
  contract). Backwards compatible: v1/v2/v3 bundles without the new fields
  import unchanged. Round-trip regression tests pin every namespace.
- **Documentation truth (A0).** DEPLOY-AR.md claimed the AI features fall
  back to "free Pollinations" without a Gemini key — false. The code's
  platform-SDK fallback only has credentials inside its originating sandbox;
  everywhere else the features return their designed `ai_unavailable` state.
  Fixed in DEPLOY-AR.md, README.md and `.env.example`; the corrected AI
  posture (D-24: off by default; D-29: BYO-key disclosure draft) is
  documented in `docs/AI_POSTURE.md`. A stale provider-chain comment in
  `app/api/echo/ai/ask/route.ts` (claimed platform-first; the code is
  Gemini-first) was corrected.

### Changed

- **Provider registry: `cloudSyncPolicy` field added** (Revision 1.3 §7.3.1).
  Four-level per-provider cloud-sync posture: `full` (wikidata, trakt, bnf,
  echo-demo), `reference` (rawg, igdb, openlib, tvmaze, imdb, cinemeta, madb,
  inventaire), `none` (**anilist** — local-only until written terms
  clarification, per Revision 1.3; kitsu — hard-disabled). `pointer` is
  reserved for no provider (the documented post-clarification candidate).
  Declarative until Track B exists (no `supabase/` directory today); the
  registry is the single source of truth the future sync classifier reads.
  AniList's local functionality is unchanged.
- **RAWG commercial-use flag updated** from `unverified` to `permitted`
  (free under 100K monthly active users with attribution — verified
  2026-11-25, rawg.io/apidocs), with the verification date recorded in the
  registry.
- **Version references unified** at 1.1.0 (package.json, Settings about line)
  with this changelog as the ledger; `scripts/version-check.ts` enforces
  agreement in CI.

### Added

- **CI pipeline** (`.github/workflows/ci.yml`): lint, `tsc --noEmit`,
  domain tests, production build, secret scanning and the version check —
  every gate that exists locally now runs on every push/PR.
- **Test spine (A1):** Playwright end-to-end coverage of the six core flows
  with mocked providers (onboarding→sample map→exit demo; federated
  search→rate→map updates; details drawer; language→AR/RTL; export→clear→
  import round-trip; offline library + local search); API-route tests
  (rate limits, validation, graceful AI-unavailable, provider proxies);
  EN↔AR i18n parity gate; service-worker offline behaviour tests; and
  performance baselines (`scripts/perf-baseline.ts`).
- **Cost-table generator (T-6.1):** `scripts/cost-table.ts` renders the
  four-tier cost model (T1/T2 zero-cost, T3 future commercial, T4 upgrade
  triggers) from the plan's verified numbers — the doc table and the script
  can no longer drift apart silently.
- **AniList clarification letter (L-3)** prepared at
  `docs/letters/ANILIST_CLARIFICATION_LETTER.md` (four questions, EN) —
  **prepared, NOT sent**; sending requires explicit owner approval.
- **Cloudflare Workers PoC report** (`docs/workers-poc/POC_REPORT.md`):
  the isolated compatibility assessment (P-1…P-8) with measurements and the
  migration recommendation for decision D-28.

### Verified

- `gemini-3.5-flash-lite` deprecation check (2026-11-25, official
  deprecations page): **not deprecated**, no shutdown date announced; the
  app's model chain (`gemini-3.8-flash` → `gemini-3.5-flash-lite`) is
  current. Recorded in `docs/AI_POSTURE.md`.

## [1.0.0] — 2026-11-23 — "MVP"

The audited initial release: local-first taste atlas across seven media
types, deterministic taste engine, license-gated federated provider registry
(14 entries), bilingual EN/AR with full RTL, PWA with offline shell,
IndexedDB persistence with migrations, versioned export/import (v1–v3),
sample-map demo mode. Known gaps at release (documented in the system audit
and addressed in 1.1.0): RAWG provenance stamping missing, NF-1 export
round-trip loss, AI features unavailable without a key, UI/routes/SW/i18n
untested.
