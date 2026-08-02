/**
 * Project Control — Partner Shop Launch gating (defect UX-1).
 *
 * THE BUG, RESTATED AS THE HEADLINE TEST
 *
 * The Shop Launch view treated every child of the partner-network node as a launch phase and
 * excluded only `pn-pilot` and `pn-launch` when deciding pilot readiness. `pn-backlog` — the
 * approved G7–G20 work that is deliberately permanent future scope, and 0% by design — therefore
 * counted as a gate, and pilot readiness was unconditionally false forever.
 *
 * The load-bearing test is "a complete launch programme reaches READY while the backlog is still
 * at 0%". It fails against the old rule and passes against this one.
 *
 * The rest is the honesty margin: an unrecognised phase, or a missing gate, must produce UNKNOWN
 * rather than a confident READY. A dashboard that answers confidently from a tree it does not
 * fully recognise is the failure mode this whole programme exists to remove.
 */
import { describe, it, expect } from "vitest";
import {
  LAUNCH_GATE_KEYS,
  PERMANENT_BACKLOG_KEYS,
  classifyPhase,
  computePilotReadiness,
  launchGateNumber,
  partitionPhases,
  type GateablePhase,
} from "@shared/project-control-launch";
import { NODES } from "../server/project-control/seed-data";

function phase(key: string, overall: number): GateablePhase {
  return { key, readiness: { overall } };
}

/** Every launch gate complete; the permanent backlog untouched at 0%, as it always will be. */
function completeLaunchProgramme(): GateablePhase[] {
  return [...LAUNCH_GATE_KEYS.map((k) => phase(k, 100)), phase("pn-backlog", 0)];
}

describe("the declared sequence matches the seeded programme tree", () => {
  it("declares exactly the ten approved gates", () => {
    expect(LAUNCH_GATE_KEYS.length).toBe(10);
    expect(new Set(LAUNCH_GATE_KEYS).size).toBe(10);
  });

  it("every declared gate exists as a real node under partner-network", () => {
    const children = NODES.filter((n) => n.parentKey === "partner-network").map((n) => n.key);
    for (const key of LAUNCH_GATE_KEYS) {
      expect(children, `${key} is declared a launch gate but is not a partner-network node`).toContain(key);
    }
  });

  it("every partner-network child is classified — none falls through unrecognised", () => {
    // This is the guard that would have caught the original defect at build time: pn-backlog was a
    // child nobody had decided about, so it silently inherited "gate".
    const children = NODES.filter((n) => n.parentKey === "partner-network").map((n) => n.key);
    for (const key of children) {
      expect(classifyPhase(key), `partner-network child ${key} is unclassified`).not.toBe("unrecognised");
    }
  });

  it("declares the backlog as permanent scope rather than as a gate", () => {
    expect(classifyPhase("pn-backlog")).toBe("permanent_backlog");
    expect(PERMANENT_BACKLOG_KEYS).toContain("pn-backlog");
  });

  it("numbers the gates 1..10 and refuses to number anything outside the sequence", () => {
    expect(launchGateNumber("pn-g5")).toBe(1);
    expect(launchGateNumber("pn-launch")).toBe(10);
    // The backlog must never render as "phase 11".
    expect(launchGateNumber("pn-backlog")).toBeNull();
    expect(launchGateNumber("nonsense")).toBeNull();
  });
});

describe("partitioning separates launch scope from permanent scope", () => {
  it("puts the backlog in its own bucket, never among the gates", () => {
    const { gates, backlog, unrecognised } = partitionPhases(completeLaunchProgramme());
    expect(gates).toHaveLength(10);
    expect(backlog.map((p) => p.key)).toEqual(["pn-backlog"]);
    expect(unrecognised).toHaveLength(0);
  });

  it("orders gates by the declared sequence, not by input order", () => {
    const shuffled = [phase("pn-launch", 0), phase("pn-g6a", 0), phase("pn-g5", 0)];
    expect(partitionPhases(shuffled).gates.map((g) => g.key)).toEqual(["pn-g5", "pn-g6a", "pn-launch"]);
  });

  it("surfaces an unrecognised phase rather than silently dropping it", () => {
    const { unrecognised } = partitionPhases([phase("pn-g5", 100), phase("pn-something-new", 0)]);
    expect(unrecognised.map((p) => p.key)).toEqual(["pn-something-new"]);
  });
});

describe("pilot readiness — the UX-1 defect", () => {
  it("REACHES READY when every pre-pilot gate is complete and the backlog is still 0%", () => {
    // The exact scenario the old rule made impossible.
    const result = computePilotReadiness(completeLaunchProgramme());
    expect(result.state).toBe("ready");
    expect(result.blockedBy).toEqual([]);
    expect(result.reason).toContain("does not gate the pilot");
  });

  it("stays READY even when the backlog is explicitly present and unfinished", () => {
    const phases = [...LAUNCH_GATE_KEYS.map((k) => phase(k, 100)), phase("pn-backlog", 0)];
    expect(computePilotReadiness(phases).state).toBe("ready");
  });

  it("does not require the pilot or the post-pilot gate to be complete before the pilot can start", () => {
    // Gates 1-8 complete; the pilot itself and the wider opening are not. That IS ready.
    const phases = [
      ...LAUNCH_GATE_KEYS.slice(0, 8).map((k) => phase(k, 100)),
      phase("pn-pilot", 0),
      phase("pn-launch", 0),
      phase("pn-backlog", 0),
    ];
    const result = computePilotReadiness(phases);
    expect(result.state).toBe("ready");
    expect(result.requiredGates).not.toContain("pn-pilot");
    expect(result.requiredGates).not.toContain("pn-launch");
  });

  it("is BLOCKED, and names the gate, when a real pre-pilot gate is unfinished", () => {
    const phases = completeLaunchProgramme().map((p) => (p.key === "pn-portal" ? phase("pn-portal", 55) : p));
    const result = computePilotReadiness(phases);
    expect(result.state).toBe("blocked");
    expect(result.blockedBy).toEqual(["pn-portal"]);
  });

  it("lists every unfinished gate in declared order, not input order", () => {
    const phases = completeLaunchProgramme().map((p) =>
      p.key === "pn-g5" || p.key === "pn-portal" ? phase(p.key, 10) : p
    );
    expect(computePilotReadiness(phases).blockedBy).toEqual(["pn-g5", "pn-portal"]);
  });

  it("treats 99% as not complete — readiness floors, it never rounds up", () => {
    const phases = completeLaunchProgramme().map((p) => (p.key === "pn-g6a" ? phase("pn-g6a", 99) : p));
    expect(computePilotReadiness(phases).state).toBe("blocked");
  });
});

describe("pilot readiness fails closed on ambiguity", () => {
  it("is UNKNOWN — never READY — when the tree contains an unrecognised phase", () => {
    const phases = [...completeLaunchProgramme(), phase("pn-brand-new-thing", 0)];
    const result = computePilotReadiness(phases);
    expect(result.state).toBe("unknown");
    expect(result.reason).toContain("pn-brand-new-thing");
  });

  it("is UNKNOWN when a required gate is absent from the programme entirely", () => {
    const phases = completeLaunchProgramme().filter((p) => p.key !== "pn-g6c");
    const result = computePilotReadiness(phases);
    expect(result.state).toBe("unknown");
    expect(result.reason).toContain("pn-g6c");
  });

  it("is UNKNOWN rather than READY for an empty programme", () => {
    expect(computePilotReadiness([]).state).toBe("unknown");
  });

  it("always supplies a reason that stands alone when rendered", () => {
    for (const phases of [[], completeLaunchProgramme(), [phase("weird", 0)]]) {
      expect(computePilotReadiness(phases).reason.length).toBeGreaterThan(20);
    }
  });
});
