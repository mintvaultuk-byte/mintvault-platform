/**
 * Partner Card Job reconciliation tick.
 *
 * A RECONCILIATION THAT NEVER RUNS PROVES NOTHING. That is the lesson the credit reconciliation job
 * records in its own header — it was fully implemented and tested, with no scheduler, no route and
 * no alerting, so its only caller was a unit test. This job is registered from server/index.ts
 * through the same advisory-locked scheduler on the first tick, so it genuinely executes.
 *
 * WHY THIS ONE REPAIRS AND THE CREDIT ONE DOES NOT.
 *
 * Credit drift is a MONEY-CORRECTNESS fault whose cause is unknown at detection time; an automatic
 * "fix" would destroy the evidence needed to explain how the balance moved, so it alerts and stops.
 *
 * QA/Card Job drift is different in kind: the cause is known exactly (a split transaction whose
 * second half did not land), the correct resolution is a single legal transition that the approval
 * itself should have performed, and the current state is fail-closed — the card is stuck, not wrong.
 * Leaving it alone is not "safe", it is a paid-for card that can never be printed. So this one
 * repairs, under the strict contract in card-job-reconciliation.ts: re-prove everything, move one
 * state, settle nothing, mint nothing, touch no grade, and audit it as a repair.
 *
 * EVERYTHING ELSE IS REPORT-ONLY. Stuck Card Jobs and stale leases have many possible causes and no
 * single safe answer, so they are surfaced for a human and not touched.
 */
import {
  detectStaleLeases,
  detectStuckCardJobs,
  redriveQaCardJobDrift,
  type RedriveSummary,
} from "../partner/card-job-reconciliation";

export interface CardJobReconciliationOutcome {
  /** False when the check could not run at all (e.g. a database without `certificates`). */
  ran: boolean;
  /** QA/Card Job split-transaction drift: detected, and how each item resolved. */
  drift: RedriveSummary;
  /** Report-only counts. */
  stuckCardJobs: number;
  staleLeases: number;
  /** Bounded operator sample. Never the whole set — a systemic fault could be thousands. */
  sample: string[];
  skippedReason?: string;
}

/** Enough detail to diagnose, small enough to keep logs usable. */
const SAMPLE_LIMIT = 10;

export async function runPartnerCardJobReconciliation(): Promise<CardJobReconciliationOutcome> {
  const drift = await redriveQaCardJobDrift();
  if (!drift.ran) {
    return {
      ran: false,
      drift,
      stuckCardJobs: 0,
      staleLeases: 0,
      sample: [],
      skippedReason: drift.skippedReason,
    };
  }

  const sample: string[] = [];
  for (const result of drift.results) {
    if (sample.length >= SAMPLE_LIMIT) break;
    // A REFUSED item is the one an operator must see: the repair's premise did not hold, so the card
    // is still stuck and now needs a human. A repaired one is informational.
    sample.push(
      result.outcome === "refused"
        ? `REFUSED ${result.cardJobId}: ${result.reason ?? "unknown"}`
        : `${result.outcome} ${result.cardJobId}`
    );
  }

  const stuck = await detectStuckCardJobs();
  const stale = await detectStaleLeases();
  for (const item of stuck.items) {
    if (sample.length >= SAMPLE_LIMIT * 2) break;
    sample.push(`STUCK ${item.cardJobId} ${item.status} ${item.hoursStuck}h`);
  }

  return {
    ran: true,
    drift,
    stuckCardJobs: stuck.items.length,
    staleLeases: stale.items.length,
    sample,
  };
}
