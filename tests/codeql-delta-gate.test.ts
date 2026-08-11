/**
 * codeql-delta-gate.test.ts — the governance proof for the CodeQL baseline policy.
 *
 * The owner grandfathered the HIGH/CRITICAL findings already present on `main` (2026-08-10). That
 * decision is only safe if the mechanism enforcing it can tell inherited debt from newly
 * introduced debt — otherwise "baseline" quietly becomes "ignore", which is the failure mode a
 * security baseline is famous for.
 *
 * So both directions are pinned here, and neither is optional:
 *
 *   an inherited HIGH  → allowed, build stays green
 *   a NEW HIGH         → release gate RED
 *
 * These run with no network and no GitHub token: `evaluateDelta` is pure, which is why the CLI
 * shell around it is deliberately thin.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateDelta, extractBlockingPairs, pairKey } from "../scripts/ci/assert-codeql-delta.mjs";

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), "security/codeql-baseline.json"), "utf8"),
) as { count: number; pairs: Array<{ rule: string; path: string; severity: string }> };

/** A REST-shaped alert, so the test feeds the gate what GitHub actually returns. */
const alert = (rule: string, path: string, severity = "high") => ({
  rule: { id: rule, security_severity_level: severity },
  most_recent_instance: { location: { path } },
});

describe("CodeQL delta gate — inherited debt passes, new findings block", () => {
  it("the baseline file is a real, non-empty pin of what was on main", () => {
    expect(baseline.pairs.length).toBeGreaterThan(0);
    expect(baseline.count).toBe(baseline.pairs.length);
    // Every entry must be a blocking severity — a baseline containing mediums would silently widen
    // the grandfathering beyond what the owner approved.
    for (const p of baseline.pairs) {
      expect(["high", "critical"], `${p.rule} ${p.path}`).toContain(p.severity);
    }
    // And no duplicates, or `count` stops meaning anything.
    expect(new Set(baseline.pairs.map(pairKey)).size).toBe(baseline.pairs.length);
  });

  it("PROOF 1 — an inherited HIGH does NOT block", () => {
    const inherited = baseline.pairs.map((p) => alert(p.rule, p.path, p.severity));
    const v = evaluateDelta({ baselinePairs: baseline.pairs, currentAlerts: inherited, analysisRan: true });
    expect(v.ok, `blocked on inherited debt: ${JSON.stringify(v.introduced)}`).toBe(true);
    expect(v.introduced).toEqual([]);
    expect(v.inherited.length).toBe(baseline.pairs.length);
  });

  it("PROOF 2 — a NEW HIGH in a NEW file blocks, and is named", () => {
    const v = evaluateDelta({
      baselinePairs: baseline.pairs,
      currentAlerts: [
        ...baseline.pairs.map((p) => alert(p.rule, p.path, p.severity)),
        alert("js/sql-injection", "server/partner/brand-new-file.ts"),
      ],
      analysisRan: true,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("new_high_or_critical");
    expect(v.introduced).toHaveLength(1);
    expect(v.introduced[0]).toMatchObject({ rule: "js/sql-injection", path: "server/partner/brand-new-file.ts" });
  });

  it("PROOF 3 — a NEW RULE in an ALREADY-BASELINED file still blocks", () => {
    // The likeliest real regression: someone edits a file that already carries inherited debt and
    // introduces a different vulnerability class in it. Baselining by file alone would swallow this.
    const victim = baseline.pairs[0];
    const v = evaluateDelta({
      baselinePairs: baseline.pairs,
      currentAlerts: [alert(victim.rule, victim.path, victim.severity), alert("js/path-injection", victim.path)],
      analysisRan: true,
    });
    expect(v.ok).toBe(false);
    expect(v.introduced.map((i) => i.rule)).toEqual(["js/path-injection"]);
  });

  it("PROOF 4 — a CRITICAL is blocking even though the baseline holds only highs", () => {
    const v = evaluateDelta({
      baselinePairs: baseline.pairs,
      currentAlerts: [alert("js/code-injection", "server/anywhere.ts", "critical")],
      analysisRan: true,
    });
    expect(v.ok).toBe(false);
    expect(v.introduced[0].severity).toBe("critical");
  });

  it("MEDIUM and LOW are not blocking — the policy is HIGH/CRITICAL only", () => {
    const v = evaluateDelta({
      baselinePairs: baseline.pairs,
      currentAlerts: [alert("js/whatever", "server/new.ts", "medium"), alert("js/other", "server/new2.ts", "low")],
      analysisRan: true,
    });
    expect(v.ok).toBe(true);
    expect(v.introduced).toEqual([]);
  });

  /**
   * The vacuous-green case, and the reason `analysisRan` is a required input rather than inferred
   * from an empty list. An analysis that silently failed also reports zero findings.
   */
  it("PROOF 5 — an analysis that did NOT run fails the gate, even with zero alerts", () => {
    const v = evaluateDelta({ baselinePairs: baseline.pairs, currentAlerts: [], analysisRan: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("analysis_did_not_run");
    expect(v.message).toMatch(/did not run is not zero findings/i);
  });

  it("a resolved baselined finding is reported, not treated as a failure", () => {
    // Fixing inherited debt must never turn the build red — and the operator should be told the
    // baseline can be trimmed, or it drifts wider than reality forever.
    const v = evaluateDelta({
      baselinePairs: baseline.pairs,
      currentAlerts: baseline.pairs.slice(1).map((p) => alert(p.rule, p.path, p.severity)),
      analysisRan: true,
    });
    expect(v.ok).toBe(true);
    expect(v.resolved).toEqual([pairKey(baseline.pairs[0])]);
  });

  it("extractBlockingPairs de-duplicates and ignores non-blocking severities", () => {
    const pairs = extractBlockingPairs([
      alert("js/a", "f.ts"),
      alert("js/a", "f.ts"), // same finding reported twice
      alert("js/b", "f.ts", "medium"),
      { rule: { id: "js/c" }, most_recent_instance: { location: { path: "g.ts" } } }, // no severity
    ]);
    expect(pairs).toEqual([{ rule: "js/a", path: "f.ts", severity: "high" }]);
  });
});
