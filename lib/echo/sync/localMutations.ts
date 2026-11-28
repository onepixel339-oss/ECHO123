/**
 * ECHO — the local-mutation tap (B3 wiring).
 *
 * Store actions emit their successful local writes here; the sync engine
 * (when enabled) subscribes and turns them into policy-classified outbox
 * ops. With sync unconfigured there are ZERO subscribers — emission is a
 * no-op array iteration and the local-only experience is untouched.
 *
 * The applier side (pulled changes) deliberately does NOT emit: applying a
 * remote change is not a local mutation, and re-emitting it would loop ops
 * back into the outbox.
 */

import type { SyncEntity } from "./types";

/**
 * The AppSettings fields the sync layer carries (mirror of the server's
 * user_settings row — v1.2 §6.3 compared-key set, user-data columns only).
 * Shared by the store's emission gate and the engine's apply path.
 */
export const SYNCED_SETTINGS_KEYS = [
  "language", "interests", "recencyWeight", "mapLabels", "animations",
  "contentVisibility", "providerToggles", "excludedGenres",
  "dismissedInsights",
] as const;

export interface LocalMutationEvent {
  entity: SyncEntity;
  op: "upsert" | "delete";
  recordId: string;
  record?: Record<string, unknown>;
}

type Listener = (event: LocalMutationEvent) => void;

const listeners = new Set<Listener>();

export function subscribeToLocalMutations(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitLocalMutation(event: LocalMutationEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // a broken subscriber must never break the local write path
    }
  }
}

/** subscriber count — tests and the engine's own introspection */
export function localMutationListenerCount(): number {
  return listeners.size;
}

/**
 * "Local data cleared" signal (Settings → Clear all data). The engine uses
 * it to disconnect sync state (quarantine + clear the outbox, reset device
 * state) WITHOUT touching cloud data — the confirmation dialog and the
 * bilingual copy say exactly that.
 */
const clearListeners = new Set<() => void>();

export function subscribeToLocalClear(fn: () => void): () => void {
  clearListeners.add(fn);
  return () => clearListeners.delete(fn);
}

export function emitLocalCleared(): void {
  for (const fn of clearListeners) {
    try {
      fn();
    } catch {
      /* same no-break contract */
    }
  }
}
