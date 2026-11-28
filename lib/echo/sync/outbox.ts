/**
 * ECHO — outbox v4: the offline queue (v1.1 §9.2/§9.4 + v1.2 §6 + PATCH1
 * §10.2.6 rule 3).
 *
 * Invariants implemented here:
 *   INV-1/2  idempotent push — acks only, replays are the server's job.
 *   INV-14   outbox compaction (collapse at >5,000 ops): latest op per
 *            (entity, recordId), baseVersion from the EARLIEST un-acked op,
 *            deletes never collapsed away.
 *   §10.2.6  outbox preservation — entries are removed ONLY by an explicit
 *            per-op ack from a successful contract response. Network or
 *            service failure never discards queued changes; backpressure
 *            rejections (conflict_archive_full) retain the op client-side.
 */

import type { SyncOp, PushResponse } from "./types";
import { openDB, STORES, closeDB } from "../localdb";

export interface OutboxEntry {
  op: SyncOp;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function appendOps(ops: SyncOp[]): Promise<void> {
  if (ops.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORES.outbox, "readwrite");
    const store = t.objectStore(STORES.outbox);
    const now = Date.now();
    for (const op of ops) {
      const entry: OutboxEntry = { op, createdAt: now, attempts: 0, lastAttemptAt: null };
      store.put(entry, op.opid);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getAllOutbox(): Promise<OutboxEntry[]> {
  const db = await openDB();
  const t = db.transaction(STORES.outbox, "readonly");
  const store = t.objectStore(STORES.outbox);
  const values = (await reqToPromise(store.getAll())) as OutboxEntry[];
  return values;
}

export async function outboxCount(): Promise<number> {
  const db = await openDB();
  const t = db.transaction(STORES.outbox, "readonly");
  return reqToPromise(t.objectStore(STORES.outbox).count());
}

/** Remove exactly the acked opids — nothing else (outbox preservation). */
export async function removeAcked(ackedOpids: string[]): Promise<void> {
  if (ackedOpids.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORES.outbox, "readwrite");
    const store = t.objectStore(STORES.outbox);
    for (const opid of ackedOpids) store.delete(opid);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Record an attempt (never removes anything). */
export async function markAttempted(opids: string[]): Promise<void> {
  if (opids.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORES.outbox, "readwrite");
    const store = t.objectStore(STORES.outbox);
    const now = Date.now();
    for (const opid of opids) {
      const g = store.get(opid);
      g.onsuccess = () => {
        const entry = g.result as OutboxEntry | undefined;
        if (entry) {
          entry.attempts += 1;
          entry.lastAttemptAt = now;
          store.put(entry, opid);
        }
      };
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearOutbox(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORES.outbox, "readwrite");
    const req = t.objectStore(STORES.outbox).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Serialize the current batch (≤200 ops, ≤2MB) — oldest first. */
export function selectBatch(entries: OutboxEntry[], maxOps = 200, maxBytes = 2_000_000): SyncOp[] {
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt || a.op.opid.localeCompare(b.op.opid));
  const batch: SyncOp[] = [];
  let bytes = 0;
  for (const e of sorted) {
    const opBytes = JSON.stringify(e.op).length;
    if (batch.length >= maxOps) break;
    if (batch.length > 0 && bytes + opBytes > maxBytes) break;
    batch.push(e.op);
    bytes += opBytes;
  }
  return batch;
}

/**
 * Backpressure collapse (INV-14): with more than `threshold` (5,000) queued
 * ops, collapse to the latest op per (entity, recordId) — carrying the
 * EARLIEST un-acked baseVersion for that record so CAS still detects
 * concurrency against intermediate server states — and never dropping a
 * delete. Pure function of the outbox; tests lock it.
 */
export function collapseOutbox(entries: OutboxEntry[], threshold = 5000): OutboxEntry[] {
  if (entries.length <= threshold) return entries;
  const byRecord = new Map<string, OutboxEntry[]>();
  for (const e of entries) {
    const key = `${e.op.entity}:${e.op.recordId}`;
    const list = byRecord.get(key) ?? [];
    list.push(e);
    byRecord.set(key, list);
  }
  const collapsed: OutboxEntry[] = [];
  for (const list of byRecord.values()) {
    const sorted = list.sort((a, b) => a.createdAt - b.createdAt);
    const latest = sorted[sorted.length - 1];
    const earliestBase = sorted[0].op.baseVersion;
    const hasDelete = sorted.some((e) => e.op.op === "delete");
    if (hasDelete) {
      // deletes are never collapsed away: keep the latest delete, carrying
      // the earliest base (the delete must still win its CAS)
      const latestDelete = [...sorted].reverse().find((e) => e.op.op === "delete")!;
      collapsed.push({
        ...latestDelete,
        op: { ...latestDelete.op, baseVersion: earliestBase },
      });
    } else {
      collapsed.push({
        ...latest,
        op: { ...latest.op, baseVersion: earliestBase },
      });
    }
  }
  return collapsed;
}

/**
 * Process a successful push response: remove acked ops ONLY. Archived
 * (conflict) ops were processed server-side — they are acked and the
 * conflict card data is surfaced separately. Rejected ops (schema /
 * provider_policy / conflict_archive_full) are RETAINED for retry or user
 * action — never silently discarded.
 */
export function partitionResponse(
  response: PushResponse,
): { acked: string[]; retained: string[] } {
  const processed = new Set<string>(response.acked);
  for (const arc of response.archived) processed.add(arc.opid);
  const retained = response.rejected.map((r) => r.opid);
  return { acked: [...processed], retained };
}

/** Export the whole outbox (quarantine backup before Replace Local). */
export async function exportOutbox(): Promise<OutboxEntry[]> {
  return getAllOutbox();
}

/** Import entries into the quarantine store (Replace Local auto-backup). */
export async function quarantineOutbox(entries: OutboxEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORES.quarantine, "readwrite");
    const store = t.objectStore(STORES.quarantine);
    const now = Date.now();
    entries.forEach((e, i) => store.put({ ...e, quarantinedAt: now }, `q-${now}-${i}`));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export { closeDB };
