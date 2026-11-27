/**
 * ECHO — local backup-reminder nudge (A2 hygiene, audit H1).
 *
 * A gentle, quarterly, DEVICE-LOCAL reminder to export a backup. It is
 * deliberately NOT part of the IndexedDB settings store or any future sync
 * payload: whether a particular device has a recent backup is a fact about
 * that device, not about the user's taste data.
 *
 * Rules (pre-registered, unit-tested):
 *  - a library with fewer than MIN_ENTRIES titles is never nagged;
 *  - after a successful export the nudge sleeps NUDGE_INTERVAL_MS (90 days);
 *  - a user who never exported is nudged once their library reaches
 *    NEVER_EXPORTED_MIN_ENTRIES (20) titles — data worth saving exists then;
 *  - "remind me later" snoozes the banner for another NUDGE_INTERVAL_MS.
 */

const STORAGE_KEY = "echo.backupNudge.v1";

/** 90 days — "quarterly". */
export const NUDGE_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
/** Below this library size a backup nudge is noise. */
export const MIN_ENTRIES = 5;
/** Never-exported libraries are nudged at this size (a real library exists). */
export const NEVER_EXPORTED_MIN_ENTRIES = 20;

export interface BackupNudgeState {
  /** epoch ms of the last successful export, or null */
  lastExportAt: number | null;
  /** epoch ms before which the nudge stays hidden (snooze), or null */
  snoozedUntil: number | null;
}

export const EMPTY_NUDGE_STATE: BackupNudgeState = {
  lastExportAt: null,
  snoozedUntil: null,
};

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null; // private mode / blocked storage — the nudge stays silent
  }
}

export function readBackupNudgeState(): BackupNudgeState {
  const s = storage();
  if (!s) return EMPTY_NUDGE_STATE;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_NUDGE_STATE;
    const parsed = JSON.parse(raw) as Partial<BackupNudgeState>;
    return {
      lastExportAt:
        typeof parsed.lastExportAt === "number" && Number.isFinite(parsed.lastExportAt)
          ? parsed.lastExportAt
          : null,
      snoozedUntil:
        typeof parsed.snoozedUntil === "number" && Number.isFinite(parsed.snoozedUntil)
          ? parsed.snoozedUntil
          : null,
    };
  } catch {
    return EMPTY_NUDGE_STATE;
  }
}

function write(state: BackupNudgeState): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full / blocked — non-fatal
  }
}

/** Record a successful export (call from the export flow). */
export function markBackupExported(now: number = Date.now()): void {
  const state = readBackupNudgeState();
  write({ ...state, lastExportAt: now, snoozedUntil: null });
}

/** Snooze the banner for another interval. */
export function snoozeBackupNudge(now: number = Date.now()): void {
  const state = readBackupNudgeState();
  write({ ...state, snoozedUntil: now + NUDGE_INTERVAL_MS });
}

/** Clear all nudge bookkeeping (tests). */
export function resetBackupNudge(): void {
  const s = storage();
  try {
    s?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Should the backup nudge banner be shown for a library of `entryCount`
 * titles? Pure — all impurity lives in read/write above.
 */
export function shouldNudgeBackup(
  entryCount: number,
  state: BackupNudgeState = readBackupNudgeState(),
  now: number = Date.now(),
): boolean {
  if (entryCount < MIN_ENTRIES) return false;
  if (state.snoozedUntil !== null && now < state.snoozedUntil) return false;
  if (state.lastExportAt !== null) {
    return now - state.lastExportAt >= NUDGE_INTERVAL_MS;
  }
  // never exported: only once a genuinely-sized library exists
  return entryCount >= NEVER_EXPORTED_MIN_ENTRIES;
}
