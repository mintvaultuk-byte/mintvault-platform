/**
 * Trusted Intake Connector — Phase G2: validation engine, staleness, lease-renewal, and immutability
 * proof (disposable Postgres, realistic non-superuser role model, real connections — not mocks).
 *
 * Runs ONLY when PARTNER_CONNECTOR_VALIDATION_RT_ADMIN + PARTNER_CONNECTOR_VALIDATION_RT_URL are set:
 *   PARTNER_CONNECTOR_VALIDATION_RT_ADMIN=postgresql://postgres@127.0.0.1:5592/dispo \
 *   PARTNER_CONNECTOR_VALIDATION_RT_URL=postgresql://partner_connector_val_app_test:synthetic@127.0.0.1:5592/dispo \
 *   npx vitest run tests/partner-connector-validation-service.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import { applyMigrationsRealistic, pinAccountingTopologyTo } from "./helpers/partner-realistic-db";

vi.mock("../server/r2", () => ({
  headR2: vi.fn(async () => ({
    lastModified: new Date("2026-08-05T00:00:00.000Z"),
    contentLength: 1024,
    contentType: "image/jpeg",
    eTag: '"validation-fixture"',
  })),
}));

const ADMIN = process.env.PARTNER_CONNECTOR_VALIDATION_RT_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_VALIDATION_RT_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-4000-0000-0000-000000000001";
const B = "bbbbbbbb-4000-0000-0000-000000000002";
const L1 = "10000000-4000-0000-0000-0000000000c1";
const LB = "20000000-4000-0000-0000-0000000000d1";
const U1 = "11111111-4000-0000-0000-0000000000a1";
const UB = "22222222-4000-0000-0000-0000000000b1";

let admin: Client;
let subCounter = 0;
let custCounter = 0;

async function seedTenant(tenantId: string, locationId: string, userId: string, ref: string): Promise<void> {
  await admin.query(
    "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,$2,$2,'ACTIVE')",
    [tenantId, ref]
  );
  await admin.query(
    "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,$2,$3,$3,'HQ','ACTIVE')",
    [locationId, ref + "-loc", tenantId]
  );
  await admin.query(
    "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES ($1,$2,$3,$3,$4,'x','ACTIVE',false)",
    [userId, ref + "-user", tenantId, `${ref}@example.com`]
  );
  await admin.query(
    "INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES ($1,'standard','Standard',2500,10,true) ON CONFLICT (tenant_id, tier_code) DO NOTHING",
    [tenantId]
  );
}

interface SeedOpts {
  customerId?: string | null;
  serviceTierCode?: string | null;
  estimatedPricePence?: number;
  cardCount?: number;
  submissionStatus?: string;
  cards?: { quantity?: number; declaredValuePence?: number | null; cardName?: string | null }[];
  handoffStatus?: "pending" | "applied" | "failed";
}

async function seedFullSubmission(tenantId: string, locationId: string, userId: string, opts: SeedOpts = {}) {
  custCounter += 1;
  let customerId = opts.customerId;
  if (customerId === undefined) {
    customerId = `40000000-0000-0000-0000-${String(custCounter).padStart(12, "0")}`;
    await admin.query(
      "INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,'Test Customer','customer@example.com')",
      [customerId, tenantId]
    );
  }

  subCounter += 1;
  const subId = `30000000-4000-0000-0000-${String(subCounter).padStart(12, "0")}`;
  const cards = opts.cards ?? [{ quantity: 1, declaredValuePence: 1000, cardName: "Test Card" }];
  const totalQuantity = cards.reduce((s, c) => s + (c.quantity ?? 1), 0);
  const tierCode = opts.serviceTierCode === undefined ? "standard" : opts.serviceTierCode;
  const estimatedPrice = opts.estimatedPricePence ?? (tierCode ? 2500 * totalQuantity : null);

  await admin.query(
    `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, status, customer_id, service_tier_code, estimated_price_pence, card_count, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      subId,
      tenantId,
      locationId,
      userId,
      opts.submissionStatus ?? "submitted_to_mintvault",
      customerId,
      tierCode,
      estimatedPrice,
      opts.cardCount ?? totalQuantity,
      `idem-${subId}`,
    ]
  );

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const cardId = `50000000-0000-0000-0000-${String(subCounter * 100 + i + 1).padStart(12, "0")}`;
    await admin.query(
      `INSERT INTO partner_submission_cards
         (id, tenant_id, submission_id, sequence_number, card_name, quantity, declared_value_pence, front_image_key, back_image_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        cardId,
        tenantId,
        subId,
        i + 1,
        c.cardName === undefined ? "Test Card" : c.cardName,
        c.quantity ?? 1,
        c.declaredValuePence === undefined ? 1000 : c.declaredValuePence,
        `partner-submissions/${tenantId}/${subId}/${cardId}/front-seed.jpg`,
        `partner-submissions/${tenantId}/${subId}/${cardId}/back-seed.jpg`,
      ]
    );
  }

  const h = await admin.query(
    `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,$3,'{}'::jsonb) RETURNING id`,
    [tenantId, subId, opts.handoffStatus ?? "pending"]
  );

  return { submissionId: subId, handoffId: h.rows[0].id as string, customerId };
}

async function claimAndStartValidating(
  svc: typeof import("../server/partner/connector-service"),
  connectorId: string,
  claimant: string
) {
  const claimed = await svc.claimConnectorRecord(connectorId, claimant);
  return svc.transitionConnectorState({
    connectorId,
    claimant,
    expectedVersion: claimed.version,
    toState: "validating",
    eventType: "validating",
  });
}

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector G2 — validation service (disposable DB, real connections)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      await admin.query("GRANT ALL ON SCHEMA public TO public");
      await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
      await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
      await applyMigrationsRealistic(admin, ADMIN!);

      await admin.query("DROP ROLE IF EXISTS partner_connector_val_app_test").catch(() => {});
      await admin.query("CREATE ROLE partner_connector_val_app_test LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_connector_runtime TO partner_connector_val_app_test");
      await admin.query("DROP ROLE IF EXISTS partner_val_test_conn").catch(() => {});
      await admin.query("CREATE ROLE partner_val_test_conn LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_runtime TO partner_val_test_conn");

      process.env.PARTNER_CONNECTOR_DATABASE_URL = CONNECTOR_URL;
      // CI pins MINTVAULT_DATABASE_URL globally to a DIFFERENT database; the G6D accounting
      // topology assertion in server/partner/db.ts then throws. Pin it to this suite's own.
      pinAccountingTopologyTo(CONNECTOR_URL);
      const runtimeUrlForFlags = new URL(CONNECTOR_URL!);
      runtimeUrlForFlags.username = "partner_val_test_conn";
      runtimeUrlForFlags.password = "synthetic";
      process.env.PARTNER_DATABASE_URL = runtimeUrlForFlags.toString();

      await seedTenant(A, L1, U1, "valA");
      await seedTenant(B, LB, UB, "valB");

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

    describe("valid source", () => {
      it("a fully valid submission produces outcome=valid and connector moves to ready_for_import", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.outcome).toBe("valid");
        expect(result.blockingErrorCount).toBe(0);
        const status = await svc.getConnectorStatus({ tenantId: A, connectorId: rec.id });
        expect(status?.state).toBe("ready_for_import");
      });
    });

    describe("blocking rule categories", () => {
      it("organisation_suspended blocks", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        await admin.query("UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1", [A]);
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.outcome).toBe("invalid");
        expect(result.findings.map((f) => f.code)).toContain("organisation_suspended");
        await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [A]);
      });

      it("location_inactive blocks", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        await admin.query("UPDATE partner_locations SET status='SUSPENDED' WHERE id=$1", [L1]);
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("location_inactive");
        await admin.query("UPDATE partner_locations SET status='ACTIVE' WHERE id=$1", [L1]);
      });

      it("submission_not_final blocks (draft submission)", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { submissionStatus: "draft" });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("submission_not_final");
      });

      it("customer_missing blocks when no customer is linked", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { customerId: null });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("customer_missing");
      });

      it("customer_invalid_email blocks a malformed email", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        custCounter += 1;
        const custId = `40000000-0000-0000-0000-${String(custCounter).padStart(12, "0")}`;
        await admin.query(
          "INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,'Bad Email','not-an-email')",
          [custId, A]
        );
        const { handoffId } = await seedFullSubmission(A, L1, U1, { customerId: custId });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("customer_invalid_email");
      });

      it("service_tier_missing blocks when no tier code is set", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { serviceTierCode: null, estimatedPricePence: null });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("service_tier_missing");
      });

      it("service_tier_inactive blocks", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        await admin.query(
          "INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES ($1,'disabled_tier','Disabled',1000,5,false)",
          [A]
        );
        const { handoffId } = await seedFullSubmission(A, L1, U1, {
          serviceTierCode: "disabled_tier",
          estimatedPricePence: 1000,
        });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("service_tier_inactive");
      });

      it("service_price_mismatch blocks when stored price doesn't match server recomputation", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { estimatedPricePence: 999999 });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("service_price_mismatch");
      });

      it("no_cards blocks an empty submission", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { cards: [], estimatedPricePence: 0, cardCount: 0 });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("no_cards");
      });

      it("card_invalid_quantity blocks a quantity above the validation ceiling (1001; the DB itself already forbids 0 or below via chk_partner_submission_cards_qty, so that boundary can never reach the validator at all)", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { cards: [{ quantity: 1001 }], cardCount: 1001 });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("card_invalid_quantity");
      });

      it("card_invalid_declared_value blocks a negative value", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { cards: [{ declaredValuePence: -100 }] });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("card_invalid_declared_value");
      });

      it("card_missing_required_field blocks a blank card name", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { cards: [{ cardName: "   " }] });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("card_missing_required_field");
      });

      it("totals_mismatch blocks when card_count doesn't match summed quantities", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { cardCount: 999 });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.findings.map((f) => f.code)).toContain("totals_mismatch");
      });

      it("submission_cancelled produces outcome=cancelled (not invalid)", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { submissionStatus: "cancelled" });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.outcome).toBe("cancelled");
        const status = await svc.getConnectorStatus({ tenantId: A, connectorId: rec.id });
        expect(status?.state).toBe("cancelled");
      });

      it("submission_superseded blocks when another live connector record already exists for the same submission (review finding: this code was documented as actively checked but had zero implementation)", async () => {
        // Two independent DB constraints already make this doubly impossible through any normal
        // path: partner_submission_handoffs.submission_id is UNIQUE (one handoff per submission,
        // ever), and partner_connector_records.handoff_id is UNIQUE (one connector record per
        // handoff). To exercise the defensive check at all, this test directly corrupts the
        // referential link — creating a genuinely separate submission+handoff+connector record,
        // then repointing its partner_submission_id at the FIRST submission via raw admin SQL — the
        // exact kind of state the check exists to catch if that invariant were ever broken upstream.
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { submissionId: submissionIdA, handoffId: handoffIdA } = await seedFullSubmission(A, L1, U1);
        const first = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffIdA });
        const { handoffId: handoffIdOther } = await seedFullSubmission(A, L1, U1);
        const second = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffIdOther });
        await admin.query("UPDATE partner_connector_records SET partner_submission_id=$1 WHERE id=$2", [
          submissionIdA,
          second.id,
        ]);

        const claimed = await claimAndStartValidating(svc, second.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: second.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.outcome).toBe("invalid");
        expect(result.findings.map((f) => f.code)).toContain("submission_superseded");
        void first;
        void submissionIdA;
      });
    });

    describe("immutability of findings and runs", () => {
      it("an invalid outcome appends no false 'valid' history — the connector transitions to rejected", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { cards: [] });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        const status = await svc.getConnectorStatus({ tenantId: A, connectorId: rec.id });
        expect(status?.state).toBe("rejected");
      });

      it("validation history is never destroyed by a revalidation", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const first = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(first.outcome).toBe("valid");

        const ready = await svc.getConnectorStatus({ tenantId: A, connectorId: rec.id });
        const recRow = await admin.query("SELECT version FROM partner_connector_records WHERE id=$1", [rec.id]);
        await val.requestConnectorRevalidation({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: recRow.rows[0].version,
        });
        const afterRevalReq = await admin.query("SELECT version FROM partner_connector_records WHERE id=$1", [rec.id]);
        const second = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: afterRevalReq.rows[0].version,
        });
        expect(second.outcome).toBe("valid");
        expect(second.id).not.toBe(first.id);

        const { rows } = await admin.query(
          "SELECT count(*)::int n FROM partner_connector_validation_runs WHERE connector_record_id=$1",
          [rec.id]
        );
        expect(rows[0].n).toBe(2); // both runs preserved, neither overwritten
        void ready;
      });
    });

    describe("staleness detection", () => {
      it("a card added between validations makes the next validation stale", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId, submissionId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const first = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(first.outcome).toBe("valid");

        // Mutate the source directly: addCard() itself does NOT bump partner_submissions.version (only
        // editSubmissionDraft does) — this manual UPDATE tests the version-mismatch detection path
        // deliberately, independent of whether any real draft-mutation function happens to trigger it.
        const extraCardId = "50000000-0000-0000-0000-000000009999";
        await admin.query(
          `INSERT INTO partner_submission_cards
             (id, tenant_id, submission_id, sequence_number, card_name, quantity, front_image_key, back_image_key)
           VALUES ($1,$2,$3,2,'Extra Card',1,$4,$5)`,
          [
            extraCardId,
            A,
            submissionId,
            `partner-submissions/${A}/${submissionId}/${extraCardId}/front-seed.jpg`,
            `partner-submissions/${A}/${submissionId}/${extraCardId}/back-seed.jpg`,
          ]
        );
        await admin.query(
          "UPDATE partner_submissions SET card_count = card_count + 1, version = version + 1 WHERE id=$1",
          [submissionId]
        );

        const recRow = await admin.query("SELECT version FROM partner_connector_records WHERE id=$1", [rec.id]);
        await val.requestConnectorRevalidation({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: recRow.rows[0].version,
        });
        const afterReval = await admin.query("SELECT version FROM partner_connector_records WHERE id=$1", [rec.id]);
        const second = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: afterReval.rows[0].version,
        });
        expect(second.outcome).toBe("stale");
        expect(second.findings.map((f) => f.code)).toContain("source_version_mismatch");
      });

      it("irrelevant metadata (no actual field change) does NOT cause false staleness on a fresh validation run against the same data", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const first = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(first.outcome).toBe("valid");

        const recRow = await admin.query("SELECT version FROM partner_connector_records WHERE id=$1", [rec.id]);
        await val.requestConnectorRevalidation({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: recRow.rows[0].version,
        });
        const afterReval = await admin.query("SELECT version FROM partner_connector_records WHERE id=$1", [rec.id]);
        const second = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: afterReval.rows[0].version,
        });
        expect(second.outcome).toBe("valid"); // not stale — nothing structural changed
      });
    });

    describe("revalidation", () => {
      it("revalidation is refused on a rejected (terminal) record", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1, { cards: [] });
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        const status = await svc.getConnectorStatus({ tenantId: A, connectorId: rec.id });
        expect(status?.state).toBe("rejected");
        const recRow = await admin.query("SELECT version FROM partner_connector_records WHERE id=$1", [rec.id]);
        await expect(
          val.requestConnectorRevalidation({
            connectorId: rec.id,
            claimant: "worker-1",
            expectedVersion: recRow.rows[0].version,
          })
        ).rejects.toMatchObject({ code: "invalid_state_transition" });
      });
    });

    describe("lease renewal (G2C)", () => {
      it("a validator can renew its own lease before it expires", async () => {
        const svc = await import("../server/partner/connector-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const renewed = await svc.renewConnectorClaimLease({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(renewed.state).toBe("validating");
        // >= not >: two back-to-back local operations can land on the same millisecond (both compute
        // now() + 300s independently) — the correctness property is "the renewal succeeded and set a
        // fresh expiry", not strict wall-clock ordering down to the millisecond.
        expect(new Date(renewed.claimExpiresAt!).getTime()).toBeGreaterThanOrEqual(
          new Date(claimed.claimExpiresAt!).getTime()
        );
        expect(renewed.version).toBeGreaterThan(claimed.version);
      });

      it("a non-claimant cannot renew someone else's lease", async () => {
        const svc = await import("../server/partner/connector-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        await expect(
          svc.renewConnectorClaimLease({ connectorId: rec.id, claimant: "worker-2", expectedVersion: claimed.version })
        ).rejects.toMatchObject({ code: "stale_claim" });
      });

      it("an expired lease cannot be renewed (must be reclaimed instead)", async () => {
        const svc = await import("../server/partner/connector-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await svc.claimConnectorRecord(rec.id, "worker-1", -1); // already-expired lease
        await expect(
          svc.renewConnectorClaimLease({ connectorId: rec.id, claimant: "worker-1", expectedVersion: claimed.version })
        ).rejects.toMatchObject({ code: "stale_claim" });
      });

      it("an expired VALIDATING lease is recoverable — the exact G1-documented gap G2C closes (previously only 'claimed' leases were ever treated as reclaimable)", async () => {
        const svc = await import("../server/partner/connector-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await svc.claimConnectorRecord(rec.id, "worker-1", -1); // already-expired lease
        const validating = await svc.transitionConnectorState({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
          toState: "validating",
          eventType: "validating",
        });
        expect(validating.state).toBe("validating");
        // A second worker must be able to reclaim this — this exact case threw "already_claimed" before
        // the fix, because claimability only ever checked state === 'claimed', never 'validating'.
        const reclaimed = await svc.claimConnectorRecord(rec.id, "worker-2");
        expect(reclaimed.claimedBy).toBe("worker-2");
        expect(reclaimed.state).toBe("claimed"); // reset to claimed, not inherited mid-validation state
      });

      it("a stale validator (lease expired, reclaimed by another worker) cannot commit a validation result", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await svc.claimConnectorRecord(rec.id, "worker-1", -1);
        await svc.transitionConnectorState({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
          toState: "validating",
          eventType: "validating",
        });
        // worker-2 reclaims the now-expired lease.
        const reclaimed = await svc.claimConnectorRecord(rec.id, "worker-2");
        // worker-1 (stale) tries to validate using its OLD version. The reclaim already reset the
        // record to 'claimed' (not 'validating'), so this fails on the state precondition rather than
        // the claimant/version one — either way, worker-1's stale attempt cannot succeed.
        await expect(
          val.validateConnectorRecord({ connectorId: rec.id, claimant: "worker-1", expectedVersion: claimed.version })
        ).rejects.toMatchObject({ code: "invalid_state_transition" });
        void reclaimed;
      });

      it("crash before validation commit leaves no completed validation run", async () => {
        const svc = await import("../server/partner/connector-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await svc.claimConnectorRecord(rec.id, "worker-1");
        await svc.transitionConnectorState({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
          toState: "validating",
          eventType: "validating",
        });
        // Simulate a crash: no validateConnectorRecord call is ever made — connector stays validating.
        const status = await svc.getConnectorStatus({ tenantId: A, connectorId: rec.id });
        expect(status?.state).toBe("validating");
        const { rows } = await admin.query(
          "SELECT count(*)::int n FROM partner_connector_validation_runs WHERE connector_record_id=$1 AND completed_at IS NOT NULL",
          [rec.id]
        );
        expect(rows[0].n).toBe(0);
      });
    });

    describe("flags and trust boundary", () => {
      it("validateConnectorRecord fails closed when the connector flag is OFF", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        await admin.query(
          "UPDATE partner_feature_flags SET enabled=false WHERE flag='partner_connector_enabled' AND tenant_id IS NULL"
        );
        await expect(
          val.validateConnectorRecord({ connectorId: rec.id, claimant: "worker-1", expectedVersion: claimed.version })
        ).rejects.toMatchObject({ code: "feature_disabled" });
        await admin.query(
          "UPDATE partner_feature_flags SET enabled=true WHERE flag='partner_connector_enabled' AND tenant_id IS NULL"
        );
      });

      it("a tenant mismatch on validateConnectorRecord is rejected as unauthorised", async () => {
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId } = await seedFullSubmission(A, L1, U1);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        await expect(
          val.validateConnectorRecord({
            connectorId: rec.id,
            claimant: "worker-1",
            expectedVersion: claimed.version,
            tenantId: B,
          })
        ).rejects.toMatchObject({ code: "unauthorised" });
      });

      it("partner_connector_runtime cannot UPDATE or DELETE a validation run or finding (append-only, enforced at the DB level)", async () => {
        const runtimeUrl = new URL(CONNECTOR_URL!);
        const client = new Client({ connectionString: runtimeUrl.toString() });
        await client.connect();
        try {
          await expect(
            client.query("UPDATE partner_connector_validation_runs SET outcome='valid' WHERE true")
          ).rejects.toMatchObject({ code: "42501" });
          await expect(client.query("DELETE FROM partner_connector_validation_runs WHERE true")).rejects.toMatchObject({
            code: "42501",
          });
          await expect(
            client.query("UPDATE partner_connector_validation_findings SET code='x' WHERE true")
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            client.query("DELETE FROM partner_connector_validation_findings WHERE true")
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.end();
        }
      });

      it("partner_runtime (Partner-facing role) cannot read any validation run or finding", async () => {
        const runtimeUrl = new URL(CONNECTOR_URL!);
        runtimeUrl.username = "partner_val_test_conn";
        runtimeUrl.password = "synthetic";
        const client = new Client({ connectionString: runtimeUrl.toString() });
        await client.connect();
        try {
          await expect(client.query("SELECT * FROM partner_connector_validation_runs LIMIT 1")).rejects.toMatchObject({
            code: "42501",
          });
          await expect(
            client.query("SELECT * FROM partner_connector_validation_findings LIMIT 1")
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.end();
        }
      });
    });

    describe("cross-tenant isolation", () => {
      it("a card whose tenant_id is corrupted to another tenant is invisible to the validator (RLS, not the app-layer check, is the actual enforcement)", async () => {
        // RLS on partner_submission_cards (FORCE ROW LEVEL SECURITY, migration 0007) means a row
        // whose real tenant_id no longer matches the validating transaction's app.tenant_id GUC is
        // filtered out at the DATABASE level before the validation engine's own card_tenant_mismatch
        // check could ever see it — so the observable outcome here is "no_cards" (the corrupted card
        // vanished from the result set), not "card_tenant_mismatch" (which exists purely as defence
        // in depth for a scenario RLS already makes structurally unreachable through this table).
        const svc = await import("../server/partner/connector-service");
        const val = await import("../server/partner/connector-validation-service");
        const { handoffId, submissionId } = await seedFullSubmission(A, L1, U1);
        await admin.query("UPDATE partner_submission_cards SET tenant_id=$1 WHERE submission_id=$2", [B, submissionId]);
        const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
        const claimed = await claimAndStartValidating(svc, rec.id, "worker-1");
        const result = await val.validateConnectorRecord({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        });
        expect(result.outcome).toBe("invalid");
        expect(result.findings.map((f) => f.code)).toContain("no_cards");
        // Also proves totals_mismatch fires (card_count still says 1, but zero cards are now visible).
        expect(result.findings.map((f) => f.code)).toContain("totals_mismatch");
      });
    });
  }
);
