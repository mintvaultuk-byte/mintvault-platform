import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBuildGitSha } from "../script/build-provenance";

describe("build provenance", () => {
  it("uses the full checked-out commit when Git metadata is available", () => {
    expect(
      resolveBuildGitSha({
        checkoutSha: "59AB3DC662716D69F00B46E8CF45DBF82667CE01",
        environmentSha: "unknown",
        production: true,
      })
    ).toBe("59ab3dc662716d69f00b46e8cf45dbf82667ce01");
  });

  it("uses an injected build argument when the Docker context excludes Git", () => {
    expect(
      resolveBuildGitSha({
        checkoutSha: null,
        environmentSha: "59ab3dc662716d69f00b46e8cf45dbf82667ce01",
        production: true,
      })
    ).toBe("59ab3dc662716d69f00b46e8cf45dbf82667ce01");
  });

  it("refuses a production artifact with missing or unknown provenance", () => {
    expect(() => resolveBuildGitSha({ checkoutSha: null, environmentSha: null, production: true })).toThrow(
      "Production build provenance is required"
    );
    expect(() => resolveBuildGitSha({ checkoutSha: null, environmentSha: "unknown", production: true })).toThrow(
      "Production build provenance is required"
    );
  });

  it("refuses abbreviated provenance for a production artifact", () => {
    expect(() => resolveBuildGitSha({ checkoutSha: "59ab3dc6", environmentSha: null, production: true })).toThrow(
      "full 40-character hexadecimal GIT_SHA"
    );
  });

  it("allows an unknown identity only for a non-production local build", () => {
    expect(resolveBuildGitSha({ checkoutSha: null, environmentSha: null, production: false })).toBe("unknown");
  });

  it("marks Docker builds as provenance-required and has no unknown default", () => {
    const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");
    const buildScript = readFileSync(resolve(process.cwd(), "script/build.ts"), "utf8");
    const deployScript = readFileSync(resolve(process.cwd(), "scripts/safe-deploy.sh"), "utf8");
    expect(dockerfile).toMatch(/^ARG GIT_SHA$/m);
    expect(dockerfile).toMatch(/^ENV BUILD_PROVENANCE_REQUIRED=1$/m);
    expect(dockerfile).not.toMatch(/^ARG GIT_SHA=/m);
    expect(buildScript).toContain('execSync("git rev-parse HEAD"');
    expect(deployScript).toContain('SHA="$(git rev-parse HEAD)"');
    expect(buildScript).not.toContain("git rev-parse --short HEAD");
    expect(deployScript).not.toContain("git rev-parse --short HEAD");
  });

  it("only deploys production from a clean checkout at the exact origin/main SHA", () => {
    const deployScript = readFileSync(resolve(process.cwd(), "scripts/safe-deploy.sh"), "utf8");
    expect(deployScript).toContain('if [ "$TARGET" = "prod" ] && [ "$ALLOW_BEHIND" -eq 1 ]');
    expect(deployScript).toContain('if [ "$TARGET" = "prod" ] && [ "$SHA" != "$REMOTE" ]');
    expect(deployScript).toContain('if [ "$TARGET" = "prod" ] && { [ -n "$DIRTY_TRACKED" ] || [ -n "$UNTRACKED" ]; }');
    expect(deployScript).toContain("production builds require a completely clean worktree");
  });
});
