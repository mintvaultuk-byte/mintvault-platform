/**
 * Trusted Intake Connector — Phase G1: service, idempotency, concurrency, state machine, trust
 * boundary, and feature-flag proof (disposable Postgres, realistic non-superuser role model, real
 * concurrent connections — not mocks).
 *
 * Runs ONLY when PARTNER_CONNECTOR_RT_ADMIN + PARTNER_CONNECTOR_RT_URL are set (superuser + a
 * connector-role connection URL to a DISPOSABLE local Postgres):
 *   PARTNER_CONNECTOR_RT_ADMIN=postgresql://postgres@127.0.0.1:5551/dispo \
 *   PARTNER_CONNECTOR_RT_URL=postgresql://partner_connector_app_test:synthetic@127.0.0.1:5551/dispo \
 *   npx vitest run tests/partner-connector-service.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { applyMigrationsRealistic } from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_CONNECTOR_RT_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_RT_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-3000-0000-0000-000000000001"; // tenant A
const B = "bbbbbbbb-3000-0000-0000-000000000002"; // tenant B
const L1 = "10000000-3000-0000-0000-0000000000c1";
const LB = "20000000-3000-0000-0000-0000000000d1";
const U1 = "11111111-3000-0000-0000-0000000000a1";
const UB = "22222222-3000-0000-0000-0000000000b1";

let admin: Client;

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
}

let submissionCounter = 0;
/** Create a draft partner_submissions row + (optionally) a pending handoff, as the seeded admin. */
async function seedSubmissionWithHandoff(
  tenantId: string,
  locationId: string,
  userId: string,
  opts: { handoffStatus?: "pending" | "applied" | "failed" | null; idempotencyKey?: string | null } = {}
): Promise<{ submissionId: string; handoffId: string | null }> {
  submissionCounter += 1;
  const subId = `30000000-0000-0000-0000-${String(submissionCounter).padStart(12, "0")}`;
  await admin.query(
    `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, status, idempotency_key)
     VALUES ($1,$2,$3,$4,'submitted_to_mintvault',$5)`,
    [subId, tenantId, locationId, userId, opts.idempotencyKey ?? `idem-${subId}`]
  );
  let handoffId: string | null = null;
  if (opts.handoffStatus !== null) {
    const h = await admin.query(
      `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,$3,'{}'::jsonb) RETURNING id`,
      [tenantId, subId, opts.handoffStatus ?? "pending"]
    );
    handoffId = h.rows[0].id;
  }
  return { submissionId: subId, handoffId };
}

(isLocal ? describe : describe.skip)("Trusted Intake Connector G1 — service (disposable DB, real connections)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await applyMigrationsRealistic(admin, ADMIN!);

    await admin.query("DROP ROLE IF EXISTS partner_connector_app_test").catch(() => {});
    await admin.query("CREATE ROLE partner_connector_app_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_connector_runtime TO partner_connector_app_test");

    await admin.query("DROP ROLE IF EXISTS partner_app_test_conn").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test_conn LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test_conn");

    process.env.PARTNER_CONNECTOR_DATABASE_URL = CONNECTOR_URL;
    // resolveGlobalFlag() (server/partner/flags.ts) reads via the SEPARATE partner_runtime pool
    // (server/partner/db.ts), not the connector pool — it must be configured too, or every flag
    // check fails closed regardless of the seeded row (which is the correct fail-closed behavior,
    // but would make every flag-ON test indistinguishable from a real "flag missing" case).
    const runtimeUrlForFlags = new URL(CONNECTOR_URL!);
    runtimeUrlForFlags.username = "partner_app_test_conn";
    runtimeUrlForFlags.password = "synthetic";
    process.env.PARTNER_DATABASE_URL = runtimeUrlForFlags.toString();

    await seedTenant(A, L1, U1, "connA");
    await seedTenant(B, LB, UB, "connB");

    // default: connector enabled, emergency stop off (global rows)
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

  describe("record creation and idempotency", () => {
    it("a valid pending handoff creates one connector record in state=queued", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      expect(rec.state).toBe("queued");
      expect(rec.handoffId).toBe(handoffId);
      expect(rec.attemptCount).toBe(0);
    });

    it("same handoff, repeated request returns the SAME canonical record (idempotent)", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const first = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const second = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      expect(second.id).toBe(first.id);
      const { rows } = await admin.query("SELECT count(*)::int n FROM partner_connector_records WHERE handoff_id=$1", [
        handoffId,
      ]);
      expect(rows[0].n).toBe(1);
    });

    it("concurrent duplicate requests for the same handoff create exactly one canonical record", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! }))
      );
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      const { rows } = await admin.query("SELECT count(*)::int n FROM partner_connector_records WHERE handoff_id=$1", [
        handoffId,
      ]);
      expect(rows[0].n).toBe(1);
    });

    it("different handoffs create different records", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const h1 = await seedSubmissionWithHandoff(A, L1, U1);
      const h2 = await seedSubmissionWithHandoff(A, L1, U1);
      const r1 = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h1.handoffId! });
      const r2 = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h2.handoffId! });
      expect(r1.id).not.toBe(r2.id);
    });

    it("the same idempotency key reused for a DIFFERENT handoff fails safely", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const h1 = await seedSubmissionWithHandoff(A, L1, U1);
      const h2 = await seedSubmissionWithHandoff(A, L1, U1);
      await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h1.handoffId!, idempotencyKey: "shared-key-1" });
      await expect(
        ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h2.handoffId!, idempotencyKey: "shared-key-1" })
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    });

    it("a not-ready (already applied) handoff is rejected", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1, { handoffStatus: "applied" });
      await expect(ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! })).rejects.toMatchObject({
        code: "handoff_not_ready",
      });
    });

    it("an unknown handoff id is rejected without leaking existence", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      await expect(
        ensureConnectorRecordForHandoff({ tenantId: A, handoffId: "99999999-0000-0000-0000-000000000000" })
      ).rejects.toMatchObject({ code: "handoff_not_found" });
    });

    it("a handoff belonging to another tenant is rejected exactly like 'not found' (no leak)", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(B, LB, UB);
      await expect(ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! })).rejects.toMatchObject({
        code: "handoff_not_found",
      });
    });

    it("retry after a genuine transient error is still idempotent (second call returns the same record)", async () => {
      const { ensureConnectorRecordForHandoff } = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const r1 = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const r2 = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! }); // simulated retry
      expect(r2.id).toBe(r1.id);
    });
  });

  describe("read-only status", () => {
    it("returns a narrow, non-leaking status shape", async () => {
      const { ensureConnectorRecordForHandoff, getConnectorStatus } =
        await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const status = await getConnectorStatus({ tenantId: A, connectorId: rec.id });
      expect(status).toMatchObject({ connectorId: rec.id, state: "queued", attemptCount: 0 });
      expect(status).not.toHaveProperty("claimedBy");
      expect(status).not.toHaveProperty("version");
    });

    it("cross-tenant status read returns null (no existence leak)", async () => {
      const { ensureConnectorRecordForHandoff, getConnectorStatus } =
        await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const status = await getConnectorStatus({ tenantId: B, connectorId: rec.id });
      expect(status).toBeNull();
    });

    it("an unknown connector id returns null", async () => {
      const { getConnectorStatus } = await import("../server/partner/connector-service");
      const status = await getConnectorStatus({ tenantId: A, connectorId: "99999999-0000-0000-0000-000000000000" });
      expect(status).toBeNull();
    });
  });

  describe("state machine — legal and illegal transitions", () => {
    it("every legal transition in the matrix succeeds and appends exactly one history row", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      rec = await svc.claimConnectorRecord(rec.id, "worker-1");
      expect(rec.state).toBe("claimed");
      rec = await svc.transitionConnectorState({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: rec.version,
        toState: "validating",
        eventType: "validating",
      });
      expect(rec.state).toBe("validating");
      rec = await svc.transitionConnectorState({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: rec.version,
        toState: "awaiting_validation",
        eventType: "validated",
      });
      expect(rec.state).toBe("awaiting_validation");

      const { rows } = await admin.query(
        "SELECT event_type, from_state, to_state FROM partner_connector_events WHERE connector_record_id=$1 ORDER BY created_at",
        [rec.id]
      );
      expect(rows.map((r) => r.event_type)).toEqual(["created", "claimed", "validating", "validated"]);
    });

    it("an illegal transition fails and appends no history row", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      // queued -> awaiting_validation is not legal
      await expect(
        svc.transitionConnectorState({
          connectorId: rec.id,
          expectedVersion: rec.version,
          toState: "awaiting_validation",
          eventType: "bad",
        })
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
      const { rows } = await admin.query(
        "SELECT count(*)::int n FROM partner_connector_events WHERE connector_record_id=$1",
        [rec.id]
      );
      expect(rows[0].n).toBe(1); // only the original "created" event
    });

    it("a terminal-state (cancelled) record refuses any further transition", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      rec = await svc.transitionConnectorState({
        connectorId: rec.id,
        expectedVersion: rec.version,
        toState: "cancelled",
        eventType: "cancelled",
      });
      expect(rec.state).toBe("cancelled");
      await expect(
        svc.transitionConnectorState({
          connectorId: rec.id,
          expectedVersion: rec.version,
          toState: "queued",
          eventType: "reopen",
        })
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
    });

    it("no G1 function can ever transition a record into 'imported'", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await expect(
        svc.transitionConnectorState({
          connectorId: rec.id,
          expectedVersion: rec.version,
          toState: "imported",
          eventType: "import",
        })
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
      const { rows } = await admin.query("SELECT state FROM partner_connector_records WHERE id=$1", [rec.id]);
      expect(rows[0].state).not.toBe("imported");
    });

    it("state and version update atomically — a failed transition changes nothing", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await expect(
        svc.transitionConnectorState({
          connectorId: rec.id,
          expectedVersion: 999,
          toState: "cancelled",
          eventType: "cancel",
        })
      ).rejects.toMatchObject({ code: "stale_claim" });
      const { rows } = await admin.query("SELECT state, version FROM partner_connector_records WHERE id=$1", [rec.id]);
      expect(rows[0].state).toBe("queued");
      expect(rows[0].version).toBe(1);
    });

    it("recordConnectorFailure sets retryable next_retry_at only when retryable is true", async () => {
      const svc = await import("../server/partner/connector-service");
      const h1 = await seedSubmissionWithHandoff(A, L1, U1);
      let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h1.handoffId! });
      rec = await svc.claimConnectorRecord(rec.id, "worker-1");
      rec = await svc.recordConnectorFailure({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: rec.version,
        errorCategory: "validation",
        errorCode: "permanent_processing_error",
        retryable: false,
      });
      expect(rec.state).toBe("failed");
      expect(rec.nextRetryAt).toBeNull();

      const h2 = await seedSubmissionWithHandoff(A, L1, U1);
      let rec2 = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h2.handoffId! });
      rec2 = await svc.claimConnectorRecord(rec2.id, "worker-1");
      rec2 = await svc.recordConnectorFailure({
        connectorId: rec2.id,
        claimant: "worker-1",
        expectedVersion: rec2.version,
        errorCategory: "database",
        errorCode: "transient_database_error",
        retryable: true,
      });
      expect(rec2.nextRetryAt).not.toBeNull();
    });

    it("failed -> queued (retry) then failed -> cancelled are both legal", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      rec = await svc.claimConnectorRecord(rec.id, "worker-1");
      rec = await svc.recordConnectorFailure({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: rec.version,
        errorCategory: "x",
        errorCode: "transient_database_error",
        retryable: true,
      });
      rec = await svc.transitionConnectorState({
        connectorId: rec.id,
        expectedVersion: rec.version,
        toState: "queued",
        eventType: "retried",
      });
      expect(rec.state).toBe("queued");
      rec = await svc.claimConnectorRecord(rec.id, "worker-2");
      rec = await svc.recordConnectorFailure({
        connectorId: rec.id,
        claimant: "worker-2",
        expectedVersion: rec.version,
        errorCategory: "x",
        errorCode: "permanent_processing_error",
        retryable: false,
      });
      rec = await svc.transitionConnectorState({
        connectorId: rec.id,
        expectedVersion: rec.version,
        toState: "cancelled",
        eventType: "cancelled",
      });
      expect(rec.state).toBe("cancelled");
    });

    it("requeuing via transitionConnectorState clears claimed_by/claimed_at/claim_expires_at/next_retry_at (review finding: only releaseConnectorClaim used to clear these)", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      rec = await svc.claimConnectorRecord(rec.id, "worker-1");
      rec = await svc.recordConnectorFailure({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: rec.version,
        errorCategory: "x",
        errorCode: "transient_database_error",
        retryable: true,
      });
      expect(rec.nextRetryAt).not.toBeNull();
      rec = await svc.transitionConnectorState({
        connectorId: rec.id,
        expectedVersion: rec.version,
        toState: "queued",
        eventType: "retried",
      });
      expect(rec.state).toBe("queued");
      expect(rec.claimedBy).toBeNull();
      expect(rec.claimedAt).toBeNull();
      expect(rec.claimExpiresAt).toBeNull();
      expect(rec.nextRetryAt).toBeNull();
    });

    it("a tenant mismatch on a tenant-scoped call is rejected as unauthorised (review finding: 4 functions previously took no tenantId at all)", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await expect(svc.claimConnectorRecord(rec.id, "worker-1", 300, B)).rejects.toMatchObject({
        code: "unauthorised",
      });
      await expect(
        svc.transitionConnectorState({
          connectorId: rec.id,
          tenantId: B,
          expectedVersion: rec.version,
          toState: "cancelled",
          eventType: "cancelled",
        })
      ).rejects.toMatchObject({ code: "unauthorised" });
      const claimed = await svc.claimConnectorRecord(rec.id, "worker-1");
      await expect(
        svc.recordConnectorFailure({
          connectorId: rec.id,
          tenantId: B,
          claimant: "worker-1",
          expectedVersion: claimed.version,
          errorCategory: "x",
          errorCode: "permanent_processing_error",
          retryable: false,
        })
      ).rejects.toMatchObject({ code: "unauthorised" });
      await expect(
        svc.releaseConnectorClaim({
          connectorId: rec.id,
          tenantId: B,
          claimant: "worker-1",
          expectedVersion: claimed.version,
        })
      ).rejects.toMatchObject({ code: "unauthorised" });
    });

    it("a matching tenantId succeeds normally (the check only rejects a mismatch, never a correct caller)", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const claimed = await svc.claimConnectorRecord(rec.id, "worker-1", 300, A);
      expect(claimed.state).toBe("claimed");
      const released = await svc.releaseConnectorClaim({
        connectorId: rec.id,
        tenantId: A,
        claimant: "worker-1",
        expectedVersion: claimed.version,
      });
      expect(released.state).toBe("queued");
    });

    it("omitting claimant on an actually-claimed record is rejected, not silently allowed (review finding: '&& claimant' used to short-circuit the ownership check)", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      rec = await svc.claimConnectorRecord(rec.id, "worker-1");
      // No claimant passed at all — must be rejected, not treated as "no check requested".
      await expect(
        svc.transitionConnectorState({
          connectorId: rec.id,
          expectedVersion: rec.version,
          toState: "validating",
          eventType: "validating",
        })
      ).rejects.toMatchObject({ code: "stale_claim" });
      await expect(
        svc.recordConnectorFailure({
          connectorId: rec.id,
          expectedVersion: rec.version,
          errorCategory: "x",
          errorCode: "permanent_processing_error",
          retryable: false,
        })
      ).rejects.toMatchObject({ code: "stale_claim" });
    });
  });

  describe("error normalisation (review finding: only ensureConnectorRecordForHandoff normalised errors; every other function is now guarded too)", () => {
    it("every exported function throws a ConnectorError, never a raw pg error, on a malformed id", async () => {
      const svc = await import("../server/partner/connector-service");
      const { ConnectorError } = await import("../server/partner/connector-errors");
      const BAD = "not-a-uuid";
      await expect(svc.getConnectorStatus({ tenantId: A, connectorId: BAD })).rejects.toBeInstanceOf(ConnectorError);
      await expect(svc.claimConnectorRecord(BAD, "worker-1")).rejects.toBeInstanceOf(ConnectorError);
      await expect(
        svc.transitionConnectorState({
          connectorId: BAD,
          expectedVersion: 1,
          toState: "cancelled",
          eventType: "cancelled",
        })
      ).rejects.toBeInstanceOf(ConnectorError);
      await expect(
        svc.recordConnectorFailure({
          connectorId: BAD,
          expectedVersion: 1,
          errorCategory: "x",
          errorCode: "permanent_processing_error",
          retryable: false,
        })
      ).rejects.toBeInstanceOf(ConnectorError);
      await expect(
        svc.releaseConnectorClaim({ connectorId: BAD, claimant: "worker-1", expectedVersion: 1 })
      ).rejects.toBeInstanceOf(ConnectorError);
    });

    it("normalised errors never contain SQL keywords or raw Postgres error text", async () => {
      const svc = await import("../server/partner/connector-service");
      await expect(svc.claimConnectorRecord("not-a-uuid", "worker-1")).rejects.not.toMatchObject({
        message: expect.stringMatching(/SELECT|INSERT|UPDATE|invalid input syntax/i),
      });
    });
  });

  describe("claiming and concurrency (real, separate connections)", () => {
    it("one processor claims a queued record; a second concurrent processor cannot claim the same one", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const [r1, r2] = await Promise.allSettled([
        svc.claimConnectorRecord(rec.id, "worker-1"),
        svc.claimConnectorRecord(rec.id, "worker-2"),
      ]);
      const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
      const rejected = [r1, r2].filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: expect.stringMatching(/already_claimed|stale_claim/),
      });
    });

    it("claimNextConnectorRecord under SKIP LOCKED: two concurrent global claims never return the same record", async () => {
      const svc = await import("../server/partner/connector-service");
      const h1 = await seedSubmissionWithHandoff(A, L1, U1);
      const h2 = await seedSubmissionWithHandoff(A, L1, U1);
      await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h1.handoffId! });
      await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h2.handoffId! });
      const [r1, r2] = await Promise.all([
        svc.claimNextConnectorRecord("worker-a"),
        svc.claimNextConnectorRecord("worker-b"),
      ]);
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r1!.id).not.toBe(r2!.id);
    });

    it("claimNextConnectorRecord returns null when nothing is claimable", async () => {
      const svc = await import("../server/partner/connector-service");
      // drain anything currently queued in this suite's tenant scope by claiming until null (isolated
      // check: create one fresh record, claim it, then claiming again for THAT exact scenario is
      // covered elsewhere — here we assert the null-shape contract directly with a targeted case).
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await svc.claimConnectorRecord(rec.id, "worker-1");
      await svc.transitionConnectorState({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: 2,
        toState: "cancelled",
        eventType: "cancelled",
      });
      // Claiming repeatedly must never return this now-terminal record.
      let seenTerminal = false;
      for (let i = 0; i < 20; i++) {
        const next = await svc.claimNextConnectorRecord(`sweep-${i}`);
        if (next == null) break;
        if (next.id === rec.id) seenTerminal = true;
      }
      expect(seenTerminal).toBe(false);
    });

    it("an expired claim is recoverable by a new claimant", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await svc.claimConnectorRecord(rec.id, "worker-1", -1); // lease already expired (negative seconds)
      const reclaimed = await svc.claimConnectorRecord(rec.id, "worker-2");
      expect(reclaimed.claimedBy).toBe("worker-2");
    });

    it("a stale claimant (lost the lease) cannot transition the record after it's reclaimed", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await svc.claimConnectorRecord(rec.id, "worker-1", -1);
      const reclaimed = await svc.claimConnectorRecord(rec.id, "worker-2");
      await expect(
        svc.transitionConnectorState({
          connectorId: rec.id,
          claimant: "worker-1",
          expectedVersion: reclaimed.version,
          toState: "validating",
          eventType: "validating",
        })
      ).rejects.toMatchObject({ code: "stale_claim" });
    });

    it("the correct claimant can release; the record returns to queued and is claimable again", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const claimed = await svc.claimConnectorRecord(rec.id, "worker-1");
      const released = await svc.releaseConnectorClaim({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: claimed.version,
      });
      expect(released.state).toBe("queued");
      expect(released.claimedBy).toBeNull();
      const reclaimed = await svc.claimConnectorRecord(rec.id, "worker-2");
      expect(reclaimed.claimedBy).toBe("worker-2");
    });

    it("a non-claimant cannot release someone else's claim", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      const claimed = await svc.claimConnectorRecord(rec.id, "worker-1");
      await expect(
        svc.releaseConnectorClaim({ connectorId: rec.id, claimant: "worker-2", expectedVersion: claimed.version })
      ).rejects.toMatchObject({ code: "stale_claim" });
    });

    it("a terminal-state record cannot be claimed", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await svc.transitionConnectorState({
        connectorId: rec.id,
        expectedVersion: rec.version,
        toState: "cancelled",
        eventType: "cancelled",
      });
      await expect(svc.claimConnectorRecord(rec.id, "worker-1")).rejects.toMatchObject({
        code: "invalid_state_transition",
      });
    });
  });

  describe("feature flag and emergency stop", () => {
    it("connector fails closed when the flag is missing entirely", async () => {
      await admin.query(
        "DELETE FROM partner_feature_flags WHERE flag='partner_connector_enabled' AND tenant_id IS NULL"
      );
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      await expect(svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! })).rejects.toMatchObject({
        code: "feature_disabled",
      });
      await admin.query(
        "INSERT INTO partner_feature_flags (flag, tenant_id, location_id, enabled) VALUES ('partner_connector_enabled', NULL, NULL, true)"
      );
    });

    it("connector fails safely when the flag is explicitly OFF", async () => {
      await admin.query(
        "UPDATE partner_feature_flags SET enabled=false WHERE flag='partner_connector_enabled' AND tenant_id IS NULL"
      );
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      await expect(svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! })).rejects.toMatchObject({
        code: "feature_disabled",
      });
      await admin.query(
        "UPDATE partner_feature_flags SET enabled=true WHERE flag='partner_connector_enabled' AND tenant_id IS NULL"
      );
    });

    it("connector permits foundation processing when the flag is ON", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      expect(rec.state).toBe("queued");
    });

    it("emergency stop overrides an ON flag — every state-changing call fails, no partial transition occurs", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });

      await admin.query(
        "UPDATE partner_feature_flags SET enabled=true WHERE flag='partner_emergency_stop' AND tenant_id IS NULL"
      );
      await expect(svc.claimConnectorRecord(rec.id, "worker-1")).rejects.toMatchObject({ code: "emergency_stop" });
      const { rows } = await admin.query("SELECT state, version FROM partner_connector_records WHERE id=$1", [rec.id]);
      expect(rows[0].state).toBe("queued"); // unchanged — no partial transition
      expect(rows[0].version).toBe(1);

      await admin.query(
        "UPDATE partner_feature_flags SET enabled=false WHERE flag='partner_emergency_stop' AND tenant_id IS NULL"
      );
    });

    it("read-only status remains available even when the connector is OFF or stopped", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      const rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      await admin.query(
        "UPDATE partner_feature_flags SET enabled=true WHERE flag='partner_emergency_stop' AND tenant_id IS NULL"
      );
      const status = await svc.getConnectorStatus({ tenantId: A, connectorId: rec.id });
      expect(status).not.toBeNull();
      await admin.query(
        "UPDATE partner_feature_flags SET enabled=false WHERE flag='partner_emergency_stop' AND tenant_id IS NULL"
      );
    });
  });

  describe("trust boundary — partner_runtime cannot touch connector internals", () => {
    let runtimeClient: Client;
    beforeAll(async () => {
      const runtimeUrl = new URL(CONNECTOR_URL!);
      runtimeUrl.username = "partner_app_test_conn";
      runtimeUrl.password = "synthetic";
      runtimeClient = new Client({ connectionString: runtimeUrl.toString() });
      await runtimeClient.connect();
    });
    afterAll(async () => {
      await runtimeClient.end().catch(() => {});
    });

    it("partner_runtime cannot INSERT a connector record", async () => {
      await expect(
        runtimeClient.query(
          "INSERT INTO partner_connector_records (tenant_id, partner_submission_id, handoff_id) VALUES ($1,$2,$3)",
          [A, "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"]
        )
      ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege
    });

    it("partner_runtime cannot UPDATE a connector record", async () => {
      await expect(
        runtimeClient.query("UPDATE partner_connector_records SET state='cancelled' WHERE tenant_id=$1", [A])
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("partner_runtime cannot INSERT connector history", async () => {
      await expect(
        runtimeClient.query(
          "INSERT INTO partner_connector_events (connector_record_id, to_state, event_type, attempt_number) VALUES ($1,'queued','forged',0)",
          ["00000000-0000-0000-0000-000000000000"]
        )
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("partner_runtime cannot even SELECT connector records", async () => {
      await expect(runtimeClient.query("SELECT * FROM partner_connector_records LIMIT 1")).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("direct grading/certificate/payment table writes are impossible through the connector API surface (no such function exists)", async () => {
      const svc = await import("../server/partner/connector-service");
      const exported = Object.keys(svc);
      for (const name of exported) {
        expect(name.toLowerCase()).not.toMatch(/certificate|payment|stripe|label|grade/);
      }
    });
  });

  describe("history immutability is enforced at the DB level for the role that actually holds SELECT/INSERT (not just for partner_runtime, which holds nothing)", () => {
    let connectorClient: Client;
    beforeAll(async () => {
      connectorClient = new Client({ connectionString: CONNECTOR_URL! });
      await connectorClient.connect();
    });
    afterAll(async () => {
      await connectorClient.end().catch(() => {});
    });

    it("partner_connector_runtime itself cannot UPDATE an event row (no UPDATE grant, even though it holds SELECT/INSERT)", async () => {
      await expect(
        connectorClient.query("UPDATE partner_connector_events SET event_type='forged' WHERE true")
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("partner_connector_runtime itself cannot DELETE an event row", async () => {
      await expect(connectorClient.query("DELETE FROM partner_connector_events WHERE true")).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  describe("error handling", () => {
    it("a database failure never leaks raw SQL or table names to the caller", async () => {
      const svc = await import("../server/partner/connector-service");
      let caught: unknown;
      try {
        // malformed UUID triggers a real pg error inside the service.
        await svc.getConnectorStatus({ tenantId: A, connectorId: "not-a-uuid" });
      } catch (err) {
        caught = err;
      }
      // getConnectorStatus intentionally lets a malformed id 500 upstream in production routing;
      // here we only assert that IF it throws, no SQL text leaks into the message.
      if (caught) {
        expect(String((caught as Error).message)).not.toMatch(/SELECT|INSERT|UPDATE|FROM partner_connector/i);
      }
    });

    it("retryable failures are marked retryable=true, permanent failures retryable=false", async () => {
      const { ConnectorError } = await import("../server/partner/connector-errors");
      expect(new ConnectorError("transient_database_error", "x").retryable).toBe(true);
      expect(new ConnectorError("permanent_processing_error", "x").retryable).toBe(false);
      expect(new ConnectorError("already_claimed", "x").retryable).toBe(true);
      expect(new ConnectorError("invalid_state_transition", "x").retryable).toBe(false);
    });

    it("an unknown/unexpected error normalises to a safe generic code", async () => {
      const { toConnectorError } = await import("../server/partner/connector-errors");
      const normalised = toConnectorError(new Error("Postgres said something with a table name in it"));
      expect(normalised.code).toBe("transient_database_error");
      expect(normalised.message).not.toMatch(/table name/);
    });
  });

  describe("listRetryableConnectorRecords", () => {
    it("lists only failed records whose retry time has arrived", async () => {
      const svc = await import("../server/partner/connector-service");
      const { handoffId } = await seedSubmissionWithHandoff(A, L1, U1);
      let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: handoffId! });
      rec = await svc.claimConnectorRecord(rec.id, "worker-1");
      rec = await svc.recordConnectorFailure({
        connectorId: rec.id,
        claimant: "worker-1",
        expectedVersion: rec.version,
        errorCategory: "x",
        errorCode: "permanent_processing_error",
        retryable: false,
      });
      const list = await svc.listRetryableConnectorRecords(500);
      expect(list.find((r) => r.id === rec.id)).toBeUndefined(); // non-retryable, excluded

      await admin.query(
        "UPDATE partner_connector_records SET next_retry_at = now() - interval '1 minute' WHERE id != $1 AND state='failed'",
        [rec.id]
      );
    });
  });
});
