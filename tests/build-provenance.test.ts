import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBuildGitSha } from "../script/build-provenance";

describe("build provenance", () => {
  it("uses the checked-out commit when Git metadata is available", () => {
    expect(
      resolveBuildGitSha({
        checkoutSha: "59AB3DC6",
        environmentSha: "unknown",
        production: true,
      })
    ).toBe("59ab3dc6");
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

  it("allows an unknown identity only for a non-production local build", () => {
    expect(resolveBuildGitSha({ checkoutSha: null, environmentSha: null, production: false })).toBe("unknown");
  });

  it("marks Docker builds as provenance-required and has no unknown default", () => {
    const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^ARG GIT_SHA$/m);
    expect(dockerfile).toMatch(/^ENV BUILD_PROVENANCE_REQUIRED=1$/m);
    expect(dockerfile).not.toMatch(/^ARG GIT_SHA=/m);
  });
});
