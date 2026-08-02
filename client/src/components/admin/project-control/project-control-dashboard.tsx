import { ProjectControlExecutiveSummary } from "./executive-summary";
import { PartnerShopLaunchProgression } from "./partner-shop-launch-progression";
import { PriorityBlockerList } from "./priority-blocker-list";
import { CollapsedWorkflowTree } from "./workflow-tree";
import { CompactLiveEvidence } from "./compact-live-evidence";
import type { LiveEvidence, ProjectControlOverview, ShopLaunchView, SyncStatus } from "@/lib/project-control/api";

export function ProjectControlDashboard({ overview, shopLaunch, liveEvidence, sync, onOpenPackage, onRefresh, refreshing }: { overview: ProjectControlOverview; shopLaunch: ShopLaunchView; liveEvidence: LiveEvidence | undefined; sync: SyncStatus | null; onOpenPackage: (key: string) => void; onRefresh: () => void; refreshing: boolean }) {
  const active = shopLaunch.nextMilestone?.key ?? null;
  return <div className="pc-dashboard"><ProjectControlExecutiveSummary overview={overview} shopLaunch={shopLaunch} evidenceState={liveEvidence?.github.freshness.freshness ?? "unknown"} onOpenPackage={onOpenPackage} onRefresh={onRefresh} refreshing={refreshing} /><PartnerShopLaunchProgression view={shopLaunch} onOpenPackage={onOpenPackage} /><div className="pc-secondary-grid"><PriorityBlockerList blockers={shopLaunch.blockers} onOpenPackage={onOpenPackage} /><CollapsedWorkflowTree tree={overview.tree} activePhaseKey={active} integrity={overview.treeIntegrity} onOpenPackage={onOpenPackage} /></div><CompactLiveEvidence evidence={liveEvidence} sync={sync} onRefresh={onRefresh} refreshing={refreshing} /></div>;
}
