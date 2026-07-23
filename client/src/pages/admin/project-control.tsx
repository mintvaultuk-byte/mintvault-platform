import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Copy, Database, GitBranch, ShieldCheck, TimerReset } from "lucide-react";
import { AdminShell, AdminButton, Badge, Panel, StatCard, Chip } from "@/components/admin";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";

const BASE = "/api/super-admin/project-control";

type LifecycleState =
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

interface Summary {
  generatedAt: string;
  baselineVersion: string;
  readOnly: true;
  featureFlag: string;
  totals: {
    requirements: number;
    evidenceItems: number;
    blocked: number;
    unknown: number;
    stale: number;
    contradictions: number;
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
  recommendations: Recommendation[];
}

interface Requirement {
  id: string;
  description: string;
  rationale: string;
  acceptanceCriteria: string;
  evidenceClassification: string;
  lifecycleState: LifecycleState;
  relatedComponents: string[];
  testsRequired: string;
}

interface RequirementStatus {
  requirementId: string;
  lifecycleState: LifecycleState;
  readinessPercent: number;
  confidencePercent: number;
  evidenceIds: string[];
  reason: string;
  stale: boolean;
  blocked: boolean;
}

interface Evidence {
  evidenceId: string;
  requirementIds: string[];
  evidenceClassification: string;
  lifecycleState: LifecycleState;
  sourceKind: string;
  sourceLocator: string;
  sourceTimestamp: string;
  summary: string;
  staleAfter?: string;
}

interface Recommendation {
  id: string;
  priority: "blocker" | "high" | "medium" | "low";
  requirementIds: string[];
  summary: string;
  rationale: string;
  evidenceIds: string[];
}

interface RequirementsResponse {
  requirements: Requirement[];
  statuses: RequirementStatus[];
}

interface EvidenceResponse {
  evidence: Evidence[];
}

interface PromptResponse {
  snapshotId: string;
  promptText: string;
  sourceEvidenceIds: string[];
}

function badgeForState(state: LifecycleState, blocked?: boolean): "red" | "wait" | "prog" | "gold" | "act" | "neu" {
  if (blocked || state === "blocked" || state === "tests failing" || state === "review failed") return "red";
  if (state === "unknown" || state === "not started" || state === "stale") return "wait";
  if (state === "in progress" || state === "implemented" || state === "test evidence missing" || state === "review pending") {
    return "prog";
  }
  if (state === "production verified" || state === "review passed") return "act";
  if (state === "deployed" || state === "deployment pending" || state === "production verification pending") return "gold";
  return "neu";
}

function pct(value: unknown): string {
  return typeof value === "number" ? `${value}%` : "0%";
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export default function AdminProjectControlPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [filter, setFilter] = useState<"all" | "blocked" | "stale" | "pcd" | "unknown">("all");
  const [selectedRequirementId, setSelectedRequirementId] = useState<string | null>(null);

  const summary = useQuery<Summary>({ queryKey: [`${BASE}/summary`], refetchInterval: 60000 });
  const requirements = useQuery<RequirementsResponse>({ queryKey: [`${BASE}/requirements`], refetchInterval: 60000 });
  const evidence = useQuery<EvidenceResponse>({ queryKey: [`${BASE}/evidence`], refetchInterval: 60000 });
  const prompt = useQuery<PromptResponse>({ queryKey: [`${BASE}/continuation-prompt`], refetchInterval: 60000 });

  const statusByRequirement = useMemo(() => {
    return new Map((requirements.data?.statuses ?? []).map((status) => [status.requirementId, status]));
  }, [requirements.data?.statuses]);

  const evidenceByRequirement = useMemo(() => {
    const map = new Map<string, Evidence[]>();
    for (const item of evidence.data?.evidence ?? []) {
      for (const requirementId of item.requirementIds) {
        map.set(requirementId, [...(map.get(requirementId) ?? []), item]);
      }
    }
    return map;
  }, [evidence.data?.evidence]);

  const filteredRequirements = useMemo(() => {
    const rows = requirements.data?.requirements ?? [];
    return rows.filter((req) => {
      const status = statusByRequirement.get(req.id);
      if (filter === "blocked") return status?.blocked;
      if (filter === "stale") return status?.stale;
      if (filter === "pcd") return req.id.startsWith("MEGS-PCD-");
      if (filter === "unknown") return status?.lifecycleState === "unknown" || req.lifecycleState === "unknown";
      return true;
    });
  }, [filter, requirements.data?.requirements, statusByRequirement]);

  const selectedRequirement = useMemo(() => {
    const fallback = filteredRequirements[0]?.id ?? null;
    const id = selectedRequirementId ?? fallback;
    return requirements.data?.requirements.find((item) => item.id === id) ?? null;
  }, [filteredRequirements, requirements.data?.requirements, selectedRequirementId]);

  const apiError = (summary.error as any)?.message || (requirements.error as any)?.message || (evidence.error as any)?.message;

  if (apiError) {
    return (
      <AdminShell activeTab="dashboard" onTabChange={() => navigate("/admin")} onLogout={() => navigate("/admin")}>
        <Panel title="Project Control unavailable" sub="MEGS-PCD-006 fail-closed feature flag or Super Admin authorization blocked access.">
          <div className="flex items-start gap-3 rounded border border-red-900 bg-red-950/30 p-4 text-sm text-red-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <div className="font-semibold">Access denied or unavailable</div>
              <div className="mt-1 text-red-200">{apiError}</div>
            </div>
          </div>
        </Panel>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Project Control"
      crumb="MINTVAULT · GOVERNANCE"
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Readiness" value={pct(summary.data?.readiness.overallPercent)} foot={summary.data?.readiness.formula} />
          <StatCard label="Confidence" value={pct(summary.data?.readiness.confidencePercent)} foot="Reduced by stale or contradictory evidence" />
          <StatCard label="Requirements" value={summary.data?.totals.requirements ?? "—"} foot={`${summary.data?.totals.evidenceItems ?? 0} evidence items`} />
          <StatCard label="Blocked" value={summary.data?.totals.blocked ?? "—"} foot={`${summary.data?.totals.unknown ?? 0} unknown · ${summary.data?.totals.stale ?? 0} stale`} />
        </div>

        <Panel
          title="Evidence Snapshot"
          sub={`Generated ${summary.data?.generatedAt ?? "loading"} · ${summary.data?.baselineVersion ?? "MEGS v1.1"} · read-only`}
          actions={
            <Badge variant="gold">
              <ShieldCheck className="mr-1 inline h-3 w-3" /> {summary.data?.featureFlag ?? "super_admin_project_control_enabled"}
            </Badge>
          }
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded border border-[var(--admin-border)] p-3 text-sm">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <GitBranch className="h-4 w-4 text-[var(--admin-gold)]" /> Repository
              </div>
              <div className="font-mono text-xs text-[var(--admin-muted)]">
                {String(summary.data?.repository.branch ?? "unknown")}
                <br />
                {String(summary.data?.repository.head ?? "unknown").slice(0, 12)}
                <br />
                migration {String(summary.data?.repository.migrationHead ?? "unknown")}
              </div>
            </div>
            <div className="rounded border border-[var(--admin-border)] p-3 text-sm">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <Database className="h-4 w-4 text-[var(--admin-gold)]" /> Production Evidence
              </div>
              <div className="font-mono text-xs text-[var(--admin-muted)]">
                prod {String((summary.data?.production.production as any)?.commit ?? "unknown")}
                <br />
                stage {String((summary.data?.production.staging as any)?.commit ?? "unknown")}
              </div>
            </div>
            <div className="rounded border border-[var(--admin-border)] p-3 text-sm">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <TimerReset className="h-4 w-4 text-[var(--admin-gold)]" /> Content-addressed Prompt
              </div>
              <div className="mb-2 font-mono text-xs text-[var(--admin-muted)]">{prompt.data?.snapshotId ?? "loading"}</div>
              <AdminButton
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (!prompt.data?.promptText) return;
                  copyText(prompt.data.promptText).then(() => toast({ title: "Prompt copied" }));
                }}
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </AdminButton>
            </div>
          </div>
        </Panel>

        <div className="flex flex-wrap gap-2">
          <Chip active={filter === "all"} onClick={() => setFilter("all")} count={requirements.data?.requirements.length ?? 0}>
            All
          </Chip>
          <Chip active={filter === "blocked"} onClick={() => setFilter("blocked")} count={summary.data?.totals.blocked ?? 0}>
            Blocked
          </Chip>
          <Chip active={filter === "unknown"} onClick={() => setFilter("unknown")} count={summary.data?.totals.unknown ?? 0}>
            Unknown
          </Chip>
          <Chip active={filter === "stale"} onClick={() => setFilter("stale")} count={summary.data?.totals.stale ?? 0}>
            Stale
          </Chip>
          <Chip active={filter === "pcd"} onClick={() => setFilter("pcd")}>
            Project Control
          </Chip>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
          <Panel title="Requirements" sub="Lifecycle and readiness are evidence-derived.">
            <div className="max-h-[680px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-[var(--admin-panel)] text-xs uppercase text-[var(--admin-muted)]">
                  <tr>
                    <th className="p-2">ID</th>
                    <th className="p-2">State</th>
                    <th className="p-2">Ready</th>
                    <th className="p-2">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRequirements.map((req) => {
                    const status = statusByRequirement.get(req.id);
                    const active = selectedRequirement?.id === req.id;
                    return (
                      <tr
                        key={req.id}
                        className={`cursor-pointer border-t border-[var(--admin-border)] ${active ? "bg-[var(--admin-gold)]/10" : ""}`}
                        onClick={() => setSelectedRequirementId(req.id)}
                      >
                        <td className="p-2 font-mono text-xs">{req.id}</td>
                        <td className="p-2">
                          <Badge variant={badgeForState(status?.lifecycleState ?? req.lifecycleState, status?.blocked)}>
                            {status?.lifecycleState ?? req.lifecycleState}
                          </Badge>
                        </td>
                        <td className="p-2 font-mono text-xs">{status?.readinessPercent ?? 0}%</td>
                        <td className="p-2 font-mono text-xs">{status?.confidencePercent ?? 0}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="space-y-4">
            <Panel title={selectedRequirement?.id ?? "Requirement"} sub={selectedRequirement?.evidenceClassification ?? "Select a requirement"}>
              {selectedRequirement && (
                <div className="space-y-3 text-sm">
                  <p>{selectedRequirement.description}</p>
                  <div className="rounded border border-[var(--admin-border)] p-3">
                    <div className="text-xs uppercase text-[var(--admin-muted)]">Acceptance</div>
                    <div>{selectedRequirement.acceptanceCriteria}</div>
                  </div>
                  <div className="rounded border border-[var(--admin-border)] p-3">
                    <div className="text-xs uppercase text-[var(--admin-muted)]">Tests Required</div>
                    <div>{selectedRequirement.testsRequired}</div>
                  </div>
                  <div className="text-xs text-[var(--admin-muted)]">
                    {statusByRequirement.get(selectedRequirement.id)?.reason ?? "No status evidence loaded."}
                  </div>
                </div>
              )}
            </Panel>

            <Panel title="Related Evidence" sub="Timestamped evidence only; static evidence is not a passing test claim.">
              <div className="space-y-2">
                {(selectedRequirement ? evidenceByRequirement.get(selectedRequirement.id) ?? [] : []).map((item) => (
                  <div key={item.evidenceId} className="rounded border border-[var(--admin-border)] p-3 text-sm">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge variant={badgeForState(item.lifecycleState)}>{item.lifecycleState}</Badge>
                      <span className="font-mono text-xs text-[var(--admin-muted)]">{item.evidenceId}</span>
                    </div>
                    <div>{item.summary}</div>
                    <div className="mt-1 font-mono text-xs text-[var(--admin-muted)]">
                      {item.sourceKind} · {item.sourceLocator}
                    </div>
                  </div>
                ))}
                {selectedRequirement && (evidenceByRequirement.get(selectedRequirement.id) ?? []).length === 0 && (
                  <div className="rounded border border-[var(--admin-border)] p-3 text-sm text-[var(--admin-muted)]">
                    No direct evidence ingested for this requirement.
                  </div>
                )}
              </div>
            </Panel>
          </div>
        </div>

        <Panel title="Recommendations" sub="Every recommendation retains requirement and evidence provenance.">
          <div className="grid gap-3 md:grid-cols-2">
            {(summary.data?.recommendations ?? []).map((rec) => (
              <div key={rec.id} className="rounded border border-[var(--admin-border)] p-3 text-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Badge variant={rec.priority === "blocker" || rec.priority === "high" ? "red" : "wait"}>{rec.priority}</Badge>
                  <span className="font-mono text-xs text-[var(--admin-muted)]">{rec.requirementIds.length} reqs</span>
                </div>
                <div className="font-semibold">{rec.summary}</div>
                <div className="mt-1 text-[var(--admin-muted)]">{rec.rationale}</div>
                <div className="mt-2 font-mono text-[11px] text-[var(--admin-muted)]">{rec.requirementIds.join(", ")}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </AdminShell>
  );
}
