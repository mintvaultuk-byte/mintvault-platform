import { ArrowRight, ShieldAlert } from "lucide-react";
import { AdminButton, Badge, Panel } from "@/components/admin";
import type { ShopLaunchView } from "@/lib/project-control/api";
import { BLOCKER_KIND_LABELS } from "@shared/project-control";

export function PriorityBlockerList({ blockers, onOpenPackage }: { blockers: ShopLaunchView["blockers"]; onOpenPackage: (key: string) => void }) {
  const priority = blockers.slice(0, 3);
  return <Panel title="Priority blockers" sub="Only the launch blockers that need attention now."><div className="pc-blocker-list" data-testid="pc-priority-blockers">{priority.length === 0 ? <p>No open Partner Shop launch blockers are recorded.</p> : priority.map((blocker, index) => <article className="pc-blocker-card" key={`${blocker.packageKey}-${index}`}><ShieldAlert size={18} aria-hidden="true" /><div><div className="pc-blocker-title"><Badge variant={blocker.severity === "critical" || blocker.severity === "high" ? "red" : "gold"}>{blocker.severity ?? "attention"}</Badge><strong>{blocker.packageTitle}</strong></div><p>{blocker.description}</p><small>{BLOCKER_KIND_LABELS[blocker.kind as keyof typeof BLOCKER_KIND_LABELS] ?? "Open blocker"} · evidence confidence is available in package detail</small></div><AdminButton size="sm" variant="ghost" onClick={() => onOpenPackage(blocker.packageKey)} aria-label={`Open blocker for ${blocker.packageTitle}`}>Open <ArrowRight size={14} /></AdminButton></article>)}</div></Panel>;
}
