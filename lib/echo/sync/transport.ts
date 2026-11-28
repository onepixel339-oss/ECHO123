/**
 * ECHO — platform-outage transport classifier + backoff ladder
 * (v1.3 PATCH1 §10.2.6, corrected: Cloudflare daily-quota exhaustion returns
 * Error 1027 — the Worker never executes, so no app-level 429/JSON/
 * Retry-After can exist on that path; the ladder never depends on
 * Retry-After being present).
 */

import type { TransportClass } from "./types";

export interface ClassifyInput {
  status: number;
  bodyText: string;
  contentType: string;
}

/**
 * Classify a sync HTTP response, in order (§10.2.6):
 *   1. contract response (2xx JSON matching the app schema) — caller checks
 *      the body separately; this function returns `contract` for any 2xx
 *      that parses as JSON and lets the caller validate the shape.
 *   2. app-level 429 — ECHO's own rate limiter: JSON body, optional
 *      retryAfterMs. Never required for scheduling.
 *   3. platform failure — everything else: non-JSON bodies (including
 *      Cloudflare's HTML error pages), unexpected statuses, fetch
 *      rejection, timeout → service_unavailable. HTML containing
 *      "Error 1027" / cf-ray / server: cloudflare is sub-classified
 *      platform_quota_exceeded for copy + backoff selection. Correctness
 *      never depends on this detection.
 */
export function classifyResponse(input: ClassifyInput): TransportClass {
  const { status, bodyText, contentType } = input;

  if (status >= 200 && status < 300) return { kind: "contract" };

  const isJson = contentType.includes("json") || looksLikeJson(bodyText);
  if (status === 429 && isJson) {
    let retryAfterMs: number | undefined;
    try {
      const body = JSON.parse(bodyText) as { retryAfterMs?: unknown };
      if (typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs)) {
        retryAfterMs = body.retryAfterMs;
      }
    } catch {
      /* not JSON after all — falls through to platform handling below */
    }
    if (retryAfterMs !== undefined) return { kind: "app_429", retryAfterMs };
    return { kind: "app_429" };
  }

  if (status === 401) return { kind: "auth_expired" };

  // platform / generic failure — sub-classify quota pages diagnostically
  const platformQuota =
    (status >= 500 || status === 429 || !isJson) &&
    /error\s*1027/i.test(bodyText);
  if (platformQuota) return { kind: "service_unavailable", sub: "platform_quota_exceeded" };
  return { kind: "service_unavailable", sub: "generic" };
}

/** Classify RPC-error JSON bodies the routes surface with typed codes. */
export function classifyRpcError(status: number, code: string): TransportClass {
  switch (code) {
    case "device_not_found": return { kind: "device_not_found" };
    case "device_revoked": return { kind: "device_revoked" };
    case "cursor_expired": return { kind: "cursor_expired" };
    case "epoch_mismatch": return { kind: "epoch_mismatch" };
    case "unauthenticated": return { kind: "auth_expired" };
    default: return { kind: "service_unavailable", sub: "generic", ...(status ? {} : {}) };
  }
}

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

/** Cloudflare-style 1027 quota error page fixture (W-1). */
export const FIXTURE_ERROR_1027_PAGE = `<!DOCTYPE html>
<html><head><title>Worker exceeded free tier daily request limit</title></head>
<body><h1>Error 1027</h1>
<p>Worker exceeded free tier daily request limit.</p>
<hr><!-- cf-ray: 8f3a2b1c9d4e --></body></html>`;

/**
 * The backoff ladder (§10.2.6 rules 4): generic failures use exponential
 * backoff with jitter (1s base, ×2, cap 2 min — v1.1 §9.4); quota-classified
 * failures retry at most once per 30 minutes until the next midnight UTC;
 * any successful contract response resets the ladder. Pure function: the
 * caller owns the clock and the randomness for testability.
 */
export function nextBackoffMs(
  failureCount: number,
  cls: TransportClass,
  nowMs: number,
  jitterFraction = 0,
): number {
  if (cls.kind === "service_unavailable" && cls.sub === "platform_quota_exceeded") {
    // once per 30 minutes until the next midnight UTC (reset time used for
    // scheduling only — a wrong clock still converges)
    const nextSlot = nowMs + 30 * 60 * 1000;
    const midnight = nextMidnightUtc(nowMs);
    return Math.max(30 * 60 * 1000, Math.min(nextSlot, midnight) - nowMs);
  }
  const base = 1000 * Math.pow(2, Math.min(failureCount, 8)); // 1s → 256s cap
  const capped = Math.min(base, 120_000);
  const jitter = capped * jitterFraction * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(capped + jitter));
}

/** Next midnight UTC after `nowMs` (the documented daily-limit reset time). */
export function nextMidnightUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return next;
}

/** True when a retry is due (no busy loop — W-3). */
export function retryDue(lastAttemptMs: number, backoffMs: number, nowMs: number): boolean {
  return nowMs - lastAttemptMs >= backoffMs;
}
