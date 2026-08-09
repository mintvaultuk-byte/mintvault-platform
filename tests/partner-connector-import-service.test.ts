/**
 * Trusted Intake Connector — Phase G3: exactly-once importer service proof (disposable Postgres,
 * realistic non-superuser role model, real connections — not mocks). Mirrors
 * tests/partner-connector-service.test.ts's (G1) and tests/partner-connector-validation-service.test.ts's
 * (G2) setup pattern, extended with hand-created representative `users`/`submissions`/
 * `submission_items` tables (the real ones are managed by db:push, not by any migrations/ file).
 *
 * Runs ONLY when PARTNER_CONNECTOR_IMPORT_RT_ADMIN + PARTNER_CONNECTOR_IMPORT_RT_URL are set:
 *   PARTNER_CONNECTOR_IMPORT_RT_ADMIN=postgresql://postgres@127.0.0.1:5593/dispo \
 *   PARTNER_CONNECTOR_IMPORT_RT_URL=postgresql://partner_connector_import_test:synthetic@127.0.0.1:5593/dispo \
 *   npx vitest run tests/partner-connector-import-service.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
  pinAccountingTopologyTo,
} from "./helpers/partner-realistic-db";

vi.mock("../server/r2", async () => {
  const actual = await vi.importActual<typeof import("../server/r2")>("../server/r2");
  return { ...actual, headR2: vi.fn(async () => ({ lastModified: new Date("2026-08-04T00:00:00Z") })) };
});

const ADMIN = process.env.PARTNER_CONNECTOR_IMPORT_RT_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_IMPORT_RT_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-4000-0000-0000-000000000001";
const B = "bbbbbbbb-4000-0000-0000-000000000002";
const L1 = "10000000-4000-0000-0000-0000000000c1";
const LB = "20000000-4000-0000-0000-0000000000d1";
const U1 = "11111111-4000-0000-0000-0000000000a1";
const UB = "22222222-4000-0000-0000-0000000000b1";

let admin: Client;
let seq = 0;
const uuid = (n: number) => `40000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const frontKey = (tenantId: string, submissionId: string, cardId: string) =>
  `partner-submissions/${tenantId}/${submissionId}/${cardId}/front-seed.jpg`;
const backKey = (tenantId: string, submissionId: string, cardId: string) =>
  `partner-submissions/${tenantId}/${submissionId}/${cardId}/back-seed.jpg`;

async function seedMintVaultTables(): Promise<void> {
  await admin.query(`CREATE TABLE IF NOT EXISTS users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar UNIQUE, first_name varchar, last_name varchar,
    role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS submissions (
    id serial PRIMARY KEY, user_id varchar NOT NULL, status varchar(30) NOT NULL DEFAULT 'draft',
    tracking_number text NOT NULL UNIQUE, card_count integer NOT NULL DEFAULT 0,
    total_price decimal(10,2) NOT NULL DEFAULT 0, total_declared_value integer NOT NULL DEFAULT 0,
    payment_status varchar(20) NOT NULL DEFAULT 'unpaid', payment_intent_id text,
    service_type text, service_tier text, grading_cost integer DEFAULT 0,
    customer_email text, customer_first_name text, customer_last_name text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS submission_items (
    id serial PRIMARY KEY, submission_id integer NOT NULL, card_index integer NOT NULL DEFAULT 0,
    game text, card_set text, card_name text, card_number text, year text,
    declared_value integer DEFAULT 0, declared_new boolean DEFAULT false, notes text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS certificates (
    id serial PRIMARY KEY,
    cert_id text,
    certificate_number text UNIQUE,
    card_id integer,
    submission_item_id integer,
    status varchar(10) NOT NULL DEFAULT 'active',
    label_type text NOT NULL DEFAULT 'Standard',
    grade_type text NOT NULL DEFAULT 'numeric',
    language text DEFAULT 'English',
    card_game text,
    set_name text,
    card_name text,
    card_number_display text,
    year_text text,
    variant text,
    front_image_path text,
    back_image_path text,
    grading_front_original text,
    grading_back_original text,
    created_by text,
    issued_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    reference_number text UNIQUE,
    logbook_version integer NOT NULL DEFAULT 1,
    logbook_last_issued_at timestamptz,
    integrity_hash text,
    print_state varchar(24) NOT NULL DEFAULT 'awaiting_approval',
    grader_status varchar(20) NOT NULL DEFAULT 'unassigned',
    origin_type text,
    origin_partner_id uuid,
    origin_partner_public_ref text,
    origin_partner_legal_name text,
    origin_partner_trading_name text,
    origin_location_id uuid,
    origin_location_public_ref text,
    origin_location_name text,
    origin_location_address text,
    origin_captured_at timestamptz,
    origin_snapshot_version integer,
    deleted_at timestamptz,
    grade_approved_at timestamptz
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS cert_counter (
    id integer PRIMARY KEY,
    last_issued integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb DEFAULT '{}'::jsonb, created_at timestamp NOT NULL DEFAULT now()
  )`);
  // Dead table — G3 must never write here (DESTINATION-BOUNDARY.md).
  await admin.query(`CREATE TABLE IF NOT EXISTS cards (
    id serial PRIMARY KEY, submission_id integer, card_name text
  )`);
  // A pre-existing, unrelated user + submission — proves the importer never picks an arbitrary
  // existing user/reference (the exact risk the unsafe COALESCE fallback and COUNT(*) generator create).
  await admin.query(
    "INSERT INTO users (id, email, first_name) VALUES ('pre-existing-arbitrary-user', 'unrelated@example.com', 'Unrelated') ON CONFLICT DO NOTHING"
  );
  await admin.query(
    "INSERT INTO submissions (user_id, tracking_number, status) VALUES ('pre-existing-arbitrary-user', 'MV-SUB-000001', 'draft') ON CONFLICT DO NOTHING"
  );
  await admin.query("ALTER TABLE users OWNER TO pn_migrator");
  await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
  await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
  await admin.query("ALTER TABLE certificates OWNER TO pn_migrator");
  await admin.query("ALTER TABLE cert_counter OWNER TO pn_migrator");
  await admin.query("ALTER TABLE audit_log OWNER TO pn_migrator");
  await admin.query("ALTER TABLE cards OWNER TO pn_migrator");
}

async function seedTenant(tenantId: string, locationId: string, userId: string, ref: string): Promise<void> {
  await admin.query(
    "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,$2,$2,'ACTIVE') ON CONFLICT DO NOTHING",
    [tenantId, ref]
  );
  await admin.query(
    "INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET trading_name=EXCLUDED.trading_name",
    [tenantId, `${ref} Trading`]
  );
  await admin.query(
    "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,$2,$3,$3,'HQ','ACTIVE') ON CONFLICT DO NOTHING",
    [locationId, ref + "-loc", tenantId]
  );
  await admin.query(
    "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES ($1,$2,$3,$3,$4,'x','ACTIVE',false) ON CONFLICT DO NOTHING",
    [userId, ref + "-user", tenantId, `${ref}@example.com`]
  );
  await admin.query(
    "INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES ($1,'standard','Standard',1500,10,true) ON CONFLICT DO NOTHING",
    [tenantId]
  );
}

interface SeedResult {
  connectorId: string;
  version: number;
  submissionId: string;
  customerId: string;
  handoffId: string;
}

/** Seeds a fully valid Partner submission + customer + cards, drives it through claim ->
 * validating -> validateConnectorRecord, and asserts it lands in ready_for_import. Returns
 * everything a test needs to then call importValidatedConnector. */
async function seedReadyForImport(
  tenantId: string,
  locationId: string,
  partnerUserId: string,
  opts: { customerName?: string; cardCount?: number; claimant?: string } = {}
): Promise<SeedResult> {
  seq += 1;
  const subId = uuid(seq);
  const custId = uuid(seq + 100_000);
  await admin.query("INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,$3,$4)", [
    custId,
    tenantId,
    opts.customerName ?? `Customer ${seq}`,
    `customer${seq}@example.com`,
  ]);
  await admin.query(
    `INSERT INTO partner_submissions
       (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
     VALUES ($1,$2,$3,$4,$5,'standard',3000,$6,'submitted_to_mintvault')`,
    [subId, tenantId, locationId, partnerUserId, custId, opts.cardCount ?? 2]
  );
  for (let i = 1; i <= (opts.cardCount ?? 2); i++) {
    const cardId = uuid(400_000 + seq * 100 + i);
    await admin.query(
      `INSERT INTO partner_submission_cards
         (id, tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, declared_value_pence, quantity, front_image_key, back_image_key)
       VALUES ($1,$2,$3,$4,$5,'pokemon','Base Set','4/102',1999,50000,1,$6,$7)`,
      [cardId, tenantId, subId, i, `Card ${i}`, frontKey(tenantId, subId, cardId), backKey(tenantId, subId, cardId)]
    );
  }
  const h = await admin.query(
    "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
    [tenantId, subId]
  );
  const handoffId = h.rows[0].id;

  const svc = await import("../server/partner/connector-service");
  const validation = await import("../server/partner/connector-validation-service");
  const claimant = opts.claimant ?? "worker-import-test";

  let rec = await svc.ensureConnectorRecordForHandoff({ tenantId, handoffId });
  rec = await svc.claimConnectorRecord(rec.id, claimant, 300, tenantId);
  rec = await svc.transitionConnectorState({
    connectorId: rec.id,
    claimant,
    tenantId,
    expectedVersion: rec.version,
    toState: "validating",
    eventType: "validating",
  });
  const run = await validation.validateConnectorRecord({
    connectorId: rec.id,
    claimant,
    expectedVersion: rec.version,
    tenantId,
  });
  expect(run.outcome).toBe("valid");

  const status = await svc.getConnectorStatus({ tenantId, connectorId: rec.id });
  expect(status?.state).toBe("ready_for_import");

  // getConnectorStatus doesn't expose version — re-read via a direct admin query for the test's own use.
  const { rows } = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [rec.id]);
  return { connectorId: rec.id, version: rows[0].version, submissionId: subId, customerId: custId, handoffId };
}

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector G3 — exactly-once importer (disposable DB, real connections)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
      await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
      // pn_migrator must exist BEFORE seedMintVaultTables' ALTER TABLE ... OWNER TO pn_migrator runs.
      await provisionRealisticRoles(admin);
      await seedMintVaultTables();
      await admin.query("DROP ROLE IF EXISTS partner_connector_import_test").catch(() => {});
      await admin.query("CREATE ROLE partner_connector_import_test LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_connector_runtime TO partner_connector_import_test");

      await admin.query("DROP ROLE IF EXISTS partner_import_test_conn").catch(() => {});
      await admin.query("CREATE ROLE partner_import_test_conn LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_runtime TO partner_import_test_conn");
      await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);

      process.env.PARTNER_CONNECTOR_DATABASE_URL = CONNECTOR_URL;
      // CI pins MINTVAULT_DATABASE_URL globally to a DIFFERENT database; the G6D accounting
      // topology assertion in server/partner/db.ts then throws. Pin it to this suite's own.
      pinAccountingTopologyTo(CONNECTOR_URL);
      const runtimeUrlForFlags = new URL(CONNECTOR_URL!);
      runtimeUrlForFlags.username = "partner_import_test_conn";
      runtimeUrlForFlags.password = "synthetic";
      process.env.PARTNER_DATABASE_URL = runtimeUrlForFlags.toString();

      await seedTenant(A, L1, U1, "impA");
      await seedTenant(B, LB, UB, "impB");

      await admin.query(
        "INSERT INTO partner_feature_flags (flag, tenant_id, location_id, enabled) VALUES ('partner_connector_enabled', NULL, NULL, true), ('partner_emergency_stop', NULL, NULL, false)"
      );
    }, 60_000);

    afterAll(async () => {
      const { closeConnectorPool } = await import("../server/partner/connector-db");
      const { closePartnerPools } = await import("../server/partner/db");
      await closeConnectorPool();
      await closePartnerPools();
      await admin?.end().catch(() => {});
    });

    describe("happy path", () => {
      it("creates one destination submission with the correct shape", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1, { cardCount: 2 });
        const result = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-import-test",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        expect(result.outcome).toBe("imported");
        expect(result.destinationSubmissionId).toBeTypeOf("number");
        expect(result.destinationReference).toMatch(/^MV-SUB-\d{6,}$/);

        const { rows } = await admin.query("SELECT * FROM submissions WHERE id = $1", [result.destinationSubmissionId]);
        expect(rows).toHaveLength(1);
        const sub = rows[0];
        expect(sub.status).toBe("draft");
        expect(sub.payment_status).toBe("unpaid");
        expect(sub.payment_intent_id).toBeNull();
        expect(sub.service_type).toBe("partner-intake");
        expect(sub.service_tier).toBe("standard");
        expect(sub.card_count).toBe(2);
        expect(Number(sub.total_price)).toBeCloseTo(30, 2); // 1500 pence/card * 2 cards = 3000p = £30
        expect(sub.user_id).not.toBe("pre-existing-arbitrary-user");

        const items = await admin.query("SELECT * FROM submission_items WHERE submission_id = $1 ORDER BY card_index", [
          result.destinationSubmissionId,
        ]);
        expect(items.rows).toHaveLength(2);
        expect(items.rows[0].card_name).toBe("Card 1");
        expect(items.rows[0].declared_value).toBe(50000);

        // Never writes to the dead `cards` table.
        const cardsCount = await admin.query("SELECT count(*)::int AS n FROM cards");
        expect(cardsCount.rows[0].n).toBe(0);

        const mapping = await importer.getConnectorImport(seeded.connectorId);
        expect(mapping?.state).toBe("completed");
        expect(mapping?.destinationSubmissionId).toBe(result.destinationSubmissionId);

        const events = await admin.query(
          "SELECT event_type, from_state, to_state FROM partner_connector_events WHERE connector_record_id = $1 ORDER BY created_at",
          [seeded.connectorId]
        );
        const tail = events.rows.slice(-2);
        expect(tail.map((e) => e.event_type)).toEqual(["import_started", "imported"]);
        expect(tail[0]).toMatchObject({ from_state: "ready_for_import", to_state: "importing" });
        expect(tail[1]).toMatchObject({ from_state: "importing", to_state: "imported" });
      });

      it("a card with quantity > 1 expands into that many submission_items rows", async () => {
        const importer = await import("../server/partner/connector-import-service");
        seq += 1;
        const subId = uuid(seq);
        const custId = uuid(seq + 100_000);
        await admin.query("INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,$3,$4)", [
          custId,
          A,
          "Qty Customer",
          `qty${seq}@example.com`,
        ]);
        await admin.query(
          `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
         VALUES ($1,$2,$3,$4,$5,'standard',4500,3,'submitted_to_mintvault')`,
          [subId, A, L1, U1, custId]
        );
        const cardId = uuid(seq + 500_000);
        await admin.query(
          `INSERT INTO partner_submission_cards
             (id, tenant_id, submission_id, sequence_number, card_name, declared_value_pence, quantity, front_image_key, back_image_key)
           VALUES ($1,$2,$3,1,'Triple Card',10000,3,$4,$5)`,
          [cardId, A, subId, frontKey(A, subId, cardId), backKey(A, subId, cardId)]
        );
        const h = await admin.query(
          "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
          [A, subId]
        );
        const svc = await import("../server/partner/connector-service");
        const validation = await import("../server/partner/connector-validation-service");
        let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h.rows[0].id });
        rec = await svc.claimConnectorRecord(rec.id, "worker-qty", 300, A);
        rec = await svc.transitionConnectorState({
          connectorId: rec.id,
          claimant: "worker-qty",
          tenantId: A,
          expectedVersion: rec.version,
          toState: "validating",
          eventType: "validating",
        });
        await validation.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-qty",
          expectedVersion: rec.version,
          tenantId: A,
        });
        const { rows: vrows } = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [
          rec.id,
        ]);

        const result = await importer.importValidatedConnector({
          connectorId: rec.id,
          claimant: "worker-qty",
          expectedVersion: vrows[0].version,
          tenantId: A,
        });
        expect(result.outcome).toBe("imported");
        const items = await admin.query("SELECT * FROM submission_items WHERE submission_id = $1", [
          result.destinationSubmissionId,
        ]);
        expect(items.rows).toHaveLength(3);
        const { rows: subRows } = await admin.query(
          "SELECT card_count, total_declared_value FROM submissions WHERE id = $1",
          [result.destinationSubmissionId]
        );
        expect(subRows[0].card_count).toBe(3);
        expect(subRows[0].total_declared_value).toBe(30000); // 10000 * 3
        const workItems = await admin.query(
          `SELECT partner_submission_card_id::text AS card_id, card_ordinal::int AS ordinal,
                  front_image_key, back_image_key, status
             FROM partner_grading_work_items
            WHERE connector_record_id = $1
            ORDER BY card_ordinal`,
          [rec.id]
        );
        expect(workItems.rows).toEqual([
          {
            card_id: cardId,
            ordinal: 1,
            front_image_key: frontKey(A, subId, cardId),
            back_image_key: backKey(A, subId, cardId),
            status: "ready_for_assignment",
          },
          {
            card_id: cardId,
            ordinal: 2,
            front_image_key: frontKey(A, subId, cardId),
            back_image_key: backKey(A, subId, cardId),
            status: "ready_for_assignment",
          },
          {
            card_id: cardId,
            ordinal: 3,
            front_image_key: frontKey(A, subId, cardId),
            back_image_key: backKey(A, subId, cardId),
            status: "ready_for_assignment",
          },
        ]);
      });
    });

    /**
     * ORIGIN-TRADING1 — the importer is the ONLY code path that stamps a PARTNER certificate
     * origin, and migration 0035 makes that stamp immutable (ENABLE ALWAYS trigger). Before the
     * repair the query selected `NULL::text AS partner_trading_name`, so every partner-graded
     * certificate froze a NULL trading name — the value server/labels.ts certificateOrigin()
     * renders FIRST as "Graded by <X>" — and no test noticed, because no test had ever read the
     * origin columns off a certificate the importer actually created.
     *
     * These tests read the real rows the real importer wrote, through the real connector role
     * (partner_connector_import_test inherits partner_connector_runtime), so a missing GRANT is a
     * failure here rather than a 42501 discovered in production.
     */
    describe("certificate origin snapshot", () => {
      it("records the APPROVED partner trading name from partner_profiles, not NULL", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1, { cardCount: 2, claimant: "worker-origin-trading" });
        const result = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-origin-trading",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        expect(result.outcome).toBe("imported");

        const { rows } = await admin.query(
          `SELECT c.origin_type, c.origin_partner_id, c.origin_partner_trading_name,
                  c.origin_partner_legal_name, c.origin_location_name
             FROM certificates c
             JOIN partner_grading_work_items w ON w.certificate_id = c.id
            WHERE w.destination_submission_id = $1
            ORDER BY w.card_ordinal`,
          [result.destinationSubmissionId]
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.origin_type).toBe("PARTNER");
          expect(row.origin_partner_id).toBe(A);
          // seedTenant(A, ..., "impA") writes partner_profiles.trading_name = 'impA Trading'
          // while partner_organisations.legal_name is 'impA'. The two differ ON PURPOSE: if the
          // snapshot ever falls back to the legal name the assertion below fails loudly instead
          // of passing on a coincidentally-equal string.
          expect(row.origin_partner_trading_name).toBe("impA Trading");
          expect(row.origin_partner_legal_name).toBe("impA");
        }
      });

      it("never reads another tenant's trading name (the location join re-qualifies by tenant)", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(B, LB, UB, { cardCount: 2, claimant: "worker-origin-trading-b" });
        const result = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-origin-trading-b",
          expectedVersion: seeded.version,
          tenantId: B,
        });
        expect(result.outcome).toBe("imported");

        const { rows } = await admin.query(
          `SELECT c.origin_partner_trading_name
             FROM certificates c
             JOIN partner_grading_work_items w ON w.certificate_id = c.id
            WHERE w.destination_submission_id = $1`,
          [result.destinationSubmissionId]
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.origin_partner_trading_name).toBe("impB Trading");
          expect(row.origin_partner_trading_name).not.toBe("impA Trading");
        }
      });

      it("normalises a whitespace-only trading name to NULL instead of freezing blank display text", async () => {
        const importer = await import("../server/partner/connector-import-service");
        // Blanked AFTER validation: the validator has its own separate opinion about a partner
        // being presentable, and this test is about the IMPORTER's snapshot normalisation, not
        // about re-testing the validator.
        const seeded = await seedReadyForImport(A, L1, U1, { cardCount: 2, claimant: "worker-origin-blank" });
        await admin.query("UPDATE partner_profiles SET trading_name = '   ' WHERE tenant_id = $1", [A]);
        try {
          const result = await importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant: "worker-origin-blank",
            expectedVersion: seeded.version,
            tenantId: A,
          });
          expect(result.outcome).toBe("imported");
          const { rows } = await admin.query(
            `SELECT c.origin_partner_trading_name, c.origin_partner_legal_name
               FROM certificates c
               JOIN partner_grading_work_items w ON w.certificate_id = c.id
              WHERE w.destination_submission_id = $1`,
            [result.destinationSubmissionId]
          );
          // NULL, not '   '. 0035's snapshot is immutable, and certificateOrigin() would render a
          // whitespace-only name as an empty "Graded by " line forever.
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(row.origin_partner_trading_name).toBeNull();
            expect(row.origin_partner_legal_name).toBe("impA");
          }
        } finally {
          await admin.query("UPDATE partner_profiles SET trading_name = 'impA Trading' WHERE tenant_id = $1", [A]);
        }
      });

      it("fails closed when BOTH the trading name and the legal name are blank", async () => {
        const importer = await import("../server/partner/connector-import-service");
        // Blanked AFTER validation — same reason as the test above.
        const seeded = await seedReadyForImport(A, L1, U1, { cardCount: 2, claimant: "worker-origin-unnamed" });
        await admin.query("UPDATE partner_profiles SET trading_name = '' WHERE tenant_id = $1", [A]);
        await admin.query("UPDATE partner_organisations SET legal_name = '   ' WHERE id = $1", [A]);
        try {
          await expect(
            importer.importValidatedConnector({
              connectorId: seeded.connectorId,
              claimant: "worker-origin-unnamed",
              expectedVersion: seeded.version,
              tenantId: A,
            })
          ).rejects.toThrow(/origin snapshot is incomplete/i);

          // The whole import transaction must have rolled back — no orphan certificate, no
          // half-imported destination submission.
          const certs = await admin.query(
            "SELECT count(*)::int AS n FROM certificates WHERE origin_partner_id = $1 AND origin_partner_legal_name IS NULL",
            [A]
          );
          expect(certs.rows[0].n).toBe(0);
        } finally {
          await admin.query("UPDATE partner_organisations SET legal_name = 'impA' WHERE id = $1", [A]);
          await admin.query("UPDATE partner_profiles SET trading_name = 'impA Trading' WHERE tenant_id = $1", [A]);
        }
      });
    });

    describe("owner resolution", () => {
      it("two different submissions from the SAME Partner customer resolve to the SAME MintVault user", async () => {
        const importer = await import("../server/partner/connector-import-service");
        seq += 1;
        const custId = uuid(seq + 200_000);
        await admin.query(
          "INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,'Repeat Customer','repeat@example.com')",
          [custId, A]
        );

        async function seedForExistingCustomer(): Promise<SeedResult> {
          seq += 1;
          const subId = uuid(seq);
          await admin.query(
            `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
           VALUES ($1,$2,$3,$4,$5,'standard',1500,1,'submitted_to_mintvault')`,
            [subId, A, L1, U1, custId]
          );
          const cardId = uuid(seq + 510_000);
          await admin.query(
            `INSERT INTO partner_submission_cards
               (id, tenant_id, submission_id, sequence_number, card_name, declared_value_pence, quantity, front_image_key, back_image_key)
             VALUES ($1,$2,$3,1,'C',1000,1,$4,$5)`,
            [cardId, A, subId, frontKey(A, subId, cardId), backKey(A, subId, cardId)]
          );
          const h = await admin.query(
            "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
            [A, subId]
          );
          const svc = await import("../server/partner/connector-service");
          const validation = await import("../server/partner/connector-validation-service");
          const claimant = `worker-repeat-${seq}`;
          let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h.rows[0].id });
          rec = await svc.claimConnectorRecord(rec.id, claimant, 300, A);
          rec = await svc.transitionConnectorState({
            connectorId: rec.id,
            claimant,
            tenantId: A,
            expectedVersion: rec.version,
            toState: "validating",
            eventType: "validating",
          });
          await validation.validateConnectorRecord({
            connectorId: rec.id,
            claimant,
            expectedVersion: rec.version,
            tenantId: A,
          });
          const { rows } = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [rec.id]);
          return {
            connectorId: rec.id,
            version: rows[0].version,
            submissionId: subId,
            customerId: custId,
            handoffId: h.rows[0].id,
          };
        }

        async function claimantFor(connectorId: string): Promise<string> {
          const { rows } = await admin.query("SELECT claimed_by FROM partner_connector_records WHERE id = $1", [
            connectorId,
          ]);
          return rows[0].claimed_by;
        }

        const first = await seedForExistingCustomer();
        const r1 = await importer.importValidatedConnector({
          connectorId: first.connectorId,
          claimant: await claimantFor(first.connectorId),
          expectedVersion: first.version,
          tenantId: A,
        });
        const second = await seedForExistingCustomer();
        const r2 = await importer.importValidatedConnector({
          connectorId: second.connectorId,
          claimant: await claimantFor(second.connectorId),
          expectedVersion: second.version,
          tenantId: A,
        });

        const u1 = await admin.query("SELECT user_id FROM submissions WHERE id = $1", [r1.destinationSubmissionId]);
        const u2 = await admin.query("SELECT user_id FROM submissions WHERE id = $1", [r2.destinationSubmissionId]);
        expect(u1.rows[0].user_id).toBe(u2.rows[0].user_id);

        const links = await admin.query(
          "SELECT count(*)::int AS n FROM partner_connector_customer_links WHERE partner_customer_id = $1",
          [custId]
        );
        expect(links.rows[0].n).toBe(1); // exactly one link, reused
      });

      it("connector-created users rows have NULL email (never collide on the UNIQUE users.email constraint)", async () => {
        const { rows } = await admin.query(
          "SELECT email FROM users WHERE id IN (SELECT mintvault_user_id FROM partner_connector_customer_links)"
        );
        for (const r of rows) expect(r.email).toBeNull();
      });
    });

    describe("exactly-once / duplicate retry", () => {
      it("a second call for the SAME connector returns the SAME destination, creates no second submission", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        const r1 = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-import-test",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        const r2 = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-import-test",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        expect(r2.outcome).toBe("already_completed");
        expect(r2.destinationSubmissionId).toBe(r1.destinationSubmissionId);
        const { rows } = await admin.query(
          "SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = $1",
          [seeded.connectorId]
        );
        expect(rows[0].n).toBe(1);
      });

      it("N concurrent import calls for the SAME connector, separate connections, create exactly one destination", async () => {
        const seeded = await seedReadyForImport(A, L1, U1);
        const N = 8;
        const results = await Promise.allSettled(
          Array.from({ length: N }, async () => {
            // Fresh import of the module per call is unnecessary (Node caches it) but each call goes
            // through the SAME connector pool — real separate pooled connections, not one shared client.
            const importer = await import("../server/partner/connector-import-service");
            return importer.importValidatedConnector({
              connectorId: seeded.connectorId,
              claimant: "worker-import-test",
              expectedVersion: seeded.version,
              tenantId: A,
            });
          })
        );
        const succeeded = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
        const destinations = new Set(succeeded.map((r) => r.value.destinationSubmissionId).filter((d) => d != null));
        expect(destinations.size).toBe(1);
        const { rows } = await admin.query(
          "SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = $1 AND state = 'completed'",
          [seeded.connectorId]
        );
        expect(rows[0].n).toBe(1);
        const submissionCount = await admin.query(
          "SELECT count(*)::int AS n FROM submissions WHERE id = ANY($1::int[])",
          [[...destinations]]
        );
        expect(submissionCount.rows[0].n).toBe(1);
      });
    });

    describe("stale source", () => {
      it("a customer edit after validation blocks import and routes the connector back to validating", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        await admin.query("UPDATE partner_customers SET full_name = 'Edited After Validation' WHERE id = $1", [
          seeded.customerId,
        ]);

        const result = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-import-test",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        expect(result.outcome).toBe("stale");
        expect(result.destinationSubmissionId).toBeNull();

        const { rows } = await admin.query("SELECT state FROM partner_connector_records WHERE id = $1", [
          seeded.connectorId,
        ]);
        expect(rows[0].state).toBe("validating");

        const mapping = await importer.getConnectorImport(seeded.connectorId);
        expect(mapping).toBeNull();
      });
    });

    describe("wrong claimant / stale version / not ready", () => {
      it("wrong claimant is rejected", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant: "someone-else",
            expectedVersion: seeded.version,
            tenantId: A,
          })
        ).rejects.toMatchObject({ code: "import_claimant_mismatch" });
      });

      it("stale version is rejected", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant: "worker-import-test",
            expectedVersion: seeded.version + 99,
            tenantId: A,
          })
        ).rejects.toMatchObject({ code: "import_version_conflict" });
      });

      it("a record still in 'validating' (not yet ready_for_import) is rejected", async () => {
        seq += 1;
        const subId = uuid(seq);
        const custId = uuid(seq + 300_000);
        await admin.query(
          "INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,'X','x@example.com')",
          [custId, A]
        );
        await admin.query(
          `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
         VALUES ($1,$2,$3,$4,$5,'standard',1500,1,'submitted_to_mintvault')`,
          [subId, A, L1, U1, custId]
        );
        const cardId = uuid(seq + 520_000);
        await admin.query(
          `INSERT INTO partner_submission_cards
             (id, tenant_id, submission_id, sequence_number, card_name, declared_value_pence, quantity, front_image_key, back_image_key)
           VALUES ($1,$2,$3,1,'C',1000,1,$4,$5)`,
          [cardId, A, subId, frontKey(A, subId, cardId), backKey(A, subId, cardId)]
        );
        const h = await admin.query(
          "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
          [A, subId]
        );
        const svc = await import("../server/partner/connector-service");
        const importer = await import("../server/partner/connector-import-service");
        let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h.rows[0].id });
        rec = await svc.claimConnectorRecord(rec.id, "worker-notready", 300, A);
        rec = await svc.transitionConnectorState({
          connectorId: rec.id,
          claimant: "worker-notready",
          tenantId: A,
          expectedVersion: rec.version,
          toState: "validating",
          eventType: "validating",
        });
        await expect(
          importer.importValidatedConnector({
            connectorId: rec.id,
            claimant: "worker-notready",
            expectedVersion: rec.version,
            tenantId: A,
          })
        ).rejects.toMatchObject({ code: "import_not_ready" });
      });

      it("the connector flag OFF blocks import (fail closed)", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        await admin.query(
          "UPDATE partner_feature_flags SET enabled = false WHERE flag = 'partner_connector_enabled' AND tenant_id IS NULL"
        );
        try {
          await expect(
            importer.importValidatedConnector({
              connectorId: seeded.connectorId,
              claimant: "worker-import-test",
              expectedVersion: seeded.version,
              tenantId: A,
            })
          ).rejects.toMatchObject({ code: "feature_disabled" });
        } finally {
          await admin.query(
            "UPDATE partner_feature_flags SET enabled = true WHERE flag = 'partner_connector_enabled' AND tenant_id IS NULL"
          );
        }
      });

      it("emergency stop overrides the flag", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        await admin.query(
          "UPDATE partner_feature_flags SET enabled = true WHERE flag = 'partner_emergency_stop' AND tenant_id IS NULL"
        );
        try {
          await expect(
            importer.importValidatedConnector({
              connectorId: seeded.connectorId,
              claimant: "worker-import-test",
              expectedVersion: seeded.version,
              tenantId: A,
            })
          ).rejects.toMatchObject({ code: "import_emergency_stopped" });
        } finally {
          await admin.query(
            "UPDATE partner_feature_flags SET enabled = false WHERE flag = 'partner_emergency_stop' AND tenant_id IS NULL"
          );
        }
      });
    });

    describe("reconciliation inspector (read-only)", () => {
      it("a normal completed import is 'consistent_completed'", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-import-test",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        const status = await importer.inspectConnectorImportConsistency(seeded.connectorId);
        expect(status.status).toBe("consistent_completed");
      });

      it("a completed mapping whose destination was deleted is flagged needs_review", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        const result = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-import-test",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        await admin.query("DELETE FROM partner_grading_work_items WHERE destination_submission_id = $1", [
          result.destinationSubmissionId,
        ]);
        await admin.query("DELETE FROM submission_items WHERE submission_id = $1", [result.destinationSubmissionId]);
        await admin.query("DELETE FROM submissions WHERE id = $1", [result.destinationSubmissionId]);
        const status = await importer.inspectConnectorImportConsistency(seeded.connectorId);
        expect(status.status).toBe("needs_review_destination_missing");
      });

      it("a connector marked imported with no mapping row (forced corruption) is flagged needs_review", async () => {
        seq += 1;
        const subId = uuid(seq);
        const custId = uuid(seq + 400_000);
        await admin.query(
          "INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,'C','c@example.com')",
          [custId, A]
        );
        await admin.query(
          `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
         VALUES ($1,$2,$3,$4,$5,'standard',1500,1,'submitted_to_mintvault')`,
          [subId, A, L1, U1, custId]
        );
        const cardId = uuid(seq + 530_000);
        await admin.query(
          `INSERT INTO partner_submission_cards
             (id, tenant_id, submission_id, sequence_number, card_name, declared_value_pence, quantity, front_image_key, back_image_key)
           VALUES ($1,$2,$3,1,'C',1000,1,$4,$5)`,
          [cardId, A, subId, frontKey(A, subId, cardId), backKey(A, subId, cardId)]
        );
        const h = await admin.query(
          "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
          [A, subId]
        );
        const svc = await import("../server/partner/connector-service");
        const importer = await import("../server/partner/connector-import-service");
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h.rows[0].id });
        await admin.query("UPDATE partner_connector_records SET state = 'imported' WHERE id = $1", [rec.id]);
        const status = await importer.inspectConnectorImportConsistency(rec.id);
        expect(status.status).toBe("needs_review_imported_without_mapping");
      });
    });

    describe("forbidden side effects", () => {
      it("importing never writes to the dead cards table and never sets a Stripe payment_intent_id", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const before = await admin.query("SELECT count(*)::int AS n FROM cards");
        const seeded = await seedReadyForImport(A, L1, U1);
        const result = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-import-test",
          expectedVersion: seeded.version,
          tenantId: A,
        });
        const after = await admin.query("SELECT count(*)::int AS n FROM cards");
        expect(after.rows[0].n).toBe(before.rows[0].n);
        const { rows } = await admin.query("SELECT payment_intent_id, payment_status FROM submissions WHERE id = $1", [
          result.destinationSubmissionId,
        ]);
        expect(rows[0].payment_intent_id).toBeNull();
        expect(rows[0].payment_status).toBe("unpaid");
      });
    });

    describe("cross-tenant", () => {
      it("importing with the wrong tenantId is rejected", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const seeded = await seedReadyForImport(A, L1, U1);
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant: "worker-import-test",
            expectedVersion: seeded.version,
            tenantId: B,
          })
        ).rejects.toMatchObject({ code: "unauthorised" });
      });
    });
  }
);
