/**
 * DEPLOY GUARD REGRESSION — the 2026-08-11 sibling clobber must be unrepeatable.
 *
 * Every case is driven through a FAKE ancestry oracle built from an explicit DAG,
 * so the decision table is proven without git, network or Fly, and cannot go green
 * because of something incidental about the repository's real history.
 */
import { describe, it, expect } from "vitest";
import { evaluateLiveAncestry, assertLiveUnchanged, type AncestryOracle } from "../scripts/deploy/live-ancestry";

/**
 * The real shape of the incident:
 *
 *            be8a501e  (merge base, = origin/main at the time)
 *             /      \
 *      7d20196c      c788fa68        ← siblings; neither contains the other
 *        (v1069)      (v1070)         both were deployed to prod, 4 min apart
 *             \      /
 *            RECONCILED              ← the merge this branch produces
 */
const PARENTS: Record<string, string[]> = {
  be8a501e: [],
  "7d20196c": ["be8a501e"],
  c788fa68: ["be8a501e"],
  RECONCILED: ["7d20196c", "c788fa68"],
  // A plain fast-forward descendant of the canonical parent only.
  c788fa68_child: ["c788fa68"],
};

/** True iff `ancestor` is reachable from `descendant` (inclusive, as git defines it). */
const isAncestor: AncestryOracle = (ancestor, descendant) => {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === ancestor) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(PARENTS[n] ?? []));
  }
  return false;
};

const evaluate = (o: Partial<Parameters<typeof evaluateLiveAncestry>[0]>) =>
  evaluateLiveAncestry({
    liveSha: null,
    candidateSha: "RECONCILED",
    target: "prod",
    isAncestor,
    ...o,
  });

describe("deploy guard · live-ancestry decision table", () => {
  it("A · live is an ancestor of the candidate → ALLOW", () => {
    const v = evaluate({ liveSha: "c788fa68", candidateSha: "c788fa68_child" });
    expect(v.ok).toBe(true);
    expect(v.code).toBe("LIVE_IS_ANCESTOR");
  });

  it("B · live === candidate → ALLOW as a safe no-op", () => {
    const v = evaluate({ liveSha: "c788fa68", candidateSha: "c788fa68" });
    expect(v.ok).toBe(true);
    expect(v.code).toBe("IDENTICAL");
  });

  it("C · divergent siblings → BLOCK with DIVERGENT_LIVE_ANCESTRY", () => {
    // This is literally v1069 live, v1070 being deployed. It MUST block.
    const v = evaluateLiveAncestry({
      liveSha: "7d20196c",
      candidateSha: "c788fa68",
      target: "prod",
      isAncestor,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("DIVERGENT_LIVE_ANCESTRY");
    // The operator must be told the actual remedy, not just "no".
    expect(v.message).toContain("7d20196c");
    expect(v.message).toMatch(/merge/i);
  });

  it("C· the clobber is symmetric — deploying v1069 over a live v1070 blocks too", () => {
    const v = evaluateLiveAncestry({
      liveSha: "c788fa68",
      candidateSha: "7d20196c",
      target: "prod",
      isAncestor,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("DIVERGENT_LIVE_ANCESTRY");
  });

  it("D · live changed between preflight and deploy → BLOCK", () => {
    const v = assertLiveUnchanged("7d20196c", "c788fa68");
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ code: "LIVE_MOVED_DURING_PREFLIGHT" });
  });

  it("D· an unchanged live commit between the two reads passes", () => {
    expect(assertLiveUnchanged("c788fa68", "c788fa68").ok).toBe(true);
  });

  it("D· going from unknown to known between reads is still a move", () => {
    expect(assertLiveUnchanged(null, "c788fa68").ok).toBe(false);
  });

  it("E · candidate is BEHIND live → BLOCK, and not confused with divergence", () => {
    const v = evaluate({ liveSha: "c788fa68_child", candidateSha: "c788fa68" });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("CANDIDATE_BEHIND_LIVE");
  });

  it("F · an explicit reconciliation merge of BOTH parents is allowed with no override", () => {
    // The whole point of doing the merge: live becomes an ancestor, so the guard
    // is satisfied by construction rather than by being told to stand down.
    for (const live of ["7d20196c", "c788fa68"]) {
      const v = evaluate({ liveSha: live, candidateSha: "RECONCILED" });
      expect(v.ok, `live=${live}`).toBe(true);
      expect(v.code).toBe("LIVE_IS_ANCESTOR");
    }
  });

  it("G · live SHA undeterminable → BLOCK for prod (fail closed)", () => {
    const v = evaluate({ liveSha: null, candidateSha: "RECONCILED", target: "prod" });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("LIVE_SHA_UNKNOWN");
  });

  it("G· an empty version string is treated as unknown, not as a match", () => {
    const v = evaluate({ liveSha: "", candidateSha: "RECONCILED", target: "prod" });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("LIVE_SHA_UNKNOWN");
  });

  it("G· --allow-unknown-live is honoured for staging but NEVER for prod", () => {
    expect(evaluate({ liveSha: null, target: "staging", allowUnknownLive: true }).ok).toBe(true);
    const prod = evaluate({ liveSha: null, target: "prod", allowUnknownLive: true });
    expect(prod.ok, "prod must fail closed even when the flag is passed").toBe(false);
    expect(prod.code).toBe("LIVE_SHA_UNKNOWN");
  });
});

describe("deploy guard · the reconciliation override cannot become a casual --force", () => {
  it("allows a divergent deploy ONLY when it names the exact live commit", () => {
    const v = evaluateLiveAncestry({
      liveSha: "7d20196c",
      candidateSha: "c788fa68",
      target: "prod",
      reconciledFrom: "7d20196c",
      isAncestor,
    });
    expect(v.ok).toBe(true);
    expect(v.code).toBe("RECONCILIATION_ACKNOWLEDGED");
  });

  it("rejects an acknowledgement that names a commit which is no longer live", () => {
    // A runbook with `--reconciled-from <old sha>` pasted in goes stale the moment
    // production moves, instead of silently authorising the next clobber.
    const v = evaluateLiveAncestry({
      liveSha: "c788fa68",
      candidateSha: "7d20196c",
      target: "prod",
      reconciledFrom: "be8a501e",
      isAncestor,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("RECONCILIATION_STALE");
  });

  it("does not let the override paper over a BACKWARDS deploy", () => {
    const v = evaluateLiveAncestry({
      liveSha: "c788fa68_child",
      candidateSha: "c788fa68",
      target: "prod",
      reconciledFrom: "c788fa68_child",
      isAncestor,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("CANDIDATE_BEHIND_LIVE");
  });

  it("does not let the override substitute for an unknown live commit", () => {
    const v = evaluateLiveAncestry({
      liveSha: null,
      candidateSha: "RECONCILED",
      target: "prod",
      reconciledFrom: "7d20196c",
      isAncestor,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("LIVE_SHA_UNKNOWN");
  });
});

describe("deploy guard · staging divergence", () => {
  it("blocks a divergent staging deploy just like prod", () => {
    const v = evaluateLiveAncestry({
      liveSha: "7d20196c",
      candidateSha: "c788fa68",
      target: "staging",
      isAncestor,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("DIVERGENT_LIVE_ANCESTRY");
  });

  it("--allow-unknown-live does NOT weaken staging's divergence check", () => {
    const v = evaluateLiveAncestry({
      liveSha: "7d20196c",
      candidateSha: "c788fa68",
      target: "staging",
      allowUnknownLive: true,
      isAncestor,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("DIVERGENT_LIVE_ANCESTRY");
  });
});
