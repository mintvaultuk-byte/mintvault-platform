import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { ProjectControlDashboard } from "@/components/admin/project-control/project-control-dashboard";
import { PackageOperationalHeader } from "@/components/admin/project-control/package-operational-header";
import type {
  LiveEvidence,
  PackageWithAssessment,
  ProjectControlOverview,
  ShopLaunchView,
  SyncStatus,
} from "@/lib/project-control/api";
import type { NextAction, ProgrammeTreeNode, Readiness, StatusAssessment, WorkPackage } from "@shared/project-control";
import { LAUNCH_GATE_KEYS } from "@shared/project-control-launch";
import "@/index.css";
import "@/styles/v2-tokens.css";
import "@/styles/admin-tokens.css";
import "@/styles/project-control.css";

export type ProjectControlFixtureState =
  | "current"
  | "stale"
  | "unavailable"
  | "contradiction"
  | "refreshing"
  | "failed-refresh"
  | "empty"
  | "loading"
  | "expanded-tree"
  | "package"
  | "package-history"
  | "integrity";

const NOW = "2026-08-02T09:00:00.000Z";
const OLD = "2026-08-01T09:00:00.000Z";
const VERY_OLD = "2026-07-31T08:00:00.000Z";

const gateNames: Record<(typeof LAUNCH_GATE_KEYS)[number], string> = {
  "pn-g5": "Partner Management",
  "pn-g6a": "Wallet and immutable ledger",
  "pn-g6b": "Reserve, consume and release credits",
  "pn-g6c": "Super Admin credit management",
  "pn-g6d": "Submission and grading integration",
  "pn-auth": "Authentication, invitations and RBAC",
  "pn-portal": "Partner Portal",
  "pn-stripe-credits": "Credit purchase (Stripe)",
  "pn-pilot": "Pilot with one or two shops",
  "pn-launch": "Pilot fixes and wider opening",
};

function readiness(overall: number, gates: string[] = []): Readiness {
  return {
    rawScore: overall,
    overall,
    categories: [],
    appliedCaps: [],
    gates,
    engineering: Math.min(100, overall + 4),
    review: Math.max(0, overall - 3),
    deployment: Math.max(0, overall - 8),
    production: Math.max(0, overall - 12),
    confidenceMultiplier: 1,
    staleAfterDays: 21,
    testStaleAfterDays: 7,
  };
}

function assessment(overrides: Partial<StatusAssessment> = {}): StatusAssessment {
  return {
    status: "in_progress",
    effectiveStatus: "blocked",
    confidence: "stale",
    confidenceReason: "GitHub and package evidence are present but not all current.",
    completion: 72,
    declaredCompletion: 76,
    completionAnomaly: null,
    openBlockerCount: 1,
    ownerActionRequired: true,
    hasUnresolvedHighSecurity: false,
    warnings: [],
    readiness: readiness(72, ["deployment: staging commit is not aligned with main."]),
    evidenceScope: { applicable: [], rejected: [], shortfalls: [], releaseCommit: "74b6be7b1bd1" },
    ...overrides,
  };
}

function pkg(
  key: string,
  nodeKey: string,
  title: string,
  overrides: Partial<WorkPackage> = {},
  a: StatusAssessment = assessment()
): PackageWithAssessment {
  const base: WorkPackage = {
    id: key,
    nodeKey,
    key,
    title,
    summary: `MintVault ${title.toLowerCase()} for the Partner Shop Launch.`,
    status: a.effectiveStatus,
    declaredCompletion: a.declaredCompletion,
    risk: "high",
    classification: "B",
    reviewState: "in_review",
    deploymentState: "staging",
    productionVerification: "not_verified",
    businessValue: 92,
    engineeringRisk: 78,
    estimatedEffortDays: 2,
    remainingWork: "Resolve live evidence mismatch, rerun CI, and confirm owner acceptance before promotion.",
    branch: `codex/${key}`,
    worktreePath: `/Users/cornelius/mintvault-worktrees/${key}`,
    baseCommit: "372a98f39f23",
    latestCommit: "74b6be7b1bd1",
    prUrl: "https://github.com/mintvault/mintvault-platform/pull/255",
    version: 7,
    updatedAt: NOW,
    evidence: [
      {
        id: `${key}-e1`,
        kind: "vitest",
        supports: true,
        summary: "Project Control focused Vitest suite passed locally.",
        capturedAt: OLD,
        sourceRef: "codex local Project Control rendered UI suite",
        commitSha: "74b6be7b1bd1",
        environment: "staging",
      },
    ],
    blockers: [
      {
        id: `${key}-b1`,
        kind: "other",
        description: "Staging and production commits disagree until the live evidence refresh completes.",
        severity: "high",
        openedAt: OLD,
        resolvedAt: null,
      },
    ],
    dependsOn: ["pc-github-sync"],
    acceptanceCriteria: [
      {
        id: `${key}-a1`,
        text: "Ten launch gates remain visible in declared order.",
        met: true,
        evidenceRef: `${key}-e1`,
      },
      {
        id: `${key}-a2`,
        text: "Unknown evidence is labelled Unknown, never zero.",
        met: true,
        evidenceRef: `${key}-e1`,
      },
    ],
    requiredTests: [{ id: `${key}-t1`, name: "Project Control rendered UI suite", kind: "vitest" }],
    categoryStates: {},
    categoryNotes: null,
    tags: ["project-control", "partner-shop-launch"],
    ...overrides,
  };
  return { ...base, assessment: a };
}

const packages = LAUNCH_GATE_KEYS.map((key, index) => {
  const score = index < 6 ? 100 : key === "pn-pilot" ? 64 : 42;
  const a = assessment({
    effectiveStatus: score >= 100 ? "production_verified" : key === "pn-pilot" ? "blocked" : "in_progress",
    status: score >= 100 ? "production_verified" : "in_progress",
    confidence: score >= 100 ? "verified_by_review" : key === "pn-pilot" ? "stale" : "reported",
    completion: score,
    declaredCompletion: score,
    openBlockerCount: key === "pn-pilot" ? 1 : 0,
    ownerActionRequired: key === "pn-pilot",
    readiness: readiness(score),
  });
  return pkg(`pc-${key}`, key, gateNames[key], { blockers: key === "pn-pilot" ? [] : [] }, a);
});

const backlogPackage = pkg(
  "pc-g7-g20-backlog",
  "pn-backlog",
  "Permanent G7-G20 backlog",
  {
    summary: "Future partner network scale work deliberately outside the pilot gate.",
    remainingWork: "Keep visible for total programme scope; do not include in pilot readiness.",
    blockers: [],
  },
  assessment({
    effectiveStatus: "planned",
    status: "planned",
    confidence: "reported",
    completion: 0,
    readiness: readiness(0),
  })
);

const supersededPackage = pkg(
  "pc-superseded-legacy-flags",
  "pn-g6c",
  "Legacy credit flag override",
  {
    summary: "Superseded by Super Admin credit management.",
    status: "superseded",
    remainingWork: "Replacement is pc-pn-g6c; keep history for audit only.",
    blockers: [],
    tags: ["superseded", "replacement:pc-pn-g6c"],
  },
  assessment({
    effectiveStatus: "superseded",
    status: "superseded",
    confidence: "verified_by_review",
    completion: 0,
    readiness: readiness(0),
    warnings: ["Superseded by pc-pn-g6c; this record is retained as package history."],
  })
);

const allPackages = [...packages, backlogPackage, supersededPackage];

function node(
  key: string,
  name: string,
  children: ProgrammeTreeNode[] = [],
  pkgs: PackageWithAssessment[] = []
): ProgrammeTreeNode {
  return {
    id: key,
    key,
    parentKey: key === "mintvault" ? null : "partner-network",
    name,
    description: `${name} programme node`,
    sortOrder: 1,
    children,
    packages: pkgs,
    rollup: {
      packageCount: pkgs.length,
      readiness: readiness(
        pkgs.length
          ? Math.round(pkgs.reduce((sum, item) => sum + item.assessment.readiness.overall, 0) / pkgs.length)
          : 72
      ),
      risk: pkgs.some((item) => item.risk === "high") ? "high" : "moderate",
      openBlockers: pkgs.flatMap((item) => item.blockers.filter((blocker) => !blocker.resolvedAt)).length,
      ownerActionRequired: pkgs.some((item) => item.assessment.ownerActionRequired),
      worstConfidence: pkgs.some((item) => item.assessment.confidence === "stale") ? "stale" : "verified_by_review",
      lastUpdatedAt: NOW,
      statusCounts: {},
    },
  };
}

const gateNodes = LAUNCH_GATE_KEYS.map((key) =>
  node(
    key,
    gateNames[key],
    [],
    allPackages.filter((item) => item.nodeKey === key)
  )
);
const tree: ProgrammeTreeNode[] = [
  node("mintvault", "MintVault", [
    {
      ...node("partner-network", "Partner Network", [
        ...gateNodes,
        node("pn-backlog", "Permanent G7-G20 backlog", [], [backlogPackage]),
      ]),
      parentKey: "mintvault",
    },
  ]),
];

const nextAction: NextAction = {
  packageKey: "pc-pn-pilot",
  packageTitle: "Pilot with one or two shops",
  nodeKey: "pn-pilot",
  kind: "fix",
  headline: "Resolve pilot evidence drift before inviting the first shop",
  priority: 98,
  riskScore: 92,
  businessValue: 100,
  requiresOwnerApproval: true,
  blockedBy: ["Staging and production commits disagree."],
  reasons: ["Pilot readiness is capped by contradictory deployment evidence."],
  suppressed: ["Deployment is withheld until live evidence is current."],
};

export const projectControlFixtureOverview: ProjectControlOverview = {
  generatedAt: NOW,
  tree,
  packages: allPackages,
  readiness: readiness(78, ["production: production commit is not verified against GitHub main."]),
  nextActions: {
    highestPriority: nextAction,
    safestBuild: nextAction,
    safestReview: nextAction,
    safestMerge: null,
    safestDeployment: null,
    highestBusinessValue: nextAction,
    highestEngineeringRisk: nextAction,
    all: [nextAction],
  },
  counts: { nodes: 13, packages: allPackages.length, packagesTotal: allPackages.length, openBlockers: 1 },
  deployments: { latest: { staging: { commitSha: "74b6be7b1bd1", deployedAt: OLD, result: "ok" } } },
  queues: [],
  drift: {
    severity: "warning",
    findings: [
      {
        severity: "warning",
        code: "staging-production-drift",
        message: "Staging and production commits currently differ.",
      },
    ],
    disclosure: ["Deployment evidence is observed from contracts; CI does not prove deployment."],
    productionEvidenceMissing: false,
    mainSha: "74b6be7b1bd1",
    stagingSha: "74b6be7b1bd1",
    productionSha: "372a98f39f23",
    checkedAt: NOW,
  },
  treeIntegrity: {
    orphanedPackages: [{ key: "pc-orphan-shop-csv", nodeKey: "pn-missing-imports" }],
    orphanedNodes: [{ key: "pn-cycle-a", parentKey: "pn-cycle-b", reason: "Cycle promoted to root for visibility." }],
    nodeCycles: [["pn-cycle-a", "pn-cycle-b", "pn-cycle-a"]],
  },
  pagination: { total: allPackages.length, returned: allPackages.length, truncated: false, limit: 100, offset: 0 },
};

export const projectControlFixtureShopLaunch: ShopLaunchView = {
  generatedAt: NOW,
  readiness: readiness(82),
  phases: [
    ...LAUNCH_GATE_KEYS.map((key) => ({
      key,
      name: gateNames[key],
      description: `${gateNames[key]} gate for Partner Shop Launch.`,
      sortOrder: LAUNCH_GATE_KEYS.indexOf(key),
      packages: allPackages.filter((item) => item.nodeKey === key),
      readiness: readiness(key === "pn-pilot" ? 64 : LAUNCH_GATE_KEYS.indexOf(key) < 6 ? 100 : 58),
    })),
    {
      key: "pn-backlog",
      name: "Permanent G7-G20 backlog",
      description: "Approved future scope rendered separately from the ten pilot gates.",
      sortOrder: 99,
      packages: [backlogPackage],
      readiness: readiness(0),
    },
  ],
  blockers: [
    {
      packageKey: "pc-pn-pilot",
      packageTitle: "Pilot with one or two shops",
      kind: "evidence",
      description: "Staging and production evidence disagree.",
      openedAt: OLD,
      severity: "high",
    },
  ],
  nextMilestone: { key: "pn-pilot", name: "Pilot with one or two shops" },
  nextActions: { highestPriority: nextAction, all: [nextAction] },
};

function liveEvidence(state: ProjectControlFixtureState): LiveEvidence | undefined {
  if (state === "unavailable") return undefined;
  const stale = state === "stale";
  const contradiction = state === "contradiction";
  return {
    observedAt: NOW,
    github: {
      configured: true,
      snapshot: {
        fetchedAt: stale ? VERY_OLD : NOW,
        repository: "mintvault/mintvault-platform",
        defaultBranch: "main",
        defaultBranchSha: "74b6be7b1bd1",
        branches: [
          {
            name: "codex/project-control-live-ui",
            headSha: "74b6be7b1bd1",
            aheadOfDefault: 33,
            behindDefault: 0,
            lastCommitAt: NOW,
          },
        ],
        pullRequests: [
          {
            number: 255,
            title: "Project Control live UI",
            state: "open",
            headRef: "codex/project-control-live-ui",
            baseRef: "main",
            headSha: "74b6be7b1bd1",
            mergedAt: null,
            updatedAt: NOW,
            changedFiles: [],
          },
        ],
        workflowRuns: [
          {
            name: "Project Control UI proof",
            headSha: "74b6be7b1bd1",
            headBranch: "codex/project-control-live-ui",
            conclusion: contradiction ? "failure" : "success",
            runStartedAt: NOW,
            url: null,
          },
        ],
        releaseTags: ["pc-ui-gate-3"],
        warnings: stale ? ["GitHub snapshot is past the freshness window."] : [],
      },
      freshness: stale
        ? {
            freshness: "stale",
            reason: "GitHub was last read 1500 minute(s) ago; this view may be out of date.",
            ageMs: 90_000_000,
          }
        : { freshness: "fresh", reason: "GitHub was read 0 second(s) ago.", ageMs: 0 },
    },
    applications: [
      {
        environment: "staging",
        state: contradiction ? "contradictory" : "current",
        commit: "74b6be7b1bd1",
        build: "staging-20260802",
        timestamp: NOW,
        observedAt: NOW,
        reason: null,
      },
      {
        environment: "production",
        state: contradiction ? "contradictory" : "current",
        commit: contradiction ? "372a98f39f23" : "74b6be7b1bd1",
        build: "prod-20260802",
        timestamp: NOW,
        observedAt: NOW,
        reason: contradiction ? "Production is behind staging." : null,
      },
    ],
    deployment: {
      mainSha: "74b6be7b1bd1",
      staging: {
        environment: "staging",
        state: "current",
        commit: "74b6be7b1bd1",
        build: "staging-20260802",
        timestamp: NOW,
        observedAt: NOW,
        reason: null,
      },
      production: {
        environment: "production",
        state: contradiction ? "contradictory" : "current",
        commit: contradiction ? "372a98f39f23" : "74b6be7b1bd1",
        build: "prod-20260802",
        timestamp: NOW,
        observedAt: NOW,
        reason: null,
      },
      stagingMatchesMain: true,
      productionMatchesMain: contradiction ? false : true,
      stagingMatchesProduction: contradiction ? false : true,
      summary: contradiction
        ? "Production is 33 commits behind the Project Control UI branch."
        : "Staging and production match GitHub main.",
    },
    featureFlags: [{ key: "partner_portal_enabled", enabled: true }],
  };
}

function sync(state: ProjectControlFixtureState): SyncStatus | null {
  if (state === "refreshing")
    return {
      syncId: "fixture-running",
      state: "RUNNING",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      errorCode: null,
      activeSyncId: null,
      anotherRunActive: false,
    };
  if (state === "failed-refresh")
    return {
      syncId: "fixture-failed",
      state: "FAILED",
      requestedAt: OLD,
      startedAt: OLD,
      completedAt: NOW,
      errorCode: "SYNC_STATUS_UNAVAILABLE",
      activeSyncId: null,
      anotherRunActive: false,
    };
  return {
    syncId: "fixture-succeeded",
    state: "SUCCEEDED",
    requestedAt: OLD,
    startedAt: OLD,
    completedAt: NOW,
    errorCode: null,
    activeSyncId: null,
    anotherRunActive: false,
  };
}

export function ProjectControlVisualFixture({ state = "current" }: { state?: ProjectControlFixtureState }) {
  const [opened, setOpened] = useState<string | null>(null);
  const overview =
    state === "empty"
      ? {
          ...projectControlFixtureOverview,
          counts: { nodes: 0, packages: 0, packagesTotal: 0, openBlockers: 0 },
          packages: [],
        }
      : projectControlFixtureOverview;
  const evidence = liveEvidence(state);

  if (state === "loading") {
    return (
      <main className="admin-root pc-fixture-shell" data-fixture-state={state}>
        <div data-testid="pc-loading" role="status" aria-live="polite" className="pc-fixture-loading">
          Loading Project Control with retained evidence from the last successful refresh…
        </div>
        <ProjectControlDashboard
          overview={projectControlFixtureOverview}
          shopLaunch={projectControlFixtureShopLaunch}
          liveEvidence={liveEvidence("current")}
          evidenceUnavailable={false}
          sync={sync("refreshing")}
          onOpenPackage={setOpened}
          onRefresh={() => undefined}
          refreshing
        />
      </main>
    );
  }

  return (
    <main className="admin-root pc-fixture-shell" data-fixture-state={state}>
      <h1>Project Control visual fixture</h1>
      {state === "empty" ? (
        <section className="pc-fixture-empty" data-testid="pc-empty-state">
          <h2>No programme data yet</h2>
          <p>This is an empty programme state, not a zero readiness score.</p>
        </section>
      ) : (
        <ProjectControlDashboard
          overview={overview}
          shopLaunch={projectControlFixtureShopLaunch}
          liveEvidence={evidence}
          evidenceUnavailable={state === "unavailable"}
          sync={sync(state)}
          onOpenPackage={setOpened}
          onRefresh={() => undefined}
          refreshing={state === "refreshing"}
        />
      )}
      {(state === "package" || state === "package-history") && (
        <FixturePanel
          title={state === "package-history" ? "Package evidence and history" : "Package detail above the fold"}
        >
          <PackageOperationalHeader
            pkg={packages[8]}
            assessment={packages[8].assessment}
            readiness={packages[8].assessment.readiness}
            nextAction={nextAction}
          />
          <section data-testid="pcp-evidence-history">
            <h2>Evidence history</h2>
            <p>Superseded package retained: {supersededPackage.title}. Replacement relationship: pc-pn-g6c.</p>
            <p>Audit pagination: 2 visible of 2 fixture events.</p>
          </section>
        </FixturePanel>
      )}
      {state === "integrity" && (
        <FixturePanel title="Integrity warnings">
          <p data-testid="pc-orphan-warning">Orphan warning: pc-orphan-shop-csv references pn-missing-imports.</p>
          <p data-testid="pc-cycle-warning">
            Cycle warning: pn-cycle-a {"->"} pn-cycle-b {"->"} pn-cycle-a.
          </p>
        </FixturePanel>
      )}
      {opened && <p data-testid="pc-opened-package">Opened package {opened}</p>}
    </main>
  );
}

function FixturePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pc-section pc-fixture-detail">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function fixtureStateFromLocation(value: string | null): ProjectControlFixtureState {
  const state = String(value ?? "current");
  const allowed: ProjectControlFixtureState[] = [
    "current",
    "stale",
    "unavailable",
    "contradiction",
    "refreshing",
    "failed-refresh",
    "empty",
    "loading",
    "expanded-tree",
    "package",
    "package-history",
    "integrity",
  ];
  return allowed.includes(state as ProjectControlFixtureState) ? (state as ProjectControlFixtureState) : "current";
}

export function mountProjectControlVisualFixture(root: HTMLElement, state: ProjectControlFixtureState) {
  createRoot(root).render(
    <StrictMode>
      <ProjectControlVisualFixture state={state} />
    </StrictMode>
  );
}
