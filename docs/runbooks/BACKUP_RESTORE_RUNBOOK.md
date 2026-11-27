# Runbook — Supabase Backup, Restore, and Pause (B4 drills)

*Owner-runbook for the private-beta period. $0 posture: manual `pg_dump`
weekly + before every migration. No paid backup service.*

## 1. Weekly manual backup (Sunday, ~5 minutes)

```bash
# One-time: install the Supabase CLI and log in.
supabase login

# Replace $PROJECT_REF with the project reference from Dashboard → Settings.
# The service password comes from Dashboard → Settings → Database (enter it
# when prompted; never paste it into chat or files).
supabase db dump --project-ref $PROJECT_REF \
  --file echo-backup-$(date +%F).sql \
  --data-only --schema=echo_data,public,auth
```

- Store the dump **off-site** (your own machine + one cloud drive you
  control). The Free tier has **no automated backups** — this file is the
  only recovery point for catastrophic platform loss.
- Verify the dump is non-empty and lists `echo_data` tables:
  `grep -c "COPY echo_data" echo-backup-$(date +%F).sql` (expect ≥ 15).

## 2. Pre-migration backup (before EVERY schema change)

Same command as above. A migration is applied only after this file exists.

## 3. Restore drill into a fresh project (quarterly, and before beta)

1. Create a fresh Supabase project (Free tier allows 2 active).
2. **Pre-create the `echo_jobs_admin` role FIRST** — roles are cluster-level
   objects a database dump does not carry; without this step the dump's
   `ALTER … OWNER TO` statements fail (R-24):

   ```sql
   -- Dashboard → SQL Editor:
   create role echo_jobs_admin nologin nobypassrls noinherit;
   grant echo_jobs_admin to postgres;
   ```

3. Apply the migration chain in order (see
   `ECHO_HUMAN_HANDOFF/FILES_TO_UPLOAD_OR_APPLY.md`).
4. Restore the data dump:
   `psql $DATABASE_URL -f echo-backup-YYYY-MM-DD.sql`
   (or Dashboard → Database → SQL Editor in one transaction per file).
5. Verify: `select count(*) from echo_data.media_items;` matches the
   pre-restore count; run `select public.sync_status()` as a test user.

## 4. Pause / degraded mode (Free tier pauses after 1 week idle)

- A paused project is an **availability event, never a data-loss event** —
  data is retained; the app degrades to its offline mode by design.
- To resume: Dashboard → Settings → General → Restore project.
- If the beta cohort goes quiet for a week, either accept the pause
  (nothing breaks client-side) or ping the project with a scheduled
  `GET /api/sync/status` from any device before the week elapses.

## 5. What the beta hard gate means

**Zero data-loss incidents** during the beta validation period. Builds and
green tests do not by themselves make the beta successful — real device use
without any user-reported or log-detected loss does. Record every incident
with its root cause in `docs/validation/B4_BETA_LOG.md` (created at beta
start).

## 6. Conflict archive storage math (watch item)

Worst case: 50 users × 200 unresolved × ~4 KB ≈ **40 MB** (8% of the 500 MB
Free ceiling) — bounded by the soft cap with visible backpressure (§5.3.5).
Check `sync_status().archiveState` monthly; the T4 upgrade trigger fires at
~350 MB sustained DB usage.
