/**
 * ECHO Stage-3 database test runner.
 * Usage: bun run supabase/local/run.ts [--db-only]
 */
import EmbeddedPostgres from "embedded-postgres";
import { rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { registry, TestDb, assert, AssertionError } from "./util.ts";
import "./suites/x-security.ts";
import "./suites/t2-sequencing.ts";
import "./suites/t3-conflicts.ts";
import "./suites/t4-bootstrap.ts";
import "./suites/t5-licensing.ts";

const DATA_DIR = "/tmp/echo-pg-test";
const PORT = 54330;

async function main() {
  const dbOnly = process.argv.includes("--db-only");
  rmSync(DATA_DIR, { recursive: true, force: true });

  const pgInstance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pgInstance.initialise();
  await pgInstance.start();
  console.log(`[harness] embedded PostgreSQL up on :${PORT}`);

  let passed = 0;
  let failed = 0;
  const failures: { suite: string; name: string; err: string }[] = [];

  try {
    if (dbOnly) {
      const db = await TestDb.boot(pgInstance);
      console.log("[harness] migrations applied cleanly (db-only mode)");
      await db.drop();
    } else {
      // Group tests by suite; each suite gets a FRESH database.
      const suites = [...new Set(registry.map((t) => t.suite))];
      for (const suiteName of suites) {
        const tests = registry.filter((t) => t.suite === suiteName);
        const db = await TestDb.boot(pgInstance, `echo_${suiteName.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`);
        console.log(`\n── suite: ${suiteName} (${tests.length} tests) ──`);
        for (const t of tests) {
          try {
            await t.fn(db);
            passed++;
            console.log(`  ✓ ${t.name}`);
          } catch (e) {
            failed++;
            const msg = e instanceof AssertionError ? e.message : `${(e as Error).message}`;
            failures.push({ suite: suiteName, name: t.name, err: msg });
            console.log(`  ✗ ${t.name}\n      ${msg.split("\n")[0].slice(0, 300)}`);
          }
        }
        await db.drop();
      }
    }
  } finally {
    try {
      await pgInstance.stop();
    } catch {
      /* ignore */
    }
    rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`  DB suites: ${passed} passed, ${failed} failed, ${registry.length} total`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  [${f.suite}] ${f.name}\n    ${f.err.slice(0, 500)}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[harness] fatal:", e);
  process.exit(1);
});
