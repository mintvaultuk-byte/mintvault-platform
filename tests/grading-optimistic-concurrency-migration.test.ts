import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const migrationSql = fs.readFileSync(
  path.resolve(import.meta.dirname, "../migrations/0019_grading_optimistic_concurrency.sql"),
  "utf8"
);

describe("0019 grading optimistic concurrency migration", () => {
  let cluster: DisposablePostgres17;
  let client: Client;

  beforeAll(async () => {
    cluster = await startPostgres17("grading-concurrency-migration");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
  }, 60_000);

  beforeEach(async () => {
    await client.query("DROP TABLE IF EXISTS certificates");
    await client.query("CREATE TABLE certificates (id integer PRIMARY KEY)");
    await client.query("INSERT INTO certificates (id) VALUES (1)");
  });

  afterAll(async () => {
    await client?.end();
    await cluster?.stop();
  });

  it("is additive, backfills existing rows, defaults new rows, and is repeat-safe", async () => {
    await client.query(migrationSql);
    await client.query(migrationSql);

    const existing = await client.query<{ grading_version: number }>(
      "SELECT grading_version FROM certificates WHERE id = 1"
    );
    expect(Number(existing.rows[0].grading_version)).toBe(1);

    await client.query("INSERT INTO certificates (id) VALUES (2)");
    const inserted = await client.query<{ grading_version: number }>(
      "SELECT grading_version FROM certificates WHERE id = 2"
    );
    expect(Number(inserted.rows[0].grading_version)).toBe(1);
  });
});
