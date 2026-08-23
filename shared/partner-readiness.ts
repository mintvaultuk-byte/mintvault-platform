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
  // Onboarding test card — the shop proving, once, that a real card goes end to end.
  | "TEST_CARD_REQUIRED"
  | "TEST_CARD_IN_PROGRESS"
  | "TEST_CARD_AWAITING_REVIEW"
  | "TEST_CARD_BLOCKED"
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

/**
 * THE ONBOARDING TEST CARD — where the shop's own test card has got to.
 *
 * NOT_STARTED      no onboarding-test Card Job exists for this shop.
 * CAPTURING        one exists, but FRONT and BACK are not both accepted yet.
 * READY_TO_GRADE   both sides accepted; the card has reached the Staff/grading handoff.
 * COMPLETE         the test card finished — MintVault graded, approved and released it.
 * BLOCKED          an authoritative blocker on the test card itself (e.g. it was cancelled).
 * UNKNOWN          the Card Job authority could not be consulted. NEVER a pass.
 *
 * Every one of these is DERIVED SERVER-SIDE from the canonical Card Job lifecycle and the explicit
 * `purpose = 'ONBOARDING_TEST'` marker (migration 0109). None of it is inferred from the newest
 * job, the newest MV number, a timestamp or the newest submission — those were the available
 * guesses before the marker existed, and each of them is wrong as soon as a real customer card is
 * scanned during onboarding.
 */
export type PartnerTestCardState =
  | "NOT_STARTED"
  | "CAPTURING"
  | "READY_TO_GRADE"
  | "COMPLETE"
  | "BLOCKED"
  | "UNKNOWN";

export interface PartnerTestCardReadiness {
  state: PartnerTestCardState;
  /** The same four-value vocabulary every other dimension uses, so one renderer serves both. */
  status: ReadinessStatus;
  code: PartnerReadinessCode;
  /** One sentence of operator-facing plain English, produced on the server. */
  message: string;
  actions: ReadinessAction[];
  /**
   * Identity of the test Card Job this verdict is about, so the operator can find the actual card.
   * null in NOT_STARTED and in UNKNOWN — in the second case because nothing was established.
   */
  cardJob: {
    id: string;
    mvNumber: string | null;
    status: string;
    /**
     * Which of FRONT/BACK the capture authority has accepted so far. Informational only — the STATE
     * above comes from the Card Job lifecycle, which the capture path already advances.
     *
     * `null` means the evidence authority could not be consulted (a database without the scanner
     * evidence tables). Deliberately not `[]`: "we could not tell" and "neither side is captured"
     * are different facts, and only one of them should ever be shown to an operator.
     */
    sidesAccepted: Array<"front" | "back"> | null;
  } | null;
}

/**
 * THE canonical fix-first order — the ONE priority every surface must use.
 *
 * It lives in the shared contract rather than on the server because the clients need it too, and
 * the alternative is what shipped before: the Super Admin lifecycle helper ranked blockers by
 * `Object.keys(dimensions)` — JavaScript insertion order — which agreed with the authority only by
 * coincidence and would have diverged the first time a dimension was added anywhere but the end.
 * Import it; never re-declare it.
 */
export const PARTNER_READINESS_DIMENSION_ORDER = [
  "organisation",
  "location",
  "delivery",
  "operationsContact",
  "owner",
  "staff",
  "station",
  "scanner",
  "credits",
] as const satisfies readonly ReadinessDimensionKey[];

/**
 * THE ONE NEXT ACTION — what the operator should do about this shop, right now.
 *
 * WHY THIS IS ON THE SERVER. The 10 checks below are correct but procedural, and every surface that
 * showed them invented its own answer to "so what do I do first?": the Super Admin lifecycle helper
 * walked `Object.keys(dimensions)` (JS insertion order, not the authority's fix-first order), and
 * Needs Attention re-derived blockers from the DASHBOARD projection instead of from readiness at
 * all — so the two could, and did, disagree about the same shop. This field is the single answer;
 * clients render it and never rank blockers themselves.
 *
 * IT INTRODUCES NO RULE. It is a pure selection over values `derivePartnerOperationalReadiness`
 * has already decided: the first non-PASS dimension in the canonical order, then the onboarding
 * test card, then READY. No new check, no new step, no re-interpretation of a status.
 *
 * WHY THE TEST CARD COMES LAST. `overall.ready` deliberately excludes it — a shop that never
 * scanned a test card can still grade — so the test card can only ever be the next action once
 * every operational dimension already passes. That is exactly the operator's sequence: get the shop
 * able to grade, then prove one card end to end.
 */
export interface PartnerNextAction {
  /**
   * What KIND of answer this is.
   *
   * BLOCKED   somebody must act, and `action` says who and what.
   * PENDING   correctly in progress and waiting on someone else (owner setting a password, a
   *           station awaiting our approval). Still the next thing to watch; not a fault.
   * UNKNOWN   an authority could not be consulted. Never rendered as progress, never as READY.
   * READY     nothing left to do. The shop can grade and its test card is finished.
   */
  state: "BLOCKED" | "PENDING" | "UNKNOWN" | "READY";
  /** Stable machine code, reused verbatim from the dimension or test card this came from. */
  code: PartnerReadinessCode;
  /** Short operator-facing headline, e.g. "Scanner waiting for approval". */
  title: string;
  /** The same sentence the underlying dimension already produced. Never re-worded per surface. */
  message: string;
  /**
   * Where this verdict came from, so a surface can deep-link to the right place and a test can
   * assert provenance. `"testCard"` when it came from the onboarding test card, null when READY.
   */
  source: ReadinessDimensionKey | "testCard" | null;
  /**
   * The single control to render. ABSENT when no legitimate in-product action exists — waiting on
   * the owner to set their own password is not something MintVault can click — in which case the
   * surface shows `title`/`message` as status text. A button that cannot work is worse than none.
   */
  action: ReadinessAction | null;
}

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
  /**
   * The ONE thing to do next. Always present — READY when there is nothing left. Every surface that
   * shows "what now?" reads this and nothing else; see PartnerNextAction for why.
   */
  nextAction: PartnerNextAction;
  /**
   * The onboarding test card, kept OUTSIDE `dimensions` on purpose.
   *
   * `overall` answers "can this shop start a NEW grading job right now?", and a shop that has never
   * scanned a test card can. Folding the test card into `dimensions` would silently change that
   * question for every existing consumer — including the Command Centre's blocked-partner rollup,
   * which iterates the dimension map — and would report every long-established Partner as blocked
   * on a step that did not exist when they were onboarded. The test card is an ONBOARDING question,
   * so it is answered beside the operational one rather than mixed into it.
   */
  testCard: PartnerTestCardReadiness;
  /**
   * Is FIRST-SHOP ONBOARDING finished? The wizard's final step, and nothing else, reads this.
   *
   * Deliberately stricter than `overall.ready`: complete requires every operational dimension to
   * PASS *and* the test card to have finished. It can never be true while any authority is UNKNOWN,
   * because `overall.ready` already fails closed on UNKNOWN and the test card does the same.
   */
  onboarding: {
    complete: boolean;
    code: PartnerReadinessCode;
    message: string;
  };
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
