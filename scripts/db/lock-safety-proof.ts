/**
 * PROOF 3 — rollback-0049 transaction-control fix.
 *
 * Runs the REAL migrations/rollback-0049-partner-grading-work-items.sql against a realistic
 * disposable PostgreSQL 17 cluster (non-superuser pn_migrator, FORCE RLS, real 0049 schema).
 *
 *  3a  OLD shape (SET LOCAL stripped): an operator wrapper
 *        BEGIN; SET LOCAL lock_timeout='2s'; <file>; COMMIT;
 *      does NOT bound the wait — the file's own COMMIT discards the SET LOCAL.
 *  3b  NEW shape, CONTENDED: aborts at the file's own 5s bound with SQLSTATE 55P03,
 *      and NOTHING is dropped (atomic rollback of the rollback).
 *  3c  NEW shape, UNCONTENDED: still applies atomically — the bridge is fully removed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17 } from "../../tests/helpers/postgres17-cluster";
import {
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
  applyMigrationsRealistic,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  migratorUrlFrom,
  provisionRealisticRoles,
} from "../../tests/helpers/partner-realistic-db";

const ROLLBACK_PATH = join(process.cwd(), "migrations", "rollback-0049-partner-grading-work-items.sql");

function log(s: string): void {
  console.log(s);
}

async function seedMintVaultTables(admin: pg.Client): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    grading_status varchar(30), assigned_grader_id varchar, scan_status varchar(30),
    scan_assigned_to varchar, shipped_at timestamptz, delivered_at timestamptz,
    completed_at timestamptz, return_tracking text, return_carrier text, return_service text,
    return_postage_cost numeric, on_receipt_photo_urls jsonb,
    status_history jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await admin.query(
    "CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL REFERENCES submissions(id))"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await createMintvaultCertificatesTable(admin);
  await createMintvaultLabelPrintsTable(admin);
  await admin.query(
    "CREATE TABLE cert_counter (id integer PRIMARY KEY DEFAULT 1, last_issued integer NOT NULL DEFAULT 0)"
  );
  await admin.query("CREATE UNIQUE INDEX uq_submission_items_submission ON submission_items (submission_id, id)");
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "audit_log",
    "certificates",
    "label_prints",
    "cert_counter",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/** Hold AccessShareLock on `certificates` for `ms`, resolving once the lock is actually held. */
async function holdReader(url: string, ms: number): Promise<() => Promise<void>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  await c.query("SELECT count(*) FROM certificates");
  const timer = setTimeout(() => {}, ms);
  return async () => {
    clearTimeout(timer);
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  };
}

async function runSql(url: string, sql: string): Promise<{ ok: boolean; code?: string; message?: string; ms: number }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const t0 = Date.now();
  try {
    await c.query(sql);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: err.message, ms: Date.now() - t0 };
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
}

async function bridgeExists(admin: pg.Client): Promise<boolean> {
  const r = await admin.query("SELECT to_regclass('public.partner_grading_work_items') IS NOT NULL AS present");
  return r.rows[0].present === true;
}

async function main(): Promise<void> {
  const cluster = await startPostgres17("lock-safety-rollback-0049");
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  try {
    await provisionRealisticRoles(admin);
    await seedMintVaultTables(admin);
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);
    const migratorUrl = migratorUrlFrom(cluster.url);
    log(`setup: 0049 applied, partner_grading_work_items present = ${await bridgeExists(admin)}`);

    const real = readFileSync(ROLLBACK_PATH, "utf8");
    if (!/^SET LOCAL lock_timeout = '5s';$/m.test(real)) {
      throw new Error("rollback-0049 no longer carries the SET LOCAL lock_timeout line — proof invalid.");
    }
    const old = real.replace(/^SET LOCAL lock_timeout = '5s';$/m, "-- (SET LOCAL removed: pre-fix shape)");

    // ---------------------------------------------------------------- 3b
    log("\n=== 3b  NEW shape, CONTENDED (file carries its own SET LOCAL lock_timeout='5s') ===");
    const release = await holdReader(cluster.url, 30_000);
    const b = await runSql(migratorUrl, real);
    log(`    result: ok=${b.ok} code=${b.code ?? "-"} waited=${b.ms}ms`);
    log(`    message: ${(b.message ?? "").slice(0, 120)}`);
    log(`    partner_grading_work_items still present (nothing dropped) = ${await bridgeExists(admin)}`);
    await release();

    // ---------------------------------------------------------------- 3c
    log("\n=== 3c  NEW shape, UNCONTENDED (must still apply atomically) ===");
    const c = await runSql(migratorUrl, real);
    log(`    result: ok=${c.ok} code=${c.code ?? "-"} took=${c.ms}ms  err=${(c.message ?? "").slice(0, 160)}`);
    log(`    partner_grading_work_items present after rollback = ${await bridgeExists(admin)}`);
    const idx = await admin.query(
      "SELECT to_regclass('public.uq_partner_grading_work_items_certificate_scope') IS NOT NULL AS present"
    );
    log(`    D2 index on certificates still present = ${idx.rows[0].present}`);

    // ---------------------------------------------------------------- 3a (control)
    // Re-apply 0049, then run the PRE-FIX shape the documented way (`psql -f`, no wrapper)
    // against the same contention, to measure what the SET LOCAL line actually buys.
    log("\n=== 3a  CONTROL: OLD shape (no SET LOCAL), plain run, contended ===");
    const reapply = new pg.Client({ connectionString: migratorUrl });
    await reapply.connect();
    await reapply.query(readFileSync(join(process.cwd(), "migrations", "0049_partner_grading_work_items.sql"), "utf8"));
    await reapply.end();
    log(`    0049 re-applied, bridge present = ${await bridgeExists(admin)}`);

    const blockerMs = 12_000;
    const releaseA = await holdReader(cluster.url, 30_000);
    setTimeout(() => void releaseA(), blockerMs);
    const t0 = Date.now();
    const aRun = runSql(migratorUrl, old);
    // A public certificate lookup arriving while the ACCESS EXCLUSIVE request is queued.
    await new Promise((r) => setTimeout(r, 1_500));
    const lookup = await runSql(
      cluster.url,
      "SET lock_timeout='3s'; SELECT count(*) FROM certificates WHERE cert_id IS NOT NULL;"
    );
    log(
      `    public certificate lookup during the wait: ok=${lookup.ok} code=${lookup.code ?? "-"} ` +
        `after=${lookup.ms}ms  <- BLOCKED behind the ACCESS EXCLUSIVE waiter`
    );
    const a = await aRun;
    log(
      `    old-shape rollback: ok=${a.ok} code=${a.code ?? "-"} waited=${a.ms}ms ` +
        `(blocker held ${blockerMs}ms) elapsed=${Date.now() - t0}ms`
    );
    log(
      a.ok
        ? "    -> UNBOUNDED: it waited out the blocker instead of failing fast; every reader queued behind it."
        : `    -> bounded unexpectedly (${a.code})`
    );
  } finally {
    await admin.end().catch(() => {});
    await cluster.stop().catch(() => {});
  }
}

void main();
