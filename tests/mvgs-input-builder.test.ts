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
