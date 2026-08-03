/**
 * THE SINGLE DEFINITION of the Partner credit-reservation lifecycle partition.
 *
 * `partner_credit_reservations.status` is constrained by migration 0017 to exactly four values.
 * Those four are NOT one flat set — they are three states with different accounting meanings, and
 * conflating them is what produced the 0042 settlement defect:
 *
 *   ACTIVE           active              entitlement outstanding, nothing settled
 *   CONSUMED         consumed            settled BY GRADING — the partner has been charged
 *   RELEASE_TERMINAL released, expired   settled BY CANCELLATION — the credit went back
 *
 * A filter naming all four is the entire CHECK domain and therefore no filter at all. Migration
 * 0042 originally selected `status IN ('active','consumed','released','expired')` as its "live"
 * set, so a {consumed, released} submission had zero active rows, matched the "already settled"
 * branch, and let a connector cancellation complete against cards that had already been graded
 * and paid for.
 *
 * tests/partner-0042-state-semantics.test.ts asserts that migration 0042's SQL partitions the
 * domain the same way this module does, so the two cannot drift apart silently.
 */

export const RESERVATION_STATUS_ACTIVE = ["active"] as const;
export const RESERVATION_STATUS_CONSUMED = ["consumed"] as const;
export const RESERVATION_STATUS_RELEASE_TERMINAL = ["released", "expired"] as const;

/** Every value permitted by 0017's CHECK constraint. Used only to prove the partition is total. */
export const RESERVATION_STATUS_DOMAIN = [
  ...RESERVATION_STATUS_ACTIVE,
  ...RESERVATION_STATUS_CONSUMED,
  ...RESERVATION_STATUS_RELEASE_TERMINAL,
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUS_DOMAIN)[number];

export function isActive(status: string): boolean {
  return (RESERVATION_STATUS_ACTIVE as readonly string[]).includes(status);
}
export function isConsumed(status: string): boolean {
  return (RESERVATION_STATUS_CONSUMED as readonly string[]).includes(status);
}
export function isReleaseTerminal(status: string): boolean {
  return (RESERVATION_STATUS_RELEASE_TERMINAL as readonly string[]).includes(status);
}

/**
 * "Live" for the settlement paths means an entitlement that still has accounting weight: it is
 * either outstanding or it was consumed by grading. RELEASE_TERMINAL rows are immutable history.
 *
 * This is deliberately NOT the whole domain — that distinction is the entire point of the module.
 */
export function isLive(status: string): boolean {
  return isActive(status) || isConsumed(status);
}
