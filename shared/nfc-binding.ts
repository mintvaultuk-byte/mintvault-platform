/**
 * P11 — WHEN AN NFC TAG MAY BE BOUND TO A CERTIFICATE.
 *
 * THE DEFECT THIS CLOSES. The bind route checked exactly three things: that a uid and url were
 * supplied, that the uid was not already registered, and that the certificate did not already carry a
 * DIFFERENT uid. It never read `grade_approved_at`, `deleted_at`, `status` or `print_state`. So a
 * chip could be written for a draft, ungraded, unapproved, voided or soft-deleted card.
 *
 * That is not a cosmetic gap. The PUBLIC scan route already refuses to resolve an unapproved
 * certificate — `gradeApprovedAt == null` returns 404 — so every such tag was a physical object,
 * embedded in a slab and handed to a customer, that resolved to "not found" when tapped. The failure
 * became visible only after the card had shipped, which is the worst possible place to discover it.
 *
 * WHY A PURE FUNCTION RATHER THAN AN INLINE CHECK. The rule is a release-critical precondition on a
 * tamper-evident physical object, so it must be provable on its own rather than only reachable
 * through an authenticated HTTP route with a live database behind it. Extracting it means the proof
 * exercises the SAME code the route runs, not a paraphrase of it.
 *
 * DELIBERATELY THE SAME FACT THE PUBLIC ROUTE USES. `grade_approved_at` is the single definition of
 * "this certificate is real and public" across the system. Adding a second, subtly different notion
 * of readiness here is how the bind gate and the scan gate drift apart.
 */

export type NfcBindRefusal =
  /** The certificate does not exist, or has been soft-deleted. */
  | "not_found"
  /** The certificate has not cleared QA approval, so a tag would resolve to nothing when tapped. */
  | "not_approved";

export interface NfcBindCandidate {
  gradeApprovedAt?: Date | string | null;
  deletedAt?: Date | string | null;
}

export type NfcBindDecision = { ok: true } | { ok: false; refusal: NfcBindRefusal; status: number; error: string };

/**
 * May a tag be bound to this certificate?
 *
 * Note what is deliberately NOT required: a printed label. A slab is assembled with the chip inside
 * it, so binding legitimately happens before or alongside printing, and demanding `printed` here
 * would make the physical workflow impossible. Approval is the line that matters, because approval is
 * what makes the tag resolve.
 */
export function checkNfcBindable(cert: NfcBindCandidate | null | undefined): NfcBindDecision {
  if (!cert || cert.deletedAt != null) {
    return { ok: false, refusal: "not_found", status: 404, error: "Certificate not found" };
  }
  if (cert.gradeApprovedAt == null) {
    return {
      ok: false,
      refusal: "not_approved",
      status: 409,
      error: "This certificate is not approved, so an NFC tag cannot be bound to it.",
    };
  }
  return { ok: true };
}
