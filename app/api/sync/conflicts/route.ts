/**
 * GET  /api/sync/conflicts          — list own conflict-archive rows
 * POST /api/sync/conflicts/resolve  — {conflictId, action: restore|discard}
 * The archive rows are read through the security_invoker view (RLS-scoped);
 * restore returns a fresh pushable op (INV-18).
 */
import { z } from "zod";
import { readSyncEnv, handleRouteError, SyncNotConfiguredError } from "@/lib/echo/server/sync";
import { createClient } from "@supabase/supabase-js";

export async function GET(request: Request): Promise<Response> {
  try {
    const env = readSyncEnv();
    if (!env) throw new SyncNotConfiguredError();
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const client = createClient(env.url, env.anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client
      .from("v_conflict_archive")
      .select("id,entity,record_id,reason,base_version,server_version,client_payload,created_at,resolved_at,resolution")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return Response.json({ error: "archive_read_failed" }, { status: 502 });
    return Response.json({ ok: true, conflicts: data });
  } catch (err) {
    return handleRouteError(err);
  }
}
