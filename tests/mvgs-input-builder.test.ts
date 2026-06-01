import { describe, it, expect } from "vitest";
import {
  buildMvgsInput,
  LEGACY_HAS_CREASE_SPAN_PCT,
  LEGACY_HAS_TEAR_SEVERITY,
  scoreMvgsV2,
  type MvgsV2PersistedFields,
} from "../shared/mvgs-input-builder";

function base(overrides: Partial<MvgsV2PersistedFields> = {}): MvgsV2PersistedFields {
  return {
    centeringFrontLr: "50/50",
    centeringFrontTb: "50/50",
    centeringBackLr: "50/50",
    centeringBackTb: "50/50",
    defects: [],
    darkBorderFront: false,
    darkBorderBack: false,
    eyeAppealModifier: 0,
    ...overrides,
  };
}

describe("buildMvgsInput — crease precedence (measurement wins)", () => {
  it("no measurement + no flag → null span (no ceiling)", () => {
    const input = buildMvgsInput(base());
    expect(input.creaseSpanPct).toBeNull();
  });

  it("measurement only (no flag) → measurement wins", () => {
    const input = buildMvgsInput(base({ creaseSpanPct: 40 }));
    expect(input.creaseSpanPct).toBe(40);
  });

  it("flag only (no measurement) → legacy-equivalent span (10)", () => {
    const input = buildMvgsInput(base({ hasCrease: true }));
    expect(input.creaseSpanPct).toBe(LEGACY_HAS_CREASE_SPAN_PCT);
  });

  it("measurement AND flag both set → measurement wins (flag ignored)", () => {
    const input = buildMvgsInput(base({ creaseSpanPct: 60, hasCrease: true }));
    expect(input.creaseSpanPct).toBe(60);
    // Confirm we did NOT fall through to LEGACY_HAS_CREASE_SPAN_PCT.
    expect(input.creaseSpanPct).not.toBe(LEGACY_HAS_CREASE_SPAN_PCT);
  });

  it("legacy flag fallback produces the same ceiling as v1 legacyCeilingForFlags (cap 4.5)", () => {
    const result = scoreMvgsV2(base({ hasCrease: true }));
    expect(result.ceiling?.source).toBe("crease");
    expect(result.ceiling?.grade).toBe(4.5);
  });

  it("measurement at 40% supersedes the flag's lenient 4.5 → produces cap 4", () => {
    // Both set; measurement wins → 40% lands in 25-50% bracket → cap 4.
    const result = scoreMvgsV2(base({ creaseSpanPct: 40, hasCrease: true }));
    expect(result.ceiling?.grade).toBe(4);
  });
});

describe("buildMvgsInput — tear precedence (measurement wins)", () => {
  it("no measurement + no flag → null severity", () => {
    expect(buildMvgsInput(base()).tearSeverity).toBeNull();
  });

  it("measurement only → measurement wins", () => {
    expect(buildMvgsInput(base({ tearSeverity: "significant" })).tearSeverity).toBe("significant");
  });

  it("flag only → legacy-equivalent severity (minor)", () => {
    expect(buildMvgsInput(base({ hasTear: true })).tearSeverity).toBe(LEGACY_HAS_TEAR_SEVERITY);
    expect(LEGACY_HAS_TEAR_SEVERITY).toBe("minor");
  });

  it("measurement AND flag both set → measurement wins, even when stricter", () => {
    const input = buildMvgsInput(base({ tearSeverity: "major", hasTear: true }));
    expect(input.tearSeverity).toBe("major");
  });

  it("measurement AND flag both set → measurement wins, even when more lenient", () => {
    // Operator marks "significant" (cap 1.5) AND has the legacy boolean set
    // (which alone would map to "minor", cap 2). Measurement wins → 1.5.
    const result = scoreMvgsV2(base({ tearSeverity: "significant", hasTear: true }));
    expect(result.ceiling?.grade).toBe(1.5);
  });

  it("legacy flag never escalates to NO — only explicit 'major' measurement does", () => {
    const r = scoreMvgsV2(base({ hasTear: true }));
    expect(r.tearForceNotGraded).toBe(false);
  });

  it("explicit 'major' measurement sets tearForceNotGraded", () => {
    const r = scoreMvgsV2(base({ tearSeverity: "major" }));
    expect(r.tearForceNotGraded).toBe(true);
  });
});

describe("buildMvgsInput — wrinkle has no legacy boolean", () => {
  it("only the new severity input drives the wrinkle ceiling", () => {
    expect(buildMvgsInput(base({ wrinkleSeverity: "tiny_back" })).wrinkleSeverity).toBe("tiny_back");
    expect(buildMvgsInput(base()).wrinkleSeverity).toBeNull();
  });
});

describe("buildMvgsInput — whitening edges pass through unchanged", () => {
  it("empty array stays empty (engine falls back to pin-based edges)", () => {
    expect(buildMvgsInput(base({ whiteningLines: [] })).whiteningEdges).toEqual([]);
  });

  it("non-empty array passes through verbatim", () => {
    const lines = [
      { side: "front" as const, edge: "top" as const, coveragePct: 30 },
      { side: "front" as const, edge: "left" as const, coveragePct: 15 },
    ];
    expect(buildMvgsInput(base({ whiteningLines: lines })).whiteningEdges).toEqual(lines);
  });
});

describe("buildMvgsInput — DINGS precedence with multiple inputs", () => {
  it("worst measurement wins across crease + wrinkle + tear (DINGS §5)", () => {
    const r = scoreMvgsV2(
      base({
        creaseSpanPct: 10, // crease <25% → cap 4.5
        wrinkleSeverity: "multiple_front", // cap 5
        tearSeverity: "minor", // cap 2 — strictest
      })
    );
    expect(r.ceiling?.source).toBe("tear");
    expect(r.ceiling?.grade).toBe(2);
  });

  it("legacy-only crease + measured wrinkle → wrinkle wins when stricter", () => {
    // Legacy crease boolean alone → cap 4.5. Measured wrinkle "small_front"
    // → cap 5.5. Crease (4.5) is stricter → crease wins.
    const r = scoreMvgsV2(base({ hasCrease: true, wrinkleSeverity: "small_front" }));
    expect(r.ceiling?.source).toBe("crease");
    expect(r.ceiling?.grade).toBe(4.5);
  });
});

describe("buildMvgsInput — calibration plumbing", () => {
  it("calibration argument flows through to the engine input", () => {
    const cal = {
      edgeAffectedPct: 5,
      minorVisibleSplitPct: 30,
      darkBorderMultiplier: 1.5,
      creaseMinorMaxPct: 20,
      creaseHalfMaxPct: 45,
      creaseThreeQuarterMaxPct: 80,
    };
    expect(buildMvgsInput(base(), cal).calibration).toBe(cal);
  });

  it("omitted calibration → engine uses defaults (input.calibration undefined)", () => {
    expect(buildMvgsInput(base()).calibration).toBeUndefined();
  });
});

// ── Phase 2.1 — multi-crease persistence ────────────────────────────────
describe("buildMvgsInput — multi-crease list (longest wins)", () => {
  const pt = (x: number, y: number) => ({ x, y });

  it("empty creaseLines + no legacy span → no crease ceiling", () => {
    expect(buildMvgsInput(base({ creaseLines: [] })).creaseSpanPct).toBeNull();
  });

  it("single crease in list → engine sees its spanPct", () => {
    const input = buildMvgsInput(
      base({ creaseLines: [{ id: "a", side: "front", spanPct: 35, start: pt(0, 0), end: pt(0, 0) }] })
    );
    expect(input.creaseSpanPct).toBe(35);
  });

  it("multiple creases → engine sees the MAX (longest wins per spec §4/§5)", () => {
    const input = buildMvgsInput(
      base({
        creaseLines: [
          { id: "a", side: "front", spanPct: 18, start: pt(0, 0), end: pt(0, 0) },
          { id: "b", side: "back", spanPct: 62, start: pt(0, 0), end: pt(0, 0) }, // longest
          { id: "c", side: "front", spanPct: 30, start: pt(0, 0), end: pt(0, 0) },
        ],
      })
    );
    expect(input.creaseSpanPct).toBe(62);
  });

  it("creaseLines overrides legacy creaseSpanPct (v2.1 wins over v2.0)", () => {
    const input = buildMvgsInput(
      base({
        creaseSpanPct: 90, // legacy — would cap 3
        creaseLines: [{ id: "a", side: "front", spanPct: 15, start: pt(0, 0), end: pt(0, 0) }],
      })
    );
    expect(input.creaseSpanPct).toBe(15);
  });

  it("all-zero spanPct array degrades to null (no ceiling)", () => {
    const input = buildMvgsInput(
      base({
        creaseLines: [{ id: "a", side: "front", spanPct: 0, start: pt(0, 0), end: pt(0, 0) }],
      })
    );
    expect(input.creaseSpanPct).toBeNull();
  });

  it("creaseLines absent → legacy creaseSpanPct still applies (v2.0 fallback)", () => {
    const input = buildMvgsInput(base({ creaseSpanPct: 45 }));
    expect(input.creaseSpanPct).toBe(45);
  });

  it("creaseLines absent + creaseSpanPct null + hasCrease true → legacy boolean fallback (10%)", () => {
    const input = buildMvgsInput(base({ hasCrease: true }));
    expect(input.creaseSpanPct).toBe(10);
  });
});

describe("buildMvgsInput — whitening line narrowing (colour can't leak)", () => {
  it("strips id / start / end / color before passing to engine", () => {
    const input = buildMvgsInput(
      base({
        whiteningLines: [
          {
            id: "w1",
            side: "front",
            edge: "top",
            coveragePct: 25,
            start: { x: 10, y: 5 },
            end: { x: 35, y: 5 },
            color: "#FF00AA", // ← display-only, must NOT survive
          },
        ],
      })
    );
    expect(input.whiteningEdges).toEqual([{ side: "front", edge: "top", coveragePct: 25 }]);
    // Engine boundary received exactly the three fields, nothing else.
    expect(Object.keys(input.whiteningEdges![0]).sort()).toEqual(["coveragePct", "edge", "side"]);
  });

  it("empty list narrows to empty list (not null) — preserves 'measurement supplied' signal", () => {
    expect(buildMvgsInput(base({ whiteningLines: [] })).whiteningEdges).toEqual([]);
  });

  it("absent whiteningLines → whiteningEdges null (legacy path)", () => {
    expect(buildMvgsInput(base()).whiteningEdges).toBeNull();
  });
});

// ── v2.1 fix — multiple whitening lines per edge, worst-line-wins ───────
describe("buildMvgsInput — per-edge MAX coverage collapse (worst-line-wins)", () => {
  it("two lines on the same edge → engine sees ONE entry with the MAX coverage", () => {
    const input = buildMvgsInput(
      base({
        whiteningLines: [
          { id: "a", side: "front", edge: "top", coveragePct: 15 },
          { id: "b", side: "front", edge: "top", coveragePct: 35 }, // worst
        ],
      })
    );
    expect(input.whiteningEdges).toHaveLength(1);
    expect(input.whiteningEdges![0]).toEqual({ side: "front", edge: "top", coveragePct: 35 });
  });

  it("three lines on the same edge → MAX wins, extras don't compound", () => {
    const input = buildMvgsInput(
      base({
        whiteningLines: [
          { id: "a", side: "front", edge: "top", coveragePct: 10 },
          { id: "b", side: "front", edge: "top", coveragePct: 22 }, // worst
          { id: "c", side: "front", edge: "top", coveragePct: 18 },
        ],
      })
    );
    // Critically NOT 50 (sum). The engine sees the strictest single line.
    expect(input.whiteningEdges![0].coveragePct).toBe(22);
  });

  it("lines on different edges stay distinct (collapse is per-edge, not global)", () => {
    const input = buildMvgsInput(
      base({
        whiteningLines: [
          { id: "a", side: "front", edge: "top", coveragePct: 15 },
          { id: "b", side: "front", edge: "top", coveragePct: 35 }, // wins top
          { id: "c", side: "front", edge: "left", coveragePct: 28 },
          { id: "d", side: "back", edge: "top", coveragePct: 50 },
        ],
      })
    );
    expect(input.whiteningEdges).toHaveLength(3);
    const byKey = new Map(input.whiteningEdges!.map((e) => [`${e.side}:${e.edge}`, e.coveragePct]));
    expect(byKey.get("front:top")).toBe(35);
    expect(byKey.get("front:left")).toBe(28);
    expect(byKey.get("back:top")).toBe(50);
  });

  it("identical edges from DIFFERENT sides do NOT collapse (front top ≠ back top)", () => {
    const input = buildMvgsInput(
      base({
        whiteningLines: [
          { id: "f", side: "front", edge: "top", coveragePct: 20 },
          { id: "b", side: "back", edge: "top", coveragePct: 60 },
        ],
      })
    );
    expect(input.whiteningEdges).toHaveLength(2);
  });

  it("worst-line-wins still strips display-only fields (colour/id/start/end)", () => {
    const input = buildMvgsInput(
      base({
        whiteningLines: [
          {
            id: "a",
            side: "front",
            edge: "top",
            coveragePct: 30,
            start: { x: 10, y: 5 },
            end: { x: 40, y: 5 },
            color: "#FF00AA",
          },
          {
            id: "b",
            side: "front",
            edge: "top",
            coveragePct: 18,
            start: { x: 60, y: 5 },
            end: { x: 78, y: 5 },
            color: "#00CCFF",
          },
        ],
      })
    );
    expect(input.whiteningEdges).toHaveLength(1);
    expect(Object.keys(input.whiteningEdges![0]).sort()).toEqual(["coveragePct", "edge", "side"]);
    expect(input.whiteningEdges![0].coveragePct).toBe(30);
  });
});

// ── v2.1 fix — multiple creases (verified) ──────────────────────────────
describe("buildMvgsInput — multiple creases reach the engine as max(spanPct)", () => {
  const pt = (x: number, y: number) => ({ x, y });
  it("three creases → engine sees one number = max", () => {
    const input = buildMvgsInput(
      base({
        creaseLines: [
          { id: "a", side: "front", spanPct: 12, start: pt(0, 0), end: pt(12, 0) },
          { id: "b", side: "back", spanPct: 78, start: pt(0, 0), end: pt(0, 78) }, // worst
          { id: "c", side: "front", spanPct: 33, start: pt(0, 0), end: pt(33, 0) },
        ],
      })
    );
    expect(input.creaseSpanPct).toBe(78);
  });
});
