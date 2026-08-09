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
  /**
   * This exact card was mirrored to `approved` by a concurrent actor that won the destination lock.
   * The final state has been observed under that lock; there is nothing left to do and nothing to
   * settle twice. Distinct from `conflict` so the caller reports success rather than a 409 for a
   * card that genuinely IS approved.
   */
  | { kind: "already_approved"; destinationSubmissionId: number | null }
  /**
   * F1 RE-DRIVE OUTCOMES. All four describe a partner card whose work item is NO LONGER
   * `pending_review` — the post-commit states the old `pendingPartnerWorkItem()` gate collapsed into
   * a single indistinguishable `not_partner`.
   */
  /** The destination had already passed settlement. Nothing to do; the money moved on an earlier call. */
  | { kind: "already_settled"; destinationSubmissionId: number | null }
  /**
   * Units on this destination are still outstanding, so there is nothing to settle yet.
   * `workItemStatus` is THIS card's own status, which distinguishes the ordinary case (this card is
   * approved, siblings are not) from the partner-submit freeze described on `redriveSettlement`
   * (this card's own work item is still `assigned` while its certificate says pending_review).
   */
  | {
      kind: "settlement_pending_other_cards";
      destinationSubmissionId: number | null;
      outstandingUnits: number;
      workItemStatus: string;
    }
  /** The destination was approved-but-unsettled and this call DROVE settlement to completion. */
  | { kind: "settled_on_retry"; destinationSubmissionId: number | null }
  /**
   * The destination was approved-but-unsettled, the re-drive ran, and settlement refused. The
   * caller MUST NOT report success: `reasonCode` names the fail-closed condition (the same code
   * written to partner_credit_accounting_exceptions).
   */
  | { kind: "settlement_failed"; destinationSubmissionId: number | null; reasonCode: string; message: string }
  /** A partner work item exists but did not move — concurrent change. Caller must not report success. */
  | { kind: "conflict" };

/**
 * Destination statuses that can only be reached BY settlement (or after it).
 *
 * `settlePartnerCreditForDestinationStatus` is the sole writer of `ready_to_return` for a
 * partner-linked destination, and the print-completion cascade only advances a destination to
 * `shipped`/`completed` from `ready_to_return`. So membership here is a sound post-commit answer to
 * "has the money already moved for this destination?" without reading the credit tables at all —
 * which matters, because the credit tables live behind a different pool and reading them here would
 * widen this function's lock/connection footprint for no gain.
 *
 * It is ALSO the guard that stops a re-drive from REGRESSING a destination: settlement re-writes
 * `status = 'ready_to_return'`, so re-driving a destination that has since shipped would walk it
 * backwards. Anything in this set is left alone.
 */
const SETTLED_DESTINATION_STATUSES = new Set(["ready_to_return", "shipped", "completed"]);

interface PartnerCertContext {
  destinationSubmissionId: number;
  workItemStatus: string;
  destinationStatus: string;
}

/**
 * The partner work item attached to this certificate, WHATEVER its status.
 *
 * This replaces the old `pendingPartnerWorkItem()` boolean, which keyed on
 * `pgwi.status = 'pending_review'`. That predicate is PRE-commit state: once the mirror transaction
 * commits `approved` it is false forever, so every retry of an approval returned `not_partner` —
 * indistinguishable from an ordinary HQ card, and reported by the route as a clean 200. If the
 * commit-then-settle window had been interrupted (a fail-closed settlement condition, a crash, a pod
 * restart, a transient DB loss), the destination was left approved, published and UNSETTLED, with
 * every credit still reserved, and no retry could ever tell anyone.
 *
 * The join is unchanged and still identity-checked on all three columns, so a work item that does
 * not belong to this exact certificate/item/destination triple is not picked up.
 */
async function partnerCertContext(certId: number): Promise<PartnerCertContext | null> {
  const r = await db.execute(sql`
    SELECT pgwi.destination_submission_id::int AS destination_submission_id,
           pgwi.status::text                   AS work_item_status,
           dest.status::text                   AS destination_status
      FROM partner_grading_work_items pgwi
      JOIN certificates cert
        ON cert.id = pgwi.certificate_id
       AND cert.submission_item_id = pgwi.submission_item_id
      JOIN submission_items si
        ON si.id = cert.submission_item_id
       AND si.submission_id = pgwi.destination_submission_id
      JOIN submissions dest
        ON dest.id = pgwi.destination_submission_id
     WHERE cert.id = ${certId}
     LIMIT 1
  `);
  const row = r.rows[0] as
    | { destination_submission_id?: number; work_item_status?: string; destination_status?: string }
    | undefined;
  if (!row || row.destination_submission_id == null) return null;
  return {
    destinationSubmissionId: row.destination_submission_id,
    workItemStatus: String(row.work_item_status ?? ""),
    destinationStatus: String(row.destination_status ?? ""),
  };
}

/** True when this certificate is attached to a partner grading work item awaiting review. */
async function pendingPartnerWorkItem(certId: number): Promise<boolean> {
  const ctx = await partnerCertContext(certId);
  return ctx?.workItemStatus === "pending_review";
}

function settlementReasonCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return "settlement_unknown_failure";
}

/**
 * Drive settlement for a destination whose approved set is complete.
 *
 * DELIBERATELY OUTSIDE ANY TRANSACTION OF OURS, AND HOLDING NO LOCK — see the deadlock note on
 * `mirrorPartnerApproval`. This function is called only after every `partner_grading_work_items`
 * lock this module took has been released at COMMIT (or, on the re-drive path, without ever having
 * taken one). `settlePartnerCreditForDestinationStatus` opens its OWN transaction on the partner
 * admin pool and takes `submissions FOR UPDATE` first, so concurrent re-drives serialise there —
 * and it is idempotent, so a second arrival replays to the same end state rather than double-
 * consuming.
 */
async function driveSettlement(
  destinationSubmissionId: number,
  certId: number,
  adminUser: string
): Promise<void> {
  await storage.updateSubmissionStatus(destinationSubmissionId, "ready_to_return", {
    partner_grading_approved_by: adminUser,
    partner_grading_completed_cert_id: certId,
  });
}

/**
 * F1 RE-DRIVE. Reached when the certificate IS a partner card but its work item has already left
 * `pending_review` — i.e. the mirror transaction committed on some earlier call.
 *
 * The decision is made entirely from POST-COMMIT state:
 *   - destination already at/past `ready_to_return` -> settled, nothing to do;
 *   - any sibling unit still outstanding             -> not the complete set, nothing to settle;
 *   - zero live units                                -> vacuous, refuse to claim settlement (F3's
 *                                                       failure mode, applied here too);
 *   - otherwise                                      -> approved-but-UNSETTLED: drive settlement.
 *
 * Only the last case moves money, and it moves it through exactly the same call the happy path
 * uses, so there is one settlement code path, not two.
 *
 * WHAT THIS DOES *NOT* REPAIR — the partner-submit entry point, stated explicitly.
 * -------------------------------------------------------------------------------
 * A second reviewer found the same `not_partner` freeze reachable from
 * server/partner/grading-routes.ts `submit` and `edit-submission`. Those are four-statement
 * sequences with NO enclosing transaction: applyCertGradeDraft -> persistPartnerGradeAuthorityScore
 * -> partnerSubmitForReview -> UPDATE partner_grading_work_items. If the fourth statement matches
 * zero rows (a concurrent HQ reassignment, or any DB error) the route returns 409 while the
 * certificate is ALREADY `pending_review` and the work item is still `assigned`.
 *
 * The change here makes that state DIAGNOSABLE but does not fix it. A later approval on such a card
 * lands in this function, finds `workItemStatus = 'assigned'`, counts it as outstanding and returns
 * `settlement_pending_other_cards` carrying that status — no longer `not_partner`, and no longer a
 * 200 that reads as success. But the work item can never reach `pending_review` again by itself, so
 * the card still cannot be approved or settled without operator intervention. The real repair is to
 * wrap those four statements in one transaction, which is a change to grading-routes.ts and is
 * deliberately out of scope for this finding.
 */
async function redriveSettlement(
  certId: number,
  ctx: PartnerCertContext,
  adminUser: string
): Promise<PartnerMirrorResult> {
  const destinationSubmissionId = ctx.destinationSubmissionId;
  if (SETTLED_DESTINATION_STATUSES.has(ctx.destinationStatus)) {
    return { kind: "already_settled", destinationSubmissionId };
  }

  const counts = await db.execute(sql`
    SELECT count(*) FILTER (WHERE status NOT IN ('approved','completed','void'))::int AS outstanding,
           count(*) FILTER (WHERE status <> 'void')::int                              AS live_units
      FROM partner_grading_work_items
     WHERE destination_submission_id = ${destinationSubmissionId}
  `);
  const row = counts.rows[0] as { outstanding?: number; live_units?: number } | undefined;
  const outstanding = Number(row?.outstanding ?? 0);
  const liveUnits = Number(row?.live_units ?? 0);

  if (outstanding > 0) {
    return {
      kind: "settlement_pending_other_cards",
      destinationSubmissionId,
      outstandingUnits: outstanding,
      workItemStatus: ctx.workItemStatus,
    };
  }
  if (liveUnits === 0) {
    // Zero graded units is not "settled" — it is a submission with nothing to charge for. Claiming
    // success here would be the vacuous-completion shape F3 hardens in the print-completion gate.
    return {
      kind: "settlement_failed",
      destinationSubmissionId,
      reasonCode: "no_live_graded_units",
      message: "Every grading work item on this destination is void; there is nothing to settle.",
    };
  }

  try {
    await driveSettlement(destinationSubmissionId, certId, adminUser);
  } catch (error) {
    return {
      kind: "settlement_failed",
      destinationSubmissionId,
      reasonCode: settlementReasonCode(error),
      message: error instanceof Error ? error.message : "Partner credit settlement failed.",
    };
  }
  return { kind: "settled_on_retry", destinationSubmissionId };
}

/**
 * Destinations whose grading is finished but whose credits were never settled.
 *
 * F1's stranded state is now VISIBLE. Before this, a submission that fell through the
 * commit-then-act window sat in `in_grading` with N credits reserved for the full 365-day
 * reservation TTL, and nothing anywhere named it: the UI reported 200 on every retry and no query
 * described the shape. This is that query. Read-only, no locks, no writes.
 *
 * "Stranded" is exactly the re-drive precondition: at least one live (non-void) work item, every
 * live work item approved or completed, and the destination still short of `ready_to_return`.
 * Anything listed here can be cleared by re-approving the card (which now re-drives) or by the
 * existing `POST /api/admin/submissions/:id/status` route.
 */
export interface StrandedPartnerSettlement {
  destinationSubmissionId: number;
  destinationReference: string | null;
  destinationStatus: string;
  tenantId: string | null;
  partnerSubmissionId: string | null;
  liveUnits: number;
  certificateId: number | null;
}

export async function findStrandedPartnerSettlements(): Promise<StrandedPartnerSettlement[]> {
  const exists = await db.execute(sql`SELECT to_regclass('public.partner_grading_work_items')::text AS rel`);
  if (!(exists.rows[0] as { rel?: string | null } | undefined)?.rel) return [];
  const r = await db.execute(sql`
    SELECT pgwi.destination_submission_id::int                       AS destination_submission_id,
           max(dest.tracking_number)                                 AS destination_reference,
           max(dest.status::text)                                    AS destination_status,
           max(pgwi.tenant_id::text)                                 AS tenant_id,
           max(pgwi.partner_submission_id::text)                     AS partner_submission_id,
           count(*) FILTER (WHERE pgwi.status <> 'void')::int         AS live_units,
           min(pgwi.certificate_id)::int                             AS certificate_id
      FROM partner_grading_work_items pgwi
      JOIN submissions dest ON dest.id = pgwi.destination_submission_id
     WHERE dest.status NOT IN ('ready_to_return','shipped','completed')
     GROUP BY pgwi.destination_submission_id
    HAVING count(*) FILTER (WHERE pgwi.status <> 'void') > 0
       AND count(*) FILTER (WHERE pgwi.status NOT IN ('approved','completed','void')) = 0
     ORDER BY 1
  `);
  return (
    r.rows as unknown as {
      destination_submission_id: number;
      destination_reference: string | null;
      destination_status: string | null;
      tenant_id: string | null;
      partner_submission_id: string | null;
      live_units: number;
      certificate_id: number | null;
    }[]
  ).map((row) => ({
    destinationSubmissionId: Number(row.destination_submission_id),
    destinationReference: row.destination_reference,
    destinationStatus: String(row.destination_status ?? ""),
    tenantId: row.tenant_id,
    partnerSubmissionId: row.partner_submission_id,
    liveUnits: Number(row.live_units),
    certificateId: row.certificate_id == null ? null : Number(row.certificate_id),
  }));
}

/**
 * Mark the partner work item approved, and move the destination submission on when every live
 * card unit is approved.
 *
 * `status <> 'void'` excludes voided units from the completeness test, so a submission whose only
 * outstanding unit was voided still completes — while a genuinely outstanding unit still blocks it.
 *
 * SERIALISATION (H4). The completeness read is a submission-level decision made from per-card
 * writes, so without a lock it is a textbook write-skew: two Super Admins approving two DIFFERENT
 * cards of the same submission touch different rows, never block each other, and each reads the
 * other's card as still pending. Both return 200, every card is approved, and NEITHER settles —
 * the submission is left fully graded, unbilled and stuck in `in_grading`. Reproduced on real
 * PostgreSQL 17 (settles = 0; the sequential control settles exactly once).
 *
 * The fix is the `FOR UPDATE` below, taken BEFORE the per-card UPDATE. It is scoped to ONE
 * destination submission — never a table-wide or global lock — so approvals on other submissions
 * and other tenants proceed in parallel exactly as before. `ORDER BY id` fixes the acquisition
 * order, so two actors on the same destination queue behind the same first row instead of grabbing
 * rows in opposite orders. The second actor blocks until the first commits, then reads a complete,
 * committed picture: exactly one actor ever observes the full approved set, so exactly one settles.
 *
 * The lock covers two statements (the lock read and the per-card UPDATE) plus the completeness
 * read, and is released at COMMIT. Settlement deliberately stays OUTSIDE the transaction — the
 * mirror never holds partner_grading_work_items locks while `submissions` and the credit tables are
 * being written, which is what keeps this transaction's lock set a single table and therefore
 * incapable of forming a deadlock cycle with the print-completion or settlement paths.
 *
 * F1 RE-DRIVE AND THE DEADLOCK CONSTRAINT.
 * ----------------------------------------
 * The obvious repair for a commit-then-act window is to pull the act inside the commit. That is
 * exactly what must NOT happen here, and the re-drive is built so it does not.
 *
 * Moving settlement inside this transaction would give it the lock order
 * `partner_grading_work_items -> submissions -> partner_credit_*`. Both other writers of that set
 * acquire in the opposite order: `settlePartnerCreditForDestinationStatus` takes
 * `submissions FOR UPDATE` FIRST and reaches partner_grading_work_items only afterwards (its
 * approval-evidence read), and `markCompleted` takes `certificates`/`submissions` before its
 * work-item cascade UPDATE. Two actors — one approving the final card of destination D, one
 * completing a print batch containing D — would then hold the first lock each other needs, which is
 * a textbook ABBA cycle resolved by PostgreSQL killing one transaction at random. That is the
 * design the existing comment above is defending, and it is still correct.
 *
 * The re-drive therefore takes NO lock of its own. It runs only when this module's transaction is
 * NOT open (the work item already left `pending_review`, so nothing is mirrored and no
 * `FOR UPDATE` is taken), does three read-committed SELECTs that release immediately, and then
 * calls the SAME settlement entry point the happy path calls, on its own connection and in its own
 * transaction, with its own unchanged lock order. No new edge is added to the wait-for graph.
 * Correctness under concurrent re-drives comes from settlement's own
 * `SELECT ... FROM submissions WHERE id=$1 FOR UPDATE` plus its idempotency, not from a lock held
 * here.
 */
export async function mirrorPartnerApproval(certId: number, adminUser: string): Promise<PartnerMirrorResult> {
  const context = await partnerCertContext(certId);
  // A certificate with no partner work item at all is an ordinary HQ card. Unchanged.
  if (!context) return { kind: "not_partner" };
  /**
   * F1. The work item has already left `pending_review`, so the mirror transaction committed on an
   * earlier call. That does NOT mean the work is finished: settlement runs after that commit and
   * outside it, so this is exactly the window where the destination can be left approved, published
   * and unsettled. Re-drive from post-commit state instead of returning `not_partner`.
   */
  if (context.workItemStatus !== "pending_review") return redriveSettlement(certId, context, adminUser);

  const outcome = await db.transaction(async (tx) => {
    // The destination this card belongs to. Immutable once the connector import linked it, so it is
    // safe to read before the lock — it only names the scope the lock is then taken over.
    const scope = await tx.execute(sql`
      SELECT destination_submission_id::int AS destination_submission_id
        FROM partner_grading_work_items
       WHERE certificate_id = ${certId}
       LIMIT 1
    `);
    const destinationSubmissionId =
      (scope.rows[0] as { destination_submission_id?: number } | undefined)?.destination_submission_id ?? null;
    if (destinationSubmissionId == null) return null;

    // Tenant/destination-scoped serialisation point. Deterministic order, one submission only.
    await tx.execute(sql`
      SELECT 1
        FROM partner_grading_work_items
       WHERE destination_submission_id = ${destinationSubmissionId}
       ORDER BY id
       FOR UPDATE
    `);

    const workUpdate = await tx.execute(sql`
      UPDATE partner_grading_work_items
         SET status = 'approved', updated_at = NOW()
       WHERE certificate_id = ${certId}
         AND status = 'pending_review'
       RETURNING id
    `);
    if (workUpdate.rows.length !== 1) {
      // Nothing moved. Under the lock we can now tell the two cases apart: either a concurrent
      // actor already mirrored THIS card to `approved` (the same-card race — the loser must report
      // the final state as success and must not settle again), or the item went somewhere else
      // entirely (returned_for_change / void), which is a real conflict.
      const observed = await tx.execute(sql`
        SELECT status::text AS status
          FROM partner_grading_work_items
         WHERE certificate_id = ${certId}
         LIMIT 1
      `);
      const status = (observed.rows[0] as { status?: string } | undefined)?.status ?? null;
      return status === "approved" ? { alreadyApproved: true as const, destinationSubmissionId } : null;
    }

    const statusCheck = await tx.execute(sql`
      SELECT pgwi.destination_submission_id::int AS destination_submission_id,
             bool_and(pgwi.status = 'approved') AS all_approved
        FROM partner_grading_work_items pgwi
       WHERE pgwi.destination_submission_id = ${destinationSubmissionId}
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
  if ("alreadyApproved" in outcome) {
    return { kind: "already_approved", destinationSubmissionId: outcome.destinationSubmissionId };
  }

  if (outcome.allApproved && outcome.destinationSubmissionId) {
    /**
     * Still allowed to THROW on this, the first attempt. A settlement refusal here is all-or-nothing
     * (nothing consumed, destination not advanced) and the route turns it into a named 409 — the
     * request has already failed loudly, so there is no silent-success to close. What F1 fixes is
     * the RETRY, which used to be a bare 200; see `redriveSettlement`.
     */
    await driveSettlement(outcome.destinationSubmissionId, certId, adminUser);
  }
  return {
    kind: "mirrored",
    allApproved: outcome.allApproved,
    destinationSubmissionId: outcome.destinationSubmissionId,
  };
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
