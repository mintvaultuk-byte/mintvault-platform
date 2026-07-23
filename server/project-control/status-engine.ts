import crypto from "node:crypto";
import type {
  LifecycleState,
  ProjectControlSummary,
  ProjectEvidence,
  ProjectRecommendation,
  ProjectRequirement,
  RequirementStatus,
} from "./types";

const READINESS_BY_STATE: Record<LifecycleState, number> = {
  "not started": 0,
  proposed: 5,
  "in progress": 25,
  implemented: 45,
  "test evidence missing": 45,
  "tests failing": 20,
  "review pending": 60,
  "review failed": 30,
  "review passed": 75,
  "deployment pending": 80,
  deployed: 85,
  "production verification pending": 90,
  "production verified": 100,
  blocked: 0,
  stale: 10,
  unknown: 0,
  superseded: 0,
};

const CONFIDENCE_BY_EVIDENCE = {
  "Locked Founder Requirement": 65,
  "Proven from repository": 70,
  "Proven from production": 80,
  "Proven from database": 80,
  "Proven by tests": 90,
  "Proven by human review": 85,
  "Reported but Unverified": 35,
  Assumption: 20,
  "Future Roadmap": 45,
  "Open Question": 20,
  Unknown: 15,
  "Stale Evidence": 15,
  Contradiction: 10,
  "Superseded Decision": 10,
} as const;

const DIRECT_EVIDENCE_CONFIDENCE_CAP = 15;

const STRONG_EVIDENCE_CLASSES = new Set([
  "Proven from repository",
  "Proven from production",
  "Proven from database",
  "Proven by tests",
  "Proven by human review",
]);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function evidenceIsStale(evidence: ProjectEvidence, now: Date): boolean {
  if (!evidence.staleAfter) return evidence.evidenceClassification === "Stale Evidence";
  return new Date(evidence.staleAfter).getTime() <= now.getTime();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * A scanner may see the same observation from both a live scan and persisted
 * evidence. Keep the newest matching observation so duplicate evidence cannot
 * inflate readiness or confidence.
 */
function uniqueEvidence(items: ProjectEvidence[]): ProjectEvidence[] {
  const byObservation = new Map<string, ProjectEvidence>();
  for (const item of items) {
    const key = [
      item.sourceKind,
      item.sourceLocator,
      item.evidenceClassification,
      item.lifecycleState,
      item.summary,
      stableJson(item.payload ?? null),
    ].join("\u0000");
    const existing = byObservation.get(key);
    if (!existing || new Date(item.sourceTimestamp).getTime() > new Date(existing.sourceTimestamp).getTime()) {
      byObservation.set(key, item);
    }
  }
  return [...byObservation.values()];
}

export function calculateRequirementStatuses(
  requirements: ProjectRequirement[],
  evidence: ProjectEvidence[],
  now: Date = new Date()
): RequirementStatus[] {
  const evidenceByRequirement = new Map<string, ProjectEvidence[]>();
  for (const item of evidence) {
    for (const requirementId of new Set(item.requirementIds)) {
      const list = evidenceByRequirement.get(requirementId) ?? [];
      list.push(item);
      evidenceByRequirement.set(requirementId, list);
    }
  }

  return requirements.map((requirement) => {
    const related = uniqueEvidence(evidenceByRequirement.get(requirement.id) ?? []);
    const stale = related.some((item) => evidenceIsStale(item, now)) || requirement.lifecycleState === "stale";
    const contradictory =
      requirement.evidenceClassification === "Contradiction" ||
      related.some((item) => item.evidenceClassification === "Contradiction");
    const failedMandatoryTest = related.some((item) => item.sourceKind === "test" && item.lifecycleState === "tests failing");
    const missingMandatoryTest = related.some(
      (item) => item.sourceKind === "test" && item.lifecycleState === "test evidence missing"
    );
    const hasStrongCurrentEvidence = related.some(
      (item) => STRONG_EVIDENCE_CLASSES.has(item.evidenceClassification) && !evidenceIsStale(item, now) && item.lifecycleState !== "test evidence missing"
    );
    const blocked =
      requirement.lifecycleState === "blocked" ||
      requirement.lifecycleState === "unknown" ||
      requirement.evidenceClassification === "Open Question" ||
      contradictory ||
      failedMandatoryTest;

    const evidenceConfidence = related.length
      ? related.reduce(
          (sum, item) =>
            sum + CONFIDENCE_BY_EVIDENCE[item.evidenceClassification] + item.confidenceImpact - (evidenceIsStale(item, now) ? 25 : 0),
          0
        ) / related.length
      : CONFIDENCE_BY_EVIDENCE[requirement.evidenceClassification];

    let readinessBase = blocked ? 0 : READINESS_BY_STATE[requirement.lifecycleState];
    if (stale) readinessBase = Math.min(readinessBase, READINESS_BY_STATE.stale);
    if (missingMandatoryTest) readinessBase = Math.min(readinessBase, READINESS_BY_STATE["test evidence missing"]);
    // A lifecycle label is not proof by itself. Unverified/self-reported work
    // may be visible as in progress, but cannot resemble reviewed readiness.
    if (!hasStrongCurrentEvidence) readinessBase = Math.min(readinessBase, READINESS_BY_STATE["in progress"]);

    let confidence = related.length === 0 ? DIRECT_EVIDENCE_CONFIDENCE_CAP : evidenceConfidence;
    if (missingMandatoryTest) confidence = Math.min(confidence, CONFIDENCE_BY_EVIDENCE["Reported but Unverified"]);
    if (!hasStrongCurrentEvidence) confidence = Math.min(confidence, CONFIDENCE_BY_EVIDENCE["Reported but Unverified"]);
    if (failedMandatoryTest) confidence = 0;
    confidence = clampPercent(confidence - (stale ? 20 : 0) - (contradictory ? 35 : 0));

    return {
      requirementId: requirement.id,
      lifecycleState: failedMandatoryTest
        ? "tests failing"
        : missingMandatoryTest
          ? "test evidence missing"
          : contradictory
            ? "blocked"
            : requirement.lifecycleState,
      readinessPercent: clampPercent(readinessBase),
      confidencePercent: confidence,
      evidenceIds: related.map((item) => item.evidenceId),
      reason:
        failedMandatoryTest
          ? "A mandatory test is failing; readiness is blocked."
          : missingMandatoryTest
            ? "Mandatory test evidence is missing or skipped; readiness is capped until a current pass is recorded."
            : related.length > 0
              ? `Derived from ${related.length} unique evidence item(s) and lifecycle state ${requirement.lifecycleState}.`
              : `No direct evidence ingested; readiness and confidence are capped below review readiness.`,
      stale,
      blocked,
      optional: requirement.optional === true,
    };
  });
}

export function buildRecommendations(statuses: RequirementStatus[], evidence: ProjectEvidence[]): ProjectRecommendation[] {
  const recommendations: ProjectRecommendation[] = [];
  const byId = new Map(statuses.map((status) => [status.requirementId, status]));

  const projectControlBlockers = statuses.filter(
    (status) => status.requirementId.startsWith("MEGS-PCD-") && (status.blocked || status.readinessPercent < 75)
  );
  if (projectControlBlockers.length > 0) {
    recommendations.push({
      id: "pcd-complete-evidence-loop",
      priority: "blocker",
      requirementIds: projectControlBlockers.map((status) => status.requirementId),
      summary: "Finish Project Control evidence, status, readiness, and Super Admin surfaces before review.",
      rationale: "The dashboard cannot claim governance readiness until its own requirements have evidence and tests.",
      evidenceIds: projectControlBlockers.flatMap((status) => status.evidenceIds),
    });
  }

  const contradictionEvidence = evidence.filter((item) => item.evidenceClassification === "Contradiction");
  if (contradictionEvidence.length > 0) {
    recommendations.push({
      id: "resolve-contradictions",
      priority: "high",
      requirementIds: [...new Set(contradictionEvidence.flatMap((item) => item.requirementIds))],
      summary: "Keep contradictory requirements blocked until founder decisions are recorded.",
      rationale: "MEGS requires contradictions to block affected implementation and release claims.",
      evidenceIds: contradictionEvidence.map((item) => item.evidenceId),
    });
  }

  const staleStatuses = statuses.filter((status) => status.stale);
  if (staleStatuses.length > 0) {
    recommendations.push({
      id: "refresh-stale-evidence",
      priority: "medium",
      requirementIds: staleStatuses.map((status) => status.requirementId),
      summary: "Refresh stale evidence before using it for readiness.",
      rationale: "Stale evidence reduces confidence and must not silently remain current.",
      evidenceIds: staleStatuses.flatMap((status) => status.evidenceIds),
    });
  }

  const missingTests = statuses.filter((status) => byId.get(status.requirementId)?.lifecycleState === "test evidence missing");
  if (missingTests.length > 0) {
    recommendations.push({
      id: "run-targeted-tests",
      priority: "high",
      requirementIds: missingTests.map((status) => status.requirementId),
      summary: "Run or add targeted tests for implemented mechanisms with missing test evidence.",
      rationale: "Implementation alone does not verify requirements.",
      evidenceIds: missingTests.flatMap((status) => status.evidenceIds),
    });
  }

  return recommendations;
}

export function buildSummary(args: {
  requirements: ProjectRequirement[];
  evidence: ProjectEvidence[];
  statuses: RequirementStatus[];
  repository: Record<string, unknown>;
  production: Record<string, unknown>;
  generatedAt?: string;
}): ProjectControlSummary {
  const mandatoryStatuses = args.statuses.filter((status) => status.lifecycleState !== "superseded" && !status.optional);
  const denominator = mandatoryStatuses.length;
  const numerator = mandatoryStatuses.reduce((sum, status) => sum + status.readinessPercent, 0);
  const confidenceNumerator = mandatoryStatuses.reduce((sum, status) => sum + status.confidencePercent, 0);
  const contradictions = args.evidence.filter((item) => item.evidenceClassification === "Contradiction").length;

  return {
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    baselineVersion: "MEGS v1.1",
    readOnly: true,
    featureFlag: "super_admin_project_control_enabled",
    totals: {
      requirements: args.requirements.length,
      evidenceItems: args.evidence.length,
      blocked: args.statuses.filter((status) => status.blocked).length,
      unknown: args.statuses.filter((status) => status.lifecycleState === "unknown").length,
      stale: args.statuses.filter((status) => status.stale).length,
      contradictions,
      optional: args.statuses.filter((status) => status.optional).length,
    },
    readiness: {
      overallPercent: denominator > 0 ? clampPercent(numerator / denominator) : 0,
      confidencePercent: denominator > 0 ? clampPercent(confidenceNumerator / denominator) : 0,
      numerator: clampPercent(numerator),
      denominator: denominator * 100,
      formula:
        "sum(mandatory requirement readiness percent) / mandatory, non-superseded requirement count; missing evidence, stale evidence, failed or skipped tests, contradictions, unknowns, and blocks cap or zero readiness.",
    },
    repository: args.repository,
    production: args.production,
    recommendations: buildRecommendations(args.statuses, args.evidence),
  };
}

export function buildContinuationPrompt(args: {
  summary: ProjectControlSummary;
  requirements: ProjectRequirement[];
  statuses: RequirementStatus[];
  evidence: ProjectEvidence[];
}): { snapshotId: string; promptText: string; sourceEvidenceIds: string[] } {
  const blockers = args.statuses.filter((status) => status.blocked).map((status) => status.requirementId);
  const stale = args.statuses.filter((status) => status.stale).map((status) => status.requirementId);
  const sourceEvidenceIds = [...new Set(args.evidence.map((item) => item.evidenceId))].sort();
  const seed = JSON.stringify({
    readiness: args.summary.readiness,
    requirements: args.requirements.map((requirement) => ({
      id: requirement.id,
      evidenceClassification: requirement.evidenceClassification,
      lifecycleState: requirement.lifecycleState,
      optional: requirement.optional === true,
    })),
    statuses: args.statuses.map((status) => ({
      requirementId: status.requirementId,
      lifecycleState: status.lifecycleState,
      readinessPercent: status.readinessPercent,
      confidencePercent: status.confidencePercent,
      evidenceIds: [...status.evidenceIds].sort(),
      stale: status.stale,
      blocked: status.blocked,
      optional: status.optional,
    })),
    blockers,
    stale,
    sourceEvidenceIds,
  });
  const snapshotId = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  const promptText = [
    "RECOMMENDED MODEL: GPT-5.5 Codex High",
    "",
    "Use MEGS v1.1 as the governing baseline.",
    `Evidence snapshot: ${snapshotId}`,
    `Overall readiness: ${args.summary.readiness.overallPercent}%`,
    `Confidence: ${args.summary.readiness.confidencePercent}%`,
    "",
    "Forbidden actions: deploy, merge, push to production, apply production migrations, disable security, infer completion from missing evidence.",
    "",
    `Blocked requirement IDs: ${blockers.length > 0 ? blockers.join(", ") : "None"}`,
    `Stale requirement IDs: ${stale.length > 0 ? stale.join(", ") : "None"}`,
    "",
    "This is a content-addressed snapshot: identical evidence and status inputs produce identical prompt text and ID. Continue only through safe engineering phases. Stop at founder decisions, repository integrity risk, destructive database actions, security blockers, or unresolved architecture decisions.",
  ].join("\n");
  return { snapshotId, promptText, sourceEvidenceIds };
}
