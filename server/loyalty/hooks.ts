/**
 * Loyalty hooks — STUBS ONLY.
 *
 * These functions are deliberately not wired into the submission /
 * certificate completion code paths. They exist so the eventual wiring
 * has a clear, well-typed entry point — and so reviewers can audit
 * "where would loyalty actually fire from" before the wiring lands.
 *
 * TODO (legal sign-off required):
 *   - Loyalty programme T&Cs reviewed + accepted by every existing
 *     customer before any earn/redeem activity goes live.
 *   - Wire onSubmissionCompleted into the submission status
 *     transition path (status='completed' or 'delivered' depending
 *     on the programme spec).
 *   - Wire onCertificateGraded into the /api/admin/certificates/:id/
 *     approve handler, after the grade row is written.
 *   - Replace the body of each function with a real awardPoints() call
 *     that uses the EARN_SUBMISSION / EARN_CERTIFICATE constants and
 *     the Vault Club multiplier.
 *
 * Until then: log + return. No DB writes from this module.
 */

export function onSubmissionCompleted(submissionId: number | string): void {
  console.log(`[loyalty/hooks] STUB onSubmissionCompleted(${submissionId}) — wiring deferred to legal sign-off`);
}

export function onCertificateGraded(certId: string): void {
  console.log(`[loyalty/hooks] STUB onCertificateGraded(${certId}) — wiring deferred to legal sign-off`);
}
