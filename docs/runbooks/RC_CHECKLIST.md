# Release Candidate Checklist — v2.0.0 (B5 preparation)

*Prepared locally. The candidate is cut only when every gate below is green
or explicitly owner-held.*

## Gates

- [x] Stage 1 report + exit gate (PoC P-1…P-8 with measurements)
- [x] Stage 2 report (A2 complete with regression coverage; §5.4 ops)
- [x] Stage 3 report (B0/B1/B2: 47/47 DB suites + 450 unit + 28 e2e green)
- [ ] Stage 4: B3 UI wiring (device/conflict viewers into Settings) + beta
- [ ] A3 real-user validation results entered by the owner (6–10 participants)
- [ ] A4 gate decision recorded (deferred unless evidence fires)
- [ ] Hosted Supabase: migrations applied; X-2/X-11 hosted legs green
- [ ] Username + password flow live on staging (incl. duplicate + wrong-password handling)
- [ ] Cloudflare staging verification checklist (runbook) complete
- [ ] Private beta: zero data-loss incidents across the soak period
- [ ] Weekly pg_dump drill executed once (runbook §1) + restore drill (§3)

## Documentation package (bilingual)

- [x] `docs/sync/SYNC_GUIDE.en.md` / `.ar.md` (bootstrap choices, conflict
      cards, AniList local-only limitation, 14-day delete window, degraded mode)
- [x] `docs/runbooks/BACKUP_RESTORE_RUNBOOK.md`
- [x] `docs/runbooks/CLOUDFLARE_STAGING_RUNBOOK.md`
- [ ] README sync section + screenshots (at RC)

## Copy the candidate must carry (already implemented, verified at RC)

- The AniList "stays on this device" badge (AR/EN) — shipped at Stage 2
- The sync explanation screen summary (AR/EN) — docs above, UI at B3 wiring
- The 14-day delete-recovery window statement — in both guide languages
- The conflict-archive pause state ("review your N pending conflicts") —
  surfaced via `archiveState` (never hidden backpressure)

## Version & changelog

- Version stays **1.2.0** until the RC: the sync capability ships dark
  behind its flag; v2.0.0 is cut only when the gates above pass.
- CHANGELOG gains the Stage 3/4 entry at RC time (drafted with the candidate).

## Non-goals (recorded, not silently dropped)

- No payments, no commercial data integrations, no paid subscriptions.
- No progress/episode tracking unless A3 evidence fires the pre-registered gate.
- No AniList cloud sync until written provider clarification (D-20).
- No server-side exports of provider fields (removed since v1.2).
