/**
 * OWNER-AUTHORISED REPAIR (2026-08-11) — READING A REVIEW MUST NOT WRITE.
 *
 * Entering Review used to unconditionally PUT the entire grading payload — grade,
 * sub-grades, centering, defects — merely because the reviewer OPENED the card, and
 * that write carried no optimistic lock. So reviewer A simply *looking* at a card
 * could overwrite reviewer B's newer work from another tab or session.
 *
 * These are behavioural tests of the real decision function the panel calls, plus
 * source invariants proving the panel is actually wired to it and that the P0
 * revision binding was not weakened to get here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decideReviewPersist, type ReviewCleanBaseline } from "../shared/grading-review-barrier";

const PANEL = readFileSync("client/src/components/grading/grading-panel.tsx", "utf8");
const BARRIER = readFileSync("shared/grading-review-barrier.ts", "utf8");
const WORKSTATION = readFileSync("client/src/components/grading-workflow/GradingWorkstation.tsx", "utf8");

const baseline = (over: Partial<ReviewCleanBaseline> = {}): ReviewCleanBaseline => ({
  certId: 42,
  fingerprint: '{"grade":8,"centering":9}',
  revision: 7,
  ...over,
});

describe("entering Review performs NO write when nothing changed", () => {
  it("1-5. a clean open reuses the authoritative revision instead of saving", () => {
    const d = decideReviewPersist({ baseline: baseline(), certId: 42, payloadFingerprint: '{"grade":8,"centering":9}' });
    expect(d).toEqual({ mode: "reuse", revision: 7 });
  });

  it("6. an actual grading edit still persists", () => {
    const d = decideReviewPersist({ baseline: baseline(), certId: 42, payloadFingerprint: '{"grade":9,"centering":9}' });
    expect(d).toEqual({ mode: "persist" });
  });

  it("7. an edit reverted to its original value is clean again — no unnecessary save", () => {
    const original = '{"grade":8,"centering":9}';
    const b = baseline({ fingerprint: original });
    // edit …
    expect(decideReviewPersist({ baseline: b, certId: 42, payloadFingerprint: '{"grade":9,"centering":9}' })).toEqual({
      mode: "persist",
    });
    // … then revert
    expect(decideReviewPersist({ baseline: b, certId: 42, payloadFingerprint: original })).toEqual({
      mode: "reuse",
      revision: 7,
    });
  });

  it("fails toward the previous always-write behaviour when the baseline is unknown or foreign", () => {
    // No baseline yet (not hydrated) — must NOT silently skip a save.
    expect(decideReviewPersist({ baseline: null, certId: 42, payloadFingerprint: "x" })).toEqual({ mode: "persist" });
    expect(decideReviewPersist({ baseline: undefined, certId: 42, payloadFingerprint: "x" })).toEqual({
      mode: "persist",
    });
    // Baseline belongs to a DIFFERENT certificate — never reuse another card's revision.
    expect(
      decideReviewPersist({ baseline: baseline({ certId: 41 }), certId: 42, payloadFingerprint: baseline().fingerprint })
    ).toEqual({ mode: "persist" });
    // A corrupt or non-positive revision can never enter a CAS predicate.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        decideReviewPersist({
          baseline: baseline({ revision: bad }),
          certId: 42,
          payloadFingerprint: baseline().fingerprint,
        }),
        `revision ${bad} must force a real save`
      ).toEqual({ mode: "persist" });
    }
  });

  it("8. multi-session: A merely opening at R10 cannot clobber B's newer R11", () => {
    // A hydrated at revision 10 and changed nothing. B has since written R11.
    // A's transition must resolve to `reuse` — i.e. issue no PUT at all — so there
    // is no write that could overwrite B. A discovers the staleness through the
    // revision-aware preview and the approval CAS, not by overwriting.
    const aBaseline = baseline({ revision: 10 });
    const d = decideReviewPersist({ baseline: aBaseline, certId: 42, payloadFingerprint: aBaseline.fingerprint });
    expect(d.mode).toBe("reuse");
    expect(d).toEqual({ mode: "reuse", revision: 10 });
  });
});

describe("the panel is actually wired to the no-write decision", () => {
  it("the Review transition consults decideReviewPersist BEFORE any fetch", () => {
    const at = PANEL.indexOf("const decision = decideReviewPersist(");
    expect(at).toBeGreaterThan(0);
    // The transition handler's PUT must come AFTER the decision, or the decision
    // would be decorative.
    const put = PANEL.indexOf('method: "PUT"', at);
    expect(put).toBeGreaterThan(at);
    // …and the reuse branch must return before reaching it.
    const reuse = PANEL.indexOf('if (decision.mode === "reuse")', at);
    expect(reuse).toBeGreaterThan(at);
    expect(reuse).toBeLessThan(put);
  });

  it("the clean baseline is captured only once hydrated, and only for the current cert", () => {
    expect(PANEL).toContain("gradingHydratedForRef.current === certId && cleanBaselineRef.current?.certId !== certId");
    // It is refreshed after this panel's own save, so a second Review entry with no
    // further edits performs no second write.
    expect(PANEL).toContain("cleanBaselineRef.current = { certId: transitionCertId, fingerprint: payloadFingerprint, revision }");
  });

  it("P0 revision binding is preserved: the barrier still previews and still demands an exact match", () => {
    // reuse supplies the revision; it does not bypass preview or readiness.
    expect(BARRIER).toContain("export async function runReviewTransitionBarrier");
    expect(BARRIER).toContain("previewed = await withinBarrierDeadline(args.preview(snapshot)");
    expect(BARRIER).toContain("if (!previewed) return { ok: false, phase: \"preview\" }");
    // Review readiness is still fingerprint+cert bound.
    expect(BARRIER).toContain("args.ready?.certId === args.certId && args.ready.payloadFingerprint === args.currentPayloadFingerprint");
    // The approval path still sends an expectedRevision.
    expect(WORKSTATION).toContain("expectedRevision");
  });
});
