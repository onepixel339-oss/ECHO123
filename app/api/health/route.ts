/**
 * ECHO — health endpoint (A2/§5.4 free operational basics).
 *
 * The $0 posture's health check: no external service is called, no secret is
 * read, nothing is persisted. It answers three questions an operator has:
 *  1. is the app running (and which version)?
 *  2. which OPTIONAL integrations are configured on this deployment?
 *  3. what does the provider gate look like right now?
 *
 * Configuration is reported as BOOLEANS ONLY — key names and values never
 * leave the server. A free external uptime probe (the owner's choice of
 * service, added later at the human checkpoint) can poll this route; the
 * built-in /status page renders it for humans, bilingually.
 */

import { NextResponse } from "next/server";
import { isProviderEnabled, listProviderRegistry } from "@/lib/echo/providers/registry";

export const dynamic = "force-dynamic";

const BOOTED_AT = Date.now();

export async function GET() {
  const providers = listProviderRegistry().map((entry) => ({
    id: entry.id,
    name: entry.name,
    enabled: isProviderEnabled(entry.id),
    userToggleable: entry.userToggleable,
    cloudSyncPolicy: entry.cloudSyncPolicy,
  }));

  return NextResponse.json(
    {
      status: "ok",
      version: process.env.ECHO_VERSION ?? "1.3.0",
      bootedAtMs: BOOTED_AT,
      uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000),
      integrations: {
        // booleans only — never key names or values
        rawg: Boolean((process.env.NEXT_PUBLIC_RAWG_API_KEY ?? "").trim()),
        igdb: Boolean(
          (process.env.IGDB_CLIENT_ID ?? "").trim() &&
            (process.env.IGDB_CLIENT_SECRET ?? "").trim(),
        ),
        trakt: Boolean((process.env.TRAKT_CLIENT_ID ?? "").trim()),
        upstashKv: Boolean((process.env.UPSTASH_REDIS_REST_URL ?? "").trim()),
      },
      providers,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
