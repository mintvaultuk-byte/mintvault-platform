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
  PILOT_GATE_KEY,
  computePilotReadiness,
  launchGateNumber,
  partitionPhases,
} from "@shared/project-control-launch";
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
  /**
   * DEFECT UX-1, fixed.
   *
   * This previously excluded two keys by hand and required everything else to be complete. The
   * permanent G7–G20 backlog is also a child of partner-network and is 0% by design, so it sat
   * inside the gate set and pilot readiness was unconditionally false forever — the card read
   * "NOT READY — Earlier phases are not finished", which was untrue and unfixable.
   *
   * Membership of the launch sequence is an owner decision, so it is declared once in
   * `@shared/project-control-launch` and both the numbering and the gating read from that single
   * declaration. This view holds no copy of the roadmap.
   */
  const { gates, backlog, unrecognised } = partitionPhases(d.phases);
  const pilot = computePilotReadiness(d.phases);
  const pilotPhase = d.phases.find((p) => p.key === PILOT_GATE_KEY);

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
              // UNKNOWN is a real answer, not a styling of NOT READY. It means the declared launch
              // sequence and the actual programme tree have diverged, and a confident verdict
              // either way would be a guess.
              value={pilot.state === "ready" ? "READY" : pilot.state === "blocked" ? "NOT READY" : "UNKNOWN"}
              foot={pilot.reason}
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

        <Panel title="Launch sequence" sub="The ten approved gates, in order" className="mt-4">
          <div style={{ display: "grid", gap: 12 }} data-testid="pcsl-phases">
            {gates.map((phase) => (
              <PhaseCard
                key={phase.key}
                phase={phase}
                // Numbered from the DECLARED sequence, never from array position — that is what
                // let the backlog render as "phase 11".
                number={launchGateNumber(phase.key)}
                blocking={pilot.blockedBy.includes(phase.key)}
                onOpenPackage={(key) => navigate(`/admin/project-control/package/${key}`)}
              />
            ))}
          </div>
        </Panel>

        {backlog.length > 0 && (
          <Panel title="Permanent backlog" sub="Approved future scope — does not gate the pilot" className="mt-4">
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
              This work is planned and not cancelled. It is shown so programme readiness is measured against the real
              scope, but it is deliberately outside the launch sequence and never blocks a milestone.
            </div>
            <div style={{ display: "grid", gap: 12 }} data-testid="pcsl-backlog">
              {backlog.map((phase) => (
                <PhaseCard
                  key={phase.key}
                  phase={phase}
                  number={null}
                  blocking={false}
                  onOpenPackage={(key) => navigate(`/admin/project-control/package/${key}`)}
                />
              ))}
            </div>
          </Panel>
        )}

        {unrecognised.length > 0 && (
          <Panel title="Unrecognised phases" className="mt-4">
            <div data-testid="pcsl-unrecognised" style={{ fontSize: 13 }}>
              The programme tree contains {unrecognised.length} phase(s) that the declared launch sequence does not know
              about ({unrecognised.map((p) => p.key).join(", ")}). Pilot readiness is reported as UNKNOWN until they are
              classified as either a launch gate or permanent backlog — a confident verdict from a tree we do not fully
              recognise would be a guess.
            </div>
          </Panel>
        )}

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
              {pilot.state === "ready" &&
                "Every gate before the pilot is complete. The pilot can be scheduled. The permanent backlog is future scope and does not gate it."}
              {pilot.state === "blocked" &&
                `The pilot cannot start yet — ${pilot.blockedBy.length} gate(s) before it are unfinished: ${pilot.blockedBy.join(", ")}.`}
              {pilot.state === "unknown" && pilot.reason}
            </div>
          </Panel>
        )}
      </div>
    </AdminShell>
  );
}

/**
 * One phase card. Shared by the launch sequence and the permanent backlog so the two cannot drift
 * apart visually — the ONLY differences are the number (backlog has none) and the blocking flag.
 */
function PhaseCard({
  phase,
  number,
  blocking,
  onOpenPackage,
}: {
  phase: ScopedView["phases"][number];
  number: number | null;
  blocking: boolean;
  onOpenPackage: (key: string) => void;
}) {
  return (
    <div
      style={{
        border: blocking ? "1px solid var(--admin-gold)" : "1px solid var(--admin-line-hard, rgba(212,175,55,0.22))",
        borderRadius: "var(--admin-r-sm, 9px)",
        padding: 12,
      }}
      data-testid={`pcsl-phase-${phase.key}`}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {number === null ? (
          <Chip>Backlog</Chip>
        ) : (
          <span style={{ opacity: 0.5, fontVariantNumeric: "tabular-nums" }}>{number}</span>
        )}
        <strong>{phase.name}</strong>
        <Badge variant={phase.readiness.overall >= 100 ? "act" : "prog"}>
          {displayPercent(phase.readiness.overall)}
        </Badge>
        <Chip>
          {phase.packages.length} package{phase.packages.length === 1 ? "" : "s"}
        </Chip>
        {blocking && <Badge variant="wait">Blocking the pilot</Badge>}
      </div>
      <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>{phase.description}</div>

      {phase.packages.map((pkg) => (
        <div key={pkg.key} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => onOpenPackage(pkg.key)}
            style={{
              background: "none",
              border: 0,
              padding: 0,
              cursor: "pointer",
              color: "inherit",
              textAlign: "left",
              textDecoration: "underline",
              textUnderlineOffset: 3,
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
  );
}
