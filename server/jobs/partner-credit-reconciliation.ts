/**
 * Grading Credit reconciliation tick.
 *
 * WHY THIS FILE EXISTS. `reconcileCreditReservations()` was already fully implemented — six checks
 * covering wallet-vs-ledger drift, negative balances, missing consume/terminal evidence, duplicate
 * terminal transitions and cross-tenant or orphaned references — but it had NO scheduler, NO route
 * and NO alerting. Its only caller was a unit test. A reconciliation that never runs proves nothing:
 * the master plan requires that the ledger/reservation result be mathematically proven and that
 * drift RAISES AN ALERT rather than being silently repaired.
 *
 * The sibling expiry job (partner-credit-reservation-expiry.ts) is the proven pattern and is
 * followed exactly here: registered from server/index.ts through the normal advisory-locked
 * scheduler, so every Fly Machine may tick while only one performs the work at a time.
 *
 * STRICTLY READ-ONLY. This job NEVER writes to a wallet, ledger or reservation. Drift is a signal to
 * a human, not something to auto-correct — a silent "fix" would destroy the very evidence needed to
 * explain how the money moved. Remediation is an audited Super Admin adjustment.
 */
import { reconcileCreditReservations } from "../partner/partner-credit-reservation-service";

export interface CreditReconciliationOutcome {
  /** True when the reconciliation ran to completion (whether or not it found drift). */
  ran: boolean;
  errors: number;
  warnings: number;
  /** Stable issue codes with counts, e.g. { WALLET_BALANCE_MISMATCH: 2 }. Never row contents. */
  byCode: Record<string, number>;
  /** Bounded sample for the operator log. Never the whole set — a systemic fault could be thousands. */
  sample: string[];
  /** Set when the check could not run at all (e.g. pre-0017 database during rollout). */
  skippedReason?: string;
}

/** How many issue details are logged per tick. Enough to diagnose, small enough to keep logs usable. */
const SAMPLE_LIMIT = 10;

export async function runPartnerCreditReconciliation(): Promise<CreditReconciliationOutcome> {
  let issues;
  try {
    ({ issues } = await reconcileCreditReservations());
  } catch (err) {
    // Application-first rollout: on a database without the G6A/G6B credit tables this throws rather
    // than reporting zero drift. Reporting "could not check" is honest; reporting "no drift" would
    // be a lie of exactly the kind this job exists to prevent.
    return {
      ran: false,
      errors: 0,
      warnings: 0,
      byCode: {},
      sample: [],
      skippedReason: (err as Error).message,
    };
  }

  const byCode: Record<string, number> = {};
  for (const issue of issues) byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;

  return {
    ran: true,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    byCode,
    sample: issues
      .slice(0, SAMPLE_LIMIT)
      .map((i) => `${i.severity.toUpperCase()} ${i.code} tenant=${i.tenantId ?? "-"} ${i.detail}`),
  };
}
