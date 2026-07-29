/**
 * Project Control — Partner Shop Launch view.
 *
 * A dedicated lens on the SAME work packages the main programme tree shows, scoped to the
 * Partner Network branch and displayed in the recorded phase order. It deliberately holds no
 * separate copy of the roadmap: the existing sequence (G5 → G6A → G6B → G6C → G6D →
 * Authentication → Portal → Stripe Credits → Pilot → Public Launch) is preserved because it
 * comes from the same node ordering the rest of the dashboard reads. Change the roadmap in one
 * place and this view follows.
 */
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminShell, Panel, StatCard, Badge, AdminButton, Chip } from "@/components/admin";
import {
  BLOCKER_KIND_LABELS,
  type BlockerKind,
  type NextAction,
  type Readiness,
  type StatusAssessment,
  type WorkPackage,
} from "@shared/project-control";
import {
  confidenceBadgeVariant,
  confidenceLabel,
  describeAction,
  displayPercent,
  relativeTime,
  statusBadgeVariant,
  statusLabel,
} from "./project-control-helpers";

const BASE = "/api/admin/project-control";

type PackageWithAssessment = WorkPackage & { assessment: StatusAssessment };

interface ScopedView {
  generatedAt: string;
  readiness: Readiness;
  phases: {
    key: string;
    name: string;
    description: string;
    packages: PackageWithAssessment[];
    readiness: Readiness;
  }[];
  blockers: {
    packageKey: string;
    packageTitle: string;
    kind: BlockerKind;
    description: string;
    openedAt: string;
  }[];
  nextMilestone: { key: string; name: string } | null;
  nextActions: { highestPriority: NextAction | null; all: NextAction[] };
}

export default function ProjectControlShopLaunchPage() {
  const [, navigate] = useLocation();
  const view = useQuery<ScopedView>({ queryKey: [`${BASE}/views/shop-launch`], refetchInterval: 120_000 });

  if (view.isLoading) {
    return (
      <div className="p-8" style={{ color: "var(--admin-gold, #D4AF37)" }} data-testid="pcsl-loading">
        Loading…
      </div>
    );
  }
  if (view.isError || !view.data) {
    return (
      <div className="p-8" data-testid="pcsl-error">
        Shop Launch view could not load.
      </div>
    );
  }

  const d = view.data;
  // The pilot cannot start until everything before it is verified in production. That is a
  // statement about the recorded readiness, not a separate rule invented here.
  const pilotPhase = d.phases.find((p) => p.key === "pn-pilot");
  const prePilot = d.phases.filter((p) => p.key !== "pn-pilot" && p.key !== "pn-launch");
  const pilotReady = prePilot.length > 0 && prePilot.every((p) => p.readiness.overall >= 100);

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Partner Shop Launch"
      crumb="Programme"
    >
      <div data-testid="pcsl-root">
        <AdminButton variant="ghost" onClick={() => navigate("/admin/project-control")} className="mb-3">
          ← Back to Project Control
        </AdminButton>

        <Panel title="Launch readiness" sub={`Recalculated ${relativeTime(d.generatedAt)}`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
            <StatCard label="Overall" value={displayPercent(d.readiness.overall)} testId="pcsl-overall" />
            <StatCard label="Engineering" value={displayPercent(d.readiness.engineering)} />
            <StatCard label="Review" value={displayPercent(d.readiness.review)} />
            <StatCard label="Deployment" value={displayPercent(d.readiness.deployment)} />
            <StatCard label="Production" value={displayPercent(d.readiness.production)} />
            <StatCard
              label="Pilot readiness"
              value={pilotReady ? "READY" : "NOT READY"}
              foot={
                pilotReady
                  ? "Everything before the pilot is verified in production."
                  : "Earlier phases are not finished."
              }
              testId="pcsl-pilot"
            />
            <StatCard label="Next milestone" value={d.nextMilestone?.name ?? "—"} testId="pcsl-next-milestone" />
          </div>
          {d.readiness.gates.length > 0 && (
            <ul style={{ marginTop: 12, fontSize: 13, opacity: 0.85, paddingLeft: 18 }}>
              {d.readiness.gates.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
        </Panel>

        {d.nextActions.highestPriority && (
          <Panel title="Do this next" className="mt-4">
            <div style={{ fontWeight: 700 }}>{d.nextActions.highestPriority.headline}</div>
            <div style={{ opacity: 0.85, marginTop: 4 }}>{describeAction(d.nextActions.highestPriority)}</div>
          </Panel>
        )}

        <Panel title="Phases" sub="In the recorded launch sequence" className="mt-4">
          <div style={{ display: "grid", gap: 12 }} data-testid="pcsl-phases">
            {d.phases.map((phase, index) => (
              <div
                key={phase.key}
                style={{ border: "1px solid rgba(212,175,55,0.22)", borderRadius: 10, padding: 12 }}
                data-testid={`pcsl-phase-${phase.key}`}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ opacity: 0.5, fontVariantNumeric: "tabular-nums" }}>{index + 1}</span>
                  <strong>{phase.name}</strong>
                  <Badge variant={phase.readiness.overall >= 100 ? "act" : "prog"}>
                    {displayPercent(phase.readiness.overall)}
                  </Badge>
                  <Chip>
                    {phase.packages.length} package{phase.packages.length === 1 ? "" : "s"}
                  </Chip>
                </div>
                <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>{phase.description}</div>

                {phase.packages.map((pkg) => (
                  <div
                    key={pkg.key}
                    style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}
                  >
                    <button
                      type="button"
                      onClick={() => navigate(`/admin/project-control/package/${pkg.key}`)}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        cursor: "pointer",
                        color: "inherit",
                        textAlign: "left",
                      }}
                    >
                      {pkg.title}
                    </button>
                    <Badge variant={statusBadgeVariant(pkg.assessment.effectiveStatus)}>
                      {statusLabel(pkg.assessment.effectiveStatus)}
                    </Badge>
                    <Chip>{displayPercent(pkg.assessment.completion)}</Chip>
                    <Badge variant={confidenceBadgeVariant(pkg.assessment.confidence)}>
                      {confidenceLabel(pkg.assessment.confidence)}
                    </Badge>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Launch blockers" sub={`${d.blockers.length} open`} className="mt-4">
          {d.blockers.length === 0 ? (
            <div style={{ opacity: 0.7 }}>Nothing is blocking the launch programme right now.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }} data-testid="pcsl-blockers">
              {d.blockers.map((b, i) => (
                <div
                  key={`${b.packageKey}-${i}`}
                  style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                >
                  <Badge variant="red">{BLOCKER_KIND_LABELS[b.kind]}</Badge>
                  <button
                    type="button"
                    onClick={() => navigate(`/admin/project-control/package/${b.packageKey}`)}
                    style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit" }}
                  >
                    {b.packageTitle}
                  </button>
                  <span style={{ opacity: 0.85 }}>{b.description}</span>
                  <span style={{ opacity: 0.55, fontSize: 12 }}>opened {relativeTime(b.openedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {pilotPhase && (
          <Panel title="Pilot" sub="First live partner shops" className="mt-4">
            <div data-testid="pcsl-pilot-detail">
              {pilotReady
                ? "Every phase before the pilot is verified in production. The pilot can be scheduled."
                : "The pilot cannot start yet. The phases above must reach production-verified first — that is what the readiness figures are measuring."}
            </div>
          </Panel>
        )}
      </div>
    </AdminShell>
  );
}
