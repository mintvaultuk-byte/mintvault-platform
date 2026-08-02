import { AlertTriangle, ArrowRight, Flag, RefreshCw, Rocket, Server, Target } from "lucide-react";
import { AdminButton, Panel, StatCard } from "@/components/admin";
import type { ProjectControlOverview, ShopLaunchView, SyncStatus } from "@/lib/project-control/api";
import type { OverviewDto } from "@shared/project-control-overview";
import { displayPercent, describeAction, relativeTime } from "@/pages/admin/project-control-helpers";
import { EvidenceStateBadge } from "./evidence-state";

function deploymentLabel(
  commit: string | null | undefined,
  matchesMain: boolean | null | undefined,
  available: boolean
) {
  if (!available) return { value: "Unavailable", foot: "Evidence service could not be read" };
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
  sync,
  evidenceState,
  onOpenPackage,
  onRefresh,
  refreshing,
}: {
  overview: ProjectControlOverview;
  shopLaunch: ShopLaunchView;
  evidence: OverviewDto | undefined;
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
  const staging = deploymentLabel(
    stagingApp?.commit,
    evidence?.executive.deploymentAligned,
    Boolean(evidence)
  );
  const production = deploymentLabel(
    productionApp?.commit,
    evidence?.executive.productionAligned,
    Boolean(evidence)
  );
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
        <StatCard
          className="pc-summary-readiness"
          label="Overall readiness"
          value={displayPercent(overview.readiness.overall)}
          foot="Server-authoritative weighted readiness"
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
