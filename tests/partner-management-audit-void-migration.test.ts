/**
 * Forward-only database proof for 0094.
 *
 * This suite starts an isolated PostgreSQL 17.10 cluster and applies the real SQL exactly as the
 * migration runner does (inside one transaction). It never reads any configured application
 * database or an environment URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const ROOT = process.cwd();
const PRIOR_MIGRATION = join(ROOT, "migrations", "0084_partner_location_management.sql");
const MIGRATION = join(ROOT, "migrations", "0094_partner_management_audit_card_job_void.sql");
const NEW_ACTION = "partner_card_job_voided";
const UNKNOWN_ACTION = "partner_card_job_totally_invalid_test_event";

function permittedActions(sql: string): string[] {
  const fromConstraint = sql.slice(sql.lastIndexOf("ADD CONSTRAINT chk_partner_management_audit_action"));
  return (fromConstraint.slice(0, fromConstraint.indexOf("));")).match(/'([a-z_]+)'/g) ?? []).map((value) =>
    value.slice(1, -1)
  );
}

const priorActions = permittedActions(readFileSync(PRIOR_MIGRATION, "utf8"));
const migrationSql = readFileSync(MIGRATION, "utf8");

let cluster: DisposablePostgres17;
let admin: Client;

describe("0094 Partner Card Job void audit vocabulary", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-management-audit-void-migration");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();

    // Reconstruct the live 0084 contract minimally, then seed every prior valid value. The test
    // proves the forward migration preserves both the rows and the entire existing vocabulary.
    const literals = priorActions.map((action) => `'${action}'`).join(",");
    await admin.query(`
      CREATE TABLE partner_management_audit (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        action_type text NOT NULL,
        CONSTRAINT chk_partner_management_audit_action CHECK (action_type IN (${literals}))
      )
    `);
    for (const action of priorActions) {
      await admin.query("INSERT INTO partner_management_audit (action_type) VALUES ($1)", [action]);
    }

    await admin.query("BEGIN");
    try {
      await admin.query(migrationSql);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("is forward-only and preserves every existing audit value and row", async () => {
    expect(migrationSql).not.toMatch(/\b(?:DELETE|UPDATE|TRUNCATE)\b/i);
    expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);
    const preserved = await admin.query<{ action_type: string }>(
      "SELECT action_type FROM partner_management_audit ORDER BY action_type"
    );
    expect(preserved.rows.map((row) => row.action_type)).toEqual([...priorActions].sort());

    for (const action of priorActions) {
      await expect(
        admin.query("INSERT INTO partner_management_audit (action_type) VALUES ($1)", [action])
      ).resolves.toBeDefined();
    }
  });

  it("accepts the exact Card Job void action", async () => {
    await expect(
      admin.query("INSERT INTO partner_management_audit (action_type) VALUES ($1)", [NEW_ACTION])
    ).resolves.toBeDefined();
    const constraint = await admin.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='partner_management_audit'::regclass AND conname='chk_partner_management_audit_action'"
    );
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain(NEW_ACTION);
  });

  it("continues to reject an unrecognised audit action", async () => {
    await expect(
      admin.query("INSERT INTO partner_management_audit (action_type) VALUES ($1)", [UNKNOWN_ACTION])
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_partner_management_audit_action",
    });
  });
});
