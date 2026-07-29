/**
 * Comparison-harness self-tests.
 *
 * These prove the machinery, not the algorithm: identical immutable inputs,
 * no cross-path mutation, order independence, repeatability, correct detection
 * of a known synthetic difference, and stale-row rejection. They use the real
 * production decision function (evaluateCropIntegrity) via the harness — no
 * copied decision logic.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  buildSnapshot,
  compare,
  runPath,
  resumeKey,
  HARNESS_VERSION,
  type ImmutableSnapshot,
} from "./helpers/comparison-harness";
import {
  tightenForDisplay,
  emptyCropIntegrityReport,
  MAX_EDGE_TRIM_BEYOND_MAT_MM,
  LOW_CONFIDENCE_MAT_MULTIPLE,
  MAX_EDGE_TRIM_UNKNOWN_MAT_MM,
  type CropIntegrityReport,
} from "../server/image-processing";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** Synthetic card on mat: real pixels through the real decision path. */
async function fixture(matPx = 60, cardW = 880, cardH = 1229): Promise<Buffer> {
  const W = cardW + 2 * matPx;
  const H = cardH + 2 * matPx;
  const card = Buffer.alloc(cardW * cardH * 3);
  for (let i = 0; i < cardW * cardH; i++) {
    card[i * 3] = 40;
    card[i * 3 + 1] = 30;
    card[i * 3 + 2] = 66;
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: "#eef2f4" } })
    .composite([{ input: card, raw: { width: cardW, height: cardH, channels: 3 }, left: matPx, top: matPx }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function snapshotFromRealPipeline(buf: Buffer, cert: string): Promise<{ snap: ImmutableSnapshot; report: CropIntegrityReport }> {
  const report = emptyCropIntegrityReport("front");
  await tightenForDisplay(buf, cert, undefined, "front", report);
  const md = await sharp(buf).metadata();
  const snap = buildSnapshot(report, {
    cert,
    face: "front",
    sourceSha: sha(buf),
    sourceW: md.width!,
    sourceH: md.height!,
    centredSha: sha(buf),
    centredW: report.pre?.w ?? md.width!,
    centredH: report.pre?.h ?? md.height!,
    codeVersion: "test",
  });
  return { snap, report };
}

/** Hand-built snapshot so a specific overshoot can be dialled in exactly. */
function syntheticSnapshot(over: Partial<ImmutableSnapshot> = {}): ImmutableSnapshot {
  const base = {
    harnessVersion: HARNESS_VERSION,
    codeVersion: "test",
    cert: "SYN1",
    face: "front" as const,
    sourceSha: "aaaa",
    sourceW: 1474,
    sourceH: 2000,
    centredSha: "bbbb",
    centredW: 1440,
    centredH: 1950,
    detectionState: "detected",
    proposal: { w: 1340, h: 1830 },
    edgeTrimPx: { top: 60, bottom: 60, left: 50, right: 50 },
    rawMat: { top: 58, bottom: 58, left: 48, right: 48 },
    plausibilityState: "valid_after_artefact_skip",
    matUsableForAcceptance: true,
    measuredConfidenceBeforeDecision: "low" as const,
    discardedBand: { top: 0.01, bottom: 0.01, left: 0.01, right: 0.01 },
    artefactDetected: true,
    ...over,
  };
  return Object.freeze(base) as ImmutableSnapshot;
}

describe("immutable pre-decision snapshot", () => {
  it("captures measured confidence, never report.cropConfidence", async () => {
    const { snap, report } = await snapshotFromRealPipeline(await fixture(), "SNAP1");
    if (report.retainedMat) {
      // Mat was measured: the snapshot must carry that exact pre-decision value.
      expect(snap.measuredConfidenceBeforeDecision).toBe(report.retainedMat.confidence);
    } else {
      // Pipeline exited before mat measurement (e.g. detection failed). The
      // snapshot must fail closed to "low", never inherit a post-decision value.
      expect(snap.measuredConfidenceBeforeDecision).toBe("low");
    }
    // On an accepted crop the production code writes cropConfidence="high" AFTER
    // deciding. If the harness ever read that, this assertion would catch it.
    if (report.decision === "accepted" && report.retainedMat?.confidence === "low") {
      expect(report.cropConfidence).toBe("high");
      expect(snap.measuredConfidenceBeforeDecision).not.toBe(report.cropConfidence);
    }
  });

  it("is deeply frozen and detached from the source report", async () => {
    const { snap, report } = await snapshotFromRealPipeline(await fixture(), "SNAP2");
    expect(Object.isFrozen(snap)).toBe(true);
    if (snap.rawMat) expect(Object.isFrozen(snap.rawMat)).toBe(true);
    const before = JSON.stringify(snap);
    // Mutate the originating report as violently as production might.
    report.cropConfidence = "high";
    report.decision = "rejected";
    if (report.retainedMat) report.retainedMat.left = 99999;
    if (report.edgeTrimPx) report.edgeTrimPx.left = 88888;
    expect(JSON.stringify(snap)).toBe(before);
  });
});

describe("mutation isolation between paths", () => {
  it("neither path can alter the other's inputs or the snapshot", () => {
    const snap = syntheticSnapshot();
    const before = JSON.stringify(snap);
    const a = runPath(snap, "baseline")!;
    // Mutate everything the first path handed back.
    if (a.matUsed) a.matUsed.left = 123456;
    a.reasons.push("tampered");
    const b = runPath(snap, "patched")!;
    expect(b.matUsed?.left).toBe(48);
    expect(b.reasons).not.toContain("tampered");
    expect(JSON.stringify(snap)).toBe(before);
  });

  it("repeated execution is identical", () => {
    const snap = syntheticSnapshot();
    const r1 = compare(snap);
    const r2 = compare(snap);
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
  });
});

describe("order independence", () => {
  it("baseline-first and patched-first agree exactly", () => {
    for (const snap of [
      syntheticSnapshot(),
      syntheticSnapshot({ matUsableForAcceptance: false, plausibilityState: "implausibly_large" }),
      syntheticSnapshot({ measuredConfidenceBeforeDecision: "high" }),
    ]) {
      const A = compare(snap, ["baseline", "patched"]);
      const B = compare(snap, ["patched", "baseline"]);
      expect(JSON.stringify(B.baseline)).toBe(JSON.stringify(A.baseline));
      expect(JSON.stringify(B.patched)).toBe(JSON.stringify(A.patched));
      expect(B.changed).toBe(A.changed);
      expect(B.changeKind).toBe(A.changeKind);
    }
  });

  it("holds on a real-pipeline snapshot too", async () => {
    const { snap } = await snapshotFromRealPipeline(await fixture(), "ORDER1");
    const A = compare(snap, ["baseline", "patched"]);
    const B = compare(snap, ["patched", "baseline"]);
    expect(JSON.stringify(B)).toBe(JSON.stringify(A));
  });
});

describe("known difference and known identity", () => {
  it("an unusable mat produces exactly one difference, of the right kind", () => {
    // Same geometry; only plausibility differs. Baseline trusts the mat and
    // uses the widened bound; patched withholds it and uses the 6mm ceiling.
    const usable = syntheticSnapshot({ matUsableForAcceptance: true });
    const unusable = syntheticSnapshot({
      matUsableForAcceptance: false,
      plausibilityState: "implausibly_large",
    });
    const same = compare(usable);
    expect(same.changed).toBe(false);

    const diff = compare(unusable);
    expect(diff.baseline!.toleranceReason).toBe("widened_low_confidence");
    expect(diff.baseline!.toleranceMm).toBeCloseTo(MAX_EDGE_TRIM_BEYOND_MAT_MM * LOW_CONFIDENCE_MAT_MULTIPLE, 6);
    expect(diff.patched!.toleranceReason).toBe("unknown_mat_ceiling");
    expect(diff.patched!.toleranceMm).toBe(MAX_EDGE_TRIM_UNKNOWN_MAT_MM);
    // Both paths saw the SAME pre-decision confidence — that is the repair.
    expect(diff.patched!.appliedConfidence).toBe(diff.baseline!.appliedConfidence);
  });

  it("a known-identical fixture reports no difference and identical fields", () => {
    const snap = syntheticSnapshot();
    const r = compare(snap);
    expect(r.changed).toBe(false);
    expect(r.baseline!.decision).toBe(r.patched!.decision);
    expect(r.baseline!.toleranceMm).toBe(r.patched!.toleranceMm);
    expect(r.baseline!.reasons).toEqual(r.patched!.reasons);
  });

  it("the OLD broken behaviour would have differed — proving the test bites", () => {
    // Reproduce the bug: feed the post-decision confidence ("high") to baseline
    // while patched uses the true pre-decision value ("low").
    const snap = syntheticSnapshot();
    const broken = runPath(
      Object.freeze({ ...snap, measuredConfidenceBeforeDecision: "high" as const }),
      "baseline"
    )!;
    const correct = runPath(snap, "baseline")!;
    expect(broken.toleranceMm).not.toBe(correct.toleranceMm);
    expect(broken.toleranceMm).toBe(MAX_EDGE_TRIM_BEYOND_MAT_MM);
    expect(correct.toleranceMm).toBeCloseTo(MAX_EDGE_TRIM_BEYOND_MAT_MM * LOW_CONFIDENCE_MAT_MULTIPLE, 6);
  });
});

describe("resume and stale-row safety", () => {
  const opt = "opts-v1";
  it("identical inputs produce a reusable key", () => {
    const s = syntheticSnapshot();
    expect(resumeKey(s, opt)).toBe(resumeKey(syntheticSnapshot(), opt));
  });

  it("a source-hash change forces recomputation", () => {
    expect(resumeKey(syntheticSnapshot({ sourceSha: "zzzz" }), opt)).not.toBe(resumeKey(syntheticSnapshot(), opt));
  });

  it("a harness-version change forces recomputation", () => {
    expect(resumeKey(syntheticSnapshot({ harnessVersion: "old/1" }), opt)).not.toBe(
      resumeKey(syntheticSnapshot(), opt)
    );
  });

  it("a code-version change forces recomputation", () => {
    expect(resumeKey(syntheticSnapshot({ codeVersion: "other" }), opt)).not.toBe(resumeKey(syntheticSnapshot(), opt));
  });

  it("an options change forces recomputation", () => {
    expect(resumeKey(syntheticSnapshot(), "opts-v2")).not.toBe(resumeKey(syntheticSnapshot(), opt));
  });

  it("front and back identities never collide", () => {
    expect(resumeKey(syntheticSnapshot({ face: "back" }), opt)).not.toBe(resumeKey(syntheticSnapshot(), opt));
  });
});
