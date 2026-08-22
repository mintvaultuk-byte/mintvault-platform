/**
 * PARTNER OPERATIONAL READINESS — the shared contract shape (P5).
 *
 * WHY THIS EXISTS. MintVault had two readiness authorities that disagreed. The Partner Portal used
 * the server-side `getPartnerOnboardingReadiness` / `buildLoginReadiness` pair. The Super Admin
 * partner detail page used a client-side `computeChecklist` + `checklistPercent`, and those two
 * helpers hard-coded the station and credits rows as "unavailable" while `checklistPercent`
 * filtered unavailable rows out of its own denominator. A shop with a completed profile therefore
 * rendered "100% complete" to the operator while having no approved station and no Grading Credits
 * — i.e. while being unable to grade a single card. The percentage was not merely imprecise; it was
 * confidently wrong about the only question that matters.
 *
 * READINESS IS A DECISION, NOT A PERCENTAGE. This contract answers exactly one question — can this
 * Partner start a NEW grading job right now? — and, when the answer is no, which single condition
 * to fix first. There is deliberately no score, no percentage and no progress bar: a number that
 * blends "branding uploaded" with "has credits" can always be pushed upward by work that changes
 * nothing operationally.
 *
 * These are TYPES ONLY. Every value, including the human-readable copy, is derived on the server by
 * `derivePartnerOperationalReadiness` and rendered verbatim by both clients. Nothing here
 * re-implements a rule, because two implementations of one rule is how the drift being repaired
 * started.
 */

/**
 * PASS      the dimension is satisfied.
 * BLOCKED   something is wrong and somebody must act.
 * PENDING   correctly in progress; waiting, not broken (e.g. station awaiting MintVault approval).
 * UNKNOWN   the authority could not be consulted. NEVER equivalent to PASS — see the note below.
 *
 * UNKNOWN is a genuine third state, carried over from the existing station probe's rule that `null`
 * means "cannot tell", not `false`. An absent migration, an unreachable wallet or a missing version
 * policy must never resolve to green: the whole point of this contract is that it refuses to claim
 * a Partner can grade unless it has positively established that they can.
 */
export type ReadinessStatus = "PASS" | "BLOCKED" | "PENDING" | "UNKNOWN";

/** Who can actually resolve a blocked dimension. Drives which action a given audience is shown. */
export type ReadinessAudience = "PARTNER" | "SUPER_ADMIN" | "BOTH";

export interface ReadinessAction {
  /** Who this action is for. A Partner is never offered an action only MintVault can perform. */
  audience: ReadinessAudience;
  label: string;
  /**
   * In-product destination. ABSENT when no legitimate destination exists — station enrolment
   * happens in the Scanner app, and approval is MintVault's to give — so the UI renders explanatory
   * text instead of a control. A button that cannot work is worse than no button.
   */
  href?: string;
}

export interface ReadinessDimension {
  status: ReadinessStatus;
  /** Stable machine code. Safe to branch on; safe to log. */
  code: PartnerReadinessCode;
  /** One sentence of operator-facing plain English. No internal architecture vocabulary. */
  message: string;
  actions: ReadinessAction[];
}

/**
 * Codes.
 *
 * Existing canonical names are REUSED rather than aliased: `STATION_SETUP_REQUIRED`,
 * `AWAITING_PASSWORD_SETUP` and `AWAITING_MFA_SETUP` already exist as `onboardingState` values on
 * the shipped readiness payload, so introducing STATION_ENROLMENT_REQUIRED / PASSWORD_SETUP_REQUIRED
 * / MFA_SETUP_REQUIRED beside them would have created two names for one condition — the exact
 * duplication this package exists to remove.
 */
export type PartnerReadinessCode =
  | "READY"
  // Organisation / portal
  | "PARTNER_SUSPENDED"
  | "PARTNER_REVOKED"
  | "PORTAL_DISABLED"
  | "LOGIN_DISABLED"
  | "EMERGENCY_STOP"
  // Owner / user
  | "OWNER_SETUP_REQUIRED"
  | "AWAITING_PASSWORD_SETUP"
  | "INVITATION_EXPIRED"
  | "AWAITING_MFA_SETUP"
  | "USER_SUSPENDED"
  // Location
  | "LOCATION_REQUIRED"
  | "DELIVERY_ADDRESS_REQUIRED"
  | "OPERATIONS_CONTACT_REQUIRED"
  // Station
  | "STATION_SETUP_REQUIRED"
  | "STATION_APPROVAL_PENDING"
  | "STATION_UNAVAILABLE"
  // Scanner health
  | "SCANNER_OFFLINE"
  | "SCANNER_UPDATE_REQUIRED"
  | "CALIBRATION_REQUIRED"
  // Staff
  | "STAFF_OPERATOR_REQUIRED"
  | "STAFF_LOCATION_ASSIGNMENT_REQUIRED"
  // Credits
  | "CREDITS_REQUIRED"
  // Any authority that could not be consulted
  | "CONFIGURATION_UNAVAILABLE";

export type ReadinessDimensionKey =
  | "organisation"
  | "location"
  | "delivery"
  | "operationsContact"
  | "owner"
  | "staff"
  | "station"
  | "scanner"
  | "credits";

export interface PartnerOperationalReadiness {
  overall: {
    /** True ONLY when every load-bearing dimension is PASS. Never true alongside UNKNOWN. */
    ready: boolean;
    code: PartnerReadinessCode;
    message: string;
  };
  dimensions: Record<ReadinessDimensionKey, ReadinessDimension>;
  /** The blocking dimensions in fix-first order, flattened for direct rendering. */
  actions: Array<ReadinessAction & { dimension: ReadinessDimensionKey; code: PartnerReadinessCode }>;
}

/**
 * Optional profile completeness — branding, address, trading name.
 *
 * Kept deliberately OUTSIDE PartnerOperationalReadiness and never consulted by `overall`. It is
 * genuinely useful to an operator ("this shop never finished its profile") and genuinely irrelevant
 * to whether a card can be graded. Blending the two is what produced the misleading percentage, so
 * the type system now keeps them apart: there is no path by which a branding upload can influence
 * `ready`.
 */
export interface PartnerProfileCompleteness {
  items: Array<{ key: string; label: string; done: boolean }>;
  completed: number;
  total: number;
}
