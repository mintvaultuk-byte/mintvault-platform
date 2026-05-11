/**
 * scripts/_pr91-cut-verify.ts
 *
 * Verifies the A4 SVG cut layer geometry for a 4-cert print batch.
 * Renders the SVG, parses the <rect> elements, and asserts:
 *   - 8 cut rects total (4 rows × 2 cells)
 *   - 4 slab cuts at 69.5 × 19.5 mm (70 − 0.25×2 bleed)
 *   - 4 insert cuts at 85.1 × 53.5 mm (85.6 − 0.25×2 bleed)
 *   - All stroke = "#FF00FF", fill = "none"
 *
 * Aborts with non-zero exit on any failure so the calling shell can stop
 * the commit chain.
 *
 * Run: npx tsx scripts/_pr91-cut-verify.ts
 */

import { generatePrintBatchCutSVG } from "../server/print-batch";

interface RectAttrs {
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  fill: string;
}

function parseRects(svg: string): RectAttrs[] {
  const rects: RectAttrs[] = [];
  const re = /<rect\s+([^/>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const attrs = m[1];
    const pick = (name: string): string | null => {
      const am = new RegExp(`${name}="([^"]+)"`).exec(attrs);
      return am ? am[1] : null;
    };
    rects.push({
      x: parseFloat(pick("x") || "0"),
      y: parseFloat(pick("y") || "0"),
      width: parseFloat(pick("width") || "0"),
      height: parseFloat(pick("height") || "0"),
      stroke: pick("stroke") || "",
      fill: pick("fill") || "",
    });
  }
  return rects;
}

function approxEq(a: number, b: number, eps = 0.001): boolean {
  return Math.abs(a - b) < eps;
}

function assert(label: string, ok: boolean, detail: string = ""): boolean {
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}${detail ? "  " + detail : ""}`);
  return ok;
}

function main(): void {
  console.log("PR #91 cut-layer verification\n");
  const svg = generatePrintBatchCutSVG(4);
  const rects = parseRects(svg);

  let allOk = true;

  // Count
  allOk = assert(`8 cut rects total`, rects.length === 8, `(found ${rects.length})`) && allOk;

  // Per-rect dimensions
  // Layout: even-indexed rects are slabs (70×20 + 0.25 inset → 69.5×19.5),
  //         odd-indexed rects are inserts (85.6×54 + 0.25 inset → 85.1×53.5).
  let slabCount = 0;
  let insertCount = 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const isSlab = approxEq(r.width, 69.5) && approxEq(r.height, 19.5);
    const isInsert = approxEq(r.width, 85.1) && approxEq(r.height, 53.5);
    if (isSlab) slabCount++;
    if (isInsert) insertCount++;
  }
  allOk = assert(`4 slab cut rects (69.5 × 19.5 mm)`, slabCount === 4, `(found ${slabCount})`) && allOk;
  allOk = assert(`4 insert cut rects (85.1 × 53.5 mm)`, insertCount === 4, `(found ${insertCount})`) && allOk;

  // Stroke + fill
  const allMagenta = rects.every(r => r.stroke === "#FF00FF");
  const allNoFill  = rects.every(r => r.fill === "none");
  allOk = assert(`All strokes = #FF00FF`, allMagenta) && allOk;
  allOk = assert(`All fills = none`, allNoFill) && allOk;

  // <g id="cut"> wrapper
  const hasCutGroup = /<g\s+id="cut">/.test(svg);
  allOk = assert(`Wrapped in <g id="cut">`, hasCutGroup) && allOk;

  console.log(`\n${allOk ? "PASS" : "FAIL"} — ${allOk ? "all assertions met" : "see ✗ above"}`);
  if (!allOk) process.exit(1);
}

main();
