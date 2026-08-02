import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { Badge, Panel } from "@/components/admin";
import type { ProgrammeTreeNode } from "@shared/project-control";
import { displayPercent, statusBadgeVariant, statusLabel } from "@/pages/admin/project-control-helpers";
import { useMemo, useState } from "react";

function keysForFocusedPath(nodes: ProgrammeTreeNode[], nextKey: string | null) {
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    const index = node.children.findIndex((child) => child.key === nextKey);
    if (index >= 0) return new Set(node.children.slice(Math.max(0, index - 1), index + 2).map((child) => child.key));
    stack.push(...node.children);
  }
  return new Set<string>();
}

function allNodeKeys(nodes: ProgrammeTreeNode[]) {
  const keys: string[] = [];
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    keys.push(node.key);
    stack.push(...node.children);
  }
  return keys;
}

function TreeNode({
  node,
  depth,
  expanded,
  focusedKeys,
  showFullTree,
  onToggle,
  onOpenPackage,
}: {
  node: ProgrammeTreeNode;
  depth: number;
  expanded: Set<string>;
  focusedKeys: Set<string>;
  showFullTree: boolean;
  onToggle: (key: string) => void;
  onOpenPackage: (key: string) => void;
}) {
  const hasChildren = node.children.length > 0 || node.packages.length > 0;
  const isOpen = expanded.has(node.key);
  const children =
    !showFullTree && node.key === "partner-network" && focusedKeys.size > 0
      ? node.children.filter((child) => focusedKeys.has(child.key))
      : node.children;
  return (
    <div
      className={`pc-tree-node ${focusedKeys.has(node.key) ? "is-focus-node" : ""}`}
      style={{ "--pc-depth": depth } as React.CSSProperties}
    >
      <div className="pc-tree-row">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.key)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}
          >
            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : (
          <span className="pc-tree-spacer" />
        )}
        <GitBranch size={14} aria-hidden="true" />
        <strong>{node.name}</strong>
        {node.rollup && (
          <Badge variant={node.rollup.readiness.overall >= 100 ? "act" : "prog"}>
            {displayPercent(node.rollup.readiness.overall)}
          </Badge>
        )}
      </div>
      {isOpen && (
        <div className="pc-tree-children">
          {node.packages.map((pkg) => (
            <div className="pc-tree-package" key={pkg.key}>
              <button type="button" onClick={() => onOpenPackage(pkg.key)}>
                {pkg.title}
              </button>
              <Badge variant={statusBadgeVariant(pkg.status)}>{statusLabel(pkg.status)}</Badge>
              {pkg.blockers.some((blocker) => !blocker.resolvedAt) && <Badge variant="red">BLOCKED</Badge>}
            </div>
          ))}
          {children.map((child) => (
            <TreeNode
              key={child.key}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              focusedKeys={focusedKeys}
              showFullTree={showFullTree}
              onToggle={onToggle}
              onOpenPackage={onOpenPackage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CollapsedWorkflowTree({
  tree,
  activePhaseKey,
  integrity,
  onOpenPackage,
}: {
  tree: ProgrammeTreeNode[];
  activePhaseKey: string | null;
  integrity: { orphanedPackages: { key: string }[]; orphanedNodes: { key: string }[]; nodeCycles: string[][] };
  onOpenPackage: (key: string) => void;
}) {
  const defaults = useMemo(() => new Set(["mintvault", "partner-network"]), []);
  const [expanded, setExpanded] = useState<Set<string>>(defaults);
  const [showFullTree, setShowFullTree] = useState(false);
  const focusedKeys = useMemo(() => keysForFocusedPath(tree, activePhaseKey), [tree, activePhaseKey]);
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const integrityProblem =
    integrity.orphanedPackages.length + integrity.orphanedNodes.length + integrity.nodeCycles.length > 0;
  return (
    <Panel
      title="Workflow tree"
      sub="Shows the previous, next and following launch gates; expand the full programme only when needed."
    >
      <div className="pc-tree-toolbar">
        <button
          type="button"
          className="pc-text-button"
          onClick={() => {
            setShowFullTree((value) => !value);
            if (!showFullTree) setExpanded(new Set(allNodeKeys(tree)));
          }}
        >
          {showFullTree ? "Return to launch path" : "Expand full tree"}
        </button>
        <span>Next milestone: {activePhaseKey ?? "Unknown"}</span>
      </div>
      {integrityProblem && (
        <div className="pc-integrity-warning" data-testid="pc-tree-integrity-warning">
          Programme structure needs attention: {integrity.orphanedPackages.length} orphaned package(s),{" "}
          {integrity.orphanedNodes.length} orphaned node(s), {integrity.nodeCycles.length} cycle(s).
        </div>
      )}
      <div className="pc-tree" data-testid="pc-workflow-tree">
        {tree.map((node) => (
          <TreeNode
            key={node.key}
            node={node}
            depth={0}
            expanded={expanded}
            focusedKeys={focusedKeys}
            showFullTree={showFullTree}
            onToggle={toggle}
            onOpenPackage={onOpenPackage}
          />
        ))}
      </div>
    </Panel>
  );
}
