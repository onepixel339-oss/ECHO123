/**
 * ECHO — Search pagination regression tests (A2, audit C4: "long tails
 * unreachable"). ALL network access is mocked — no live calls.
 *
 * Covers:
 *  - the engine threads options.page into provider filters (AniList GraphQL
 *    variables carry the page);
 *  - snapshots report their page and an honest canLoadMore (true only when a
 *    NATIVELY PAGINATED provider filled its per-provider cap);
 *  - TVMaze (no upstream paging) never claims canLoadMore even on a full page;
 *  - adapters translate page → their native cursor: Wikidata `continue`,
 *    RAWG `page`, Trakt/IGDB proxy `page` query params.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runFederatedSearch } from "../federated/engine";
import { resetFederatedCooldowns } from "../federated/engine";
import { setProviderToggles } from "../providers/registry";
import { WikidataProvider } from "../providers/wikidata";
import { RawgProvider } from "../providers/rawg";
import { TraktProvider } from "../providers/trakt";
import { IgdbProvider } from "../providers/igdb";

/* ------------------------------ fetch stubbing ----------------------------- */

let calls: { url: string; body?: string }[] = [];
let responder: ((url: string, body?: string) => unknown | null) = () => null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  resetFederatedCooldowns();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body });
    const out = responder(url, body);
    if (out === null) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  responder = () => null;
  setProviderToggles(null);
  delete process.env.NEXT_PUBLIC_RAWG_API_KEY;
  delete process.env.TRAKT_CLIENT_ID;
  delete process.env.IGDB_CLIENT_ID;
  delete process.env.IGDB_CLIENT_SECRET;
  process.env.NEXT_PUBLIC_TRAKT_ENABLED = "0";
  process.env.NEXT_PUBLIC_IGDB_ENABLED = "0";
});

function anilistMedia(n: number) {
  return {
    id: 1000 + n,
    title: { romaji: `Page Test ${n}`, english: `Page Test ${n}` },
    genres: ["Drama"],
    tags: [],
    isAdult: false,
    format: "TV",
    startDate: { year: 2000 + (n % 20) },
    siteUrl: `https://anilist.co/anime/${1000 + n}`,
    description: "Test.",
    countryOfOrigin: "JP",
  };
}

function anilistPage(media: object[]) {
  return { data: { Page: { media } } };
}

/* ------------------------------ engine level ------------------------------- */

describe("federated engine — page threading (A2)", () => {
  test("options.page reaches the provider call (AniList GraphQL variables)", async () => {
    responder = (url) => {
      if (url.includes("graphql.anilist.co")) return anilistPage([anilistMedia(1)]);
      return {};
    };
    const snap = await runFederatedSearch("page threading", {
      categories: ["anime"],
      page: 3,
    });
    expect(snap.page).toBe(3);
    const gql = calls.find((c) => c.url.includes("graphql.anilist.co"));
    expect(gql).toBeDefined();
    const vars = JSON.parse(gql!.body!) as { variables: { p?: number } };
    // the GraphQL request carries the page in its variables
    expect(JSON.stringify(vars)).toContain("\"p\":3");
  });

  test("page 1 (default) sends p=1, not a missing page", async () => {
    responder = (url) => {
      if (url.includes("graphql.anilist.co")) return anilistPage([anilistMedia(1)]);
      return {};
    };
    await runFederatedSearch("default page", { categories: ["anime"] });
    const gql = calls.find((c) => c.url.includes("graphql.anilist.co"));
    const vars = JSON.parse(gql!.body!) as { variables: { p?: number } };
    expect(vars.variables.p).toBe(1);
  });

  test("canLoadMore is true when a paginated provider fills its page", async () => {
    responder = (url) => {
      if (url.includes("graphql.anilist.co"))
        return anilistPage(Array.from({ length: 8 }, (_, i) => anilistMedia(i)));
      return {};
    };
    const snap = await runFederatedSearch("full page", { categories: ["anime"] });
    const anilist = snap.providers.find((p) => p.id === "anilist");
    expect(anilist?.paginated).toBe(true);
    expect(anilist?.count).toBe(8);
    expect(snap.canLoadMore).toBe(true);
  });

  test("canLoadMore is false when the paginated provider returns a partial page", async () => {
    responder = (url) => {
      if (url.includes("graphql.anilist.co"))
        return anilistPage(Array.from({ length: 3 }, (_, i) => anilistMedia(i)));
      return {};
    };
    const snap = await runFederatedSearch("partial page", { categories: ["anime"] });
    expect(snap.canLoadMore).toBe(false);
  });

  test("a full page from a NON-paginated provider (TVMaze) never claims canLoadMore", async () => {
    responder = (url) => {
      if (url.includes("api.tvmaze.com/search")) {
        return Array.from({ length: 8 }, (_, i) => ({
          show: { id: i + 1, name: `Full Page Series ${i}`, premiered: "2020-01-01" },
        }));
      }
      return {};
    };
    const snap = await runFederatedSearch("full page series", { categories: ["series"] });
    const tvmaze = snap.providers.find((p) => p.id === "tvmaze");
    expect(tvmaze?.count).toBe(8);
    expect(tvmaze?.paginated).toBeFalsy();
    expect(snap.canLoadMore).toBe(false);
  });
});

/* ------------------------------ adapter level ------------------------------ */

describe("Wikidata adapter — continue cursor (A2)", () => {
  const provider = new WikidataProvider();

  test("page 2 requests continue=20 with the fixed 20-hit page size", async () => {
    responder = () => ({ search: [] });
    await provider.search("cursor test", { mediaTypes: ["movie"], limit: 8, page: 2 });
    const url = calls.find((c) => c.url.includes("wbsearchentities"))!.url;
    expect(url).toContain("continue=20");
    expect(url).toContain("limit=20");
  });

  test("page 1 omits the continue parameter entirely", async () => {
    responder = () => ({ search: [] });
    await provider.search("cursor test", { mediaTypes: ["movie"], limit: 8 });
    const url = calls.find((c) => c.url.includes("wbsearchentities"))!.url;
    expect(url).not.toContain("continue=");
  });

  test("different pages use different cache entries (no cross-page hits)", async () => {
    let n = 0;
    responder = (url) => {
      if (url.includes("wbsearchentities")) {
        n += 1;
        return { search: [{ id: `Q${n}`, label: `Hit ${n}` }] };
      }
      if (url.includes("wbgetentities")) {
        const ids = new URL(url).searchParams.get("ids") ?? "";
        const entities: Record<string, unknown> = {};
        for (const id of ids.split("|").filter(Boolean)) {
          entities[id] = {
            id,
            labels: { en: { language: "en", value: `Label ${id}` } },
            claims: {
              P31: [{ mainsnak: { property: "P31", datavalue: { value: { id: "Q11424" } } } }],
            },
          };
        }
        return { entities };
      }
      return {};
    };
    const a = await provider.search("cache pages", { mediaTypes: ["movie"], limit: 8, page: 1 });
    const b = await provider.search("cache pages", { mediaTypes: ["movie"], limit: 8, page: 2 });
    expect(a[0].item.providerId).not.toBe(b[0].item.providerId);
  });
});

describe("RAWG adapter — page param (A2)", () => {
  test("page 2 is forwarded as &page=2", async () => {
    process.env.NEXT_PUBLIC_RAWG_API_KEY = "test-rawg-key";
    responder = () => ({ count: 0, results: [] });
    const provider = new RawgProvider();
    await provider.search("portal", { mediaTypes: ["game"], limit: 8, page: 2 });
    const url = calls.find((c) => c.url.includes("api.rawg.io/api/games"))!.url;
    expect(url).toContain("page=2");
  });

  test("page 1 keeps the bare URL (no page param)", async () => {
    process.env.NEXT_PUBLIC_RAWG_API_KEY = "test-rawg-key";
    responder = () => ({ count: 0, results: [] });
    const provider = new RawgProvider();
    await provider.search("portal", { mediaTypes: ["game"], limit: 8 });
    const url = calls.find((c) => c.url.includes("api.rawg.io/api/games"))!.url;
    expect(url).not.toContain("page=");
  });
});

describe("proxy adapters — page reaches the proxy query (A2)", () => {
  test("Trakt asks the proxy with &page=2", async () => {
    process.env.NEXT_PUBLIC_TRAKT_ENABLED = "1";
    responder = (url) => {
      if (url.includes("/api/echo/providers/trakt")) {
        return { configured: true, results: [] };
      }
      return {};
    };
    const provider = new TraktProvider();
    await provider.search("dune", { mediaTypes: ["movie"], limit: 8, page: 2 });
    const url = calls.find((c) => c.url.includes("/api/echo/providers/trakt"))!.url;
    expect(url).toContain("page=2");
  });

  test("IGDB asks the proxy with &page=2", async () => {
    process.env.NEXT_PUBLIC_IGDB_ENABLED = "1";
    responder = (url) => {
      if (url.includes("/api/echo/providers/igdb")) {
        return { configured: true, results: [] };
      }
      return {};
    };
    const provider = new IgdbProvider();
    await provider.search("hollow knight", { mediaTypes: ["game"], limit: 8, page: 2 });
    const url = calls.find((c) => c.url.includes("/api/echo/providers/igdb"))!.url;
    expect(url).toContain("page=2");
  });
});
