# Runbook — Cloudflare Workers Staging Deployment (B3/B4 preparation)

*Prepared locally; execution waits for the owner's Cloudflare account (the
human checkpoint). Nothing here has been deployed or claimed as deployed.*

## Proven by the Stage-1 PoC (docs/workers-poc/POC_REPORT.md)

- **vinext 1.4.6** is the adapter (OpenNext remains the documented fallback
  only if a deploy-gated gate later fails — P-7 was N/A).
- Local workerd build green: **0.65 MiB gzipped vs the 3.00 MiB Free limit
  (4.6× headroom)**; static assets 1.61 MiB / 33 files via Workers Assets
  (free, unlimited); e2e green against the local workerd preview.
- Two one-line repo fixes identified for the vinext path: remove
  `output: "standalone"` for vinext builds (kept for Next standalone) and
  drop the dead `__dirname` declarations in `eslint.config.mjs`.

## Staging deployment steps (owner, ~20 minutes)

1. Create a Cloudflare account and claim a `*.workers.dev` subdomain.
2. In the repo:
   ```bash
   bun install
   bunx vinext init --platform cloudflare   # non-destructive (PoC-verified)
   # apply the two one-line fixes above
   bun run build:vinext                     # local workerd build first
   bunx wrangler deploy --name echo-staging # STAGING only
   ```
3. Enter secrets in Wrangler (never in files or chat):
   ```bash
   bunx wrangler secret put NEXT_PUBLIC_SUPABASE_URL        --name echo-staging
   bunx wrangler secret put NEXT_PUBLIC_SUPABASE_ANON_KEY   --name echo-staging
   bunx wrangler secret put SUPABASE_SERVICE_ROLE_KEY       --name echo-staging
   # plus the existing provider keys if enabled (RAWG/IGDB/Trakt/Gemini)
   ```
4. Verification checklist on `https://echo-staging.<your-subdomain>.workers.dev`:
   - [ ] all six primary user flows (the e2e suite, pointed at the staging URL)
   - [ ] fonts, RTL/Arabic routing, service worker + PWA install + offline
   - [ ] `/api/health` and `/status`
   - [ ] Username + password flow live (signup, duplicate rejection, generic sign-in failure, sign-in, anonymous bridge, change password)
   - [ ] full sync flow: sign in → bootstrap choices → push/pull → conflict card
   - [ ] Free-plan limits: Error 1027 behavior NOT intentionally exhausted;
         observed only if a quota event occurs (the client's classifier is tested)
   - [ ] static assets served during any Worker-quota event (the §10.7-7 unknown)

## Rollback

`wrangler deployments rollback --name echo-staging`. The Vercel legacy
deployment stays untouched until the production cutover decision (owner).

## Production cutover (separate owner decision — NOT part of staging)

Present the staging evidence; the owner decides. No DNS/URL switch happens
without that explicit instruction.
