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

/**
 * Refresh EVERY evidence source, not only GitHub.
 *
 * The dashboard used to get application, database and flag evidence as a side effect of polling
 * `/live-evidence`, which probed them inline on every page load. Removing that poll — the whole
 * point of the cutover — left nothing to populate them: the client could only ever start a GitHub
 * sync, so `/composed-overview` would have reported applications, databases and flags as UNKNOWN
 * for ever and the new dashboard would have looked broken on first use.
 *
 * GitHub is the only DURABLE, long-running sync with a run id worth polling; the other three are
 * short server-side probes. They are started alongside and deliberately not awaited for the
 * caller's progress state — but a failure in one must not abort the others, hence allSettled.
 * Each records its own run, so a failure is visible in the evidence log rather than silent.
 */
export async function startEvidenceRefresh(): Promise<Pick<SyncStatus, "syncId" | "state">> {
  const github = await startGitHubSync();
  await Promise.allSettled([
    apiRequest("POST", `${PROJECT_CONTROL_API}/sync/applications`, {}),
    apiRequest("POST", `${PROJECT_CONTROL_API}/sync/flags`, {}),
    apiRequest("POST", `${PROJECT_CONTROL_API}/sync/databases`, {}),
  ]);
  return github;
}

export const projectControlQueryKeys = {
  overview: [PROJECT_CONTROL_API, "overview"] as const,
  shopLaunch: [PROJECT_CONTROL_API, "shop-launch"] as const,
  /**
   * The stored composed evidence. Replaces `liveEvidence` as the dashboard's evidence source.
   *
   * `/live-evidence` is `gatedExpensive` and fans out to the GitHub API and BOTH Fly applications
   * on every call. Polling it every 120 seconds meant merely leaving the dashboard open spent
   * GitHub quota and sent live HTTPS probes to production — and because the GitHub snapshot cache
   * TTL is 60s, a 120s poll missed the cache every single time. `/composed-overview` reads
   * persisted snapshots only and is registered under the ordinary read gate.
   */
  composedOverview: [PROJECT_CONTROL_API, "composed-overview"] as const,
  github: [PROJECT_CONTROL_API, "github"] as const,
  syncLatest: [PROJECT_CONTROL_API, "sync", "latest"] as const,
  sync: (id: string) => [PROJECT_CONTROL_API, "sync", id] as const,
};
