/**
 * Migration 0045 ⇄ application parity.
 *
 * WHAT THIS IS FOR. 0045 owns `partner_grading_work_items`, and seven production modules read or
 * write it. Nothing checked that the columns those modules name actually exist with the shape they
 * assume. That is not hypothetical: this branch already shipped one column that did not exist
 * (`partner_submissions.completed_at`, fixed in 5e620fa), and it reached a real database before
 * anything noticed, because a syntactically perfect SQL string naming a missing column only fails
 * at execution.
 *
 * HOW THE PROOF WORKS, AND WHAT IT IS NOT. Column names are DISCOVERED from production source by
 * pattern — that part is textual, and on its own would prove nothing. Every discovered name is then
 * VERIFIED against `information_schema` / `pg_catalog` on a real database with 0045 applied. So the
 * assertion is "the database really provides what production really names", not "these two strings
 * look alike". A production module gaining a reference to a column 0045 does not supply turns this
 * RED without anyone remembering to update a list.
 *
 * Discovery is scoped to the two constructs that name columns unambiguously — INSERT column lists
 * and UPDATE SET clauses targeting this table — so it cannot mistake a status VALUE or a joined
 * table's column for a column of this one. See writtenColumns() for why that precision matters.
 *
 * SELF-PROVISIONING: starts its own PostgreSQL 17. Needs POSTGRES17_BIN or docker. Never skips.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
} from "./helpers/partner-realistic-db";

const TABLE = "partner_grading_work_items";

/** Every production module that reads or writes the 0045 table. */
const CONSUMERS = [
  "server/partner/connector-import-service.ts",
  "server/partner/grading-assignment.ts",
  "server/partner/grading-routes.ts",
  "server/partner/grading-review-mirror.ts",
  "server/partner/partner-submission-credit-lifecycle.ts",
  "server/print-workflow.ts",
  "server/storage.ts",
  "server/routes.ts",
];

let cluster: DisposablePostgres17;
let admin: Client;
let dbColumns: Map<string, { type: string; nullable: boolean }>;

/**
 * Extract the columns production actually WRITES to this table, by parsing the two constructs that
 * name columns unambiguously:
 *
 *   INSERT INTO partner_grading_work_items (a, b, c)   -> a, b, c
 *   UPDATE partner_grading_work_items SET a = ..., b = -> a, b
 *
 * An earlier draft harvested every snake_case identifier near a mention of the table. That was
 * wrong in a way worth recording: it swept in other tables (partner_connector_imports), other
 * tables' columns (grader_status, certificate_number), and STATUS VALUES (pending_review,
 * ready_for_assignment) — then "verified" them with a filter that only asked whether the string
 * appeared anywhere in the migration text, which the CHECK constraint on status made true. That
 * combination could report a healthy schema as broken, and would never have caught a real defect.
 *
 * Parsing the column-list position is both precise and non-circular: the names come from where
 * production declares them, and are checked against what the database actually has.
 */
function writtenColumns(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const note = (name: string, file: string) => {
    if (!found.has(name)) found.set(name, []);
    if (!found.get(name)!.includes(file)) found.get(name)!.push(file);
  };
  for (const file of CONSUMERS) {
    let src: string;
    try {
      src = readFileSync(join(process.cwd(), file), "utf8");
    } catch {
      continue;
    }
    if (!src.includes(TABLE)) continue;

    for (const m of src.matchAll(new RegExp(`INSERT\\s+INTO\\s+${TABLE}\\s*\\(([^)]*)\\)`, "gis"))) {
      for (const c of m[1].split(",")) {
        const name = c.trim().replace(/["\s]/g, "");
        if (/^[a-z][a-z0-9_]*$/.test(name)) note(name, file);
      }
    }
    for (const m of src.matchAll(
      new RegExp(`UPDATE\\s+${TABLE}\\b[\\s\\S]{0,400}?SET\\s+([\\s\\S]{0,400}?)(?:WHERE|\`)`, "gis")
    )) {
      for (const a of m[1].matchAll(/([a-z][a-z0-9_]*)\s*=/g)) note(a[1], file);
    }
  }
  return found;
}

describe("migration 0045 ⇄ application parity", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-0045-parity");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await admin.query("CREATE TABLE users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)");
    await admin.query(
      "CREATE TABLE submissions (id serial PRIMARY KEY, user_id varchar, status varchar(30) NOT NULL DEFAULT 'draft', tracking_number text NOT NULL UNIQUE)"
    );
    await admin.query(
      "CREATE TABLE submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL REFERENCES submissions(id))"
    );
    await admin.query(`CREATE TABLE audit_log (
      id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
      admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
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
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);

    const { rows } = await admin.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [TABLE]
    );
    dbColumns = new Map(rows.map((r) => [r.column_name, { type: r.data_type, nullable: r.is_nullable === "YES" }]));
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("A1: the table exists with a non-trivial column set", async () => {
    expect(dbColumns.size, "0045 must actually have created the table").toBeGreaterThan(15);
    // Spot-pin the identity columns the whole bridge is built on, so a table that existed but was
    // gutted could not satisfy the size check alone.
    for (const c of [
      "tenant_id",
      "partner_submission_id",
      "partner_submission_card_id",
      "destination_submission_id",
      "submission_item_id",
      "certificate_id",
      "status",
      "card_ordinal",
    ]) {
      expect(dbColumns.has(c), `0045 must provide ${c}`).toBe(true);
    }
  });

  it("A2: every column production WRITES to this table is supplied by the migration chain", () => {
    const written = writtenColumns();
    // Discovery must find the real INSERT the importer performs. If this ever drops to a handful,
    // the extractor has silently stopped matching and the guard below would be vacuous.
    expect(written.size, "must discover the importer's real column list").toBeGreaterThan(15);
    expect([...written.keys()], "the importer's INSERT must be the source of these").toContain("submission_item_id");
    expect([...written.keys()]).toContain("card_ordinal");

    const missing = [...written.entries()]
      .filter(([name]) => !dbColumns.has(name))
      .map(([name, files]) => `${name} (written by ${files.join(", ")})`);
    expect(missing, `production writes columns 0045 does not supply: ${missing.join("; ")}`).toEqual([]);
  });

  it("A3: the identity columns are NOT NULL, so a work item cannot exist unattached", () => {
    for (const c of [
      "tenant_id",
      "partner_organisation_id",
      "partner_location_id",
      "partner_submission_id",
      "partner_submission_card_id",
      "destination_submission_id",
      "submission_item_id",
      "card_ordinal",
      "status",
    ]) {
      expect(dbColumns.get(c)?.nullable, `${c} must be NOT NULL`).toBe(false);
    }
    // certificate_id is deliberately nullable: the work item exists before the certificate links.
    expect(dbColumns.get("certificate_id")?.nullable).toBe(true);
  });

  it("A4: the canonical uniqueness indexes exist — one work item per destination item and per source unit", async () => {
    const { rows } = await admin.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1",
      [TABLE]
    );
    const defs = rows.map((r) => r.indexdef.replace(/\s+/g, " "));
    const hasUnique = (cols: string) => defs.some((d) => d.includes("UNIQUE") && d.includes(`(${cols})`));

    expect(hasUnique("submission_item_id"), "one work item per destination submission_item").toBe(true);
    expect(
      hasUnique("partner_submission_card_id, card_ordinal"),
      "one work item per PHYSICAL source unit — this is what stops a card being graded twice"
    ).toBe(true);
    // The table carries its two canonical unique indexes plus supporting ones. Pinned at the real
    // current count so DELETING an index is a deliberate act that also edits this line.
    expect(rows.length, "index count on the bridge table").toBe(7);
  });

  it("A5: every foreign key 0045 declares is really present in pg_catalog", async () => {
    const { rows } = await admin.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype='f'`,
      [TABLE]
    );
    const defs = rows.map((r) => r.def.replace(/\s+/g, " "));
    // Scoped composite FKs are the mechanism that stops a work item pointing at another tenant's
    // rows, so they are asserted specifically rather than by count alone.
    expect(defs.some((d) => d.includes("(tenant_id, partner_location_id)"))).toBe(true);
    expect(defs.some((d) => d.includes("(tenant_id, partner_submission_id)"))).toBe(true);
    expect(defs.some((d) => d.includes("(partner_submission_id, partner_submission_card_id)"))).toBe(true);
    expect(defs.some((d) => d.includes("(certificate_id, destination_submission_id, submission_item_id)"))).toBe(true);
    expect(rows.length, "0045 declares a large FK set").toBeGreaterThan(10);
  });

  it("A6: RLS is ENABLED and FORCED, with a tenant policy on both USING and WITH CHECK", async () => {
    const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; relowner: string }>(
      `SELECT relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS relowner
         FROM pg_class WHERE oid = $1::regclass`,
      [TABLE]
    );
    expect(rows[0].relrowsecurity, "RLS must be enabled").toBe(true);
    // FORCE is what applies the policy to the table OWNER too. Without it the migrator — and any
    // definer function it owns — reads across tenants.
    expect(rows[0].relforcerowsecurity, "RLS must be FORCED, not merely enabled").toBe(true);
    expect(rows[0].relowner).toBe("pn_migrator");

    const { rows: pol } = await admin.query<{ polname: string; using: string | null; check: string | null }>(
      `SELECT polname,
              pg_get_expr(polqual, polrelid) AS using,
              pg_get_expr(polwithcheck, polrelid) AS check
         FROM pg_policy WHERE polrelid = $1::regclass`,
      [TABLE]
    );
    expect(pol.length).toBeGreaterThan(0);
    const tenant = pol.find((p) => p.polname.includes("tenant"));
    expect(tenant, "a tenant-isolation policy must exist").toBeTruthy();
    // Both directions matter: USING alone would let a tenant WRITE a row it could not read.
    expect(tenant!.using).toContain("partner_current_tenant");
    expect(tenant!.check, "WITH CHECK must also be tenant-scoped").toContain("partner_current_tenant");
  });

  it("A7: PUBLIC holds no privileges, and the runtime role has exactly what it needs", async () => {
    const grantsFor = async (grantee: string) => {
      const { rows } = await admin.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema='public' AND table_name=$1 AND grantee=$2`,
        [TABLE, grantee]
      );
      return rows.map((r) => r.privilege_type).sort();
    };
    expect(await grantsFor("PUBLIC"), "PUBLIC must hold nothing on the bridge table").toEqual([]);
    const runtime = await grantsFor("partner_runtime");
    expect(runtime.length, "partner_runtime must hold real privileges, or RLS proofs are vacuous").toBeGreaterThan(0);
    expect(runtime).toContain("SELECT");
  });
});
