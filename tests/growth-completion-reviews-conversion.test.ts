import fs from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { getConversionSummary } from "../server/growth-intelligence-service";
import {
  getConversionEventSummary,
  getPreviousConversionEventSummary,
  recordGrowthConversionEvent,
} from "../server/growth-conversion-service";
import {
  getReviewConfiguration,
  getReviewSummary,
  queueReviewRequest,
  reviewCapabilityToken,
  reviewTokenHash,
  reviewTokenMatches,
} from "../server/review-request-service";
import type { GrowthSummary } from "../server/commercial-growth-service";

const dialect = new PgDialect();
const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const summary: GrowthSummary = {
  period: "30d",
  timezone: "Europe/London",
  paid: {
    paidSubmissions: { state: "MEASURED", value: 2 },
    paidCards: { state: "MEASURED", value: 5 },
    revenuePence: { state: "MEASURED", value: 3800 },
    averageCardsPerPaidOrder: { state: "MEASURED", value: 2.5 },
    unattributedPaidSubmissions: { state: "MEASURED", value: 0 },
  },
  sourcePerformance: [],
  campaignPerformance: [],
  partnerApplications: {
    total: { state: "MEASURED", value: 0 },
    new: { state: "MEASURED", value: 0 },
    contacted: { state: "MEASURED", value: 0 },
    qualified: { state: "MEASURED", value: 0 },
    notAFit: { state: "MEASURED", value: 0 },
    onboarding: { state: "MEASURED", value: 0 },
  },
  activePartners: { state: "NOT_INSTRUMENTED", reason: "No authority" },
  partnerCardsPerPartner: { state: "NOT_INSTRUMENTED", reason: "No authority" },
  partnerRevenue: { state: "NOT_INSTRUMENTED", reason: "No authority" },
  repeatCustomerRate: { state: "NOT_INSTRUMENTED", reason: "No authority" },
  historical: { state: "NOT_INSTRUMENTED", reason: "No authority" },
};

describe("GB-05 review lifecycle", () => {
  it("keeps the Growth review DTO distinct from the canonical grading ReviewSummary owner", () => {
    const source = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
    expect(source).toContain("type GrowthReviewSummary");
    expect(source).not.toContain("useQuery<ReviewSummary>");
    expect(source).toContain("shrink-0 whitespace-nowrap");
    expect(source).toContain("flex flex-wrap gap-2 pb-1 sm:flex-nowrap sm:overflow-x-auto");
  });

  it("stays disabled until every server-owned destination and sender boundary is valid", () => {
    delete process.env.REVIEW_DESTINATION_URL;
    delete process.env.REVIEW_DESTINATION_ALLOWED_HOSTS;
    delete process.env.REVIEW_TOKEN_SECRET;
    delete process.env.APP_URL;
    expect(getReviewConfiguration().state).toBe("NOT_CONFIGURED");

    process.env.REVIEW_DESTINATION_URL = "http://localhost/review";
    process.env.REVIEW_DESTINATION_ALLOWED_HOSTS = "localhost";
    process.env.REVIEW_TOKEN_SECRET = "x".repeat(32);
    process.env.RESEND_API_KEY = "configured-name-only";
    process.env.RESEND_DOMAIN_VERIFIED = "true";
    process.env.APP_URL = "https://mintvault.example.com";
    expect(getReviewConfiguration().state).toBe("INVALID");

    process.env.REVIEW_DESTINATION_URL = "https://reviews.example.com/mintvault";
    process.env.REVIEW_DESTINATION_ALLOWED_HOSTS = "reviews.example.com";
    delete process.env.APP_URL;
    expect(getReviewConfiguration().state).toBe("NOT_CONFIGURED");
    process.env.APP_URL = "http://localhost:5000";
    expect(getReviewConfiguration().state).toBe("INVALID");
    process.env.APP_URL = "https://mintvault.example.com";
    expect(getReviewConfiguration()).toMatchObject({ state: "READY", delayHours: 72 });
  });

  it("derives stable purpose-bound capability tokens and compares only hashes", () => {
    const secret = "s".repeat(40);
    const click = reviewCapabilityToken(secret, "click", 42);
    const suppress = reviewCapabilityToken(secret, "suppress", 42);
    expect(click).not.toBe(suppress);
    expect(reviewCapabilityToken(secret, "click", 42)).toBe(click);
    expect(reviewTokenMatches(click, reviewTokenHash(click))).toBe(true);
    expect(reviewTokenMatches(suppress, reviewTokenHash(click))).toBe(false);
  });

  it("queues one delayed request with no copied recipient PII", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    await queueReviewRequest(17, new Date("2026-08-19T10:00:00Z"), {
      execute: async (query) => {
        calls.push(dialect.sqlToQuery(query));
        return { rows: [] };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("ON CONFLICT (submission_id) DO NOTHING");
    expect(calls[0].sql).toContain("INTERVAL '1 hour'");
    expect(calls[0].sql).not.toMatch(/customer_email|first_name|last_name/);
  });

  it("returns aggregate lifecycle counts without recipient or submission detail", async () => {
    process.env.REVIEW_DESTINATION_URL = "https://reviews.example.com/mintvault";
    process.env.REVIEW_DESTINATION_ALLOWED_HOSTS = "reviews.example.com";
    process.env.REVIEW_TOKEN_SECRET = "s".repeat(40);
    process.env.RESEND_API_KEY = "configured-name-only";
    process.env.RESEND_DOMAIN_VERIFIED = "true";
    process.env.APP_URL = "https://mintvault.example.com";
    const result = await getReviewSummary("30d", {
      execute: async () => ({
        rows: [
          {
            eligible: 3,
            scheduled: 1,
            sent: 2,
            delivery_failed: 1,
            delivery_uncertain: 0,
            suppressed_status: 1,
            cancelled: 1,
            clicked: 1,
            suppression_records: 1,
          },
        ],
      }),
    });
    expect(result).toMatchObject({ eligible: 3, sent: 2, deliveryFailed: 1, suppressed: 1, clicked: 1 });
    expect(JSON.stringify(result)).not.toMatch(/customer_email|@example|first_name|tracking_number/);
    expect(result.publicReviews.state).toBe("NOT_CONNECTED");
  });

  it("migration enforces one request per submission, bounded attempts and no email column", () => {
    const migration = fs.readFileSync("migrations/0101_growth_reviews_and_conversion.sql", "utf8");
    expect(migration).toContain("CONSTRAINT uq_review_requests_submission UNIQUE (submission_id)");
    expect(migration).toContain("attempt_count >= 0 AND attempt_count <= 3");
    expect(migration).toContain("review_delivery_attempts");
    expect(migration).toContain("review_suppressions");
    expect(migration).not.toMatch(/^\s*(email|customer_email|recipient_email)\s+/m);
  });

  it("tightens manual delivery atomically and cancels pending review state on correction", () => {
    const route = fs.readFileSync("server/routes/admin-submissions.ts", "utf8");
    expect(route).toContain("AND shipped_at IS NOT NULL");
    expect(route).toContain("AND LOWER(status) = 'completed'");
    expect(route).toContain("AND payment_status = 'paid'");
    expect(route).toContain("queueReviewRequest(numId, new Date(deliveredAt), tx)");
    expect(route).toContain("cancelPendingReviewRequest(numId, tx)");
  });

  it("does not log raw recipient addresses in submission lifecycle sends", () => {
    const email = fs.readFileSync("server/email.ts", "utf8");
    const lifecycle = email.slice(
      email.indexOf("export async function sendSubmissionConfirmation"),
      email.indexOf("// ── Premium ownership")
    );
    expect(lifecycle).not.toMatch(/console\.(?:log|error)\([^\n]*data\.email/);
    expect(lifecycle).toContain("sendReviewRequestEmail");
    expect(lifecycle).toContain("idempotencyKey");
    const routes = fs.readFileSync("server/routes/reviews.ts", "utf8");
    expect(routes.match(/Referrer-Policy/g)).toHaveLength(3);
    expect(routes.match(/private, no-store/g)).toHaveLength(3);
  });
});

describe("Growth conversion events", () => {
  it("writes a unique, privacy-minimised server event", async () => {
    let query!: { sql: string; params: unknown[] };
    await recordGrowthConversionEvent(9, "CHECKOUT_START", {
      execute: async (input) => {
        query = dialect.sqlToQuery(input);
        return { rows: [] };
      },
    });
    expect(query.sql).toContain("ON CONFLICT (submission_id, event_kind) DO NOTHING");
    expect(query.params).toEqual(expect.arrayContaining([9, "CHECKOUT_START"]));
    expect(query.sql).not.toMatch(/email|cookie|referrer|ip_address/);
  });

  it("reports a cohort and calculates truthful checkout-to-paid drop-off", async () => {
    const executor = {
      execute: async () => ({
        rows: [{ submission_starts: 6, checkout_starts: 4, checkout_cohort_paid: 2, checkout_cohort_paid_cards: 5 }],
      }),
    };
    expect(await getConversionEventSummary("30d", executor)).toEqual({
      submissionStarts: 6,
      checkoutStarts: 4,
      checkoutCohortPaid: 2,
      checkoutCohortPaidCards: 5,
    });
    const conversion = await getConversionSummary("30d", summary, executor);
    expect(conversion.stages[0].metric).toMatchObject({ state: "REAL", value: 6 });
    expect(conversion.stages[1].metric).toMatchObject({ state: "REAL", value: 4 });
    expect(conversion.dropOff).toMatchObject({ state: "REAL", value: 50 });
    expect(conversion.submissionToCheckout).toMatchObject({ state: "REAL", value: 66.7 });
    expect(conversion.checkoutToPaid).toMatchObject({ state: "REAL", value: 50 });
    expect(conversion.submissionToPaid).toMatchObject({ state: "REAL", value: 33.3 });
    expect(conversion.cardsPerPaidOrder).toMatchObject({ state: "REAL", value: 2.5 });
    expect(conversion.comparison).toMatchObject({ state: "REAL", value: 0 });
    expect(conversion.stages[2].metric.source).toContain("Stripe");
  });

  it("queries an immediately preceding like-for-like London cohort and refuses an all-time comparison", async () => {
    let query!: { sql: string; params: unknown[] };
    const previous = await getPreviousConversionEventSummary("7d", {
      execute: async (input) => {
        query = dialect.sqlToQuery(input);
        return {
          rows: [{ submission_starts: 4, checkout_starts: 3, checkout_cohort_paid: 2, checkout_cohort_paid_cards: 4 }],
        };
      },
    });
    expect(previous).toMatchObject({ submissionStarts: 4, checkoutStarts: 3, checkoutCohortPaid: 2 });
    expect(query.sql).toContain("Europe/London");
    expect(query.sql).toContain("e.occurred_at <");
    expect(await getPreviousConversionEventSummary("all", { execute: async () => ({ rows: [] }) })).toBeNull();
  });

  it("keeps both event writes explicitly fail-open around checkout", () => {
    const route = fs.readFileSync("server/routes/submissions.ts", "utf8");
    expect(route).toContain('recordGrowthConversionEvent(Number(submission.id), "SUBMISSION_START").catch');
    expect(route).toContain('recordGrowthConversionEvent(Number(submission.id), "CHECKOUT_START").catch');
    expect(route.indexOf('recordGrowthConversionEvent(Number(submission.id), "CHECKOUT_START")')).toBeGreaterThan(
      route.indexOf("stripe.paymentIntents.create")
    );
  });
});
