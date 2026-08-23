/**
 * OWNER EMAIL ELIGIBILITY — the shared shape of "can this address be a new shop's Owner?"
 *
 * TYPES ONLY. The answer is decided on the server by `checkOwnerEmailEligibility`, using the same
 * finder the create transaction runs, and rendered verbatim by the CREATE SHOP form. Nothing on the
 * client re-derives availability: a pre-flight check that disagrees with the thing it is checking is
 * worse than no pre-flight check at all.
 */

/** What the create path found already holding this address. */
export interface PartnerOwnerEmailClash {
  partnerId: string;
  partnerName: string;
  /** Canonical partner_users.status: ACTIVE, INVITED, SUSPENDED or REVOKED. */
  userStatus: string;
  /** The user's most recent invitation. `null` means they were never invited. */
  invitationStatus: string | null;
  invitationExpiresAt: string | null;
  /**
   * Whether a CANONICAL authority exists that could free this address.
   *
   * True only for INVITED, where `amendPendingInvitation` can move a pending invitation elsewhere.
   * It is false for ACTIVE, SUSPENDED and REVOKED because no authority changes a non-invited user's
   * email — and REVOKED is terminal by design, since that address is what ties a person's audit,
   * security, grading, station and financial history together.
   */
  releasable: boolean;
  /** Why the address is held, in Super Admin's words. */
  reason: string;
  /** The exact supported resolution. Never a suggestion with no authority behind it. */
  nextAction: string;
}

export interface OwnerEmailEligibility {
  email: string;
  available: boolean;
  conflict: PartnerOwnerEmailClash | null;
}
