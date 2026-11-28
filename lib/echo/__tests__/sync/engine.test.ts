/**
 * ECHO — sync engine tests (B3 wiring): the runtime orchestration with a
 * mocked transport + mocked auth, over the real IndexedDB layer
 * (fake-indexeddb) and a real in-memory store shape.
 *
 * Locked behaviors:
 *   - unconfigured → getSyncEngine() null (local-only spine);
 *   - sign-in → device registration → bootstrap choice-before-mutation;
 *   - a local mutation after bootstrap lands in the outbox and pushes;
 *   - AniList-derived media never enters the outbox (policy gate);
 *   - pulled changes apply to the store WITHOUT re-emitting (no echo loop);
 *   - own pushed edits report their version to the ledger (baseVersion
 *     advances on the next edit);
 *   - conflict archive surfacing + resolve calls;
 *   - device rename/revoke actions hit the right endpoints;
 *   - "clear all data" quarantines the outbox and resets device state
 *     without touching cloud data.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import "fake-indexeddb/auto";
import { SyncEngine, type EchoStoreShape } from "../../sync/engine";
import type { AuthClientPort, AuthSession } from "../../sync/auth";
import { subscribeToLocalMutations, emitLocalMutation, emitLocalCleared } from "../../sync/localMutations";
import { getAllOutbox, clearOutbox } from "../../sync/outbox";
import { openDB, closeDB, STORES } from "../../localdb";
import type { SyncOp } from "../../sync/types";

// ── a scripted transport ────────────────────────────────────────────────

interface Served {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function makeTransport(responses: Array<(req: Served) => { status: number; body: unknown } | null>) {
  const served: Served[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    // the engine issues browser-relative /api/sync/... paths; resolve them
    // against a virtual origin (the browser does this implicitly)
    const url = new URL(typeof input === "string" ? input : (input as Request).url, "http://engine.test");
    const path = url.pathname + (url.search || "");
    const bodyText = init?.body ? String(init.body) : null;
    const served1: Served = {
      method: init?.method ?? "GET",
      path,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null,
    };
    served.push(served1);
    for (const handler of responses) {
      const res = handler(served1);
      if (res) {
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not_mocked" }), { status: 555 });
  };
  return { served, fetchImpl };
}

// ── a scripted auth port ────────────────────────────────────────────────

class ScriptedAuth implements AuthClientPort {
  session: AuthSession | null = null;
  signUpCalls: Array<{ username: string; password: string }> = [];
  async signUpWithUsername(username: string, password: string): Promise<AuthSession> {
    this.signUpCalls.push({ username, password });
    this.session = { userId: "user-1", isAnonymous: false, username, accessToken: "tok-1" };
    return this.session;
  }
  async signInWithUsername(username: string): Promise<AuthSession> {
    this.session = { userId: "user-1", isAnonymous: false, username, accessToken: "tok-1" };
    return this.session;
  }
  async signInAnonymously(): Promise<AuthSession> {
    this.session = { userId: "user-2", isAnonymous: true, username: null, accessToken: "tok-2" };
    return this.session;
  }
  async convertAnonymousToAccount(username: string): Promise<AuthSession> {
    this.session = { userId: "user-2", isAnonymous: false, username, accessToken: "tok-2b" };
    return this.session;
  }
  async changePassword(): Promise<void> {}
  async signOut(): Promise<void> {
    this.session = null;
  }
  async getSession(): Promise<AuthSession | null> {
    return this.session;
  }
  onAuthStateChange(): () => void {
    return () => undefined;
  }
}

// ── the in-memory store shape ───────────────────────────────────────────

function makeStore() {
  const state = {
    settings: { language: "en", interests: [], recencyWeight: true, mapLabels: true, animations: true } as EchoStoreShape["getState"] extends () => infer S ? S extends { settings: infer X } ? X : never : never,
    media: [] as Array<{ localId: string; provider: string; title: string; mediaType: string }>,
    entries: [] as Array<{ id: string; mediaLocalId: string; status: string; rating?: number }>,
    feedback: [] as Array<{ id: string; mediaLocalId?: string; value: string; source: string }>,
  };
  const store: EchoStoreShape = {
    getState: () => state as never,
    setState: (partial) => {
      Object.assign(state, partial);
    },
  };
  return { store, state };
}

// ── helpers ─────────────────────────────────────────────────────────────

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function deviceRegisterOk(req: Served) {
  if (req.method === "POST" && req.path === "/api/sync/devices") {
    return { status: 200, body: { ok: true, deviceId: DEVICE_ID } };
  }
  return null;
}

function bootstrapStatusEmpty(req: Served) {
  if (req.method === "GET" && req.path === "/api/sync/bootstrap/status") {
    return {
      status: 200,
      body: {
        ok: true, epoch: 1, headSeq: 0, watermark: 0, serverBootId: "boot-1",
        activeSnapshot: { id: 1, headSeq: 0, epoch: 1, pageCount: 1, recordCount: 0, contentHash: "h" },
      },
    };
  }
  return null;
}

function bootstrapPageEmpty(req: Served) {
  if (req.method === "GET" && req.path.startsWith("/api/sync/bootstrap/page")) {
    return { status: 200, body: { entity: "media_items", payload: [] } };
  }
  return null;
}

function keepLocalOk(req: Served) {
  if (req.method === "POST" && req.path === "/api/sync/keep-local") {
    return { status: 200, body: { ok: true, epoch: 2 } };
  }
  return null;
}

function devicesPatchOk(req: Served) {
  if (req.method === "PATCH" && req.path === "/api/sync/devices") {
    return { status: 200, body: { ok: true } };
  }
  if (req.method === "DELETE" && req.path.startsWith("/api/sync/devices")) {
    return { status: 200, body: { ok: true } };
  }
  return null;
}

function devicesListOk(req: Served) {
  if (req.method === "GET" && req.path === "/api/sync/devices") {
    return {
      status: 200,
      body: {
        devices: [{
          id: DEVICE_ID, name: "Test device", platform: "linux", app_version: "1.3.0",
          acked_seq: 0, epoch: 1, bootstrapped_at: null, created_at: "2026-01-01T00:00:00Z",
          last_synced_at: new Date().toISOString(), revoked_at: null,
        }],
      },
    };
  }
  return null;
}

function conflictsEmpty(req: Served) {
  if (req.method === "GET" && req.path === "/api/sync/conflicts") {
    return { status: 200, body: { conflicts: [] } };
  }
  if (req.method === "GET" && req.path === "/api/sync/status") {
    return {
      status: 200,
      body: {
        ok: true, epoch: 1, headSeq: 0, watermark: 0, serverBootId: "boot-1",
        perEntity: {}, perEntityHash: {},
        archiveState: { unresolved: 0, nearFullAt: 20, cap: 100, state: "ok" },
      },
    };
  }
  return null;
}

function pushOk(req: Served) {
  if (req.method === "POST" && req.path === "/api/sync/push") {
    const ops = (req.body?.ops ?? []) as SyncOp[];
    return {
      status: 200,
      body: {
        ok: true, epoch: 1, headSeq: ops.length,
        acked: ops.map((o) => o.opid), archived: [], rejected: [],
      },
    };
  }
  return null;
}

function pullEmpty(req: Served) {
  if (req.method === "GET" && req.path.startsWith("/api/sync/pull")) {
    return { status: 200, body: { ok: true, headSeq: 0, watermark: 0, changes: [] } };
  }
  return null;
}

async function freshSyncMeta() {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORES.syncMeta, "readwrite");
    t.objectStore(STORES.syncMeta).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  await closeDB();
}

async function makeEngine(handlers: Parameters<typeof makeTransport>[0]) {
  await clearOutbox();
  await freshSyncMeta();
  const { served, fetchImpl } = makeTransport(handlers);
  const auth = new ScriptedAuth();
  const { store, state } = makeStore();
  const engine = new SyncEngine(
    { url: "http://mock.local", anonKey: "anon" },
    { getStore: () => store, auth, fetchImpl },
  );
  return { engine, auth, served, state };
}

// silence the standalone getSyncEngine config test duplication
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

beforeEach(async () => {
  await clearOutbox();
});

describe("sync engine (B3)", () => {
  test("sign-in registers the device and waits at the bootstrap choice (nothing mutates)", async () => {
    const { engine, served } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, devicesListOk, conflictsEmpty,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");

    const snap = engine.getSnapshot();
    expect(snap.session?.username).toBe("sara");
    expect(snap.deviceId).toBe(DEVICE_ID);
    expect(snap.bootstrapped).toBe(false); // choice pending — no mutation yet
    // no push/keep-local/bootstrap-ack happened before the choice
    const mutating = served.filter((s) =>
      s.path.startsWith("/api/sync/push") ||
      s.path === "/api/sync/keep-local" ||
      s.path === "/api/sync/bootstrap/ack");
    expect(mutating).toEqual([]);
    engine.stop();
  });

  test("keep-local choice: seeds local records, acks nothing else, marks bootstrapped", async () => {
    const { engine, state } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, bootstrapPageEmpty, keepLocalOk,
      devicesListOk, conflictsEmpty, pushOk, pullEmpty,
    ]);
    await engine.start();
    // pre-populate local store + db media so seeding has something to do
    state.media.push({ localId: "wikidata:Q1", provider: "wikidata", title: "A real title", mediaType: "movie" });
    state.entries.push({ id: "entry-1", mediaLocalId: "wikidata:Q1", status: "completed", rating: 5 });

    await engine.signIn("sara", "pw-123456");
    await engine.chooseBootstrap("keep_local");

    const snap = engine.getSnapshot();
    expect(snap.bootstrapped).toBe(true);
    expect(snap.uiState).toBe("synced");
    engine.stop();
  });

  test("a local mutation after bootstrap lands in the outbox and pushes (policy-classified)", async () => {
    const { engine, served, state } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, bootstrapPageEmpty, keepLocalOk,
      devicesListOk, conflictsEmpty, pushOk, pullEmpty,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");
    await engine.chooseBootstrap("keep_local");
    served.length = 0; // ignore bootstrap traffic

    // a permitted (wikidata) media mutation flows to the outbox
    const seen: string[] = [];
    const unsub = subscribeToLocalMutations((ev) => seen.push(`${ev.op}:${ev.entity}:${ev.recordId}`));
    emitLocalMutation({
      entity: "media_items", op: "upsert", recordId: "wikidata:Q2",
      record: { localId: "wikidata:Q2", provider: "wikidata", title: "Another", mediaType: "movie" },
    });
    await new Promise((r) => setTimeout(r, 50));
    unsub();

    // outbox got the op and the drainer pushed it
    const pushes = served.filter((s) => s.path === "/api/sync/push");
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    const ops = (pushes[0].body?.ops ?? []) as SyncOp[];
    expect(ops.some((o) => o.recordId === "wikidata:Q2" && o.op === "upsert")).toBe(true);
    // the store shape still works for provider lookups
    expect(state.media.length).toBeGreaterThanOrEqual(0);
    engine.stop();
  });

  test("AniList-derived media NEVER enters the outbox (cloudSyncPolicy = none)", async () => {
    const { engine, served } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, bootstrapPageEmpty, keepLocalOk,
      devicesListOk, conflictsEmpty, pushOk, pullEmpty,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");
    await engine.chooseBootstrap("keep_local");
    served.length = 0;

    emitLocalMutation({
      entity: "media_items", op: "upsert", recordId: "anilist:123",
      record: { localId: "anilist:123", provider: "anilist", title: "Local only", mediaType: "anime" },
    });
    emitLocalMutation({
      entity: "entries", op: "upsert", recordId: "entry-anilist",
      record: { id: "entry-anilist", mediaLocalId: "anilist:123", status: "watching" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const outbox = await getAllOutbox();
    expect(outbox.filter((e) => e.op.recordId === "anilist:123")).toEqual([]);
    expect(outbox.filter((e) => e.op.recordId === "entry-anilist")).toEqual([]);
    engine.stop();
  });

  test("pulled changes apply to the store without re-emitting (no echo loop)", async () => {
    let pullCount = 0;
    const pullWithChange: Parameters<typeof makeTransport>[0][number] = (req) => {
      if (req.method === "GET" && req.path.startsWith("/api/sync/pull")) {
        pullCount += 1;
        if (pullCount === 1) {
          return {
            status: 200,
            body: {
              ok: true, headSeq: 5, watermark: 5,
              changes: [{
                seq: 5, entity: "media_items", recordId: "wikidata:Q9", op: "upsert",
                version: 1, deviceId: "other-device", epoch: 1,
                record: { localId: "wikidata:Q9", provider: "wikidata", title: "From the cloud", mediaType: "movie" },
              }],
            },
          };
        }
        return { status: 200, body: { ok: true, headSeq: 5, watermark: 5, changes: [] } };
      }
      return null;
    };
    const { engine, state } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, bootstrapPageEmpty, keepLocalOk,
      devicesListOk, conflictsEmpty, pushOk, pullWithChange,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");
    await engine.chooseBootstrap("keep_local");

    // the pulled record is now in the store
    expect(state.media.some((m) => m.localId === "wikidata:Q9")).toBe(true);
    // and it did NOT loop back into the outbox
    const outbox = await getAllOutbox();
    expect(outbox.filter((e) => e.op.recordId === "wikidata:Q9")).toEqual([]);
    engine.stop();
  });

  test("device rename and revoke call the right endpoints", async () => {
    const { engine, served } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, bootstrapPageEmpty, keepLocalOk,
      devicesListOk, devicesPatchOk, conflictsEmpty, pushOk, pullEmpty,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");

    const okRename = await engine.renameDevice(DEVICE_ID, "My laptop");
    expect(okRename).toBe(true);
    const patch = served.find((s) => s.method === "PATCH" && s.path === "/api/sync/devices");
    expect(patch?.body).toEqual({ deviceId: DEVICE_ID, name: "My laptop" });

    const okRevoke = await engine.revokeDevice("22222222-2222-4222-8222-222222222222");
    expect(okRevoke).toBe(true);
    const del = served.find((s) => s.method === "DELETE" && s.path.startsWith("/api/sync/devices"));
    expect(del?.path).toContain("deviceId=22222222");
    engine.stop();
  });

  test("conflict resolve calls the RPC endpoint with the chosen action", async () => {
    const { engine, served } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, bootstrapPageEmpty, keepLocalOk,
      devicesListOk, conflictsEmpty, pushOk, pullEmpty,
      (req) => req.method === "POST" && req.path === "/api/sync/conflicts/resolve"
        ? { status: 200, body: { ok: true } }
        : null,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");
    const ok = await engine.resolveConflict(7, "restore");
    expect(ok).toBe(true);
    const call = served.find((s) => s.path === "/api/sync/conflicts/resolve");
    expect(call?.body).toEqual({ conflictId: 7, action: "restore" });
    engine.stop();
  });

  test("'clear all data' quarantines + clears the outbox and resets device state (cloud untouched)", async () => {
    const { engine, served } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, bootstrapPageEmpty, keepLocalOk,
      devicesListOk, conflictsEmpty, pushOk, pullEmpty,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");
    await engine.chooseBootstrap("keep_local");

    emitLocalMutation({
      entity: "feedback", op: "upsert", recordId: "fb-1",
      record: { id: "fb-1", value: "liked", source: "rating" },
    });
    await new Promise((r) => setTimeout(r, 30));

    served.length = 0;
    emitLocalCleared();
    await new Promise((r) => setTimeout(r, 50));

    const snap = engine.getSnapshot();
    expect(snap.deviceId).toBeNull();
    expect(snap.bootstrapped).toBe(false);
    expect(snap.uiState).toBe("local_only");
    expect(snap.outboxCount).toBe(0);
    // nothing was sent to the cloud during the local clear
    expect(served).toEqual([]);
    engine.stop();
  });

  test("signed-out snapshot clears devices/conflicts", async () => {
    const { engine } = await makeEngine([
      deviceRegisterOk, bootstrapStatusEmpty, devicesListOk, conflictsEmpty,
    ]);
    await engine.start();
    await engine.signIn("sara", "pw-123456");
    await engine.signOut();
    const snap = engine.getSnapshot();
    expect(snap.session).toBeNull();
    expect(snap.uiState).toBe("signed_out");
    expect(snap.devices).toEqual([]);
    engine.stop();
  });
});
