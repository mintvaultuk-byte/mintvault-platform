import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyScopedMigration } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let client: pg.Client;

const stationA = "11111111-1111-4111-8111-111111111111";
const stationB = "22222222-2222-4222-8222-222222222222";

const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (err: Error & { code?: string }) => err
  );
  expect(error, "expected PostgreSQL to reject a duplicate physical station target").not.toBeNull();
  expect(error?.code).toBe("23505");
}

async function resetPre0094Schema(): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS
      certificate_image_evidence,
      partner_credit_reservations,
      partner_card_jobs,
      scanner_capture_sessions,
      certificates,
      schema_migrations;
  `);
  await client.query(`
    CREATE TABLE schema_migrations (
      id serial PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      status text NOT NULL DEFAULT 'applied',
      applied_by text NOT NULL DEFAULT current_user
    );
  `);
  const migration0093 = readFileSync("migrations/0093_partner_credit_pack_currency.sql", "utf8");
  await client.query(
    "INSERT INTO schema_migrations (filename, checksum, completed_at, status) VALUES ($1,$2,now(),'applied')",
    ["0093_partner_credit_pack_currency.sql", checksum(migration0093)]
  );
  await client.query(`
    CREATE TABLE certificates (
      id integer PRIMARY KEY,
      certificate_number text NOT NULL
    );
    CREATE TABLE partner_credit_reservations (
      id text PRIMARY KEY,
      certificate_id integer NOT NULL REFERENCES certificates(id)
    );
    CREATE TABLE partner_card_jobs (
      id text PRIMARY KEY,
      certificate_id integer NOT NULL REFERENCES certificates(id),
      reservation_id text REFERENCES partner_credit_reservations(id)
    );
    CREATE TABLE scanner_capture_sessions (
      id text PRIMARY KEY,
      certificate_id integer NOT NULL REFERENCES certificates(id),
      side text NOT NULL CHECK (side IN ('front', 'back')),
      workstation_id text NOT NULL,
      station_id uuid,
      scanner_profile_version text NOT NULL DEFAULT 'lide400-fixed-v1',
      actor_id text,
      state text NOT NULL CHECK (state IN ('armed', 'claimed', 'capturing', 'captured', 'failed', 'expired', 'cancelled')),
      claimed_by_device_id text,
      recapture boolean NOT NULL DEFAULT false,
      failure_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      captured_at timestamptz,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
    );
    CREATE UNIQUE INDEX uq_scanner_capture_one_active_station
      ON scanner_capture_sessions (station_id)
      WHERE station_id IS NOT NULL
        AND state IN ('armed','claimed','capturing');
    CREATE TABLE certificate_image_evidence (
      id serial PRIMARY KEY,
      certificate_id integer NOT NULL REFERENCES certificates(id),
      side text NOT NULL,
      capture_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await client.query("INSERT INTO certificates (id, certificate_number) VALUES (1,'MV-000001'),(2,'MV-000002')");
  await client.query("INSERT INTO partner_credit_reservations (id, certificate_id) VALUES ('res-1',1),('res-2',2)");
  await client.query(
    "INSERT INTO partner_card_jobs (id, certificate_id, reservation_id) VALUES ('job-1',1,'res-1'),('job-2',2,'res-2')"
  );
}

describe("0094 scanner physical-release migration", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("scanner-physical-release-migration");
    client = new pg.Client({ connectionString: cluster.url });
    await client.connect();
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await cluster?.stop();
  });

  it("migrates a 0093 database and preserves the physical single-flight invariant", async () => {
    await resetPre0094Schema();

    await client.query(
      `INSERT INTO scanner_capture_sessions (id, certificate_id, side, workstation_id, station_id, state)
       VALUES ('front-before-0094', 1, 'front', 'station-a-mac', $1, 'claimed')`,
      [stationA]
    );
    await expectUniqueViolation(
      client.query(
        `INSERT INTO scanner_capture_sessions (id, certificate_id, side, workstation_id, station_id, state)
         VALUES ('back-before-0094', 1, 'back', 'station-a-mac', $1, 'armed')`,
        [stationA]
      )
    );

    const logs: string[] = [];
    const applied = await applyScopedMigration(client as never, "0094_scanner_capture_physical_release.sql", {
      log: (message) => logs.push(message),
    });

    expect(applied.applied).toBe(true);
    expect(applied.journalBefore).toBe(1);
    expect(applied.journalAfter).toBe(2);
    expect(logs.join("\n")).toContain("approved protected index replacement");

    const column = await client.query(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name='scanner_capture_sessions'
          AND column_name='physical_released'`
    );
    expect(column.rows).toEqual([{ is_nullable: "NO", column_default: "false" }]);

    await expectUniqueViolation(
      client.query(
        `INSERT INTO scanner_capture_sessions (id, certificate_id, side, workstation_id, station_id, state, physical_released)
         VALUES ('back-still-on-glass', 1, 'back', 'station-a-mac', $1, 'armed', false)`,
        [stationA]
      )
    );

    await client.query("UPDATE scanner_capture_sessions SET physical_released=true WHERE id='front-before-0094'");
    await client.query(
      `INSERT INTO scanner_capture_sessions (id, certificate_id, side, workstation_id, station_id, state, physical_released)
       VALUES ('back-after-release', 1, 'back', 'station-a-mac', $1, 'armed', false)`,
      [stationA]
    );
    await client.query(
      `INSERT INTO scanner_capture_sessions (id, certificate_id, side, workstation_id, station_id, state, physical_released)
       VALUES ('released-retry-row', 2, 'front', 'station-a-mac', $1, 'claimed', true)`,
      [stationA]
    );
    await expectUniqueViolation(
      client.query(
        `INSERT INTO scanner_capture_sessions (id, certificate_id, side, workstation_id, station_id, state, physical_released)
         VALUES ('other-card-on-glass', 2, 'back', 'station-a-mac', $1, 'armed', false)`,
        [stationA]
      )
    );

    await client.query(
      `INSERT INTO scanner_capture_sessions (id, certificate_id, side, workstation_id, station_id, state, physical_released)
       VALUES ('station-b-independent-glass', 2, 'front', 'station-b-mac', $1, 'armed', false)`,
      [stationB]
    );

    const migration0094 = readFileSync("migrations/0094_scanner_capture_physical_release.sql", "utf8");
    await client.query("BEGIN");
    await client.query(migration0094);
    await client.query("COMMIT");

    const replay = await applyScopedMigration(client as never, "0094_scanner_capture_physical_release.sql");
    expect(replay.applied).toBe(false);
    expect(replay.reason).toBe("already_applied");

    const index = await client.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename='scanner_capture_sessions' AND indexname='uq_scanner_capture_one_active_station'"
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toContain("physical_released = false");
    expect(index.rows[0].indexdef).toContain("state = ANY");

    const duplicatePhysicalOwners = await client.query(
      `SELECT station_id, count(*)::int AS count
         FROM scanner_capture_sessions
        WHERE station_id IS NOT NULL
          AND physical_released = false
          AND state IN ('armed','claimed','capturing')
        GROUP BY station_id
       HAVING count(*) > 1`
    );
    expect(duplicatePhysicalOwners.rows).toEqual([]);
  }, 180_000);
});
