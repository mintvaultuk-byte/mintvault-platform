/**
 * Partner rating reconciliation entry point.
 *
 * Registered from server/index.ts through the normal advisory-lock scheduler, so every production
 * instance may tick while only one instance reconciles at a time. The domain operation is bounded,
 * idempotent, and treats a pre-0062 database as a safe no-op during an application-first rollout —
 * the same shape as the credit-reservation expiry job next to it.
 *
 * This is the SAFETY NET, not the primary mechanism. Ratings are refreshed immediately after the
 * review that changed them; this exists for the cases that mechanism cannot cover — a process that
 * died between commit and refresh, a machine restart, a transient database error.
 */
import { runRatingReconciler, type ReconcilerResult } from "../partner/public-network-rating-lifecycle";

export async function runPartnerRatingReconciler(): Promise<ReconcilerResult> {
  return runRatingReconciler();
}
