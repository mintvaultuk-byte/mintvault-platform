import { sql } from "drizzle-orm";
import { db } from "../db";
import { summariseCommandCentreSubmissionStatuses } from "./submission-status";
import { normaliseCommandCentreTimestamp } from "./timestamp";

type Row = Record<string, unknown>;
type SourceResult<T> = { value: T } | { error: string };
type TimestampedCandidate = { id: string; timestamp: string };

export type CoreOperationalSnapshot = {
  submissions: SourceResult<{ unknownStatus: boolean; nonTerminal: number; paid: { count: number; amount: number; nonGbp: number } }>;
  scan: SourceResult<{ queue: number; candidates: Array<{ id: string; timestamp: string }> }>;
  grading: SourceResult<number>;
  review: SourceResult<{ count: number; candidates: Array<{ id: string; timestamp: string }> }>;
  print: SourceResult<{ count: number; candidates: Array<{ id: string; timestamp: string }> }>;
  transfer: SourceResult<{ count: number; candidates: Array<{ id: string; timestamp: string }> }>;
};

function numberOf(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Command Centre aggregate returned a non-numeric value");
  return parsed;
}

function normaliseCandidates(rows: Row[], timestampField: string): TimestampedCandidate[] {
  return rows.flatMap((row) => {
    const timestamp = normaliseCommandCentreTimestamp(row[timestampField]);
    const id = row.id;
    return timestamp && (typeof id === "string" || typeof id === "number")
      ? [{ id: String(id), timestamp }]
      : [];
  });
}

async function rows(query: string): Promise<Row[]> {
  const result = await db.execute(sql.raw(query));
  return result.rows as Row[];
}

async function safely<T>(operation: () => Promise<T>): Promise<SourceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return { value: await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("CORE_SOURCE_TIMEOUT")), 1_400);
      }),
    ]) };
  } catch (error) {
    return { error: (error as Error).message === "CORE_SOURCE_TIMEOUT" ? "CORE_SOURCE_TIMEOUT" : "CORE_SOURCE_ERROR" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency(tasks: readonly (() => Promise<unknown>)[], concurrency: number): Promise<unknown[]> {
  const output: unknown[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      output[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return output;
}

export function buildPaidSubmissionAggregateQuery(period: "today" | "month_to_date"): string {
  // payment_timestamp is a timestamp without time zone. Compare it with two
  // London-local timestamps so the period remains correct regardless of the
  // database session TimeZone (including BST transitions).
  const paymentPeriod = period === "today" ? "date_trunc('day', now() AT TIME ZONE 'Europe/London')" : "date_trunc('month', now() AT TIME ZONE 'Europe/London')";
  return "SELECT count(*)::bigint AS count, COALESCE(sum(payment_amount), 0) AS amount, count(*) FILTER (WHERE payment_currency IS DISTINCT FROM 'GBP')::bigint AS non_gbp FROM submissions WHERE deleted_at IS NULL AND payment_status = 'paid' AND payment_amount IS NOT NULL AND payment_timestamp >= " + paymentPeriod + " AND payment_timestamp < (now() AT TIME ZONE 'Europe/London')";
}

async function readSubmissions(period: "today" | "month_to_date") {
  const [statusRows, paidRows] = await Promise.all([
    rows("SELECT status, count(*)::bigint AS n FROM submissions WHERE deleted_at IS NULL GROUP BY status"),
    rows(buildPaidSubmissionAggregateQuery(period)),
  ]);
  const statusSummary = summariseCommandCentreSubmissionStatuses(
    statusRows.map((row) => ({ status: row.status, count: numberOf(row.n) })),
  );
  const paid = paidRows[0] ?? {};
  return {
    ...statusSummary,
    paid: { count: numberOf(paid.count ?? 0), amount: numberOf(paid.amount ?? 0), nonGbp: numberOf(paid.non_gbp ?? 0) },
  };
}

async function readScan() {
  const [aggregateRows, candidateRows] = await Promise.all([
    rows("SELECT scan_status, count(*)::bigint AS n FROM submissions WHERE deleted_at IS NULL AND scan_status IN ('unassigned', 'assigned') GROUP BY scan_status"),
    rows("SELECT id, received_at FROM submissions WHERE deleted_at IS NULL AND received_at IS NOT NULL AND scan_status = 'unassigned' ORDER BY received_at ASC, id ASC LIMIT 100"),
  ]);
  return { queue: aggregateRows.reduce((total, row) => total + numberOf(row.n), 0), candidates: normaliseCandidates(candidateRows, "received_at") };
}

async function readGrading() {
  const aggregateRows = await rows("SELECT grader_status, count(*)::bigint AS n FROM certificates WHERE deleted_at IS NULL AND grader_status IN ('unassigned', 'assigned') GROUP BY grader_status");
  return aggregateRows.reduce((total, row) => total + numberOf(row.n), 0);
}

async function readReview() {
  const [aggregateRows, candidateRows] = await Promise.all([
    rows("SELECT count(*)::bigint AS n FROM certificates WHERE deleted_at IS NULL AND grader_status = 'pending_review'"),
    rows("SELECT id, graded_at FROM certificates WHERE deleted_at IS NULL AND grader_status = 'pending_review' ORDER BY graded_at ASC NULLS LAST, id ASC LIMIT 100"),
  ]);
  return { count: numberOf(aggregateRows[0]?.n ?? 0), candidates: normaliseCandidates(candidateRows, "graded_at") };
}

async function readPrint() {
  const candidateRows = await rows("SELECT id, created_at, count(*) OVER() AS total_count FROM print_batches WHERE status IN ('failed', 'partial') ORDER BY created_at ASC, id ASC LIMIT 100");
  return { count: numberOf(candidateRows[0]?.total_count ?? 0), candidates: normaliseCandidates(candidateRows, "created_at") };
}

async function readTransfer() {
  const candidateRows = await rows("SELECT id, disputed_at, count(*) OVER() AS total_count FROM transfer_verifications WHERE disputed_at IS NOT NULL AND finalised_at IS NULL AND cancelled_at IS NULL ORDER BY disputed_at ASC, id ASC LIMIT 100");
  return { count: numberOf(candidateRows[0]?.total_count ?? 0), candidates: normaliseCandidates(candidateRows, "disputed_at") };
}

/** Bounded read-only aggregation with source-local error envelopes. */
export async function readCoreOperationalSnapshot(period: "today" | "month_to_date"): Promise<CoreOperationalSnapshot> {
  const results = await mapWithConcurrency([
    () => safely(() => readSubmissions(period)), () => safely(readScan), () => safely(readGrading),
    () => safely(readReview), () => safely(readPrint), () => safely(readTransfer),
  ], 6);
  const [submissions, scan, grading, review, print, transfer] = results as [
    CoreOperationalSnapshot["submissions"],
    CoreOperationalSnapshot["scan"],
    CoreOperationalSnapshot["grading"],
    CoreOperationalSnapshot["review"],
    CoreOperationalSnapshot["print"],
    CoreOperationalSnapshot["transfer"],
  ];
  return { submissions, scan, grading, review, print, transfer };
}
