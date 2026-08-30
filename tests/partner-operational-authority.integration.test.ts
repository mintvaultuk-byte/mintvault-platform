import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  partnerOperationalReadAuthorityReady,
  readPartnerPrintAuthority,
  readPartnerQaAuthority,
  withPartnerGradingWriteAuthority,
} from "../server/partner/operational-authority";
import { closePartnerPools } from "../server/partner/db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const LOCATION_ID = "20000000-0000-4000-8000-000000000001";
const PARTNER_SUBMISSION_ID = "30000000-0000-4000-8000-000000000001";
const HANDOFF_ID = "40000000-0000-4000-8000-000000000001";
const RECORD_ID = "50000000-0000-4000-8000-000000000001";
const IMPORT_ID = "60000000-0000-4000-8000-000000000001";
const STATION_ID = "70000000-0000-4000-8000-000000000001";
const OPERATOR_ID = "80000000-0000-4000-8000-000000000001";

let cluster: DisposablePostgres17;
let admin: Client;
let runtime: Client;
let savedEnv: Record<string, string | undefined>;

function asRole(raw: string, username: string, password: string): string {
  const url = new URL(raw);
  url.username = username;
  url.password = password;
  return url.toString();
}

async function waitForRecordLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await admin.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_stat_activity
         WHERE query LIKE '%connector operational authority: lock record first%'
           AND wait_event_type = 'Lock'
      ) AS waiting
    `);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("operational authority did not reach the record lock wait");
}

beforeAll(async () => {
  cluster = await startPostgres17("partner-operational-authority");
  admin = new Client({ connectionString: cluster.url });
  await admin.connect();
  await admin.query(`
    CREATE ROLE mintvault_app NOLOGIN;
    CREATE ROLE mintvault_operational_login LOGIN PASSWORD 'runtime-secret' INHERIT
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    GRANT mintvault_app TO mintvault_operational_login;
    CREATE ROLE partner_operational_admin LOGIN PASSWORD 'admin-secret' INHERIT
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

    CREATE TABLE partner_organisations (
      id uuid PRIMARY KEY, status text NOT NULL, legal_name text NOT NULL
    );
    CREATE TABLE partner_users (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, first_name text, last_name text, email text
    );
    CREATE TABLE partner_stations (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, location_id uuid NOT NULL,
      station_code text NOT NULL, approved_at timestamptz
    );
    CREATE TABLE partner_station_calibrations (id uuid PRIMARY KEY);
    CREATE TABLE partner_submissions (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, location_id uuid NOT NULL, card_count integer NOT NULL
    );
    CREATE TABLE partner_submission_handoffs (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, submission_id uuid NOT NULL
    );
    CREATE TABLE partner_connector_records (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, partner_submission_id uuid NOT NULL,
      handoff_id uuid NOT NULL, state text NOT NULL
    );
    CREATE TABLE partner_connector_imports (
      id uuid PRIMARY KEY, connector_record_id uuid NOT NULL,
      partner_organisation_id uuid NOT NULL, partner_location_id uuid NOT NULL,
      partner_submission_id uuid NOT NULL, partner_handoff_id uuid NOT NULL,
      destination_submission_id integer NOT NULL, state text NOT NULL
    );
    CREATE TABLE partner_credit_reservations (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, source text NOT NULL,
      submission_reference text NOT NULL, status text NOT NULL
    );
    CREATE TABLE partner_card_jobs (
      id uuid PRIMARY KEY, certificate_id integer, tenant_id uuid, location_id uuid,
      cancelled_at timestamptz, status text, mv_number text, reservation_id uuid
    );

    CREATE TABLE submissions (id integer PRIMARY KEY);
    CREATE TABLE submission_items (id integer PRIMARY KEY, submission_id integer);
    CREATE TABLE certificates (
      id integer PRIMARY KEY, certificate_number text NOT NULL, origin_type text,
      origin_partner_id uuid, origin_location_id uuid, submission_item_id integer,
      card_id integer, grader_status text, review_required boolean,
      grade_approved_at timestamptz, grade_approved_by text, print_state text
    );
    CREATE TABLE scanner_capture_sessions (
      id text PRIMARY KEY, certificate_id integer NOT NULL, side text NOT NULL,
      state text NOT NULL, station_id uuid
    );
    CREATE TABLE certificate_image_evidence (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, certificate_id integer NOT NULL,
      side text NOT NULL, capture_metadata jsonb NOT NULL, is_current boolean NOT NULL,
      evidence_class text NOT NULL, format text NOT NULL
    );

    INSERT INTO partner_organisations VALUES ('${TENANT_ID}', 'ACTIVE', 'Operational Shop');
    INSERT INTO partner_users VALUES ('${OPERATOR_ID}', '${TENANT_ID}', 'Ada', 'Lovelace', 'ada@example.test');
    INSERT INTO partner_stations VALUES ('${STATION_ID}', '${TENANT_ID}', '${LOCATION_ID}', 'MV-STATION-1', now());
    INSERT INTO partner_station_calibrations VALUES ('90000000-0000-4000-8000-000000000001');
    INSERT INTO partner_submissions VALUES ('${PARTNER_SUBMISSION_ID}', '${TENANT_ID}', '${LOCATION_ID}', 1);
    INSERT INTO partner_submission_handoffs VALUES ('${HANDOFF_ID}', '${TENANT_ID}', '${PARTNER_SUBMISSION_ID}');
    INSERT INTO partner_connector_records
      VALUES ('${RECORD_ID}', '${TENANT_ID}', '${PARTNER_SUBMISSION_ID}', '${HANDOFF_ID}', 'imported');
    INSERT INTO partner_connector_imports
      VALUES ('${IMPORT_ID}', '${RECORD_ID}', '${TENANT_ID}', '${LOCATION_ID}',
              '${PARTNER_SUBMISSION_ID}', '${HANDOFF_ID}', 20, 'completed');
    INSERT INTO partner_credit_reservations
      VALUES ('91000000-0000-4000-8000-000000000001', '${TENANT_ID}', 'portal',
              '${PARTNER_SUBMISSION_ID}', 'consumed');
    INSERT INTO submissions VALUES (20);
    INSERT INTO submission_items VALUES (10, 20);
    INSERT INTO certificates
      VALUES (1, 'MV-OPERATIONAL-1', 'PARTNER', '${TENANT_ID}', '${LOCATION_ID}', 10,
              NULL, 'approved', true, now(), 'admin@example.test', 'needs_printing');
    INSERT INTO scanner_capture_sessions VALUES
      ('capture-front', 1, 'front', 'captured', '${STATION_ID}'),
      ('capture-back', 1, 'back', 'captured', '${STATION_ID}');
    INSERT INTO certificate_image_evidence
      (certificate_id, side, capture_metadata, is_current, evidence_class, format)
    VALUES
      (1, 'front', '{"captureSessionId":"capture-front"}', true, 'NEW_IMMUTABLE_MASTER', 'tiff'),
      (1, 'back', '{"captureSessionId":"capture-back"}', true, 'NEW_IMMUTABLE_MASTER', 'tiff');

    GRANT USAGE ON SCHEMA public TO mintvault_app, partner_operational_admin;
    GRANT SELECT, UPDATE ON certificates TO mintvault_app;
    GRANT SELECT ON submissions, submission_items, scanner_capture_sessions,
      certificate_image_evidence TO mintvault_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO partner_operational_admin;
    GRANT UPDATE ON partner_card_jobs, partner_connector_imports, partner_connector_records,
      partner_station_calibrations, partner_stations, partner_submission_handoffs,
      partner_submissions TO partner_operational_admin;
  `);

  savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
    PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
  };
  process.env.NODE_ENV = "test";
  process.env.MINTVAULT_DATABASE_URL = asRole(cluster.url, "mintvault_operational_login", "runtime-secret");
  process.env.PARTNER_ADMIN_DATABASE_URL = asRole(cluster.url, "partner_operational_admin", "admin-secret");
  runtime = new Client({ connectionString: process.env.MINTVAULT_DATABASE_URL });
  await runtime.connect();
}, 60_000);

afterAll(async () => {
  await closePartnerPools();
  await runtime?.end().catch(() => {});
  await admin?.end().catch(() => {});
  for (const [key, value] of Object.entries(savedEnv ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cluster?.stop();
});

describe("distinct Partner operational authority", () => {
  it("serves the mixed print/QA facts while the main role remains denied Partner SELECT", async () => {
    await expect(runtime.query("SELECT 1 FROM partner_connector_imports")).rejects.toMatchObject({ code: "42501" });
    await expect(partnerOperationalReadAuthorityReady()).resolves.toBe(true);

    const print = await readPartnerPrintAuthority(["MV-OPERATIONAL-1"]);
    expect(print.get("MV-OPERATIONAL-1")).toMatchObject({
      mappingValid: true,
      qaComplete: true,
      creditSettled: true,
      captureComplete: true,
    });
    const qa = await readPartnerQaAuthority({
      tenantId: TENANT_ID,
      locationId: LOCATION_ID,
      operatorId: OPERATOR_ID,
      stationIds: [STATION_ID],
    });
    expect(qa).toMatchObject({ operatorName: "Ada Lovelace", stationCodes: ["MV-STATION-1"] });
    expect(qa.approvedStationIds.has(STATION_ID)).toBe(true);

    await expect(
      withPartnerGradingWriteAuthority(
        {
          lineage: "connector",
          certificateId: 1,
          tenantId: TENANT_ID,
          locationId: LOCATION_ID,
          partnerSubmissionId: PARTNER_SUBMISSION_ID,
          destinationSubmissionId: 20,
        },
        async () => {
          await runtime.query("UPDATE certificates SET print_state=print_state WHERE id=1");
          return "updated";
        }
      )
    ).resolves.toBe("updated");
  });

  it("keeps record-before-import order under a real two-connection reconciliation race", async () => {
    const reconciler = new Client({ connectionString: cluster.url });
    let authority: Promise<string> | null = null;
    await reconciler.connect();
    try {
      await reconciler.query("BEGIN");
      await reconciler.query("SELECT 1 FROM partner_connector_records WHERE id=$1::uuid FOR UPDATE", [RECORD_ID]);
      authority = withPartnerGradingWriteAuthority(
        {
          lineage: "connector",
          certificateId: 1,
          tenantId: TENANT_ID,
          locationId: LOCATION_ID,
          partnerSubmissionId: PARTNER_SUBMISSION_ID,
          destinationSubmissionId: 20,
        },
        async () => "authorised"
      );
      await waitForRecordLockWait();
      await expect(
        Promise.race([
          reconciler.query("UPDATE partner_connector_imports SET state=state WHERE id=$1::uuid", [IMPORT_ID]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("import update blocked behind reader")), 2_000)),
        ])
      ).resolves.toBeDefined();
      await reconciler.query("COMMIT");
      await expect(authority).resolves.toBe("authorised");
    } finally {
      await reconciler.query("ROLLBACK").catch(() => {});
      await authority?.catch(() => {});
      await reconciler.end().catch(() => {});
    }
  });
});
