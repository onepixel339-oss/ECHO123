/**
 * ECHO — B3 client legs: device manager, reconciliation watchdog,
 * BroadcastChannel leader election (v1.1 §9.2/§10.3 + B3 list).
 *
 * Correctness never depends on the BroadcastChannel nudge or the
 * reconciliation watchdog — both are accelerants/self-healing checks on top
 * of the pull/push protocol (Supabase Realtime, when enabled later, is the
 * same: a nudge, never a correctness dependency).
 */

import type { DeviceRow, SyncStatusResponse } from "./types";

/** The device-management view model (list, rename, revoke, explain status). */
export interface DeviceViewModel {
  id: string;
  name: string;
  platform: string | null;
  isCurrent: boolean;
  lastSyncedAt: string | null;
  revoked: boolean;
  /** EN/AR copy key: "this device" | "active" | "inactive" | "revoked" */
  stateKey: "this_device" | "active" | "inactive" | "revoked";
}

export function toDeviceViewModels(rows: DeviceRow[], currentDeviceId: string | null): DeviceViewModel[] {
  const now = Date.now();
  return rows.map((d) => {
    const last = d.last_synced_at ? Date.parse(d.last_synced_at) : null;
    const active = last !== null && now - last < 7 * 24 * 3600 * 1000;
    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      isCurrent: d.id === currentDeviceId,
      lastSyncedAt: d.last_synced_at,
      revoked: d.revoked_at !== null,
      stateKey:
        d.revoked_at !== null ? "revoked"
        : d.id === currentDeviceId ? "this_device"
        : active ? "active" : "inactive",
    };
  });
}

/** Session counter for the watchdog cadence (weekly + every 20th session). */
export class SessionCounter {
  private count: number;
  private lastWatchdogAt: number;
  constructor(count = 0, lastWatchdogAt = 0) {
    this.count = count;
    this.lastWatchdogAt = lastWatchdogAt;
  }
  next(nowMs: number): { count: number; watchdogDue: boolean } {
    this.count += 1;
    const weeklyDue = nowMs - this.lastWatchdogAt >= 7 * 24 * 3600 * 1000;
    const every20th = this.count % 20 === 0;
    const watchdogDue = (weeklyDue && this.count > 1) || every20th;
    if (watchdogDue) this.lastWatchdogAt = nowMs;
    return { count: this.count, watchdogDue };
  }
}

/** The drift verdict from comparing per-entity hashes (v1.1 §10.3). */
export interface ReconcileVerdict {
  drifted: string[];        // entities whose hash mismatch
  unknownEntities: string[]; // local entities the server report lacks
}

export function compareHashes(
  local: Record<string, string>,
  server: Record<string, string>,
): ReconcileVerdict {
  const drifted: string[] = [];
  const unknownEntities: string[] = [];
  for (const [entity, hash] of Object.entries(local)) {
    if (!(entity in server)) unknownEntities.push(entity);
    else if (server[entity] !== hash) drifted.push(entity);
  }
  return { drifted, unknownEntities };
}

/** Watchdog decision: targeted re-pull vs guided re-bootstrap vs healthy. */
export function watchdogAction(verdict: ReconcileVerdict, cursorExpired: boolean): {
  action: "healthy" | "targeted_repull" | "guided_rebootstrap";
  entities: string[];
} {
  if (cursorExpired) return { action: "guided_rebootstrap", entities: [] };
  if (verdict.drifted.length > 0 || verdict.unknownEntities.length > 0) {
    return { action: "targeted_repull", entities: [...verdict.drifted, ...verdict.unknownEntities] };
  }
  return { action: "healthy", entities: [] };
}

/** Conflict-card view model (the bilingual viewer's rows). */
export interface ConflictCard {
  conflictId: number;
  entity: string;
  recordId: string;
  reason: string;
  /** EN/AR copy key for the reason. */
  reasonKey: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  canRestore: boolean;
}

export function toConflictCards(rows: Array<Record<string, unknown>>): ConflictCard[] {
  return rows.map((r) => {
    const reason = String(r.reason ?? "schema");
    return {
      conflictId: Number(r.id),
      entity: String(r.entity ?? ""),
      recordId: String(r.record_id ?? ""),
      reason,
      reasonKey: `conflict_reason_${reason}`,
      createdAt: String(r.created_at ?? ""),
      resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
      resolution: r.resolution ? String(r.resolution) : null,
      canRestore: r.resolved_at === null && reason !== "applied_delete" ? true : true,
    };
  });
}

/**
 * archiveState surfacing (§5.3.5): the near_full banner and the paused
 * state are ALWAYS visible — never hidden backpressure.
 */
export function archiveStateCopy(status: SyncStatusResponse): {
  banner: "none" | "near_full" | "paused";
  unresolved: number;
  cap: number;
} {
  const s = status.archiveState.state;
  return {
    banner: s === "full" ? "paused" : s === "near_full" ? "near_full" : "none",
    unresolved: status.archiveState.unresolved,
    cap: status.archiveState.cap,
  };
}

/**
 * BroadcastChannel leader election (single drainer across tabs — v1.1 §9.2).
 * Correctness never depends on it: worst case two tabs drain concurrently
 * and the server's opid dedupe absorbs the overlap.
 */
export class TabLeader {
  private channel: BroadcastChannel | null = null;
  private isLeader = false;
  private readonly id = `tab-${Math.random().toString(36).slice(2)}`;

  constructor(
    private onBecomeLeader: () => void,
    private onLoseLeadership: () => void,
  ) {}

  start(): void {
    if (typeof BroadcastChannel === "undefined") {
      // single-tab environment: this tab is the leader by default
      this.isLeader = true;
      this.onBecomeLeader();
      return;
    }
    this.channel = new BroadcastChannel("echo-sync-leader");
    this.channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; from: string };
      if (data?.type === "leader-announce" && data.from !== this.id && this.isLeader) {
        // two leaders: the lexicographically smaller id wins
        if (data.from < this.id) this.stepDown();
      }
      if (data?.type === "leader-stepdown") {
        if (!this.isLeader) this.claim();
      }
    };
    this.claim();
  }

  private claim(): void {
    this.isLeader = true;
    this.channel?.postMessage({ type: "leader-announce", from: this.id });
    this.onBecomeLeader();
  }

  private stepDown(): void {
    this.isLeader = false;
    this.channel?.postMessage({ type: "leader-stepdown", from: this.id });
    this.onLoseLeadership();
  }

  stop(): void {
    if (this.isLeader) this.stepDown();
    this.channel?.close();
    this.channel = null;
  }

  leading(): boolean {
    return this.isLeader;
  }
}
