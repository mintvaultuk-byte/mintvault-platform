import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { Badge, Panel } from "@/components/admin";
import type { ProgrammeTreeNode } from "@shared/project-control";
import { displayPercent, statusBadgeVariant, statusLabel } from "@/pages/admin/project-control-helpers";
import { useMemo, useState } from "react";

function TreeNode({ node, depth, activeKey, expanded, onToggle, onOpenPackage }: { node: ProgrammeTreeNode; depth: number; activeKey: string | null; expanded: Set<string>; onToggle: (key: string) => void; onOpenPackage: (key: string) => void }) {
  const hasChildren = node.children.length > 0 || node.packages.length > 0;
  const isOpen = expanded.has(node.key);
  return <div className={`pc-tree-node ${node.key === "partner-network" ? "is-active-branch" : ""}`} style={{ "--pc-depth": depth } as React.CSSProperties}><div className="pc-tree-row">{hasChildren ? <button type="button" onClick={() => onToggle(node.key)} aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button> : <span className="pc-tree-spacer" />}<GitBranch size={14} aria-hidden="true" /><strong>{node.name}</strong>{node.rollup && <Badge variant={node.rollup.readiness.overall >= 100 ? "act" : "prog"}>{displayPercent(node.rollup.readiness.overall)}</Badge>}</div>{isOpen && <div className="pc-tree-children">{node.packages.map((pkg) => <div className={`pc-tree-package ${pkg.key === activeKey ? "is-active-package" : ""}`} key={pkg.key}><button type="button" onClick={() => onOpenPackage(pkg.key)}>{pkg.title}</button><Badge variant={statusBadgeVariant(pkg.status)}>{statusLabel(pkg.status)}</Badge>{pkg.blockers.some((blocker) => !blocker.resolvedAt) && <Badge variant="red">BLOCKED</Badge>}</div>)}{node.children.map((child) => <TreeNode key={child.key} node={child} depth={depth + 1} activeKey={activeKey} expanded={expanded} onToggle={onToggle} onOpenPackage={onOpenPackage} />)}</div>}</div>;
}

export function CollapsedWorkflowTree({ tree, activePhaseKey, integrity, onOpenPackage }: { tree: ProgrammeTreeNode[]; activePhaseKey: string | null; integrity: { orphanedPackages: { key: string }[]; orphanedNodes: { key: string }[]; nodeCycles: string[][] }; onOpenPackage: (key: string) => void }) {
  const defaults = useMemo(() => new Set(["mintvault", "partner-network"]), []);
  const [expanded, setExpanded] = useState<Set<string>>(defaults);
  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const integrityProblem = integrity.orphanedPackages.length + integrity.orphanedNodes.length + integrity.nodeCycles.length > 0;
  return <Panel title="Workflow tree" sub="Collapsed to the active launch path. Expand only when you need the full programme."><div className="pc-tree-toolbar"><button type="button" className="pc-text-button" onClick={() => setExpanded(new Set(tree.flatMap((node) => [node.key, ...node.children.map((child) => child.key)])))}>Expand full tree</button><span>Active phase: {activePhaseKey ?? "Unknown"}</span></div>{integrityProblem && <div className="pc-integrity-warning" data-testid="pc-tree-integrity-warning">Programme structure needs attention: {integrity.orphanedPackages.length} orphaned package(s), {integrity.orphanedNodes.length} orphaned node(s), {integrity.nodeCycles.length} cycle(s).</div>}<div className="pc-tree" data-testid="pc-workflow-tree">{tree.map((node) => <TreeNode key={node.key} node={node} depth={0} activeKey={null} expanded={expanded} onToggle={toggle} onOpenPackage={onOpenPackage} />)}</div></Panel>;
}
