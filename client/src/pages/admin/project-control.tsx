/**
 * Super Admin Project Control — main dashboard.
 *
 * The single screen that answers: what is built, what is not, what is blocked, what is deployed,
 * what is running in production, and what should be worked on next.
 *
 * This component is a thin renderer. All logic worth asserting lives in ./project-control-helpers
 * (pure, unit-tested) and in @shared/project-control (the status, readiness, next-action and
 * prompt engines, also unit-tested). Nothing on this page can push, merge, deploy, or apply a
 * migration — it records what happened, it does not cause it.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AdminShell, Panel, StatCard, Badge, AdminButton, Chip } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  CATEGORY_LABELS,
  EVIDENCE_CONFIDENCES,
  RISK_LEVELS,
  WORK_STATUSES,
  type EvidenceConfidence,
  type NextAction,
  type ProgrammeTreeNode,
  type Readiness,
  type RiskLevel,
  type DriftReport,
  type QueueResult,
  type StatusAssessment,
  type WorkPackage,
  type WorkStatus,
} from "@shared/project-control";
import {
  EMPTY_FILTER,
  confidenceBadgeVariant,
  confidenceLabel,
  describeAction,
  diagnoseLoadFailure,
  displayPercent,
  explainReadiness,
  isFilterActive,
  overviewQueryString,
  relativeTime,
  riskBadgeVariant,
  statusBadgeVariant,
  statusLabel,
  toggleInList,
  type FilterState,
} from "./project-control-helpers";

const BASE = "/api/admin/project-control";

type PackageWithAssessment = WorkPackage & { assessment: StatusAssessment };

interface Overview {
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

export default function ProjectControlPage() {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [showFilters, setShowFilters] = useState(false);

  const qs = overviewQueryString(filter);
  const overview = useQuery<Overview>({
    queryKey: [`${BASE}/overview${qs}`],
    refetchInterval: 120_000,
    /**
     * DEFECT F-1. The filter is part of the query key, so every keystroke in the search box
     * produced a brand-new key with no cached data. `isLoading` went true, the early return below
     * replaced the whole page with a loading div, and the `<input>` was unmounted — destroying
     * focus and the caret on every character typed.
     *
     * Keeping the previous result while the new one loads means the page never unmounts, so the
     * input keeps focus and the operator keeps their place. `isFetching` drives a subtle busy
     * indicator instead of a full-page swap.
     */
    placeholderData: (previous) => previous,
  });

  // Idempotent: the seed inserts only rows whose key does not already exist, so pressing this
  // twice does nothing the second time and never overwrites an edited status.
  const seed = useMutation({
    mutationFn: async () => (await apiRequest("POST", `${BASE}/seed`, {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`${BASE}/overview${qs}`] }),
  });

  // F-1: only a FIRST load with nothing to show replaces the page. A refetch triggered by typing
  // keeps the previous result on screen, so the search input is never unmounted.
  if (overview.isLoading && !overview.data) {
    return (
      <div className="p-8" data-testid="pc-loading" style={{ color: "var(--admin-gold, #D4AF37)" }}>
        Loading Project Control…
      </div>
    );
  }

  if (!overview.data) {
    const diagnosis = diagnoseLoadFailure(overview.error);
    return (
      <div className="p-8" data-testid={diagnosis.testId}>
        <div
          style={{
            fontWeight: 800,
            marginBottom: 6,
            ...(diagnosis.tone === "error" ? { color: "var(--admin-red, #cd8073)" } : {}),
          }}
        >
          {diagnosis.headline}
        </div>
        <div style={{ opacity: 0.85 }}>{diagnosis.detail}</div>
        {diagnosis.canRetry && (
          <AdminButton variant="ghost" className="mt-3" onClick={() => void overview.refetch()}>
            Try again
          </AdminButton>
        )}
      </div>
    );
  }

  const data = overview.data;
  const empty = data.counts.packagesTotal === 0;

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Project Control"
      crumb="Engineering programme"
    >
      <div data-testid="pc-root">
        {empty && <EmptyState />}

        <DriftBanner drift={data.drift} />
        <TreeIntegrityBanner integrity={data.treeIntegrity} />

        <ReadinessPanel readiness={data.readiness} counts={data.counts} generatedAt={data.generatedAt} />

        <QueuesPanel queues={data.queues} onOpen={(key) => navigate(`/admin/project-control/package/${key}`)} />

        <NextActionsPanel
          summary={data.nextActions}
          onOpen={(key) => navigate(`/admin/project-control/package/${key}`)}
        />

        <Panel
          title="Programme"
          sub="Every MintVault workstream, rolled up"
          className="mt-4"
          actions={
            <>
              <AdminButton variant="ghost" onClick={() => setShowFilters((v) => !v)} data-testid="pc-toggle-filters">
                {showFilters ? "Hide filters" : "Filters & search"}
              </AdminButton>
              <AdminButton
                variant={empty ? "gold" : "ghost"}
                onClick={() => seed.mutate()}
                disabled={seed.isPending}
                data-testid="pc-seed"
              >
                {seed.isPending ? "Seeding…" : "Seed programme tree"}
              </AdminButton>
              <AdminButton variant="ghost" onClick={() => navigate("/admin/project-control/shop-launch")}>
                Shop Launch
              </AdminButton>
              <AdminButton variant="ghost" onClick={() => navigate("/admin/project-control/scanner")}>
                Scanner
              </AdminButton>
            </>
          }
        >
          {showFilters && <Filters filter={filter} setFilter={setFilter} />}
          {data.tree.length === 0 ? (
            <div style={{ opacity: 0.7 }} data-testid="pc-tree-empty">
              Nothing matches the current filters.
            </div>
          ) : (
            <div data-testid="pc-tree">
              {data.tree.map((node) => (
                <TreeNode
                  key={node.key}
                  node={node}
                  depth={0}
                  onOpen={(key) => navigate(`/admin/project-control/package/${key}`)}
                />
              ))}
            </div>
          )}
        </Panel>

        <DeploymentPanel latest={data.deployments.latest} />
        <RepositoryPanel />
      </div>
    </AdminShell>
  );
}

/* ------------------------------------------------------------------------------------------ */

function EmptyState() {
  return (
    <div
      data-testid="pc-empty"
      style={{
        marginBottom: 12,
        background: "var(--admin-gold, #D4AF37)",
        color: "var(--admin-on-gold, #1A1400)",
        padding: "10px 14px",
        borderRadius: 8,
      }}
    >
      No programme data yet. Use <strong>Seed programme tree</strong> below to create the starting MintVault hierarchy.
      Seeding is safe to run more than once — it never overwrites anything you have already edited.
    </div>
  );
}

function ReadinessPanel({
  readiness,
  counts,
  generatedAt,
}: {
  readiness: Readiness;
  counts: Overview["counts"];
  generatedAt: string;
}) {
  const [showCategories, setShowCategories] = useState(false);
  return (
    <Panel
      title="Programme readiness"
      sub={`Recalculated ${relativeTime(generatedAt)}. Weighted across the ten approved categories. 100% is only reachable when every work package has passed review, merged, deployed and been verified in production.`}
      actions={
        <AdminButton variant="ghost" onClick={() => setShowCategories((v) => !v)} data-testid="pc-toggle-categories">
          {showCategories ? "Hide breakdown" : "Show category breakdown"}
        </AdminButton>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        <StatCard
          label="Overall"
          value={displayPercent(readiness.overall)}
          foot={explainReadiness(readiness)}
          testId="pc-readiness-overall"
        />
        <StatCard label="Engineering" value={displayPercent(readiness.engineering)} testId="pc-readiness-engineering" />
        <StatCard label="Review" value={displayPercent(readiness.review)} testId="pc-readiness-review" />
        <StatCard label="Deployment" value={displayPercent(readiness.deployment)} testId="pc-readiness-deployment" />
        <StatCard label="Production" value={displayPercent(readiness.production)} testId="pc-readiness-production" />
        <StatCard label="Work packages" value={counts.packages} mono />
        <StatCard label="Open blockers" value={counts.openBlockers} mono testId="pc-open-blockers" />
      </div>

      {readiness.appliedCaps?.length > 0 && (
        <div
          data-testid="pc-readiness-caps"
          style={{
            marginTop: 12,
            padding: "8px 12px",
            borderRadius: 8,
            background: "var(--admin-red, #cd8073)",
            color: "#fff",
          }}
        >
          <strong>Readiness is capped:</strong>
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            {readiness.appliedCaps.map((c) => (
              <li key={c.reason}>
                No higher than {c.cap}% — {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showCategories && (
        <div style={{ marginTop: 14, display: "grid", gap: 6, fontSize: 13 }} data-testid="pc-categories">
          <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", opacity: 0.6 }}>
            Weighted categories — evidence is measured, not assumed
          </div>
          {readiness.categories.map((c) => (
            <div key={c.category} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ minWidth: 150, fontWeight: 600 }}>{CATEGORY_LABELS[c.category]}</span>
              <Chip>{c.weight}%</Chip>
              <Badge
                variant={
                  c.state === "complete"
                    ? "act"
                    : c.state === "failed"
                      ? "red"
                      : c.state === "in_progress"
                        ? "prog"
                        : "neu"
                }
              >
                {c.state.replace(/_/g, " ").toUpperCase()}
              </Badge>
              <span style={{ opacity: 0.75 }}>{c.reason}</span>
            </div>
          ))}
          <div style={{ opacity: 0.6, marginTop: 4 }}>
            Evidence goes stale after {readiness.staleAfterDays} days; test evidence after{" "}
            {readiness.testStaleAfterDays} days.
          </div>
        </div>
      )}

      {readiness.gates.length > 0 && (
        <ul style={{ marginTop: 12, opacity: 0.85, fontSize: 13, paddingLeft: 18 }} data-testid="pc-readiness-gates">
          {readiness.gates.slice(0, 12).map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function NextActionsPanel({ summary, onOpen }: { summary: Overview["nextActions"]; onOpen: (key: string) => void }) {
  const highlights: { label: string; action: NextAction | null }[] = [
    { label: "Do this next", action: summary.highestPriority },
    { label: "Safest build", action: summary.safestBuild },
    { label: "Safest review", action: summary.safestReview },
    { label: "Safest merge", action: summary.safestMerge },
    { label: "Safest deployment", action: summary.safestDeployment },
    { label: "Highest business value", action: summary.highestBusinessValue },
    { label: "Highest engineering risk", action: summary.highestEngineeringRisk },
  ];

  return (
    <Panel
      title="What to work on next"
      sub="Ranked by value, how close it is to finished, and what it unblocks"
      className="mt-4"
    >
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}
        data-testid="pc-next-actions"
      >
        {highlights.map(({ label, action }) => (
          <div
            key={label}
            style={{ border: "1px solid rgba(212,175,55,0.25)", borderRadius: 10, padding: 12 }}
            data-testid={`pc-next-${label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", opacity: 0.7 }}>{label}</div>
            {action ? (
              <>
                <button
                  type="button"
                  onClick={() => onOpen(action.packageKey)}
                  style={{
                    background: "none",
                    border: 0,
                    padding: 0,
                    textAlign: "left",
                    cursor: "pointer",
                    color: "inherit",
                    fontWeight: 700,
                    marginTop: 4,
                  }}
                >
                  {action.headline}
                </button>
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>{describeAction(action)}</div>
                {action.requiresOwnerApproval && (
                  <Badge variant="gold" className="mt-2">
                    NEEDS YOUR APPROVAL
                  </Badge>
                )}
              </>
            ) : (
              <div style={{ opacity: 0.6, marginTop: 6 }}>Nothing outstanding.</div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * Practical bound on how deep the programme tree is rendered.
 *
 * LOW-RISK HARDENING (third review). `TreeNode` renders recursively, so an unexpectedly deep tree
 * would recurse once per level in React's render stack. The real roadmap is three levels
 * (programme → phase → package), and the server refuses to build a tree deeper than its own
 * guard, so this is a belt-and-braces display limit rather than a load-bearing control: past this
 * depth the branch is shown as a labelled notice instead of being expanded, so the browser degrades
 * to a readable message rather than a blank page.
 */
const MAX_RENDERED_TREE_DEPTH = 50;

function TreeNode({ node, depth, onOpen }: { node: ProgrammeTreeNode; depth: number; onOpen: (key: string) => void }) {
  const [open, setOpen] = useState(depth < 2);
  const r = node.rollup;
  const hasChildren = node.children.length > 0 || node.packages.length > 0;

  return (
    <div
      style={{
        marginLeft: depth * 16,
        borderLeft: depth > 0 ? "1px solid rgba(212,175,55,0.18)" : undefined,
        paddingLeft: depth > 0 ? 12 : 0,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", flexWrap: "wrap" }}
        data-testid={`pc-node-${node.key}`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasChildren}
          style={{
            background: "none",
            border: 0,
            cursor: hasChildren ? "pointer" : "default",
            color: "inherit",
            fontWeight: 800,
            fontSize: 15,
          }}
        >
          {hasChildren ? (open ? "▾" : "▸") : "•"} {node.name}
        </button>
        <Badge variant={r.readiness.overall >= 100 ? "act" : "prog"}>{displayPercent(r.readiness.overall)}</Badge>
        <Chip>
          {r.packageCount} package{r.packageCount === 1 ? "" : "s"}
        </Chip>
        {r.openBlockers > 0 && <Badge variant="red">{r.openBlockers} blocked</Badge>}
        {r.ownerActionRequired && <Badge variant="gold">NEEDS YOU</Badge>}
        <Badge variant={riskBadgeVariant(r.risk)}>{r.risk.toUpperCase()}</Badge>
        <Badge variant={confidenceBadgeVariant(r.worstConfidence)}>{confidenceLabel(r.worstConfidence)}</Badge>
        <span style={{ fontSize: 12, opacity: 0.6 }}>updated {relativeTime(r.lastUpdatedAt)}</span>
      </div>

      {open && (
        <>
          {node.packages.map((pkg) => (
            <PackageRow key={pkg.key} pkg={pkg as PackageWithAssessment} depth={depth + 1} onOpen={onOpen} />
          ))}
          {depth + 1 >= MAX_RENDERED_TREE_DEPTH && node.children.length > 0 ? (
            <div
              data-testid="pc-tree-depth-limit"
              style={{ marginLeft: 16, padding: "8px 0", fontSize: 12, color: "#B8960C" }}
            >
              {node.children.length} deeper level(s) are not shown — this branch is nested more than{" "}
              {MAX_RENDERED_TREE_DEPTH} levels, which the roadmap should never be. Check the programme tree for an
              accidental parent loop.
            </div>
          ) : (
            node.children.map((child) => <TreeNode key={child.key} node={child} depth={depth + 1} onOpen={onOpen} />)
          )}
        </>
      )}
    </div>
  );
}

function PackageRow({
  pkg,
  depth,
  onOpen,
}: {
  pkg: PackageWithAssessment;
  depth: number;
  onOpen: (key: string) => void;
}) {
  const a = pkg.assessment;
  return (
    <div
      style={{
        marginLeft: depth * 16,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
        flexWrap: "wrap",
      }}
      data-testid={`pc-package-${pkg.key}`}
    >
      <button
        type="button"
        onClick={() => onOpen(pkg.key)}
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit", textAlign: "left" }}
      >
        {pkg.title}
      </button>
      <Badge variant={statusBadgeVariant(a?.effectiveStatus ?? pkg.status)}>
        {statusLabel(a?.effectiveStatus ?? pkg.status)}
      </Badge>
      <Chip>{displayPercent(a?.completion ?? 0)}</Chip>
      {a && <Badge variant={confidenceBadgeVariant(a.confidence)}>{confidenceLabel(a.confidence)}</Badge>}
      {pkg.branch && <span style={{ fontSize: 12, opacity: 0.6 }}>{pkg.branch}</span>}
      {a && a.warnings.length > 0 && (
        <Badge variant="red">
          {a.warnings.length} warning{a.warnings.length === 1 ? "" : "s"}
        </Badge>
      )}
    </div>
  );
}

function Filters({ filter, setFilter }: { filter: FilterState; setFilter: (f: FilterState) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }} data-testid="pc-filters">
      <input
        type="search"
        value={filter.search}
        placeholder="Search title, branch, remaining work, blockers…"
        onChange={(e) => setFilter({ ...filter, search: e.target.value })}
        data-testid="pc-filter-search"
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid rgba(212,175,55,0.3)",
          background: "transparent",
          color: "inherit",
        }}
      />
      <FilterGroup
        label="Status"
        options={WORK_STATUSES as readonly WorkStatus[]}
        selected={filter.status}
        render={statusLabel}
        onToggle={(v) => setFilter({ ...filter, status: toggleInList(filter.status, v) })}
      />
      <FilterGroup
        label="Confidence"
        options={EVIDENCE_CONFIDENCES as readonly EvidenceConfidence[]}
        selected={filter.confidence}
        render={confidenceLabel}
        onToggle={(v) => setFilter({ ...filter, confidence: toggleInList(filter.confidence, v) })}
      />
      <FilterGroup
        label="Risk"
        options={RISK_LEVELS as readonly RiskLevel[]}
        selected={filter.risk}
        render={(v) => v.toUpperCase()}
        onToggle={(v) => setFilter({ ...filter, risk: toggleInList(filter.risk, v) })}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <AdminButton
          variant={filter.blockedOnly ? "gold" : "ghost"}
          onClick={() => setFilter({ ...filter, blockedOnly: !filter.blockedOnly })}
          data-testid="pc-filter-blocked"
        >
          Blocked only
        </AdminButton>
        <AdminButton
          variant={filter.ownerActionOnly ? "gold" : "ghost"}
          onClick={() => setFilter({ ...filter, ownerActionOnly: !filter.ownerActionOnly })}
          data-testid="pc-filter-owner"
        >
          Waiting on me
        </AdminButton>
        {isFilterActive(filter) && (
          <AdminButton variant="ghost" onClick={() => setFilter(EMPTY_FILTER)} data-testid="pc-filter-clear">
            Clear
          </AdminButton>
        )}
      </div>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  selected,
  render,
  onToggle,
}: {
  label: string;
  options: readonly T[];
  selected: T[];
  render: (v: T) => string;
  onToggle: (v: T) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", opacity: 0.6, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            style={{
              padding: "3px 9px",
              fontSize: 12,
              borderRadius: 999,
              cursor: "pointer",
              color: selected.includes(o) ? "var(--admin-on-gold, #1A1400)" : "inherit",
              background: selected.includes(o) ? "var(--admin-gold, #D4AF37)" : "transparent",
              border: "1px solid rgba(212,175,55,0.35)",
            }}
          >
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function DeploymentPanel({ latest }: { latest: Overview["deployments"]["latest"] }) {
  const rows = (["production", "staging", "local"] as const).map((env) => ({ env, record: latest[env] }));
  return (
    <Panel
      title="What is running where"
      sub="Recorded deployment history — the dashboard records releases, it never performs them"
      className="mt-4"
    >
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}
        data-testid="pc-deployments"
      >
        {rows.map(({ env, record }) => (
          <StatCard
            key={env}
            label={env.toUpperCase()}
            value={record ? record.commitSha.slice(0, 8) : "—"}
            mono
            foot={
              record
                ? `${record.releaseVersion ?? "no version"} · ${record.result} · ${relativeTime(record.deployedAt)}`
                : "No deployment recorded"
            }
            testId={`pc-deploy-${env}`}
          />
        ))}
      </div>
    </Panel>
  );
}

interface RepoScanResponse {
  scannedAt: string;
  currentBranch: string;
  headCommit: string;
  dirtyFileCount: number;
  mainSha: string | null;
  branches: { name: string; commit: string; subject: string; committedAt: string; mergedIntoMain: boolean }[];
  worktrees: { path: string; branch: string | null; commit: string; detached: boolean }[];
  migrations: { filename: string; number: string; duplicateNumber: boolean }[];
  featureFlags: { name: string; configured: boolean }[];
  warnings: string[];
}

function RepositoryPanel() {
  const scan = useQuery<RepoScanResponse>({ queryKey: [`${BASE}/repository`], refetchInterval: 300_000 });
  const [expanded, setExpanded] = useState(false);

  const unmerged = useMemo(() => (scan.data?.branches ?? []).filter((b) => !b.mergedIntoMain), [scan.data]);
  const duplicates = useMemo(() => (scan.data?.migrations ?? []).filter((m) => m.duplicateNumber), [scan.data]);

  if (!scan.data) return null;

  return (
    <Panel
      title="Repository"
      sub={`Read-only scan, ${relativeTime(scan.data.scannedAt)}`}
      className="mt-4"
      actions={
        <AdminButton variant="ghost" onClick={() => setExpanded((v) => !v)} data-testid="pc-repo-toggle">
          {expanded ? "Hide detail" : "Show detail"}
        </AdminButton>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
        <StatCard label="Branch" value={scan.data.currentBranch} mono />
        <StatCard label="HEAD" value={scan.data.headCommit.slice(0, 8)} mono />
        <StatCard label="main" value={scan.data.mainSha ? scan.data.mainSha.slice(0, 8) : "—"} mono />
        <StatCard label="Uncommitted files" value={scan.data.dirtyFileCount} mono />
        <StatCard label="Unmerged branches" value={unmerged.length} mono testId="pc-repo-unmerged" />
        <StatCard label="Worktrees" value={scan.data.worktrees.length} mono />
        <StatCard label="Migrations" value={scan.data.migrations.length} mono />
      </div>

      {duplicates.length > 0 && (
        <div
          style={{
            marginTop: 12,
            color: "#fff",
            background: "var(--admin-red, #cd8073)",
            padding: "8px 12px",
            borderRadius: 8,
          }}
          data-testid="pc-repo-dupes"
        >
          Duplicate migration numbers found: {duplicates.map((d) => d.filename).join(", ")}. The migration runner
          refuses to run while these exist.
        </div>
      )}

      {scan.data.warnings.map((w) => (
        <div key={w} style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
          {w}
        </div>
      ))}

      {expanded && (
        <div style={{ marginTop: 14, display: "grid", gap: 16 }} data-testid="pc-repo-detail">
          <div>
            <strong>Unmerged branches</strong>
            <ul style={{ paddingLeft: 18, fontSize: 13, opacity: 0.85 }}>
              {unmerged.slice(0, 40).map((b) => (
                <li key={b.name}>
                  {b.name} — {b.commit.slice(0, 8)} — {relativeTime(b.committedAt)}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <strong>Worktrees</strong>
            <ul style={{ paddingLeft: 18, fontSize: 13, opacity: 0.85 }}>
              {scan.data.worktrees.slice(0, 60).map((w) => (
                <li key={w.path}>
                  {w.branch ?? "(detached)"} — {w.path}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <strong>Feature flags</strong>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
              Configured or not only — flag values are never sent to the browser.
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {scan.data.featureFlags.map((f) => (
                <Badge key={f.name} variant={f.configured ? "act" : "neu"}>
                  {f.name}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Drift, integrity and queues — added during remediation                                       */
/* ------------------------------------------------------------------------------------------ */

/** Repository-versus-environment divergence. Critical drift is never collapsed or hidden. */
function DriftBanner({ drift }: { drift: DriftReport }) {
  if (!drift) return null;
  if (drift.severity === "none" || drift.findings.length === 0) {
    // Nothing is wrong — but say plainly what "nothing is wrong" actually means here.
    return (
      <div
        data-testid="pc-drift-none"
        style={{
          marginBottom: 12,
          padding: "8px 12px",
          borderRadius: 8,
          border: "1px solid rgba(212,175,55,0.3)",
          fontSize: 13,
        }}
      >
        <strong>No drift detected between the repository and recorded deployments.</strong>
        <DriftDisclosure disclosure={drift.disclosure} />
      </div>
    );
  }
  const critical = drift.severity === "critical";
  const warning = drift.severity === "warning";
  return (
    <div
      data-testid="pc-drift"
      style={{
        marginBottom: 12,
        padding: "10px 14px",
        borderRadius: 8,
        color: critical ? "#fff" : "var(--admin-on-gold, #1A1400)",
        background: critical ? "var(--admin-red, #cd8073)" : warning ? "var(--admin-gold, #D4AF37)" : "transparent",
        border: critical || warning ? "none" : "1px solid rgba(212,175,55,0.3)",
      }}
    >
      <strong>
        {critical
          ? "The repository and production disagree in a way that matters."
          : warning
            ? "The repository and production have drifted apart."
            : "Repository notes"}
      </strong>
      <ul style={{ paddingLeft: 18, marginTop: 6 }}>
        {drift.findings.map((f) => (
          <li key={f.code + f.message}>{f.message}</li>
        ))}
      </ul>
      <DriftDisclosure disclosure={drift.disclosure} />
    </div>
  );
}

/**
 * What this check does NOT do. Shown wherever drift is shown — including when nothing is wrong,
 * because "no drift detected" is the reading most likely to be mistaken for "production checked".
 */
function DriftDisclosure({ disclosure }: { disclosure: readonly string[] }) {
  return (
    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }} data-testid="pc-drift-disclosure">
      {disclosure.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

/**
 * Work that references a programme node which does not exist, and node cycles. Previously these
 * silently vanished from the tree; they are now stated plainly.
 */
function TreeIntegrityBanner({ integrity }: { integrity: Overview["treeIntegrity"] }) {
  if (!integrity) return null;
  const { orphanedPackages, orphanedNodes, nodeCycles } = integrity;
  if (orphanedPackages.length === 0 && orphanedNodes.length === 0 && nodeCycles.length === 0) return null;
  return (
    <div
      data-testid="pc-tree-integrity"
      style={{
        marginBottom: 12,
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--admin-red, #cd8073)",
        color: "#fff",
      }}
    >
      <strong>Some programme data does not join up.</strong>
      <ul style={{ paddingLeft: 18, marginTop: 6 }}>
        {orphanedPackages.length > 0 && (
          <li>
            {orphanedPackages.length} work package(s) point at a programme node that does not exist. They are shown
            under &ldquo;Unassigned work&rdquo; rather than being hidden.
          </li>
        )}
        {orphanedNodes.map((n) => (
          <li key={n.key}>
            {n.key}: {n.reason}
          </li>
        ))}
        {nodeCycles.map((c) => (
          <li key={c.join(">")}>Programme nodes form a loop: {c.join(" → ")}.</li>
        ))}
      </ul>
    </div>
  );
}

/** The nine approved queues. */
function QueuesPanel({ queues, onOpen }: { queues: QueueResult[]; onOpen: (key: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!queues || queues.length === 0) return null;

  return (
    <Panel title="Queues" sub="The nine standing views. Click a queue to see what is in it." className="mt-4">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-testid="pc-queues">
        {queues.map((q) => (
          <button
            key={q.key}
            type="button"
            onClick={() => setOpen(open === q.key ? null : q.key)}
            title={q.description}
            data-testid={`pc-queue-${q.key}`}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              cursor: "pointer",
              border: "1px solid rgba(212,175,55,0.35)",
              background: open === q.key ? "var(--admin-gold, #D4AF37)" : "transparent",
              color: open === q.key ? "var(--admin-on-gold, #1A1400)" : "inherit",
              fontWeight: q.entries.length > 0 ? 700 : 400,
              opacity: q.entries.length === 0 ? 0.55 : 1,
            }}
          >
            {q.label} <span style={{ fontVariantNumeric: "tabular-nums" }}>({q.entries.length})</span>
          </button>
        ))}
      </div>

      {open && (
        <div style={{ marginTop: 14 }} data-testid={`pc-queue-open-${open}`}>
          {(() => {
            const q = queues.find((x) => x.key === open)!;
            return (
              <>
                <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 8 }}>{q.description}</div>
                {q.entries.length === 0 ? (
                  <div style={{ opacity: 0.7 }}>Nothing in this queue.</div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {q.entries.map((e) => (
                      <div
                        key={e.packageKey}
                        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                      >
                        <button
                          type="button"
                          onClick={() => onOpen(e.packageKey)}
                          style={{
                            background: "none",
                            border: 0,
                            padding: 0,
                            cursor: "pointer",
                            color: "inherit",
                            textAlign: "left",
                            fontWeight: 600,
                          }}
                        >
                          {e.title}
                        </button>
                        <Badge variant={statusBadgeVariant(e.status)}>{statusLabel(e.status)}</Badge>
                        <Chip>{displayPercent(e.completion)}</Chip>
                        <Badge variant={confidenceBadgeVariant(e.confidence)}>{confidenceLabel(e.confidence)}</Badge>
                        {e.requiresOwnerApproval && <Badge variant="gold">NEEDS YOUR APPROVAL</Badge>}
                        <span style={{ fontSize: 12, opacity: 0.75 }}>{e.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </Panel>
  );
}
