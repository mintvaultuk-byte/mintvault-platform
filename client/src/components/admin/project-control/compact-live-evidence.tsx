import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { AdminButton, Panel } from "@/components/admin";
import type { LiveEvidence, SyncStatus } from "@/lib/project-control/api";
import { relativeTime } from "@/pages/admin/project-control-helpers";
import { EvidenceStateBadge, evidenceStateFrom } from "./evidence-state";

export function CompactLiveEvidence({
  evidence,
  evidenceUnavailable,
  sync,
  onRefresh,
  refreshing,
}: {
  evidence: LiveEvidence | undefined;
  evidenceUnavailable: boolean;
  sync: SyncStatus | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [details, setDetails] = useState(false);
  const github = evidence?.github;
  const staging = evidence?.applications.find((item) => item.environment === "staging");
  const production = evidence?.applications.find((item) => item.environment === "production");
  const state = evidence
    ? evidenceStateFrom(github?.freshness.freshness)
    : evidenceUnavailable
      ? "unavailable"
      : "unknown";
  const staleSnapshot = state === "stale" ? github?.snapshot?.fetchedAt : null;
  const contradiction = Boolean(
    evidence?.deployment &&
    (evidence.deployment.stagingMatchesMain === false ||
      evidence.deployment.productionMatchesMain === false ||
      evidence.deployment.stagingMatchesProduction === false)
  );
  return (
    <section className="pc-section">
      <Panel
        title="Live evidence"
        sub="Compact source-of-truth summary; CI never proves deployment."
        actions={
          <AdminButton
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh GitHub evidence"
          >
            <RefreshCw size={14} />
            {refreshing ? "Refreshing…" : "Refresh GitHub"}
          </AdminButton>
        }
      >
        <div className="pc-evidence-summary" data-testid="pc-live-evidence">
          <div>
            <small>GitHub main</small>
            <strong className="pc-mono">
              {github?.snapshot?.defaultBranchSha?.slice(0, 12) ?? (evidenceUnavailable ? "Unavailable" : "Unknown")}
            </strong>
            <span className="pc-evidence-note">
              {staleSnapshot ? `Last known good · ${relativeTime(staleSnapshot)}` : "Repository source"}
            </span>
            <EvidenceStateBadge state={state} />
          </div>
          <div>
            <small>PR / CI</small>
            <strong>
              {github?.snapshot
                ? `${github.snapshot.pullRequests.filter((pr) => pr.state === "open").length} open PRs`
                : evidenceUnavailable
                  ? "Unavailable"
                  : "Unknown"}
            </strong>
            <EvidenceStateBadge
              state={
                github?.snapshot?.workflowRuns.some((run) => run.conclusion === "failure")
                  ? "failed"
                  : github?.snapshot
                    ? "current"
                    : state
              }
            />
          </div>
          <div>
            <small>Staging commit</small>
            <strong className="pc-mono">{staging?.commit?.slice(0, 12) ?? "Unavailable"}</strong>
            <EvidenceStateBadge state={staging?.state ?? (evidenceUnavailable ? "unavailable" : "unknown")} />
          </div>
          <div>
            <small>Production commit</small>
            <strong className="pc-mono">{production?.commit?.slice(0, 12) ?? "Unavailable"}</strong>
            <EvidenceStateBadge state={production?.state ?? (evidenceUnavailable ? "unavailable" : "unknown")} />
          </div>
          <div>
            <small>Flags</small>
            <strong>
              {evidence ? `${evidence.featureFlags.length} reported` : evidenceUnavailable ? "Unavailable" : "Unknown"}
            </strong>
            <EvidenceStateBadge state={evidence ? "current" : state} />
          </div>
          <div>
            <small>Migration</small>
            <strong>Not returned</strong>
            <EvidenceStateBadge state="unknown" />
          </div>
          <div>
            <small>Sync status</small>
            <strong>{sync?.state ?? "No refresh run"}</strong>
            <EvidenceStateBadge state={sync?.state ?? "unknown"} />
          </div>
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          GitHub refresh state: {sync?.state ?? "idle"}. Evidence freshness: {state}.
        </div>
        {contradiction && (
          <div className="pc-contradiction" data-testid="pc-contradiction-warning">
            Contradictory deployment evidence:{" "}
            {evidence?.deployment?.summary || "inspect the named sources before promoting readiness."}
          </div>
        )}
        <button
          type="button"
          className="pc-evidence-disclosure"
          onClick={() => setDetails((open) => !open)}
          aria-expanded={details}
        >
          {details ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{" "}
          {details ? "Hide technical detail" : "Show technical detail"}
        </button>
        {details && (
          <div className="pc-evidence-details">
            <p>
              {staleSnapshot
                ? `GitHub snapshot last known good ${relativeTime(staleSnapshot)}.`
                : `Observed ${relativeTime(evidence?.observedAt)}.`}{" "}
              {github?.freshness.reason ?? "No GitHub evidence has been read yet."}
            </p>
            <p>
              Migration evidence is unavailable from this compact route. Unknown is never interpreted as incomplete.
            </p>
            {sync?.errorCode && (
              <p>Refresh result: {sync.state.toLowerCase().replace(/_/g, " ")}. Retry is available.</p>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
