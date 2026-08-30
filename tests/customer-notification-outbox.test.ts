import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { CUSTOMER_NOTIFICATION_READINESS_SQL } from "../server/readiness";

const MIGRATION = readFileSync(new URL("../migrations/0120_customer_notification_outbox.sql", import.meta.url), "utf8");
const KEY_V1 = "11".repeat(32);
const KEY_V2 = "22".repeat(32);

let cluster: DisposablePostgres17;
let pool: pg.Pool;
let testDb: ReturnType<typeof drizzle>;
let enqueueCustomerNotification: typeof import("../server/customer-notification-outbox").enqueueCustomerNotification;
let processCustomerNotificationBatch: typeof import("../server/customer-notification-outbox").processCustomerNotificationBatch;

async function enqueue(eventKey: string, recipient = "owner@example.test", token = "secret-capability") {
  return testDb.transaction((tx) =>
    enqueueCustomerNotification(tx as never, {
      eventKey,
      kind: "ACCOUNT_MAGIC_LINK",
      aggregateType: "user",
      aggregateId: "user-1",
      recipient,
      payload: { token },
      expiresAt: new Date(Date.now() + 60_000),
    })
  );
}

describe("0120 encrypted customer notification outbox", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("customer-notification-outbox");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
    testDb = drizzle(pool);
    ({ enqueueCustomerNotification, processCustomerNotificationBatch } =
      await import("../server/customer-notification-outbox"));
    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_VERSION = "1";
    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_V1 = KEY_V1;
    await pool.query("CREATE ROLE mintvault_app NOLOGIN");
    await pool.query("CREATE SCHEMA hostile");
    const client = await pool.connect();
    try {
      await client.query("SET search_path=hostile,public");
      await client.query(MIGRATION);
      await client.query(MIGRATION);
    } finally {
      client.release();
    }
  }, 60_000);

  afterAll(async () => {
    delete process.env.CUSTOMER_NOTIFICATION_ENC_KEY_VERSION;
    delete process.env.CUSTOMER_NOTIFICATION_ENC_KEY_V1;
    delete process.env.CUSTOMER_NOTIFICATION_ENC_KEY_V2;
    delete process.env.MINTVAULT_DATABASE_URL;
    await pool?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_VERSION = "1";
    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_V1 = KEY_V1;
    delete process.env.CUSTOMER_NOTIFICATION_ENC_KEY_V2;
    await pool.query("TRUNCATE public.customer_notification_outbox RESTART IDENTITY");
  });

  it("is independently replayable, schema-qualified, exact-shape ready, and fails closed on an incompatible namesake", async () => {
    expect((await pool.query(CUSTOMER_NOTIFICATION_READINESS_SQL)).rows[0].ready).toBe(true);
    expect(
      (await pool.query("SELECT to_regclass('hostile.customer_notification_outbox') AS relation")).rows[0].relation
    ).toBeNull();
    expect(
      (
        await pool.query(
          `SELECT COUNT(*)::int AS count FROM pg_trigger WHERE tgrelid='public.customer_notification_outbox'::regclass AND NOT tgisinternal`
        )
      ).rows[0].count
    ).toBe(0);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP TABLE public.customer_notification_outbox");
      await client.query("CREATE TABLE public.customer_notification_outbox (id text)");
      await expect(client.query(MIGRATION)).rejects.toThrow(/0120: incompatible customer notification columns/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect((await pool.query(CUSTOMER_NOTIFICATION_READINESS_SQL)).rows[0].ready).toBe(true);
  });

  it("stores no plaintext recipient/capability and accepts only an identical event replay", async () => {
    const first = await enqueue("account-magic:user-1:event-1");
    expect(await enqueue("account-magic:user-1:event-1")).toBe(first);
    await expect(enqueue("account-magic:user-1:event-1", "attacker@example.test")).rejects.toThrow(
      /event key conflicts/
    );
    await expect(enqueue("account-magic:user-1:event-1", "owner@example.test", "different-secret")).rejects.toThrow(
      /event key conflicts/
    );
    const row = (
      await pool.query(
        `SELECT encrypted_payload,payload_fingerprint,event_key FROM public.customer_notification_outbox`
      )
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain("owner@example.test");
    expect(JSON.stringify(row)).not.toContain("secret-capability");
    expect(row.payload_fingerprint).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("rolls back the business mutation when enqueue fails", async () => {
    await pool.query("CREATE TABLE public.notification_atomic_state (id int primary key)");
    await expect(
      testDb.transaction(async (tx) => {
        await tx.execute((await import("drizzle-orm")).sql`INSERT INTO public.notification_atomic_state VALUES (1)`);
        await enqueueCustomerNotification(tx as never, {
          eventKey: "bad@email-key",
          kind: "PASSWORD_RESET",
          aggregateType: "user",
          aggregateId: "u",
          recipient: "u@example.test",
          payload: { token: "x" },
        });
      })
    ).rejects.toThrow(/event key is invalid/);
    expect(
      (await pool.query("SELECT COUNT(*)::int AS count FROM public.notification_atomic_state")).rows[0].count
    ).toBe(0);
  });

  it("delivers a concurrent claim once and preserves the provider idempotency key across an ambiguous marker failure", async () => {
    await enqueue("account-magic:user-1:concurrent");
    const concurrentSend = vi.fn(async (_kind: unknown, _envelope: unknown, options: { idempotencyKey: string }) => ({
      id: options.idempotencyKey,
    }));
    await Promise.all([
      processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send: concurrentSend }),
      processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send: concurrentSend }),
    ]);
    expect(concurrentSend).toHaveBeenCalledTimes(1);

    await enqueue("account-magic:user-1:ambiguous");
    await pool.query(`
      CREATE FUNCTION public.reject_one_sent_marker() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_key='account-magic:user-1:ambiguous' AND NEW.status='SENT' THEN
          RAISE EXCEPTION 'simulated crash after provider receipt';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_one_sent_marker BEFORE UPDATE ON public.customer_notification_outbox
      FOR EACH ROW EXECUTE FUNCTION public.reject_one_sent_marker()
    `);
    const keys: string[] = [];
    const uncertainSend = vi.fn(async (_kind: unknown, _envelope: unknown, options: { idempotencyKey: string }) => {
      keys.push(options.idempotencyKey);
      return { id: "provider-receipt" };
    });
    const first = await processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send: uncertainSend });
    expect(first.failed).toBe(1);
    await pool.query("DROP TRIGGER reject_one_sent_marker ON public.customer_notification_outbox");
    await pool.query("DROP FUNCTION public.reject_one_sent_marker()");
    await pool.query(
      `UPDATE public.customer_notification_outbox SET next_attempt_at=NOW() WHERE event_key='account-magic:user-1:ambiguous'`
    );
    await processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send: uncertainSend });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("schedules provider retries before a short-lived capability expires", async () => {
    await enqueue("account-magic:user-1:short-lived");
    const send = vi
      .fn<() => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new Error("transient provider outage"))
      .mockResolvedValueOnce({ id: "provider-recovered" });

    const first = await processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send });
    expect(first.failed).toBe(1);
    const failed = (
      await pool.query(
        `SELECT status,attempt_count,next_attempt_at,expires_at
           FROM public.customer_notification_outbox
          WHERE event_key='account-magic:user-1:short-lived'`
      )
    ).rows[0];
    expect(failed).toMatchObject({ status: "FAILED", attempt_count: 1 });
    expect(new Date(failed.next_attempt_at).getTime()).toBeLessThan(new Date(failed.expires_at).getTime());

    await pool.query(
      `UPDATE public.customer_notification_outbox
          SET next_attempt_at=NOW()
        WHERE event_key='account-magic:user-1:short-lived'`
    );
    const second = await processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send });
    expect(second.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("decrypts historical v1 rows after v2 rotation and fails closed when the historical key is unavailable", async () => {
    await enqueue("account-magic:user-1:rotate-ok");
    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_VERSION = "2";
    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_V2 = KEY_V2;
    const send = vi.fn(async () => ({ id: "rotated-receipt" }));
    await processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send });
    expect(send).toHaveBeenCalledTimes(1);

    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_VERSION = "1";
    await enqueue("account-magic:user-1:rotate-missing");
    process.env.CUSTOMER_NOTIFICATION_ENC_KEY_VERSION = "2";
    delete process.env.CUSTOMER_NOTIFICATION_ENC_KEY_V1;
    const result = await processCustomerNotificationBatch({ limit: 1, exec: testDb as never, send });
    expect(result.reconciliationRequired).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT status FROM public.customer_notification_outbox WHERE event_key='account-magic:user-1:rotate-missing'`
        )
      ).rows[0].status
    ).toBe("RECONCILIATION_REQUIRED");
  });
});
