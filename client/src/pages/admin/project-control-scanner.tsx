/**
 * Project Control — Scanner view.
 *
 * Scanner pipeline state, reliability, known issues (including the crop defect), repair status,
 * and verification. Same data source as the main tree, scoped to the Scanner branch — no second
 * copy of the truth.
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
  riskBadgeVariant,
  statusBadgeVariant,
  statusLabel,
} from "./project-control-helpers";

const BASE = "/api/admin/project-control";

type PackageWithAssessment = WorkPackage & { assessment: StatusAssessment };

interface ScannerView {
  generatedAt: string;
  readiness: Readiness;
  packages: PackageWithAssessment[];
  blockers: { packageKey: string; packageTitle: string; kind: BlockerKind; description: string; openedAt: string }[];
  nextActions: { highestPriority: NextAction | null; all: NextAction[] };
}

export default function ProjectControlScannerPage() {
  const [, navigate] = useLocation();
  const view = useQuery<ScannerView>({ queryKey: [`${BASE}/views/scanner`], refetchInterval: 120_000 });

  if (view.isLoading) {
    return (
      <div className="p-8" style={{ color: "var(--admin-gold, #D4AF37)" }} data-testid="pcsc-loading">
        Loading…
      </div>
    );
  }
  if (view.isError || !view.data) {
    return (
      <div className="p-8" data-testid="pcsc-error">
        Scanner view could not load.
      </div>
    );
  }

  const d = view.data;

  // "Reliability" here is deliberately evidence-based rather than a made-up score: it is the
  // share of scanner work packages whose status is backed by verified (not merely reported)
  // evidence. A pipeline nobody has checked recently does not read as reliable.
  const verified = d.packages.filter(
    (p) => p.assessment.confidence === "automatically_verified" || p.assessment.confidence === "verified_by_review"
  ).length;
  const reliability = d.packages.length === 0 ? 0 : (verified / d.packages.length) * 100;

  const unresolvedIssues = d.packages.filter(
    (p) => p.assessment.effectiveStatus !== "production_verified" && p.assessment.effectiveStatus !== "superseded"
  );

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Scanner"
      crumb="Pipeline"
    >
      <div data-testid="pcsc-root">
        <AdminButton variant="ghost" onClick={() => navigate("/admin/project-control")} className="mb-3">
          ← Back to Project Control
        </AdminButton>

        <Panel title="Pipeline state" sub={`Recalculated ${relativeTime(d.generatedAt)}`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
            <StatCard label="Overall readiness" value={displayPercent(d.readiness.overall)} testId="pcsc-overall" />
            <StatCard label="Production verified" value={displayPercent(d.readiness.production)} />
            <StatCard
              label="Evidence-backed"
              value={displayPercent(reliability)}
              foot="Share of scanner work whose status is verified, not just reported"
              testId="pcsc-reliability"
            />
            <StatCard label="Open issues" value={unresolvedIssues.length} mono testId="pcsc-open-issues" />
            <StatCard label="Blockers" value={d.blockers.length} mono />
          </div>
        </Panel>

        {d.nextActions.highestPriority && (
          <Panel title="Do this next" className="mt-4">
            <div style={{ fontWeight: 700 }}>{d.nextActions.highestPriority.headline}</div>
            <div style={{ opacity: 0.85, marginTop: 4 }}>{describeAction(d.nextActions.highestPriority)}</div>
          </Panel>
        )}

        <Panel title="Known issues and repair status" className="mt-4">
          {unresolvedIssues.length === 0 ? (
            <div style={{ opacity: 0.7 }}>Nothing outstanding on the scanner pipeline.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }} data-testid="pcsc-issues">
              {unresolvedIssues.map((pkg) => (
                <div
                  key={pkg.key}
                  style={{ border: "1px solid rgba(212,175,55,0.2)", borderRadius: 10, padding: 12 }}
                  data-testid={`pcsc-issue-${pkg.key}`}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => navigate(`/admin/project-control/package/${pkg.key}`)}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        cursor: "pointer",
                        color: "inherit",
                        fontWeight: 700,
                      }}
                    >
                      {pkg.title}
                    </button>
                    <Badge variant={statusBadgeVariant(pkg.assessment.effectiveStatus)}>
                      {statusLabel(pkg.assessment.effectiveStatus)}
                    </Badge>
                    <Chip>{displayPercent(pkg.assessment.completion)}</Chip>
                    <Badge variant={riskBadgeVariant(pkg.risk)}>{pkg.risk.toUpperCase()}</Badge>
                    <Badge variant={confidenceBadgeVariant(pkg.assessment.confidence)}>
                      {confidenceLabel(pkg.assessment.confidence)}
                    </Badge>
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>{pkg.summary}</div>
                  <div style={{ fontSize: 13, marginTop: 6 }}>
                    <strong>Remaining:</strong> {pkg.remainingWork || "Not recorded."}
                  </div>
                  {pkg.branch && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>Branch: {pkg.branch}</div>}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Verification" sub="What has actually been proven, and where" className="mt-4">
          <div style={{ display: "grid", gap: 6, fontSize: 13 }} data-testid="pcsc-verification">
            {d.packages.map((pkg) => (
              <div key={pkg.key} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ minWidth: 220 }}>{pkg.title}</span>
                <Badge variant={pkg.productionVerification === "verified" ? "act" : "wait"}>
                  {pkg.productionVerification.replace(/_/g, " ").toUpperCase()}
                </Badge>
                <span style={{ opacity: 0.65 }}>{pkg.assessment.confidenceReason}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Blockers" className="mt-4">
          {d.blockers.length === 0 ? (
            <div style={{ opacity: 0.7 }}>None open.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }} data-testid="pcsc-blockers">
              {d.blockers.map((b, i) => (
                <div
                  key={`${b.packageKey}-${i}`}
                  style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
                >
                  <Badge variant="red">{BLOCKER_KIND_LABELS[b.kind]}</Badge>
                  <span>{b.packageTitle}</span>
                  <span style={{ opacity: 0.85 }}>{b.description}</span>
                  <span style={{ opacity: 0.55, fontSize: 12 }}>opened {relativeTime(b.openedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </AdminShell>
  );
}
