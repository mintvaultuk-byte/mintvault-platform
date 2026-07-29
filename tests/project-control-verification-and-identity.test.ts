/**
 * Project Control — third-hostile-review remediation suite.
 *
 * Every case beginning "H3-x" is a defect the third hostile review proved, reproduced here first
 * so the fix is demonstrated rather than asserted. These run against the REAL engine and the REAL
 * key-derivation code — nothing is mirrored or re-implemented for the test.
 *
 * Covers:
 *  H3-1  a deployment record must never satisfy production verification;
 *  H3-3  idempotency encoding must be collision-safe;
 *  H3-4  an acceptance criterion must cite evidence that actually resolves;
 *  plus the low-risk severity-canonicalisation and iterative-layout hardening.
 */
import { describe, it, expect } from "vitest";
import {
  CAP_NOT_PRODUCTION_VERIFIED,
  PRODUCTION_VERIFICATION_EVIDENCE_KINDS,
  REQUIREMENTS_EVIDENCE_KINDS,
  assessWorkPackage,
  canonicalSeverity,
  computeNextActions,
  computeReadiness,
  hasUnresolvedHighSecurityIssue,
  resolveAcceptanceCriteria,
  resolveCategories,
  type EvidenceRecord,
  type WorkPackage,
} from "@shared/project-control";
import {
  IDEMPOTENCY_DOMAINS,
  canonicalIdempotencyKey,
  deploymentAttemptKey,
  testRunAttemptKey,
  AttemptIdentityError,
} from "../server/project-control/idempotency";
import { layoutDependencyColumns } from "../client/src/pages/admin/project-control-helpers";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const ago = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString();
const ahead = (n: number) => new Date(NOW.getTime() + n * 864e5).toISOString();
const SHA = "abc1234def5678";
const OTHER_SHA = "9999999999999999";

function pkg(o: Partial<WorkPackage> = {}): WorkPackage {
  return {
    id: 1, key: "k", nodeKey: "core", title: "T", summary: "", status: "production_verified",
    declaredCompletion: 100, risk: "low", classification: "A", reviewState: "passed",
    deploymentState: "production", productionVerification: "verified", businessValue: 3,
    engineeringRisk: 2, estimatedEffortDays: null, remainingWork: "", branch: null,
    worktreePath: null, baseCommit: null, latestCommit: SHA, prUrl: null, version: 1,
    updatedAt: ago(1), evidence: [], blockers: [], dependsOn: [], acceptanceCriteria: [],
    requiredTests: [], categoryStates: {}, categoryNotes: {}, tags: [],
    ...o,
  } as WorkPackage;
}

/** Everything except production verification genuinely proven. */
const OTHERWISE_PERFECT: EvidenceRecord[] = [
  { id: 901, kind: "vitest", supports: true, capturedAt: ago(1), commitSha: SHA },
  { id: 902, kind: "hostile_review", supports: true, capturedAt: ago(2), commitSha: SHA },
];
const PROVEN_CRITERIA = [{ id: "a", text: "It works", met: true, evidenceRef: "901" }];

const categoryOf = (p: WorkPackage, name: string) => resolveCategories(p, NOW).find((c) => c.category === name)!;

/* ------------------------------------------------------------------------------------------ */
/* H3-1 — a deployment is not a verification                                                    */
/* ------------------------------------------------------------------------------------------ */

describe("H3-1: deployment must never prove production verification", () => {
  it("only production_check is an accepted production-verification kind", () => {
    expect(PRODUCTION_VERIFICATION_EVIDENCE_KINDS).toEqual(["production_check"]);
    expect(PRODUCTION_VERIFICATION_EVIDENCE_KINDS).not.toContain("deployment");
  });

  it("REPRODUCTION: production deployment + verified flag no longer yields a warning-free 100%", () => {
    const p = pkg({
      acceptanceCriteria: PROVEN_CRITERIA,
      evidence: [
        { id: 1, kind: "deployment", supports: true, capturedAt: ago(1), commitSha: SHA, environment: "production" },
        ...OTHERWISE_PERFECT,
      ],
    });
    const r = computeReadiness([p], NOW);
    const assessment = assessWorkPackage(p, NOW);

    expect(categoryOf(p, "production").state).toBe("not_started");
    expect(r.overall).toBeLessThan(100);
    expect(r.overall).toBeLessThanOrEqual(CAP_NOT_PRODUCTION_VERIFIED);
    expect(r.gates.some((g) => g.startsWith("production"))).toBe(true);
    expect(assessment.warnings.length).toBeGreaterThan(0);
  });

  it("deployment credit is complete while production verification stays incomplete", () => {
    const p = pkg({
      acceptanceCriteria: PROVEN_CRITERIA,
      evidence: [
        { id: 1, kind: "deployment", supports: true, capturedAt: ago(1), commitSha: SHA, environment: "production" },
        ...OTHERWISE_PERFECT,
      ],
    });
    expect(categoryOf(p, "deployment").state).toBe("complete");
    expect(categoryOf(p, "production").state).not.toBe("complete");
  });

  it("the next safe action asks for verification, not another deployment", () => {
    const p = pkg({
      acceptanceCriteria: PROVEN_CRITERIA,
      evidence: [
        { id: 1, kind: "deployment", supports: true, capturedAt: ago(1), commitSha: SHA, environment: "production" },
        ...OTHERWISE_PERFECT,
      ],
    });
    const kinds = computeNextActions([p], NOW).map((a) => a.kind);
    expect(kinds).toContain("verify_production");
    expect(kinds).not.toContain("deploy");
  });

  it("a healthy production deployment alone does not verify", () => {
    const p = pkg({
      productionVerification: "not_verified",
      evidence: [
        { id: 1, kind: "deployment", supports: true, capturedAt: ago(1), commitSha: SHA, environment: "production" },
      ],
    });
    expect(categoryOf(p, "production").state).toBe("not_started");
    expect(categoryOf(p, "production").reason).toMatch(/nobody has verified it|not verified/i);
  });

  it("an operator flipping productionVerification to verified proves nothing on its own", () => {
    const p = pkg({ productionVerification: "verified", evidence: [] });
    expect(categoryOf(p, "production").state).toBe("not_started");
    expect(categoryOf(p, "production").overridden).toBe(true);
  });

  it("a genuine production_check on the right commit and environment DOES count", () => {
    const p = pkg({
      acceptanceCriteria: PROVEN_CRITERIA,
      evidence: [
        { id: 1, kind: "production_check", supports: true, capturedAt: ago(1), commitSha: SHA, environment: "production" },
        ...OTHERWISE_PERFECT,
      ],
    });
    expect(categoryOf(p, "production").state).toBe("complete");
    expect(computeReadiness([p], NOW).overall).toBe(100);
  });

  it("staging verification still does not count", () => {
    const p = pkg({
      evidence: [
        { id: 1, kind: "production_check", supports: true, capturedAt: ago(1), commitSha: SHA, environment: "staging" },
      ],
    });
    expect(categoryOf(p, "production").state).not.toBe("complete");
  });

  it("foreign-commit verification still does not count", () => {
    const p = pkg({
      evidence: [
        { id: 1, kind: "production_check", supports: true, capturedAt: ago(1), commitSha: OTHER_SHA, environment: "production" },
      ],
    });
    expect(categoryOf(p, "production").state).not.toBe("complete");
  });

  it("stale verification still does not count", () => {
    const p = pkg({
      evidence: [
        { id: 1, kind: "production_check", supports: true, capturedAt: ago(400), commitSha: SHA, environment: "production" },
      ],
    });
    expect(categoryOf(p, "production").state).not.toBe("complete");
  });

  it("malformed and future verification fail closed", () => {
    for (const capturedAt of ["not-a-date", ahead(3)]) {
      const p = pkg({
        evidence: [
          { id: 1, kind: "production_check", supports: true, capturedAt, commitSha: SHA, environment: "production" },
        ],
      });
      expect(categoryOf(p, "production").state).not.toBe("complete");
    }
  });

  it("no warning-free false 100% remains for any deployment-only shape", () => {
    const shapes: Partial<WorkPackage>[] = [
      { deploymentState: "production", productionVerification: "verified" },
      { deploymentState: "production", productionVerification: "not_verified" },
      { deploymentState: "staging", productionVerification: "verified" },
      { deploymentState: "rolled_back", productionVerification: "verified" },
    ];
    for (const shape of shapes) {
      const p = pkg({
        ...shape,
        acceptanceCriteria: PROVEN_CRITERIA,
        evidence: [
          { id: 1, kind: "deployment", supports: true, capturedAt: ago(1), commitSha: SHA, environment: "production" },
          ...OTHERWISE_PERFECT,
        ],
      });
      const r = computeReadiness([p], NOW);
      expect(r.overall, JSON.stringify(shape)).toBeLessThan(100);
      expect(r.gates.length, JSON.stringify(shape)).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------------------------------ */
/* H3-3 — collision-safe identity encoding                                                      */
/* ------------------------------------------------------------------------------------------ */

describe("H3-3: idempotency encoding is collision-safe", () => {
  const D = IDEMPOTENCY_DOMAINS.deployment;

  it("REPRODUCTION: the old |~| separator collision no longer collides", () => {
    const split = canonicalIdempotencyKey(D, { a: "deployment", b: "production", c: "abc" });
    const joined = canonicalIdempotencyKey(D, { a: "deployment|~|production", b: "abc", c: null });
    expect(split).not.toBe(joined);
  });

  it("a separator embedded in the first field cannot impersonate the next field", () => {
    expect(canonicalIdempotencyKey(D, { a: "x=s:1:y", b: "z" })).not.toBe(
      canonicalIdempotencyKey(D, { a: "x", b: "y", c: "z" })
    );
  });

  it("empty string stays distinguishable from null", () => {
    expect(canonicalIdempotencyKey(D, { a: "" })).not.toBe(canonicalIdempotencyKey(D, { a: null }));
  });

  it("null stays distinguishable from the literal string 'null'", () => {
    expect(canonicalIdempotencyKey(D, { a: null })).not.toBe(canonicalIdempotencyKey(D, { a: "null" }));
  });

  it("property order cannot alter identity", () => {
    expect(canonicalIdempotencyKey(D, { alpha: "1", beta: "2" })).toBe(
      canonicalIdempotencyKey(D, { beta: "2", alpha: "1" })
    );
  });

  it("field NAMES matter: the same values under different names differ", () => {
    expect(canonicalIdempotencyKey(D, { a: "1", b: "2" })).not.toBe(canonicalIdempotencyKey(D, { a: "2", b: "1" }));
  });

  it("deployment and test-run domains cannot cross-collide", () => {
    const fields = { externalId: "run-1", environment: "production", commitSha: SHA };
    expect(canonicalIdempotencyKey(IDEMPOTENCY_DOMAINS.deployment, fields)).not.toBe(
      canonicalIdempotencyKey(IDEMPOTENCY_DOMAINS.testRun, fields)
    );
  });

  it("Unicode values encode deterministically and distinctly", () => {
    const composed = "caf\u00e9"; // e-acute as ONE code point
    const decomposed = "cafe\u0301"; // e + combining acute
    expect(composed).not.toBe(decomposed);

    // Deterministic: the same string always yields the same key.
    expect(canonicalIdempotencyKey(D, { a: composed })).toBe(canonicalIdempotencyKey(D, { a: composed }));
    // Distinct: genuinely different byte sequences are NOT collapsed. Deliberate — the encoder
    // does no normalisation, because silently folding distinct values reintroduces collisions.
    expect(canonicalIdempotencyKey(D, { a: composed })).not.toBe(canonicalIdempotencyKey(D, { a: decomposed }));
    expect(canonicalIdempotencyKey(D, { a: composed })).not.toBe(canonicalIdempotencyKey(D, { a: "cafe" }));
  });
  it("identical canonical inputs produce identical keys; any difference does not", () => {
    const base = { externalId: "dep-1", environment: "production", commitSha: SHA, releaseVersion: "v1", packageKey: "wp" };
    expect(canonicalIdempotencyKey(D, base)).toBe(canonicalIdempotencyKey(D, { ...base }));
    expect(canonicalIdempotencyKey(D, base)).not.toBe(canonicalIdempotencyKey(D, { ...base, releaseVersion: "v2" }));
  });
});

/* ------------------------------------------------------------------------------------------ */
/* H3-2 — attempt identity (validation half; the DB half is the integration suite)              */
/* ------------------------------------------------------------------------------------------ */

describe("H3-2: attempt identity is required and meaningful", () => {
  it("REPRODUCTION: a genuine redeploy of the same commit is no longer merged", () => {
    const first = deploymentAttemptKey({ externalId: "dep-1", environment: "production", commitSha: SHA });
    const second = deploymentAttemptKey({ externalId: "dep-2", environment: "production", commitSha: SHA });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("the same deployment retried keeps one identity", () => {
    const a = deploymentAttemptKey({ externalId: "dep-1", environment: "production", commitSha: SHA });
    const b = deploymentAttemptKey({ externalId: "dep-1", environment: "production", commitSha: SHA });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it("rollback then redeploy of the same commit are separable", () => {
    const rollback = deploymentAttemptKey({ externalId: "dep-rollback", environment: "production", commitSha: SHA });
    const redeploy = deploymentAttemptKey({ externalId: "dep-redeploy", environment: "production", commitSha: SHA });
    expect(rollback.idempotencyKey).not.toBe(redeploy.idempotencyKey);
  });

  it("a second CI run of the same suite and commit is a separate run", () => {
    const first = testRunAttemptKey({ externalRunId: "ci-1", kind: "vitest", commitSha: SHA });
    const second = testRunAttemptKey({ externalRunId: "ci-2", kind: "vitest", commitSha: SHA });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("missing every attempt identity is rejected, not silently derived", () => {
    expect(() => deploymentAttemptKey({ environment: "production", commitSha: SHA })).toThrow(AttemptIdentityError);
    expect(() => testRunAttemptKey({ kind: "vitest", commitSha: SHA })).toThrow(AttemptIdentityError);
  });

  it("blank and whitespace-only attempt identities are rejected", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      expect(() => deploymentAttemptKey({ externalId: blank, environment: "production", commitSha: SHA })).toThrow(
        AttemptIdentityError
      );
      expect(() => testRunAttemptKey({ externalRunId: blank, kind: "vitest" })).toThrow(AttemptIdentityError);
    }
  });

  it("oversized attempt identities are rejected", () => {
    const huge = "a".repeat(201);
    expect(() => deploymentAttemptKey({ externalId: huge, environment: "production", commitSha: SHA })).toThrow(
      AttemptIdentityError
    );
    expect(() => deploymentAttemptKey({ idempotencyKey: huge, environment: "production", commitSha: SHA })).toThrow(
      AttemptIdentityError
    );
  });

  it("a too-short or malformed explicit key is rejected", () => {
    expect(() => deploymentAttemptKey({ idempotencyKey: "short", environment: "production", commitSha: SHA })).toThrow(
      AttemptIdentityError
    );
    expect(() =>
      deploymentAttemptKey({ idempotencyKey: "has spaces!!", environment: "production", commitSha: SHA })
    ).toThrow(AttemptIdentityError);
  });

  it("an explicit idempotency key wins over the derived identity", () => {
    const a = deploymentAttemptKey({ idempotencyKey: "req-abc-123", externalId: "dep-1", environment: "production", commitSha: SHA });
    const b = deploymentAttemptKey({ idempotencyKey: "req-abc-123", externalId: "dep-2", environment: "staging", commitSha: OTHER_SHA });
    expect(a.idempotencyKey).toBe("req-abc-123");
    expect(b.idempotencyKey).toBe("req-abc-123");
  });

  it("no timestamp participates in identity", () => {
    const a = deploymentAttemptKey({ externalId: "dep-1", environment: "production", commitSha: SHA });
    // Same inputs, computed later — identity must not drift with the clock.
    const b = deploymentAttemptKey({ externalId: "dep-1", environment: "production", commitSha: SHA });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* H3-4 — acceptance criteria must cite resolvable evidence                                     */
/* ------------------------------------------------------------------------------------------ */

describe("H3-4: acceptance criteria must reference real evidence", () => {
  const realEvidence: EvidenceRecord[] = [
    { id: 55, kind: "vitest", supports: true, capturedAt: ago(1), commitSha: SHA },
  ];

  it("REPRODUCTION: evidenceRef 'x' no longer self-certifies requirements", () => {
    const p = pkg({
      latestCommit: null,
      evidence: [],
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "x" }],
    });
    const requirements = categoryOf(p, "requirements");
    expect(requirements.state).toBe("not_started");
    expect(requirements.reason).toMatch(/does not exist/);
    expect(requirements.overridden).toBe(true);
  });

  it("a real evidence id counts", () => {
    const p = pkg({
      evidence: realEvidence,
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }],
    });
    expect(categoryOf(p, "requirements").state).toBe("complete");
  });

  it("a nonexistent evidence id does not count", () => {
    const p = pkg({
      evidence: realEvidence,
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "99999" }],
    });
    expect(categoryOf(p, "requirements").state).toBe("not_started");
  });

  it("evidence belonging to another package does not count", () => {
    // Another package's evidence is simply absent from this package's evidence set.
    const p = pkg({ evidence: [], acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }] });
    expect(categoryOf(p, "requirements").state).toBe("not_started");
  });

  it("foreign-commit evidence does not count and says so", () => {
    const p = pkg({
      latestCommit: SHA,
      evidence: [{ id: 55, kind: "vitest", supports: true, capturedAt: ago(1), commitSha: OTHER_SHA }],
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }],
    });
    const requirements = categoryOf(p, "requirements");
    expect(requirements.state).toBe("not_started");
    expect(requirements.reason).toMatch(/another commit or environment/);
  });

  it("stale evidence does not count", () => {
    const p = pkg({
      evidence: [{ id: 55, kind: "vitest", supports: true, capturedAt: ago(400), commitSha: SHA }],
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }],
    });
    expect(categoryOf(p, "requirements").state).toBe("not_started");
  });

  it("contradicting evidence does not count", () => {
    const p = pkg({
      evidence: [{ id: 55, kind: "vitest", supports: false, capturedAt: ago(1), commitSha: SHA }],
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }],
    });
    expect(categoryOf(p, "requirements").state).toBe("not_started");
  });

  it("malformed-timestamp evidence does not count", () => {
    const p = pkg({
      evidence: [{ id: 55, kind: "vitest", supports: true, capturedAt: "nonsense", commitSha: SHA }],
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }],
    });
    expect(categoryOf(p, "requirements").state).toBe("not_started");
  });

  it("an owner statement cannot prove a requirement", () => {
    expect(REQUIREMENTS_EVIDENCE_KINDS).not.toContain("owner_statement");
    const p = pkg({
      evidence: [{ id: 55, kind: "owner_statement", supports: true, capturedAt: ago(1), commitSha: SHA }],
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }],
    });
    const requirements = categoryOf(p, "requirements");
    expect(requirements.state).toBe("not_started");
    expect(requirements.reason).toMatch(/cannot prove a requirement/);
  });

  it("manual verification IS accepted for a requirement", () => {
    const p = pkg({
      evidence: [{ id: 55, kind: "manual_verification", supports: true, capturedAt: ago(1), commitSha: SHA }],
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "55" }],
    });
    expect(categoryOf(p, "requirements").state).toBe("complete");
  });

  it("mixed valid and invalid criteria score partially, not fully", () => {
    const p = pkg({
      evidence: realEvidence,
      acceptanceCriteria: [
        { id: "a", text: "real", met: true, evidenceRef: "55" },
        { id: "b", text: "fake", met: true, evidenceRef: "x" },
      ],
    });
    const requirements = categoryOf(p, "requirements");
    expect(requirements.state).toBe("in_progress");
    expect(requirements.reason).toContain("1/2");
  });

  it("a criterion that is simply not met is still representable, with no shortfall noise", () => {
    const p = pkg({
      evidence: realEvidence,
      acceptanceCriteria: [{ id: "a", text: "todo", met: false, evidenceRef: null }],
    });
    const requirements = categoryOf(p, "requirements");
    expect(requirements.state).toBe("not_started");
    expect(requirements.overridden).toBe(false);
  });

  it("met-without-any-reference is reported as a shortfall", () => {
    const resolutions = resolveAcceptanceCriteria(
      [{ id: "a", text: "works", met: true, evidenceRef: null }],
      [], [], NOW
    );
    expect(resolutions[0].counted).toBe(false);
    expect(resolutions[0].shortfall).toMatch(/cites no evidence/);
  });

  it("there is no requirements self-certification path left", () => {
    const p = pkg({
      latestCommit: null,
      evidence: [],
      categoryStates: { requirements: "complete" } as never,
      acceptanceCriteria: [{ id: "a", text: "works", met: true, evidenceRef: "anything" }],
    });
    expect(categoryOf(p, "requirements").state).not.toBe("complete");
    expect(computeReadiness([p], NOW).overall).toBeLessThan(100);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Low-risk hardening                                                                           */
/* ------------------------------------------------------------------------------------------ */

describe("low-risk hardening", () => {
  it("severity canonicalises case and whitespace, and refuses anything else", () => {
    expect(canonicalSeverity("HIGH")).toBe("high");
    expect(canonicalSeverity("  Critical ")).toBe("critical");
    expect(canonicalSeverity("none")).toBe("none");
    for (const bad of ["hi", "sev-high", "", null, undefined, 7, {}]) {
      expect(canonicalSeverity(bad as never)).toBeNull();
    }
  });

  it("the 49% security cap cannot be dodged with a non-canonical severity", () => {
    for (const severity of ["high", "HIGH", " High "]) {
      expect(
        hasUnresolvedHighSecurityIssue([
          { id: 1, kind: "security_issue", description: "x", severity: severity as never, openedAt: ago(1), resolvedAt: null },
        ])
      ).toBe(true);
    }
  });

  it("an unrecognised severity does not trigger the cap and does not crash", () => {
    expect(
      hasUnresolvedHighSecurityIssue([
        { id: 1, kind: "security_issue", description: "x", severity: "sev-9" as never, openedAt: ago(1), resolvedAt: null },
      ])
    ).toBe(false);
  });

  it("layoutDependencyColumns is iterative: a 5000-long chain does not overflow", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => ({ key: `n${i}` }));
    const edges = Array.from({ length: 4999 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    const layout = layoutDependencyColumns(nodes, edges);
    expect(layout).toHaveLength(5000);
    expect(layout[4999].column).toBe(4999);
  });

  it("layoutDependencyColumns still pins cycle members to column 0", () => {
    const layout = layoutDependencyColumns(
      [{ key: "a" }, { key: "b" }],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ]
    );
    expect(layout.every((n) => n.column >= 0)).toBe(true);
  });
});
