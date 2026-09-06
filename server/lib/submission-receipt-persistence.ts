import { fileTypeFromBuffer } from "file-type";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { getR2SignedUrl } from "../r2";
import {
  ObjectWriteCoordinator,
  ObjectWriteAbandonError,
  ObjectWriteConflictError,
  canonicalJson,
  createPoolTransactionRunner,
  readObjectWriteSnapshot,
  sha256Hex,
  type ObjectWriteFinalizeContext,
  type ObjectWriteItemRecord,
} from "./object-write-coordinator";
import { objectWriteStore } from "./object-write-store";

const RECEIPT_MIMES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/tiff", "tiff"],
]);

export interface ReceiptPhotoObject {
  operationId: string;
  logicalSlot: string;
  store: "R2";
  key: string;
  sha256: string;
  byteLength: number;
  contentType: string;
}

interface ReceiptIntent {
  submissionId: number;
  trackingNumber: string;
  expectedStatus: string;
  expectedRevision: number;
  adminUser: string;
  externalUrls: string[];
}

function parseExternalUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error("Receipt photo URLs must be an array of at most six URLs");
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length > 2_048) throw new Error("Receipt photo URL is invalid");
    const url = new URL(entry);
    if (url.protocol !== "https:") throw new Error("Receipt photo URLs must use HTTPS");
    return url.toString();
  });
}

function parseReceiptIntent(context: ObjectWriteFinalizeContext): ReceiptIntent {
  const payload = context.intentPayload;
  if (
    context.operationKind !== "SUBMISSION_RECEIPT_PHOTOS" ||
    context.aggregateType !== "submission" ||
    !Number.isSafeInteger(payload.submissionId) ||
    Number(payload.submissionId) <= 0 ||
    typeof payload.trackingNumber !== "string" ||
    typeof payload.expectedStatus !== "string" ||
    !Number.isSafeInteger(payload.expectedRevision) ||
    Number(payload.expectedRevision) < 0 ||
    typeof payload.adminUser !== "string"
  ) {
    throw new Error("SUBMISSION_RECEIPT_PHOTOS intent is malformed");
  }
  const submissionId = Number(payload.submissionId);
  if (context.aggregateId !== String(submissionId)) throw new Error("Receipt intent aggregate does not match submission");
  return {
    submissionId,
    trackingNumber: payload.trackingNumber,
    expectedStatus: payload.expectedStatus,
    expectedRevision: Number(payload.expectedRevision),
    adminUser: payload.adminUser,
    externalUrls: parseExternalUrls(payload.externalUrls),
  };
}

function descriptors(operationId: string, items: ObjectWriteItemRecord[]): ReceiptPhotoObject[] {
  return items.map((item) => {
    if (
      item.store !== "R2" ||
      item.verificationState !== "VERIFIED" ||
      item.required !== true ||
      item.objectClass !== "CANONICAL" ||
      item.priorObjectKey !== null
    ) {
      throw new Error("Receipt photo manifest contains an unverified or non-R2 item");
    }
    return {
      operationId,
      logicalSlot: item.logicalSlot,
      store: "R2",
      key: item.objectKey,
      sha256: item.contentSha256,
      byteLength: item.byteLength,
      contentType: item.contentType,
    };
  });
}

async function finalizeReceipt(
  client: PoolClient,
  intent: ReceiptIntent,
  photoObjects: ReceiptPhotoObject[],
  operationId: string | null
): Promise<{ submissionId: number; trackingNumber: string; photoObjects: ReceiptPhotoObject[]; externalUrls: string[] }> {
  const locked = await client.query<{ status: string; on_receipt_photo_revision: string | number }>(
    `SELECT status,on_receipt_photo_revision FROM submissions
      WHERE id=$1 AND tracking_number=$2 AND deleted_at IS NULL FOR UPDATE`,
    [intent.submissionId, intent.trackingNumber]
  );
  if (locked.rowCount !== 1) {
    throw new ObjectWriteAbandonError("Submission is unavailable while finalizing receipt photos");
  }
  if (
    locked.rows[0].status !== intent.expectedStatus ||
    Number(locked.rows[0].on_receipt_photo_revision) !== intent.expectedRevision
  ) {
    throw new ObjectWriteAbandonError("Submission changed before receipt photos could be published");
  }
  const updated = await client.query(
    `UPDATE submissions
        SET status='received',received_at=now(),updated_at=now(),
            on_receipt_photo_urls=$3,
            on_receipt_photo_objects=$4::jsonb,
            on_receipt_photo_revision=on_receipt_photo_revision+1,
            status_history=COALESCE(status_history,'[]'::jsonb)
              || jsonb_build_array(jsonb_build_object('status','received','timestamp',now(),'note',NULL))
      WHERE id=$1 AND tracking_number=$2 AND status=$5 AND on_receipt_photo_revision=$6
      RETURNING id`,
    [
      intent.submissionId,
      intent.trackingNumber,
      JSON.stringify(intent.externalUrls),
      JSON.stringify(photoObjects),
      intent.expectedStatus,
      intent.expectedRevision,
    ]
  );
  if (updated.rowCount !== 1) {
    throw new ObjectWriteAbandonError("Submission receipt update lost its compare-and-swap");
  }
  await client.query(
    `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details)
     VALUES ('submission',$1,'status_received',$2,$3::jsonb)`,
    [
      intent.trackingNumber,
      intent.adminUser,
      JSON.stringify({ photoCount: photoObjects.length + intent.externalUrls.length, operationId }),
    ]
  );
  return {
    submissionId: intent.submissionId,
    trackingNumber: intent.trackingNumber,
    photoObjects,
    externalUrls: intent.externalUrls,
  };
}

export async function finalizeSubmissionReceiptObjectWrite(
  client: PoolClient,
  context: ObjectWriteFinalizeContext
): Promise<{ submissionId: number; trackingNumber: string; photoObjects: ReceiptPhotoObject[]; externalUrls: string[] }> {
  const intent = parseReceiptIntent(context);
  if (
    context.actorId !== intent.adminUser ||
    context.expectedState.status !== intent.expectedStatus ||
    context.expectedState.receiptRevision !== intent.expectedRevision
  ) {
    throw new Error("SUBMISSION_RECEIPT_PHOTOS manifest state is inconsistent");
  }
  return finalizeReceipt(client, intent, descriptors(context.operationId, context.items), context.operationId);
}

function readPhotoObjects(value: unknown): ReceiptPhotoObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ReceiptPhotoObject[] => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { operationId?: unknown }).operationId !== "string" ||
      typeof (entry as { logicalSlot?: unknown }).logicalSlot !== "string" ||
      (entry as { store?: unknown }).store !== "R2" ||
      typeof (entry as { key?: unknown }).key !== "string" ||
      typeof (entry as { sha256?: unknown }).sha256 !== "string" ||
      typeof (entry as { byteLength?: unknown }).byteLength !== "number" ||
      typeof (entry as { contentType?: unknown }).contentType !== "string"
    ) {
      return [];
    }
    return [entry as ReceiptPhotoObject];
  });
}

function readLegacyUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export async function signedSubmissionReceiptPhotoUrls(record: Record<string, unknown>): Promise<string[]> {
  const objects = readPhotoObjects(record.on_receipt_photo_objects ?? record.onReceiptPhotoObjects);
  const external = readLegacyUrls(record.on_receipt_photo_urls ?? record.onReceiptPhotoUrls);
  const signed = await Promise.all(objects.map((object) => getR2SignedUrl(object.key, 60 * 60)));
  return [...signed, ...external];
}

export async function decorateSubmissionReceiptPhotos<T extends Record<string, unknown>>(record: T): Promise<T> {
  const urls = await signedSubmissionReceiptPhotoUrls(record);
  const encoded = JSON.stringify(urls);
  return { ...record, on_receipt_photo_urls: encoded, onReceiptPhotoUrls: encoded };
}

export async function persistSubmissionReceipt(input: {
  submissionId: number;
  trackingNumber: string;
  expectedStatus: string;
  expectedRevision: number;
  adminUser: string;
  files: Array<{ buffer: Buffer; mimetype: string; originalname: string }>;
  externalUrls: unknown;
  requestIdempotencyKey?: string | null;
}): Promise<{ photoUrls: string[]; replayed: boolean; operationId: string | null }> {
  const externalUrls = parseExternalUrls(input.externalUrls);
  const runner = createPoolTransactionRunner(pool);
  if (input.files.length === 0) {
    if (input.expectedStatus !== "new" && input.expectedStatus !== "paid") {
      throw new Error("Submission is not eligible to be marked received");
    }
    const intent: ReceiptIntent = {
      submissionId: input.submissionId,
      trackingNumber: input.trackingNumber,
      expectedStatus: input.expectedStatus,
      expectedRevision: input.expectedRevision,
      adminUser: input.adminUser,
      externalUrls,
    };
    const result = await runner.transaction((client) => finalizeReceipt(client, intent, [], null));
    return { photoUrls: result.externalUrls, replayed: false, operationId: null };
  }
  const suppliedKey = input.requestIdempotencyKey?.trim() ?? "";
  if (!suppliedKey) throw new Error("An Idempotency-Key header is required for receipt photo uploads");
  if (suppliedKey.length > 200) throw new Error("Idempotency key is too long");
  const ledgerKey = `submission-receipt:${sha256Hex(suppliedKey)}`;
  const revision = sha256Hex(`${input.submissionId}:${input.trackingNumber}:${suppliedKey}`).slice(0, 32);
  const suppliedItems = await Promise.all(
    input.files.map(async (file, index) => {
      const detected = await fileTypeFromBuffer(file.buffer);
      const ext = detected?.mime ? RECEIPT_MIMES.get(detected.mime) : null;
      if (!detected?.mime || !ext) throw new Error(`File "${file.originalname}" is not a valid receipt image`);
      return {
        store: "R2" as const,
        logicalSlot: `photo-${index + 1}`,
        objectKey: `receipt/${input.trackingNumber}/revisions/${revision}/${index + 1}.${ext}`,
        body: file.buffer,
        contentType: detected.mime,
        objectClass: "CANONICAL" as const,
      };
    })
  );
  const snapshot = await runner.transaction((client) => readObjectWriteSnapshot(client, null, ledgerKey));
  if (snapshot) {
    const payload = snapshot.intentPayload;
    if (
      snapshot.operationKind !== "SUBMISSION_RECEIPT_PHOTOS" ||
      snapshot.aggregateType !== "submission" ||
      snapshot.aggregateId !== String(input.submissionId) ||
      snapshot.actorId !== input.adminUser ||
      payload.submissionId !== input.submissionId ||
      payload.trackingNumber !== input.trackingNumber ||
      payload.adminUser !== input.adminUser ||
      canonicalJson(payload.externalUrls) !== canonicalJson(externalUrls) ||
      snapshot.items.length !== suppliedItems.length
    ) {
      throw new ObjectWriteConflictError("Idempotency key is already bound to another receipt request");
    }
  } else if (input.expectedStatus !== "new" && input.expectedStatus !== "paid") {
    throw new Error("Submission is not eligible to be marked received");
  }
  const intent: ReceiptIntent = snapshot
    ? (snapshot.intentPayload as unknown as ReceiptIntent)
    : {
        submissionId: input.submissionId,
        trackingNumber: input.trackingNumber,
        expectedStatus: input.expectedStatus,
        expectedRevision: input.expectedRevision,
        adminUser: input.adminUser,
        externalUrls,
      };
  const items = snapshot
    ? snapshot.items.map((item, index) => ({
        store: item.store,
        logicalSlot: item.logicalSlot,
        objectKey: item.objectKey,
        priorObjectKey: item.priorObjectKey,
        body: suppliedItems[index].body,
        contentType: item.contentType,
        objectClass: item.objectClass,
        required: item.required,
        retentionDays: item.retentionDays ?? undefined,
      }))
    : suppliedItems;
  const coordinator = new ObjectWriteCoordinator(runner, objectWriteStore, `submission-receipt:${input.adminUser}`);
  const result = await coordinator.execute(
    {
      tenantId: snapshot?.tenantId,
      idempotencyKey: ledgerKey,
      operationKind: snapshot?.operationKind ?? "SUBMISSION_RECEIPT_PHOTOS",
      aggregateType: snapshot?.aggregateType ?? "submission",
      aggregateId: snapshot?.aggregateId ?? String(input.submissionId),
      actorId: snapshot?.actorId ?? input.adminUser,
      expectedState: snapshot?.expectedState ?? {
        status: input.expectedStatus,
        receiptRevision: input.expectedRevision,
      },
      intentPayload: { ...intent },
      items,
    },
    finalizeSubmissionReceiptObjectWrite
  );
  const signed = await Promise.all(result.result.photoObjects.map((object) => getR2SignedUrl(object.key, 60 * 60)));
  return {
    photoUrls: [...signed, ...result.result.externalUrls],
    replayed: result.replayed,
    operationId: result.operationId,
  };
}
