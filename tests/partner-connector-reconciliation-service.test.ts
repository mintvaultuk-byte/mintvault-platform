/**
 * Trusted Intake Connector — Phase G3E: consistency inspector + reconciliation engine proof
 * (disposable Postgres, realistic non-superuser role model, real connections — not mocks). Mirrors
 * tests/partner-connector-import-service.test.ts's (G3) setup pattern, extended to migration 0011.
 *
 * Runs ONLY when PARTNER_CONNECTOR_RECON_RT_ADMIN + PARTNER_CONNECTOR_RECON_RT_URL are set:
 *   PARTNER_CONNECTOR_RECON_RT_ADMIN=postgresql://postgres@127.0.0.1:5630/dispo \
 *   PARTNER_CONNECTOR_RECON_RT_URL=postgresql://partner_connector_recon_test:synthetic@127.0.0.1:5630/dispo \
 *   npx vitest run tests/partner-connector-reconciliation-service.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_G3F,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_CONNECTOR_RECON_RT_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_RECON_RT_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-5000-0000-0000-000000000001";
const L1 = "10000000-5000-0000-0000-0000000000c1";
const U1 = "11111111-5000-0000-0000-0000000000a1";

let admin: Client;
let seq = 0;
const uuid = (n: number) => `50000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

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
  await admin.query("ALTER TABLE users OWNER TO pn_migrator");
  await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
  await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
}

async function seedTenant(tenantId: string, locationId: string, userId: string, ref: string): Promise<void> {
  await admin.query(
    "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,$2,$2,'ACTIVE') ON CONFLICT DO NOTHING",
    [tenantId, ref]
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
  claimant: string;
}

async function seedReadyForImport(opts: { cardCount?: number; claimant?: string } = {}): Promise<SeedResult> {
  seq += 1;
  const subId = uuid(seq);
  const custId = uuid(seq + 100_000);
  const claimant = opts.claimant ?? `worker-recon-${seq}`;
  await admin.query("INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,$3,$4)", [
    custId,
    A,
    `Customer ${seq}`,
    `customer${seq}@example.com`,
  ]);
  const cardCount = opts.cardCount ?? 1;
  await admin.query(
    `INSERT INTO partner_submissions
       (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
     VALUES ($1,$2,$3,$4,$5,'standard',$6,$7,'submitted_to_mintvault')`,
    [subId, A, L1, U1, custId, 1500 * cardCount, cardCount]
  );
  for (let i = 1; i <= (opts.cardCount ?? 1); i++) {
    await admin.query(
      `INSERT INTO partner_submission_cards
         (tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, declared_value_pence, quantity)
       VALUES ($1,$2,$3,$4,'pokemon','Base Set','4/102',1999,50000,1)`,
      [A, subId, i, `Card ${i}`]
    );
  }
  const h = await admin.query(
    "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
    [A, subId]
  );
  const handoffId = h.rows[0].id;

  const svc = await import("../server/partner/connector-service");
  const validation = await import("../server/partner/connector-validation-service");

  let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId });
  rec = await svc.claimConnectorRecord(rec.id, claimant, 300, A);
  rec = await svc.transitionConnectorState({
    connectorId: rec.id,
    claimant,
    tenantId: A,
    expectedVersion: rec.version,
    toState: "validating",
    eventType: "validating",
  });
  const run = await validation.validateConnectorRecord({
    connectorId: rec.id,
    claimant,
    expectedVersion: rec.version,
    tenantId: A,
  });
  expect(run.outcome).toBe("valid");

  const { rows } = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [rec.id]);
  return {
    connectorId: rec.id,
    version: rows[0].version,
    submissionId: subId,
    customerId: custId,
    handoffId,
    claimant,
  };
}

async function seedImportedConnector(): Promise<{
  connectorId: string;
  destinationSubmissionId: number;
  claimant: string;
}> {
  const importer = await import("../server/partner/connector-import-service");
  const seeded = await seedReadyForImport();
  const result = await importer.importValidatedConnector({
    connectorId: seeded.connectorId,
    claimant: seeded.claimant,
    expectedVersion: seeded.version,
    tenantId: A,
  });
  expect(result.outcome).toBe("imported");
  return {
    connectorId: seeded.connectorId,
    destinationSubmissionId: result.destinationSubmissionId!,
    claimant: seeded.claimant,
  };
}

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector G3E — reconciliation engine (disposable DB, real connections)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
      await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
      await provisionRealisticRoles(admin);
      await seedMintVaultTables();
      await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_G3F);

      await admin.query("DROP ROLE IF EXISTS partner_connector_recon_test").catch(() => {});
      await admin.query("CREATE ROLE partner_connector_recon_test LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_connector_runtime TO partner_connector_recon_test");

      await admin.query("DROP ROLE IF EXISTS partner_recon_test_conn").catch(() => {});
      await admin.query("CREATE ROLE partner_recon_test_conn LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_runtime TO partner_recon_test_conn");

      process.env.PARTNER_CONNECTOR_DATABASE_URL = CONNECTOR_URL;
      const runtimeUrlForFlags = new URL(CONNECTOR_URL!);
      runtimeUrlForFlags.username = "partner_recon_test_conn";
      runtimeUrlForFlags.password = "synthetic";
      process.env.PARTNER_DATABASE_URL = runtimeUrlForFlags.toString();

      await seedTenant(A, L1, U1, "reconA");
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

    describe("inspectors — consistent cases report no issues", () => {
      it("a fresh ready_for_import connector has zero issues", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        const report = await recon.inspectConnectorConsistency(seeded.connectorId);
        expect(report.issues).toEqual([]);
      });

      it("a normally-imported connector has zero issues", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId } = await seedImportedConnector();
        const report = await recon.inspectConnectorConsistency(connectorId);
        expect(report.issues).toEqual([]);
      });
    });

    describe("inspectors — detect forced corruption", () => {
      it("detects a completed mapping whose destination was deleted", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId, destinationSubmissionId } = await seedImportedConnector();
        await admin.query("DELETE FROM submission_items WHERE submission_id = $1", [destinationSubmissionId]);
        await admin.query("DELETE FROM submissions WHERE id = $1", [destinationSubmissionId]);
        const issues = await recon.inspectImportMapping(connectorId);
        expect(issues.some((i) => i.code === "destination_missing")).toBe(true);
        const report = await recon.inspectConnectorConsistency(connectorId);
        expect(report.issues.some((i) => i.code === "destination_missing")).toBe(true);
      });

      it("detects a connector marked imported with no mapping row (forced corruption)", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query("UPDATE partner_connector_records SET state = 'imported' WHERE id = $1", [
          seeded.connectorId,
        ]);
        const report = await recon.inspectConnectorConsistency(seeded.connectorId);
        expect(report.issues.some((i) => i.code === "mapping_missing")).toBe(true);
      });

      it("detects a connector marked imported with no matching event (evidence gap)", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId } = await seedImportedConnector();
        await admin.query(
          "DELETE FROM partner_connector_events WHERE connector_record_id = $1 AND to_state = 'imported'",
          [connectorId]
        );
        const issues = await recon.inspectConnectorEvidence(connectorId);
        expect(issues.some((i) => i.code === "corrupt_lineage")).toBe(true);
      });

      it("detects an expired claim on a ready_for_import record", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query(
          "UPDATE partner_connector_records SET claim_expires_at = now() - interval '1 hour' WHERE id = $1",
          [seeded.connectorId]
        );
        const report = await recon.inspectConnectorConsistency(seeded.connectorId);
        expect(report.issues.some((i) => i.code === "claim_expired")).toBe(true);
      });

      it("detects a stale reservation (forced: reserved row older than the threshold)", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query(
          `INSERT INTO partner_connector_imports
             (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
              validation_run_id, source_fingerprint, source_fingerprint_version, state, reserved_at)
           SELECT $1, $2, $3, r.partner_submission_id, r.handoff_id, v.id, v.source_fingerprint, v.source_fingerprint_version, 'reserved', now() - interval '2 hours'
             FROM partner_connector_records r
             JOIN partner_connector_validation_runs v ON v.connector_record_id = r.id
            WHERE r.id = $1 ORDER BY v.created_at DESC LIMIT 1`,
          [seeded.connectorId, A, L1]
        );
        const issues = await recon.inspectImportMapping(seeded.connectorId);
        expect(issues.some((i) => i.code === "import_interrupted")).toBe(true);
      });

      it("detects a stale fingerprint via a fresh recompute (no import attempted)", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query("UPDATE partner_customers SET full_name = 'Edited For Recon Test' WHERE id = $1", [
          seeded.customerId,
        ]);
        const issues = await recon.inspectValidationChain(seeded.connectorId);
        expect(issues.some((i) => i.code === "stale_fingerprint")).toBe(true);
      });
    });

    describe("sweepConnectorLineageIntegrity — global invariant sweep", () => {
      it("reports zero duplicates in normal operation", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        await seedImportedConnector();
        const dupes = await recon.sweepConnectorLineageIntegrity();
        expect(dupes).toEqual([]);
      });

      it("detects a duplicate mapping row if the UNIQUE constraint is bypassed (forced corruption, superuser only)", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId } = await seedImportedConnector();
        await admin.query(
          "ALTER TABLE partner_connector_imports DROP CONSTRAINT uq_partner_connector_imports_connector"
        );
        await admin.query("ALTER TABLE partner_connector_imports DROP CONSTRAINT uq_partner_connector_imports_handoff");
        await admin.query(
          "ALTER TABLE partner_connector_imports DROP CONSTRAINT uq_partner_connector_imports_submission"
        );
        try {
          const existing = await admin.query("SELECT * FROM partner_connector_imports WHERE connector_record_id = $1", [
            connectorId,
          ]);
          const row = existing.rows[0];
          await admin.query(
            `INSERT INTO partner_connector_imports
               (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
                validation_run_id, source_fingerprint, source_fingerprint_version, state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed')`,
            [
              row.connector_record_id,
              row.partner_organisation_id,
              row.partner_location_id,
              row.partner_submission_id,
              row.partner_handoff_id,
              row.validation_run_id,
              row.source_fingerprint,
              row.source_fingerprint_version,
            ]
          );
          const dupes = await recon.sweepConnectorLineageIntegrity();
          expect(dupes.some((d) => d.kind === "mapping_duplicate" && d.key === connectorId)).toBe(true);
        } finally {
          await admin.query(
            "DELETE FROM partner_connector_imports WHERE connector_record_id = $1 AND state = 'failed'",
            [connectorId]
          );
          await admin.query(
            "ALTER TABLE partner_connector_imports ADD CONSTRAINT uq_partner_connector_imports_connector UNIQUE (connector_record_id)"
          );
          await admin.query(
            "ALTER TABLE partner_connector_imports ADD CONSTRAINT uq_partner_connector_imports_handoff UNIQUE (partner_handoff_id)"
          );
          await admin.query(
            "ALTER TABLE partner_connector_imports ADD CONSTRAINT uq_partner_connector_imports_submission UNIQUE (partner_submission_id)"
          );
        }
      });
    });

    describe("completeFromExistingDestination — the one safe auto-repair", () => {
      it("writes the missing 'imported' event and requires actor+reason", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId, destinationSubmissionId } = await seedImportedConnector();
        await admin.query(
          "DELETE FROM partner_connector_events WHERE connector_record_id = $1 AND to_state = 'imported'",
          [connectorId]
        );

        await expect(
          recon.completeFromExistingDestination({ connectorId, actorId: "", reason: "test" })
        ).rejects.toMatchObject({
          code: "manual_review_required",
        });

        const result = await recon.completeFromExistingDestination({
          connectorId,
          actorId: "ops-1",
          reason: "evidence gap repair",
        });
        expect(result.destinationSubmissionId).toBe(destinationSubmissionId);

        const events = await admin.query(
          "SELECT event_type, actor_id FROM partner_connector_events WHERE connector_record_id = $1 AND to_state = 'imported' ORDER BY created_at DESC LIMIT 1",
          [connectorId]
        );
        expect(events.rows[0]).toMatchObject({
          event_type: "reconciliation_completed_from_existing",
          actor_id: "ops-1",
        });
      });
    });

    describe("recoverExpiredImportClaim — the real fix", () => {
      it("reclaims an expired ready_for_import lease and preserves state (does not downgrade to claimed)", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query(
          "UPDATE partner_connector_records SET claim_expires_at = now() - interval '1 hour' WHERE id = $1",
          [seeded.connectorId]
        );

        await recon.recoverExpiredImportClaim({
          connectorId: seeded.connectorId,
          claimant: "worker-recovery",
          actorId: "ops-2",
          reason: "original worker died before importing",
          tenantId: A,
        });

        const { rows } = await admin.query(
          "SELECT state, claimed_by, version FROM partner_connector_records WHERE id = $1",
          [seeded.connectorId]
        );
        expect(rows[0].state).toBe("ready_for_import");
        expect(rows[0].claimed_by).toBe("worker-recovery");

        // The new claimant can now import directly, without redoing validation.
        const importer = await import("../server/partner/connector-import-service");
        const result = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: "worker-recovery",
          expectedVersion: rows[0].version,
          tenantId: A,
        });
        expect(result.outcome).toBe("imported");
      });

      it("without the fix, an expired ready_for_import claim would have been permanently unclaimable — proven by asserting the old claimant cannot import after a DIFFERENT worker reclaims it", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query(
          "UPDATE partner_connector_records SET claim_expires_at = now() - interval '1 hour' WHERE id = $1",
          [seeded.connectorId]
        );
        await recon.recoverExpiredImportClaim({
          connectorId: seeded.connectorId,
          claimant: "worker-b",
          actorId: "ops-3",
          reason: "reclaim",
          tenantId: A,
        });

        const importer = await import("../server/partner/connector-import-service");
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant: seeded.claimant,
            expectedVersion: seeded.version,
            tenantId: A,
          })
        ).rejects.toMatchObject({ code: "import_claimant_mismatch" });
      });
    });

    describe("recoverReservedImport — resumes a stale reservation in place", () => {
      it("completes a corrupted stale 'reserved' mapping without creating a second destination", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query(
          `INSERT INTO partner_connector_imports
             (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
              validation_run_id, source_fingerprint, source_fingerprint_version, state, reserved_at)
           SELECT $1, $2, $3, r.partner_submission_id, r.handoff_id, v.id, v.source_fingerprint, v.source_fingerprint_version, 'reserved', now() - interval '2 hours'
             FROM partner_connector_records r
             JOIN partner_connector_validation_runs v ON v.connector_record_id = r.id
            WHERE r.id = $1 ORDER BY v.created_at DESC LIMIT 1`,
          [seeded.connectorId, A, L1]
        );

        const outcome = await recon.recoverReservedImport({
          connectorId: seeded.connectorId,
          claimant: seeded.claimant,
          expectedVersion: seeded.version,
          actorId: "ops-4",
          reason: "stale reservation from a simulated crash",
          tenantId: A,
        });
        expect(outcome.outcome).toBe("imported");

        const mappingCount = await admin.query(
          "SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = $1",
          [seeded.connectorId]
        );
        expect(mappingCount.rows[0].n).toBe(1);
        const submissionCount = await admin.query("SELECT count(*)::int AS n FROM submissions WHERE id = $1", [
          outcome.destinationSubmissionId,
        ]);
        expect(submissionCount.rows[0].n).toBe(1);
      });
    });

    describe("recoverInterruptedImport", () => {
      it("is a safe, audited retry that returns the same destination on a duplicate call", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        const first = await recon.recoverInterruptedImport({
          connectorId: seeded.connectorId,
          claimant: seeded.claimant,
          expectedVersion: seeded.version,
          actorId: "ops-5",
          reason: "caller never saw the response",
          tenantId: A,
        });
        expect(first.outcome).toBe("imported");
        const second = await recon.recoverInterruptedImport({
          connectorId: seeded.connectorId,
          claimant: seeded.claimant,
          expectedVersion: seeded.version,
          actorId: "ops-5",
          reason: "retry again",
          tenantId: A,
        });
        expect(second.outcome).toBe("already_completed");
        expect(second.destinationSubmissionId).toBe(first.destinationSubmissionId);
      });
    });

    describe("manual review — markManualReview / resolveManualReview / acknowledgePermanentFailure", () => {
      it("markManualReview from ready_for_import hops through reconciliation_required and writes both events", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await recon.markManualReview({
          connectorId: seeded.connectorId,
          actorId: "ops-6",
          reason: "ambiguous corruption detected",
        });

        const { rows } = await admin.query("SELECT state FROM partner_connector_records WHERE id = $1", [
          seeded.connectorId,
        ]);
        expect(rows[0].state).toBe("manual_review");

        const events = await admin.query(
          "SELECT event_type, to_state FROM partner_connector_events WHERE connector_record_id = $1 ORDER BY created_at",
          [seeded.connectorId]
        );
        const tail = events.rows.slice(-2);
        expect(tail.map((e) => e.to_state)).toEqual(["reconciliation_required", "manual_review"]);
      });

      it("resolveManualReview('retry') returns the record to queued and clears the claim", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await recon.markManualReview({ connectorId: seeded.connectorId, actorId: "ops-7", reason: "escalate" });
        const { rows: before } = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [
          seeded.connectorId,
        ]);

        await recon.resolveManualReview({
          connectorId: seeded.connectorId,
          actorId: "ops-7",
          reason: "resubmitted by partner",
          resolution: "retry",
          expectedVersion: before[0].version,
        });
        const { rows } = await admin.query("SELECT state, claimed_by FROM partner_connector_records WHERE id = $1", [
          seeded.connectorId,
        ]);
        expect(rows[0].state).toBe("queued");
        expect(rows[0].claimed_by).toBeNull();
      });

      it("resolveManualReview('cancel') is terminal", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await recon.markManualReview({ connectorId: seeded.connectorId, actorId: "ops-8", reason: "escalate" });
        const { rows: before } = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [
          seeded.connectorId,
        ]);

        await recon.resolveManualReview({
          connectorId: seeded.connectorId,
          actorId: "ops-8",
          reason: "abandoned by partner",
          resolution: "cancel",
          expectedVersion: before[0].version,
        });
        const { rows } = await admin.query("SELECT state FROM partner_connector_records WHERE id = $1", [
          seeded.connectorId,
        ]);
        expect(rows[0].state).toBe("cancelled");
      });

      it("acknowledgePermanentFailure moves a failed record to cancelled with the reason recorded", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const svc = await import("../server/partner/connector-service");
        const seeded = await seedReadyForImport();
        // Drive it to 'failed' via the normal G1/G2 path (ready_for_import -> validating -> failed;
        // 'failed' is not a legal direct exit from ready_for_import).
        const validating = await svc.transitionConnectorState({
          connectorId: seeded.connectorId,
          claimant: seeded.claimant,
          tenantId: A,
          expectedVersion: seeded.version,
          toState: "validating",
          eventType: "validating",
        });
        const rec = await svc.recordConnectorFailure({
          connectorId: seeded.connectorId,
          claimant: seeded.claimant,
          tenantId: A,
          expectedVersion: validating.version,
          errorCategory: "test",
          errorCode: "forced_failure",
          retryable: false,
        });

        await recon.acknowledgePermanentFailure({
          connectorId: seeded.connectorId,
          actorId: "ops-9",
          reason: "source submission permanently unrecoverable",
          expectedVersion: rec.version,
          tenantId: A,
        });
        const { rows } = await admin.query("SELECT state FROM partner_connector_records WHERE id = $1", [
          seeded.connectorId,
        ]);
        expect(rows[0].state).toBe("cancelled");

        const ev = await admin.query(
          "SELECT metadata FROM partner_connector_events WHERE connector_record_id = $1 AND event_type = 'reconciliation_permanent_failure_acknowledged'",
          [seeded.connectorId]
        );
        expect(ev.rows[0].metadata.reason).toBe("source submission permanently unrecoverable");
      });
    });

    describe("reconcileConnector — orchestrator", () => {
      it("a consistent connector is a no-op (no mutation, no event)", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId } = await seedImportedConnector();
        const before = await admin.query(
          "SELECT count(*)::int AS n FROM partner_connector_events WHERE connector_record_id = $1",
          [connectorId]
        );

        const result = await recon.reconcileConnector({
          connectorId,
          actorId: "ops-10",
          reason: "routine sweep",
          tenantId: A,
        });
        expect(result.action).toBe("none");

        const after = await admin.query(
          "SELECT count(*)::int AS n FROM partner_connector_events WHERE connector_record_id = $1",
          [connectorId]
        );
        expect(after.rows[0].n).toBe(before.rows[0].n);
      });

      it("auto-repairs an evidence-only gap via completeFromExistingDestination", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId } = await seedImportedConnector();
        await admin.query(
          "DELETE FROM partner_connector_events WHERE connector_record_id = $1 AND to_state = 'imported'",
          [connectorId]
        );

        const result = await recon.reconcileConnector({
          connectorId,
          actorId: "ops-11",
          reason: "routine sweep",
          tenantId: A,
        });
        expect(result.action).toBe("completed_from_existing");
      });

      it("escalates genuine corruption (destination deleted) to manual_review — flags the MAPPING, never un-terminals the imported connector", async () => {
        const recon = await import("../server/partner/connector-reconciliation-service");
        const { connectorId, destinationSubmissionId } = await seedImportedConnector();
        await admin.query("DELETE FROM submission_items WHERE submission_id = $1", [destinationSubmissionId]);
        await admin.query("DELETE FROM submissions WHERE id = $1", [destinationSubmissionId]);

        const result = await recon.reconcileConnector({
          connectorId,
          actorId: "ops-12",
          reason: "corruption sweep",
          tenantId: A,
        });
        expect(result.action).toBe("marked_manual_review");

        // 'imported' is terminal and must never change, even when corruption is found.
        const { rows } = await admin.query("SELECT state FROM partner_connector_records WHERE id = $1", [connectorId]);
        expect(rows[0].state).toBe("imported");

        // The MAPPING is what actually gets flagged.
        const mapping = await admin.query(
          "SELECT state, last_safe_error_code FROM partner_connector_imports WHERE connector_record_id = $1",
          [connectorId]
        );
        expect(mapping.rows[0]).toMatchObject({
          state: "reconciliation_required",
          last_safe_error_code: "corrupt_lineage",
        });
      });
    });

    describe("never creates a duplicate destination across recovery paths", () => {
      it("recoverReservedImport followed by a normal retry still yields exactly one submission", async () => {
        const importer = await import("../server/partner/connector-import-service");
        const recon = await import("../server/partner/connector-reconciliation-service");
        const seeded = await seedReadyForImport();
        await admin.query(
          `INSERT INTO partner_connector_imports
             (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
              validation_run_id, source_fingerprint, source_fingerprint_version, state, reserved_at)
           SELECT $1, $2, $3, r.partner_submission_id, r.handoff_id, v.id, v.source_fingerprint, v.source_fingerprint_version, 'reserved', now() - interval '2 hours'
             FROM partner_connector_records r
             JOIN partner_connector_validation_runs v ON v.connector_record_id = r.id
            WHERE r.id = $1 ORDER BY v.created_at DESC LIMIT 1`,
          [seeded.connectorId, A, L1]
        );
        const recovered = await recon.recoverReservedImport({
          connectorId: seeded.connectorId,
          claimant: seeded.claimant,
          expectedVersion: seeded.version,
          actorId: "ops-13",
          reason: "recover",
          tenantId: A,
        });
        const retried = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant: seeded.claimant,
          expectedVersion: seeded.version,
          tenantId: A,
        });
        expect(retried.outcome).toBe("already_completed");
        expect(retried.destinationSubmissionId).toBe(recovered.destinationSubmissionId);
        const submissionCount = await admin.query("SELECT count(*)::int AS n FROM submissions WHERE id = $1", [
          recovered.destinationSubmissionId,
        ]);
        expect(submissionCount.rows[0].n).toBe(1);
      });
    });
  }
);
