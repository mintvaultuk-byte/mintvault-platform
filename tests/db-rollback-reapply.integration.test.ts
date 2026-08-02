/**
 * The rollback ledger — the ONLY thing that may re-admit a below-watermark migration.
 *
 * WHAT THIS SUITE IS DEFENDING
 *
 * The monotonic order guard refuses a pending migration numbered below the highest applied. That is
 * how a stale branch lands a schema change underneath migrations that already assumed a later
 * state, and that refusal must stay absolute.
 *
 * But "pending" means only "absent from the journal by filename", and an approved rollback produces
 * exactly that shape by deleting its own row. So a deliberate back-out and a late-arriving branch
 * became indistinguishable, and the connector's documented rollback-and-restore procedure stopped
 * working — three CI suites went red.
 *
 * The ledger is the missing input, and it is deliberately narrow. Re-admission requires ALL of:
 *
 *   - a ledger row for that EXACT filename, state 'eligible';
 *   - its checksum — copied FROM the journal, i.e. what was genuinely applied to THIS database,
 *     never hashed from disk — equal to the forward file's checksum today;
 *   - watermark_at_rollback equal to the CURRENT watermark.
 *
 * That last condition is what stops it becoming a general bypass, and it is the case a hostile
 * reviewer raised specifically: roll back 0038, let 0039/0040 land, then reapply 0038. Every other
 * condition passes; the watermark moved 38 -> 40, so the marker is dead and the guard still
 * refuses. The exemption is therefore "put back exactly what you just removed, before anything else
 * changes" — self-closing, not a standing licence.
 *
 * Deleting a journal row by hand mints nothing and stays refused. That asymmetry is the point.
 *
 * Runs against a DISPOSABLE, ISOLATED PostgreSQL 17 this file creates and drops. It never touches
 * staging or production, and fails loudly rather than skipping.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { listMigrationFiles, planMigrations, applyMigrations } from "../scripts/db/migrate";

let cluster: DisposablePostgres17;
let db: pg.Pool;
let dir: string;

/** A synthetic migration whose body is trivially re-runnable. */
function write(name: string, body: string): void {
  writeFileSync(join(dir, name), body, "utf8");
}

function files() {
  return listMigrationFiles(dir);
}

function fileFor(name: string) {
  const f = files().find((x) => x.filename === name);
  if (!f) throw new Error(`fixture missing: ${name}`);
  return f;
}

/** Apply through the REAL runner, so the journal and the ledger are created exactly as in production. */
async function apply(only?: string[]) {
  const client = new pg.Client({ connectionString: cluster.url });
  await client.connect();
  try {
    const set = only ? files().filter((f) => only.includes(f.filename)) : files();
    return await applyMigrations(client as never, set);
  } finally {
    await client.end();
  }
}

async function plan() {
  const client = new pg.Client({ connectionString: cluster.url });
  await client.connect();
  try {
    return await planMigrations(client as never, files());
  } finally {
    await client.end();
  }
}

/**
 * The APPROVED rollback shape, byte-identical in structure to the block every rollback-*.sql now
 * carries: mint the ledger row from the journal, then retract the journal row, in one transaction.
 */
async function approvedRollback(filenames: string[]): Promise<void> {
  const list = filenames.map((f) => `'${f}'`).join(",");
  await db.query(`
    BEGIN;
    DO $ledger$
    BEGIN
      IF to_regclass('public.schema_migration_rollbacks') IS NOT NULL THEN
        INSERT INTO schema_migration_rollbacks (filename, checksum, watermark_at_rollback, batch)
        SELECT m.filename, m.checksum,
               COALESCE((SELECT MAX((regexp_match(filename,'^([0-9]{4,})_'))[1]::int) FROM schema_migrations),0),
               'test'
          FROM schema_migrations m WHERE m.filename IN (${list})
        ON CONFLICT DO NOTHING;
      END IF;
    END $ledger$;
    DELETE FROM schema_migrations WHERE filename IN (${list});
    COMMIT;`);
}

/** A hand-deletion: the journal row goes, and NOTHING is minted. */
async function handDelete(filename: string): Promise<void> {
  await db.query(`DELETE FROM schema_migrations WHERE filename = $1`, [filename]);
}

async function journal(): Promise<string[]> {
  const { rows } = await db.query<{ filename: string }>(`SELECT filename FROM schema_migrations ORDER BY filename`);
  return rows.map((r) => r.filename);
}

async function markers(): Promise<{ filename: string; state: string }[]> {
  const { rows } = await db.query<{ filename: string; state: string }>(
    `SELECT filename, state FROM schema_migration_rollbacks ORDER BY filename, id`
  );
  return rows;
}

beforeAll(async () => {
  cluster = await startPostgres17("db-rollback-reapply");
  db = new pg.Pool({ connectionString: cluster.url, max: 4 });
}, 240_000);

afterAll(async () => {
  await db?.end();
  await cluster?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS schema_migrations, schema_migration_rollbacks CASCADE`);
  await db.query(`DROP TABLE IF EXISTS t1, t2, t3, t4, t5, t9 CASCADE`);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "mig-reapply-"));
  // A small, ordinary migration set. Each body is idempotent so a reapply is legitimate.
  write("0001_a.sql", "CREATE TABLE IF NOT EXISTS t1 (id int);\n");
  write("0002_b.sql", "CREATE TABLE IF NOT EXISTS t2 (id int);\n");
  write("0003_c.sql", "CREATE TABLE IF NOT EXISTS t3 (id int);\n");
  write("0004_d.sql", "CREATE TABLE IF NOT EXISTS t4 (id int);\n");
  write("0005_e.sql", "CREATE TABLE IF NOT EXISTS t5 (id int);\n");
});

describe("rollback-ledger coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.GITHUB_ACTIONS) {
      expect(cluster?.url, "disposable PostgreSQL 17 must be reachable in CI").toBeTruthy();
    }
  });
});

/* ── 10 + 11: the ordinary paths must be completely unchanged ──────────────────────────────── */

describe("ordinary migration behaviour is untouched", () => {
  it("MATRIX-10 applies a full set from an empty database", async () => {
    const { applied } = await apply();
    expect(applied).toHaveLength(5);
    expect(await journal()).toHaveLength(5);
    // The ledger is created but stays empty — nothing was rolled back.
    expect(await markers()).toEqual([]);
  }, 60_000);

  it("MATRIX-11 a normal forward-only migration is admitted with no ledger involvement", async () => {
    await apply();
    write("0006_f.sql", "CREATE TABLE IF NOT EXISTS t9 (id int);\n");
    const p = await plan();
    expect(p.pending).toEqual(["0006_f.sql"]);
    expect(p.outOfOrder).toEqual([]);
    expect(p.authorisedReapply).toEqual([]);
    const { applied } = await apply();
    expect(applied).toEqual(["0006_f.sql"]);
  }, 60_000);

  it("re-running an already-applied set is a clean no-op", async () => {
    await apply();
    const { applied } = await apply();
    expect(applied).toEqual([]);
  }, 60_000);
});

/* ── 1, 2, 12: everything WITHOUT a marker stays refused ───────────────────────────────────── */

describe("no marker means no exemption", () => {
  it("MATRIX-1 refuses a late-arriving lower-numbered migration", async () => {
    // 0002 was NEVER applied here; everything above it was. It then turns up from a branch —
    // the exact shape the guard exists for, and it must be refused without a ledger entry.
    await apply(["0001_a.sql", "0003_c.sql", "0004_d.sql", "0005_e.sql"]);
    expect(await markers()).toEqual([]);
    const p = await plan();
    expect(p.outOfOrder.map((o) => o.filename)).toContain("0002_b.sql");
    expect(p.authorisedReapply).toEqual([]);
    await expect(apply()).rejects.toThrow(/Out-of-order migration/);
  }, 60_000);

  it("MATRIX-2 refuses when the journal row was deleted BY HAND (no ledger entry)", async () => {
    await apply();
    await handDelete("0002_b.sql");
    expect(await markers()).toEqual([]);
    const p = await plan();
    // This is the requirement that absence must never imply eligibility.
    expect(p.outOfOrder.map((o) => o.filename)).toEqual(["0002_b.sql"]);
    expect(p.authorisedReapply).toEqual([]);
    await expect(apply()).rejects.toThrow(/Out-of-order migration/);
  }, 60_000);

  it("MATRIX-12 refuses the 0036-0038 late-arrival scenario", async () => {
    // Mirrors the real branch situation: 0039/0040 applied, 0036-0038 turn up later from a branch.
    write("0036_device.sql", "CREATE TABLE IF NOT EXISTS t9 (id int);\n");
    write("0039_live.sql", "CREATE TABLE IF NOT EXISTS t1 (id int);\n");
    write("0040_seed.sql", "CREATE TABLE IF NOT EXISTS t2 (id int);\n");
    await apply(["0039_live.sql", "0040_seed.sql"]);
    const p = await plan();
    expect(p.outOfOrder.map((o) => o.filename)).toContain("0036_device.sql");
    expect(p.authorisedReapply).toEqual([]);
    await expect(apply()).rejects.toThrow(/Out-of-order migration/);
  }, 60_000);
});

/* ── 3, 4: the approved rollback path ──────────────────────────────────────────────────────── */

describe("an approved rollback makes exactly that migration eligible", () => {
  it("MATRIX-3 mints a marker carrying the filename, the applied checksum and the watermark", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    const { rows } = await db.query(
      `SELECT filename, checksum, watermark_at_rollback, state FROM schema_migration_rollbacks`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("0002_b.sql");
    // The checksum is the one the RUNNER wrote, not one hashed from disk at rollback time.
    expect(rows[0].checksum).toBe(fileFor("0002_b.sql").checksum);
    expect(Number(rows[0].watermark_at_rollback)).toBe(5);
    expect(rows[0].state).toBe("eligible");

    const p = await plan();
    expect(p.authorisedReapply.map((r) => r.filename)).toEqual(["0002_b.sql"]);
    expect(p.outOfOrder).toEqual([]);
  }, 60_000);

  it("MATRIX-4 reapply restores the journal and consumes the marker atomically", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    const { applied } = await apply();
    expect(applied).toEqual(["0002_b.sql"]);
    expect(await journal()).toHaveLength(5);
    // Consumed, not deleted: the audit trail of the rollback survives.
    expect(await markers()).toEqual([{ filename: "0002_b.sql", state: "consumed" }]);
    // And the exemption is spent — a second attempt has nothing to ride on.
    const p = await plan();
    expect(p.authorisedReapply).toEqual([]);
  }, 60_000);

  it("a consumed marker cannot be reused by deleting the journal row again", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    await apply();
    await handDelete("0002_b.sql");
    const p = await plan();
    expect(p.authorisedReapply).toEqual([]);
    expect(p.outOfOrder.map((o) => o.filename)).toEqual(["0002_b.sql"]);
  }, 60_000);
});

/* ── 5, 6, 7: the marker must be exact ─────────────────────────────────────────────────────── */

describe("the marker binds tightly, and to one migration only", () => {
  it("MATRIX-5 refuses when the forward file changed after the rollback", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    // Someone edits the migration between backing it out and putting it back.
    write("0002_b.sql", "CREATE TABLE IF NOT EXISTS t2 (id int, extra text);\n");
    const p = await plan();
    expect(p.authorisedReapply).toEqual([]);
    expect(p.outOfOrder.map((o) => o.filename)).toEqual(["0002_b.sql"]);
    await expect(apply()).rejects.toThrow(/Out-of-order migration/);
  }, 60_000);

  it("MATRIX-6 a marker for another migration grants nothing", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    // Consume 0002's marker legitimately, then hand-delete a DIFFERENT migration.
    await apply();
    await handDelete("0003_c.sql");
    const p = await plan();
    expect(p.authorisedReapply).toEqual([]);
    expect(p.outOfOrder.map((o) => o.filename)).toEqual(["0003_c.sql"]);
  }, 60_000);

  it("MATRIX-7 exempts ONLY the marked migration when several are pending below the watermark", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    // 0003 goes by hand — no marker. Both are now pending and below the watermark.
    await handDelete("0003_c.sql");
    const p = await plan();
    expect(p.authorisedReapply.map((r) => r.filename)).toEqual(["0002_b.sql"]);
    expect(p.outOfOrder.map((o) => o.filename)).toEqual(["0003_c.sql"]);
    // One valid marker must never carry an unmarked sibling through the batch.
    await expect(apply()).rejects.toThrow(/0003_c\.sql/);
    // ...and the refusal is total: the marked one is not applied either.
    expect(await journal()).not.toContain("0002_b.sql");
  }, 60_000);
});

/* ── The self-closing invariant ────────────────────────────────────────────────────────────── */

describe("the marker dies as soon as anything else is applied", () => {
  it("refuses a reapply once a later migration has landed since the rollback", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    // The exact scenario a hostile reviewer raised for 0036-0038: back one out, let a later
    // migration land, then try to slide the old one in underneath it.
    write("0006_f.sql", "CREATE TABLE IF NOT EXISTS t9 (id int);\n");
    await apply(["0006_f.sql"]);

    const p = await plan();
    expect(p.authorisedReapply, "the marker must be dead once the watermark moves").toEqual([]);
    expect(p.outOfOrder.map((o) => o.filename)).toEqual(["0002_b.sql"]);
    await expect(apply()).rejects.toThrow(/Out-of-order migration/);
  }, 60_000);
});

/* ── 8: a failed reapply must not lie ──────────────────────────────────────────────────────── */

describe("MATRIX-8 a failed reapply leaves recoverable state", () => {
  it("keeps the marker eligible and does NOT record the migration as applied", async () => {
    await apply();
    await approvedRollback(["0002_b.sql"]);
    // The reapply now fails: the file is broken between rollback and reapply.
    write("0002_b.sql", "CREATE TABLE IF NOT EXISTS t2 (id int);\nSELECT 1/0;\n");
    // Checksum changed too, so it is refused before it can even run — the outer guard holds first.
    await expect(apply()).rejects.toThrow();
    expect(await journal()).not.toContain("0002_b.sql");
    // Recoverable: the operator can restore the file and retry without re-running the rollback.
    expect((await markers())[0]).toEqual({ filename: "0002_b.sql", state: "eligible" });
  }, 60_000);

  it("a mid-apply SQL failure rolls back the journal row AND leaves the marker eligible", async () => {
    // A body with NO "IF NOT EXISTS", so a pre-existing object makes the reapply genuinely throw.
    // The file is never edited, so its checksum still matches the marker — this isolates a runtime
    // failure from a checksum refusal.
    write("0002_b.sql", "CREATE TABLE t2 (id int);\n");
    await apply();
    await approvedRollback(["0002_b.sql"]);
    await db.query(`DROP TABLE IF EXISTS t2`);
    // The marker is genuinely eligible at this point.
    expect((await plan()).authorisedReapply.map((r) => r.filename)).toEqual(["0002_b.sql"]);

    // Now sabotage the target so the migration's own SQL fails mid-apply.
    await db.query(`CREATE TABLE t2 (id int, conflicting text)`);
    await expect(apply()).rejects.toThrow(/already exists|failed and was rolled back/i);

    // The journal must NOT claim it applied, and the marker must survive for a retry.
    expect(await journal()).not.toContain("0002_b.sql");
    expect((await markers())[0]).toEqual({ filename: "0002_b.sql", state: "eligible" });

    // Recovery without re-running the rollback: clear the obstruction and retry.
    await db.query(`DROP TABLE t2`);
    const { applied } = await apply();
    expect(applied).toEqual(["0002_b.sql"]);
    expect((await markers())[0].state).toBe("consumed");
  }, 60_000);
});
