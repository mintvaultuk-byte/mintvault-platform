/**
 * THE WELCOME GRANT — five grading credits, once, for a shop MintVault has just created.
 *
 * WHY A SHARED MODULE. The amount, the ledger coordinates and the idempotency key are read by the
 * creation transaction, by the tests that prove exactly-once, and by the surfaces that explain the
 * balance to an operator. Three copies of "5" is how a welcome grant quietly becomes a welcome
 * grant of six.
 *
 * WHY THESE LEDGER COORDINATES. `partner_credit_ledger` is append-only with a fixed vocabulary
 * (partner-wallet-errors.ts):
 *
 *   entry_type `opening_balance` — this IS the wallet's opening position. Not a purchase (no money
 *                                 changed hands), not an admin_adjustment (no human decided it).
 *   source     `system`          — granted by MintVault itself during onboarding. `admin` would
 *                                 claim a Super Admin chose to award it; they did not.
 *   actor_type `system`          — same reason. The audit row still carries the operator who
 *                                 created the shop, which is where "who caused this" belongs.
 *
 * WHY THE KEY IS THE PARTNER ID. The ledger's uniqueness is `(source, idempotency_key)`
 * (uq_partner_credit_ledger_idem, migration 0016), so a key derived from nothing but the partner's
 * own id makes the grant exactly-once for that partner FOREVER — independent of which code path
 * asked, how many times, or how far apart. A page refresh, a create retry, an invitation resend, an
 * Owner activation, a Scanner enrolment and a reinstall all compute the same key and all lose the
 * same ON CONFLICT race. Exactly-once is a property of the key, not of the caller's care.
 */
export const PARTNER_WELCOME_CREDIT_AMOUNT = 5;

/** Recorded verbatim in `partner_credit_ledger.reason`, so the grant is greppable in the ledger. */
export const PARTNER_WELCOME_CREDIT_REASON = "FIRST_SHOP_WELCOME_CREDITS";

/** Stable, derived, and never a random value — see the module note on exactly-once. */
export function partnerWelcomeCreditIdempotencyKey(partnerId: string): string {
  return `first-shop-welcome-credits:${partnerId}`;
}
