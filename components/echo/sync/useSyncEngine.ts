"use client";

/**
 * ECHO — the React binding for the sync engine (B3).
 *
 * Returns the engine snapshot (subscribing for updates) when cloud sync is
 * configured, or null forever when it is not — the local-only app renders
 * no account/sync surface at all in that case.
 */

import React from "react";
import { getSyncEngine, bindStoreAccess, type SyncEngineSnapshot } from "@/lib/echo/sync/engine";
import { useEchoStore } from "@/lib/echo/store";

export function useSyncEngine(): SyncEngineSnapshot | null {
  const [snapshot, setSnapshot] = React.useState<SyncEngineSnapshot | null>(null);

  React.useEffect(() => {
    // bridge the real zustand store into the (store-agnostic) engine
    bindStoreAccess(() => useEchoStore);
    const engine = getSyncEngine();
    if (!engine) return; // unconfigured: fully local, no sync UI anywhere
    const unsubscribe = engine.subscribe(setSnapshot);
    void engine.start();
    return unsubscribe;
  }, []);

  return snapshot;
}
