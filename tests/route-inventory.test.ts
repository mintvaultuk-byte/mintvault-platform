import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractRouteRegistrations, duplicateRouteKeys } from "./helpers/extract-routes";

/**
 * Route-uniqueness safety net (remediation Phase 0).
 *
 * The route layer currently carries 115 method+path pairs that are registered
 * twice — once in the server/routes.ts monolith and once in a modular
 * server/routes/* file. They are byte-identical copies (Express uses whichever
 * registers first), so they are a maintenance hazard, not a behavioural bug.
 *
 * This test does NOT fail on that known debt — it pins the current duplicate
 * set as a committed baseline (tests/fixtures/route-duplicates.baseline.json)
 * and fails only when a NEW duplicate is introduced. Phase 3 deletes the
 * duplicates and shrinks the baseline toward empty; this test guards against
 * regressions the whole way.
 */

const BASELINE_PATH = path.join(process.cwd(), "tests/fixtures/route-duplicates.baseline.json");

describe("API route inventory", () => {
  const regs = extractRouteRegistrations();
  const dupes = duplicateRouteKeys(regs);

  it("parses the route sources (extractor sanity)", () => {
    expect(regs.length).toBeGreaterThan(350);
    const unique = new Set(regs.map((r) => r.key));
    expect(unique.size).toBeGreaterThan(350);
  });

  it("registers no route more than twice (no triple+ registration)", () => {
    const overTwice = [...dupes.entries()].filter(([, c]) => c > 2);
    expect(
      overTwice,
      `Route(s) registered more than twice:\n${overTwice.map(([k, c]) => `  ${k} (${c}x)`).join("\n")}`
    ).toEqual([]);
  });

  it("introduces NO new duplicate route beyond the known baseline", () => {
    const baseline: { route: string; count: number }[] = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const baselineKeys = new Set(baseline.map((b) => b.route));
    const introduced = [...dupes.keys()].filter((k) => !baselineKeys.has(k));
    expect(
      introduced,
      `New duplicate route registration(s) detected. Register each path ONCE ` +
        `(prefer the modular server/routes/* file, remove the server/routes.ts copy):\n` +
        introduced.map((k) => `  ${k}`).join("\n")
    ).toEqual([]);
  });
});
