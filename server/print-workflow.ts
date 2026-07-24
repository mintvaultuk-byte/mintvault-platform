/**
 * print-workflow.ts — service layer for the Approval → Printing → Printed
 * lifecycle. Owns the durable STATE (certificates.print_state), the batch
 * records (print_batches), and the append-only audit ledger (print_events).
 *
 * It deliberately does NOT render PDFs — the existing, proven print-batch.ts
 * renderer (invoked via the existing /api/admin/print-batch route) produces the
 * bytes. This module reuses the same deterministic batchId so the two line up.
 *
 * Every state transition here is decided by the pure state machine in
 * shared/print-lifecycle.ts and persisted TRANSACTIONALLY and FAIL-LOUD — the
 * opposite of the legacy best-effort print writes (finding B-2). Actor identity
 * resolves admin OR staff correctly (fixes attribution finding B-3).
 */
import type { Request } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import {
  effectivePrintState,
  nextState,
  isValidReprintReason,
  isReprintReasonCategory,
  type PrintState,
  type PrintRole,
  type PrintAction,
  type BatchKind,
} from "@shared/print-lifecycle";
import type { PrintQueueRow, PrintBatchSummary, PrintEvent } from "@shared/schema";

// ── Boot-time idempotent schema migration ────────────────────────────────────
// Mirrors the established certificates-column pattern (migratePerOperatorSchema):
// ADD COLUMN IF NOT EXISTS + CREATE TABLE/INDEX IF NOT EXISTS + a one-time audit
// row. Additive only; safe to run on every boot. Wired into the boot sequence in
// server/routes.ts alongside the other migrate*Schema() calls.
export async function migratePrintWorkflowSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE certificates
      ADD COLUMN IF NOT EXISTS print_state VARCHAR(24) NOT NULL DEFAULT 'awaiting_approval'
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_certificates_print_state ON certificates (print_state)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS print_batches (
      id              SERIAL PRIMARY KEY,
      batch_id        TEXT NOT NULL UNIQUE,
      kind            VARCHAR(12) NOT NULL DEFAULT 'batch',
      status          VARCHAR(12) NOT NULL DEFAULT 'open',
      cert_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
      cert_count      INTEGER NOT NULL DEFAULT 0,
      success_count   INTEGER NOT NULL DEFAULT 0,
      failure_count   INTEGER NOT NULL DEFAULT 0,
      created_by      TEXT,
      created_by_role VARCHAR(16),
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      printed_at      TIMESTAMP,
      notes           TEXT,
      reason          TEXT,
      reason_category VARCHAR(24),
      layout_version  TEXT
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_print_batches_status ON print_batches (status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_print_batches_created_at ON print_batches (created_at)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS print_events (
      id              SERIAL PRIMARY KEY,
      cert_id         TEXT NOT NULL,
      batch_id        TEXT,
      actor           TEXT NOT NULL,
      actor_role      VARCHAR(16),
      action          VARCHAR(24) NOT NULL,
      from_state      VARCHAR(24),
      to_state        VARCHAR(24),
      reason          TEXT,
      reason_category VARCHAR(24),
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_print_events_cert ON print_events (cert_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_print_events_batch ON print_events (batch_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_print_events_created_at ON print_events (created_at)`);

  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
    SELECT 'schema', 'print_workflow', 'print_workflow_schema_migrate', NULL,
           ${{
             certificates: ["print_state"],
             tables: ["print_batches", "print_events"],
           }}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'print_workflow_schema_migrate')
  `);
}

// ── Actor / role resolution ──────────────────────────────────────────────────

export interface ActorIdentity {
  actor: string;
  role: PrintRole;
}

/**
 * Resolve WHO is acting and their print role. Admin session → admin. A staffer
 * reaching an admin handler via the can_print proxy (__graderProxy set) → their
 * staff email + staff_print. Falls back to the literal "admin" only if nothing
 * resolves (never silently mis-attributes to admin when a staff email exists).
 */
export function resolveActor(req: Request): ActorIdentity {
  const s = req.session as any;
  const isProxiedStaff = (req as any).__graderProxy === true;
  if (isProxiedStaff && s?.staffEmail) {
    return { actor: String(s.staffEmail), role: "staff_print" };
  }
  if (s?.adminEmail) {
    return { actor: String(s.adminEmail), role: "admin" };
  }
  if (s?.staffEmail) {
    // Staff without the print proxy — read-only surfaces only.
    return { actor: String(s.staffEmail), role: "staff_readonly" };
  }
  return { actor: "admin", role: "admin" };
}

/**
 * The batchId string the existing /api/admin/print-batch renderer would derive
 * for this request MUST use the same admin-user expression the renderer uses
 * (`adminEmail || "admin"`), so the persisted record lines up with the rendered
 * artefacts. Attribution (created_by) uses resolveActor instead — the two are
 * intentionally separate concerns.
 */
export function renderAdminUser(req: Request): string {
  return (req.session as any)?.adminEmail || "admin";
}

// ── Queue read ───────────────────────────────────────────────────────────────

interface RawQueueRow {
  certificate_number: string;
  print_state: string;
  grade_approved_at: string | null;
  grade_approved_by: string | null;
  card_name: string | null;
  card_game: string | null;
  set_name: string | null;
  card_number_display: string | null;
  grade: string | null;
  owner_name: string | null;
  owner_email: string | null;
  front_image_path: string | null;
  printed_at: string | null;
  submission_id: number | null;
  tracking_number: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  batch_id: string | null;
  reprint_count: number | string | null;
}

export async function listPrintQueue(limit = 2000): Promise<PrintQueueRow[]> {
  const result = await db.execute(sql`
    SELECT
      c.certificate_number,
      c.print_state,
      c.grade_approved_at,
      c.grade_approved_by,
      c.card_name,
      c.card_game,
      c.set_name,
      c.card_number_display,
      c.grade,
      c.owner_name,
      c.owner_email,
      c.front_image_path,
      lp.printed_at,
      s.id                  AS submission_id,
      s.tracking_number,
      s.customer_first_name,
      s.customer_last_name,
      s.customer_email,
      (
        SELECT pe.batch_id FROM print_events pe
        WHERE pe.cert_id = c.certificate_number AND pe.batch_id IS NOT NULL
        ORDER BY pe.created_at DESC LIMIT 1
      )                     AS batch_id,
      (SELECT COUNT(*) FROM reprint_log rl WHERE rl.cert_id = c.certificate_number) AS reprint_count
    FROM certificates c
    LEFT JOIN label_prints lp     ON lp.cert_id = c.certificate_number
    LEFT JOIN submission_items si ON si.id = c.submission_item_id
    LEFT JOIN cards cd            ON cd.id = c.card_id
    LEFT JOIN submissions s       ON s.id = COALESCE(si.submission_id, cd.submission_id)
    WHERE c.deleted_at IS NULL AND c.status <> 'voided'
    ORDER BY c.grade_approved_at DESC NULLS LAST, c.issued_at DESC
    LIMIT ${limit}
  `);

  return (result.rows as unknown as RawQueueRow[]).map((r) => {
    const approved = r.grade_approved_at !== null;
    const state = effectivePrintState({ storedState: r.print_state as PrintState, approved });
    const customerName =
      r.owner_name ||
      [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ").trim() ||
      null;
    return {
      certId: r.certificate_number,
      state,
      cardName: r.card_name,
      cardGame: r.card_game,
      setName: r.set_name,
      cardNumber: r.card_number_display,
      gradeOverall: r.grade,
      customerName,
      customerEmail: r.owner_email || r.customer_email,
      submissionId: r.submission_id,
      trackingNumber: r.tracking_number,
      approvedAt: r.grade_approved_at,
      approvedBy: r.grade_approved_by,
      printedAt: r.printed_at,
      batchId: r.batch_id,
      reprintCount: Number(r.reprint_count ?? 0),
      // Existence signals for the operator. certificateExists is always true (this
      // IS a cert row). labelExists = we have front imagery to render a label from.
      // pdfExists = a batch has been generated for this cert (its PDF is at the R2
      // key for batch_id; the /print-batch/:id/pdf endpoint serves it on demand).
      certificateExists: true,
      labelExists: !!r.front_image_path,
      pdfExists: !!r.batch_id,
    };
  });
}

// ── Batch + event reads ──────────────────────────────────────────────────────

interface RawBatchRow {
  batch_id: string;
  kind: string;
  status: string;
  cert_ids?: string[];
  cert_count: number | string;
  success_count: number | string;
  failure_count: number | string;
  created_by: string | null;
  created_by_role: string | null;
  created_at: string;
  printed_at: string | null;
  notes: string | null;
  reason: string | null;
  reason_category: string | null;
}

export async function listBatches(limit = 200): Promise<PrintBatchSummary[]> {
  const result = await db.execute(sql`
    SELECT batch_id, kind, status, cert_count, success_count, failure_count,
           created_by, created_by_role, created_at, printed_at, notes, reason, reason_category
    FROM print_batches
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return (result.rows as unknown as RawBatchRow[]).map(mapBatchSummary);
}

export async function getBatchDetail(
  batchId: string
): Promise<{ batch: PrintBatchSummary; certIds: string[]; events: PrintEvent[] } | null> {
  const b = await db.execute(sql`SELECT * FROM print_batches WHERE batch_id = ${batchId} LIMIT 1`);
  if (b.rows.length === 0) return null;
  const row = b.rows[0] as unknown as RawBatchRow;
  const events = await db.execute(sql`
    SELECT * FROM print_events WHERE batch_id = ${batchId} ORDER BY created_at ASC
  `);
  return {
    batch: mapBatchSummary(row),
    certIds: row.cert_ids ?? [],
    events: events.rows as unknown as PrintEvent[],
  };
}

export async function listCertEvents(certId: string, limit = 200): Promise<PrintEvent[]> {
  const result = await db.execute(sql`
    SELECT * FROM print_events WHERE cert_id = ${certId} ORDER BY created_at DESC LIMIT ${limit}
  `);
  return result.rows as unknown as PrintEvent[];
}

function mapBatchSummary(row: RawBatchRow): PrintBatchSummary {
  return {
    batchId: row.batch_id,
    kind: row.kind,
    status: row.status,
    certCount: Number(row.cert_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    createdBy: row.created_by ?? null,
    createdByRole: row.created_by_role ?? null,
    createdAt: row.created_at,
    printedAt: row.printed_at ?? null,
    notes: row.notes ?? null,
    reason: row.reason ?? null,
    reasonCategory: row.reason_category ?? null,
  };
}

// ── Effective-state helper (read current stored + approval for a set of certs) ─

async function loadEffectiveStates(certIds: string[]): Promise<Map<string, PrintState>> {
  if (certIds.length === 0) return new Map();
  const result = await db.execute(sql`
    SELECT certificate_number, print_state, (grade_approved_at IS NOT NULL) AS approved
    FROM certificates
    WHERE certificate_number = ANY(${certIds})
  `);
  const map = new Map<string, PrintState>();
  for (const raw of result.rows as unknown as { certificate_number: string; print_state: string; approved: boolean }[]) {
    map.set(
      raw.certificate_number,
      effectivePrintState({ storedState: raw.print_state as PrintState, approved: raw.approved === true })
    );
  }
  return map;
}

// ── Transition results ───────────────────────────────────────────────────────

export interface WorkflowResult {
  applied: string[];
  rejected: { certId: string; code?: string; message?: string }[];
}

/**
 * Persist a batch: mark each eligible cert `printing`, write/refresh the
 * print_batches record, and append print_events. Called AFTER the existing
 * renderer has produced the artefacts (client passes the same certIds; batchId
 * is derived identically). Idempotent on batchId (upsert). Transactional.
 */
export async function persistBatch(params: {
  batchId: string;
  certIds: string[];
  kind: BatchKind;
  identity: ActorIdentity;
  reason?: string | null;
  reasonCategory?: string | null;
  layoutVersion?: string | null;
  notes?: string | null;
}): Promise<WorkflowResult> {
  const { batchId, certIds, kind, identity } = params;
  const states = await loadEffectiveStates(certIds);
  const applied: string[] = [];
  const rejected: WorkflowResult["rejected"] = [];

  for (const certId of certIds) {
    const from = states.get(certId);
    if (!from) {
      rejected.push({ certId, code: "not_found", message: "Certificate not found." });
      continue;
    }
    const t = nextState(from, "create_batch");
    if (!t.ok) rejected.push({ certId, code: t.code, message: t.message });
    else applied.push(certId);
  }

  if (applied.length === 0) {
    return { applied, rejected };
  }

  await db.transaction(async (tx) => {
    // Upsert the batch record.
    await tx.execute(sql`
      INSERT INTO print_batches
        (batch_id, kind, status, cert_ids, cert_count, created_by, created_by_role, reason, reason_category, layout_version, notes)
      VALUES (
        ${batchId}, ${kind}, 'printing', ${JSON.stringify(applied)}::jsonb, ${applied.length},
        ${identity.actor}, ${identity.role}, ${params.reason ?? null}, ${params.reasonCategory ?? null},
        ${params.layoutVersion ?? null}, ${params.notes ?? null}
      )
      ON CONFLICT (batch_id) DO UPDATE SET
        status = 'printing',
        cert_ids = ${JSON.stringify(applied)}::jsonb,
        cert_count = ${applied.length},
        kind = ${kind}
    `);
    // Advance each accepted cert to printing + write an event.
    for (const certId of applied) {
      const from = states.get(certId)!;
      await tx.execute(sql`
        UPDATE certificates SET print_state = 'printing', updated_at = NOW()
        WHERE certificate_number = ${certId}
      `);
      await tx.execute(sql`
        INSERT INTO print_events (cert_id, batch_id, actor, actor_role, action, from_state, to_state, reason, reason_category)
        VALUES (${certId}, ${batchId}, ${identity.actor}, ${identity.role},
                ${kind === "reprint" ? "create_batch" : "create_batch"}, ${from}, 'printing',
                ${params.reason ?? null}, ${params.reasonCategory ?? null})
      `);
    }
  });

  return { applied, rejected };
}

/**
 * Confirm a batch physically printed. Advances each of its certs to
 * printed (first-run) or reprinted (reprint batch), stamps the batch + the
 * existing label_prints sheet as printed. Transactional.
 */
export async function markBatchPrinted(batchId: string, identity: ActorIdentity): Promise<WorkflowResult> {
  const b = await db.execute(sql`SELECT kind, cert_ids FROM print_batches WHERE batch_id = ${batchId} LIMIT 1`);
  if (b.rows.length === 0) {
    return { applied: [], rejected: [{ certId: batchId, code: "not_found", message: "Batch not found." }] };
  }
  const batchRow = b.rows[0] as unknown as { kind: BatchKind; cert_ids?: string[] };
  const kind = batchRow.kind;
  const certIds = batchRow.cert_ids ?? [];
  const states = await loadEffectiveStates(certIds);

  const applied: string[] = [];
  const rejected: WorkflowResult["rejected"] = [];
  const targets: { certId: string; from: PrintState; to: PrintState }[] = [];
  for (const certId of certIds) {
    const from = states.get(certId);
    if (!from) {
      rejected.push({ certId, code: "not_found" });
      continue;
    }
    const t = nextState(from, "mark_printed", { batchKind: kind });
    if (!t.ok || !t.to) rejected.push({ certId, code: t.code, message: t.message });
    else {
      targets.push({ certId, from, to: t.to });
      applied.push(certId);
    }
  }

  if (targets.length === 0) return { applied, rejected };

  await db.transaction(async (tx) => {
    for (const { certId, from, to } of targets) {
      await tx.execute(sql`
        UPDATE certificates SET print_state = ${to}, updated_at = NOW()
        WHERE certificate_number = ${certId}
      `);
      await tx.execute(sql`
        INSERT INTO print_events (cert_id, batch_id, actor, actor_role, action, from_state, to_state)
        VALUES (${certId}, ${batchId}, ${identity.actor}, ${identity.role}, 'mark_printed', ${from}, ${to})
      `);
    }
    await tx.execute(sql`
      UPDATE print_batches
      SET status = 'printed', printed_at = NOW(), success_count = ${applied.length},
          failure_count = ${rejected.length}
      WHERE batch_id = ${batchId}
    `);
    // Keep the legacy label_prints sheet in sync (reuses existing sheet history).
    await tx.execute(sql`
      UPDATE label_prints SET printed_at = NOW() WHERE sheet_ref = ${`print_batch_${batchId}`}
    `);
  });

  return { applied, rejected };
}

/**
 * Request a reprint. Flags each cert reprint_required, records the reason +
 * category + who in the append-only ledger, and populates the (previously
 * orphaned) reprint_log so the reprint-count badge is accurate (fixes B-1).
 */
export async function requestReprint(params: {
  certIds: string[];
  reason: string;
  reasonCategory: string;
  identity: ActorIdentity;
}): Promise<WorkflowResult> {
  const { certIds, reason, reasonCategory, identity } = params;
  if (!isValidReprintReason(reason)) {
    return { applied: [], rejected: certIds.map((certId) => ({ certId, code: "reason_required", message: "A reprint reason (10–500 chars) is required." })) };
  }
  const category = isReprintReasonCategory(reasonCategory) ? reasonCategory : null;
  const states = await loadEffectiveStates(certIds);
  const applied: string[] = [];
  const rejected: WorkflowResult["rejected"] = [];
  const targets: { certId: string; from: PrintState }[] = [];
  for (const certId of certIds) {
    const from = states.get(certId);
    if (!from) {
      rejected.push({ certId, code: "not_found" });
      continue;
    }
    const t = nextState(from, "reprint", { hasReason: true });
    if (!t.ok) rejected.push({ certId, code: t.code, message: t.message });
    else {
      targets.push({ certId, from });
      applied.push(certId);
    }
  }

  if (targets.length === 0) return { applied, rejected };

  await db.transaction(async (tx) => {
    for (const { certId, from } of targets) {
      await tx.execute(sql`
        UPDATE certificates SET print_state = 'reprint_required', updated_at = NOW()
        WHERE certificate_number = ${certId}
      `);
      await tx.execute(sql`
        INSERT INTO print_events (cert_id, actor, actor_role, action, from_state, to_state, reason, reason_category)
        VALUES (${certId}, ${identity.actor}, ${identity.role}, 'reprint', ${from}, 'reprint_required', ${reason}, ${category})
      `);
      // Populate reprint_log so the reprint-count badge is accurate.
      await tx.execute(sql`INSERT INTO reprint_log (cert_id) VALUES (${certId})`);
    }
  });

  return { applied, rejected };
}

/**
 * Mark certs completed (terminal). Admin-only enforcement happens in the route;
 * the state machine still guards the transition (must be printed/reprinted).
 */
export async function markCompleted(params: { certIds: string[]; identity: ActorIdentity }): Promise<WorkflowResult> {
  const { certIds, identity } = params;
  const states = await loadEffectiveStates(certIds);
  const applied: string[] = [];
  const rejected: WorkflowResult["rejected"] = [];
  const targets: { certId: string; from: PrintState }[] = [];
  for (const certId of certIds) {
    const from = states.get(certId);
    if (!from) {
      rejected.push({ certId, code: "not_found" });
      continue;
    }
    const t = nextState(from, "complete");
    if (!t.ok) rejected.push({ certId, code: t.code, message: t.message });
    else {
      targets.push({ certId, from });
      applied.push(certId);
    }
  }
  if (targets.length === 0) return { applied, rejected };
  await db.transaction(async (tx) => {
    for (const { certId, from } of targets) {
      await tx.execute(sql`
        UPDATE certificates SET print_state = 'completed', updated_at = NOW()
        WHERE certificate_number = ${certId}
      `);
      await tx.execute(sql`
        INSERT INTO print_events (cert_id, actor, actor_role, action, from_state, to_state)
        VALUES (${certId}, ${identity.actor}, ${identity.role}, 'complete', ${from}, 'completed')
      `);
    }
  });
  return { applied, rejected };
}

// Re-export the action union for route typing convenience.
export type { PrintAction };
