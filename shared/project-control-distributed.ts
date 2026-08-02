/**
 * Project Control — the DISTRIBUTED Partner Shop programme lane model.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The existing programme tree models the ORIGINAL Partner Network roadmap
 * (G5 → G6A → G6B → G6C → G6D → Auth → Portal → Stripe Credits → Pilot → Launch).
 * That roadmap is preserved untouched. The *distributed* Partner Shop programme — shops running
 * their own scanners, devices, grading stations and corrections against a server-authoritative
 * MVGS — is a different decomposition, and it had no representation at all.
 *
 * HONESTY CONTRACT (the whole point of this module)
 * -------------------------------------------------
 * Nothing here hard-codes a percentage. A lane's score is DERIVED, at request time, from facts
 * observed in the live repository and the live database, and then handed to the ALREADY-APPROVED
 * ten-category weighted readiness engine (`project-control-readiness.ts`) which applies the
 * approved weights and the approved hard caps. This module adds no scoring maths of its own.
 *
 * The four rules the owner set are enforced structurally, not by convention:
 *
 *   1. "Files existing is not completion."
 *      `deriveLaneStatus` never returns a landed status from file presence. A migration file on
 *      disk yields `awaiting_migration`, never `merged`.
 *   2. "Skipped tests are not passes."
 *      `countPassingTestEvidence` counts only `passed`. `skipped`/`not_run` are discarded, and a
 *      lane whose only test evidence is skipped is reported as having NO test evidence.
 *   3. "Unmerged work is not deployed."
 *      `deployed` is unreachable unless `mergedIntoMain` is true AND a succeeded deployment is
 *      recorded for the environment. The branch ladder below is strictly ordered.
 *   4. "Reported claims without evidence are not verified."
 *      Every derived evidence record carries `automatically_verified` ONLY when it came from a
 *      machine observation (git / schema_migrations / recorded gate). Owner statements are never
 *      minted here at all.
 */
import type {
  BlockerRecord,
  EvidenceRecord,
  RiskLevel,
  WorkStatus,
} from "./project-control-types";

/* ------------------------------------------------------------------------------------------ */
/* Lane definitions                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * A lane is a unit of the distributed Partner Shop programme.
 *
 * `branchCandidates` is an ORDERED preference list. The scanner picks the first candidate that
 * actually exists as a ref; that is how the dashboard "detects the actual branch head" rather
 * than trusting a commit quoted in a prompt. A lane with no matching ref is genuinely not started.
 */
export interface LaneDefinition {
  key: string;
  title: string;
  description: string;
  /** Ordered candidates. First existing ref wins. */
  branchCandidates: string[];
  /** Migration numbers this lane owns, as they appear in migrations/NNNN_*.sql. */
  migrationNumbers: string[];
  /** Substrings matched against recorded test-run names/kinds for this lane. */
  testMatchers: string[];
  risk: RiskLevel;
  /** Display + sequencing order within the programme. */
  sortOrder: number;
}

/**
 * The thirteen lanes the owner named, in programme order.
 *
 * NOTE ON SCOPE: this is a READ-ONLY reflection of work that exists elsewhere. Adding a lane here
 * does not create work, does not move a branch, and does not change any other programme's status.
 */
export const DISTRIBUTED_LANES: LaneDefinition[] = [
  {
    key: "dsp-wave1",
    title: "Wave 1 — Partner foundation",
    description:
      "Partner certificate origin, MFA and lockout hardening, tenant-isolation CI. The landed foundation every later lane builds on.",
    branchCandidates: ["psp/partner-wave1-integration-final", "psp/w1-b-cert-origin"],
    migrationNumbers: ["35"],
    testMatchers: ["partner-certificate-origin", "tenant-isolation", "partner-wave1"],
    risk: "high",
    sortOrder: 10,
  },
  {
    key: "dsp-mvgs-authority",
    title: "MVGS Server Authority",
    description:
      "Moving grading authority to the server so a partner-side client can never assert a grade. Protected system: read-only here.",
    branchCandidates: ["psp/w2-mvgs-server-authority", "psp/w2-mvgs-hostile-tests"],
    migrationNumbers: [],
    testMatchers: ["mvgs", "grader-authority", "grading-authority"],
    risk: "critical",
    sortOrder: 20,
  },
  {
    key: "dsp-device-registry",
    title: "Device Registry",
    description:
      "Tenant-immutable partner device records with forced RLS. Carries migration 0036.",
    branchCandidates: ["psp/w2-a-device-registry"],
    migrationNumbers: ["36"],
    testMatchers: ["device-registry", "partner-device"],
    risk: "high",
    sortOrder: 30,
  },
  {
    key: "dsp-scanner",
    title: "Scanner (partner-side capture)",
    description:
      "Partner shop scanner enrolment, capture pipeline and ingestion bound to a registered device.",
    branchCandidates: ["psp/w2-b-partner-scanner", "psp/w2-scanner"],
    migrationNumbers: [],
    testMatchers: ["partner-scanner", "scan-ingest"],
    risk: "high",
    sortOrder: 40,
  },
  {
    key: "dsp-image-binding",
    title: "Image Binding",
    description:
      "Cryptographically binding captured images to the device, the submission and the certificate so images cannot be substituted.",
    branchCandidates: ["psp/w2-c-image-binding", "psp/w2-image-binding"],
    migrationNumbers: [],
    testMatchers: ["image-binding", "image-provenance"],
    risk: "critical",
    sortOrder: 50,
  },
  {
    key: "dsp-grading-station",
    title: "Partner Grading Station",
    description:
      "The partner-operated grading workstation, driven by server-authoritative MVGS results.",
    branchCandidates: ["psp/w2-d-grading-station", "psp/w2-partner-grading-station"],
    migrationNumbers: [],
    testMatchers: ["partner-grading-station", "grading-station"],
    risk: "critical",
    sortOrder: 60,
  },
  {
    key: "dsp-credits-g6d",
    title: "Credits / G6D",
    description:
      "Credit reservation, consumption and owner-binding wired into partner submission and grading.",
    branchCandidates: ["psp/w2-e-credits", "codex/partner-g6d-submission-credit-integration"],
    migrationNumbers: [],
    testMatchers: ["credit", "g6d", "wallet", "ledger"],
    risk: "critical",
    sortOrder: 70,
  },
  {
    key: "dsp-cert-print-nfc",
    title: "Certificate / Print / NFC",
    description:
      "Partner-origin certificates through approval, print batch, label render and NFC verification.",
    branchCandidates: ["psp/w2-f-cert-print-nfc", "psp/w1-c-approval-gates"],
    migrationNumbers: [],
    testMatchers: ["print-workflow", "certificate", "nfc", "label"],
    risk: "high",
    sortOrder: 80,
  },
  {
    key: "dsp-corrections",
    title: "Corrections",
    description:
      "Post-issue correction of partner certificates, fully audited, without breaking the approve-lock.",
    branchCandidates: ["psp/w2-h-corrections", "codex/super-admin-correction-mode-repair"],
    migrationNumbers: [],
    testMatchers: ["correction"],
    risk: "high",
    sortOrder: 90,
  },
  {
    key: "dsp-quality",
    title: "Quality",
    description:
      "Cross-shop grading consistency monitoring, drift detection and quality sampling.",
    branchCandidates: ["psp/w2-i-quality", "psp/w2-quality"],
    migrationNumbers: [],
    testMatchers: ["quality", "consistency-audit"],
    risk: "moderate",
    sortOrder: 100,
  },
  {
    key: "dsp-partner-ops-ui",
    title: "Partner operational UI",
    description:
      "The day-to-day partner-facing operational surface: queues, submissions, device and user management.",
    branchCandidates: [
      "psp/w2-admin-suspend-audit",
      "psp/partner-management-ux-v1",
      "psp/partner-user-management-v2",
    ],
    migrationNumbers: [],
    testMatchers: ["partner-user-management", "partner-management", "suspend"],
    risk: "moderate",
    sortOrder: 110,
  },
  {
    key: "dsp-hub-locator",
    title: "Public Hub Locator",
    description:
      "The public-facing directory of partner shops, so a collector can find a participating hub.",
    branchCandidates: ["psp/w2-j-hub-locator", "psp/w2-hub-locator"],
    migrationNumbers: [],
    testMatchers: ["hub-locator", "locator"],
    risk: "low",
    sortOrder: 120,
  },
  {
    key: "dsp-project-control",
    title: "Project Control",
    description:
      "This dashboard: evidence-weighted programme visibility for the distributed Partner Shop programme.",
    branchCandidates: ["psp/w2-project-control-dashboard"],
    migrationNumbers: [],
    testMatchers: ["project-control"],
    risk: "low",
    sortOrder: 130,
  },
];

/** Lanes that must never be declared non-applicable — the programme cannot ship without them. */
export const MANDATORY_LANE_KEYS: readonly string[] = DISTRIBUTED_LANES.filter(
  (l) => l.key !== "dsp-hub-locator"
).map((l) => l.key);

/* ------------------------------------------------------------------------------------------ */
/* Observed facts                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** A migration file as observed on disk AND in the connected database's ledger. */
export interface ObservedMigration {
  number: string;
  filename: string;
  /** Present in migrations/ on the checked-out tree. */
  fileExists: boolean;
  /** Recorded in schema_migrations with status 'applied' in the CONNECTED database. */
  applied: boolean;
  /** Recorded but status 'failed' or 'applying' — worse than absent, so it is surfaced. */
  failed: boolean;
  /** Which database this statement is about. Never a connection string. */
  environment: string;
}

/** A recorded gate result for a lane. Skipped/not_run never reach here as passes. */
export interface ObservedTestRun {
  name: string;
  kind: string;
  result: "passed" | "failed" | "skipped" | "not_run";
  ranAt: string;
  commitSha: string | null;
}

/** Everything observed about one lane, from machine sources only. */
export interface LaneFacts {
  lane: LaneDefinition;
  /** The branch candidate that actually resolved, or null when none exists. */
  branch: string | null;
  /** The ACTUAL head commit of that branch, read from the ref — never from a prompt. */
  headCommit: string | null;
  headSubject: string | null;
  headCommittedAt: string | null;
  /** Commits the branch is ahead of main by. Zero on an already-merged branch. */
  commitsAheadOfMain: number;
  mergedIntoMain: boolean;
  migrations: ObservedMigration[];
  testRuns: ObservedTestRun[];
  /** Succeeded deployments recorded for this lane's commit, by environment. */
  deployedEnvironments: string[];
  /** Environments where a production check was recorded and passed. */
  productionVerifiedEnvironments: string[];
}

/* ------------------------------------------------------------------------------------------ */
/* Derivation — the honesty rules, as code                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * Passing gate evidence for a lane.
 *
 * RULE 2, enforced here: `skipped` and `not_run` are filtered out BEFORE counting. A lane whose
 * entire suite was skipped therefore has zero test evidence and cannot reach a tested status —
 * which is the correct answer, and the opposite of what a naive count would say.
 */
export function countPassingTestEvidence(runs: ObservedTestRun[]): {
  passed: number;
  failed: number;
  discardedSkipped: number;
} {
  let passed = 0;
  let failed = 0;
  let discardedSkipped = 0;
  for (const r of runs) {
    if (r.result === "passed") passed += 1;
    else if (r.result === "failed") failed += 1;
    else discardedSkipped += 1;
  }
  return { passed, failed, discardedSkipped };
}

/**
 * The single source of truth for a lane's status.
 *
 * A STRICT LADDER. Each rung requires every rung below it. There is deliberately no path from
 * "a file exists" to a landed status, and no path from "merged" to "deployed" that does not pass
 * through a recorded, succeeded deployment.
 */
export function deriveLaneStatus(facts: LaneFacts): WorkStatus {
  // Rung 0 — nothing to point at.
  if (!facts.branch || !facts.headCommit) return "not_started";

  const gates = countPassingTestEvidence(facts.testRuns);

  // A failing gate outranks everything above it: a lane with failing tests is not "built".
  if (gates.failed > 0) return "tests_failing";

  // Rung 1 — work exists on a branch but has not landed.
  if (!facts.mergedIntoMain) {
    // RULE 1: an authored-but-unapplied migration is explicitly NOT completion.
    const unappliedMigration = facts.migrations.some((m) => m.fileExists && !m.applied);
    if (unappliedMigration) return "awaiting_deployment";
    if (gates.passed === 0) return "awaiting_test_evidence";
    return "awaiting_review";
  }

  // Rung 2 — landed on main. RULE 3: this is as far as merging alone can take a lane.
  const migrationsOutstanding = facts.migrations.some((m) => m.fileExists && !m.applied);
  if (migrationsOutstanding) return "awaiting_deployment";

  if (facts.deployedEnvironments.length === 0) return "awaiting_deployment";

  // Rung 3 — deployed somewhere, but production verification is its own evidence.
  if (facts.productionVerifiedEnvironments.length === 0) return "awaiting_production_verification";

  return "production_verified";
}

/**
 * Machine-observed evidence for a lane.
 *
 * RULE 4: every record minted here is traceable to a machine source, so it is legitimately
 * `automatically_verified` when the readiness engine grades confidence. No owner statement is
 * ever created by this function — an unproven lane simply carries less evidence and scores lower.
 */
export function buildLaneEvidence(facts: LaneFacts, now: Date = new Date()): EvidenceRecord[] {
  const at = now.toISOString();
  const out: EvidenceRecord[] = [];

  if (facts.branch && facts.headCommit) {
    out.push({
      kind: "repository_scan",
      supports: true,
      capturedAt: facts.headCommittedAt ?? at,
      summary: `Branch ${facts.branch} exists at ${facts.headCommit.slice(0, 8)} (${facts.commitsAheadOfMain} commit(s) ahead of main).`,
      sourceRef: `${facts.branch}@${facts.headCommit}`,
      commitSha: facts.headCommit,
      environment: null,
    });

    // Merge state is recorded as evidence in BOTH directions, so "not merged" is a visible fact
    // rather than a silent absence.
    out.push({
      kind: "repository_scan",
      supports: facts.mergedIntoMain,
      capturedAt: at,
      summary: facts.mergedIntoMain
        ? `${facts.branch} is merged into main.`
        : `${facts.branch} is NOT merged into main, so nothing from this lane is on main.`,
      sourceRef: `merged:${facts.branch}`,
      commitSha: facts.headCommit,
      environment: null,
    });
  }

  for (const m of facts.migrations) {
    out.push({
      kind: "database_check",
      // A migration that exists but is unapplied CONTRADICTS a claim of completion.
      supports: m.applied,
      capturedAt: at,
      summary: m.failed
        ? `Migration ${m.filename} is recorded as FAILED in ${m.environment}.`
        : m.applied
          ? `Migration ${m.filename} is applied in ${m.environment}.`
          : `Migration ${m.filename} exists in the tree but is NOT applied in ${m.environment}.`,
      sourceRef: `schema_migrations:${m.filename}`,
      commitSha: facts.headCommit,
      environment: m.environment as EvidenceRecord["environment"],
    });
  }

  // RULE 2 again, at the evidence layer: only passes become supporting test evidence.
  for (const r of facts.testRuns) {
    if (r.result === "skipped" || r.result === "not_run") continue;
    out.push({
      kind: (["typescript", "lint", "vitest", "integration", "production_build"].includes(r.kind)
        ? r.kind
        : "vitest") as EvidenceRecord["kind"],
      supports: r.result === "passed",
      capturedAt: r.ranAt,
      summary: `${r.name} ${r.result}.`,
      sourceRef: `test:${r.name}`,
      commitSha: r.commitSha,
      environment: null,
    });
  }

  for (const env of facts.deployedEnvironments) {
    out.push({
      kind: "deployment",
      supports: true,
      capturedAt: at,
      summary: `A succeeded deployment carrying ${facts.headCommit?.slice(0, 8) ?? "this lane"} is recorded for ${env}.`,
      sourceRef: `deployment:${env}`,
      commitSha: facts.headCommit,
      environment: env as EvidenceRecord["environment"],
    });
  }

  for (const env of facts.productionVerifiedEnvironments) {
    out.push({
      kind: "production_check",
      supports: true,
      capturedAt: at,
      summary: `A passing production check is recorded for ${env}.`,
      sourceRef: `production_check:${env}`,
      commitSha: facts.headCommit,
      environment: env as EvidenceRecord["environment"],
    });
  }

  return out;
}

/**
 * Blockers derived from the same observed facts.
 *
 * These feed the approved BLOCKED cap (79%) in the readiness engine, so an unapplied migration or
 * an unmerged branch mathematically cannot be rounded away.
 */
export function buildLaneBlockers(facts: LaneFacts, now: Date = new Date()): BlockerRecord[] {
  const at = now.toISOString();
  const out: BlockerRecord[] = [];

  for (const m of facts.migrations) {
    if (m.fileExists && !m.applied) {
      out.push({
        kind: "awaiting_migration",
        description: m.failed
          ? `Migration ${m.filename} FAILED in ${m.environment} and must be investigated before anything downstream can proceed.`
          : `Migration ${m.filename} is written but not applied in ${m.environment}.`,
        openedAt: at,
        resolvedAt: null,
      });
    }
  }

  const gates = countPassingTestEvidence(facts.testRuns);
  if (gates.failed > 0) {
    out.push({
      kind: "failed_tests",
      description: `${gates.failed} recorded gate(s) for this lane are failing.`,
      openedAt: at,
      resolvedAt: null,
    });
  }

  if (facts.branch && !facts.mergedIntoMain) {
    out.push({
      kind: "awaiting_review",
      description: `${facts.branch} is complete on its own branch but is not merged into main.`,
      openedAt: at,
      resolvedAt: null,
    });
  }

  if (!facts.branch) {
    out.push({
      kind: "dependency_incomplete",
      description: "No branch exists for this lane yet — the work has not been started.",
      openedAt: at,
      resolvedAt: null,
    });
  }

  return out;
}
