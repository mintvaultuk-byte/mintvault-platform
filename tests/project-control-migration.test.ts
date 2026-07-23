import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const FILENAME = "0020_project_control_dashboard.sql";

let cluster: DisposablePostgres17;
let client: Client;

function migration() {
  const found = listMigrationFiles().find((candidate) => candidate.filename === FILENAME);
  if (!found) throw new Error(`${FILENAME} was not discovered`);
  return found;
}

describe("0020 Project Control governance migration", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("project-control-migration");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    await cluster?.stop();
  });

  it("applies cleanly and prevents update, delete, and truncate after append-only inserts", async () => {
    const { applied } = await applyMigrations(client, [migration()]);
    expect(applied).toEqual([FILENAME]);

    await client.query(`
      INSERT INTO project_control_evidence (
        evidence_id, requirement_id, evidence_classification, source_kind, summary
      ) VALUES ('pcd-evidence-1', 'MEGS-PCD-009', 'Proven from database', 'database', 'disposable test evidence')
    `);
    await client.query(`
      INSERT INTO project_control_status_history (requirement_id, lifecycle_state, reason)
      VALUES ('MEGS-PCD-009', 'implemented', 'disposable test status')
    `);
    await client.query(`
      INSERT INTO project_control_prompt_snapshots (snapshot_id, prompt_text)
      VALUES ('pcd-snapshot-1', 'disposable test prompt')
    `);

    for (const table of ["project_control_evidence", "project_control_status_history", "project_control_prompt_snapshots"]) {
      await expect(client.query(`UPDATE ${table} SET created_at = created_at`)).rejects.toThrow(/append-only/);
      await expect(client.query(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
      await expect(client.query(`TRUNCATE ${table}`)).rejects.toThrow(/append-only/);
    }
  });
});
