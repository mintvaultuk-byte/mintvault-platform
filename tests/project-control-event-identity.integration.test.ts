/**
 * Project Control — event identity against a real PostgreSQL database.
 *
 * REMEDIATION of third-hostile-review finding H3-2. The previous idempotency test passed matching
 * timestamps by hand, which proved the unique index existed and hid the fact that genuinely
 * separate events were being merged. This suite drives the REAL service functions
 * (`recordDeployment`, `recordTestRun`) against a REAL disposable PostgreSQL 17 cluster, with
 * REAL concurrent connections. Nothing is mirrored in SQL and nothing is mocked.
 *
 * The cluster is created and destroyed by this file. It never touches staging or production, and
 * it never reads the application's configured database — `MINTVAULT_DATABASE_URL` is pointed at
 * the disposable cluster before the service is imported.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const ROOT = join(__dirname, "..");
const MIGRATION = readFileSync(join(ROOT, "migrations/0030_project_control.sql"), "utf8");

let cluster: DisposablePostgres17;
let admin: Client;
let service: typeof import("../server/project-control/service");
let pool: typeof import("../server/db").pool;

const ACTOR = "founder@example.com";
const SHA = "abc1234def5678901234567890abcdef12345678";

beforeAll(async () => {
  cluster = await startPostgres17("project-control-identity");
  admin = new Client({ connectionString: cluster.url });
  await admin.connect();
  await admin.query(MIGRATION);
  await admin.query(`INSERT INTO pc_nodes (key, name, sort_order) VALUES ('core', 'Core', 1)`);
  await admin.query(`INSERT INTO pc_work_packages (key, node_key, title) VALUES ('wp', 'core', 'WP')`);

  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  service = await import("../server/project-control/service");
  pool = (await import("../server/db")).pool;
}, 120_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await admin?.end().catch(() => {});
  await cluster?.stop();
});

const countDeployments = async () => Number((await admin.query("SELECT COUNT(*)::int c FROM pc_deployments")).rows[0].c);
const countTestRuns = async () => Number((await admin.query("SELECT COUNT(*)::int c FROM pc_test_runs")).rows[0].c);
const countAudit = async (subjectKey: string) =>
  Number(
    (await admin.query("SELECT COUNT(*)::int c FROM pc_status_events WHERE subject_key = $1", [subjectKey])).rows[0].c
  );

const deployment = (over: Record<string, unknown> = {}) => ({
  environment: "production" as const,
  commitSha: SHA,
  result: "succeeded" as const,
  notes: "",
  ...over,
});

describe("H3-2: deployment event identity on real PostgreSQL", () => {
  it("REPRODUCTION CLOSED: two genuine deploys of the same commit create two rows", async () => {
    const before = await countDeployments();
    const first = await service.recordDeployment(deployment({ externalId: "fly-release-100" }), ACTOR);
    const second = await service.recordDeployment(deployment({ externalId: "fly-release-101" }), ACTOR);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(await countDeployments()).toBe(before + 2);
  });

  it("the SAME deployment retried sequentially creates exactly one row and one audit event", async () => {
    const before = await countDeployments();
    const auditBefore = await countAudit(`production:${SHA}`);

    const a = await service.recordDeployment(deployment({ externalId: "fly-release-200" }), ACTOR);
    const b = await service.recordDeployment(deployment({ externalId: "fly-release-200" }), ACTOR);
    const c = await service.recordDeployment(deployment({ externalId: "fly-release-200" }), ACTOR);

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(c.duplicate).toBe(true);
    expect(await countDeployments()).toBe(before + 1);
    // A duplicate must not append a second, untruthful audit row to the append-only ledger.
    expect(await countAudit(`production:${SHA}`)).toBe(auditBefore + 1);
  });

  it("CONCURRENT retries of the same attempt deduplicate to one row", async () => {
    const before = await countDeployments();
    const auditBefore = await countAudit(`production:${SHA}`);

    // Genuinely concurrent: eight in-flight transactions on separate pooled connections.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.recordDeployment(deployment({ externalId: "fly-release-300" }), ACTOR))
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ duplicate: boolean }>[];

    // Every call must succeed, and exactly one may claim to have created the row.
    expect(fulfilled).toHaveLength(8);
    expect(fulfilled.filter((r) => !r.value.duplicate)).toHaveLength(1);
    expect(await countDeployments()).toBe(before + 1);
    expect(await countAudit(`production:${SHA}`)).toBe(auditBefore + 1);
  });

  it("rollback and the redeploy that follows it are recorded separately", async () => {
    const before = await countDeployments();
    await service.recordDeployment(
      deployment({ externalId: "fly-release-400", result: "rolled_back", rollbackOfSha: SHA }),
      ACTOR
    );
    await service.recordDeployment(deployment({ externalId: "fly-release-401" }), ACTOR);
    expect(await countDeployments()).toBe(before + 2);
  });

  it("an explicit idempotencyKey deduplicates even across differing external ids", async () => {
    const before = await countDeployments();
    const a = await service.recordDeployment(
      deployment({ externalId: "fly-release-500", idempotencyKey: "submit-abc-0001" }),
      ACTOR
    );
    const b = await service.recordDeployment(
      deployment({ externalId: "fly-release-501", idempotencyKey: "submit-abc-0001" }),
      ACTOR
    );
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(await countDeployments()).toBe(before + 1);
  });

  it("a deployment with no attempt identity is REJECTED, not merged", async () => {
    const before = await countDeployments();
    await expect(service.recordDeployment(deployment(), ACTOR)).rejects.toThrow(/attempt identity/i);
    expect(await countDeployments()).toBe(before);
  });

  it("blank and oversized attempt identities are rejected", async () => {
    const before = await countDeployments();
    await expect(service.recordDeployment(deployment({ externalId: "   " }), ACTOR)).rejects.toThrow(/attempt identity/i);
    await expect(service.recordDeployment(deployment({ externalId: "a".repeat(201) }), ACTOR)).rejects.toThrow();
    await expect(service.recordDeployment(deployment({ idempotencyKey: "short" }), ACTOR)).rejects.toThrow();
    expect(await countDeployments()).toBe(before);
  });

  it("the stored idempotency key never contains a timestamp", async () => {
    const { rows } = await admin.query("SELECT idempotency_key FROM pc_deployments LIMIT 50");
    for (const row of rows) {
      expect(row.idempotency_key).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe("H3-2: test-run event identity on real PostgreSQL", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    packageKey: "wp",
    kind: "vitest" as const,
    result: "passed",
    commitSha: SHA,
    detail: "",
    ...over,
  });

  it("the same CI run retried creates one row", async () => {
    const before = await countTestRuns();
    const a = await service.recordTestRun(run({ externalRunId: "ci-1000" }), ACTOR);
    const b = await service.recordTestRun(run({ externalRunId: "ci-1000" }), ACTOR);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(await countTestRuns()).toBe(before + 1);
  });

  it("REPRODUCTION CLOSED: a second CI run of the same suite and commit creates a second row", async () => {
    const before = await countTestRuns();
    await service.recordTestRun(run({ externalRunId: "ci-2000" }), ACTOR);
    await service.recordTestRun(run({ externalRunId: "ci-2001" }), ACTOR);
    expect(await countTestRuns()).toBe(before + 2);
  });

  it("CONCURRENT retries of the same run deduplicate to one row", async () => {
    const before = await countTestRuns();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.recordTestRun(run({ externalRunId: "ci-3000" }), ACTOR))
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ duplicate: boolean }>[];
    expect(fulfilled).toHaveLength(8);
    expect(fulfilled.filter((r) => !r.value.duplicate)).toHaveLength(1);
    expect(await countTestRuns()).toBe(before + 1);
  });

  it("a test run with no attempt identity is REJECTED", async () => {
    const before = await countTestRuns();
    await expect(service.recordTestRun(run(), ACTOR)).rejects.toThrow(/attempt identity/i);
    expect(await countTestRuns()).toBe(before);
  });

  it("deployment and test-run keys never collide on identical facts", async () => {
    const d = await service.recordDeployment(deployment({ externalId: "shared-id-1" }), ACTOR);
    const t = await service.recordTestRun(run({ externalRunId: "shared-id-1" }), ACTOR);
    expect(d.idempotencyKey).not.toBe(t.idempotencyKey);
  });
});
