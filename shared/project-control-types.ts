/**
 * Project Control — canonical vocabulary and record shapes.
 *
 * Split out of project-control.ts during remediation so the status vocabulary, readiness
 * categories and record shapes have one unambiguous home. `@shared/project-control` re-exports
 * everything here, so existing imports are unaffected.
 */

/* ------------------------------------------------------------------------------------------ */
/* Status vocabulary — the full approved list                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * All twenty approved lifecycle states, plus `unknown`.
 *
 * REMEDIATION of hostile-review finding "missing approved statuses": the previous list had 17
 * entries and could not represent Built With Known Defects, Needs Fixing, Awaiting Test
 * Evidence, Tests Failing, Committed or Awaiting Deployment at all. `ready_to_merge` is renamed
 * to the approved `ready_for_landing`; a migration-time alias is provided below so any row
 * already carrying the old value still reads correctly.
 */
export const WORK_STATUSES = [
  "not_started",
  "planned",
  "in_progress",
  "built",
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
  "unknown",
] as const;

export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  not_started: "Not started",
  planned: "Planned",
  in_progress: "In progress",
  built: "Built",
  built_with_known_defects: "Built with known defects",
  needs_fixing: "Needs fixing",
  awaiting_test_evidence: "Awaiting test evidence",
  tests_failing: "Tests failing",
  awaiting_review: "Awaiting review",
  review_failed: "Review failed",
  ready_for_landing: "Ready for landing",
  committed: "Committed",
  merged: "Merged",
  awaiting_deployment: "Awaiting deployment",
  deployed: "Deployed",
  awaiting_production_verification: "Awaiting production verification",
  production_verified: "Production verified",
  blocked: "Blocked",
  paused: "Paused",
  superseded: "Superseded",
  unknown: "Unknown",
};

/**
 * Legacy values that may exist in a row written before the vocabulary was completed. Mapped on
 * read so no historical record silently becomes `unknown`.
 */
const LEGACY_STATUS_ALIASES: Record<string, WorkStatus> = {
  ready_to_merge: "ready_for_landing",
  needs_review: "awaiting_review",
  needs_testing: "awaiting_test_evidence",
};

/**
 * Normalise a stored status.
 *
 * DECISION (documented deliberately): input is canonicalised for CASE and SURROUNDING WHITESPACE
 * only — `" Merged "` and `"MERGED"` both resolve to `merged`, because those are storage and
 * transport artefacts rather than different statuses. Everything else FAILS CLOSED to `unknown`,
 * which scores zero and surfaces as a shortfall. In particular no fuzzy matching, no
 * space-for-underscore substitution and no prefix matching: a status the system does not
 * recognise must read as unknown, never as the nearest plausible thing.
 *
 * Note that route input is separately constrained to the exact canonical values by Zod, so this
 * tolerance applies to reading historical rows, not to accepting sloppy API calls.
 */
export function normaliseStatus(value: string | null | undefined): WorkStatus {
  if (typeof value !== "string") return "unknown";
  const canonical = value.trim().toLowerCase();
  if ((WORK_STATUSES as readonly string[]).includes(canonical)) return canonical as WorkStatus;
  return LEGACY_STATUS_ALIASES[canonical] ?? "unknown";
}

/** The happy-path pipeline, in order. */
export const STATUS_PIPELINE: WorkStatus[] = [
  "not_started",
  "planned",
  "in_progress",
  "built",
  "awaiting_test_evidence",
  "awaiting_review",
  "ready_for_landing",
  "committed",
  "merged",
  "awaiting_deployment",
  "deployed",
  "awaiting_production_verification",
  "production_verified",
];

export const OFF_PIPELINE_STATUSES: WorkStatus[] = [
  "built_with_known_defects",
  "needs_fixing",
  "tests_failing",
  "review_failed",
  "blocked",
  "paused",
  "superseded",
  "unknown",
];

export function isOffPipeline(status: WorkStatus): boolean {
  return OFF_PIPELINE_STATUSES.includes(status);
}

/** Statuses that mean "this work is not healthy", used by the queues and the action engine. */
export const UNHEALTHY_STATUSES: WorkStatus[] = [
  "built_with_known_defects",
  "needs_fixing",
  "tests_failing",
  "review_failed",
  "blocked",
];

/** 0-based index into STATUS_PIPELINE; off-pipeline statuses fall back to a conservative anchor. */
export function pipelineIndex(status: WorkStatus): number {
  const direct = STATUS_PIPELINE.indexOf(status);
  if (direct >= 0) return direct;
  switch (status) {
    case "tests_failing":
      return STATUS_PIPELINE.indexOf("awaiting_test_evidence");
    case "review_failed":
      return STATUS_PIPELINE.indexOf("awaiting_review");
    case "built_with_known_defects":
    case "needs_fixing":
      return STATUS_PIPELINE.indexOf("built");
    case "blocked":
    case "paused":
      return STATUS_PIPELINE.indexOf("in_progress");
    case "superseded":
    case "unknown":
    default:
      return 0;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Evidence confidence                                                                          */
/* ------------------------------------------------------------------------------------------ */

export const EVIDENCE_CONFIDENCES = [
  "automatically_verified",
  "verified_by_review",
  "reported",
  "unknown",
  "contradictory",
  "stale",
] as const;

export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number];

export const EVIDENCE_CONFIDENCE_LABELS: Record<EvidenceConfidence, string> = {
  automatically_verified: "Automatically Verified",
  verified_by_review: "Verified By Review",
  reported: "Reported",
  unknown: "Unknown",
  contradictory: "Contradictory",
  stale: "Stale",
};

export const CONFIDENCE_WEIGHT: Record<EvidenceConfidence, number> = {
  automatically_verified: 1,
  verified_by_review: 0.85,
  reported: 0.5,
  unknown: 0.25,
  stale: 0.2,
  contradictory: 0.1,
};

export const CONFIDENCE_RANK: Record<EvidenceConfidence, number> = {
  automatically_verified: 5,
  verified_by_review: 4,
  reported: 3,
  unknown: 2,
  stale: 1,
  contradictory: 0,
};

/**
 * Staleness window in days. Disclosed in the API response and rendered in the UI rather than
 * being a hidden constant, and overridable per call.
 */
export const EVIDENCE_STALE_AFTER_DAYS = 21;

/** Test evidence ages faster than design evidence — a green run from three weeks ago proves little. */
export const TEST_EVIDENCE_STALE_AFTER_DAYS = 7;

export const EVIDENCE_KINDS = [
  "typescript",
  "lint",
  "vitest",
  "integration",
  "production_build",
  "security_review",
  "hostile_review",
  "manual_verification",
  "deployment",
  "production_check",
  "database_check",
  "repository_scan",
  "owner_statement",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Evidence kinds that count as automated test/gate evidence. */
export const TEST_EVIDENCE_KINDS: EvidenceKind[] = ["typescript", "lint", "vitest", "integration", "production_build"];

/** Evidence kinds that count as security evidence. */
export const SECURITY_EVIDENCE_KINDS: EvidenceKind[] = ["security_review", "hostile_review"];

/**
 * The ONLY evidence kinds that can prove production verification.
 *
 * REMEDIATION of third-hostile-review finding H3-1. `deployment` was previously accepted here,
 * so a recorded release plus an operator flipping `productionVerification` to "verified" produced
 * a warning-free 100% with no production check ever performed. A deployment proves a release
 * happened; it does not prove anyone looked at the result.
 *
 * A deployment CAN still become production evidence — but only by being promoted to
 * `production_check`, which `evidenceFromHistory` does exactly when the release carries a
 * `verifiedAt`, i.e. when a verification event genuinely exists.
 */
export const PRODUCTION_VERIFICATION_EVIDENCE_KINDS: EvidenceKind[] = ["production_check"];

/**
 * Evidence kinds an acceptance criterion may cite as proof.
 *
 * REMEDIATION of third-hostile-review finding H3-4. `owner_statement` is deliberately EXCLUDED:
 * it is the kind the seed records for "this is what the founder says, nobody has checked it", so
 * allowing it here would let a requirement be proven by asserting it — the exact
 * self-certification the finding is about. An operator who genuinely checked something by hand
 * records `manual_verification`, which is accepted.
 */
export const REQUIREMENTS_EVIDENCE_KINDS: EvidenceKind[] = [
  "typescript",
  "lint",
  "vitest",
  "integration",
  "production_build",
  "security_review",
  "hostile_review",
  "manual_verification",
  "deployment",
  "production_check",
  "database_check",
  "repository_scan",
];

/**
 * Canonicalise a severity received at the domain boundary.
 *
 * LOW-RISK HARDENING (third review). The 49% security cap compares against lowercase severities,
 * while environment and status inputs are already canonicalised. The database CHECK and the Zod
 * enum both reject non-lowercase severity, so this cannot currently be reached through the API —
 * it exists so a direct service call, a future import path or a fixture cannot quietly bypass the
 * cap by supplying "HIGH".
 *
 * Only whitespace and case are canonicalised. There is deliberately NO fuzzy or confusable
 * matching: an unrecognised value returns null and the caller fails closed.
 */
export function canonicalSeverity(value: unknown): SecuritySeverity | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return (SECURITY_SEVERITIES as readonly string[]).includes(candidate)
    ? (candidate as SecuritySeverity)
    : null;
}

/** The strongest confidence each evidence kind can ever support, by its own nature. */
export const EVIDENCE_KIND_CEILING: Record<EvidenceKind, EvidenceConfidence> = {
  typescript: "automatically_verified",
  lint: "automatically_verified",
  vitest: "automatically_verified",
  integration: "automatically_verified",
  production_build: "automatically_verified",
  repository_scan: "automatically_verified",
  production_check: "automatically_verified",
  database_check: "automatically_verified",
  deployment: "automatically_verified",
  security_review: "verified_by_review",
  hostile_review: "verified_by_review",
  manual_verification: "verified_by_review",
  owner_statement: "reported",
};

export interface EvidenceRecord {
  id?: number | string;
  kind: EvidenceKind;
  /** true = supports the claim; false = contradicts it. */
  supports: boolean;
  capturedAt: string;
  summary?: string;
  sourceRef?: string | null;
  /** Commit the evidence was produced against — evidence for one SHA never proves another. */
  commitSha?: string | null;
  /** Environment the evidence came from — staging evidence never proves production. */
  environment?: Environment | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Readiness categories                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** The ten approved readiness categories, in reporting order. */
export const READINESS_CATEGORIES = [
  "requirements",
  "database",
  "backend",
  "frontend",
  "security",
  "tests",
  "review",
  "landing",
  "deployment",
  "production",
] as const;

export type ReadinessCategory = (typeof READINESS_CATEGORIES)[number];

/** The approved weighting. Sums to 100. */
export const CATEGORY_WEIGHTS: Record<ReadinessCategory, number> = {
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
};

export const CATEGORY_LABELS: Record<ReadinessCategory, string> = {
  requirements: "Requirements",
  database: "Database",
  backend: "Backend",
  frontend: "Frontend",
  security: "Security",
  tests: "Automated tests",
  review: "Independent review",
  landing: "Commit and merge",
  deployment: "Deployment",
  production: "Production verification",
};

export const CATEGORY_STATES = ["not_applicable", "not_started", "in_progress", "complete", "failed"] as const;

export type CategoryState = (typeof CATEGORY_STATES)[number];

/** Score contributed by each state. `failed` scores zero — it is not partial credit. */
export const CATEGORY_STATE_SCORE: Record<CategoryState, number> = {
  not_applicable: 0, // excluded from the denominator instead
  not_started: 0,
  in_progress: 50,
  complete: 100,
  failed: 0,
};

/**
 * Categories that may NEVER be marked not-applicable.
 *
 * REMEDIATION of hostile-review finding H3: marking review `not_required` and production
 * verification `not_applicable` previously scored 100 for both and produced 91% overall with an
 * empty gates list. Every category below is now mandatory for every work package; declaring one
 * non-applicable is ignored and the category is treated as `not_started`, with a gate recorded.
 */
export const MANDATORY_CATEGORIES: ReadinessCategory[] = [
  "requirements",
  "backend",
  "security",
  "tests",
  "review",
  "landing",
  "deployment",
  "production",
];

/** Categories that may legitimately not apply (a backend-only change has no frontend). */
export const OPTIONAL_CATEGORIES: ReadinessCategory[] = ["database", "frontend"];

/* ------------------------------------------------------------------------------------------ */
/* Risk, classification, blockers                                                               */
/* ------------------------------------------------------------------------------------------ */

export const RISK_LEVELS = ["low", "moderate", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_WEIGHT: Record<RiskLevel, number> = { low: 1, moderate: 2, high: 3, critical: 4 };

export const ISSUE_CLASSES = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type IssueClass = (typeof ISSUE_CLASSES)[number];

export const ISSUE_CLASS_LABELS: Record<IssueClass, string> = {
  A: "Safe local fix",
  B: "Coordinated frontend/backend change",
  C: "Requires staging verification",
  D: "Infrastructure / configuration change",
  E: "Migration",
  F: "External provider dependency",
  G: "Operational action",
  H: "Recommendation only",
};

export const SECURITY_SEVERITIES = ["none", "low", "medium", "high", "critical"] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

export const BLOCKER_KINDS = [
  "awaiting_review",
  "awaiting_hostile_review",
  "awaiting_migration",
  "awaiting_deployment",
  "awaiting_production_verification",
  "failed_tests",
  "security_issue",
  "infrastructure_issue",
  "awaiting_founder_decision",
  "dependency_incomplete",
  "external_provider",
  "other",
] as const;

export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const BLOCKER_KIND_LABELS: Record<BlockerKind, string> = {
  awaiting_review: "Awaiting review",
  awaiting_hostile_review: "Awaiting hostile review",
  awaiting_migration: "Awaiting migration",
  awaiting_deployment: "Awaiting deployment",
  awaiting_production_verification: "Awaiting production verification",
  failed_tests: "Failed tests",
  security_issue: "Security issue",
  infrastructure_issue: "Infrastructure issue",
  awaiting_founder_decision: "Waiting for founder decision",
  dependency_incomplete: "Blocking dependency not finished",
  external_provider: "External provider dependency",
  other: "Other",
};

/** Blockers only the owner can clear. */
export const OWNER_ACTION_BLOCKERS: BlockerKind[] = [
  "awaiting_founder_decision",
  "awaiting_migration",
  "awaiting_deployment",
];

export interface BlockerRecord {
  id?: number | string;
  kind: BlockerKind;
  description: string;
  openedAt: string;
  resolvedAt?: string | null;
  /** Only meaningful for kind === "security_issue"; drives the hard security cap. */
  severity?: SecuritySeverity | null;
}

export function openBlockers(blockers: BlockerRecord[]): BlockerRecord[] {
  return blockers.filter((b) => !b.resolvedAt);
}

/** An unresolved HIGH or CRITICAL security issue — the trigger for the 49% hard cap. */
export function hasUnresolvedHighSecurityIssue(blockers: BlockerRecord[]): boolean {
  return openBlockers(blockers).some((b) => {
    if (b.kind !== "security_issue") return false;
    // Canonicalised so a stray "HIGH" or " high " cannot slip past the 49% cap. Unrecognised
    // severities canonicalise to null and therefore do NOT trigger the cap — but they also never
    // earn credit, because an unknown severity is not a resolved one.
    const severity = canonicalSeverity(b.severity);
    return severity === "high" || severity === "critical";
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Acceptance criteria and required tests                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * An acceptance criterion carried forward from the superseded WIP's per-requirement
 * `acceptanceCriteria` field, which this build originally dropped entirely.
 */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  met: boolean;
  /** Evidence reference proving it — a criterion cannot be `met` without one. */
  evidenceRef?: string | null;
}

/** A named test/gate that must pass before this work package can be considered done. */
export interface RequiredTest {
  id: string;
  name: string;
  /** Evidence kind that satisfies it. */
  kind: EvidenceKind;
}

/* ------------------------------------------------------------------------------------------ */
/* Review, deployment, production                                                               */
/* ------------------------------------------------------------------------------------------ */

export const REVIEW_STATES = [
  "not_required",
  "not_started",
  "in_review",
  "changes_requested",
  "passed",
  "failed",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const DEPLOYMENT_STATES = ["not_deployed", "staging", "production", "rolled_back"] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export const PRODUCTION_VERIFICATIONS = ["not_applicable", "not_verified", "verified", "failed"] as const;
export type ProductionVerification = (typeof PRODUCTION_VERIFICATIONS)[number];

export const ENVIRONMENTS = ["local", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const DEPLOYMENT_RESULTS = ["succeeded", "failed", "rolled_back", "in_progress"] as const;
export type DeploymentResult = (typeof DEPLOYMENT_RESULTS)[number];

export const TEST_RESULTS = ["passed", "failed", "skipped", "not_run"] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export interface DeploymentRecord {
  id?: number | string;
  environment: Environment;
  commitSha: string;
  releaseVersion?: string | null;
  result: DeploymentResult;
  migrationState?: string | null;
  deployedAt: string;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  rollbackOfSha?: string | null;
  notes?: string | null;
}

export interface TestRunRecord {
  id?: number | string;
  packageKey?: string | null;
  kind: EvidenceKind;
  result: TestResult;
  commitSha?: string | null;
  ranAt: string;
  detail?: string | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Work package                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface WorkPackage {
  id: number | string;
  nodeKey: string;
  key: string;
  title: string;
  summary?: string | null;
  status: WorkStatus;
  declaredCompletion: number;
  risk: RiskLevel;
  classification: IssueClass;
  reviewState: ReviewState;
  deploymentState: DeploymentState;
  productionVerification: ProductionVerification;
  businessValue: number;
  engineeringRisk: number;
  estimatedEffortDays?: number | null;
  remainingWork?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  baseCommit?: string | null;
  latestCommit?: string | null;
  prUrl?: string | null;
  /** Optimistic-locking version. Incremented on every update. */
  version: number;
  updatedAt: string;
  evidence: EvidenceRecord[];
  blockers: BlockerRecord[];
  dependsOn: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  requiredTests: RequiredTest[];
  /** Explicit per-category state; anything absent is derived conservatively. */
  categoryStates: Partial<Record<ReadinessCategory, CategoryState>>;
  /** Justification required whenever an optional category is marked not-applicable. */
  categoryNotes?: Partial<Record<ReadinessCategory, string>> | null;
  tags: string[];
}

/* ------------------------------------------------------------------------------------------ */
/* Programme nodes                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface ProgrammeNode {
  id: number | string;
  key: string;
  parentKey: string | null;
  name: string;
  description?: string | null;
  sortOrder: number;
  archived?: boolean;
}

/* ------------------------------------------------------------------------------------------ */
/* Timestamp handling                                                                           */
/* ------------------------------------------------------------------------------------------ */

export type TimestampVerdict = "valid" | "malformed" | "future";

/**
 * Classify a timestamp.
 *
 * REMEDIATION of hostile-review findings M4 and M5: a malformed date was previously reported as
 * "stale — older than 21 days" (a false statement), and a future-dated timestamp counted as
 * permanently fresh. Both are now distinct, named verdicts.
 *
 * A small tolerance absorbs clock skew between the app server and the database.
 */
export const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export function classifyTimestamp(value: string | null | undefined, now: Date): TimestampVerdict {
  if (typeof value !== "string") return "malformed";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "malformed";
  if (parsed > now.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS) return "future";
  return "valid";
}

/**
 * Clamp to 0–100 by FLOORING, never rounding.
 *
 * A 1e-6 epsilon is applied first so that a value which is mathematically exactly 100 but arrives
 * as 99.99999999999999 through floating-point weight redistribution still reads as 100. The
 * epsilon is far smaller than any real difference: 99.5 still floors to 99, and 99.9999 still
 * floors to 99. Only genuine floating-point noise is absorbed.
 */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const denoised = Math.round(n * 1e6) / 1e6;
  return Math.max(0, Math.min(100, Math.floor(denoised)));
}

/**
 * REMEDIATION of hostile-review finding H1.
 *
 * The previous implementation used Math.round, so an aggregate of 99.5 displayed as 100% while
 * a work package was demonstrably incomplete. Flooring guarantees that 100% is only ever shown
 * when the underlying value genuinely reached 100.
 */
export const floorPercent = clampPercent;
