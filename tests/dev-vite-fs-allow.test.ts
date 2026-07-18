/**
 * Dev-server stability regression: the Vite middleware must allow serving from
 * the REAL node_modules directory. Root cause of the review-server exit(1) loop:
 * with node_modules symlinked to a shared checkout, package assets (@fontsource
 * fonts) resolve to a realpath OUTSIDE the worktree root; Vite's default fs.allow
 * rejects it, and setupVite's customLogger.error escalates that 403 to
 * process.exit(1) — killing the dev server on the first font request.
 *
 * Source assertion (dev-only file; no server spun up here).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const VITE = readFileSync(join(process.cwd(), "server/vite.ts"), "utf8");

describe("dev server serves symlinked node_modules assets (no fs-allow exit-1)", () => {
  it("setupVite sets server.fs.allow including the real node_modules path", () => {
    expect(VITE).toContain("fs: { allow: fsAllow }");
    expect(VITE).toContain("fs.realpathSync");
    expect(VITE).toMatch(/node_modules/);
  });
  it("the realpath resolution is guarded so a missing node_modules can't throw at boot", () => {
    const block = VITE.slice(VITE.indexOf("const fsAllow"), VITE.indexOf("const serverOptions"));
    expect(block).toContain("try {");
    expect(block).toContain("catch");
  });
  it("the customLogger.error still exists (fail-fast on real Vite errors is unchanged)", () => {
    // We fixed the CAUSE (the fs-allow denial), not by removing fail-fast.
    expect(VITE).toContain("process.exit(1)");
    expect(VITE).toContain("customLogger");
  });
});
