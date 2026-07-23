import { describe, expect, it } from "vitest";
import { loadGovernanceRequirements } from "../server/project-control/governance-loader";
import { buildContinuationPrompt, buildSummary, calculateRequirementStatuses } from "../server/project-control/status-engine";
import type { ProjectEvidence, ProjectRequirement } from "../server/project-control/types";

function req(overrides: Partial<ProjectRequirement>): ProjectRequirement {
  return {
    id: "MEGS-PCD-001",
    description: "Project Control Dashboard must be evidence-based.",
    rationale: "No inferred readiness.",
    acceptanceCriteria: "Derived from evidence.",
    evidenceClassification: "Locked Founder Requirement",
    lifecycleState: "not started",
    relatedComponents: ["Project Control"],
    testsRequired: "Readiness tests",
    sourceDocument: "test",
    ...overrides,
  };
}

function evidence(overrides: Partial<ProjectEvidence>): ProjectEvidence {
  return {
    evidenceId: "ev-1",
    requirementIds: ["MEGS-PCD-001"],
    evidenceClassification: "Proven from repository",
    lifecycleState: "implemented",
    sourceKind: "repository",
    sourceLocator: "test",
    sourceTimestamp: "2026-07-22T00:00:00.000Z",
    summary: "Repository mechanism exists.",
    confidenceImpact: 0,
    ...overrides,
  };
}

describe("Project Control governance loader", () => {
  it("loads the MEGS v1.1 matrix with baseline and amendment requirement IDs", () => {
    const requirements = loadGovernanceRequirements();
    const ids = new Set(requirements.map((item) => item.id));

    expect(requirements.length).toBeGreaterThanOrEqual(86);
    expect(ids.has("MEGS-PCD-010")).toBe(true);
    expect(ids.has("MEGS-SCAN-004")).toBe(true);
    expect(ids.has("VQ-STUDIO-004")).toBe(true);
  });
});

describe("Project Control status engine", () => {
  it("keeps unknown and blocked requirements at zero readiness", () => {
    const requirements = [
      req({ id: "MEGS-PCD-001", lifecycleState: "unknown", evidenceClassification: "Open Question" }),
      req({ id: "MEGS-PCD-006", lifecycleState: "blocked" }),
    ];

    const statuses = calculateRequirementStatuses(requirements, []);

    expect(statuses.map((status) => status.readinessPercent)).toEqual([0, 0]);
    expect(statuses.every((status) => status.blocked)).toBe(true);
  });

  it("reduces confidence for stale evidence without treating it as complete", () => {
    const requirements = [req({ lifecycleState: "implemented" })];
    const statuses = calculateRequirementStatuses(
      requirements,
      [evidence({ staleAfter: "2026-07-21T00:00:00.000Z" })],
      new Date("2026-07-22T00:00:00.000Z")
    );

    expect(statuses[0].readinessPercent).toBe(10);
    expect(statuses[0].stale).toBe(true);
    expect(statuses[0].confidencePercent).toBeLessThan(70);
  });

  it("caps review-labelled requirements when direct evidence is missing", () => {
    const [status] = calculateRequirementStatuses([req({ lifecycleState: "review passed" })], []);

    expect(status.readinessPercent).toBe(25);
    expect(status.confidencePercent).toBeLessThanOrEqual(15);
    expect(status.blocked).toBe(false);
  });

  it("does not double-count repeated evidence observations", () => {
    const requirement = req({ lifecycleState: "review passed" });
    const duplicate = evidence({ evidenceId: "ev-duplicate" });
    const [status] = calculateRequirementStatuses([requirement], [duplicate, { ...duplicate, evidenceId: "ev-copy" }]);

    expect(status.evidenceIds).toEqual(["ev-duplicate"]);
    expect(status.confidencePercent).toBe(70);
  });

  it("blocks a failed mandatory test and exposes skipped test evidence as missing", () => {
    const failed = calculateRequirementStatuses(
      [req({ lifecycleState: "review passed" })],
      [evidence({ sourceKind: "test", evidenceClassification: "Proven by tests", lifecycleState: "tests failing" })]
    )[0];
    const skipped = calculateRequirementStatuses(
      [req({ lifecycleState: "production verified" })],
      [evidence({ sourceKind: "test", lifecycleState: "test evidence missing", payload: { testStatus: "skipped" } })]
    )[0];

    expect(failed).toMatchObject({ lifecycleState: "tests failing", readinessPercent: 0, confidencePercent: 0, blocked: true });
    expect(skipped).toMatchObject({ lifecycleState: "test evidence missing", readinessPercent: 25, blocked: false });
  });

  it("keeps deployment awaiting production verification below completion and self-reports below review readiness", () => {
    const deployment = calculateRequirementStatuses(
      [req({ lifecycleState: "production verification pending" })],
      [evidence({ sourceKind: "production", evidenceClassification: "Proven from production", lifecycleState: "production verification pending" })]
    )[0];
    const selfReported = calculateRequirementStatuses(
      [req({ lifecycleState: "production verified" })],
      [evidence({ evidenceClassification: "Reported but Unverified", lifecycleState: "implemented" })]
    )[0];

    expect(deployment).toMatchObject({ lifecycleState: "production verification pending", readinessPercent: 90, blocked: false });
    expect(selfReported.readinessPercent).toBe(25);
    expect(selfReported.confidencePercent).toBeLessThanOrEqual(35);
  });

  it("excludes optional and superseded work from the mandatory readiness denominator", () => {
    const requirements = [
      req({ id: "MEGS-PCD-001", lifecycleState: "production verified" }),
      req({ id: "OPTIONAL-001", lifecycleState: "not started", optional: true }),
      req({ id: "SUPERSEDED-001", lifecycleState: "superseded" }),
    ];
    const statuses = calculateRequirementStatuses(requirements, [evidence({ lifecycleState: "production verified", evidenceClassification: "Proven by tests" })]);
    const summary = buildSummary({ requirements, evidence: [], statuses, repository: {}, production: {}, generatedAt: "2026-07-22T00:00:00.000Z" });

    expect(summary.readiness).toMatchObject({ numerator: 100, denominator: 100, overallPercent: 100 });
    expect(summary.totals.optional).toBe(1);
  });

  it("builds evidence-provenance recommendations and a frozen continuation prompt", () => {
    const requirements = [req({ id: "MEGS-PCD-006", lifecycleState: "not started" })];
    const ev = [evidence({ evidenceId: "flag-missing", requirementIds: ["MEGS-PCD-006"] })];
    const statuses = calculateRequirementStatuses(requirements, ev);
    const summary = buildSummary({
      requirements,
      evidence: ev,
      statuses,
      repository: { head: "abc" },
      production: { production: { commit: "def" } },
      generatedAt: "2026-07-22T00:00:00.000Z",
    });
    const prompt = buildContinuationPrompt({ summary, requirements, statuses, evidence: ev });

    expect(summary.recommendations[0].requirementIds).toContain("MEGS-PCD-006");
    expect(prompt.promptText).toContain("Forbidden actions");
    expect(prompt.sourceEvidenceIds).toEqual(["flag-missing"]);
  });

  it("creates a stable content-addressed continuation prompt for identical inputs", () => {
    const requirements = [req({ lifecycleState: "implemented" })];
    const ev = [evidence({ evidenceId: "stable-evidence" })];
    const statuses = calculateRequirementStatuses(requirements, ev);
    const firstSummary = buildSummary({ requirements, evidence: ev, statuses, repository: {}, production: {}, generatedAt: "2026-07-22T00:00:00.000Z" });
    const secondSummary = buildSummary({ requirements, evidence: ev, statuses, repository: {}, production: {}, generatedAt: "2026-07-23T00:00:00.000Z" });

    expect(buildContinuationPrompt({ summary: firstSummary, requirements, statuses, evidence: ev })).toEqual(
      buildContinuationPrompt({ summary: secondSummary, requirements, statuses, evidence: ev })
    );
  });
});
