/**
 * ECHO — the sync engine (B3 wiring): the runtime that connects auth,
 * SyncClient, the outbox, the store, and the Settings UI.
 *
 * Lifecycle:
 *   unconfigured → the engine is null; the app is fully local (the spine).
 *   configured + signed out → auth UI only; no device, no sync.
 *   signed in → device registration → bootstrap choice (merge / keep-local /
 *     replace-local) → snapshot transfer + delta drain (+ seeding for the
 *     local-first choices) → live push/pull.
 *
 * Correctness spine (unchanged from B2): local writes ALWAYS land first;
 * the outbox is never discarded without per-op acks; any transport failure
 * degrades passively; a 409/epoch mismatch routes through the bootstrap
 * choice UI — never a silent divergence.
 *
 * The engine is UI-framework-free: Settings consumes an immutable snapshot
 * through subscribe(); React state updates are the hook's concern.
 */

import { SyncClient } from "./client";
import {
  SupabaseAuthClient, AuthFlowError,
  type AuthSession, type AuthClientPort, type SupabasePublicConfig,
} from "./auth";
import type {
  SyncUiState, SyncOp, SyncEntity, PullChange,
  SyncStatusResponse, DeviceRow,
} from "./types";
import { toDeviceViewModels, toConflictCards, type DeviceViewModel, type ConflictCard } from "./deviceManager";
import { classifyMediaRecord, entrySyncable, classifyWorkRecord } from "./policy";
import { appendOps, outboxCount, quarantineOutbox, exportOutbox, clearOutbox } from "./outbox";
import { seedMergeOps, newIntent, type LocalRecordSnapshot, type ServerRecordSnapshot } from "./bootstrap";
import { subscribeToLocalMutations, subscribeToLocalClear, type LocalMutationEvent } from "./localMutations";
import { VersionLedger } from "./versionLedger";
import * as db from "../localdb";
import { nextOpid } from "./opid";
import type { AppSettings, MediaItem, UserMediaEntry, TasteFeedback, WorkRecord, WorkLink } from "../types";

/** Fields of AppSettings the sync layer carries (mirror of the server row). */
import { SYNCED_SETTINGS_KEYS } from "./localMutations";

export interface SyncEngineSnapshot {
  configured: boolean;
  uiState: SyncUiState;
  session: AuthSession | null;
  deviceId: string | null;
  deviceName: string | null;
  bootstrapped: boolean;
  bootstrapPhase: "choice_pending" | "choice_made" | "snapshot_transfer" | "delta_drain" | "seeding" | "done" | null;
  bootstrapProgress: { pages: number; done: number } | null;
  conflicts: ConflictCard[];
  devices: DeviceViewModel[];
  archive: { unresolved: number; cap: number; state: "ok" | "near_full" | "full" } | null;
  outboxCount: number;
  lastSyncedAt: number | null;
  busy: boolean;
}

export type BootstrapChoice = "merge" | "keep_local" | "replace_local";

type SnapshotListener = (s: SyncEngineSnapshot) => void;

export interface SyncEnginePorts {
  /** store bridge — injected so tests can run without the real zustand store */
  getStore: () => EchoStoreShape;
  auth?: AuthClientPort;
  fetchImpl?: typeof fetch;
}

/** The store surface the engine needs (satisfied by useEchoStore). */
export interface EchoStoreShape {
  getState: () => {
    settings: AppSettings;
    media: MediaItem[];
    entries: UserMediaEntry[];
    feedback: TasteFeedback[];
  };
  setState: (partial: Partial<{
    settings: AppSettings;
    media: MediaItem[];
    entries: UserMediaEntry[];
    feedback: TasteFeedback[];
  }>) => void;
}

export class SyncEngine {
  readonly config: SupabasePublicConfig;
  private client: SyncClient;
  private auth: AuthClientPort;
  private ledger = new VersionLedger();
  private session: AuthSession | null = null;
  private devices: DeviceViewModel[] = [];
  private conflicts: ConflictCard[] = [];
  private archive: SyncEngineSnapshot["archive"] = null;
  private boxCount = 0;
  private busy = false;
  private listeners = new Set<SnapshotListener>();
  private unsubMutationTap: (() => void) | null = null;
  private unsubClearTap: (() => void) | null = null;
  private unsubAuth: (() => void) | null = null;
  private started = false;
  private readonly fetchImpl: typeof fetch;
  private readonly getStore: () => EchoStoreShape;

  constructor(config: SupabasePublicConfig, ports: SyncEnginePorts) {
    this.config = config;
    this.getStore = ports.getStore;
    this.fetchImpl = ports.fetchImpl ?? (globalThis.fetch.bind(globalThis));
    this.auth = ports.auth ?? new SupabaseAuthClient(config);
    this.client = new SyncClient({
      endpoints: {
        push: (deviceId, ops, epoch) =>
          this.api("/api/sync/push", {
            method: "POST",
            body: JSON.stringify({ deviceId, ops, epoch }),
          }),
        pull: (deviceId, since, limit) =>
          this.api(`/api/sync/pull?deviceId=${encodeURIComponent(deviceId)}&since=${since}${limit ? `&limit=${limit}` : ""}`),
        status: () => this.api("/api/sync/status"),
        bootstrapStatus: () => this.api("/api/sync/bootstrap/status"),
      },
      applyChange: (change) => this.applyChange(change),
      onPulledVersion: (entity, recordId, version) => {
        void this.ledger.observe(entity, recordId, version);
      },
      onUiState: () => this.notify(),
      onConflicts: () => {
        // surface fresh conflict cards (the full list refreshes async)
        void this.refreshConflicts();
        this.notify();
      },
    });
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.client.loadState();
    this.unsubAuth = this.auth.onAuthStateChange((session) => {
      this.session = session;
      void this.onSessionChanged();
    });
    this.unsubMutationTap = subscribeToLocalMutations((ev) => void this.onLocalMutation(ev));
    this.unsubClearTap = subscribeToLocalClear(() => void this.disconnectLocal());
    // initial session read
    this.session = await this.auth.getSession().catch(() => null);
    await this.onSessionChanged();
  }

  stop(): void {
    this.unsubMutationTap?.();
    this.unsubClearTap?.();
    this.unsubAuth?.();
    this.client.stopPullScheduler();
    this.started = false;
  }

  private async onSessionChanged(): Promise<void> {
    if (!this.session) {
      this.client.setSignedOut();
      this.devices = [];
      this.conflicts = [];
      this.archive = null;
      this.client.stopPullScheduler();
      this.notify();
      return;
    }
    const state = this.client.getState();
    if (!state.deviceId) {
      await this.registerDevice();
    }
    if (state.deviceId && !state.bootstrapped) {
      // the Settings UI presents the bootstrap choice; nothing mutates until
      // the user chooses (choice-before-mutation)
      this.client.setUiState("local_only");
      void this.checkBootstrap();
    } else if (state.deviceId) {
      this.client.startPullScheduler();
      void this.refreshDevices().then(() => this.refreshConflicts());
    }
    this.notify();
  }

  private async registerDevice(): Promise<void> {
    try {
      const platform = detectPlatform();
      const res = await this.api("/api/sync/devices", {
        method: "POST",
        body: JSON.stringify({
          name: defaultDeviceName(),
          platform,
          appVersion: APP_VERSION_SYNC,
        }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { deviceId?: string };
      if (!body.deviceId) return;
      const name = defaultDeviceName();
      this.client.attachDevice(body.deviceId, name);
    } catch {
      // network down: the next sign-in attempt retries registration
    }
  }

  private async checkBootstrap(): Promise<void> {
    const status = await this.client.checkBootstrapStatus();
    if (!status) return;
    // persisted intent resume (crash after choice_made)
    const state = this.client.getState();
    if (state.bootstrapIntent && state.bootstrapIntent.phase !== "done" && state.bootstrapIntent.phase !== "choice_pending") {
      await this.resumeBootstrap(state.bootstrapIntent.kind, state.bootstrapIntent.id);
      return;
    }
    this.client.setUiState("local_only");
    this.notify();
  }

  // ── auth actions (UI entry points) ──

  async signUp(username: string, password: string): Promise<void> {
    this.busy = true;
    this.notify();
    try {
      this.session = await this.auth.signUpWithUsername(username, password);
      await this.onSessionChanged();
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  async signIn(username: string, password: string): Promise<void> {
    this.busy = true;
    this.notify();
    try {
      this.session = await this.auth.signInWithUsername(username, password);
      await this.onSessionChanged();
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  async startAnonymousBridge(): Promise<void> {
    this.busy = true;
    this.notify();
    try {
      this.session = await this.auth.signInAnonymously();
      await this.onSessionChanged();
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  async convertAnonymousToAccount(username: string, password: string): Promise<void> {
    this.busy = true;
    this.notify();
    try {
      this.session = await this.auth.convertAnonymousToAccount(username, password);
      this.notify();
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  async changePassword(current: string, next: string): Promise<void> {
    this.busy = true;
    this.notify();
    try {
      await this.auth.changePassword(current, next);
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.session = null;
    await this.onSessionChanged();
  }

  // ── bootstrap choice (the ONLY path that mutates sync state) ──

  async chooseBootstrap(kind: BootstrapChoice): Promise<void> {
    const state = this.client.getState();
    if (!state.deviceId || !this.session) return;
    const intent = newIntent(kind);
    await this.client.persistIntent(intent);
    await this.resumeBootstrap(kind, intent.id);
  }

  private async resumeBootstrap(kind: BootstrapChoice, intentId: string): Promise<void> {
    this.busy = true;
    try {
      await this.client.setIntentPhase("snapshot_transfer");
      this.notify();
      const status = await this.client.checkBootstrapStatus();
      if (!status) throw new Error("bootstrap_status_failed");
      const snapshot = status.activeSnapshot;
      const serverRecords = new Map<string, ServerRecordSnapshot>();

      if (kind === "replace_local" || kind === "merge") {
        for (let page = 1; page <= snapshot.pageCount; page++) {
          const res = await this.api(
            `/api/sync/bootstrap/page?snapshot=${snapshot.id}&page=${page}`,
          );
          if (!res.ok) throw new Error("bootstrap_page_failed");
          const body = (await res.json()) as {
            payload?: Array<{ record_id: string; version: number; record: Record<string, unknown> | null }>;
            entity?: string;
          };
          const items = body.payload ?? [];
          for (const item of items) {
            serverRecords.set(`${body.entity}:${item.record_id}`, {
              entity: body.entity as SyncEntity,
              recordId: item.record_id,
              record: item.record,
              version: item.version,
            });
          }
          await this.client.setProgress(snapshot.id, page);
          this.notify();
        }
      }

      // ── kind-specific step (BEFORE the delta drain, so drained records
      //    can never be captured into a seed set or re-emitted) ──
      if (kind === "replace_local") {
        // INV-13: never pushes — quarantine the outbox + wipe local stores,
        // then apply the downloaded snapshot
        const entries = await exportOutbox();
        await quarantineOutbox(entries);
        await clearOutbox();
        await db.clearAllLocalData();
        this.getStore().setState({
          media: [],
          entries: [],
          feedback: [],
        });
        await this.ledger.clear();
        for (const server of serverRecords.values()) {
          if (server.record !== null) await this.applyServerRecord(server);
        }
      } else if (kind === "keep_local") {
        await this.client.setIntentPhase("seeding");
        // typed confirm: epoch reset so the server adopts this device's
        // state as the single truth (v1.3 PATCH1 keep-local semantics)
        await this.api("/api/sync/keep-local", {
          method: "POST",
          body: JSON.stringify({ intentId }),
        });
        // seed every local record (unbased → base 0 → never a silent
        // overwrite; the server saw epoch_reset first so its prior state
        // was archived by the S-2 job)
        const ops = await this.buildSeedOps(intentId);
        await appendOps(ops);
      } else {
        // merge: seed local records that are new or genuinely divergent
        // against the snapshot baseline
        await this.client.setIntentPhase("seeding");
        const ops = await this.buildSeedOps(intentId, serverRecords);
        await appendOps(ops);
      }

      // ── delta drain: everything accumulated since the snapshot ──
      await this.client.setIntentPhase("delta_drain");
      await this.client.pullCycle();

      await this.client.setIntentPhase("done");
      await this.client.markBootstrapped();
      this.client.startPullScheduler();
      void this.client.drain();
      void this.refreshDevices().then(() => this.refreshConflicts());
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  private async buildSeedOps(
    intentId: string,
    serverRecords?: Map<string, ServerRecordSnapshot>,
  ): Promise<SyncOp[]> {
    const store = this.getStore().getState();
    const server = serverRecords ?? new Map<string, ServerRecordSnapshot>();
    const mediaProvider = (id: string) => store.media.find((m) => m.localId === id)?.provider;
    const local: LocalRecordSnapshot[] = [];
    for (const m of store.media) {
      local.push({ entity: "media_items", recordId: m.localId, record: m as unknown as Record<string, unknown>, observedVersion: await this.ledger.get("media_items", m.localId) });
    }
    for (const e of store.entries) {
      local.push({ entity: "entries", recordId: e.id, record: e as unknown as Record<string, unknown>, observedVersion: await this.ledger.get("entries", e.id) });
    }
    for (const f of store.feedback) {
      local.push({ entity: "feedback", recordId: f.id, record: f as unknown as Record<string, unknown>, observedVersion: await this.ledger.get("feedback", f.id) });
    }
    const works = await db.getAllWorks().catch(() => [] as WorkRecord[]);
    const workLinks = await db.getAllWorkLinks().catch(() => [] as WorkLink[]);
    for (const w of works) {
      local.push({ entity: "works", recordId: w.workId, record: w as unknown as Record<string, unknown>, observedVersion: await this.ledger.get("works", w.workId) });
    }
    for (const l of workLinks) {
      local.push({ entity: "work_links", recordId: l.id, record: l as unknown as Record<string, unknown>, observedVersion: await this.ledger.get("work_links", l.id) });
    }
    const state = this.client.getState();
    return seedMergeOps(state.deviceId ?? "nodevice", intentId, local, server, mediaProvider);
  }

  // ── live mutations → outbox ──

  private async onLocalMutation(ev: LocalMutationEvent): Promise<void> {
    const state = this.client.getState();
    if (!state.deviceId || !this.session || !state.bootstrapped) return;
    const op = await this.buildOpFromMutation(ev);
    if (!op) return;
    await appendOps([op]);
    this.boxCount = await outboxCount();
    this.notify();
    void this.client.drain();
  }

  private async buildOpFromMutation(ev: LocalMutationEvent): Promise<SyncOp | null> {
    const baseVersion = await this.ledger.get(ev.entity, ev.recordId);
    if (ev.op === "delete") {
      return {
        opid: nextOpid(this.client.getState().deviceId ?? "nodevice", this.client.nextOpidForNumber()),
        entity: ev.entity,
        recordId: ev.recordId,
        op: "delete",
        baseVersion,
      };
    }
    let record = ev.record ?? null;
    if (record === null) return null;
    switch (ev.entity) {
      case "media_items": {
        const classified = classifyMediaRecord(record);
        if (classified === null) return null; // AniList/kitsu: local-only
        record = classified;
        break;
      }
      case "entries": {
        const provider = this.mediaProviderById(String(record.mediaLocalId ?? ""));
        if (!entrySyncable(record, (id) => provider ?? this.mediaProviderById(id))) return null;
        break;
      }
      case "feedback": {
        const mediaLocalId = record.mediaLocalId;
        if (typeof mediaLocalId === "string" && mediaLocalId) {
          if (!entrySyncable({ mediaLocalId }, (id) => this.mediaProviderById(id))) return null;
        }
        break;
      }
      case "works":
      case "work_links": {
        const classified = classifyWorkRecord(record);
        if (classified === null) return null;
        break;
      }
      case "user_settings":
        break;
    }
    return {
      opid: nextOpid(this.client.getState().deviceId ?? "nodevice", this.client.nextOpidForNumber()),
      entity: ev.entity,
      recordId: ev.recordId,
      op: "upsert",
      baseVersion,
      record,
    };
  }

  private mediaProviderById(localId: string): string | undefined {
    return this.getStore().getState().media.find((m) => m.localId === localId)?.provider;
  }

  // ── pulled changes → local stores (never re-emits) ──

  private async applyChange(change: PullChange): Promise<void> {
    if (change.op === "epoch_reset") return; // handled by the client
    await this.applyServerRecord({
      entity: change.entity,
      recordId: change.recordId,
      record: change.record,
      version: change.version,
      deleted: change.op === "delete",
    });
    this.boxCount = await outboxCount();
    this.notify();
  }

  private async applyServerRecord(rec: {
    entity: SyncEntity;
    recordId: string;
    record: Record<string, unknown> | null;
    version: number;
    deleted?: boolean;
  }): Promise<void> {
    const deleted = rec.deleted ?? rec.record === null;
    const store = this.getStore();
    switch (rec.entity) {
      case "media_items": {
        if (deleted) {
          await db.deleteMedia([rec.recordId]).catch(() => undefined);
          store.setState({ media: store.getState().media.filter((m) => m.localId !== rec.recordId) });
        } else if (rec.record) {
          const item = rec.record as unknown as MediaItem;
          await db.putMedia([item]).catch(() => undefined);
          const media = store.getState().media;
          store.setState({
            media: media.some((m) => m.localId === rec.recordId)
              ? media.map((m) => (m.localId === rec.recordId ? item : m))
              : [...media, item],
          });
        }
        break;
      }
      case "entries": {
        if (deleted) {
          await db.deleteEntries([rec.recordId]).catch(() => undefined);
          store.setState({ entries: store.getState().entries.filter((e) => e.id !== rec.recordId) });
        } else if (rec.record) {
          const entry = rec.record as unknown as UserMediaEntry;
          await db.putEntries([entry]).catch(() => undefined);
          const entries = store.getState().entries;
          store.setState({
            entries: entries.some((e) => e.id === rec.recordId)
              ? entries.map((e) => (e.id === rec.recordId ? entry : e))
              : [...entries, entry],
          });
        }
        break;
      }
      case "feedback": {
        if (deleted) {
          await db.deleteFeedback([rec.recordId]).catch(() => undefined);
          store.setState({ feedback: store.getState().feedback.filter((f) => f.id !== rec.recordId) });
        } else if (rec.record) {
          const fb = rec.record as unknown as TasteFeedback;
          await db.putFeedback([fb]).catch(() => undefined);
          const feedback = store.getState().feedback;
          store.setState({
            feedback: feedback.some((f) => f.id === rec.recordId)
              ? feedback.map((f) => (f.id === rec.recordId ? fb : f))
              : [...feedback, fb],
          });
        }
        break;
      }
      case "user_settings": {
        if (rec.record && !deleted) {
          // merge ONLY the synced keys — local-only prefs survive
          const current = store.getState().settings;
          const patch: Record<string, unknown> = {};
          for (const key of SYNCED_SETTINGS_KEYS) {
            if (key in rec.record) patch[key] = rec.record[key];
          }
          const next = { ...current, ...patch } as AppSettings;
          await db.saveSettings(next).catch(() => undefined);
          store.setState({ settings: next });
        }
        break;
      }
      case "works": {
        if (deleted) await db.deleteWorks([rec.recordId]).catch(() => undefined);
        else if (rec.record) await db.putWorks([rec.record as unknown as WorkRecord]).catch(() => undefined);
        break;
      }
      case "work_links": {
        if (deleted) await db.deleteWorkLinks([rec.recordId]).catch(() => undefined);
        else if (rec.record) await db.putWorkLinks([rec.record as unknown as WorkLink]).catch(() => undefined);
        break;
      }
    }
  }

  // ── device + conflict management (Settings actions) ──

  async refreshDevices(): Promise<void> {
    try {
      const res = await this.api("/api/sync/devices");
      if (!res.ok) return;
      const body = (await res.json()) as { devices?: DeviceRow[] };
      this.devices = toDeviceViewModels(body.devices ?? [], this.client.getState().deviceId);
      this.notify();
    } catch {
      /* degraded — the list simply stays stale */
    }
  }

  async renameDevice(deviceId: string, name: string): Promise<boolean> {
    try {
      const res = await this.api("/api/sync/devices", {
        method: "PATCH",
        body: JSON.stringify({ deviceId, name }),
      });
      if (!res.ok) return false;
      if (this.client.getState().deviceId === deviceId) {
        this.client.attachDevice(deviceId, name);
      }
      await this.refreshDevices();
      return true;
    } catch {
      return false;
    }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    try {
      const res = await this.api(`/api/sync/devices?deviceId=${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      });
      if (!res.ok) return false;
      await this.refreshDevices();
      return true;
    } catch {
      return false;
    }
  }

  async refreshConflicts(): Promise<void> {
    try {
      const res = await this.api("/api/sync/conflicts");
      if (!res.ok) return;
      const body = (await res.json()) as { conflicts?: Array<Record<string, unknown>> };
      this.conflicts = toConflictCards(body.conflicts ?? []);
      const status = await this.api("/api/sync/status");
      if (status.ok) {
        const s = (await status.json()) as SyncStatusResponse;
        this.archive = {
          unresolved: s.archiveState.unresolved,
          cap: s.archiveState.cap,
          state: s.archiveState.state,
        };
      }
      this.notify();
    } catch {
      /* degraded */
    }
  }

  async resolveConflict(conflictId: number, action: "restore" | "discard"): Promise<boolean> {
    try {
      const res = await this.api("/api/sync/conflicts/resolve", {
        method: "POST",
        body: JSON.stringify({ conflictId, action }),
      });
      if (!res.ok) return false;
      await this.refreshConflicts();
      return true;
    } catch {
      return false;
    }
  }

  /** Manual "sync now" (Settings button): drain + pull. */
  async syncNow(): Promise<void> {
    this.busy = true;
    this.notify();
    try {
      await this.client.drain();
      await this.client.pullCycle();
      await this.refreshDevices();
      await this.refreshConflicts();
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /**
   * "Clear all data" hook: quarantines + clears the outbox and resets the
   * device/bootstrap state WITHOUT touching cloud data. The next sign-in on
   * this device walks the bootstrap choice again.
   */
  async disconnectLocal(): Promise<void> {
    const entries = await exportOutbox();
    await quarantineOutbox(entries);
    await clearOutbox();
    await this.ledger.clear();
    this.client.resetDeviceState();
    this.devices = [];
    this.conflicts = [];
    this.archive = null;
    this.boxCount = 0;
    this.notify();
  }

  // ── plumbing ──

  private async api(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.session?.accessToken) headers.authorization = `Bearer ${this.session.accessToken}`;
    return this.fetchImpl(path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  }

  subscribe(fn: SnapshotListener): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): SyncEngineSnapshot {
    const state = this.client.getState();
    return {
      configured: true,
      uiState: this.client.getUiState(),
      session: this.session,
      deviceId: state.deviceId,
      deviceName: state.deviceName,
      bootstrapped: state.bootstrapped,
      bootstrapPhase: state.bootstrapIntent?.phase ?? null,
      bootstrapProgress: state.bootstrapProgress
        ? { pages: state.bootstrapProgress.nextPage, done: state.bootstrapProgress.nextPage }
        : null,
      conflicts: this.conflicts,
      devices: this.devices,
      archive: this.archive,
      outboxCount: this.boxCount,
      lastSyncedAt: state.lastPushAt,
      busy: this.busy,
    };
  }

  private notify(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* UI errors never break the engine */
      }
    }
  }
}

// ---- module-level singleton access ----

let engineInstance: SyncEngine | null | undefined;

/** Returns the engine when sync is configured; null when fully local. */
export function getSyncEngine(storeAccess?: () => EchoStoreShape): SyncEngine | null {
  if (engineInstance !== undefined) return engineInstance;
  const config = readConfig();
  if (!config) {
    engineInstance = null;
    return null;
  }
  // lazy import shape: the store import is injected by the React hook layer
  // to keep this module store-agnostic; on first call we bind the real store
  const getStore = storeAccess ?? defaultStoreAccess();
  if (!getStore) return null;
  engineInstance = new SyncEngine(config, { getStore });
  return engineInstance;
}

let boundStore: (() => EchoStoreShape) | null = null;
export function bindStoreAccess(fn: () => EchoStoreShape): void {
  boundStore = fn;
}
function defaultStoreAccess(): (() => EchoStoreShape) | null {
  return boundStore;
}

function readConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return { url, anonKey };
}

export { AuthFlowError };

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("android")) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "other";
}

function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "Device";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("android")) return "Android device";
  if (/iphone|ipad|ipod/.test(ua)) return "iOS device";
  if (ua.includes("mac")) return "Mac";
  if (ua.includes("windows")) return "Windows PC";
  if (ua.includes("linux")) return "Linux device";
  return "Device";
}

const APP_VERSION_SYNC = "1.3.0";
