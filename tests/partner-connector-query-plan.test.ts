/**
 * Trusted Intake Connector — Phase G3F FINAL: query-plan / index verification (real Postgres,
 * realistically-sized dataset). Proves the connector hot-path queries use their intended indexes and
 * do NOT fall back to a sequential scan of the large connector/import tables. See PERFORMANCE-RESULTS.md
 * for the recorded plans (this test is the executable, repeatable form of that evidence).
 *
 * Runs ONLY when PARTNER_CONNECTOR_PLAN_ADMIN is set (superuser URL to a DISPOSABLE local Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";

const ADMIN = process.env.PARTNER_CONNECTOR_PLAN_ADMIN;
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN);

let admin: Client;
const ORG = "aaaaaaaa-9000-0000-0000-000000000001";
const LOC = "10000000-9000-0000-0000-0000000000c1";
const USER = "11111111-9000-0000-0000-0000000000a1";

async function explain(sql: string, params: unknown[] = []): Promise<string> {
  const res = await admin.query(`EXPLAIN (COSTS OFF) ${sql}`, params);
  return res.rows.map((r) => r["QUERY PLAN"]).join("\n");
}

(isLocal ? describe : describe.skip)("Trusted Intake Connector G3F FINAL — query-plan / index verification", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    // MintVault fixtures so migration 0010's grants apply.
    await admin.query(
      "CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar NOT NULL, tracking_number text UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)"
    );
    await provisionRealisticRoles(admin);
    for (const t of ["users", "submissions", "submission_items"])
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
    await migrator.connect();
    try {
      await applyMigrations(migrator, listMigrationFiles());
    } finally {
      await migrator.end();
    }

    // ---- Bulk-seed a realistically-sized, realistically-distributed dataset ----
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'plan','plan','ACTIVE')",
      [ORG]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'plan-loc',$2,$2,'HQ','ACTIVE')",
      [LOC, ORG]
    );
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES ($1,'plan-user',$2,$2,'plan@e.com','x','ACTIVE',false)",
      [USER, ORG]
    );
    await admin.query(
      "INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES ($1,'standard','Standard',1500,10,true)",
      [ORG]
    );

    await admin.query(
      `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, status)
       SELECT ('90000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, $1, $2, $3, 'submitted_to_mintvault' FROM generate_series(1,2000) g`,
      [ORG, LOC, USER]
    );
    await admin.query(
      `INSERT INTO partner_submission_handoffs (id, tenant_id, submission_id, status, snapshot)
       SELECT ('91000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, $1, ('90000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, 'pending', '{}'::jsonb FROM generate_series(1,2000) g`,
      [ORG]
    );
    // 95% terminal 'imported', ~5% claimable — realistic steady state.
    await admin.query(
      `INSERT INTO partner_connector_records (id, tenant_id, partner_submission_id, handoff_id, state, claim_expires_at)
       SELECT ('92000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, $1,
              ('90000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
              ('91000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
              CASE WHEN g % 20 = 0 THEN 'ready_for_import' WHEN g % 40 = 1 THEN 'queued' ELSE 'imported' END,
              CASE WHEN g % 20 = 0 THEN now()-interval '1 hour' ELSE now()+interval '1 hour' END
       FROM generate_series(1,2000) g`,
      [ORG]
    );
    // validation runs (one completed per record) for the latest-run lookup
    await admin.query(
      `INSERT INTO partner_connector_validation_runs (connector_record_id, validation_attempt, source_submission_version, source_handoff_status, outcome, blocking_error_count, warning_count, completed_at, source_fingerprint, source_fingerprint_version)
       SELECT ('92000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, 1, 1, 'pending', 'valid', 0, 0, now(), 'fp'||g, 1 FROM generate_series(1,2000) g`
    );
    // customers (FK target for the links) + links + attempts for the imported subset
    await admin.query(
      `INSERT INTO partner_customers (id, tenant_id, full_name, email)
       SELECT ('93000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, $1, 'Cust '||g, 'c'||g||'@e.com' FROM generate_series(1,2000) g`,
      [ORG]
    );
    await admin.query(
      `INSERT INTO partner_connector_customer_links (partner_organisation_id, partner_customer_id, mintvault_user_id, email_snapshot)
       SELECT $1, ('93000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, 'user-'||g, 'c'||g||'@e.com' FROM generate_series(1,2000) g`,
      [ORG]
    );
    await admin.query(
      `INSERT INTO submissions (id, user_id, tracking_number) SELECT g, 'u', 'MV-SUB-'||lpad(g::text,6,'0') FROM generate_series(1,2000) g`
    );
    // one completed import per 'imported' record, deterministically keyed by g (no window function).
    await admin.query(
      `INSERT INTO partner_connector_imports
         (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
          validation_run_id, source_fingerprint, source_fingerprint_version, state, destination_submission_id)
       SELECT r.id, $1, $2, r.partner_submission_id, r.handoff_id, v.id, 'fp', 1, 'completed', g
         FROM generate_series(1,2000) g
         JOIN partner_connector_records r ON r.id = ('92000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid AND r.state = 'imported'
         JOIN partner_connector_validation_runs v ON v.connector_record_id = r.id`,
      [ORG, LOC]
    );
    await admin.query(
      `INSERT INTO partner_connector_import_attempts
         (connector_record_id, import_mapping_id, partner_organisation_id, partner_submission_id, partner_handoff_id,
          validation_run_id, source_fingerprint, source_fingerprint_version, attempt_number, attempt_type, outcome, destination_submission_id, started_at, completed_at)
       SELECT m.connector_record_id, m.id, $1, m.partner_submission_id, m.partner_handoff_id, m.validation_run_id, 'fp', 1, 1, 'initial', 'completed', m.destination_submission_id, now(), now()
         FROM partner_connector_imports m`,
      [ORG]
    );
    await admin.query("ANALYZE partner_connector_records");
    await admin.query("ANALYZE partner_connector_imports");
    await admin.query("ANALYZE partner_connector_validation_runs");
    await admin.query("ANALYZE partner_connector_customer_links");
    await admin.query("ANALYZE partner_connector_import_attempts");
  }, 120_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
  });

  it("claim-next does NOT sequentially scan the whole records table (uses the corrected claimable index)", async () => {
    const plan = await explain(
      `SELECT * FROM partner_connector_records
        WHERE state = 'queued' OR (state IN ('claimed','validating','ready_for_import') AND claim_expires_at < now())
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    expect(plan).not.toMatch(/Seq Scan on partner_connector_records/);
    expect(plan).toMatch(/idx_partner_connector_records_claimable/);
  });

  it("import mapping by connector uses its unique index", async () => {
    const plan = await explain("SELECT * FROM partner_connector_imports WHERE connector_record_id = $1", [
      "92000000-0000-0000-0000-000000000002",
    ]);
    expect(plan).not.toMatch(/Seq Scan on partner_connector_imports/);
    expect(plan).toMatch(/Index/);
  });

  it("import mapping by handoff and by destination use their unique indexes", async () => {
    const byHandoff = await explain("SELECT * FROM partner_connector_imports WHERE partner_handoff_id = $1", [
      "91000000-0000-0000-0000-000000000002",
    ]);
    expect(byHandoff).not.toMatch(/Seq Scan on partner_connector_imports/);
    const byDest = await explain("SELECT * FROM partner_connector_imports WHERE destination_submission_id = $1", [1]);
    expect(byDest).not.toMatch(/Seq Scan on partner_connector_imports/);
  });

  it("latest validation-run lookup uses the (connector_record_id, created_at) index", async () => {
    const plan = await explain(
      `SELECT id FROM partner_connector_validation_runs WHERE connector_record_id = $1 AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      ["92000000-0000-0000-0000-000000000002"]
    );
    expect(plan).not.toMatch(/Seq Scan on partner_connector_validation_runs/);
    expect(plan).toMatch(/idx_partner_connector_validation_runs_record|Index/);
  });

  it("customer-link resolution uses the (org, customer) unique index", async () => {
    const plan = await explain(
      "SELECT mintvault_user_id FROM partner_connector_customer_links WHERE partner_organisation_id = $1 AND partner_customer_id = $2",
      [ORG, "00000000-0000-0000-0000-000000000000"]
    );
    expect(plan).not.toMatch(/Seq Scan on partner_connector_customer_links/);
    expect(plan).toMatch(/Index/);
  });

  it("provenance attempt history + completed lookup use their indexes", async () => {
    const history = await explain(
      "SELECT * FROM partner_connector_import_attempts WHERE connector_record_id = $1 ORDER BY attempt_number ASC",
      ["92000000-0000-0000-0000-000000000002"]
    );
    expect(history).not.toMatch(/Seq Scan on partner_connector_import_attempts/);
    const completed = await explain(
      "SELECT count(*) FROM partner_connector_import_attempts WHERE connector_record_id = $1 AND outcome = 'completed'",
      ["92000000-0000-0000-0000-000000000002"]
    );
    expect(completed).not.toMatch(/Seq Scan on partner_connector_import_attempts/);
  });

  it("partner_connector_import_attempts has EXACTLY the two evidence-backed indexes — no speculative index remains", async () => {
    const { rows } = await admin.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'partner_connector_import_attempts' ORDER BY indexname"
    );
    const names = rows.map((r) => r.indexname);
    // pkey + the connector history index + the completed partial unique. NOTHING else.
    expect(names).toEqual([
      "idx_partner_connector_import_attempts_connector",
      "partner_connector_import_attempts_pkey",
      "uq_partner_connector_import_attempts_completed",
    ]);
    // the three removed speculative indexes are absent
    for (const removed of [
      "idx_partner_connector_import_attempts_mapping",
      "idx_partner_connector_import_attempts_run",
      "idx_partner_connector_import_attempts_destination",
    ]) {
      expect(names).not.toContain(removed);
    }
  });
});
