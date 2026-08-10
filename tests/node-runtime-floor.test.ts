/**
 * Node runtime floor.
 *
 * `file-type@22` is pure ESM (`"type": "module"`) and the server bundles to CJS
 * (script/build.ts emits dist/index.cjs), so `require()`ing it depends on Node's `require(esm)`
 * support. That landed in 20.19.0 and is NOT present in earlier Node 20 patches — on 20.18 the
 * production bundle throws ERR_REQUIRE_ESM at boot.
 *
 * The Dockerfile previously used the floating `node:20-slim` tag. That resolves to 20.20.2 today,
 * which is fine, but nothing recorded or enforced the ≥20.19 requirement, so the guarantee rested
 * on a tag someone else controls. This pins an explicit patch and pins the reasoning with it: if
 * anyone moves the base image below the floor, this test goes red rather than the container
 * failing at boot.
 *
 * Deliberately NOT a move to Node 22 — that is a bigger change than this PR needs, and 20.20.2
 * already clears the floor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIN_MAJOR = 20;
const MIN_MINOR = 19;

describe("Node runtime floor", () => {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
  const fromLines = dockerfile.split("\n").filter((l) => /^FROM node:/.test(l.trim()));

  it("every Node stage pins an explicit patch, never a floating major tag", () => {
    expect(fromLines.length, "Dockerfile must still have Node build and production stages").toBe(2);
    for (const line of fromLines) {
      const tag = /^FROM node:([^\s]+)/.exec(line.trim())?.[1] ?? "";
      expect(tag, `floating tag in "${line.trim()}" — pin an explicit patch`).toMatch(/^\d+\.\d+\.\d+-/);
    }
  });

  it("every pinned Node version is at or above the require(esm) floor of 20.19", () => {
    for (const line of fromLines) {
      const tag = /^FROM node:(\d+)\.(\d+)\.(\d+)/.exec(line.trim());
      expect(tag, `could not parse a version from "${line.trim()}"`).toBeTruthy();
      const [major, minor] = [Number(tag![1]), Number(tag![2])];
      const meetsFloor = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
      expect(
        meetsFloor,
        `${line.trim()} is below Node ${MIN_MAJOR}.${MIN_MINOR}; file-type@22 is ESM-only and the ` +
          `server bundles to CJS, so require(esm) support is mandatory`
      ).toBe(true);
    }
  });

  it("file-type is still the ESM-only dependency this floor exists for", () => {
    // If file-type ever stops being ESM-only, this floor is arguably no longer load-bearing — that
    // should be a deliberate decision, not a silent drift.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "node_modules/file-type/package.json"), "utf8"));
    expect(pkg.type, "file-type is expected to be ESM-only").toBe("module");
    expect(String(pkg.engines?.node ?? "")).toMatch(/>=\s*2[02]/);
  });
});
