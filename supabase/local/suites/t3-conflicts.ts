/**
 * T-3.1…T-3.14 — conflict decision/archive tests (v1.2 §5.5 + PATCH1 §5.5).
 */
import {
  suite, test, assert, assertEq, assertRejects,
  TestDb, TestDb as Db, USER_A, USER_B, USER_C, initUser, registerDevice, op, mediaRecord, push, pull, status, runJob,
} from "../util.ts";
import { readFileSync } from "node:fs";

async function expectFailInTx(
  admin: { query: (sql: string, v?: unknown[]) => Promise<{ rows: unknown[] }> },
  sql: string,
  params: unknown[],
  needle: string,
) {
  await admin.query("savepoint sp");
  try {
    await admin.query(sql, params);
    throw new Error(`expected a rejection containing '${needle}' but the statement succeeded`);
  } catch (e) {
    if (!String((e as Error).message).includes(needle)) throw e;
  }
  await admin.query("rollback to savepoint sp");
  await admin.query("release savepoint sp");
}

async function conflictsOf(db: Db, userId: string) {
  const admin = await db.adminClient();
  const res = await admin.query(
    "select id, entity, record_id, reason, base_version, server_version, resolved_at, resolution, client_payload from echo_data.conflict_archive where user_id = $1 order by id", [userId]);
  return res.rows as {
    id: number; entity: string; record_id: string; reason: string;
    base_version: number | null; server_version: number | null;
    resolved_at: string | null; resolution: string | null; client_payload: Record<string, unknown>;
  }[];
}

async function entityRow(db: Db, userId: string, table: string, key: string) {
  const admin = await db.adminClient();
  const res = await admin.query(`select * from echo_data.${table} where user_id = $1 and local_id = $2`, [userId, key]);
  return res.rows[0] as { version: number; deleted_at: string | null; record: Record<string, unknown> | null } | undefined;
}

suite("T-3 conflicts", () => {
  test("T-3.1 stale delete (D-4): not applied, archived delete_vs_edit, server record intact", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const r1 = await push(a.client, dev, [op("t31-1", "media_items", "m-t31", "upsert", 0, mediaRecord({ localId: "m-t31", title: "original" }))]);
    const v = r1.archived.length === 0 ? r1.headSeq : 0;
    // now a delete with a STALE base (server already at v ≥ 1):
    const r2 = await push(a.client, dev, [op("t31-2", "media_items", "m-t31", "delete", 0)]);
    assertEq(r2.archived.filter((x) => x.reason === "delete_vs_edit").length, 1, "D-4 archives the delete intent");
    assert(!r2.acked.includes("t31-2"), "the stale delete is NOT applied");
    const row = await entityRow(db, USER_A, "media_items", "m-t31");
    assert(row && row.deleted_at === null, "server record stays live");
    assertEq(row!.record!.title, "original", "server content untouched");
  });

  test("T-3.2 confirmed delete (D-2): applied + applied_delete snapshot archived", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const r1 = await push(a.client, dev, [op("t32-1", "media_items", "m-t32", "upsert", 0, mediaRecord({ localId: "m-t32", title: "to-be-deleted" }))]);
    const st1 = await status(a.client);
    const cur = (await entityRow(db, USER_A, "media_items", "m-t32"))!.version;
    const r2 = await push(a.client, dev, [op("t32-2", "media_items", "m-t32", "delete", cur)]);
    assert(r2.acked.includes("t32-2"), "delete applied");
    assertEq(r2.archived.filter((x) => x.reason === "applied_delete").length, 1, "D-2 archives the superseded snapshot");
    const row = await entityRow(db, USER_A, "media_items", "m-t32");
    assert(row && row.deleted_at !== null, "tombstone present");
    assertEq(row!.record, null, "tombstone record = null");
    const arcs = await conflictsOf(db, USER_A);
    const snapRow = arcs.find((x) => x.reason === "applied_delete")!;
    assertEq((snapRow.client_payload.record as Record<string, unknown>).title, "to-be-deleted",
      "archived snapshot holds the superseded content");
  });

  test("T-3.3 restore round-trip (INV-18)", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("t33-1", "media_items", "m-t33", "upsert", 0, mediaRecord({ localId: "m-t33", title: "first" }))]);
    const cur = (await entityRow(db, USER_A, "media_items", "m-t33"))!.version;
    // produce an edit_edit conflict (stale upsert)
    const r2 = await push(a.client, dev, [op("t33-2", "media_items", "m-t33", "upsert", 0, mediaRecord({ localId: "m-t33", title: "stale-loser" }))]);
    assertEq(r2.archived.filter((x) => x.reason === "edit_edit").length, 1, "D-3 archived");
    const arc = (await conflictsOf(db, USER_A)).find((x) => x.reason === "edit_edit")!;

    // restore: get the pushable op, push it with the suggested base
    const res = await a.client.query("select public.sync_conflict_resolve($1, 'restore') as r", [arc.id]);
    const pushOp = res.rows[0].r.pushOp as { op: string; entity: string; recordId: string; record: Record<string, unknown>; suggestedBaseVersion: number };
    assertEq(pushOp.record.title, "stale-loser", "archived payload returned");
    const r3 = await push(a.client, dev, [op(`restore-${arc.id}`, pushOp.entity, pushOp.recordId, "upsert", pushOp.suggestedBaseVersion, pushOp.record)]);
    assert(r3.acked.includes(`restore-${arc.id}`), "restored op applied (CAS'd fresh push)");
    const row = await entityRow(db, USER_A, "media_items", "m-t33");
    assertEq(row!.record!.title, "stale-loser", "restored content is live");
    const arcAfter = (await conflictsOf(db, USER_A)).find((x) => x.id === arc.id)!;
    assert(arcAfter.resolved_at !== null && arcAfter.resolution === "restored", "archive row marked restored");
  });

  test("T-3.4 table-driven D-1…D-10 enumeration (classification actually taken)", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const R = mediaRecord();

    // D-8: absent, base 0 → apply
    let r = await push(a.client, dev, [op("d8", "media_items", "m-d8", "upsert", 0, { ...R, localId: "m-d8" })]);
    assert(r.acked.includes("d8") && r.archived.length === 0, "D-8 fresh insert applies");
    let v8 = (await entityRow(db, USER_A, "media_items", "m-d8"))!.version;

    // D-1: live, b = v → apply fast path
    r = await push(a.client, dev, [op("d1", "media_items", "m-d8", "upsert", v8, { ...R, localId: "m-d8", title: "d1 edit" })]);
    assert(r.acked.includes("d1"), "D-1 applies");
    let v1 = (await entityRow(db, USER_A, "media_items", "m-d8"))!.version;
    assert(v1 > v8, "version advanced");

    // D-3: live, b < v → archive edit_edit, server stays
    r = await push(a.client, dev, [op("d3", "media_items", "m-d8", "upsert", v8, { ...R, localId: "m-d8", title: "d3 loser" })]);
    assertEq(r.archived[0]?.reason, "edit_edit", "D-3 archives");
    assertEq((await entityRow(db, USER_A, "media_items", "m-d8"))!.record!.title, "d1 edit", "D-3 server state wins");

    // D-10: live, b > v → apply + server_rebuild marker
    r = await push(a.client, dev, [op("d10", "media_items", "m-d8", "upsert", v1 + 1000, { ...R, localId: "m-d8", title: "d10 rebuild" })]);
    assert(r.acked.includes("d10"), "D-10 applies");
    const logD10 = await (await db.adminClient()).query(
      "select payload from echo_data.change_log where user_id = $1 and record_id = 'm-d8' order by seq desc limit 1", [USER_A]);
    assert(logD10.rows[0].payload._echoServerRebuild === true, "D-10 carries the server_rebuild marker");

    // D-2: live, b = v, delete → apply + applied_delete
    const v10 = (await entityRow(db, USER_A, "media_items", "m-d8"))!.version;
    r = await push(a.client, dev, [op("d2", "media_items", "m-d8", "delete", v10)]);
    assert(r.acked.includes("d2"), "D-2 applies the delete");
    const vTomb = (await entityRow(db, USER_A, "media_items", "m-d8"))!.version;

    // D-5: tombstone, b = v → informed resurrection
    r = await push(a.client, dev, [op("d5", "media_items", "m-d8", "upsert", vTomb, { ...R, localId: "m-d8", title: "d5 resurrected" })]);
    assert(r.acked.includes("d5"), "D-5 resurrection applies");
    const row5 = await entityRow(db, USER_A, "media_items", "m-d8");
    assert(row5!.deleted_at === null && row5!.record!.title === "d5 resurrected", "D-5 restored live");
    const v5 = row5!.version;

    // D-6: tombstone, b < v → delete wins, archived
    await push(a.client, dev, [op("d6-del", "media_items", "m-d8", "delete", v5)]);
    const vTomb2 = (await entityRow(db, USER_A, "media_items", "m-d8"))!.version;
    r = await push(a.client, dev, [op("d6", "media_items", "m-d8", "upsert", vTomb2 - 1, { ...R, localId: "m-d8", title: "d6 loser" })]);
    assertEq(r.archived[0]?.reason, "delete_vs_upsert", "D-6 archives (anti-resurrection)");
    assert((await entityRow(db, USER_A, "media_items", "m-d8"))!.deleted_at !== null, "tombstone kept");

    // D-7: tombstone, any base → no-op confirmation
    r = await push(a.client, dev, [op("d7", "media_items", "m-d8", "delete", vTomb2)]);
    assert(r.acked.includes("d7"), "D-7 confirmed");

    // D-9: absent, b > 0 → archive stale_base_unknown_record
    r = await push(a.client, dev, [op("d9", "media_items", "m-absent", "upsert", 42, { ...R, localId: "m-absent" })]);
    assertEq(r.archived[0]?.reason, "stale_base_unknown_record", "D-9 archives");
    assert(!(await entityRow(db, USER_A, "media_items", "m-absent")), "D-9 did not insert");

    // D-4: live, b < v, delete → NOT applied, archived (resurrect first so
    // the stored row is LIVE again — the D-6/D-7 chain left a tombstone)
    const vTomb3 = (await entityRow(db, USER_A, "media_items", "m-d8"))!.version;
    await push(a.client, dev, [op("d5b", "media_items", "m-d8", "upsert", vTomb3, mediaRecord({ localId: "m-d8", title: "live-again" }))]);
    const vLive = (await entityRow(db, USER_A, "media_items", "m-d8"))!.version;
    r = await push(a.client, dev, [op("d4", "media_items", "m-d8", "delete", vLive - 1)]);
    assertEq(r.archived[0]?.reason, "delete_vs_edit", "D-4 archives the delete intent");
    const rowD4 = await entityRow(db, USER_A, "media_items", "m-d8");
    assert(rowD4!.deleted_at === null && rowD4!.record!.title === "live-again", "D-4: delete NOT applied — server record stays live");
  });

  test("T-3.5 permutation pair (INV-3b): exactly one winner, loser archived, either order", async (db: Db) => {
    for (const order of [0, 1]) {
      const u = order === 0 ? USER_A : USER_B;
      const a = await initUser(db, u);
      const d1 = await registerDevice(a.client, "dev1");
      const d2 = await registerDevice(a.client, "dev2");
      await push(a.client, d1, [op("p-base", "media_items", "m-perm", "upsert", 0, mediaRecord({ localId: "m-perm", title: "base" }))]);
      const v = (await entityRow(db, u, "media_items", "m-perm"))!.version;
      const first = order === 0 ? d1 : d2;
      const second = order === 0 ? d2 : d1;
      await push(a.client, first, [op("p-a", "media_items", "m-perm", "upsert", v, mediaRecord({ localId: "m-perm", title: "A" }))]);
      const r2 = await push(a.client, second, [op("p-b", "media_items", "m-perm", "upsert", v, mediaRecord({ localId: "m-perm", title: "B" }))]);
      const winner = (await entityRow(db, u, "media_items", "m-perm"))!.record!.title;
      assertEq(winner, "A", "the later-arriving op is archived (arrival order decides; INV-3b)");
      assertEq(r2.archived.length, 1, "the loser is in the archive with both payloads");
      assertEq((Number(r2.archived[0].serverVersion ?? 0)) > Number(v), true, "archive records the server version it lost to");
    }
  });

  test("T-3.6 recreate-after-delete chain (D-5 informed vs D-6 stale vs D-9 post-GC)", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("rad-1", "media_items", "m-rad", "upsert", 0, mediaRecord({ localId: "m-rad" }))]);
    const v = (await entityRow(db, USER_A, "media_items", "m-rad"))!.version;
    await push(a.client, dev, [op("rad-2", "media_items", "m-rad", "delete", v)]);
    const vt = (await entityRow(db, USER_A, "media_items", "m-rad"))!.version;
    // informed resurrection with matching base:
    const r = await push(a.client, dev, [op("rad-3", "media_items", "m-rad", "upsert", vt, mediaRecord({ localId: "m-rad", title: "back" }))]);
    assert(r.acked.includes("rad-3"), "informed resurrection applies");
    // stale-base upsert after the resurrection:
    const v2 = (await entityRow(db, USER_A, "media_items", "m-rad"))!.version;
    const r2 = await push(a.client, dev, [op("rad-4", "media_items", "m-rad", "upsert", v2 - 1, mediaRecord({ localId: "m-rad", title: "stale" }))]);
    assertEq(r2.archived[0]?.reason, "edit_edit", "stale base after resurrection archives");
  });

  test("T-3.7 randomized 3-device torture (N=200 ops; no silent loss)", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const devices = [await registerDevice(a.client, "t1"), await registerDevice(a.client, "t2"), await registerDevice(a.client, "t3")];
    let archivedCount = 0;
    let appliedCount = 0;
    let curVersion = 0;
    const rand = (n: number) => Math.floor(Math.random() * n);
    for (let i = 0; i < 200; i++) {
      const d = devices[rand(3)];
      const isDelete = rand(4) === 0;
      const base = Math.max(0, curVersion - rand(3)); // sometimes stale
      const r = await push(a.client, d, [
        isDelete
          ? op(`tort-${i}`, "media_items", "m-tort", "delete", base)
          : op(`tort-${i}`, "media_items", "m-tort", "upsert", base, mediaRecord({ localId: "m-tort", title: `v${i}` })),
      ]);
      appliedCount += r.acked.length;
      archivedCount += r.archived.length;
      const row = await entityRow(db, USER_A, "media_items", "m-tort");
      curVersion = row ? row.version : 0;
      // invariant: only D-2 (applied_delete) is both applied and archived;
      // every other archived reason means the op was NOT applied
      for (const arc of r.archived) {
        if (arc.reason === "applied_delete") continue;
        assert(!r.acked.includes(arc.opid), `archived op ${arc.opid} (${arc.reason}) must not be applied`);
      }
      for (const ack of r.acked) {
        const arc = r.archived.find((x) => x.opid === ack);
        assert(!arc || arc.reason === "applied_delete", `applied op ${ack} must not be a loser archive`);
      }
    }
    assert(appliedCount > 50 && archivedCount > 5, `torture exercised both paths (applied=${appliedCount}, archived=${archivedCount})`);
  });

  test("T-3.8 lifecycle-correctness survival matrix", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const admin = await db.adminClient();
    // (i) unresolved rows 1 year old; (ii) resolved 91 days ago; (iii) resolved 10 days ago;
    // (iv) applied_delete rows 15 and 10 days old.
    for (let i = 0; i < 5; i++) {
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, base_version, server_version, client_payload, created_at, resolved_at, resolution)
         values ($1, 'entries', $2, 'edit_edit', 1, 2, '{"record":{}}', now() - interval '365 days', null, null)`, [USER_A, `unres-${i}`]);
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, base_version, server_version, client_payload, created_at, resolved_at, resolution)
         values ($1, 'entries', $2, 'edit_edit', 1, 2, '{"record":{}}', now() - interval '120 days', now() - interval '91 days', 'restored')`, [USER_A, `res-old-${i}`]);
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, base_version, server_version, client_payload, created_at, resolved_at, resolution)
         values ($1, 'entries', $2, 'edit_edit', 1, 2, '{"record":{}}', now() - interval '30 days', now() - interval '10 days', 'discarded')`, [USER_A, `res-new-${i}`]);
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, base_version, server_version, client_payload, created_at)
         values ($1, 'entries', $2, 'applied_delete', 3, 4, '{"record":{}}', now() - interval '15 days')`, [USER_A, `adel-old-${i}`]);
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, base_version, server_version, client_payload, created_at)
         values ($1, 'entries', $2, 'applied_delete', 3, 4, '{"record":{}}', now() - interval '10 days')`, [USER_A, `adel-new-${i}`]);
    }
    await runJob(db, "sync_job_cleanup", USER_A);
    const remaining = await conflictsOf(db, USER_A);
    const ids = remaining.map((r) => r.record_id);
    for (let i = 0; i < 5; i++) {
      assert(ids.includes(`unres-${i}`), `(i) unresolved never expires: unres-${i}`);
      assert(!ids.includes(`res-old-${i}`), `(ii) resolved 91d removed`);
      assert(ids.includes(`res-new-${i}`), `(iii) resolved 10d retained`);
      assert(!ids.includes(`adel-old-${i}`), `(iv) applied_delete 15d removed`);
      assert(ids.includes(`adel-new-${i}`), `(iv) applied_delete 10d retained`);
    }
  });

  test("T-3.9 reason-code acceptance on the fresh six-value DDL", async (db: Db) => {
    const admin = await db.adminClient();
    for (const reason of ["edit_edit", "delete_vs_upsert", "delete_vs_edit", "applied_delete", "stale_base_unknown_record", "schema"]) {
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', $2, $3, '{}')`, [USER_A, `code-${reason}`, reason]);
    }
    await assertRejects(
      async () => admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', 'bad', 'not_a_reason', '{}')`, [USER_A]),
      "conflict_archive_reason_check", "invalid code rejected");
  });

  test("T-3.10 reason-code migration from the inherited four-value DDL", async (db: Db) => {
    // Isolated user + dedicated session; the constraint swap and the §5.3.4
    // migration run inside one transaction that is always rolled back at the
    // end (this test mutates schema shape deliberately).
    const c = await db.userClient(USER_C);
    const admin = await db.adminClient();
    await admin.query("insert into auth.users (id, email) values ($1, 'c@t.local') on conflict do nothing", [USER_C]);
    await admin.query("insert into echo_data.profiles (id) values ($1) on conflict do nothing", [USER_C]);
    await admin.query("begin");
    try {
      // earlier tests in this suite created six-value rows; the four-value
      // swap must run against an empty table (the rollback restores them)
      await admin.query("delete from echo_data.conflict_archive");
      await admin.query("alter table echo_data.conflict_archive drop constraint conflict_archive_reason_check");
      await admin.query(`alter table echo_data.conflict_archive add constraint conflict_archive_reason_check
        check (reason in ('edit_edit','delete_vs_upsert','stale_base_unknown_record','schema'))`);
      // seed a legacy row
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', 'legacy-1', 'edit_edit', '{}')`, [USER_C]);
      // the inherited shape rejects the new codes (inside a savepoint so the
      // expected failure does not abort the outer transaction):
      await expectFailInTx(admin,
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', 'legacy-2', 'delete_vs_edit', '{}')`, [USER_C],
        "conflict_archive_reason_check");
      // apply the §5.3.4 migration (same SQL as 0007):
      const migration = readFileSync(
        new URL("../../migrations/0007_reason_constraint.sql", import.meta.url), "utf8");
      await admin.query(migration);
      // legacy rows remain valid; new codes insert; invalid still rejected:
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', 'legacy-2', 'delete_vs_edit', '{}')`, [USER_C]);
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', 'legacy-3', 'applied_delete', '{}')`, [USER_C]);
      await expectFailInTx(admin,
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', 'legacy-bad', 'nope', '{}')`, [USER_C],
        "conflict_archive_reason_check");
    } finally {
      await admin.query("rollback");
    }
    void c;
  });

  test("T-3.11 validator parity: DB constraint set == canonical six (TS side pinned in the bun suite)", async (db: Db) => {
    const admin = await db.adminClient();
    const res = await admin.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'echo_data.conflict_archive'::regclass and conname = 'conflict_archive_reason_check'`);
    const def = res.rows[0].def as string;
    for (const code of ["edit_edit", "delete_vs_upsert", "delete_vs_edit", "applied_delete", "stale_base_unknown_record", "schema"]) {
      assert(def.includes(code), `constraint contains ${code}`);
    }
    assertEq((def.match(/,/g) || []).length, 5, "exactly six values");
  });

  test("T-3.12 archive-write failure atomicity", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const admin = await db.adminClient();
    await push(a.client, dev, [op("atom-1", "media_items", "m-atom", "upsert", 0, mediaRecord({ localId: "m-atom", title: "live" }))]);
    const v = (await entityRow(db, USER_A, "media_items", "m-atom"))!.version;

    // inject a failure into conflict_archive inserts for a marked payload
    await admin.query(`
      create or replace function echo_data.fail_marked_archive() returns trigger
      language plpgsql as $$
      begin
        if new.client_payload::text like '%ATOMIC_FAIL%' then
          raise exception 'injected archive failure';
        end if;
        return new;
      end $$`);
    await admin.query(`create trigger fail_marked_archive before insert on echo_data.conflict_archive
      for each row execute function echo_data.fail_marked_archive()`);

    // a D-3 push whose archived loser carries the marker → whole op rolls back
    await assertRejects(
      async () => a.client.query("select public.sync_push($1::jsonb, $2, null)", [
        JSON.stringify([{ opid: "atom-3", entity: "media_items", recordId: "m-atom", op: "upsert", baseVersion: 0, record: { ...mediaRecord({ localId: "m-atom" }), title: "ATOMIC_FAIL" } }]),
        dev,
      ]), "injected archive failure", "archive write failure surfaces");

    await admin.query("drop trigger fail_marked_archive on echo_data.conflict_archive");
    await admin.query("drop function echo_data.fail_marked_archive()");

    // nothing partial: the live row is intact at its version, no archive rows for m-atom
    const row = await entityRow(db, USER_A, "media_items", "m-atom");
    assertEq(row!.record!.title, "live", "server record untouched by the failed archive write");
    const arcs = await conflictsOf(db, USER_A);
    assert(!arcs.some((x) => x.record_id === "m-atom"), "no partial archive row");
  });

  test("T-3.13 cap and backpressure (near_full at 160; full at 200; self-healing)", async (db: Db) => {
    const a = await initUser(db, USER_C);
    const dev = await registerDevice(a.client);
    const admin = await db.adminClient();

    // seed unresolved conflicts directly (count-level setup; USER_C is isolated)
    for (let i = 0; i < 159; i++) {
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', $2, 'edit_edit', '{}')`, [USER_C, `cap-${i}`]);
    }
    let st = await status(a.client);
    assertEq(st.archiveState.state, "ok", "159 → ok");

    // one more via a real push (D-3) → 160 → near_full
    await push(a.client, dev, [op("cap-seed", "media_items", "m-cap", "upsert", 0, mediaRecord({ localId: "m-cap" }))]);
    const v = (await entityRow(db, USER_C, "media_items", "m-cap"))!.version;
    await push(a.client, dev, [op("cap-160", "media_items", "m-cap", "upsert", v - 1, mediaRecord({ localId: "m-cap", title: "loser" }))]);
    st = await status(a.client);
    assertEq(st.archiveState.state, "near_full", "160 → near_full");

    // fill to exactly 200 unresolved (160 + 40 seeded)
    for (let i = 160; i < 200; i++) {
      await admin.query(
        `insert into echo_data.conflict_archive (user_id, entity, record_id, reason, client_payload)
         values ($1, 'entries', $2, 'edit_edit', '{}')`, [USER_C, `cap-${i}`]);
    }
    st = await status(a.client);
    assertEq(st.archiveState.state, "full", "200 → full");

    // at 200: a NEW conflict-generating op is rejected with conflict_archive_full …
    const rFull = await push(a.client, dev, [op("cap-200", "media_items", "m-cap", "upsert", v - 1, mediaRecord({ localId: "m-cap", title: "rejected-loser" }))]);
    assertEq(rFull.rejected.find((x) => x.reason === "conflict_archive_full")?.opid, "cap-200",
      "conflict-generating op rejected with conflict_archive_full");
    assert(!rFull.acked.includes("cap-200"), "not applied");
    // …while a NON-conflicting op in the same batch still applies:
    const rMixed = await push(a.client, dev, [
      op("cap-nc", "entries", "e-cap-nc", "upsert", 0, { status: "watching" }),
      op("cap-cf", "media_items", "m-cap", "upsert", v - 1, mediaRecord({ localId: "m-cap", title: "another-loser" })),
    ]);
    assert(rMixed.acked.includes("cap-nc"), "non-conflicting op commits");
    assert(!!rMixed.rejected.find((x) => x.opid === "cap-cf" && x.reason === "conflict_archive_full"), "conflicting op rejected");

    // resolve some rows → capacity frees → the rejected op drains on retry
    const arcs = await conflictsOf(db, USER_C);
    for (const arc of arcs.slice(0, 10)) {
      await a.client.query("select public.sync_conflict_resolve($1, 'discard')", [arc.id]);
    }
    const retry = await push(a.client, dev, [op("cap-200", "media_items", "m-cap", "upsert", v - 1, mediaRecord({ localId: "m-cap", title: "rejected-loser" }))]);
    assert(retry.archived.length === 1, "after resolution the previously rejected op drains (archived as the conflict it is)");
    // unresolved rows were never deleted by anything:
    const after = await conflictsOf(db, USER_C);
    assertEq(after.filter((x) => x.resolved_at === null).length, 200 - 10 + 1, "unresolved count consistent (190 + the drained one)");
  });

  test("T-3.14 applied_delete 14-day lifecycle", async (db: Db) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("ad-1", "media_items", "m-ad", "upsert", 0, mediaRecord({ localId: "m-ad", title: "deleteme" }))]);
    const v = (await entityRow(db, USER_A, "media_items", "m-ad"))!.version;
    await push(a.client, dev, [op("ad-2", "media_items", "m-ad", "delete", v)]);
    // backdate the applied_delete archive row 15 days:
    const admin = await db.adminClient();
    await admin.query(
      "update echo_data.conflict_archive set created_at = now() - interval '15 days' where user_id = $1 and reason = 'applied_delete'", [USER_A]);
    await runJob(db, "sync_job_cleanup", USER_A);
    const arcs = await conflictsOf(db, USER_A);
    assert(!arcs.some((x) => x.reason === "applied_delete"), "15-day-old applied_delete removed exactly at the window");
  });
});
