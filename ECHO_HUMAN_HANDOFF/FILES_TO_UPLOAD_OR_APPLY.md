# ECHO — Files to Apply / Upload (and what NOT to commit)

## Apply to Supabase (ACTION 2) — in this exact order

| Order | File | Note |
|---|---|---|
| 1 | `MIGRATIONS/0000_roles.sql` | creates `echo_jobs_admin` |
| 2 | `MIGRATIONS/0001_schema.sql` | the whole schema + RLS + grants |
| 3 | `MIGRATIONS/0002_devices_and_pull.sql` | devices + the PATCH1 sync_pull |
| 4 | `MIGRATIONS/0003_sync_push.sql` | the D-1…D-10 push |
| 5 | `MIGRATIONS/0004_bootstrap_lifecycle.sql` | snapshots/bootstrap/lifecycle |
| 6 | `MIGRATIONS/0005_jobs.sql` | the S-2 definer jobs |
| 7 | `MIGRATIONS/0006_views_assertions.sql` | views + trigger + assertions |
| 8 | `MIGRATIONS/0007_reason_constraint.sql` | the §5.3.4 constraint migration |

Each migration ends with its own ownership/shape assertion — if any raises
an error, STOP and send the error to the agent (do not "fix" the SQL).

## Reference only (no upload needed)

- `expected_function_inventory.psv` — the X-5 diff source (compare with the
  inventory view's output after applying the migrations).

## Deploy to hosting (after Actions 1–5)

The whole repository deploys as usual (`bun install && bun run build` or the
Cloudflare staging runbook). Environment variables from ACTION 5.

## What NOT to commit anywhere

- `.env` (only `.env.example` is tracked — placeholders only)
- Any Supabase key other than the two `NEXT_PUBLIC_*` values (and even
  those belong in the hosting provider's settings, not the repo)
- `SUPABASE_SERVICE_ROLE_KEY` — hosting env only
- Supabase service-role key — hosting provider env settings only (there are no OAuth client secrets in the 1.3.0 username/password model)
- The A3 participants' filled sheets — they contain personal data; keep
  them locally and share only the anonymized `08_RESULTS_TEMPLATE.md`
  summary with the agent.

## GitHub transfer (final stage, after cutover)

Prepared at the final handoff: full source archive, git bundle, patch
against the last canonical commit, file manifest with SHA-256 hashes, and
`GITHUB_MANUAL_IMPORT.md`. You will not need to re-upload files that already
match remote blobs (the Phase-1 delivery proved 193/194 blobs identical;
the single missing `ci.yml` is included in the repo tree).
