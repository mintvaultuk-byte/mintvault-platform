import { createHash, createHmac, timingSafeEqual } from "crypto";
import { isIP } from "net";
import { sql, type SQL } from "drizzle-orm";
import type { GrowthPeriod } from "./commercial-growth-service";
import { sendReviewRequestEmail } from "./email";

export const REVIEW_REQUEST_DELAY_HOURS = 72;
export const REVIEW_MAX_ATTEMPTS = 3;
export const REVIEW_BATCH_SIZE = 10;

type QueryResult = { rows: unknown[] };
export type ReviewQueryExecutor = { execute(query: SQL): Promise<QueryResult> };

export type ReviewConfiguration =
  | {
      state: "READY";
      destination: URL;
      appBaseUrl: string;
      tokenSecret: string;
      delayHours: number;
    }
  | { state: "NOT_CONFIGURED" | "INVALID"; reason: string; delayHours: number };

function configuredDelayHours(): number {
  const parsed = Number(process.env.REVIEW_REQUEST_DELAY_HOURS ?? REVIEW_REQUEST_DELAY_HOURS);
  return Number.isInteger(parsed) && parsed >= 24 && parsed <= 336 ? parsed : REVIEW_REQUEST_DELAY_HOURS;
}

function safeReviewDestination(raw: string, allowedHosts: string[]): URL | null {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      isIP(hostname) !== 0 ||
      !allowedHosts.includes(hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function safeCredentialLinkBase(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== "/" ||
      !url.hostname ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".local") ||
      isIP(url.hostname) !== 0
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Reads configuration without ever returning a credential to a route/client. */
export function getReviewConfiguration(): ReviewConfiguration {
  const delayHours = configuredDelayHours();
  const rawDestination = process.env.REVIEW_DESTINATION_URL?.trim() ?? "";
  const rawAppBaseUrl = process.env.APP_URL?.trim() ?? "";
  const allowedHosts = (process.env.REVIEW_DESTINATION_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const tokenSecret = process.env.REVIEW_TOKEN_SECRET ?? "";
  if (!rawDestination || !rawAppBaseUrl || allowedHosts.length === 0 || !tokenSecret || !process.env.RESEND_API_KEY) {
    return {
      state: "NOT_CONFIGURED",
      reason:
        "Review destination, canonical app URL, host allowlist, token secret and email provider authority are required.",
      delayHours,
    };
  }
  if (process.env.RESEND_DOMAIN_VERIFIED !== "true") {
    return {
      state: "NOT_CONFIGURED",
      reason: "The verified MintVault email domain is required before customer review requests can send.",
      delayHours,
    };
  }
  const destination = safeReviewDestination(rawDestination, allowedHosts);
  const appBaseUrl = safeCredentialLinkBase(rawAppBaseUrl);
  if (!destination || !appBaseUrl || Buffer.byteLength(tokenSecret, "utf8") < 32) {
    return {
      state: "INVALID",
      reason:
        "Review configuration failed canonical HTTPS URL, destination allowlist or minimum secret-length validation.",
      delayHours,
    };
  }
  return { state: "READY", destination, appBaseUrl, tokenSecret, delayHours };
}

export function reviewCapabilityToken(secret: string, purpose: "click" | "suppress", requestId: number): string {
  return createHmac("sha256", secret).update(`growth-review:${purpose}:${requestId}:v1`).digest("base64url");
}

export function reviewTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function reviewTokenMatches(token: string, expectedHash: string): boolean {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(reviewTokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Must be called inside the same transaction that first records delivery. */
export async function queueReviewRequest(
  submissionId: number,
  deliveredAt: Date,
  executor: ReviewQueryExecutor
): Promise<void> {
  const delayHours = configuredDelayHours();
  await executor.execute(sql`
    INSERT INTO review_requests (
      submission_id, status, eligible_at, scheduled_for, next_attempt_at
    ) VALUES (
      ${submissionId},
      'ELIGIBLE',
      ${deliveredAt},
      ${deliveredAt} + (${delayHours} * INTERVAL '1 hour'),
      ${deliveredAt} + (${delayHours} * INTERVAL '1 hour')
    )
    ON CONFLICT (submission_id) DO NOTHING
  `);
}

export async function cancelPendingReviewRequest(submissionId: number, executor: ReviewQueryExecutor): Promise<void> {
  await executor.execute(sql`
    UPDATE review_requests
       SET status = 'CANCELLED', next_attempt_at = NULL, updated_at = NOW()
     WHERE submission_id = ${submissionId}
       AND status IN ('ELIGIBLE', 'REQUEST_SCHEDULED', 'DELIVERY_FAILED')
  `);
}

export type ReviewSummary = {
  period: GrowthPeriod;
  configuration: { state: "READY" | "NOT_CONFIGURED" | "INVALID"; reason?: string };
  eligible: number;
  scheduled: number;
  sent: number;
  deliveryFailed: number;
  deliveryUncertain: number;
  suppressed: number;
  cancelled: number;
  clicked: number;
  publicReviews: { state: "NOT_CONNECTED"; reason: string };
  definition: string;
  lastUpdated: string;
};

function periodFilter(period: GrowthPeriod): SQL {
  if (period === "all") return sql`TRUE`;
  const days = period === "today" ? 0 : period === "7d" ? 6 : period === "30d" ? 29 : 89;
  return sql`rr.eligible_at >= ((date_trunc('day', now() AT TIME ZONE 'Europe/London') - (${days} * interval '1 day')) AT TIME ZONE 'Europe/London')`;
}

export async function getReviewSummary(period: GrowthPeriod, executor?: ReviewQueryExecutor): Promise<ReviewSummary> {
  const runner = executor ?? (await import("./db")).db;
  const config = getReviewConfiguration();
  const result = await runner.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE rr.status = 'ELIGIBLE')::int AS eligible,
      COUNT(*) FILTER (WHERE rr.status = 'REQUEST_SCHEDULED')::int AS scheduled,
      COUNT(*) FILTER (WHERE rr.status = 'REQUEST_SENT')::int AS sent,
      COUNT(*) FILTER (WHERE rr.status = 'DELIVERY_FAILED')::int AS delivery_failed,
      COUNT(*) FILTER (WHERE rr.status = 'DELIVERY_UNCERTAIN')::int AS delivery_uncertain,
      COUNT(*) FILTER (WHERE rr.status = 'SUPPRESSED')::int AS suppressed_status,
      COUNT(*) FILTER (WHERE rr.status = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE rr.clicked_at IS NOT NULL)::int AS clicked,
      COUNT(DISTINCT rs.submission_id)::int AS suppression_records
    FROM review_requests rr
    LEFT JOIN review_suppressions rs ON rs.submission_id = rr.submission_id
    WHERE ${periodFilter(period)}
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const count = (key: string) => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    period,
    configuration: config.state === "READY" ? { state: "READY" } : { state: config.state, reason: config.reason },
    eligible: count("eligible"),
    scheduled: count("scheduled"),
    sent: count("sent"),
    deliveryFailed: count("delivery_failed"),
    deliveryUncertain: count("delivery_uncertain"),
    suppressed: Math.max(count("suppressed_status"), count("suppression_records")),
    cancelled: count("cancelled"),
    clicked: count("clicked"),
    publicReviews: {
      state: "NOT_CONNECTED",
      reason: "No approved review-provider ratings/count API authority is connected.",
    },
    definition:
      "Eligible means a paid, non-deleted submission whose shipped/completed return has a carrier-confirmed delivered_at. Grade, sentiment and marketing consent are never eligibility inputs. Clicked records the first request to the signed link and may include email security scanners; it is not a claimed human review.",
    lastUpdated: new Date().toISOString(),
  };
}

type ClaimedReview = {
  id: number;
  submission_id: number;
  attempt_count: number;
  customer_email: string;
  customer_first_name: string;
  tracking_number: string;
};

async function claimDueReviews(): Promise<ClaimedReview[]> {
  const { db } = await import("./db");
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE review_requests rr
         SET status = 'SUPPRESSED', next_attempt_at = NULL, updated_at = NOW()
       WHERE rr.status IN ('ELIGIBLE', 'REQUEST_SCHEDULED', 'DELIVERY_FAILED')
         AND EXISTS (SELECT 1 FROM review_suppressions rs WHERE rs.submission_id = rr.submission_id)
    `);
    await tx.execute(sql`
      UPDATE review_requests rr
         SET status = 'CANCELLED', next_attempt_at = NULL, updated_at = NOW()
       FROM submissions s
       WHERE s.id = rr.submission_id
         AND rr.status IN ('ELIGIBLE', 'REQUEST_SCHEDULED', 'DELIVERY_FAILED')
         AND (
           s.delivered_at IS NULL OR s.shipped_at IS NULL OR LOWER(s.status) <> 'completed'
           OR s.payment_status <> 'paid' OR s.deleted_at IS NOT NULL
           OR s.payment_intent_id IS NULL OR s.payment_timestamp IS NULL
           OR s.payment_currency <> 'GBP' OR s.customer_email IS NULL
         )
    `);
    const claimed = await tx.execute(sql`
      WITH due AS (
        SELECT rr.id
        FROM review_requests rr
        JOIN submissions s ON s.id = rr.submission_id
        WHERE rr.status IN ('ELIGIBLE', 'REQUEST_SCHEDULED', 'DELIVERY_FAILED')
          AND rr.next_attempt_at <= NOW()
          AND rr.attempt_count < ${REVIEW_MAX_ATTEMPTS}
          AND s.delivered_at IS NOT NULL
          AND s.shipped_at IS NOT NULL
          AND LOWER(s.status) = 'completed'
          AND s.payment_status = 'paid'
          AND s.deleted_at IS NULL
          AND s.payment_intent_id IS NOT NULL
          AND s.payment_timestamp IS NOT NULL
          AND s.payment_currency = 'GBP'
          AND s.customer_email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM review_suppressions rs WHERE rs.submission_id = rr.submission_id)
        ORDER BY rr.next_attempt_at, rr.id
        LIMIT ${REVIEW_BATCH_SIZE}
        FOR UPDATE OF rr SKIP LOCKED
      )
      UPDATE review_requests rr
         SET status = 'REQUEST_SCHEDULED',
             attempt_count = rr.attempt_count + 1,
             last_attempt_at = NOW(),
             next_attempt_at = NOW() + INTERVAL '1 hour',
             updated_at = NOW()
        FROM due
       WHERE rr.id = due.id
      RETURNING rr.id, rr.submission_id, rr.attempt_count
    `);
    if (claimed.rows.length === 0) return [];
    const ids = claimed.rows.map((row) => Number((row as Record<string, unknown>).id));
    const detail = await tx.execute(sql`
      SELECT rr.id, rr.submission_id, rr.attempt_count,
             s.customer_email, COALESCE(s.customer_first_name, 'there') AS customer_first_name,
             s.tracking_number
      FROM review_requests rr
      JOIN submissions s ON s.id = rr.submission_id
      WHERE rr.id = ANY(${ids}::bigint[])
      ORDER BY rr.id
    `);
    return detail.rows as ClaimedReview[];
  });
}

function reviewFailureCode(error: unknown): "PROVIDER_REJECTED" | "PROVIDER_UNCERTAIN" {
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("Resend API error:") || message === "Resend returned no message id"
    ? "PROVIDER_REJECTED"
    : "PROVIDER_UNCERTAIN";
}

/** Called behind the application-wide advisory job lock; DB claims are also SKIP LOCKED. */
export async function processReviewRequestBatch(): Promise<{ processed: number; state: string }> {
  const config = getReviewConfiguration();
  if (config.state !== "READY") return { processed: 0, state: config.state };
  const claimed = await claimDueReviews();
  if (claimed.length === 0) return { processed: 0, state: "READY" };
  const { db } = await import("./db");
  for (const request of claimed) {
    const clickToken = reviewCapabilityToken(config.tokenSecret, "click", request.id);
    const suppressToken = reviewCapabilityToken(config.tokenSecret, "suppress", request.id);
    const clickHash = reviewTokenHash(clickToken);
    const suppressHash = reviewTokenHash(suppressToken);
    await db.execute(sql`
      UPDATE review_requests
         SET click_token_hash = ${clickHash}, suppress_token_hash = ${suppressHash}, updated_at = NOW()
       WHERE id = ${request.id} AND status = 'REQUEST_SCHEDULED'
    `);
    try {
      const sent = await sendReviewRequestEmail({
        email: request.customer_email,
        firstName: request.customer_first_name,
        submissionId: request.tracking_number,
        reviewUrl: `${config.appBaseUrl}/reviews/r/${clickToken}`,
        preferencesUrl: `${config.appBaseUrl}/reviews/preferences/${suppressToken}`,
        idempotencyKey: `growth-review-${request.id}-v1`,
      });
      if (!sent) throw new Error("email provider unavailable");
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE review_requests
             SET status = 'REQUEST_SENT', sent_at = NOW(), provider_message_id = ${sent.id},
                 failure_code = NULL, next_attempt_at = NULL, updated_at = NOW()
           WHERE id = ${request.id} AND status = 'REQUEST_SCHEDULED'
        `);
        await tx.execute(sql`
          INSERT INTO review_delivery_attempts (
            review_request_id, attempt_number, outcome, provider_message_id
          ) VALUES (${request.id}, ${request.attempt_count}, 'SENT', ${sent.id})
          ON CONFLICT (review_request_id, attempt_number) DO NOTHING
        `);
      });
      console.log(`[reviews] request_sent requestId=${request.id} providerMessageId=${sent.id}`);
    } catch (error) {
      const failureCode = reviewFailureCode(error);
      const outcome = failureCode === "PROVIDER_UNCERTAIN" ? "UNCERTAIN" : "FAILED";
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE review_requests
             SET status = ${request.attempt_count >= REVIEW_MAX_ATTEMPTS ? (outcome === "UNCERTAIN" ? "DELIVERY_UNCERTAIN" : "DELIVERY_FAILED") : "DELIVERY_FAILED"},
                 failure_code = ${failureCode},
                 next_attempt_at = CASE
                   WHEN ${request.attempt_count} >= ${REVIEW_MAX_ATTEMPTS} THEN NULL
                   WHEN ${request.attempt_count} = 1 THEN NOW() + INTERVAL '15 minutes'
                   ELSE NOW() + INTERVAL '2 hours'
                 END,
                 updated_at = NOW()
           WHERE id = ${request.id} AND status = 'REQUEST_SCHEDULED'
        `);
        await tx.execute(sql`
          INSERT INTO review_delivery_attempts (
            review_request_id, attempt_number, outcome, failure_code
          ) VALUES (${request.id}, ${request.attempt_count}, ${outcome}, ${failureCode})
          ON CONFLICT (review_request_id, attempt_number) DO NOTHING
        `);
      });
      console.warn(`[reviews] request_failed requestId=${request.id} code=${failureCode}`);
    }
  }
  return { processed: claimed.length, state: "READY" };
}

export async function recordReviewClick(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return false;
  const { db } = await import("./db");
  const result = await db.execute(sql`
    UPDATE review_requests
       SET clicked_at = COALESCE(clicked_at, NOW()), updated_at = NOW()
     WHERE click_token_hash = ${reviewTokenHash(token)} AND status = 'REQUEST_SENT'
    RETURNING id
  `);
  return result.rows.length === 1;
}

export async function suppressReviewRequest(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return false;
  const { db } = await import("./db");
  const tokenHash = reviewTokenHash(token);
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT id, submission_id FROM review_requests
      WHERE suppress_token_hash = ${tokenHash}
      FOR UPDATE
    `);
    if (found.rows.length !== 1) return false;
    const row = found.rows[0] as Record<string, unknown>;
    await tx.execute(sql`
      INSERT INTO review_suppressions (submission_id, reason)
      VALUES (${Number(row.submission_id)}, 'CUSTOMER_REQUEST')
      ON CONFLICT (submission_id) DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE review_requests
         SET status = CASE WHEN status = 'REQUEST_SENT' THEN status ELSE 'SUPPRESSED' END,
             next_attempt_at = NULL,
             updated_at = NOW()
       WHERE id = ${Number(row.id)}
    `);
    return true;
  });
}
