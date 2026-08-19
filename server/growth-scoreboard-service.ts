/**
 * Owner-authoritative commercial scoreboard.
 *
 * Actuals are exact calendar-month aggregates. Targets are append-only owner
 * decisions written only through the existing Super Admin boundary. This
 * module never infers a target and exposes no MCP/AI mutation.
 */
import { sql, type SQL } from "drizzle-orm";
import { GROWTH_TARGET_METRICS, type GrowthTargetMetric, type GrowthTargetPeriod } from "@shared/schema";

export const GROWTH_SCOREBOARD_TIMEZONE = "Europe/London";
export const GROWTH_SCOREBOARD_PERIOD: GrowthTargetPeriod = "MONTHLY";
export const MAX_GROWTH_TARGET_VALUE = 1_000_000_000_000;

export type CommercialScoreStatus = "GREEN" | "AMBER" | "RED" | "GREY";
export type CommercialScoreLabel =
  "ON_TRACK" | "ATTENTION" | "MATERIALLY_BEHIND" | "NO_TARGET_SET" | "INSUFFICIENT_DATA";

export type CommercialTargetMetric = {
  key: GrowthTargetMetric;
  label: string;
  unit: "COUNT" | "GBP_PENCE";
  actual: { state: "REAL"; value: number } | { state: "NOT_INSTRUMENTED"; reason: string };
  target:
    | { state: "SET"; value: number; authority: "SUPER_ADMIN"; lastSetAt: string }
    | { state: "NOT_SET"; authority: "SUPER_ADMIN"; lastSetAt: string | null };
  status: CommercialScoreStatus;
  statusLabel: CommercialScoreLabel;
  actualProgressPercent: number | null;
  expectedProgressPercent: number;
  paceRatio: number | null;
  explanation: string;
};

export type CommercialScoreboardInsight = {
  id: string;
  kind: "ON_TRACK" | "ACTION";
  metric: GrowthTargetMetric;
  message: string;
  trace: {
    ruleId: "TARGET_PACE_GREEN" | "TARGET_PACE_AMBER" | "TARGET_PACE_RED";
    actualProgressPercent: number;
    expectedProgressPercent: number;
  };
};

export type CommercialScoreboard = {
  period: {
    kind: "MONTHLY";
    timezone: typeof GROWTH_SCOREBOARD_TIMEZONE;
    start: string;
    end: string;
    progressPercent: number;
  };
  targetAuthority:
    | {
        state: "READY";
        mutationAuthority: "SUPER_ADMIN_ONLY";
        mcpMutationEnabled: false;
      }
    | {
        state: "NOT_INSTRUMENTED";
        mutationAuthority: "SUPER_ADMIN_ONLY";
        mcpMutationEnabled: false;
        reason: string;
      };
  metrics: CommercialTargetMetric[];
  insights: CommercialScoreboardInsight[];
  definition: string;
  lastUpdated: string;
};

export type CommercialTargetUpdate = Partial<Record<GrowthTargetMetric, number | null>>;

type QueryResult = { rows: unknown[] };
export type ScoreboardQueryExecutor = { execute(query: SQL): Promise<QueryResult> };
export type ScoreboardMutationExecutor = {
  transaction<T>(callback: (tx: ScoreboardQueryExecutor) => Promise<T>): Promise<T>;
};

type ActualRow = {
  period_start?: Date | string;
  period_end?: Date | string;
  paid_cards?: number | string;
  revenue_pence?: number | string;
  partner_applications?: number | string;
  qualified_partners?: number | string;
};

type TargetRow = {
  metric?: string;
  target_value?: number | string | null;
  created_at?: Date | string;
};

const METRIC_DEFINITIONS: Record<GrowthTargetMetric, { label: string; unit: "COUNT" | "GBP_PENCE" }> = {
  PAID_CARDS: { label: "Paid cards", unit: "COUNT" },
  REVENUE_GBP: { label: "Revenue", unit: "GBP_PENCE" },
  PARTNER_APPLICATIONS: { label: "Partner applications", unit: "COUNT" },
  QUALIFIED_PARTNERS: { label: "Qualified Partners", unit: "COUNT" },
  GENUINE_REVIEWS: { label: "Genuine reviews", unit: "COUNT" },
};

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | string | undefined, fallback: Date): string {
  const parsed = value instanceof Date ? value : value ? new Date(value) : fallback;
  if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_SCOREBOARD_PERIOD");
  return parsed.toISOString();
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

export function commercialPeriodProgress(start: string, end: string, observedAt: string): number {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const observedMs = new Date(observedAt).getTime();
  if (![startMs, endMs, observedMs].every(Number.isFinite) || endMs <= startMs) {
    throw new Error("INVALID_SCOREBOARD_PERIOD");
  }
  return Math.min(1, Math.max(0, (observedMs - startMs) / (endMs - startMs)));
}

export function deriveCommercialTargetStatus(input: {
  actual: number | null;
  target: number | null;
  periodProgress: number;
  elapsedMs: number;
}): Pick<
  CommercialTargetMetric,
  "status" | "statusLabel" | "actualProgressPercent" | "expectedProgressPercent" | "paceRatio" | "explanation"
> {
  const expectedProgressPercent = roundOne(Math.min(1, Math.max(0, input.periodProgress)) * 100);
  if (input.target == null) {
    return {
      status: "GREY",
      statusLabel: "NO_TARGET_SET",
      actualProgressPercent: null,
      expectedProgressPercent,
      paceRatio: null,
      explanation: "No owner-approved target is set for this calendar month.",
    };
  }
  if (input.actual == null) {
    return {
      status: "GREY",
      statusLabel: "INSUFFICIENT_DATA",
      actualProgressPercent: null,
      expectedProgressPercent,
      paceRatio: null,
      explanation: "The target is set, but an authoritative actual is not instrumented.",
    };
  }
  const actualProgress = input.actual / input.target;
  const actualProgressPercent = roundOne(actualProgress * 100);
  if (actualProgress >= 1) {
    return {
      status: "GREEN",
      statusLabel: "ON_TRACK",
      actualProgressPercent,
      expectedProgressPercent,
      paceRatio: input.periodProgress > 0 ? roundOne(actualProgress / input.periodProgress) : null,
      explanation: "The monthly target has been achieved.",
    };
  }
  if (input.elapsedMs < 24 * 60 * 60 * 1000 && input.actual === 0) {
    return {
      status: "GREY",
      statusLabel: "INSUFFICIENT_DATA",
      actualProgressPercent,
      expectedProgressPercent,
      paceRatio: null,
      explanation: "Less than one complete day has elapsed and no actual has been recorded yet.",
    };
  }
  const paceRatio = input.periodProgress > 0 ? actualProgress / input.periodProgress : Number.POSITIVE_INFINITY;
  if (paceRatio >= 1) {
    return {
      status: "GREEN",
      statusLabel: "ON_TRACK",
      actualProgressPercent,
      expectedProgressPercent,
      paceRatio: roundOne(paceRatio),
      explanation: "Actual progress is at or ahead of elapsed calendar-month pace.",
    };
  }
  if (paceRatio >= 0.7) {
    return {
      status: "AMBER",
      statusLabel: "ATTENTION",
      actualProgressPercent,
      expectedProgressPercent,
      paceRatio: roundOne(paceRatio),
      explanation: "Actual progress is behind elapsed calendar-month pace but not materially behind.",
    };
  }
  return {
    status: "RED",
    statusLabel: "MATERIALLY_BEHIND",
    actualProgressPercent,
    expectedProgressPercent,
    paceRatio: roundOne(paceRatio),
    explanation: "Actual progress is below 70% of the elapsed calendar-month pace.",
  };
}

function scoreboardInsights(metrics: CommercialTargetMetric[]): CommercialScoreboardInsight[] {
  return metrics.flatMap((metric): CommercialScoreboardInsight[] => {
    if (metric.actualProgressPercent == null || metric.status === "GREY") return [];
    if (metric.status === "GREEN") {
      return [
        {
          id: `scoreboard-${metric.key.toLowerCase()}-on-track`,
          kind: "ON_TRACK",
          metric: metric.key,
          message: `${metric.label} ${metric.actualProgressPercent >= 100 ? "has achieved the monthly target" : "is at or ahead of monthly target pace"}.`,
          trace: {
            ruleId: "TARGET_PACE_GREEN",
            actualProgressPercent: metric.actualProgressPercent,
            expectedProgressPercent: metric.expectedProgressPercent,
          },
        },
      ];
    }
    return [
      {
        id: `scoreboard-${metric.key.toLowerCase()}-action`,
        kind: "ACTION",
        metric: metric.key,
        message:
          metric.status === "RED"
            ? `${metric.label} is materially behind monthly target pace.`
            : `${metric.label} is behind monthly target pace and needs attention.`,
        trace: {
          ruleId: metric.status === "RED" ? "TARGET_PACE_RED" : "TARGET_PACE_AMBER",
          actualProgressPercent: metric.actualProgressPercent,
          expectedProgressPercent: metric.expectedProgressPercent,
        },
      },
    ];
  });
}

async function readCurrentMonthActuals(executor: ScoreboardQueryExecutor, observedAt: Date): Promise<ActualRow> {
  const result = await executor.execute(sql`
    WITH bounds AS (
      SELECT
        (date_trunc('month', ${observedAt}::timestamptz AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London') AS period_start,
        ((date_trunc('month', ${observedAt}::timestamptz AT TIME ZONE 'Europe/London') + interval '1 month') AT TIME ZONE 'Europe/London') AS period_end
    )
    SELECT
      b.period_start,
      b.period_end,
      (
        SELECT COALESCE(SUM(s.card_count), 0)::bigint
          FROM submissions s
         WHERE s.payment_status = 'paid'
           AND s.deleted_at IS NULL
           AND s.payment_intent_id IS NOT NULL
           AND s.payment_timestamp IS NOT NULL
           AND s.payment_currency = 'GBP'
           AND s.payment_timestamp >= b.period_start
           AND s.payment_timestamp < b.period_end
      ) AS paid_cards,
      (
        SELECT COALESCE(SUM(ROUND(s.payment_amount * 100)), 0)::bigint
          FROM submissions s
         WHERE s.payment_status = 'paid'
           AND s.deleted_at IS NULL
           AND s.payment_intent_id IS NOT NULL
           AND s.payment_timestamp IS NOT NULL
           AND s.payment_currency = 'GBP'
           AND s.payment_timestamp >= b.period_start
           AND s.payment_timestamp < b.period_end
      ) AS revenue_pence,
      (
        SELECT COUNT(*)::bigint
          FROM partner_applications pa
         WHERE pa.deleted_at IS NULL
           AND pa.created_at >= b.period_start
           AND pa.created_at < b.period_end
      ) AS partner_applications,
      (
        SELECT COUNT(*)::bigint
          FROM partner_applications pa
         WHERE pa.deleted_at IS NULL
           AND pa.status IN ('QUALIFIED', 'ONBOARDING')
           AND pa.created_at >= b.period_start
           AND pa.created_at < b.period_end
      ) AS qualified_partners
    FROM bounds b
  `);
  return (result.rows[0] ?? {}) as ActualRow;
}

async function readTargets(executor: ScoreboardQueryExecutor, periodStart: Date): Promise<TargetRow[]> {
  const result = await executor.execute(sql`
    SELECT DISTINCT ON (metric) metric, target_value, created_at
      FROM growth_commercial_targets
     WHERE period = 'MONTHLY' AND period_start = ${periodStart}
     ORDER BY metric, created_at DESC, id DESC
  `);
  return result.rows as TargetRow[];
}

export async function getCommercialScoreboard(
  options: {
    executor?: ScoreboardQueryExecutor;
    observedAt?: Date;
  } = {}
): Promise<CommercialScoreboard> {
  const executor = options.executor ?? (await import("./db")).db;
  const observedAt = options.observedAt ?? new Date();
  const observedIso = observedAt.toISOString();
  const actualRow = await readCurrentMonthActuals(executor, observedAt);
  const start = iso(actualRow.period_start, observedAt);
  const end = iso(actualRow.period_end, observedAt);
  const periodProgress = commercialPeriodProgress(start, end, observedIso);
  let targetRows: TargetRow[] = [];
  let targetAuthority: CommercialScoreboard["targetAuthority"] = {
    state: "READY",
    mutationAuthority: "SUPER_ADMIN_ONLY",
    mcpMutationEnabled: false,
  };
  try {
    targetRows = await readTargets(executor, new Date(start));
  } catch {
    targetAuthority = {
      state: "NOT_INSTRUMENTED",
      mutationAuthority: "SUPER_ADMIN_ONLY",
      mcpMutationEnabled: false,
      reason: "The commercial target store is unavailable until migration 0101 is applied.",
    };
  }
  const targets = new Map<GrowthTargetMetric, { value: number | null; createdAt: string }>();
  for (const row of targetRows) {
    if (!GROWTH_TARGET_METRICS.includes(row.metric as GrowthTargetMetric)) continue;
    const raw = row.target_value;
    const value = raw == null ? null : numeric(raw);
    targets.set(row.metric as GrowthTargetMetric, {
      value: value != null && value > 0 ? value : null,
      createdAt: iso(row.created_at, observedAt),
    });
  }
  const actuals: Record<GrowthTargetMetric, CommercialTargetMetric["actual"]> = {
    PAID_CARDS: { state: "REAL", value: numeric(actualRow.paid_cards) },
    REVENUE_GBP: { state: "REAL", value: numeric(actualRow.revenue_pence) },
    PARTNER_APPLICATIONS: { state: "REAL", value: numeric(actualRow.partner_applications) },
    QUALIFIED_PARTNERS: { state: "REAL", value: numeric(actualRow.qualified_partners) },
    GENUINE_REVIEWS: {
      state: "NOT_INSTRUMENTED",
      reason: "No approved review-provider authority proves genuine published review count.",
    },
  };
  const elapsedMs = observedAt.getTime() - new Date(start).getTime();
  const metrics = GROWTH_TARGET_METRICS.map((key): CommercialTargetMetric => {
    const definition = METRIC_DEFINITIONS[key];
    const actual = actuals[key];
    const configured = targets.get(key);
    const targetValue = targetAuthority.state === "READY" ? (configured?.value ?? null) : null;
    const status =
      targetAuthority.state === "READY"
        ? deriveCommercialTargetStatus({
            actual: actual.state === "REAL" ? actual.value : null,
            target: targetValue,
            periodProgress,
            elapsedMs,
          })
        : {
            ...deriveCommercialTargetStatus({ actual: null, target: 1, periodProgress, elapsedMs }),
            explanation: "The owner-approved target store is not instrumented in this environment.",
          };
    return {
      key,
      ...definition,
      actual,
      target:
        targetValue == null
          ? { state: "NOT_SET", authority: "SUPER_ADMIN", lastSetAt: configured?.createdAt ?? null }
          : { state: "SET", value: targetValue, authority: "SUPER_ADMIN", lastSetAt: configured!.createdAt },
      ...status,
    };
  });
  return {
    period: {
      kind: GROWTH_SCOREBOARD_PERIOD,
      timezone: GROWTH_SCOREBOARD_TIMEZONE,
      start,
      end,
      progressPercent: roundOne(periodProgress * 100),
    },
    targetAuthority,
    metrics,
    insights: scoreboardInsights(metrics),
    definition:
      "Calendar-month actual progress is compared with elapsed Europe/London month progress. Green is on/ahead of pace; amber is 70% to under 100% of pace; red is below 70%. No target or unavailable actual is grey. Targets are never inferred.",
    lastUpdated: observedIso,
  };
}

export async function setCurrentMonthCommercialTargets(
  targets: CommercialTargetUpdate,
  actor: string,
  options: { executor?: ScoreboardMutationExecutor; observedAt?: Date } = {}
): Promise<{ changed: boolean; changedMetrics: GrowthTargetMetric[] }> {
  const entries = Object.entries(targets) as Array<[GrowthTargetMetric, number | null | undefined]>;
  const updates = entries.filter(
    (entry): entry is [GrowthTargetMetric, number | null] =>
      GROWTH_TARGET_METRICS.includes(entry[0]) && entry[1] !== undefined
  );
  if (updates.length === 0) throw new Error("EMPTY_TARGET_UPDATE");
  for (const [, value] of updates) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0 || value > MAX_GROWTH_TARGET_VALUE)) {
      throw new Error("INVALID_TARGET_VALUE");
    }
  }
  const safeActor = actor.trim();
  if (!safeActor || safeActor.length > 320) throw new Error("INVALID_TARGET_ACTOR");
  const observedAt = options.observedAt ?? new Date();
  const executor = options.executor ?? ((await import("./db")).db as unknown as ScoreboardMutationExecutor);
  return executor.transaction(async (tx) => {
    const bounds = await tx.execute(sql`
      SELECT (date_trunc('month', ${observedAt}::timestamptz AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London') AS period_start
    `);
    const rawStart = (bounds.rows[0] as { period_start?: Date | string } | undefined)?.period_start;
    const periodStart = new Date(iso(rawStart, observedAt));
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        1901187519,
        (EXTRACT(YEAR FROM (${periodStart}::timestamptz AT TIME ZONE 'Europe/London'))::int * 100)
          + EXTRACT(MONTH FROM (${periodStart}::timestamptz AT TIME ZONE 'Europe/London'))::int
      )
    `);
    const currentRows = await readTargets(tx, periodStart);
    const current = new Map<GrowthTargetMetric, number | null>();
    for (const row of currentRows) {
      if (GROWTH_TARGET_METRICS.includes(row.metric as GrowthTargetMetric)) {
        current.set(row.metric as GrowthTargetMetric, row.target_value == null ? null : numeric(row.target_value));
      }
    }
    const changes = updates.filter(([metric, targetValue]) => (current.get(metric) ?? null) !== targetValue);
    if (changes.length === 0) return { changed: false, changedMetrics: [] };
    for (const [metric, targetValue] of changes) {
      await tx.execute(sql`
        INSERT INTO growth_commercial_targets (metric, period, period_start, target_value, set_by)
        VALUES (${metric}, 'MONTHLY', ${periodStart}, ${targetValue}, ${safeActor})
      `);
    }
    await tx.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      VALUES (
        'commercial_growth_target',
        ${periodStart.toISOString()},
        'growth_targets_updated',
        ${safeActor},
        ${JSON.stringify({
          period: GROWTH_SCOREBOARD_PERIOD,
          metrics: changes.map(([metric, targetValue]) => ({ metric, targetValue })),
          source: "growth_command",
        })}::jsonb
      )
    `);
    return { changed: true, changedMetrics: changes.map(([metric]) => metric) };
  });
}
