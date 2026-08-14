/**
 * FORWARD-ONLY LINEAGE CONVERGENCE — real-PostgreSQL proof for migration 0090.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * tests/migration-identity-guard.test.ts already proves the RUNNER's exclusion mechanics, but it
 * does so with SYNTHETIC bodies — `file("0090_….sql", "ALTER TABLE probe_target ADD COLUMN …")`.
 * That pins the partition logic and nothing about the migration itself. An independent audit
 * (2026-08-14) correctly called that out: the fresh-state harness asserted source strings rather
 * than behaviour, so 0090 could have been semantically wrong in every way and still shipped green.
 *
 * This suite closes that gap. It builds a database shaped like the REAL staging lineage, then
 * drives the REAL runner (scripts/db/migrate.ts) over the REAL release files with the REAL
 * migrations/lineage-exclusions.json declarations. Nothing here re-implements the migration engine
 * and nothing here reads a migration as text to assert on it — every assertion is made against
 * PostgreSQL's own catalogue after the runner has finished.
 *
 * THE LINEAGE BEING CONVERGED
 * ===========================
 * The 2026-08-14 absorb of production v1078 brought production's applied scanner trio into this
 * release at its immutable numbers (0044 MFA / 0046 scanner_processing_jobs / 0047
 * scanner_evidence_staging). Staging's journal holds a DIFFERENT identity at each of those three
 * numbers. Applied history is immutable, so the runner must refuse the colliding files there —
 * and 0090 must deliver the genuinely-missing content instead.
 *
 * WHAT IS DELIBERATELY NOT MOCKED: the runner, the exclusions file, the migration SQL, the journal,
 * or PostgreSQL. The ONLY fixture is the pre-migration lineage state, which is what a staging host
 * actually looked like on 2026-08-14.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrations, listMigrationFiles, loadLineageExclusions } from "../scripts/db/migrate";
import { CERTIFICATES_PROTECTED_COLUMNS_SQL } from "./helpers/certificates-protected-columns";

let cluster: DisposablePostgres17;

/**
 * The three release files whose numbers staging already occupies with a different identity, plus
 * the convergence migration itself. Taken from the REAL migrations directory — real bytes, real
 * checksums, real order — not hand-written fixtures.
 */
const RELEASE_SUBSET = [
  "0044_partner_mfa_pending_lifecycle.sql",
  "0046_scanner_processing_jobs.sql",
  "0047_scanner_evidence_staging.sql",
  "0090_lineage_convergence_scanner.sql",
];

/** Staging's applied identities at 0044/0046/0047 — the immutable occupants. */
const STAGING_OCCUPANTS = [
  "0044_partner_submission_lifecycle_and_location_snapshot.sql",
  "0046_partner_mfa_pending_lifecycle.sql",
  "0047_partner_owner_invariant_tenants_rls.sql",
];

/**
 * Real files, in the order the RUNNER would see them.
 *
 * `applyMigrations` applies the array in the order given — it does not re-sort. `listMigrationFiles`
 * is what establishes numeric order in production, so this helper sorts too. Getting that wrong
 * silently changes which migration runs first and can make an ordering hazard look benign.
 */
function releaseFiles(names: string[] = RELEASE_SUBSET) {
  const all = listMigrationFiles();
  return names
    .map((n) => {
      const f = all.find((x) => x.filename === n);
      if (!f) throw new Error(`release file ${n} is missing from migrations/ — this proof has rotted`);
      return f;
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

/**
 * Build a database shaped like a staging-lineage host immediately BEFORE 0090.
 *
 * Present: certificates (+ the shared protected-column definition), partner_stations, the 0044 MFA
 * pending-lifecycle content (which staging applied under its OWN 0046 filename), and the
 * partner_runtime role 0090 revokes from.
 *
 * Absent, deliberately: every scanner object 0090 exists to deliver. `assertConvergenceAbsent()`
 * below pins that absence so this proof can never quietly become vacuous by seeding the very
 * things it claims the migration creates.
 */
async function buildStagingLineage(dbName: string): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: cluster.url.replace(/\/[^/]*$/, `/${dbName}`), max: 4 });

  await pool.query(`
    CREATE TABLE certificates (
      id serial PRIMARY KEY,
      certificate_number text,
      cert_id text,
      status text,
      deleted_at timestamptz,
      grade_approved_at timestamptz,
      grade_approved_by text,
      grader_status text,
      print_state text,
      updated_at timestamptz DEFAULT now()
    );
  `);
  await pool.query(CERTIFICATES_PROTECTED_COLUMNS_SQL);

  // partner_stations as 0045 defines it, reduced to what 0090's FKs and preconditions need. The
  // tenant/location FKs are irrelevant to scanner convergence and are omitted deliberately rather
  // than stubbed, so this fixture cannot drift into pretending to be the whole partner schema.
  await pool.query(`
    CREATE TABLE partner_stations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      station_code text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'ACTIVE'
    );
  `);

  // The 0044 MFA pending-lifecycle content, present because staging applied the byte-identical
  // body as its own 0046. 0090 VERIFIES this rather than re-running it.
  // Shape and index predicate follow real 0044 (migrations/0044_partner_mfa_pending_lifecycle.sql),
  // so this fixture cannot be misread as an approximation of the MFA table.
  await pool.query(`
    CREATE TABLE partner_mfa_methods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      method text NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE',
      enrolment_session_id uuid,
      expires_at timestamptz,
      consumed_at timestamptz
    );
    CREATE UNIQUE INDEX uq_partner_mfa_one_pending
      ON partner_mfa_methods (user_id, method) WHERE status = 'PENDING';
    CREATE FUNCTION partner_auth_lookup(p_email text)
      RETURNS TABLE (user_id uuid, mfa_required boolean, has_active_mfa boolean)
      LANGUAGE sql AS $fn$ SELECT NULL::uuid, NULL::boolean, NULL::boolean $fn$;
  `);

  // Staging's journal: its own identities at the three contested numbers.
  await pool.query(`
    CREATE TABLE schema_migrations (
      id serial PRIMARY KEY, filename text NOT NULL UNIQUE, checksum text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz DEFAULT now(),
      status text NOT NULL DEFAULT 'applied', applied_by text NOT NULL DEFAULT current_user
    );
  `);
  for (const occupant of STAGING_OCCUPANTS) {
    await pool.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
      occupant,
      `staging-applied-${occupant}`,
    ]);
  }
  return pool;
}

/** Does a relation exist in this database? */
async function hasRelation(pool: pg.Pool, name: string): Promise<boolean> {
  const r = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${name}`]);
  return r.rows[0].present === true;
}

async function hasColumn(pool: pg.Pool, table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rowCount === 1;
}

/** Every object 0090 is responsible for delivering. */
const CONVERGENCE_RELATIONS = [
  "scanner_processing_jobs",
  "certificate_image_evidence",
  "scanner_capture_sessions",
  "scanner_evidence_staging",
  "uq_scanner_processing_active_certificate",
  "uq_scanner_evidence_staging_active_session",
];

async function assertConvergenceAbsent(pool: pg.Pool) {
  for (const rel of CONVERGENCE_RELATIONS) {
    expect(await hasRelation(pool, rel), `${rel} must NOT pre-exist — the proof would be vacuous`).toBe(false);
  }
  expect(await hasColumn(pool, "certificates", "raw_uploaded")).toBe(false);
  expect(await hasColumn(pool, "certificates", "ingest_idempotency_key")).toBe(false);
}

async function assertConverged(pool: pg.Pool) {
  for (const rel of CONVERGENCE_RELATIONS) {
    expect(await hasRelation(pool, rel), `${rel} must exist after 0090`).toBe(true);
  }
  expect(await hasColumn(pool, "certificates", "raw_uploaded")).toBe(true);
  expect(await hasColumn(pool, "certificates", "ingest_idempotency_key")).toBe(true);

  /**
   * STRUCTURE, NOT JUST NAMES.
   *
   * 0090 creates its tables with `CREATE TABLE IF NOT EXISTS`, and its own final verification block
   * only asks `to_regclass(...) IS NULL`. So a host that already had `scanner_capture_sessions` in
   * some other shape — e.g. the legacy application-boot DDL in server/scanner-capture-service.ts,
   * which declares `station_id uuid` with NO foreign key — gets a silent no-op: the table survives
   * without the FK and 0090 still reports success. 0045's compensating block does not help either,
   * because its `ADD COLUMN IF NOT EXISTS station_id` also no-ops when the bare column exists.
   *
   * Asserting the constraint rather than the table name is what makes that failure visible.
   */
  const fks = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'scanner_capture_sessions'::regclass AND contype = 'f'
      ORDER BY conname`
  );
  const names = fks.rows.map((r) => r.conname);
  expect(names, "scanner_capture_sessions must carry BOTH foreign keys, not just the certificate one").toEqual(
    expect.arrayContaining(["scanner_capture_sessions_certificate_id_fkey", "scanner_capture_sessions_station_id_fkey"])
  );
}

/** Drive the REAL runner over a real file set, with a dedicated client as it expects. */
async function runMigrations(
  pool: pg.Pool,
  files: ReturnType<typeof releaseFiles>,
  exclusions = loadLineageExclusions()
): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  try {
    return await applyMigrations(client as never, files, { exclusions });
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  cluster = await startPostgres17("lineage-convergence-0090");
  // Roles are cluster-wide. 0090 REVOKEs from partner_runtime, and its own precondition block
  // fails closed without it.
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_runtime') THEN
      CREATE ROLE partner_runtime NOLOGIN;
    END IF;
  END$$;`);
  await admin.end();
}, 180_000);

afterAll(async () => {
  await cluster?.stop();
});

describe("0090 converges a staging-lineage host through the real runner", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await buildStagingLineage("lineage_0090_staging");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("the pre-0090 staging lineage genuinely lacks every object 0090 delivers", async () => {
    // Guards the whole suite against proving nothing.
    await assertConvergenceAbsent(pool);
    const journal = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
    expect(journal.rows.map((r) => r.filename)).toEqual([...STAGING_OCCUPANTS].sort());
  });

  it("applies ONLY 0090 — the three declared collisions are excluded, not applied, not journalled", async () => {
    const result = await runMigrations(pool, releaseFiles());

    // The runner's own decision, using the REAL declarations file.
    expect(result.applied).toEqual(["0090_lineage_convergence_scanner.sql"]);

    const journal = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
    const names = journal.rows.map((r) => r.filename);
    expect(names).toContain("0090_lineage_convergence_scanner.sql");
    for (const incoming of RELEASE_SUBSET.slice(0, 3)) {
      expect(names, `${incoming} was excluded and must never be journalled`).not.toContain(incoming);
    }
    // History is immutable: the three staging occupants are untouched.
    for (const occupant of STAGING_OCCUPANTS) {
      expect(names).toContain(occupant);
    }
  });

  it("the intended convergence state exists afterwards", async () => {
    await assertConverged(pool);
  });

  it("delivers the convergence SEMANTICS, not merely the object names", async () => {
    // One live candidate per capture session — the invariant scanner_evidence_staging exists for.
    const cert = await pool.query<{ id: number }>(
      "INSERT INTO certificates (certificate_number) VALUES ('MV-TEST-0090') RETURNING id"
    );
    const certId = cert.rows[0].id;
    await pool.query(
      `INSERT INTO scanner_capture_sessions
         (id, certificate_id, side, workstation_id, scanner_profile_version, state, expires_at)
       VALUES ('sess-1', $1, 'front', 'ws-1', 'v1', 'armed', now() + interval '1 hour')`,
      [certId]
    );

    const stage = (key: string) =>
      pool.query(
        `INSERT INTO scanner_evidence_staging
           (capture_session_id, object_key, expected_sha256, expected_bytes, capture_provenance, state, expires_at)
         VALUES ('sess-1', $1, repeat('a',64), 1024, '{}'::jsonb, 'granted', now() + interval '1 hour')`,
        [key]
      );
    await stage("staging/one");
    // uq_scanner_evidence_staging_active_session: a SECOND live candidate for the same session
    // must be refused by the database, not by application code.
    await expect(stage("staging/two")).rejects.toThrow(/duplicate key value|unique/i);

    // certificates.ingest_idempotency_key must be genuinely unique (the atomic replay gate).
    await pool.query("UPDATE certificates SET ingest_idempotency_key = 'idem-1' WHERE id = $1", [certId]);
    const other = await pool.query<{ id: number }>(
      "INSERT INTO certificates (certificate_number) VALUES ('MV-TEST-0090-B') RETURNING id"
    );
    await expect(
      pool.query("UPDATE certificates SET ingest_idempotency_key = 'idem-1' WHERE id = $1", [other.rows[0].id])
    ).rejects.toThrow(/duplicate key value|unique/i);
  });

  it("is safe to rerun: the runner re-applies nothing and the converged state is unchanged", async () => {
    const before = await pool.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename");
    const result = await runMigrations(pool, releaseFiles());
    expect(result.applied, "0090 is already journalled — nothing may re-apply").toEqual([]);
    const after = await pool.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename");
    expect(after.rows).toEqual(before.rows);
    await assertConverged(pool);
  });
});

describe("0090's idempotency is a property of the SQL, not just of the journal", () => {
  it("re-executing the 0090 body against an already-converged database is a no-op", async () => {
    // The journal would normally stop a second run. A convergence migration must ALSO be safe if
    // it is ever replayed directly (the 0073 precedent, and how the scoped `--only` mode works),
    // so execute the real bytes a second time with the journal bypassed entirely.
    const pool = await buildStagingLineage("lineage_0090_rerun");
    try {
      await runMigrations(pool, releaseFiles());
      await assertConverged(pool);

      const sql = releaseFiles(["0090_lineage_convergence_scanner.sql"])[0].sql;
      await expect(pool.query(sql), "the 0090 body must be replay-safe").resolves.toBeDefined();
      await assertConverged(pool);
    } finally {
      await pool.end();
    }
  }, 120_000);
});

describe("the exclusion declarations remain fail-closed", () => {
  it("an UNDECLARED identity conflict still aborts the whole run and leaves the journal intact", async () => {
    const pool = await buildStagingLineage("lineage_0090_undeclared");
    try {
      // Staging also occupies 0045 with its own identity in this scenario. No declaration covers
      // it, so the run must abort — including the otherwise-valid 0090.
      await pool.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2)", [
        "0045_some_other_staging_identity.sql",
        "staging-applied-0045",
      ]);
      const before = await pool.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename");

      await expect(runMigrations(pool, releaseFiles([...RELEASE_SUBSET, "0045_partner_stations.sql"]))).rejects.toThrow(
        /Migration identity conflict/
      );

      const after = await pool.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename");
      expect(after.rows, "a refused run must leave the journal byte-identical").toEqual(before.rows);
      // And it must not have half-converged.
      await assertConvergenceAbsent(pool);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("the REAL declarations are void without their supersededBy migration — the conflicts abort", async () => {
    const pool = await buildStagingLineage("lineage_0090_no_superseder");
    try {
      // Same real declarations, but 0090 is dropped from the release. Every declaration names 0090
      // as its supersededBy, so all three become invalid and the run must fail closed rather than
      // silently skipping content nothing else delivers.
      await expect(runMigrations(pool, releaseFiles(RELEASE_SUBSET.slice(0, 3)))).rejects.toThrow(
        /Migration identity conflict/
      );
      await assertConvergenceAbsent(pool);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("every shipped declaration is anchored to a convergence migration that exists", () => {
    // Pins the real file rather than a fixture: a declaration whose supersededBy was renamed or
    // dropped would silently become void on every host.
    const declarations = loadLineageExclusions();
    expect(declarations.length, "the release ships lineage declarations").toBeGreaterThan(0);
    const present = new Set(listMigrationFiles().map((f) => f.filename));
    for (const d of declarations) {
      expect(present, `${d.incoming}'s supersededBy must ship in the release`).toContain(d.supersededBy);
    }
  });
});

describe("the staging-lineage apply ORDER constraint is pinned, not folklore", () => {
  /**
   * A staging-lineage host that has not yet applied 0075 CANNOT be converged by one unscoped run.
   *
   * 0075_partner_station_single_active_capture indexes `scanner_capture_sessions` with no
   * to_regclass guard (unlike 0045, which guards the same table). The runner sorts numerically, so
   * 0075 executes ~15 files BEFORE 0090 — the migration that actually delivers that table on this
   * lineage — and the run dies at 0075 with `relation "scanner_capture_sessions" does not exist`,
   * never reaching 0090.
   *
   * This is NOT currently live: staging has already applied 0075 (verified 2026-08-14 by read-only
   * dry-run on Machine d8d14d0f34d378 — 54 total, 51 applied, 3 pending, and the 3 pending are
   * exactly the declared exclusions). It is pinned here because it WOULD bite a rebuilt or
   * newly-forked staging-lineage estate, and the mitigation is a deployment-order decision that
   * must not be rediscovered by an outage.
   *
   * The supported route on such a host is the runner's scoped convergence mode — the same 0073
   * precedent: `--only 0090_lineage_convergence_scanner.sql --convergence-mode --apply` first,
   * then a normal run.
   */
  it("an unscoped run that includes 0075 fails at 0075, and 0090 is never reached", async () => {
    const pool = await buildStagingLineage("lineage_0090_order");
    try {
      // 0045 is deliberately NOT in this set: the lineage being modelled has already applied it
      // (that is why partner_stations exists in the fixture). What it has NOT applied is 0075.
      await expect(
        runMigrations(pool, releaseFiles([...RELEASE_SUBSET, "0075_partner_station_single_active_capture.sql"]))
      ).rejects.toThrow(/0075_partner_station_single_active_capture\.sql failed and was rolled back/);

      // 0090 never ran, so the convergence content is absent — the host is left partially migrated.
      const journal = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
      expect(journal.rows.map((r) => r.filename)).not.toContain("0090_lineage_convergence_scanner.sql");
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("the scoped convergence route DOES converge such a host", async () => {
    // Proves the documented mitigation actually works, rather than asserting only the failure.
    const { applyScopedMigration } = await import("../scripts/db/migrate");
    const pool = await buildStagingLineage("lineage_0090_scoped");
    try {
      const client = await pool.connect();
      try {
        const result = await applyScopedMigration(client as never, "0090_lineage_convergence_scanner.sql", {
          files: releaseFiles(["0090_lineage_convergence_scanner.sql"]),
        });
        expect(result.applied).toBe(true);
      } finally {
        client.release();
      }
      await assertConverged(pool);
    } finally {
      await pool.end();
    }
  }, 120_000);
});

describe("0090 fails closed where it is not applicable", () => {
  it("aborts on a database with no core certificates table — the application-scope classification is real", async () => {
    // This is the behavioural counterpart to 0090's APPLICATION-scope entry in
    // tests/helpers/partner-realistic-db.ts. If this ever stopped raising, the classification
    // contract would be describing a property the migration no longer has.
    const admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS lineage_0090_partner_only");
    await admin.query("CREATE DATABASE lineage_0090_partner_only");
    await admin.end();

    const pool = new pg.Pool({
      connectionString: cluster.url.replace(/\/[^/]*$/, "/lineage_0090_partner_only"),
      max: 2,
    });
    try {
      const sql = releaseFiles(["0090_lineage_convergence_scanner.sql"])[0].sql;
      await expect(pool.query(sql)).rejects.toThrow(/0090 precondition failed: certificates table is missing/);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("aborts when the 0044 MFA content it VERIFIES is absent, rather than half-converging", async () => {
    const pool = await buildStagingLineage("lineage_0090_no_mfa");
    try {
      // Model a host that reached 0090 without the MFA pending lifecycle — the exact situation the
      // verification block exists to catch loudly.
      await pool.query("DROP INDEX uq_partner_mfa_one_pending");
      await expect(runMigrations(pool, releaseFiles())).rejects.toThrow(/0090 verification failed/);
      await assertConvergenceAbsent(pool);
    } finally {
      await pool.end();
    }
  }, 120_000);
});
