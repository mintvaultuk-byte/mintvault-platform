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
  it("perfectly centred card → 50/50 and grade 10 on both sides", () => {
    const inner = innerFor(50, 50);
    expect(computeCentering(FULL_OUTER, inner, "front")).toMatchObject({ lr: "50/50", tb: "50/50", subgrade: 10 });
    expect(computeCentering(FULL_OUTER, inner, "back")).toMatchObject({ lr: "50/50", tb: "50/50", subgrade: 10 });
  });

  it("honours front-strict / back-lenient — identical rects grade differently", () => {
    // 60/40 L/R, 50/50 T/B. Front chart: bigger 60 → grade 9. Back: 60 → 10.
    // The OLD private ladder was side-agnostic and gave 8 for BOTH — the bug.
    const inner = innerFor(60, 50);
    const front = computeCentering(FULL_OUTER, inner, "front");
    const back = computeCentering(FULL_OUTER, inner, "back");
    expect(front.lr).toBe("60/40");
    expect(front.subgrade).toBe(9);
    expect(back.subgrade).toBe(10);
  });

  it("subgrade always equals min of the two axes on the canonical chart", () => {
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
        const expected = Math.min(centeringAxisGrade(r.lr, side), centeringAxisGrade(r.tb, side));
        expect(r.subgrade).toBe(expected);
      }
    }
  });

  it("emits bigger-side-first ratio strings", () => {
    // left margin smaller than right → wider side first → "70/30".
    const r = computeCentering(FULL_OUTER, innerFor(30, 50), "front");
    expect(r.lr).toBe("70/30");
  });
});

describe("server manual-centering subgrade parity", () => {
  // The server save endpoint (POST /api/admin/certificates/:id/manual-centering)
  // computes its subgrade as min(centeringAxisGrade(lr, side), centeringAxisGrade(tb, side))
  // on the bigger-side-first ratio strings — the same canonical chart as
  // computeCentering and the client panel. This locks in the fix that replaced
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

  it("matches computeCentering for the same rects — one source of truth", () => {
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
        expect(serverSubgrade(r.lr, r.tb, side)).toBe(r.subgrade);
      }
    }
  });
});
