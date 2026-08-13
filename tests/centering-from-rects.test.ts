import { describe, it, expect } from "vitest";
import { computeCentering, type Rect } from "@/components/grading/centering-from-rects";
import { centeringAxisGrade } from "../shared/centering";

const FULL_OUTER: Rect = { left: 0, top: 0, right: 100, bottom: 100 };

/**
 * Build an inner rect (against a full-image outer) that yields a target L/R and
 * T/B FLOAT split. e.g. lFloat=60 → left margin is 60% of the horizontal margin
 * → "60/40". totalMarginPct is split between the two sides of each axis.
 */
function innerFor(lFloat: number, tFloat: number, totalMarginPct = 20): Rect {
  const leftM = (lFloat / 100) * totalMarginPct;
  const rightM = totalMarginPct - leftM;
  const topM = (tFloat / 100) * totalMarginPct;
  const bottomM = totalMarginPct - topM;
  return { left: leftM, top: topM, right: 100 - rightM, bottom: 100 - bottomM };
}

describe("computeCentering", () => {
  it("perfectly centred card → 50/50 observation ratios", () => {
    const inner = innerFor(50, 50);
    expect(computeCentering(FULL_OUTER, inner, "front")).toEqual({ lr: "50/50", tb: "50/50" });
    expect(computeCentering(FULL_OUTER, inner, "back")).toEqual({ lr: "50/50", tb: "50/50" });
  });

  it("emits the same observed ratios regardless of the card side", () => {
    // The browser records geometry only. The server applies the stricter
    // front / lenient back chart after it receives this measurement.
    const inner = innerFor(60, 50);
    const front = computeCentering(FULL_OUTER, inner, "front");
    const back = computeCentering(FULL_OUTER, inner, "back");
    expect(front.lr).toBe("60/40");
    expect(front.tb).toBe("50/50");
    expect(back).toEqual(front);
  });

  it("does not expose a browser-calculated subgrade", () => {
    const samples: Array<[number, number]> = [
      [50, 50],
      [55, 50],
      [60, 45],
      [70, 60],
      [80, 52],
      [95, 50],
      [50, 80],
      [66, 66],
    ];
    for (const side of ["front", "back"] as const) {
      for (const [l, t] of samples) {
        const r = computeCentering(FULL_OUTER, innerFor(l, t), side);
        expect("subgrade" in r).toBe(false);
      }
    }
  });

  it("emits bigger-side-first ratio strings", () => {
    // left margin smaller than right → wider side first → "70/30".
    const r = computeCentering(FULL_OUTER, innerFor(30, 50), "front");
    expect(r.lr).toBe("70/30");
  });
});

describe("server manual-centering grade resolution", () => {
  // The server save endpoint (POST /api/admin/certificates/:id/manual-centering)
  // computes its subgrade as min(centeringAxisGrade(lr, side), centeringAxisGrade(tb, side))
  // on the bigger-side-first ratio strings. This locks in the fix that replaced
  // the old side-agnostic worstDev ladder, which gave 8 for a 60/40 front
  // (worstDev = 10) where the strict front chart gives 9.
  const serverSubgrade = (lr: string, tb: string, side: "front" | "back") =>
    Math.min(centeringAxisGrade(lr, side), centeringAxisGrade(tb, side));

  it("60/40 front → 9 (canonical), NOT 8 (old worstDev ladder)", () => {
    expect(serverSubgrade("60/40", "50/50", "front")).toBe(9);
  });

  it("60/40 is lenient on the back → 10", () => {
    expect(serverSubgrade("60/40", "50/50", "back")).toBe(10);
  });

  it("uses the submitted browser ratios as server observations", () => {
    const samples: Array<[number, number]> = [
      [50, 50],
      [60, 50],
      [70, 60],
      [80, 52],
      [95, 50],
    ];
    for (const side of ["front", "back"] as const) {
      for (const [l, t] of samples) {
        const r = computeCentering(FULL_OUTER, innerFor(l, t), side);
        expect(serverSubgrade(r.lr, r.tb, side)).toBeTypeOf("number");
      }
    }
  });
});
