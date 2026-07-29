/**
 * Project Control — engine regression suite.
 *
 * Locks down the behaviour the dashboard exists for: a claim without evidence is not believed,
 * contradicting evidence always wins, readiness obeys the approved weighting and every hard cap,
 * 100% is unreachable by rounding or by declaring categories non-applicable, and the next-action
 * engine refuses to recommend landing or deploying work whose evidence is failing.
 *
 * Every case here that begins "ATTACK" was a real defect found by hostile review.
 */
import { describe, it, expect } from "vitest";
import {
  CAP_NOT_PRODUCTION_VERIFIED,
  CAP_REVIEW_FAILED,
  CAP_UNRESOLVED_HIGH_SECURITY,
  CATEGORY_WEIGHTS,
  MANDATORY_CATEGORIES,
  READINESS_CATEGORIES,
  WORK_STATUSES,
  assessWorkPackage,
  buildDependencyGraph,
  buildProgrammeTree,
  classifyTimestamp,
  clampPercent,
  computeNextActions,
  computeQueues,
  computeReadiness,
  deriveConfidence,
  detectDrift,
  evidenceFromHistory,
  filterPackages,
  findDependencyCycles,
  isLegalTransition,
  latestDeployments,
  normaliseStatus,
  resolveCategories,
  scopeEvidence,
  summariseNextActions,
  type DeploymentRecord,
  type EvidenceRecord,
  type ProgrammeNode,
  type WorkPackage,
} from "@shared/project-control";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 864e5).toISOString();

/**
 * The release commit every fixture's evidence is scoped to. Evidence must name it, or it does not
 * count — that is the H-2 remediation, and the fixtures model it honestly rather than working
 * around it.
 */
const SHA = "abc1234def5678";

function pkg(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return {
    id: 1,
    key: "example",
    nodeKey: "core",
    title: "Example work package",
    summary: "",
    status: "in_progress",
    declaredCompletion: 50,
    risk: "low",
    classification: "A",
    reviewState: "not_started",
    deploymentState: "not_deployed",
    productionVerification: "not_verified",
    businessValue: 3,
    engineeringRisk: 2,
    estimatedEffortDays: null,
    remainingWork: "",
    branch: null,
    worktreePath: null,
    baseCommit: null,
    prUrl: null,
    latestCommit: SHA,
    version: 1,
    updatedAt: daysAgo(1),
    evidence: [],
    blockers: [],
    dependsOn: [],
    acceptanceCriteria: [],
    requiredTests: [],
    categoryStates: {},
    categoryNotes: {},
    tags: [],
    ...overrides,
  };
}

/** A work package that genuinely satisfies every category, with real evidence. */
function fullyProven(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return pkg({
    key: "done",
    status: "production_verified",
    declaredCompletion: 100,
    reviewState: "passed",
    deploymentState: "production",
    productionVerification: "verified",
    // H3-4: the criterion cites evidence id 3 (a real vitest record below). An arbitrary string
    // no longer counts, so fixtures must reference evidence that genuinely exists.
    acceptanceCriteria: [{ id: "a1", text: "It works", met: true, evidenceRef: "3" }],
    evidence: [
      { id: 1, kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "production", commitSha: SHA },
      { id: 2, kind: "deployment", supports: true, capturedAt: daysAgo(2), environment: "production", commitSha: SHA },
      { id: 3, kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
      { id: 4, kind: "typescript", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
      { id: 5, kind: "hostile_review", supports: true, capturedAt: daysAgo(2), commitSha: SHA },
    ],
    ...overrides,
  });
}

/* ------------------------------------------------------------------------------------------ */

describe("status vocabulary", () => {
  it("carries all twenty approved states plus unknown", () => {
    expect(WORK_STATUSES).toHaveLength(21);
    for (const required of [
      "built_with_known_defects",
      "needs_fixing",
      "awaiting_test_evidence",
      "tests_failing",
      "awaiting_review",
      "review_failed",
      "ready_for_landing",
      "committed",
      "merged",
      "awaiting_deployment",
      "deployed",
      "awaiting_production_verification",
      "production_verified",
      "blocked",
      "paused",
      "superseded",
    ]) {
      expect(WORK_STATUSES).toContain(required);
    }
  });

  it("maps legacy values instead of losing them to unknown", () => {
    expect(normaliseStatus("ready_to_merge")).toBe("ready_for_landing");
    expect(normaliseStatus("needs_review")).toBe("awaiting_review");
    expect(normaliseStatus("needs_testing")).toBe("awaiting_test_evidence");
    expect(normaliseStatus("garbage")).toBe("unknown");
    expect(normaliseStatus(null)).toBe("unknown");
  });

  it("ATTACK: cannot launder an illegal transition through an off-pipeline state", () => {
    expect(isLegalTransition("not_started", "production_verified")).toBe(false);
    expect(isLegalTransition("not_started", "paused")).toBe(true);
    // The two-hop laundering route is now closed.
    expect(isLegalTransition("paused", "production_verified")).toBe(false);
    expect(isLegalTransition("blocked", "production_verified")).toBe(false);
    expect(isLegalTransition("in_progress", "built")).toBe(true);
    expect(isLegalTransition("deployed", "in_progress")).toBe(true);
  });
});

describe("timestamps", () => {
  it("distinguishes valid, malformed and future", () => {
    expect(classifyTimestamp(daysAgo(1), NOW)).toBe("valid");
    expect(classifyTimestamp("banana", NOW)).toBe("malformed");
    expect(classifyTimestamp(null, NOW)).toBe("malformed");
    expect(classifyTimestamp(daysAhead(365), NOW)).toBe("future");
  });

  it("ATTACK: future-dated evidence is discarded, not treated as permanently fresh", () => {
    const r = deriveConfidence([{ kind: "production_check", supports: true, capturedAt: daysAhead(365) }], NOW);
    expect(r.confidence).toBe("unknown");
    expect(r.discarded).toBe(1);
  });

  it("ATTACK: a malformed date is not reported as 'older than 21 days'", () => {
    const r = deriveConfidence([{ kind: "production_check", supports: true, capturedAt: "banana" }], NOW);
    expect(r.confidence).toBe("unknown");
    expect(r.reason).not.toContain("older than");
    expect(r.reason).toContain("unusable or future timestamp");
  });
});

describe("evidence confidence", () => {
  it("reports Unknown with no evidence", () => {
    expect(deriveConfidence([], NOW).confidence).toBe("unknown");
  });

  it("contradiction always wins, even against a majority", () => {
    const evidence: EvidenceRecord[] = [
      { kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
      { kind: "production_check", supports: true, capturedAt: daysAgo(1) },
      { kind: "manual_verification", supports: false, capturedAt: daysAgo(1), commitSha: SHA },
    ];
    expect(deriveConfidence(evidence, NOW).confidence).toBe("contradictory");
  });

  it("stale when everything supporting is out of date", () => {
    expect(
      deriveConfidence([{ kind: "vitest", supports: true, capturedAt: daysAgo(60), commitSha: SHA }], NOW).confidence
    ).toBe("stale");
  });

  it("quantity never upgrades quality", () => {
    const many: EvidenceRecord[] = Array.from({ length: 20 }, () => ({
      kind: "owner_statement" as const,
      supports: true,
      capturedAt: daysAgo(1),
    }));
    expect(deriveConfidence(many, NOW).confidence).toBe("reported");
  });

  it("a human review can never become Automatically Verified", () => {
    expect(
      deriveConfidence([{ kind: "hostile_review", supports: true, capturedAt: daysAgo(1), commitSha: SHA }], NOW)
        .confidence
    ).toBe("verified_by_review");
  });

  it("evidence for another commit or a lower environment is refused", () => {
    const evidence: EvidenceRecord[] = [
      { kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: "old00000" },
      { kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "staging" },
      { kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: "new11111" },
    ];
    const scoped = scopeEvidence(evidence, { commitSha: "new11111", environment: "production" });
    expect(scoped.applicable).toHaveLength(1);
    expect(scoped.rejected).toHaveLength(2);
    expect(scoped.rejected[1].reason).toContain("staging");
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("ten-category weighted readiness", () => {
  it("uses the approved weights, summing to 100", () => {
    expect(Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(CATEGORY_WEIGHTS).toMatchObject({
      requirements: 10,
      database: 15,
      backend: 20,
      frontend: 10,
      security: 10,
      tests: 10,
      review: 10,
      landing: 5,
      deployment: 5,
      production: 5,
    });
  });

  it("always reports all ten categories", () => {
    const cats = resolveCategories(pkg(), NOW);
    expect(cats.map((c) => c.category).sort()).toEqual([...READINESS_CATEGORIES].sort());
  });

  it("reaches 100% only when every category is genuinely complete", () => {
    expect(computeReadiness([fullyProven()], NOW).overall).toBe(100);
  });

  it("ATTACK: cannot round up to 100% — 100 and 99 average to 99, not 100", () => {
    const a = fullyProven({ key: "a" });
    const b = fullyProven({
      key: "b",
      acceptanceCriteria: [
        { id: "c1", text: "one", met: true, evidenceRef: "e" },
        { id: "c2", text: "two", met: false, evidenceRef: null },
      ],
    });
    const r = computeReadiness([a, b], NOW);
    expect(r.overall).toBeLessThan(100);
    expect(clampPercent(99.6)).toBe(99);
    expect(clampPercent(99.99)).toBe(99);
    expect(clampPercent(100)).toBe(100);
  });

  it("ATTACK: not_applicable is refused for every mandatory category", () => {
    const bypass = fullyProven({
      categoryStates: Object.fromEntries(MANDATORY_CATEGORIES.map((c) => [c, "not_applicable" as const])),
    });
    const cats = resolveCategories(bypass, NOW);
    for (const category of MANDATORY_CATEGORIES) {
      expect(cats.find((c) => c.category === category)!.state, category).not.toBe("not_applicable");
    }
  });

  it("ATTACK: review 'not_required' plus production 'not_applicable' no longer scores free marks", () => {
    const bypass = pkg({
      status: "merged",
      declaredCompletion: 100,
      reviewState: "not_required",
      deploymentState: "production",
      productionVerification: "not_applicable",
      evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    const r = computeReadiness([bypass], NOW);
    expect(r.overall).toBeLessThan(CAP_NOT_PRODUCTION_VERIFIED);
    // And it is EXPLAINED, not silent — the previous version returned an empty gates list.
    expect(r.gates.length).toBeGreaterThan(0);
    const cats = resolveCategories(bypass, NOW);
    expect(cats.find((c) => c.category === "review")!.state).toBe("not_started");
    expect(cats.find((c) => c.category === "production")!.state).toBe("not_started");
  });

  it("caps at 49% for an unresolved HIGH security issue", () => {
    const risky = fullyProven({
      blockers: [{ kind: "security_issue", description: "auth bypass", openedAt: daysAgo(1), severity: "high" }],
    });
    const r = computeReadiness([risky], NOW);
    expect(r.overall).toBeLessThanOrEqual(CAP_UNRESOLVED_HIGH_SECURITY);
    expect(r.appliedCaps.some((c) => c.cap === CAP_UNRESOLVED_HIGH_SECURITY)).toBe(true);
  });

  it("a CRITICAL security issue caps the same way", () => {
    const risky = fullyProven({
      blockers: [{ kind: "security_issue", description: "rce", openedAt: daysAgo(1), severity: "critical" }],
    });
    expect(computeReadiness([risky], NOW).overall).toBeLessThanOrEqual(CAP_UNRESOLVED_HIGH_SECURITY);
  });

  it("a resolved security issue does not cap", () => {
    const fine = fullyProven({
      blockers: [
        {
          kind: "security_issue",
          description: "fixed",
          openedAt: daysAgo(3),
          resolvedAt: daysAgo(1),
          severity: "high",
        },
      ],
    });
    expect(computeReadiness([fine], NOW).overall).toBe(100);
  });

  it("caps at 69% for a failed review", () => {
    const failed = fullyProven({ reviewState: "failed" });
    const r = computeReadiness([failed], NOW);
    expect(r.overall).toBeLessThanOrEqual(CAP_REVIEW_FAILED);
  });

  it("not merged contributes zero to landing", () => {
    const notMerged = fullyProven({ status: "committed" });
    const landing = resolveCategories(notMerged, NOW).find((c) => c.category === "landing")!;
    expect(landing.state).toBe("in_progress");
    expect(landing.score).toBe(50);

    const notCommitted = fullyProven({ status: "built" });
    expect(resolveCategories(notCommitted, NOW).find((c) => c.category === "landing")!.score).toBe(0);
  });

  it("not deployed contributes zero to deployment", () => {
    const nd = fullyProven({ deploymentState: "not_deployed" });
    expect(resolveCategories(nd, NOW).find((c) => c.category === "deployment")!.score).toBe(0);
  });

  it("not production verified keeps overall below 100", () => {
    const np = fullyProven({ productionVerification: "not_verified" });
    const r = computeReadiness([np], NOW);
    expect(r.overall).toBeLessThan(100);
    expect(r.appliedCaps.some((c) => c.cap === CAP_NOT_PRODUCTION_VERIFIED)).toBe(true);
  });

  it("ATTACK: production verified without production EVIDENCE scores zero, not partial credit", () => {
    const claim = fullyProven({
      evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    const prod = resolveCategories(claim, NOW).find((c) => c.category === "production")!;
    expect(prod.state).toBe("not_started");
    expect(prod.score).toBe(0);
    expect(prod.overridden).toBe(true);
  });

  it("stale test evidence does not count as current", () => {
    const stale = fullyProven({
      evidence: [
        { kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "production", commitSha: SHA },
        { kind: "vitest", supports: true, capturedAt: daysAgo(30), commitSha: SHA },
      ],
    });
    const tests = resolveCategories(stale, NOW).find((c) => c.category === "tests")!;
    expect(tests.state).toBe("not_started");
    expect(tests.reason).toContain("no longer count");
  });

  it("failing tests mark the tests category failed", () => {
    const failing = fullyProven({
      evidence: [
        { kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "production", commitSha: SHA },
        { kind: "vitest", supports: false, capturedAt: daysAgo(1), commitSha: SHA },
      ],
    });
    expect(resolveCategories(failing, NOW).find((c) => c.category === "tests")!.state).toBe("failed");
  });

  it("required tests must each have a current passing run", () => {
    const partial = fullyProven({
      requiredTests: [
        { id: "t1", name: "types", kind: "typescript" },
        { id: "t2", name: "unit", kind: "vitest" },
        { id: "t3", name: "build", kind: "production_build" },
      ],
    });
    const tests = resolveCategories(partial, NOW).find((c) => c.category === "tests")!;
    expect(tests.state).toBe("in_progress");
    expect(tests.reason).toContain("2/3");
  });

  it("acceptance criteria drive the requirements category, and unevidenced claims do not count", () => {
    // H3-4 tightened this: "e1" is not a real evidence record, so it no longer counts either.
    // Both criteria are therefore unproven and the category earns nothing.
    const claimed = pkg({
      acceptanceCriteria: [
        { id: "a", text: "one", met: true, evidenceRef: "e1" },
        { id: "b", text: "two", met: true, evidenceRef: null },
      ],
    });
    const req = resolveCategories(claimed, NOW).find((c) => c.category === "requirements")!;
    expect(req.state).toBe("not_started");
    expect(req.reason).toContain("0/2");
    expect(req.overridden).toBe(true);

    // With ONE criterion citing genuinely resolvable evidence, the category moves partway.
    const half = pkg({
      // commitSha is required: `vitest` is commit-bound, so evidence without it is scoped out
      // before requirements resolution ever sees it (the H-2 control, still in force).
      evidence: [{ id: 77, kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
      acceptanceCriteria: [
        { id: "a", text: "one", met: true, evidenceRef: "77" },
        { id: "b", text: "two", met: true, evidenceRef: null },
      ],
    });
    const partial = resolveCategories(half, NOW).find((c) => c.category === "requirements")!;
    expect(partial.state).toBe("in_progress");
    expect(partial.reason).toContain("1/2");
  });

  it("an optional category may be non-applicable ONLY with a justification", () => {
    const noJustification = fullyProven({ categoryStates: { frontend: "not_applicable" } });
    expect(resolveCategories(noJustification, NOW).find((c) => c.category === "frontend")!.state).toBe("not_started");

    const justified = fullyProven({
      categoryStates: { frontend: "not_applicable" },
      categoryNotes: { frontend: "Server-only change; no UI surface." },
    });
    const cat = resolveCategories(justified, NOW).find((c) => c.category === "frontend")!;
    expect(cat.state).toBe("not_applicable");
    expect(cat.effectiveWeight).toBe(0);
  });

  it("redistributes a non-applicable optional weight across the rest", () => {
    const justified = fullyProven({
      categoryStates: { frontend: "not_applicable" },
      categoryNotes: { frontend: "Server-only change." },
    });
    const cats = resolveCategories(justified, NOW);
    const total = cats.reduce((s, c) => s + c.effectiveWeight, 0);
    expect(Math.round(total)).toBe(100);
    expect(computeReadiness([justified], NOW).overall).toBe(100);
  });

  it("handles hostile numeric inputs", () => {
    expect(assessWorkPackage(pkg({ declaredCompletion: -500 }), NOW).declaredCompletion).toBe(0);
    expect(assessWorkPackage(pkg({ declaredCompletion: 9999 }), NOW).declaredCompletion).toBe(100);
    expect(assessWorkPackage(pkg({ declaredCompletion: Number.NaN }), NOW).declaredCompletion).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("an empty programme is 0%, not 100%", () => {
    const r = computeReadiness([], NOW);
    expect(r.overall).toBe(0);
    expect(r.gates).toContain("No work packages.");
  });

  it("superseded work is excluded from the aggregate", () => {
    expect(computeReadiness([fullyProven(), pkg({ key: "old", status: "superseded" })], NOW).overall).toBe(100);
  });

  it("one unverified package keeps the whole programme below 100", () => {
    const r = computeReadiness([fullyProven({ key: "a" }), pkg({ key: "b" })], NOW);
    expect(r.overall).toBeLessThan(100);
    expect(r.appliedCaps.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("status assessment warnings", () => {
  it("downgrades Production Verified with no production evidence", () => {
    const a = assessWorkPackage(pkg({ status: "production_verified", declaredCompletion: 100 }), NOW);
    expect(a.effectiveStatus).toBe("awaiting_production_verification");
  });

  it("ATTACK: warns when production verification is claimed but nothing is deployed", () => {
    const a = assessWorkPackage(
      pkg({ status: "production_verified", productionVerification: "verified", deploymentState: "not_deployed" }),
      NOW
    );
    expect(a.warnings.join(" ")).toContain("deployment state says Not deployed");
  });

  it("shows Blocked whatever the recorded status says", () => {
    const a = assessWorkPackage(
      pkg({
        status: "ready_for_landing",
        blockers: [{ kind: "awaiting_founder_decision", description: "needs a call", openedAt: daysAgo(2) }],
      }),
      NOW
    );
    expect(a.effectiveStatus).toBe("blocked");
    expect(a.ownerActionRequired).toBe(true);
  });

  it("flags an open HIGH security issue on the package itself", () => {
    const a = assessWorkPackage(
      pkg({ blockers: [{ kind: "security_issue", description: "x", openedAt: daysAgo(1), severity: "high" }] }),
      NOW
    );
    expect(a.hasUnresolvedHighSecurity).toBe(true);
    expect(a.warnings.join(" ")).toContain("capped at 49%");
  });

  it("flags a large gap between declared and evidenced completion", () => {
    const a = assessWorkPackage(pkg({ status: "planned", declaredCompletion: 95 }), NOW);
    expect(a.completionAnomaly).toBeTruthy();
    expect(a.completion).toBeLessThan(95);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("programme tree integrity", () => {
  const nodes: ProgrammeNode[] = [
    { id: 1, key: "root", parentKey: null, name: "MintVault", sortOrder: 0 },
    { id: 2, key: "child", parentKey: "root", name: "Partner Network", sortOrder: 10 },
    { id: 3, key: "grandchild", parentKey: "child", name: "G6D", sortOrder: 10 },
  ];

  it("rolls descendants up into the parent", () => {
    const tree = buildProgrammeTree(
      nodes,
      [pkg({ key: "a", nodeKey: "grandchild", risk: "critical" }), pkg({ key: "b", nodeKey: "child" })],
      NOW
    );
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].rollup.packageCount).toBe(2);
    expect(tree.roots[0].rollup.risk).toBe("critical");
  });

  it("ATTACK: a package with an unknown node is surfaced, never hidden", () => {
    const tree = buildProgrammeTree(nodes, [pkg({ key: "orphan", nodeKey: "does-not-exist" })], NOW);
    expect(tree.orphanedPackages).toEqual([{ key: "orphan", nodeKey: "does-not-exist" }]);
    const unassigned = tree.roots.find((r) => r.key === "__unassigned__");
    expect(unassigned).toBeTruthy();
    expect(unassigned!.packages.map((p) => p.key)).toEqual(["orphan"]);
  });

  it("ATTACK: a node parent cycle does not make the tree disappear", () => {
    const cyclic: ProgrammeNode[] = [
      { id: 1, key: "a", parentKey: "b", name: "A", sortOrder: 0 },
      { id: 2, key: "b", parentKey: "a", name: "B", sortOrder: 0 },
    ];
    const tree = buildProgrammeTree(cyclic, [pkg({ key: "p", nodeKey: "a" })], NOW);
    expect(tree.nodeCycles.length).toBeGreaterThan(0);
    expect(tree.roots.length).toBeGreaterThan(0);
    expect(tree.orphanedNodes.length).toBeGreaterThan(0);
  });

  it("a node with a missing parent is promoted and reported", () => {
    const orphanNode: ProgrammeNode[] = [{ id: 9, key: "orphan", parentKey: "missing", name: "Orphan", sortOrder: 0 }];
    const tree = buildProgrammeTree(orphanNode, [], NOW);
    expect(tree.roots).toHaveLength(1);
    expect(tree.orphanedNodes[0].reason).toContain("does not exist");
  });

  it("reports the worst confidence in a subtree", () => {
    const tree = buildProgrammeTree(
      nodes,
      [
        pkg({
          key: "a",
          nodeKey: "grandchild",
          evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
        }),
        pkg({ key: "b", nodeKey: "child" }),
      ],
      NOW
    );
    expect(tree.roots[0].rollup.worstConfidence).toBe("unknown");
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("dependency graph", () => {
  it("marks an edge blocking while the dependency is unfinished", () => {
    const graph = buildDependencyGraph([pkg({ key: "a", dependsOn: ["b"] }), pkg({ key: "b" })], NOW);
    expect(graph.edges).toEqual([{ from: "b", to: "a", blocking: true }]);
  });

  it("reports a dangling dependency instead of dropping it silently", () => {
    const graph = buildDependencyGraph([pkg({ key: "a", dependsOn: ["ghost"] })], NOW);
    expect(graph.edges).toHaveLength(0);
    expect(graph.danglingDependencies).toEqual([{ from: "a", missing: "ghost" }]);
  });

  it("detects a two-node cycle", () => {
    const cycles = findDependencyCycles([
      { key: "a", dependsOn: ["b"] },
      { key: "b", dependsOn: ["a"] },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(["a", "b"]);
  });

  it("detects a self-dependency", () => {
    expect(findDependencyCycles([{ key: "a", dependsOn: ["a"] }])).toHaveLength(1);
  });

  it("finds no cycle in a clean chain", () => {
    expect(
      findDependencyCycles([
        { key: "a", dependsOn: [] },
        { key: "b", dependsOn: ["a"] },
        { key: "c", dependsOn: ["b"] },
      ])
    ).toHaveLength(0);
  });

  it("ATTACK: is linear, not exponential — 2,000 densely linked packages complete promptly", () => {
    const N = 2000;
    const packages = [pkg({ key: "p0" }), pkg({ key: "p1", dependsOn: ["p0"] })];
    for (let i = 2; i < N; i++) {
      packages.push(pkg({ key: `p${i}`, dependsOn: [`p${i - 1}`, `p${i - 2}`] }));
    }
    const started = Date.now();
    const cycles = findDependencyCycles(packages);
    const elapsed = Date.now() - started;
    expect(cycles).toHaveLength(0);
    // The previous implementation needed roughly 48 seconds for FORTY packages.
    expect(elapsed).toBeLessThan(2000);
  });

  it("does not blow the stack on a very deep chain", () => {
    const packages = [pkg({ key: "p0" })];
    for (let i = 1; i < 5000; i++) packages.push(pkg({ key: `p${i}`, dependsOn: [`p${i - 1}`] }));
    expect(() => findDependencyCycles(packages)).not.toThrow();
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("next action engine", () => {
  it("recommends the corrective action for each unhealthy stage", () => {
    const cases: [WorkPackage["status"], string][] = [
      ["not_started", "build"],
      ["in_progress", "build"],
      ["built", "test"],
      ["built_with_known_defects", "fix"],
      ["needs_fixing", "fix"],
      ["awaiting_test_evidence", "test"],
      ["tests_failing", "fix"],
      ["awaiting_review", "review"],
      ["review_failed", "fix_review"],
      ["deployed", "verify_production"],
    ];
    for (const [status, expected] of cases) {
      expect(computeNextActions([pkg({ status })], NOW)[0]?.kind, status).toBe(expected);
    }
  });

  it("ATTACK: refuses to recommend DEPLOY when tests are failing", () => {
    const failing = pkg({
      status: "merged",
      businessValue: 5,
      evidence: [{ kind: "vitest", supports: false, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    const action = computeNextActions([failing], NOW)[0];
    expect(action.kind).not.toBe("deploy");
    expect(action.kind).toBe("fix");
    expect(action.suppressed.join(" ")).toContain("Deploy withheld");
  });

  it("ATTACK: refuses to recommend MERGE/LAND when review failed", () => {
    const failed = pkg({ status: "ready_for_landing", reviewState: "failed" });
    const action = computeNextActions([failed], NOW)[0];
    expect(action.kind).toBe("fix_review");
    expect(action.suppressed.length).toBeGreaterThan(0);
  });

  it("ATTACK: refuses to recommend deploy with an open HIGH security issue", () => {
    const risky = pkg({
      status: "merged",
      blockers: [{ kind: "security_issue", description: "auth bypass", openedAt: daysAgo(1), severity: "high" }],
    });
    expect(computeNextActions([risky], NOW)[0].kind).toBe("security_review");
  });

  it("ATTACK: refuses to recommend deploy on contradictory evidence", () => {
    const contradicted = pkg({
      status: "merged",
      evidence: [
        { kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
        { kind: "manual_verification", supports: false, capturedAt: daysAgo(1), commitSha: SHA },
      ],
    });
    expect(computeNextActions([contradicted], NOW)[0].kind).not.toBe("deploy");
  });

  it("recommends deploy only when the evidence genuinely supports it", () => {
    const ready = pkg({
      status: "merged",
      reviewState: "passed",
      evidence: [
        { kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
        { kind: "hostile_review", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
      ],
    });
    const action = computeNextActions([ready], NOW)[0];
    expect(action.kind).toBe("deploy");
    expect(action.requiresOwnerApproval).toBe(true);
    expect(action.suppressed).toHaveLength(0);
  });

  it("labels every protected action as owner-approved", () => {
    for (const [status, kind] of [
      ["ready_for_landing", "land"],
      ["merged", "deploy"],
    ] as const) {
      const ready = pkg({
        status,
        reviewState: "passed",
        evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
      });
      const action = computeNextActions([ready], NOW)[0];
      expect(action.kind, status).toBe(kind);
      expect(action.requiresOwnerApproval, status).toBe(true);
    }
  });

  it("recommends nothing for finished or superseded work", () => {
    expect(computeNextActions([fullyProven()], NOW)).toHaveLength(0);
    expect(computeNextActions([pkg({ status: "superseded" })], NOW)).toHaveLength(0);
  });

  it("demotes work whose dependencies are unfinished", () => {
    const blocked = pkg({ key: "blocked-one", status: "not_started", businessValue: 5, dependsOn: ["upstream"] });
    const upstream = pkg({ key: "upstream", status: "in_progress", businessValue: 1 });
    const ranked = computeNextActions([blocked, upstream], NOW);
    expect(ranked[0].packageKey).toBe("upstream");
  });

  it("clamps malformed value and risk inputs instead of producing a top-priority zero-risk action", () => {
    const malformed = pkg({
      status: "in_progress",
      businessValue: 9999 as unknown as number,
      engineeringRisk: -50 as unknown as number,
    });
    const action = computeNextActions([malformed], NOW)[0];
    expect(action.businessValue).toBeLessThanOrEqual(5);
    expect(action.riskScore).toBeGreaterThan(0);
  });

  it("an empty programme produces no actions", () => {
    expect(computeNextActions([], NOW)).toHaveLength(0);
    expect(summariseNextActions([]).highestPriority).toBeNull();
  });

  it("never proposes a suppressed action as a 'safest' pick", () => {
    const suppressed = pkg({
      key: "bad",
      status: "merged",
      evidence: [{ kind: "vitest", supports: false, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    expect(summariseNextActions(computeNextActions([suppressed], NOW)).safestDeployment).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("queues", () => {
  it("provides all nine approved queues", () => {
    const queues = computeQueues([pkg()], NOW);
    expect(queues.map((q) => q.key)).toEqual([
      "needs_attention",
      "ready_for_codex",
      "awaiting_founder_decision",
      "awaiting_hostile_review",
      "needs_fixing",
      "ready_to_land",
      "ready_to_deploy",
      "awaiting_production_verification",
      "stale_evidence",
    ]);
  });

  const queueOf = (key: string, packages: WorkPackage[]) => computeQueues(packages, NOW).find((q) => q.key === key)!;

  it("Needs attention catches failing, blocked and contradictory work", () => {
    const failing = pkg({ key: "f", status: "tests_failing" });
    const secure = pkg({
      key: "s",
      blockers: [{ kind: "security_issue", description: "x", openedAt: daysAgo(1), severity: "critical" }],
    });
    expect(
      queueOf("needs_attention", [failing, secure])
        .entries.map((e) => e.packageKey)
        .sort()
    ).toEqual(["f", "s"]);
  });

  it("Ready for Codex only lists unblocked work with a branch", () => {
    const ready = pkg({ key: "r", status: "in_progress", branch: "codex/x" });
    const noBranch = pkg({ key: "n", status: "in_progress" });
    const blocked = pkg({
      key: "b",
      status: "in_progress",
      branch: "codex/y",
      blockers: [{ kind: "other", description: "x", openedAt: daysAgo(1) }],
    });
    expect(queueOf("ready_for_codex", [ready, noBranch, blocked]).entries.map((e) => e.packageKey)).toEqual(["r"]);
  });

  it("Awaiting founder decision is owner-flagged", () => {
    const waiting = pkg({
      key: "w",
      blockers: [{ kind: "awaiting_founder_decision", description: "pick a name", openedAt: daysAgo(1) }],
    });
    const q = queueOf("awaiting_founder_decision", [waiting]);
    expect(q.entries).toHaveLength(1);
    expect(q.entries[0].requiresOwnerApproval).toBe(true);
  });

  it("Ready to deploy excludes anything with failing tests", () => {
    const good = pkg({
      key: "g",
      status: "merged",
      evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    const bad = pkg({
      key: "b",
      status: "merged",
      evidence: [{ kind: "vitest", supports: false, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    expect(queueOf("ready_to_deploy", [good, bad]).entries.map((e) => e.packageKey)).toEqual(["g"]);
  });

  it("Stale evidence lists only stale-confidence work", () => {
    const stale = pkg({
      key: "s",
      evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(60), commitSha: SHA }],
    });
    const fresh = pkg({
      key: "f",
      evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    expect(queueOf("stale_evidence", [stale, fresh]).entries.map((e) => e.packageKey)).toEqual(["s"]);
  });

  it("Awaiting production verification lists deployed-but-unchecked work", () => {
    const deployed = pkg({ key: "d", status: "deployed", deploymentState: "production" });
    expect(queueOf("awaiting_production_verification", [deployed]).entries.map((e) => e.packageKey)).toEqual(["d"]);
  });

  it("a queue can be used as a filter", () => {
    const stale = pkg({
      key: "s",
      evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(60), commitSha: SHA }],
    });
    const fresh = pkg({
      key: "f",
      evidence: [{ kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    expect(filterPackages([stale, fresh], { queue: "stale_evidence" }, NOW).map((p) => p.key)).toEqual(["s"]);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("filtering", () => {
  const packages = [
    pkg({
      key: "one",
      title: "Scanner crop gate",
      status: "awaiting_review",
      risk: "high",
      branch: "fix/front-crop",
      tags: ["scanner"],
    }),
    pkg({ key: "two", title: "Wallet ledger", status: "built", risk: "low", tags: ["shop-launch"] }),
    pkg({
      key: "three",
      title: "Blocked thing",
      status: "in_progress",
      blockers: [{ kind: "awaiting_founder_decision", description: "needs a call", openedAt: daysAgo(1) }],
    }),
  ];

  it("searches titles, branches, tags and criteria", () => {
    expect(filterPackages(packages, { search: "crop" }, NOW).map((p) => p.key)).toEqual(["one"]);
    expect(filterPackages(packages, { search: "front-crop" }, NOW).map((p) => p.key)).toEqual(["one"]);
    expect(filterPackages(packages, { search: "scanner" }, NOW).map((p) => p.key)).toEqual(["one"]);
  });

  it("filters by tag", () => {
    expect(filterPackages(packages, { tags: ["shop-launch"] }, NOW).map((p) => p.key)).toEqual(["two"]);
  });

  it("filters on the EFFECTIVE status", () => {
    expect(filterPackages(packages, { statuses: ["blocked"] }, NOW).map((p) => p.key)).toEqual(["three"]);
    expect(filterPackages(packages, { statuses: ["in_progress"] }, NOW)).toHaveLength(0);
  });

  it("returns everything for an empty filter", () => {
    expect(filterPackages(packages, {}, NOW)).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("deployment history and drift", () => {
  const deployments: DeploymentRecord[] = [
    { environment: "production", commitSha: "aaaaaaaa", result: "succeeded", deployedAt: daysAgo(5) },
    { environment: "production", commitSha: "bbbbbbbb", result: "succeeded", deployedAt: daysAgo(1) },
    { environment: "staging", commitSha: "cccccccc", result: "failed", deployedAt: daysAgo(2) },
  ];

  it("returns the newest release per environment", () => {
    const latest = latestDeployments(deployments);
    expect(latest.production?.commitSha).toBe("bbbbbbbb");
    expect(latest.local).toBeUndefined();
  });

  it("turns a failed release or test into contradicting evidence", () => {
    expect(evidenceFromHistory([deployments[2]], [])[0].supports).toBe(false);
    expect(evidenceFromHistory([], [{ kind: "vitest", result: "failed", ranAt: daysAgo(1) }])[0].supports).toBe(false);
  });

  it("carries commit and environment onto derived evidence", () => {
    const e = evidenceFromHistory([deployments[1]], [])[0];
    expect(e.commitSha).toBe("bbbbbbbb");
    expect(e.environment).toBe("production");
  });

  it("detects production lagging main", () => {
    const report = detectDrift({
      mainSha: "ffffffff",
      latestDeployments: latestDeployments(deployments),
      packages: [],
      now: NOW,
    });
    expect(report.severity).toBe("warning");
    expect(report.findings.some((f) => f.code === "production_behind_main")).toBe(true);
  });

  it("flags a rolled-back production release as critical", () => {
    const report = detectDrift({
      mainSha: "aaaaaaaa",
      latestDeployments: {
        production: { environment: "production", commitSha: "aaaaaaaa", result: "rolled_back", deployedAt: daysAgo(1) },
      },
      packages: [],
      now: NOW,
    });
    expect(report.severity).toBe("critical");
  });

  it("flags a package claiming production verification at a commit production never ran", () => {
    const report = detectDrift({
      mainSha: "bbbbbbbb",
      latestDeployments: latestDeployments(deployments),
      packages: [fullyProven({ latestCommit: "deadbeef" })],
      now: NOW,
    });
    expect(report.severity).toBe("critical");
    expect(report.findings.some((f) => f.code === "verified_commit_not_in_production")).toBe(true);
  });

  it("reports no drift when everything lines up", () => {
    const report = detectDrift({
      mainSha: "bbbbbbbb",
      dirtyFileCount: 0,
      latestDeployments: {
        production: { environment: "production", commitSha: "bbbbbbbb", result: "succeeded", deployedAt: daysAgo(1) },
      },
      packages: [],
      now: NOW,
    });
    expect(report.severity).toBe("none");
    expect(report.findings).toHaveLength(0);
  });
});
