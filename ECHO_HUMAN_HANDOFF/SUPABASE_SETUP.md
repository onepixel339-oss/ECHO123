# ECHO — Supabase Setup Guide

## Project settings (ACTION 1 recap)

- Region **eu-central-1** (Frankfurt) — minimal latency from the current
  deployment region; EU processing for account data.
- Plan **Free** (500 MB DB, 50k MAU, pauses after 1 week idle — an
  availability event only; the app degrades to offline mode by design).
- **No automated backups on Free:** the weekly + pre-migration `pg_dump`
  discipline in `docs/runbooks/BACKUP_RESTORE_RUNBOOK.md` is mandatory.

## Applying the migrations

The 8 files in `MIGRATIONS/` run **in numeric order** via the SQL Editor
(ACTION 2), or, if you prefer the CLI:

```bash
supabase link --project-ref $PROJECT_REF
for f in ECHO_HUMAN_HANDOFF/MIGRATIONS/*.sql; do
  echo "-- applying $f"; supabase db execute --project-ref $PROJECT_REF -f "$f" || break
done
```

What they build (one line each):

| # | File | What it creates |
|---|---|---|
| 0000 | roles.sql | The least-privilege `echo_jobs_admin` job-owner role |
| 0001 | schema.sql | The private `echo_data` schema: 15 tables, the six-value conflict reason constraint, per-command RLS (incl. the devices UPDATE policy), grants |
| 0002 | devices_and_pull.sql | Helpers, profile init, device register/revoke/rename/list, **the PATCH1 device-scoped `sync_pull`** |
| 0003 | sync_push.sql | **The D-1…D-10 decision table** + idempotency + backpressure + row caps + AniList hard floor |
| 0004 | bootstrap_lifecycle.sql | Snapshots, bootstrap status/manifest/page/**ack(deviceId)**, status, conflict resolve, keep-local, restore-backup |
| 0005 | jobs.sql | The S-2 SECURITY DEFINER jobs (compact/cleanup/reset) owned by `echo_jobs_admin` |
| 0006 | views_assertions.sql | The lock-guard trigger, `security_invoker` views, EXECUTE default-deny, the ownership/shape assertions + inventory view |
| 0007 | reason_constraint.sql | The §5.3.4 constraint migration (no-op on fresh DBs; corrects any v1.1-built environment) |

## RLS verification (after applying)

1. SQL Editor:
   ```sql
   select count(*) from pg_tables where schemaname = 'echo_data';
   ```
   → **15**.
2. Table Editor: every `echo_data` table shows **RLS enabled**.
3. The function inventory (ACTION 2's success check) matches
   `expected_function_inventory.psv` exactly.

## Auth settings

Covered in EXACT_OWNER_ACTIONS ACTION 5 + USERNAME_AUTH_SETUP.md: the
Email provider ON with both confirmations OFF (the internal `.invalid`
alias carries the password identity — users never see an email), anonymous
sign-ins ON, and every other provider OFF. There is no Google OAuth client
in the 1.3.0 product.

## Operations

- **Watermark/compaction:** the S-2 jobs are per-user RPCs; run them from a
  scheduled function or manually during the beta:
  ```sql
  select echo_jobs.sync_job_compact('<user-uuid>');
  select echo_jobs.sync_job_cleanup('<user-uuid>');
  ```
  (A scheduled Cloudflare Worker trigger can call them via the service key
  later — 5 cron triggers are available on the Free plan.)
- **Reset (panic button):** `POST /api/sync/reset` with the caller's session
  — wipes only that user's replica, rotates `serverBootId`.
- **Weekly backup + restore drill + pause handling:** see the runbook.

## What NOT to do

- Do not enable any auth provider besides Email-with-confirmations-off and
  anonymous sign-ins (username + password is the ONLY permanent method).
- Do not turn "Confirm email" or "Confirm change of email" ON — with the
  `.invalid` alias there is no mailbox; confirmations would break every
  signup. (And never set a REAL user's email this way — the pattern is
  reserved for the internal alias.)
- Do not add `echo_data` to the API's exposed schemas (it is private by
  design; reads go through the `v_*` views).
- Do not grant `service_role` or `supabase_admin` ownership of any function.
- Do not run migrations without the pre-migration dump.
