/**
 * Project Control — the distributed live-evidence model.
 *
 * This suite exists because the distributed model was carried forward as an explicitly UNTESTED
 * work-in-progress ("INCOMPLETE — no tests yet"). It is the gate that makes it acceptable.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 *
 * The whole point of deriving programme status from machine facts rather than hand-written seed
 * fields is that a lane cannot be made to LOOK more finished than it is. Every test below is
 * therefore an honesty property — an assertion that some plausible-looking input does NOT earn a
 * status it has not paid for. The failure mode this guards against is not a crash; it is a
 * dashboard that confidently reports green.
 *
 * The four rules, restated as testable claims:
 *   RULE 1  an authored-but-unapplied migration is never completion;
 *   RULE 2  skipped and not_run are discarded before counting, never treated as passes;
 *   RULE 3  merging is as far as merging alone can take a lane — deployment needs a record;
 *   RULE 4  only machine observations become evidence; no owner statement is ever minted here.
 *
 * Pure functions only — no database, no git, no network.
 */
import { describe, it, expect } from "vitest";
import {
  DISTRIBUTED_LANES,
  MANDATORY_LANE_KEYS,
  buildLaneBlockers,
  buildLaneEvidence,
  countPassingTestEvidence,
  deriveLaneStatus,
  type LaneDefinition,
  type LaneFacts,
  type ObservedMigration,
  type ObservedTestRun,
} from "@shared/project-control-distributed";

const LANE: LaneDefinition = DISTRIBUTED_LANES[0];

function migration(over: Partial<ObservedMigration> = {}): ObservedMigration {
  return {
    number: "0031",
    filename: "0031_partner_user_management.sql",
    fileExists: true,
    applied: true,
    failed: false,
    environment: "staging",
    ...over,
  };
}

function run(over: Partial<ObservedTestRun> = {}): ObservedTestRun {
  return {
    name: "vitest",
    kind: "vitest",
    result: "passed",
    ranAt: "2026-08-01T00:00:00.000Z",
    commitSha: "a".repeat(40),
    ...over,
  };
}

/** A lane that has done everything: merged, migrated, deployed, production-verified. */
function fullyLanded(over: Partial<LaneFacts> = {}): LaneFacts {
  return {
    lane: LANE,
    branch: "feature/example",
    headCommit: "a".repeat(40),
    headSubject: "feat: example",
    headCommittedAt: "2026-08-01T00:00:00.000Z",
    commitsAheadOfMain: 0,
    mergedIntoMain: true,
    migrations: [migration()],
    testRuns: [run()],
    deployedEnvironments: ["production"],
    productionVerifiedEnvironments: ["production"],
    ...over,
  };
}

describe("lane definitions", () => {
  it("declares unique keys", () => {
    const keys = DISTRIBUTED_LANES.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("orders every lane deterministically", () => {
    const orders = DISTRIBUTED_LANES.map((l) => l.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("gives every lane at least one branch candidate to resolve against", () => {
    for (const lane of DISTRIBUTED_LANES) {
      expect(lane.branchCandidates.length, `${lane.key} has no branch candidates`).toBeGreaterThan(0);
    }
  });

  it("treats every lane except the optional Hub Locator as mandatory", () => {
    expect(MANDATORY_LANE_KEYS).not.toContain("dsp-hub-locator");
    expect(MANDATORY_LANE_KEYS.length).toBe(DISTRIBUTED_LANES.length - 1);
  });
});

describe("RULE 2 — skipped gates are discarded, never counted as passes", () => {
  it("counts passes and failures separately from skips", () => {
    const counts = countPassingTestEvidence([
      run({ result: "passed" }),
      run({ result: "passed" }),
      run({ result: "failed" }),
      run({ result: "skipped" }),
      run({ result: "not_run" }),
    ]);
    expect(counts).toEqual({ passed: 2, failed: 1, discardedSkipped: 2 });
  });

  it("a suite that was entirely skipped yields NO test evidence", () => {
    const counts = countPassingTestEvidence([run({ result: "skipped" }), run({ result: "not_run" })]);
    expect(counts.passed).toBe(0);
  });

  it("an all-skipped lane cannot reach a reviewed status — it is awaiting evidence", () => {
    const facts = fullyLanded({
      mergedIntoMain: false,
      testRuns: [run({ result: "skipped" }), run({ result: "not_run" })],
      migrations: [],
    });
    expect(deriveLaneStatus(facts)).toBe("awaiting_test_evidence");
  });

  it("never mints supporting evidence from a skipped run", () => {
    const evidence = buildLaneEvidence(fullyLanded({ testRuns: [run({ result: "skipped" })] }));
    expect(evidence.some((e) => e.sourceRef?.startsWith("test:"))).toBe(false);
  });
});

describe("status ladder — each rung requires every rung below it", () => {
  it("a lane with no branch is not started", () => {
    expect(deriveLaneStatus(fullyLanded({ branch: null, headCommit: null }))).toBe("not_started");
  });

  it("a lane with a branch but no head commit is not started", () => {
    expect(deriveLaneStatus(fullyLanded({ headCommit: null }))).toBe("not_started");
  });

  it("RULE 3 — merged alone is NOT deployed", () => {
    expect(deriveLaneStatus(fullyLanded({ deployedEnvironments: [], productionVerifiedEnvironments: [] }))).toBe(
      "awaiting_deployment"
    );
  });

  it("deployed is NOT production-verified", () => {
    expect(deriveLaneStatus(fullyLanded({ productionVerifiedEnvironments: [] }))).toBe(
      "awaiting_production_verification"
    );
  });

  it("only a fully evidenced lane reaches production_verified", () => {
    expect(deriveLaneStatus(fullyLanded())).toBe("production_verified");
  });

  it("an unmerged lane with passing gates is awaiting review, not landed", () => {
    expect(deriveLaneStatus(fullyLanded({ mergedIntoMain: false, migrations: [] }))).toBe("awaiting_review");
  });
});

describe("RULE 1 — an authored but unapplied migration is never completion", () => {
  it("blocks an unmerged lane at awaiting_deployment even with passing gates", () => {
    const facts = fullyLanded({ mergedIntoMain: false, migrations: [migration({ applied: false })] });
    expect(deriveLaneStatus(facts)).toBe("awaiting_deployment");
  });

  it("blocks a MERGED, deployed, production-verified lane — the strongest case", () => {
    const facts = fullyLanded({ migrations: [migration({ applied: false })] });
    expect(deriveLaneStatus(facts)).toBe("awaiting_deployment");
  });

  it("records the unapplied migration as CONTRADICTING evidence, not as absent", () => {
    const evidence = buildLaneEvidence(fullyLanded({ migrations: [migration({ applied: false })] }));
    const record = evidence.find((e) => e.sourceRef === "schema_migrations:0031_partner_user_management.sql");
    expect(record?.supports).toBe(false);
    expect(record?.summary).toContain("NOT applied");
  });

  it("a migration that has not been written yet does not block (nothing to apply)", () => {
    const facts = fullyLanded({ migrations: [migration({ fileExists: false, applied: false })] });
    expect(deriveLaneStatus(facts)).toBe("production_verified");
  });
});

describe("failing gates outrank every higher rung", () => {
  it("a fully landed lane with one failing gate is tests_failing", () => {
    const facts = fullyLanded({ testRuns: [run({ result: "passed" }), run({ result: "failed" })] });
    expect(deriveLaneStatus(facts)).toBe("tests_failing");
  });

  it("passing gates cannot outvote a failing one", () => {
    const facts = fullyLanded({
      testRuns: [
        run({ result: "passed" }),
        run({ result: "passed" }),
        run({ result: "passed" }),
        run({ result: "failed" }),
      ],
    });
    expect(deriveLaneStatus(facts)).toBe("tests_failing");
  });
});

describe("RULE 4 — evidence is machine-observed only", () => {
  it("never mints an owner statement", () => {
    const evidence = buildLaneEvidence(fullyLanded());
    expect(evidence.some((e) => e.kind === "owner_statement")).toBe(false);
  });

  it("records merge state in BOTH directions, so 'not merged' is a visible fact", () => {
    const merged = buildLaneEvidence(fullyLanded()).find((e) => e.sourceRef === "merged:feature/example");
    const unmerged = buildLaneEvidence(fullyLanded({ mergedIntoMain: false })).find(
      (e) => e.sourceRef === "merged:feature/example"
    );
    expect(merged?.supports).toBe(true);
    expect(unmerged?.supports).toBe(false);
    expect(unmerged?.summary).toContain("NOT merged");
  });

  it("produces no evidence at all for a lane that does not exist", () => {
    expect(
      buildLaneEvidence(
        fullyLanded({
          branch: null,
          headCommit: null,
          migrations: [],
          testRuns: [],
          deployedEnvironments: [],
          productionVerifiedEnvironments: [],
        })
      )
    ).toEqual([]);
  });

  it("attributes deployment and production-check evidence to a named environment", () => {
    const evidence = buildLaneEvidence(fullyLanded());
    expect(evidence.find((e) => e.kind === "deployment")?.environment).toBe("production");
    expect(evidence.find((e) => e.kind === "production_check")?.environment).toBe("production");
  });

  it("is deterministic for a fixed clock", () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    expect(buildLaneEvidence(fullyLanded(), now)).toEqual(buildLaneEvidence(fullyLanded(), now));
  });
});

describe("blockers feed the approved BLOCKED cap rather than being rounded away", () => {
  it("raises a blocker for an unapplied migration", () => {
    const blockers = buildLaneBlockers(fullyLanded({ migrations: [migration({ applied: false })] }));
    expect(blockers.some((b) => b.kind === "awaiting_migration")).toBe(true);
  });

  it("distinguishes a FAILED migration from a merely unapplied one", () => {
    const blockers = buildLaneBlockers(fullyLanded({ migrations: [migration({ applied: false, failed: true })] }));
    expect(blockers.find((b) => b.kind === "awaiting_migration")?.description).toContain("FAILED");
  });

  it("raises a blocker for failing gates", () => {
    const blockers = buildLaneBlockers(fullyLanded({ testRuns: [run({ result: "failed" })] }));
    expect(blockers.some((b) => b.kind === "failed_tests")).toBe(true);
  });

  it("raises a blocker for an unmerged branch", () => {
    const blockers = buildLaneBlockers(fullyLanded({ mergedIntoMain: false }));
    expect(blockers.some((b) => b.kind === "awaiting_review")).toBe(true);
  });

  it("raises a blocker when no branch exists at all", () => {
    const blockers = buildLaneBlockers(fullyLanded({ branch: null, headCommit: null }));
    expect(blockers.some((b) => b.kind === "dependency_incomplete")).toBe(true);
  });

  it("leaves a fully landed lane with no open blockers", () => {
    expect(buildLaneBlockers(fullyLanded())).toEqual([]);
  });

  it("opens every derived blocker unresolved", () => {
    const blockers = buildLaneBlockers(
      fullyLanded({ mergedIntoMain: false, migrations: [migration({ applied: false })] })
    );
    expect(blockers.length).toBeGreaterThan(0);
    for (const b of blockers) expect(b.resolvedAt).toBeNull();
  });
});
