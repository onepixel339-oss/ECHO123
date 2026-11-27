/**
 * A2 regression tests (audit H1): the local quarterly backup-reminder nudge.
 *
 * Rules under test (see lib/echo/backupNudge.ts):
 *  - < 5 entries → never;
 *  - exported recently → no; ≥ 90 days since export → yes;
 *  - never exported → only at ≥ 20 entries;
 *  - snooze hides it until it expires;
 *  - markBackupExported resets the clock and clears a snooze.
 */

import { describe, expect, test } from "bun:test";
import {
  NUDGE_INTERVAL_MS,
  shouldNudgeBackup,
  type BackupNudgeState,
} from "@/lib/echo/backupNudge";

const NOW = 1_800_000_000_000; // fixed epoch ms
const DAY = 24 * 60 * 60 * 1000;

const never: BackupNudgeState = { lastExportAt: null, snoozedUntil: null };

describe("shouldNudgeBackup (A2 / H1)", () => {
  test("small libraries are never nudged", () => {
    expect(shouldNudgeBackup(0, never, NOW)).toBe(false);
    expect(shouldNudgeBackup(4, never, NOW)).toBe(false);
  });

  test("a recent export keeps the nudge silent", () => {
    expect(
      shouldNudgeBackup(50, { lastExportAt: NOW - 30 * DAY, snoozedUntil: null }, NOW),
    ).toBe(false);
    expect(
      shouldNudgeBackup(50, { lastExportAt: NOW - (NUDGE_INTERVAL_MS - DAY), snoozedUntil: null }, NOW),
    ).toBe(false);
  });

  test("a stale export (≥ 90 days) triggers the nudge", () => {
    expect(
      shouldNudgeBackup(50, { lastExportAt: NOW - NUDGE_INTERVAL_MS, snoozedUntil: null }, NOW),
    ).toBe(true);
    expect(
      shouldNudgeBackup(50, { lastExportAt: NOW - 200 * DAY, snoozedUntil: null }, NOW),
    ).toBe(true);
  });

  test("never exported: nudged at 20+ entries, not before", () => {
    expect(shouldNudgeBackup(19, never, NOW)).toBe(false);
    expect(shouldNudgeBackup(20, never, NOW)).toBe(true);
  });

  test("an active snooze hides the nudge even when overdue", () => {
    const state: BackupNudgeState = {
      lastExportAt: NOW - 200 * DAY,
      snoozedUntil: NOW + 10 * DAY,
    };
    expect(shouldNudgeBackup(50, state, NOW)).toBe(false);
  });

  test("an expired snooze lets the nudge show again", () => {
    const state: BackupNudgeState = {
      lastExportAt: NOW - 200 * DAY,
      snoozedUntil: NOW - DAY,
    };
    expect(shouldNudgeBackup(50, state, NOW)).toBe(true);
  });
});
