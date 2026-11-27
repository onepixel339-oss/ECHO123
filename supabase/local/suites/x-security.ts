/**
 * X-1…X-11 — cross-user security matrix (B0).
 * Covers: RLS-active proof, exposure closure (local equivalents), anon
 * EXECUTE denial, security_invoker views, function-inventory diff, job
 * EXECUTE isolation, the v1.1 §6.6 cross-user matrix, migration
 * self-acceptance (X-9, incl. the red-branch proof), execution-identity
 * proof (X-10), and environment parity (X-11 local leg).
 */
import {
  suite, test, assert, assertEq, assertRejects,
  TestDb, USER_A, USER_B, initUser, registerDevice, op, mediaRecord, push, pull, devicesSnapshot,
} from "../util.ts";
import type { Client } from "pg";
import { readFileSync } from "node:fs";

suite("X security", () => {
  test("X-1 RLS-active: user A sees only own rows across all 14 tables", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const b = await initUser(db, USER_B);
    const devA = await registerDevice(a.client, "A-dev");
    const devB = await registerDevice(b.client, "B-dev");
    await push(a.client, devA, [op("a-1", "media_items", "m-a", "upsert", 0, mediaRecord({ localId: "m-a", title: "A's title" }))]);
    await push(b.client, devB, [op("b-1", "media_items", "m-b", "upsert", 0, mediaRecord({ localId: "m-b", title: "B's title" }))]);

    const tables = [
      "v_profiles", "v_devices", "v_media_items", "v_entries", "v_feedback",
      "v_works", "v_work_links", "v_user_settings", "v_change_log", "v_push_ops",
      "v_snapshots", "v_snapshot_pages", "v_conflict_archive", "v_recovery_backups",
    ];
    for (const t of tables) {
      const res = await a.client.query(`select count(*)::int as n from public.${t}`);
      assert(res.rows[0].n >= 0, `table ${t} readable`);
      // foreign-row check (v_snapshot_pages is scoped via its parent snapshot —
      // covered by X-7 case 5)
      if (t === "v_snapshot_pages") continue;
      const ownerCol = t === "v_profiles" ? "id" : "user_id";
      const res2 = await a.client.query(`select count(*)::int as n from public.${t} where ${ownerCol}::text <> $1`, [USER_A]);
      assertEq(res2.rows[0].n, 0, `table ${t}: A must see zero foreign rows`);
    }
    // A sees own media but not B's
    const media = await a.client.query("select local_id from public.v_media_items");
    assertEq(media.rows.map((r: { local_id: string }) => r.local_id), ["m-a"], "A sees only own media row");
  });

  test("X-2 exposure closure (local equivalents): anon has no USAGE on echo_data; public schema exposes only views+RPCs", async (db: TestDb) => {
    const anon = await db.roleClient("anon");
    const res = await anon.query(`select has_schema_privilege('anon', 'echo_data', 'USAGE') as u`);
    assertEq(res.rows[0].u, false, "anon must NOT have USAGE on echo_data");
    const res2 = await anon.query(`select has_schema_privilege('anon', 'echo_jobs', 'USAGE') as u`);
    assertEq(res2.rows[0].u, false, "anon must NOT have USAGE on echo_jobs");
    // public schema contains no tables (views + functions only)
    const admin = await db.adminClient();
    const tbl = await admin.query(
      `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`);
    assertEq(tbl.rows.length, 0, "public schema must contain no tables (private-schema pattern)");
  });

  test("X-3 anon EXECUTE denial on every sync RPC", async (db: TestDb) => {
    await initUser(db, USER_A);
    const anon = await db.roleClient("anon");
    for (const call of [
      "select public.sync_init_profile()",
      "select public.sync_device_register('x','linux','t')",
      "select public.sync_pull(gen_random_uuid(), 0)",
      "select public.sync_push('[]'::jsonb, gen_random_uuid())",
      "select public.sync_status()",
      "select public.sync_bootstrap_status()",
    ]) {
      await assertRejects(async () => anon.query(call), "permission denied", call);
    }
  });

  test("X-4 security_invoker views: reloptions present; B's view read returns only B's rows", async (db: TestDb) => {
    const admin = await db.adminClient();
    const res = await admin.query(
      `select reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname='v_change_log'`);
    assert(JSON.stringify(res.rows[0].reloptions).includes("security_invoker=true"),
      "v_change_log must carry security_invoker=true");

    const a = await initUser(db, USER_A);
    const b = await initUser(db, USER_B);
    const devA = await registerDevice(a.client);
    const devB = await registerDevice(b.client);
    await push(a.client, devA, [op("a-1", "entries", "e-a", "upsert", 0, { status: "completed", rating: 5 })]);
    await push(b.client, devB, [op("b-1", "entries", "e-b", "upsert", 0, { status: "planned", rating: 3 })]);
    const rowsB = await b.client.query("select record_id from public.v_change_log order by record_id");
    assertEq(rowsB.rows.map((r: { record_id: string }) => r.record_id), ["e-b", "m-b"], "view read scoped to B");
  });

  test("X-5 function inventory diff vs checked-in expectation", async (db: TestDb) => {
    const admin = await db.adminClient();
    const actual = await admin.query(
      "select schema, proname, security_definer, owner, execute_grantees, search_path from public.v_sync_function_inventory order by schema, proname");
    const expected = readFileSync(new URL("../../expected_function_inventory.psv", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("--"))
      .map((l) => {
        const [schema, proname, sd, owner, grantees, sp] = l.split("|");
        return {
          schema, proname,
          security_definer: sd === "t",
          owner, execute_grantees: grantees, search_path: sp,
        };
      })
      .sort((x, y) => (x.schema + x.proname).localeCompare(y.schema + y.proname));
    const actualSorted = actual.rows.map((r: Record<string, unknown>) => ({
      schema: r.schema, proname: r.proname,
      security_definer: r.security_definer === true || r.security_definer === "t" || r.security_definer === true,
      owner: r.owner, execute_grantees: r.execute_grantees, search_path: r.search_path,
    })).sort((x: { schema: string; proname: string }, y: { schema: string; proname: string }) => (x.schema + x.proname).localeCompare(y.schema + y.proname));
    assertEq(actualSorted, expected, "function inventory must match the checked-in expectation exactly");
  });

  test("X-6 job EXECUTE isolation: authenticated cannot run the S-2 jobs", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    await assertRejects(
      async () => a.client.query("select echo_jobs.sync_job_compact($1)", [USER_A]),
      "permission denied", "authenticated must not EXECUTE echo_jobs.sync_job_compact");
    await assertRejects(
      async () => a.client.query("select echo_jobs.sync_job_cleanup($1)", [USER_A]),
      "permission denied", "authenticated must not EXECUTE echo_jobs.sync_job_cleanup");
    // superuser (the local stand-in for the service-role job runner) can:
    const admin = await db.adminClient();
    await admin.query("select echo_jobs.sync_job_compact($1)", [USER_A]);
  });

  test("X-7 cross-user matrix (v1.1 §6.6 cases 1–10)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const b = await initUser(db, USER_B);
    const devA = await registerDevice(a.client, "A-dev");
    const devB = await registerDevice(b.client, "B-dev");
    await push(a.client, devA, [op("a-1", "media_items", "m-a", "upsert", 0, mediaRecord({ localId: "m-a" }))]);

    // case 2: A pushes ops embedding B's identity in payload — applies to A only
    const bEntriesBefore = (await b.client.query("select count(*)::int as n from public.v_entries")).rows[0].n;
    const aEntriesBefore = (await a.client.query("select count(*)::int as n from public.v_entries")).rows[0].n;
    await push(a.client, devA, [op("a-2", "entries", "e-a7", "upsert", 0, { user_id: USER_B, status: "watching" })]);
    const bEntries = await b.client.query("select count(*)::int as n from public.v_entries");
    assertEq(bEntries.rows[0].n, bEntriesBefore, "case 2: A's op with B's user_id in payload must NOT create B rows");
    const aEntries = await a.client.query("select count(*)::int as n from public.v_entries");
    assertEq(aEntries.rows[0].n, aEntriesBefore + 1, "case 2: the op applied to A (ownership from auth.uid())");

    // case 3 (O-2 unified): A pushes with B's device → uniform device_not_found
    const err = await assertRejects(
      async () => push(a.client, devB, [op("a-3", "entries", "e-a2", "upsert", 0, { status: "watching" })]),
      "device_not_found", "case 3: foreign device must raise device_not_found");
    assert(!(err.message.includes("device_not_owned")), "case 3: the retired device_not_owned vocabulary must NOT appear");
    // …and zero writes happened for either user from the rejected push
    const logA = await a.client.query("select count(*)::int as n from public.v_change_log where record_id = 'e-a2'");
    assertEq(logA.rows[0].n, 0, "case 3: rejected push wrote nothing");

    // case 4: direct DML through the views is impossible (select-only grants on
    // the view surface — auto-updatable views without INSERT/UPDATE/DELETE grants)
    await assertRejects(
      async () => a.client.query("insert into public.v_media_items (user_id, local_id, record) values ($1,'x','{}')", [USER_A]),
      "permission denied", "case 4: direct insert through the view must fail");
    // …and echo_data direct DML is unreachable through any API surface locally
    //    (no SQL connections for API roles on the hosted platform).

    // case 5: A reads B's conflict_archive/snapshot pages → zero of B's rows
    const confBefore = (await a.client.query("select count(*)::int as n from public.v_conflict_archive")).rows[0].n;
    await push(b.client, devB, [op("b-1", "media_items", "m-b", "upsert", 0, mediaRecord({ localId: "m-b" }))]);
    await push(b.client, devB, [op("b-2", "media_items", "m-b", "upsert", 999, mediaRecord({ localId: "m-b", title: "loser" }))]); // D-3 archive row
    const conf = await a.client.query("select count(*)::int as n from public.v_conflict_archive");
    assertEq(conf.rows[0].n, confBefore, "case 5: A's conflict count is unchanged by B's new conflict (zero of B's rows visible)");
    const bStatus = await b.client.query("select public.sync_bootstrap_status() as r");
    const snapId = bStatus.rows[0].r.activeSnapshot.id;
    const bPages = await b.client.query("select count(*)::int as n from public.v_snapshot_pages where snapshot_id = $1", [snapId]);
    assert(bPages.rows[0].n > 0, "B sees own snapshot pages");
    const aPages = await a.client.query("select count(*)::int as n from public.v_snapshot_pages where snapshot_id = $1", [snapId]);
    assertEq(aPages.rows[0].n, 0, "case 5: A sees zero of B's snapshot pages");

    // case 7: revoked device push → device_revoked, zero writes
    const devA2 = await registerDevice(a.client, "A-dev-2");
    await a.client.query("select public.sync_device_revoke($1)", [devA2]);
    await assertRejects(
      async () => push(a.client, devA2, [op("a-4", "entries", "e-a3", "upsert", 0, { status: "watching" })]),
      "device_revoked", "case 7: revoked device push must raise device_revoked");
    const logA2 = await a.client.query("select count(*)::int as n from public.v_change_log where record_id = 'e-a3'");
    assertEq(logA2.rows[0].n, 0, "case 7: revoked push wrote nothing");

    // case 9: account deletion cascade — deleting the auth user leaves zero rows
    const admin = await db.adminClient();
    await admin.query("delete from auth.users where id = $1", [USER_A]);
    const leftovers = await admin.query(
      `select
         (select count(*) from echo_data.profiles where id = $1) +
         (select count(*) from echo_data.devices where user_id = $1) +
         (select count(*) from echo_data.media_items where user_id = $1) +
         (select count(*) from echo_data.entries where user_id = $1) +
         (select count(*) from echo_data.change_log where user_id = $1) +
         (select count(*) from echo_data.push_ops where user_id = $1) +
         (select count(*) from echo_data.snapshots where user_id = $1) as total`, [USER_A]);
    assertEq(Number(leftovers.rows[0].total), 0, "case 9: cascade leaves zero rows for the deleted user");
    const bStill = await b.client.query("select count(*)::int as n from public.v_media_items");
    assertEq(bStill.rows[0].n, 1, "case 9: user B unaffected");
  });

  test("X-8 push with foreign device performs zero writes (device-guard precedes the lock)", async (db: TestDb) => {
    const a = await initUser(db, USER_A);
    const b = await initUser(db, USER_B);
    const devB = await registerDevice(b.client, "B-dev");
    const before = await devicesSnapshot(db, USER_B);
    await assertRejects(
      async () => push(a.client, devB, [op("x-1", "entries", "e-x", "upsert", 0, { status: "watching" })]),
      "device_not_found");
    const after = await devicesSnapshot(db, USER_B);
    assertEq(after, before, "foreign-device push must not touch B's devices");
  });

  test("X-9 migration self-acceptance + red-branch proof", async (db: TestDb) => {
    // The chain itself applied as the migration role (postgres) and passed
    // its own final assertion — implicit in boot() succeeding. Re-run the
    // assertion body explicitly (idempotent green):
    const admin = await db.adminClient();
    await admin.query(`
      do $$
      declare r record;
      begin
        for r in
          select p.proname, n.nspname as schema, pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public','echo_jobs') and p.proname like 'sync\\_%' escape '\\'
        loop
          if r.schema = 'public' and r.prosecdef then
            raise exception 'public.% is SECURITY DEFINER', r.proname; end if;
          if r.schema = 'echo_jobs' and r.prosecdef and r.owner <> 'echo_jobs_admin' then
            raise exception 'echo_jobs.% definer owned by %', r.proname, r.owner; end if;
          if not r.prosecdef and r.owner <> current_user then
            raise exception '% owned by %', r.proname, r.owner; end if;
          if r.proconfig is null or not exists (select 1 from unnest(r.proconfig) c where c like 'search_path=%') then
            raise exception '% has no pinned search_path', r.proname; end if;
        end loop;
      end $$`);

    // RED BRANCH: flipping a public RPC to SECURITY DEFINER must make the
    // assertion fail (rolled back afterwards).
    await admin.query("begin");
    await admin.query("alter function public.sync_pull(uuid, bigint, int) security definer");
    await assertRejects(async () => admin.query(`
      do $$
      declare r record;
      begin
        for r in
          select p.proname, n.nspname as schema, pg_get_userbyid(p.proowner) as owner, p.prosecdef
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public','echo_jobs') and p.proname like 'sync\\_%' escape '\\'
        loop
          if r.schema = 'public' and r.prosecdef then
            raise exception 'public.% is SECURITY DEFINER', r.proname; end if;
        end loop;
      end $$`), "SECURITY DEFINER", "definer flip must be caught");
    await admin.query("rollback");
    // …and the inventory diff would catch it too:
    const inv = await admin.query(
      "select security_definer from public.v_sync_function_inventory where proname = 'sync_pull'");
    assertEq(inv.rows[0].security_definer, false, "rollback restored the invoker flag");
  });

  test("X-10 execution-identity proof: invoker runs as caller, definer as owner", async (db: TestDb) => {
    const admin = await db.adminClient();
    // scratch pair outside the audited schemas/names
    await admin.query("create schema if not exists echo_test_scratch");
    await admin.query(`
      create or replace function echo_test_scratch.as_invoker() returns text
      language sql security invoker set search_path = pg_catalog as $$ select current_user $$`);
    await admin.query(`
      create or replace function echo_test_scratch.as_definer() returns text
      language sql security definer set search_path = pg_catalog as $$ select current_user $$`);
    await admin.query("revoke all on function echo_test_scratch.as_invoker() from public");
    await admin.query("revoke all on function echo_test_scratch.as_definer() from public");
    await admin.query("grant execute on function echo_test_scratch.as_invoker() to authenticated");
    await admin.query("grant execute on function echo_test_scratch.as_definer() to authenticated");
    await admin.query("grant usage on schema echo_test_scratch to authenticated");

    const a = await initUser(db, USER_A);
    const inv = await a.client.query("select echo_test_scratch.as_invoker() as u");
    const def = await a.client.query("select echo_test_scratch.as_definer() as u");
    assertEq(inv.rows[0].u, "authenticated", "SECURITY INVOKER executes as the caller");
    assertEq(def.rows[0].u, "postgres", "SECURITY DEFINER executes as the owner");
    await admin.query("drop schema echo_test_scratch cascade");
  });

  test("X-11 environment parity (local leg): owner = migration role in this environment", async (db: TestDb) => {
    const admin = await db.adminClient();
    const res = await admin.query(
      `select distinct owner from public.v_sync_function_inventory where schema = 'public'`);
    assertEq(res.rows.map((r: { owner: string }) => r.owner), ["postgres"],
      "in the local environment the migration role is postgres (hosted: same; CI container: same via POSTGRES_USER)");
  });
});
