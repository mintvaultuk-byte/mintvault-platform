/**
 * Project Control — evidence scoping suite (second-hostile-review H-1 and H-2).
 *
 * H-1: a `production_check` recorded against STAGING satisfied production verification and
 *      produced a warning-free 100% with no caps, no gates and no next actions.
 * H-2: `scopeEvidence()` existed but nothing called it, so a package at commit A reached 100% on
 *      evidence recorded entirely against commit B.
 *
 * Every case below is written from the attacker's side: prove the false 100% is unreachable, and
 * prove a genuinely valid evidence set still gets full marks.
 */
import { describe, it, expect } from "vitest";
import {
  COMMIT_INDEPENDENT_EVIDENCE_KINDS,
  assessWorkPackage,
  canonicalCommit,
  canonicalEnvironment,
  commitsMatch,
  computeNextActions,
  computeReadiness,
  assessWorkPackage,
  aggregateReadiness,
  CAP_CONTRADICTORY_EVIDENCE,
  CAP_BLOCKED,
  isCommitBound,
  resolveCategories,
  scopePackageEvidence,
  type EvidenceRecord,
  type WorkPackage,
} from "@shared/project-control";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 864e5).toISOString();

const SHA = "abc1234def5678";
const OTHER_SHA = "9999999888888";

function pkg(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return {
    id: 1,
    key: "k",
    nodeKey: "core",
    title: "T",
    summary: "",
    status: "production_verified",
    declaredCompletion: 100,
    risk: "low",
    classification: "A",
    reviewState: "passed",
    deploymentState: "production",
    productionVerification: "verified",
    businessValue: 3,
    engineeringRisk: 2,
    estimatedEffortDays: null,
    remainingWork: "",
    branch: null,
    worktreePath: null,
    baseCommit: null,
    latestCommit: SHA,
    prUrl: null,
    version: 1,
    updatedAt: daysAgo(1),
    evidence: [],
    blockers: [],
    dependsOn: [],
    // H3-4: must cite evidence that actually resolves — id 3 in VALID_EVIDENCE below.
    acceptanceCriteria: [{ id: "a1", text: "It works", met: true, evidenceRef: "3" }],
    requiredTests: [],
    categoryStates: {},
    categoryNotes: {},
    tags: [],
    ...overrides,
  };
}

/** A complete, correctly scoped evidence set — the only thing that should ever reach 100%. */
const VALID_EVIDENCE: EvidenceRecord[] = [
  { id: 1, kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "production", commitSha: SHA },
  { id: 2, kind: "deployment", supports: true, capturedAt: daysAgo(2), environment: "production", commitSha: SHA },
  { id: 3, kind: "vitest", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
  { id: 4, kind: "typescript", supports: true, capturedAt: daysAgo(1), commitSha: SHA },
  { id: 5, kind: "hostile_review", supports: true, capturedAt: daysAgo(2), commitSha: SHA },
];

const production = (categories: ReturnType<typeof resolveCategories>) =>
  categories.find((x) => x.category === "production")!;

/* ------------------------------------------------------------------------------------------ */
/* H-1: environment binding                                                                    */
/* ------------------------------------------------------------------------------------------ */

describe("H-1 production verification requires the production environment", () => {
  it("the baseline valid set still reaches 100%", () => {
    const r = computeReadiness([pkg({ evidence: VALID_EVIDENCE })], NOW);
    expect(r.overall).toBe(100);
    expect(r.appliedCaps).toHaveLength(0);
    expect(r.gates).toHaveLength(0);
    expect(assessWorkPackage(pkg({ evidence: VALID_EVIDENCE }), NOW).warnings).toHaveLength(0);
  });

  const WRONG_ENVIRONMENTS: [string, unknown][] = [
    ["staging", "staging"],
    ["local", "local"],
    ["preview", "preview"],
    ["test", "test"],
    ["prod (abbreviated)", "prod"],
    ["PRODUCTION_EU", "PRODUCTION_EU"],
    ["empty string", ""],
    ["whitespace", "   "],
    ["missing", undefined],
    ["null", null],
    ["numeric", 3],
    ["object", { env: "production" }],
  ];

  it.each(WRONG_ENVIRONMENTS)("a production_check from %s cannot exceed 99%%", (_name, environment) => {
    const attacked = pkg({
      evidence: [
        {
          kind: "production_check",
          supports: true,
          capturedAt: daysAgo(1),
          commitSha: SHA,
          environment: environment as never,
        },
        ...VALID_EVIDENCE.filter((e) => e.kind !== "production_check" && e.kind !== "deployment"),
      ],
    });
    const r = computeReadiness([attacked], NOW);
    expect(r.overall).toBeLessThan(100);
    expect(r.appliedCaps.some((c) => c.cap === 99)).toBe(true);
  });

  it.each(WRONG_ENVIRONMENTS)("a production_check from %s leaves production unsatisfied", (_name, environment) => {
    const attacked = pkg({
      evidence: [
        {
          kind: "production_check",
          supports: true,
          capturedAt: daysAgo(1),
          commitSha: SHA,
          environment: environment as never,
        },
      ],
    });
    expect(production(resolveCategories(attacked, NOW)).state).not.toBe("complete");
  });

  it("names the shortfall rather than failing silently", () => {
    const attacked = pkg({
      evidence: [
        { kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "staging", commitSha: SHA },
      ],
    });
    const a = assessWorkPackage(attacked, NOW);
    expect(a.warnings.join(" ")).toMatch(/not recorded in production|does NOT prove production/i);
    expect(a.evidenceScope.shortfalls.length).toBeGreaterThan(0);
  });

  it("mixed staging and production evidence counts only the production record", () => {
    const mixed = pkg({
      evidence: [
        ...VALID_EVIDENCE,
        { kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "staging", commitSha: SHA },
      ],
    });
    expect(computeReadiness([mixed], NOW).overall).toBe(100);
    expect(production(resolveCategories(mixed, NOW)).state).toBe("complete");
  });

  it("a wrong-environment claim still produces a next action instead of going quiet", () => {
    const attacked = pkg({
      evidence: [
        { kind: "production_check", supports: true, capturedAt: daysAgo(1), environment: "staging", commitSha: SHA },
        ...VALID_EVIDENCE.filter((e) => e.kind === "vitest" || e.kind === "hostile_review"),
      ],
    });
    expect(computeNextActions([attacked], NOW).length).toBeGreaterThan(0);
  });

  it("a stale production check no longer proves production", () => {
    const stale = pkg({
      evidence: [
        {
          kind: "production_check",
          supports: true,
          capturedAt: daysAgo(60),
          environment: "production",
          commitSha: SHA,
        },
        ...VALID_EVIDENCE.filter((e) => e.kind === "vitest" || e.kind === "hostile_review"),
      ],
    });
    expect(production(resolveCategories(stale, NOW)).state).not.toBe("complete");
  });

  it("a production deployment claim with only staging deployment evidence is downgraded", () => {
    const claim = pkg({
      deploymentState: "production",
      evidence: [
        { kind: "deployment", supports: true, capturedAt: daysAgo(1), environment: "staging", commitSha: SHA },
      ],
    });
    const deployment = resolveCategories(claim, NOW).find((c) => c.category === "deployment")!;
    expect(deployment.state).not.toBe("complete");
    expect(deployment.overridden).toBe(true);
  });

  it("canonicalises only case and surrounding whitespace — a transport artefact, not a different environment", () => {
    // Documented decision: `" PRODUCTION "` IS production. Everything else fails closed.
    const padded = pkg({
      evidence: [
        {
          kind: "production_check",
          supports: true,
          capturedAt: daysAgo(1),
          environment: " PRODUCTION " as never,
          commitSha: SHA,
        },
        ...VALID_EVIDENCE.filter((e) => e.kind !== "production_check"),
      ],
    });
    expect(computeReadiness([padded], NOW).overall).toBe(100);
  });

  it("canonicalEnvironment fails closed on everything that is not exactly known", () => {
    expect(canonicalEnvironment("production")).toBe("production");
    expect(canonicalEnvironment(" PRODUCTION ")).toBe("production");
    expect(canonicalEnvironment("prod")).toBeNull();
    expect(canonicalEnvironment("production-eu")).toBeNull();
    expect(canonicalEnvironment("")).toBeNull();
    expect(canonicalEnvironment(undefined)).toBeNull();
    expect(canonicalEnvironment(42)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------ */
/* H-2: commit binding                                                                         */
/* ------------------------------------------------------------------------------------------ */

describe("H-2 evidence is scoped to the release commit", () => {
  const foreign = VALID_EVIDENCE.map((e) => ({ ...e, commitSha: OTHER_SHA }));

  it("evidence entirely on a foreign commit cannot reach 100%", () => {
    const r = computeReadiness([pkg({ evidence: foreign })], NOW);
    expect(r.overall).toBeLessThan(100);
    expect(r.gates.length).toBeGreaterThan(0);
  });

  it("reports every foreign record as rejected, with a reason", () => {
    const scope = scopePackageEvidence(pkg({ evidence: foreign }), NOW);
    expect(scope.applicable).toHaveLength(0);
    expect(scope.rejected).toHaveLength(foreign.length);
    expect(scope.rejected.every((r) => r.code === "wrong_commit")).toBe(true);
    expect(scope.shortfalls.join(" ")).toContain("different commit");
  });

  it.each([
    ["automated tests", "vitest", "tests"],
    ["independent review", "hostile_review", "security"],
  ] as const)("foreign %s does not satisfy its category", (_label, kind, category) => {
    const attacked = pkg({ evidence: [{ kind, supports: true, capturedAt: daysAgo(1), commitSha: OTHER_SHA }] });
    expect(resolveCategories(attacked, NOW).find((c) => c.category === category)!.state).not.toBe("complete");
  });

  it("foreign deployment does not satisfy deployment", () => {
    const attacked = pkg({
      deploymentState: "production",
      evidence: [
        { kind: "deployment", supports: true, capturedAt: daysAgo(1), environment: "production", commitSha: OTHER_SHA },
      ],
    });
    expect(resolveCategories(attacked, NOW).find((c) => c.category === "deployment")!.state).not.toBe("complete");
  });

  it("foreign production verification does not satisfy production", () => {
    const attacked = pkg({
      evidence: [
        {
          kind: "production_check",
          supports: true,
          capturedAt: daysAgo(1),
          environment: "production",
          commitSha: OTHER_SHA,
        },
      ],
    });
    expect(production(resolveCategories(attacked, NOW)).state).not.toBe("complete");
  });

  it("mixed old and new evidence counts only the current-commit records", () => {
    const mixed = pkg({ evidence: [...foreign, ...VALID_EVIDENCE] });
    expect(computeReadiness([mixed], NOW).overall).toBe(100);
    const scope = scopePackageEvidence(mixed, NOW);
    expect(scope.applicable).toHaveLength(VALID_EVIDENCE.length);
    expect(scope.rejected).toHaveLength(foreign.length);
  });

  it("commit-bound evidence with NO commit fails closed", () => {
    const noCommit = pkg({ evidence: VALID_EVIDENCE.map((e) => ({ ...e, commitSha: null })) });
    const scope = scopePackageEvidence(noCommit, NOW);
    expect(scope.applicable).toHaveLength(0);
    expect(scope.rejected.every((r) => r.code === "missing_commit")).toBe(true);
    expect(computeReadiness([noCommit], NOW).overall).toBeLessThan(100);
  });

  it("a package with NO release commit cannot count build evidence at all", () => {
    const noRelease = pkg({ latestCommit: null, evidence: VALID_EVIDENCE });
    const scope = scopePackageEvidence(noRelease, NOW);
    expect(scope.applicable).toHaveLength(0);
    expect(scope.rejected.every((r) => r.code === "no_release_commit")).toBe(true);
  });

  it("a malformed commit identifier fails closed on both sides", () => {
    expect(canonicalCommit("not-a-sha")).toBeNull();
    expect(canonicalCommit("abc")).toBeNull();
    expect(canonicalCommit(null)).toBeNull();
    expect(canonicalCommit("ABC1234DEF")).toBe("abc1234def");
    const malformed = pkg({ latestCommit: "zzz", evidence: VALID_EVIDENCE });
    expect(scopePackageEvidence(malformed, NOW).applicable).toHaveLength(0);
  });

  it("accepts a legitimate git abbreviation but never a 6-character prefix", () => {
    expect(commitsMatch("abc1234", "abc1234def5678")).toBe(true);
    expect(commitsMatch("abc1234def5678", "abc1234")).toBe(true);
    expect(commitsMatch("abc123", "abc1234def5678")).toBe(false);
    expect(commitsMatch("abc1235", "abc1234def5678")).toBe(false);
    expect(commitsMatch(null, "abc1234")).toBe(false);
  });

  it("commit-independent kinds are narrowly defined and behave as documented", () => {
    expect([...COMMIT_INDEPENDENT_EVIDENCE_KINDS].sort()).toEqual([
      "database_check",
      "owner_statement",
      "repository_scan",
    ]);
    for (const kind of ["vitest", "typescript", "hostile_review", "deployment", "production_check"] as const) {
      expect(isCommitBound(kind), kind).toBe(true);
    }
    // An owner statement survives with no commit at all, on a package with no release commit.
    const ownerOnly = pkg({
      latestCommit: null,
      evidence: [{ kind: "owner_statement", supports: true, capturedAt: daysAgo(1) }],
    });
    expect(scopePackageEvidence(ownerOnly, NOW).rejected).toHaveLength(0);
  });

  it("stale evidence from the CORRECT commit still does not count", () => {
    const stale = pkg({ evidence: VALID_EVIDENCE.map((e) => ({ ...e, capturedAt: daysAgo(90) })) });
    expect(computeReadiness([stale], NOW).overall).toBeLessThan(100);
  });

  it("future and malformed timestamps are discarded before anything else", () => {
    const bad = pkg({
      evidence: [
        { kind: "vitest", supports: true, capturedAt: daysAhead(30), commitSha: SHA },
        { kind: "vitest", supports: true, capturedAt: "banana", commitSha: SHA },
      ],
    });
    const scope = scopePackageEvidence(bad, NOW);
    expect(scope.applicable).toHaveLength(0);
    expect(scope.rejected.every((r) => r.code === "invalid_timestamp")).toBe(true);
  });

  it("contradictory evidence on the correct commit still applies its cap", () => {
    const contradicted = pkg({
      evidence: [...VALID_EVIDENCE, { kind: "vitest", supports: false, capturedAt: daysAgo(1), commitSha: SHA }],
    });
    const r = computeReadiness([contradicted], NOW);
    expect(r.overall).toBeLessThanOrEqual(69);
  });

  it("scoping is idempotent — applying it twice changes nothing", () => {
    const p = pkg({ evidence: [...foreign, ...VALID_EVIDENCE] });
    const once = scopePackageEvidence(p, NOW);
    const twice = scopePackageEvidence({ ...p, evidence: once.applicable }, NOW);
    expect(twice.applicable).toHaveLength(once.applicable.length);
    expect(twice.rejected).toHaveLength(0);
  });

  it("the assessment always carries the scope report, so nothing is refused silently", () => {
    const a = assessWorkPackage(pkg({ evidence: foreign }), NOW);
    expect(a.evidenceScope.rejected.length).toBe(foreign.length);
    expect(a.warnings.length).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * FIX 4 (OV2) — the AGGREGATE caps.
 *
 * `aggregateReadiness`'s own docstring says "the same caps are re-applied at the aggregate level",
 * but only three of the five were: CAP_CONTRADICTORY_EVIDENCE and CAP_BLOCKED were missing. Since
 * this is the engine whose `overall` the dashboard renders, contradictory evidence and open
 * blockers did not cap the programme number — they diluted it through the mean, so one bad package
 * in ten moved the headline by a few points instead of pinning it.
 *
 * There was no test calling aggregateReadiness at all, which is why the gap survived.
 * ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("OV2 — aggregate readiness applies the caps it promises", () => {
  /** Nine perfect packages and one carrying the named defect. */
  function programme(bad: WorkPackage) {
    const good = Array.from({ length: 9 }, (_, i) => pkg({ id: i + 10, key: `ok-${i}`, evidence: VALID_EVIDENCE }));
    // assessWorkPackage gives the true PER-PACKAGE readiness. computeReadiness([p]) is itself an
    // aggregate-of-one, so feeding it back in would be circular.
    return [...good, bad].map((p) => ({ pkg: p, readiness: assessWorkPackage(p, NOW).readiness }));
  }

  it("a clean programme still reaches its normal ceiling", () => {
    const clean = Array.from({ length: 10 }, (_, i) =>
      pkg({ id: i + 1, key: `ok-${i}`, evidence: VALID_EVIDENCE })
    ).map((p) => ({ pkg: p, readiness: assessWorkPackage(p, NOW).readiness }));

    expect(aggregateReadiness(clean).overall).toBe(100);
  });

  it("one contradictory package caps the WHOLE programme, it does not merely dilute it", () => {
    // supports:false on a production_check against the same commit is the contradiction shape.
    const contradictory = pkg({
      id: 99,
      key: "bad",
      evidence: [
        ...VALID_EVIDENCE,
        { id: 6, kind: "production_check", supports: false, capturedAt: daysAgo(1), environment: "production", commitSha: SHA },
      ],
    });
    const result = aggregateReadiness(programme(contradictory));

    expect(result.overall).toBeLessThanOrEqual(CAP_CONTRADICTORY_EVIDENCE);
    expect(result.appliedCaps.map((c) => c.cap)).toContain(CAP_CONTRADICTORY_EVIDENCE);
    expect(result.appliedCaps.map((c) => c.reason).join(" ")).toContain("contradictory");
  });

  it("one blocked package caps the WHOLE programme", () => {
    const blocked = pkg({
      id: 98,
      key: "blocked",
      evidence: VALID_EVIDENCE,
      blockers: [
        {
          id: 1,
          packageKey: "blocked",
          kind: "dependency",
          severity: "medium",
          description: "Waiting on the payment refactor.",
          openedAt: daysAgo(2),
          resolvedAt: null,
        },
      ],
    });
    const result = aggregateReadiness(programme(blocked));

    expect(result.overall).toBeLessThanOrEqual(CAP_BLOCKED);
    expect(result.appliedCaps.map((c) => c.cap)).toContain(CAP_BLOCKED);
  });

  it("the strictest applicable aggregate cap wins", () => {
    const both = pkg({
      id: 97,
      key: "both",
      evidence: [
        ...VALID_EVIDENCE,
        { id: 6, kind: "production_check", supports: false, capturedAt: daysAgo(1), environment: "production", commitSha: SHA },
      ],
      blockers: [
        {
          id: 2,
          packageKey: "both",
          kind: "dependency",
          severity: "low",
          description: "Blocked too.",
          openedAt: daysAgo(2),
          resolvedAt: null,
        },
      ],
    });
    const result = aggregateReadiness(programme(both));

    // Contradiction (69) is stricter than blocked (79); the lower ceiling must win.
    expect(result.overall).toBeLessThanOrEqual(CAP_CONTRADICTORY_EVIDENCE);
  });
});
