/**
 * Mirror Super Admin approve/reject decisions onto partner_grading_work_items.
 *
 * PARTNER-OWNED, deliberately OUTSIDE server/grader.ts.
 *
 * An earlier revision of this work embedded these updates INSIDE approveGraderCert and
 * rejectCertGrade — protected MVGS engine functions — and widened the two MVGS tripwire tests to
 * accept the change. Nothing here is grading logic: it sets partner workflow state after the
 * engine has already made, gated and committed the grading decision. So it belongs here, called
 * from the route layer (server/routes/grader.ts, which the engine guard does not cover).
 *
 * WHAT IS DELIBERATELY NOT DUPLICATED
 * -----------------------------------
 * The previous revision re-implemented the certificate approval UPDATE inside its own transaction
 * so the cert write and the work-item write were atomic. That duplicated a protected write path.
 * Here, approveGraderCert remains the single writer of the approval — including
 * checkGradePublishGates (B3 sub-grade completeness and the printable-grade rule that exists
 * because of the "0/POOR" incident). Partner cards therefore pass exactly the same gates as HQ
 * cards, through exactly the same code.
 *
 * ATOMICITY, STATED HONESTLY
 * --------------------------
 * Because the engine owns the certificate write, the mirror is a SECOND statement. If it fails,
 * the certificate is approved while the work item still reads pending_review. That is a visible,
 * self-correcting inconsistency (the work item can be re-mirrored) and it is the safe direction:
 * the alternative — mirroring first — would mark partner work approved for a certificate that the
 * publish gates then refused. Failures are returned to the caller, never swallowed, so the route
 * can surface them rather than reporting a clean approval over a broken mirror.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";

export type PartnerMirrorResult =
  /** No partner work item is attached to this certificate — an ordinary HQ card. */
  | { kind: "not_partner" }
  /** Mirrored successfully. `allApproved` is true when every live card on the submission is done. */
  | { kind: "mirrored"; allApproved: boolean; destinationSubmissionId: number | null }
  /** A partner work item exists but did not move — concurrent change. Caller must not report success. */
  | { kind: "conflict" };

/** True when this certificate is attached to a partner grading work item awaiting review. */
async function pendingPartnerWorkItem(certId: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1
      FROM partner_grading_work_items pgwi
      JOIN certificates cert
        ON cert.id = pgwi.certificate_id
       AND cert.submission_item_id = pgwi.submission_item_id
       AND cert.submission_id = pgwi.destination_submission_id
     WHERE cert.id = ${certId}
       AND pgwi.status = 'pending_review'
     LIMIT 1
  `);
  return r.rows.length > 0;
}

/**
 * Mark the partner work item approved, and move the destination submission on when every live
 * card unit is approved.
 *
 * `status <> 'void'` excludes voided units from the completeness test, so a submission whose only
 * outstanding unit was voided still completes — while a genuinely outstanding unit still blocks it.
 */
export async function mirrorPartnerApproval(certId: number, adminUser: string): Promise<PartnerMirrorResult> {
  if (!(await pendingPartnerWorkItem(certId))) return { kind: "not_partner" };

  const outcome = await db.transaction(async (tx) => {
    const workUpdate = await tx.execute(sql`
      UPDATE partner_grading_work_items
         SET status = 'approved', updated_at = NOW()
       WHERE certificate_id = ${certId}
         AND status = 'pending_review'
       RETURNING id
    `);
    if (workUpdate.rows.length !== 1) return null;

    const statusCheck = await tx.execute(sql`
      SELECT pgwi.destination_submission_id::int AS destination_submission_id,
             bool_and(pgwi.status = 'approved') AS all_approved
        FROM partner_grading_work_items pgwi
       WHERE pgwi.destination_submission_id = (
         SELECT destination_submission_id
           FROM partner_grading_work_items
          WHERE certificate_id = ${certId}
          LIMIT 1
       )
         AND pgwi.status <> 'void'
       GROUP BY pgwi.destination_submission_id
    `);
    const row = statusCheck.rows[0] as { destination_submission_id?: number; all_approved?: boolean } | undefined;
    return {
      allApproved: Boolean(row?.all_approved),
      destinationSubmissionId: row?.destination_submission_id ?? null,
    };
  });

  if (!outcome) return { kind: "conflict" };

  if (outcome.allApproved && outcome.destinationSubmissionId) {
    await storage.updateSubmissionStatus(outcome.destinationSubmissionId, "ready_to_return", {
      partner_grading_approved_by: adminUser,
      partner_grading_completed_cert_id: certId,
    });
  }
  return { kind: "mirrored", allApproved: outcome.allApproved, destinationSubmissionId: outcome.destinationSubmissionId };
}

/**
 * Return the partner work item for change after a Super Admin rejection.
 *
 * Guarded on `status = 'pending_review'` so a rejection cannot reopen a unit that has already been
 * approved or voided by someone else.
 */
export async function mirrorPartnerRejection(certId: number): Promise<PartnerMirrorResult> {
  if (!(await pendingPartnerWorkItem(certId))) return { kind: "not_partner" };
  const r = await db.execute(sql`
    UPDATE partner_grading_work_items
       SET status = 'returned_for_change', updated_at = NOW()
     WHERE certificate_id = ${certId}
       AND status = 'pending_review'
     RETURNING id
  `);
  if (r.rows.length !== 1) return { kind: "conflict" };
  return { kind: "mirrored", allApproved: false, destinationSubmissionId: null };
}
