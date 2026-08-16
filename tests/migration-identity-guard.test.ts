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
import {
  applyMigrations,
  planMigrations,
  listMigrationFiles,
  loadLineageExclusions,
  partitionIdentityConflicts,
} from "../scripts/db/migrate";

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

/**
 * LINEAGE EXCLUSION DECLARATIONS (2026-08-14) — the guard's "exclude the colliding file from
 * this environment" remedy, made explicit and fail-closed. A declaration names the EXACT
 * (incoming, occupant) pair plus a supersededBy convergence migration that must ship in the
 * same release; anything less specific still aborts the whole run.
 */
describe("lineage exclusion declarations", () => {
  const STAGING_SHAPED = [
    { filename: "0044_partner_submission_lifecycle_and_location_snapshot.sql", sql: "SELECT 1" },
    { filename: "0046_partner_mfa_pending_lifecycle.sql", sql: "SELECT 2" },
    { filename: "0047_partner_owner_invariant_tenants_rls.sql", sql: "SELECT 3" },
  ];

  it("EXCLUDES a declared (incoming, occupant) pair and applies the rest — never journalling the excluded file", async () => {
    await freshJournal(STAGING_SHAPED);
    const client = await pool.connect();
    try {
      const result = await applyMigrations(
        client as never,
        [
          // Would poison probe_target if it ran — proving exclusion means NOT-RUN, not just unlogged.
          file("0046_scanner_processing_jobs.sql", "ALTER TABLE probe_target ADD COLUMN poisoned integer"),
          file("0090_lineage_convergence_scanner.sql", "ALTER TABLE probe_target ADD COLUMN converged90 integer"),
        ],
        {
          exclusions: [
            {
              incoming: "0046_scanner_processing_jobs.sql",
              occupant: "0046_partner_mfa_pending_lifecycle.sql",
              supersededBy: "0090_lineage_convergence_scanner.sql",
              reason: "test",
            },
          ],
        }
      );
      expect(result.applied).toEqual(["0090_lineage_convergence_scanner.sql"]);
    } finally {
      client.release();
    }
    const cols = await pool.query(
      "SELECT count(*)::int c FROM information_schema.columns WHERE table_name='probe_target' AND column_name='poisoned'"
    );
    expect(cols.rows[0].c, "the excluded migration must not have run").toBe(0);
    const journal = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE filename='0046_scanner_processing_jobs.sql'"
    );
    expect(journal.rowCount, "the excluded migration must not be journalled").toBe(0);
  });

  it("a declaration whose supersededBy is ABSENT from the release is void — the conflict still aborts", async () => {
    await freshJournal(STAGING_SHAPED);
    const client = await pool.connect();
    try {
      await expect(
        applyMigrations(client as never, [file("0046_scanner_processing_jobs.sql", "SELECT 1")], {
          exclusions: [
            {
              incoming: "0046_scanner_processing_jobs.sql",
              occupant: "0046_partner_mfa_pending_lifecycle.sql",
              supersededBy: "0090_lineage_convergence_scanner.sql", // not in this file set
              reason: "test",
            },
          ],
        })
      ).rejects.toThrow(/Migration identity conflict/);
    } finally {
      client.release();
    }
  });

  it("a declaration naming the WRONG occupant does not match — the conflict still aborts", async () => {
    await freshJournal(STAGING_SHAPED);
    const client = await pool.connect();
    try {
      await expect(
        applyMigrations(
          client as never,
          [
            file("0046_scanner_processing_jobs.sql", "SELECT 1"),
            file("0090_lineage_convergence_scanner.sql", "SELECT 1"),
          ],
          {
            exclusions: [
              {
                incoming: "0046_scanner_processing_jobs.sql",
                occupant: "0046_some_other_identity.sql", // staging's real occupant is the MFA file
                supersededBy: "0090_lineage_convergence_scanner.sql",
                reason: "test",
              },
            ],
          }
        )
      ).rejects.toThrow(/Migration identity conflict/);
    } finally {
      client.release();
    }
  });

  it("the SHIPPED declarations file resolves the real staging lineage: 3 excluded, 0 undeclared", () => {
    const files = listMigrationFiles();
    const exclusions = loadLineageExclusions();
    expect(exclusions).toHaveLength(3);
    for (const d of exclusions) {
      expect(
        files.some((f) => f.filename === d.incoming),
        `${d.incoming} must ship in this release`
      ).toBe(true);
      expect(
        files.some((f) => f.filename === d.supersededBy),
        `${d.supersededBy} must ship in this release`
      ).toBe(true);
    }
    // Staging's journal identities at the colliding numbers, as read on 2026-08-14.
    const stagingJournal = [
      "0044_partner_submission_lifecycle_and_location_snapshot.sql",
      "0046_partner_mfa_pending_lifecycle.sql",
      "0047_partner_owner_invariant_tenants_rls.sql",
    ];
    const pending = files.map((f) => f.filename);
    const partition = partitionIdentityConflicts(pending, stagingJournal, files, exclusions);
    expect(partition.undeclared).toEqual([]);
    expect(partition.excluded.map((c) => c.incoming).sort()).toEqual([
      "0044_partner_mfa_pending_lifecycle.sql",
      "0046_scanner_processing_jobs.sql",
      "0047_scanner_evidence_staging.sql",
    ]);
  });

  it("on a FRESH journal the declarations never match — 0044/0046/0047 apply normally", () => {
    const files = listMigrationFiles();
    const exclusions = loadLineageExclusions();
    const partition = partitionIdentityConflicts(
      files.map((f) => f.filename),
      [],
      files,
      exclusions
    );
    expect(partition.undeclared).toEqual([]);
    expect(partition.excluded).toEqual([]);
  });
});
