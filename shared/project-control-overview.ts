/**
 * Project Control — the composed-overview DTO, shared between server and browser.
 *
 * WHY THESE TYPES MOVED OUT OF `server/`
 *
 * They were declared in `server/project-control/overview-service.ts`, and the path aliases are
 * `@/* -> client/src/*` and `@shared/* -> shared/*` — there is no `@server` alias and no client
 * file imports from `server/`. So the DTO describing the endpoint the UI is supposed to consume
 * was, by construction, not importable by the UI. The only alternatives were to hand-duplicate the
 * shape in the client (which CLAUDE.md forbids, and which is exactly the drift class that produced
 * the TCGdex `data.identification.*` incident) or to move it here.
 *
 * Types only. No runtime code, no database, no network — safe to import from either side.
 */
import type { Contradiction, Gate, GateResult, ReadinessVerdict } from "./project-control-gates";

export interface EvidenceMeta {
  /** ISO string, or null when nothing has ever been observed. Never a fabricated "now". */
  observedAt: string | null;
  freshness: "CURRENT" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | "CONTRADICTORY" | "FAILED" | null;
  /** When the latest observation is unusable, this is when the last usable one was taken. */
  lastKnownGoodAt: string | null;
  source: string;
}

export interface RepositorySection {
  mainSha: string | null;
  branchCount: number | null;
  /** OPEN pull requests only. Null when the snapshot predates this field being recorded. */
  openPullRequests: number | null;
  /** Every pull request the scan saw, in any state. */
  totalPullRequests: number | null;
  ciConclusion: string | null;
  syncState: string | null;
  lastSuccessfulSyncAt: string | null;
  activeSyncId: string | null;
  meta: EvidenceMeta;
}

export interface ApplicationSection {
  environment: string;
  commit: string | null;
  build: string | null;
  healthy: boolean | null;
  meta: EvidenceMeta;
}

export interface DatabaseSection {
  environment: string;
  journalPresent: boolean | null;
  appliedCount: number | null;
  pendingCount: number | null;
  foreignKeysIntact: boolean | null;
  missingForeignKeys: string[];
  contradictions: string[];
  meta: EvidenceMeta;
}

export interface FlagSection {
  key: string;
  /**
   * Which estate this observation is about.
   *
   * Previously absent from the DTO entirely, so a consumer could not tell whether a flag state
   * came from staging, production or a machine that could not name itself — and the gate below
   * could not either.
   */
  environment: string;
  /**
   * The last KNOWN GOOD state: `enabled`, `disabled_explicit`, `absent` or `unknown`.
   *
   * `absent` and `disabled_explicit` are deliberately distinct all the way to the gate. "Nobody
   * has decided" and "somebody decided no" call for different operator action, and collapsing
   * them to a boolean — which the gate used to do — throws away the only useful part.
   */
  state: string | null;
  /** The most recent observation, which may be unusable. Differs from `state` during an outage. */
  latestState: string | null;
  meta: EvidenceMeta;
}

export interface OverviewDto {
  generatedAt: string;
  repository: RepositorySection;
  applications: ApplicationSection[];
  databases: DatabaseSection[];
  flags: FlagSection[];
  gates: GateResult[];
  readiness: ReadinessVerdict;
  contradictions: Contradiction[];
  executive: {
    currentGate: Gate | null;
    nextGate: Gate | null;
    highestBlocker: string | null;
    nextRecommendedAction: string;
    /**
     * Main vs STAGING. Kept under its original name so existing consumers do not silently change
     * meaning.
     */
    deploymentAligned: boolean | null;
    /**
     * Main vs PRODUCTION, and staging vs production.
     *
     * Previously absent: `deploymentAligned` compared main to staging only, so a production
     * status card had nothing truthful to render and a client that wanted the comparison had to
     * compute it itself. `detectContradictions` already received the production commit, so the
     * data was present and merely unexposed.
     */
    productionAligned: boolean | null;
    stagingMatchesProduction: boolean | null;
  };
  integrity: {
    staleSources: string[];
    unknownSources: string[];
    unavailableSources: string[];
    contradictionCount: number;
  };
}
