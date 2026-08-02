/**
 * Project Control — the distributed Partner Shop programme view assembler.
 *
 * This module OBSERVES; it does not decide. It gathers machine facts (git refs, the
 * schema_migrations ledger, recorded gates, recorded deployments), hands them to the pure
 * derivation rules in `@shared/project-control-distributed`, and then hands the resulting
 * synthetic work packages to the ALREADY-APPROVED readiness engine.
 *
 * It deliberately adds NO scoring maths. The ten category weights, the confidence multiplier and
 * every hard cap (49 security / 69 review / 69 contradictory / 79 blocked / 99 not-production-
 * verified) come from `project-control-readiness.ts` unchanged, which is why a lane cannot be
 * made to look finished by editing this file.
 *
 * STRICTLY READ-ONLY: no INSERT, no UPDATE, no git mutation. The initial dashboard is a mirror.
 */
import { desc } from "drizzle-orm";
import { db } from "../db";
import { pcDeployments, pcTestRuns } from "@shared/schema";
import {
  DISTRIBUTED_LANES,
  buildLaneBlockers,
  buildLaneEvidence,
  countPassingTestEvidence,
  deriveLaneStatus,
  type LaneDefinition,
  type LaneFacts,
  type ObservedMigration,
  type ObservedTestRun,
} from "@shared/project-control-distributed";
import { aggregateReadiness, type Readiness } from "@shared/project-control-readiness";
import { assessWorkPackage } from "@shared/project-control";
import type { WorkPackage } from "@shared/project-control-types";
import { countCommitsAhead, scanRepository } from "./repo-scan";
import { scanMigrationLedger } from "./migration-scan";

/* ------------------------------------------------------------------------------------------ */
/* Output shape                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface LaneView {
  key: string;
  title: string;
  description: string;
  status: string;
  risk: string;
  readiness: Readiness;
  confidence: string;
  /** The branch that actually resolved, plus its ACTUAL head — detected, never quoted. */
  branch: string | null;
  headCommit: string | null;
  headCommitShort: string | null;
  headSubject: string | null;
  headCommittedAt: string | null;
  commitsAheadOfMain: number;
  mergedIntoMain: boolean;
  migrations: ObservedMigration[];
  testEvidence: { passed: number; failed: number; discardedSkipped: number; runs: ObservedTestRun[] };
  deployedEnvironments: string[];
  productionVerifiedEnvironments: string[];
  blockers: { kind: string; description: string; openedAt: string }[];
}

export interface DistributedProgrammeView {
  generatedAt: string;
  /** Which database answered the migration questions. */
  environment: string;
  mainSha: string | null;
  /** Overall distributed Partner Shop Launch readiness — computed, never hard-coded. */
  readiness: Readiness;
  /** MVGS Server Authority, promoted to a headline figure because the owner tracks it separately. */
  mvgsAuthority: { readiness: Readiness; lane: LaneView | null };
  lanes: LaneView[];
  blockers: { laneKey: string; laneTitle: string; kind: string; description: string; openedAt: string }[];
  nextRecommendedTask: { laneKey: string; laneTitle: string; headline: string; detail: string } | null;
  continuationPrompt: string;
  /** Everything the scan could not establish. Surfaced, never swallowed. */
  warnings: string[];
}

/* ------------------------------------------------------------------------------------------ */
/* Fact gathering                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Resolve a lane's branch by trying each candidate in order and taking the first that EXISTS.
 *
 * This is the mechanism that satisfies "detect the actual branch head" — a commit quoted in a
 * prompt is never consulted, and a branch that has advanced since the prompt was written is
 * picked up automatically.
 */
function resolveBranch(
  lane: LaneDefinition,
  branches: { name: string; commit: string; subject: string; committedAt: string; mergedIntoMain: boolean }[]
) {
  for (const candidate of lane.branchCandidates) {
    const found = branches.find((b) => b.name === candidate);
    if (found) return found;
  }
  return null;
}

async function gatherLaneFacts(
  lane: LaneDefinition,
  repo: Awaited<ReturnType<typeof scanRepository>>,
  ledgerMigrations: ObservedMigration[],
  testRuns: ObservedTestRun[],
  deployments: { commitSha: string; environment: string; result: string; verifiedAt: Date | null }[]
): Promise<LaneFacts> {
  const branch = resolveBranch(lane, repo.branches);

  const commitsAheadOfMain = branch ? await countCommitsAhead(branch.name) : 0;

  const migrations = ledgerMigrations.filter((m) => lane.migrationNumbers.includes(m.number));

  const laneTests = testRuns.filter((r) =>
    lane.testMatchers.some((matcher) => r.name.toLowerCase().includes(matcher.toLowerCase()))
  );

  // RULE 3: a deployment only counts for this lane when it carries THIS lane's head commit.
  // A staging release of some other branch proves nothing about this one.
  const laneDeployments = branch
    ? deployments.filter((d) => d.commitSha === branch.commit && d.result === "succeeded")
    : [];

  const deployedEnvironments = [...new Set(laneDeployments.map((d) => d.environment))].sort();
  const productionVerifiedEnvironments = [
    ...new Set(laneDeployments.filter((d) => d.verifiedAt !== null && d.environment === "production").map((d) => d.environment)),
  ].sort();

  return {
    lane,
    branch: branch?.name ?? null,
    headCommit: branch?.commit ?? null,
    headSubject: branch?.subject ?? null,
    headCommittedAt: branch?.committedAt ?? null,
    commitsAheadOfMain,
    mergedIntoMain: branch?.mergedIntoMain ?? false,
    migrations,
    testRuns: laneTests,
    deployedEnvironments,
    productionVerifiedEnvironments,
  };
}

/**
 * Build the synthetic work package the readiness engine grades.
 *
 * It is synthetic on purpose: these lanes are a live reflection of the repository, not rows an
 * operator maintains by hand, so there is nothing to drift out of date. Acceptance criteria are
 * left empty rather than invented — an empty criteria set scores `not_started` for requirements,
 * which is the honest answer when no criteria have been agreed.
 */
function toWorkPackage(facts: LaneFacts, now: Date): WorkPackage {
  const status = deriveLaneStatus(facts);
  const evidence = buildLaneEvidence(facts, now);
  const blockers = buildLaneBlockers(facts, now);

  return {
    id: facts.lane.key,
    nodeKey: "distributed-partner-shop",
    key: facts.lane.key,
    title: facts.lane.title,
    summary: facts.lane.description,
    status,
    // Declared completion is deliberately NOT a free parameter: it mirrors the derived status so
    // no one can inflate the number by declaring a lane 90% done.
    declaredCompletion: 0,
    risk: facts.lane.risk,
    classification: "C",
    // "not_started", never "not_required": a distributed-programme lane always needs review, and
    // "not_required" would score the review category as complete for free.
    reviewState: "not_started",
    deploymentState: facts.deployedEnvironments.includes("production")
      ? "production"
      : facts.deployedEnvironments.length > 0
        ? "staging"
        : "not_deployed",
    productionVerification: facts.productionVerifiedEnvironments.length > 0 ? "verified" : "not_verified",
    businessValue: 3,
    engineeringRisk: 3,
    branch: facts.branch,
    latestCommit: facts.headCommit,
    version: 1,
    updatedAt: now.toISOString(),
    evidence,
    blockers,
    dependsOn: [],
    acceptanceCriteria: [],
    requiredTests: [],
    categoryStates: {},
    categoryNotes: null,
    tags: ["distributed-partner-shop"],
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Assembly                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * The order in which an unfinished lane should be picked up.
 *
 * Lower is more urgent. This encodes the dependency reality of the programme: server-side grading
 * authority and the device/image trust chain must exist before a partner-operated grading station
 * means anything, and nothing can be piloted before corrections and quality exist.
 */
const LANE_PRIORITY: Record<string, number> = {
  "dsp-wave1": 0,
  "dsp-mvgs-authority": 1,
  "dsp-device-registry": 2,
  "dsp-image-binding": 3,
  "dsp-scanner": 4,
  "dsp-grading-station": 5,
  "dsp-credits-g6d": 6,
  "dsp-cert-print-nfc": 7,
  "dsp-corrections": 8,
  "dsp-quality": 9,
  "dsp-partner-ops-ui": 10,
  "dsp-hub-locator": 11,
  "dsp-project-control": 12,
};

export async function buildDistributedProgrammeView(
  now: Date = new Date()
): Promise<DistributedProgrammeView> {
  const warnings: string[] = [];

  const [repo, ledger] = await Promise.all([scanRepository(), scanMigrationLedger()]);
  warnings.push(...repo.warnings, ...ledger.warnings);

  // Recorded gates and releases. Both reads are bounded and read-only.
  const [testRows, deploymentRows] = await Promise.all([
    db
      .select({
        packageKey: pcTestRuns.packageKey,
        kind: pcTestRuns.kind,
        result: pcTestRuns.result,
        commitSha: pcTestRuns.commitSha,
        detail: pcTestRuns.detail,
        ranAt: pcTestRuns.ranAt,
      })
      .from(pcTestRuns)
      .orderBy(desc(pcTestRuns.ranAt))
      .limit(500),
    db
      .select({
        commitSha: pcDeployments.commitSha,
        environment: pcDeployments.environment,
        result: pcDeployments.result,
        verifiedAt: pcDeployments.verifiedAt,
      })
      .from(pcDeployments)
      .orderBy(desc(pcDeployments.deployedAt))
      .limit(500),
  ]);

  const testRuns: ObservedTestRun[] = testRows.map((r) => ({
    // The matcher searches package key, gate kind and detail together, so a gate recorded against
    // either a package or a free-text description still finds its lane.
    name: `${r.packageKey ?? ""} ${r.kind} ${r.detail}`.trim(),
    kind: r.kind,
    result: (["passed", "failed", "skipped", "not_run"].includes(r.result) ? r.result : "not_run") as ObservedTestRun["result"],
    ranAt: (r.ranAt instanceof Date ? r.ranAt : new Date(r.ranAt as unknown as string)).toISOString(),
    commitSha: r.commitSha,
  }));

  const deployments = deploymentRows.map((d) => ({
    commitSha: d.commitSha,
    environment: d.environment,
    result: d.result,
    verifiedAt: d.verifiedAt instanceof Date ? d.verifiedAt : d.verifiedAt ? new Date(d.verifiedAt as unknown as string) : null,
  }));

  const lanes: LaneView[] = [];
  const graded: { pkg: WorkPackage; readiness: Readiness }[] = [];

  for (const lane of [...DISTRIBUTED_LANES].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const facts = await gatherLaneFacts(lane, repo, ledger.migrations, testRuns, deployments);
    const pkg = toWorkPackage(facts, now);

    /**
     * The SAME assessor the rest of the dashboard uses. Going through `assessWorkPackage` rather
     * than calling the readiness engine directly is deliberate: it also applies the anti-inflation
     * downgrades (blocked-overrides-status, production-verified-without-evidence), so a lane
     * cannot present a better status than its evidence supports.
     */
    const assessment = assessWorkPackage(pkg, now);
    const readiness = assessment.readiness;

    graded.push({ pkg, readiness });

    const gates = countPassingTestEvidence(facts.testRuns);

    lanes.push({
      key: lane.key,
      title: lane.title,
      description: lane.description,
      // The EFFECTIVE status — what the evidence supports, not what the ladder proposed.
      status: assessment.effectiveStatus,
      risk: lane.risk,
      readiness,
      confidence: assessment.confidence,
      branch: facts.branch,
      headCommit: facts.headCommit,
      headCommitShort: facts.headCommit ? facts.headCommit.slice(0, 8) : null,
      headSubject: facts.headSubject,
      headCommittedAt: facts.headCommittedAt,
      commitsAheadOfMain: facts.commitsAheadOfMain,
      mergedIntoMain: facts.mergedIntoMain,
      migrations: facts.migrations,
      testEvidence: { ...gates, runs: facts.testRuns },
      deployedEnvironments: facts.deployedEnvironments,
      productionVerifiedEnvironments: facts.productionVerifiedEnvironments,
      blockers: pkg.blockers.map((b) => ({
        kind: b.kind,
        description: b.description,
        openedAt: b.openedAt,
      })),
    });
  }

  const readiness = aggregateReadiness(graded);

  const mvgsLane = lanes.find((l) => l.key === "dsp-mvgs-authority") ?? null;
  const mvgsGraded = graded.filter((g) => g.pkg.key === "dsp-mvgs-authority");
  const mvgsAuthority = { readiness: aggregateReadiness(mvgsGraded), lane: mvgsLane };

  const blockers = lanes.flatMap((l) =>
    l.blockers.map((b) => ({
      laneKey: l.key,
      laneTitle: l.title,
      kind: b.kind,
      description: b.description,
      openedAt: b.openedAt,
    }))
  );

  const nextRecommendedTask = chooseNextTask(lanes);
  const continuationPrompt = buildContinuationPrompt({
    generatedAt: now.toISOString(),
    environment: ledger.environment,
    mainSha: repo.mainSha,
    readiness,
    lanes,
    nextRecommendedTask,
  });

  return {
    generatedAt: now.toISOString(),
    environment: ledger.environment,
    mainSha: repo.mainSha,
    readiness,
    mvgsAuthority,
    lanes,
    blockers,
    nextRecommendedTask,
    continuationPrompt,
    warnings,
  };
}

/**
 * The next recommended task.
 *
 * Preference order, and the reasoning behind it:
 *  1. A lane that has LANDED work stuck behind an unapplied migration or an unmerged branch —
 *     finishing something already built beats starting something new.
 *  2. Otherwise the highest-priority lane that is not yet production verified.
 */
function chooseNextTask(lanes: LaneView[]): DistributedProgrammeView["nextRecommendedTask"] {
  const byPriority = [...lanes].sort(
    (a, b) => (LANE_PRIORITY[a.key] ?? 99) - (LANE_PRIORITY[b.key] ?? 99)
  );

  const stuckButBuilt = byPriority.find(
    (l) => l.branch !== null && !l.mergedIntoMain && l.commitsAheadOfMain > 0
  );
  if (stuckButBuilt) {
    const unapplied = stuckButBuilt.migrations.filter((m) => !m.applied);
    return {
      laneKey: stuckButBuilt.key,
      laneTitle: stuckButBuilt.title,
      headline: `Land ${stuckButBuilt.title}`,
      detail:
        `${stuckButBuilt.branch} is ${stuckButBuilt.commitsAheadOfMain} commit(s) ahead of main at ` +
        `${stuckButBuilt.headCommitShort} and is not merged.` +
        (unapplied.length > 0
          ? ` It also carries ${unapplied.length} unapplied migration(s): ${unapplied.map((m) => m.filename).join(", ")}.`
          : "") +
        " Review, merge and deploy it before starting new lanes.",
    };
  }

  const notStarted = byPriority.find((l) => l.branch === null);
  if (notStarted) {
    return {
      laneKey: notStarted.key,
      laneTitle: notStarted.title,
      headline: `Start ${notStarted.title}`,
      detail: `${notStarted.description} No branch exists for this lane yet, so it is the next unstarted item in dependency order.`,
    };
  }

  const unverified = byPriority.find((l) => l.productionVerifiedEnvironments.length === 0);
  if (unverified) {
    return {
      laneKey: unverified.key,
      laneTitle: unverified.title,
      headline: `Verify ${unverified.title} in production`,
      detail: "Everything is merged and deployed, but no passing production check is recorded.",
    };
  }

  return null;
}

/**
 * A continuation prompt built from the observed state.
 *
 * It quotes only detected facts (branch, actual head, merge state, migration ledger state) so it
 * cannot carry a stale commit forward the way a hand-written prompt does.
 */
export function buildContinuationPrompt(input: {
  generatedAt: string;
  environment: string;
  mainSha: string | null;
  readiness: Readiness;
  lanes: LaneView[];
  nextRecommendedTask: DistributedProgrammeView["nextRecommendedTask"];
}): string {
  const lines: string[] = [];

  lines.push("Continue the MintVault distributed Partner Shop programme.");
  lines.push("");
  lines.push(`State observed ${input.generatedAt} against the ${input.environment} database.`);
  lines.push(`main is at ${input.mainSha ?? "unknown"}.`);
  lines.push(
    `Distributed Partner Shop Launch readiness: ${input.readiness.overall}% (evidence-weighted, caps applied).`
  );
  lines.push("");
  lines.push("Lane state (detected, not quoted):");

  for (const lane of input.lanes) {
    if (!lane.branch) {
      lines.push(`- ${lane.title}: not started — no branch exists.`);
      continue;
    }
    const migrationNote =
      lane.migrations.length === 0
        ? ""
        : ` migrations ${lane.migrations.map((m) => `${m.filename}=${m.applied ? "applied" : "UNAPPLIED"}`).join(", ")};`;
    lines.push(
      `- ${lane.title}: ${lane.branch} @ ${lane.headCommitShort}, ${lane.commitsAheadOfMain} ahead of main, ` +
        `${lane.mergedIntoMain ? "merged" : "NOT merged"};${migrationNote} ` +
        `${lane.testEvidence.passed} passing gate(s)${lane.testEvidence.discardedSkipped > 0 ? ` (${lane.testEvidence.discardedSkipped} skipped, not counted)` : ""}; ` +
        `${lane.readiness.overall}%.`
    );
  }

  if (input.nextRecommendedTask) {
    lines.push("");
    lines.push(`Next recommended task: ${input.nextRecommendedTask.headline}`);
    lines.push(input.nextRecommendedTask.detail);
  }

  lines.push("");
  lines.push("Constraints: work in an isolated worktree and branch. Do not merge or deploy without");
  lines.push("owner approval. Do not modify protected MVGS grading files. Do not renumber migrations.");

  return lines.join("\n");
}

/** Exported for tests: the priority map is programme policy, so it is asserted rather than assumed. */
export { LANE_PRIORITY, chooseNextTask };
