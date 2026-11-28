/**
 * ECHO — sync protocol types (client side).
 *
 * Wire contracts mirror the RPC responses in supabase/migrations
 * (v1.1 §9.3 as amended by v1.2/v1.3 PATCH1: the pull carries the
 * requesting deviceId; errors are uniform device_not_found / device_revoked).
 */

export type SyncEntity =
  | "media_items"
  | "entries"
  | "feedback"
  | "works"
  | "work_links"
  | "user_settings";

/** The six canonical conflict reasons (v1.3 PATCH1 §5.3.4 — parity-tested
 * against the DB constraint by T-3.11). */
export const CONFLICT_REASONS = [
  "edit_edit",
  "delete_vs_upsert",
  "delete_vs_edit",
  "applied_delete",
  "stale_base_unknown_record",
  "schema",
] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export interface SyncOp {
  opid: string;
  entity: SyncEntity;
  recordId: string;
  op: "upsert" | "delete";
  baseVersion: number;
  lamport?: number;
  record?: Record<string, unknown>;
}

export interface ArchivedOp {
  opid: string;
  reason: ConflictReason;
  conflictId: number;
  serverVersion: number | null;
}

export interface RejectedOp {
  opid: string;
  reason: "schema" | "provider_policy" | "conflict_archive_full" | string;
}

export interface PushResponse {
  ok: true;
  epoch: number;
  headSeq: number;
  acked: string[];
  archived: ArchivedOp[];
  rejected: RejectedOp[];
}

export interface PullChange {
  seq: number;
  entity: SyncEntity;
  recordId: string;
  op: "upsert" | "delete" | "epoch_reset";
  version: number;
  deviceId: string | null;
  epoch: number;
  record: Record<string, unknown> | null;
}

export interface PullResponse {
  ok: true;
  headSeq: number;
  watermark: number;
  changes: PullChange[];
}

export interface ArchiveState {
  unresolved: number;
  nearFullAt: number;
  cap: number;
  state: "ok" | "near_full" | "full";
}

export interface SyncStatusResponse {
  ok: true;
  epoch: number;
  headSeq: number;
  watermark: number;
  serverBootId: string;
  perEntity: Record<string, number>;
  perEntityHash: Record<string, string>;
  archiveState: ArchiveState;
}

export interface ActiveSnapshot {
  id: number;
  headSeq: number;
  epoch: number;
  pageCount: number;
  recordCount: number;
  contentHash: string;
}

export interface BootstrapStatusResponse {
  ok: true;
  epoch: number;
  headSeq: number;
  watermark: number;
  serverBootId: string;
  activeSnapshot: ActiveSnapshot;
}

export interface BootstrapPage {
  pageNo: number;
  entity: string;
  firstKey: string;
  lastKey: string;
  rowCount: number;
  pageHash: string;
}

export interface DeviceRow {
  id: string;
  name: string;
  platform: string | null;
  app_version: string | null;
  acked_seq: number;
  epoch: number;
  bootstrapped_at: string | null;
  created_at: string;
  last_synced_at: string | null;
  revoked_at: string | null;
}

/** Persisted client sync state (IndexedDB `syncMeta`, key "sync"). */
export interface SyncState {
  deviceId: string | null;
  deviceName: string | null;
  cursor: number;
  epoch: number;
  serverBootId: string | null;
  bootstrapped: boolean;
  /** bootstrap intent state machine (v1.2 §6.3.2) */
  bootstrapIntent: BootstrapIntent | null;
  bootstrapProgress: { snapshotId: number; nextPage: number } | null;
  opidCounter: number;
  lastPushAt: number | null;
}

export type BootstrapIntentKind = "merge" | "keep_local" | "replace_local";

export interface BootstrapIntent {
  id: string;
  kind: BootstrapIntentKind;
  phase:
    | "choice_pending"
    | "choice_made"
    | "snapshot_transfer"
    | "delta_drain"
    | "seeding"
    | "done";
}

/** Transport classification (PATCH1 §10.2.6). */
export type TransportClass =
  | { kind: "contract" }
  | { kind: "app_429"; retryAfterMs?: number }
  | { kind: "service_unavailable"; sub: "platform_quota_exceeded" | "generic" }
  | { kind: "auth_expired" }
  | { kind: "device_not_found" }
  | { kind: "device_revoked" }
  | { kind: "cursor_expired" }
  | { kind: "epoch_mismatch" }
  | { kind: "conflict_archive_full" };

/** Client-side degraded/synced state surfaced to the UI (EN/AR copy keyed). */
export type SyncUiState =
  | "off"
  | "local_only"
  | "synced"
  | "syncing"
  | "degraded"
  | "paused_conflicts"
  | "must_rebootstrap"
  | "signed_out";
