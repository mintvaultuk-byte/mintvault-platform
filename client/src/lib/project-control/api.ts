import { apiRequest } from "@/lib/queryClient";
import type {
  DriftReport,
  NextAction,
  ProgrammeTreeNode,
  QueueResult,
  Readiness,
  StatusAssessment,
  WorkPackage,
} from "@shared/project-control";
import type { GitHubFreshnessVerdict, GitHubSnapshot } from "@shared/project-control-github";

export const PROJECT_CONTROL_API = "/api/admin/project-control";

export type PackageWithAssessment = WorkPackage & { assessment: StatusAssessment };

export interface ProjectControlOverview {
  generatedAt: string;
  tree: ProgrammeTreeNode[];
  packages: PackageWithAssessment[];
  readiness: Readiness;
  nextActions: {
    highestPriority: NextAction | null;
    safestBuild: NextAction | null;
    safestReview: NextAction | null;
    safestMerge: NextAction | null;
    safestDeployment: NextAction | null;
    highestBusinessValue: NextAction | null;
    highestEngineeringRisk: NextAction | null;
    all: NextAction[];
  };
  counts: { nodes: number; packages: number; packagesTotal: number; openBlockers: number };
  deployments: {
    latest: Record<
      string,
      { commitSha: string; releaseVersion?: string | null; deployedAt: string; result: string } | undefined
    >;
  };
  queues: QueueResult[];
  drift: DriftReport;
  treeIntegrity: {
    orphanedPackages: { key: string; nodeKey: string }[];
    orphanedNodes: { key: string; parentKey: string | null; reason: string }[];
    nodeCycles: string[][];
  };
  pagination: { total: number; returned: number; truncated: boolean; limit: number; offset: number };
}

export interface ShopLaunchView {
  generatedAt: string;
  readiness: Readiness;
  phases: {
    key: string;
    name: string;
    description: string;
    sortOrder: number;
    packages: PackageWithAssessment[];
    readiness: Readiness;
  }[];
  blockers: {
    packageKey: string;
    packageTitle: string;
    kind: string;
    description: string;
    openedAt: string;
    severity?: string | null;
  }[];
  nextMilestone: { key: string; name: string } | null;
  nextActions: { highestPriority: NextAction | null; all: NextAction[] };
}

export interface AppEvidence {
  environment: string;
  state: "current" | "unavailable" | "unknown" | "contradictory";
  commit: string | null;
  build: string | null;
  timestamp: string | null;
  observedAt: string;
  reason: string | null;
}

export interface LiveEvidence {
  observedAt: string;
  github: { configured: boolean; snapshot: GitHubSnapshot | null; freshness: GitHubFreshnessVerdict };
  applications: AppEvidence[];
  deployment: {
    mainSha: string | null;
    staging: AppEvidence | null;
    production: AppEvidence | null;
    stagingMatchesMain: boolean | null;
    productionMatchesMain: boolean | null;
    stagingMatchesProduction: boolean | null;
    summary: string;
  } | null;
  featureFlags: unknown[];
}

export interface SyncStatus {
  syncId: string;
  state:
    | "QUEUED"
    | "RUNNING"
    | "SUCCEEDED"
    | "PARTIAL"
    | "FAILED"
    | "RATE_LIMITED"
    | "UNAVAILABLE"
    | "CANCELLED"
    | "EXPIRED";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  activeSyncId: string | null;
  anotherRunActive: boolean;
}

export async function pcGet<T>(path: string): Promise<T> {
  return (await apiRequest("GET", `${PROJECT_CONTROL_API}${path}`)).json() as Promise<T>;
}

export async function startGitHubSync(): Promise<Pick<SyncStatus, "syncId" | "state">> {
  return (await apiRequest("POST", `${PROJECT_CONTROL_API}/sync/github`, {})).json() as Promise<
    Pick<SyncStatus, "syncId" | "state">
  >;
}

export const projectControlQueryKeys = {
  overview: [PROJECT_CONTROL_API, "overview"] as const,
  shopLaunch: [PROJECT_CONTROL_API, "shop-launch"] as const,
  liveEvidence: [PROJECT_CONTROL_API, "live-evidence"] as const,
  github: [PROJECT_CONTROL_API, "github"] as const,
  syncLatest: [PROJECT_CONTROL_API, "sync", "latest"] as const,
  sync: (id: string) => [PROJECT_CONTROL_API, "sync", id] as const,
};
