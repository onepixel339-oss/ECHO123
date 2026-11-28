/**
 * Client-side licensing-contract suite (T-5 client legs):
 *   T-5.1  AniList exclusion at seed/classify time.
 *   T-5.2  leak-path matrix: externalIds / work_links / provenance strips;
 *          user fields attached to AniList records stay local.
 *   T-5.3  per-provider non-regression (policy is per provider, not global).
 *   T-5.6  policy-flip drill (design-level): the pointer payload is the
 *          documented candidate; under `none` nothing AniList-derived moves.
 */
import { describe, expect, test } from "bun:test";
import {
  cloudSyncPolicyFor, classifyMediaRecord, stripAniListReferences,
  entrySyncable, classifyWorkRecord, CLOUD_SYNC_POLICIES,
} from "../../sync/policy";
import { seedMergeOps } from "../../sync/bootstrap";
import { CONFLICT_REASONS } from "../../sync/types";

const anilistRecord = {
  localId: "m-an", provider: "anilist", providerId: "21",
  mediaType: "anime" as const, format: "series" as const,
  title: "AniList Title", genres: ["drama"], posterUrl: "https://x/p.jpg",
};

describe("T-5.1 AniList record never enters the outbox", () => {
  test("classifyMediaRecord returns null for provider=anilist", () => {
    expect(classifyMediaRecord(anilistRecord)).toBeNull();
    expect(classifyMediaRecord({ ...anilistRecord, provider: "kitsu" })).toBeNull();
  });
  test("seedMergeOps excludes AniList media records entirely", () => {
    const ops = seedMergeOps(
      "dev-1", "intent-1",
      [
        { entity: "media_items", recordId: "m-an", record: anilistRecord, observedVersion: null },
        { entity: "media_items", recordId: "m-ok", record: { ...anilistRecord, localId: "m-ok", provider: "trakt", providerId: "t1" }, observedVersion: null },
      ],
      new Map(),
      () => undefined,
    );
    expect(ops.length).toBe(1);
    expect(ops[0].recordId).toBe("m-ok");
    expect(ops[0].opid).toBe("boot-dev-1-intent-1-1");
  });
});

describe("T-5.2 leak-path matrix", () => {
  test("(a) a Trakt record with an AniList id in externalIds: the AniList key is stripped, the record still syncs", () => {
    const rec = {
      localId: "m-tr", provider: "trakt", providerId: "t1",
      mediaType: "movie" as const, format: "film" as const, title: "T",
      externalIds: { trakt: "t1", anilist: "21", anilist_id: 21 },
    };
    const classified = classifyMediaRecord(rec)!;
    expect(classified).not.toBeNull();
    expect(JSON.stringify(classified)).not.toContain("anilist");
    expect((classified.externalIds as Record<string, unknown>).trakt).toBe("t1");
  });
  test("(b) work_links rows referencing AniList refs are stripped but still sync", () => {
    const rec = { id: "wl-1", workId: "w-1", relation: "adaptation", externalIds: { anilist: "50" } };
    const classified = classifyWorkRecord(rec)!;
    expect(JSON.stringify(classified)).not.toContain("anilist");
  });
  test("(c) provenance naming AniList is stripped", () => {
    const rec = stripAniListReferences({ title: "T", provenance: { title: "anilist", genres: "trakt" } });
    expect((rec.provenance as Record<string, unknown>).genres).toBe("trakt");
    expect((rec.provenance as Record<string, unknown>).title).toBeUndefined();
  });
  test("(e) user fields attached to an AniList-derived record stay local", () => {
    const providers = new Map([["m-an", "anilist"], ["m-tr", "trakt"]]);
    const lookup = (id: string) => providers.get(id);
    expect(entrySyncable({ mediaLocalId: "m-an", status: "watching" }, lookup)).toBe(false);
    expect(entrySyncable({ mediaLocalId: "m-tr", status: "watching" }, lookup)).toBe(true);
  });
  test("artwork keys never appear in any classified payload", () => {
    const rec = {
      localId: "m-w", provider: "wikidata", providerId: "Q1",
      mediaType: "movie" as const, format: "film" as const, title: "W",
      posterUrl: "https://x/p.jpg", backdropUrl: "https://x/b.jpg", trailerUrl: "https://x/t",
      synopsis: "long text",
    };
    const classified = classifyMediaRecord(rec)!;
    for (const k of ["posterUrl", "backdropUrl", "trailerUrl", "synopsis"]) {
      expect(classified).not.toHaveProperty(k);
    }
  });
});

describe("T-5.3 per-provider non-regression", () => {
  test("policy assignment matches the v1.3 PATCH1 §7.3.1 registry encoding", () => {
    expect(cloudSyncPolicyFor("anilist")).toBe("none");
    expect(cloudSyncPolicyFor("kitsu")).toBe("none");
    expect(cloudSyncPolicyFor("trakt")).toBe("full");
    expect(cloudSyncPolicyFor("wikidata")).toBe("full");
    expect(cloudSyncPolicyFor("manual")).toBe("full");
    expect(cloudSyncPolicyFor("rawg")).toBe("reference");
    expect(cloudSyncPolicyFor("tvmaze")).toBe("reference");
    expect(cloudSyncPolicyFor("openlibrary")).toBe("reference");
  });
  test("reference-level providers keep identity but lose descriptive fields", () => {
    const rec = {
      localId: "m-r", provider: "rawg", providerId: "r1",
      mediaType: "game" as const, format: "game" as const, title: "G",
      genres: ["rpg"], tags: ["open-world"],
    };
    const classified = classifyMediaRecord(rec)!;
    expect(classified.title).toBe("G");
    expect(classified).not.toHaveProperty("genres");
    expect(classified).not.toHaveProperty("tags");
  });
  test("full-level providers keep engine inputs (the taste engine cannot run without them)", () => {
    const rec = {
      localId: "m-f", provider: "trakt", providerId: "t1",
      mediaType: "series" as const, format: "series" as const, title: "S",
      genres: ["sci-fi"], tags: ["space"],
    };
    const classified = classifyMediaRecord(rec)!;
    expect(classified.genres).toEqual(["sci-fi"]);
    expect(classified.tags).toEqual(["space"]);
  });
  test("unknown providers default to the conservative reference tier", () => {
    expect(cloudSyncPolicyFor("totally-unknown")).toBe("reference");
  });
});

describe("T-5.6 policy-flip drill (design level)", () => {
  test("the pointer level exists in the vocabulary but is assigned to no provider", () => {
    const assigned = Object.entries(CLOUD_SYNC_POLICIES).filter(([, v]) => v === "pointer");
    expect(assigned).toEqual([]);
  });
  test("late-entering records (a future flip) would take the unbased merge path (base 0 → D-3)", () => {
    // Under the current `none` policy the AniList record never seeds at all
    // (T-5.1). A future registry flip (owner gate D-20) would make it a
    // newly-permitted provider — and a divergent local record with no
    // baseline then seeds exactly like any other newly-permitted record:
    // base_version = 0 against existing server state (never a silent
    // overwrite). Simulated here with a permitted provider record:
    const ops = seedMergeOps(
      "dev-1", "intent-flip",
      [{ entity: "media_items", recordId: "m-flip", record: { ...anilistRecord, localId: "m-flip", provider: "trakt", providerId: "t1" }, observedVersion: null }],
      new Map([["media_items:m-flip", { entity: "media_items", recordId: "m-flip", record: { title: "server" }, version: 7 }]]),
      () => undefined,
    );
    expect(ops.length).toBe(1);
    expect(ops[0].baseVersion).toBe(0);
  });
});

describe("T-3.11 (client leg) validator parity: TS enum == canonical six", () => {
  test("CONFLICT_REASONS equals the DB constraint set", () => {
    expect([...CONFLICT_REASONS].sort()).toEqual([
      "applied_delete", "delete_vs_edit", "delete_vs_upsert",
      "edit_edit", "schema", "stale_base_unknown_record",
    ]);
  });
});
