/**
 * Trusted Intake Connector — WP-3 production driver proof (disposable PostgreSQL 17, realistic
 * non-superuser role model, real connections — not mocks).
 *
 * The connector chain G1–G3F was code-complete but had ZERO production callers: a submitted Partner
 * handoff sat `pending` forever. This suite proves the driver (server/partner/connector-runtime.ts)
 * actually closes that gap, and that every fail-closed control still holds when it does:
 *
 *   • flag OFF                → the runtime never claims and creates nothing
 *   • emergency stop ON       → same, and it takes precedence over the enabled flag
 *   • flag flipped ON via SQL → sweep + validation + import proceed end-to-end
 *   • flag flipped OFF mid-run→ the very next cycle halts (no new claims, no new imports)
 *   • E2E                     → portal handoff → connector record → validated → ready_for_import →
 *                               imported EXACTLY ONCE → real submissions/submission_items rows with
 *                               an MV-SUB reference and a resolved (never arbitrary) owner
 *   • re-run                  → the sweep finds nothing and imports nothing twice
 *   • crash mid-import        → the transaction rolls back; a restart re-runs and produces ONE
 *                               destination submission, never two
 *   • no connector env        → startConnectorRuntime is a single-line no-op (main app unchanged)
 *   • shutdown                → stop drains without leaking a live lease
 *
 * Runs ONLY when PARTNER_CONNECTOR_RUNTIME_ADMIN + PARTNER_CONNECTOR_RUNTIME_URL are set (a
 * superuser URL and a connector-role URL against a DISPOSABLE local database):
 *   PARTNER_CONNECTOR_RUNTIME_ADMIN=postgresql://postgres@127.0.0.1:55437/dispo \
 *   PARTNER_CONNECTOR_RUNTIME_URL=postgresql://partner_connector_rt_test:synthetic@127.0.0.1:55437/dispo \
 *   npx vitest run tests/partner-connector-runtime.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_G4,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_CONNECTOR_RUNTIME_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_RUNTIME_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-7000-0000-0000-000000000001";
const B = "bbbbbbbb-7000-0000-0000-000000000002";
const LA = "10000000-7000-0000-0000-0000000000c1";
const LB = "20000000-7000-0000-0000-0000000000d1";
const UA = "11111111-7000-0000-0000-0000000000a1";
const UB = "22222222-7000-0000-0000-0000000000b1";

let admin: Client;
let seq = 0;
const uuid = (n: number) => `70000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

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
  // A pre-existing, unrelated user + submission: proves the driver never adopts an arbitrary
  // existing owner or reference when it imports.
  await admin.query(
    "INSERT INTO users (id, email, first_name) VALUES ('pre-existing-unrelated', 'unrelated@example.com', 'Unrelated') ON CONFLICT DO NOTHING"
  );
  await admin.query(
    "INSERT INTO submissions (user_id, tracking_number, status) VALUES ('pre-existing-unrelated', 'MV-SUB-000001', 'draft') ON CONFLICT DO NOTHING"
  );
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

interface SeededHandoff {
  submissionId: string;
  customerId: string;
  handoffId: string;
  customerEmail: string;
  cardCount: number;
}

/**
 * Creates a fully valid Partner submission + customer + cards + a PENDING handoff — i.e. exactly the
 * state the Partner portal leaves behind today, and exactly what used to sit there forever. Nothing
 * here touches the connector: the driver has to discover it.
 */
async function seedPendingHandoff(
  tenantId: string,
  locationId: string,
  partnerUserId: string,
  opts: { cardCount?: number } = {}
): Promise<SeededHandoff> {
  seq += 1;
  const cardCount = opts.cardCount ?? 2;
  const subId = uuid(seq);
  const custId = uuid(seq + 500_000);
  const email = `runtime-customer${seq}@example.com`;
  await admin.query("INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,$3,$4)", [
    custId,
    tenantId,
    `Runtime Customer ${seq}`,
    email,
  ]);
  // estimated_price_pence MUST equal tier price (1500) x total card quantity, or validation
  // legitimately rejects the submission with `service_price_mismatch`.
  await admin.query(
    `INSERT INTO partner_submissions
       (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
     VALUES ($1,$2,$3,$4,$5,'standard',$6,$7,'submitted_to_mintvault')`,
    [subId, tenantId, locationId, partnerUserId, custId, 1500 * cardCount, cardCount]
  );
  for (let i = 1; i <= cardCount; i++) {
    await admin.query(
      `INSERT INTO partner_submission_cards
         (tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, declared_value_pence, quantity)
       VALUES ($1,$2,$3,$4,'pokemon','Base Set','4/102',1999,50000,1)`,
      [tenantId, subId, i, `Runtime Card ${i}`]
    );
  }
  const h = await admin.query<{ id: string }>(
    "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
    [tenantId, subId]
  );
  return { submissionId: subId, customerId: custId, handoffId: h.rows[0].id, customerEmail: email, cardCount };
}

/**
 * Seeds a valid submission + pending handoff, then plants a connector record for it in `failed` —
 * the shape a transient import/validation error leaves behind. `retryAt` controls whether its
 * next_retry_at has already elapsed (due for retry) or is still in the future (not yet due).
 */
async function seedFailedRecord(
  tenantId: string,
  locationId: string,
  partnerUserId: string,
  retryAt: "past" | "future"
): Promise<{ connectorId: string; handoffId: string }> {
  const seeded = await seedPendingHandoff(tenantId, locationId, partnerUserId, { cardCount: 1 });
  const interval = retryAt === "past" ? "-1 hour" : "+1 hour";
  const rec = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records
       (tenant_id, partner_submission_id, handoff_id, state, version, attempt_count,
        last_error_category, last_error_code, next_retry_at)
     VALUES ($1,$2,$3,'failed',1,1,'transient','transient_database_error', now() + $4::interval)
     RETURNING id`,
    [tenantId, seeded.submissionId, seeded.handoffId, interval]
  );
  return { connectorId: rec.rows[0].id, handoffId: seeded.handoffId };
}

/** Write the GLOBAL flag row directly — the WRITE path itself is a separate work package. */
async function setGlobalFlag(flag: string, enabled: boolean): Promise<void> {
  const upd = await admin.query(
    "UPDATE partner_feature_flags SET enabled=$2, updated_at=now() WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL",
    [flag, enabled]
  );
  if (upd.rowCount === 0) {
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL,NULL,$1,$2)",
      [flag, enabled]
    );
  }
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(sql, params);
  return rows[0].n;
}

const connectorRecordCount = () => countRows("SELECT count(*)::int n FROM partner_connector_records");
const partnerIntakeSubmissionCount = () =>
  countRows("SELECT count(*)::int n FROM submissions WHERE service_type = 'partner-intake'");

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector WP-3 — production driver (disposable PostgreSQL 17, real connections)",
  () => {
    let runtime: typeof import("../server/partner/connector-runtime");

    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
      await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
      await provisionRealisticRoles(admin);
      await seedMintVaultTables();
      await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_G4);

      await admin.query("DROP ROLE IF EXISTS partner_connector_rt_test").catch(() => {});
      await admin.query("CREATE ROLE partner_connector_rt_test LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_connector_runtime TO partner_connector_rt_test");
      await admin.query("DROP ROLE IF EXISTS partner_runtime_rt_test").catch(() => {});
      await admin.query("CREATE ROLE partner_runtime_rt_test LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_runtime TO partner_runtime_rt_test");

      const connUrl = new URL(CONNECTOR_URL!);
      connUrl.username = "partner_connector_rt_test";
      connUrl.password = "synthetic";
      process.env.PARTNER_CONNECTOR_DATABASE_URL = connUrl.toString();

      const flagUrl = new URL(CONNECTOR_URL!);
      flagUrl.username = "partner_runtime_rt_test";
      flagUrl.password = "synthetic";
      process.env.PARTNER_DATABASE_URL = flagUrl.toString();

      // The cross-tenant discovery read + the observability projection run on the privileged pool.
      process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;

      await seedTenant(A, LA, UA, "rtA");
      await seedTenant(B, LB, UB, "rtB");

      // Fail-closed default: both global flags start OFF.
      await setGlobalFlag("partner_connector_enabled", false);
      await setGlobalFlag("partner_emergency_stop", false);

      runtime = await import("../server/partner/connector-runtime");
    }, 120_000);

    afterAll(async () => {
      await runtime?.stopConnectorRuntime().catch(() => undefined);
      const { closePartnerPools } = await import("../server/partner/db");
      const { closeConnectorPool } = await import("../server/partner/connector-db");
      await closePartnerPools().catch(() => undefined);
      await closeConnectorPool().catch(() => undefined);
      await admin?.query("DROP ROLE IF EXISTS partner_connector_rt_test").catch(() => undefined);
      await admin?.query("DROP ROLE IF EXISTS partner_runtime_rt_test").catch(() => undefined);
      await admin?.end().catch(() => undefined);
    });

    beforeEach(() => {
      runtime.__resetConnectorRuntimeForTest();
    });

    // ---------------------------------------------------------------------
    // Fail-closed gate
    // ---------------------------------------------------------------------
    it("flag OFF: a cycle claims nothing, creates no connector record, and imports nothing", async () => {
      await setGlobalFlag("partner_connector_enabled", false);
      await seedPendingHandoff(A, LA, UA);
      const before = await connectorRecordCount();

      const cycle = await runtime.runConnectorCycle({ singleCycle: true });

      expect(cycle.gateOpen).toBe(false);
      expect(cycle.sweep.candidates).toBe(0);
      expect(cycle.process.claimed).toBe(0);
      expect(cycle.recovery).toBeNull();
      expect(await connectorRecordCount()).toBe(before);
      expect(await partnerIntakeSubmissionCount()).toBe(0);
    });

    it("emergency stop ON (with the enabled flag also ON): the gate is still closed", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", true);
      const before = await connectorRecordCount();

      const cycle = await runtime.runConnectorCycle({ singleCycle: true });

      expect(cycle.gateOpen).toBe(false);
      expect(cycle.process.claimed).toBe(0);
      expect(await connectorRecordCount()).toBe(before);

      await setGlobalFlag("partner_emergency_stop", false);
    });

    // ---------------------------------------------------------------------
    // End-to-end: the gap this package exists to close
    // ---------------------------------------------------------------------
    it("flag ON: a pending handoff is swept, validated, and imported exactly once into real MintVault rows", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", false);
      const seeded = await seedPendingHandoff(A, LA, UA, { cardCount: 3 });

      const cycle = await runtime.runConnectorCycle({ singleCycle: true });

      expect(cycle.gateOpen).toBe(true);
      expect(cycle.sweep.candidates).toBeGreaterThanOrEqual(1);
      expect(cycle.process.imported).toBeGreaterThanOrEqual(1);

      // The connector record exists, is terminal `imported`, and is the ONE canonical record.
      const rec = await admin.query<{ id: string; state: string; tenant_id: string }>(
        "SELECT id, state, tenant_id FROM partner_connector_records WHERE handoff_id = $1",
        [seeded.handoffId]
      );
      expect(rec.rows.length).toBe(1);
      expect(rec.rows[0].state).toBe("imported");
      expect(rec.rows[0].tenant_id).toBe(A);

      // Exactly one completed import mapping.
      expect(
        await countRows(
          "SELECT count(*)::int n FROM partner_connector_imports WHERE connector_record_id=$1 AND state='completed'",
          [rec.rows[0].id]
        )
      ).toBe(1);

      // A real destination submission with an MV-SUB reference and a RESOLVED owner (never the
      // pre-existing unrelated user), plus one submission_item per card.
      const dest = await admin.query<{
        id: number;
        tracking_number: string;
        user_id: string;
        card_count: number;
        service_type: string;
        customer_email: string;
      }>(
        `SELECT s.id, s.tracking_number, s.user_id, s.card_count, s.service_type, s.customer_email
           FROM submissions s
           JOIN partner_connector_imports m ON m.destination_submission_id = s.id
          WHERE m.connector_record_id = $1`,
        [rec.rows[0].id]
      );
      expect(dest.rows.length).toBe(1);
      expect(dest.rows[0].tracking_number).toMatch(/^MV-SUB-\d{6}$/);
      expect(dest.rows[0].service_type).toBe("partner-intake");
      expect(dest.rows[0].card_count).toBe(seeded.cardCount);
      expect(dest.rows[0].user_id).not.toBe("pre-existing-unrelated");
      expect(dest.rows[0].customer_email).toBe(seeded.customerEmail);

      // Ownership is keyed by (partner_organisation_id, partner_customer_id) — never by email — so
      // the proof of a RESOLVED owner is the link row, not users.email (which is deliberately NULL
      // on connector-created rows; see connector-owner-resolution.ts).
      const link = await admin.query<{ mintvault_user_id: string; email_snapshot: string | null }>(
        `SELECT mintvault_user_id, email_snapshot FROM partner_connector_customer_links
          WHERE partner_organisation_id = $1 AND partner_customer_id = $2`,
        [A, seeded.customerId]
      );
      expect(link.rows.length).toBe(1);
      expect(link.rows[0].mintvault_user_id).toBe(dest.rows[0].user_id);
      expect(link.rows[0].email_snapshot).toBe(seeded.customerEmail);

      const owner = await admin.query<{ role: string; first_name: string | null }>(
        "SELECT role, first_name FROM users WHERE id = $1",
        [dest.rows[0].user_id]
      );
      expect(owner.rows.length).toBe(1);
      expect(owner.rows[0].role).toBe("customer");
      expect(owner.rows[0].first_name).toBe("Runtime");

      expect(
        await countRows("SELECT count(*)::int n FROM submission_items WHERE submission_id = $1", [dest.rows[0].id])
      ).toBe(seeded.cardCount);
    }, 60_000);

    it("re-running the sweep is a no-op: no second connector record and no second import", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      const recordsBefore = await connectorRecordCount();
      const submissionsBefore = await partnerIntakeSubmissionCount();

      const second = await runtime.runConnectorCycle({ singleCycle: true });

      expect(second.sweep.candidates).toBe(0);
      expect(second.sweep.created).toBe(0);
      expect(second.process.imported).toBe(0);
      expect(await connectorRecordCount()).toBe(recordsBefore);
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore);
    });

    it("tenant isolation: two tenants' handoffs each produce a record bound to their OWN tenant", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      const inA = await seedPendingHandoff(A, LA, UA, { cardCount: 1 });
      const inB = await seedPendingHandoff(B, LB, UB, { cardCount: 1 });

      await runtime.runConnectorCycle({ singleCycle: true });

      const rows = await admin.query<{ handoff_id: string; tenant_id: string }>(
        "SELECT handoff_id, tenant_id FROM partner_connector_records WHERE handoff_id = ANY($1::uuid[])",
        [[inA.handoffId, inB.handoffId]]
      );
      const byHandoff = new Map(rows.rows.map((r) => [r.handoff_id, r.tenant_id]));
      expect(byHandoff.get(inA.handoffId)).toBe(A);
      expect(byHandoff.get(inB.handoffId)).toBe(B);

      // Every destination submission still belongs to a customer of its own tenant.
      const cross = await countRows(
        `SELECT count(*)::int n
           FROM partner_connector_imports m
           JOIN partner_connector_records r ON r.id = m.connector_record_id
           JOIN partner_submissions ps ON ps.id = r.partner_submission_id
          WHERE ps.tenant_id <> r.tenant_id`
      );
      expect(cross).toBe(0);
    }, 60_000);

    // ---------------------------------------------------------------------
    // Mid-run flag flips
    // ---------------------------------------------------------------------
    it("flag flipped OFF between cycles: the next cycle halts within one cycle and imports nothing", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await seedPendingHandoff(A, LA, UA, { cardCount: 1 });
      const recordsBefore = await connectorRecordCount();
      const submissionsBefore = await partnerIntakeSubmissionCount();

      await setGlobalFlag("partner_connector_enabled", false);
      const cycle = await runtime.runConnectorCycle({ singleCycle: true });

      expect(cycle.gateOpen).toBe(false);
      expect(cycle.process.imported).toBe(0);
      expect(await connectorRecordCount()).toBe(recordsBefore);
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore);

      // ...and flipping it back ON is picked up by the very next cycle, with no restart.
      await setGlobalFlag("partner_connector_enabled", true);
      const resumed = await runtime.runConnectorCycle({ singleCycle: true });
      expect(resumed.gateOpen).toBe(true);
      expect(resumed.process.imported).toBe(1);
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore + 1);
    }, 60_000);

    it("emergency stop raised between cycles halts the next cycle and imports nothing", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await seedPendingHandoff(A, LA, UA, { cardCount: 1 });
      const submissionsBefore = await partnerIntakeSubmissionCount();

      await setGlobalFlag("partner_emergency_stop", true);
      const stopped = await runtime.runConnectorCycle({ singleCycle: true });
      expect(stopped.gateOpen).toBe(false);
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore);

      await setGlobalFlag("partner_emergency_stop", false);
      const resumed = await runtime.runConnectorCycle({ singleCycle: true });
      expect(resumed.process.imported).toBe(1);
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore + 1);
    }, 60_000);

    // ---------------------------------------------------------------------
    // Crash-safe restart
    // ---------------------------------------------------------------------
    it("crash mid-import then restart: the destination submission is created exactly once", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", false);
      const seeded = await seedPendingHandoff(A, LA, UA, { cardCount: 2 });
      const submissionsBefore = await partnerIntakeSubmissionCount();

      const { __setConnectorHook, __clearConnectorHook } = await import("../server/partner/connector-instrumentation");

      // Simulate the process dying after the destination rows are written but before the importer
      // commits: the enclosing withConnectorTx rolls the whole transaction back.
      let crashed = 0;
      __setConnectorHook((point) => {
        if (point === "before_commit" && crashed === 0) {
          crashed += 1;
          throw new Error("simulated process death before commit");
        }
      });
      const crashCycle = await runtime.runConnectorCycle({ singleCycle: true });
      __clearConnectorHook();

      expect(crashed).toBe(1);
      expect(crashCycle.process.imported).toBe(0);
      expect(crashCycle.process.failed).toBeGreaterThanOrEqual(1);
      // Nothing was left behind by the rolled-back attempt.
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore);

      // Restart: a fresh runtime instance re-claims the record (its lease is still live for the
      // dead process, so the recovery path is exercised by expiring it — exactly what a restart
      // after a real crash sees once the lease lapses).
      await admin.query(
        "UPDATE partner_connector_records SET claim_expires_at = now() - interval '1 hour' WHERE handoff_id = $1",
        [seeded.handoffId]
      );
      runtime.__resetConnectorRuntimeForTest();
      const recovered = await runtime.runConnectorCycle({ singleCycle: true });
      expect(recovered.process.imported + (recovered.recovery?.imported ?? 0)).toBeGreaterThanOrEqual(1);

      const rec = await admin.query<{ id: string; state: string }>(
        "SELECT id, state FROM partner_connector_records WHERE handoff_id = $1",
        [seeded.handoffId]
      );
      expect(rec.rows[0].state).toBe("imported");

      // EXACTLY ONE destination submission, and exactly one completed mapping.
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore + 1);
      expect(
        await countRows(
          "SELECT count(*)::int n FROM partner_connector_imports WHERE connector_record_id=$1 AND state='completed'",
          [rec.rows[0].id]
        )
      ).toBe(1);
      expect(
        await countRows("SELECT count(*)::int n FROM partner_connector_imports WHERE connector_record_id=$1", [
          rec.rows[0].id,
        ])
      ).toBe(1);
    }, 90_000);

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------
    it("no connector env: startConnectorRuntime is a no-op that never arms a timer", async () => {
      const saved = process.env.PARTNER_CONNECTOR_DATABASE_URL;
      delete process.env.PARTNER_CONNECTOR_DATABASE_URL;
      try {
        runtime.startConnectorRuntime();
        const snap = runtime.getConnectorRuntimeSnapshot();
        expect(snap.status).toBe("not_configured");
        expect(snap.cyclesCompleted).toBe(0);
        expect(snap.inFlight).toBe(false);
        await runtime.stopConnectorRuntime();
      } finally {
        process.env.PARTNER_CONNECTOR_DATABASE_URL = saved;
      }
    });

    it("start → cycle → stop: the supervisor runs, reports itself, and drains without leaking a lease", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", false);
      await seedPendingHandoff(A, LA, UA, { cardCount: 1 });

      runtime.startConnectorRuntime({ pollIntervalMs: 10, singleCycle: true });
      // The first cycle is fire-and-forget; wait for it to land rather than sleeping blindly.
      const deadline = Date.now() + 30_000;
      while (runtime.getConnectorRuntimeSnapshot().cyclesCompleted === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const snap = runtime.getConnectorRuntimeSnapshot();
      expect(snap.status).toBe("running");
      expect(snap.cyclesCompleted).toBe(1);
      expect(snap.lastCycle?.gateOpen).toBe(true);
      expect(snap.lastErrorCode).toBeNull();

      await runtime.stopConnectorRuntime();
      const after = runtime.getConnectorRuntimeSnapshot();
      expect(after.status).toBe("stopped");
      expect(after.inFlight).toBe(false);

      // No NON-TERMINAL record is left holding a live lease by this process — a terminal record
      // (imported/rejected/cancelled) keeps its historical claim fields by design and can never be
      // reclaimed, so it cannot be "leaked". Covers BOTH claimant shapes the driver produces: its
      // own `runtime:<machine>:<pid>:<rand>` identity and the recovery pool's `g3f-worker-N` ids.
      expect(
        await countRows(
          `SELECT count(*)::int n FROM partner_connector_records
            WHERE (claimed_by LIKE 'runtime:%' OR claimed_by LIKE 'g3f-worker-%')
              AND claim_expires_at > now()
              AND state NOT IN ('imported','rejected','cancelled')`
        )
      ).toBe(0);
    }, 60_000);

    it("observability: the connector-ops runtime status reports live state + backlog from existing tables", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", false);
      const svc = await import("../server/partner/connector-admin-service");

      const seeded = await seedPendingHandoff(A, LA, UA, { cardCount: 1 });
      const withBacklog = await svc.getConnectorRuntimeStatus();
      expect(withBacklog.featureEnabled).toBe(true);
      expect(withBacklog.emergencyStop).toBe(false);
      expect(withBacklog.backlog.pendingHandoffs).toBeGreaterThanOrEqual(1);
      expect(withBacklog.runtime.status).toBeDefined();

      await runtime.runConnectorCycle({ singleCycle: true });

      const drained = await svc.getConnectorRuntimeStatus();
      expect(drained.backlog.pendingHandoffs).toBe(0);
      expect(drained.backlog.queued).toBe(0);
      const imported = await admin.query<{ state: string }>(
        "SELECT state FROM partner_connector_records WHERE handoff_id=$1",
        [seeded.handoffId]
      );
      expect(imported.rows[0].state).toBe("imported");

      // No secret material in the observability payload.
      expect(JSON.stringify(drained)).not.toMatch(/password|secret|token|\$2[aby]\$/i);
    }, 60_000);

    // ---------------------------------------------------------------------
    // R1 — retryable `failed` records must not stall invisibly
    // ---------------------------------------------------------------------
    it("requeue: a failed record whose retry time has elapsed is retried; one still in the future is counted but left alone", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", false);
      const svc = await import("../server/partner/connector-admin-service");

      const due = await seedFailedRecord(A, LA, UA, "past");
      const notDue = await seedFailedRecord(A, LA, UA, "future");

      // Both are visible as `failed`; only the elapsed one is reported retryable.
      const before = await svc.getConnectorRuntimeStatus();
      expect(before.backlog.failed).toBeGreaterThanOrEqual(2);
      expect(before.backlog.retryableFailed).toBeGreaterThanOrEqual(1);
      const submissionsBefore = await partnerIntakeSubmissionCount();

      const cycle = await runtime.runConnectorCycle({ singleCycle: true });

      // Only the due record was picked up — the future one was never a candidate.
      expect(cycle.requeue.candidates).toBe(1);
      expect(cycle.requeue.requeued).toBe(1);
      expect(cycle.requeue.failed).toBe(0);
      expect(cycle.process.imported).toBe(1);
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore + 1);

      const states = await admin.query<{ id: string; state: string }>(
        "SELECT id, state FROM partner_connector_records WHERE id = ANY($1::uuid[])",
        [[due.connectorId, notDue.connectorId]]
      );
      const byId = new Map(states.rows.map((r) => [r.id, r.state]));
      expect(byId.get(due.connectorId)).toBe("imported");
      expect(byId.get(notDue.connectorId)).toBe("failed");

      // The counters moved the way an operator would need them to.
      const after = await svc.getConnectorRuntimeStatus();
      expect(after.backlog.retryableFailed).toBe(before.backlog.retryableFailed - 1);
      expect(after.backlog.failed).toBe(before.backlog.failed - 1);
    }, 60_000);

    // ---------------------------------------------------------------------
    // R2 — the admin identity must be pinned, never inherited by fallback
    // ---------------------------------------------------------------------
    it("admin URL not pinned: the runtime parks visibly and never sweeps", async () => {
      const saved = process.env.PARTNER_ADMIN_DATABASE_URL;
      delete process.env.PARTNER_ADMIN_DATABASE_URL;
      try {
        runtime.startConnectorRuntime({ pollIntervalMs: 10, singleCycle: true });
        const snap = runtime.getConnectorRuntimeSnapshot();
        expect(snap.status).toBe("stopped");
        expect(snap.idleReason).toBe("admin_url_not_pinned");
        expect(snap.lastErrorCode).toBe("admin_url_not_pinned");
        // Parked BEFORE any work: no cycle ran, so nothing was swept.
        expect(snap.cyclesCompleted).toBe(0);
        expect(snap.lastCycle).toBeNull();
        await runtime.stopConnectorRuntime();
      } finally {
        process.env.PARTNER_ADMIN_DATABASE_URL = saved;
      }
    });

    // ---------------------------------------------------------------------
    // R3 — "flag store down" must not masquerade as "flag switched off"
    // ---------------------------------------------------------------------
    it("flag store unreachable: reported distinctly, never as flag_disabled", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", false);
      const { closePartnerPools } = await import("../server/partner/db");
      const savedFlagUrl = process.env.PARTNER_DATABASE_URL;
      const submissionsBefore = await partnerIntakeSubmissionCount();
      await seedPendingHandoff(A, LA, UA, { cardCount: 1 });

      // Point the runtime's flag read at a port nothing listens on.
      await closePartnerPools();
      process.env.PARTNER_DATABASE_URL = "postgresql://nobody:nobody@127.0.0.1:1/nope";
      try {
        runtime.startConnectorRuntime({ pollIntervalMs: 10, singleCycle: true });
        const deadline = Date.now() + 30_000;
        while (runtime.getConnectorRuntimeSnapshot().cyclesCompleted === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const snap = runtime.getConnectorRuntimeSnapshot();
        expect(snap.idleReason).toBe("flag_store_unreachable");
        expect(snap.idleReason).not.toBe("flag_disabled");
        expect(snap.lastErrorCode).toBe("flag_store_unreachable");
        expect(snap.lastCycle?.gateOpen).toBe(false);
        expect(snap.lastCycle?.idleReason).toBe("flag_store_unreachable");
        // Blind means idle: nothing was claimed or imported while the store was down.
        expect(snap.lastCycle?.process.claimed).toBe(0);
        expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore);
        await runtime.stopConnectorRuntime();
      } finally {
        await closePartnerPools();
        process.env.PARTNER_DATABASE_URL = savedFlagUrl;
      }

      // Sanity: with the store reachable again the SAME handoff proceeds normally, proving the
      // previous cycle idled because of the outage and not because of anything it changed.
      runtime.__resetConnectorRuntimeForTest();
      const recovered = await runtime.runConnectorCycle({ singleCycle: true });
      expect(recovered.gateOpen).toBe(true);
      expect(recovered.idleReason).toBeNull();
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore + 1);
    }, 90_000);

    // ---------------------------------------------------------------------
    // R5 — two drivers racing the same backlog
    // ---------------------------------------------------------------------
    it("two concurrent drivers over N ready handoffs produce exactly N submissions and N import mappings", async () => {
      await setGlobalFlag("partner_connector_enabled", true);
      await setGlobalFlag("partner_emergency_stop", false);
      const N = 4;
      // Seeded sequentially: the fixture shares one pg Client, and concurrent queries on a single
      // client are serialised with a deprecation warning. The CONCURRENCY under test is the two
      // drivers below, not the seeding.
      const handoffIds: string[] = [];
      for (let i = 0; i < N; i += 1) {
        handoffIds.push((await seedPendingHandoff(A, LA, UA, { cardCount: 1 })).handoffId);
      }
      const submissionsBefore = await partnerIntakeSubmissionCount();

      // Two INDEPENDENT drivers with distinct claimant identities, racing the same backlog.
      await Promise.all([
        runtime.runConnectorCycle({ singleCycle: true, claimant: "runtime:test-driver-a:1:aaaa" }),
        runtime.runConnectorCycle({ singleCycle: true, claimant: "runtime:test-driver-b:2:bbbb" }),
      ]);

      // Exactly one connector record, one completed mapping and one destination submission per
      // handoff — no double import, no orphan.
      expect(
        await countRows("SELECT count(*)::int n FROM partner_connector_records WHERE handoff_id = ANY($1::uuid[])", [
          handoffIds,
        ])
      ).toBe(N);
      expect(
        await countRows(
          `SELECT count(*)::int n FROM partner_connector_records
            WHERE handoff_id = ANY($1::uuid[]) AND state = 'imported'`,
          [handoffIds]
        )
      ).toBe(N);
      expect(
        await countRows(
          `SELECT count(*)::int n
             FROM partner_connector_imports m
             JOIN partner_connector_records r ON r.id = m.connector_record_id
            WHERE r.handoff_id = ANY($1::uuid[]) AND m.state = 'completed'`,
          [handoffIds]
        )
      ).toBe(N);
      expect(await partnerIntakeSubmissionCount()).toBe(submissionsBefore + N);

      // Every destination reference is distinct — no two records adopted the same submission.
      expect(
        await countRows(
          `SELECT count(DISTINCT m.destination_submission_id)::int n
             FROM partner_connector_imports m
             JOIN partner_connector_records r ON r.id = m.connector_record_id
            WHERE r.handoff_id = ANY($1::uuid[])`,
          [handoffIds]
        )
      ).toBe(N);
    }, 90_000);
  }
);
