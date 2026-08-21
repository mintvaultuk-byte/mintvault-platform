import type { PoolClient } from "pg";
import { pool } from "../db";
import { summariseCommandCentreSubmissionStatuses } from "./submission-status";
import { normaliseCommandCentreTimestamp } from "./timestamp";

type Row = Record<string, unknown>;
type SourceResult<T> = { value: T } | { error: string };
type TimestampedCandidate = { id: string; timestamp: string };
const SOURCE_BUDGET_MS = 650;
const SNAPSHOT_BUDGET_MS = 1_200;

export type CoreOperationalSnapshot = {
  submissions: SourceResult<{
    unknownStatus: boolean;
    nonTerminal: number;
    paid: { count: number; amount: number; nonGbp: number };
  }>;
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
    return timestamp && (typeof id === "string" || typeof id === "number") ? [{ id: String(id), timestamp }] : [];
  });
}

async function rows(client: PoolClient, query: string): Promise<Row[]> {
  const result = await client.query(query);
  return result.rows as Row[];
}

async function acquireCoreClient(
  deadlineAt: number
): Promise<{ client: PoolClient; release: (destroy?: boolean) => void }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("CORE_SOURCE_TIMEOUT");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("CORE_SOURCE_TIMEOUT"));
    }, remainingMs);
    pool.connect((error, client, release) => {
      if (settled) {
        if (client) release(true);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error || !client) reject(error ?? new Error("CORE_SOURCE_CLIENT_UNAVAILABLE"));
      else resolve({ client, release });
    });
  });
}

async function safely<T>(
  source: string,
  snapshotDeadlineAt: number,
  operation: (client: PoolClient) => Promise<T>
): Promise<SourceResult<T>> {
  const startedAt = Date.now();
  const sourceDeadlineAt = Math.min(snapshotDeadlineAt, startedAt + SOURCE_BUDGET_MS);
  let acquired: Awaited<ReturnType<typeof acquireCoreClient>> | undefined;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    acquired = await acquireCoreClient(sourceDeadlineAt);
    const { client } = acquired;
    const remainingMs = sourceDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      destroyed = true;
      acquired.release(true);
      throw new Error("CORE_SOURCE_TIMEOUT");
    }
    const transaction = async () => {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '500ms'");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    };
    const value = await Promise.race([
      transaction(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          destroyed = true;
          acquired?.release(true);
          reject(new Error("CORE_SOURCE_TIMEOUT"));
        }, remainingMs);
      }),
    ]);
    console.info(`[command-centre-source] source=${source} outcome=ok duration_ms=${Date.now() - startedAt}`);
    return { value };
  } catch (error) {
    if (acquired && !destroyed) await acquired.client.query("ROLLBACK").catch(() => {});
    const reason = (error as Error).message === "CORE_SOURCE_TIMEOUT" ? "CORE_SOURCE_TIMEOUT" : "CORE_SOURCE_ERROR";
    console.warn(`[command-centre-source] source=${source} outcome=${reason} duration_ms=${Date.now() - startedAt}`);
    return { error: reason };
  } finally {
    if (timer) clearTimeout(timer);
    if (acquired && !destroyed) acquired.release();
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

export function buildPaidSubmissionAggregateQuery(
  period: "today" | "month_to_date",
  clockExpression = "now()"
): string {
  // payment_timestamp is timestamp-without-time-zone carrying a UTC wall-clock
  // value (Date writers are serialised as ISO UTC). Convert the London calendar
  // boundary back to that representation before comparing the bare column.
  const londonBoundary =
    period === "today"
      ? `date_trunc('day', ${clockExpression} AT TIME ZONE 'Europe/London')`
      : `date_trunc('month', ${clockExpression} AT TIME ZONE 'Europe/London')`;
  const utcNaiveBoundary = `((${londonBoundary} AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')`;
  return (
    "SELECT count(*)::bigint AS count, COALESCE(sum(payment_amount), 0) AS amount, count(*) FILTER (WHERE payment_currency IS DISTINCT FROM 'GBP')::bigint AS non_gbp FROM submissions WHERE deleted_at IS NULL AND payment_status = 'paid' AND payment_amount IS NOT NULL AND payment_timestamp >= " +
    utcNaiveBoundary +
    ` AND payment_timestamp < (${clockExpression} AT TIME ZONE 'UTC')`
  );
}

async function readSubmissions(client: PoolClient, period: "today" | "month_to_date") {
  const statusRows = await rows(
    client,
    "SELECT status, count(*)::bigint AS n FROM submissions WHERE deleted_at IS NULL GROUP BY status"
  );
  const paidRows = await rows(client, buildPaidSubmissionAggregateQuery(period));
  const statusSummary = summariseCommandCentreSubmissionStatuses(
    statusRows.map((row) => ({ status: row.status, count: numberOf(row.n) }))
  );
  const paid = paidRows[0] ?? {};
  return {
    ...statusSummary,
    paid: { count: numberOf(paid.count ?? 0), amount: numberOf(paid.amount ?? 0), nonGbp: numberOf(paid.non_gbp ?? 0) },
  };
}

async function readScan(client: PoolClient) {
  const aggregateRows = await rows(
    client,
    "SELECT scan_status, count(*)::bigint AS n FROM submissions WHERE deleted_at IS NULL AND scan_status IN ('unassigned', 'assigned') GROUP BY scan_status"
  );
  const candidateRows = await rows(
    client,
    "SELECT id, received_at FROM submissions WHERE deleted_at IS NULL AND received_at IS NOT NULL AND scan_status = 'unassigned' ORDER BY received_at ASC, id ASC LIMIT 100"
  );
  return {
    queue: aggregateRows.reduce((total, row) => total + numberOf(row.n), 0),
    candidates: normaliseCandidates(candidateRows, "received_at"),
  };
}

async function readGrading(client: PoolClient) {
  const aggregateRows = await rows(
    client,
    "SELECT grader_status, count(*)::bigint AS n FROM certificates WHERE deleted_at IS NULL AND grader_status IN ('unassigned', 'assigned') GROUP BY grader_status"
  );
  return aggregateRows.reduce((total, row) => total + numberOf(row.n), 0);
}

async function readReview(client: PoolClient) {
  const aggregateRows = await rows(
    client,
    "SELECT count(*)::bigint AS n FROM certificates WHERE deleted_at IS NULL AND grader_status = 'pending_review'"
  );
  const candidateRows = await rows(
    client,
    "SELECT id, graded_at FROM certificates WHERE deleted_at IS NULL AND grader_status = 'pending_review' ORDER BY graded_at ASC NULLS LAST, id ASC LIMIT 100"
  );
  return { count: numberOf(aggregateRows[0]?.n ?? 0), candidates: normaliseCandidates(candidateRows, "graded_at") };
}

async function readPrint(client: PoolClient) {
  const candidateRows = await rows(
    client,
    "SELECT id, created_at, count(*) OVER() AS total_count FROM print_batches WHERE status IN ('failed', 'partial') ORDER BY created_at ASC, id ASC LIMIT 100"
  );
  return {
    count: numberOf(candidateRows[0]?.total_count ?? 0),
    candidates: normaliseCandidates(candidateRows, "created_at"),
  };
}

async function readTransfer(client: PoolClient) {
  const candidateRows = await rows(
    client,
    "SELECT id, disputed_at, count(*) OVER() AS total_count FROM transfer_verifications WHERE disputed_at IS NOT NULL AND finalised_at IS NULL AND cancelled_at IS NULL ORDER BY disputed_at ASC, id ASC LIMIT 100"
  );
  return {
    count: numberOf(candidateRows[0]?.total_count ?? 0),
    candidates: normaliseCandidates(candidateRows, "disputed_at"),
  };
}

/** Bounded read-only aggregation with source-local error envelopes. */
export async function readCoreOperationalSnapshot(period: "today" | "month_to_date"): Promise<CoreOperationalSnapshot> {
  const snapshotDeadlineAt = Date.now() + SNAPSHOT_BUDGET_MS;
  const results = await mapWithConcurrency(
    [
      () => safely("submissions", snapshotDeadlineAt, (client) => readSubmissions(client, period)),
      () => safely("scan", snapshotDeadlineAt, readScan),
      () => safely("grading", snapshotDeadlineAt, readGrading),
      () => safely("review", snapshotDeadlineAt, readReview),
      () => safely("print", snapshotDeadlineAt, readPrint),
      () => safely("transfer", snapshotDeadlineAt, readTransfer),
    ],
    3
  );
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
