/**
 * T-5.1/T-5.2(d) — the database-side legs of the licensing boundary suite:
 * AniList cloudSyncPolicy = none is enforced at the RPC hard floor, and the
 * server-side artifacts (change_log / snapshots / conflict_archive payloads)
 * never contain AniList-derived data. The client-side legs (strip rules,
 * seeding exclusion, per-provider non-regression, local-only experience,
 * export mechanics, policy-flip drill) run in the bun unit suite.
 */
import {
  suite, test, assert, assertEq, assertRejects,
  TestDb, USER_A, initUser, registerDevice, op, mediaRecord, push, pull, bootstrapStatus,
} from "../util.ts";

suite("T-5 licensing (DB legs)", () => {
  test("T-5.1 AniList media record in a push batch → rejected with a classified error; zero server rows", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const r = await push(a.client, dev, [
      op("an-1", "media_items", "m-anilist", "upsert", 0, mediaRecord({ localId: "m-anilist", provider: "anilist", providerId: "21" })),
    ]);
    assertEq(r.rejected.find((x) => x.reason === "provider_policy")?.opid, "an-1",
      "AniList record rejected server-side with provider_policy");
    assert(!r.acked.includes("an-1"), "not applied");
    const admin = await db.adminClient();
    for (const [table, where] of [
      ["change_log", "user_id = $1"],
      ["snapshots", "user_id = $1"],
      ["snapshot_pages", "snapshot_id in (select id from echo_data.snapshots where user_id = $1)"],
      ["conflict_archive", "user_id = $1"],
    ] as const) {
      const rows = await admin.query(`select count(*)::int as n from echo_data.${table} where ${where}`, [USER_A]);
      assertEq(rows.rows[0].n, 0, `no rows in ${table} for the AniList attempt`);
    }
    const media = await admin.query("select count(*)::int as n from echo_data.media_items where user_id = $1", [USER_A]);
    assertEq(media.rows[0].n, 0, "the op never left a media row");
  });

  test("T-5.2(d) server-side artifacts for a mixed library contain no AniList data", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    // a compliant mixed library: trakt + manual + wikidata records
    await push(a.client, dev, [
      op("mx-1", "media_items", "m-trakt", "upsert", 0, mediaRecord({ localId: "m-trakt", provider: "trakt", externalIds: { trakt: "t1" } })),
      op("mx-2", "media_items", "m-manual", "upsert", 0, mediaRecord({ localId: "m-manual", provider: "manual" })),
      op("mx-3", "media_items", "m-wikidata", "upsert", 0, mediaRecord({ localId: "m-wikidata", provider: "wikidata" })),
      op("mx-4", "entries", "e-mixed", "upsert", 0, { status: "watching", rating: 4 }),
    ]);
    // produce a conflict archive row too:
    await push(a.client, dev, [op("mx-5", "media_items", "m-trakt", "upsert", 0, mediaRecord({ localId: "m-trakt", provider: "trakt", title: "loser" }))]);
    // build a snapshot:
    await bootstrapStatus(a.client);

    const admin = await db.adminClient();
    for (const [table, col, where] of [
      ["change_log", "payload", "user_id = $1"],
      ["snapshot_pages", "payload", "snapshot_id in (select id from echo_data.snapshots where user_id = $1)"],
      ["conflict_archive", "client_payload", "user_id = $1"],
      ["media_items", "record", "user_id = $1"],
    ] as const) {
      const rows = await admin.query(`select ${col}::text as t from echo_data.${table} where ${where}`, [USER_A]);
      for (const row of rows.rows) {
        const t = row.t as string;
        assert(!t.includes("anilist"), `${table}.${col} contains no 'anilist' reference`);
        assert(!/"21"/.test(t) || table === "media_items", "no AniList provider ids leaked");
      }
    }
  });
});
