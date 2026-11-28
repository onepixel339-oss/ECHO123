/**
 * A2 regression tests (audit D9): toast auto-dismiss + sensible limit.
 *
 * Before the fix: TOAST_LIMIT was 1 and the remove queue was armed only on
 * dismiss with a ~16.7-minute delay — toasts were effectively sticky and
 * mutually exclusive. After: limit 3, 5-second auto-dismiss armed on ADD,
 * per-toast duration override.
 */

import { describe, expect, test } from "bun:test";
import { reducer, subscribe, toast } from "@/hooks/use-toast";

interface Toasty {
  id: string;
  open?: boolean;
  [k: string]: unknown;
}

function addToast(state: { toasts: Toasty[] }, t: Toasty) {
  return reducer(state, { type: "ADD_TOAST", toast: t as never });
}

describe("toast limit (A2 / D9)", () => {
  test("at most 3 toasts are kept — the oldest is evicted", () => {
    let state = { toasts: [] as Toasty[] };
    for (let i = 0; i < 5; i++) {
      state = addToast(state, { id: `t${i}`, open: true });
    }
    expect(state.toasts).toHaveLength(3);
    expect(state.toasts.map((t) => t.id)).toEqual(["t4", "t3", "t2"]);
  });

  test("newest toast is first (stacking order preserved)", () => {
    let state = { toasts: [] as Toasty[] };
    state = addToast(state, { id: "a", open: true });
    state = addToast(state, { id: "b", open: true });
    expect(state.toasts.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("toast auto-dismiss (A2 / D9)", () => {
  test("a toast is removed from state after its duration elapses", async () => {
    const seen: { toasts: Toasty[] }[] = [];
    const unsub = subscribe((s) => seen.push({ toasts: s.toasts }));
    try {
      toast({ description: "bye", duration: 40 } as never);
      expect(seen.at(-1)?.toasts).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 120));
      const last = seen.at(-1);
      expect(last?.toasts).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  test("duration: Infinity is never auto-removed within the window", async () => {
    const seen: { toasts: Toasty[] }[] = [];
    const unsub = subscribe((s) => seen.push({ toasts: s.toasts }));
    try {
      toast({ description: "stay", duration: Infinity } as never);
      await new Promise((r) => setTimeout(r, 80));
      expect(seen.at(-1)?.toasts).toHaveLength(1);
    } finally {
      unsub();
    }
  });
});
