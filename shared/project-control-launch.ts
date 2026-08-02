/**
 * Project Control — the Partner Shop Launch gate model.
 *
 * THE DEFECT THIS REPLACES
 *
 * The Shop Launch view derived its phase list from "every child of the partner-network node", and
 * decided pilot readiness by excluding two keys by hand:
 *
 *     const prePilot = d.phases.filter((p) => p.key !== "pn-pilot" && p.key !== "pn-launch");
 *     const pilotReady = prePilot.length > 0 && prePilot.every((p) => p.readiness.overall >= 100);
 *
 * `pn-backlog` — the approved G7–G20 work that is deliberately future scope — is also a child of
 * partner-network. It is 0% by design and always will be. So it sat inside `prePilot`, and
 * `pilotReady` was unconditionally, permanently false. The card read "NOT READY — Earlier phases
 * are not finished", which was untrue and unfixable, and the backlog was numbered as launch phase
 * eleven in a sequence the same file's header says has ten entries.
 *
 * THE RULE
 *
 * Membership of the launch sequence is an OWNER DECISION, not a shape you can infer from the tree.
 * It is therefore declared here explicitly, once, and both the ordering and the gating read from
 * the same declaration — so they cannot drift apart the way a hand-maintained filter did.
 *
 * WHY THIS LIVES IN shared/ RATHER THAN IN scopedView
 *
 * Server-side would be marginally cleaner. `scopedView` lives in a file another concurrent session
 * currently owns (see file-ownership-2026-08-02.md), so placing the rule there would have
 * guaranteed a merge conflict. A pure shared module is the correct second-best: it is testable
 * without a server, the client does not hold a second copy of the roadmap, and the server can
 * adopt it later without either side rewriting.
 *
 * Pure. No network, no database, no clock.
 */

/* ------------------------------------------------------------------------------------------ */
/* The declared sequence                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * The ten approved Shop Launch gates, IN ORDER. This ordering is load-bearing: it is the
 * numbering the operator sees, and it is the order in which readiness is demanded.
 */
export const LAUNCH_GATE_KEYS = [
  "pn-g5", // 1  Partner Management
  "pn-g6a", // 2  Wallet and immutable ledger
  "pn-g6b", // 3  Reserve, consume and release credits
  "pn-g6c", // 4  Super Admin credit management
  "pn-g6d", // 5  Submission and grading integration
  "pn-auth", // 6  Authentication, invitations and RBAC
  "pn-portal", // 7  Partner Portal
  "pn-stripe-credits", // 8  Credit purchase (Stripe)
  "pn-pilot", // 9  Pilot with one or two shops
  "pn-launch", // 10 Pilot fixes and wider opening
] as const;

export type LaunchGateKey = (typeof LAUNCH_GATE_KEYS)[number];

/**
 * Phases that are permanently future scope.
 *
 * These are NOT cancelled and must stay visible — dropping them would understate the real
 * programme — but they can never gate a milestone, because by definition they are not finished
 * and are not meant to be.
 */
export const PERMANENT_BACKLOG_KEYS = ["pn-backlog"] as const;

/** The gate the pilot itself represents. Everything ORDERED BEFORE it must be complete. */
export const PILOT_GATE_KEY: LaunchGateKey = "pn-pilot";

export const PHASE_CLASSES = ["launch_gate", "permanent_backlog", "unrecognised"] as const;
export type PhaseClass = (typeof PHASE_CLASSES)[number];

export function classifyPhase(key: string): PhaseClass {
  if ((LAUNCH_GATE_KEYS as readonly string[]).includes(key)) return "launch_gate";
  if ((PERMANENT_BACKLOG_KEYS as readonly string[]).includes(key)) return "permanent_backlog";
  return "unrecognised";
}

/** Position in the launch sequence, 1-based. Null for anything not in the sequence. */
export function launchGateNumber(key: string): number | null {
  const index = (LAUNCH_GATE_KEYS as readonly string[]).indexOf(key);
  return index === -1 ? null : index + 1;
}

/* ------------------------------------------------------------------------------------------ */
/* Partitioning                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** The minimum a phase must expose to be gated on. Structural, so callers can pass richer rows. */
export interface GateablePhase {
  key: string;
  readiness: { overall: number };
}

export interface PhasePartition<T extends GateablePhase> {
  /** The ten launch gates, in declared order. Missing gates simply do not appear. */
  gates: T[];
  /** Permanent future scope. Rendered separately, never numbered into the launch sequence. */
  backlog: T[];
  /**
   * Phases that are neither. Surfaced rather than silently dropped: an unrecognised phase means
   * the tree and this declaration have diverged, and the operator needs to know that.
   */
  unrecognised: T[];
}

export function partitionPhases<T extends GateablePhase>(phases: T[]): PhasePartition<T> {
  const gates: T[] = [];
  const backlog: T[] = [];
  const unrecognised: T[] = [];

  for (const phase of phases) {
    switch (classifyPhase(phase.key)) {
      case "launch_gate":
        gates.push(phase);
        break;
      case "permanent_backlog":
        backlog.push(phase);
        break;
      default:
        unrecognised.push(phase);
    }
  }

  // Declared order, not tree order — the numbering the operator sees comes from here.
  gates.sort(
    (a, b) =>
      (LAUNCH_GATE_KEYS as readonly string[]).indexOf(a.key) - (LAUNCH_GATE_KEYS as readonly string[]).indexOf(b.key)
  );

  return { gates, backlog, unrecognised };
}

/* ------------------------------------------------------------------------------------------ */
/* Pilot readiness                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const PILOT_READINESS_STATES = ["ready", "blocked", "unknown"] as const;
export type PilotReadinessState = (typeof PILOT_READINESS_STATES)[number];

export interface PilotReadiness {
  state: PilotReadinessState;
  /** Always populated and safe to render verbatim. */
  reason: string;
  /** Gate keys, in declared order, that are not yet complete. Empty when ready. */
  blockedBy: string[];
  /** Gates that must be complete before the pilot, in declared order. */
  requiredGates: string[];
}

/**
 * Can the pilot start?
 *
 * Only the gates ORDERED BEFORE the pilot are considered. The backlog is excluded because it is
 * permanent future scope; `pn-launch` is excluded because it is after the pilot by definition.
 *
 * FAILS CLOSED on ambiguity. If the tree contains a phase this module does not recognise, the
 * answer is UNKNOWN — not READY. A divergence between the declared sequence and the actual tree
 * is exactly the condition under which a confident answer would be a lie.
 */
export function computePilotReadiness<T extends GateablePhase>(phases: T[]): PilotReadiness {
  const { gates, unrecognised } = partitionPhases(phases);
  const pilotIndex = (LAUNCH_GATE_KEYS as readonly string[]).indexOf(PILOT_GATE_KEY);
  const requiredGates = (LAUNCH_GATE_KEYS as readonly string[]).slice(0, pilotIndex);

  if (unrecognised.length > 0) {
    return {
      state: "unknown",
      reason: `The programme contains ${unrecognised.length} phase(s) this launch sequence does not recognise (${unrecognised
        .map((p) => p.key)
        .join(", ")}), so pilot readiness cannot be stated with confidence.`,
      blockedBy: [],
      requiredGates: [...requiredGates],
    };
  }

  const present = new Map(gates.map((g) => [g.key, g]));
  const missing = requiredGates.filter((key) => !present.has(key));
  if (missing.length > 0) {
    return {
      state: "unknown",
      reason: `${missing.length} required launch gate(s) are absent from the programme (${missing.join(", ")}), so pilot readiness cannot be stated.`,
      blockedBy: [],
      requiredGates: [...requiredGates],
    };
  }

  const blockedBy = requiredGates.filter((key) => (present.get(key)?.readiness.overall ?? 0) < 100);

  if (blockedBy.length === 0) {
    return {
      state: "ready",
      reason:
        "Every gate before the pilot is complete. The permanent G7–G20 backlog is future scope and does not gate the pilot.",
      blockedBy: [],
      requiredGates: [...requiredGates],
    };
  }

  return {
    state: "blocked",
    reason: `${blockedBy.length} gate(s) before the pilot are not finished.`,
    blockedBy,
    requiredGates: [...requiredGates],
  };
}
