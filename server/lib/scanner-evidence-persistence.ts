import type { PoolClient } from "pg";
import { hashLockKey } from "./advisory-lock";
import type { ScannerEvidenceInspection } from "./image-evidence";
import {
  ObjectWriteAbandonError,
  ObjectWriteConflictError,
  ObjectWriteCoordinator,
  createPoolTransactionRunner,
  readObjectWriteSnapshot,
  type ObjectStorePort,
  type ObjectWriteFinalizeContext,
  type ObjectWriteTransactionRunner,
} from "./object-write-coordinator";
import { objectWriteStore } from "./object-write-store";

type CaptureSide = "front" | "back";

type CurrentEvidence = {
  id: number;
  object_key: string;
  sha256: string;
  byte_length: string | number;
  evidence_class: string;
  capture_metadata: Record<string, unknown> | string | null;
};

type ScannerEvidenceIntent = {
  certificateId: number;
  side: CaptureSide;
  allowRecapture: boolean;
  inspection: ScannerEvidenceInspection;
  captureMetadata: Record<string, unknown>;
};

export type ScannerEvidencePersistenceDependencies = {
  runner?: ObjectWriteTransactionRunner;
  store?: ObjectStorePort;
  workerId?: string;
};

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value == null) return null;
  return integer(value, label);
}

function parseInspection(value: unknown): ScannerEvidenceInspection {
  const inspection = plainObject(value, "Scanner evidence inspection");
  const evidenceClass = requiredString(inspection.evidenceClass, "Scanner evidence class");
  const sha256 = requiredString(inspection.sha256, "Scanner evidence SHA-256");
  const format = requiredString(inspection.format, "Scanner evidence format");
  const mimeType = requiredString(inspection.mimeType, "Scanner evidence media type");
  const extension = requiredString(inspection.extension, "Scanner evidence extension");
  if (evidenceClass !== "NEW_IMMUTABLE_MASTER" && evidenceClass !== "LEGACY_DERIVED_ONLY") {
    throw new Error("Scanner evidence class is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Scanner evidence SHA-256 is invalid");
  if (format !== "tiff" && format !== "jpeg") throw new Error("Scanner evidence format is invalid");
  if (mimeType !== "image/tiff" && mimeType !== "image/jpeg") {
    throw new Error("Scanner evidence media type is invalid");
  }
  if (extension !== "tif" && extension !== "jpg") throw new Error("Scanner evidence extension is invalid");
  return {
    evidenceClass,
    sha256,
    byteLength: integer(inspection.byteLength, "Scanner evidence byte length"),
    format,
    mimeType,
    extension,
    width: integer(inspection.width, "Scanner evidence width"),
    height: integer(inspection.height, "Scanner evidence height"),
    bitDepth: nullableInteger(inspection.bitDepth, "Scanner evidence bit depth"),
    dpi: nullableInteger(inspection.dpi, "Scanner evidence DPI"),
    channels: nullableInteger(inspection.channels, "Scanner evidence channel count"),
    hasAlpha: inspection.hasAlpha === true,
    colourSpace: optionalString(inspection.colourSpace),
    hasIccProfile: inspection.hasIccProfile === true,
  };
}

function parseIntent(context: ObjectWriteFinalizeContext): ScannerEvidenceIntent {
  if (context.operationKind !== "SCANNER_EVIDENCE_CAPTURE" || context.aggregateType !== "certificate") {
    throw new Error("Scanner evidence object-write authority is invalid");
  }
  const raw = plainObject(context.intentPayload, "Scanner evidence object-write intent");
  const certificateId = integer(raw.certificateId, "Scanner evidence certificate id");
  if (context.aggregateId !== String(certificateId)) {
    throw new Error("Scanner evidence aggregate does not match its intent");
  }
  if (raw.side !== "front" && raw.side !== "back") throw new Error("Scanner evidence side is invalid");
  const inspection = parseInspection(raw.inspection);
  const captureMetadata = plainObject(raw.captureMetadata, "Scanner evidence capture metadata");
  return {
    certificateId,
    side: raw.side,
    allowRecapture: raw.allowRecapture === true,
    inspection,
    captureMetadata,
  };
}

function captureSessionId(metadata: Record<string, unknown>): string | null {
  return optionalString(metadata.captureSessionId);
}

function currentSnapshot(row: CurrentEvidence | undefined): Record<string, unknown> {
  return {
    priorEvidenceId: row?.id ?? null,
    priorObjectKey: row?.object_key ?? null,
    priorSha256: row?.sha256 ?? null,
    priorByteLength: row ? Number(row.byte_length) : null,
    priorEvidenceClass: row?.evidence_class ?? null,
  };
}

function snapshotsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return ["priorEvidenceId", "priorObjectKey", "priorSha256", "priorByteLength", "priorEvidenceClass"].every(
    (key) => (expected[key] ?? null) === (actual[key] ?? null)
  );
}

function metadataObject(value: CurrentEvidence["capture_metadata"]): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return plainObject(JSON.parse(value), "Stored scanner evidence metadata");
    } catch {
      return {};
    }
  }
  return value;
}

function jsonClone(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Publish the immutable evidence row and every local consequence in the same
 * transaction that moves the durable object-write operation to COMMITTED.
 */
export async function finalizeScannerEvidenceCaptureObjectWrite(
  client: PoolClient,
  context: ObjectWriteFinalizeContext
): Promise<Record<string, unknown>> {
  const intent = parseIntent(context);
  const item = context.items[0];
  if (
    context.items.length !== 1 ||
    item.store !== "R2" ||
    item.logicalSlot !== `scanner_${intent.side}_master` ||
    item.objectKey !== requiredString(context.intentPayload.objectKey, "Scanner evidence object key") ||
    item.contentSha256 !== intent.inspection.sha256 ||
    item.byteLength !== intent.inspection.byteLength ||
    item.verificationState !== "VERIFIED"
  ) {
    throw new Error("Scanner evidence object manifest does not match its intent");
  }

  await client.query("SELECT pg_advisory_xact_lock($1)", [
    hashLockKey(`evidence:${intent.certificateId}:${intent.side}`),
  ]);
  const certificate = await client.query<{ certificate_number: string }>(
    `SELECT certificate_number FROM certificates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
    [intent.certificateId]
  );
  if (!certificate.rows[0]) throw new ObjectWriteAbandonError("Scanner evidence certificate is unavailable");

  const selected = await client.query<CurrentEvidence>(
    `SELECT id,object_key,sha256,byte_length,evidence_class,capture_metadata
       FROM certificate_image_evidence
      WHERE certificate_id=$1 AND side=$2 AND is_current=true
      FOR UPDATE`,
    [intent.certificateId, intent.side]
  );
  const current = selected.rows[0];
  if (!snapshotsMatch(context.expectedState, currentSnapshot(current))) {
    throw new ObjectWriteAbandonError("Current scanner evidence changed before immutable publication");
  }

  const sessionId = captureSessionId(intent.captureMetadata);
  const exactReplay =
    current?.object_key === item.objectKey &&
    current.sha256 === item.contentSha256 &&
    Number(current.byte_length) === item.byteLength &&
    current.evidence_class === intent.inspection.evidenceClass;
  let evidenceId: number;
  if (exactReplay) {
    const storedSession = captureSessionId(metadataObject(current.capture_metadata));
    if (sessionId && storedSession !== sessionId) {
      throw new ObjectWriteAbandonError("Identical scanner bytes are already bound to another capture session");
    }
    evidenceId = current.id;
  } else {
    if (current && !intent.allowRecapture) {
      throw new ObjectWriteAbandonError(`Refusing to replace existing ${intent.side} scanner evidence`);
    }
    const duplicate = await client.query<{ id: number }>(
      "SELECT id FROM certificate_image_evidence WHERE object_key=$1 FOR UPDATE",
      [item.objectKey]
    );
    if (duplicate.rows.length) {
      throw new ObjectWriteAbandonError("Scanner evidence object is already bound to a historical revision");
    }
    if (current) {
      await client.query(
        "UPDATE certificate_image_evidence SET is_current=false,superseded_at=NOW() WHERE id=$1",
        [current.id]
      );
    }
    const metadata = {
      channels: intent.inspection.channels,
      colourSpace: intent.inspection.colourSpace,
      hasAlpha: intent.inspection.hasAlpha,
      hasIccProfile: intent.inspection.hasIccProfile,
      ...intent.captureMetadata,
      objectWriteOperationId: context.operationId,
    };
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO certificate_image_evidence
        (certificate_id,side,evidence_class,evidence_version,object_key,sha256,byte_length,
         pixel_width,pixel_height,bit_depth,dpi,format,capture_metadata,is_current)
       VALUES ($1,$2,$3,'v2',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,true)
       RETURNING id`,
      [
        intent.certificateId,
        intent.side,
        intent.inspection.evidenceClass,
        item.objectKey,
        intent.inspection.sha256,
        intent.inspection.byteLength,
        intent.inspection.width,
        intent.inspection.height,
        intent.inspection.bitDepth,
        intent.inspection.dpi,
        intent.inspection.format,
        JSON.stringify(metadata),
      ]
    );
    evidenceId = inserted.rows[0].id;
    if (current) {
      await client.query("UPDATE certificate_image_evidence SET superseded_by_id=$1 WHERE id=$2", [
        evidenceId,
        current.id,
      ]);
    }
  }

  await client.query(
    `UPDATE certificates
        SET archived_to_b2_at=NULL,raw_uploaded=true,scan_status='processing',updated_at=NOW()
      WHERE id=$1 AND deleted_at IS NULL`,
    [intent.certificateId]
  );

  const stationId = optionalString(intent.captureMetadata.stationId);
  if (sessionId) {
    const session = await client.query(
      `UPDATE scanner_capture_sessions
          SET state='captured',captured_at=COALESCE(captured_at,NOW()),failure_reason=NULL
        WHERE id=$1 AND certificate_id=$2 AND side=$3
        RETURNING id`,
      [sessionId, intent.certificateId, intent.side]
    );
    if (session.rowCount !== 1) {
      throw new ObjectWriteAbandonError("Scanner capture session no longer matches the immutable evidence intent");
    }
  }
  const stagingId = optionalString(intent.captureMetadata.stagingId);
  if (stagingId) {
    const staging = await client.query(
      `UPDATE scanner_evidence_staging
          SET state='accepted',accepted_at=COALESCE(accepted_at,NOW()),updated_at=NOW(),
              failure_reason=NULL,finalizing_at=NULL
        WHERE id=$1 AND capture_session_id=$2 AND object_key IS NOT NULL
        RETURNING id`,
      [stagingId, sessionId]
    );
    if (!sessionId || staging.rowCount !== 1) {
      throw new ObjectWriteAbandonError("Scanner staging reservation no longer matches the immutable evidence intent");
    }
  }

  await client.query(
    `INSERT INTO scanner_processing_jobs(certificate_id,station_id,job_kind,state,available_at)
     VALUES ($1,$2,'scanner_derivatives','queued',NOW())
     ON CONFLICT (certificate_id,job_kind) WHERE state IN ('queued','running','retry')
     DO UPDATE SET
       station_id=COALESCE(EXCLUDED.station_id,scanner_processing_jobs.station_id),
       rerun_requested=scanner_processing_jobs.rerun_requested OR scanner_processing_jobs.state='running',
       state=CASE WHEN scanner_processing_jobs.state='running' THEN 'running' ELSE 'queued' END,
       available_at=CASE WHEN scanner_processing_jobs.state='running' THEN scanner_processing_jobs.available_at ELSE NOW() END,
       updated_at=NOW(),
       last_error=CASE WHEN scanner_processing_jobs.state='running' THEN scanner_processing_jobs.last_error ELSE NULL END`,
    [intent.certificateId, stationId]
  );

  const auditDetails = {
    capture_session_id: sessionId,
    side: intent.side,
    card_id: intent.captureMetadata.cardId ?? null,
    submission_item_id: intent.captureMetadata.submissionItemId ?? null,
    submission_id: intent.captureMetadata.submissionId ?? null,
    workstation_id: intent.captureMetadata.workstationId ?? null,
    station_id: stationId,
    tenant_id: intent.captureMetadata.tenantId ?? null,
    location_id: intent.captureMetadata.locationId ?? null,
    actor_id: intent.captureMetadata.actorId ?? null,
    scanner_device_id: intent.captureMetadata.scannerDeviceId ?? null,
    scanner_model: intent.captureMetadata.scannerModel ?? null,
    scanner_profile_version: intent.captureMetadata.profileVersion ?? null,
    sha256: intent.inspection.sha256,
    recapture: intent.allowRecapture,
    object_write_operation_id: context.operationId,
  };
  await client.query(
    `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details,created_at)
     SELECT 'certificate',$1,'scanner_capture_accepted','scanner',$2::jsonb,NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log
         WHERE entity_type='certificate' AND entity_id=$1
           AND action='scanner_capture_accepted'
           AND details ->> 'object_write_operation_id'=$3
      )`,
    [String(intent.certificateId), JSON.stringify(auditDetails), context.operationId]
  );

  return {
    certificateId: intent.certificateId,
    certificateNumber: certificate.rows[0].certificate_number,
    evidenceId,
    side: intent.side,
    objectKey: item.objectKey,
    sha256: item.contentSha256,
  };
}

export async function persistScannerEvidenceCapture(
  input: {
    certificateId: number;
    side: CaptureSide;
    body: Buffer;
    inspection: ScannerEvidenceInspection;
    allowRecapture: boolean;
    captureMetadata: Record<string, unknown>;
  },
  dependencies: ScannerEvidencePersistenceDependencies = {}
): Promise<{ objectKey: string; operationId: string; replayed: boolean }> {
  if (!Buffer.isBuffer(input.body) || input.body.length !== input.inspection.byteLength) {
    throw new Error("Scanner evidence bytes do not match their inspection");
  }
  const runner =
    dependencies.runner ?? createPoolTransactionRunner((await import("../db")).pool);
  const captureMetadata = jsonClone(input.captureMetadata);
  const sessionId = captureSessionId(captureMetadata);
  const idempotencyKey = sessionId
    ? `scanner-evidence:${sessionId}:${input.side}`
    : `scanner-evidence:${input.certificateId}:${input.side}:${input.inspection.sha256}`;
  const baseline = await runner.transaction(async (client) => {
    const operation = await readObjectWriteSnapshot(client, optionalString(captureMetadata.tenantId), idempotencyKey);
    const current = await client.query<CurrentEvidence>(
      `SELECT id,object_key,sha256,byte_length,evidence_class,capture_metadata
         FROM certificate_image_evidence
        WHERE certificate_id=$1 AND side=$2 AND is_current=true`,
      [input.certificateId, input.side]
    );
    return { operation, current: current.rows[0] };
  });
  const prior = baseline.current;
  if (prior && !input.allowRecapture) {
    const priorSession = captureSessionId(metadataObject(prior.capture_metadata));
    const exactReplay =
      prior.object_key.endsWith(`/${input.inspection.sha256}.${input.inspection.extension}`) &&
      prior.sha256 === input.inspection.sha256 &&
      Number(prior.byte_length) === input.inspection.byteLength &&
      (!sessionId || priorSession === sessionId);
    if (!exactReplay) throw new ObjectWriteConflictError(`Refusing to replace existing ${input.side} scanner evidence`);
  }
  const objectKey =
    input.inspection.evidenceClass === "NEW_IMMUTABLE_MASTER"
      ? `evidence/masters/${input.certificateId}/${input.side}/${input.inspection.sha256}.tif`
      : `evidence/legacy/${input.certificateId}/${input.side}/${input.inspection.sha256}.jpg`;
  const coordinator = new ObjectWriteCoordinator(
    runner,
    dependencies.store ?? objectWriteStore,
    dependencies.workerId ?? `scanner-evidence:${process.pid}`
  );
  const result = await coordinator.execute(
    {
      tenantId: optionalString(captureMetadata.tenantId),
      idempotencyKey,
      operationKind: "SCANNER_EVIDENCE_CAPTURE",
      aggregateType: "certificate",
      aggregateId: String(input.certificateId),
      actorId: optionalString(captureMetadata.actorId) ?? "scanner",
      expectedState: baseline.operation?.expectedState ?? currentSnapshot(prior),
      intentPayload: {
        certificateId: input.certificateId,
        side: input.side,
        allowRecapture: input.allowRecapture,
        objectKey,
        inspection: input.inspection,
        captureMetadata,
      },
      items: [
        {
          store: "R2",
          logicalSlot: `scanner_${input.side}_master`,
          objectKey,
          priorObjectKey: baseline.operation
            ? (baseline.operation.items[0]?.priorObjectKey ?? null)
            : (prior?.object_key ?? null),
          body: input.body,
          contentType: input.inspection.mimeType,
          objectClass: "CANONICAL",
        },
      ],
    },
    finalizeScannerEvidenceCaptureObjectWrite
  );
  return { objectKey, operationId: result.operationId, replayed: result.replayed };
}
