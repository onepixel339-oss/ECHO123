/**
 * ECHO Stage-3 local database test harness — utilities.
 *
 * Boots a real embedded PostgreSQL (PG 19) as the current user, applies the
 * local-env fixture (auth schema stub + platform roles) and the full
 * supabase/migrations chain as the migration role (`postgres`), then hands
 * out per-user sessions that simulate Supabase JWTs exactly the way
 * PostgREST does (set role authenticated + request.jwt.claims GUC).
 */
import EmbeddedPostgres from "embedded-postgres";
import type { Client } from "pg";
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", "..");
export const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
export const FIXTURES_DIR = path.join(__dirname, "fixtures");

export const USER_A = "11111111-1111-1111-1111-111111111111";
export const USER_B = "22222222-2222-2222-2222-222222222222";
export const USER_C = "33333333-3333-3333-3333-333333333333";

export function claimsFor(userId: string): string {
  return JSON.stringify({ sub: userId, role: "authenticated" });
}

// ─────────────────────────── tiny test framework ──────────────────────────
export type TestFn = (db: TestDb) => Promise<void> | void;
export type Testcase = { suite: string; name: string; fn: TestFn };

export const registry: Testcase[] = [];
let currentSuite = "";

export function suite(name: string, fn: () => void) {
  currentSuite = name;
  fn();
  currentSuite = "";
}
export function test(name: string, fn: TestFn) {
  registry.push({ suite: currentSuite, name, fn });
}

export class AssertionError extends Error {}
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}
export function assertEq<T>(actual: T, expected: T, msg = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AssertionError(
      `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
export async function assertRejects(fn: () => Promise<unknown>, needle: string, msg = "") {
  try {
    await fn();
  } catch (e) {
    const text = `${(e as Error).message} ${(e as { detail?: string })?.detail ?? ""} ${(e as { code?: string })?.code ?? ""}`;
    if (!text.includes(needle)) {
      throw new AssertionError(
        `${msg} — expected error containing '${needle}', got: ${text}`,
      );
    }
    return e as Error;
  }
  throw new AssertionError(`${msg} — expected a rejection containing '${needle}', but the call resolved`);
}

export async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs = 8000,
  stepMs = 40,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return await cond();
}

// ─────────────────────────── database harness ─────────────────────────────
export class TestDb {
  private pg: InstanceType<typeof EmbeddedPostgres>;
  readonly database: string;
  private clients: Client[] = [];
  private admin?: Client;

  private constructor(pgInstance: InstanceType<typeof EmbeddedPostgres>, database: string) {
    this.pg = pgInstance;
    this.database = database;
  }

  static async boot(instance?: InstanceType<typeof EmbeddedPostgres>, database = "echo_test") {
    const pgInstance =
      instance ??
      new EmbeddedPostgres({
        databaseDir: "/tmp/echo-pg-test",
        user: "postgres",
        password: "postgres",
        port: 54330,
        persistent: false,
        onLog: () => {},
        onError: () => {},
      });
    const exists = instance !== undefined;
    if (!exists) {
      await pgInstance.initialise();
      await pgInstance.start();
    }
    const db = new TestDb(pgInstance, database);
    await pgInstance.createDatabase(database);
    await db.migrate();
    return db;
  }

  private async migrate() {
    const client = await this.adminClient();
    const fixture = readFileSync(path.join(FIXTURES_DIR, "local_env.sql"), "utf8");
    await client.query(fixture);
    const files = [
      "0000_roles.sql",
      "0001_schema.sql",
      "0002_devices_and_pull.sql",
      "0003_sync_push.sql",
      "0004_bootstrap_lifecycle.sql",
      "0005_jobs.sql",
      "0006_views_assertions.sql",
      "0007_reason_constraint.sql",
    ];
    for (const f of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      await client.query(sql);
    }
  }

  async adminClient(): Promise<Client> {
    if (!this.admin) {
      this.admin = new pg.Client({
        user: "postgres",
        password: "postgres",
        port: 54330,
        host: "localhost",
        database: this.database,
      });
      await this.admin.connect();
    }
    return this.admin;
  }

  /** A session authenticated as `userId` (Supabase-JWT-equivalent). */
  async userClient(userId: string): Promise<Client> {
    const client = new pg.Client({
      user: "postgres",
      password: "postgres",
      port: 54330,
      host: "localhost",
      database: this.database,
    });
    await client.connect();
    await client.query("set role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      claimsFor(userId),
    ]);
    this.clients.push(client);
    return client;
  }

  /** A session with a given platform role and no user claims. */
  async roleClient(role: "anon" | "authenticated" | "service_role"): Promise<Client> {
    const client = new pg.Client({
      user: "postgres",
      password: "postgres",
      port: 54330,
      host: "localhost",
      database: this.database,
    });
    await client.connect();
    await client.query(`set role ${role}`);
    this.clients.push(client);
    return client;
  }

  async closeAll() {
    for (const c of this.clients) await c.end().catch(() => {});
    if (this.admin) await this.admin.end().catch(() => {});
    this.clients = [];
    this.admin = undefined;
  }

  async drop() {
    // End clients FIRST — terminating backends under live sockets crashes
    // the pg driver with unhandled 'error' events. The terminate/drop runs
    // from a maintenance session on the 'postgres' database (you cannot
    // drop a database your own session is connected to).
    await this.closeAll();
    const maint = new pg.Client({
      user: "postgres", password: "postgres", port: 54330, host: "localhost", database: "postgres",
    });
    await maint.connect();
    await maint.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid()`, [this.database]);
    await maint.query(`drop database if exists ${this.database}`);
    await maint.end();
  }
}

// ─────────────────────────── protocol helpers ─────────────────────────────
export async function initUser(db: TestDb, userId: string) {
  const admin = await db.adminClient();
  await admin.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [
    userId,
    `user-${userId.slice(0, 8)}@test.local`,
  ]);
  const c = await db.userClient(userId);
  const res = await c.query("select public.sync_init_profile() as r");
  return { client: c, profile: res.rows[0].r };
}

export async function registerDevice(c: Client, name = "Device"): Promise<string> {
  const res = await c.query("select public.sync_device_register($1, 'linux', 'test') as id", [name]);
  return res.rows[0].id;
}

export function op(
  opid: string,
  entity: string,
  recordId: string,
  kind: "upsert" | "delete",
  baseVersion: number,
  record?: Record<string, unknown>,
) {
  return {
    opid,
    entity,
    recordId,
    op: kind,
    baseVersion,
    ...(record !== undefined ? { record } : {}),
  };
}

export function mediaRecord(overrides: Record<string, unknown> = {}) {
  return {
    localId: "m-1",
    provider: "trakt",
    providerId: "trk-1",
    mediaType: "movie",
    format: "film",
    title: "Test Title",
    releaseYear: 2020,
    ...overrides,
  };
}

export async function push(c: Client, deviceId: string, ops: unknown[], epoch?: number) {
  const res = await c.query("select public.sync_push($1::jsonb, $2, $3) as r", [
    JSON.stringify(ops),
    deviceId,
    epoch ?? null,
  ]);
  return res.rows[0].r as {
    ok: boolean;
    epoch: number;
    headSeq: number;
    acked: string[];
    archived: { opid: string; reason: string; conflictId: number; serverVersion: number | null }[];
    rejected: { opid: string; reason: string }[];
  };
}

export async function pull(c: Client, deviceId: string, since: number, limit?: number) {
  const res = await c.query("select public.sync_pull($1, $2, $3) as r", [deviceId, since, limit ?? 500]);
  return res.rows[0].r as {
    ok: boolean;
    headSeq: number;
    watermark: number;
    changes: {
      seq: number;
      entity: string;
      recordId: string;
      op: string;
      version: number;
      deviceId: string | null;
      epoch: number;
      record: unknown;
    }[];
  };
}

export async function devicesSnapshot(db: TestDb, userId: string): Promise<Record<string, unknown>> {
  const admin = await db.adminClient();
  const res = await admin.query(
    "select coalesce(jsonb_object_agg(id, to_jsonb(d) - 'user_id'), '{}'::jsonb) as s from echo_data.devices d where d.user_id = $1",
    [userId],
  );
  return res.rows[0].s as Record<string, unknown>;
}

export async function status(c: Client) {
  const res = await c.query("select public.sync_status() as r");
  return res.rows[0].r as {
    ok: boolean;
    epoch: number;
    headSeq: number;
    watermark: number;
    serverBootId: string;
    perEntity: Record<string, number>;
    perEntityHash: Record<string, string>;
    archiveState: { unresolved: number; nearFullAt: number; cap: number; state: string };
  };
}

export async function bootstrapStatus(c: Client) {
  const res = await c.query("select public.sync_bootstrap_status() as r");
  return res.rows[0].r as {
    ok: boolean;
    epoch: number;
    headSeq: number;
    watermark: number;
    serverBootId: string;
    activeSnapshot: {
      id: number;
      headSeq: number;
      pageCount: number;
      recordCount: number;
      contentHash: string;
      epoch: number;
    };
  };
}

export async function runJob(db: TestDb, fn: "sync_job_compact" | "sync_job_cleanup" | "sync_job_reset", userId: string) {
  const admin = await db.adminClient();
  const res = await admin.query(`select echo_jobs.${fn}($1) as r`, [userId]);
  return res.rows[0].r as Record<string, unknown>;
}
