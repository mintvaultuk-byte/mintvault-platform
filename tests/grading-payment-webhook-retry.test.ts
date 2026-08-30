/**
 * Grading-payment webhook retry and concurrency proof.
 *
 * This drives the shipped WebhookHandlers.processWebhook entrypoint with a real
 * Stripe test signature and the production storage implementation against a
 * disposable PostgreSQL 17.10 cluster. It protects the money invariant that a
 * transient paid-transition failure must not burn the Stripe event before the
 * submission is marked paid, while replayed/concurrent deliveries still produce
 * exactly one paid transition.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import pg from "pg";
import { readFileSync } from "node:fs";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { PAYMENT_FULFILMENT_READINESS_SQL } from "../server/readiness";

vi.mock("../server/email", () => ({
  sendSubmissionConfirmation: vi.fn(async () => ({ id: "email_grading_payment_retry" })),
  sendSubmissionConfirmationV2: vi.fn(async () => ({ id: "email_grading_payment_retry_v2" })),
  sendVaultClubWelcomeEmail: vi.fn(async () => {}),
  sendVaultClubCancelledEmail: vi.fn(async () => {}),
  sendVaultClubPaymentFailedEmail: vi.fn(async () => {}),
}));
vi.mock("../server/lib/pdf-token", () => ({
  generatePdfToken: vi.fn(() => "grading-payment-retry-test-token"),
  verifyPdfToken: vi.fn(() => true),
}));

const WEBHOOK_SECRET = "whsec_grading_payment_retry_proof";
const STRIPE_TEST_KEY = "sk_test_grading_payment_retry_proof";
const FULFILMENT_MIGRATION_SQL = readFileSync(
  new URL("../migrations/0117_grading_payment_fulfilment_outbox.sql", import.meta.url),
  "utf8"
);

let cluster: DisposablePostgres17;
let admin: pg.Client;
let appPool: pg.Pool;
let storage: typeof import("../server/storage").storage;
let WebhookHandlers: typeof import("../server/webhookHandlers").WebhookHandlers;
let reconcileGradingPaymentFulfilments: typeof import("../server/routes/submissions").reconcileGradingPaymentFulfilments;
let eventSeq = 0;

interface SignedEvent {
  payload: Buffer;
  signature: string;
  eventId: string;
}

function signedPaymentSucceeded(
  paymentIntentId: string,
  eventId = `evt_grading_retry_${++eventSeq}`,
  metadata: Record<string, string> = {}
): SignedEvent {
  const event = {
    id: eventId,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 2_500,
        currency: "gbp",
        metadata,
      },
    },
  };
  const payload = Buffer.from(JSON.stringify(event));
  const stripe = new Stripe(STRIPE_TEST_KEY, { apiVersion: "2025-08-27.basil" as never });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: payload.toString("utf8"),
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature, eventId };
}

async function seedSubmission(paymentIntentId: string, email?: string): Promise<number> {
  const result = await admin.query<{ id: number }>(
    `INSERT INTO submissions (tracking_number, payment_intent_id, email)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`MV-SUB-PAY-${paymentIntentId}`, paymentIntentId, email ?? null]
  );
  return result.rows[0].id;
}

async function paymentState(id: number): Promise<{
  status: string;
  payment_status: string;
  payment_amount: string | null;
  payment_currency: string | null;
}> {
  const result = await admin.query(
    `SELECT status, payment_status, payment_amount::text, payment_currency
     FROM submissions WHERE id=$1`,
    [id]
  );
  return result.rows[0];
}

async function eventLedgerCount(eventId: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM stripe_webhook_events WHERE stripe_event_id=$1`,
    [eventId]
  );
  return Number(result.rows[0].count);
}

async function fulfilmentState(submissionId: number): Promise<{
  status: string;
  attempt_count: number;
  provider_message_id: string | null;
}> {
  const result = await admin.query(
    `SELECT status, attempt_count, provider_message_id
       FROM grading_payment_fulfilments WHERE submission_id=$1`,
    [submissionId]
  );
  return result.rows[0];
}

async function estimateEffectState(submissionId: number): Promise<{
  paid_at: Date;
  estimated_completion_date: Date | null;
  estimate_completed_at: Date | null;
}> {
  const result = await admin.query(
    `SELECT f.paid_at, s.estimated_completion_date, f.estimate_completed_at
       FROM grading_payment_fulfilments f
       JOIN submissions s ON s.id = f.submission_id
      WHERE f.submission_id=$1`,
    [submissionId]
  );
  return result.rows[0];
}

function addUtcWorkingDays(value: Date, workingDays: number): Date {
  const target = new Date(value);
  let added = 0;
  while (added < workingDays) {
    target.setUTCDate(target.getUTCDate() + 1);
    const day = target.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return target;
}

describe("grading Stripe webhook retry safety (PostgreSQL 17.10)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("grading-payment-webhook-retry");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();

    await admin.query(`
      CREATE TABLE submissions (
        id SERIAL PRIMARY KEY,
        tracking_number TEXT NOT NULL UNIQUE,
        payment_intent_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'draft',
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        payment_amount NUMERIC(10, 2),
        payment_currency TEXT,
        payment_timestamp TIMESTAMPTZ,
        service_tier TEXT DEFAULT 'standard',
        estimated_completion_date TIMESTAMPTZ,
        email TEXT,
        user_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await admin.query(`
      CREATE TABLE stripe_webhook_events (
        stripe_event_id TEXT PRIMARY KEY,
        event_type TEXT,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await admin.query(FULFILMENT_MIGRATION_SQL);
    await admin.query(FULFILMENT_MIGRATION_SQL);
    await admin.query(`
      CREATE TABLE users (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        email text NOT NULL UNIQUE,
        first_name text,
        last_name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await admin.query(`
      CREATE TABLE member_credits (
        id serial PRIMARY KEY,
        user_id text NOT NULL,
        credit_type text NOT NULL,
        expires_at timestamptz,
        used_at timestamptz,
        used_for_submission_id integer,
        reserved_at timestamptz,
        reserved_until timestamptz,
        reserved_for_tracking_number text
      )
    `);
    await admin.query(`
      CREATE TABLE promo_codes (
        id serial PRIMARY KEY,
        code text NOT NULL,
        uses_count integer NOT NULL DEFAULT 0,
        max_uses integer,
        deleted_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await admin.query(`
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        admin_user text,
        details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.STRIPE_SECRET_KEY = STRIPE_TEST_KEY;
    process.env.STRIPE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const storageModule = await import("../server/storage");
    storage = storageModule.storage;
    WebhookHandlers = (await import("../server/webhookHandlers")).WebhookHandlers;
    reconcileGradingPaymentFulfilments = (await import("../server/routes/submissions"))
      .reconcileGradingPaymentFulfilments;
    appPool = (await import("../server/db")).pool;
  }, 90_000);

  afterAll(async () => {
    await appPool?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await admin.query(`DROP TRIGGER IF EXISTS fail_grading_estimate_marker ON grading_payment_fulfilments`);
    await admin.query(`DROP FUNCTION IF EXISTS fail_grading_estimate_marker()`);
    await admin.query(`DROP TRIGGER IF EXISTS fail_grading_email_marker ON grading_payment_fulfilments`);
    await admin.query(`DROP FUNCTION IF EXISTS fail_grading_email_marker()`);
    await admin.query(`DROP TRIGGER IF EXISTS fail_grading_user_marker ON grading_payment_fulfilments`);
    await admin.query(`DROP FUNCTION IF EXISTS fail_grading_user_marker()`);
    await admin.query(`
      TRUNCATE grading_payment_fulfilments, submissions, stripe_webhook_events,
               member_credits, promo_codes, audit_log, users RESTART IDENTITY
    `);
  });

  it("replays 0117 exactly and rejects an incompatible payment-authority namesake", async () => {
    expect((await admin.query<{ ready: boolean }>(PAYMENT_FULFILMENT_READINESS_SQL)).rows[0].ready).toBe(true);
    const objectCounts = await admin.query<{
      table_count: number;
      key_count: number;
      check_count: number;
      due_index_count: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='grading_payment_fulfilments' AND c.relkind='r') AS table_count,
        (SELECT COUNT(*)::int FROM pg_constraint c
          WHERE c.conrelid='public.grading_payment_fulfilments'::regclass
            AND c.contype IN ('p', 'u', 'f')) AS key_count,
        (SELECT COUNT(*)::int FROM pg_constraint c
          WHERE c.conrelid='public.grading_payment_fulfilments'::regclass
            AND c.contype='c' AND c.convalidated) AS check_count,
        (SELECT COUNT(*)::int FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
          WHERE i.indrelid='public.grading_payment_fulfilments'::regclass
            AND idx.relname='idx_grading_payment_fulfilments_due'
            AND i.indisvalid AND i.indisready) AS due_index_count
    `);
    expect(objectCounts.rows[0]).toEqual({
      table_count: 1,
      key_count: 4,
      check_count: 6,
      due_index_count: 1,
    });

    await admin.query("BEGIN");
    try {
      await admin.query(`
        ALTER TABLE public.grading_payment_fulfilments
          RENAME TO grading_payment_fulfilments_authoritative_backup
      `);
      await admin.query(`CREATE TABLE public.grading_payment_fulfilments (submission_id integer)`);
      expect((await admin.query<{ ready: boolean }>(PAYMENT_FULFILMENT_READINESS_SQL)).rows[0].ready).toBe(false);
      await expect(admin.query(FULFILMENT_MIGRATION_SQL)).rejects.toThrow(
        /incompatible public\.grading_payment_fulfilments; missing columns/
      );
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("makes readiness fail closed when the payment due-index contract drifts", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(`DROP INDEX public.idx_grading_payment_fulfilments_due`);
      expect((await admin.query<{ ready: boolean }>(PAYMENT_FULFILMENT_READINESS_SQL)).rows[0].ready).toBe(false);
    } finally {
      await admin.query("ROLLBACK");
    }
    expect((await admin.query<{ ready: boolean }>(PAYMENT_FULFILMENT_READINESS_SQL)).rows[0].ready).toBe(true);
  });

  it("keeps payment authority in public under a hostile search_path", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(`CREATE SCHEMA payment_shadow`);
      await admin.query(`CREATE TABLE payment_shadow.submissions (id integer PRIMARY KEY)`);
      await admin.query(`SET LOCAL search_path = payment_shadow, public`);
      await admin.query(FULFILMENT_MIGRATION_SQL);

      const binding = await admin.query<{
        shadow_table: string | null;
        public_table: string;
        referenced_table: string;
      }>(`
        SELECT
          to_regclass('payment_shadow.grading_payment_fulfilments')::text AS shadow_table,
          fulfilment_namespace.nspname || '.' || fulfilment_table.relname AS public_table,
          submission_namespace.nspname || '.' || submission_table.relname AS referenced_table
        FROM pg_constraint c
        JOIN pg_class fulfilment_table ON fulfilment_table.oid=c.conrelid
        JOIN pg_namespace fulfilment_namespace ON fulfilment_namespace.oid=fulfilment_table.relnamespace
        JOIN pg_class submission_table ON submission_table.oid=c.confrelid
        JOIN pg_namespace submission_namespace ON submission_namespace.oid=submission_table.relnamespace
        WHERE c.conrelid='public.grading_payment_fulfilments'::regclass AND c.contype='f'
      `);
      expect(binding.rows).toEqual([
        {
          shadow_table: null,
          public_table: "public.grading_payment_fulfilments",
          referenced_table: "public.submissions",
        },
      ]);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("recovers a persisted receipt after paid-transition failure without provider redelivery", async () => {
    const submissionId = await seedSubmission("pi_grading_retry_once");
    const signed = signedPaymentSucceeded("pi_grading_retry_once");
    const markPaid = vi.spyOn(storage, "markSubmissionAsPaid");
    markPaid.mockRejectedValueOnce(new Error("simulated transient paid-transition failure"));

    await expect(WebhookHandlers.processWebhook(signed.payload, signed.signature)).rejects.toThrow(
      /simulated transient paid-transition failure/
    );

    expect(await paymentState(submissionId)).toMatchObject({
      status: "draft",
      payment_status: "unpaid",
    });
    expect(await eventLedgerCount(signed.eventId)).toBe(0);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "PENDING", attempt_count: 0 });

    // The periodic worker is sufficient even before Stripe redelivers: the
    // durable receipt contains the verified payment facts needed to retry the
    // exact guarded draft->paid transition.
    await expect(reconcileGradingPaymentFulfilments()).resolves.toEqual({
      examined: 1,
      completed: 1,
      failed: 0,
      reconciliationRequired: 0,
    });

    expect(await paymentState(submissionId)).toEqual({
      status: "paid",
      payment_status: "paid",
      payment_amount: "25.00",
      payment_currency: "GBP",
    });
    expect(await eventLedgerCount(signed.eventId)).toBe(0);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 1 });

    // A later provider retry records its delivery but repeats no effect.
    await WebhookHandlers.processWebhook(signed.payload, signed.signature);
    expect(await eventLedgerCount(signed.eventId)).toBe(1);
    expect(markPaid).toHaveBeenCalledTimes(2);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 1 });
  });

  it("does not acknowledge or overwrite a paid receipt that conflicts with non-draft state", async () => {
    const submissionId = await seedSubmission("pi_grading_state_conflict");
    await admin.query(`UPDATE submissions SET status='cancelled' WHERE id=$1`, [submissionId]);
    const signed = signedPaymentSucceeded("pi_grading_state_conflict");

    await expect(WebhookHandlers.processWebhook(signed.payload, signed.signature)).rejects.toThrow(
      /submission did not reach paid state/
    );
    expect(await paymentState(submissionId)).toMatchObject({ status: "cancelled", payment_status: "unpaid" });
    expect(await eventLedgerCount(signed.eventId)).toBe(0);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "PENDING", attempt_count: 0 });

    await expect(reconcileGradingPaymentFulfilments()).resolves.toEqual({
      examined: 0,
      completed: 0,
      failed: 0,
      reconciliationRequired: 1,
    });
    expect(await paymentState(submissionId)).toMatchObject({ status: "cancelled", payment_status: "unpaid" });
    expect(await fulfilmentState(submissionId)).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      attempt_count: 0,
    });
  });

  it("recovers durable fulfilment after the paid transaction commits and the process dies", async () => {
    const submissionId = await seedSubmission("pi_grading_crash_after_paid");
    const signed = signedPaymentSucceeded("pi_grading_crash_after_paid");
    const realMarkPaid = storage.markSubmissionAsPaid.bind(storage);
    vi.spyOn(storage, "markSubmissionAsPaid").mockImplementationOnce(async (...args) => {
      const won = await realMarkPaid(...args);
      expect(won).toBe(true);
      throw new Error("simulated process death after paid commit");
    });

    await expect(WebhookHandlers.processWebhook(signed.payload, signed.signature)).rejects.toThrow(
      /simulated process death after paid commit/
    );

    expect(await paymentState(submissionId)).toMatchObject({ status: "paid", payment_status: "paid" });
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "PENDING", attempt_count: 0 });
    expect(await eventLedgerCount(signed.eventId)).toBe(0);

    const reconciliation = await reconcileGradingPaymentFulfilments();
    expect(reconciliation).toEqual({ examined: 1, completed: 1, failed: 0, reconciliationRequired: 0 });
    expect(await fulfilmentState(submissionId)).toEqual({
      status: "COMPLETE",
      attempt_count: 1,
      provider_message_id: "email_grading_payment_retry",
    });

    // The exact Stripe retry now only observes the complete submission and records
    // the event; no outbox effect is repeated.
    await WebhookHandlers.processWebhook(signed.payload, signed.signature);
    expect(await eventLedgerCount(signed.eventId)).toBe(1);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 1 });
  });

  it("keeps one paid-transition winner under concurrent redelivery of the same signed event", async () => {
    const submissionId = await seedSubmission("pi_grading_concurrent");
    const signed = signedPaymentSucceeded("pi_grading_concurrent");

    await Promise.all(
      Array.from({ length: 6 }, () => WebhookHandlers.processWebhook(signed.payload, signed.signature))
    );

    expect(await paymentState(submissionId)).toEqual({
      status: "paid",
      payment_status: "paid",
      payment_amount: "25.00",
      payment_currency: "GBP",
    });
    expect(await eventLedgerCount(signed.eventId)).toBe(1);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 1 });
    expect((await estimateEffectState(submissionId)).estimated_completion_date).not.toBeNull();

    await WebhookHandlers.processWebhook(signed.payload, signed.signature);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 1 });
  });

  it("rolls back an estimate write when its marker fails, then replays the authoritative date", async () => {
    const submissionId = await seedSubmission("pi_grading_estimate_marker_failure");
    const signed = signedPaymentSucceeded("pi_grading_estimate_marker_failure");
    await admin.query(`
      CREATE FUNCTION fail_grading_estimate_marker() RETURNS trigger AS $$
      BEGIN
        IF OLD.estimate_completed_at IS NULL AND NEW.estimate_completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'simulated estimate marker failure';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await admin.query(`
      CREATE TRIGGER fail_grading_estimate_marker
      BEFORE UPDATE ON grading_payment_fulfilments
      FOR EACH ROW EXECUTE FUNCTION fail_grading_estimate_marker()
    `);

    // The fault lands after the submission UPDATE but before the effect marker.
    // Both writes share a transaction, so the customer-facing promise must roll back.
    await WebhookHandlers.processWebhook(signed.payload, signed.signature);
    expect(await paymentState(submissionId)).toMatchObject({ status: "paid", payment_status: "paid" });
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "FAILED", attempt_count: 1 });
    expect(await eventLedgerCount(signed.eventId)).toBe(1);
    expect(await estimateEffectState(submissionId)).toMatchObject({
      estimated_completion_date: null,
      estimate_completed_at: null,
    });

    await admin.query(`DROP TRIGGER fail_grading_estimate_marker ON grading_payment_fulfilments`);
    await admin.query(`DROP FUNCTION fail_grading_estimate_marker()`);
    await admin.query(`UPDATE grading_payment_fulfilments SET next_attempt_at=now() WHERE submission_id=$1`, [
      submissionId,
    ]);

    expect(await reconcileGradingPaymentFulfilments()).toEqual({
      examined: 1,
      completed: 1,
      failed: 0,
      reconciliationRequired: 0,
    });
    const recovered = await estimateEffectState(submissionId);
    expect(recovered.estimate_completed_at).not.toBeNull();
    expect(recovered.estimated_completion_date?.toISOString()).toBe(
      addUtcWorkingDays(recovered.paid_at, 20).toISOString()
    );
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 2 });
  });

  it("reuses the stored provider idempotency key after send succeeds but its marker fails", async () => {
    const submissionId = await seedSubmission("pi_grading_email_marker_failure");
    const signed = signedPaymentSucceeded("pi_grading_email_marker_failure");
    const emailModule = await import("../server/email");
    const confirmation = vi.mocked(emailModule.sendSubmissionConfirmation);
    await admin.query(`
      CREATE FUNCTION fail_grading_email_marker() RETURNS trigger AS $$
      BEGIN
        IF OLD.email_completed_at IS NULL AND NEW.email_completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'simulated email marker failure';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await admin.query(`
      CREATE TRIGGER fail_grading_email_marker
      BEFORE UPDATE ON grading_payment_fulfilments
      FOR EACH ROW EXECUTE FUNCTION fail_grading_email_marker()
    `);

    // This is the unavoidable external-provider boundary: the provider accepted
    // the first send, then the local marker failed. Replay must send an identical
    // payload under the same provider idempotency key rather than create a second email.
    await WebhookHandlers.processWebhook(signed.payload, signed.signature);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "FAILED", attempt_count: 1 });
    expect(confirmation).toHaveBeenCalledTimes(1);
    const firstPayload = confirmation.mock.calls[0][0];
    expect(firstPayload.idempotencyKey).toBe(`grading-payment-confirmation:MV-SUB-PAY-pi_grading_email_marker_failure`);

    await admin.query(`DROP TRIGGER fail_grading_email_marker ON grading_payment_fulfilments`);
    await admin.query(`DROP FUNCTION fail_grading_email_marker()`);
    await admin.query(`UPDATE grading_payment_fulfilments SET next_attempt_at=now() WHERE submission_id=$1`, [
      submissionId,
    ]);
    expect(await reconcileGradingPaymentFulfilments()).toMatchObject({ completed: 1 });
    expect(confirmation).toHaveBeenCalledTimes(2);
    expect(confirmation.mock.calls[1][0]).toEqual(firstPayload);
    expect(await fulfilmentState(submissionId)).toEqual({
      status: "COMPLETE",
      attempt_count: 2,
      provider_message_id: "email_grading_payment_retry",
    });
  });

  it("rolls back account linking with its marker and safely recreates it on replay", async () => {
    const submissionId = await seedSubmission("pi_grading_user_marker_failure", "payment-user@example.test");
    const signed = signedPaymentSucceeded("pi_grading_user_marker_failure");
    await admin.query(`
      CREATE FUNCTION fail_grading_user_marker() RETURNS trigger AS $$
      BEGIN
        IF OLD.user_link_completed_at IS NULL AND NEW.user_link_completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'simulated user-link marker failure';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await admin.query(`
      CREATE TRIGGER fail_grading_user_marker
      BEFORE UPDATE ON grading_payment_fulfilments
      FOR EACH ROW EXECUTE FUNCTION fail_grading_user_marker()
    `);

    await WebhookHandlers.processWebhook(signed.payload, signed.signature);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "FAILED", attempt_count: 1 });
    expect((await admin.query(`SELECT COUNT(*)::int AS count FROM users`)).rows[0].count).toBe(0);
    expect(
      (await admin.query(`SELECT user_id FROM submissions WHERE id=$1`, [submissionId])).rows[0].user_id
    ).toBeNull();

    await admin.query(`DROP TRIGGER fail_grading_user_marker ON grading_payment_fulfilments`);
    await admin.query(`DROP FUNCTION fail_grading_user_marker()`);
    await admin.query(`UPDATE grading_payment_fulfilments SET next_attempt_at=now() WHERE submission_id=$1`, [
      submissionId,
    ]);
    expect(await reconcileGradingPaymentFulfilments()).toMatchObject({ completed: 1 });
    const linked = await admin.query(
      `SELECT s.user_id, u.email
         FROM submissions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1`,
      [submissionId]
    );
    expect(linked.rows).toEqual([{ user_id: expect.any(String), email: "payment-user@example.test" }]);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 2 });
  });

  it("terminalizes and continuously reports an expired final-attempt worker lease", async () => {
    const submissionId = await seedSubmission("pi_grading_exhausted_lease");
    const signed = signedPaymentSucceeded("pi_grading_exhausted_lease");
    await admin.query(`
      CREATE FUNCTION fail_grading_estimate_marker() RETURNS trigger AS $$
      BEGIN
        IF OLD.estimate_completed_at IS NULL AND NEW.estimate_completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'seed interrupted fulfilment';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await admin.query(`
      CREATE TRIGGER fail_grading_estimate_marker
      BEFORE UPDATE ON grading_payment_fulfilments
      FOR EACH ROW EXECUTE FUNCTION fail_grading_estimate_marker()
    `);
    await WebhookHandlers.processWebhook(signed.payload, signed.signature);
    await admin.query(`DROP TRIGGER fail_grading_estimate_marker ON grading_payment_fulfilments`);
    await admin.query(`DROP FUNCTION fail_grading_estimate_marker()`);
    await admin.query(
      `UPDATE grading_payment_fulfilments
          SET status='PROCESSING', attempt_count=8, claim_token='dead-worker',
              claim_expires_at=now() - interval '1 minute', next_attempt_at=now()
        WHERE submission_id=$1`,
      [submissionId]
    );

    expect(await reconcileGradingPaymentFulfilments()).toEqual({
      examined: 0,
      completed: 0,
      failed: 0,
      reconciliationRequired: 1,
    });
    expect(await fulfilmentState(submissionId)).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      attempt_count: 8,
    });
    // The worker result is an operational backlog gauge, so app restarts and
    // later sweeps continue to alert until an operator resolves the row.
    expect((await reconcileGradingPaymentFulfilments()).reconciliationRequired).toBe(1);
  });

  it("replays durable credit and legacy-promo effects exactly once under concurrent delivery", async () => {
    const submissionId = await seedSubmission("pi_grading_effects_concurrent");
    const credit = await admin.query<{ id: number }>(`
      INSERT INTO member_credits
        (user_id, credit_type, expires_at, reserved_at, reserved_until, reserved_for_tracking_number)
      VALUES ('user-payment-proof', 'member', now() + interval '30 days', now(), NULL,
              'MV-SUB-PAY-pi_grading_effects_concurrent')
      RETURNING id
    `);
    const promo = await admin.query<{ id: number }>(`
      INSERT INTO promo_codes (code, max_uses) VALUES ('PAYMENTPROOF', 10) RETURNING id
    `);
    const signed = signedPaymentSucceeded("pi_grading_effects_concurrent", undefined, {
      creditApplied: "true",
      creditType: "member",
      reservedCreditId: String(credit.rows[0].id),
      creditOwnerUserId: "user-payment-proof",
      creditAmountPence: "1500",
      promoCodeId: String(promo.rows[0].id),
      promoCode: "PAYMENTPROOF",
      promoCodePercent: "10",
    });

    await Promise.all(
      Array.from({ length: 6 }, () => WebhookHandlers.processWebhook(signed.payload, signed.signature))
    );
    await WebhookHandlers.processWebhook(signed.payload, signed.signature);

    const creditState = await admin.query(`SELECT used_for_submission_id FROM member_credits WHERE id=$1`, [
      credit.rows[0].id,
    ]);
    const promoState = await admin.query(`SELECT uses_count FROM promo_codes WHERE id=$1`, [promo.rows[0].id]);
    const promoAudits = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_log
        WHERE entity_type='promo_code' AND action='PROMO_CODE_REDEEMED'
          AND (details->>'submission_id')::int=$1`,
      [submissionId]
    );
    expect(creditState.rows[0].used_for_submission_id).toBe(submissionId);
    expect(promoState.rows[0].uses_count).toBe(1);
    expect(promoAudits.rows[0].count).toBe(1);
    expect(await fulfilmentState(submissionId)).toMatchObject({ status: "COMPLETE", attempt_count: 1 });
  });
});
