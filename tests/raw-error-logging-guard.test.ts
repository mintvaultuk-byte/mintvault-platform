import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Source guard against NEW raw-error logging (Phase 2 / L5).
 *
 * Logging `console.error(`...${err.message}...`)` can leak connection strings,
 * signed URLs, emails, tokens and filesystem paths into server logs. The fix is
 * to log safeErrorSummary(err) instead. There is a large pre-existing backlog of
 * such sites, so this guard does two things:
 *   1. Pins the backlog at a baseline COUNT and fails if it GROWS (new sites).
 *      Removing sites (count goes down) is always fine — lower the baseline.
 *   2. Keeps the central error path (server/index.ts) at ZERO such sites.
 *
 * Incremental replacement of the backlog is tracked debt (Phase 18), not Phase 2.
 */

const ROOT = process.cwd();

// console.(error|warn)( ... <err|error|e|ex> ... .message  — single line
const RAW_ERR_LOG = /console\.(error|warn)\([^)]*\b(err|error|e|ex)\b[^)]*\.message/;

function serverTsFiles(dir = path.join(ROOT, "server")): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...serverTsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function countRawErrorLogs(): { total: number; perFile: Map<string, number> } {
  const perFile = new Map<string, number>();
  let total = 0;
  for (const file of serverTsFiles()) {
    let n = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (RAW_ERR_LOG.test(line)) n++;
    }
    if (n > 0) perFile.set(path.relative(ROOT, file), n);
    total += n;
  }
  return { total, perFile };
}

// Baseline captured 2026-06-24 after the Phase 2 central-path fixes. This number
// must only ever go DOWN. A new raw-error log anywhere pushes it up and fails CI.
const BASELINE = 318;

describe("raw-error-logging source guard", () => {
  const { total } = countRawErrorLogs();

  it("does not add NEW raw-error message logging beyond the tracked baseline", () => {
    expect(
      total,
      total > BASELINE
        ? `New raw-error logging detected (${total} > ${BASELINE}). Log safeErrorSummary(err) instead of err.message.`
        : `Backlog reduced to ${total} — lower BASELINE in this test to ${total} to lock the gain.`
    ).toBeLessThanOrEqual(BASELINE);
  });

  it("keeps the central error handler on safeErrorSummary (no raw error/stack)", () => {
    const idx = fs.readFileSync(path.join(ROOT, "server/index.ts"), "utf8");
    // The Phase 2 central handler logs a safe summary, not the raw error.
    expect(idx).toMatch(/console\.error\("\[unhandled-error\]", safeErrorSummary\(err,/);
    expect(idx).not.toContain("Internal Server Error [reqId=");
  });
});
