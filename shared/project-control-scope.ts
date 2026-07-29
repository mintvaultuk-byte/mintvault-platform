/**
 * Project Control — evidence scoping. THE single authoritative path.
 *
 * REMEDIATION of second-hostile-review findings H-1 and H-2.
 *
 * H-1: a `production_check` recorded against STAGING satisfied production verification, producing
 *      a warning-free 100% with no caps, no gates and no next actions.
 * H-2: `scopeEvidence()` existed but nothing in the readiness path called it, so a package at
 *      commit A reached 100% on evidence recorded entirely against commit B.
 *
 * Both are closed here, in one place, and every consumer (confidence, categories, gates, caps,
 * next actions) routes through `scopePackageEvidence`. Scoping is IDEMPOTENT, so calling it twice
 * on the same package is harmless — that is what lets it be applied defensively at every entry
 * point without double-counting rejections.
 *
 * FAIL CLOSED is the governing principle: evidence whose binding cannot be positively established
 * does not count. An honest "unproven" is always safer than an optimistic "verified".
 */
import {
  ENVIRONMENTS,
  classifyTimestamp,
  type Environment,
  type EvidenceKind,
  type EvidenceRecord,
  type WorkPackage,
} from "./project-control-types";

/* ------------------------------------------------------------------------------------------ */
/* Environment canonicalisation                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * Canonicalise an environment label.
 *
 * Returns null for anything that is not EXACTLY one of the three known environments after
 * trimming and lower-casing. `preview`, `test`, `prod`, `PRODUCTION_EU`, `""`, whitespace, and any
 * unknown string all canonicalise to null — and null never satisfies a production claim.
 *
 * Deliberately NOT fuzzy: accepting `prod` or `production-eu` as production is precisely the kind
 * of helpfulness that lets staging evidence prove a production claim.
 */
export function canonicalEnvironment(value: unknown): Environment | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  return (ENVIRONMENTS as readonly string[]).includes(normalised) ? (normalised as Environment) : null;
}

/** True only for evidence positively established as coming from production. */
export function isProductionEvidence(e: EvidenceRecord): boolean {
  return canonicalEnvironment(e.environment) === "production";
}

/* ------------------------------------------------------------------------------------------ */
/* Commit binding rules                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Evidence kinds that are COMMIT-INDEPENDENT, and why. This list is deliberately tiny: every
 * entry is a claim about something other than the built artefact, so binding it to a commit would
 * be meaningless rather than merely strict.
 *
 *  - `owner_statement`   a founder's statement of intent or status. It describes the work, not a
 *                        build, and is already capped at "Reported" confidence.
 *  - `repository_scan`   a fact about the repository as a whole (branches, worktrees, migration
 *                        files present), not about one commit's behaviour.
 *  - `database_check`    a fact about a database's schema, which no commit can own.
 *
 * EVERYTHING ELSE IS COMMIT-BOUND. A green test run, a review approval, a deployment and a
 * production check are all statements about one specific build, and none of them transfers to a
 * different commit.
 */
export const COMMIT_INDEPENDENT_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "owner_statement",
  "repository_scan",
  "database_check",
] as const;

export function isCommitBound(kind: EvidenceKind): boolean {
  return !COMMIT_INDEPENDENT_EVIDENCE_KINDS.includes(kind);
}

/** A commit identifier we are willing to compare. Fails closed on anything ambiguous. */
export function canonicalCommit(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  // A short SHA is ambiguous across a repository this size; require a recognisable hex commit.
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Do two commit identifiers refer to the same commit?
 *
 * Git abbreviations are legitimate, so a prefix match is accepted in the ONE safe direction: the
 * shorter must be a prefix of the longer, and it must be at least 7 characters. Anything else is
 * a mismatch.
 */
export function commitsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 7 && long.startsWith(short);
}

/* ------------------------------------------------------------------------------------------ */
/* Rejection reporting                                                                          */
/* ------------------------------------------------------------------------------------------ */

export const SCOPE_REJECTIONS = [
  "wrong_commit",
  "missing_commit",
  "no_release_commit",
  "wrong_environment",
  "missing_environment",
  "invalid_timestamp",
] as const;

export type ScopeRejectionCode = (typeof SCOPE_REJECTIONS)[number];

export interface ScopeRejection {
  evidence: EvidenceRecord;
  code: ScopeRejectionCode;
  reason: string;
}

export interface ScopedEvidence {
  /** Evidence that survived scoping and may be counted. */
  applicable: EvidenceRecord[];
  /** Everything refused, with a machine-readable code and a plain-English reason. */
  rejected: ScopeRejection[];
  /** Named readiness shortfalls to surface on the package. */
  shortfalls: string[];
  /** The release commit the package's evidence was scoped against, if one could be established. */
  releaseCommit: string | null;
}

/** Human-readable summary of a rejection group, used for the named shortfalls. */
const SHORTFALL_TEXT: Record<ScopeRejectionCode, (n: number) => string> = {
  wrong_commit: (n) => `${n} evidence record(s) were recorded against a different commit and do not count.`,
  missing_commit: (n) =>
    `${n} evidence record(s) carry no commit reference, so they cannot be tied to this build and do not count.`,
  no_release_commit: (n) =>
    `${n} evidence record(s) cannot be checked because this work package has no release commit recorded.`,
  wrong_environment: (n) =>
    `${n} production-verification record(s) came from a different environment and do NOT prove production.`,
  missing_environment: (n) =>
    `${n} production-verification record(s) carry no environment and do NOT prove production.`,
  invalid_timestamp: (n) => `${n} evidence record(s) had an unusable or future timestamp and were discarded.`,
};

/* ------------------------------------------------------------------------------------------ */
/* The authoritative scoper                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Evidence kinds that assert something about PRODUCTION and therefore need a production environment. */
export const PRODUCTION_ASSERTING_KINDS: readonly EvidenceKind[] = ["production_check", "deployment"] as const;

/**
 * Scope a work package's evidence.
 *
 * Applies, in order:
 *  1. timestamp validity (malformed or future evidence is not evidence);
 *  2. commit binding for every commit-bound kind;
 *  3. environment binding for every production-asserting kind.
 *
 * A record that survives all three may be counted; nothing else may.
 */
export function scopePackageEvidence(pkg: WorkPackage, now: Date = new Date()): ScopedEvidence {
  const releaseCommit = canonicalCommit(pkg.latestCommit);
  const applicable: EvidenceRecord[] = [];
  const rejected: ScopeRejection[] = [];

  for (const e of pkg.evidence) {
    // --- 1. timestamp -----------------------------------------------------------------------
    if (classifyTimestamp(e.capturedAt, now) !== "valid") {
      rejected.push({
        evidence: e,
        code: "invalid_timestamp",
        reason: "The timestamp is malformed or in the future, so this is not usable evidence.",
      });
      continue;
    }

    // --- 2. commit binding ------------------------------------------------------------------
    if (isCommitBound(e.kind)) {
      const evidenceCommit = canonicalCommit(e.commitSha);
      if (!releaseCommit) {
        rejected.push({
          evidence: e,
          code: "no_release_commit",
          reason: "This work package records no release commit, so build evidence cannot be tied to it.",
        });
        continue;
      }
      if (!evidenceCommit) {
        rejected.push({
          evidence: e,
          code: "missing_commit",
          reason: "Build evidence must name the commit it was produced against.",
        });
        continue;
      }
      if (!commitsMatch(evidenceCommit, releaseCommit)) {
        rejected.push({
          evidence: e,
          code: "wrong_commit",
          reason: `Recorded against ${evidenceCommit.slice(0, 8)}, not this package's ${releaseCommit.slice(0, 8)}.`,
        });
        continue;
      }
    }

    // --- 3. environment binding for production-asserting evidence ---------------------------
    if (PRODUCTION_ASSERTING_KINDS.includes(e.kind)) {
      const environment = canonicalEnvironment(e.environment);
      if (environment === null) {
        rejected.push({
          evidence: e,
          code: "missing_environment",
          reason: "Production evidence must name the environment it came from.",
        });
        continue;
      }
      // A staging or local deployment is still legitimate evidence THAT a deployment happened;
      // it simply cannot assert production. It is kept, and the production category checks the
      // environment again before crediting it.
    }

    applicable.push(e);
  }

  const counts = new Map<ScopeRejectionCode, number>();
  for (const r of rejected) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  const shortfalls = [...counts.entries()].map(([code, n]) => SHORTFALL_TEXT[code](n));

  // A wrong-environment production claim is the exact defect H-1 described: name it loudly.
  const wrongEnvProduction = pkg.evidence.filter(
    (e) => e.kind === "production_check" && canonicalEnvironment(e.environment) !== "production"
  ).length;
  if (wrongEnvProduction > 0) {
    shortfalls.push(
      `${wrongEnvProduction} production check(s) were not recorded in production, so production verification is NOT satisfied.`
    );
  }

  return { applicable, rejected, shortfalls, releaseCommit };
}

/**
 * Return the package with only its scoped evidence attached, plus the shortfalls.
 *
 * This is what every engine consumes. Because scoping is idempotent, applying it to an
 * already-scoped package changes nothing.
 */
export function withScopedEvidence(
  pkg: WorkPackage,
  now: Date = new Date()
): { pkg: WorkPackage; scope: ScopedEvidence } {
  const scope = scopePackageEvidence(pkg, now);
  return { pkg: { ...pkg, evidence: scope.applicable }, scope };
}
