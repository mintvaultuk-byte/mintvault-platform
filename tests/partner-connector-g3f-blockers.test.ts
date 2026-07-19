/**
 * Trusted Intake Connector — G3F FINAL blocker-remediation proofs (disposable Postgres, real roles
 * and real connections — not mocks). Covers the three test-gap blockers the Final Release Authority
 * required:
 *   3A  append-only runtime permissions on partner_connector_import_attempts (real runtime role).
 *   3B  resumed import records the LATEST authorising validation run + fingerprint, while the
 *       interrupted reservation's stale fingerprint is preserved (unchanged) as history.
 *   4   bounded transient claim retry in the worker pool (transient-then-success, exhaustion,
 *       permanent, shutdown-during-retry, contention, client-release).
 *
 * Runs ONLY when PARTNER_CONNECTOR_BLOCKER_RT_ADMIN + PARTNER_CONNECTOR_BLOCKER_RT_URL are set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { applyMigrationsRealistic, provisionRealisticRoles, PARTNER_MIGRATIONS_WITH_G3F } from "./helpers/partner-realistic-db";
import { ConnectorError } from "../server/partner/connector-errors";

const ADMIN = process.env.PARTNER_CONNECTOR_BLOCKER_RT_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_BLOCKER_RT_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-b000-0000-0000-000000000001";
const L1 = "10000000-b000-0000-0000-0000000000c1";
const U1 = "11111111-b000-0000-0000-0000000000a1";

let admin: Client;
let seq = 0;
const uuid = (n: number) => `b0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function seedMintVaultTables(): Promise<void> {
  await admin.query(`CREATE TABLE IF NOT EXISTS users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar,
    last_name varchar, role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamptz NOT NULL DEFAULT now())`);
  await admin.query(`CREATE TABLE IF NOT EXISTS submissions (
    id serial PRIMARY KEY, user_id varchar NOT NULL, status varchar(30) NOT NULL DEFAULT 'draft',
    tracking_number text NOT NULL UNIQUE, card_count integer NOT NULL DEFAULT 0,
    total_price decimal(10,2) NOT NULL DEFAULT 0, total_declared_value integer NOT NULL DEFAULT 0,
    payment_status varchar(20) NOT NULL DEFAULT 'unpaid', payment_intent_id text,
    service_type text, service_tier text, grading_cost integer DEFAULT 0,
    customer_email text, customer_first_name text, customer_last_name text,
    created_at timestamptz NOT NULL DEFAULT now())`);
  await admin.query(`CREATE TABLE IF NOT EXISTS submission_items (
    id serial PRIMARY KEY, submission_id integer NOT NULL, card_index integer NOT NULL DEFAULT 0,
    game text, card_set text, card_name text, card_number text, year text,
    declared_value integer DEFAULT 0, declared_new boolean DEFAULT false, notes text,
    created_at timestamptz NOT NULL DEFAULT now())`);
  // forbidden-side-effect fixtures
  await admin.query(`CREATE TABLE IF NOT EXISTS certificates (id serial PRIMARY KEY, cert_id text)`);
  await admin.query(`CREATE TABLE IF NOT EXISTS labels (id serial PRIMARY KEY, cert_id text)`);
  await admin.query(`CREATE TABLE IF NOT EXISTS payments (id serial PRIMARY KEY, amount integer)`);
  await admin.query("INSERT INTO certificates (cert_id) VALUES ('SEED') ON CONFLICT DO NOTHING");
  await admin.query("INSERT INTO labels (cert_id) VALUES ('SEED') ON CONFLICT DO NOTHING");
  await admin.query("INSERT INTO payments (amount) VALUES (1) ON CONFLICT DO NOTHING");
  for (const t of ["users", "submissions", "submission_items", "certificates", "labels", "payments"])
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
}

async function seedTenant(): Promise<void> {
  await admin.query("INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'blkA','blkA','ACTIVE') ON CONFLICT DO NOTHING", [A]);
  await admin.query("INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'blkA-loc',$2,$2,'HQ','ACTIVE') ON CONFLICT DO NOTHING", [L1, A]);
  await admin.query("INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES ($1,'blkA-user',$2,$2,'blkA@example.com','x','ACTIVE',false) ON CONFLICT DO NOTHING", [U1, A]);
  await admin.query("INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES ($1,'standard','Standard',1500,10,true) ON CONFLICT DO NOTHING", [A]);
}

/** Seed → claim → validate → ready_for_import. Returns ids + the validation run and fingerprint. */
async function seedReady(claimant: string): Promise<{ connectorId: string; version: number; customerId: string; submissionId: string; handoffId: string; runA: string; fpA: string }> {
  seq += 1;
  const subId = uuid(seq);
  const custId = uuid(seq + 500_000);
  await admin.query("INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,$3,$4)", [custId, A, `Blk Customer ${seq}`, `blk${seq}@example.com`]);
  await admin.query(
    `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
     VALUES ($1,$2,$3,$4,$5,'standard',1500,1,'submitted_to_mintvault')`,
    [subId, A, L1, U1, custId]
  );
  await admin.query(`INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, declared_value_pence, quantity) VALUES ($1,$2,1,'Card 1',50000,1)`, [A, subId]);
  const h = await admin.query("INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id", [A, subId]);
  const svc = await import("../server/partner/connector-service");
  const validation = await import("../server/partner/connector-validation-service");
  let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: A, handoffId: h.rows[0].id });
  rec = await svc.claimConnectorRecord(rec.id, claimant, 300, A);
  rec = await svc.transitionConnectorState({ connectorId: rec.id, claimant, tenantId: A, expectedVersion: rec.version, toState: "validating", eventType: "validating" });
  const run = await validation.validateConnectorRecord({ connectorId: rec.id, claimant, expectedVersion: rec.version, tenantId: A });
  expect(run.outcome).toBe("valid");
  const { rows } = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [rec.id]);
  const runRow = await admin.query<{ id: string; source_fingerprint: string }>(
    "SELECT id, source_fingerprint FROM partner_connector_validation_runs WHERE connector_record_id = $1 ORDER BY created_at DESC LIMIT 1",
    [rec.id]
  );
  return { connectorId: rec.id, version: rows[0].version, customerId: custId, submissionId: subId, handoffId: h.rows[0].id, runA: runRow.rows[0].id, fpA: runRow.rows[0].source_fingerprint };
}

(isLocal ? describe : describe.skip)("Trusted Intake Connector G3F — blocker remediation proofs", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_G3F);
    await admin.query("DROP ROLE IF EXISTS partner_connector_blocker_test").catch(() => {});
    await admin.query("CREATE ROLE partner_connector_blocker_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_connector_runtime TO partner_connector_blocker_test");
    await admin.query("DROP ROLE IF EXISTS partner_blk_conn").catch(() => {});
    await admin.query("CREATE ROLE partner_blk_conn LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_blk_conn");
    process.env.PARTNER_CONNECTOR_DATABASE_URL = CONNECTOR_URL;
    const flagUrl = new URL(CONNECTOR_URL!);
    flagUrl.username = "partner_blk_conn";
    flagUrl.password = "synthetic";
    process.env.PARTNER_DATABASE_URL = flagUrl.toString();
    await seedTenant();
    await admin.query("INSERT INTO partner_feature_flags (flag, tenant_id, location_id, enabled) VALUES ('partner_connector_enabled', NULL, NULL, true), ('partner_emergency_stop', NULL, NULL, false)");
  }, 60_000);

  afterAll(async () => {
    const { closeConnectorPool } = await import("../server/partner/connector-db");
    const { closePartnerPools } = await import("../server/partner/db");
    await closeConnectorPool();
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  // ============================================================================================
  // Blocker 3A — append-only runtime permissions
  // ============================================================================================
  describe("3A — append-only runtime permissions on partner_connector_import_attempts", () => {
    // Connect AS the real partner_connector_runtime role (via a login role that has it granted).
    let runtime: Client;
    let seededConnectorId: string;
    let orgId: string;
    let subId: string;
    let handoffId: string;
    let runId: string;
    beforeAll(async () => {
      const s = await seedReady("perm-seed");
      seededConnectorId = s.connectorId;
      orgId = A;
      subId = s.submissionId;
      handoffId = s.handoffId;
      runId = s.runA;
      const runtimeUrl = new URL(CONNECTOR_URL!);
      runtimeUrl.username = "partner_connector_blocker_test";
      runtimeUrl.password = "synthetic";
      runtime = new Client({ connectionString: runtimeUrl.toString() });
      await runtime.connect();
    });
    afterAll(async () => {
      await runtime?.end().catch(() => {});
    });

    it("runtime confirms it is running as a granted-in role of partner_connector_runtime, NOSUPERUSER/NOBYPASSRLS", async () => {
      const who = await runtime.query<{ u: string; su: boolean; brls: boolean }>(
        "SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname='partner_connector_runtime') AS su, (SELECT rolbypassrls FROM pg_roles WHERE rolname='partner_connector_runtime') AS brls"
      );
      expect(who.rows[0].su).toBe(false);
      expect(who.rows[0].brls).toBe(false);
      // membership in partner_connector_runtime
      const mem = await runtime.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles g ON g.oid=m.member WHERE r.rolname='partner_connector_runtime' AND g.rolname=current_user");
      expect(mem.rows[0].n).toBe(1);
    });

    it("authorised INSERT succeeds", async () => {
      await runtime.query("SET ROLE partner_connector_runtime");
      try {
        await runtime.query(
          `INSERT INTO partner_connector_import_attempts
             (connector_record_id, partner_organisation_id, partner_submission_id, partner_handoff_id,
              validation_run_id, source_fingerprint, source_fingerprint_version, attempt_number, attempt_type, outcome, started_at)
           VALUES ($1,$2,$3,$4,$5,'fp',1,1,'initial','stale', now())`,
          [seededConnectorId, orgId, subId, handoffId, runId]
        );
      } finally {
        await runtime.query("RESET ROLE");
      }
      const n = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM partner_connector_import_attempts WHERE connector_record_id = $1", [seededConnectorId]);
      expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("authorised SELECT succeeds", async () => {
      await runtime.query("SET ROLE partner_connector_runtime");
      try {
        const r = await runtime.query("SELECT id FROM partner_connector_import_attempts WHERE connector_record_id = $1", [seededConnectorId]);
        expect(r.rows.length).toBeGreaterThanOrEqual(1);
      } finally {
        await runtime.query("RESET ROLE");
      }
    });

    it("UPDATE is denied", async () => {
      await runtime.query("SET ROLE partner_connector_runtime");
      try {
        await expect(runtime.query("UPDATE partner_connector_import_attempts SET outcome = 'completed'")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await runtime.query("RESET ROLE");
      }
    });

    it("DELETE is denied", async () => {
      await runtime.query("SET ROLE partner_connector_runtime");
      try {
        await expect(runtime.query("DELETE FROM partner_connector_import_attempts")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await runtime.query("RESET ROLE");
      }
    });

    it("TRUNCATE is denied", async () => {
      await runtime.query("SET ROLE partner_connector_runtime");
      try {
        await expect(runtime.query("TRUNCATE partner_connector_import_attempts")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await runtime.query("RESET ROLE");
      }
    });

    it("ALTER TABLE / DROP TABLE / ownership transfer / DISABLE TRIGGER are denied", async () => {
      await runtime.query("SET ROLE partner_connector_runtime");
      try {
        await expect(runtime.query("ALTER TABLE partner_connector_import_attempts ADD COLUMN hacked text")).rejects.toBeTruthy();
        await expect(runtime.query("DROP TABLE partner_connector_import_attempts")).rejects.toBeTruthy();
        await expect(runtime.query("ALTER TABLE partner_connector_import_attempts OWNER TO partner_connector_runtime")).rejects.toBeTruthy();
        await expect(runtime.query("ALTER TABLE partner_connector_import_attempts DISABLE TRIGGER ALL")).rejects.toBeTruthy();
      } finally {
        await runtime.query("RESET ROLE");
      }
    });

    it("self-GRANT cannot escalate: a non-owner GRANT grants nothing (privilege stays absent)", async () => {
      // Postgres does not ERROR on a non-owner GRANT — it warns and grants nothing. Prove the escalation
      // genuinely fails by confirming the role still cannot UPDATE after attempting to grant itself UPDATE.
      await runtime.query("SET ROLE partner_connector_runtime");
      try {
        await runtime.query("GRANT UPDATE ON partner_connector_import_attempts TO partner_connector_runtime").catch(() => {});
        // still no UPDATE privilege
        const has = await runtime.query<{ has: boolean }>("SELECT has_table_privilege('partner_connector_runtime','partner_connector_import_attempts','UPDATE') AS has");
        expect(has.rows[0].has).toBe(false);
        // and an actual UPDATE still fails
        await expect(runtime.query("UPDATE partner_connector_import_attempts SET outcome='completed'")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await runtime.query("RESET ROLE");
      }
    });

    it("PUBLIC has no privilege; runtime does NOT own the table; runtime privileges are narrower than the owner", async () => {
      const pub = await admin.query<{ has: boolean }>("SELECT has_table_privilege('public','partner_connector_import_attempts','SELECT') AS has");
      expect(pub.rows[0].has).toBe(false);
      const owner = await admin.query<{ owner: string }>("SELECT tableowner AS owner FROM pg_tables WHERE tablename='partner_connector_import_attempts'");
      expect(owner.rows[0].owner).not.toBe("partner_connector_runtime");
      expect(owner.rows[0].owner).toBe("pn_migrator");
      // runtime privileges: SELECT+INSERT only, strictly fewer than owner's full set
      const rt = await admin.query<{ p: string }>("SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE grantee='partner_connector_runtime' AND table_name='partner_connector_import_attempts' ORDER BY p");
      expect(rt.rows.map((r) => r.p).sort()).toEqual(["INSERT", "SELECT"]);
    });

    it("cross-tenant security boundary is service-level (no table RLS), documented precisely", async () => {
      // The append-only connector tables carry NO row-level security (same design as
      // partner_connector_records/_events/_imports — see ARCHITECTURE §7). Tenant isolation is
      // enforced at the service layer: every read is by connector_record_id, itself resolved from a
      // tenant-scoped upstream. Assert the table genuinely has RLS DISABLED (so no false RLS claim).
      const rls = await admin.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname='partner_connector_import_attempts'");
      expect(rls.rows[0].relrowsecurity).toBe(false);
    });
  });

  // ============================================================================================
  // Blocker 3B — resumed import records the LATEST authorising run/fingerprint; stale one preserved
  // ============================================================================================
  describe("3B — resumed import uses the newer fingerprint; the interrupted reservation's stale fingerprint is preserved", () => {
    it("end-to-end: reservation holds fp A (immutable); completed attempt holds the newer authorising run/fp; retry converges; no side effects", async () => {
      const importer = await import("../server/partner/connector-import-service");
      const svc = await import("../server/partner/connector-service");
      const validation = await import("../server/partner/connector-validation-service");
      const claimant = "resume-3b";
      const s = await seedReady(claimant);
      const runA = s.runA;
      const fpA = s.fpA;

      // Force an interrupted 'reserved' mapping carrying run A / fingerprint A (the historical
      // artifact whose stale fingerprint the evidence table must NOT let authorise the final import).
      await admin.query(
        `INSERT INTO partner_connector_imports
           (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
            validation_run_id, source_fingerprint, source_fingerprint_version, state, reserved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,'reserved', now() - interval '2 hours')`,
        [s.connectorId, A, L1, s.submissionId, s.handoffId, runA, fpA]
      );

      // Mutate the source so its deterministic fingerprint changes.
      await admin.query("UPDATE partner_customers SET full_name = 'Renamed For 3B' WHERE id = $1", [s.customerId]);

      // Revalidate: first revalidation is STALE vs run A (different fingerprint), second is VALID
      // (source unchanged since the stale run) — producing a newer VALID run with the new fingerprint.
      let cur = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [s.connectorId]);
      let rec = await svc.transitionConnectorState({ connectorId: s.connectorId, claimant, tenantId: A, expectedVersion: cur.rows[0].version, toState: "validating", eventType: "revalidate" });
      const stale = await validation.validateConnectorRecord({ connectorId: s.connectorId, claimant, expectedVersion: rec.version, tenantId: A });
      expect(stale.outcome).toBe("stale");
      // stale routed connector to 'failed'; go validating -> valid
      cur = await admin.query("SELECT version, state FROM partner_connector_records WHERE id = $1", [s.connectorId]);
      rec = await svc.transitionConnectorState({ connectorId: s.connectorId, claimant, tenantId: A, expectedVersion: cur.rows[0].version, toState: "validating", eventType: "revalidate2" });
      const valid = await validation.validateConnectorRecord({ connectorId: s.connectorId, claimant, expectedVersion: rec.version, tenantId: A });
      expect(valid.outcome).toBe("valid");

      const runB = (await admin.query<{ id: string; source_fingerprint: string }>("SELECT id, source_fingerprint FROM partner_connector_validation_runs WHERE connector_record_id = $1 AND outcome='valid' ORDER BY created_at DESC LIMIT 1", [s.connectorId])).rows[0];
      expect(runB.id).not.toBe(runA); // newer run
      expect(runB.source_fingerprint).not.toBe(fpA); // newer fingerprint

      // Resume the import (the importer resumes the existing 'reserved' mapping in place).
      cur = await admin.query("SELECT version FROM partner_connector_records WHERE id = $1", [s.connectorId]);
      const result = await importer.importValidatedConnector({ connectorId: s.connectorId, claimant, expectedVersion: cur.rows[0].version, tenantId: A });
      expect(result.outcome).toBe("imported");
      const destId = result.destinationSubmissionId!;

      // exactly one destination / mapping / completed attempt
      expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions WHERE id = $1", [destId])).rows[0].n).toBe(1);
      expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = $1 AND state='completed'", [s.connectorId])).rows[0].n).toBe(1);
      const attempts = await importer.getImportAttempts(s.connectorId);
      const completed = attempts.filter((a) => a.outcome === "completed");
      expect(completed).toHaveLength(1);

      // The completed attempt records the NEWER authorising run + fingerprint (run B), NOT fp A.
      expect(completed[0].validationRunId).toBe(runB.id);
      expect(completed[0].sourceFingerprint).toBe(runB.source_fingerprint);
      expect(completed[0].sourceFingerprint).not.toBe(fpA);
      expect(completed[0].attemptType).toBe("resumed");
      expect(completed[0].destinationSubmissionId).toBe(destId);
      // no completed attempt carries fp A
      expect(completed.some((a) => a.sourceFingerprint === fpA)).toBe(false);

      // The reservation-turned-completed mapping row PRESERVES its original (stale) fp A, immutable —
      // this is exactly the ambiguity the attempt evidence resolves.
      const mapRow = await admin.query<{ source_fingerprint: string; validation_run_id: string; destination_submission_id: number }>(
        "SELECT source_fingerprint, validation_run_id, destination_submission_id FROM partner_connector_imports WHERE connector_record_id = $1",
        [s.connectorId]
      );
      expect(mapRow.rows[0].source_fingerprint).toBe(fpA); // NOT rewritten
      expect(mapRow.rows[0].validation_run_id).toBe(runA); // NOT rewritten
      expect(mapRow.rows[0].destination_submission_id).toBe(destId);

      // Retry converges on the same destination; no new submission; no historical overwrite.
      const beforeSubs = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions")).rows[0].n;
      const retry = await importer.importValidatedConnector({ connectorId: s.connectorId, claimant, expectedVersion: cur.rows[0].version, tenantId: A });
      expect(retry.outcome).toBe("already_completed");
      expect(retry.destinationSubmissionId).toBe(destId);
      expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions")).rows[0].n).toBe(beforeSubs);
      const attemptsAfter = await importer.getImportAttempts(s.connectorId);
      expect(attemptsAfter.filter((a) => a.outcome === "completed")).toHaveLength(1); // still one, not overwritten/duplicated

      // Runtime cannot update or delete the attempt rows (append-only, re-proven for this connector).
      const runtimeUrl = new URL(CONNECTOR_URL!);
      runtimeUrl.username = "partner_connector_blocker_test";
      runtimeUrl.password = "synthetic";
      const runtime = new Client({ connectionString: runtimeUrl.toString() });
      await runtime.connect();
      try {
        await runtime.query("SET ROLE partner_connector_runtime");
        await expect(runtime.query("UPDATE partner_connector_import_attempts SET source_fingerprint = 'x' WHERE connector_record_id = $1", [s.connectorId])).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("DELETE FROM partner_connector_import_attempts WHERE connector_record_id = $1", [s.connectorId])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await runtime.query("RESET ROLE").catch(() => {});
        await runtime.end();
      }

      // No forbidden side effects.
      expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM certificates")).rows[0].n).toBe(1);
      expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM labels")).rows[0].n).toBe(1);
      expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM payments")).rows[0].n).toBe(1);
      const destRow = await admin.query<{ payment_intent_id: string | null; status: string; payment_status: string }>("SELECT payment_intent_id, status, payment_status FROM submissions WHERE id = $1", [destId]);
      expect(destRow.rows[0].payment_intent_id).toBeNull();
      expect(destRow.rows[0].status).toBe("draft");
      expect(destRow.rows[0].payment_status).toBe("unpaid");
    }, 60_000);
  });

  // ============================================================================================
  // Blocker 4 — bounded transient claim retry
  // ============================================================================================
  describe("4 — bounded transient claim retry in the worker pool", () => {
    async function expireAndReady(claimant: string): Promise<string> {
      const s = await seedReady(claimant);
      await admin.query("UPDATE partner_connector_records SET claim_expires_at = now() - interval '1 hour' WHERE id = $1", [s.connectorId]);
      return s.connectorId;
    }

    it("A — one/two transient claim errors then success: worker recovers, imports, records retries, no leak", async () => {
      const { runConnectorWorkerPool } = await import("../server/partner/connector-worker");
      const svc = await import("../server/partner/connector-service");
      const importer = await import("../server/partner/connector-import-service");
      await expireAndReady("wr-A");
      let calls = 0;
      const res = await runConnectorWorkerPool({
        workerCount: 1,
        leaseSeconds: 120,
        maxClaimRetries: 3,
        claimBackoffMs: 5,
        _claimFn: async (id, lease) => {
          calls += 1;
          if (calls <= 2) throw new ConnectorError("transient_database_error", "boom"); // retryable
          return svc.claimNextConnectorRecord(id, lease); // real claim on the 3rd attempt
        },
      });
      expect(res.claimRetries).toBe(2);
      expect(res.claimRetryExhaustions).toBe(0);
      expect(res.imported).toBe(1);
      expect(res.failures).toEqual([]);
      // pool healthy afterwards (proves no client leak stranded it)
      const s2 = await expireAndReady("wr-A2");
      const c = await admin.query<{ claimed_by: string; version: number }>("SELECT claimed_by, version FROM partner_connector_records WHERE id = $1", [s2]);
      // claim it via the real path and import to confirm the pool still works
      const claimed = await svc.claimConnectorRecord(s2, "wr-A2b", 120, A);
      const ok = await importer.importValidatedConnector({ connectorId: s2, claimant: "wr-A2b", expectedVersion: claimed.version, tenantId: A });
      expect(ok.outcome).toBe("imported");
      void c;
    }, 30_000);

    it("B — repeated transient failures stop at the retry maximum (no infinite loop), deterministic exhaustion", async () => {
      const { runConnectorWorkerPool } = await import("../server/partner/connector-worker");
      const res = await runConnectorWorkerPool({
        workerCount: 1,
        maxClaimRetries: 3,
        claimBackoffMs: 1,
        _claimFn: async () => {
          throw new ConnectorError("transient_database_error", "always-transient"); // retryable, never succeeds
        },
      });
      expect(res.claimRetries).toBe(3); // exactly the max, then gives up
      expect(res.claimRetryExhaustions).toBe(1);
      expect(res.imported).toBe(0);
      expect(res.failures).toEqual([{ connectorId: "(claim)", code: "transient_database_error", kind: "transient" }]);
    }, 15_000);

    it("C — permanent claim error is NOT retried and the worker exits safely", async () => {
      const { runConnectorWorkerPool } = await import("../server/partner/connector-worker");
      const res = await runConnectorWorkerPool({
        workerCount: 1,
        maxClaimRetries: 3,
        _claimFn: async () => {
          throw new ConnectorError("unauthorised", "permanent"); // non-retryable
        },
      });
      expect(res.claimRetries).toBe(0);
      expect(res.claimRetryExhaustions).toBe(0);
      expect(res.failures).toEqual([{ connectorId: "(claim)", code: "unauthorised", kind: "permanent" }]);
    }, 15_000);

    it("D — shutdown during retry prevents another claim and exits within bounded time", async () => {
      const { runConnectorWorkerPool } = await import("../server/partner/connector-worker");
      let stop = false;
      let calls = 0;
      const res = await runConnectorWorkerPool({
        workerCount: 1,
        maxClaimRetries: 100, // high, so only shutdown stops it
        claimBackoffMs: 1,
        shouldStop: () => stop,
        _claimFn: async () => {
          calls += 1;
          if (calls >= 2) stop = true; // request shutdown after the first retry
          throw new ConnectorError("transient_database_error", "boom");
        },
      });
      expect(res.stoppedEarly).toBe(true);
      expect(calls).toBeLessThan(5); // bounded — shutdown wins over the 100 retry budget
    }, 15_000);

    it("E — claim contention (already_claimed) retries then proceeds; exactly one destination, no duplicate", async () => {
      const { runConnectorWorkerPool } = await import("../server/partner/connector-worker");
      const svc = await import("../server/partner/connector-service");
      const connectorId = await expireAndReady("wr-E");
      let calls = 0;
      const res = await runConnectorWorkerPool({
        workerCount: 1,
        leaseSeconds: 120,
        maxClaimRetries: 3,
        claimBackoffMs: 2,
        _claimFn: async (id, lease) => {
          calls += 1;
          if (calls === 1) throw new ConnectorError("already_claimed", "contention"); // retryable contention
          return svc.claimNextConnectorRecord(id, lease);
        },
      });
      expect(res.claimRetries).toBe(1);
      expect(res.imported).toBe(1);
      expect(res.failures).toEqual([]);
      const dests = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = $1 AND state='completed'", [connectorId]);
      expect(dests.rows[0].n).toBe(1); // exactly one, no duplicate
    }, 30_000);

    it("numeric config: non-finite / negative / malformed values fall back to safe defaults", async () => {
      const { runConnectorWorkerPool } = await import("../server/partner/connector-worker");
      // Infinity/NaN/negative/decimal/string must NOT hang or throw — they fall back to bounded defaults.
      for (const bad of [Infinity, -Infinity, NaN, -5, 2.7, "abc" as unknown as number, undefined as unknown as number]) {
        const res = await runConnectorWorkerPool({
          workerCount: 1,
          maxClaimRetries: bad,
          claimBackoffMs: bad,
          _claimFn: async () => {
            throw new ConnectorError("transient_database_error", "x");
          },
        });
        // whatever the bad input, retries are a finite bounded number and the worker terminated
        expect(Number.isFinite(res.claimRetries)).toBe(true);
        expect(res.claimRetries).toBeLessThanOrEqual(3); // default cap when input is invalid
        expect(res.claimRetryExhaustions).toBe(1);
      }
    }, 20_000);
  });
});
