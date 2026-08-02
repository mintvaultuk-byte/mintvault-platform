/**
 * Project Control — the durable evidence repository.
 *
 * The only module that writes migration 0039's four tables. Everything above it (the GitHub sync,
 * the probes, the overview) goes through this API, so the invariants live in one place instead of
 * being re-implemented per caller.
 *
 * THE THREE INVARIANTS THIS MODULE OWES THE REST OF THE SYSTEM
 * -----------------------------------------------------------
 * 1. SNAPSHOTS ARE APPEND-ONLY. There is deliberately no update and no delete in this API. The
 *    database enforces it too (0039's trigger), but the absence of the method is the first line:
 *    a caller cannot reach for what does not exist.
 *
 * 2. A CHECKPOINT ADVANCES ONLY AFTER THE EVIDENCE IT DESCRIBES IS STORED. A checkpoint is a claim
 *    that "everything up to here is safely recorded". Advancing it on a failed run would make the
 *    next run skip data that was never persisted — a permanent, silent hole. `storeCheckpoint` is
 *    therefore never called from a failure path, and `completeRun` will not advance it either.
 *
 * 3. "LATEST GOOD" IS NOT "LATEST ROW". A failed observation is recorded, not substituted. Reads
 *    that answer "what do we know?" filter to usable freshness, so an outage adds a row saying so
 *    without destroying the answer that came before it.
 *
 * REDACTION: payloads are bounded and pass through `redactPayload` before storage. A secret must
 * never reach this table, because a table is forever and a log line is not.
 */
import { createHash, randomUUID } from "node:crypto";

/** Minimal database seam so tests can drive a real pool and production passes its own. */
export interface EvidenceDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** A pool that can hand out a dedicated connection — required for a real transaction. */
export interface PoolLikeDb extends EvidenceDb {
  connect(): Promise<EvidenceDb & { release(): void }>;
}

function isPoolLike(db: EvidenceDb): db is PoolLikeDb {
  return typeof (db as PoolLikeDb).connect === "function";
}

/**
 * Run `work` inside a single transaction on ONE connection.
 *
 * This matters more than it looks. `pool.query` may route consecutive statements to DIFFERENT
 * connections, so issuing BEGIN and COMMIT through a pool does not produce a transaction — it
 * produces a BEGIN on one connection and a COMMIT on another, with the real work uncommitted
 * somewhere in between. A dedicated client is the only way to get atomicity here.
 *
 * If the caller's db cannot hand out a connection the work still runs, without atomicity, rather
 * than failing — the fallback is honest and the callers that matter pass a real pool.
 */
export async function withTransaction<T>(db: EvidenceDb, work: (tx: EvidenceDb) => Promise<T>): Promise<T> {
  if (!isPoolLike(db)) return work(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const RUN_STATES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "CANCELLED",
  "EXPIRED",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** States in which a run is still doing something; used to find the active run. */
const OPEN_STATES: readonly RunState[] = ["QUEUED", "RUNNING"];

/** Freshness values that count as usable evidence when answering "what do we know?". */
export const USABLE_FRESHNESS = ["CURRENT", "STALE"] as const;

export type Freshness = "CURRENT" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | "CONTRADICTORY" | "FAILED";

export interface SyncRun {
  syncId: string;
  sourceType: string;
  triggerType: "manual" | "scheduled" | "startup";
  actor: string | null;
  target: string;
  environment: string | null;
  state: RunState;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  counts: Record<string, unknown>;
  warnings: unknown[];
  errorCode: string | null;
  workerIdentity: string | null;
}

export interface SnapshotInput {
  sourceType: string;
  environment?: string | null;
  entityType: string;
  entityId: string;
  commitSha?: string | null;
  status?: string | null;
  freshness?: Freshness;
  confidence?: string;
  validUntil?: Date | null;
  payload?: unknown;
  syncId?: string | null;
  staleReason?: string | null;
}

export interface StoredSnapshot extends Omit<SnapshotInput, "payload"> {
  id: string;
  payload: unknown;
  payloadDigest: string;
  observedAt: Date;
  freshness: Freshness;
}

/** Payload ceiling. A snapshot describes an observation; it is not a place to park an API dump. */
const MAX_PAYLOAD_BYTES = 32 * 1024;

/**
 * Strip credential-shaped values and bound the size before anything is written.
 *
 * Applied to every payload rather than trusting callers: the GitHub scanner already redacts its
 * errors, but a future caller will forget, and a secret written into an append-only table cannot
 * be deleted afterwards — the trigger that protects history also protects a mistake.
 */
export function redactPayload(payload: unknown): { value: unknown; digest: string } {
  let text: string;
  try {
    text = JSON.stringify(payload ?? {});
  } catch {
    text = '{"error":"unserialisable payload"}';
  }

  const scrubbed = text
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/sk_(live|test)_[A-Za-z0-9]{10,}/g, "[REDACTED_KEY]")
    .replace(/postgres(?:ql)?:\/\/[^"\s]+/gi, "[REDACTED_DSN]")
    .replace(/https?:\/\/[^"\s]*@[^"\s]*/gi, "[REDACTED_URL]");

  const bounded =
    scrubbed.length > MAX_PAYLOAD_BYTES
      ? JSON.stringify({ truncated: true, bytes: scrubbed.length, head: scrubbed.slice(0, 2000) })
      : scrubbed;

  return { value: JSON.parse(bounded), digest: createHash("sha256").update(bounded).digest("hex") };
}

/* ── Sync runs ────────────────────────────────────────────────────────────────────────────── */

export async function createRun(
  db: EvidenceDb,
  input: {
    sourceType: string;
    triggerType: "manual" | "scheduled" | "startup";
    target: string;
    actor?: string | null;
    environment?: string | null;
    workerIdentity?: string | null;
  }
): Promise<string> {
  const syncId = randomUUID();
  await db.query(
    `INSERT INTO pc_sync_runs (sync_id, source_type, trigger_type, actor, target, environment, state, worker_identity)
     VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7)`,
    [
      syncId,
      input.sourceType,
      input.triggerType,
      input.actor ?? null,
      input.target,
      input.environment ?? null,
      input.workerIdentity ?? null,
    ]
  );
  return syncId;
}

export async function markRunning(db: EvidenceDb, syncId: string): Promise<void> {
  await db.query(`UPDATE pc_sync_runs SET state='RUNNING', started_at=now() WHERE sync_id=$1`, [syncId]);
}

/**
 * Close out a run.
 *
 * Deliberately does NOT touch the checkpoint. A run's outcome and the checkpoint's position are
 * separate decisions: a PARTIAL run stored some evidence and must record that, but only the
 * caller knows how far the checkpoint may safely advance.
 */
export async function completeRun(
  db: EvidenceDb,
  syncId: string,
  state: Exclude<RunState, "QUEUED" | "RUNNING">,
  detail: {
    counts?: Record<string, unknown>;
    warnings?: unknown[];
    errorCode?: string | null;
    rateLimitRemaining?: number | null;
    rateLimitResetAt?: Date | null;
  } = {}
): Promise<void> {
  await db.query(
    `UPDATE pc_sync_runs
        SET state=$2, completed_at=now(), counts=$3::jsonb, warnings=$4::jsonb,
            error_code=$5, rate_limit_remaining=$6, rate_limit_reset_at=$7
      WHERE sync_id=$1`,
    [
      syncId,
      state,
      JSON.stringify(detail.counts ?? {}),
      JSON.stringify((detail.warnings ?? []).slice(0, 50)),
      detail.errorCode ?? null,
      detail.rateLimitRemaining ?? null,
      detail.rateLimitResetAt ?? null,
    ]
  );
}

function toRun(row: Record<string, unknown>): SyncRun {
  return {
    syncId: row.sync_id as string,
    sourceType: row.source_type as string,
    triggerType: row.trigger_type as SyncRun["triggerType"],
    actor: (row.actor as string) ?? null,
    target: row.target as string,
    environment: (row.environment as string) ?? null,
    state: row.state as RunState,
    requestedAt: row.requested_at as Date,
    startedAt: (row.started_at as Date) ?? null,
    completedAt: (row.completed_at as Date) ?? null,
    counts: (row.counts as Record<string, unknown>) ?? {},
    warnings: (row.warnings as unknown[]) ?? [],
    errorCode: (row.error_code as string) ?? null,
    workerIdentity: (row.worker_identity as string) ?? null,
  };
}

export async function getRun(db: EvidenceDb, syncId: string): Promise<SyncRun | null> {
  const res = await db.query(`SELECT * FROM pc_sync_runs WHERE sync_id=$1`, [syncId]);
  return res.rows.length ? toRun(res.rows[0] as Record<string, unknown>) : null;
}

export async function getLatestRun(db: EvidenceDb, sourceType: string): Promise<SyncRun | null> {
  const res = await db.query(
    `SELECT * FROM pc_sync_runs WHERE source_type=$1 ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [sourceType]
  );
  return res.rows.length ? toRun(res.rows[0] as Record<string, unknown>) : null;
}

/** The run a duplicate refresh should be shown instead of starting a second scan. */
export async function getActiveRun(db: EvidenceDb, sourceType: string): Promise<SyncRun | null> {
  const res = await db.query(
    `SELECT * FROM pc_sync_runs
      WHERE source_type=$1 AND state = ANY($2::text[])
      ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [sourceType, OPEN_STATES as unknown as string[]]
  );
  return res.rows.length ? toRun(res.rows[0] as Record<string, unknown>) : null;
}

/** The last run that actually produced evidence — what "last successful sync" means on screen. */
export async function getLastSuccessfulRun(db: EvidenceDb, sourceType: string): Promise<SyncRun | null> {
  const res = await db.query(
    `SELECT * FROM pc_sync_runs
      WHERE source_type=$1 AND state IN ('SUCCEEDED','PARTIAL')
      ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1`,
    [sourceType]
  );
  return res.rows.length ? toRun(res.rows[0] as Record<string, unknown>) : null;
}

/**
 * Reap runs abandoned by a dead process.
 *
 * A run that is QUEUED or RUNNING blocks every future refresh, because `getActiveRun` treats both
 * as active. The lease expires on its own after five minutes; the RUN ROW does not. So a process
 * killed mid-sync — OOM, a Fly machine replacement, a deploy — would leave a row that wedges
 * refresh permanently, with no remedy short of editing the table by hand.
 *
 * This closes any run older than `olderThanMs` that no live lease still covers. The lease check is
 * the safety catch: a genuinely long-running sync renews nothing but still holds its lease, so it
 * is never reaped out from under itself.
 *
 * Returns the ids it expired, so a caller can log what it cleaned up rather than doing it silently.
 */
export async function expireAbandonedRuns(
  db: EvidenceDb,
  sourceType: string,
  olderThanMs = 15 * 60 * 1000
): Promise<string[]> {
  const seconds = Math.max(1, Math.floor(olderThanMs / 1000));
  const res = await db.query(
    `UPDATE pc_sync_runs r
        SET state='EXPIRED', completed_at=now(), error_code='abandoned_run_reaped'
      WHERE r.source_type=$1
        AND r.state = ANY($2::text[])
        AND r.requested_at < now() - ($3 || ' seconds')::interval
        -- Never reap a run whose lease is still live: that sync is genuinely in progress.
        AND NOT EXISTS (
          SELECT 1 FROM pc_sync_leases l
           WHERE l.source_type = r.source_type AND l.sync_id = r.sync_id AND l.expires_at > now()
        )
      RETURNING r.sync_id`,
    [sourceType, OPEN_STATES as unknown as string[], String(seconds)]
  );
  return (res.rows as { sync_id: string }[]).map((r) => r.sync_id);
}

/* ── Checkpoints ──────────────────────────────────────────────────────────────────────────── */

export interface Checkpoint {
  sourceType: string;
  resourceKey: string;
  etag: string | null;
  cursorValue: string | null;
  observedAt: Date;
  syncId: string | null;
}

export async function loadCheckpoint(
  db: EvidenceDb,
  sourceType: string,
  resourceKey: string
): Promise<Checkpoint | null> {
  const res = await db.query(
    `SELECT source_type, resource_key, etag, cursor_value, observed_at, sync_id
       FROM pc_sync_checkpoints WHERE source_type=$1 AND resource_key=$2`,
    [sourceType, resourceKey]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0] as Record<string, unknown>;
  return {
    sourceType: r.source_type as string,
    resourceKey: r.resource_key as string,
    etag: (r.etag as string) ?? null,
    cursorValue: (r.cursor_value as string) ?? null,
    observedAt: r.observed_at as Date,
    syncId: (r.sync_id as string) ?? null,
  };
}

/** Every checkpoint for a source, so a whole scan can be primed in one read. */
export async function loadCheckpoints(db: EvidenceDb, sourceType: string): Promise<Map<string, Checkpoint>> {
  const res = await db.query(
    `SELECT source_type, resource_key, etag, cursor_value, observed_at, sync_id
       FROM pc_sync_checkpoints WHERE source_type=$1`,
    [sourceType]
  );
  const out = new Map<string, Checkpoint>();
  for (const row of res.rows as Record<string, unknown>[]) {
    out.set(row.resource_key as string, {
      sourceType: row.source_type as string,
      resourceKey: row.resource_key as string,
      etag: (row.etag as string) ?? null,
      cursorValue: (row.cursor_value as string) ?? null,
      observedAt: row.observed_at as Date,
      syncId: (row.sync_id as string) ?? null,
    });
  }
  return out;
}

/**
 * Advance a checkpoint.
 *
 * CALL THIS ONLY AFTER THE EVIDENCE IT DESCRIBES IS STORED. A checkpoint that runs ahead of the
 * snapshots makes the next sync skip data nothing ever recorded — a hole that is silent, permanent
 * and invisible to every later read.
 */
export async function storeCheckpoint(
  db: EvidenceDb,
  input: { sourceType: string; resourceKey: string; etag?: string | null; cursorValue?: string | null; syncId?: string | null }
): Promise<void> {
  await db.query(
    `INSERT INTO pc_sync_checkpoints (source_type, resource_key, etag, cursor_value, observed_at, sync_id)
     VALUES ($1,$2,$3,$4,now(),$5)
     ON CONFLICT (source_type, resource_key) DO UPDATE
       SET etag=EXCLUDED.etag, cursor_value=EXCLUDED.cursor_value,
           observed_at=now(), sync_id=EXCLUDED.sync_id`,
    [input.sourceType, input.resourceKey, input.etag ?? null, input.cursorValue ?? null, input.syncId ?? null]
  );
}

/* ── Snapshots ────────────────────────────────────────────────────────────────────────────── */

/** Insert an observation. There is no update and no delete — by design, not by omission. */
export async function insertSnapshot(db: EvidenceDb, input: SnapshotInput): Promise<string> {
  const { value, digest } = redactPayload(input.payload);
  const res = await db.query(
    `INSERT INTO pc_evidence_snapshots
       (source_type, environment, entity_type, entity_id, commit_sha, status, freshness, confidence,
        valid_until, payload, payload_digest, sync_id, stale_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
     RETURNING id`,
    [
      input.sourceType,
      input.environment ?? null,
      input.entityType,
      input.entityId,
      input.commitSha ?? null,
      input.status ?? null,
      input.freshness ?? "CURRENT",
      input.confidence ?? "machine",
      input.validUntil ?? null,
      JSON.stringify(value),
      digest,
      input.syncId ?? null,
      input.staleReason ?? null,
    ]
  );
  return String((res.rows[0] as { id: unknown }).id);
}

function toSnapshot(row: Record<string, unknown>): StoredSnapshot {
  return {
    id: String(row.id),
    sourceType: row.source_type as string,
    environment: (row.environment as string) ?? null,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    commitSha: (row.commit_sha as string) ?? null,
    status: (row.status as string) ?? null,
    freshness: row.freshness as Freshness,
    confidence: row.confidence as string,
    validUntil: (row.valid_until as Date) ?? null,
    payload: row.payload,
    payloadDigest: row.payload_digest as string,
    observedAt: row.observed_at as Date,
    syncId: (row.sync_id as string) ?? null,
    staleReason: (row.stale_reason as string) ?? null,
  };
}

/** The most recent observation, whatever it says — including a failure. Use for "what happened?". */
export async function getLatestSnapshot(
  db: EvidenceDb,
  key: { sourceType: string; environment?: string | null; entityType: string; entityId: string }
): Promise<StoredSnapshot | null> {
  const res = await db.query(
    `SELECT * FROM pc_evidence_snapshots
      WHERE source_type=$1 AND environment IS NOT DISTINCT FROM $2 AND entity_type=$3 AND entity_id=$4
      ORDER BY observed_at DESC, id DESC LIMIT 1`,
    [key.sourceType, key.environment ?? null, key.entityType, key.entityId]
  );
  return res.rows.length ? toSnapshot(res.rows[0] as Record<string, unknown>) : null;
}

/**
 * The most recent USABLE observation — the answer to "what do we know?".
 *
 * This is the read that makes an outage survivable. After a failed sync the latest ROW says
 * UNAVAILABLE; this returns the last CURRENT/STALE observation instead, so the dashboard keeps
 * showing the last known truth with an honest freshness label rather than blanking.
 */
export async function getLatestGoodSnapshot(
  db: EvidenceDb,
  key: { sourceType: string; environment?: string | null; entityType: string; entityId: string }
): Promise<StoredSnapshot | null> {
  const res = await db.query(
    `SELECT * FROM pc_evidence_snapshots
      WHERE source_type=$1 AND environment IS NOT DISTINCT FROM $2 AND entity_type=$3 AND entity_id=$4
        AND freshness = ANY($5::text[])
      ORDER BY observed_at DESC, id DESC LIMIT 1`,
    [key.sourceType, key.environment ?? null, key.entityType, key.entityId, USABLE_FRESHNESS as unknown as string[]]
  );
  return res.rows.length ? toSnapshot(res.rows[0] as Record<string, unknown>) : null;
}

/** Bounded history for one entity, newest first. */
export async function listSnapshotHistory(
  db: EvidenceDb,
  key: { sourceType: string; environment?: string | null; entityType: string; entityId: string },
  limit = 50
): Promise<StoredSnapshot[]> {
  const bounded = Math.min(Math.max(1, limit), 200);
  const res = await db.query(
    `SELECT * FROM pc_evidence_snapshots
      WHERE source_type=$1 AND environment IS NOT DISTINCT FROM $2 AND entity_type=$3 AND entity_id=$4
      ORDER BY observed_at DESC, id DESC LIMIT $5`,
    [key.sourceType, key.environment ?? null, key.entityType, key.entityId, bounded]
  );
  return (res.rows as Record<string, unknown>[]).map(toSnapshot);
}

/**
 * Latest usable observation per entity for a source — the overview's bulk read.
 *
 * DISTINCT ON keeps this one indexed query rather than one per entity, which matters because the
 * overview renders on an ordinary page load and must not fan out.
 */
export async function getLatestGoodByEntity(
  db: EvidenceDb,
  sourceType: string,
  entityType: string,
  environment?: string | null
): Promise<StoredSnapshot[]> {
  const res = await db.query(
    `SELECT DISTINCT ON (entity_id) *
       FROM pc_evidence_snapshots
      WHERE source_type=$1 AND entity_type=$2 AND environment IS NOT DISTINCT FROM $3
        AND freshness = ANY($4::text[])
      ORDER BY entity_id, observed_at DESC, id DESC`,
    [sourceType, entityType, environment ?? null, USABLE_FRESHNESS as unknown as string[]]
  );
  return (res.rows as Record<string, unknown>[]).map(toSnapshot);
}
