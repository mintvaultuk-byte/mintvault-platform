import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

vi.mock("../server/db", () => ({ pool: { connect: vi.fn() } }));
import { buildPaidSubmissionAggregateQuery } from "../server/command-centre/core-read-adapter";

let cluster: DisposablePostgres17;
let client: Client;

beforeAll(async () => {
  cluster = await startPostgres17("command-centre-finance-period");
  client = new Client({ connectionString: cluster.url });
  await client.connect();
  await client.query(`CREATE TABLE submissions (
    id text PRIMARY KEY, deleted_at timestamp, payment_status text,
    payment_amount numeric, payment_currency text, payment_timestamp timestamp
  )`);
}, 60_000);

afterAll(async () => {
  await client?.end();
  await cluster?.stop();
}, 60_000);

async function aggregate(period: "today" | "month_to_date", clock: string) {
  return (await client.query(buildPaidSubmissionAggregateQuery(period, `'${clock}'::timestamptz`))).rows[0];
}

describe("Command Centre paid-submission periods in real PostgreSQL", () => {
  it("includes the first BST hour, excludes future/deleted rows, and preserves currency truth", async () => {
    await client.query(`INSERT INTO submissions VALUES
      ('bst-first-hour',NULL,'paid',25,'GBP','2026-06-30 23:30:00'),
      ('future',NULL,'paid',99,'GBP','2026-06-30 23:50:00'),
      ('deleted','2026-07-01','paid',50,'GBP','2026-06-30 23:20:00'),
      ('non-gbp',NULL,'paid',5,'USD','2026-06-30 23:35:00')`);
    const row = await aggregate("today", "2026-07-01 00:45:00+01");
    expect(row).toMatchObject({ count: "2", amount: "30", non_gbp: "1" });
    expect(await aggregate("month_to_date", "2026-07-01 00:45:00+01")).toMatchObject({ count: "2", amount: "30" });
  });

  it("uses the GMT midnight without a one-hour shift", async () => {
    await client.query("TRUNCATE submissions");
    await client.query(`INSERT INTO submissions VALUES
      ('before-gmt',NULL,'paid',10,'GBP','2026-11-30 23:59:59'),
      ('at-gmt',NULL,'paid',20,'GBP','2026-12-01 00:00:00')`);
    expect(await aggregate("today", "2026-12-01 00:30:00+00")).toMatchObject({ count: "1", amount: "20" });
  });
});
