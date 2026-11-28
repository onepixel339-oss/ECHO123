# ECHO — Exact Owner Actions

*Every action has: the dashboard, the field, the value, and a success check.
Placeholders like `$PROJECT_REF` mean "your project's value" — the agent
will never invent them.*

**Order matters:** the GitHub import (Action 1) comes first — Cloudflare
staging and the hosted checks come after it, per the 2026-11-27 brief.

---

## ACTION 1 — Import the GitHub package (10 min)

Follow `GITHUB_MANUAL_IMPORT.md`. Short version:

- **Preferred (preserves full history):** `git clone echo-repository.bundle
  echo-imported && cd echo-imported && git push` to a NEW empty GitHub
  repository (`onepixel339-oss/echo` or a fresh name you choose).
- **Fallback (no git locally):** create the repository, upload
  `echo-source.zip` contents through the web UI (history starts at one
  commit — the bundle remains your history record either way).
- **Success check:** the GitHub repo shows branch `echo/autonomous-execution`
  (and `main`) with the exact file count from `TREE_MANIFEST.txt`, and
  `.github/workflows/ci.yml` is present.

## ACTION 2 — Confirm the real CI run (5 min, mostly waiting)

1. In the imported repository: **Actions** tab → the workflow
   **CI** triggered by your push.
2. Watch it run. It is the same 9-gate suite that passed locally (lint,
   typecheck, 472 unit tests, secret scan + self-test, version check,
   cost-table check, standalone build, 32 e2e, and the local PostgreSQL 19
   sync-database job).
3. **If it fails:** do not fix it in the GitHub UI. Copy the failing job's
   log and send it with the `NEXT_AGENT_MESSAGE.txt` text — the fix comes
   back as a small local patch + a new package (the agent never pushes).
4. **Success check:** the run ends green. **This is the first time the
   workflow has ever run on GitHub — until this moment, CI was
   local-verified only.**

## ACTION 3 — Create the Supabase project (10 min)

1. **Dashboard:** https://supabase.com/dashboard → **New project**.
2. **Fields:**
   - Name: `echo` (any name you like)
   - Database Password: generate and store in your password manager
   - Region: **eu-central-1 (Frankfurt)** — keeps account data in the EU
   - Plan: **Free**
3. **When it is ready:** Settings → **General** → copy the **Reference ID**
   (looks like `abcdefghijklmnop`) — this is `$PROJECT_REF`. This value is
   not secret; you can share it with the agent.
4. **Success check:** the Dashboard shows a healthy project with zero tables
   in Table Editor.

## ACTION 4 — Apply the 9 migrations (5 min)

1. **Dashboard:** SQL Editor → **New query**.
2. Open `MIGRATIONS/0000_roles.sql`, copy its full contents, paste, **Run**.
3. Repeat for `0001`, `0002`, `0003`, `0004`, `0005`, `0006`, `0007`, `0008` **in
   that exact order** (each file says which number it is).
4. **Success check (paste and Run):**
   ```sql
   select schema, proname, security_definer, owner
     from public.v_sync_function_inventory
    order by schema, proname;
   ```
   Expect 26 rows; every `public.sync_*` row shows `security_definer = false`
   and `owner = postgres`; the three `echo_jobs.sync_job_*` rows show
   `security_definer = true` and `owner = echo_jobs_admin`. Then compare the
   full output to `expected_function_inventory.psv` — it must match exactly.
   Also verify the inventory view itself uses caller permissions:
   ```sql
   select reloptions
     from pg_class
    where oid = 'public.v_sync_function_inventory'::regclass;
   ```
   The returned options must include `security_invoker=true`.

## ACTION 5 — Turn on username + password auth (5 min)

There is **no Google OAuth client to create anymore** — the 1.3.0 product
uses usernames + passwords only. In Supabase:

1. **Dashboard:** Authentication → **Providers** → **Email**:
   - **Enable Email Provider: ON** (Supabase requires the email provider to
     carry password identities — ECHO repurposes it with internal
     non-deliverable aliases; users never see or enter an email)
   - **Confirm email: OFF** (critical — with confirmations off, Supabase
     creates the user directly and never attempts to send mail)
2. **Dashboard:** Authentication → **Providers** → every other provider
   (**Google, GitHub, Phone, SAML, magic link**) → **OFF** (most are off by
   default — verify each).
3. **Dashboard:** Authentication → **Sign In / Up** → **Emails** tab →
   **Confirm email: OFF** and **Confirm change of email: OFF**.
4. **Dashboard:** Authentication → **Sign In / Up** → **Anonymous sign-ins:
   ON** (the local-first bridge).
5. **Success check:** Authentication → Providers shows Email = enabled with
   both confirmations OFF, Anonymous = enabled, everything else = disabled.

Full walkthrough incl. why the `.invalid` alias is safe:
`USERNAME_AUTH_SETUP.md`.

## ACTION 6 — Run the hosted auth verification (10 min)

This is the one check the local test suite cannot cover (it verifies the
adapter against a faithful local GoTrue-compatible server; this step
verifies the real hosted Auth service):

1. Deploy (or run locally with env vars) the app with
   `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
2. In the app: Settings → **Account & sync** → **Create account**.
3. Register `testuser1` / a throwaway strong password. Expect: the account
   is created instantly, NO "check your email" screen, no verification
   mail anywhere.
4. Sign out. Try to create `TESTUSER1` again → expect "This username is
   already taken" (case-insensitive uniqueness works).
5. Sign in with `testuser1` + a WRONG password → expect the generic
   "Wrong username or password." (never a hint about which part is wrong).
6. Sign in correctly → Settings shows "Signed in as testuser1", the Devices
   list shows this device, and the three bootstrap choices appear.
7. In Supabase → Authentication → Users: the user row exists, its email
   field is a long `echo-u-…@echo.invalid` value (the internal alias —
   never shown to users), **Email confirmed = true without any mail sent**.
8. **If any step behaves differently** (a confirmation mail is attempted,
   signup rejected, alias refused): STOP — record exactly what happened and
   send it with the `NEXT_AGENT_MESSAGE.txt` text. The adapter is designed
   to be disabled rather than shipped broken; the fallback options are
   documented in `USERNAME_AUTH_SETUP.md` §Fallback.

## ACTION 7 — Enter the environment variables (2 min)

In your hosting provider's secure environment settings (never in chat):

| Variable | Where the value comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API → **Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API → **anon public** key |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → **service_role** key — server-only secret |

**Success check:** `/api/sync/status` on your deployment returns JSON (not
`503 sync_not_configured`).

## ACTION 8 — Verify the security posture (2 min)

Paste into SQL Editor:
```sql
select count(*) as rls_tables from pg_tables where schemaname = 'echo_data';
```
Expect **15** (every table RLS-enabled — `pg_class.relrowsecurity` is set by
the migrations; Table Editor → each table shows "RLS enabled").

Then try Table Editor → `echo_data.change_log` → it returns an error or zero
rows for the dashboard role — the schema is deliberately not REST-exposed.

## ACTION 9 — Recruit the A3 cohort (asynchronous)

1. Send `A3_USER_TEST_KIT/01_INVITATION.md` to 6–10 people (≥3
   Arabic-first; a mix of both languages).
2. They follow `02_PARTICIPANT_INSTRUCTIONS.md`; you (or a facilitator)
   follow `04_TASK_SCRIPT.md` verbatim — the progress-attempt task must be
   read as written.
3. Collect `05_FEEDBACK_FORM.md` + `07_OBSERVATION_SHEET.md` responses and
   the one-week `06_RETENTION_PULSE.md` answers.
4. Fill `08_RESULTS_TEMPLATE.md` with the REAL numbers and send it back.
   **Do not invent or round up any result** — the A4 gate reads exactly what
   you return.

## LATER ACTIONS (after the GitHub import + A3)

- **ACTION 10 — Cloudflare staging:** follow
  `../docs/runbooks/CLOUDFLARE_STAGING_RUNBOOK.md` (~20 min) and its
  verification checklist.
- **ACTION 11 — Production cutover:** your explicit decision, on staging
  evidence. Nothing switches before you say so.
