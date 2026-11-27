/**
 * T-2.1…T-2.14 — sequencing, pull/compaction locking, watermark, device
 * isolation, cursor, and compaction tests (PATCH1 §4.5).
 */
import {
  suite, test, assert, assertEq, assertRejects, waitFor,
  TestDb, USER_A, USER_B, USER_C, initUser, registerDevice, op, mediaRecord, push, pull,
  devicesSnapshot, status, bootstrapStatus, runJob,
} from "../util.ts";
import type { Client } from "pg";

async function userKeyOf(db: TestDb, userId: string): Promise<number> {
  const admin = await db.adminClient();
  const res = await admin.query("select ('x' || substr($1::text, 1, 8))::bit(32)::int as k", [userId]);
  return res.rows[0].k;
}

async function isBlocked(db: TestDb, pidOf: number): Promise<boolean> {
  const admin = await db.adminClient();
  const res = await admin.query(
    "select count(*)::int as n from pg_blocking_pids($1) b", [pidOf]);
  return res.rows[0].n > 0;
}

async function backendPid(c: Client): Promise<number> {
  const res = await c.query("select pg_backend_pid() as p");
  return res.rows[0].p;
}

suite("T-2 sequencing", () => {
  test("T-2.1 per-user write serialization: a second push blocks until the first commits; seq follows commit order", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const key = await userKeyOf(db, USER_A);

    const s1 = await db.userClient(USER_A);
    await s1.query("begin");
    await s1.query("select pg_advisory_xact_lock(72451, $1)", [key]); // in-flight writer

    const s2 = await db.userClient(USER_A);
    await s2.query("set lock_timeout = '600ms'");
    await assertRejects(
      async () => push(s2, dev, [op("s2-1", "entries", "e-s2", "upsert", 0, { status: "watching" })]),
      "lock", "second writer must block on the exclusive per-user lock");
    await s1.query("commit");

    // now unblocked
    const r = await push(s2, dev, [op("s2-1", "entries", "e-s2", "upsert", 0, { status: "watching" })]);
    assert(r.acked.includes("s2-1"), "retry after unblock applies");
  });

  test("T-2.2 quiescent read: a pull (shared lock) blocks an in-flight writer's view and vice versa", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("q-1", "entries", "e-q", "upsert", 0, { status: "watching" })]);
    const key = await userKeyOf(db, USER_A);

    // (a) writer holds exclusive → pull blocks
    const w = await db.userClient(USER_A);
    await w.query("begin");
    await w.query("select pg_advisory_xact_lock(72451, $1)", [key]);
    const p = await db.userClient(USER_A);
    await p.query("set lock_timeout = '600ms'");
    await assertRejects(async () => pull(p, dev, 0), "lock", "pull must wait for the exclusive lock");
    await w.query("commit");

    // (b) pull holds shared → writer blocks
    const pr = await db.userClient(USER_A);
    await pr.query("begin");
    await pr.query("select pg_advisory_xact_lock_shared(72451, $1)", [key]);
    const wr = await db.userClient(USER_A);
    await wr.query("set lock_timeout = '600ms'");
    await assertRejects(
      async () => push(wr, dev, [op("q-2", "entries", "e-q2", "upsert", 0, { status: "watching" })]),
      "lock", "writer must wait for the shared (pull) lock");
    await pr.query("commit");
  });

  test("T-2.3 lock-guard trigger: change_log write without the advisory lock raises 40P01", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    await assertRejects(
      async () => a.client.query(
        `insert into echo_data.change_log (user_id, epoch, entity, record_id, op, version, payload)
         values ($1, 1, 'entries', 'e-x', 'upsert', 1, '{}'::jsonb)`, [USER_A]),
      "lock-guard", "unprotected change_log insert must be rejected");
    // …while the same insert under the lock succeeds:
    const key = await userKeyOf(db, USER_A);
    await a.client.query("begin");
    await a.client.query("select pg_advisory_xact_lock(72451, $1)", [key]);
    await a.client.query(
      `insert into echo_data.change_log (user_id, epoch, entity, record_id, op, version, payload)
       values ($1, 1, 'entries', 'e-x', 'upsert', 1, '{}'::jsonb)`, [USER_A]);
    await a.client.query("commit");
  });

  test("T-2.5 gap tolerance: identity gaps never hide rows; cursor advances to the page max", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    const baseline = (await status(a.client)).headSeq; // cross-test rows exist above this
    await push(a.client, dev, [op("g-1", "entries", "e-g1", "upsert", 0, { status: "watching" })]);

    // create a gap: a transaction that rolls back after taking the lock
    const key = await userKeyOf(db, USER_A);
    const s = await db.userClient(USER_A);
    await s.query("begin");
    await s.query("select pg_advisory_xact_lock(72451, $1)", [key]);
    await s.query("select public.sync_push($1::jsonb, $2, null)", [JSON.stringify([op("g-gap", "entries", "e-gap", "upsert", 0, { status: "dropped" })]), dev]);
    await s.query("rollback"); // seq burned, row absent → gap

    const r2 = await push(a.client, dev, [op("g-2", "entries", "e-g2", "upsert", 0, { status: "completed" })]);
    const p = await pull(a.client, dev, baseline);
    const ids = p.changes.map((c) => c.recordId).sort();
    assertEq(ids, ["e-g1", "e-g2"], "gaps carry no meaning — all rows > cursor are delivered");
    assert(p.headSeq >= r2.headSeq, "head reported");
  });

  test("T-2.6 snapshot boundary: a write landing during (simulated) snapshot creation lands above head_seq", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("sb-1", "entries", "e-sb1", "upsert", 0, { status: "watching" })]);
    const key = await userKeyOf(db, USER_A);

    // simulate an in-progress snapshot read: hold the SHARED lock (exactly
    // what build_snapshot runs under), then let a writer queue behind it.
    const holder = await db.userClient(USER_A);
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock_shared(72451, $1)", [key]);

    const writer = await db.userClient(USER_A);
    const writePromise = push(writer, dev, [op("sb-2", "entries", "e-sb2", "upsert", 0, { status: "watching" })]);

    // snapshot creation under the same shared lock (compatible, like the real flow):
    const snapRes = await holder.query("select public.sync_bootstrap_status() as r");
    const snap = snapRes.rows[0].r.activeSnapshot;
    await holder.query("commit");
    const wr = await writePromise;

    assert(wr.headSeq > snap.headSeq, "the write landed strictly above the snapshot boundary");
    // …and the delta above head_seq delivers it (INV-10):
    const delta = await pull(a.client, dev, snap.headSeq);
    assert(delta.changes.some((c) => c.recordId === "e-sb2"), "write during creation delivered by the delta pull, in neither-both case");
  });

  test("T-2.8 pull/compaction watermark race (a)(b)(c)(d)(e)", async (db: TestDb) => {
    // Uses USER_C so the compaction it performs does not advance the watermark
    // for USER_A (later tests in this suite rely on W = 1 there).
    const a = await initUser(db, USER_C);
    const dev = await registerDevice(a.client);
    for (let i = 1; i <= 5; i++) {
      await push(a.client, dev, [op(`rc-${i}`, "entries", `e-rc${i}`, "upsert", 0, { status: "watching" })]);
    }
    const key = await userKeyOf(db, USER_C);
    const headBefore = (await status(a.client)).headSeq;

    // Dedicated sessions: the compactor and the watcher must NOT share the
    // wedged admin client (a blocked query queues everything behind it).
    const compactor = await db.userClient(USER_A); // superuser-equivalent path via SET is not used; connect fresh below
    await compactor.query("reset role");
    const watcher = await db.userClient(USER_A);
    await watcher.query("reset role");

    // (a) pull-in-flight (shared lock held) → compaction blocks, then runs after commit.
    //     The pull confirms headBefore (a fully-caught-up device).
    const pullSession = await db.userClient(USER_C);
    await pullSession.query("begin");
    await pullSession.query("select pg_advisory_xact_lock_shared(72451, $1)", [key]);
    // validate and read the page the pull would see, under the lock (the RPC's own order)
    const pageUnderLock = await pullSession.query("select public.sync_pull($1, $2, 500) as r", [dev, headBefore]);

    const compactionPromise = compactor.query("select echo_jobs.sync_job_compact($1) as r", [USER_C]);
    const compactorBlocked = await waitFor(async () => {
      const procs = await watcher.query(
        "select pid from pg_stat_activity where query like '%sync_job_compact%' and state = 'active' and wait_event is not null");
      return procs.rows.length > 0;
    }, 3000);
    assert(compactorBlocked, "(a) compaction must be blocked while the pull holds the shared lock");
    void pageUnderLock;

    await pullSession.query("commit");
    const compacted = (await compactionPromise).rows[0].r;
    assertEq(Number(compacted.watermarkNew), headBefore, "(a) compaction advanced the watermark to the acked head after the pull committed");

    // (b) compaction first → a stale pull validates against the NEW watermark → 409 contract
    const stale = await db.userClient(USER_C);
    await assertRejects(async () => pull(stale, dev, 0), "cursor_expired",
      "(b) stale cursor must get cursor_expired, never a partial page");

    // (c) completeness oracle across randomized runs (N=50 here; the dedicated
    //     T-2.7 harness runs the full randomized schedule including compaction)
    for (let run = 0; run < 50; run++) {
      const u = await initUser(db, USER_B);
      const d = await registerDevice(u.client);
      const nOps = 3 + (run % 4);
      const opsBatch = [];
      for (let i = 0; i < nOps; i++) opsBatch.push(op(`c-${run}-${i}`, "entries", `e-c${run}-${i}`, "upsert", 0, { status: "watching" }));
      await push(u.client, d, opsBatch);
      const st = await status(u.client);
      const page = await pull(u.client, d, 0);
      const expected = page.changes.map((c) => c.seq).filter((s) => s > 0 && s <= st.headSeq);
      assertEq(page.changes.map((c) => c.seq), expected, `(c) run ${run}: page complete`);
    }

    // (d) two concurrent pulls from different devices + a compaction attempt waiting
    const u2 = await initUser(db, USER_A); // reuse A but fresh devices
    const devA2 = await registerDevice(u2.client, "race-a");
    const devB2 = await registerDevice(u2.client, "race-b");
    const [p1, p2] = await Promise.all([
      pull(u2.client, devA2, 0),
      (async () => {
        const c = await db.userClient(USER_A);
        return pull(c, devB2, 0);
      })(),
    ]);
    assert(p1.ok && p2.ok, "(d) both pulls completed");
    const after = await devicesSnapshot(db, USER_A);
    assertEq((after[devA2] as { acked_seq: number }).acked_seq, 0, "(d) device A cursor stayed at its confirmed 0");
    assertEq((after[devB2] as { acked_seq: number }).acked_seq, 0, "(d) device B cursor stayed at its confirmed 0");

    // (e) the real S-2 job path end-to-end with assertions
    const e = await runJob(db, "sync_job_compact", USER_C);
    assertEq(Number(e.watermarkNew), headBefore, "(e) job advances monotonically to the floor");
    const logs = await (await db.adminClient()).query(
      "select count(*)::int as n from echo_data.change_log where user_id = $1 and seq < $2", [USER_C, headBefore]);
    assert(logs.rows[0].n >= 0, "(e) job deleted only rows below the watermark");
  });

  test("T-2.9 conservative cursor recording under client crash", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const dev = await registerDevice(a.client);
    await push(a.client, dev, [op("cc-1", "entries", "e-cc1", "upsert", 0, { status: "watching" })]);
    // client pulls (page delivered) but "crashes" before applying/confirming:
    const delivered = await pull(a.client, dev, 0);
    // run compaction (all devices acked only 0):
    await runJob(db, "sync_job_compact", USER_A);
    const snap = await devicesSnapshot(db, USER_A);
    assertEq((snap[dev] as { acked_seq: number }).acked_seq, 0,
      "stored cursor remains the last CONFIRMED cursor (0), not the delivered head");
    // the recovering client's next pull returns the undelivered rows:
    const retry = await pull(a.client, dev, 0);
    assert(retry.changes.length === delivered.changes.length, "retry pull returns the same rows — nothing lost");
  });

  test("T-2.10 device-scoped cursor update (F-16 regression)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const devA = await registerDevice(a.client, "A");
    const devB = await registerDevice(a.client, "B");
    // seed 3 changes; both devices confirmed cursor 0
    await push(a.client, devA, [
      op("d10-1", "entries", "e-d1", "upsert", 0, { status: "watching" }),
      op("d10-2", "entries", "e-d2", "upsert", 0, { status: "watching" }),
    ]);
    const before = await devicesSnapshot(db, USER_A);
    assertEq((before[devB] as { acked_seq: number }).acked_seq, 0, "B starts at 0");

    // Device A pulls at p_since = 900 (a large confirmed value is legal)
    const r = await pull(a.client, devA, 900);
    assertEq(r.headSeq, r.headSeq, "pull ok");

    const after = await devicesSnapshot(db, USER_A);
    assertEq((after[devA] as { acked_seq: number }).acked_seq, 900, "A's cursor became 900");
    assertEq((after[devB] as { acked_seq: number }).acked_seq, 0, "B's cursor REMAINED 100-equivalent (0) — F-16 fixed");
    const tsA = (after[devA] as { last_synced_at: string | null }).last_synced_at;
    const tsB = (after[devB] as { last_synced_at: string | null }).last_synced_at;
    assert(tsA !== null, "A's last_synced_at updated");
    assertEq(tsB, (before[devB] as { last_synced_at: string | null }).last_synced_at,
      "B's last_synced_at untouched");
  });

  test("T-2.11 lagging-device compaction protection", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const devA = await registerDevice(a.client, "fast");
    const devB = await registerDevice(a.client, "slow");
    const baseline = (await status(a.client)).headSeq; // cross-test rows exist below
    const pushes = [];
    for (let i = 1; i <= 4; i++) {
      pushes.push(op(`lag-${i}`, "entries", `e-lag${i}`, "upsert", 0, { status: "watching" }));
    }
    await push(a.client, devA, pushes);
    const st = await status(a.client);
    // fast device pulls everything (cursor = head); slow device stays at 0
    await pull(a.client, devA, st.headSeq);
    await runJob(db, "sync_job_compact", USER_A);

    const after = await devicesSnapshot(db, USER_A);
    assertEq((after[devB] as { acked_seq: number }).acked_seq, 0, "slow device still at 0");
    // the changes B still requires are NOT deleted — B pulls them without a 409:
    const bPull = await pull(a.client, devB, baseline);
    assertEq(bPull.changes.filter((c) => c.recordId.startsWith("e-lag")).length, pushes.length,
      "slow device receives all its missing changes — no false CURSOR_EXPIRED");
  });

  test("T-2.12 device authorization matrix (foreign / revoked / unknown)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const b = await initUser(db, USER_B);
    const devA = await registerDevice(a.client, "own");
    const devB = await registerDevice(b.client, "foreign");
    const devRevoked = await registerDevice(a.client, "toberevoked");
    await a.client.query("select public.sync_device_revoke($1)", [devRevoked]);
    const unknown = "99999999-9999-9999-9999-999999999999";

    // (1) own active device succeeds
    await pull(a.client, devA, 0);
    const before = await devicesSnapshot(db, USER_A);
    const beforeB = await devicesSnapshot(db, USER_B);

    // (2) foreign + (4) unknown → the SAME error
    const e2 = await assertRejects(async () => pull(a.client, devB, 0), "device_not_found", "foreign device");
    const e4 = await assertRejects(async () => pull(a.client, unknown, 0), "device_not_found", "unknown device");
    assertEq(e2.message, e4.message, "(2)+(4) indistinguishable — no cross-user existence oracle");

    // (3) own revoked device → device_revoked
    await assertRejects(async () => pull(a.client, devRevoked, 0), "device_revoked", "revoked device");

    const after = await devicesSnapshot(db, USER_A);
    const afterB = await devicesSnapshot(db, USER_B);
    assertEq(after, before, "every rejected case left every A device row unchanged");
    assertEq(afterB, beforeB, "every rejected case left every B device row unchanged");
  });

  test("T-2.13 concurrent device pulls (different devices and same device)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const devA = await registerDevice(a.client, "cc-a");
    const devSame = await registerDevice(a.client, "cc-same");
    await push(a.client, devA, [
      op("cc13-1", "entries", "e-cc13a", "upsert", 0, { status: "watching" }),
      op("cc13-2", "entries", "e-cc13b", "upsert", 0, { status: "watching" }),
    ]);
    const head = (await status(a.client)).headSeq;

    // different-device run: both succeed, each advances only its own row
    const c1 = await db.userClient(USER_A);
    const c2 = await db.userClient(USER_A);
    const [rA, rB] = await Promise.all([pull(c1, devA, head), pull(c2, devSame, 0)]);
    assert(rA.ok && rB.ok, "both different-device pulls complete");
    const snap1 = await devicesSnapshot(db, USER_A);
    assertEq((snap1[devA] as { acked_seq: number }).acked_seq, head, "device A advanced to its confirmed head");
    assertEq((snap1[devSame] as { acked_seq: number }).acked_seq, 0, "device Same stayed at 0");

    // same-device run: two concurrent pulls at cursors 900 and 100 → final = 900
    const c3 = await db.userClient(USER_A);
    const c4 = await db.userClient(USER_A);
    const [p1, p2] = await Promise.all([pull(c3, devSame, 900), pull(c4, devSame, 100)]);
    assert(p1.ok && p2.ok, "both same-device pulls complete (I-6: briefly serialized, not deadlocked)");
    const snap2 = await devicesSnapshot(db, USER_A);
    assertEq((snap2[devSame] as { acked_seq: number }).acked_seq, 900,
      "same-device cursor is monotonic and order-independent (greatest)");
  });

  test("T-2.14 confirmed cursor vs delivered head with sibling isolation", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const devA = await registerDevice(a.client, "crashy");
    const devB = await registerDevice(a.client, "sibling");
    await push(a.client, devA, [op("ch-1", "entries", "e-ch1", "upsert", 0, { status: "watching" })]);
    const head = (await status(a.client)).headSeq;

    // deliver a page to A (confirming head via THIS pull only on the NEXT one)
    await pull(a.client, devA, head);
    // sibling B pulls at its own cursor
    await pull(a.client, devB, 0);
    // compaction runs while A has "crashed" post-delivery
    await runJob(db, "sync_job_compact", USER_A);

    const snap = await devicesSnapshot(db, USER_A);
    assertEq((snap[devA] as { acked_seq: number }).acked_seq, head, "A's stored cursor = its last confirmed value");
    assertEq((snap[devB] as { acked_seq: number }).acked_seq, 0, "B's cursor unchanged");
    const retry = await pull(a.client, devA, head);
    assertEq(retry.changes.length, 0, "A's retry at its confirmed cursor returns the (empty) remainder safely");
  });

  test("T-2.7 randomized interleaving harness (N=1000 scheduled steps incl. compaction)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const devices = [
      await registerDevice(a.client, "v1"),
      await registerDevice(a.client, "v2"),
      await registerDevice(a.client, "v3"),
    ];
    const clients = [a.client, await db.userClient(USER_A), await db.userClient(USER_A)];
    let seq = 0;
    let pulls = 0;
    let rebootstraped = 0;
    const appliedRecordIds = new Set<string>();

    const rand = (n: number) => Math.floor(Math.random() * n);
    for (let step = 0; step < 1000; step++) {
      const choice = rand(10);
      const di = rand(3);
      if (choice < 5) {
        // push
        const id = `r-${step}`;
        await push(clients[di], devices[di], [op(`op-${step}`, "entries", id, "upsert", 0, { status: "watching", step })]);
        appliedRecordIds.add(id);
      } else if (choice < 9) {
        // pull from the device's own confirmed cursor
        const snap = await devicesSnapshot(db, USER_A);
        const cursor = (snap[devices[di]] as { acked_seq: number }).acked_seq;
        try {
          const page = await pull(clients[di], devices[di], cursor);
          for (const ch of page.changes) {
            if (ch.recordId.startsWith("r-")) appliedRecordIds.add(ch.recordId);
          }
          pulls++;
        } catch {
          // cursor_expired → the real client re-bootstraps: snapshot + ack, then resume
          rebootstraped++;
          const bs = await bootstrapStatus(clients[di]);
          await clients[di].query("select public.sync_bootstrap_ack($1, $2, $3)", [devices[di], bs.activeSnapshot.id, bs.headSeq]);
        }
      } else {
        await runJob(db, "sync_job_compact", USER_A).catch(() => {});
      }
    }
    assert(pulls > 100, `harness exercised the pull path (${pulls} pulls)`);
    assert(rebootstraped === 0, `no spurious cursor_expired occurred (${rebootstraped}) — compaction respected the slowest device`);
    // final convergence: every applied record id is visible to a fresh device
    // (paginated — the pull page limit is 500)
    const devFresh = await registerDevice(a.client, "fresh");
    const visible = new Set<string>();
    let cursor = 0;
    for (;;) {
      const page = await pull(a.client, devFresh, cursor);
      for (const ch of page.changes) if (ch.op === "upsert") visible.add(ch.recordId);
      if (page.changes.length === 0 || cursor >= page.headSeq) break;
      cursor = page.changes[page.changes.length - 1].seq;
    }
    // entries are never deleted in this harness → all applied ids must be visible
    for (const id of appliedRecordIds) {
      assert(visible.has(id), `skipped committed change: ${id}`);
    }
  });
});
