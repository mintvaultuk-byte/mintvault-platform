import { AlertTriangle, ArrowRight, Flag, RefreshCw, Rocket, Server, Target } from "lucide-react";
import { AdminButton, Panel, StatCard } from "@/components/admin";
import type { ProjectControlOverview, ShopLaunchView, SyncStatus } from "@/lib/project-control/api";
import type { OverviewDto } from "@shared/project-control-overview";
import { displayPercent, describeAction, relativeTime } from "@/pages/admin/project-control-helpers";
import { EvidenceStateBadge } from "./evidence-state";

function deploymentLabel(
  commit: string | null | undefined,
  matchesMain: boolean | null | undefined,
  /** "loaded" = we have a DTO; "loading" = still in flight; "failed" = the request errored. */
  status: "loaded" | "loading" | "failed"
) {
  // These were one boolean, so a request still in flight asserted "Evidence service could not be
  // read" — a false statement, and one the evidence strip below contradicted on the same screen.
  if (status === "loading") return { value: "Loading", foot: "Reading stored evidence" };
  if (status === "failed") return { value: "Unavailable", foot: "Evidence service could not be read" };
  if (!commit) return { value: "Unknown", foot: "No commit was returned" };
  return {
    value: matchesMain === false ? "Drift" : matchesMain === true ? "Aligned" : "Unverified",
    foot: `${commit.slice(0, 12)} · ${matchesMain === null ? "comparison unavailable" : "repository comparison"}`,
  };
}

export function ProjectControlExecutiveSummary({
  overview,
  shopLaunch,
  evidence,
  evidenceUnavailable,
  sync,
  evidenceState,
  onOpenPackage,
  onRefresh,
  refreshing,
}: {
  overview: ProjectControlOverview;
  shopLaunch: ShopLaunchView;
  evidence: OverviewDto | undefined;
  /** True only when the evidence request FAILED — not merely while it is in flight. */
  evidenceUnavailable: boolean;
  sync: SyncStatus | null;
  evidenceState: string;
  onOpenPackage: (key: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const next = overview.nextActions.highestPriority ?? shopLaunch.nextActions.highestPriority;
  const milestone = shopLaunch.nextMilestone;
  const blocker = shopLaunch.blockers[0];
  const pilot = shopLaunch.phases.find((item) => item.key === "pn-pilot");
  const pilotReady = Boolean(pilot && pilot.readiness.overall >= 100);
  /**
   * Alignment comes from the server's `executive` block now.
   *
   * `deploymentAligned` (main vs staging) already existed; `productionAligned` was added because
   * the DTO previously had no production comparison at all, so this card had nothing truthful to
   * render. Neither verdict is computed here any more.
   */
  const stagingApp = evidence?.applications.find((a) => a.environment === "staging");
  const productionApp = evidence?.applications.find((a) => a.environment === "production");
  const evidenceStatus: "loaded" | "loading" | "failed" = evidence
    ? "loaded"
    : evidenceUnavailable
      ? "failed"
      : "loading";
  const staging = deploymentLabel(stagingApp?.commit, evidence?.executive.deploymentAligned, evidenceStatus);
  const production = deploymentLabel(productionApp?.commit, evidence?.executive.productionAligned, evidenceStatus);
  return (
    <section aria-labelledby="pc-executive-heading" className="pc-section">
      <div className="pc-section-heading">
        <div>
          <h2 id="pc-executive-heading">Partner Shop launch</h2>
          <p>Can we launch, and what is stopping us?</p>
        </div>
        <div className="pc-summary-actions">
          <EvidenceStateBadge state={evidenceState} testId="pc-evidence-freshness" />
          <AdminButton variant="gold" onClick={onRefresh} disabled={refreshing} aria-label="Refresh GitHub evidence">
            <RefreshCw size={15} aria-hidden="true" />
            {refreshing ? "Refreshing GitHub…" : "Refresh GitHub"}
          </AdminButton>
        </div>
      </div>
      <div className="pc-summary-grid">
        {/*
          TWO NUMBERS, TWO MEANINGS, BOTH LABELLED.

          The headline used to render `overview.readiness.overall` — the aggregate over
          operator-DECLARED work-package completion — under the caption "Server-authoritative
          weighted readiness". It was neither server-authoritative about evidence nor capped by it:
          a package marked done by hand pushed it to 100% with every live evidence source UNKNOWN.
          Meanwhile `evidence.readiness.percent`, the gate-and-contradiction-capped number that the
          readiness caps were built to produce, was rendered NOWHERE — only its `appliedCaps` were
          read, further down the page.

          So the authoritative figure leads, and it is genuinely capped: contradictions, unavailable
          and stale evidence all pull it down via computeGateReadiness. When the evidence layer has
          not loaded it shows Unknown rather than silently falling back to the declared number,
          because a fallback is how the two got conflated in the first place.

          The declared figure keeps its place beside it, named for what it is. It is real
          information — it is just a statement of intent, not of proof.
        */}
        <StatCard
          className="pc-summary-readiness"
          label="Evidence-backed readiness"
          value={evidence ? displayPercent(evidence.readiness.percent) : "Unknown"}
          foot={
            evidence
              ? evidence.readiness.appliedCaps.length > 0
                ? `Capped by ${evidence.readiness.appliedCaps.map((c) => c.code).join(", ")}`
                : `${evidence.readiness.satisfiedGates}/${evidence.readiness.totalGates} gates proven by live evidence`
              : evidenceUnavailable
                ? "Live evidence unavailable — not inferred from declared progress"
                : "Loading live evidence…"
          }
          icon={<Target size={15} />}
          testId="pc-evidence-readiness"
        />
        <StatCard
          label="Declared completion"
          value={displayPercent(overview.readiness.overall)}
          foot="Operator-entered progress — a statement of intent, not evidence"
          icon={<Target size={15} />}
          testId="pc-overall-readiness"
        />
        <Panel className="pc-next-action" title="Do this next" sub="Highest-priority server recommendation">
          {next ? (
            <>
              <button
                type="button"
                className="pc-action-link"
                onClick={() => onOpenPackage(next.packageKey)}
                data-testid="pc-next-action"
              >
                <strong>{next.headline}</strong>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <p>{describeAction(next)}</p>
            </>
          ) : (
            <p>There is no recommended action yet. Evidence and programme state remain visible below.</p>
          )}
        </Panel>
        <StatCard
          className="pc-summary-phase"
          label="Next milestone"
          value={milestone?.name ?? "Unknown"}
          foot={milestone ? "The active phase is not returned by this contract" : "No milestone was returned"}
          testId="pc-current-phase"
        />
        <StatCard
          className="pc-summary-pilot"
          label="Pilot readiness"
          value={pilotReady ? "Ready" : "Not ready"}
          foot={pilot ? `${displayPercent(pilot.readiness.overall)} · G7–G20 excluded` : "Pilot state unknown"}
          icon={<Rocket size={15} />}
          testId="pc-pilot-readiness"
        />
        <StatCard
          className="pc-summary-blocker"
          label="Highest blocker"
          value={blocker?.packageTitle ?? "No open blocker"}
          foot={blocker?.description ?? "No open blocker was returned"}
          icon={<AlertTriangle size={15} />}
          testId="pc-highest-blocker"
        />
        <StatCard
          className="pc-summary-staging"
          label="Staging"
          value={staging.value}
          foot={staging.foot}
          icon={<Server size={15} />}
          testId="pc-staging-status"
        />
        <StatCard
          className="pc-summary-production"
          label="Production"
          value={production.value}
          foot={production.foot}
          icon={<Server size={15} />}
          testId="pc-production-status"
        />
        <StatCard
          className="pc-summary-refresh"
          label="Last evidence refresh"
          value={sync?.completedAt ? relativeTime(sync.completedAt) : "No successful refresh"}
          foot={sync?.completedAt ? "Last GitHub sync completion" : "Refresh GitHub to establish evidence"}
          icon={<Flag size={15} />}
          testId="pc-last-refresh"
        />
      </div>
    </section>
  );
}
