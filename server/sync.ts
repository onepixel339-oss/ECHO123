/**
 * ECHO — server-side sync route helper (B1/B2).
 *
 * The routes are thin: zod-validate the request, verify the caller's JWT via
 * the platform (a per-request client bound to the caller's access token —
 * the v1.1 §6.3 pattern: the RPC executes as the caller with RLS), map RPC
 * error codes onto the HTTP contract, and return 503 sync_not_configured
 * when the placeholder-only environment is absent (the local-first spine:
 * the app is fully functional without sync).
 *
 * No secrets ever live here — the owner enters credentials directly in the
 * provider dashboards / local .env (never committed, never in chat).
 */

import { createClient } from "@supabase/supabase-js";

export interface SyncEnv {
  url: string;
  anonKey: string;
}

export function readSyncEnv(): SyncEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return { url, anonKey };
}

export class SyncNotConfiguredError extends Error {
  constructor() {
    super("sync_not_configured");
  }
}

export interface SyncCaller {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
}

/** A per-request client bound to the caller's access token (RLS applies). */
export function callerFromRequest(request: Request): SyncCaller {
  const env = readSyncEnv();
  if (!env) throw new SyncNotConfiguredError();
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const client = createClient(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(fn, args);
      if (error) {
        // map RPC error codes onto the HTTP contract (v1.1 §9.3 + PATCH1)
        const code = error.message.split("\n")[0].trim();
        throw new RpcError(code, (error as { details?: string }).details ?? "");
      }
      return data as T;
    },
  };
}

export class RpcError extends Error {
  constructor(
    public code: string,
    public detail: string,
  ) {
    super(code);
  }
}

/** The route-level error mapping (PATCH1 §4.3.3 error-surfacing row). */
export function rpcErrorToResponse(err: RpcError): Response {
  const body = (extra: Record<string, unknown>) =>
    Response.json({ error: err.code, ...extra }, { status: statusFor(err.code) });
  switch (err.code) {
    case "cursor_expired":
      return body({ mustRebootstrap: true, watermark: safeDetailNumber(err.detail, "watermark") });
    case "epoch_mismatch":
      return body({ mustRebootstrap: true, serverEpoch: safeDetailNumber(err.detail, "serverEpoch") });
    case "device_not_found":
      return body({}); // 404 — uniform for unknown AND foreign identifiers
    case "device_revoked":
      return body({}); // 403
    default:
      return body({});
  }
}

function statusFor(code: string): number {
  switch (code) {
    case "unauthenticated": return 401;
    case "cursor_expired":
    case "epoch_mismatch": return 409;
    case "device_not_found": return 404;
    case "device_revoked":
    case "invalid_action": return 403;
    case "device_name_taken": return 409;
    case "push_batch_too_large":
    case "row_cap_exceeded":
    case "invalid_drained_seq":
    case "push_batch_invalid":
    case "invalid_device_name": return 400;
    case "conflict_archive_full": return 429;
    default: return 502;
  }
}

function safeDetailNumber(detail: string, key: string): number | undefined {
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    const v = parsed[key];
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function notConfiguredResponse(): Response {
  return Response.json(
    { error: "sync_not_configured" },
    { status: 503, headers: { "retry-after": "3600" } },
  );
}

export function handleRouteError(err: unknown): Response {
  if (err instanceof SyncNotConfiguredError) return notConfiguredResponse();
  if (err instanceof RpcError) return rpcErrorToResponse(err);
  return Response.json({ error: "internal" }, { status: 500 });
}
