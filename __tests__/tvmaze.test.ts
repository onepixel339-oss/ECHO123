/**
 * ECHO — TVMaze provider tests (A2 regression coverage).
 *
 * ALL network access is mocked: globalThis.fetch is stubbed per test — no
 * live calls. Covers:
 *  - the fuzzy-noise post-filter (audit H2): only hits whose normalized
 *    title contains every query token survive; untitled rows are dropped
 *  - normalization: case, accents, punctuation are ignored when matching
 *  - multi-token queries require EVERY token (order-free containment)
 *  - the filter never fires on detail lookups (getTitle untouched)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TvMazeProvider, tvmazeTitleMatchesQuery } from "../providers/tvmaze";

const provider = new TvMazeProvider();

const realFetch = globalThis.fetch;

function show(id: number, name: string | undefined, year = 2019) {
  return { show: { id, name, premiered: `${year}-04-01` } };
}

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        show(1, "The Twilight Zone"),
        show(2, "Breaking Bad"),
        show(3, undefined), // untitled row — noise
        show(4, "Zone of the Enders"),
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("tvmazeTitleMatchesQuery (A2 / H2 post-filter)", () => {
  test("keeps a hit whose title contains the query", () => {
    expect(tvmazeTitleMatchesQuery("The Twilight Zone", "twilight")).toBe(true);
    expect(tvmazeTitleMatchesQuery("The Twilight Zone", "Twilight Zone")).toBe(true);
  });

  test("case, accents and punctuation are normalized away", () => {
    expect(tvmazeTitleMatchesQuery("Caféteslat", "cafe")).toBe(true);
    expect(tvmazeTitleMatchesQuery("L'Étranger", "etranger")).toBe(true);
  });

  test("multi-token queries require every token, in any order", () => {
    expect(tvmazeTitleMatchesQuery("Zone The Twilight", "the twilight zone")).toBe(true);
    expect(tvmazeTitleMatchesQuery("The Twilight", "the twilight zone")).toBe(false);
  });

  test("fuzzy noise that merely sounds similar is rejected", () => {
    expect(tvmazeTitleMatchesQuery("Twilight Sparkle Adventures", "twilight zone")).toBe(false);
    expect(tvmazeTitleMatchesQuery("Zoning Board Meetings", "zone of the enders")).toBe(false);
  });

  test("missing or empty titles are dropped (noise rows)", () => {
    expect(tvmazeTitleMatchesQuery(undefined, "anything")).toBe(false);
    expect(tvmazeTitleMatchesQuery("", "anything")).toBe(false);
    expect(tvmazeTitleMatchesQuery("   ", "anything")).toBe(false);
  });

  test("an empty query never matches (engine never sends one)", () => {
    expect(tvmazeTitleMatchesQuery("The Twilight Zone", "  ")).toBe(false);
  });
});

describe("TvMazeProvider.search (A2 / H2 post-filter)", () => {
  test("fuzzy-matched shows without the query tokens are filtered out", async () => {
    const rows = await provider.search("twilight zone", { mediaTypes: ["series"] });
    // upstream returned 4 rows incl. noise; only the title-containing rows survive
    expect(rows.map((r) => r.item.title)).toEqual(["The Twilight Zone"]);
    expect(rows[0].item.provider).toBe("tvmaze");
    expect(rows[0].item.releaseYear).toBe(2019);
  });

  test("a query no title contains returns an empty list (no invented results)", async () => {
    const rows = await provider.search("quantum leap", { mediaTypes: ["series"] });
    expect(rows).toEqual([]);
  });

  test("getTitle is NOT post-filtered (direct id lookups stay verbatim)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ id: 7, name: "Whatever Show", premiered: "2001-01-01" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const item = await provider.getTitle("7");
    expect(item?.title).toBe("Whatever Show");
    expect(item?.providerId).toBe("7");
  });
});
