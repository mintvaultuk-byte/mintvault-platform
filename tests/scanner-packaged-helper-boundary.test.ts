import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function source(relative: string) {
  return readFileSync(path.join(process.cwd(), "scripts", "scanner-app", relative), "utf8");
}

describe("Scanner packaged capture-helper boundary", () => {
  const controller = source("lib/lide400-controller.js");
  const integrity = source("lib/helper-integrity.js");
  const main = source("main.js");
  const native = source("native/mintvault-lide-bridge.m");

  it("contains no station-runtime compiler or mutable Application Support helper fallback", () => {
    expect(controller).not.toContain("/usr/bin/xcrun");
    expect(controller).not.toMatch(/\bclang\b/);
    expect(controller).not.toContain("Application Support");
    expect(controller).not.toContain("mintvault-lide-bridge.m");
    expect(controller).toContain("verifiedCaptureHelper().path");
  });

  it("configures the resolver from Electron's non-overridable packaged runtime facts", () => {
    expect(main).toContain("isPackaged: app.isPackaged");
    expect(main).toContain("resourcesPath: process.resourcesPath");
    expect(main).toContain("execPath: process.execPath");
    expect(integrity).toContain('path.join(configuredRuntime.resourcesPath, "helpers")');
    expect(integrity).not.toContain("process.env");
  });

  it("pins helper name, identifier, protocol, architecture, macOS floor, signature and Team boundary", () => {
    for (const contract of [
      '"mv-capture-helper"',
      '"com.mintvault.scanner.capture-helper"',
      'architecture: "arm64"',
      'minimumMacOS: MINIMUM_MACOS',
      '"/usr/bin/lipo"',
      '"/usr/bin/otool"',
      '"/usr/bin/codesign"',
      "Team Identifier does not match",
      "SHA-256 does not match",
    ]) expect(integrity).toContain(contract);
    expect(native).toContain('kHelperVersion = @"1.0.0"');
    expect(native).toContain('versioned[@"protocolVersion"]');
  });
});
