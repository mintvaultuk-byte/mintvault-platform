/**
 * certificate-image-persistence.ts — the durable half of
 * `POST /api/admin/certificates/:id/upload-images`.
 *
 * WHY THIS MODULE EXISTS (M-2, hostile review of PR #260)
 * That route is the one the real grading UI uploads through. It wrote
 * `front_image_path`, `back_image_path`, every `grading_*` capture column,
 * `image_quality_checks` and `crop_geometry` through a series of INDEPENDENT
 * auto-committing raw UPDATEs and wrote ZERO audit rows: a customer's card
 * images could be replaced with no record of who did it, and a failure partway
 * through left the row half-updated.
 *
 * The persistence step is separated from the image PIPELINE (deskew, crop,
 * mask, variants, quality) so it can be driven against a real PostgreSQL
 * cluster in tests without running sharp — the pipeline is untouched by this
 * change, and the transaction/audit/compensation behaviour is what needs proof.
 *
 * WHAT IS AND IS NOT ATOMIC — stated plainly, because the honest model matters:
 *   • Postgres side: the column UPDATE and its audit row commit in ONE
 *     transaction. Both or neither. An audit failure rolls the write back.
 *   • Object storage: R2 CANNOT join that transaction. Objects are written
 *     first, the database commits second. A database failure therefore triggers
 *     best-effort compensation, NOT a rollback.
 *   • An object whose key was already the committed value has already had its
 *     BYTES overwritten by the time we get here. No rollback can undo that.
 *     This module never deletes such an object (the last committed row still
 *     points at it) and reports the situation truthfully rather than claiming
 *     an atomicity that does not exist.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { deleteFromR2 } from "../r2";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ObjectWriteAbandonError,
  ObjectWriteCoordinator,
  createPoolTransactionRunner,
  type ObjectStorePort,
  type ObjectWriteFinalizeContext,
  type ObjectWriteItemRecord,
  type ObjectWriteTransactionRunner,
} from "./object-write-coordinator";
import { objectWriteStore } from "./object-write-store";

/**
 * The EXHAUSTIVE set of certificate columns this route may commit.
 *
 * Hard-coded and never derived from request input: these names are interpolated
 * as SQL IDENTIFIERS, so anything reaching that position must be a literal from
 * this list. A value outside it is a programming error, not user input.
 */
export const IMAGE_UPLOAD_OWNED_COLUMNS = [
  "grading_front_original",
  "grading_front_cropped",
  "grading_front_display",
  "grading_back_original",
  "grading_back_cropped",
  "grading_back_display",
  "grading_angled_original",
  "grading_angled_cropped",
  "grading_closeup_original",
  "grading_closeup_cropped",
  "front_image_path",
  "back_image_path",
  // Display variants generated after the response (greyscale / high-contrast /
  // edge-enhanced / inverted). Written by the same route's background pass, so
  // they go through the same allowlist + audit rather than a bare UPDATE.
  "grading_front_greyscale",
  "grading_front_highcontrast",
  "grading_front_edgeenhanced",
  "grading_front_inverted",
  "grading_back_greyscale",
  "grading_back_highcontrast",
  "grading_back_edgeenhanced",
  "grading_back_inverted",
  "image_quality_checks",
  "crop_geometry",
] as const;

export const IMAGE_UPLOAD_COLUMN_SET: ReadonlySet<string> = new Set(IMAGE_UPLOAD_OWNED_COLUMNS);
/** Columns holding JSON documents — need a ::jsonb cast and structural compare. */
export const IMAGE_UPLOAD_JSONB_COLUMNS: ReadonlySet<string> = new Set(["image_quality_checks", "crop_geometry"]);

/** The audit action every successful image upload writes. */
export const IMAGE_UPLOAD_AUDIT_ACTION = "certificate_images_uploaded";
/** Background variant pass — distinguished so it cannot be mistaken for the
 *  operator-facing upload event above. */
export const IMAGE_VARIANTS_AUDIT_ACTION = "certificate_image_variants_generated";

/**
 * M-3 (hostile review of PR #262) · the durable record of the ONE genuinely
 * unrecoverable outcome in this design.
 *
 * When an upload replaces the bytes at a key the last committed row still points
 * at and the transaction then fails, the previous bytes are gone: R2 is written
 * before the transaction and cannot be rolled back. Compensation correctly
 * REFUSES to delete such an object (the committed row still references it), so
 * the certificate keeps a valid pointer — but it now points at DIFFERENT content
 * than it did a moment ago, and nothing said so. The only evidence was a
 * console line, which is not evidence at all once the log rotates.
 *
 * Deliberately NOT written for ordinary recoverable orphan cleanup: an object
 * this request created and then deleted overwrote nothing and left the committed
 * state exactly as it was. Auditing that would train readers to ignore the event.
 */
export const IMAGE_UPLOAD_FAILURE_AUDIT_ACTION = "certificate_image_upload_failed";

/**
 * Column → Drizzle row property, for the columns shared/schema.ts actually
 * declares. Used only to decide whether an uploaded key was ALREADY the
 * committed value (compensation safety). A column absent here is treated as NOT
 * pre-existing, which fails SAFE for cleanup: `grading_*` capture keys are
 * per-certificate and are only ever written by this route, so deleting one after
 * a failed transaction cannot orphan a reference from the last committed row.
 * The two columns that the metadata route ALSO writes — front/back image path —
 * are both mapped, so a shared object is never mistaken for an orphan.
 */
export const COLUMN_TO_CERT_KEY: Record<string, string> = {
  front_image_path: "frontImagePath",
  back_image_path: "backImagePath",
};

export interface UploadedObject {
  key: string;
  column: string;
  sha256: string;
  bytes: number;
  contentType: string;
  /** True when this key was ALREADY the committed value for its column. */
  preexisting: boolean;
}

export interface ImageUploadPersistResult {
  committed: boolean;
  /** Columns whose stored value actually moved. Empty on a same-key replacement. */
  changedFields: string[];
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  /** Orphaned objects removed after a failed transaction. */
  orphansRemoved: string[];
  /** Orphans we tried and FAILED to remove — reported, never hidden. */
  orphanCleanupFailed: string[];
  /**
   * Objects whose bytes were overwritten in place and which we deliberately did
   * NOT delete during compensation, because the last committed row points at
   * them. Their previous CONTENT is unrecoverable — surfaced, not swallowed.
   */
  overwrittenCommittedObjects: string[];
  /**
   * M-1r · objects whose prior state could NOT be established, because the
   * FOR UPDATE read of the committed row never completed. Nothing is claimed
   * about them and none of them are ever deleted.
   */
  unknownPriorStateObjects: string[];
  /** M-1r · false when the prior committed row was never read. */
  priorStateVerified: boolean;
  /**
   * M-3 · true when an unrecoverable overwrite occurred AND its durable failure
   * audit row was written. False when there was nothing to record, or when the
   * failure audit itself could not be written — which never masks the original
   * failure, it only means this one record is missing too.
   */
  failureAuditRecorded: boolean;
}

/** Derive the card side/angle a column belongs to, for the failure record. */
function sideOfColumn(column: string): string {
  const m = /^grading_(front|back|angled|closeup)_/.exec(column);
  if (m) return m[1];
  if (column === "front_image_path") return "front";
  if (column === "back_image_path") return "back";
  return "other";
}

/**
 * M-3 · classify the failure WITHOUT leaking a raw message or stack.
 *
 * A SQLSTATE and a coarse category are enough to triage; an error message can
 * carry row contents, and a stack carries file paths. Neither belongs in an
 * audit row a customer-facing trail is read from.
 */
function classifyPersistFailure(err: unknown): { category: string; sqlState?: string } {
  const e = err as { code?: unknown; message?: unknown } | null;
  const sqlState = typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined;
  const message = typeof e?.message === "string" ? e.message : "";
  if (message.includes("not found")) return { category: "certificate_row_missing", sqlState };
  if (sqlState) return { category: "database_error", sqlState };
  return { category: "unknown_persistence_failure" };
}

const normVal = (v: unknown): string | null =>
  v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);

export interface AtomicImageUploadPersistArgs {
  id: number;
  certId: string;
  updates: Record<string, string>;
  expectedState: Record<string, unknown>;
  items: ObjectWriteItemRecord[];
  actor: string;
  action?: string;
  auditMetadata?: Record<string, unknown>;
  imageHistory?: Array<{
    side: "front" | "back";
    objectKey: string;
    sortOrder: number;
  }>;
  evidenceUpdates?: Array<{
    side: "front" | "back";
    expectedSourceSha256: string;
    workingObjectKey: string;
    workingSha256: string;
    workingWidth: number;
    workingHeight: number;
    workingFormat: string;
    workingSettings: Record<string, unknown>;
  }>;
}

/**
 * Finalizer used by the durable object-write coordinator. The certificate
 * pointer mutation, content audit and operation COMMITTED transition all use
 * the same PoolClient transaction; this function must never open or commit one.
 */
export async function persistImageUploadAuditedTx(
  client: PoolClient,
  args: AtomicImageUploadPersistArgs
): Promise<Record<string, unknown>> {
  const committed = Object.entries(args.updates).filter(([column]) => IMAGE_UPLOAD_COLUMN_SET.has(column));
  if (committed.length !== Object.keys(args.updates).length || committed.length === 0) {
    throw new Error("Atomic image finalizer received an empty or non-allowlisted update set");
  }
  for (const column of Object.keys(args.expectedState)) {
    if (!IMAGE_UPLOAD_COLUMN_SET.has(column)) throw new Error(`Atomic image finalizer cannot guard ${column}`);
  }

  const selected = await client.query<Record<string, unknown>>(
    `SELECT deleted_at,${IMAGE_UPLOAD_OWNED_COLUMNS.map((column) => `"${column}"`).join(",")}
       FROM certificates WHERE id=$1 FOR UPDATE`,
    [args.id]
  );
  const prior = selected.rows[0];
  if (!prior || prior.deleted_at != null) {
    throw new ObjectWriteAbandonError("Atomic image finalizer certificate row is unavailable");
  }
  for (const [column, expected] of Object.entries(args.expectedState)) {
    if (normVal(prior[column]) !== normVal(expected)) {
      throw new ObjectWriteAbandonError(`Atomic image finalizer conflict on ${column}`);
    }
  }

  for (const evidence of args.evidenceUpdates ?? []) {
    if (
      !["front", "back"].includes(evidence.side) ||
      !/^[0-9a-f]{64}$/.test(evidence.expectedSourceSha256) ||
      !/^[0-9a-f]{64}$/.test(evidence.workingSha256) ||
      !Number.isSafeInteger(evidence.workingWidth) ||
      !Number.isSafeInteger(evidence.workingHeight) ||
      evidence.workingWidth <= 0 ||
      evidence.workingHeight <= 0
    ) {
      throw new Error("Atomic image finalizer received malformed evidence lineage");
    }
    const lineage = await client.query(
      `UPDATE certificate_image_evidence SET
         working_object_key=$4,working_sha256=$5,working_width=$6,working_height=$7,
         working_format=$8,working_settings=$9::jsonb
       WHERE certificate_id=$1 AND side=$2 AND is_current=true AND sha256=$3
       RETURNING id`,
      [
        args.id,
        evidence.side,
        evidence.expectedSourceSha256,
        evidence.workingObjectKey,
        evidence.workingSha256,
        evidence.workingWidth,
        evidence.workingHeight,
        evidence.workingFormat,
        JSON.stringify(evidence.workingSettings),
      ]
    );
    if (lineage.rows.length !== 1) throw new Error(`Atomic image finalizer lost ${evidence.side} evidence lineage`);
  }

  const changes = committed
    .filter(([column, value]) => normVal(prior[column]) !== normVal(value))
    .map(([field, to]) => ({ field, from: prior[field] ?? null, to }));
  const values: unknown[] = committed.map(([, value]) => value);
  const assignments = committed.map(
    ([column], index) => `"${column}"=$${index + 1}${IMAGE_UPLOAD_JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`
  );
  values.push(args.id);
  const updated = await client.query(
    `UPDATE certificates SET ${assignments.join(",")},updated_at=now()
      WHERE id=$${values.length} RETURNING id`,
    values
  );
  if (updated.rows.length !== 1) throw new Error("Atomic image finalizer certificate update was not applied");

  const uploadedObjects = args.items.map((item) => ({
    key: item.objectKey,
    column: item.logicalSlot,
    sha256: item.contentSha256,
    bytes: item.byteLength,
    contentType: item.contentType,
    pathChanged: normVal(prior[item.logicalSlot]) !== normVal(item.objectKey),
    writeDisposition: item.writeDisposition,
  }));
  for (const history of args.imageHistory ?? []) {
    if (
      (history.side !== "front" && history.side !== "back") ||
      !history.objectKey ||
      !Number.isSafeInteger(history.sortOrder) ||
      history.sortOrder < 0
    ) {
      throw new Error("Atomic image finalizer received malformed image history");
    }
    await client.query(
      `INSERT INTO certificate_images(certificate_id,image_type,url,sort_order,created_at)
       VALUES ($1,$2,$3,$4,now())`,
      [args.id, history.side, history.objectKey, history.sortOrder]
    );
  }
  const details = {
    certificateId: args.id,
    certId: args.certId,
    scope: "grading_image_upload",
    objectWriteAtomic: true,
    changes,
    changedFields: changes.map((change) => change.field),
    uploadedObjects,
    requestMetadata: args.auditMetadata ?? null,
    outcome: "committed",
  };
  await client.query(
    `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details,created_at)
     VALUES ('certificate',$1,$2,$3,$4::jsonb,now())`,
    [args.certId, args.action ?? IMAGE_UPLOAD_AUDIT_ACTION, args.actor, JSON.stringify(details)]
  );
  return {
    certificateId: args.id,
    certId: args.certId,
    changedFields: changes.map((change) => change.field),
    objectKeys: args.items.map((item) => item.objectKey),
  };
}

export async function finalizeCertificateImageObjectWrite(
  client: PoolClient,
  context: ObjectWriteFinalizeContext
): Promise<Record<string, unknown>> {
  const intent = context.intentPayload;
  const id = Number(intent.id);
  const certId = typeof intent.certId === "string" ? intent.certId : "";
  const actor = typeof intent.actor === "string" ? intent.actor : "";
  const action = typeof intent.action === "string" ? intent.action : undefined;
  const updates = intent.updates;
  const rawEvidenceUpdates = intent.evidenceUpdates;
  const rawAuditMetadata = intent.auditMetadata;
  const rawImageHistory = intent.imageHistory;
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !certId ||
    !actor ||
    !updates ||
    typeof updates !== "object" ||
    Array.isArray(updates)
  ) {
    throw new Error("Certificate image object-write intent is malformed");
  }
  const stringUpdates: Record<string, string> = {};
  for (const [column, value] of Object.entries(updates as Record<string, unknown>)) {
    if (!IMAGE_UPLOAD_COLUMN_SET.has(column) || typeof value !== "string") {
      throw new Error("Certificate image object-write intent contains an invalid update");
    }
    stringUpdates[column] = value;
  }
  if (context.aggregateType !== "certificate" || context.aggregateId !== String(id)) {
    throw new Error("Certificate image object-write aggregate does not match its intent");
  }
  let evidenceUpdates: AtomicImageUploadPersistArgs["evidenceUpdates"];
  if (rawEvidenceUpdates !== undefined) {
    if (!Array.isArray(rawEvidenceUpdates)) throw new Error("Certificate evidence updates must be an array");
    evidenceUpdates = rawEvidenceUpdates.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Certificate evidence update is malformed");
      }
      const value = entry as Record<string, unknown>;
      if (
        (value.side !== "front" && value.side !== "back") ||
        typeof value.expectedSourceSha256 !== "string" ||
        typeof value.workingObjectKey !== "string" ||
        typeof value.workingSha256 !== "string" ||
        typeof value.workingWidth !== "number" ||
        typeof value.workingHeight !== "number" ||
        typeof value.workingFormat !== "string" ||
        !value.workingSettings ||
        typeof value.workingSettings !== "object" ||
        Array.isArray(value.workingSettings)
      ) {
        throw new Error("Certificate evidence update is malformed");
      }
      return value as unknown as NonNullable<AtomicImageUploadPersistArgs["evidenceUpdates"]>[number];
    });
  }
  let auditMetadata: Record<string, unknown> | undefined;
  if (rawAuditMetadata !== undefined) {
    if (!rawAuditMetadata || typeof rawAuditMetadata !== "object" || Array.isArray(rawAuditMetadata)) {
      throw new Error("Certificate image audit metadata must be an object");
    }
    auditMetadata = rawAuditMetadata as Record<string, unknown>;
  }
  let imageHistory: AtomicImageUploadPersistArgs["imageHistory"];
  if (rawImageHistory !== undefined) {
    if (!Array.isArray(rawImageHistory)) throw new Error("Certificate image history must be an array");
    imageHistory = rawImageHistory.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Certificate image history entry is malformed");
      }
      const value = entry as Record<string, unknown>;
      if (
        (value.side !== "front" && value.side !== "back") ||
        typeof value.objectKey !== "string" ||
        typeof value.sortOrder !== "number"
      ) {
        throw new Error("Certificate image history entry is malformed");
      }
      return value as NonNullable<AtomicImageUploadPersistArgs["imageHistory"]>[number];
    });
  }
  return persistImageUploadAuditedTx(client, {
    id,
    certId,
    updates: stringUpdates,
    expectedState: context.expectedState,
    items: context.items,
    actor,
    action,
    auditMetadata,
    imageHistory,
    evidenceUpdates,
  });
}

export interface ManualCertificateImagePublicationInput {
  id: number;
  certId: string;
  side: "front" | "back";
  previousKey: string | null;
  body: Buffer;
  actor: string;
  replaceExisting: boolean;
  originalFilename?: string | null;
  mimeReceived?: string | null;
  sizeInBytes: number;
  recordImageHistory?: boolean;
  /** Test/recovery hook. Production callers normally let this be generated. */
  writeVersion?: string;
}

export interface ManualCertificateImagePublicationDependencies {
  runner?: ObjectWriteTransactionRunner;
  store?: ObjectStorePort;
  workerId?: string;
}

export interface CertificateImageArtifactRevisionInput {
  id: number;
  certId: string;
  actor: string;
  action: string;
  expectedState: Record<string, unknown>;
  artifacts: Array<{
    column: (typeof IMAGE_UPLOAD_OWNED_COLUMNS)[number];
    filename: string;
    body: Buffer;
    contentType: string;
    objectClass?: "CANONICAL" | "DERIVATIVE";
  }>;
  auditMetadata?: Record<string, unknown>;
  writeVersion?: string;
}

/** Publish an explicitly rendered image revision through the same manifest/CAS finalizer. */
export async function persistCertificateImageArtifactRevision(
  input: CertificateImageArtifactRevisionInput,
  dependencies: ManualCertificateImagePublicationDependencies = {}
): Promise<{ operationId: string; replayed: boolean; objectKeys: Record<string, string> }> {
  if (!Number.isSafeInteger(input.id) || input.id <= 0 || !input.certId.trim() || !input.actor.trim()) {
    throw new Error("Certificate image artifact identity is invalid");
  }
  if (!input.action.trim() || input.artifacts.length === 0) {
    throw new Error("Certificate image artifact revision is empty");
  }
  const writeVersion = input.writeVersion ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(writeVersion)) {
    throw new Error("Certificate image artifact write version is invalid");
  }
  const objectKeys: Record<string, string> = {};
  const seenColumns = new Set<string>();
  for (const artifact of input.artifacts) {
    if (!IMAGE_UPLOAD_COLUMN_SET.has(artifact.column) || seenColumns.has(artifact.column)) {
      throw new Error("Certificate image artifact contains a duplicate or unowned column");
    }
    if (!Buffer.isBuffer(artifact.body) || artifact.body.length === 0 || !/^[a-z0-9][a-z0-9._-]*$/i.test(artifact.filename)) {
      throw new Error("Certificate image artifact body or filename is invalid");
    }
    seenColumns.add(artifact.column);
    objectKeys[artifact.column] = `images/grading/${input.id}/revisions/${writeVersion}/${artifact.filename}`;
  }
  if (
    Object.keys(input.expectedState).length !== input.artifacts.length ||
    Object.keys(input.expectedState).some((column) => !seenColumns.has(column))
  ) {
    throw new Error("Certificate image artifact expected state must cover every artifact exactly");
  }
  const runner = dependencies.runner ?? createPoolTransactionRunner((await import("../db")).pool);
  const coordinator = new ObjectWriteCoordinator(
    runner,
    dependencies.store ?? objectWriteStore,
    dependencies.workerId ?? `certificate-artifact:${process.pid}`
  );
  const result = await coordinator.execute(
    {
      idempotencyKey: `certificate-artifact:${input.id}:${input.action}:${writeVersion}`,
      operationKind: "CERTIFICATE_IMAGE_REVISION",
      aggregateType: "certificate",
      aggregateId: String(input.id),
      actorId: input.actor,
      expectedState: input.expectedState,
      intentPayload: {
        id: input.id,
        certId: input.certId,
        actor: input.actor,
        action: input.action,
        updates: objectKeys,
        evidenceUpdates: [],
        ...(input.auditMetadata ? { auditMetadata: input.auditMetadata } : {}),
      },
      items: input.artifacts.map((artifact) => ({
        store: "R2" as const,
        logicalSlot: artifact.column,
        objectKey: objectKeys[artifact.column],
        priorObjectKey: (input.expectedState[artifact.column] as string | null | undefined) ?? null,
        body: artifact.body,
        contentType: artifact.contentType,
        objectClass: artifact.objectClass ?? "DERIVATIVE",
      })),
    },
    finalizeCertificateImageObjectWrite
  );
  return { operationId: result.operationId, replayed: result.replayed, objectKeys };
}

/**
 * Durable publication boundary for POST /api/admin/certs/:certId/image.
 *
 * The route owns decode/admission and the downstream derivative pipeline. This
 * helper owns the irreversible boundary: create-only object publication plus a
 * certificate-pointer CAS and audit row in the operation's COMMITTED
 * transaction. Supplying the same writeVersion is an exact replay; a different
 * version competing from the same previous pointer is abandoned.
 */
export async function persistManualCertificateImageObjectWrite(
  input: ManualCertificateImagePublicationInput,
  dependencies: ManualCertificateImagePublicationDependencies = {}
): Promise<{ objectKey: string; operationId: string; replayed: boolean }> {
  if (!Number.isSafeInteger(input.id) || input.id <= 0 || !input.certId.trim() || !input.actor.trim()) {
    throw new Error("Manual certificate image identity is invalid");
  }
  if (!Buffer.isBuffer(input.body) || input.body.length === 0) {
    throw new Error("Manual certificate image body is empty");
  }
  if (!Number.isSafeInteger(input.sizeInBytes) || input.sizeInBytes <= 0) {
    throw new Error("Manual certificate image source size is invalid");
  }
  const writeVersion = input.writeVersion ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(writeVersion)) {
    throw new Error("Manual certificate image write version is invalid");
  }
  const sideColumn = input.side === "front" ? "grading_front_original" : "grading_back_original";
  const objectKey = `images/grading/${input.id}/manual-revisions/${writeVersion}/${input.side}_original.jpg`;
  const runner =
    dependencies.runner ?? createPoolTransactionRunner((await import("../db")).pool);
  const coordinator = new ObjectWriteCoordinator(
    runner,
    dependencies.store ?? objectWriteStore,
    dependencies.workerId ?? `manual-cert-image:${process.pid}`
  );
  const result = await coordinator.execute(
    {
      idempotencyKey: `manual-cert-image:${input.id}:${input.side}:${writeVersion}`,
      operationKind: "CERTIFICATE_IMAGE_REVISION",
      aggregateType: "certificate",
      aggregateId: String(input.id),
      actorId: input.actor,
      expectedState: { [sideColumn]: input.previousKey },
      intentPayload: {
        id: input.id,
        certId: input.certId,
        actor: input.actor,
        action: "image_attached_manual",
        updates: { [sideColumn]: objectKey },
        evidenceUpdates: [],
        auditMetadata: {
          side: input.side,
          replace_existing: input.replaceExisting,
          original_filename: input.originalFilename ?? null,
          mime_received: input.mimeReceived ?? null,
          size_in_bytes: input.sizeInBytes,
        },
        imageHistory: input.recordImageHistory
          ? [{ side: input.side, objectKey, sortOrder: input.side === "front" ? 0 : 1 }]
          : [],
      },
      items: [
        {
          store: "R2",
          logicalSlot: sideColumn,
          objectKey,
          priorObjectKey: input.previousKey,
          body: input.body,
          contentType: "image/jpeg",
          objectClass: "CANONICAL",
        },
      ],
    },
    finalizeCertificateImageObjectWrite
  );
  return { objectKey, operationId: result.operationId, replayed: result.replayed };
}

/**
 * Commit an image upload's column changes together with a truthful audit row.
 *
 * @param id        numeric certificates.id
 * @param certId    CANONICAL certificate id ("MV1"). Used as the audit
 *                  `entity_id`, matching the metadata route — this route used to
 *                  write nothing at all, and the grading route used to write the
 *                  numeric row id, so querying the trail by certificate ID
 *                  missed events. One convention now.
 * @param updates   column → value, filtered against the allowlist here.
 * @param uploadedObjects content identity for every object written to R2.
 * @param actor     admin/staff email recorded as `admin_user`.
 */
export async function persistImageUploadAudited(args: {
  id: number;
  certId: string;
  updates: Record<string, string>;
  uploadedObjects: UploadedObject[];
  actor: string;
  /** Defaults to the operator-facing upload event. */
  action?: string;
}): Promise<ImageUploadPersistResult> {
  const { id, certId, updates, uploadedObjects, actor, action = IMAGE_UPLOAD_AUDIT_ACTION } = args;

  const committed: Array<[string, string]> = [];
  for (const [col, val] of Object.entries(updates)) {
    if (!IMAGE_UPLOAD_COLUMN_SET.has(col)) {
      // A column outside the allowlist is a construction bug. Dropped loudly
      // rather than interpolated into an identifier position.
      console.warn(`[upload-images] ignoring non-allowlisted column '${col}'`);
      continue;
    }
    committed.push([col, val]);
  }

  if (committed.length === 0) {
    return {
      committed: true,
      changedFields: [],
      changes: [],
      orphansRemoved: [],
      orphanCleanupFailed: [],
      overwrittenCommittedObjects: [],
      unknownPriorStateObjects: [],
      priorStateVerified: true,
      failureAuditRecorded: false,
    };
  }

  let changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  // The row as it stood BEFORE this transaction, captured for compensation.
  // Read inside the transaction (below) but needed in the catch, so it is held
  // here. Null means we never got far enough to know what was committed — in
  // which case compensation deletes NOTHING, which is the safe direction.
  let priorCommitted: Record<string, unknown> | null = null;

  try {
    await db.transaction(async (tx) => {
      // Lock the row and read the PRE-state of exactly the columns about to be
      // written. Read INSIDE the transaction rather than from a caller-supplied
      // Drizzle row, because several of these columns are real but undeclared in
      // shared/schema.ts — a Drizzle-selected row has no property for them, so a
      // diff built from it would be fabricated.
      const priorRes: any = await tx.execute(
        sql`SELECT ${sql.join(
          IMAGE_UPLOAD_OWNED_COLUMNS.map((c) => sql.raw(`"${c}"`)),
          sql`, `
        )} FROM certificates WHERE id = ${id} FOR UPDATE`
      );
      const prior = (priorRes.rows?.[0] ?? {}) as Record<string, unknown>;
      priorCommitted = prior;
      // A missing row must not produce an audit row claiming an upload landed.
      if (!priorRes.rows?.length) {
        throw new Error(`persistImageUploadAudited: certificate ${id} not found`);
      }

      changes = committed
        .filter(([col, val]) => normVal(prior[col]) !== normVal(val))
        .map(([col, val]) => ({ field: col, from: prior[col] ?? null, to: val }));

      await tx.execute(
        sql`UPDATE certificates SET ${sql.join(
          committed.map(([col, val]) =>
            IMAGE_UPLOAD_JSONB_COLUMNS.has(col)
              ? sql`${sql.raw(`"${col}"`)} = ${val}::jsonb`
              : sql`${sql.raw(`"${col}"`)} = ${val}`
          ),
          sql`, `
        )}, updated_at = NOW() WHERE id = ${id}`
      );

      // Audited whenever an object was uploaded, EVEN IF no column value moved:
      // these R2 keys are deterministic, so a re-upload replaces the object
      // while the stored path string stays identical. A path-only audit would
      // report "nothing happened" for a request that swapped a customer's card
      // image. Content identity below is what makes that provable.
      //
      // A request that uploaded nothing AND changed nothing writes no row.
      if (uploadedObjects.length === 0 && changes.length === 0) return;

      await tx.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES (
          'certificate',
          ${certId},
          ${action},
          ${actor},
          ${JSON.stringify({
            certificateId: id,
            certId,
            scope: "grading_image_upload",
            changes,
            changedFields: changes.map((c) => c.field),
            // Object KEYS only — never a signed URL, never a credential. The
            // keys are already stored in these columns.
            uploadedObjects: uploadedObjects.map((o) => ({
              key: o.key,
              column: o.column,
              sha256: o.sha256,
              bytes: o.bytes,
              contentType: o.contentType,
              // Stated explicitly rather than implied: when false the stored
              // path did NOT move and the object itself was overwritten.
              pathChanged: normVal(prior[o.column]) !== normVal(o.key),
            })),
            outcome: "committed",
          })}::jsonb,
          NOW()
        )
      `);
    });
  } catch (persistErr: any) {
    // ── COMPENSATION ────────────────────────────────────────────────────────
    // Nothing committed. Remove the objects this request CREATED; never remove
    // one the last committed row still points at.
    // HOSTILE SELF-REVIEW (HIGH, found and fixed before this PR was opened).
    // An earlier revision decided orphan-eligibility from the caller's
    // `preexisting` flag alone. That flag is derived from COLUMN_TO_CERT_KEY,
    // which only maps front/back image path — so EVERY deterministic
    // `grading/{certId}/{angle}_cropped.jpg` key came through as
    // preexisting:false. On the very common case of an operator RE-uploading an
    // angle, a failed transaction would then have deleted the grading object the
    // last committed row still points at, turning a recoverable failure into a
    // certificate with broken grading images.
    //
    // The authoritative test is the row we actually read under FOR UPDATE: an
    // object is an orphan ONLY if no committed column value equals its key. The
    // caller's flag is still honoured as an additional veto, never as the sole
    // permission.
    const committedKeys = new Set(
      priorCommitted
        ? Object.values(priorCommitted).filter((v): v is string => typeof v === "string" && v.length > 0)
        : []
    );
    // If we never read the prior row, we cannot prove anything about any object.
    const canProveOrphans = priorCommitted !== null;

    // ── M-1r · THREE STATES, NOT TWO ────────────────────────────────────────
    // An earlier revision had only "orphan" and "everything else", and called
    // everything else OVERWRITTEN. When the transaction failed BEFORE the
    // FOR UPDATE read completed (pool timeout after BEGIN, connection reset,
    // statement/lock timeout) nothing could be proven, so every uploaded key —
    // including brand-new ones with no previous content at all — was reported as
    // overwritten, and the failure audit asserted their previous bytes were
    // unrecoverable. That is a durable record making a claim it cannot support.
    //
    //   provablyOverwritten — prior state WAS read, and the object is either
    //                         flagged preexisting or matches a committed value.
    //                         Its previous bytes really are gone.
    //   provablyOrphaned    — prior state WAS read, and nothing committed
    //                         references this key. Safe to delete.
    //   unknownPriorState   — prior state was NOT read. Nothing is provable, so
    //                         nothing is claimed and nothing is deleted.
    type PriorState = "overwritten" | "orphan" | "unknown";
    const classify = (o: UploadedObject): PriorState => {
      if (!canProveOrphans) return "unknown";
      if (o.preexisting || committedKeys.has(o.key)) return "overwritten";
      return "orphan";
    };
    const provablyOverwritten = uploadedObjects.filter((o) => classify(o) === "overwritten");
    const provablyOrphaned = uploadedObjects.filter((o) => classify(o) === "orphan");
    const unknownPriorState = uploadedObjects.filter((o) => classify(o) === "unknown");
    // Deletion eligibility is UNCHANGED: only a provable orphan is ever removed.
    // Overwritten and unknown objects are both left alone.
    const orphans = provablyOrphaned;
    const overwritten = provablyOverwritten.map((o) => o.key);
    const orphansRemoved: string[] = [];
    const orphanCleanupFailed: string[] = [];
    for (const o of orphans) {
      try {
        await deleteFromR2(o.key);
        orphansRemoved.push(o.key);
      } catch (cleanupErr: any) {
        orphanCleanupFailed.push(o.key);
        console.error(`[upload-images] orphan cleanup FAILED for ${o.key}: ${cleanupErr?.message}`);
      }
    }
    console.error(
      `[upload-images] persist failed for cert=${id} (${persistErr?.message}); ` +
        `orphans_removed=${orphansRemoved.length} orphans_left=${orphanCleanupFailed.length} ` +
        `overwritten_committed_objects=${overwritten.length} unknown_prior_state=${unknownPriorState.length}`
    );

    // ── M-3 · DURABLE FAILURE RECORD FOR AN UNRECOVERABLE OVERWRITE ─────────
    // Written ONLY when a committed object's bytes were actually replaced.
    // Recoverable orphan cleanup overwrote nothing and is not audited here.
    //
    // On its OWN connection (`db`, not `tx`): the transaction has already rolled
    // back, so anything written inside it would roll back with it — the record of
    // the failure must survive the failure. Best-effort by construction: it can
    // neither rescue the request nor replace the 500 the caller returns.
    let failureAuditRecorded = false;
    if (overwritten.length > 0 || unknownPriorState.length > 0) {
      const { category, sqlState } = classifyPersistFailure(persistErr);
      const describe = (o: UploadedObject) => ({
        key: o.key,
        column: o.column,
        side: sideOfColumn(o.column),
        bytes: o.bytes,
      });
      const overwrittenDetail = provablyOverwritten.map(describe);
      const unknownDetail = unknownPriorState.map(describe);
      // Only the PROVEN case may be described as destroying prior content. The
      // unknown case gets uncertainty wording and nothing more.
      const note = [
        "Object storage was written before the database transaction and cannot be rolled back.",
        overwrittenDetail.length > 0
          ? "The objects listed under overwrittenCommittedObjects were overwritten in place; their previous content is unrecoverable."
          : "",
        unknownDetail.length > 0
          ? "The objects listed under unknownPriorStateObjects are UNVERIFIED: the prior committed state could not be read, " +
            "so it is NOT known whether they replaced existing content. No claim is made about prior content, and none of " +
            "them were deleted."
          : "",
        "No certificate column changed — the database mutation did not commit.",
      ]
        .filter(Boolean)
        .join(" ");
      try {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
          VALUES (
            'certificate',
            ${certId},
            ${IMAGE_UPLOAD_FAILURE_AUDIT_ACTION},
            ${actor},
            ${JSON.stringify({
              certificateId: id,
              certId,
              scope: "grading_image_upload",
              // Stated in the row itself so no reader can mistake this for a
              // successful upload, and so the R2/Postgres boundary is not
              // dressed up as an atomicity it does not have.
              outcome: "not_committed",
              committed: false,
              databaseMutationCommitted: false,
              note,
              failureCategory: category,
              ...(sqlState ? { sqlState } : {}),
              // True when the prior committed row was read under FOR UPDATE. When
              // false NOTHING about prior object state is provable, and the
              // overwritten list is necessarily empty.
              priorStateVerified: canProveOrphans,
              // Object KEYS and byte counts only — never a signed URL, never a
              // credential, never a request header, never a stack trace.
              overwrittenCommittedObjects: overwrittenDetail,
              overwrittenCommittedObjectCount: overwrittenDetail.length,
              unknownPriorStateObjects: unknownDetail,
              unknownPriorStateObjectCount: unknownDetail.length,
              sides: Array.from(new Set([...overwrittenDetail, ...unknownDetail].map((o) => o.side))).sort(),
              orphansRemovedCount: orphansRemoved.length,
              orphanCleanupFailedCount: orphanCleanupFailed.length,
              orphanCleanupFailedKeys: orphanCleanupFailed,
            })}::jsonb,
            NOW()
          )
        `);
        failureAuditRecorded = true;
      } catch (auditErr: any) {
        // The ORIGINAL failure is what the caller must see. This secondary
        // failure is logged safely and changes nothing else: no throw, no
        // success, and above all no deletion of a committed object.
        console.error(
          `[upload-images] FAILURE-AUDIT write failed for cert=${id} ` +
            `(${auditErr?.code ?? "no-sqlstate"}); original failure stands, ${overwritten.length} ` +
            `committed object(s) were overwritten with no durable record`
        );
      }
    }

    return {
      committed: false,
      changedFields: [],
      changes: [],
      orphansRemoved,
      orphanCleanupFailed,
      overwrittenCommittedObjects: overwritten,
      unknownPriorStateObjects: unknownPriorState.map((o) => o.key),
      priorStateVerified: canProveOrphans,
      failureAuditRecorded,
    };
  }

  return {
    committed: true,
    changedFields: changes.map((c) => c.field),
    changes,
    orphansRemoved: [],
    orphanCleanupFailed: [],
    overwrittenCommittedObjects: [],
    unknownPriorStateObjects: [],
    priorStateVerified: true,
    failureAuditRecorded: false,
  };
}
