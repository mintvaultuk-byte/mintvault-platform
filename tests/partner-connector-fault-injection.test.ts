/**
 * Trusted Intake Connector — Phase G3F FINAL: deterministic failure-injection + crash-recovery proof
 * (disposable Postgres, real connections — not mocks). Uses connector-instrumentation.ts's test-only
 * hook to throw at labelled points inside the importer's single transaction, plus out-of-band
 * techniques (pg_terminate_backend, statement_timeout, lock_timeout, pool saturation) for the
 * connection/timeout cases. See FAILURE-INJECTION-MATRIX.md.
 *
 * Runs ONLY when PARTNER_CONNECTOR_FAULT_RT_ADMIN + PARTNER_CONNECTOR_FAULT_RT_URL are set.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_G3F,
} from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_CONNECTOR_FAULT_RT_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_FAULT_RT_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-8000-0000-0000-000000000001";
const L1 = "10000000-8000-0000-0000-0000000000c1";
const U1 = "11111111-8000-0000-0000-0000000000a1";

let admin: Client;
let seq = 0;
const uuid = (n: number) => `80000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

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
  for (const t of ["users", "submissions", "submission_items"])
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
}

async function seedTenant(): Promise<void> {
  await admin.query(
    "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'faultA','faultA','ACTIVE') ON CONFLICT DO NOTHING",
    [A]
  );
  await admin.query(
    "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'faultA-loc',$2,$2,'HQ','ACTIVE') ON CONFLICT DO NOTHING",
    [L1, A]
  );
  await admin.query(
    "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES ($1,'faultA-user',$2,$2,'faultA@example.com','x','ACTIVE',false) ON CONFLICT DO NOTHING",
    [U1, A]
  );
  await admin.query(
    "INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES ($1,'standard','Standard',1500,10,true) ON CONFLICT DO NOTHING",
    [A]
  );
}

/** Seed a connector, claim it, and leave it ready_for_import claimed by `claimant` (live lease). */
async function seedClaimedReady(
  claimant: string,
  itemCount = 2
): Promise<{ connectorId: string; version: number; customerId: string }> {
  seq += 1;
  const subId = uuid(seq);
  const custId = uuid(seq + 300_000);
  await admin.query("INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,$3,$4)", [
    custId,
    A,
    `Fault Customer ${seq}`,
    `fault${seq}@example.com`,
  ]);
  await admin.query(
    `INSERT INTO partner_submissions (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
     VALUES ($1,$2,$3,$4,$5,'standard',$6,$7,'submitted_to_mintvault')`,
    [subId, A, L1, U1, custId, 1500 * itemCount, itemCount]
  );
  for (let i = 1; i <= itemCount; i++) {
    await admin.query(
      `INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, declared_value_pence, quantity) VALUES ($1,$2,$3,$4,50000,1)`,
      [A, subId, i, `Card ${i}`]
    );
  }
  const h = await admin.query(
    "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
    [A, subId]
  );
  const svc = await import("../server/partner/connector-service");
  const validation = await import("../server/partner/connector-validation-service");
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
  return { connectorId: rec.id, version: rows[0].version, customerId: custId };
}

async function dbState(connectorId: string) {
  const rec = await admin.query<{ state: string }>("SELECT state FROM partner_connector_records WHERE id = $1", [
    connectorId,
  ]);
  const mappings = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = $1",
    [connectorId]
  );
  const completed = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = $1 AND state = 'completed'",
    [connectorId]
  );
  const attempts = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM partner_connector_import_attempts WHERE connector_record_id = $1",
    [connectorId]
  );
  const subs = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM submissions WHERE id IN (SELECT destination_submission_id FROM partner_connector_imports WHERE connector_record_id = $1 AND destination_submission_id IS NOT NULL)",
    [connectorId]
  );
  return {
    state: rec.rows[0]?.state,
    mappings: mappings.rows[0].n,
    completed: completed.rows[0].n,
    attempts: attempts.rows[0].n,
    subs: subs.rows[0].n,
  };
}

// Every hook point the importer actually emits (see connector-import-service.ts hook() calls). Each
// is inside the single import transaction and precedes the destination commit, so a fault at any of
// them must roll the whole transaction back with no partial destination, then a clean retry succeeds.
const ROLLBACK_POINTS = [
  "before_validation_recheck",
  "after_validation_recheck",
  "before_reservation",
  "after_reservation",
  "after_owner_resolution",
  "after_submission_insert",
  "during_item_insert",
  "after_items",
  "before_mapping_completion",
  "after_mapping_completion",
  "before_connector_imported",
  "before_commit",
] as const;

(isLocal ? describe : describe.skip)("Trusted Intake Connector G3F FINAL — failure injection & crash recovery", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_G3F);
    await admin.query("DROP ROLE IF EXISTS partner_connector_fault_test").catch(() => {});
    await admin.query("CREATE ROLE partner_connector_fault_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_connector_runtime TO partner_connector_fault_test");
    await admin.query("DROP ROLE IF EXISTS partner_fault_conn").catch(() => {});
    await admin.query("CREATE ROLE partner_fault_conn LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_fault_conn");
    process.env.PARTNER_CONNECTOR_DATABASE_URL = CONNECTOR_URL;
    const flagUrl = new URL(CONNECTOR_URL!);
    flagUrl.username = "partner_fault_conn";
    flagUrl.password = "synthetic";
    process.env.PARTNER_DATABASE_URL = flagUrl.toString();
    await seedTenant();
    await admin.query(
      "INSERT INTO partner_feature_flags (flag, tenant_id, location_id, enabled) VALUES ('partner_connector_enabled', NULL, NULL, true), ('partner_emergency_stop', NULL, NULL, false)"
    );
  }, 60_000);

  afterEach(async () => {
    const { __clearConnectorHook } = await import("../server/partner/connector-instrumentation");
    __clearConnectorHook();
    delete process.env.PARTNER_CONNECTOR_STATEMENT_TIMEOUT_MS;
    delete process.env.PARTNER_CONNECTOR_LOCK_TIMEOUT_MS;
  });

  afterAll(async () => {
    const { closeConnectorPool } = await import("../server/partner/connector-db");
    const { closePartnerPools } = await import("../server/partner/db");
    await closeConnectorPool();
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  describe("single-transaction rollback at each fault point (no partial destination, clean retry)", () => {
    for (const point of ROLLBACK_POINTS) {
      it(`fault at '${point}' rolls the whole transaction back, then a clean retry succeeds`, async () => {
        const { __setConnectorHook } = await import("../server/partner/connector-instrumentation");
        const importer = await import("../server/partner/connector-import-service");
        const claimant = `fault-${point}`;
        const seeded = await seedClaimedReady(claimant);

        __setConnectorHook((p) => {
          if (p === point) throw new Error(`injected fault at ${point}`);
        });
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant,
            expectedVersion: seeded.version,
            tenantId: A,
          })
        ).rejects.toBeTruthy();

        // Nothing partial persisted.
        const after = await dbState(seeded.connectorId);
        expect(after.state).toBe("ready_for_import");
        expect(after.completed).toBe(0);
        expect(after.subs).toBe(0);
        expect(after.mappings).toBe(0); // reserved INSERT (if reached) rolled back in the same txn
        expect(after.attempts).toBe(0); // no committed attempt row

        // Clean retry (hook cleared) succeeds and creates exactly one destination.
        const { __clearConnectorHook } = await import("../server/partner/connector-instrumentation");
        __clearConnectorHook();
        const retry = await importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant,
          expectedVersion: seeded.version,
          tenantId: A,
        });
        expect(retry.outcome).toBe("imported");
        const done = await dbState(seeded.connectorId);
        expect(done.state).toBe("imported");
        expect(done.completed).toBe(1);
        expect(done.subs).toBe(1);
        expect(done.attempts).toBe(1);
      });
    }
  });

  describe("connection & timeout failures", () => {
    it("connection termination mid-transaction: no partial destination, record recoverable", async () => {
      const { __setConnectorHook } = await import("../server/partner/connector-instrumentation");
      const importer = await import("../server/partner/connector-import-service");
      const claimant = "fault-conn-term";
      const seeded = await seedClaimedReady(claimant);
      // The hook runs inside the importer's own transaction and now carries that transaction's client
      // — terminate its backend from within, a genuine mid-transaction connection death.
      __setConnectorHook(async (p, ctx) => {
        if (p === "after_submission_insert" && ctx.client) {
          // OWN the error this test deliberately causes. Killing the backend makes node-postgres
          // emit 'error' ("Connection terminated unexpectedly") on this very client. The connector
          // pool is module-private, so nothing else is listening, and an EventEmitter 'error' with
          // no listener becomes an UNHANDLED ERROR: vitest then exits 1 even though all 21 tests
          // pass, turning the whole CI build red. This suite was describe.skip'd for months, so the
          // latent rejection only became visible once the suite was actually wired into CI.
          //
          // Attaching a listener to the dying client absorbs exactly that one expected event, on
          // exactly the connection this test kills. It changes NOTHING about the fault injection or
          // any assertion below: the backend is still terminated mid-transaction, the importer still
          // observes the dead connection, and the rejection/rollback/recovery assertions are
          // untouched. HookClient is typed with only `query` (it avoids a pg dependency), but the
          // runtime object is the pg.PoolClient, hence the narrow structural cast.
          const dyingClient = ctx.client as unknown as {
            on?: (event: string, listener: (err: unknown) => void) => void;
          };
          dyingClient.on?.("error", () => {
            /* expected: this backend is being terminated by the line below */
          });
          await ctx.client.query("SELECT pg_terminate_backend(pg_backend_pid())").catch(() => {
            /* the terminate itself may surface as an error — that's the point */
          });
          // force the importer to observe the dead connection on its next statement
          throw Object.assign(new Error("connection terminated"), { code: "57P01" });
        }
      });
      await expect(
        importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant,
          expectedVersion: seeded.version,
          tenantId: A,
        })
      ).rejects.toBeTruthy();
      // the pool must discard the dead client; force a fresh pool for the retry
      const { closeConnectorPool: closePool } = await import("../server/partner/connector-db");
      await closePool();
      const after = await dbState(seeded.connectorId);
      expect(after.state).toBe("ready_for_import");
      expect(after.completed).toBe(0);
      expect(after.subs).toBe(0);
      // pool still works afterwards
      const { __clearConnectorHook } = await import("../server/partner/connector-instrumentation");
      __clearConnectorHook();
      const retry = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(retry.outcome).toBe("imported");
    });

    it("statement timeout: a slow statement inside the transaction aborts and rolls back, no partial destination", async () => {
      const { __setConnectorHook } = await import("../server/partner/connector-instrumentation");
      const importer = await import("../server/partner/connector-import-service");
      const { closeConnectorPool } = await import("../server/partner/connector-db");
      const claimant = "fault-stmt-timeout";
      const seeded = await seedClaimedReady(claimant);
      process.env.PARTNER_CONNECTOR_STATEMENT_TIMEOUT_MS = "150";
      await closeConnectorPool(); // ensure a fresh session picks up the SET LOCAL timeout
      // Run a real slow statement on the importer's OWN transaction connection — statement_timeout
      // (150ms) aborts the pg_sleep(1), aborting the transaction. Proves the bounded-timeout setting
      // is active inside withConnectorTx and that the resulting failure leaves no partial destination.
      __setConnectorHook(async (p, ctx) => {
        if (p === "after_submission_insert" && ctx.client) {
          await ctx.client.query("SELECT pg_sleep(1)");
        }
      });
      await expect(
        importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant,
          expectedVersion: seeded.version,
          tenantId: A,
        })
      ).rejects.toBeTruthy();
      const after = await dbState(seeded.connectorId);
      expect(after.state).toBe("ready_for_import");
      expect(after.completed).toBe(0);
      expect(after.subs).toBe(0);
      // a normal import still works after the timeout setting is cleared
      const { __clearConnectorHook } = await import("../server/partner/connector-instrumentation");
      __clearConnectorHook();
      delete process.env.PARTNER_CONNECTOR_STATEMENT_TIMEOUT_MS;
      await closeConnectorPool();
      const retry = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(retry.outcome).toBe("imported");
    });

    it("lock timeout: a blocked FOR UPDATE fails fast with a bounded error, no duplicate", async () => {
      const importer = await import("../server/partner/connector-import-service");
      const { closeConnectorPool } = await import("../server/partner/connector-db");
      const claimant = "fault-lock-timeout";
      const seeded = await seedClaimedReady(claimant);
      // Hold a FOR UPDATE lock on the connector row from a separate admin transaction.
      const holder = new Client({ connectionString: ADMIN });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM partner_connector_records WHERE id = $1 FOR UPDATE", [seeded.connectorId]);
      try {
        process.env.PARTNER_CONNECTOR_LOCK_TIMEOUT_MS = "200";
        await closeConnectorPool();
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant,
            expectedVersion: seeded.version,
            tenantId: A,
          })
        ).rejects.toBeTruthy(); // lock_timeout -> normalised connector error
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
        delete process.env.PARTNER_CONNECTOR_LOCK_TIMEOUT_MS;
        await closeConnectorPool();
      }
      // no partial destination; record recoverable
      const after = await dbState(seeded.connectorId);
      expect(after.completed).toBe(0);
      const retry = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(retry.outcome).toBe("imported");
    });

    it("pool saturation: bounded acquisition timeout, no client leak, pool works afterwards", async () => {
      const importer = await import("../server/partner/connector-import-service");
      const { closeConnectorPool } = await import("../server/partner/connector-db");
      // pool max 1 + a short acquisition timeout: concurrent callers beyond 1 get a bounded error.
      process.env.PARTNER_CONNECTOR_DB_POOL_MAX = "1";
      process.env.PARTNER_CONNECTOR_ACQUIRE_TIMEOUT_MS = "200";
      await closeConnectorPool();
      try {
        const claimants = await Promise.all([0, 1, 2, 3].map((i) => seedClaimedReady(`fault-sat-${i}`)));
        const results = await Promise.allSettled(
          claimants.map((c, i) =>
            importer.importValidatedConnector({
              connectorId: c.connectorId,
              claimant: `fault-sat-${i}`,
              expectedVersion: c.version,
              tenantId: A,
            })
          )
        );
        // at least one should have succeeded and the set is bounded (no hang); some may reject with a
        // bounded acquisition/connection error rather than hanging forever.
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      } finally {
        delete process.env.PARTNER_CONNECTOR_DB_POOL_MAX;
        delete process.env.PARTNER_CONNECTOR_ACQUIRE_TIMEOUT_MS;
        await closeConnectorPool();
      }
      // pool works normally after restoring config
      const c = await seedClaimedReady("fault-sat-after");
      const ok = await importer.importValidatedConnector({
        connectorId: c.connectorId,
        claimant: "fault-sat-after",
        expectedVersion: c.version,
        tenantId: A,
      });
      expect(ok.outcome).toBe("imported");
    }, 60_000);
  });

  describe("recovery & idempotency", () => {
    it("lost response after commit: a retry returns the same destination, zero new submissions", async () => {
      const importer = await import("../server/partner/connector-import-service");
      const claimant = "fault-lost-resp";
      const seeded = await seedClaimedReady(claimant);
      const first = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(first.outcome).toBe("imported");
      const before = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions");
      const retry = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(retry.outcome).toBe("already_completed");
      expect(retry.destinationSubmissionId).toBe(first.destinationSubmissionId);
      const after = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("worker death: lease expires, another worker reclaims, the dead worker cannot commit", async () => {
      const svc = await import("../server/partner/connector-service");
      const importer = await import("../server/partner/connector-import-service");
      const claimant = "fault-dead-worker";
      const seeded = await seedClaimedReady(claimant);
      // Simulate the worker dying: expire its lease.
      await admin.query(
        "UPDATE partner_connector_records SET claim_expires_at = now() - interval '1 hour' WHERE id = $1",
        [seeded.connectorId]
      );
      // A new worker reclaims (state preserved for ready_for_import).
      const reclaimed = await svc.claimConnectorRecord(seeded.connectorId, "worker-alive", 300, A);
      expect(reclaimed.state).toBe("ready_for_import");
      // The dead worker can no longer commit.
      await expect(
        importer.importValidatedConnector({
          connectorId: seeded.connectorId,
          claimant,
          expectedVersion: seeded.version,
          tenantId: A,
        })
      ).rejects.toMatchObject({ code: "import_claimant_mismatch" });
      // The live worker imports successfully.
      const ok = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant: "worker-alive",
        expectedVersion: reclaimed.version,
        tenantId: A,
      });
      expect(ok.outcome).toBe("imported");
    });

    it("stale source mutation: import blocked, stale attempt appended, no destination", async () => {
      const importer = await import("../server/partner/connector-import-service");
      const claimant = "fault-stale";
      const seeded = await seedClaimedReady(claimant);
      await admin.query("UPDATE partner_customers SET full_name = 'Mutated' WHERE id = $1", [seeded.customerId]);
      const outcome = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(outcome.outcome).toBe("stale");
      const after = await dbState(seeded.connectorId);
      expect(after.state).toBe("validating");
      expect(after.completed).toBe(0);
      const staleAttempts = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM partner_connector_import_attempts WHERE connector_record_id = $1 AND outcome = 'stale'",
        [seeded.connectorId]
      );
      expect(staleAttempts.rows[0].n).toBe(1);
    });
  });

  describe("flags mid-run (fail-closed)", () => {
    it("emergency stop blocks new claims and new imports", async () => {
      const svc = await import("../server/partner/connector-service");
      const importer = await import("../server/partner/connector-import-service");
      const claimant = "fault-estop";
      const seeded = await seedClaimedReady(claimant);
      await admin.query(
        "UPDATE partner_feature_flags SET enabled = true WHERE flag = 'partner_emergency_stop' AND tenant_id IS NULL"
      );
      try {
        await expect(svc.claimNextConnectorRecord("estop-worker", 60)).rejects.toMatchObject({
          code: "emergency_stop",
        });
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant,
            expectedVersion: seeded.version,
            tenantId: A,
          })
        ).rejects.toMatchObject({ code: "import_emergency_stopped" });
      } finally {
        await admin.query(
          "UPDATE partner_feature_flags SET enabled = false WHERE flag = 'partner_emergency_stop' AND tenant_id IS NULL"
        );
      }
      // works again after the stop is lifted
      const ok = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(ok.outcome).toBe("imported");
    });

    it("feature flag OFF fails closed (no new work)", async () => {
      const svc = await import("../server/partner/connector-service");
      const importer = await import("../server/partner/connector-import-service");
      const claimant = "fault-flagoff";
      const seeded = await seedClaimedReady(claimant);
      await admin.query(
        "UPDATE partner_feature_flags SET enabled = false WHERE flag = 'partner_connector_enabled' AND tenant_id IS NULL"
      );
      try {
        await expect(svc.claimNextConnectorRecord("off-worker", 60)).rejects.toMatchObject({
          code: "feature_disabled",
        });
        await expect(
          importer.importValidatedConnector({
            connectorId: seeded.connectorId,
            claimant,
            expectedVersion: seeded.version,
            tenantId: A,
          })
        ).rejects.toMatchObject({ code: "feature_disabled" });
      } finally {
        await admin.query(
          "UPDATE partner_feature_flags SET enabled = true WHERE flag = 'partner_connector_enabled' AND tenant_id IS NULL"
        );
      }
      const ok = await importer.importValidatedConnector({
        connectorId: seeded.connectorId,
        claimant,
        expectedVersion: seeded.version,
        tenantId: A,
      });
      expect(ok.outcome).toBe("imported");
    });
  });
});
