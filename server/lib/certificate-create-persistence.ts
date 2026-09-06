import { generateReferenceNumber } from "../reference-number";
import { objectWriteStore } from "./object-write-store";
import {
  ObjectWriteConflictError,
  ObjectWriteAbandonError,
  ObjectWriteCoordinator,
  canonicalJson,
  createPoolTransactionRunner,
  readObjectWriteSnapshot,
  sha256Hex,
  type ObjectWriteFinalizeContext,
  type ObjectWriteInput,
} from "./object-write-coordinator";
import { pool } from "../db";
import { storage, type SqlExecutor } from "../storage";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  CERTIFICATE_ORIGIN_SNAPSHOT_VERSION,
  auditLog,
  certificateImages,
  certificates,
  type CertificateRecord,
  type InsertCertificate,
} from "@shared/schema";
import { fileTypeFromBuffer } from "file-type";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tif",
};

export interface CertificateCreateImageInput {
  side: "front" | "back";
  body: Buffer;
}

interface CertificateCreateIntent {
  actor: string;
  requestedStatus: string;
  certificateData: Record<string, unknown>;
  imageKeys: Partial<Record<"front" | "back", string>>;
}

export interface CertificateCreateImagesResult extends Record<string, unknown> {
  certificateId: number;
  certId: string;
  operationId: string;
  artifacts: Array<Record<string, unknown>>;
}

function jsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const clean = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(clean);
    if (entry && typeof entry === "object" && !(entry instanceof Date)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .map(([key, child]) => [key, clean(child)])
      );
    }
    if (entry instanceof Date) return entry.toISOString();
    return entry;
  };
  return clean(value) as Record<string, unknown>;
}

function camelKey(key: string): string {
  const aliases: Record<string, string> = {
    certificate_number: "certId",
    grade: "gradeOverall",
    centering_score: "gradeCentering",
    corners_score: "gradeCorners",
    edges_score: "gradeEdges",
    surface_score: "gradeSurface",
    card_number_display: "cardNumber",
    issued_at: "createdAt",
    year_text: "year",
    rarity_label: "rarityLabelStructured",
  };
  return aliases[key] ?? key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function camelRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [camelKey(key), value]));
}

function comparable(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "object") return canonicalJson(value);
  return String(value);
}

function parseIntent(context: ObjectWriteFinalizeContext): CertificateCreateIntent {
  const payload = context.intentPayload as unknown as Partial<CertificateCreateIntent>;
  if (
    context.operationKind !== "CERTIFICATE_CREATE_IMAGES" ||
    context.aggregateType !== "certificate_create" ||
    context.aggregateId !== context.expectedState.requestHash ||
    typeof payload.actor !== "string" ||
    context.actorId !== payload.actor ||
    typeof payload.requestedStatus !== "string" ||
    !payload.certificateData ||
    typeof payload.certificateData !== "object" ||
    !payload.imageKeys ||
    typeof payload.imageKeys !== "object"
  ) {
    throw new Error("CERTIFICATE_CREATE_IMAGES intent is malformed");
  }
  return payload as CertificateCreateIntent;
}

export async function finalizeCertificateCreateImagesObjectWrite(
  client: import("pg").PoolClient,
  context: ObjectWriteFinalizeContext
): Promise<CertificateCreateImagesResult> {
  const intent = parseIntent(context);
  const selected = await client.query<{ cert: Record<string, unknown> }>(
    `SELECT to_jsonb(c) AS cert
       FROM certificates c
      WHERE c.object_write_operation_id=$1
      FOR UPDATE`,
    [context.operationId]
  );
  if (selected.rowCount !== 1) throw new ObjectWriteAbandonError("Prepared certificate row is missing");
  const raw = selected.rows[0].cert;
  const certificate = camelRecord(raw);
  if (
    certificate.objectWriteOperationId !== context.operationId ||
    certificate.deletedAt != null ||
    certificate.frontImagePath != null ||
    certificate.backImagePath != null ||
    certificate.status !== "draft" ||
    certificate.createdBy !== intent.actor
  ) {
    throw new ObjectWriteAbandonError("Prepared certificate changed before image publication");
  }
  for (const [property, expected] of Object.entries(intent.certificateData)) {
    if (property === "status" || property === "frontImagePath" || property === "backImagePath") continue;
    if (comparable(certificate[property]) !== comparable(expected)) {
      throw new ObjectWriteAbandonError(`Prepared certificate changed before publication (${property})`);
    }
  }

  const expectedSides = Object.keys(intent.imageKeys).sort();
  const actualSides = context.items.map((item) => item.logicalSlot).sort();
  if (canonicalJson(actualSides) !== canonicalJson(expectedSides)) {
    throw new Error("Certificate create image manifest is incomplete");
  }
  const descriptors = context.items.map((item) => {
    const side = item.logicalSlot as "front" | "back";
    if (
      (side !== "front" && side !== "back") ||
      item.store !== "R2" ||
      item.objectClass !== "CANONICAL" ||
      item.required !== true ||
      item.priorObjectKey !== null ||
      item.verificationState !== "VERIFIED" ||
      intent.imageKeys[side] !== item.objectKey
    ) {
      throw new Error(`Certificate create image ${item.logicalSlot} is not verified against its manifest`);
    }
    return {
      operationId: context.operationId,
      logicalSlot: side,
      store: item.store,
      key: item.objectKey,
      sha256: item.contentSha256,
      byteLength: item.byteLength,
      contentType: item.contentType,
    };
  });
  const bySide = new Map(descriptors.map((item) => [item.logicalSlot, item] as const));
  await client.query(
    `UPDATE certificates
        SET front_image_path=$2,back_image_path=$3,status=$4,updated_at=NOW()
      WHERE id=$1`,
    [
      Number(certificate.id),
      bySide.get("front")?.key ?? null,
      bySide.get("back")?.key ?? null,
      intent.requestedStatus,
    ]
  );
  const tx = drizzle(client);
  for (const side of ["front", "back"] as const) {
    const descriptor = bySide.get(side);
    if (!descriptor) continue;
    await tx.insert(certificateImages).values({
      certificateId: Number(certificate.id),
      imageType: side,
      url: descriptor.key,
      sortOrder: side === "front" ? 0 : 1,
    });
  }
  const auditDetails = {
    operationId: context.operationId,
    certificateId: Number(certificate.id),
    certId: String(certificate.certId),
    cardName: intent.certificateData.cardName ?? null,
    setName: intent.certificateData.setName ?? null,
    cardNumber: intent.certificateData.cardNumber ?? null,
    gradeOverall: intent.certificateData.gradeOverall ?? null,
    artifacts: descriptors,
  };
  await tx.insert(auditLog).values([
    {
      entityType: "certificate",
      entityId: String(certificate.certId),
      action: "CERT_ID_ALLOCATED",
      adminUser: intent.actor,
      details: {
        operationId: context.operationId,
        mvNumber: String(certificate.certId),
        originType: "HQ",
      },
    },
    {
      entityType: "certificate",
      entityId: String(certificate.certId),
      action: "create",
      adminUser: intent.actor,
      details: auditDetails,
    },
  ]);
  return {
    certificateId: Number(certificate.id),
    certId: String(certificate.certId),
    operationId: context.operationId,
    artifacts: descriptors,
  };
}

export async function abandonCertificateCreateImagesObjectWrite(
  client: import("pg").PoolClient,
  context: ObjectWriteFinalizeContext,
  reason: { code: string; detail: string }
): Promise<void> {
  parseIntent(context);
  const prepared = await client.query<{ id: number; certificate_number: string }>(
    `SELECT id,certificate_number FROM certificates
      WHERE object_write_operation_id=$1 FOR UPDATE`,
    [context.operationId]
  );
  const certificate = prepared.rows[0];
  if (!certificate) return;
  await client.query(
    `UPDATE certificates
        SET status='voided',voided_at=COALESCE(voided_at,NOW()),
            void_reason=COALESCE(void_reason,'Initial image publication abandoned'),
            deleted_at=COALESCE(deleted_at,NOW()),updated_at=NOW()
      WHERE id=$1 AND front_image_path IS NULL AND back_image_path IS NULL`,
    [certificate.id]
  );
  await client.query(
    `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details)
     VALUES ('certificate',$1,'certificate_create_abandoned',$2,$3::jsonb)`,
    [
      certificate.certificate_number,
      context.actorId,
      JSON.stringify({ operationId: context.operationId, code: reason.code, detail: reason.detail }),
    ]
  );
}

export async function createCertificateWithImages(input: {
  data: InsertCertificate;
  actor: string;
  idempotencyKey: string;
  images: CertificateCreateImageInput[];
}): Promise<{ certificate: CertificateRecord; operationId: string; replayed: boolean }> {
  const rawKey = input.idempotencyKey.trim();
  if (!rawKey || rawKey.length > 200) throw new Error("A valid Idempotency-Key header is required");
  if (input.images.length < 1 || input.images.length > 2) throw new Error("Certificate creation requires one or two images");
  if (new Set(input.images.map((image) => image.side)).size !== input.images.length) {
    throw new Error("Certificate creation contains a duplicate image side");
  }
  const actor = input.actor.trim() || "admin";
  const requestHash = sha256Hex(rawKey);
  const ledgerKey = `certificate-create:${requestHash}`;
  const runner = createPoolTransactionRunner(pool);
  const existing = await runner.transaction((client) => readObjectWriteSnapshot(client, null, ledgerKey));
  const certificateData = jsonRecord(input.data as unknown as Record<string, unknown>);
  if (existing) {
    const existingIntent = existing.intentPayload as unknown as Partial<CertificateCreateIntent>;
    if (
      existing.operationKind !== "CERTIFICATE_CREATE_IMAGES" ||
      existing.aggregateType !== "certificate_create" ||
      existing.aggregateId !== requestHash ||
      existing.actorId !== actor ||
      existingIntent.actor !== actor ||
      canonicalJson(existingIntent.certificateData) !== canonicalJson(certificateData)
    ) {
      throw new ObjectWriteConflictError("Certificate-create idempotency key is already bound to another request");
    }
  }

  const detected = await Promise.all(
    input.images.map(async (image) => {
      const kind = await fileTypeFromBuffer(image.body);
      const extension = kind?.mime ? IMAGE_TYPES[String(kind.mime)] : undefined;
      if (!kind?.mime || !extension) throw new Error(`The ${image.side} image has an unsupported content type`);
      return { ...image, contentType: kind.mime, extension };
    })
  );
  const imageKeys = Object.fromEntries(
    detected.map((image) => [
      image.side,
      `images/certificate-create/${requestHash}/${image.side}.${image.extension}`,
    ])
  ) as Partial<Record<"front" | "back", string>>;
  const requestedStatus = String(certificateData.status ?? "draft");
  const intent: CertificateCreateIntent = {
    actor,
    requestedStatus,
    certificateData,
    imageKeys,
  };
  const writeInput: ObjectWriteInput = {
    idempotencyKey: ledgerKey,
    operationKind: "CERTIFICATE_CREATE_IMAGES",
    aggregateType: "certificate_create",
    aggregateId: requestHash,
    actorId: actor,
    expectedState: { requestHash },
    intentPayload: intent as unknown as Record<string, unknown>,
    items: detected.map((image) => ({
      store: "R2" as const,
      logicalSlot: image.side,
      objectKey: imageKeys[image.side]!,
      priorObjectKey: null,
      body: image.body,
      contentType: image.contentType,
      objectClass: "CANONICAL" as const,
    })),
  };
  const coordinator = new ObjectWriteCoordinator(runner, objectWriteStore, `certificate-create:${actor}`);
  const executed = await coordinator.execute(
    writeInput,
    finalizeCertificateCreateImagesObjectWrite,
    async (client, operationId) => {
      const submissionItemId = certificateData.submissionItemId == null ? null : Number(certificateData.submissionItemId);
      if (submissionItemId != null) {
        const eligible = await client.query(
          `SELECT si.id
             FROM submission_items si
             JOIN submissions s ON s.id=si.submission_id
            WHERE si.id=$1 AND s.deleted_at IS NULL AND s.status <> 'draft'
              AND NOT EXISTS (
                SELECT 1 FROM certificates c
                 WHERE c.submission_item_id=si.id AND c.deleted_at IS NULL
              )`,
          [submissionItemId]
        );
        if (eligible.rowCount !== 1) {
          throw new Error("Submission item not found, already linked, or submission not paid");
        }
      }
      const referenceNumber = generateReferenceNumber();
      const tx = drizzle(client, { schema: { certificates } });
      const certId = await storage.getNextCertId(tx as unknown as SqlExecutor);
      try {
        await tx.insert(certificates).values({
          ...(certificateData as unknown as typeof certificates.$inferInsert),
          certId,
          status: "draft",
          frontImagePath: null,
          backImagePath: null,
          createdBy: actor,
          integrityHash: sha256Hex(`${certId}:${operationId}`),
          referenceNumber,
          objectWriteOperationId: operationId,
          originType: "HQ",
          originPartnerId: null,
          originPartnerPublicRef: null,
          originPartnerLegalName: null,
          originPartnerTradingName: null,
          originLocationId: null,
          originLocationPublicRef: null,
          originLocationName: null,
          originLocationAddress: null,
          originCapturedAt: new Date(),
          originSnapshotVersion: CERTIFICATE_ORIGIN_SNAPSHOT_VERSION,
          logbookVersion: 1,
          logbookLastIssuedAt: new Date(),
        });
      } catch (error) {
        if ((error as { code?: unknown })?.code === "23505") {
          throw new ObjectWriteConflictError("Certificate identity or submission item was concurrently claimed");
        }
        throw error;
      }
    },
    abandonCertificateCreateImagesObjectWrite
  );
  const certificate = await storage.getCertificate(Number(executed.result.certificateId));
  if (!certificate) throw new Error("Committed certificate could not be reloaded");
  return { certificate, operationId: executed.operationId, replayed: executed.replayed };
}
