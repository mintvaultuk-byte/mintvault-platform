/**
 * Project Control — the approved ten-category weighted readiness engine.
 *
 * REMEDIATION of hostile-review findings H1, H2 and H3.
 *
 * The previous implementation averaged four unweighted dimensions and multiplied by a confidence
 * factor. It implemented none of the approved weighting, none of the hard caps, could display
 * 100% by rounding, and could be pushed to 91% with no production verification and no warning at
 * all by declaring categories non-applicable.
 *
 * This engine:
 *  - scores the ten approved categories at their approved weights;
 *  - redistributes the weight of a genuinely non-applicable OPTIONAL category across the rest;
 *  - refuses non-applicability for the eight MANDATORY categories;
 *  - applies every approved hard cap, and NAMES each cap it applied;
 *  - floors, never rounds, so 100% is unreachable unless every input genuinely reached 100.
 */
import {
  CATEGORY_STATE_SCORE,
  CATEGORY_WEIGHTS,
  CONFIDENCE_WEIGHT,
  EVIDENCE_STALE_AFTER_DAYS,
  MANDATORY_CATEGORIES,
  OPTIONAL_CATEGORIES,
  READINESS_CATEGORIES,
  PRODUCTION_VERIFICATION_EVIDENCE_KINDS,
  REQUIREMENTS_EVIDENCE_KINDS,
  SECURITY_EVIDENCE_KINDS,
  TEST_EVIDENCE_KINDS,
  TEST_EVIDENCE_STALE_AFTER_DAYS,
  classifyTimestamp,
  floorPercent,
  hasUnresolvedHighSecurityIssue,
  openBlockers,
  type AcceptanceCriterion,
  type CategoryState,
  type EvidenceConfidence,
  type EvidenceRecord,
  type ReadinessCategory,
  type WorkPackage,
} from "./project-control-types";
import { canonicalEnvironment, scopePackageEvidence } from "./project-control-scope";

/* ------------------------------------------------------------------------------------------ */
/* Hard caps                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** An unresolved HIGH/CRITICAL security issue caps overall readiness here. */
export const CAP_UNRESOLVED_HIGH_SECURITY = 49;
/** A failed independent review caps overall readiness here. */
export const CAP_REVIEW_FAILED = 69;
/** Anything not verified in production can never read as finished. */
export const CAP_NOT_PRODUCTION_VERIFIED = 99;
/** Contradictory evidence is a stop condition, not a discount. */
export const CAP_CONTRADICTORY_EVIDENCE = 69;
/** Work recorded as blocked cannot read as nearly finished. */
export const CAP_BLOCKED = 79;

export interface AppliedCap {
  cap: number;
  reason: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Category resolution                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface CategoryAssessment {
  category: ReadinessCategory;
  state: CategoryState;
  weight: number;
  /** Weight after redistribution of non-applicable optional categories. */
  effectiveWeight: number;
  score: number;
  /** Plain-English explanation of why the category is in this state. */
  reason: string;
  /** Set when a declared not-applicable was refused. */
  overridden: boolean;
}

function freshSupporting(
  evidence: EvidenceRecord[],
  kinds: readonly string[],
  now: Date,
  staleDays: number
): { supporting: EvidenceRecord[]; contradicting: EvidenceRecord[]; stale: number; invalid: number } {
  const cutoff = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const relevant = evidence.filter((e) => kinds.includes(e.kind));
  const supporting: EvidenceRecord[] = [];
  const contradicting: EvidenceRecord[] = [];
  let stale = 0;
  let invalid = 0;

  for (const e of relevant) {
    const verdict = classifyTimestamp(e.capturedAt, now);
    // A malformed or future timestamp is NOT evidence. It is discarded, not treated as fresh.
    if (verdict !== "valid") {
      invalid += 1;
      continue;
    }
    if (!e.supports) {
      contradicting.push(e);
      continue;
    }
    if (Date.parse(e.capturedAt) < cutoff) {
      stale += 1;
      continue;
    }
    supporting.push(e);
  }
  return { supporting, contradicting, stale, invalid };
}

/* ------------------------------------------------------------------------------------------ */
/* Acceptance-criterion evidence resolution (H3-4)                                              */
/* ------------------------------------------------------------------------------------------ */

export interface CriterionResolution {
  criterion: AcceptanceCriterion;
  /** True only when the criterion is met AND its evidenceRef resolves to usable evidence. */
  counted: boolean;
  /** The evidence record it resolved to, when it resolved. */
  evidence: EvidenceRecord | null;
  /** Why it did not count. Null when it counted. */
  shortfall: string | null;
}

/** Match an evidenceRef against a record's identity. */
function referenceMatches(evidence: EvidenceRecord, ref: string): boolean {
  if (evidence.id !== undefined && evidence.id !== null && String(evidence.id) === ref) return true;
  // Derived evidence (built from deployment/test history) carries no row id, so a release version
  // or run reference is the only handle an operator has for it.
  return typeof evidence.sourceRef === "string" && evidence.sourceRef.length > 0 && evidence.sourceRef === ref;
}

/**
 * Decide, for each acceptance criterion, whether it is genuinely evidenced.
 *
 * REMEDIATION of third-hostile-review finding H3-4. Previously ANY non-empty `evidenceRef` counted,
 * so `evidenceRef: "x"` self-certified the requirements category. A reference must now resolve to
 * a real evidence record belonging to this work package, and that record must survive every check
 * the rest of the engine already applies.
 *
 * `scopedEvidence` is the package's evidence AFTER commit/environment scoping; `allEvidence` is the
 * unscoped set, used only to tell "there is no such record" apart from "the record exists but was
 * scoped out", so the shortfall message can say which.
 */
export function resolveAcceptanceCriteria(
  criteria: AcceptanceCriterion[],
  scopedEvidence: EvidenceRecord[],
  allEvidence: EvidenceRecord[],
  now: Date = new Date(),
  staleAfterDays: number = EVIDENCE_STALE_AFTER_DAYS
): CriterionResolution[] {
  const cutoff = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;

  return criteria.map((criterion) => {
    const miss = (shortfall: string): CriterionResolution => ({ criterion, counted: false, evidence: null, shortfall });

    if (!criterion.met) return miss("not yet met");

    const ref = typeof criterion.evidenceRef === "string" ? criterion.evidenceRef.trim() : "";
    if (ref.length === 0) return miss("marked met but cites no evidence");

    const match = scopedEvidence.find((e) => referenceMatches(e, ref));
    if (!match) {
      // Distinguish "never existed / belongs to someone else" from "scoped out".
      const outOfScope = allEvidence.find((e) => referenceMatches(e, ref));
      return miss(
        outOfScope
          ? "cites evidence recorded for another commit or environment"
          : "cites evidence that does not exist on this work package"
      );
    }

    if (!REQUIREMENTS_EVIDENCE_KINDS.includes(match.kind)) {
      return miss(`cites ${match.kind}, which cannot prove a requirement`);
    }
    if (!match.supports) return miss("cites evidence that contradicts the claim");
    if (classifyTimestamp(match.capturedAt, now) !== "valid") {
      return miss("cites evidence with an unusable or future timestamp");
    }
    if (Date.parse(match.capturedAt) < cutoff) {
      return miss(`cites evidence older than ${staleAfterDays} days`);
    }

    return { criterion, counted: true, evidence: match, shortfall: null };
  });
}

/** Compact, de-duplicated reason list for the category message. */
function summariseShortfalls(shortfalls: CriterionResolution[]): string {
  const seen: string[] = [];
  for (const s of shortfalls) {
    if (s.shortfall && !seen.includes(s.shortfall)) seen.push(s.shortfall);
  }
  return `${seen.slice(0, 3).join("; ")}.`;
}

/**
 * Resolve every category to a state.
 *
 * An explicitly recorded state wins EXCEPT where it would be a bypass: a mandatory category can
 * never be `not_applicable`, and `complete` is refused for tests/security/review/production when
 * the evidence does not support it.
 */
export function resolveCategories(
  rawPkg: WorkPackage,
  now: Date = new Date(),
  staleAfterDays: number = EVIDENCE_STALE_AFTER_DAYS
): CategoryAssessment[] {
  // REMEDIATION H-1/H-2: scope BEFORE any category is scored. Idempotent, so this is safe even
  // when the caller already scoped — and it means no entry point can skip it.
  const scope = scopePackageEvidence(rawPkg, now);
  const pkg: WorkPackage = { ...rawPkg, evidence: scope.applicable };
  const explicit = pkg.categoryStates ?? {};
  const results: Omit<CategoryAssessment, "effectiveWeight">[] = [];

  const push = (category: ReadinessCategory, state: CategoryState, reason: string, overridden = false) => {
    results.push({
      category,
      state,
      weight: CATEGORY_WEIGHTS[category],
      score: CATEGORY_STATE_SCORE[state],
      reason,
      overridden,
    });
  };

  /** Apply an explicit state if it is permitted, else return null and let derivation run. */
  const explicitOrNull = (category: ReadinessCategory): CategoryState | null => {
    const declared = explicit[category];
    if (!declared) return null;
    if (declared === "not_applicable" && MANDATORY_CATEGORIES.includes(category)) return null;
    return declared;
  };

  // ---- requirements: every criterion must cite evidence that actually RESOLVES ---------------
  {
    const declared = explicitOrNull("requirements");
    const criteria = pkg.acceptanceCriteria ?? [];
    if (criteria.length === 0) {
      push(
        "requirements",
        declared === "complete" ? "in_progress" : (declared ?? "not_started"),
        "No acceptance criteria recorded, so the requirement cannot be proven met.",
        declared === "complete"
      );
    } else {
      // Resolution runs against the ALREADY-SCOPED evidence set, so a criterion citing evidence
      // recorded for a different commit resolves to nothing — commit binding is inherited rather
      // than re-implemented here.
      const resolutions = resolveAcceptanceCriteria(criteria, pkg.evidence, rawPkg.evidence, now, staleAfterDays);
      const proven = resolutions.filter((r) => r.counted);
      const shortfalls = resolutions.filter((r) => !r.counted && r.criterion.met);
      const state: CategoryState =
        proven.length === criteria.length ? "complete" : proven.length > 0 ? "in_progress" : "not_started";

      const detail =
        shortfalls.length > 0
          ? `; ${shortfalls.length} marked met but not counted — ${summariseShortfalls(shortfalls)}`
          : ".";
      push(
        "requirements",
        state,
        `${proven.length}/${criteria.length} acceptance criteria met with resolvable evidence${detail}`,
        shortfalls.length > 0
      );
    }
  }

  // ---- database / backend / frontend: build categories, derived from the pipeline -------------
  for (const category of ["database", "backend", "frontend"] as const) {
    const declared = explicitOrNull(category);
    if (declared) {
      const note = pkg.categoryNotes?.[category];
      if (declared === "not_applicable" && !note) {
        push(category, "not_started", `Declared not applicable without a justification — not accepted.`, true);
      } else {
        push(category, declared, declared === "not_applicable" ? `Not applicable: ${note}` : "Recorded directly.");
      }
      continue;
    }
    const built = [
      "built",
      "built_with_known_defects",
      "awaiting_test_evidence",
      "awaiting_review",
      "ready_for_landing",
      "committed",
      "merged",
      "awaiting_deployment",
      "deployed",
      "awaiting_production_verification",
      "production_verified",
    ].includes(pkg.status);
    const started = pkg.status !== "not_started" && pkg.status !== "planned" && pkg.status !== "unknown";
    const defective = pkg.status === "built_with_known_defects" || pkg.status === "needs_fixing";
    push(
      category,
      defective ? "in_progress" : built ? "complete" : started ? "in_progress" : "not_started",
      defective
        ? "Recorded as having known defects, so the build is not complete."
        : `Derived from the recorded status.`
    );
  }

  // ---- security ------------------------------------------------------------------------------
  {
    const highOpen = hasUnresolvedHighSecurityIssue(pkg.blockers);
    const sec = freshSupporting(pkg.evidence, SECURITY_EVIDENCE_KINDS, now, staleAfterDays);
    if (highOpen) {
      push("security", "failed", "An unresolved HIGH or CRITICAL security issue is open.");
    } else if (sec.contradicting.length > 0) {
      push("security", "failed", `${sec.contradicting.length} security finding(s) contradict this work.`);
    } else if (sec.supporting.length > 0) {
      push("security", "complete", `${sec.supporting.length} current security/hostile review(s) recorded.`);
    } else if (sec.stale > 0) {
      push("security", "in_progress", `${sec.stale} security review(s) are older than ${staleAfterDays} days.`);
    } else {
      push("security", "not_started", "No security or hostile review evidence recorded.");
    }
  }

  // ---- tests ---------------------------------------------------------------------------------
  {
    const t = freshSupporting(pkg.evidence, TEST_EVIDENCE_KINDS, now, TEST_EVIDENCE_STALE_AFTER_DAYS);
    const required = pkg.requiredTests ?? [];
    const satisfied = required.filter((r) => t.supporting.some((e) => e.kind === r.kind));

    if (pkg.status === "tests_failing" || t.contradicting.length > 0) {
      push("tests", "failed", `${t.contradicting.length} recorded test run(s) failed.`);
    } else if (required.length > 0 && satisfied.length < required.length) {
      push(
        "tests",
        satisfied.length > 0 ? "in_progress" : "not_started",
        `${satisfied.length}/${required.length} required tests have a current passing run.`
      );
    } else if (t.supporting.length > 0) {
      push("tests", "complete", `${t.supporting.length} current passing gate(s) recorded.`);
    } else if (t.stale > 0) {
      // Stale tests must NOT count as current evidence.
      push(
        "tests",
        "not_started",
        `${t.stale} passing run(s) are older than ${TEST_EVIDENCE_STALE_AFTER_DAYS} days and no longer count.`
      );
    } else if (t.invalid > 0) {
      push(
        "tests",
        "not_started",
        `${t.invalid} test record(s) had an unusable or future timestamp and were discarded.`
      );
    } else {
      push("tests", "not_started", "No automated test evidence recorded.");
    }
  }

  // ---- review --------------------------------------------------------------------------------
  {
    switch (pkg.reviewState) {
      case "failed":
        push("review", "failed", "Independent review failed.");
        break;
      case "passed":
        push("review", "complete", "Independent review passed.");
        break;
      case "in_review":
        push("review", "in_progress", "Review in progress.");
        break;
      case "changes_requested":
        push("review", "in_progress", "Review returned changes.");
        break;
      case "not_required":
        // Never a free 100%: review is mandatory, so this reads as not started and is flagged.
        push("review", "not_started", "Marked not required — review is mandatory, so this scores zero.", true);
        break;
      case "not_started":
      default:
        push("review", "not_started", "No independent review recorded.");
    }
  }

  // ---- landing (commit + merge) --------------------------------------------------------------
  {
    const merged = [
      "merged",
      "awaiting_deployment",
      "deployed",
      "awaiting_production_verification",
      "production_verified",
    ].includes(pkg.status);
    const committed = pkg.status === "committed" || pkg.status === "ready_for_landing";
    push(
      "landing",
      merged ? "complete" : committed ? "in_progress" : "not_started",
      merged
        ? "Merged."
        : committed
          ? "Committed but not merged — landing contributes nothing until merged."
          : "Not committed."
    );
  }

  // ---- deployment ----------------------------------------------------------------------------
  {
    const productionDeployEvidence = pkg.evidence.some(
      (e) => e.supports && e.kind === "deployment" && canonicalEnvironment(e.environment) === "production"
    );
    const anyDeployEvidence = rawPkg.evidence.some((e) => e.kind === "deployment");
    switch (pkg.deploymentState) {
      case "production":
        // A claim of production deployment is downgraded when the only deployment evidence that
        // exists came from somewhere else — the same class of defect as H-1.
        if (!productionDeployEvidence && anyDeployEvidence) {
          push(
            "deployment",
            "in_progress",
            "Recorded as deployed to production, but no deployment evidence from production exists.",
            true
          );
        } else {
          push("deployment", "complete", "Deployed to production.");
        }
        break;
      case "staging":
        push("deployment", "in_progress", "Deployed to staging only.");
        break;
      case "rolled_back":
        push("deployment", "failed", "Last deployment was rolled back.");
        break;
      case "not_deployed":
      default:
        push("deployment", "not_started", "Not deployed — deployment contributes nothing.");
    }
  }

  // ---- production verification ---------------------------------------------------------------
  {
    /**
     * REMEDIATION H-1. Production verification counts ONLY when every one of these holds:
     *   - the evidence kind asserts production (`production_check`, or a `deployment` record);
     *   - the environment canonicalises to EXACTLY "production" — staging, local, preview, test,
     *     blank, malformed and unknown all fail;
     *   - the timestamp is valid and not in the future (already enforced by scoping);
     *   - the evidence is not stale;
     *   - it survived commit scoping (already enforced above).
     *
     * The previous implementation required no environment at all for `production_check`, so a
     * staging record satisfied production and produced a warning-free 100%.
     */
    const productionCutoff = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;

    /**
     * REMEDIATION H3-1. Only a `production_check` proves production verification. A `deployment`
     * record — however healthy, however production, however recent — proves a release happened
     * and nothing more. `evidenceFromHistory` promotes a release to `production_check` precisely
     * when it carries a `verifiedAt`, so a genuinely verified deployment still counts; an
     * unverified one never does.
     */
    const prodEvidence = pkg.evidence.filter(
      (e) =>
        e.supports &&
        PRODUCTION_VERIFICATION_EVIDENCE_KINDS.includes(e.kind) &&
        canonicalEnvironment(e.environment) === "production" &&
        Date.parse(e.capturedAt) >= productionCutoff
    );
    // Verification-kind evidence that exists but was NOT recorded in production.
    const wrongEnvironment = rawPkg.evidence.filter(
      (e) =>
        e.supports &&
        PRODUCTION_VERIFICATION_EVIDENCE_KINDS.includes(e.kind) &&
        canonicalEnvironment(e.environment) !== "production"
    );
    const staleProduction = pkg.evidence.filter(
      (e) =>
        e.supports &&
        PRODUCTION_VERIFICATION_EVIDENCE_KINDS.includes(e.kind) &&
        canonicalEnvironment(e.environment) === "production" &&
        Date.parse(e.capturedAt) < productionCutoff
    );
    // A production release with no verification is the exact H3-1 case: name it explicitly so the
    // shortfall reads as "nobody has checked", not as a missing record.
    const unverifiedProductionRelease = pkg.evidence.some(
      (e) => e.supports && e.kind === "deployment" && canonicalEnvironment(e.environment) === "production"
    );

    if (pkg.productionVerification === "failed") {
      push("production", "failed", "Production verification failed.");
    } else if (prodEvidence.length > 0 && pkg.productionVerification === "verified") {
      push("production", "complete", `${prodEvidence.length} production check(s) recorded in production.`);
    } else if (pkg.productionVerification === "verified" && wrongEnvironment.length > 0) {
      push(
        "production",
        "not_started",
        `Marked verified, but the ${wrongEnvironment.length} production record(s) came from ${[
          ...new Set(wrongEnvironment.map((e) => canonicalEnvironment(e.environment) ?? "an unnamed environment")),
        ].join(", ")} — that does NOT prove production.`,
        true
      );
    } else if (pkg.productionVerification === "verified" && staleProduction.length > 0) {
      push(
        "production",
        "not_started",
        `Marked verified, but the production check(s) are older than ${staleAfterDays} days and no longer count.`,
        true
      );
    } else if (pkg.productionVerification === "verified" && unverifiedProductionRelease) {
      push(
        "production",
        "not_started",
        "Marked verified, and a production release IS recorded, but no production check has been recorded against it — a deployment is not a verification.",
        true
      );
    } else if (pkg.productionVerification === "verified") {
      push("production", "not_started", "Marked verified but no usable production check evidence exists.", true);
    } else if (unverifiedProductionRelease) {
      push(
        "production",
        "not_started",
        "A production release is recorded but nobody has verified it. Record a production check.",
        false
      );
    } else if (pkg.productionVerification === "not_applicable") {
      push(
        "production",
        "not_started",
        "Marked not applicable — production verification is mandatory, so this scores zero.",
        true
      );
    } else {
      push("production", "not_started", "Not verified in production.");
    }
  }

  // ---- redistribute the weight of genuinely non-applicable optional categories ---------------
  const applicable = results.filter((r) => r.state !== "not_applicable");
  const nonApplicableWeight = results.filter((r) => r.state === "not_applicable").reduce((sum, r) => sum + r.weight, 0);
  const applicableWeight = applicable.reduce((sum, r) => sum + r.weight, 0);

  return results.map((r) => ({
    ...r,
    effectiveWeight:
      r.state === "not_applicable"
        ? 0
        : applicableWeight === 0
          ? 0
          : r.weight + (nonApplicableWeight * r.weight) / applicableWeight,
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Readiness                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface Readiness {
  /** Weighted score before caps. */
  rawScore: number;
  /** Final, capped, floored figure. */
  overall: number;
  /** Per-category breakdown, always all ten. */
  categories: CategoryAssessment[];
  /** Every cap that was applied, with the reason. */
  appliedCaps: AppliedCap[];
  /** Plain-English reasons overall is not 100. */
  gates: string[];
  /** The four headline dimensions, retained for the summary cards. */
  engineering: number;
  review: number;
  deployment: number;
  production: number;
  /** Confidence multiplier applied (1 = every status automatically verified). */
  confidenceMultiplier: number;
  /** Disclosed, not hidden. */
  staleAfterDays: number;
  testStaleAfterDays: number;
}

function weightedScore(categories: CategoryAssessment[]): number {
  const totalWeight = categories.reduce((s, c) => s + c.effectiveWeight, 0);
  if (totalWeight === 0) return 0;
  return categories.reduce((s, c) => s + c.score * c.effectiveWeight, 0) / totalWeight;
}

/** Readiness for a single work package. */
export function computePackageReadiness(
  pkg: WorkPackage,
  confidence: EvidenceConfidence,
  now: Date = new Date(),
  staleAfterDays: number = EVIDENCE_STALE_AFTER_DAYS
): Readiness {
  const categories = resolveCategories(pkg, now, staleAfterDays);
  const raw = weightedScore(categories);
  const multiplier = CONFIDENCE_WEIGHT[confidence];
  let score = raw * multiplier;

  const appliedCaps: AppliedCap[] = [];
  const cap = (limit: number, reason: string) => {
    if (score > limit) {
      score = limit;
      appliedCaps.push({ cap: limit, reason });
    }
  };

  // Order matters only for reporting; each cap is a ceiling, so the lowest wins regardless.
  if (hasUnresolvedHighSecurityIssue(pkg.blockers)) {
    cap(CAP_UNRESOLVED_HIGH_SECURITY, "An unresolved HIGH or CRITICAL security issue is open.");
  }
  if (pkg.reviewState === "failed") {
    cap(CAP_REVIEW_FAILED, "Independent review failed.");
  }
  if (confidence === "contradictory") {
    cap(CAP_CONTRADICTORY_EVIDENCE, "Evidence for this work contradicts itself.");
  }
  if (openBlockers(pkg.blockers).length > 0) {
    cap(CAP_BLOCKED, "Work is blocked.");
  }
  const productionComplete = categories.find((c) => c.category === "production")?.state === "complete";
  if (!productionComplete) {
    cap(CAP_NOT_PRODUCTION_VERIFIED, "Not verified in production.");
  }

  const byCategory = (c: ReadinessCategory) => categories.find((x) => x.category === c)!;
  const engineeringCategories: ReadinessCategory[] = ["requirements", "database", "backend", "frontend"];
  const engineering = weightedScore(categories.filter((c) => engineeringCategories.includes(c.category)));

  const gates = categories
    .filter((c) => c.state !== "complete" && c.state !== "not_applicable")
    .map((c) => `${c.category}: ${c.reason}`);
  if (multiplier < 1) {
    gates.push(
      `Status confidence is ${confidence}, so the weighted score is discounted to ${Math.round(multiplier * 100)}%.`
    );
  }

  return {
    rawScore: floorPercent(raw),
    overall: floorPercent(score),
    categories,
    appliedCaps,
    gates,
    engineering: floorPercent(engineering),
    review: floorPercent(byCategory("review").score),
    deployment: floorPercent(byCategory("deployment").score),
    production: floorPercent(byCategory("production").score),
    confidenceMultiplier: multiplier,
    staleAfterDays,
    testStaleAfterDays: TEST_EVIDENCE_STALE_AFTER_DAYS,
  };
}

/**
 * Readiness across a set of work packages.
 *
 * Aggregation is by mean of the per-package weighted scores, then the same caps are re-applied at
 * the aggregate level: one package with an open HIGH security issue caps the whole programme, and
 * one package not verified in production keeps the programme below 100.
 */
export function aggregateReadiness(packages: { pkg: WorkPackage; readiness: Readiness }[]): Readiness {
  const live = packages.filter((p) => p.pkg.status !== "superseded");

  if (live.length === 0) {
    const empty = READINESS_CATEGORIES.map((category) => ({
      category,
      state: "not_started" as CategoryState,
      weight: CATEGORY_WEIGHTS[category],
      effectiveWeight: CATEGORY_WEIGHTS[category],
      score: 0,
      reason: "No work packages.",
      overridden: false,
    }));
    return {
      rawScore: 0,
      overall: 0,
      categories: empty,
      appliedCaps: [],
      gates: ["No work packages."],
      engineering: 0,
      review: 0,
      deployment: 0,
      production: 0,
      confidenceMultiplier: 1,
      staleAfterDays: EVIDENCE_STALE_AFTER_DAYS,
      testStaleAfterDays: TEST_EVIDENCE_STALE_AFTER_DAYS,
    };
  }

  const mean = (pick: (r: Readiness) => number) => live.reduce((s, p) => s + pick(p.readiness), 0) / live.length;

  // Per-category aggregate: mean score, worst state.
  const categories: CategoryAssessment[] = READINESS_CATEGORIES.map((category) => {
    const each = live.map((p) => p.readiness.categories.find((c) => c.category === category)!);
    const score = each.reduce((s, c) => s + c.score, 0) / each.length;
    const anyFailed = each.some((c) => c.state === "failed");
    const allComplete = each.every((c) => c.state === "complete" || c.state === "not_applicable");
    let state: CategoryState;
    if (anyFailed) state = "failed";
    else if (allComplete) state = "complete";
    else if (score > 0) state = "in_progress";
    else state = "not_started";
    const incomplete = each.filter((c) => c.state !== "complete" && c.state !== "not_applicable").length;
    return {
      category,
      state,
      weight: CATEGORY_WEIGHTS[category],
      effectiveWeight: each.reduce((s, c) => s + c.effectiveWeight, 0) / each.length,
      score,
      reason:
        incomplete === 0
          ? "Complete across every work package."
          : `${incomplete} of ${each.length} work package(s) are not complete.`,
      overridden: each.some((c) => c.overridden),
    };
  });

  let score = mean((r) => r.overall);
  const appliedCaps: AppliedCap[] = [];
  /**
   * Record the cap whenever the CONDITION holds, not only when it happens to bite. A per-package
   * cap may already have pulled the mean below the ceiling; the founder still needs to be told
   * why the programme can never reach 100.
   */
  const cap = (limit: number, reason: string) => {
    score = Math.min(score, limit);
    appliedCaps.push({ cap: limit, reason });
  };

  const withHighSecurity = live.filter((p) => hasUnresolvedHighSecurityIssue(p.pkg.blockers));
  if (withHighSecurity.length > 0) {
    cap(
      CAP_UNRESOLVED_HIGH_SECURITY,
      `${withHighSecurity.length} work package(s) have an unresolved HIGH or CRITICAL security issue.`
    );
  }
  const failedReview = live.filter((p) => p.pkg.reviewState === "failed");
  if (failedReview.length > 0) {
    cap(CAP_REVIEW_FAILED, `${failedReview.length} work package(s) failed review.`);
  }
  const notProdVerified = live.filter(
    (p) => p.readiness.categories.find((c) => c.category === "production")?.state !== "complete"
  );
  if (notProdVerified.length > 0) {
    cap(CAP_NOT_PRODUCTION_VERIFIED, `${notProdVerified.length} work package(s) are not verified in production.`);
  }

  const gates: string[] = [];
  for (const c of categories) {
    if (c.state !== "complete" && c.state !== "not_applicable") gates.push(`${c.category}: ${c.reason}`);
  }

  return {
    rawScore: floorPercent(mean((r) => r.rawScore)),
    overall: floorPercent(score),
    categories,
    appliedCaps,
    gates,
    engineering: floorPercent(mean((r) => r.engineering)),
    review: floorPercent(mean((r) => r.review)),
    deployment: floorPercent(mean((r) => r.deployment)),
    production: floorPercent(mean((r) => r.production)),
    confidenceMultiplier: mean((r) => r.confidenceMultiplier),
    staleAfterDays: EVIDENCE_STALE_AFTER_DAYS,
    testStaleAfterDays: TEST_EVIDENCE_STALE_AFTER_DAYS,
  };
}

export { OPTIONAL_CATEGORIES, MANDATORY_CATEGORIES };
