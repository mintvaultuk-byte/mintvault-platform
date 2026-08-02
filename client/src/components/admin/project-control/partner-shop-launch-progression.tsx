import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Panel } from "@/components/admin";
import type { ShopLaunchView } from "@/lib/project-control/api";
import {
  confidenceBadgeVariant,
  displayPercent,
  statusBadgeVariant,
  statusLabel,
} from "@/pages/admin/project-control-helpers";
import { LAUNCH_GATE_KEYS, partitionPhases } from "@shared/project-control-launch";
import { EvidenceStateBadge } from "./evidence-state";

export function PartnerShopLaunchProgression({
  view,
  onOpenPackage,
}: {
  view: ShopLaunchView;
  onOpenPackage: (key: string) => void;
}) {
  const { backlog, unrecognised } = partitionPhases(view.phases);
  const byKey = useMemo(() => new Map(view.phases.map((phase) => [phase.key, phase])), [view.phases]);
  const nextKey = view.nextMilestone?.key ?? null;
  const [open, setOpen] = useState<string | null>(nextKey);
  useEffect(() => {
    if (nextKey) setOpen(nextKey);
  }, [nextKey]);
  return (
    <section className="pc-section" aria-labelledby="pc-launch-heading">
      <h2 id="pc-launch-heading" className="sr-only">
        Partner Shop Launch
      </h2>
      <Panel
        title="Partner Shop Launch"
        sub="Ten declared launch gates. The highlighted gate is the next recorded milestone."
      >
        <ol className="pc-launch-list" data-testid="pc-launch-gates">
          {LAUNCH_GATE_KEYS.map((key, index) => {
            const phase = byKey.get(key);
            const expanded = open === key;
            if (!phase)
              return (
                <li key={key} className="pc-launch-gate pc-gate-missing">
                  <div className="pc-gate-toggle">
                    <span className="pc-gate-order">{index + 1}</span>
                    <span className="pc-gate-name">{key.replace(/^pn-/, "").replace(/-/g, " ")}</span>
                    <EvidenceStateBadge state="unknown" />
                    <span className="pc-gate-meta">Gate data unavailable</span>
                  </div>
                </li>
              );
            const blockers = phase.packages.flatMap((pkg) => pkg.blockers.filter((blocker) => !blocker.resolvedAt));
            const freshness = phase.packages.some((pkg) => pkg.assessment.confidence === "contradictory")
              ? "contradictory"
              : phase.packages.some((pkg) => pkg.assessment.confidence === "stale")
                ? "stale"
                : phase.packages.length
                  ? "current"
                  : "unknown";
            return (
              <li key={key} className={`pc-launch-gate ${key === nextKey ? "is-next-gate" : ""}`}>
                <button
                  type="button"
                  className="pc-gate-toggle"
                  onClick={() => setOpen(expanded ? null : key)}
                  aria-expanded={expanded}
                  aria-controls={`pc-gate-${key}`}
                >
                  <span className="pc-gate-order">{index + 1}</span>
                  <span className="pc-gate-name">
                    {phase.name}
                    {key === nextKey && <small>Next milestone</small>}
                  </span>
                  <Badge variant={phase.readiness.overall >= 100 ? "act" : "prog"}>
                    {displayPercent(phase.readiness.overall)}
                  </Badge>
                  <span className="pc-gate-meta">
                    {blockers.length} blocker{blockers.length === 1 ? "" : "s"}
                  </span>
                  <EvidenceStateBadge state={freshness} />
                  {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                </button>
                <div id={`pc-gate-${key}`} className="pc-gate-detail" hidden={!expanded}>
                  {phase.packages.length === 0 ? (
                    <p>No package evidence has been recorded for this gate.</p>
                  ) : (
                    phase.packages.map((pkg) => (
                      <div className="pc-gate-package" key={pkg.key}>
                        <span>
                          <strong>{pkg.title}</strong>
                          <small>{pkg.summary ?? "No summary recorded."}</small>
                        </span>
                        <Badge variant={statusBadgeVariant(pkg.assessment.effectiveStatus)}>
                          {statusLabel(pkg.assessment.effectiveStatus)}
                        </Badge>
                        <Badge variant={confidenceBadgeVariant(pkg.assessment.confidence)}>
                          {pkg.assessment.confidence.replace(/_/g, " ")}
                        </Badge>
                        <button type="button" onClick={() => onOpenPackage(pkg.key)} aria-label={`Open ${pkg.title}`}>
                          <ExternalLink size={15} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {backlog.map((item) => (
          <div className="pc-backlog" data-testid="pc-permanent-backlog" key={item.key}>
            <strong>Permanent backlog · G7–G20</strong>
            <span>{item.description}</span>
            <Badge variant="wait">Separate from pilot readiness</Badge>
          </div>
        ))}
        {unrecognised.length > 0 && (
          <div className="pc-integrity-warning">
            {unrecognised.length} unrecognised Partner Network phase(s) require owner review.
          </div>
        )}
      </Panel>
    </section>
  );
}
