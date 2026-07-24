/**
 * print-workflow-migration.test.ts — DB-backed. Provisions a disposable
 * PostgreSQL 17 cluster, applies the numbered migration 0022 through the REAL
 * runner, and proves: clean apply, schema shape, historical backfill, approval
 * SQL integration (the CASE promotion + non-regression), destructive-SQL lint,
 * and idempotent re-apply. No staging/prod touched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { applyMigrations, listMigrationFiles, planMigrations } from "../scripts/db/migrate";
import { lintSql, hasBlocking } from "../scripts/db/lint-destructive-sql";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const { Client } = pg;

function migration0022() {
  const f = listMigrationFiles().find((m) => m.filename.includes("0022_print_workflow_lifecycle"));
  if (!f) throw new Error("0022 migration file not found");
  return f;
}

// Minimal pre-existing schema the migration depends on (ALTER certificates;
// backfill reads label_prints). Created before 0022 is applied.
const BASE_DDL = `
  CREATE TABLE certificates (
    id serial PRIMARY KEY,
    certificate_number text UNIQUE NOT NULL,
    grade_approved_at timestamptz,
    grade_approved_by text,
    deleted_at timestamptz,
    status varchar(10) NOT NULL DEFAULT 'active',
    ownership_status varchar(20) NOT NULL DEFAULT 'unclaimed',
    updated_at timestamptz DEFAULT now(),
    issued_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE label_prints (
    id serial PRIMARY KEY, cert_id text UNIQUE NOT NULL, sheet_ref text,
    queued_at timestamptz DEFAULT now(), printed_at timestamptz
  );
  CREATE TABLE reprint_log ( id serial PRIMARY KEY, cert_id text NOT NULL, reprint_time timestamptz DEFAULT now() );
  CREATE TABLE audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
  );
`;

describe("0022 print-workflow migration (DB-backed)", () => {
  let cluster: DisposablePostgres17;
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    cluster = await startPostgres17("print-workflow-migration");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
    await client.query(BASE_DDL);
    // Seed rows that exercise the backfill, BEFORE the migration runs.
    await client.query(`
      INSERT INTO certificates (certificate_number, grade_approved_at, status) VALUES
        ('MV-A-APPROVED-PRINTED', now(), 'active'),
        ('MV-B-APPROVED-UNPRINTED', now(), 'active'),
        ('MV-C-UNAPPROVED', NULL, 'active'),
        ('MV-D-VOIDED', now(), 'voided');
      INSERT INTO label_prints (cert_id, printed_at) VALUES ('MV-A-APPROVED-PRINTED', now());
    `);
    // Apply 0022 through the real runner.
    await applyMigrations(client, [migration0022()]);
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    await cluster?.stop();
  });

  it("adds print_state to certificates with the correct default", async () => {
    const col = await client.query(`
      SELECT data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name='certificates' AND column_name='print_state'
    `);
    expect(col.rows.length).toBe(1);
    expect(col.rows[0].is_nullable).toBe("NO");
    expect(String(col.rows[0].column_default)).toContain("awaiting_approval");
  });

  it("creates print_batches and print_events tables", async () => {
    const t = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('print_batches','print_events') ORDER BY table_name
    `);
    expect(t.rows.map((r: { table_name: string }) => r.table_name)).toEqual(["print_batches", "print_events"]);
    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name='print_batches'
    `);
    const names = cols.rows.map((r: { column_name: string }) => r.column_name);
    for (const c of ["batch_id", "kind", "status", "cert_ids", "created_by_role", "reason_category"]) {
      expect(names).toContain(c);
    }
  });

  it("creates the expected indexes", async () => {
    const idx = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('certificates','print_batches','print_events')`);
    const names = idx.rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain("idx_certificates_print_state");
    expect(names).toContain("idx_print_batches_status");
    expect(names).toContain("idx_print_events_cert");
  });

  it("backfills historical print_state correctly", async () => {
    const q = await client.query(`SELECT certificate_number, print_state FROM certificates ORDER BY certificate_number`);
    const byId = Object.fromEntries(q.rows.map((r: { certificate_number: string; print_state: string }) => [r.certificate_number, r.print_state]));
    expect(byId["MV-A-APPROVED-PRINTED"]).toBe("printed");
    expect(byId["MV-B-APPROVED-UNPRINTED"]).toBe("needs_printing");
    expect(byId["MV-C-UNAPPROVED"]).toBe("awaiting_approval");
    expect(byId["MV-D-VOIDED"]).toBe("awaiting_approval"); // voided never becomes printable
  });

  it("approval SQL promotes awaiting_approval → needs_printing (the integration CASE)", async () => {
    await client.query(`INSERT INTO certificates (certificate_number, status) VALUES ('MV-E-FRESH', 'active')`);
    // Replicates the exact clause added to every approval UPDATE.
    await client.query(`
      UPDATE certificates
      SET grade_approved_at = now(), status='active',
          print_state = CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing' ELSE print_state END
      WHERE certificate_number = 'MV-E-FRESH'
    `);
    const r = await client.query(`SELECT print_state FROM certificates WHERE certificate_number='MV-E-FRESH'`);
    expect(r.rows[0].print_state).toBe("needs_printing");
  });

  it("approval SQL never regresses an in-flight print state", async () => {
    await client.query(`INSERT INTO certificates (certificate_number, status, print_state, grade_approved_at) VALUES ('MV-F-PRINTED', 'active', 'printed', now())`);
    await client.query(`
      UPDATE certificates
      SET print_state = CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing' ELSE print_state END
      WHERE certificate_number = 'MV-F-PRINTED'
    `);
    const r = await client.query(`SELECT print_state FROM certificates WHERE certificate_number='MV-F-PRINTED'`);
    expect(r.rows[0].print_state).toBe("printed");
  });

  it("is journalled and idempotent on re-apply", async () => {
    const journal = await client.query(`SELECT filename, status FROM schema_migrations WHERE filename LIKE '%0022%'`);
    expect(journal.rows.length).toBe(1);
    expect(journal.rows[0].status).toBe("applied");
    // Planning again shows nothing pending.
    const plan = await planMigrations(client, [migration0022()]);
    expect(plan.pending.length).toBe(0);
  });

  it("passes the destructive-SQL linter (additive-only)", () => {
    const findings = lintSql(migration0022().sql ?? "");
    expect(hasBlocking(findings)).toBe(false);
  });
});
