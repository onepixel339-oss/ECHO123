/**
 * B3 client-leg tests: device view models, reconciliation watchdog,
 * conflict cards, archiveState surfacing, tab leader election.
 */
import { describe, expect, test } from "bun:test";
import {
  toDeviceViewModels, SessionCounter, compareHashes, watchdogAction,
  toConflictCards, archiveStateCopy, TabLeader,
} from "../../sync/deviceManager";
import type { DeviceRow, SyncStatusResponse } from "../../sync/types";

const dev = (over: Partial<DeviceRow>): DeviceRow => ({
  id: "d-1", name: "Device", platform: "linux", app_version: null,
  acked_seq: 0, epoch: 1, bootstrapped_at: null, created_at: "2026-11-01T00:00:00Z",
  last_synced_at: null, revoked_at: null, ...over,
});

describe("device view models", () => {
  test("state keys: this device / active / inactive / revoked", () => {
    const now = Date.now();
    const rows = [
      dev({ id: "current", last_synced_at: new Date(now - 1000).toISOString() }),
      dev({ id: "fresh", name: "Fresh", last_synced_at: new Date(now - 3600_000).toISOString() }),
      dev({ id: "old", name: "Old", last_synced_at: new Date(now - 30 * 24 * 3600_000).toISOString() }),
      dev({ id: "gone", name: "Gone", revoked_at: new Date().toISOString() }),
      dev({ id: "never", name: "Never", last_synced_at: null }),
    ];
    const vms = toDeviceViewModels(rows, "current");
    expect(vms.find((v) => v.id === "current")?.stateKey).toBe("this_device");
    expect(vms.find((v) => v.id === "fresh")?.stateKey).toBe("active");
    expect(vms.find((v) => v.id === "old")?.stateKey).toBe("inactive");
    expect(vms.find((v) => v.id === "gone")?.stateKey).toBe("revoked");
    expect(vms.find((v) => v.id === "never")?.stateKey).toBe("inactive");
  });
});

describe("reconciliation watchdog", () => {
  test("cadence: every 20th session or weekly (not the first)", () => {
    const c = new SessionCounter(0, 0);
    expect(c.next(1000).watchdogDue).toBe(false); // first session: no
    for (let i = 0; i < 18; i++) c.next(2000);
    const r = c.next(3000);
    expect(r.count).toBe(20);
    expect(r.watchdogDue).toBe(true); // 20th session
    const c2 = new SessionCounter(3, 0);
    expect(c2.next(8 * 24 * 3600 * 1000).watchdogDue).toBe(true); // weekly
  });

  test("hash comparison detects the drifted entity only", () => {
    const v = compareHashes(
      { media_items: "aaa", entries: "bbb", feedback: "ccc" },
      { media_items: "aaa", entries: "CHANGED", feedback: "ccc" },
    );
    expect(v.drifted).toEqual(["entries"]);
    expect(v.unknownEntities).toEqual([]);
  });

  test("watchdog action: healthy / targeted re-pull / guided re-bootstrap", () => {
    expect(watchdogAction({ drifted: [], unknownEntities: [] }, false).action).toBe("healthy");
    const t = watchdogAction({ drifted: ["entries"], unknownEntities: ["works"] }, false);
    expect(t.action).toBe("targeted_repull");
    expect(t.entities).toEqual(["entries", "works"]);
    expect(watchdogAction({ drifted: [], unknownEntities: [] }, true).action).toBe("guided_rebootstrap");
  });
});

describe("conflict cards + archiveState surfacing", () => {
  test("cards map DB rows to view models with copy keys", () => {
    const cards = toConflictCards([
      { id: 7, entity: "media_items", record_id: "m-1", reason: "delete_vs_edit", created_at: "t", resolved_at: null, resolution: null },
      { id: 8, entity: "entries", record_id: "e-1", reason: "applied_delete", created_at: "t", resolved_at: "t2", resolution: "restored" },
    ]);
    expect(cards[0].reasonKey).toBe("conflict_reason_delete_vs_edit");
    expect(cards[0].canRestore).toBe(true);
    expect(cards[1].resolvedAt).toBe("t2");
  });

  test("archiveState: near_full banner at 160; paused at 200 — never hidden", () => {
    const mk = (state: string): SyncStatusResponse => ({
      ok: true, epoch: 1, headSeq: 1, watermark: 1, serverBootId: "b",
      perEntity: {}, perEntityHash: {},
      archiveState: { unresolved: state === "full" ? 200 : state === "near_full" ? 160 : 5, nearFullAt: 160, cap: 200, state: state as "ok" },
    });
    expect(archiveStateCopy(mk("ok")).banner).toBe("none");
    expect(archiveStateCopy(mk("near_full")).banner).toBe("near_full");
    expect(archiveStateCopy(mk("full"))).toEqual({ banner: "paused", unresolved: 200, cap: 200 });
  });
});

describe("tab leader election (BroadcastChannel)", () => {
  test("without BroadcastChannel the single tab leads", () => {
    let led = false;
    const leader = new TabLeader(() => { led = true; }, () => {});
    leader.start();
    expect(led).toBe(true);
    expect(leader.leading()).toBe(true);
    leader.stop();
  });
});
