/**
 * Project Control — the composed overview.
 *
 * ONE endpoint, ONE typed DTO, and the only summary the UI consumes. The frontend must never
 * assemble four evidence sources itself: doing so would put the "merged is not deployed" rule in
 * the browser, where it could drift from the backend's version and where nobody would notice.
 *
 * ZERO EXTERNAL CALLS. This reads persisted snapshots and nothing else. It does not touch GitHub,
 * Fly, either application or either database. That is a correctness property, not a performance
 * one: an overview that refreshed on page load would spend GitHub quota on every render, and a
 * dashboard that is expensive to look at is a dashboard nobody looks at. Refresh is a separate,
 * explicit, audited action.
 *
 * The DTO carries typed data only — no display strings, no formatting, no HTML. Rendering
 * decisions belong to the UI; this decides what is TRUE.
 */
import { TRACKED_FLAGS } from "./flag-evidence";
import {
  getLatestSnapshot,
  getLatestGoodSnapshot,
  getLatestRun,
  getActiveRun,
  getLastSuccessfulRun,
  type EvidenceDb,
  type StoredSnapshot,
  type SyncRun,
} from "./evidence-repository";
import { GITHUB_SOURCE } from "./github-sync-service";
import { APPLICATION_SOURCE, FLAG_SOURCE } from "./probe-persistence";
import { DATABASE_SOURCE } from "./database-evidence";
import {
  GATES,
  resolveGate,
  summariseGates,
  detectContradictions,
  computeGateReadiness,
  type Gate,
  type GateResult,
  type GateObservation,
  type Contradiction,
  type ReadinessVerdict,
} from "@shared/project-control-gates";

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
  openPullRequests: number | null;
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
    deploymentAligned: boolean | null;
  };
  integrity: {
    staleSources: string[];
    unknownSources: string[];
    unavailableSources: string[];
    contradictionCount: number;
  };
}

/** Every environment this dashboard reports on. Fixed, not discovered. */
const ENVIRONMENTS = ["staging", "production"] as const;
const APPLICATION_HOSTS: Record<string, string> = {
  staging: "mintvault-v2.fly.dev",
  production: "mintvault.fly.dev",
};

/**
 * Build the meta block for one entity.
 *
 * Reads the latest observation AND the latest usable one. When they differ, the caller learns both
 * that something is wrong now and when it was last right — which is the whole point of keeping
 * failures as additional rows rather than replacements.
 */
function metaFrom(latest: StoredSnapshot | null, good: StoredSnapshot | null, source: string): EvidenceMeta {
  return {
    observedAt: latest ? latest.observedAt.toISOString() : null,
    freshness: latest ? latest.freshness : null,
    lastKnownGoodAt: good ? good.observedAt.toISOString() : null,
    source,
  };
}

/** Freshness after applying the validity window. A snapshot past validUntil is STALE, not CURRENT. */
function effectiveFreshness(snap: StoredSnapshot | null, now: Date): EvidenceMeta["freshness"] {
  if (!snap) return null;
  if (snap.freshness !== "CURRENT") return snap.freshness;
  if (snap.validUntil && snap.validUntil.getTime() < now.getTime()) return "STALE";
  return "CURRENT";
}

export async function buildComposedOverview(db: EvidenceDb, now: Date = new Date()): Promise<OverviewDto> {
  /* ── Repository ────────────────────────────────────────────────────────────────────────── */
  const repoLatest = await getLatestSnapshotForAnyRepo(db);
  const repoGood = repoLatest
    ? await getLatestGoodSnapshot(db, {
        sourceType: GITHUB_SOURCE,
        environment: null,
        entityType: "repository",
        entityId: repoLatest.entityId,
      })
    : null;

  const latestRun: SyncRun | null = await getLatestRun(db, GITHUB_SOURCE);
  const activeRun: SyncRun | null = await getActiveRun(db, GITHUB_SOURCE);
  const lastGoodRun: SyncRun | null = await getLastSuccessfulRun(db, GITHUB_SOURCE);
  const repoPayload = (repoGood?.payload ?? {}) as Record<string, unknown>;

  const repository: RepositorySection = {
    mainSha: repoGood?.commitSha ?? null,
    branchCount: numberOrNull(repoPayload.branchCount),
    openPullRequests: numberOrNull(repoPayload.pullRequestCount),
    ciConclusion: null,
    syncState: latestRun?.state ?? null,
    lastSuccessfulSyncAt: lastGoodRun?.completedAt ? lastGoodRun.completedAt.toISOString() : null,
    activeSyncId: activeRun?.syncId ?? null,
    meta: {
      ...metaFrom(repoLatest, repoGood, GITHUB_SOURCE),
      freshness: effectiveFreshness(repoLatest, now),
    },
  };

  /* ── Applications ──────────────────────────────────────────────────────────────────────── */
  const applications: ApplicationSection[] = [];
  for (const environment of ENVIRONMENTS) {
    const key = {
      sourceType: APPLICATION_SOURCE,
      environment,
      entityType: "application_version",
      entityId: APPLICATION_HOSTS[environment],
    };
    const latest = await getLatestSnapshot(db, key);
    const good = await getLatestGoodSnapshot(db, key);
    const payload = (good?.payload ?? {}) as Record<string, unknown>;
    applications.push({
      environment,
      // The last KNOWN GOOD commit, not the latest row. During an outage this keeps showing the
      // real deployed SHA with an honest freshness label instead of blanking.
      commit: good?.commitSha ?? null,
      build: typeof payload.build === "string" ? payload.build : null,
      healthy: latest ? latest.freshness === "CURRENT" : null,
      meta: { ...metaFrom(latest, good, APPLICATION_SOURCE), freshness: effectiveFreshness(latest, now) },
    });
  }

  /* ── Databases ─────────────────────────────────────────────────────────────────────────── */
  const databases: DatabaseSection[] = [];
  for (const environment of ENVIRONMENTS) {
    const key = {
      sourceType: DATABASE_SOURCE,
      environment,
      entityType: "migration_ledger",
      entityId: environment,
    };
    const latest = await getLatestSnapshot(db, key);
    const good = await getLatestGoodSnapshot(db, key);
    const payload = (good?.payload ?? {}) as Record<string, unknown>;
    const fks = (payload.foreignKeys ?? {}) as { intact?: boolean; missing?: string[] };
    databases.push({
      environment,
      journalPresent: typeof payload.journalPresent === "boolean" ? payload.journalPresent : null,
      appliedCount: numberOrNull(payload.appliedCount),
      // null, NOT zero. "We have not looked" must never render as "nothing is pending".
      pendingCount: Array.isArray(payload.pendingFilenames) ? payload.pendingFilenames.length : null,
      foreignKeysIntact: typeof fks.intact === "boolean" ? fks.intact : null,
      missingForeignKeys: Array.isArray(fks.missing) ? (fks.missing as string[]) : [],
      contradictions: Array.isArray(payload.contradictions) ? (payload.contradictions as string[]) : [],
      meta: { ...metaFrom(latest, good, DATABASE_SOURCE), freshness: effectiveFreshness(latest, now) },
    });
  }

  /**
   * ── Flags ───────────────────────────────────────────────────────────────────────────────
   *
   * This read used to be the ONE source of the four that was not environment-keyed:
   *
   *   SELECT DISTINCT ON (entity_id) * FROM pc_evidence_snapshots WHERE source_type=$1
   *
   * `DISTINCT ON (entity_id)` collapses every environment's row for a flag into one and keeps
   * whichever is newest — so a production machine's observation satisfied the STAGING gate, and a
   * row labelled `unknown` satisfied whichever gate asked first. It also hand-built its meta and
   * skipped `effectiveFreshness`, so `FLAG_VALID_MS` was written and never read and a flag
   * observation stayed CURRENT forever.
   *
   * Now keyed on (environment, flag) exactly as applications and databases are, with the validity
   * window applied and last-known-good read separately from latest.
   */
  const flags: FlagSection[] = [];
  for (const environment of ENVIRONMENTS) {
    for (const { name } of TRACKED_FLAGS) {
      const key = {
        sourceType: FLAG_SOURCE,
        environment,
        entityType: "feature_flag",
        entityId: name,
      };
      const latest = await getLatestSnapshot(db, key);
      const good = await getLatestGoodSnapshot(db, key);
      if (!latest && !good) continue; // Nothing has ever been observed for this flag here.
      flags.push({
        key: name,
        environment,
        // The last KNOWN GOOD state, so an unavailable observation does not blank a real answer.
        state: (good?.status as string) ?? null,
        latestState: (latest?.status as string) ?? null,
        meta: { ...metaFrom(latest, good, FLAG_SOURCE), freshness: effectiveFreshness(latest, now) },
      });
    }
  }

  /* ── Gates ─────────────────────────────────────────────────────────────────────────────── */
  const stagingApp = applications.find((a) => a.environment === "staging") ?? null;
  const productionApp = applications.find((a) => a.environment === "production") ?? null;
  const stagingDb = databases.find((d) => d.environment === "staging") ?? null;
  /**
   * The staging flag SPECIFICALLY — `FEATURE_ENABLED_STAGING` is a question about staging.
   *
   * This used to be `flags.find(f => f.key === ...)` over an unscoped list, so whichever
   * environment happened to be observed most recently answered it.
   */
  const pcFlag =
    flags.find((f) => f.key === "SUPER_ADMIN_PROJECT_CONTROL_ENABLED" && f.environment === "staging") ?? null;

  const observation = (
    source: string,
    satisfied: boolean,
    meta: EvidenceMeta | null,
    detail?: string
  ): GateObservation | null =>
    meta && meta.freshness
      ? { source, satisfied, freshness: meta.freshness, observedAt: meta.observedAt, detail: detail ?? null }
      : null;

  const gateResults: GateResult[] = [
    resolveGate("AUTHORED", observation(GITHUB_SOURCE, Boolean(repository.mainSha), repository.meta)),
    /**
     * MERGED is UNKNOWN, and that is the honest answer rather than a missing feature.
     *
     * It used to be the BYTE-IDENTICAL observation to AUTHORED above — `Boolean(repository.mainSha)`
     * — so every repository that has a default branch at all satisfied "merged", permanently, with
     * no pull request, no ancestry and no branch involved.
     *
     * The reason it cannot be answered here is structural: `buildComposedOverview(db, now)` takes no
     * work package and never reads `pc_work_packages`. There is no "this work" whose merge could be
     * asserted — the gate array is programme-wide. Answering a per-branch question from a repo-wide
     * fact is precisely the category error this module exists to prevent.
     *
     * `isBranchMerged` (shared/project-control-github.ts) is the correct implementation and
     * deliberately refuses the optimistic reading. Wiring it needs a package-to-branch mapping and
     * per-package gate evaluation, neither of which exists yet. Until then UNKNOWN, matching the
     * CI_PASSED precedent below: "we did not establish this", never "it is fine".
     */
    resolveGate("MERGED", null),
    // CI evidence is collected but not yet mapped to a package, so this is honestly UNKNOWN
    // rather than optimistically satisfied.
    resolveGate("CI_PASSED", null),
    /**
     * MIGRATION_AUTHORED is UNKNOWN for the same structural reason.
     *
     * It used to read `(stagingDb?.appliedCount ?? 0) >= 0` — an expression that is true for every
     * possible value, since appliedCount is a non-negative integer or null coalescing to 0. The
     * gate was satisfied by a database with zero migrations applied and zero migration files
     * authored, and it had no test of any kind.
     *
     * It was also answered by the wrong authority: "has a migration been WRITTEN" is a question
     * about the repository, and it was being answered from the database ledger. `migrationFilesTouched`
     * (shared/project-control-github.ts) is the function built to answer it properly, and it needs a
     * package-to-migration mapping that does not exist in the schema, the manifest or the work-package
     * table. Authored is also not applied — MIGRATION_APPLIED_STAGING below is a separate question
     * and keeps its own real evidence.
     */
    resolveGate("MIGRATION_AUTHORED", null),
    resolveGate(
      "MIGRATION_APPLIED_STAGING",
      observation(
        DATABASE_SOURCE,
        stagingDb?.pendingCount === 0,
        stagingDb?.meta ?? null,
        stagingDb?.pendingCount ? `${stagingDb.pendingCount} migration(s) not applied.` : undefined
      )
    ),
    resolveGate("DEPLOYED_STAGING", observation(APPLICATION_SOURCE, Boolean(stagingApp?.commit), stagingApp?.meta ?? null)),
    resolveGate(
      "FEATURE_ENABLED_STAGING",
      observation(
        FLAG_SOURCE,
        pcFlag?.state === "enabled",
        pcFlag?.meta ?? null,
        // `absent` and `disabled_explicit` reach the operator intact rather than collapsing into
        // one indistinguishable "not satisfied". The remedies differ: set it, versus revisit the
        // decision to turn it off.
        pcFlag
          ? `Flag state in staging: ${pcFlag.state ?? "unknown"}.` +
            (pcFlag.latestState && pcFlag.latestState !== pcFlag.state
              ? ` Latest observation was ${pcFlag.latestState}; showing last known good.`
              : "")
          : "No flag evidence has been recorded for staging."
      )
    ),
    // Human verification has no machine evidence source. It is UNKNOWN until somebody records it,
    // and no amount of green machine evidence may satisfy it.
    resolveGate("VERIFIED_STAGING", null),
    resolveGate(
      "DEPLOYED_PRODUCTION",
      observation(APPLICATION_SOURCE, Boolean(productionApp?.commit), productionApp?.meta ?? null)
    ),
    resolveGate("VERIFIED_PRODUCTION", null),
  ];

  const contradictions = detectContradictions({
    repositoryHeadSha: repository.mainSha,
    repositoryKnown: Boolean(repository.mainSha),
    stagingCommit: stagingApp?.commit ?? null,
    stagingKnown: Boolean(stagingApp?.meta.observedAt),
    productionCommit: productionApp?.commit ?? null,
    productionKnown: Boolean(productionApp?.meta.observedAt),
    migrationsPending: stagingDb?.pendingCount ?? null,
    databaseKnown: Boolean(stagingDb?.meta.observedAt),
    // Tri-state: null means "we have no staging flag evidence", which is not the same as "off".
    projectControlFlagEnabled: pcFlag ? pcFlag.state === "enabled" : null,
    flagsKnown: flags.length > 0,
  });

  const readiness = computeGateReadiness(gateResults, contradictions);
  const summary = summariseGates(gateResults);

  const staleSources = collectSources(gateResults, "STALE");
  const unknownSources = collectSources(gateResults, "UNKNOWN");
  const unavailableSources = collectSources(gateResults, "UNAVAILABLE");

  const highest = contradictions.find((c) => c.severity === "high") ?? contradictions[0] ?? null;

  return {
    generatedAt: now.toISOString(),
    repository,
    applications,
    databases,
    flags,
    gates: gateResults,
    readiness,
    contradictions,
    executive: {
      currentGate: summary.reached,
      nextGate: summary.next,
      highestBlocker: highest ? highest.summary : null,
      nextRecommendedAction: recommendAction(summary.next, contradictions, repository),
      deploymentAligned: deploymentAlignment(repository.mainSha, stagingApp?.commit ?? null),
    },
    integrity: {
      staleSources,
      unknownSources,
      unavailableSources,
      contradictionCount: contradictions.length,
    },
  };
}

/** The repository entity id is the configured repo; find whichever one has evidence. */
async function getLatestSnapshotForAnyRepo(db: EvidenceDb): Promise<StoredSnapshot | null> {
  const res = await db.query(
    `SELECT * FROM pc_evidence_snapshots
      WHERE source_type=$1 AND entity_type='repository'
      ORDER BY observed_at DESC, id DESC LIMIT 1`,
    [GITHUB_SOURCE]
  );
  if (!res.rows.length) return null;
  const row = res.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    sourceType: row.source_type as string,
    environment: (row.environment as string) ?? null,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    commitSha: (row.commit_sha as string) ?? null,
    status: (row.status as string) ?? null,
    freshness: row.freshness as StoredSnapshot["freshness"],
    confidence: row.confidence as string,
    validUntil: (row.valid_until as Date) ?? null,
    payload: row.payload,
    payloadDigest: row.payload_digest as string,
    observedAt: row.observed_at as Date,
    syncId: (row.sync_id as string) ?? null,
    staleReason: (row.stale_reason as string) ?? null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function collectSources(results: GateResult[], state: GateResult["state"]): string[] {
  return [...new Set(results.filter((r) => r.state === state && r.source).map((r) => r.source as string))];
}

/** Tri-state: null when either side is unknown, never a false "not aligned". */
function deploymentAlignment(head: string | null, deployed: string | null): boolean | null {
  if (!head || !deployed) return null;
  const shorter = head.length <= deployed.length ? head : deployed;
  const longer = head.length <= deployed.length ? deployed : head;
  if (shorter.length < 7) return null;
  return longer.toLowerCase().startsWith(shorter.toLowerCase());
}

/** The one thing an operator should do next. A high-severity contradiction always outranks a gate. */
function recommendAction(next: Gate | null, contradictions: Contradiction[], repo: RepositorySection): string {
  const high = contradictions.find((c) => c.severity === "high");
  if (high) return `Resolve the contradiction: ${high.summary}`;
  if (!repo.meta.observedAt) return "Run a GitHub refresh — no repository evidence has been collected yet.";
  if (!next) return "All tracked gates are satisfied. Record verification evidence to confirm.";
  return `Advance the next gate: ${next}.`;
}
