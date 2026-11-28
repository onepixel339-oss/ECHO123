/**
 * ECHO — opid generation (v1.1 §9.2: opid = <deviceId>-<monotonic>;
 * bootstrap seed ops use the deterministic boot-<deviceId>-<intentId>-<n>
 * scheme — a re-seed after a crash regenerates the identical opid set, and
 * the server's push_ops dedupe makes replays no-ops; v1.2 §6.3.3).
 */

export function nextOpid(deviceId: string, counter: number): string {
  return `${deviceId}-${counter}`;
}

/** Deterministic bootstrap seed opid (crash-resume idempotence, INV-2). */
export function bootOpid(deviceId: string, intentId: string, n: number): string {
  return `boot-${deviceId}-${intentId}-${n}`;
}
