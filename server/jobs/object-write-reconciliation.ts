import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db";
import {
  ObjectWriteAbandonError,
  canonicalJson,
  createPoolTransactionRunner,
  type ObjectInspection,
  type ObjectStorePort,
  type ObjectWriteFinalizeContext,
  type ObjectWriteItemRecord,
  type ObjectWriteTransactionRunner,
} from "../lib/object-write-coordinator";
import {
  resolveObjectWriteFinalizer,
  type RegisteredObjectWriteFinalizer,
} from "../lib/object-write-finalizer-registry";
import { isShuttingDown, runTrackedJob, trackInterval } from "../lib/lifecycle";
import { objectWriteStore } from "../lib/object-write-store";
import {
  __resetObjectWriteRuntimeForTests as resetObjectWriteRuntimeState,
  markObjectWriteRuntimeInstalled,
  objectWriteReconcilerInstalled,
  objectWriteRuntimeInstalled,
} from "../lib/object-write-runtime-state";

interface OperationRow {
  id: string;
  tenant_id: string | null;
  operation_kind: string;
  aggregate_type: string;
  aggregate_id: string | null;
  actor_id: string | null;
  state: "UPLOADING" | "VERIFIED";
  expected_state: Record<string, unknown>;
  intent_payload: Record<string, unknown>;
}

interface ItemRow {
  id: string;
  operation_id: string;
  store: "R2" | "B2";
  logical_slot: string;
  object_key: string;
  prior_object_key: string | null;
  content_sha256: string;
  byte_length: string | number;
  content_type: string;
  object_class: ObjectWriteItemRecord["objectClass"];
  retention_days: number | null;
  minimum_retain_until: Date | string | null;
  missing_observed_at: Date | string | null;
  observed_version_id: string | null;
  required: boolean;
  verification_state: ObjectWriteItemRecord["verificationState"];
  write_disposition: ObjectWriteItemRecord["writeDisposition"];
}

export interface ObjectWriteClaim {
  operation: OperationRow;
  items: ObjectWriteItemRecord[];
  leaseToken: string;
}

export interface ObjectWriteReconciliationDependencies {
  runner: ObjectWriteTransactionRunner;
  stores: ObjectStorePort;
  resolveFinalizer: (operationKind: string) => RegisteredObjectWriteFinalizer | null;
  workerId: string;
  leaseMs: number;
  missingGraceMs: number;
}

const defaultDependencies = (): ObjectWriteReconciliationDependencies => ({
  runner: createPoolTransactionRunner(pool),
  stores: objectWriteStore,
  resolveFinalizer: resolveObjectWriteFinalizer,
  workerId: `object-reconciler:${process.pid}`,
  leaseMs: 120_000,
  missingGraceMs: 300_000,
});

function mapItem(row: ItemRow): ObjectWriteItemRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    store: row.store,
    logicalSlot: row.logical_slot,
    objectKey: row.object_key,
    priorObjectKey: row.prior_object_key,
    contentSha256: row.content_sha256,
    byteLength: Number(row.byte_length),
    contentType: row.content_type,
    objectClass: row.object_class,
    retentionDays: row.retention_days,
    minimumRetainUntil: row.minimum_retain_until ? new Date(row.minimum_retain_until) : null,
    missingObservedAt: row.missing_observed_at ? new Date(row.missing_observed_at) : null,
    observedVersionId: row.observed_version_id,
    required: row.required,
    verificationState: row.verification_state,
    writeDisposition: row.write_disposition,
  };
}

function matches(item: ObjectWriteItemRecord, inspection: ObjectInspection): boolean {
  if (!inspection.exists || inspection.sha256 !== item.contentSha256 || inspection.byteLength !== item.byteLength) {
    return false;
  }
  if (item.store === "R2") return true;
  if (
    !inspection.versionId ||
    inspection.objectLockMode !== "COMPLIANCE" ||
    !inspection.objectLockRetainUntil ||
    !item.minimumRetainUntil
  ) {
    return false;
  }
  return inspection.objectLockRetainUntil.getTime() >= item.minimumRetainUntil.getTime();
}

async function readItems(client: PoolClient, operationId: string): Promise<ObjectWriteItemRecord[]> {
  const result = await client.query<ItemRow>(
    `SELECT id::text,operation_id::text,store,logical_slot,object_key,prior_object_key,
            content_sha256,byte_length,content_type,object_class,retention_days,minimum_retain_until,
            missing_observed_at,observed_version_id,required,
            verification_state,write_disposition
       FROM object_write_items WHERE operation_id=$1 ORDER BY store,logical_slot,id`,
    [operationId]
  );
  return result.rows.map(mapItem);
}

export async function claimDueObjectWrite(
  deps: ObjectWriteReconciliationDependencies = defaultDependencies()
): Promise<ObjectWriteClaim | null> {
  const leaseToken = randomUUID();
  return deps.runner.transaction(async (client) => {
    const result = await client.query<OperationRow>(
      `WITH candidate AS (
         SELECT id FROM object_write_operations
          WHERE state IN ('PREPARED','UPLOADING','VERIFIED','RECONCILIATION_REQUIRED')
            AND next_attempt_at <= now()
            AND (lease_token IS NULL OR lease_expires_at <= now())
          ORDER BY next_attempt_at,created_at,id
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE object_write_operations operation
          SET state=CASE
                WHEN operation.state='VERIFIED' THEN 'VERIFIED'
                WHEN operation.state='RECONCILIATION_REQUIRED'
                     AND NOT EXISTS (
                       SELECT 1 FROM object_write_items item
                        WHERE item.operation_id=operation.id AND item.required
                          AND item.verification_state <> 'VERIFIED'
                     ) THEN 'VERIFIED'
                ELSE 'UPLOADING'
              END,
              lease_owner=$1,lease_token=$2,
              lease_expires_at=now()+($3::bigint*interval '1 millisecond'),
              attempt_count=attempt_count+1
         FROM candidate WHERE operation.id=candidate.id
       RETURNING operation.id::text,operation.tenant_id::text,operation.operation_kind,
                 operation.aggregate_type,operation.aggregate_id,operation.actor_id,operation.state,
                 operation.expected_state,operation.intent_payload`,
      [deps.workerId.slice(0, 200), leaseToken, deps.leaseMs]
    );
    const operation = result.rows[0];
    return operation ? { operation, items: await readItems(client, operation.id), leaseToken } : null;
  });
}

async function releaseForRetry(
  deps: ObjectWriteReconciliationDependencies,
  claim: ObjectWriteClaim,
  code: string,
  detail: string,
  delaySeconds = 300
): Promise<void> {
  await deps.runner.transaction(async (client) => {
    await client.query(
      `UPDATE object_write_operations
          SET state='RECONCILIATION_REQUIRED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
              next_attempt_at=now()+($3::integer*interval '1 second'),
              last_error_code=$4,last_error_detail=$5
        WHERE id=$1 AND lease_token=$2`,
      [claim.operation.id, claim.leaseToken, delaySeconds, code, detail.slice(0, 500)]
    );
  });
}

async function renewLease(
  deps: ObjectWriteReconciliationDependencies,
  claim: ObjectWriteClaim
): Promise<void> {
  await deps.runner.transaction(async (client) => {
    const renewed = await client.query(
      `UPDATE object_write_operations
          SET lease_expires_at=now()+($3::bigint*interval '1 millisecond')
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at > now()
          AND state IN ('UPLOADING','VERIFIED','RECONCILIATION_REQUIRED')
        RETURNING id`,
      [claim.operation.id, claim.leaseToken, deps.leaseMs]
    );
    if (renewed.rows.length !== 1) throw new Error("Object-write reconciliation lease expired or was lost");
  });
}

async function observeMissingOrAbandon(
  deps: ObjectWriteReconciliationDependencies,
  claim: ObjectWriteClaim,
  missingItems: ObjectWriteItemRecord[],
  handler: RegisteredObjectWriteFinalizer
): Promise<"ABANDONED" | "RETRY"> {
  const graceElapsed = await deps.runner.transaction(async (client) => {
    const locked = await client.query(
      `SELECT id FROM object_write_operations
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at > now()
        FOR UPDATE`,
      [claim.operation.id, claim.leaseToken]
    );
    if (locked.rows.length !== 1) throw new Error("Object-write lease was lost before missing-byte observation");
    const observed = await client.query<{ id: string; missing_observed_at: Date | string }>(
      `UPDATE object_write_items
          SET missing_observed_at=COALESCE(missing_observed_at,now()),
              last_error_detail='Required object bytes were not observed; abandonment grace is active.'
        WHERE operation_id=$1 AND id=ANY($2::uuid[])
        RETURNING id::text,missing_observed_at`,
      [claim.operation.id, missingItems.map((item) => item.id)]
    );
    const cutoff = Date.now() - deps.missingGraceMs;
    const graceElapsed =
      observed.rows.length === missingItems.length &&
      observed.rows.every((row) => new Date(row.missing_observed_at).getTime() <= cutoff);
    if (!graceElapsed) {
      await client.query(
        `UPDATE object_write_operations
            SET state='RECONCILIATION_REQUIRED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                next_attempt_at=now()+interval '30 seconds',last_error_code='OBJECT_MISSING_GRACE',
                last_error_detail=$3
          WHERE id=$1 AND lease_token=$2`,
        [
          claim.operation.id,
          claim.leaseToken,
          `Required object bytes are temporarily absent: ${missingItems.map((item) => item.logicalSlot).join(",")}`.slice(
            0,
            500
          ),
        ]
      );
      return false;
    }
    return true;
  });
  if (!graceElapsed) return "RETRY";
  await abandonClaim(
    claim,
    handler,
    "OBJECT_MISSING",
    `Required object bytes are absent after the reconciliation grace period: ${missingItems
      .map((item) => item.logicalSlot)
      .join(",")}`
  );
  return "ABANDONED";
}

function claimContext(claim: ObjectWriteClaim): ObjectWriteFinalizeContext {
  return {
    operationId: claim.operation.id,
    tenantId: claim.operation.tenant_id,
    operationKind: claim.operation.operation_kind,
    aggregateType: claim.operation.aggregate_type,
    aggregateId: claim.operation.aggregate_id,
    actorId: claim.operation.actor_id,
    expectedState: claim.operation.expected_state,
    intentPayload: claim.operation.intent_payload,
    items: claim.items,
  };
}

async function abandonClaim(
  claim: ObjectWriteClaim,
  handler: RegisteredObjectWriteFinalizer,
  code: string,
  detail: string
): Promise<void> {
  const context = claimContext(claim);
  await handler.transactionRunner(context).transaction(async (client) => {
    const locked = await client.query(
      `SELECT id FROM object_write_operations
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at > now()
          AND state IN ('UPLOADING','VERIFIED','RECONCILIATION_REQUIRED')
        FOR UPDATE`,
      [claim.operation.id, claim.leaseToken]
    );
    if (locked.rowCount !== 1) throw new Error("Object-write lease was lost before abandonment");
    if (handler.abandon) await handler.abandon(client, context, { code, detail: detail.slice(0, 500) });
    const abandoned = await client.query(
      `UPDATE object_write_operations
          SET state='ABANDONED',last_error_code=$3,
              last_error_detail=$4,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE id=$1 AND lease_token=$2 RETURNING id`,
      [
        claim.operation.id,
        claim.leaseToken,
        code,
        detail.slice(0, 500),
      ]
    );
    if (abandoned.rows.length !== 1) throw new Error("Object-write lease was lost before abandonment");
    await client.query(
      `UPDATE object_write_items
          SET cleanup_state='PENDING',delete_after=now()+interval '1 hour'
        WHERE operation_id=$1 AND store='R2' AND write_disposition='CREATED'
          AND cleanup_state='NONE'`,
      [claim.operation.id]
    );
  });
}

async function finalizeClaim(claim: ObjectWriteClaim, handler: RegisteredObjectWriteFinalizer): Promise<void> {
  const context = claimContext(claim);
  await handler.transactionRunner(context).transaction(async (client) => {
    const locked = await client.query(
      `SELECT id FROM object_write_operations
        WHERE id=$1 AND lease_token=$2 AND state='VERIFIED' FOR UPDATE`,
      [claim.operation.id, claim.leaseToken]
    );
    if (locked.rows.length !== 1) throw new Error("Object-write verified lease was lost before finalization");
    const result = await handler.finalize(client, context);
    canonicalJson(result);
    const committed = await client.query(
      `UPDATE object_write_operations SET state='COMMITTED',result_payload=$3::jsonb
        WHERE id=$1 AND lease_token=$2 AND state='VERIFIED' RETURNING id`,
      [claim.operation.id, claim.leaseToken, canonicalJson(result)]
    );
    if (committed.rows.length !== 1) throw new Error("Object-write commit lost its lease");
  });
}

export async function reconcileObjectWriteClaim(
  claim: ObjectWriteClaim,
  deps: ObjectWriteReconciliationDependencies = defaultDependencies()
): Promise<"COMMITTED" | "ABANDONED" | "RETRY" | "MANUAL"> {
  const handler = deps.resolveFinalizer(claim.operation.operation_kind);
  if (!handler) {
    await releaseForRetry(
      deps,
      claim,
      "FINALIZER_NOT_REGISTERED",
      "The deployed process has no finalizer for this object-write operation.",
      3600
    );
    return "MANUAL";
  }
  const missing: ObjectWriteItemRecord[] = [];
  for (const item of claim.items) {
    let inspection: ObjectInspection;
    try {
      await renewLease(deps, claim);
      inspection = await deps.stores.inspect(item.store, item.objectKey);
      await renewLease(deps, claim);
    } catch {
      await releaseForRetry(
        deps,
        claim,
        "OBJECT_STORE_UNAVAILABLE",
        "Stored bytes could not be inspected; no publication decision was made."
      );
      return "RETRY";
    }
    if (!inspection.exists) {
      if (item.required) missing.push(item);
      continue;
    }
    if (!matches(item, inspection)) {
      await deps.runner.transaction(async (client) => {
        const updated = await client.query(
          `UPDATE object_write_items item
              SET verification_state=CASE WHEN verification_state='VERIFIED' THEN 'VERIFIED' ELSE 'QUARANTINED' END,
                  write_disposition=CASE WHEN write_disposition='PENDING' THEN 'AMBIGUOUS' ELSE write_disposition END,
                  last_error_detail='Stored bytes or retention do not match the immutable manifest.'
             FROM object_write_operations operation
            WHERE item.id=$1 AND item.operation_id=operation.id
              AND operation.id=$2 AND operation.lease_token=$3
            RETURNING item.id`,
          [item.id, claim.operation.id, claim.leaseToken]
        );
        if (updated.rows.length !== 1) throw new Error("Object-write lease was lost during quarantine");
      });
      await releaseForRetry(
        deps,
        claim,
        "OBJECT_INTEGRITY_MISMATCH",
        "Stored bytes or retention do not match the immutable manifest.",
        3600
      );
      return "MANUAL";
    }
    await deps.runner.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE object_write_items item
            SET write_disposition=CASE WHEN write_disposition='PENDING' THEN 'AMBIGUOUS' ELSE write_disposition END,
                verification_state='VERIFIED',observed_sha256=$2,observed_byte_length=$3,
                object_lock_mode=$4,object_lock_retain_until=$5,observed_version_id=$6,
                missing_observed_at=NULL,last_error_detail=NULL
           FROM object_write_operations operation
          WHERE item.id=$1 AND item.operation_id=operation.id
            AND operation.id=$7 AND operation.lease_token=$8
          RETURNING item.id`,
        [
          item.id,
          inspection.sha256,
          inspection.byteLength,
          inspection.objectLockMode ?? null,
          inspection.objectLockRetainUntil ?? null,
          inspection.versionId ?? null,
          claim.operation.id,
          claim.leaseToken,
        ]
      );
      if (updated.rows.length !== 1) throw new Error("Object-write lease was lost during verification");
    });
    item.verificationState = "VERIFIED";
    if (item.writeDisposition === "PENDING") item.writeDisposition = "AMBIGUOUS";
  }

  if (missing.length) {
    return observeMissingOrAbandon(deps, claim, missing, handler);
  }
  if (claim.items.every((item) => !item.required || item.verificationState === "VERIFIED")) {
    await deps.runner.transaction(async (client) => {
      await client.query(
        `UPDATE object_write_operations SET state='VERIFIED'
          WHERE id=$1 AND lease_token=$2 AND state IN ('UPLOADING','RECONCILIATION_REQUIRED','VERIFIED')`,
        [claim.operation.id, claim.leaseToken]
      );
    });
    claim.operation.state = "VERIFIED";
  }
  try {
    await renewLease(deps, claim);
    await finalizeClaim(claim, handler);
    return "COMMITTED";
  } catch (error) {
    if (error instanceof ObjectWriteAbandonError) {
      await abandonClaim(claim, handler, error.code, error.message);
      return "ABANDONED";
    }
    await releaseForRetry(deps, claim, "FINALIZER_FAILED", "The atomic business finalizer failed and was rolled back.");
    return "RETRY";
  }
}

export async function runObjectWriteReconciliationPass(
  deps: ObjectWriteReconciliationDependencies = defaultDependencies(),
  limit = 20
): Promise<{ examined: number; committed: number; abandoned: number; retry: number; manual: number }> {
  const result = { examined: 0, committed: 0, abandoned: 0, retry: 0, manual: 0 };
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  for (let index = 0; index < bounded; index += 1) {
    const claim = await claimDueObjectWrite(deps);
    if (!claim) break;
    result.examined += 1;
    const outcome = await reconcileObjectWriteClaim(claim, deps);
    if (outcome === "COMMITTED") result.committed += 1;
    else if (outcome === "ABANDONED") result.abandoned += 1;
    else if (outcome === "RETRY") result.retry += 1;
    else result.manual += 1;
  }
  return result;
}

export async function runObjectWriteCleanupPass(
  deps: ObjectWriteReconciliationDependencies = defaultDependencies(),
  limit = 20
): Promise<{ examined: number; cleaned: number; failed: number }> {
  const result = { examined: 0, cleaned: 0, failed: 0 };
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  for (let index = 0; index < bounded; index += 1) {
    const claimed = await deps.runner.transaction(async (client) => {
      const found = await client.query<{ id: string; object_key: string }>(
        `WITH candidate AS (
           SELECT item.id FROM object_write_items item
           JOIN object_write_operations operation ON operation.id=item.operation_id
          WHERE operation.state='ABANDONED' AND item.store='R2'
            AND item.write_disposition='CREATED' AND item.cleanup_state='PENDING'
            AND item.delete_after <= now()
            AND (item.cleanup_claimed_at IS NULL OR item.cleanup_claimed_at < now()-interval '15 minutes')
          ORDER BY item.delete_after,item.id FOR UPDATE OF item SKIP LOCKED LIMIT 1
         )
         UPDATE object_write_items item SET cleanup_claimed_at=now(),cleanup_attempt_count=cleanup_attempt_count+1
           FROM candidate WHERE item.id=candidate.id
         RETURNING item.id::text,item.object_key`,
        []
      );
      return found.rows[0] ?? null;
    });
    if (!claimed) break;
    result.examined += 1;
    try {
      await deps.stores.deleteR2(claimed.object_key);
      await deps.runner.transaction(async (client) => {
        await client.query(
          `UPDATE object_write_items SET cleanup_state='CLEANED',cleanup_claimed_at=NULL,last_error_detail=NULL
            WHERE id=$1 AND cleanup_state='PENDING'`,
          [claimed.id]
        );
      });
      result.cleaned += 1;
    } catch {
      await deps.runner.transaction(async (client) => {
        await client.query(
          `UPDATE object_write_items SET cleanup_claimed_at=NULL,
                  last_error_detail='R2 cleanup failed and will be retried.'
            WHERE id=$1 AND cleanup_state='PENDING'`,
          [claimed.id]
        );
      });
      result.failed += 1;
    }
  }
  return result;
}

export { objectWriteRuntimeInstalled };

export function installObjectWriteReconciler(
  deps: ObjectWriteReconciliationDependencies = defaultDependencies(),
  intervalMs = 60_000
): void {
  if (objectWriteReconcilerInstalled()) return;
  markObjectWriteRuntimeInstalled();
  const tick = () => {
    if (isShuttingDown()) return;
    void runTrackedJob(async () => {
      await runObjectWriteReconciliationPass(deps);
      await runObjectWriteCleanupPass(deps);
    }).catch(() => {
      // Never let a provider/database fault escape an interval callback as an
      // unhandled rejection. Durable leases expire and the next tick retries.
      console.error("[object-write-reconciliation] pass failed; durable work remains queued for retry");
    });
  };
  tick();
  trackInterval(tick, intervalMs, { unref: true });
}

export function __resetObjectWriteRuntimeForTests(): void {
  resetObjectWriteRuntimeState();
}
