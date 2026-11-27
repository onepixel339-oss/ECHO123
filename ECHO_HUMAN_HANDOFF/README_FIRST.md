# ECHO — READ THIS FIRST

*One page. Do these in order. No secrets ever go into chat, files, or email —
every credential is typed directly into the provider's own dashboard.*

## Where things stand

- **The 1.3.0 final-scope tree is implemented and locally verified** (fresh
  runs, 2026-11-28): 47/47 database suites on a real local PostgreSQL 19,
  **472/472** unit tests, **32/32** e2e against the production build,
  lint/typecheck/build/secret-scan/version-check/cost-table all green.
  Full evidence: `../STAGE_1_REPORT.md`, `../STAGE_2_REPORT.md`,
  `../STAGE_3_REPORT.md`, and `../CHANGELOG.md` (1.3.0 entry).
- **Product scope (owner decisions, 27 Nov 2026): username + password
  ONLY** (no email, no phone, no Google/GitHub/social, no magic link, no
  SMTP, **no password recovery**) and **no generative AI** (Gemini, Ask
  ECHO, Taste Companion, and the weekly digest are removed; nothing
  pretends to be AI). Local-only use stays fully functional.
- **A3 (real-user validation) is still PENDING** — it needs your 6–10 real
  participants. The kit is in `A3_USER_TEST_KIT/`. Nothing was fabricated.
- **What is genuinely yours to do now** (details + success checks in
  `EXACT_OWNER_ACTIONS.md`):

  1. **Import the GitHub package** into a clean repository (bundle or
     source archive — `GITHUB_MANUAL_IMPORT.md`, 10 min).
  2. **Confirm the real GitHub Actions run** passes (the workflow has
     never run on GitHub yet — CI is local-verified only).
  3. **Create the Supabase project** and apply the 8 migrations (10 min).
  4. **Configure username + password auth** in Supabase Auth (5 min — this
     replaces the old Google OAuth step; there is NO Google client to
     create anymore).
  5. **Run the hosted auth verification** for the username adapter
     (`USERNAME_AUTH_SETUP.md`, 10 min — the one hosted check the local
     tests cannot cover).
  6. **Enter the environment variables** in your hosting provider (2 min).
  7. **Recruit the A3 cohort** and return the filled sheets (1–2 weeks,
     asynchronous — runs in parallel with everything above).
  8. Later: **Cloudflare staging** (runbook included), then the production
     cutover decision.

## The three rules

1. **Never paste secrets into chat.** Dashboards only.
2. **Back up before migrating.** The runbook's two commands (weekly +
   pre-migration) are in `docs/runbooks/BACKUP_RESTORE_RUNBOOK.md`.
3. **When you're done**, send the message at the bottom of
   `NEXT_AGENT_MESSAGE.txt` — the agent then verifies everything end-to-end
   and continues from `EXECUTION_STATUS.md` (nothing restarts).

## Package contents

| File | What it is |
|---|---|
| `EXACT_OWNER_ACTIONS.md` | Your numbered actions with exact dashboards, fields, and success checks |
| `GITHUB_MANUAL_IMPORT.md` | Importing the repository bundle / source archive into GitHub |
| `USERNAME_AUTH_SETUP.md` | The username + password Auth configuration + hosted verification |
| `FILES_TO_UPLOAD_OR_APPLY.md` | Migration order + what NOT to commit |
| `SUPABASE_SETUP.md` | Project settings, migration execution, RLS verification |
| `CLOUDFLARE_SETUP.md` | Staging deployment (later, after the GitHub import) |
| `MIGRATIONS/` | The 8 versioned SQL migrations (with the expected-function inventory) |
| `A3_USER_TEST_KIT/` | The bilingual validation kit for your participants |
| `.env.example` | Placeholders only — copy to `.env` / hosting env vars |
| `HANDOFF_MANIFEST.txt` | SHA-256 inventory of this package |
| `BACKUP_MANIFEST.txt` | Local backup locations + verification results |
| `NEXT_AGENT_MESSAGE.txt` | The exact message to send when you're done |
