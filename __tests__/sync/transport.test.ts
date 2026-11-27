/**
 * W-1…W-6 — platform-outage transport classifier + backoff ladder suite
 * (v1.3 PATCH1 §10.2.6; the corrected Cloudflare Error-1027 model).
 */
import { describe, expect, test } from "bun:test";
import {
  classifyResponse, classifyRpcError, nextBackoffMs, nextMidnightUtc, retryDue,
  FIXTURE_ERROR_1027_PAGE,
} from "../../sync/transport";

const json = (body: unknown, status = 200) => ({
  status,
  bodyText: JSON.stringify(body),
  contentType: "application/json",
});

describe("W-1 Cloudflare 1027 quota error page → service_unavailable / platform_quota_exceeded", () => {
  test("classifies the HTML fixture without throwing", () => {
    const cls = classifyResponse({
      status: 503, // vendor does not document the exact status; body markers decide
      bodyText: FIXTURE_ERROR_1027_PAGE,
      contentType: "text/html",
    });
    expect(cls.kind).toBe("service_unavailable");
    if (cls.kind === "service_unavailable") expect(cls.sub).toBe("platform_quota_exceeded");
  });
  test("non-JSON 429 (platform, not app) also lands on the safe path", () => {
    const cls = classifyResponse({ status: 429, bodyText: "<html>rate limited</html>", contentType: "text/html" });
    expect(cls.kind).toBe("service_unavailable");
  });
});

describe("W-2 network failure / non-JSON 5xx → the identical safe path", () => {
  test("non-JSON 5xx", () => {
    const cls = classifyResponse({ status: 502, bodyText: "<html>Bad Gateway</html>", contentType: "text/html" });
    expect(cls.kind).toBe("service_unavailable");
    if (cls.kind === "service_unavailable") expect(cls.sub).toBe("generic");
  });
  test("JSON 500 with an ECHO error code maps to the typed classifier", () => {
    expect(classifyRpcError(500, "device_revoked").kind).toBe("device_revoked");
    expect(classifyRpcError(404, "device_not_found").kind).toBe("device_not_found");
    expect(classifyRpcError(409, "cursor_expired").kind).toBe("cursor_expired");
  });
  test("contract response", () => {
    expect(classifyResponse(json({ ok: true })).kind).toBe("contract");
  });
  test("app-level 429 with retryAfterMs is honored when present", () => {
    const cls = classifyResponse(json({ error: "rate_limited", retryAfterMs: 2500 }, 429));
    expect(cls.kind).toBe("app_429");
    if (cls.kind === "app_429") expect(cls.retryAfterMs).toBe(2500);
  });
});

describe("W-3 no Retry-After → local backoff ladder, no busy loop", () => {
  test("app 429 without retryAfterMs uses the local ladder", () => {
    const cls = classifyResponse(json({ error: "rate_limited" }, 429));
    expect(cls.kind).toBe("app_429");
    if (cls.kind === "app_429") expect(cls.retryAfterMs).toBeUndefined();
  });
  test("ladder is exponential, capped at 2 minutes, and grows with failures", () => {
    const t0 = Date.UTC(2026, 10, 27, 12, 0, 0);
    expect(nextBackoffMs(0, { kind: "service_unavailable", sub: "generic" }, t0)).toBe(1000);
    expect(nextBackoffMs(1, { kind: "service_unavailable", sub: "generic" }, t0)).toBe(2000);
    expect(nextBackoffMs(3, { kind: "service_unavailable", sub: "generic" }, t0)).toBe(8000);
    expect(nextBackoffMs(10, { kind: "service_unavailable", sub: "generic" }, t0)).toBe(120000);
  });
  test("quota-class failures wait ≥30 minutes, bounded by the next midnight UTC", () => {
    const t0 = Date.UTC(2026, 10, 27, 23, 50, 0); // 10 minutes to midnight
    const wait = nextBackoffMs(1, { kind: "service_unavailable", sub: "platform_quota_exceeded" }, t0);
    expect(wait).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000); // clamped to midnight (≈10 min)
    expect(wait).toBeLessThanOrEqual(30 * 60 * 1000 + 1);
    const t1 = Date.UTC(2026, 10, 27, 1, 0, 0);
    expect(nextBackoffMs(1, { kind: "service_unavailable", sub: "platform_quota_exceeded" }, t1)).toBe(30 * 60 * 1000);
    expect(nextMidnightUtc(t1)).toBe(Date.UTC(2026, 10, 28, 0, 0, 0));
  });
  test("retryDue prevents busy loops", () => {
    const t0 = 1_000_000;
    expect(retryDue(t0, 60_000, t0 + 59_999)).toBe(false);
    expect(retryDue(t0, 60_000, t0 + 60_000)).toBe(true);
  });
});

describe("W-4/W-5/W-6 — SyncClient end-to-end against a mocked transport", () => {
  test("degraded state leaves local flows usable; outbox intact; recovery drains", async () => {
    const { SyncClient } = await import("../../sync/client");
    const { getAllOutbox, clearOutbox } = await import("../../sync/outbox");
    const { closeDB } = await import("../../localdb");
    // fake-indexeddb provides the IndexedDB the outbox uses
    const { default: fakeAuto } = await import("fake-indexeddb/auto");
    void fakeAuto;

    await clearOutbox();
    const op = (n: number) => ({
      opid: `op-${n}`, entity: "entries" as const, recordId: `e-${n}`,
      op: "upsert" as const, baseVersion: 0, record: { status: "watching" },
    });

    const pushes: { ops: unknown[] }[] = [];
    let failNextPush = true;
    const cursor = 0;
    const endpoints = {
      push: async (_d: string, ops: unknown[]) => {
        if (failNextPush) {
          failNextPush = false;
          return new Response("<html>Error 1027</html>", { status: 503, headers: { "content-type": "text/html" } });
        }
        pushes.push({ ops });
        return Response.json({
          ok: true, epoch: 1, headSeq: cursor + ops.length,
          acked: (ops as { opid: string }[]).map((o) => o.opid), archived: [], rejected: [],
        });
      },
      pull: async () => Response.json({ ok: true, headSeq: cursor, watermark: 1, changes: [] }),
      status: async () => Response.json({ ok: true, epoch: 1, headSeq: 0, watermark: 1, serverBootId: "b", perEntity: {}, perEntityHash: {}, archiveState: { unresolved: 0, nearFullAt: 160, cap: 200, state: "ok" } }),
      bootstrapStatus: async () => Response.json({ ok: true, epoch: 1, headSeq: 0, watermark: 1, serverBootId: "b", activeSnapshot: { id: 1, headSeq: 0, epoch: 1, pageCount: 0, recordCount: 0, contentHash: "h" } }),
    };
    const states: string[] = [];
    const client = new SyncClient({
      endpoints,
      applyChange: async () => {},
      onUiState: (s) => states.push(s),
      now: () => Date.now(),
    });
    await client.loadState();
    client.attachDevice("dev-1", "Test");

    // local mutation queued while the platform is down:
    await client.enqueue([op(1), op(2)]);

    // W-1/W-4: the failed push degrades the UI but local data is intact
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getUiState()).toBe("degraded");
    expect((await getAllOutbox()).length).toBe(2); // W-5: nothing discarded

    // W-6: service restored → retry succeeds, ops drain with opid dedupe
    client["backoffMs"] = 0; // ladder satisfied (time travel for the test)
    await client.drain();
    expect(pushes.length).toBe(1);
    expect((await getAllOutbox()).length).toBe(0); // drained
    expect(client.getUiState()).toBe("synced");
    expect(states).toContain("degraded");
    expect(states).toContain("synced");

    await closeDB();
  });
});
