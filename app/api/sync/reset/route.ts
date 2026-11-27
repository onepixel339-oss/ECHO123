/**
 * POST /api/sync/reset — the owner-scoped panic button (v1.1 §9.3). Wipes
 * the caller's replica via the S-2 job path (the only sanctioned change_log
 * deletion outside compaction), rotates serverBootId, bumps the epoch.
 * Local data is unaffected.
 */
import { readSyncEnv, handleRouteError, SyncNotConfiguredError } from "@/lib/echo/server/sync";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: Request): Promise<Response> {
  try {
    const env = readSyncEnv();
    if (!env) throw new SyncNotConfiguredError();
    // The uid comes ONLY from the verified JWT (never the body). The job
    // itself runs as the least-privilege echo_jobs_admin (S-2 allowlist).
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const client = createClient(env.url, env.anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await client.auth.getUser(token);
    if (userError || !userData.user) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    // service-role path: the route holds no key in this local-first build;
    // on the hosted project the SUPABASE_SERVICE_ROLE_KEY secret (dashboard-
    // entered, never in code) authorizes the job invocation.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return Response.json({ error: "service_key_not_configured" }, { status: 503 });
    }
    const admin = createClient(env.url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.rpc("sync_job_reset", { p_user: userData.user.id });
    if (error) return Response.json({ error: "reset_failed" }, { status: 502 });
    return Response.json(data);
  } catch (err) {
    return handleRouteError(err);
  }
}
