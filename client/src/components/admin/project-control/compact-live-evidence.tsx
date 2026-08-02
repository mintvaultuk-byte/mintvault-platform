import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { AdminButton, Panel } from "@/components/admin";
import type { SyncStatus } from "@/lib/project-control/api";
import type { OverviewDto } from "@shared/project-control-overview";
import { relativeTime } from "@/pages/admin/project-control-helpers";
import { EvidenceStateBadge, evidenceStateFrom } from "./evidence-state";

/**
 * The evidence strip, rendered ENTIRELY from stored backend truth.
 *
 * What this component used to do, and no longer does:
 *
 *   - Detect contradictions itself, with a three-boolean OR over deployment comparisons. The
 *     backend owns `detectContradictions`, which covers database and flag contradictions too and
 *     carries a severity and a stable code. The browser version could not express any of that, and
 *     silently disagreed with the number shown above it.
 *   - Count open PRs by filtering a raw GitHub snapshot in the browser.
 *   - Decide a CI verdict from "did any workflow run fail".
 *
 * All three are now read from the composed DTO. The rule the server states — that the
 * "merged is not deployed" logic must never live in the browser, where it can drift unnoticed —
 * is finally true.
 */
export function CompactLiveEvidence({
  evidence,
  evidenceUnavailable,
  sync,
  onRefresh,
  refreshing,
}: {
  evidence: OverviewDto | undefined;
  evidenceUnavailable: boolean;
  sync: SyncStatus | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [details, setDetails] = useState(false);
  const repo = evidence?.repository;
  const staging = evidence?.applications.find((item) => item.environment === "staging");
  const production = evidence?.applications.find((item) => item.environment === "production");
  const stagingDb = evidence?.databases.find((item) => item.environment === "staging");

  const state = evidence
    ? evidenceStateFrom(repo?.meta.freshness)
    : evidenceUnavailable
      ? "unavailable"
      : "unknown";

  /** Stale means "a real answer, just old" — so show WHEN it was last right, not a blank. */
  const lastKnownGoodAt = repo?.meta.lastKnownGoodAt ?? null;
  const showLastKnownGood = state === "stale" || state === "unavailable";

  // Backend-authoritative. No client-side derivation.
  const contradictions = evidence?.contradictions ?? [];
  const caps = evidence?.readiness.appliedCaps ?? [];

  /** null is Unknown; it is never rendered as zero or as a dash that reads like "none". */
  const orUnknown = (value: string | null | undefined) =>
    value ?? (evidenceUnavailable ? "Unavailable" : "Unknown");

  return (
    <section className="pc-section">
      <Panel
        title="Live evidence"
        sub="Stored source-of-truth summary; CI never proves deployment."
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
            <strong className="pc-mono">{orUnknown(repo?.mainSha?.slice(0, 12))}</strong>
            <span className="pc-evidence-note">
              {showLastKnownGood && lastKnownGoodAt
                ? `Last known good · ${relativeTime(lastKnownGoodAt)}`
                : "Repository source"}
            </span>
            <EvidenceStateBadge state={state} />
          </div>
          <div>
            <small>PR / CI</small>
            <strong>
              {/* OPEN PRs specifically. The server now records the open count separately from the
                  all-state total, so this cannot silently become "every PR ever opened". */}
              {repo?.openPullRequests === null || repo?.openPullRequests === undefined
                ? orUnknown(null)
                : `${repo.openPullRequests} open PRs`}
            </strong>
            <EvidenceStateBadge state={repo?.ciConclusion ? evidenceStateFrom(repo.ciConclusion) : "unknown"} />
          </div>
          <div>
            <small>Staging commit</small>
            <strong className="pc-mono">{orUnknown(staging?.commit?.slice(0, 12))}</strong>
            <EvidenceStateBadge state={evidenceStateFrom(staging?.meta.freshness) ?? "unknown"} />
          </div>
          <div>
            <small>Production commit</small>
            <strong className="pc-mono">{orUnknown(production?.commit?.slice(0, 12))}</strong>
            <EvidenceStateBadge state={evidenceStateFrom(production?.meta.freshness) ?? "unknown"} />
          </div>
          <div>
            <small>Flags</small>
            {/* The server OMITS flags it has never observed, so an empty array means "no evidence",
                not "we looked and found none". Rendering "0 reported" made those identical. */}
            <strong>{evidence && evidence.flags.length > 0 ? `${evidence.flags.length} reported` : orUnknown(null)}</strong>
            <EvidenceStateBadge state={evidence && evidence.flags.length > 0 ? "current" : "unknown"} />
          </div>
          <div>
            <small>Migration (staging)</small>
            {/* Previously the hard-coded string "Not returned" — the compact route genuinely did
                not carry migration evidence. The composed DTO does. */}
            <strong>
              {stagingDb?.appliedCount === null || stagingDb?.appliedCount === undefined
                ? orUnknown(null)
                : `${stagingDb.appliedCount} applied · ${stagingDb.pendingCount ?? "unknown"} pending`}
            </strong>
            <EvidenceStateBadge state={evidenceStateFrom(stagingDb?.meta.freshness) ?? "unknown"} />
          </div>
          <div>
            <small>Sync status</small>
            <strong>{sync?.state ?? repo?.syncState ?? "No refresh run"}</strong>
            <EvidenceStateBadge state={sync?.state ?? repo?.syncState ?? "unknown"} />
          </div>
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          GitHub refresh state: {sync?.state ?? "idle"}. Evidence freshness: {state}.
        </div>
        {contradictions.length > 0 && (
          <div className="pc-contradiction" data-testid="pc-contradiction-warning">
            {/* The server's stable code and summary, not a sentence assembled here. */}
            {contradictions.map((c) => (
              <p key={c.code}>
                <strong>{c.code}</strong> — {c.summary}
              </p>
            ))}
          </div>
        )}
        {/* Rendered independently of contradictions. A binding cap from an UNAVAILABLE or UNKNOWN
            source is exactly the case an operator needs explained, and nesting this inside the
            contradiction block meant those two were computed, sent, and never shown. */}
        {caps.filter((cap) => cap.binding).length > 0 && (
          <div className="pc-contradiction" data-testid="pc-readiness-caps">
            {caps
              .filter((cap) => cap.binding)
              .map((cap) => (
                <p key={cap.code} data-testid="pc-readiness-cap">
                  {cap.reason}
                </p>
              ))}
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
              {showLastKnownGood && lastKnownGoodAt
                ? `Repository evidence last known good ${relativeTime(lastKnownGoodAt)}.`
                : `Observed ${relativeTime(repo?.meta.observedAt)}.`}{" "}
              {evidence
                ? `Composed from stored snapshots at ${relativeTime(evidence.generatedAt)}; no external call was made to render this page.`
                : "No evidence has been stored yet. Use Refresh GitHub to collect some."}
            </p>
            {evidence && (
              <p>
                Integrity: {evidence.integrity.staleSources.length} stale,{" "}
                {evidence.integrity.unknownSources.length} unknown,{" "}
                {evidence.integrity.unavailableSources.length} unavailable source(s).
              </p>
            )}
            {sync?.errorCode && (
              <p>Refresh result: {sync.state.toLowerCase().replace(/_/g, " ")}. Retry is available.</p>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
