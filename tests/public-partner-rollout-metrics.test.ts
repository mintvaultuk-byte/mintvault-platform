import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const fixtureDir = mkdtempSync(join(tmpdir(), "mintvault-public-rollout-"));
const script = join(process.cwd(), "scripts/public-partner-rollout-metrics.mjs");

function run(lines: string[]) {
  const path = join(fixtureDir, `rollout-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(path, lines.join("\n"), "utf8");
  const result = spawnSync(process.execPath, [script, path, "--minutes=15"], { encoding: "utf8" });
  return { ...result, report: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
}

function line(path: string, status: number, durationMs: number) {
  return `${new Date().toISOString()} app[test] lhr [info] GET ${path} ${status} in ${durationMs}ms`;
}

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe("public Partner rollout threshold analyser", () => {
  it("counts the exact API, HTML and sitemap denominator and accepts a healthy window", () => {
    const result = run([
      line("/api/public/partners", 200, 80),
      line("/find-a-partner", 200, 120),
      line("/partners/location/storefront-ref-a", 404, 140),
      line("/sitemap.xml", 200, 160),
      line("/unrelated", 503, 9999),
    ]);
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      requests: 4,
      serverErrors: 0,
      p95Ms: 160,
      decision: "CONTINUE",
    });
  });

  it("returns a rollback exit code when any 5xx breaches the one-percent threshold", () => {
    const result = run([line("/api/public/partners", 503, 40)]);
    expect(result.status).toBe(2);
    expect(result.report).toMatchObject({ requests: 1, serverErrors: 1, decision: "ROLL_BACK" });
  });
});
