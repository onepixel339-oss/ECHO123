/**
 * ECHO — per-record observed-version ledger (client side).
 *
 * Live edits push with `baseVersion` = the version this device last OBSERVED
 * for that record (v1.2 §6.3): the pull stream is the source of observed
 * versions. A record never seen (or deleted) has version 0 — an unbased
 * push the server treats per the D-3/D-6/D-8/D-9 rules.
 *
 * Persisted in IndexedDB `syncMeta` under the key "versions" as a plain map
 * `${entity}:${recordId}` → version. Bounded: it only grows with synced
 * records, never with outbox attempts.
 */

import type { SyncEntity } from "./types";
import { openDB, STORES } from "../localdb";

const KEY = "versions";
const MAX_ENTRIES = 50_000; // far beyond any personal library; safety valve

export class VersionLedger {
  private cache: Map<string, number> | null = null;

  private async load(): Promise<Map<string, number>> {
    if (this.cache) return this.cache;
    const db = await openDB();
    const value = await new Promise<Record<string, number> | undefined>((resolve, reject) => {
      const t = db.transaction(STORES.syncMeta, "readonly");
      const req = t.objectStore(STORES.syncMeta).get(KEY);
      req.onsuccess = () => resolve(req.result as Record<string, number> | undefined);
      req.onerror = () => reject(req.error);
    });
    this.cache = new Map(Object.entries(value ?? {}));
    return this.cache;
  }

  private async persist(): Promise<void> {
    const map = await this.load();
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORES.syncMeta, "readwrite");
      t.objectStore(STORES.syncMeta).put(Object.fromEntries(map), KEY);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  static key(entity: SyncEntity, recordId: string): string {
    return `${entity}:${recordId}`;
  }

  async get(entity: SyncEntity, recordId: string): Promise<number> {
    const map = await this.load();
    return map.get(VersionLedger.key(entity, recordId)) ?? 0;
  }

  /** Records the observed version — monotonic; never goes backwards. */
  async observe(entity: SyncEntity, recordId: string, version: number): Promise<void> {
    const map = await this.load();
    const k = VersionLedger.key(entity, recordId);
    const current = map.get(k) ?? 0;
    if (version <= current) return;
    map.set(k, version);
    if (map.size > MAX_ENTRIES) {
      // drop the oldest observed versions rather than grow unbounded
      const excess = map.size - MAX_ENTRIES;
      let dropped = 0;
      for (const key of map.keys()) {
        if (dropped >= excess) break;
        map.delete(key);
        dropped += 1;
      }
    }
    await this.persist();
  }

  /** Test/introspection helper. */
  async snapshot(): Promise<Record<string, number>> {
    const map = await this.load();
    return Object.fromEntries(map);
  }

  async clear(): Promise<void> {
    this.cache = new Map();
    await this.persist();
  }
}
