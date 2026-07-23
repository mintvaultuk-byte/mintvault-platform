export type EvidenceClassification =
  | "Locked Founder Requirement"
  | "Proven from repository"
  | "Proven from production"
  | "Proven from database"
  | "Proven by tests"
  | "Proven by human review"
  | "Reported but Unverified"
  | "Assumption"
  | "Future Roadmap"
  | "Open Question"
  | "Unknown"
  | "Stale Evidence"
  | "Contradiction"
  | "Superseded Decision";

export type LifecycleState =
  | "not started"
  | "proposed"
  | "in progress"
  | "implemented"
  | "test evidence missing"
  | "tests failing"
  | "review pending"
  | "review failed"
  | "review passed"
  | "deployment pending"
  | "deployed"
  | "production verification pending"
  | "production verified"
  | "blocked"
  | "stale"
  | "unknown"
  | "superseded";

export interface ProjectRequirement {
  id: string;
  description: string;
  rationale: string;
  acceptanceCriteria: string;
  evidenceClassification: EvidenceClassification;
  lifecycleState: LifecycleState;
  relatedComponents: string[];
  testsRequired: string;
  sourceDocument: string;
  /** Optional requirements are reported separately and never inflate mandatory readiness. */
  optional?: boolean;
}

export interface ProjectEvidence {
  evidenceId: string;
  requirementIds: string[];
  evidenceClassification: EvidenceClassification;
  lifecycleState: LifecycleState;
  sourceKind: "repository" | "production" | "database" | "test" | "review" | "founder" | "governance";
  sourceLocator: string;
  sourceTimestamp: string;
  summary: string;
  staleAfter?: string;
  confidenceImpact: number;
  payload?: Record<string, unknown>;
}

export interface RequirementStatus {
  requirementId: string;
  lifecycleState: LifecycleState;
  readinessPercent: number;
  confidencePercent: number;
  evidenceIds: string[];
  reason: string;
  stale: boolean;
  blocked: boolean;
  optional: boolean;
}

export interface ProjectControlSummary {
  generatedAt: string;
  baselineVersion: "MEGS v1.1";
  readOnly: true;
  featureFlag: "super_admin_project_control_enabled";
  totals: {
    requirements: number;
    evidenceItems: number;
    blocked: number;
    unknown: number;
    stale: number;
    contradictions: number;
    optional: number;
  };
  readiness: {
    overallPercent: number;
    confidencePercent: number;
    numerator: number;
    denominator: number;
    formula: string;
  };
  repository: Record<string, unknown>;
  production: Record<string, unknown>;
  recommendations: ProjectRecommendation[];
}

export interface ProjectRecommendation {
  id: string;
  priority: "blocker" | "high" | "medium" | "low";
  requirementIds: string[];
  summary: string;
  rationale: string;
  evidenceIds: string[];
}
