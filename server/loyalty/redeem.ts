/**
 * Loyalty redemption — TODO STUB.
 *
 * Out of scope this PR. No logic, no route, no DB writes. The function
 * signature lands here as a placeholder so the eventual implementation
 * has an obvious home and reviewers can search for "redeemPoints" without
 * finding a half-written body.
 *
 * TODO (post legal sign-off):
 *   - Implement redeem flow: reserve points, create loyaltyRedemptions
 *     row tied to a submission, mirror to ledger as a negative delta
 *     with reason='redeem' inside the same tx.
 *   - Add validation: balance >= pointsSpent, cooldown rules if any.
 *   - Add /api/loyalty/redeem POST route with requireCustomer auth.
 *   - Email confirmation, T&Cs version snapshot in metadata.
 */

export interface RedeemInput {
  userId:        string;
  submissionId:  string;
  pointsSpent:   number;
  tier:          string;
}

export interface RedeemResult {
  status: "redeemed" | "insufficient_balance" | "not_implemented";
  ledgerId?: string;
  balanceAfter?: number;
  reason?: string;
}

export async function redeemPoints(_input: RedeemInput): Promise<RedeemResult> {
  // TODO: implement after legal sign-off of loyalty programme T&Cs.
  return { status: "not_implemented", reason: "loyalty redemption is not enabled" };
}
