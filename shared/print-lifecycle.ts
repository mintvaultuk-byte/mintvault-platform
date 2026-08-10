/**
 * print-lifecycle.ts — pure print-workflow state machine.
 *
 * Single source of truth for the Approval → Printing → Printed lifecycle.
 * Deliberately has ZERO imports of the DB, server, or React so it can be unit
 * tested in isolation and shared verbatim by client and server (imported via
 * the `@shared/` alias). Every decision the print workflow makes — what state a
 * cert is in, which transition an action performs, who may perform it, whether a
 * batch would duplicate a print — is decided here, not scattered across routes.
 *
 * IMPORTANT boundaries:
 *  - This does NOT decide grade approval. Approval remains owned by the grader
 *    system (`certificates.grade_approved_at`). This module only READS whether a
 *    cert is approved to compute its effective print state.
 *  - `certificates.status` (validity: active/voided) and `grader_status`
 *    (grading workflow) are separate concepts and are never touched here.
 */

// ── States ───────────────────────────────────────────────────────────────────

export const PRINT_STATES = [
  "awaiting_approval",
  "needs_printing",
  "printing",
  "printed",
  "reprint_required",
  "reprinted",
  "completed",
] as const;

export type PrintState = (typeof PRINT_STATES)[number];

/** The default stored value for a freshly-created certificate. */
export const DEFAULT_PRINT_STATE: PrintState = "awaiting_approval";

/** Human labels for the admin UI. */
export const PRINT_STATE_LABEL: Record<PrintState, string> = {
  awaiting_approval: "Awaiting Approval",
  needs_printing: "Approved – Ready To Print",
  printing: "Printing",
  printed: "Printed",
  reprint_required: "Reprint Required",
  reprinted: "Reprinted",
  completed: "Completed",
};

/**
 * Design-system badge variant per state (matches `admin-badge is-{variant}`,
 * variants: act | neu | prog | wait | gold | red). Keeps the queue visually
 * consistent with the grading queue.
 */
export const PRINT_STATE_BADGE: Record<PrintState, "act" | "neu" | "prog" | "wait" | "gold" | "red"> = {
  awaiting_approval: "neu",
  needs_printing: "gold",
  printing: "prog",
  printed: "act",
  reprint_required: "red",
  reprinted: "prog",
  completed: "act",
};

/** States a batch's "printed" confirmation can advance a cert into. */
export const PRINTED_STATES: ReadonlySet<PrintState> = new Set<PrintState>(["printed", "reprinted"]);

/** States that mean "this label has already been physically produced". */
export const ALREADY_PRINTED_STATES: ReadonlySet<PrintState> = new Set<PrintState>([
  "printed",
  "reprinted",
  "completed",
]);

/**
 * States explicitly stored/owned by the print workflow (i.e. not derivable from
 * approval alone). Used by effectivePrintState to decide when a stored value
 * overrides the approval-derived value.
 */
const ADVANCED_STATES: ReadonlySet<PrintState> = new Set<PrintState>([
  "printing",
  "printed",
  "reprint_required",
  "reprinted",
  "completed",
]);

// ── Batch kinds ──────────────────────────────────────────────────────────────

export const BATCH_KINDS = ["batch", "reprint"] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

export const BATCH_STATUSES = ["open", "rendering", "printing", "printed", "partial", "failed", "cancelled"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

// ── Reprint reasons ──────────────────────────────────────────────────────────

export const REPRINT_REASON_CATEGORIES = [
  "lost_label",
  "damaged_print",
  "printer_error",
  "customer_replacement",
  "correction",
] as const;

export type ReprintReasonCategory = (typeof REPRINT_REASON_CATEGORIES)[number];

export const REPRINT_REASON_LABEL: Record<ReprintReasonCategory, string> = {
  lost_label: "Lost label",
  damaged_print: "Damaged print",
  printer_error: "Printer error",
  customer_replacement: "Customer replacement",
  correction: "Correction",
};

export function isReprintReasonCategory(v: unknown): v is ReprintReasonCategory {
  return typeof v === "string" && (REPRINT_REASON_CATEGORIES as readonly string[]).includes(v);
}

/** Minimum/maximum length for the free-text reprint reason (mirrors the existing reprint route). */
export const REPRINT_REASON_MIN = 10;
export const REPRINT_REASON_MAX = 500;

export function isValidReprintReason(reason: unknown): reason is string {
  return (
    typeof reason === "string" &&
    reason.trim().length >= REPRINT_REASON_MIN &&
    reason.trim().length <= REPRINT_REASON_MAX
  );
}

// ── Actions ──────────────────────────────────────────────────────────────────

export const PRINT_ACTIONS = ["create_batch", "print_all_ready", "mark_printed", "reprint", "complete"] as const;
export type PrintAction = (typeof PRINT_ACTIONS)[number];

// ── Roles / permissions ──────────────────────────────────────────────────────

/**
 * Real MintVault privilege tiers for printing. There is one admin identity today
 * ("super admin" == admin); staff are gated by the `can_print` capability.
 *  - admin          → full access, including terminal `complete`.
 *  - staff_print    → staff user with can_print: all non-terminal print actions.
 *  - staff_readonly → authenticated staff without can_print: read-only.
 *  - partner_print  → Partner-scoped label preparation and physical confirmation only.
 */
/** `partner_print` is deliberately distinct from a MintVault admin/staff role.
 * The Partner adapter additionally proves immutable certificate origin before it
 * invokes this workflow; keeping the actor role separate preserves that fact in
 * the append-only print ledger instead of mis-attributing shop operations to HQ.
 */
export type PrintRole = "admin" | "staff_print" | "staff_readonly" | "partner_print";

const ACTION_PERMISSIONS: Record<PrintAction, ReadonlySet<PrintRole>> = {
  create_batch: new Set<PrintRole>(["admin", "staff_print", "partner_print"]),
  print_all_ready: new Set<PrintRole>(["admin", "staff_print"]),
  mark_printed: new Set<PrintRole>(["admin", "staff_print", "partner_print"]),
  reprint: new Set<PrintRole>(["admin", "staff_print"]),
  // HQ can complete any eligible certificate. The narrowly-scoped Partner
  // completion adapter additionally requires immutable origin ownership,
  // printed state and locked NFC before it calls this transition.
  complete: new Set<PrintRole>(["admin", "partner_print"]),
};

export function canPerform(action: PrintAction, role: PrintRole): boolean {
  return ACTION_PERMISSIONS[action].has(role);
}

/** Whether a role may read the printing queue at all. */
export function canReadQueue(role: PrintRole): boolean {
  return role === "admin" || role === "staff_print" || role === "staff_readonly";
}

// ── Effective state derivation ───────────────────────────────────────────────

export interface EffectiveStateInput {
  /** The stored `certificates.print_state` (may be the default if never advanced). */
  storedState: PrintState | null | undefined;
  /** Whether the grade has been approved (`grade_approved_at IS NOT NULL`). */
  approved: boolean;
}

/**
 * Compute the state to SHOW/act on for a cert without mutating the grader system.
 *
 * Rule: an advanced, print-workflow-owned state (printing/printed/reprint_required/
 * reprinted/completed) always wins — once printing has started, approval status can't
 * pull it backwards. Otherwise the state is derived from approval: approved →
 * needs_printing, not approved → awaiting_approval. This lets newly-approved certs
 * appear in "Needs Printing" with no write to the grading tables.
 */
export function effectivePrintState(input: EffectiveStateInput): PrintState {
  const stored = input.storedState ?? DEFAULT_PRINT_STATE;
  if (ADVANCED_STATES.has(stored)) return stored;
  // stored is awaiting_approval or needs_printing → derive from approval.
  return input.approved ? "needs_printing" : "awaiting_approval";
}

// ── Transitions ──────────────────────────────────────────────────────────────

export interface TransitionResult {
  ok: boolean;
  /** The resulting state when ok. */
  to?: PrintState;
  /** Machine-readable reason when not ok. */
  code?:
    | "not_approved"
    | "already_printed"
    | "invalid_from"
    | "not_printed_yet"
    | "reason_required"
    | "already_completed";
  message?: string;
}

/**
 * Decide the next state for an action given the cert's current effective state.
 * Pure — performs no I/O. The service layer calls this, then persists the result
 * transactionally and writes a print_event.
 *
 * @param from     effective current state
 * @param action   the requested action
 * @param opts.batchKind for mark_printed: whether the batch was a reprint (→ reprinted) or first print (→ printed)
 * @param opts.hasReason for reprint: whether a valid reason was supplied
 */
export function nextState(
  from: PrintState,
  action: PrintAction,
  opts: { batchKind?: BatchKind; hasReason?: boolean } = {}
): TransitionResult {
  switch (action) {
    case "create_batch":
    case "print_all_ready": {
      // Only certs that are ready to print (needs_printing) or being reprinted
      // (reprint_required) may enter a batch. Blocking already-printed certs here
      // is what forces the operator through the explicit `reprint` path instead.
      if (from === "needs_printing" || from === "reprint_required") {
        return { ok: true, to: "printing" };
      }
      if (from === "awaiting_approval") {
        return { ok: false, code: "not_approved", message: "Certificate grade is not approved yet." };
      }
      if (ALREADY_PRINTED_STATES.has(from)) {
        return { ok: false, code: "already_printed", message: "Already printed — use Reprint (reason required)." };
      }
      return { ok: false, code: "invalid_from", message: `Cannot batch from state "${from}".` };
    }
    case "mark_printed": {
      if (from !== "printing") {
        return {
          ok: false,
          code: "not_printed_yet",
          message: `Only a cert in "printing" can be marked printed (was "${from}").`,
        };
      }
      // A reprint batch resolves to "reprinted"; a first-run batch to "printed".
      return { ok: true, to: opts.batchKind === "reprint" ? "reprinted" : "printed" };
    }
    case "reprint": {
      // Reprint is only meaningful once a label has already been produced.
      if (!ALREADY_PRINTED_STATES.has(from) && from !== "reprint_required") {
        return { ok: false, code: "invalid_from", message: `Nothing printed yet to reprint (state "${from}").` };
      }
      if (!opts.hasReason) {
        return { ok: false, code: "reason_required", message: "A reprint reason is required." };
      }
      return { ok: true, to: "reprint_required" };
    }
    case "complete": {
      // Completable once physically printed. Blocking from non-printed avoids
      // marking something done that was never produced.
      if (from === "completed") {
        return { ok: false, code: "already_completed", message: "Already completed." };
      }
      if (!PRINTED_STATES.has(from)) {
        return { ok: false, code: "not_printed_yet", message: `Can only complete a printed cert (state "${from}").` };
      }
      return { ok: true, to: "completed" };
    }
    default:
      return { ok: false, code: "invalid_from", message: `Unknown action "${action}".` };
  }
}

// ── Duplicate protection ─────────────────────────────────────────────────────

/**
 * Given the effective states of certs the operator selected for a NEW (first-run)
 * batch, return the ones that would be duplicate prints (already printed/completed).
 * The route uses this to force a confirmation + reason before proceeding.
 */
export function findDuplicatePrints<T extends { certId: string; state: PrintState }>(certs: readonly T[]): T[] {
  return certs.filter((c) => ALREADY_PRINTED_STATES.has(c.state));
}

// ── Filters (queue tabs) ─────────────────────────────────────────────────────

export const PRINT_QUEUE_FILTERS = [
  "needs_printing",
  "printing",
  "printed_today",
  "printed",
  "reprints",
  "completed",
  "all",
] as const;

export type PrintQueueFilter = (typeof PRINT_QUEUE_FILTERS)[number];

export const PRINT_QUEUE_FILTER_LABEL: Record<PrintQueueFilter, string> = {
  needs_printing: "Ready To Print",
  printing: "Printing / In Progress",
  printed_today: "Printed Today",
  printed: "Printed",
  reprints: "Reprints",
  completed: "Completed",
  all: "All",
};

export interface QueueFilterInput {
  state: PrintState;
  /** printed_at (or reprinted_at) timestamp, ms epoch, or null. */
  printedAtMs: number | null;
}

/**
 * Whether a cert row matches a queue filter. `nowMs`/`dayStartMs` are passed in
 * (not read from the clock) so this stays pure and testable.
 */
export function matchesFilter(row: QueueFilterInput, filter: PrintQueueFilter, dayStartMs: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs_printing":
      return row.state === "needs_printing";
    case "printing":
      return row.state === "printing";
    case "printed":
      return row.state === "printed" || row.state === "reprinted";
    case "completed":
      return row.state === "completed";
    case "reprints":
      return row.state === "reprint_required" || row.state === "reprinted";
    case "printed_today":
      return (
        (row.state === "printed" || row.state === "reprinted") &&
        row.printedAtMs !== null &&
        row.printedAtMs >= dayStartMs
      );
    default:
      return false;
  }
}
