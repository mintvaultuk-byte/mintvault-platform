/**
 * MIGRATION IDENTITY GUARD — the control that makes forward-only convergence real.
 *
 * The runner's pre-existing duplicate-number check only compares files WITHIN one
 * release. It could not see that the target database had already applied a
 * DIFFERENT migration at the same numeric slot, because the journal is keyed on
 * `filename` and numbers are only sort order. So a release whose 0046 is
 * `partner_mfa_pending_lifecycle` applied cleanly onto a database whose 0046 is
 * `scanner_processing_jobs`: the filename was simply absent, the runner treated it
 * as new work, and the database ended up holding two different migrations at 0046
 * — permanently ambiguous, and silently, because nothing errored.
 *
 * That is precisely how MintVault ended up with three incompatible lineages forking
 * at 0045-0048 across production, staging and main.
 *
 * The guard fails closed BEFORE anything is applied and never mutates the journal:
 * applied history stays immutable, which is the whole point of the owner's
 * forward-only decision.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrations, planMigrations } from "../scripts/db/migrate";

let cluster: DisposablePostgres17;
let pool: pg.Pool;

const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex");
const file = (filename: string, sql: string) => ({
  number: filename.slice(0, 4),
  filename,
  path: `/virtual/${filename}`,
  sql,
  checksum: sha(sql),
  noTransaction: false,
});

beforeAll(async () => {
  cluster = await startPostgres17("migration-identity-guard");
  pool = new pg.Pool({ connectionString: cluster.url, max: 4 });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

async function freshJournal(applied: Array<{ filename: string; sql: string }>) {
  await pool.query("DROP TABLE IF EXISTS schema_migrations, probe_target");
  await pool.query("CREATE TABLE probe_target (id integer)");
  await pool.query(`
    CREATE TABLE schema_migrations (
      id serial PRIMARY KEY, filename text NOT NULL UNIQUE, checksum text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      status text NOT NULL DEFAULT 'applied', applied_by text NOT NULL DEFAULT current_user
    );
  `);
  for (const a of applied) {
    await pool.query("INSERT INTO schema_migrations (filename, checksum, completed_at) VALUES ($1,$2,now())", [
      a.filename,
      sha(a.sql),
    ]);
  }
}

describe("migration identity guard", () => {
  it("REFUSES a release whose number is already occupied by a DIFFERENT migration", async () => {
    // The real production collision: 0046 is scanner_processing_jobs there, but the
    // reconciliation branch's 0046 is partner_mfa_pending_lifecycle.
    await freshJournal([{ filename: "0046_scanner_processing_jobs.sql", sql: "SELECT 1" }]);
    const client = await pool.connect();
    try {
      await expect(
        applyMigrations(client as never, [
          file("0046_partner_mfa_pending_lifecycle.sql", "ALTER TABLE probe_target ADD COLUMN mfa integer"),
        ])
      ).rejects.toThrow(/Migration identity conflict/);
    } finally {
      client.release();
    }
    // AND it must have applied nothing — fail closed, not fail halfway.
    const { rows } = await pool.query(
      "SELECT count(*)::int c FROM information_schema.columns WHERE table_name='probe_target' AND column_name='mfa'"
    );
    expect(rows[0].c, "the refused migration must not have run").toBe(0);
  });

  it("names BOTH identities so an operator can act without decoding it", async () => {
    await freshJournal([{ filename: "0047_scanner_evidence_staging.sql", sql: "SELECT 1" }]);
    const client = await pool.connect();
    try {
      const err = await applyMigrations(client as never, [
        file("0047_partner_label_preview_permission.sql", "SELECT 1"),
      ]).then(
        () => null,
        (e: Error) => e
      );
      expect(err).not.toBeNull();
      expect(err!.message).toContain("0047_scanner_evidence_staging.sql");
      expect(err!.message).toContain("0047_partner_label_preview_permission.sql");
      // It must point at the forward-only remedy, not at renumbering.
      expect(err!.message).toMatch(/immutable/i);
      expect(err!.message).toMatch(/next globally\s+free number/i);
    } finally {
      client.release();
    }
  });

  it("ALLOWS a genuinely new number — this is what forward-only convergence needs", async () => {
    // 0073 against a journal holding the production scanner trio: no slot conflict,
    // so convergence proceeds.
    await freshJournal([
      { filename: "0045_partner_stations.sql", sql: "SELECT 1" },
      { filename: "0046_scanner_processing_jobs.sql", sql: "SELECT 1" },
      { filename: "0047_scanner_evidence_staging.sql", sql: "SELECT 1" },
    ]);
    const client = await pool.connect();
    try {
      const result = await applyMigrations(client as never, [
        file("0073_lineage_convergence.sql", "ALTER TABLE probe_target ADD COLUMN converged integer"),
      ]);
      expect(result.applied).toEqual(["0073_lineage_convergence.sql"]);
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      "SELECT count(*)::int c FROM information_schema.columns WHERE table_name='probe_target' AND column_name='converged'"
    );
    expect(rows[0].c).toBe(1);
  });

  it("ALLOWS re-running the SAME identity — idempotency is not a conflict", async () => {
    await freshJournal([{ filename: "0046_partner_mfa_pending_lifecycle.sql", sql: "SELECT 42" }]);
    const client = await pool.connect();
    try {
      const result = await applyMigrations(client as never, [
        file("0046_partner_mfa_pending_lifecycle.sql", "SELECT 42"),
      ]);
      expect(result.applied, "an already-applied identity is skipped, not refused").toEqual([]);
    } finally {
      client.release();
    }
  });

  it("exposes the full journal to the guard, not just this release's files", async () => {
    // The colliding migration is BY DEFINITION one the release does not contain, so
    // the guard can only see it by reading the journal itself.
    await freshJournal([
      { filename: "0045_partner_stations.sql", sql: "SELECT 1" },
      { filename: "0046_scanner_processing_jobs.sql", sql: "SELECT 1" },
    ]);
    const plan = await planMigrations(pool as never, [file("0073_lineage_convergence.sql", "SELECT 1")]);
    expect(plan.journalFilenames).toContain("0045_partner_stations.sql");
    expect(plan.journalFilenames).toContain("0046_scanner_processing_jobs.sql");
  });

  it("never mutates applied journal rows — history stays immutable", async () => {
    await freshJournal([{ filename: "0046_scanner_processing_jobs.sql", sql: "SELECT 1" }]);
    const before = await pool.query("SELECT filename, checksum, status FROM schema_migrations ORDER BY filename");
    const client = await pool.connect();
    try {
      await applyMigrations(client as never, [file("0046_partner_mfa_pending_lifecycle.sql", "SELECT 1")]).catch(
        () => {}
      );
    } finally {
      client.release();
    }
    const after = await pool.query("SELECT filename, checksum, status FROM schema_migrations ORDER BY filename");
    expect(after.rows, "a refused run must leave the journal byte-identical").toEqual(before.rows);
  });
});
