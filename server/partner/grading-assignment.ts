/**
 * Partner grading assignment — partner-owned, deliberately OUTSIDE server/grader.ts.
 *
 * This logic is entirely tenant/permission plumbing: it decides WHICH partner user may be handed
 * WHICH partner-origin certificate, and mirrors that decision onto partner_grading_work_items. It
 * contains no scoring, no sub-grade arithmetic, no centering maths, no Pristine rules and no
 * certificate numbering — nothing that belongs to the protected MVGS engine.
 *
 * It lives here rather than in server/grader.ts because server/grader.ts is a protected file. An
 * earlier revision of this work placed the function there and widened the two MVGS tripwire tests
 * to accept it; that is the wrong direction of travel. Partner-specific code belongs in
 * server/partner/, and the protected engine stays byte-identical to main.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";

/**
 * SQL predicate: refuse to move a certificate whose PARTNER work item is awaiting HQ review.
 *
 * HQ's assign/reassign/unassign writers predicate only on `grader_status <> 'approved'`, which a
 * card at 'pending_review' passes, and none of them touch partner_grading_work_items. Moving the
 * certificate therefore strands the pair: the cert leaves 'pending_review' while the work item
 * stays there. That is terminal — approval requires the cert AT 'pending_review', and every retry
 * door (partner /submit, /edit-submission, assignPartnerCerts) requires the work item to be in
 * ('ready_for_assignment','assigned','returned_for_change'). Settlement never runs and the reserved
 * credits stay held, with no in-app repair path.
 *
 * Handed back as a FRAGMENT so the caller can splice it into its existing UPDATE, rather than as a
 * pre-flight SELECT: the check must not be separable from the write by a concurrent approval.
 *
 * It lives in this file, not in server/grader.ts, for the reason in this module's header — the
 * partner table name is partner-owned knowledge and the protected engine must not carry it.
 *
 * Degrades to an empty fragment when 0049 has not been applied, because the callers also run
 * against HQ databases that predate partner_grading_work_items, where an unconditional reference
 * would be a parse error.
 */
export async function partnerReviewLockGuard() {
  const t = await db.execute(sql`SELECT to_regclass('public.partner_grading_work_items')::text AS t`);
  if (!(t.rows[0] as { t?: string | null } | undefined)?.t) return sql``;
  return sql`AND NOT EXISTS (
    SELECT 1 FROM partner_grading_work_items pgwi
     WHERE pgwi.certificate_id = certificates.id
       AND pgwi.status = 'pending_review'
  )`;
}

/**
 * Work-item statuses meaning a physical grading unit has left the intake queue and acquired
 * durable grading/review history.
 *
 * `ready_for_assignment` is the only pre-grading state: the unit exists and is imported, but no
 * grader has touched it and it carries no quality signal. Everything else means a partner grader
 * was handed the card, or HQ has seen a submitted grade. `void` is excluded because nothing in the
 * codebase writes it (server/print-workflow.ts:1100-1102 says so, and grep confirms) — listing it
 * here would imply a state machine that does not exist.
 */
export const GRADING_EVIDENCE_WORK_ITEM_STATUSES = [
  "assigned",
  "pending_review",
  "returned_for_change",
  "approved",
  "completed",
] as const;

/** Raised when an ordinary partner cancellation would erase durable grading/review evidence. */
export class PartnerGradingEvidenceLockError extends Error {
  public readonly code = "grading_already_started";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Refuse an ORDINARY partner cancellation once grading has begun on any card in the submission.
 *
 * WHY THIS EXISTS. `cancelSubmission` previously guarded only on the submission not already being
 * cancelled. A completed connector import creates the MintVault destination in `in_grading`,
 * which is the status required for the eventual `in_grading → ready_to_return` credit settlement.
 * The Partner work-item guard remains necessary because a historical import or manual
 * reconciliation can still leave a pre-grading destination status while work has already begun.
 * Two consequences of permitting ordinary cancellation after that point are:
 *
 *   1. QUALITY LAUNDERING. A shop could see how grading went — a card sitting at
 *      `returned_for_change` after HQ bounced it — then cancel and re-submit the same physical
 *      card as a brand-new submission with a fresh `redo_count` of 0. Every surrogate key in the
 *      chain is minted at intake, so the second attempt is a different card to every table in the
 *      system. Closing the rating denominator alone would not have stopped this.
 *   2. THE APPROVAL FREEZE. Cancelling creates unreleased rows in
 *      `partner_submission_credit_holds`, and migration 0041's `certificates` trigger raises
 *      `check_violation` on ANY write to a certificate whose destination carries an unreleased
 *      hold. `approveCertGrade` is a plain UPDATE on that table, so HQ approval became impossible
 *      — the partner could strand its own reviewed work with no in-app repair path.
 *
 * The fix is lifecycle governance rather than a new identity mechanism: once a unit has left
 * `ready_for_assignment`, the ordinary cancel route is closed and the evidence cannot be erased.
 * Genuinely exceptional cancellation stays available to HQ through its own audited path, which
 * preserves the evidence rather than discarding it.
 *
 * Runs on the CALLER'S transaction client and takes `FOR UPDATE` on the work-item rows, so the
 * check cannot be separated from the cancellation write by a concurrent submit-for-review. Rows
 * are locked in `id` order, matching grading-review-mirror.ts's ordering on the same table, so the
 * two writers serialise instead of forming a cycle.
 *
 * Degrades to a no-op when 0049 has not been applied, matching partnerReviewLockGuard above.
 */
export async function assertCancellationLeavesNoGradingEvidence(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  partnerSubmissionId: string
): Promise<void> {
  const present = await client.query("SELECT to_regclass('public.partner_grading_work_items')::text AS t");
  if (!(present.rows[0] as { t?: string | null } | undefined)?.t) return;

  const { rows } = await client.query(
    `SELECT status
       FROM partner_grading_work_items
      WHERE partner_submission_id = $1
        AND status = ANY($2::text[])
      ORDER BY id
        FOR UPDATE`,
    [partnerSubmissionId, [...GRADING_EVIDENCE_WORK_ITEM_STATUSES]]
  );
  if (rows.length === 0) return;

  throw new PartnerGradingEvidenceLockError(
    "Grading has already started on this submission, so it can no longer be cancelled here. " +
      "Contact MintVault support if it genuinely needs to be withdrawn."
  );
}

/**
 * Bind an int[] as ONE parameter.
 *
 * Local copy of the same helper server/grader.ts uses privately. Duplicated rather than exported
 * from there so this module creates no new coupling to the protected file — it is four lines of
 * parameter binding with no engine semantics.
 */
const intArray = (ids: number[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::int[]`;

/** Assign partner-origin work items to a partner user with MVGS assessment permission. */
export async function assignPartnerCerts(partnerUserId: string, certIds: number[], adminUser: string) {
  const clean = certIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No certificate ids" };
  const eligible = await db.execute(sql`
    SELECT u.id, u.tenant_id
      FROM partner_users u
     WHERE u.id = ${partnerUserId}
       AND u.status = 'ACTIVE'
       AND EXISTS (
         SELECT 1
           FROM partner_user_roles ur
           JOIN partner_role_permissions rp ON rp.role_id = ur.role_id
           JOIN partner_permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = u.id
            AND ur.tenant_id = u.tenant_id
            AND p.code = 'partner.cards.assess'
       )
     LIMIT 1
  `);
  const partner = eligible.rows[0] as { id: string; tenant_id: string } | undefined;
  if (!partner) return { ok: false as const, status: 400, error: "Not a valid partner grader" };

  const r = await db.execute(sql`
    WITH assigned AS (
      UPDATE certificates cert
         SET assigned_grader_id = ${partnerUserId},
             grader_status = 'assigned',
             assigned_at = NOW(),
             rejection_reason = NULL,
             updated_at = NOW()
        FROM partner_grading_work_items pgwi
        JOIN partner_connector_imports pci ON pci.id = pgwi.connector_import_id
        JOIN submission_items si
          ON si.id = pgwi.submission_item_id
         AND si.submission_id = pgwi.destination_submission_id
       WHERE cert.id = ANY(${intArray(clean)})
         AND cert.submission_item_id = pgwi.submission_item_id
         AND pgwi.tenant_id = ${partner.tenant_id}
         AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = cert.id)
         AND pgwi.status IN ('ready_for_assignment','assigned','returned_for_change')
         AND pci.state = 'completed'
         AND pci.deleted_at IS NULL
         AND cert.deleted_at IS NULL
         AND cert.grader_status IN ('unassigned','assigned','rejected')
         AND (
           EXISTS (
             SELECT 1
               FROM partner_user_roles ur
               JOIN partner_roles r ON r.id = ur.role_id
              WHERE ur.user_id = ${partnerUserId}
                AND ur.tenant_id = ${partner.tenant_id}
                AND r.code IN ('PARTNER_OWNER','PARTNER_MANAGER')
           )
           OR EXISTS (
             SELECT 1
               FROM partner_user_locations pul
              WHERE pul.user_id = ${partnerUserId}
                AND pul.tenant_id = ${partner.tenant_id}
                AND pul.location_id = pgwi.partner_location_id
           )
         )
       RETURNING cert.id, cert.submission_item_id
    )
    UPDATE partner_grading_work_items pgwi
       SET certificate_id = assigned.id,
           certificate_linked_at = COALESCE(pgwi.certificate_linked_at, NOW()),
           assigned_partner_grader_id = ${partnerUserId},
           assigned_at = COALESCE(pgwi.assigned_at, NOW()),
           status = 'assigned',
           updated_at = NOW()
      FROM assigned
     WHERE assigned.submission_item_id = pgwi.submission_item_id
       AND pgwi.tenant_id = ${partner.tenant_id}
       AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = assigned.id)
       AND pgwi.status IN ('ready_for_assignment','assigned','returned_for_change')
    RETURNING assigned.id
  `);
  await storage.writeAuditLog("certificate", clean.join(","), "partner_grader_assign", adminUser, {
    partner_user_id: partnerUserId,
    partner_tenant_id: partner.tenant_id,
    cert_ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}
