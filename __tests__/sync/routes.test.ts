/**
 * Sync API route contract tests (A1 standard: every route that exists is
 * tested; the local-first spine means the routes answer 503
 * sync_not_configured when the placeholder-only environment is absent).
 */
import { describe, expect, test } from "bun:test";

// The test process has no Supabase env — the not-configured contract is the
// locally-verifiable surface (the configured path needs the hosted project:
// the human handoff verifies it there; never faked here).

async function post(path: string, body: unknown): Promise<Response> {
  const mod = await import(path);
  return mod.POST(new Request(`https://echo.app${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  }));
}
async function get(path: string, query = ""): Promise<Response> {
  const mod = await import(path);
  return mod.GET(new Request(`https://echo.app${path}${query}`));
}

describe("sync routes — not-configured contract", () => {
  test("POST /api/sync/push returns 503 sync_not_configured without env", async () => {
    const res = await post("../../../../app/api/sync/push/route", {
      deviceId: "11111111-1111-4111-8111-111111111111",
      ops: [{ opid: "o-1", entity: "entries", recordId: "e-1", op: "upsert", baseVersion: 0, record: {} }],
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sync_not_configured" });
  });

  test("POST /api/sync/push rejects a malformed deviceId with 400 BEFORE any RPC", async () => {
    const res = await post("../../../../app/api/sync/push/route", {
      deviceId: "not-a-uuid",
      ops: [{ opid: "o-1", entity: "entries", recordId: "e-1", op: "upsert", baseVersion: 0 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("POST /api/sync/push rejects oversized batches (≤200 ops)", async () => {
    const ops = Array.from({ length: 201 }, (_, i) => ({
      opid: `o-${i}`, entity: "entries" as const, recordId: `e-${i}`,
      op: "upsert" as const, baseVersion: 0, record: {},
    }));
    const res = await post("../../../../app/api/sync/push/route", {
      deviceId: "11111111-1111-4111-8111-111111111111", ops,
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/sync/pull requires a uuid deviceId (PATCH1 route contract)", async () => {
    const res = await get("../../../../app/api/sync/pull/route", "?since=0&deviceId=nope");
    expect(res.status).toBe(400);
    // a valid uuid but no env → 503, never a device-row touch
    const res2 = await get("../../../../app/api/sync/pull/route", "?since=0&deviceId=11111111-1111-4111-8111-111111111111");
    expect(res2.status).toBe(503);
  });

  test("GET /api/sync/status returns 503 without env", async () => {
    const res = await get("../../../../app/api/sync/status/route");
    expect(res.status).toBe(503);
  });

  test("POST /api/sync/bootstrap/ack requires deviceId (O-1 resolution)", async () => {
    const res = await post("../../../../app/api/sync/bootstrap/ack/route", {
      snapshotId: 1, drainedSeq: 5, // deviceId missing
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/sync/devices validates the registration body", async () => {
    const res = await post("../../../../app/api/sync/devices/route", { name: 42 });
    expect(res.status).toBe(400);
  });

  test("GET /api/sync/conflicts returns 503 without env", async () => {
    const res = await get("../../../../app/api/sync/conflicts/route");
    expect(res.status).toBe(503);
  });

  test("POST /api/sync/keep-local requires intentId", async () => {
    const res = await post("../../../../app/api/sync/keep-local/route", {});
    expect(res.status).toBe(400);
  });

  test("POST /api/sync/conflicts/resolve validates the action vocabulary", async () => {
    const bad = await post("../../../../app/api/sync/conflicts/resolve/route", { conflictId: 1, action: "explode" });
    expect(bad.status).toBe(400);
  });
});
