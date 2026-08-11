/**
 * LIVE-ANCESTRY DEPLOY GUARD
 *
 * WHY THIS EXISTS — the 2026-08-11 sibling-clobber incident
 * ---------------------------------------------------------
 * safe-deploy.sh's GUARD 1 compared the CHECKOUT against `origin/main`. That is a
 * guard against shipping code older than the branch. It is NOT a guard against
 * shipping code that does not contain what is CURRENTLY RUNNING.
 *
 * On 2026-08-11 those two were different things:
 *
 *   v1069  7d20196c  scanner/station mainline   ← went live
 *   v1070  c788fa68  canonical grading          ← went live 4 minutes later
 *
 * Neither commit contained the other (14 commits each way off `be8a501e`), and
 * NEITHER was on origin/main. So GUARD 1 had nothing to say, and the second deploy
 * silently removed every scanner/station route from production.
 *
 * The missing question is not "is my checkout current with the branch?" but:
 *
 *      DOES MY CANDIDATE CONTAIN WHAT IS RUNNING RIGHT NOW?
 *
 * That is an ancestry question against the LIVE artifact, and it is what this
 * module answers. It is deliberately a PURE function over an injected ancestry
 * oracle so the whole decision table can be tested without git, network, or Fly.
 */

/** Resolves "is `ancestor` an ancestor of `descendant`?" (git merge-base --is-ancestor). */
export type AncestryOracle = (ancestor: string, descendant: string) => boolean;

export type DeployTarget = "prod" | "staging";

export interface LiveAncestryInput {
  /**
   * The commit the LIVE server reports it is serving, or `null` when it could not
   * be determined (unreachable, no /api/version, malformed payload). `null` is a
   * distinct state from "different" and is treated as such — see LIVE_SHA_UNKNOWN.
   */
  liveSha: string | null;
  /** The commit this deploy would ship. */
  candidateSha: string;
  target: DeployTarget;
  /**
   * `--reconciled-from <SHA>`: the operator asserts the candidate deliberately
   * supersedes a divergent live release whose semantics it has absorbed.
   *
   * This must NAME the live SHA, and it is checked against what the server actually
   * reports at the moment of deploy. That is the whole point: a blanket `--force`
   * can be pasted into a runbook once and then silently authorise every future
   * clobber, whereas this value goes stale the instant production moves, so it
   * cannot be set ahead of time or reused.
   */
  reconciledFrom?: string | null;
  /** `--allow-unknown-live`: staging only. Never honoured for prod. */
  allowUnknownLive?: boolean;
  isAncestor: AncestryOracle;
}

export type LiveAncestryVerdict =
  | { ok: true; code: "IDENTICAL" | "LIVE_IS_ANCESTOR" | "RECONCILIATION_ACKNOWLEDGED"; message: string }
  | {
      ok: false;
      code: "DIVERGENT_LIVE_ANCESTRY" | "CANDIDATE_BEHIND_LIVE" | "LIVE_SHA_UNKNOWN" | "RECONCILIATION_STALE";
      message: string;
    };

/**
 * Decide whether `candidateSha` may replace `liveSha`.
 *
 * The ONLY unconditional allow is "the live commit is contained in the candidate".
 * Everything else either blocks or requires the operator to name the exact live
 * commit they are superseding.
 */
export function evaluateLiveAncestry(input: LiveAncestryInput): LiveAncestryVerdict {
  const { liveSha, candidateSha, target, reconciledFrom, allowUnknownLive, isAncestor } = input;

  // ── Case G · the live commit could not be determined ──────────────────────
  // Fail CLOSED for production. An unreachable /api/version is exactly the state
  // a half-finished or crash-looping deploy presents, and that is the moment a
  // clobber does the most damage. Staging may opt out explicitly, because a
  // staging box is legitimately parked/asleep a lot of the time.
  if (liveSha === null || liveSha === "") {
    if (target === "staging" && allowUnknownLive) {
      return {
        ok: true,
        code: "RECONCILIATION_ACKNOWLEDGED",
        message: "staging: live commit unknown and --allow-unknown-live was given — proceeding without ancestry proof",
      };
    }
    return {
      ok: false,
      code: "LIVE_SHA_UNKNOWN",
      message:
        `Could not determine the commit ${target} is currently serving, so it is impossible to prove this ` +
        `deploy contains it. Refusing to deploy blind. Check the app is up and /api/version responds.` +
        (target === "staging" ? " For a parked staging box, pass --allow-unknown-live." : ""),
    };
  }

  // ── Case B · already serving this exact commit ────────────────────────────
  if (liveSha === candidateSha) {
    return { ok: true, code: "IDENTICAL", message: `${target} already serves ${candidateSha} — deploy is a no-op` };
  }

  const liveContained = isAncestor(liveSha, candidateSha);

  // ── Case A / F · the candidate contains the live release ──────────────────
  // Case F (an explicit reconciliation merge of two divergent parents) lands here
  // and needs no override, precisely BECAUSE the merge makes live an ancestor.
  // That is the shape every clobber-repair should have.
  if (liveContained) {
    return {
      ok: true,
      code: "LIVE_IS_ANCESTOR",
      message: `${candidateSha} contains the live commit ${liveSha} — safe to fast-forward ${target}`,
    };
  }

  // ── Case E · the candidate is BEHIND live ─────────────────────────────────
  // Reported separately from the divergent case: it is a different operator
  // mistake (stale checkout, wrong branch) with a different fix.
  if (isAncestor(candidateSha, liveSha)) {
    return {
      ok: false,
      code: "CANDIDATE_BEHIND_LIVE",
      message:
        `Candidate ${candidateSha} is an ANCESTOR of the live commit ${liveSha} — deploying would roll ${target} ` +
        `BACKWARDS and drop everything in between. If a rollback is genuinely intended, use the explicit ` +
        `\`fly deploy --image\` rollback path, not safe-deploy.`,
    };
  }

  // ── Case C · divergent siblings — the 2026-08-11 incident ─────────────────
  if (reconciledFrom) {
    // The acknowledgement must match what is live AT THIS MOMENT.
    if (reconciledFrom !== liveSha) {
      return {
        ok: false,
        code: "RECONCILIATION_STALE",
        message:
          `--reconciled-from ${reconciledFrom} does not match the commit ${target} is actually serving (${liveSha}). ` +
          `Production moved since that acknowledgement was written. Re-check what is live and re-assess whether ` +
          `the candidate really absorbs it.`,
      };
    }
    return {
      ok: true,
      code: "RECONCILIATION_ACKNOWLEDGED",
      message:
        `DIVERGENT from live ${liveSha}, but explicitly acknowledged via --reconciled-from. ` +
        `Operator asserts ${candidateSha} carries that release's semantics forward.`,
    };
  }

  return {
    ok: false,
    code: "DIVERGENT_LIVE_ANCESTRY",
    message:
      `DIVERGENT_LIVE_ANCESTRY: ${target} is serving ${liveSha}, which is NOT an ancestor of candidate ` +
      `${candidateSha}. These are sibling releases — neither contains the other — so deploying would silently ` +
      `remove everything unique to ${liveSha}. This is exactly the 2026-08-11 v1069/v1070 clobber. ` +
      `Fix: merge ${liveSha} into the candidate and deploy the merge. Only if the candidate genuinely already ` +
      `carries that work forward, re-run with --reconciled-from ${liveSha}.`,
  };
}

/**
 * MOVING-TARGET GUARD. The live commit is read twice — once at preflight and once
 * immediately before the deploy is fired — because a concurrent session can ship
 * in between. v1069 → v1070 were four minutes apart; every preflight check in that
 * window was answering about a production that no longer existed by deploy time.
 */
export function assertLiveUnchanged(
  preflightSha: string | null,
  atDeploySha: string | null
): { ok: true } | { ok: false; code: "LIVE_MOVED_DURING_PREFLIGHT"; message: string } {
  if (preflightSha === atDeploySha) return { ok: true };
  return {
    ok: false,
    code: "LIVE_MOVED_DURING_PREFLIGHT",
    message:
      `LIVE_MOVED_DURING_PREFLIGHT: production was serving ${preflightSha ?? "<unknown>"} when this deploy was ` +
      `checked, and is serving ${atDeploySha ?? "<unknown>"} now. Another session deployed while this one was ` +
      `preparing. Every ancestry conclusion above is stale. Re-run from the start.`,
  };
}
