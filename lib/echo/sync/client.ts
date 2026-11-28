/**
 * ECHO — SyncClient: the client-side orchestrator (B2).
 *
 * Local mutation → IndexedDB write + outbox append (the primary write is
 * ALWAYS local). The drainer pushes ≤200-op batches (single-flight); the
 * pull scheduler runs on start, after a push ack, every 5 minutes online,
 * and on a Realtime nudge (correctness never depends on the nudge).
 * Echo suppression: skip changes this device authored (opid ledger) and
 * changes whose version ≤ the locally applied version.
 *
 * Degraded behavior is the local-first spine: any transport failure maps to
 * a passive degraded state with full local functionality; the outbox is
 * NEVER discarded without a per-op ack (§10.2.6 rule 3); a 409 cursor_expired
 * or epoch mismatch routes through the bootstrap choice UI — never a silent
 * divergence.
 */

import type {
  PullResponse, PullChange, PushResponse, SyncState, SyncUiState, TransportClass,
  BootstrapStatusResponse, SyncOp, BootstrapIntent,
} from "./types";
import {
  classifyResponse, classifyRpcError, nextBackoffMs, retryDue,
} from "./transport";
import {
  getAllOutbox, selectBatch, removeAcked, markAttempted, appendOps, collapseOutbox,
} from "./outbox";
import { openDB, STORES } from "../localdb";
import { nextOpid } from "./opid";

export interface SyncEndpoints {
  push: (deviceId: string, ops: SyncOp[], epoch: number | null) => Promise<Response>;
  pull: (deviceId: string, since: number, limit?: number) => Promise<Response>;
  status: () => Promise<Response>;
  bootstrapStatus: () => Promise<Response>;
}

export interface SyncClientDeps {
  endpoints: SyncEndpoints;
  /** apply a pulled change to local stores; returns the applied version */
  applyChange: (change: PullResponse["changes"][number]) => Promise<void>;
  /** observed-version feed: EVERY pulled change reports its version, own
   *  edits included (echo-suppressed for application, still versioned) */
  onPulledVersion?: (entity: PullChange["entity"], recordId: string, version: number) => void;
  onUiState?: (state: SyncUiState) => void;
  onConflicts?: (archived: PushResponse["archived"]) => void;
  now?: () => number;
}

const PULL_INTERVAL_MS = 5 * 60 * 1000;

export class SyncClient {
  private state: SyncState = {
    deviceId: null,
    deviceName: null,
    cursor: 0,
    epoch: 1,
    serverBootId: null,
    bootstrapped: false,
    bootstrapIntent: null,
    bootstrapProgress: null,
    opidCounter: 0,
    lastPushAt: null,
  };
  private uiState: SyncUiState = "off";
  private draining = false;
  private pulling = false;
  private failureCount = 0;
  private lastAttempt = 0;
  private backoffMs = 0;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private deps: SyncClientDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ── state persistence (syncMeta store, key "sync") ──
  async loadState(): Promise<SyncState> {
    const db = await openDB();
    const value = await new Promise<SyncState | undefined>((resolve, reject) => {
      const t = db.transaction(STORES.syncMeta, "readonly");
      const req = t.objectStore(STORES.syncMeta).get("sync");
      req.onsuccess = () => resolve(req.result as SyncState | undefined);
      req.onerror = () => reject(req.error);
    });
    if (value) this.state = { ...this.state, ...value };
    return this.state;
  }

  private async persistState(): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORES.syncMeta, "readwrite");
      t.objectStore(STORES.syncMeta).put(this.state, "sync");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  getUiState(): SyncUiState {
    return this.uiState;
  }
  getState(): SyncState {
    return this.state;
  }

  /** Engine-driven state setters (B3 wiring). */
  setUiState(next: SyncUiState): void {
    this.setUi(next);
  }

  setSignedOut(): void {
    this.setUi("signed_out");
  }

  async persistIntent(intent: {
    id: string;
    kind: "merge" | "keep_local" | "replace_local";
    phase: BootstrapIntent["phase"];
  }): Promise<void> {
    this.state.bootstrapIntent = intent;
    await this.persistState();
  }

  async setIntentPhase(phase: BootstrapIntent["phase"]): Promise<void> {
    if (!this.state.bootstrapIntent) return;
    this.state.bootstrapIntent = { ...this.state.bootstrapIntent, phase };
    await this.persistState();
  }

  async setProgress(snapshotId: number, nextPage: number): Promise<void> {
    this.state.bootstrapProgress = { snapshotId, nextPage };
    await this.persistState();
  }

  async markBootstrapped(): Promise<void> {
    this.state.bootstrapped = true;
    this.state.bootstrapIntent = null;
    this.state.bootstrapProgress = null;
    await this.persistState();
    this.setUi("synced");
  }

  /** opid counter for engine-built ops (persisted with the state). */
  nextOpidForNumber(): number {
    this.state.opidCounter += 1;
    void this.persistState();
    return this.state.opidCounter;
  }

  /** "Clear all data" on this device: sync state reset, cloud untouched. */
  resetDeviceState(): void {
    this.state.deviceId = null;
    this.state.deviceName = null;
    this.state.cursor = 0;
    this.state.epoch = 1;
    this.state.serverBootId = null;
    this.state.bootstrapped = false;
    this.state.bootstrapIntent = null;
    this.state.bootstrapProgress = null;
    void this.persistState();
    this.setUi("local_only");
  }

  private setUi(next: SyncUiState) {
    this.uiState = next;
    this.deps.onUiState?.(next);
  }

  attachDevice(deviceId: string, name: string) {
    this.state.deviceId = deviceId;
    this.state.deviceName = name;
    void this.persistState();
  }

  // ── outbox interaction ──
  async enqueue(ops: SyncOp[]): Promise<void> {
    await appendOps(ops);
    void this.drain();
  }

  nextOpidFor(): string {
    this.state.opidCounter += 1;
    void this.persistState();
    return nextOpid(this.state.deviceId ?? "nodevice", this.state.opidCounter);
  }

  // ── push drainer (single-flight) ──
  async drain(): Promise<void> {
    if (this.draining || !this.state.deviceId) return;
    this.draining = true;
    try {
      let entries = await getAllOutbox();
      if (entries.length > 5000) entries = collapseOutbox(entries);
      const batch = selectBatch(entries);
      if (batch.length === 0) return;

      if (this.backoffMs > 0 && !retryDue(this.lastAttempt, this.backoffMs, this.now())) return;

      this.setUi(this.uiState === "degraded" ? "degraded" : "syncing");
      const opids = batch.map((o) => o.opid);
      let response: Response;
      try {
        response = await this.deps.endpoints.push(
          this.state.deviceId, batch, this.state.epoch);
      } catch {
        this.recordFailure({ kind: "service_unavailable", sub: "generic" });
        return; // outbox intact — never discard without a per-op ack
      }
      const cls = await this.classifyHttp(response);
      if (cls.kind !== "contract") {
        await markAttempted(opids);
        this.recordFailure(cls);
        return;
      }
      const body = (await response.json()) as PushResponse;
      this.failureCount = 0;
      this.backoffMs = 0;

      // remove ONLY the processed ops (acked + archived); rejected retained
      const processed = new Set<string>(body.acked);
      for (const arc of body.archived) processed.add(arc.opid);
      await removeAcked([...processed]);
      if (body.archived.length > 0) this.deps.onConflicts?.(body.archived);

      this.state.epoch = body.epoch;
      this.state.lastPushAt = this.now();
      await this.persistState();
      this.setUi("synced");
      void this.pullCycle(); // pull after push ack
    } finally {
      this.draining = false;
    }
  }

  // ── pull scheduler ──
  startPullScheduler() {
    this.stopPullScheduler();
    void this.pullCycle();
    this.pullTimer = setInterval(() => void this.pullCycle(), PULL_INTERVAL_MS);
  }
  stopPullScheduler() {
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pullTimer = null;
  }

  async pullCycle(): Promise<void> {
    if (this.pulling || !this.state.deviceId) return;
    this.pulling = true;
    try {
      let since = this.state.cursor;
      for (;;) {
        let response: Response;
        try {
          response = await this.deps.endpoints.pull(this.state.deviceId!, since);
        } catch {
          this.recordFailure({ kind: "service_unavailable", sub: "generic" });
          return;
        }
        const cls = await this.classifyHttp(response);
        if (cls.kind !== "contract") {
          this.recordFailure(cls);
          return;
        }
        const body = (await response.json()) as PullResponse;
        for (const change of body.changes) {
          if (change.op === "epoch_reset") {
            this.state.cursor = change.seq;
            this.setUi("must_rebootstrap");
            await this.persistState();
            continue;
          }
          // observed-version feed: every change reports, own edits included
          this.deps.onPulledVersion?.(change.entity, change.recordId, change.version);
          // echo suppression: skip own opids and already-applied versions
          if (change.deviceId === this.state.deviceId) continue;
          await this.deps.applyChange(change);
        }
        since = body.changes.length > 0 ? body.changes[body.changes.length - 1].seq : since;
        this.state.cursor = since; // cursor advances per fully-applied page
        await this.persistState();
        if (body.changes.length === 0) break;
      }
      this.failureCount = 0;
      this.backoffMs = 0;
      this.setUi("synced");
    } finally {
      this.pulling = false;
    }
  }

  // ── failure handling / backoff ladder (§10.2.6) ──
  private recordFailure(cls: TransportClass) {
    this.failureCount += 1;
    this.lastAttempt = this.now();
    this.backoffMs = nextBackoffMs(this.failureCount, cls, this.now());
    switch (cls.kind) {
      case "auth_expired":
        this.setUi("signed_out");
        break;
      case "device_not_found":
      case "device_revoked":
        // re-registration flow; NEVER discard queued outbox ops
        this.state.deviceId = null;
        void this.persistState();
        this.setUi("local_only");
        break;
      case "cursor_expired":
      case "epoch_mismatch":
        this.setUi("must_rebootstrap");
        break;
      case "app_429":
        this.backoffMs = cls.retryAfterMs ?? nextBackoffMs(this.failureCount, cls, this.now());
        this.setUi("degraded");
        break;
      default:
        // service_unavailable — the designed offline mode: passive indicator,
        // full local functionality, sync resumes transparently
        this.setUi("degraded");
    }
  }

  private async classifyHttp(response: Response): Promise<TransportClass> {
    // typed RPC errors arrive as JSON {error: code} with 4xx/5xx
    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch {
      return { kind: "service_unavailable", sub: "generic" };
    }
    const cls = classifyResponse({
      status: response.status,
      bodyText,
      contentType: response.headers.get("content-type") ?? "",
    });
    if (
      cls.kind === "service_unavailable" ||
      response.status === 409 || response.status === 403 ||
      response.status === 404 || response.status === 401
    ) {
      try {
        const parsed = JSON.parse(bodyText) as { error?: string };
        if (parsed?.error) return classifyRpcError(response.status, parsed.error);
      } catch {
        /* HTML platform page — keep the platform classification */
      }
    }
    return cls;
  }

  // Fire-and-forget bootstrap status check (the full bootstrap flow runs in
  // the Settings/sync UI where the choice is presented).
  async checkBootstrapStatus(): Promise<BootstrapStatusResponse | null> {
    try {
      const response = await this.deps.endpoints.bootstrapStatus();
      const cls = await this.classifyHttp(response);
      if (cls.kind !== "contract") return null;
      return (await response.json()) as BootstrapStatusResponse;
    } catch {
      return null;
    }
  }
}
