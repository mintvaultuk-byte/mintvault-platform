/**
 * Partner supplies ordering is proven against a real PostgreSQL 17 cluster.  These tests exercise
 * the runtime role, real RLS, immutable rows, tenant-local idempotency and the durable outbox — a
 * mocked repository could not prove any of those database boundaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_SUPPLIES,
  pinAccountingTopologyTo,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const email = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../server/email", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, sendPartnerSuppliesOrderNotification: email.send };
});

const A = "aaaaaaaa-1020-0000-0000-000000000001";
const B = "bbbbbbbb-1020-0000-0000-000000000002";
const C = "cccccccc-1020-0000-0000-000000000003";
const LA = "aaaaaaaa-1020-0000-0000-0000000000a1";
const LB = "bbbbbbbb-1020-0000-0000-0000000000b1";
const LC = "cccccccc-1020-0000-0000-0000000000c1";
const UA = "aaaaaaaa-1020-0000-0000-0000000000a2";
const UA_VIEWER = "aaaaaaaa-1020-0000-0000-0000000000a3";
const UB = "bbbbbbbb-1020-0000-0000-0000000000b2";
const UC = "cccccccc-1020-0000-0000-0000000000c2";
const ADMIN_ACTOR = "cccccccc-1020-0000-0000-000000000001";

let cluster: DisposablePostgres17;
let admin: Client;
let supplies: typeof import("../server/partner/supplies-service");
let db: typeof import("../server/partner/db");
let savedEnv: Record<string, string | undefined> = {};

function asRole(base: string, username: string, password: string): string {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  return url.toString();
}

function principal(tenantId: string, userId: string, locationId: string) {
  return {
    sessionId: "dddddddd-1020-0000-0000-000000000001",
    tenantId,
    userId,
    locationId,
    mfaPassed: true,
    permissions: new Set(["partner.supplies.view", "partner.supplies.submit"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: true,
  };
}

const allItems = [
  { productCode: "PLASTIC_GRADED_SLABS" as const, quantity: 2 },
  { productCode: "PRINT_PAPER_LABEL_STOCK" as const, quantity: 3 },
  { productCode: "NFC_TAGS" as const, quantity: 4 },
];

async function seedCoreTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query("CREATE TABLE audit_log (id serial primary key, entity_type text not null, entity_id text not null, action text not null, admin_user text, details jsonb, created_at timestamptz not null default now())");
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function seedTenantData(): Promise<void> {
  await admin.query(
    `INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES
       ($1,'sup-a','Supplies A Ltd','ACTIVE'), ($2,'sup-b','Supplies B Ltd','ACTIVE')`,
    [A, B]
  );
  await admin.query(
    `INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,'A Cards'), ($2,'B Cards')`,
    [A, B]
  );
  await admin.query(
    `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, address, status) VALUES
       ($1,'sup-la',$3,$3,'A Shop','1 A Street\nLondon\nSW1A 1AA','ACTIVE'),
       ($2,'sup-lb',$4,$4,'B Shop','2 B Street\nLondon\nEC1A 1BB','ACTIVE')`,
    [LA, LB, A, B]
  );
  await admin.query(
    `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES
       ($1,'sup-ua',$4,$4,'owner-a@example.test','ACTIVE'),
       ($2,'sup-uav',$4,$4,'viewer-a@example.test','ACTIVE'),
       ($3,'sup-ub',$5,$5,'owner-b@example.test','ACTIVE')`,
    [UA, UA_VIEWER, UB, A, B]
  );
  await admin.query(
    `INSERT INTO partner_contacts (tenant_id, full_name, email, phone, contact_type, is_primary, active) VALUES
       ($1,'Alice Operations','alice@example.test','+441234567890','operations',true,true),
       ($2,'Bob Operations','bob@example.test','+441234567891','operations',true,true)`,
    [A, B]
  );
}

describe("Partner supplies ordering (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-supplies-ordering");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedCoreTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_SUPPLIES);
    await admin.query("CREATE ROLE partner_supplies_runtime LOGIN PASSWORD 'synthetic' NOSUPERUSER NOBYPASSRLS");
    await admin.query("GRANT partner_runtime TO partner_supplies_runtime");

    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
    };
    process.env.PARTNER_DATABASE_URL = asRole(cluster.url, "partner_supplies_runtime", "synthetic");
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    pinAccountingTopologyTo(cluster.url);
    db = await import("../server/partner/db");
    supplies = await import("../server/partner/supplies-service");
    supplies.__resetSuppliesSchemaForTests();
    await seedTenantData();
  }, 180_000);

  beforeEach(() => {
    email.send.mockReset();
    email.send.mockResolvedValue({ id: "resend-supplies-test-message" });
  });

  afterAll(async () => {
    await db?.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("creates one durable order first, snapshots all three products/address/contact, audits it, and sends exactly once", async () => {
    const created = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: allItems,
      notes: "Leave with the stock room.",
      idempotencyKey: "supplies-order-primary-key-0001",
    });
    expect(created.replayed).toBe(false);
    expect(created.order.status).toBe("RECEIVED");
    expect(created.order.partnerName).toBe("A Cards");
    expect(created.order.shopName).toBe("A Shop");
    expect(created.order.delivery).toMatchObject({ postcode: "SW1A 1AA", country: "GB" });
    expect(created.order.items.map((item) => [item.productCode, item.quantity])).toEqual([
      ["NFC_TAGS", 4],
      ["PLASTIC_GRADED_SLABS", 2],
      ["PRINT_PAPER_LABEL_STOCK", 3],
    ]);

    const delivered = await supplies.attemptNewSuppliesOrderNotification(created.order.id);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(delivered).toBe("SENT");
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
      orderReference: created.order.reference,
      partnerName: "A Cards",
      shopName: "A Shop",
      contactEmail: "alice@example.test",
      deliveryPostcode: "SW1A 1AA",
      submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      items: expect.arrayContaining([
        expect.objectContaining({ label: "Plastic graded slabs", quantity: 2 }),
        expect.objectContaining({ label: "Print paper / label stock", quantity: 3 }),
        expect.objectContaining({ label: "NFC tags", quantity: 4 }),
      ]),
    }));

    const rows = await admin.query<{ event_type: string; notification_status: string; audit_count: number }>(
      `SELECT (SELECT string_agg(event_type, ',' ORDER BY id) FROM partner_supplies_order_events WHERE order_id=$1) AS event_type,
              (SELECT status FROM partner_supplies_order_notifications WHERE order_id=$1) AS notification_status,
              (SELECT count(*)::int FROM partner_audit_events WHERE record_type='partner_supplies_order' AND record_id=$1::text) AS audit_count`,
      [created.order.id]
    );
    expect(rows.rows[0]).toMatchObject({ notification_status: "SENT", audit_count: 1 });
    expect(rows.rows[0].event_type).toContain("ORDER_RECEIVED");
    expect(rows.rows[0].event_type).toContain("NOTIFICATION_ATTEMPTED");
    expect(rows.rows[0].event_type).toContain("NOTIFICATION_SENT");
  });

  it("deduplicates replays and concurrent submits by tenant-local immutable intent", async () => {
    const key = "supplies-order-idempotency-key-0002";
    const first = await supplies.createSuppliesOrder(principal(A, UA, LA), { items: [allItems[0]], idempotencyKey: key });
    const replay = await supplies.createSuppliesOrder(principal(A, UA, LA), { items: [allItems[0]], idempotencyKey: key });
    expect(replay).toMatchObject({ replayed: true, order: { id: first.order.id } });
    await expect(
      supplies.createSuppliesOrder(principal(A, UA, LA), { items: [{ ...allItems[0], quantity: 9 }], idempotencyKey: key })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });

    const concurrentKey = "supplies-order-concurrent-key-0003";
    const both = await Promise.all([
      supplies.createSuppliesOrder(principal(A, UA, LA), { items: [allItems[1]], idempotencyKey: concurrentKey }),
      supplies.createSuppliesOrder(principal(A, UA, LA), { items: [allItems[1]], idempotencyKey: concurrentKey }),
    ]);
    expect(new Set(both.map((result) => result.order.id))).toHaveLength(1);
    const count = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM partner_supplies_orders WHERE tenant_id=$1 AND idempotency_key=$2",
      [A, concurrentKey]
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("keeps orders durable when Resend fails, then lets a stepped-up Super Admin requeue an exhausted canonical notification", async () => {
    const created = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[2]],
      idempotencyKey: "supplies-order-resend-retry-key-0004",
    });
    email.send.mockRejectedValueOnce(new Error("email provider unavailable"));
    expect(await supplies.attemptNewSuppliesOrderNotification(created.order.id)).toBe("FAILED");
    const failed = await admin.query<{ count: number; provider_key: string }>(
      `SELECT (SELECT count(*)::int FROM partner_supplies_orders WHERE id=$1) AS count,
              (SELECT provider_idempotency_key FROM partner_supplies_order_notifications WHERE order_id=$1) AS provider_key`,
      [created.order.id]
    );
    expect(failed.rows[0].count).toBe(1);
    const providerKey = failed.rows[0].provider_key;
    // Model an exhausted automatic budget. The explicit operational recovery remains bounded,
    // audited and preserves this exact provider idempotency key rather than making another order.
    await admin.query(
      "UPDATE partner_supplies_order_notifications SET attempt_count=12, next_attempt_at=NULL WHERE order_id=$1",
      [created.order.id]
    );
    const requeued = await supplies.retrySuppliesOrderNotificationAsAdmin({
      orderId: created.order.id,
      actorUserId: ADMIN_ACTOR,
      actorEmail: "ops@example.test",
      requestId: "eeeeeeee-1020-0000-0000-000000000004",
    });
    expect(requeued.notificationStatus).toBe("PENDING");
    email.send.mockResolvedValueOnce({ id: "resend-supplies-retried" });
    expect((await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: created.order.id })).sent).toBe(1);
    const retried = await admin.query<{ status: string; provider_key: string; count: number }>(
      `SELECT (SELECT status FROM partner_supplies_order_notifications WHERE order_id=$1) AS status,
              (SELECT provider_idempotency_key FROM partner_supplies_order_notifications WHERE order_id=$1) AS provider_key,
              (SELECT count(*)::int FROM partner_supplies_orders WHERE id=$1) AS count`,
      [created.order.id]
    );
    expect(retried.rows[0]).toMatchObject({ status: "SENT", provider_key: providerKey, count: 1 });
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(email.send.mock.calls.map(([payload]) => payload.idempotencyKey)).toEqual([providerKey, providerKey]);
    const events = await admin.query<{ event_type: string; detail: { priorAttemptCount?: number } }>(
      "SELECT event_type, detail FROM partner_supplies_order_events WHERE order_id=$1 ORDER BY id",
      [created.order.id]
    );
    expect(events.rows).toContainEqual(expect.objectContaining({ event_type: "NOTIFICATION_REQUEUED", detail: expect.objectContaining({ priorAttemptCount: 12 }) }));
  });

  it("recovers an expired worker claim after a restart and never lets concurrent workers send the same notification", async () => {
    const created = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[1]],
      idempotencyKey: "supplies-order-expired-claim-key-0009",
    });
    const providerKey = (
      await admin.query<{ provider_idempotency_key: string }>(
        "SELECT provider_idempotency_key FROM partner_supplies_order_notifications WHERE order_id=$1",
        [created.order.id]
      )
    ).rows[0].provider_idempotency_key;
    // Simulate a process restart after it claimed the work but before it called Resend.
    await admin.query(
      `UPDATE partner_supplies_order_notifications
          SET status='CLAIMED', attempt_count=1, claim_token=gen_random_uuid(),
              claim_expires_at=now() - interval '1 second', next_attempt_at=now() - interval '1 second'
        WHERE order_id=$1`,
      [created.order.id]
    );

    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    email.send.mockImplementationOnce(async () => {
      sendStarted();
      await sendGate;
      return { id: "resend-after-restart" };
    });
    const firstWorker = supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: created.order.id });
    await started;
    const competingWorker = await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: created.order.id });
    expect(competingWorker).toMatchObject({ processed: 0, sent: 0, failed: 0, state: "READY" });
    releaseSend();
    expect(await firstWorker).toMatchObject({ processed: 1, sent: 1, failed: 0, state: "READY" });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: providerKey }));
  });

  it("reuses the persisted provider key after provider acceptance but a lost sent acknowledgement", async () => {
    const created = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[0]],
      idempotencyKey: "supplies-order-ack-loss-key-0010",
    });
    const providerKey = (
      await admin.query<{ provider_idempotency_key: string }>(
        "SELECT provider_idempotency_key FROM partner_supplies_order_notifications WHERE order_id=$1",
        [created.order.id]
      )
    ).rows[0].provider_idempotency_key;
    // Fail only the database acknowledgement after Resend accepts the first call. This models a
    // process/database fault at the exact provider-accepted boundary without pretending a mock
    // sender proves idempotency on its own.
    await admin.query(`CREATE OR REPLACE FUNCTION test_supplies_reject_sent_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='SENT' THEN RAISE EXCEPTION 'test lost sent acknowledgement'; END IF;
        RETURN NEW;
      END;
    $$`);
    await admin.query(
      "CREATE TRIGGER test_supplies_reject_sent_ack BEFORE UPDATE ON partner_supplies_order_notifications FOR EACH ROW EXECUTE FUNCTION test_supplies_reject_sent_ack()"
    );
    try {
      email.send.mockResolvedValueOnce({ id: "resend-accepted-before-ack-loss" });
      expect(await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: created.order.id })).toMatchObject({ sent: 0, failed: 1 });
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_supplies_reject_sent_ack ON partner_supplies_order_notifications");
      await admin.query("DROP FUNCTION IF EXISTS test_supplies_reject_sent_ack()");
    }
    // Time-travel the bounded automatic retry due time; production uses the same worker path.
    await admin.query("UPDATE partner_supplies_order_notifications SET next_attempt_at=now() WHERE order_id=$1", [created.order.id]);
    email.send.mockResolvedValueOnce({ id: "resend-idempotent-recovery" });
    expect(await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: created.order.id })).toMatchObject({ sent: 1, failed: 0 });
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(email.send.mock.calls.map(([payload]) => payload.idempotencyKey)).toEqual([providerKey, providerKey]);
    const outcome = await admin.query<{ status: string; orders: number }>(
      `SELECT (SELECT status FROM partner_supplies_order_notifications WHERE order_id=$1) AS status,
              (SELECT count(*)::int FROM partner_supplies_orders WHERE id=$1) AS orders`,
      [created.order.id]
    );
    expect(outcome.rows[0]).toMatchObject({ status: "SENT", orders: 1 });
  });

  it("fails closed after the provider idempotency window when delivery is uncertain", async () => {
    const created = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[0]],
      idempotencyKey: "supplies-order-stale-uncertain-key-0011",
    });
    // Represents a provider-accepted send whose local acknowledgement was unavailable more than
    // Resend's 24h idempotency retention ago. Do not infer "not delivered" from a stale key.
    await admin.query(
      `UPDATE partner_supplies_order_notifications
          SET status='FAILED', attempt_count=1, last_attempt_at=now() - interval '24 hours',
              uncertain_delivery_at=now() - interval '24 hours', next_attempt_at=now(),
              failure_code='PROVIDER_UNCERTAIN', claim_token=NULL, claim_expires_at=NULL
        WHERE order_id=$1`,
      [created.order.id]
    );
    expect(await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: created.order.id })).toMatchObject({ processed: 0, sent: 0, failed: 0 });
    await expect(
      supplies.retrySuppliesOrderNotificationAsAdmin({
        orderId: created.order.id,
        actorUserId: ADMIN_ACTOR,
        actorEmail: "ops@example.test",
        requestId: "eeeeeeee-1020-0000-0000-000000000005",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_RECONCILIATION_REQUIRED", status: 409 });
    expect(email.send).not.toHaveBeenCalled();
    const visible = (await supplies.listSuppliesOrdersForAdmin()).find((order) => order.id === created.order.id)!;
    expect(visible).toMatchObject({ notificationStatus: "FAILED", notificationRecovery: "RECONCILIATION_REQUIRED" });
  });

  it("normalizes stale uncertain pending and claimed rows into visible reconciliation failures", async () => {
    const pending = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[0]],
      idempotencyKey: "supplies-order-stale-pending-key-0011a",
    });
    const claimed = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[1]],
      idempotencyKey: "supplies-order-stale-claimed-key-0011b",
    });
    await admin.query(
      `UPDATE partner_supplies_order_notifications
          SET status='PENDING', attempt_count=1, last_attempt_at=now() - interval '24 hours',
              uncertain_delivery_at=now() - interval '24 hours', next_attempt_at=now(),
              failure_code=NULL, claim_token=NULL, claim_expires_at=NULL
        WHERE order_id=$1`,
      [pending.order.id]
    );
    await admin.query(
      `UPDATE partner_supplies_order_notifications
          SET status='CLAIMED', attempt_count=1, last_attempt_at=now() - interval '24 hours',
              uncertain_delivery_at=now() - interval '24 hours', next_attempt_at=now(),
              failure_code=NULL, claim_token=gen_random_uuid(), claim_expires_at=now() - interval '24 hours'
        WHERE order_id=$1`,
      [claimed.order.id]
    );
    expect(await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: pending.order.id })).toMatchObject({ processed: 0, sent: 0, failed: 0 });
    expect(email.send).not.toHaveBeenCalled();
    const outcomes = await admin.query<{ order_id: string; status: string; failure_code: string; events: number }>(
      `SELECT n.order_id, n.status, n.failure_code,
              (SELECT count(*)::int FROM partner_supplies_order_events e WHERE e.order_id=n.order_id AND e.event_type='NOTIFICATION_RECONCILIATION_REQUIRED') AS events
         FROM partner_supplies_order_notifications n
        WHERE n.order_id = ANY($1::uuid[])`,
      [[pending.order.id, claimed.order.id]]
    );
    expect(outcomes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ order_id: pending.order.id, status: "FAILED", failure_code: "PROVIDER_UNCERTAIN", events: 1 }),
      expect.objectContaining({ order_id: claimed.order.id, status: "FAILED", failure_code: "PROVIDER_UNCERTAIN", events: 1 }),
    ]));
    for (const orderId of [pending.order.id, claimed.order.id]) {
      await expect(
        supplies.retrySuppliesOrderNotificationAsAdmin({
          orderId,
          actorUserId: ADMIN_ACTOR,
          actorEmail: "ops@example.test",
          requestId: "eeeeeeee-1020-0000-0000-000000000005",
        })
      ).rejects.toMatchObject({ code: "NOTIFICATION_RECONCILIATION_REQUIRED", status: 409 });
    }
  });

  it("treats a concurrent Resend idempotency response as delivery-uncertain, never proven rejected", async () => {
    const created = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[2]],
      idempotencyKey: "supplies-order-concurrent-provider-key-0011c",
    });
    email.send.mockRejectedValueOnce(new Error("Resend API error: 409 concurrent_idempotent_requests"));
    expect(await supplies.attemptNewSuppliesOrderNotification(created.order.id)).toBe("FAILED");
    const failure = await admin.query<{ failure_code: string; uncertain_delivery_at: string | null }>(
      "SELECT failure_code, uncertain_delivery_at FROM partner_supplies_order_notifications WHERE order_id=$1",
      [created.order.id]
    );
    expect(failure.rows[0]).toMatchObject({ failure_code: "PROVIDER_UNCERTAIN", uncertain_delivery_at: expect.anything() });
    await admin.query(
      "UPDATE partner_supplies_order_notifications SET uncertain_delivery_at=now() - interval '24 hours', next_attempt_at=now() WHERE order_id=$1",
      [created.order.id]
    );
    expect(await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: created.order.id })).toMatchObject({ processed: 0, sent: 0, failed: 0 });
    await expect(
      supplies.retrySuppliesOrderNotificationAsAdmin({
        orderId: created.order.id,
        actorUserId: ADMIN_ACTOR,
        actorEmail: "ops@example.test",
        requestId: "eeeeeeee-1020-0000-0000-000000000005",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_RECONCILIATION_REQUIRED", status: 409 });
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("never requeues a failed notification for cancelled or dispatched stock requests", async () => {
    const cancelled = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[0]],
      idempotencyKey: "supplies-order-cancelled-retry-key-0012",
    });
    email.send.mockRejectedValueOnce(new Error("email provider unavailable"));
    await supplies.attemptNewSuppliesOrderNotification(cancelled.order.id);
    await supplies.transitionSuppliesOrderAsAdmin({
      orderId: cancelled.order.id,
      status: "CANCELLED",
      actorUserId: ADMIN_ACTOR,
      actorEmail: "ops@example.test",
      requestId: "eeeeeeee-1020-0000-0000-000000000006",
    });
    const dispatched = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[1]],
      idempotencyKey: "supplies-order-dispatched-retry-key-0013",
    });
    email.send.mockRejectedValueOnce(new Error("email provider unavailable"));
    await supplies.attemptNewSuppliesOrderNotification(dispatched.order.id);
    await supplies.transitionSuppliesOrderAsAdmin({
      orderId: dispatched.order.id,
      status: "PROCESSING",
      actorUserId: ADMIN_ACTOR,
      actorEmail: "ops@example.test",
      requestId: "eeeeeeee-1020-0000-0000-000000000007",
    });
    await supplies.transitionSuppliesOrderAsAdmin({
      orderId: dispatched.order.id,
      status: "DISPATCHED",
      actorUserId: ADMIN_ACTOR,
      actorEmail: "ops@example.test",
      requestId: "eeeeeeee-1020-0000-0000-000000000008",
    });
    for (const orderId of [cancelled.order.id, dispatched.order.id]) {
      await expect(
        supplies.retrySuppliesOrderNotificationAsAdmin({
          orderId,
          actorUserId: ADMIN_ACTOR,
          actorEmail: "ops@example.test",
          requestId: "eeeeeeee-1020-0000-0000-000000000009",
        })
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 409 });
    }
    // Lifecycle safety is enforced in the worker query as well as the manual requeue path: a
    // delayed automatic retry must never revive a cancelled/dispatched fulfilment request.
    await admin.query("UPDATE partner_supplies_order_notifications SET next_attempt_at=now() WHERE order_id = ANY($1::uuid[])", [
      [cancelled.order.id, dispatched.order.id],
    ]);
    expect(await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: cancelled.order.id })).toMatchObject({ processed: 0, sent: 0 });
    expect(await supplies.processPartnerSuppliesNotificationBatch({ onlyOrderId: dispatched.order.id })).toMatchObject({ processed: 0, sent: 0 });
    expect(email.send).toHaveBeenCalledTimes(2);
    const outcomes = await admin.query<{ order_id: string; status: string; events: number }>(
      `SELECT n.order_id, n.status,
              (SELECT count(*)::int FROM partner_supplies_order_events e WHERE e.order_id=n.order_id AND e.event_type='NOTIFICATION_REQUEUED') AS events
         FROM partner_supplies_order_notifications n
        WHERE n.order_id = ANY($1::uuid[])`,
      [[cancelled.order.id, dispatched.order.id]]
    );
    expect(outcomes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ order_id: cancelled.order.id, status: "FAILED", events: 0 }),
      expect.objectContaining({ order_id: dispatched.order.id, status: "FAILED", events: 0 }),
    ]));
  });

  it("fails closed on missing delivery data, invalid quantities, credential-like notes and cross-tenant order reads", async () => {
    await admin.query("UPDATE partner_locations SET address=NULL WHERE id=$1", [LB]);
    await expect(supplies.getSuppliesDeliveryPreview(principal(B, UB, LB))).rejects.toMatchObject({
      code: "DELIVERY_ADDRESS_REQUIRED",
      status: 409,
    });
    await expect(
      supplies.createSuppliesOrder(principal(A, UA, LA), { items: [{ ...allItems[0], quantity: 0 }], idempotencyKey: "supplies-invalid-quantity-key-0005" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      supplies.createSuppliesOrder(principal(A, UA, LA), { items: [allItems[0]], notes: "password is never a delivery note", idempotencyKey: "supplies-secret-note-key-0006" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await admin.query("UPDATE partner_locations SET address='2 B Street, London, EC1A 1BB' WHERE id=$1", [LB]);
    const b = await supplies.createSuppliesOrder(principal(B, UB, LB), { items: [allItems[0]], idempotencyKey: "supplies-b-tenant-key-0007" });
    const aOrders = await supplies.listOwnSuppliesOrders(principal(A, UA, LA));
    const bOrders = await supplies.listOwnSuppliesOrders(principal(B, UB, LB));
    const aViewerOrders = await supplies.listOwnSuppliesOrders(principal(A, UA_VIEWER, LA));
    expect(aOrders.some((order) => order.id === b.order.id)).toBe(false);
    expect(bOrders.map((order) => order.id)).toContain(b.order.id);
    expect(aViewerOrders).toEqual([]);
  });

  it("requires this tenant's active primary operations contact before Supplies is admitted", async () => {
    await admin.query("INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'sup-c','Supplies C Ltd','ACTIVE')", [C]);
    await admin.query("INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,'C Cards')", [C]);
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, address, status) VALUES ($1,'sup-lc',$2,$2,'C Shop','3 C Street, London, W1A 1AA','ACTIVE')",
      [LC, C]
    );
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES ($1,'sup-uc',$2,$2,'owner-c@example.test','ACTIVE')",
      [UC, C]
    );

    // Tenant B already has a valid contact. It must not authorise tenant C.
    await expect(supplies.getSuppliesDeliveryPreview(principal(C, UC, LC))).rejects.toMatchObject({
      code: "DELIVERY_CONTACT_REQUIRED",
      status: 409,
    });

    await admin.query(
      `INSERT INTO partner_contacts (tenant_id, full_name, email, contact_type, is_primary, active)
       VALUES ($1,'C General','general@example.test','general',true,true)`,
      [C]
    );
    await expect(supplies.getSuppliesDeliveryPreview(principal(C, UC, LC))).rejects.toMatchObject({
      code: "DELIVERY_CONTACT_REQUIRED",
      status: 409,
    });

    await admin.query("UPDATE partner_contacts SET is_primary=false WHERE tenant_id=$1", [C]);
    await admin.query(
      "INSERT INTO partner_contacts (tenant_id, full_name, email, contact_type, is_primary, active) VALUES ($1,'C Operations','not-an-email','operations',true,true)",
      [C]
    );
    await expect(supplies.getSuppliesDeliveryPreview(principal(C, UC, LC))).rejects.toMatchObject({
      code: "DELIVERY_CONTACT_REQUIRED",
      status: 409,
    });

    await admin.query("UPDATE partner_contacts SET email='c.operations@example.test', active=false WHERE tenant_id=$1 AND contact_type='operations'", [C]);
    await expect(supplies.getSuppliesDeliveryPreview(principal(C, UC, LC))).rejects.toMatchObject({
      code: "DELIVERY_CONTACT_REQUIRED",
      status: 409,
    });

    await admin.query("UPDATE partner_contacts SET active=true WHERE tenant_id=$1 AND contact_type='operations'", [C]);
    await expect(supplies.getSuppliesDeliveryPreview(principal(C, UC, LC))).resolves.toMatchObject({
      contact: { name: "C Operations", email: "c.operations@example.test" },
      delivery: { postcode: "W1A 1AA", country: "GB" },
    });

    // Contacts are tenant-scoped by schema; selecting another tenant's location is the only
    // location-binding failure mode and it must be rejected before contact admission.
    await expect(supplies.getSuppliesDeliveryPreview(principal(C, UC, LA))).rejects.toMatchObject({
      code: "LOCATION_SELECTION_REQUIRED",
      status: 409,
    });
  });

  it("locks address snapshots, rejects partner-side status writes, and permits only the Super Admin lifecycle", async () => {
    const created = await supplies.createSuppliesOrder(principal(A, UA, LA), {
      items: [allItems[0]],
      idempotencyKey: "supplies-order-lifecycle-key-0008",
    });
    await admin.query("UPDATE partner_locations SET address='99 Changed Road, London, N1 9ZZ' WHERE id=$1", [LA]);
    await admin.query("UPDATE partner_contacts SET email='changed@example.test' WHERE tenant_id=$1", [A]);
    const snapshotted = (await supplies.listOwnSuppliesOrders(principal(A, UA, LA)).then((orders) => orders.find((order) => order.id === created.order.id)))!;
    expect(snapshotted.delivery).toMatchObject({ postcode: "SW1A 1AA" });
    expect(snapshotted.contact.email).toBe("alice@example.test");

    await expect(
      db.withTenant({ tenantId: A, locationId: LA }, (client) =>
        client.query("UPDATE partner_supplies_orders SET status='DISPATCHED' WHERE id=$1", [created.order.id])
      )
    ).rejects.toThrow(/permission denied/i);
    const processing = await supplies.transitionSuppliesOrderAsAdmin({
      orderId: created.order.id,
      status: "PROCESSING",
      actorUserId: ADMIN_ACTOR,
      actorEmail: "ops@example.test",
      requestId: "eeeeeeee-1020-0000-0000-000000000001",
    });
    expect(processing.status).toBe("PROCESSING");
    const dispatched = await supplies.transitionSuppliesOrderAsAdmin({
      orderId: created.order.id,
      status: "DISPATCHED",
      actorUserId: ADMIN_ACTOR,
      actorEmail: "ops@example.test",
      requestId: "eeeeeeee-1020-0000-0000-000000000002",
    });
    expect(dispatched.status).toBe("DISPATCHED");
    await expect(
      supplies.transitionSuppliesOrderAsAdmin({
        orderId: created.order.id,
        status: "PROCESSING",
        actorUserId: ADMIN_ACTOR,
        actorEmail: "ops@example.test",
        requestId: "eeeeeeee-1020-0000-0000-000000000003",
      })
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION", status: 409 });
  });

  it("pins RLS, composite tenant foreign keys, append-only evidence and exact RBAC grants", async () => {
    const rls = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('partner_supplies_orders','partner_supplies_order_items','partner_supplies_order_events','partner_supplies_order_notifications')`
    );
    expect(rls.rows).toHaveLength(4);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const grants = await admin.query<{ role: string; permission: string }>(
      `SELECT r.code AS role, p.code AS permission
         FROM partner_role_permissions rp JOIN partner_roles r ON r.id=rp.role_id JOIN partner_permissions p ON p.id=rp.permission_id
        WHERE p.code LIKE 'partner.supplies.%' ORDER BY role, permission`
    );
    expect(grants.rows).toEqual([
      { role: "PARTNER_MANAGER", permission: "partner.supplies.submit" },
      { role: "PARTNER_MANAGER", permission: "partner.supplies.view" },
      { role: "PARTNER_OWNER", permission: "partner.supplies.submit" },
      { role: "PARTNER_OWNER", permission: "partner.supplies.view" },
      { role: "PARTNER_RECEPTION", permission: "partner.supplies.view" },
    ]);
    const constraints = await admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname IN
         ('fk_partner_supplies_orders_location_tenant','fk_partner_supplies_orders_requester_tenant',
          'fk_partner_supplies_order_items_order_tenant','fk_partner_supplies_order_events_order_tenant',
          'fk_partner_supplies_order_notifications_order_tenant') ORDER BY conname`
    );
    expect(constraints.rows).toHaveLength(5);
  });
});
