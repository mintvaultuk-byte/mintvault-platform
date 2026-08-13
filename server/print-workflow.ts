/**
 * print-workflow.ts — service layer for the Approval → Printing → Printed
 * lifecycle. Owns the durable STATE (certificates.print_state), the batch
 * records (print_batches), and the append-only audit ledger (print_events).
 *
 * Batch creation is SERVER-AUTHORITATIVE and atomic (createBatchAtomic):
 * reserve → render/upload → finalise, with release-on-failure and idempotent
 * retry keyed on the deterministic batchId. Cards never become `printed` on a
 * click — only an explicit, positive mark-printed confirmation advances them.
 * The proven print-batch.ts RENDERER is reused unchanged for the PDF bytes.
 *
 * Every state transition is decided by the pure state machine in
 * shared/print-lifecycle.ts and persisted TRANSACTIONALLY and FAIL-LOUD — the
 * opposite of the legacy best-effort print writes (finding B-2). Actor identity
 * resolves admin OR staff correctly (fixes attribution finding B-3).
 */
import type { Request } from "express";
import { checkPrintableGrade } from "@shared/printable-grade";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { getPartnerPrintEligibilityBlocks } from "./partner/print-eligibility";
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

// The print-workflow schema (certificates.print_state, print_batches,
// print_events) is created ONLY by migrations/0022_print_workflow_lifecycle.sql
// through the numbered migration runner. There is deliberately NO boot-time ALTER
// here — a single schema-mutation authority avoids the two-competing-paths problem.

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
  // Fail-closed: no admin/staff identity resolved. Reachable only if a future
  // caller invokes this without the requireAdmin guard; default to the
  // least-privileged role so it can never silently grant a mutation.
  return { actor: "unknown", role: "staff_readonly" };
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
      r.owner_name || [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ").trim() || null;
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
    events: (events.rows as unknown as RawEventRow[]).map(mapEvent),
  };
}

export async function listCertEvents(certId: string, limit = 200): Promise<PrintEvent[]> {
  const result = await db.execute(sql`
    SELECT * FROM print_events WHERE cert_id = ${certId} ORDER BY created_at DESC LIMIT ${limit}
  `);
  return (result.rows as unknown as RawEventRow[]).map(mapEvent);
}

// db.execute(SELECT *) returns raw snake_case column names, NOT the camelCase
// $inferSelect shape — map explicitly so the client's camelCase reads work.
interface RawEventRow {
  id: number;
  cert_id: string;
  batch_id: string | null;
  actor: string;
  actor_role: string | null;
  action: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  reason_category: string | null;
  created_at: string | Date;
}

function mapEvent(row: RawEventRow): PrintEvent {
  return {
    id: row.id,
    certId: row.cert_id,
    batchId: row.batch_id,
    actor: row.actor,
    actorRole: row.actor_role,
    action: row.action,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    reasonCategory: row.reason_category,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)) as PrintEvent["createdAt"],
  };
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

/**
 * Build a Postgres text[] array literal for a single bound param. drizzle's sql``
 * does NOT bind a JS array as a pg array (it neither expands nor array-encodes it
 * reliably for ANY/unnest), so we pass one properly-escaped literal + ::text[].
 */
function pgTextArray(ids: string[]): string {
  return `{${ids.map((s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

async function loadEffectiveStates(certIds: string[]): Promise<Map<string, PrintState>> {
  if (certIds.length === 0) return new Map();
  const result = await db.execute(sql`
    SELECT certificate_number, print_state, (grade_approved_at IS NOT NULL) AS approved
    FROM certificates
    WHERE certificate_number = ANY(${pgTextArray(certIds)}::text[])
  `);
  const map = new Map<string, PrintState>();
  for (const raw of result.rows as unknown as {
    certificate_number: string;
    print_state: string;
    approved: boolean;
  }[]) {
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

export interface CreateBatchResult extends WorkflowResult {
  batchId: string | null;
  kind: BatchKind | null;
  pdfUrl: string | null;
  isDuplicate: boolean;
  multiSheet: boolean;
  pageCount: number;
}

/**
 * Server-authoritative atomic batch creation. Reserve → render/upload → finalise.
 *
 *  1. RESERVE (transaction): claim eligible certs by moving needs_printing /
 *     reprint_required → printing with a state-guarded UPDATE ... RETURNING, so two
 *     concurrent requests can never both reserve the same cert (the loser sees 0
 *     rows and reports it rejected). Writes the batch row as 'rendering' + events.
 *  2. RENDER/UPLOAD: reuse the untouched print-batch.ts renderer to produce the PDF
 *     and store it in R2 under the deterministic batchId key.
 *  3a. On success: batch → 'printing'. Certs stay 'printing' — NOT 'printed'. Only
 *      an explicit mark-printed advances them (positive physical confirmation).
 *  3b. On ANY render/upload failure: RELEASE — roll the reserved certs back to their
 *      prior state, batch → 'failed', write release events, then re-throw (500).
 *      Cards never become printed because a render failed.
 *
 * Idempotent retry: batchId is deterministic (deriveBatchId). A repeat with an
 * existing 'printing'/'printed' batch returns it without re-reserving or
 * re-rendering. A previously 'failed' batch (certs already released) can retry.
 */
export async function createBatchAtomic(params: {
  certIds: string[];
  identity: ActorIdentity;
  reason?: string | null;
  reasonCategory?: string | null;
  notes?: string | null;
}): Promise<CreateBatchResult> {
  const { identity } = params;
  const requested = [...new Set(params.certIds)];
  // Partner output is a stricter authority than the generic lifecycle. Check
  // this before idempotent reuse too: a stale cached sheet must never become a
  // bypass if QA, credit, mapping, or physical evidence is no longer proven.
  const partnerBlocks = await getPartnerPrintEligibilityBlocks(requested);
  if (partnerBlocks.length > 0) {
    return {
      applied: [],
      rejected: partnerBlocks,
      batchId: null,
      kind: null,
      pdfUrl: null,
      isDuplicate: false,
      multiSheet: false,
      pageCount: 0,
    };
  }
  const states = await loadEffectiveStates(requested);

  const { deriveBatchId, CERTS_PER_PAGE, SHEET_LAYOUT_VERSION } = await import("./print-batch");

  // ── Idempotency pre-check — a retry of an IN-FLIGHT batch (double-click /
  // network retry). Fires ONLY when every requested cert is currently 'printing':
  // that is precisely the duplicate-of-a-live-batch case. It deliberately does NOT
  // fire for reprint_required (a genuine new reprint intent) or needs_printing (a
  // fresh re-batch), so those proceed normally. Returns the existing live batch.
  const allInFlight = requested.length > 0 && requested.every((id) => states.get(id) === "printing");
  const sortedReq = JSON.stringify([...requested].sort());
  const dup = allInFlight
    ? await db.execute(sql`
        SELECT batch_id, status, cert_ids, kind FROM print_batches
        WHERE created_by = ${identity.actor} AND status IN ('rendering', 'printing', 'printed')
          AND cert_ids @> ${sortedReq}::jsonb AND ${sortedReq}::jsonb @> cert_ids
        ORDER BY created_at DESC LIMIT 1
      `)
    : { rows: [] as unknown[] };
  if (dup.rows.length > 0) {
    const row = dup.rows[0] as { batch_id: string; cert_ids?: string[]; kind: BatchKind };
    const ids = row.cert_ids ?? [];
    // A retry must not hand back the URL of a batch created BEFORE the grade gate existed
    // (or one whose certs have since lost a valid grade). Re-validate before returning it.
    if (ids.length > 0) {
      const dupRows = await db.execute(sql`
        SELECT certificate_number, grade_type, grade::text AS grade FROM certificates
         WHERE certificate_number IN (${sql.join(
           ids.map((c) => sql`${c}`),
           sql`, `
         )})
      `);
      const dupById = new Map(
        (
          dupRows.rows as unknown as { certificate_number: string; grade_type: string | null; grade: string | null }[]
        ).map((r) => [r.certificate_number, r])
      );
      const dupBlocked = ids.filter((id) => {
        const r = dupById.get(id);
        return !checkPrintableGrade({ gradeType: r?.grade_type ?? null, gradeOverall: r?.grade ?? null }).printable;
      });
      if (dupBlocked.length > 0) {
        return {
          applied: [],
          rejected: dupBlocked.map((certId) => ({
            certId,
            code: "unprintable_grade",
            message: `${certId}: this certificate has no valid grade, so the existing batch cannot be reused.`,
          })),
          batchId: null,
          kind: null,
          pdfUrl: null,
          isDuplicate: false,
          multiSheet: false,
          pageCount: 0,
        };
      }
    }
    return {
      applied: ids,
      rejected: [],
      batchId: row.batch_id,
      kind: row.kind,
      pdfUrl: `/api/admin/print-batch/${row.batch_id}/pdf`,
      isDuplicate: true,
      multiSheet: ids.length > CERTS_PER_PAGE,
      pageCount: Math.max(1, Math.ceil(ids.length / CERTS_PER_PAGE)),
    };
  }

  // ── Pre-flight eligibility (pure) ──────────────────────────────────────────
  const rejected: WorkflowResult["rejected"] = [];
  const eligible: { certId: string; from: PrintState }[] = [];
  for (const certId of requested) {
    const from = states.get(certId);
    if (!from) {
      rejected.push({ certId, code: "not_found", message: "Certificate not found." });
      continue;
    }
    const t = nextState(from, "create_batch");
    if (!t.ok) rejected.push({ certId, code: t.code, message: t.message });
    else eligible.push({ certId, from });
  }
  if (eligible.length === 0) {
    return {
      applied: [],
      rejected,
      batchId: null,
      kind: null,
      pdfUrl: null,
      isDuplicate: false,
      multiSheet: false,
      pageCount: 0,
    };
  }

  // ── Grade printability gate (fail closed) ──────────────────────────────────
  // Runs INSIDE the pure pre-flight, BEFORE the reserve transaction — so a blocked
  // certificate produces no batch row, no print_event, no print_state transition and no
  // PDF. Applies identically to a fresh batch and a reprint: there is no separate
  // historical-artefact render path in this codebase, so no exception is invented here.
  // A numeric certificate with no/malformed/off-ladder grade would otherwise have been
  // rendered with an invented 0 / POOR panel (production incident 2026-07-25).
  const gradeRows = await db.execute(sql`
    SELECT certificate_number, grade_type, grade::text AS grade
    FROM certificates
    WHERE certificate_number IN (${sql.join(
      eligible.map((e) => sql`${e.certId}`),
      sql`, `
    )})
  `);
  const gradeOf = new Map(
    (
      gradeRows.rows as unknown as { certificate_number: string; grade_type: string | null; grade: string | null }[]
    ).map((r) => [r.certificate_number, r])
  );
  const printable: { certId: string; from: PrintState }[] = [];
  for (const e of eligible) {
    const row = gradeOf.get(e.certId);
    const verdict = checkPrintableGrade({ gradeType: row?.grade_type ?? null, gradeOverall: row?.grade ?? null });
    if (!verdict.printable) {
      // Unshifted, not pushed: the print-queue toast surfaces rejected[0] only, so a mixed
      // selection (one state-ineligible + one ungraded) must not hide the ungraded card.
      rejected.unshift({
        certId: e.certId,
        code: verdict.reason ?? "unprintable_grade",
        message: `${e.certId}: ${verdict.message ?? "grade is not printable."}`,
      });
    } else {
      printable.push(e);
    }
  }
  // All-or-nothing on grade validity: a sheet is a physical artefact, so we do not print
  // the good half of a batch and silently drop the rest — the operator fixes the blocked
  // card and re-submits. (State-based rejections above keep their existing partial
  // behaviour; this only governs grade validity.)
  if (printable.length !== eligible.length) {
    return {
      applied: [],
      rejected,
      batchId: null,
      kind: null,
      pdfUrl: null,
      isDuplicate: false,
      multiSheet: false,
      pageCount: 0,
    };
  }

  // A batch renders as one kind. Reprints (reprint_required, possibly claimed) use
  // the reprint render path; fresh prints (needs_printing, unclaimed) use the
  // standard path. Mixing is rejected so the render path is unambiguous.
  const fromReprint = eligible.filter((e) => e.from === "reprint_required").length;
  if (fromReprint > 0 && fromReprint !== eligible.length) {
    const mixedRejected: WorkflowResult["rejected"] = eligible.map((e) => ({
      certId: e.certId,
      code: "mixed_batch",
      message: "Select reprints and fresh prints in separate batches.",
    }));
    return {
      applied: [],
      rejected: [...mixedRejected, ...rejected],
      batchId: null,
      kind: null,
      pdfUrl: null,
      isDuplicate: false,
      multiSheet: false,
      pageCount: 0,
    };
  }
  const kind: BatchKind = fromReprint > 0 ? "reprint" : "batch";

  const eligibleIds = eligible.map((e) => e.certId);
  // UNIQUE per-request batch id (random nonce). A deterministic id caused two
  // hazards: concurrent identical submits shared one batch row (the loser
  // clobbered the winner's cert_ids and stranded certs), and a second same-day
  // reprint of the same certs collided with the first and was silently swallowed.
  // Retry idempotency is instead provided by the in-flight membership pre-check
  // above (keyed on the cert set + actor), not by id determinism.
  const batchId = deriveBatchId(eligibleIds, `${identity.actor}|${kind}|${randomUUID()}`);
  const pdfUrl = `/api/admin/print-batch/${batchId}/pdf`;
  const fromOf = new Map(eligible.map((e) => [e.certId, e.from]));

  // ── 1. RESERVE (transaction) — race-safe claim. The batch row is written ONLY
  // if we actually won certs, so a losing concurrent request creates nothing to
  // clobber and nothing to strand. ──
  const reserved: string[] = [];
  await db.transaction(async (tx) => {
    for (const { certId } of eligible) {
      // State-guarded claim: succeeds only if the cert is still batchable. A
      // concurrent request for the same cert loses here (row-locked, 0 rows).
      const claim = await tx.execute(sql`
        UPDATE certificates SET print_state = 'printing', updated_at = NOW()
        WHERE certificate_number = ${certId} AND print_state IN ('needs_printing', 'reprint_required')
        RETURNING certificate_number
      `);
      if (claim.rows.length === 0) {
        rejected.push({ certId, code: "already_reserved", message: "Already being printed by another batch." });
        continue;
      }
      reserved.push(certId);
    }
    if (reserved.length > 0) {
      await tx.execute(sql`
        INSERT INTO print_batches (batch_id, kind, status, cert_ids, cert_count, created_by, created_by_role, reason, reason_category, layout_version, notes)
        VALUES (${batchId}, ${kind}, 'rendering', ${JSON.stringify(reserved)}::jsonb, ${reserved.length}, ${identity.actor}, ${identity.role},
                ${params.reason ?? null}, ${params.reasonCategory ?? null}, ${SHEET_LAYOUT_VERSION}, ${params.notes ?? null})
      `);
      for (const certId of reserved) {
        await tx.execute(sql`
          INSERT INTO print_events (cert_id, batch_id, actor, actor_role, action, from_state, to_state, reason, reason_category)
          VALUES (${certId}, ${batchId}, ${identity.actor}, ${identity.role}, 'create_batch', ${fromOf.get(certId)}, 'printing', ${params.reason ?? null}, ${params.reasonCategory ?? null})
        `);
      }
    }
  });

  if (reserved.length === 0) {
    // Nothing won (all already reserved/ineligible) — no batch row created.
    return {
      applied: [],
      rejected,
      batchId: null,
      kind,
      pdfUrl: null,
      isDuplicate: false,
      multiSheet: false,
      pageCount: 0,
    };
  }

  // ── 2 + 3. RENDER + FINALISE (both inside the try; RELEASE on ANY failure) ──
  try {
    await renderAndUploadBatch(batchId, reserved, kind);
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE print_batches SET status = 'printing' WHERE batch_id = ${batchId}`);
      // Keep the legacy label_prints sheet in sync (drives the existing sheet
      // history UI + the queue's printedAt). printed_at stays NULL until an
      // explicit mark-printed — a click never marks a card printed.
      await tx.execute(sql`
        INSERT INTO label_prints (cert_id, sheet_ref, printed_at)
        SELECT unnest(${pgTextArray(reserved)}::text[]), ${`print_batch_${batchId}`}, NULL
        ON CONFLICT (cert_id) DO UPDATE SET sheet_ref = EXCLUDED.sheet_ref, printed_at = NULL
      `);
    });
  } catch (err) {
    // ── RELEASE — undo the reservation, fail loud. Covers render/upload AND
    // finalise failure. (Process-crash mid-render is swept by the boot reconciler
    // reconcileStuckPrintBatches — a live in-process failure is released here.) ──
    await db.transaction(async (tx) => {
      for (const certId of reserved) {
        await tx.execute(sql`
          UPDATE certificates SET print_state = ${fromOf.get(certId)}, updated_at = NOW()
          WHERE certificate_number = ${certId} AND print_state = 'printing'
        `);
        await tx.execute(sql`
          INSERT INTO print_events (cert_id, batch_id, actor, actor_role, action, from_state, to_state, reason)
          VALUES (${certId}, ${batchId}, ${identity.actor}, ${identity.role}, 'create_batch', 'printing', ${fromOf.get(certId)}, 'render_failed_released')
        `);
      }
      await tx.execute(
        sql`UPDATE print_batches SET status = 'failed', failure_count = ${reserved.length} WHERE batch_id = ${batchId}`
      );
    });
    throw err;
  }

  const multiSheet = reserved.length > CERTS_PER_PAGE;
  return {
    applied: reserved,
    rejected,
    batchId,
    kind,
    pdfUrl,
    isDuplicate: false,
    multiSheet,
    pageCount: Math.max(1, Math.ceil(reserved.length / CERTS_PER_PAGE)),
  };
}

/**
 * Reconciler for batches stranded in 'rendering' — a process crash/restart during
 * the (out-of-transaction) render window leaves reserved certs in 'printing' with
 * no way to advance. This releases them back to their pre-reserve state
 * (needs_printing for a fresh batch, reprint_required for a reprint) and fails the
 * batch. The age threshold avoids racing a genuinely in-flight render on another
 * Fly machine (a render completes in seconds; default 15 min is well clear).
 * Wire into the boot sequence and/or an interval. Returns certs released.
 */
export async function reconcileStuckPrintBatches(olderThanMinutes = 15): Promise<number> {
  const stuck = await db.execute(sql`
    SELECT batch_id, kind, cert_ids FROM print_batches
    WHERE status = 'rendering' AND created_at < NOW() - make_interval(mins => ${olderThanMinutes})
  `);
  let released = 0;
  for (const raw of stuck.rows as unknown as { batch_id: string; kind: BatchKind; cert_ids?: string[] }[]) {
    const target: PrintState = raw.kind === "reprint" ? "reprint_required" : "needs_printing";
    const certIds = raw.cert_ids ?? [];
    await db.transaction(async (tx) => {
      for (const certId of certIds) {
        const r = await tx.execute(sql`
          UPDATE certificates SET print_state = ${target}, updated_at = NOW()
          WHERE certificate_number = ${certId} AND print_state = 'printing'
          RETURNING certificate_number
        `);
        if (r.rows.length > 0) {
          released++;
          await tx.execute(sql`
            INSERT INTO print_events (cert_id, batch_id, actor, actor_role, action, from_state, to_state, reason)
            VALUES (${certId}, ${raw.batch_id}, 'system', 'admin', 'create_batch', 'printing', ${target}, 'stuck_rendering_reconciled')
          `);
        }
      }
      await tx.execute(sql`UPDATE print_batches SET status = 'failed' WHERE batch_id = ${raw.batch_id}`);
    });
  }
  return released;
}

/**
 * Render + upload the batch artefacts using the UNTOUCHED print-batch.ts renderer,
 * keyed by the deterministic batchId so the existing /print-batch/:id/pdf endpoint
 * serves them. Throws on any resolution/render/upload failure so the caller can
 * release the reservation. Fresh batches require unclaimed certs; reprint batches
 * allow claimed certs (matching the existing /print-batch/reprint semantics).
 */
async function renderAndUploadBatch(batchId: string, certIds: string[], kind: BatchKind): Promise<void> {
  const {
    generatePrintBatchPDF,
    generatePrintBatchPNG,
    generatePrintBatchPrintPNG,
    generateCricutSVG,
    uploadPrintBatchArtifacts,
    uploadPrintBatchPDF,
    uploadCricutSvg,
    CERTS_PER_PAGE,
  } = await import("./print-batch");

  const allCerts = await storage.listCertificates();
  const items: { cert: unknown; claimCode: string }[] = [];
  for (const certId of certIds) {
    const cert = (allCerts as { certId: string; ownershipStatus?: string }[]).find((c) => c.certId === certId);
    if (!cert) throw new Error(`Certificate not found while rendering: ${certId}`);
    if (kind === "batch" && cert.ownershipStatus !== "unclaimed") {
      throw new Error(`Cannot fresh-print a claimed cert (${certId}); use reprint.`);
    }
    const code = await storage.getOrGenerateClaimCode(certId);
    items.push({ cert, claimCode: String(code) });
  }

  // The upload helpers derive the R2 object keys from batchId internally, so the
  // existing /api/admin/print-batch/:batchId/pdf endpoint serves them unchanged.
  if (items.length > CERTS_PER_PAGE) {
    const pdf = await generatePrintBatchPDF(items as never);
    await uploadPrintBatchPDF(batchId, pdf);
  } else {
    const [pdf, png, printPng] = await Promise.all([
      generatePrintBatchPDF(items as never),
      generatePrintBatchPNG(items as never),
      generatePrintBatchPrintPNG(items as never),
    ]);
    await uploadPrintBatchArtifacts(batchId, pdf, png, printPng);
    await uploadCricutSvg(batchId, generateCricutSVG(items as never)).catch(() => {});
  }
}

/**
 * Confirm a batch physically printed. Advances each of its certs to
 * printed (first-run) or reprinted (reprint batch), stamps the batch + the
 * existing label_prints sheet as printed. Transactional.
 */
export async function markBatchPrinted(batchId: string, identity: ActorIdentity): Promise<WorkflowResult> {
  const b = await db.execute(sql`SELECT kind, cert_ids, status FROM print_batches WHERE batch_id = ${batchId} LIMIT 1`);
  if (b.rows.length === 0) {
    return { applied: [], rejected: [{ certId: batchId, code: "not_found", message: "Batch not found." }] };
  }
  const batchRow = b.rows[0] as unknown as { kind: BatchKind; cert_ids?: string[]; status: string };
  // Only a finalised batch (render + upload succeeded) may be confirmed printed.
  // Blocks marking a 'rendering' (never-produced) or 'failed' batch as printed —
  // a card must never read 'printed' with no PDF behind it.
  if (batchRow.status !== "printing") {
    return {
      applied: [],
      rejected: [
        { certId: batchId, code: "not_printable", message: `Batch is "${batchRow.status}", not a finalised print.` },
      ],
    };
  }
  const kind = batchRow.kind;
  const certIds = batchRow.cert_ids ?? [];
  const partnerBlocks = await getPartnerPrintEligibilityBlocks(certIds);
  if (partnerBlocks.length > 0) return { applied: [], rejected: partnerBlocks };
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
    }
  }

  if (targets.length === 0) return { applied, rejected };

  await db.transaction(async (tx) => {
    for (const { certId, from, to } of targets) {
      // Compare-and-set: advance only if still in the expected state, and write
      // the ledger event ONLY when the row actually changed. A concurrent double
      // mark-printed therefore records exactly one event per cert.
      const upd = await tx.execute(sql`
        UPDATE certificates SET print_state = ${to}, updated_at = NOW()
        WHERE certificate_number = ${certId} AND print_state = ${from}
        RETURNING certificate_number
      `);
      if (upd.rows.length === 0) {
        rejected.push({ certId, code: "state_changed", message: "Concurrently updated." });
        continue;
      }
      applied.push(certId);
      await tx.execute(sql`
        INSERT INTO print_events (cert_id, batch_id, actor, actor_role, action, from_state, to_state)
        VALUES (${certId}, ${batchId}, ${identity.actor}, ${identity.role}, 'mark_printed', ${from}, ${to})
      `);
    }
    // Only the winner of the CAS (at least one cert advanced) finalises the batch.
    if (applied.length > 0) {
      await tx.execute(sql`
        UPDATE print_batches
        SET status = 'printed', printed_at = NOW(), success_count = ${applied.length}, failure_count = ${rejected.length}
        WHERE batch_id = ${batchId} AND status = 'printing'
      `);
      await tx.execute(sql`
        UPDATE label_prints SET printed_at = NOW() WHERE sheet_ref = ${`print_batch_${batchId}`}
      `);
    }
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
    return {
      applied: [],
      rejected: certIds.map((certId) => ({
        certId,
        code: "reason_required",
        message: "A reprint reason (10–500 chars) is required.",
      })),
    };
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
    else targets.push({ certId, from });
  }

  if (targets.length === 0) return { applied, rejected };

  await db.transaction(async (tx) => {
    for (const { certId, from } of targets) {
      // CAS: flag reprint only if still in the expected state; write the ledger +
      // reprint_log row ONLY on a real change, so a double-submit records once.
      const upd = await tx.execute(sql`
        UPDATE certificates SET print_state = 'reprint_required', updated_at = NOW()
        WHERE certificate_number = ${certId} AND print_state = ${from}
        RETURNING certificate_number
      `);
      if (upd.rows.length === 0) {
        rejected.push({ certId, code: "state_changed", message: "Concurrently updated." });
        continue;
      }
      applied.push(certId);
      await tx.execute(sql`
        INSERT INTO print_events (cert_id, actor, actor_role, action, from_state, to_state, reason, reason_category)
        VALUES (${certId}, ${identity.actor}, ${identity.role}, 'reprint', ${from}, 'reprint_required', ${reason}, ${category})
      `);
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
    else targets.push({ certId, from });
  }
  if (targets.length === 0) return { applied, rejected };
  await db.transaction(async (tx) => {
    for (const { certId, from } of targets) {
      // CAS: complete only if still printed/reprinted; event on real change only.
      const upd = await tx.execute(sql`
        UPDATE certificates SET print_state = 'completed', updated_at = NOW()
        WHERE certificate_number = ${certId} AND print_state = ${from}
        RETURNING certificate_number
      `);
      if (upd.rows.length === 0) {
        rejected.push({ certId, code: "state_changed", message: "Concurrently updated." });
        continue;
      }
      applied.push(certId);
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
