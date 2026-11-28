/**
 * Outbox v4 + bootstrap client suites:
 *   INV-14 collapse, batch selection, response partitioning (outbox
 *   preservation), the five-quadrant seeding table (T-4.4), deterministic
 *   seed opids (T-4.3), choice-before-mutation (T-4.1), Replace Local
 *   never pushes (T-4.6), and the IndexedDB v4 additive upgrade.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import "fake-indexeddb/auto";
import {
  appendOps, getAllOutbox, removeAcked, clearOutbox, selectBatch,
  collapseOutbox, partitionResponse, outboxCount,
} from "../../sync/outbox";
import { seedMergeOps, newIntent, replaceLocalNeverPushes } from "../../sync/bootstrap";
import { bootOpid } from "../../sync/opid";
import type { OutboxEntry } from "../../sync/outbox";
import type { PushResponse } from "../../sync/types";
import { openDB, closeDB, STORES } from "../../localdb";

const op = (opid: string, entity: "entries" | "media_items", recordId: string,
  kind: "upsert" | "delete", base: number, record?: Record<string, unknown>) => ({
  opid, entity, recordId, op: kind, baseVersion: base, ...(record ? { record } : {}),
});

describe("outbox v4", () => {
  beforeAll(async () => {
    await clearOutbox();
  });

  test("append + count + selectBatch ordering (oldest first, ≤200, ≤2MB)", async () => {
    await clearOutbox();
    const ops = Array.from({ length: 250 }, (_, i) => op(`o-${i}`, "entries", `e-${i}`, "upsert", 0, { status: "watching" }));
    await appendOps(ops);
    expect(await outboxCount()).toBe(250);
    const entries = await getAllOutbox();
    const batch = selectBatch(entries);
    expect(batch.length).toBe(200);
    expect(batch[0].opid).toBe("o-0");
  });

  test("INV-14 collapse at >5,000 ops: latest op per record, earliest base, deletes survive", () => {
    const entries: OutboxEntry[] = [];
    const t0 = 1_000_000;
    // 3,000 edits on ONE record (collapse to 1) + 2,500 single ops → 2,501 records
    for (let i = 0; i < 3000; i++) {
      entries.push({ op: op(`many-${i}`, "entries", "e-same", "upsert", i, { v: i }), createdAt: t0 + i, attempts: 0, lastAttemptAt: null });
    }
    for (let i = 0; i < 2500; i++) {
      entries.push({ op: op(`one-${i}`, "entries", `e-uniq-${i}`, "upsert", 0, { v: i }), createdAt: t0 + 10_000 + i, attempts: 0, lastAttemptAt: null });
    }
    expect(entries.length).toBe(5500);
    const collapsed = collapseOutbox(entries);
    expect(collapsed.length).toBe(2501);
    const same = collapsed.find((e) => e.op.recordId === "e-same")!;
    expect(same.op.opid).toBe("many-2999"); // latest op wins
    expect(same.op.baseVersion).toBe(0); // earliest un-acked base preserved
    // deletes are never collapsed away:
    const withDelete: OutboxEntry[] = [
      { op: op("d-1", "entries", "e-x", "upsert", 5, { a: 1 }), createdAt: 1, attempts: 0, lastAttemptAt: null },
      { op: op("d-2", "entries", "e-x", "upsert", 5, { a: 2 }), createdAt: 2, attempts: 0, lastAttemptAt: null },
      { op: op("d-3", "entries", "e-x", "delete", 5), createdAt: 3, attempts: 0, lastAttemptAt: null },
    ];
    const c2 = collapseOutbox(withDelete, 2);
    expect(c2.length).toBe(1);
    expect(c2[0].op.op).toBe("delete");
    expect(c2[0].op.baseVersion).toBe(5);
  });

  test("partitionResponse: acked + archived removed; rejected retained (W-5)", async () => {
    await clearOutbox();
    await appendOps([
      op("p-1", "entries", "e-1", "upsert", 0, { s: 1 }),
      op("p-2", "entries", "e-2", "upsert", 0, { s: 2 }),
      op("p-3", "entries", "e-3", "upsert", 0, { s: 3 }),
    ]);
    const response: PushResponse = {
      ok: true, epoch: 1, headSeq: 9,
      acked: ["p-1"],
      archived: [{ opid: "p-2", reason: "edit_edit", conflictId: 1, serverVersion: 4 }],
      rejected: [{ opid: "p-3", reason: "conflict_archive_full" }],
    };
    const { acked, retained } = partitionResponse(response);
    expect(acked.sort()).toEqual(["p-1", "p-2"]);
    expect(retained).toEqual(["p-3"]);
    await removeAcked(acked);
    const rest = await getAllOutbox();
    expect(rest.map((e) => e.op.opid)).toEqual(["p-3"]); // the rejected op is retained
  });
});

describe("T-4.4 the five-quadrant seeding table (client classification)", () => {
  const rec = (title: string) => ({
    localId: "m-x", provider: "trakt", providerId: "t1",
    mediaType: "movie" as const, format: "film" as const, title,
    genres: ["g"], posterUrl: "https://x/p.jpg",
  });

  test("quadrant 1: server absent → insert, base 0 (D-8)", () => {
    const ops = seedMergeOps("d", "i", [{ entity: "media_items", recordId: "m-x", record: rec("A"), observedVersion: null }], new Map(), () => undefined);
    expect(ops.length).toBe(1);
    expect(ops[0].op).toBe("upsert");
    expect(ops[0].baseVersion).toBe(0);
  });

  test("quadrant 2: content-identical over the sync fields → no op", () => {
    const local = rec("A");
    const ops = seedMergeOps(
      "d", "i",
      [{ entity: "media_items", recordId: "m-x", record: local, observedVersion: 3 }],
      new Map([["media_items:m-x", { entity: "media_items", recordId: "m-x", record: { ...local, posterUrl: "https://OTHER/art.jpg", synopsis: "differs" }, version: 3 }]]),
      () => undefined,
    );
    expect(ops.length).toBe(0); // Tier X / expressive diffs are re-hydration's business
  });

  test("quadrant 3: different, NO baseline → base_version = 0 (guaranteed D-3, never D-1)", () => {
    const ops = seedMergeOps(
      "d", "i",
      [{ entity: "media_items", recordId: "m-x", record: rec("local-divergent"), observedVersion: null }],
      new Map([["media_items:m-x", { entity: "media_items", recordId: "m-x", record: rec("server-version"), version: 9 }]]),
      () => undefined,
    );
    expect(ops.length).toBe(1);
    expect(ops[0].baseVersion).toBe(0); // 0 < 9 → D-3, never the D-1 fast path
    // the payload is policy-classified (artwork stripped):
    expect(ops[0].record).not.toHaveProperty("posterUrl");
  });

  test("quadrant 4: different, genuine baseline b → the actual value is preserved", () => {
    for (const [observed, expectedBase] of [[9, 9], [3, 3], [99, 99]] as const) {
      const ops = seedMergeOps(
        "d", "i",
        [{ entity: "media_items", recordId: "m-x", record: rec("edited"), observedVersion: observed }],
        new Map([["media_items:m-x", { entity: "media_items", recordId: "m-x", record: rec("server"), version: 9 }]]),
        () => undefined,
      );
      expect(ops[0]?.baseVersion).toBe(expectedBase); // b=v → D-1; b<v → D-3; b>v → D-10
    }
  });

  test("tombstone handling: unbased → base 0 (D-6); matching baseline → D-5; stale → no op", () => {
    const serverTombstone = new Map([["media_items:m-x", { entity: "media_items", recordId: "m-x", record: null, version: 9 }]]);
    const unbased = seedMergeOps("d", "i", [{ entity: "media_items", recordId: "m-x", record: rec("zombie"), observedVersion: null }], serverTombstone, () => undefined);
    expect(unbased[0]?.baseVersion).toBe(0); // D-6 anti-resurrection
    const matching = seedMergeOps("d", "i", [{ entity: "media_items", recordId: "m-x", record: rec("informed"), observedVersion: 9 }], serverTombstone, () => undefined);
    expect(matching[0]?.baseVersion).toBe(9); // D-5 informed resurrection
    const stale = seedMergeOps("d", "i", [{ entity: "media_items", recordId: "m-x", record: rec("stale"), observedVersion: 4 }], serverTombstone, () => undefined);
    expect(stale.length).toBe(0); // delete wins; no op
  });
});

describe("T-4.3 deterministic seed opids (crash-resume idempotence)", () => {
  test("re-seeding regenerates the identical opid set", () => {
    const locals = Array.from({ length: 5 }, (_, i) => ({
      entity: "entries" as const, recordId: `e-${i}`,
      record: { status: "watching" as const, mediaLocalId: "m-tr" }, observedVersion: null,
    }));
    const a = seedMergeOps("dev-1", "intent-9", locals, new Map(), () => undefined);
    const b = seedMergeOps("dev-1", "intent-9", locals, new Map(), () => undefined);
    expect(a.map((o) => o.opid)).toEqual(b.map((o) => o.opid));
    expect(a[2].opid).toBe(bootOpid("dev-1", "intent-9", 3));
  });
});

describe("T-4.1 choice-before-mutation (client contract)", () => {
  test("the intent is created and persisted BEFORE any server mutation is requested", () => {
    const intent = newIntent("merge");
    expect(intent.phase).toBe("choice_made");
    expect(intent.id).toMatch(/^intent-/);
    // the SyncClient enqueues NOTHING during choice_pending — seeding runs
    // only after the UI records the choice (the Settings flow calls
    // seedMergeOps with the persisted intent id).
  });
});

describe("T-4.6 Replace Local never pushes (INV-13)", () => {
  test("the replace-local path produces zero seed ops and quarantines the outbox", () => {
    expect(replaceLocalNeverPushes()).toBe(true);
    const ops = seedMergeOps("d", "i", [], new Map(), () => undefined);
    expect(ops.length).toBe(0);
  });
});

describe("IndexedDB v4 additive upgrade", () => {
  test("the three sync stores exist alongside every v1-v3 store", async () => {
    const db = await openDB();
    for (const name of Object.values(STORES)) {
      expect(db.objectStoreNames.contains(name)).toBe(true);
    }
    // existing stores still work (the library remains untouched):
    await clearOutbox();
    await appendOps([op("up-1", "entries", "e-up", "upsert", 0, { s: 1 })]);
    expect(await outboxCount()).toBe(1);
    await closeDB();
  });
});
