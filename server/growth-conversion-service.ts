import { sql, type SQL } from "drizzle-orm";
import type { GrowthPeriod } from "./commercial-growth-service";

export const GROWTH_CONVERSION_EVENT_KINDS = ["SUBMISSION_START", "CHECKOUT_START"] as const;
export type GrowthConversionEventKind = (typeof GROWTH_CONVERSION_EVENT_KINDS)[number];

type QueryResult = { rows: unknown[] };
export type GrowthConversionExecutor = { execute(query: SQL): Promise<QueryResult> };

function periodFilter(period: GrowthPeriod): SQL {
  if (period === "all") return sql`TRUE`;
  const days = period === "today" ? 0 : period === "7d" ? 6 : period === "30d" ? 29 : 89;
  return sql`e.occurred_at >= ((date_trunc('day', now() AT TIME ZONE 'Europe/London') - (${days} * interval '1 day')) AT TIME ZONE 'Europe/London')`;
}

/**
 * Records one server-observed funnel event. The unique submission/kind key
 * makes retries and double-clicks idempotent. Callers deliberately catch any
 * failure so telemetry can never block checkout or payment.
 */
export async function recordGrowthConversionEvent(
  submissionId: number,
  eventKind: GrowthConversionEventKind,
  executor?: GrowthConversionExecutor
): Promise<void> {
  if (!Number.isSafeInteger(submissionId) || submissionId <= 0) throw new Error("invalid submission id");
  const runner = executor ?? (await import("./db")).db;
  await runner.execute(sql`
    INSERT INTO growth_conversion_events (submission_id, event_kind, occurred_at)
    VALUES (${submissionId}, ${eventKind}, NOW())
    ON CONFLICT (submission_id, event_kind) DO NOTHING
  `);
}

export type ConversionEventSummary = {
  submissionStarts: number;
  checkoutStarts: number;
  checkoutCohortPaid: number;
  checkoutCohortPaidCards: number;
};

export async function getConversionEventSummary(
  period: GrowthPeriod,
  executor?: GrowthConversionExecutor
): Promise<ConversionEventSummary> {
  const runner = executor ?? (await import("./db")).db;
  const window = periodFilter(period);
  const result = await runner.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE e.event_kind = 'SUBMISSION_START')::int AS submission_starts,
      COUNT(*) FILTER (WHERE e.event_kind = 'CHECKOUT_START')::int AS checkout_starts,
      COUNT(*) FILTER (
        WHERE e.event_kind = 'CHECKOUT_START'
          AND s.payment_status = 'paid'
          AND s.deleted_at IS NULL
          AND s.payment_intent_id IS NOT NULL
          AND s.payment_timestamp IS NOT NULL
          AND s.payment_currency = 'GBP'
      )::int AS checkout_cohort_paid,
      COALESCE(SUM(s.card_count) FILTER (
        WHERE e.event_kind = 'CHECKOUT_START'
          AND s.payment_status = 'paid'
          AND s.deleted_at IS NULL
          AND s.payment_intent_id IS NOT NULL
          AND s.payment_timestamp IS NOT NULL
          AND s.payment_currency = 'GBP'
      ), 0)::int AS checkout_cohort_paid_cards
    FROM growth_conversion_events e
    JOIN submissions s ON s.id = e.submission_id
    WHERE ${window}
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const value = (key: string) => {
    const parsed = Number(row[key] ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    submissionStarts: value("submission_starts"),
    checkoutStarts: value("checkout_starts"),
    checkoutCohortPaid: value("checkout_cohort_paid"),
    checkoutCohortPaidCards: value("checkout_cohort_paid_cards"),
  };
}
