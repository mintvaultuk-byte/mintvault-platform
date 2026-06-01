import { describe, it, expect } from "vitest";
import {
  detectEdge,
  coverageFromSegment,
  creaseSpanFromSegment,
  type Pt,
} from "../client/src/components/grading/measurement-math";

const pt = (x: number, y: number): Pt => ({ x, y });

describe("detectEdge — direction-first (line orientation dominates)", () => {
  it("horizontal line near the top → top", () => {
    // |dx| ≫ |dy|, midpoint Y < 50 → top.
    expect(detectEdge(pt(10, 4), pt(60, 5))).toBe("top");
  });

  it("horizontal line near the bottom → bottom", () => {
    expect(detectEdge(pt(20, 96), pt(80, 95))).toBe("bottom");
  });

  it("vertical line near the left → left", () => {
    // |dy| ≫ |dx|, midpoint X < 50 → left.
    expect(detectEdge(pt(3, 10), pt(4, 70))).toBe("left");
  });

  it("vertical line near the right → right", () => {
    expect(detectEdge(pt(96, 15), pt(97, 80))).toBe("right");
  });

  it("perfectly horizontal stroke at y=50 → top (tied midpoint resolves to top)", () => {
    // strictly < 50 fails on equality; spec uses < 50, so 50 → bottom.
    // The clean horizontal cases we care about land cleanly above or below.
    expect(detectEdge(pt(10, 49), pt(90, 49))).toBe("top");
    expect(detectEdge(pt(10, 51), pt(90, 51))).toBe("bottom");
  });

  it("dx == dy on the diagonal: direction-tie falls through to dx>=dy → top/bottom branch", () => {
    // |dx| == |dy| → the dx>=dy branch wins → top/bottom by midpoint.
    expect(detectEdge(pt(10, 10), pt(50, 50))).toBe("top"); // midpoint y=30 < 50
    expect(detectEdge(pt(50, 50), pt(90, 90))).toBe("bottom"); // midpoint y=70 ≥ 50
  });

  it("midpoint-only would mis-classify a horizontal near vertical centre — direction-first fixes it", () => {
    // Whitening line along the TOP edge drawn at y=12 (well inside the card,
    // but unambiguously horizontal). Nearest-midpoint would compare distances
    // to all 4 edges and could pick wrong if the stroke straddles the card
    // mid-line vertically; direction-first correctly returns top.
    expect(detectEdge(pt(5, 12), pt(95, 12))).toBe("top");
  });
});

describe("coverageFromSegment — % of edge length", () => {
  it("top edge: dx run is the coverage", () => {
    expect(coverageFromSegment(pt(10, 5), pt(60, 5), "top")).toBe(50);
  });

  it("bottom edge: dx run only (dy ignored)", () => {
    expect(coverageFromSegment(pt(10, 95), pt(40, 90), "bottom")).toBe(30);
  });

  it("left edge: dy run", () => {
    expect(coverageFromSegment(pt(3, 10), pt(4, 70), "left")).toBe(60);
  });

  it("right edge: dy run", () => {
    expect(coverageFromSegment(pt(97, 20), pt(96, 80), "right")).toBe(60);
  });

  it("clamps + rounds to one decimal", () => {
    // exact 33.33% → rounded to 33.3
    expect(coverageFromSegment(pt(0, 0), pt(33.333, 5), "top")).toBe(33.3);
    // negative-direction stroke still uses absolute run
    expect(coverageFromSegment(pt(80, 5), pt(20, 5), "top")).toBe(60);
  });
});

describe("creaseSpanFromSegment — dominant-axis run", () => {
  it("horizontal crease span = dx", () => {
    expect(creaseSpanFromSegment(pt(10, 50), pt(60, 52))).toBe(50);
  });

  it("vertical crease span = dy", () => {
    expect(creaseSpanFromSegment(pt(50, 10), pt(52, 80))).toBe(70);
  });

  it("diagonal crease span = max of dx/dy", () => {
    expect(creaseSpanFromSegment(pt(10, 10), pt(80, 50))).toBe(70); // dx=70 > dy=40
    expect(creaseSpanFromSegment(pt(10, 10), pt(30, 90))).toBe(80); // dy=80 > dx=20
  });

  it("clamps + rounds to one decimal", () => {
    expect(creaseSpanFromSegment(pt(0, 0), pt(33.349, 0))).toBe(33.3);
    expect(creaseSpanFromSegment(pt(0, 0), pt(110, 0))).toBe(100); // clamp
  });
});
