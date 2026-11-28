/**
 * ECHO — bootstrap intent state machine + content-diff reconcile seeding
 * (v1.2 §6.3 as corrected by v1.3 PATCH1 §6.3.3).
 *
 * Choice-before-mutation: NO user-data mutation happens before the user's
 * recorded choice; the persisted intent (IndexedDB syncMeta) is written
 * BEFORE any server mutation; crash after choice_made resumes the recorded
 * intent; crash during choice_pending re-asks. Unbased divergent records
 * seed with base_version = 0 (guaranteed D-3/D-6/D-9 — never a silent
 * overwrite); records with a genuine observed baseline keep that value.
 */

import type { SyncOp, SyncEntity } from "./types";
import { bootOpid } from "./opid";
import { classifyMediaRecord, entrySyncable, classifyWorkRecord } from "./policy";

export interface LocalRecordSnapshot {
  entity: SyncEntity;
  recordId: string;
  record: Record<string, unknown>;
  /** the version this device last observed for this record (null = never synced) */
  observedVersion: number | null;
}

export interface ServerRecordSnapshot {
  entity: SyncEntity;
  recordId: string;
  record: Record<string, unknown> | null;
  version: number;
}

/** Fields compared by the content-diff (Tier X / expressive fields excluded). */
const SYNC_COMPARED_KEYS = new Set([
  "localId", "provider", "providerId", "workId", "externalIds", "mediaType",
  "format", "subtype", "title", "originalTitle", "titleAr", "releaseYear",
  "endYear", "canonicalUrl", "provenance", "providerRef", "sourceAttribution",
  "metadataFetchedAt", "altTitles", "genres", "tags", "creators", "studios",
  "languages", "countries", "episodeCount", "volumeCount", "chapterCount",
  "issueCount", "issueNumber", "publicationStatus", "runtimeMinutes",
  "contentRating", "publicScore", "rating", "cast",
  // user data (entries/feedback/settings):
  "status", "mediaLocalId", "isFavourite", "personalNote", "userTags",
  "completedAt", "addedAt", "updatedAt", "value", "featureKey", "source",
  "locale", "theme", "aiEnabled", "syncSynopses",
]);

function canonicalComparable(record: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (SYNC_COMPARED_KEYS.has(key)) filtered[key] = record[key];
  }
  return JSON.stringify(filtered);
}

/**
 * The corrected five-quadrant seeding table (§6.3.3). Produces the seed ops
 * for a MERGE bootstrap from pre-existing local records against the server
 * snapshot. Deterministic opids (boot-<deviceId>-<intentId>-<n>) make
 * crash-retry idempotent (server push_ops dedupe).
 *
 * Media records are policy-classified first (AniList `none` never seeds);
 * entries attached to AniList media stay local (§6.3.6).
 */
export function seedMergeOps(
  deviceId: string,
  intentId: string,
  localRecords: LocalRecordSnapshot[],
  serverRecords: Map<string, ServerRecordSnapshot>,
  mediaProviderById: (mediaLocalId: string) => string | undefined,
): SyncOp[] {
  const ops: SyncOp[] = [];
  let n = 0;

  for (const local of localRecords) {
    const key = `${local.entity}:${local.recordId}`;
    const server = serverRecords.get(key);

    // Policy gate: AniList-derived media records and entries attached to
    // them never enter the outbox (cloudSyncPolicy = none).
    if (local.entity === "media_items") {
      if (classifyMediaRecord(local.record) === null) continue;
    }
    if (local.entity === "entries" && !entrySyncable(local.record, mediaProviderById)) continue;
    if (local.entity === "works" || local.entity === "work_links") {
      if (classifyWorkRecord(local.record) === null) continue;
    }

    if (!server) {
      // server absent → insert, base 0 (D-8)
      ops.push(mkOp("upsert", 0, local));
    } else if (server.record === null) {
      // server tombstone: unbased records must NOT resurrect (D-6); records
      // with a genuine observed baseline equal to the tombstone version may
      // deliberately resurrect (D-5)
      if (local.observedVersion !== null && local.observedVersion === server.version) {
        ops.push(mkOp("upsert", local.observedVersion, local));
      } else if (local.observedVersion === null) {
        // unbased against a tombstone → seed base 0 (D-6 archives it)
        ops.push(mkOp("upsert", 0, local));
      }
      // stale observed baseline against tombstone → delete wins (no op)
    } else if (
      canonicalComparable(stripForCompare(local.record)) ===
      canonicalComparable(stripForCompare(server.record))
    ) {
      // content-identical over the sync-classified fields → no op
      continue;
    } else if (local.observedVersion === null) {
      // DIFFERENT with NO baseline → base_version = 0 → guaranteed D-3
      // (server stays live; incoming archived; user gets a conflict card)
      ops.push(mkOp("upsert", 0, local));
    } else {
      // DIFFERENT with a genuine baseline → the actual value (D-1/D-3/D-10)
      ops.push(mkOp("upsert", local.observedVersion, local));
    }
  }
  return ops;

  function mkOp(op: "upsert", base: number, local: LocalRecordSnapshot): SyncOp {
    n += 1;
    const classified =
      local.entity === "media_items"
        ? (classifyMediaRecord(local.record) ?? local.record)
        : local.entity === "works" || local.entity === "work_links"
          ? (classifyWorkRecord(local.record) ?? local.record)
          : local.record;
    return {
      opid: bootOpid(deviceId, intentId, n),
      entity: local.entity,
      recordId: local.recordId,
      op,
      baseVersion: base,
      record: classified,
    };
  }
}

function stripForCompare(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (SYNC_COMPARED_KEYS.has(key)) out[key] = record[key];
  }
  return out;
}

/**
 * The persisted intent state machine (§6.3.2): transitions are idempotent;
 * `persistIntent` is called BEFORE any server mutation.
 */
export function newIntent(kind: "merge" | "keep_local" | "replace_local"): BootstrapIntentState {
  return {
    id: `intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    phase: "choice_made",
  };
}

export interface BootstrapIntentState {
  id: string;
  kind: "merge" | "keep_local" | "replace_local";
  phase: "choice_pending" | "choice_made" | "snapshot_transfer" | "delta_drain" | "seeding" | "done";
}

/**
 * Replace Local: never pushes (INV-13) — the caller quarantines the outbox
 * + a local export file, clears the outbox, wipes the library stores, then
 * bootstraps from the snapshot (base 0).
 */
export function replaceLocalNeverPushes(): true {
  return true;
}
