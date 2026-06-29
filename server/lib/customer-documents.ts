/**
 * Pure ownership + download-authorization logic for the authenticated customer
 * document routes (Phase 1: /api/customer/submissions/:submissionId/packing-slip
 * and /shipping-label).
 *
 * Kept dependency-free (no db, no express) so the BOLA/IDOR decision lives in
 * ONE unit-testable place. The identity passed in must come from the session —
 * never from request body/query/params.
 */

export interface OwnableSubmission {
  userId?: string | null;
  user_id?: string | null;
  customerEmail?: string | null;
  customer_email?: string | null;
  status?: string | null;
  deletedAt?: Date | string | null;
  deleted_at?: Date | string | null;
}

export interface CustomerIdentity {
  /** legacy magic-link customer session identity */
  customerEmail?: string | null;
  /** unified-account session identity, when present */
  userId?: string | null;
}

function norm(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().trim();
}

/**
 * True iff the submission belongs to the authenticated customer session.
 * Prefers the linked unified-user id when BOTH sides have one; otherwise falls
 * back to the legacy normalized customer email. Empty-vs-empty never matches.
 */
export function isSubmissionOwnedBySession(submission: OwnableSubmission, identity: CustomerIdentity): boolean {
  const subUserId = submission.userId ?? submission.user_id ?? null;
  const sessUserId = identity.userId ?? null;
  if (sessUserId && subUserId && String(sessUserId) === String(subUserId)) return true;

  const subEmail = norm(submission.customerEmail ?? submission.customer_email);
  const sessEmail = norm(identity.customerEmail);
  return sessEmail !== "" && subEmail !== "" && sessEmail === subEmail;
}

function isDeleted(s: OwnableSubmission): boolean {
  return (s.deletedAt ?? s.deleted_at ?? null) != null;
}

export type DownloadAuthResult =
  | { ok: true }
  | { ok: false; status: 404 } // missing / soft-deleted / wrong-owner — indistinguishable
  | { ok: false; status: 400 }; // owned, but not yet downloadable (draft)

/**
 * Decide whether the authenticated customer may download a document for this
 * submission. Ownership/existence is checked BEFORE state, and missing,
 * soft-deleted and wrong-owner all collapse to the SAME 404 so a customer can
 * never probe another customer's submissions. A draft the customer DOES own
 * returns 400 (not ready). (401 for no session is handled by requireCustomer.)
 */
export function authorizeSubmissionDownload(
  submission: OwnableSubmission | null | undefined,
  identity: CustomerIdentity
): DownloadAuthResult {
  if (!submission || isDeleted(submission) || !isSubmissionOwnedBySession(submission, identity)) {
    return { ok: false, status: 404 };
  }
  if ((submission.status ?? "") === "draft") {
    return { ok: false, status: 400 };
  }
  return { ok: true };
}
