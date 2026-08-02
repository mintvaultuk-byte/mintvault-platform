import { ProjectControlExecutiveSummary } from "./executive-summary";
import { PartnerShopLaunchProgression } from "./partner-shop-launch-progression";
import { PriorityBlockerList } from "./priority-blocker-list";
import { CollapsedWorkflowTree } from "./workflow-tree";
import { CompactLiveEvidence } from "./compact-live-evidence";
import type { LiveEvidence, ProjectControlOverview, ShopLaunchView, SyncStatus } from "@/lib/project-control/api";

export function ProjectControlDashboard({
  overview,
  shopLaunch,
  liveEvidence,
  evidenceUnavailable,
  sync,
  onOpenPackage,
  onRefresh,
  refreshing,
}: {
  overview: ProjectControlOverview;
  shopLaunch: ShopLaunchView;
  liveEvidence: LiveEvidence | undefined;
  evidenceUnavailable: boolean;
  sync: SyncStatus | null;
  onOpenPackage: (key: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const active = shopLaunch.nextMilestone?.key ?? null;
  return (
    <div className="pc-dashboard">
      <ProjectControlExecutiveSummary
        overview={overview}
        shopLaunch={shopLaunch}
        liveEvidence={liveEvidence}
        sync={sync}
        evidenceState={liveEvidence?.github.freshness.freshness ?? (evidenceUnavailable ? "unavailable" : "unknown")}
        onOpenPackage={onOpenPackage}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
      <PartnerShopLaunchProgression view={shopLaunch} onOpenPackage={onOpenPackage} />
      <div className="pc-secondary-grid">
        <PriorityBlockerList blockers={shopLaunch.blockers} onOpenPackage={onOpenPackage} />
        <CollapsedWorkflowTree
          tree={overview.tree}
          activePhaseKey={active}
          integrity={overview.treeIntegrity}
          onOpenPackage={onOpenPackage}
        />
      </div>
      <CompactLiveEvidence
        evidence={liveEvidence}
        evidenceUnavailable={evidenceUnavailable}
        sync={sync}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
    </div>
  );
}
