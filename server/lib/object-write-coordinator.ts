import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export type ObjectStoreName = "R2" | "B2";
export type ObjectClass = "CANONICAL" | "DERIVATIVE" | "STAGING" | "PRINT" | "CACHE" | "EPHEMERAL" | "ARCHIVE";

export type ObjectInspection =
  | { exists: false }
  | {
      exists: true;
      byteLength: number;
      sha256: string;
      contentType?: string;
      versionId?: string;
      objectLockMode?: string;
      objectLockRetainUntil?: Date;
    };

export interface ObjectStorePort {
  inspect(store: ObjectStoreName, objectKey: string): Promise<ObjectInspection>;
  putCreateOnly(input: {
    store: ObjectStoreName;
    objectKey: string;
    body: Buffer;
    contentType: string;
    sha256: string;
    minimumRetainUntil?: Date;
  }): Promise<void>;
  deleteR2(objectKey: string): Promise<void>;
}

export interface ObjectWriteTransactionRunner {
  transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
}

export interface ObjectWriteItemInput {
  store: ObjectStoreName;
  logicalSlot: string;
  objectKey: string;
  body: Buffer;
  contentType: string;
  objectClass: ObjectClass;
  priorObjectKey?: string | null;
  required?: boolean;
  retentionDays?: number;
}

export interface ObjectWriteInput {
  tenantId?: string | null;
  idempotencyKey: string;
  operationKind: string;
  aggregateType: string;
  aggregateId?: string | null;
  actorId?: string | null;
  expectedState?: Record<string, unknown>;
  intentPayload?: Record<string, unknown>;
  items: ObjectWriteItemInput[];
}

export interface ObjectWriteItemRecord {
  id: string;
  operationId: string;
  store: ObjectStoreName;
  logicalSlot: string;
  objectKey: string;
  priorObjectKey: string | null;
  contentSha256: string;
  byteLength: number;
  contentType: string;
  objectClass: ObjectClass;
  retentionDays: number | null;
  minimumRetainUntil: Date | null;
  missingObservedAt: Date | null;
  observedVersionId: string | null;
  required: boolean;
  verificationState: "PENDING" | "VERIFIED" | "QUARANTINED";
  writeDisposition: "PENDING" | "CREATED" | "ADOPTED" | "AMBIGUOUS";
}

export interface ObjectWriteFinalizeContext {
  operationId: string;
  tenantId: string | null;
  operationKind: string;
  aggregateType: string;
  aggregateId: string | null;
  actorId: string | null;
  expectedState: Record<string, unknown>;
  intentPayload: Record<string, unknown>;
  items: ObjectWriteItemRecord[];
}

export type ObjectWriteFinalizer<TResult extends Record<string, unknown> = Record<string, unknown>> = (
  client: PoolClient,
  context: ObjectWriteFinalizeContext
) => Promise<TResult>;

export type ObjectWritePreparer = (client: PoolClient, operationId: string) => Promise<void>;
export type ObjectWriteAbandoner = (
  client: PoolClient,
  context: ObjectWriteFinalizeContext,
  reason: { code: string; detail: string }
) => Promise<void>;

export interface ObjectWriteExecutionResult<TResult extends Record<string, unknown>> {
  operationId: string;
  replayed: boolean;
  result: TResult;
}

export type OperationState = "PREPARED" | "UPLOADING" | "VERIFIED" | "COMMITTED" | "ABANDONED" | "RECONCILIATION_REQUIRED";

interface OperationRow {
  id: string;
  tenant_id: string | null;
  operation_kind: string;
  aggregate_type: string;
  aggregate_id: string | null;
  actor_id: string | null;
  state: OperationState;
  manifest_sha256: string;
  expected_state: Record<string, unknown>;
  intent_payload: Record<string, unknown>;
  result_payload: Record<string, unknown> | null;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
}

interface ItemRow {
  id: string;
  operation_id: string;
  store: ObjectStoreName;
  logical_slot: string;
  object_key: string;
  prior_object_key: string | null;
  content_sha256: string;
  byte_length: string | number;
  content_type: string;
  object_class: ObjectClass;
  retention_days: number | null;
  minimum_retain_until: Date | string | null;
  missing_observed_at: Date | string | null;
  observed_version_id: string | null;
  required: boolean;
  verification_state: ObjectWriteItemRecord["verificationState"];
  write_disposition: ObjectWriteItemRecord["writeDisposition"];
}

export interface ObjectWriteSnapshot {
  operationId: string;
  tenantId: string | null;
  idempotencyKey: string;
  operationKind: string;
  aggregateType: string;
  aggregateId: string | null;
  actorId: string | null;
  state: OperationState;
  expectedState: Record<string, unknown>;
  intentPayload: Record<string, unknown>;
  resultPayload: Record<string, unknown> | null;
  items: ObjectWriteItemRecord[];
}

const KIND_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;
const AGGREGATE_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isValidObjectKey(key: string): boolean {
  if (!key || key.length > 1024 || key.startsWith("/") || key.includes("\\")) return false;
  if (key.split("/").some((segment) => segment === "." || segment === "..")) return false;
  for (let index = 0; index < key.length; index += 1) {
    if (key.charCodeAt(index) <= 0x1f) return false;
  }
  return true;
}

export class ObjectWriteConflictError extends Error {
  readonly code = "OBJECT_WRITE_IDEMPOTENCY_CONFLICT";
}

export class ObjectWriteInProgressError extends Error {
  readonly code = "OBJECT_WRITE_IN_PROGRESS";
}

export class ObjectWriteTerminalError extends Error {
  readonly code = "OBJECT_WRITE_TERMINAL";
}

export class ObjectWriteIntegrityError extends Error {
  readonly code = "OBJECT_WRITE_INTEGRITY_MISMATCH";
}

/** A proven, non-retryable domain CAS failure. The coordinator rolls the
 * reservation back through the registered abandoner and terminalises intent. */
export class ObjectWriteAbandonError extends Error {
  readonly code = "OBJECT_WRITE_DOMAIN_ABANDONED";
}

function jsonValue(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`, seen));
  if (typeof value !== "object") throw new Error(`${path} is not JSON-serialisable`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain JSON object`);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) throw new Error(`${path}.${key} is undefined`);
    output[key] = jsonValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return output;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value, "value", new Set()));
}

export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function boundedText(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : text.slice(0, max);
}

function classifyFailure(error: unknown): { code: string; detail: string } {
  if (error instanceof ObjectWriteIntegrityError) {
    return { code: error.code, detail: "Stored bytes do not match the immutable manifest." };
  }
  if (error instanceof ObjectWriteAbandonError) {
    return { code: error.code, detail: boundedText(error.message, 500) };
  }
  if (error instanceof ObjectWriteConflictError || error instanceof ObjectWriteTerminalError) {
    return { code: error.code, detail: boundedText(error.message, 500) };
  }
  const shaped = error as { code?: unknown } | null;
  const sqlState = typeof shaped?.code === "string" && /^[0-9A-Z]{5}$/.test(shaped.code) ? shaped.code : null;
  return {
    code: sqlState ? `DATABASE_${sqlState}` : "OBJECT_WRITE_ATTEMPT_FAILED",
    detail: "The object write could not be proven complete and requires reconciliation.",
  };
}

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

function inspectionMatches(
  item: Pick<ObjectWriteItemRecord, "contentSha256" | "byteLength">,
  found: ObjectInspection
): boolean {
  return found.exists && found.sha256 === item.contentSha256 && found.byteLength === item.byteLength;
}

function inspectionMeetsStorePolicy(item: ObjectWriteItemRecord, found: ObjectInspection): boolean {
  if (!found.exists) return false;
  if (item.store === "R2") return true;
  if (
    !found.versionId ||
    found.objectLockMode !== "COMPLIANCE" ||
    !found.objectLockRetainUntil ||
    !item.minimumRetainUntil
  )
    return false;
  return found.objectLockRetainUntil.getTime() >= item.minimumRetainUntil.getTime();
}

function validateInput(input: ObjectWriteInput): void {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
    throw new Error("Invalid object-write idempotency key");
  if (!KIND_PATTERN.test(input.operationKind)) throw new Error("Invalid object-write operation kind");
  if (!AGGREGATE_PATTERN.test(input.aggregateType)) throw new Error("Invalid object-write aggregate type");
  if (!input.items.length) throw new Error("Object-write manifest must contain at least one item");
  const slots = new Set<string>();
  const keys = new Set<string>();
  for (const item of input.items) {
    if (!item.body.length) throw new Error(`Object-write item ${item.logicalSlot} is empty`);
    if (!item.logicalSlot.trim() || item.logicalSlot.length > 120) throw new Error("Invalid object-write logical slot");
    if (!isValidObjectKey(item.objectKey)) throw new Error(`Invalid object key for ${item.logicalSlot}`);
    if (!item.contentType.trim() || item.contentType.length > 200) throw new Error("Invalid object content type");
    const slotIdentity = `${item.store}:${item.logicalSlot}`;
    const keyIdentity = `${item.store}:${item.objectKey}`;
    if (slots.has(slotIdentity)) throw new Error(`Duplicate object-write logical slot ${slotIdentity}`);
    if (keys.has(keyIdentity)) throw new Error(`Duplicate object-write key ${keyIdentity}`);
    slots.add(slotIdentity);
    keys.add(keyIdentity);
    if (item.store === "B2" && (!item.retentionDays || item.retentionDays < 1)) {
      throw new Error(`B2 object ${item.logicalSlot} requires a positive retention period`);
    }
  }
  canonicalJson(input.expectedState ?? {});
  canonicalJson(input.intentPayload ?? {});
}

function buildManifest(input: ObjectWriteInput): {
  manifestSha256: string;
  items: Array<ObjectWriteItemInput & { sha256: string }>;
} {
  validateInput(input);
  // Manifest identity must not depend on caller/Map iteration order. Retries
  // rebuild from rows read in (store,logical_slot,id) order, so canonicalise
  // before hashing and inserting or a multi-item partially completed write can
  // conflict with its own durable intent.
  const items = input.items
    .map((item) => ({ ...item, sha256: sha256Hex(item.body) }))
    .sort((left, right) =>
      `${left.store}\0${left.logicalSlot}\0${left.objectKey}`.localeCompare(
        `${right.store}\0${right.logicalSlot}\0${right.objectKey}`
      )
    );
  const manifest = {
    tenantId: input.tenantId ?? null,
    operationKind: input.operationKind,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId ?? null,
    actorId: input.actorId ?? null,
    expectedState: input.expectedState ?? {},
    intentPayload: input.intentPayload ?? {},
    items: items.map((item) => ({
      store: item.store,
      logicalSlot: item.logicalSlot,
      objectKey: item.objectKey,
      priorObjectKey: item.priorObjectKey ?? null,
      sha256: item.sha256,
      byteLength: item.body.length,
      contentType: item.contentType,
      objectClass: item.objectClass,
      required: item.required ?? true,
      retentionDays: item.retentionDays ?? null,
    })),
  };
  return { items, manifestSha256: sha256Hex(canonicalJson(manifest)) };
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

/**
 * Loads the immutable manifest bound to an idempotency key. Callers use this
 * before domain preflight so a retry is rebuilt from the original snapshot,
 * rather than from domain state that the first successful attempt changed.
 */
export async function readObjectWriteSnapshot(
  client: PoolClient,
  tenantId: string | null,
  idempotencyKey: string
): Promise<ObjectWriteSnapshot | null> {
  const selected = await client.query<
    OperationRow & { idempotency_key: string }
  >(
    `SELECT id::text,tenant_id::text,idempotency_key,operation_kind,aggregate_type,
            aggregate_id,actor_id,state,manifest_sha256,expected_state,intent_payload,
            result_payload,lease_token,lease_expires_at
       FROM object_write_operations
      WHERE COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($1::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
        AND idempotency_key=$2`,
    [tenantId, idempotencyKey]
  );
  if (selected.rowCount === 0) return null;
  const operation = selected.rows[0];
  return {
    operationId: operation.id,
    tenantId: operation.tenant_id,
    idempotencyKey: operation.idempotency_key,
    operationKind: operation.operation_kind,
    aggregateType: operation.aggregate_type,
    aggregateId: operation.aggregate_id,
    actorId: operation.actor_id,
    state: operation.state,
    expectedState: operation.expected_state,
    intentPayload: operation.intent_payload,
    resultPayload: operation.result_payload,
    items: await readItems(client, operation.id),
  };
}

export class ObjectWriteCoordinator {
  constructor(
    private readonly runner: ObjectWriteTransactionRunner,
    private readonly stores: ObjectStorePort,
    private readonly workerId = `object-write:${process.pid}`,
    private readonly leaseMs = 120_000
  ) {}

  async execute<TResult extends Record<string, unknown>>(
    input: ObjectWriteInput,
    finalizer: ObjectWriteFinalizer<TResult>,
    preparer?: ObjectWritePreparer,
    abandoner?: ObjectWriteAbandoner
  ): Promise<ObjectWriteExecutionResult<TResult>> {
    const manifest = buildManifest(input);
    const operationId = randomUUID();
    const leaseToken = randomUUID();

    const claimed = await this.runner.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO object_write_operations
           (id,tenant_id,idempotency_key,operation_kind,aggregate_type,aggregate_id,actor_id,
            manifest_sha256,expected_state,intent_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
         ON CONFLICT DO NOTHING RETURNING id::text`,
        [
          operationId,
          input.tenantId ?? null,
          input.idempotencyKey,
          input.operationKind,
          input.aggregateType,
          input.aggregateId ?? null,
          input.actorId ?? null,
          manifest.manifestSha256,
          canonicalJson(input.expectedState ?? {}),
          canonicalJson(input.intentPayload ?? {}),
        ]
      );
      const created = inserted.rows.length === 1;
      if (created) {
        for (const item of manifest.items) {
          await client.query(
            `INSERT INTO object_write_items
               (operation_id,store,logical_slot,object_key,prior_object_key,content_sha256,
                byte_length,content_type,object_class,retention_days,minimum_retain_until,required)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              operationId,
              item.store,
              item.logicalSlot,
              item.objectKey,
              item.priorObjectKey ?? null,
              item.sha256,
              item.body.length,
              item.contentType,
              item.objectClass,
              item.retentionDays ?? null,
              item.retentionDays ? new Date(Date.now() + item.retentionDays * 86_400_000) : null,
              item.required ?? true,
            ]
          );
        }
      }

      const selected = await client.query<OperationRow>(
        `SELECT * FROM object_write_operations
          WHERE COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE($1::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
            AND idempotency_key=$2
          FOR UPDATE`,
        [input.tenantId ?? null, input.idempotencyKey]
      );
      const operation = selected.rows[0];
      if (!operation) throw new Error("Object-write operation disappeared during preparation");
      if (operation.manifest_sha256 !== manifest.manifestSha256) {
        throw new ObjectWriteConflictError("Idempotency key is already bound to a different immutable manifest");
      }
      if (operation.state === "COMMITTED") {
        if (!operation.result_payload) throw new Error("Committed object-write operation has no result");
        return { operation, replayed: true, items: await readItems(client, operation.id) };
      }
      if (operation.state === "ABANDONED") {
        throw new ObjectWriteTerminalError("Object-write operation was abandoned and cannot be replayed");
      }
      if (
        operation.lease_token &&
        operation.lease_expires_at &&
        new Date(operation.lease_expires_at).getTime() > Date.now()
      ) {
        throw new ObjectWriteInProgressError("Object-write operation is already being processed");
      }
      const existingItems = await readItems(client, operation.id);
      const allVerified = existingItems.every((item) => !item.required || item.verificationState === "VERIFIED");
      const targetState = operation.state === "VERIFIED" || allVerified ? "VERIFIED" : "UPLOADING";
      await client.query(
        `UPDATE object_write_operations
            SET state=$2,lease_owner=$3,lease_token=$4,
                lease_expires_at=now()+($5::bigint*interval '1 millisecond'),
                attempt_count=attempt_count+1,last_error_code=NULL,last_error_detail=NULL
          WHERE id=$1`,
        [operation.id, targetState, boundedText(this.workerId, 200), leaseToken, this.leaseMs]
      );
      operation.state = targetState;
      operation.lease_token = leaseToken;
      // Domain reservation belongs in the same commit as PREPARED and the
      // lease claim. It intentionally runs LAST: certificate issuance uses a
      // global counter whose increment and certificate INSERT must be the
      // final two statements before commit. If the preparer loses a CAS or
      // violates an invariant, the operation, manifest, lease and reservation
      // all roll back together.
      if (created && preparer) await preparer(client, operation.id);
      return { operation, replayed: false, items: existingItems };
    });

    if (claimed.replayed) {
      return {
        operationId: claimed.operation.id,
        replayed: true,
        result: claimed.operation.result_payload as TResult,
      };
    }

    try {
      const bodyByIdentity = new Map(
        manifest.items.map((item) => [`${item.store}:${item.logicalSlot}`, item] as const)
      );
      for (const item of claimed.items) {
        const source = bodyByIdentity.get(`${item.store}:${item.logicalSlot}`);
        if (!source || source.sha256 !== item.contentSha256 || source.body.length !== item.byteLength) {
          throw new ObjectWriteConflictError(`Runtime bytes do not match manifest slot ${item.logicalSlot}`);
        }
        await this.putAndVerify(claimed.operation.id, leaseToken, item, source);
      }
      await this.runner.transaction(async (client) => {
        const updated = await client.query(
          `UPDATE object_write_operations SET state='VERIFIED'
            WHERE id=$1 AND lease_token=$2 AND state IN ('UPLOADING','RECONCILIATION_REQUIRED','VERIFIED')
            RETURNING id`,
          [claimed.operation.id, leaseToken]
        );
        if (updated.rows.length !== 1)
          throw new ObjectWriteInProgressError("Object-write lease was lost before verification");
      });
      const result = await this.finalize(claimed.operation.id, leaseToken, finalizer);
      return { operationId: claimed.operation.id, replayed: false, result };
    } catch (error) {
      if (error instanceof ObjectWriteAbandonError) {
        await this.abandon(claimed.operation.id, leaseToken, error, abandoner);
        throw error;
      }
      await this.deferForReconciliation(claimed.operation.id, leaseToken, error);
      throw error;
    }
  }

  private async abandon(
    operationId: string,
    leaseToken: string,
    error: ObjectWriteAbandonError,
    abandoner?: ObjectWriteAbandoner
  ): Promise<void> {
    const failure = classifyFailure(error);
    await this.runner.transaction(async (client) => {
      const selected = await client.query<OperationRow>(
        `SELECT * FROM object_write_operations
          WHERE id=$1 AND lease_token=$2 AND state IN ('UPLOADING','VERIFIED','RECONCILIATION_REQUIRED')
          FOR UPDATE`,
        [operationId, leaseToken]
      );
      const operation = selected.rows[0];
      if (!operation) throw new ObjectWriteInProgressError("Object-write lease was lost before abandonment");
      const items = await readItems(client, operationId);
      const context: ObjectWriteFinalizeContext = {
        operationId,
        tenantId: operation.tenant_id,
        operationKind: operation.operation_kind,
        aggregateType: operation.aggregate_type,
        aggregateId: operation.aggregate_id,
        actorId: operation.actor_id,
        expectedState: operation.expected_state,
        intentPayload: operation.intent_payload,
        items,
      };
      if (abandoner) await abandoner(client, context, failure);
      const abandoned = await client.query(
        `UPDATE object_write_operations
            SET state='ABANDONED',last_error_code=$3,last_error_detail=$4,
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
          WHERE id=$1 AND lease_token=$2 RETURNING id`,
        [operationId, leaseToken, failure.code, failure.detail]
      );
      if (abandoned.rowCount !== 1) throw new ObjectWriteInProgressError("Object-write lease was lost before abandonment");
      await client.query(
        `UPDATE object_write_items
            SET cleanup_state='PENDING',delete_after=now()+interval '1 hour'
          WHERE operation_id=$1 AND store='R2' AND write_disposition='CREATED'
            AND cleanup_state='NONE'`,
        [operationId]
      );
    });
  }

  private async putAndVerify(
    operationId: string,
    leaseToken: string,
    item: ObjectWriteItemRecord,
    source: ObjectWriteItemInput & { sha256: string }
  ): Promise<void> {
    await this.renewLease(operationId, leaseToken);
    let inspection = await this.stores.inspect(item.store, item.objectKey);
    await this.renewLease(operationId, leaseToken);
    let disposition: ObjectWriteItemRecord["writeDisposition"] = item.writeDisposition;
    if (!inspection.exists) {
      try {
        await this.renewLease(operationId, leaseToken);
        await this.stores.putCreateOnly({
          store: item.store,
          objectKey: item.objectKey,
          body: source.body,
          contentType: item.contentType,
          sha256: item.contentSha256,
          minimumRetainUntil: item.minimumRetainUntil ?? undefined,
        });
        await this.renewLease(operationId, leaseToken);
        disposition = "CREATED";
      } catch (putError) {
        await this.renewLease(operationId, leaseToken);
        inspection = await this.stores.inspect(item.store, item.objectKey);
        await this.renewLease(operationId, leaseToken);
        if (!inspectionMatches(item, inspection)) {
          if (inspection.exists) await this.quarantine(operationId, leaseToken, item.id, "AMBIGUOUS");
          throw putError;
        }
        disposition = "AMBIGUOUS";
      }
      await this.renewLease(operationId, leaseToken);
      inspection = await this.stores.inspect(item.store, item.objectKey);
      await this.renewLease(operationId, leaseToken);
    } else if (disposition === "PENDING") {
      disposition = "ADOPTED";
    }

    if (!inspection.exists || !inspectionMatches(item, inspection) || !inspectionMeetsStorePolicy(item, inspection)) {
      await this.quarantine(operationId, leaseToken, item.id, disposition);
      throw new ObjectWriteIntegrityError(`Stored object failed immutable verification for ${item.logicalSlot}`);
    }
    const observed = inspection;
    if (!SHA256_PATTERN.test(observed.sha256)) throw new Error("Object store returned an invalid SHA-256 digest");
    await this.runner.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE object_write_items item
            SET write_disposition=CASE WHEN item.write_disposition='PENDING' THEN $4 ELSE item.write_disposition END,
                verification_state='VERIFIED',observed_sha256=$5,observed_byte_length=$6,
                object_lock_mode=$7,object_lock_retain_until=$8,observed_version_id=$9,
                missing_observed_at=NULL,last_error_detail=NULL
           FROM object_write_operations operation
          WHERE item.id=$1 AND item.operation_id=operation.id AND operation.id=$2
            AND operation.lease_token=$3
          RETURNING item.id`,
        [
          item.id,
          operationId,
          leaseToken,
          disposition,
          observed.sha256,
          observed.byteLength,
          observed.objectLockMode ?? null,
          observed.objectLockRetainUntil ?? null,
          observed.versionId ?? null,
        ]
      );
      if (updated.rows.length !== 1)
        throw new ObjectWriteInProgressError("Object-write lease was lost during verification");
    });
  }

  private async renewLease(operationId: string, leaseToken: string): Promise<void> {
    await this.runner.transaction(async (client) => {
      const renewed = await client.query(
        `UPDATE object_write_operations
            SET lease_expires_at=now()+($3::bigint*interval '1 millisecond')
          WHERE id=$1 AND lease_token=$2 AND lease_expires_at > now()
            AND state IN ('UPLOADING','VERIFIED','RECONCILIATION_REQUIRED')
          RETURNING id`,
        [operationId, leaseToken, this.leaseMs]
      );
      if (renewed.rows.length !== 1) {
        throw new ObjectWriteInProgressError("Object-write lease expired or was lost during provider I/O");
      }
    });
  }

  private async quarantine(
    operationId: string,
    leaseToken: string,
    itemId: string,
    disposition: ObjectWriteItemRecord["writeDisposition"]
  ): Promise<void> {
    await this.runner.transaction(async (client) => {
      await client.query(
        `UPDATE object_write_items item
            SET write_disposition=CASE WHEN item.write_disposition='PENDING' THEN $4 ELSE item.write_disposition END,
                verification_state=CASE WHEN item.verification_state='VERIFIED' THEN 'VERIFIED' ELSE 'QUARANTINED' END,
                last_error_detail='Stored bytes did not match the immutable object manifest.'
           FROM object_write_operations operation
          WHERE item.id=$1 AND item.operation_id=operation.id AND operation.id=$2
            AND operation.lease_token=$3`,
        [itemId, operationId, leaseToken, disposition]
      );
    });
  }

  private async finalize<TResult extends Record<string, unknown>>(
    operationId: string,
    leaseToken: string,
    finalizer: ObjectWriteFinalizer<TResult>
  ): Promise<TResult> {
    return this.runner.transaction(async (client) => {
      const selected = await client.query<OperationRow>(
        "SELECT * FROM object_write_operations WHERE id=$1 FOR UPDATE",
        [operationId]
      );
      const operation = selected.rows[0];
      if (!operation || operation.lease_token !== leaseToken || operation.state !== "VERIFIED") {
        throw new ObjectWriteInProgressError("Object-write lease or verified state was lost before finalization");
      }
      const items = await readItems(client, operationId);
      if (items.some((item) => item.required && item.verificationState !== "VERIFIED")) {
        throw new ObjectWriteIntegrityError("Required objects are not verified");
      }
      const context: ObjectWriteFinalizeContext = {
        operationId,
        tenantId: operation.tenant_id,
        operationKind: operation.operation_kind,
        aggregateType: operation.aggregate_type,
        aggregateId: operation.aggregate_id,
        actorId: operation.actor_id,
        expectedState: operation.expected_state,
        intentPayload: operation.intent_payload,
        items,
      };
      const result = await finalizer(client, context);
      canonicalJson(result);
      const committed = await client.query(
        `UPDATE object_write_operations
            SET state='COMMITTED',result_payload=$3::jsonb
          WHERE id=$1 AND lease_token=$2 AND state='VERIFIED'
          RETURNING id`,
        [operationId, leaseToken, canonicalJson(result)]
      );
      if (committed.rows.length !== 1) throw new ObjectWriteInProgressError("Object-write commit lost its lease");
      return result;
    });
  }

  private async deferForReconciliation(operationId: string, leaseToken: string, error: unknown): Promise<void> {
    const failure = classifyFailure(error);
    await this.runner
      .transaction(async (client) => {
        await client.query(
          `UPDATE object_write_operations
              SET state='RECONCILIATION_REQUIRED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                  next_attempt_at=now()+interval '30 seconds',last_error_code=$3,last_error_detail=$4
            WHERE id=$1 AND lease_token=$2
              AND state IN ('UPLOADING','VERIFIED','RECONCILIATION_REQUIRED')`,
          [operationId, leaseToken, failure.code, failure.detail]
        );
      })
      .catch(() => {
        // The durable PREPARED/UPLOADING/VERIFIED row remains claimable after
        // its lease expires even if the failure annotation itself cannot land.
      });
  }
}

export function createPoolTransactionRunner(pool: { connect(): Promise<PoolClient> }): ObjectWriteTransactionRunner {
  return {
    async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
