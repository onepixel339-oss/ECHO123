# ECHO — Cloudflare Setup (staging; LATER, after A3 returns)

*Nothing has been deployed. The Stage-1 PoC proved the vinext path locally
(0.65 MiB gzipped vs the 3 MiB Free limit, 4.6× headroom; full report:
`docs/workers-poc/POC_REPORT.md`). This is the execution runbook.*

## Account + subdomain

1. Create a Cloudflare account (Free plan).
2. Workers & Pages → choose your `*.workers.dev` subdomain (e.g.
   `echo-staging.yourname.workers.dev`).

## Deploy staging

```bash
bun install
bunx vinext init --platform cloudflare    # non-destructive (PoC-verified)
# two one-line fixes from the PoC report §3:
#   1) remove `output: "standalone"` from next.config.ts for vinext builds
#   2) delete the dead __dirname/__filename declarations in eslint.config.mjs
bun run build:vinext                       # local workerd build first
bunx wrangler deploy --name echo-staging
```

## Secrets (typed into Wrangler — never files or chat)

```bash
bunx wrangler secret put NEXT_PUBLIC_SUPABASE_URL      --name echo-staging
bunx wrangler secret put NEXT_PUBLIC_SUPABASE_ANON_KEY --name echo-staging
bunx wrangler secret put SUPABASE_SERVICE_ROLE_KEY     --name echo-staging
```

## Verification checklist

From `docs/runbooks/CLOUDFLARE_STAGING_RUNBOOK.md`:
the six e2e flows against the staging URL; fonts/RTL/PWA/offline; `/api/health`
+ `/status`; the username + password account flow (signup → sign-in →
anonymous bridge → change password, per USERNAME_AUTH_SETUP.md); the full
sync flow (sign in → bootstrap choices →
push/pull → conflict card); quota behavior observed only if a real event
occurs (never intentionally exhausted).

## Quota facts (verified against current official docs, Stage-1 PoC)

- 100,000 requests/day on Free; **static asset requests are free and
  unlimited**; resets at midnight UTC; excess returns **Error 1027** (the
  Worker does not execute — the client's transport classifier handles it,
  tested by W-1…W-6).
- 10 ms CPU/invocation; 3 MiB Worker size; 5 cron triggers.
- Beta sizing: ~3.7% of the daily budget at 50 users.

## Rollback

```bash
bunx wrangler deployments rollback --name echo-staging
```

The Vercel legacy deployment stays untouched until the production cutover
decision (yours, on staging evidence).
