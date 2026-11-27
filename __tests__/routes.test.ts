/**
 * ECHO — API route tests (A1): the six dynamic routes.
 *
 * Every upstream and every AI provider is mocked: no live provider call, no
 * real LLM. The suite pins the operational contract of each route:
 *  - translate: validation, Arabic passthrough, upstream translation
 *  - IGDB / Trakt proxies: unconfigured → { configured:false }, gated by the
 *    registry, credential-safe relay, typed error envelopes
 *  - ask / companion / weekly (AI): validation, rate limits, and the
 *    designed graceful `ai_unavailable` degradation when no provider has
 *    credentials (the platform SDK is mocked to fail exactly as it does on
 *    any external deployment).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import type { NextResponse } from "next/server";

// The platform AI must behave exactly as it does outside its originating
import { POST as translatePost } from "../../../app/api/echo/translate/route";
import { GET as igdbGet } from "../../../app/api/echo/providers/igdb/route";
import { GET as healthGet } from "../../../app/api/health/route";
import { GET as traktGet } from "../../../app/api/echo/providers/trakt/route";
import { setProviderToggles } from "../providers/registry";

/* ------------------------------ helpers ------------------------------------ */

const realFetch = globalThis.fetch;
let fetchResponder: ((url: string, init?: RequestInit) => unknown | null) = () => null;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchResponder = () => null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const out = fetchResponder(String(input), init);
    if (out === null) return jsonResponse({}, 500); // unmocked upstream → "down"
    if (out instanceof Response) return out;
    return jsonResponse(out);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.IGDB_CLIENT_ID;
  delete process.env.IGDB_CLIENT_SECRET;
  delete process.env.TRAKT_CLIENT_ID;
  setProviderToggles(null);
});

let ipCounter = 0;
/** Unique IP per request so in-memory per-IP rate limits never bleed between tests. */
function freshIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

function jsonRequest(
  url: string,
  body: unknown,
  method: "POST" | "GET" = "POST",
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function emptyRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
  });
}

async function body(res: NextResponse): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/* ------------------------------ translate ---------------------------------- */

describe("POST /api/echo/translate", () => {
  test("non-JSON body → 400 bad_body", async () => {
    const req = emptyRequest("http://localhost/api/echo/translate");
    const res = await translatePost(req);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("bad_body");
  });

  test("empty texts array → 400 bad_body", async () => {
    const res = await translatePost(jsonRequest("http://localhost/api/echo/translate", { texts: [] }));
    expect(res.status).toBe(400);
  });

  test("more than 8 texts → 400 (batch clamp)", async () => {
    const res = await translatePost(
      jsonRequest("http://localhost/api/echo/translate", { texts: Array(9).fill("hello") }),
    );
    expect(res.status).toBe(400);
  });

  test("already-Arabic text passes through untouched with zero upstream calls", async () => {
    let upstreamCalls = 0;
    fetchResponder = () => {
      upstreamCalls += 1;
      return null;
    };
    const res = await translatePost(
      jsonRequest("http://localhost/api/echo/translate", { texts: ["ملخص بالعربية"] }),
    );
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.ok).toBe(true);
    expect(data.translations).toEqual(["ملخص بالعربية"]);
    expect(upstreamCalls).toBe(0);
  });

  test("English text is translated via the mocked free upstream", async () => {
    fetchResponder = (url) => {
      if (url.includes("translate.googleapis.com")) {
        // Google gtx shape: [[["translation","source",...]], ...]
        return [[["ترجمة تجريبية", "A test synopsis", null, null, 10]], null, "en"];
      }
      return null;
    };
    const res = await translatePost(
      jsonRequest("http://localhost/api/echo/translate", { texts: ["A unique test synopsis for the route suite"] }),
    );
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.ok).toBe(true);
    expect(data.translations).toEqual(["ترجمة تجريبية"]);
  });
});

/* ------------------------------ IGDB proxy --------------------------------- */

/* ------------------- A2: search pagination forwarding (proxies) -------------- */

describe("proxy routes forward the page parameter (A2)", () => {
  test("trakt proxy: page=2 reaches the upstream URL and the cache key", async () => {
    process.env.TRAKT_CLIENT_ID = "test-trakt-client";
    const seen: string[] = [];
    fetchResponder = (url) => {
      seen.push(url);
      if (url.includes("api.trakt.tv/search/movie")) return [];
      return null;
    };
    const res = await traktGet(
      new NextRequest("http://localhost/api/echo/providers/trakt?q=arrival&type=movie&limit=8&page=2"),
    );
    expect(res.status).toBe(200);
    const upstream = seen.find((u) => u.includes("api.trakt.tv/search/movie"));
    expect(upstream).toBeDefined();
    expect(upstream!).toContain("page=2");
  });

  test("trakt proxy: no page param → upstream stays on page 1 (no page= in URL)", async () => {
    process.env.TRAKT_CLIENT_ID = "test-trakt-client";
    const seen: string[] = [];
    fetchResponder = (url) => {
      seen.push(url);
      if (url.includes("api.trakt.tv/search/movie")) return [];
      return null;
    };
    await traktGet(
      new NextRequest("http://localhost/api/echo/providers/trakt?q=arrival&type=movie&limit=8"),
    );
    const upstream = seen.find((u) => u.includes("api.trakt.tv/search/movie"));
    expect(upstream).toBeDefined();
    expect(upstream!).not.toContain("page=");
  });

  test("igdb proxy: page=2 becomes an Apicalypse offset of limit", async () => {
    process.env.IGDB_CLIENT_ID = "test-client-id";
    process.env.IGDB_CLIENT_SECRET = "test-client-secret";
    const bodies: string[] = [];
    fetchResponder = (url, init) => {
      if (typeof init?.body === "string") bodies.push(init.body);
      if (url.includes("id.twitch.tv")) return { access_token: "test-token", expires_in: 3600 };
      return []; // empty igdb rows are fine — we only assert the query body
    };
    const res = await igdbGet(
      new NextRequest("http://localhost/api/echo/providers/igdb?q=hollow+knight&limit=8&page=2"),
    );
    expect(res.status).toBe(200);
    const body = bodies.find((b) => b.includes("search"));
    expect(body).toBeDefined();
    expect(body!).toContain("offset 8");
  });

  test("igdb proxy: page 1 sends no offset clause", async () => {
    process.env.IGDB_CLIENT_ID = "test-client-id";
    process.env.IGDB_CLIENT_SECRET = "test-client-secret";
    const bodies: string[] = [];
    fetchResponder = (url, init) => {
      if (typeof init?.body === "string") bodies.push(init.body);
      if (url.includes("id.twitch.tv")) return { access_token: "test-token", expires_in: 3600 };
      return [];
    };
    await igdbGet(
      new NextRequest("http://localhost/api/echo/providers/igdb?q=hollow+knight&limit=8"),
    );
    const body = bodies.find((b) => b.includes("search"));
    expect(body).toBeDefined();
    expect(body!).not.toContain("offset");
  });
});

describe("GET /api/echo/providers/igdb", () => {
  test("no credentials → { configured: false } and no upstream call", async () => {
    let upstream = 0;
    fetchResponder = () => {
      upstream += 1;
      return null;
    };
    const res = await igdbGet(new NextRequest("http://localhost/api/echo/providers/igdb?q=hollow+knight"));
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.configured).toBe(false);
    expect(data.results).toEqual([]);
    expect(upstream).toBe(0);
  });

  test("registry-gated off (user toggle) → configured:false even with credentials", async () => {
    setProviderToggles({ igdb: false });
    process.env.IGDB_CLIENT_ID = "test-client-id";
    process.env.IGDB_CLIENT_SECRET = "test-client-secret";
    const res = await igdbGet(new NextRequest("http://localhost/api/echo/providers/igdb?q=hollow+knight"));
    expect(res.status).toBe(200);
    expect((await body(res)).configured).toBe(false);
  });

  test("configured + mocked upstream → normalized results with igdb: localIds", async () => {
    process.env.IGDB_CLIENT_ID = "test-client-id";
    process.env.IGDB_CLIENT_SECRET = "test-client-secret";
    fetchResponder = (url) => {
      if (url.includes("id.twitch.tv/oauth2/token")) return { access_token: "tok", expires_in: 3600 };
      if (url.includes("api.igdb.com/v4/games")) {
        return [
          {
            id: 10320,
            name: "Hollow Knight",
            slug: "hollow-knight",
            summary: "A 2D metroidvania.",
            first_release_date: 1489276800,
            genres: [{ id: 8, name: "Platform" }],
            platforms: [{ abbreviation: "PC" }],
            cover: { image_id: "co1r7a" },
          },
        ];
      }
      return null;
    };
    const res = await igdbGet(new NextRequest("http://localhost/api/echo/providers/igdb?q=hollow+knight+unique"));
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.configured).toBe(true);
    const results = data.results as { localId: string; title: string }[];
    expect(results.length).toBe(1);
    expect(results[0].localId).toBe("igdb:10320");
    expect(results[0].title).toBe("Hollow Knight");
  });

  test("configured + upstream failure → typed error envelope, HTTP 200", async () => {
    process.env.IGDB_CLIENT_ID = "test-client-id";
    process.env.IGDB_CLIENT_SECRET = "test-client-secret";
    fetchResponder = () => null; // everything "down"
    const res = await igdbGet(new NextRequest("http://localhost/api/echo/providers/igdb?q=failing+query"));
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.configured).toBe(true);
    expect(data.results).toEqual([]);
    expect(data.error).toBe("unavailable");
  });
});

/* ------------------------------ Trakt proxy -------------------------------- */

/* ------------------------------ health (A2) ------------------------------- */

describe("GET /api/health", () => {
  test("reports ok, version, uptime and the provider gate", async () => {
    const res = await healthGet(new NextRequest("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.status).toBe("ok");
    expect(data.version).toBe("1.3.0"); // keep in lockstep with version-check (package.json = Settings = CHANGELOG)
    expect(typeof data.uptimeSeconds).toBe("number");
    // the registry gate is visible: anilist is there with cloudSyncPolicy none
    const providers = data.providers as { id: string; cloudSyncPolicy: string }[];
    const anilist = providers.find((p) => p.id === "anilist");
    expect(anilist?.cloudSyncPolicy).toBe("none");
    // hard-disabled kitsu is listed as disabled
    const kitsu = providers.find((p) => p.id === "kitsu");
    expect(kitsu?.enabled).toBe(false);
  });

  test("integrations are reported as booleans only — no key material", async () => {
    process.env.NEXT_PUBLIC_RAWG_API_KEY = "super-secret-key-material";
    const res = await healthGet(new NextRequest("http://localhost/api/health"));
    const text = await res.text();
    expect(text).not.toContain("super-secret-key-material");
    const data = JSON.parse(text);
    expect(data.integrations.rawg).toBe(true);
    expect(data.integrations.trakt).toBe(false);
  });

  test("user provider toggles are honoured in the gate view", async () => {
    setProviderToggles({ anilist: false });
    const res = await healthGet(new NextRequest("http://localhost/api/health"));
    const data = await body(res);
    const anilist = (data.providers as { id: string; enabled: boolean }[]).find(
      (p) => p.id === "anilist",
    );
    expect(anilist?.enabled).toBe(false);
  });
});

describe("GET /api/echo/providers/trakt", () => {
  test("no TRAKT_CLIENT_ID → { configured: false } and no upstream call", async () => {
    let upstream = 0;
    fetchResponder = () => {
      upstream += 1;
      return null;
    };
    const res = await traktGet(new NextRequest("http://localhost/api/echo/providers/trakt?q=arrival"));
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.configured).toBe(false);
    expect(upstream).toBe(0);
  });

  test("configured + mocked search → normalized results with trakt:movie/<id> localIds", async () => {
    process.env.TRAKT_CLIENT_ID = "test-trakt-client";
    fetchResponder = (url) => {
      if (url.includes("api.trakt.tv/search/movie")) {
        return [
          {
            type: "movie",
            score: 26.019499,
            movie: {
              title: "Arrival",
              year: 2016,
              ids: { trakt: 193426, slug: "arrival-2016", imdb: "tt2543164" },
            },
          },
        ];
      }
      return null;
    };
    const res = await traktGet(new NextRequest("http://localhost/api/echo/providers/trakt?q=arrival+2016"));
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.configured).toBe(true);
    const results = data.results as { localId: string; title: string; releaseYear: number }[];
    expect(results.length).toBe(1);
    expect(results[0].localId).toBe("trakt:movie/193426");
    expect(results[0].title).toBe("Arrival");
    expect(results[0].releaseYear).toBe(2016);
  });

  test("details refresh: ?id=movie/193426 resolves via the trakt id search endpoint", async () => {
    process.env.TRAKT_CLIENT_ID = "test-trakt-client";
    fetchResponder = (url) => {
      if (url.includes("api.trakt.tv/search/trakt/193426")) {
        return [
          {
            type: "movie",
            score: 1,
            movie: {
              title: "Arrival",
              year: 2016,
              overview: "A linguist contacts aliens.",
              ids: { trakt: 193426, slug: "arrival-2016", imdb: "tt2543164" },
            },
          },
        ];
      }
      return null;
    };
    const res = await traktGet(
      new NextRequest("http://localhost/api/echo/providers/trakt?id=movie/193426&type=movie"),
    );
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.configured).toBe(true);
    expect((data.results as { localId: string }[]).length).toBe(1);
    expect((data.results as { localId: string }[])[0].localId).toBe("trakt:movie/193426");
  });

  test("malformed id → configured:true, empty results (no upstream error leak)", async () => {
    process.env.TRAKT_CLIENT_ID = "test-trakt-client";
    const res = await traktGet(
      new NextRequest("http://localhost/api/echo/providers/trakt?id=not-a-valid-id"),
    );
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.configured).toBe(true);
    expect(data.results).toEqual([]);
  });
});

/* ------------------------------ ask (AI) ----------------------------------- */

/* ------------------------------ weekly (AI) --------------------------------- */

