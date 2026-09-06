import type { PoolClient } from "pg";
import type { CertificateRecord, LabelOverride } from "@shared/schema";
import { nextState, type BatchKind, type PrintRole, type PrintState } from "@shared/print-lifecycle";
import { applyLabelOverrides } from "../labels";
import {
  ObjectWriteAbandonError,
  canonicalJson,
  sha256Hex,
  type ObjectWriteFinalizeContext,
} from "./object-write-coordinator";
import { printArtifactPlan, type PrintBatchItem } from "../print-batch";
import { currentPrintOutputBlock } from "./print-output-eligibility";

export interface PrintArtifactIntent {
  batchId: string;
  certIds: string[];
  kind: BatchKind;
  actor: string;
  actorRole: PrintRole;
  reason: string | null;
  reasonCategory: string | null;
  notes: string | null;
  layoutVersion: string;
  renderInputSha256: string;
  fromStates: Record<string, PrintState>;
  artifactKeys: Record<string, string>;
  reprintRequest?: {
    originalStates: Record<string, PrintState>;
    reason: string;
    reasonCategory: string | null;
  };
}

export interface LoadedPrintRenderInputs {
  items: PrintBatchItem[];
  renderInputSha256: string;
}

export class PrintReservationConflictError extends Error {
  readonly code = "PRINT_RESERVATION_CONFLICT";
  constructor(readonly certId: string) {
    super(`Certificate ${certId} was reserved by another print operation`);
  }
}

interface RawCertificateRow {
  cert: Record<string, unknown>;
  claim_code: string | null;
}

interface RawOverrideRow {
  cert_id: string;
  card_name_override: string | null;
  set_override: string | null;
  variant_override: string | null;
  language_override: string | null;
  year_override: string | null;
  edited_at: Date | string;
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
  };
  if (aliases[key]) return aliases[key];
  return key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function camelRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [camelKey(key), value]));
}

function overrideRecord(row: RawOverrideRow | undefined): LabelOverride | null {
  if (!row) return null;
  return {
    id: 0,
    certId: row.cert_id,
    cardNameOverride: row.card_name_override,
    setOverride: row.set_override,
    variantOverride: row.variant_override,
    languageOverride: row.language_override,
    yearOverride: row.year_override,
    editedAt: new Date(row.edited_at),
  };
}

function renderCertificateProjection(cert: CertificateRecord): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(cert)) as Record<string, unknown>;
  // These fields are workflow bookkeeping and are not read by the renderer.
  // Reservation intentionally changes them after rendering and before final CAS.
  delete plain.printState;
  delete plain.updatedAt;
  delete plain.lastPrintedAt;
  delete plain.claimCode;
  delete plain.claim_code;
  return plain;
}

function overrideProjection(override: LabelOverride | null): Record<string, unknown> | null {
  if (!override) return null;
  return {
    cardNameOverride: override.cardNameOverride,
    setOverride: override.setOverride,
    variantOverride: override.variantOverride,
    languageOverride: override.languageOverride,
    yearOverride: override.yearOverride,
  };
}

export async function loadPrintRenderInputs(
  client: PoolClient,
  certIds: string[],
  options: { lock?: boolean } = {}
): Promise<LoadedPrintRenderInputs> {
  const ordered = [...certIds];
  const lockOrder = [...ordered].sort();
  if (options.lock) {
    await client.query(
      `SELECT certificate_number FROM certificates
        WHERE certificate_number=ANY($1::text[])
        ORDER BY certificate_number FOR UPDATE`,
      [lockOrder]
    );
  }
  const certRows = await client.query<RawCertificateRow>(
    `SELECT (to_jsonb(c)-'claim_code') AS cert,c.claim_code
       FROM certificates c
      WHERE c.certificate_number=ANY($1::text[])`,
    [ordered]
  );
  if (certRows.rowCount !== ordered.length) throw new Error("A print render certificate disappeared");

  if (options.lock) {
    await client.query(
      `SELECT cert_id FROM label_overrides
        WHERE cert_id=ANY($1::text[])
        ORDER BY cert_id FOR UPDATE`,
      [lockOrder]
    );
  }
  const overrideRows = await client.query<RawOverrideRow>(
    `SELECT cert_id,card_name_override,set_override,variant_override,
            language_override,year_override,edited_at
       FROM label_overrides WHERE cert_id=ANY($1::text[])`,
    [ordered]
  );
  const certById = new Map(
    certRows.rows.map((row) => {
      const cert = camelRecord(row.cert) as unknown as CertificateRecord;
      return [String(cert.certId), { cert, claimCode: row.claim_code }] as const;
    })
  );
  const overrideById = new Map(overrideRows.rows.map((row) => [row.cert_id, overrideRecord(row)] as const));
  const items: PrintBatchItem[] = [];
  const fingerprint: Array<Record<string, unknown>> = [];
  for (const certId of ordered) {
    const found = certById.get(certId);
    if (!found) throw new Error(`Certificate not found while rendering: ${certId}`);
    if (!found.claimCode) throw new Error(`Certificate ${certId} has no claim code for rendering`);
    const override = overrideById.get(certId) ?? null;
    const effective = applyLabelOverrides(found.cert, override);
    items.push({ cert: effective, claimCode: found.claimCode });
    fingerprint.push({
      certId,
      certificate: renderCertificateProjection(effective),
      override: overrideProjection(override),
      claimCodeSha256: sha256Hex(found.claimCode),
    });
  }
  return { items, renderInputSha256: sha256Hex(canonicalJson(fingerprint)) };
}

export async function preparePrintArtifactReservation(
  client: PoolClient,
  operationId: string,
  intent: PrintArtifactIntent
): Promise<void> {
  await client.query(
    `INSERT INTO print_batches
       (batch_id,kind,status,cert_ids,cert_count,created_by,created_by_role,
        reason,reason_category,layout_version,notes)
     VALUES ($1,$2,'rendering',$3::jsonb,$4,$5,$6,$7,$8,$9,$10)`,
    [
      intent.batchId,
      intent.kind,
      JSON.stringify(intent.certIds),
      intent.certIds.length,
      intent.actor,
      intent.actorRole,
      intent.reason,
      intent.reasonCategory,
      intent.layoutVersion,
      intent.notes,
    ]
  );
  if (intent.reprintRequest) {
    for (const certId of [...intent.certIds].sort()) {
      const original = intent.reprintRequest.originalStates[certId];
      if (!original || !nextState(original, "reprint", { hasReason: true }).ok) {
        throw new Error(`Certificate ${certId} is not eligible for the requested reprint`);
      }
      const requested = await client.query(
        `UPDATE certificates SET print_state='reprint_required',updated_at=NOW()
          WHERE certificate_number=$1 AND print_state=$2
          RETURNING certificate_number`,
        [certId, original]
      );
      if (requested.rowCount !== 1) throw new PrintReservationConflictError(certId);
      await client.query(
        `INSERT INTO print_events
           (cert_id,batch_id,actor,actor_role,action,from_state,to_state,reason,reason_category)
         VALUES ($1,$2,$3,$4,'reprint',$5,'reprint_required',$6,$7)`,
        [
          certId,
          intent.batchId,
          intent.actor,
          intent.actorRole,
          original,
          intent.reprintRequest.reason,
          intent.reprintRequest.reasonCategory,
        ]
      );
      await client.query(`INSERT INTO reprint_log(cert_id) VALUES ($1)`, [certId]);
    }
  }
  for (const certId of [...intent.certIds].sort()) {
    const from = intent.fromStates[certId];
    if (!from || !nextState(from, "create_batch").ok) throw new Error(`Certificate ${certId} is not batchable`);
    const claimed = await client.query(
      `UPDATE certificates SET print_state='printing',updated_at=now()
        WHERE certificate_number=$1
          AND (
            print_state=$2
            OR ($2='needs_printing' AND print_state='awaiting_approval' AND grade_approved_at IS NOT NULL)
          )
        RETURNING certificate_number`,
      [certId, from]
    );
    if (claimed.rowCount !== 1) throw new PrintReservationConflictError(certId);
    await client.query(
      `INSERT INTO print_events
         (cert_id,batch_id,actor,actor_role,action,from_state,to_state,reason,reason_category)
       VALUES ($1,$2,$3,$4,'create_batch',$5,'printing',$6,$7)`,
      [certId, intent.batchId, intent.actor, intent.actorRole, from, intent.reason, intent.reasonCategory]
    );
  }
  await client.query(
    `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details)
     VALUES ('system',$1,'print_batch_prepared',$2,$3::jsonb)`,
    [
      `print_batch_${intent.batchId}`,
      intent.actor,
      JSON.stringify({ operationId, certIds: intent.certIds, renderInputSha256: intent.renderInputSha256 }),
    ]
  );
}

function parseIntent(context: ObjectWriteFinalizeContext): PrintArtifactIntent {
  const payload = context.intentPayload as unknown as Partial<PrintArtifactIntent>;
  if (
    context.operationKind !== "PRINT_ARTIFACT" ||
    context.aggregateType !== "print_batch" ||
    typeof payload.batchId !== "string" ||
    context.aggregateId !== payload.batchId ||
    !Array.isArray(payload.certIds) ||
    payload.certIds.some((id) => typeof id !== "string") ||
    (payload.kind !== "batch" && payload.kind !== "reprint") ||
    typeof payload.actor !== "string" ||
    context.actorId !== payload.actor ||
    (payload.actorRole !== "admin" && payload.actorRole !== "staff_print" && payload.actorRole !== "staff_readonly") ||
    typeof payload.layoutVersion !== "string" ||
    typeof payload.renderInputSha256 !== "string" ||
    !payload.fromStates ||
    !payload.artifactKeys ||
    (payload.reprintRequest != null &&
      (typeof payload.reprintRequest !== "object" ||
        typeof payload.reprintRequest.reason !== "string" ||
        !payload.reprintRequest.originalStates))
  ) {
    throw new Error("PRINT_ARTIFACT intent is malformed");
  }
  return payload as PrintArtifactIntent;
}

export async function finalizePrintArtifactObjectWrite(
  client: PoolClient,
  context: ObjectWriteFinalizeContext
): Promise<Record<string, unknown>> {
  const intent = parseIntent(context);
  const batch = await client.query<{ status: string; kind: string; cert_ids: string[]; created_by: string }>(
    `SELECT status,kind,cert_ids,created_by FROM print_batches WHERE batch_id=$1 FOR UPDATE`,
    [intent.batchId]
  );
  if (
    batch.rowCount !== 1 ||
    batch.rows[0].status !== "rendering" ||
    batch.rows[0].kind !== intent.kind ||
    batch.rows[0].created_by !== intent.actor ||
    canonicalJson(batch.rows[0].cert_ids) !== canonicalJson(intent.certIds)
  ) {
    throw new ObjectWriteAbandonError("Print batch reservation changed before artifact publication");
  }

  let current: LoadedPrintRenderInputs;
  try {
    current = await loadPrintRenderInputs(client, intent.certIds, { lock: true });
  } catch {
    throw new ObjectWriteAbandonError("Print render inputs disappeared before artifact publication");
  }
  if (current.renderInputSha256 !== intent.renderInputSha256) {
    throw new ObjectWriteAbandonError("Print render inputs changed before artifact publication");
  }
  for (const item of current.items) {
    const cert = item.cert;
    const block = currentPrintOutputBlock(cert.certId, cert);
    if (block) throw new ObjectWriteAbandonError(block.message);
    if (intent.kind === "batch" && cert.ownershipStatus !== "unclaimed") {
      throw new ObjectWriteAbandonError(`Certificate ${cert.certId} became claimed before publication`);
    }
  }

  const plan = printArtifactPlan(intent.certIds.length);
  const expectedSlots = plan.pdfOnly ? ["pdf"] : ["cricut-png", "cricut-svg", "pdf", "print-png"];
  const actualSlots = context.items.map((item) => item.logicalSlot).sort();
  if (canonicalJson(actualSlots) !== canonicalJson(expectedSlots)) throw new Error("Print artifact set is incomplete");
  const descriptors = context.items.map((item) => {
    if (
      item.store !== "R2" ||
      item.verificationState !== "VERIFIED" ||
      item.objectClass !== "PRINT" ||
      item.required !== true ||
      item.priorObjectKey !== null ||
      intent.artifactKeys[item.logicalSlot] !== item.objectKey
    ) {
      throw new Error(`Print artifact ${item.logicalSlot} is not verified against its manifest`);
    }
    return {
      operationId: context.operationId,
      logicalSlot: item.logicalSlot,
      store: item.store,
      key: item.objectKey,
      sha256: item.contentSha256,
      byteLength: item.byteLength,
      contentType: item.contentType,
    };
  });

  await client.query(
    `INSERT INTO label_prints(cert_id,sheet_ref,printed_at)
     SELECT unnest($1::text[]),$2,NULL
     ON CONFLICT (cert_id) DO UPDATE SET sheet_ref=EXCLUDED.sheet_ref,printed_at=NULL,queued_at=now()`,
    [intent.certIds, `print_batch_${intent.batchId}`]
  );
  await client.query(
    `UPDATE print_batches SET status='printing',success_count=$2,failure_count=0 WHERE batch_id=$1`,
    [intent.batchId, intent.certIds.length]
  );
  const auditRows = intent.reprintRequest
    ? intent.certIds.map((certId) => ({ certId, ok: true as const }))
    : undefined;
  if (intent.reprintRequest) {
    await client.query(
      `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details)
       SELECT 'cert',cert_id,'reprint',$2,$3::jsonb
         FROM unnest($1::text[]) AS cert_id`,
      [
        intent.certIds,
        intent.actor,
        JSON.stringify({
          reason: intent.reprintRequest.reason,
          reason_category: intent.reprintRequest.reasonCategory,
          batch_id: intent.batchId,
          original_batch_id: null,
          new_batch_id: `print_batch_${intent.batchId}`,
          cert_count: intent.certIds.length,
          sheet_layout_version: intent.layoutVersion,
          operation_id: context.operationId,
          actor_role: intent.actorRole,
        }),
      ]
    );
  }
  await client.query(
    `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details)
     VALUES ('system',$1,'print_batch_generated',$2,$3::jsonb)`,
    [
      `print_batch_${intent.batchId}`,
      intent.actor,
      JSON.stringify({
        operationId: context.operationId,
        certIds: intent.certIds,
        kind: intent.kind,
        reason: intent.reason,
        reasonCategory: intent.reasonCategory,
        renderInputSha256: intent.renderInputSha256,
        layoutVersion: intent.layoutVersion,
        artifacts: descriptors,
      }),
    ]
  );
  return {
    batchId: intent.batchId,
    kind: intent.kind,
    applied: intent.certIds,
    rejected: [],
    pdfUrl: `/api/admin/print-batch/${intent.batchId}/pdf`,
    isDuplicate: false,
    pdfOnly: plan.pdfOnly,
    isPdfMultiPage: plan.isPdfMultiPage,
    multiSheet: plan.pdfOnly,
    pageCount: plan.pageCount,
    artifacts: descriptors,
    ...(auditRows ? { auditRows } : {}),
  };
}

/** Restore the exact pre-reservation states in the same transaction that marks
 * PRINT_ARTIFACT abandoned. This is safe to retry until the operation becomes
 * terminal and never releases a certificate that has since left `printing`. */
export async function abandonPrintArtifactObjectWrite(
  client: PoolClient,
  context: ObjectWriteFinalizeContext,
  reason: { code: string; detail: string }
): Promise<void> {
  const intent = parseIntent(context);
  const batch = await client.query<{ status: string }>(
    `SELECT status FROM print_batches WHERE batch_id=$1 FOR UPDATE`,
    [intent.batchId]
  );
  if (batch.rowCount !== 1) return;
  for (const certId of [...intent.certIds].sort()) {
    const fromState = intent.fromStates[certId];
    if (!fromState) throw new Error(`PRINT_ARTIFACT abandonment has no prior state for ${certId}`);
    const restored = await client.query(
      `UPDATE certificates SET print_state=$2,updated_at=NOW()
        WHERE certificate_number=$1 AND print_state='printing'
        RETURNING certificate_number`,
      [certId, fromState]
    );
    if (restored.rowCount === 1) {
      await client.query(
        `INSERT INTO print_events
           (cert_id,batch_id,actor,actor_role,action,from_state,to_state,reason,reason_category)
         VALUES ($1,$2,'system','admin','create_batch','printing',$3,$4,'object_write_abandoned')`,
        [certId, intent.batchId, fromState, reason.detail]
      );
    }
  }
  await client.query(
    `UPDATE print_batches
        SET status='failed',failure_count=cert_count
      WHERE batch_id=$1 AND status='rendering'`,
    [intent.batchId]
  );
  await client.query(
    `INSERT INTO audit_log(entity_type,entity_id,action,admin_user,details)
     VALUES ('system',$1,'print_batch_abandoned','system',$2::jsonb)`,
    [
      `print_batch_${intent.batchId}`,
      JSON.stringify({ operationId: context.operationId, code: reason.code, detail: reason.detail }),
    ]
  );
}

export async function resolveCommittedPrintArtifactKey(
  queryable: { query<T extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
  batchId: string,
  logicalSlot: "pdf" | "cricut-png" | "print-png" | "cricut-svg"
): Promise<{ operationExists: boolean; key: string | null }> {
  let operation: { rows: Array<{ id: string; state: string }> };
  try {
    operation = await queryable.query<{ id: string; state: string }>(
      `SELECT id::text,state FROM object_write_operations
        WHERE tenant_id IS NULL AND idempotency_key=$1
          AND operation_kind='PRINT_ARTIFACT' AND aggregate_type='print_batch' AND aggregate_id=$2`,
      [`print-artifact:${batchId}`, batchId]
    );
  } catch (error) {
    if ((error as { code?: unknown })?.code === "42P01") return { operationExists: false, key: null };
    throw error;
  }
  if (operation.rows.length === 0) return { operationExists: false, key: null };
  if (operation.rows[0].state !== "COMMITTED") return { operationExists: true, key: null };
  const item = await queryable.query<{ object_key: string }>(
    `SELECT object_key FROM object_write_items
      WHERE operation_id=$1 AND store='R2' AND logical_slot=$2
        AND required AND verification_state='VERIFIED'`,
    [operation.rows[0].id, logicalSlot]
  );
  return { operationExists: true, key: item.rows[0]?.object_key ?? null };
}
