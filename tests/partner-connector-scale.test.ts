/**
 * Trusted Intake Connector — Phase G3F FINAL: 100-record / 10-worker full-scale proof (disposable
 * Postgres, realistic non-superuser role model, real bounded worker pool over separate pooled
 * connections — not mocks). Deterministic seed (fixed integer sequence, no Math.random, no wall-clock
 * in ids). See LOAD-MODEL.md for the exact population.
 *
 * Runs ONLY when PARTNER_CONNECTOR_SCALE_RT_ADMIN + PARTNER_CONNECTOR_SCALE_RT_URL are set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  provisionRealisticRoles,
  PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE,
  pinAccountingTopologyTo,
} from "./helpers/partner-realistic-db";

vi.mock("../server/r2", () => ({
  headR2: vi.fn(async () => ({
    lastModified: new Date("2026-08-05T00:00:00.000Z"),
    contentLength: 1024,
    contentType: "image/jpeg",
    eTag: '"scale-fixture"',
  })),
}));

const ADMIN = process.env.PARTNER_CONNECTOR_SCALE_RT_ADMIN;
const CONNECTOR_URL = process.env.PARTNER_CONNECTOR_SCALE_RT_URL;
const isLocal = !!ADMIN && !!CONNECTOR_URL && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

let admin: Client;
let seq = 0;
const uuid = (n: number) => `70000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// 5 organisations, 2-3 locations each (deterministic).
const ORGS = [1, 2, 3, 4, 5].map((i) => ({
  id: `aaaaaaaa-7000-0000-0000-${String(i).padStart(12, "0")}`,
  ref: `scaleOrg${i}`,
  locations: (i <= 2 ? [1, 2] : [1, 2, 3]).map((j) => ({
    id: `10000000-7000-0000-${String(i).padStart(4, "0")}-${String(j).padStart(12, "0")}`,
    ref: `scaleOrg${i}-loc${j}`,
  })),
  userId: `11111111-7000-0000-0000-${String(i).padStart(12, "0")}`,
}));

// Reused customer emails across DIFFERENT orgs (cross-tenant no-link proof).
const SHARED_EMAILS = ["shared-a@example.com", "shared-b@example.com", "shared-c@example.com"];

interface SeededConnector {
  connectorId: string;
  orgId: string;
  locationId: string;
  customerId: string;
  submissionId: string;
  handoffId: string;
  category: string;
  itemCount: number;
  email: string;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query(`CREATE TABLE IF NOT EXISTS users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar UNIQUE, first_name varchar, last_name varchar,
    role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamptz NOT NULL DEFAULT now())`);
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
  await admin.query(`CREATE TABLE IF NOT EXISTS cards (id serial PRIMARY KEY, submission_id integer, card_name text)`);
  // Forbidden-side-effect fixtures: representative MintVault tables the importer must NEVER touch.
  await admin.query(`CREATE TABLE IF NOT EXISTS certificates (
    id serial PRIMARY KEY, certificate_number text, cert_id text, card_id integer, submission_item_id integer,
    status text, label_type text, grade_type text, language text, card_game text, set_name text,
    card_name text, card_number_display text, year_text text, variant text, front_image_path text,
    back_image_path text, grading_front_original text, grading_back_original text, created_by text,
    issued_at timestamptz, updated_at timestamptz, reference_number text, logbook_version integer,
    logbook_last_issued_at timestamptz, integrity_hash text, print_state text, grader_status text,
    origin_type text, origin_partner_id uuid, origin_partner_public_ref text, origin_partner_legal_name text,
    origin_partner_trading_name text, origin_location_id uuid, origin_location_public_ref text,
    origin_location_name text, origin_location_address text, origin_captured_at timestamptz,
    origin_snapshot_version integer
  )`);
  await admin.query(`CREATE TABLE IF NOT EXISTS cert_counter (
    id integer PRIMARY KEY DEFAULT 1,
    last_issued integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now())`);
  await admin.query(`CREATE TABLE IF NOT EXISTS labels (id serial PRIMARY KEY, cert_id text)`);
  await admin.query(`CREATE TABLE IF NOT EXISTS payments (id serial PRIMARY KEY, amount integer)`);
  await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
    admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
  await admin.query("INSERT INTO certificates (cert_id) VALUES ('SEED-CERT') ON CONFLICT DO NOTHING");
  await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 42) ON CONFLICT DO NOTHING");
  await admin.query("INSERT INTO labels (cert_id) VALUES ('SEED-LABEL') ON CONFLICT DO NOTHING");
  await admin.query("INSERT INTO payments (amount) VALUES (999) ON CONFLICT DO NOTHING");
  for (const t of [
    "users",
    "submissions",
    "submission_items",
    "cards",
    "certificates",
    "audit_log",
    "cert_counter",
    "labels",
    "payments",
  ]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function seedOrgs(): Promise<void> {
  for (const org of ORGS) {
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,$2,$2,'ACTIVE') ON CONFLICT DO NOTHING",
      [org.id, org.ref]
    );
    for (const loc of org.locations) {
      await admin.query(
        "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,$2,$3,$3,'HQ','ACTIVE') ON CONFLICT DO NOTHING",
        [loc.id, loc.ref, org.id]
      );
    }
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES ($1,$2,$3,$3,$4,'x','ACTIVE',false) ON CONFLICT DO NOTHING",
      [org.userId, org.ref + "-user", org.id, `${org.ref}@example.com`]
    );
    await admin.query(
      "INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES ($1,'standard','Standard',1500,10,true) ON CONFLICT DO NOTHING",
      [org.id]
    );
  }
}

/** Seed one connector and drive it to ready_for_import via the real claim/validate flow. */
async function seedValidatedReady(index: number, itemCount: number, email: string): Promise<SeededConnector> {
  seq += 1;
  const org = ORGS[index % ORGS.length];
  const loc = org.locations[index % org.locations.length];
  const subId = uuid(seq);
  const custId = uuid(seq + 200_000);
  await admin.query("INSERT INTO partner_customers (id, tenant_id, full_name, email) VALUES ($1,$2,$3,$4)", [
    custId,
    org.id,
    `Scale Customer ${seq}`,
    email,
  ]);
  await admin.query(
    `INSERT INTO partner_submissions
       (id, tenant_id, location_id, created_by, customer_id, service_tier_code, estimated_price_pence, card_count, status)
     VALUES ($1,$2,$3,$4,$5,'standard',$6,$7,'submitted_to_mintvault')`,
    [subId, org.id, loc.id, org.userId, custId, 1500 * itemCount, itemCount]
  );
  for (let i = 1; i <= itemCount; i++) {
    const cardId = uuid(400_000 + seq * 10 + i);
    await admin.query(
      `INSERT INTO partner_submission_cards
         (id, tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, declared_value_pence, quantity, front_image_key, back_image_key)
       VALUES ($1,$2,$3,$4,$5,'pokemon','Base Set','4/102',1999,50000,1,$6,$7)`,
      [
        cardId,
        org.id,
        subId,
        i,
        `Card ${i}`,
        `partner-submissions/${org.id}/${subId}/${cardId}/front-seed.jpg`,
        `partner-submissions/${org.id}/${subId}/${cardId}/back-seed.jpg`,
      ]
    );
  }
  const h = await admin.query(
    "INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id",
    [org.id, subId]
  );
  const handoffId = h.rows[0].id;

  const svc = await import("../server/partner/connector-service");
  const validation = await import("../server/partner/connector-validation-service");
  const claimant = `seed-${seq}`;
  let rec = await svc.ensureConnectorRecordForHandoff({ tenantId: org.id, handoffId });
  rec = await svc.claimConnectorRecord(rec.id, claimant, 300, org.id);
  rec = await svc.transitionConnectorState({
    connectorId: rec.id,
    claimant,
    tenantId: org.id,
    expectedVersion: rec.version,
    toState: "validating",
    eventType: "validating",
  });
  const run = await validation.validateConnectorRecord({
    connectorId: rec.id,
    claimant,
    expectedVersion: rec.version,
    tenantId: org.id,
  });
  expect(run.outcome).toBe("valid");
  return {
    connectorId: rec.id,
    orgId: org.id,
    locationId: loc.id,
    customerId: custId,
    submissionId: subId,
    handoffId,
    category: "valid",
    itemCount,
    email,
  };
}

// Shared state produced in beforeAll and asserted across the individual it() blocks.
let seeded: SeededConnector[] = [];
let workerResult: import("../server/partner/connector-worker").WorkerPoolResult;
let importableIds: string[] = [];
let staleIds: string[] = [];
let cancelledIds: string[] = [];
let rejectedIds: string[] = [];
let elapsedMs = 0;
let importDurations: number[] = [];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

(isLocal ? describe : describe.skip)("Trusted Intake Connector G3F FINAL — 100-record / 10-worker scale proof", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query("GRANT ALL ON SCHEMA public TO public");
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await admin.query("DROP OWNED BY partner_connector_runtime").catch(() => {});
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE);

    await admin.query("DROP ROLE IF EXISTS partner_connector_scale_test").catch(() => {});
    await admin.query("CREATE ROLE partner_connector_scale_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_connector_runtime TO partner_connector_scale_test");
    await admin.query("DROP ROLE IF EXISTS partner_scale_conn").catch(() => {});
    await admin.query("CREATE ROLE partner_scale_conn LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_scale_conn");

    process.env.PARTNER_CONNECTOR_DATABASE_URL = CONNECTOR_URL;
    // CI pins MINTVAULT_DATABASE_URL globally to a DIFFERENT database; the G6D accounting
    // topology assertion in server/partner/db.ts then throws. Pin it to this suite's own.
    pinAccountingTopologyTo(CONNECTOR_URL);
    process.env.PARTNER_CONNECTOR_DB_POOL_MAX = "12"; // 10 workers + headroom
    const flagUrl = new URL(CONNECTOR_URL!);
    flagUrl.username = "partner_scale_conn";
    flagUrl.password = "synthetic";
    process.env.PARTNER_DATABASE_URL = flagUrl.toString();
    // Ensure a fresh pool picks up the max=12 setting.
    const { closeConnectorPool } = await import("../server/partner/connector-db");
    await closeConnectorPool();

    await seedOrgs();
    await admin.query(
      "INSERT INTO partner_feature_flags (flag, tenant_id, location_id, enabled) VALUES ('partner_connector_enabled', NULL, NULL, true), ('partner_emergency_stop', NULL, NULL, false)"
    );

    // ---- Seed 100 connectors deterministically (LOAD-MODEL.md) ----
    // item-count distribution across the 90 ready_for_import records
    const itemCountFor = (i: number): number => {
      if (i < 20) return 1;
      if (i < 40) return [2, 3, 4][i % 3];
      if (i < 60) return [5, 6, 7, 8, 9, 10][i % 6];
      return [1, 2, 3, 4, 5, 6, 7, 8][i % 8];
    };

    // 90 ready_for_import (70 valid + 5 expired-claim + 5 interrupted + 10 stale), 5 cancelled, 5 rejected
    const readyForImport: SeededConnector[] = [];
    for (let i = 0; i < 90; i++) {
      const email = i < 6 ? SHARED_EMAILS[i % SHARED_EMAILS.length] : `scale${i}@example.com`;
      const s = await seedValidatedReady(i, itemCountFor(i), email);
      readyForImport.push(s);
    }
    // categorise the 90
    const valid = readyForImport.slice(0, 70);
    const expiredClaim = readyForImport.slice(70, 75);
    const interrupted = readyForImport.slice(75, 80);
    const stale = readyForImport.slice(80, 90);
    valid.forEach((s) => (s.category = "valid"));
    expiredClaim.forEach((s) => (s.category = "expired-claim"));
    interrupted.forEach((s) => (s.category = "interrupted"));
    stale.forEach((s) => (s.category = "stale"));

    // expired-claim: give a foreign stale claimant
    for (const s of expiredClaim) {
      await admin.query("UPDATE partner_connector_records SET claimed_by = 'dead-worker-foreign' WHERE id = $1", [
        s.connectorId,
      ]);
    }
    // interrupted: insert a forced stale 'reserved' mapping row (simulating a crash mid-reservation)
    for (const s of interrupted) {
      await admin.query(
        `INSERT INTO partner_connector_imports
           (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id, partner_handoff_id,
            validation_run_id, source_fingerprint, source_fingerprint_version, state, reserved_at)
         SELECT $1, $2, $3, r.partner_submission_id, r.handoff_id, v.id, v.source_fingerprint, v.source_fingerprint_version, 'reserved', now() - interval '2 hours'
           FROM partner_connector_records r
           JOIN partner_connector_validation_runs v ON v.connector_record_id = r.id
          WHERE r.id = $1 ORDER BY v.created_at DESC LIMIT 1`,
        [s.connectorId, s.orgId, s.locationId]
      );
    }
    // stale: mutate the customer AFTER validation so the import-time fingerprint recheck fails
    for (const s of stale) {
      await admin.query("UPDATE partner_customers SET full_name = 'Mutated After Validation' WHERE id = $1", [
        s.customerId,
      ]);
    }

    // 5 cancelled + 5 rejected (terminal; admin-set for seeding)
    const cancelled: SeededConnector[] = [];
    const rejected: SeededConnector[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await seedValidatedReady(90 + i, 1, `cancel${i}@example.com`);
      s.category = "cancelled";
      await admin.query(
        "UPDATE partner_connector_records SET state = 'cancelled', completed_at = now() WHERE id = $1",
        [s.connectorId]
      );
      cancelled.push(s);
    }
    for (let i = 0; i < 5; i++) {
      const s = await seedValidatedReady(95 + i, 1, `reject${i}@example.com`);
      s.category = "rejected";
      await admin.query("UPDATE partner_connector_records SET state = 'rejected', completed_at = now() WHERE id = $1", [
        s.connectorId,
      ]);
      rejected.push(s);
    }

    seeded = [...readyForImport, ...cancelled, ...rejected];
    importableIds = [...valid, ...expiredClaim, ...interrupted].map((s) => s.connectorId);
    staleIds = stale.map((s) => s.connectorId);
    cancelledIds = cancelled.map((s) => s.connectorId);
    rejectedIds = rejected.map((s) => s.connectorId);

    // Make every ready_for_import record claimable by expiring its lease (models "validated earlier,
    // lease since lapsed, a worker now picks it up").
    await admin.query(
      "UPDATE partner_connector_records SET claim_expires_at = now() - interval '1 hour' WHERE state = 'ready_for_import'"
    );

    // ---- Run the bounded worker pool: 10 workers over the pool (max 12) ----
    const { runConnectorWorkerPool } = await import("../server/partner/connector-worker");
    const start = Date.now();
    workerResult = await runConnectorWorkerPool({ workerCount: 10, leaseSeconds: 120, maxRetriesPerRecord: 3 });
    elapsedMs = Date.now() - start;

    // Accurate per-import durations (single monotonic clock in the worker), not a DB-vs-JS subtraction.
    importDurations = [...workerResult.importDurationsMs].sort((a, b) => a - b);

    // eslint-disable-next-line no-console
    console.log(
      `[G3F scale] 100 connectors, 10 workers, pool=12 -> imported=${workerResult.imported} stale=${workerResult.stale} ` +
        `alreadyCompleted=${workerResult.alreadyCompleted} retries=${workerResult.retries} elapsed=${elapsedMs}ms ` +
        `importDur(min/med/p95/max ms)=${pct(importDurations, 0)}/${pct(importDurations, 50)}/${pct(importDurations, 95)}/${importDurations[importDurations.length - 1] ?? 0}`
    );
  }, 180_000);

  afterAll(async () => {
    const { closeConnectorPool } = await import("../server/partner/connector-db");
    const { closePartnerPools } = await import("../server/partner/db");
    await closeConnectorPool();
    await closePartnerPools();
    await admin?.end().catch(() => {});
  });

  it("seeded exactly 100 connectors in the documented distribution", () => {
    expect(seeded).toHaveLength(100);
    expect(importableIds).toHaveLength(80);
    expect(staleIds).toHaveLength(10);
    expect(cancelledIds).toHaveLength(5);
    expect(rejectedIds).toHaveLength(5);
  });

  it("the worker pool ran 10 workers and reported no failures", () => {
    expect(workerResult.workers).toBe(10);
    expect(workerResult.failures).toEqual([]);
  });

  it("exactly 80 destination submissions were created (one per importable connector)", async () => {
    const dest = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM submissions WHERE service_type = 'partner-intake'"
    );
    expect(dest.rows[0].n).toBe(80);
  });

  it("exactly 80 completed import mappings, zero duplicates", async () => {
    const m = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_imports WHERE state = 'completed'"
    );
    expect(m.rows[0].n).toBe(80);
    const dupMap = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT connector_record_id FROM partner_connector_imports GROUP BY connector_record_id HAVING count(*) > 1) d"
    );
    expect(dupMap.rows[0].n).toBe(0);
    const dupDest = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT destination_submission_id FROM partner_connector_imports WHERE destination_submission_id IS NOT NULL GROUP BY destination_submission_id HAVING count(*) > 1) d"
    );
    expect(dupDest.rows[0].n).toBe(0);
  });

  it("every destination reference is unique (80 distinct tracking numbers)", async () => {
    const r = await admin.query<{ total: number; distinct: number }>(
      "SELECT count(*)::int AS total, count(DISTINCT tracking_number)::int AS distinct FROM submissions WHERE service_type = 'partner-intake'"
    );
    expect(r.rows[0].total).toBe(80);
    expect(r.rows[0].distinct).toBe(80);
  });

  it("exactly 80 completed provenance attempt rows, zero duplicate completed evidence", async () => {
    const c = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_import_attempts WHERE outcome = 'completed'"
    );
    expect(c.rows[0].n).toBe(80);
    const dup = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT connector_record_id FROM partner_connector_import_attempts WHERE outcome = 'completed' GROUP BY connector_record_id HAVING count(*) > 1) d"
    );
    expect(dup.rows[0].n).toBe(0);
  });

  it("every importable connector reached 'imported'", async () => {
    const notImported = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_records WHERE id = ANY($1::uuid[]) AND state != 'imported'",
      [importableIds]
    );
    expect(notImported.rows[0].n).toBe(0);
  });

  it("stale connectors created no destination and were routed back to 'validating'", async () => {
    const dest = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = ANY($1::uuid[]) AND state = 'completed'",
      [staleIds]
    );
    expect(dest.rows[0].n).toBe(0);
    const validating = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_records WHERE id = ANY($1::uuid[]) AND state = 'validating'",
      [staleIds]
    );
    expect(validating.rows[0].n).toBe(10);
    const staleAttempts = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_import_attempts WHERE connector_record_id = ANY($1::uuid[]) AND outcome = 'stale'",
      [staleIds]
    );
    expect(staleAttempts.rows[0].n).toBeGreaterThanOrEqual(10);
  });

  it("cancelled and rejected connectors created no destination", async () => {
    const dest = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_imports WHERE connector_record_id = ANY($1::uuid[])",
      [[...cancelledIds, ...rejectedIds]]
    );
    expect(dest.rows[0].n).toBe(0);
  });

  it("no permanently stuck lease remains after the run (no abandoned expired claim)", async () => {
    const stuck = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM partner_connector_records
        WHERE state IN ('claimed','validating','ready_for_import') AND claim_expires_at IS NOT NULL AND claim_expires_at < now()`
    );
    expect(stuck.rows[0].n).toBe(0);
  });

  it("no unexpected manual_review rows", async () => {
    const mr = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM partner_connector_records WHERE state = 'manual_review'"
    );
    expect(mr.rows[0].n).toBe(0);
  });

  it("no orphan submission_items and item counts match card counts", async () => {
    const orphan = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM submission_items si LEFT JOIN submissions s ON s.id = si.submission_id WHERE s.id IS NULL"
    );
    expect(orphan.rows[0].n).toBe(0);
    const mismatch = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM submissions s
         WHERE s.service_type = 'partner-intake'
           AND s.card_count != (SELECT count(*) FROM submission_items si WHERE si.submission_id = s.id)`
    );
    expect(mismatch.rows[0].n).toBe(0);
  });

  it("provenance: every completed attempt links a validation run + fingerprint and the exact destination", async () => {
    const bad = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM partner_connector_import_attempts a
        WHERE a.outcome = 'completed'
          AND (a.validation_run_id IS NULL OR a.source_fingerprint IS NULL OR a.destination_submission_id IS NULL)`
    );
    expect(bad.rows[0].n).toBe(0);
    // the completed attempt's destination matches the mapping's destination for every importable connector
    const mismatch = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM partner_connector_import_attempts a
         JOIN partner_connector_imports m ON m.connector_record_id = a.connector_record_id AND m.state = 'completed'
        WHERE a.outcome = 'completed' AND a.destination_submission_id != m.destination_submission_id`
    );
    expect(mismatch.rows[0].n).toBe(0);
  });

  it("cross-tenant: the same customer email in different organisations resolves to different users (no cross-link)", async () => {
    // Each (org, partner_customer) pair has its own link; the same email across orgs must not collapse.
    const links = await admin.query<{ email_snapshot: string; users: number; orgs: number }>(
      `SELECT email_snapshot, count(DISTINCT mintvault_user_id)::int AS users, count(DISTINCT partner_organisation_id)::int AS orgs
         FROM partner_connector_customer_links
        WHERE email_snapshot = ANY($1)
        GROUP BY email_snapshot`,
      [SHARED_EMAILS]
    );
    for (const row of links.rows) {
      // if the same email appears across N orgs, it must map to N distinct users, never fewer.
      expect(row.users).toBe(row.orgs);
    }
    // and no two different orgs share one mintvault user
    const shared = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT mintvault_user_id FROM partner_connector_customer_links GROUP BY mintvault_user_id HAVING count(DISTINCT partner_organisation_id) > 1) d"
    );
    expect(shared.rows[0].n).toBe(0);
  });

  it("duplicate storm at scale: 5 imported connectors x 20 concurrent retries -> same destination, zero new submissions", async () => {
    const importer = await import("../server/partner/connector-import-service");
    const targets = importableIds.slice(0, 5);
    const before = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions");
    // fetch current version+claimant for each target
    const ctx = await Promise.all(
      targets.map(async (id) => {
        const { rows } = await admin.query<{ claimed_by: string; version: number; tenant_id: string }>(
          "SELECT claimed_by, version, tenant_id FROM partner_connector_records WHERE id = $1",
          [id]
        );
        return { id, ...rows[0] };
      })
    );
    const calls = ctx.flatMap((c) =>
      Array.from({ length: 20 }, () =>
        importer
          .importValidatedConnector({
            connectorId: c.id,
            claimant: c.claimed_by,
            expectedVersion: c.version,
            tenantId: c.tenant_id,
          })
          .then((o) => ({ id: c.id, dest: o.destinationSubmissionId, outcome: o.outcome }))
          .catch(() => ({ id: c.id, dest: null, outcome: "error" as const }))
      )
    );
    const results = await Promise.all(calls);
    for (const c of ctx) {
      const forThis = results.filter((r) => r.id === c.id && r.dest != null);
      expect(new Set(forThis.map((r) => r.dest)).size).toBe(1);
      expect(forThis.every((r) => r.outcome === "already_completed")).toBe(true);
    }
    const after = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM submissions");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  }, 60_000);

  it("lost-response at scale: discarding the response then retrying returns the same destination", async () => {
    const importer = await import("../server/partner/connector-import-service");
    const targets = importableIds.slice(5, 10);
    for (const id of targets) {
      const { rows } = await admin.query<{ claimed_by: string; version: number; tenant_id: string; dest: number }>(
        `SELECT r.claimed_by, r.version, r.tenant_id, m.destination_submission_id AS dest
           FROM partner_connector_records r JOIN partner_connector_imports m ON m.connector_record_id = r.id
          WHERE r.id = $1`,
        [id]
      );
      const c = rows[0];
      // "lost response": the first call already committed during the main run; simulate the caller
      // never having seen it by simply calling again and asserting convergence.
      const retry = await importer.importValidatedConnector({
        connectorId: id,
        claimant: c.claimed_by,
        expectedVersion: c.version,
        tenantId: c.tenant_id,
      });
      expect(retry.outcome).toBe("already_completed");
      expect(retry.destinationSubmissionId).toBe(c.dest);
    }
  }, 60_000);

  it("side effects: imports mint partner certificates, but never labels/payments/dead-cards", async () => {
    const certs = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM certificates WHERE origin_type = 'PARTNER'"
    );
    const workItems = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM partner_grading_work_items");
    expect(certs.rows[0].n).toBe(workItems.rows[0].n);
    expect(certs.rows[0].n).toBeGreaterThan(80);
    expect(
      (await admin.query<{ v: number }>("SELECT last_issued AS v FROM cert_counter WHERE id = 1")).rows[0].v
    ).toBeGreaterThan(42);
    expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM labels")).rows[0].n).toBe(1);
    expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM payments")).rows[0].n).toBe(1);
    expect((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM cards")).rows[0].n).toBe(0);
    // Every connector-created submission enters its normal in-grading/unpaid lifecycle with no Stripe intent.
    const bad = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM submissions WHERE service_type = 'partner-intake' AND (payment_intent_id IS NOT NULL OR status != 'in_grading' OR payment_status != 'unpaid')"
    );
    expect(bad.rows[0].n).toBe(0);
  });

  it("recorded timing evidence exists (per-import durations captured with a monotonic clock)", () => {
    // one duration per import call that returned an outcome: imported + stale + already_completed
    expect(importDurations.length).toBe(workerResult.imported + workerResult.stale + workerResult.alreadyCompleted);
    expect(importDurations.length).toBeGreaterThanOrEqual(80);
    expect(importDurations.every((d) => d >= 0)).toBe(true);
    expect(elapsedMs).toBeGreaterThan(0);
  });
});
