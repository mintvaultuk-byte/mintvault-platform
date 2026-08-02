import { ProjectControlExecutiveSummary } from "./executive-summary";
import { PartnerShopLaunchProgression } from "./partner-shop-launch-progression";
import { PriorityBlockerList } from "./priority-blocker-list";
import { CollapsedWorkflowTree } from "./workflow-tree";
import { CompactLiveEvidence } from "./compact-live-evidence";
import type { ProjectControlOverview, ShopLaunchView, SyncStatus } from "@/lib/project-control/api";
import type { OverviewDto } from "@shared/project-control-overview";

export function ProjectControlDashboard({
  overview,
  shopLaunch,
  evidence,
  evidenceUnavailable,
  sync,
  onOpenPackage,
  onRefresh,
  refreshing,
}: {
  overview: ProjectControlOverview;
  shopLaunch: ShopLaunchView;
  /** Stored composed evidence. Backend-authoritative; nothing here recomputes it. */
  evidence: OverviewDto | undefined;
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
        evidence={evidence}
        evidenceUnavailable={evidenceUnavailable}
        sync={sync}
        evidenceState={evidence?.repository.meta.freshness ?? (evidenceUnavailable ? "unavailable" : "unknown")}
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
        evidence={evidence}
        evidenceUnavailable={evidenceUnavailable}
        sync={sync}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
    </div>
  );
}
