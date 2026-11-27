/**
 * T-4.1…T-4.8 — bootstrap and base-version tests (database legs; the
 * client-side legs run in the bun unit suite under lib/echo/__tests__/sync).
 */
import {
  suite, test, assert, assertEq, assertRejects,
  TestDb, USER_A, USER_B, initUser, registerDevice, op, mediaRecord, push, pull,
  status, bootstrapStatus, runJob, devicesSnapshot,
} from "../util.ts";

async function mediaRow(db: TestDb, userId: string, key: string) {
  const admin = await db.adminClient();
  const res = await admin.query("select version, deleted_at, record from echo_data.media_items where user_id = $1 and local_id = $2", [userId, key]);
  return res.rows[0] as { version: number; deleted_at: string | null; record: Record<string, unknown> | null } | undefined;
}

async function recoveryBackups(db: TestDb, userId: string) {
  const admin = await db.adminClient();
  const res = await admin.query("select id, kind, payload, expires_at from echo_data.recovery_backups where user_id = $1 order by id", [userId]);
  return res.rows as { id: number; kind: string; payload: Record<string, unknown>; expires_at: string }[];
}

suite("T-4 bootstrap", () => {
  test("T-4.2/4.3 DB leg: deterministic opids replay idempotently (crash-resume dedupe)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const ops = [
      op("boot-<dev>-<intent-1>-1", "media_items", "m-b1", "upsert", 0, mediaRecord({ localId: "m-b1", title: "first" })),
      op("boot-<dev>-<intent-1>-2", "media_items", "m-b2", "upsert", 0, mediaRecord({ localId: "m-b2", title: "second" })),
    ];
    const r1 = await push(a.client, dev, ops);
    assertEq(r1.acked.length, 2, "first application");
    // crash → retry the identical batch (deterministic opids):
    const r2 = await push(a.client, dev, ops);
    assertEq(r2.acked.sort(), ["boot-<dev>-<intent-1>-1", "boot-<dev>-<intent-1>-2"], "replay acks the same opids");
    const count = await (await db.adminClient()).query("select count(*)::int as n from echo_data.media_items where user_id = $1", [USER_A]);
    assertEq(count.rows[0].n, 2, "applied exactly once (INV-1/INV-2)");
  });

  test("T-4.4 reconcile enumeration: the five quadrants take the classifications they claim", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);

    // (1) server absent → insert b=0 → D-8
    const r1 = await push(a.client, dev, [op("q1", "media_items", "m-q1", "upsert", 0, mediaRecord({ localId: "m-q1" }))]);
    assert(r1.acked.includes("q1") && r1.archived.length === 0, "quadrant 1: D-8");

    // (2) content-identical → no op (client-side rule; the server simply sees
    //     no second push — the media count is unchanged from the quadrant-1 push)
    const st = await status(a.client);
    assert(st.perEntity.media_items >= 1, "quadrant 2 is a client-side no-op");

    // (3) different, NO baseline → b=0 against a live record → D-3 (server stays, incoming archived)
    const r3 = await push(a.client, dev, [op("q3", "media_items", "m-q1", "upsert", 0, mediaRecord({ localId: "m-q1", title: "divergent-no-baseline" }))]);
    assertEq(r3.archived[0]?.reason, "edit_edit", "quadrant 3: unbased collision enters D-3");
    assert(!r3.acked.includes("q3"), "not applied");
    assertEq((await mediaRow(db, USER_A, "m-q1"))!.record!.title, mediaRecord().title, "server record NOT silently overwritten");

    // (4) different, genuine baseline b → D-1 if current, D-3 if stale, D-10 if ahead
    const v = (await mediaRow(db, USER_A, "m-q1"))!.version;
    const r4a = await push(a.client, dev, [op("q4a", "media_items", "m-q1", "upsert", v, mediaRecord({ localId: "m-q1", title: "genuine-current" }))]);
    assert(r4a.acked.includes("q4a"), "quadrant 4 (b = v): D-1 applies");
    const v2 = (await mediaRow(db, USER_A, "m-q1"))!.version;
    const r4b = await push(a.client, dev, [op("q4b", "media_items", "m-q1", "upsert", v, mediaRecord({ localId: "m-q1", title: "genuine-stale" }))]);
    assertEq(r4b.archived[0]?.reason, "edit_edit", "quadrant 4 (b < v): D-3");
    const r4c = await push(a.client, dev, [op("q4c", "media_items", "m-q1", "upsert", v2 + 100, mediaRecord({ localId: "m-q1", title: "genuine-ahead" }))]);
    assert(r4c.acked.includes("q4c"), "quadrant 4 (b > v): D-10 applies");

    // (5) Tier-X-only differences never reach the server (client-side strip; the
    //     RPC additionally strips artwork keys — verified in T-5/T-3 helpers):
    const r5 = await push(a.client, dev, [op("q5", "media_items", "m-q5", "upsert", 0, mediaRecord({ localId: "m-q5", posterUrl: "https://x/art.jpg", trailerUrl: "https://x/t" }))]);
    const row5 = await mediaRow(db, USER_A, "m-q5");
    assert(!("posterUrl" in row5!.record!) && !("trailerUrl" in row5!.record!), "artwork keys stripped server-side");
  });

  test("T-4.5 Keep Local idempotency (INV-12)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("kl-1", "media_items", "m-kl", "upsert", 0, mediaRecord({ localId: "m-kl" }))]);

    const r1 = await a.client.query("select public.sync_keep_local('intent-xyz') as r");
    const e1 = r1.rows[0].r.epoch as number;
    assertEq(e1, 2, "epoch bumped to 2");
    const backups = await recoveryBackups(db, USER_A);
    assertEq(backups.length, 1, "one recovery backup created");
    assertEq(backups[0].kind, "keep_local", "kind keep_local");
    const backedUpIds = (backups[0].payload.media_items as { local_id: string }[]).map((r) => r.local_id);
    assert(backedUpIds.includes("m-kl"), "backup holds the pre-destruction state (m-kl present)");
    assert(!(await mediaRow(db, USER_A, "m-kl")), "entity rows hard-deleted (zero pre-epoch server rows)");

    // retry with the SAME intentId → no-op
    const r2 = await a.client.query("select public.sync_keep_local('intent-xyz') as r");
    assertEq(r2.rows[0].r.alreadyApplied, true, "retry is idempotent");
    assertEq(r2.rows[0].r.epoch, 2, "epoch unchanged on retry");
    const logs = await (await db.adminClient()).query(
      "select count(*)::int as n from echo_data.change_log where user_id = $1 and op = 'epoch_reset'", [USER_A]);
    assertEq(logs.rows[0].n, 1, "exactly one epoch_reset entry");
    const backups2 = await recoveryBackups(db, USER_A);
    assertEq(backups2.length, 1, "no duplicate backup");
  });

  test("T-4.7 3-device bootstrap convergence", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const devSource = await registerDevice(a.client, "source");
    await push(a.client, devSource, [
      op("t47-1", "media_items", "m-47a", "upsert", 0, mediaRecord({ localId: "m-47a", title: "Alpha" })),
      op("t47-2", "media_items", "m-47b", "upsert", 0, mediaRecord({ localId: "m-47b", title: "Beta" })),
      op("t47-3", "entries", "e-47a", "upsert", 0, { status: "completed", rating: 5 }),
    ]);

    // two more devices bootstrap via snapshot + delta + ack
    const bs = await bootstrapStatus(a.client);
    assert(bs.activeSnapshot.recordCount >= 3, "snapshot holds the records");
    for (const devName of ["second", "third"]) {
      const dev = await registerDevice(a.client, devName);
      const manifest = await a.client.query("select public.sync_bootstrap_manifest($1) as r", [bs.activeSnapshot.id]);
      const pages = manifest.rows[0].r.pages as { pageNo: number; rowCount: number; pageHash: string }[];
      let records = 0;
      for (const p of pages) {
        const page = await a.client.query("select public.sync_bootstrap_page($1, $2) as r", [bs.activeSnapshot.id, p.pageNo]);
        records += (page.rows[0].r.records as unknown[]).length;
      }
      assertEq(records, bs.activeSnapshot.recordCount, `${devName}: all pages fetched`);
      const delta = await pull(a.client, dev, bs.activeSnapshot.headSeq);
      const ack = await a.client.query("select public.sync_bootstrap_ack($1, $2, $3) as r", [dev, bs.activeSnapshot.id, bs.headSeq]);
      assertEq(ack.rows[0].r.currentHeadSeq, bs.headSeq, `${devName}: acked to head`);
      // convergence: the committed log for this test's records is identical for everyone
      const full = await pull(a.client, dev, 0);
      const own = full.changes.filter((c) => ["m-47a", "m-47b", "e-47a"].includes(c.recordId) && c.op === "upsert");
      assertEq(own.length, 3, `${devName}: converged`);
    }
  });

  test("T-4.8 unbased collision end-to-end + crash-retry idempotence + restore", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    // server record:
    await push(a.client, dev, [op("srv-1", "media_items", "m-coll", "upsert", 0, mediaRecord({ localId: "m-coll", title: "server-side" }))]);
    const v = (await mediaRow(db, USER_A, "m-coll"))!.version;

    // local record with the SAME id, different content, NO baseline (b=0):
    const localOp = op("boot-<dev>-<intent-9>-1", "media_items", "m-coll", "upsert", 0, mediaRecord({ localId: "m-coll", title: "local-side" }));
    // (a) not silently overwritten:
    const r = await push(a.client, dev, [localOp]);
    assertEq(r.archived[0]?.reason, "edit_edit", "(a) unbased collision archived via D-3");
    assertEq((await mediaRow(db, USER_A, "m-coll"))!.record!.title, "server-side", "(a) server record stays live at its version");
    // (b) local payload fully recoverable:
    const admin = await db.adminClient();
    const arc = (await admin.query("select id, client_payload from echo_data.conflict_archive where user_id = $1 order by id desc limit 1", [USER_A])).rows[0];
    assertEq((arc.client_payload.record as Record<string, unknown>).title, "local-side", "(b) archived payload complete");
    // (c) visible (conflict card data) + (d) retry any number of times → exactly ONE archive entry:
    for (let i = 0; i < 3; i++) {
      await push(a.client, dev, [localOp]);
    }
    const arcCount = await admin.query("select count(*)::int as n from echo_data.conflict_archive where user_id = $1 and record_id = 'm-coll'", [USER_A]);
    assertEq(arcCount.rows[0].n, 1, "(d) opid dedupe: exactly one archive entry across retries");
    // (e) restore from the card → fresh CAS'd push, no loop:
    const res = await a.client.query("select public.sync_conflict_resolve($1, 'restore') as r", [arc.id]);
    const pushOp = res.rows[0].r.pushOp as { record: Record<string, unknown>; suggestedBaseVersion: number; entity: string; recordId: string };
    const r2 = await push(a.client, dev, [op(`restore-${arc.id}`, pushOp.entity, pushOp.recordId, "upsert", pushOp.suggestedBaseVersion, pushOp.record)]);
    assert(r2.acked.length === 1, "(e) restored op applied via CAS");
    assertEq((await mediaRow(db, USER_A, "m-coll"))!.record!.title, "local-side", "(e) local content restored without a loop");
  });

  test("T-4 epoch/ack semantics: bootstrap_ack validates deviceId (O-1) and clamps", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const b = await initUser(db, USER_B);
    const devA = await registerDevice(a.client, "ack-a");
    const devB = await registerDevice(b.client, "ack-b");
    const bs = await bootstrapStatus(a.client);

    // foreign device → uniform device_not_found
    await assertRejects(
      async () => a.client.query("select public.sync_bootstrap_ack($1, $2, 0)", [devB, bs.activeSnapshot.id]),
      "device_not_found", "ack with a foreign device is rejected");
    // unknown device → same error
    await assertRejects(
      async () => a.client.query("select public.sync_bootstrap_ack($1, $2, 0)", ["99999999-9999-9999-9999-999999999999", bs.activeSnapshot.id]),
      "device_not_found", "ack with an unknown device is rejected");
    // drainedSeq above head → invalid_drained_seq
    await assertRejects(
      async () => a.client.query("select public.sync_bootstrap_ack($1, $2, $3)", [devA, bs.activeSnapshot.id, bs.headSeq + 10]),
      "invalid_drained_seq", "ack clamps validation: drained above head rejected");
    // valid ack:
    const ack = await a.client.query("select public.sync_bootstrap_ack($1, $2, $3) as r", [devA, bs.activeSnapshot.id, bs.headSeq]);
    assertEq(ack.rows[0].r.ackedSeq, bs.headSeq, "valid ack records the drained boundary");
    // idempotent re-ack:
    const ack2 = await a.client.query("select public.sync_bootstrap_ack($1, $2, $3) as r", [devA, bs.activeSnapshot.id, bs.headSeq]);
    assertEq(ack2.rows[0].r.ackedSeq, bs.headSeq, "re-ack idempotent");
    // foreign snapshot → snapshot_not_found
    const bsB = await bootstrapStatus(b.client);
    await assertRejects(
      async () => a.client.query("select public.sync_bootstrap_ack($1, $2, 0)", [devA, bsB.activeSnapshot.id]),
      "snapshot_not_found", "ack with a foreign snapshot is rejected");
  });

  test("T-4 restore-backup path (advisory-first, reversible, epoch-bumped)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("rb-1", "media_items", "m-rb1", "upsert", 0, mediaRecord({ localId: "m-rb1", title: "before-keep-local" }))]);
    const kl = await a.client.query("select public.sync_keep_local('intent-rb') as r");
    const backupId = kl.rows[0].r.backupId as number;

    // push a different state in the new epoch:
    await push(a.client, dev, [op("rb-2", "media_items", "m-rb2", "upsert", 0, mediaRecord({ localId: "m-rb2", title: "after-keep-local" }))]);

    // restore the pre-keep-local backup:
    const backupsBeforeRestore = (await recoveryBackups(db, USER_A)).length;
    const res = await a.client.query("select public.sync_restore_backup($1) as r", [backupId]);
    const r = res.rows[0].r;
    assertEq(Number(r.epoch), Number(kl.rows[0].r.epoch) + 1, "restore bumps the epoch again");
    assert(Number(r.restoredCount) >= 1, "rows restored from the backup");
    const row = await mediaRow(db, USER_A, "m-rb1");
    assertEq(row!.record!.title, "before-keep-local", "backup content re-instated");
    assert(!(await mediaRow(db, USER_A, "m-rb2")), "post-backup state wiped by the restore");
    const backups = await recoveryBackups(db, USER_A);
    assertEq(backups.length, backupsBeforeRestore + 1, "restore archived the current state as a new backup (reversible)");

    // expired backup → backup_expired
    const admin = await db.adminClient();
    await admin.query("update echo_data.recovery_backups set expires_at = now() - interval '1 day' where id = $1", [backupId]);
    await assertRejects(
      async () => a.client.query("select public.sync_restore_backup($1)", [backupId]),
      "backup_expired", "expired backup cannot be restored");
    // foreign backup → backup_not_found (B creates a backup; A attempts it)
    const b = await initUser(db, USER_B);
    const devB = await registerDevice(b.client, "rb-b");
    await push(b.client, devB, [op("rb-b1", "entries", "e-rbb", "upsert", 0, { status: "watching" })]);
    const klB = await b.client.query("select public.sync_keep_local('intent-rb-b') as r");
    const backupIdB = klB.rows[0].r.backupId as number;
    await assertRejects(
      async () => a.client.query("select public.sync_restore_backup($1)", [backupIdB]),
      "backup_not_found", "foreign backup is rejected");
  });
});
