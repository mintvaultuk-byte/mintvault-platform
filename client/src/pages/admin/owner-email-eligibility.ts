/**
 * OWNER EMAIL ELIGIBILITY — the CREATE SHOP form's decision, as a pure function.
 *
 * WHY THIS IS NOT INLINE IN THE PAGE. "Create fired a request it should have refused" is a logic
 * bug, and the only honest way to prove it cannot happen is to test the decision exhaustively. The
 * page has no interactive render harness, so a decision buried in JSX could only ever be checked by
 * reading it. Here it is five inputs and one answer, and every combination is pinned by a test.
 *
 * IT DECIDES NOTHING ABOUT AVAILABILITY. The server answers that; this only turns the lookup's
 * lifecycle into the state the form renders and the rule the submit handler obeys.
 */
export type OwnerEmailState = "idle" | "checking" | "available" | "unavailable" | "error";

export interface OwnerEmailLookup {
  /** The debounced address actually being asked about. Empty until one looks plausible. */
  query: string;
  isFetching: boolean;
  isError: boolean;
  /** The server's answer, when it has given one. */
  available: boolean | undefined;
}

export function ownerEmailState(lookup: OwnerEmailLookup): OwnerEmailState {
  if (!lookup.query) return "idle";
  // In-flight wins over a previous answer: a stale yes must not green-light a new address.
  if (lookup.isFetching) return "checking";
  if (lookup.isError) return "error";
  if (lookup.available === true) return "available";
  if (lookup.available === false) return "unavailable";
  return "idle";
}

/**
 * May the form send a create request?
 *
 * NO while the answer is "already in use", and NO while an answer is still being fetched — firing
 * during a lookup is exactly how a fast paste-then-click produced a doomed request and a refusal
 * the operator had to scroll up to find.
 *
 * YES on `error`, deliberately. A failed lookup is not evidence of availability, but the create
 * transaction is the real authority and must stay reachable; failing closed on a flaky lookup would
 * make the form unusable. The operator is told the check failed.
 */
export function createBlockedBy(state: OwnerEmailState): boolean {
  return state === "unavailable" || state === "checking";
}

/** The button's label. One per state, so "disabled" is never unexplained. */
export function createButtonLabel(state: OwnerEmailState, opts: { pending: boolean; failed: boolean }): string {
  if (opts.pending) return "Creating…";
  if (state === "unavailable") return "Owner email already in use";
  if (state === "checking") return "Checking Owner email…";
  if (opts.failed) return "Retry — create shop & send invitation";
  return "Create shop & send invitation";
}
