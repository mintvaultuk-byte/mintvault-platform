import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function source(relative: string) {
  return readFileSync(path.join(process.cwd(), "scripts", "scanner-app", relative), "utf8");
}

describe("Scanner packaged native-helper boundary", () => {
  const controller = source("lib/lide400-controller.js");
  const integrity = source("lib/helper-integrity.js");
  const main = source("main.js");
  const native = source("native/mintvault-lide-bridge.m");
  const identity = source("native/mv-identity-helper.swift");
  const identityClient = source("lib/identity-helper-client.js");
  const stationIdentity = source("lib/station-identity.js");
  const builder = source("scripts/build-native-helpers.js");

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

  it("packages the identity helper through the same sealed arm64 and Team boundary", () => {
    for (const contract of [
      '"mv-identity-helper"',
      '"identity-helper-manifest.json"',
      '"com.mintvault.scanner.identity-helper"',
    ]) expect(integrity).toContain(contract);
    expect(identityClient).toContain("verifiedIdentityHelper()");
    expect(identityClient).toContain('spawnSync(helper.path');
    expect(builder).toContain('"swiftc"');
    expect(builder).toContain('signAndVerify(temporaryIdentityOutput, "com.mintvault.scanner.identity-helper")');
  });

  it("keeps station private material inside a device-only Secure Enclave boundary", () => {
    for (const contract of [
      'kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly',
      'kSecAttrSynchronizable as String: kCFBooleanFalse',
      'kSecAttrSynchronizable as String: kSecAttrSynchronizableAny',
      'kSecAttrAccessGroup as String',
      'kSecAttrApplicationTag as String',
      'kSecAttrTokenIDSecureEnclave',
      'SecKeyCreateRandomKey',
      'SecureEnclave.P256.KeyAgreement.PrivateKey',
      'Curve25519.Signing.PrivateKey',
      'AES.GCM.seal',
      'AES.GCM.open',
      '"mintvault-station-request-v1"',
      '"mintvault-station-resync-v1"',
    ]) expect(identity).toContain(contract);
    expect(stationIdentity).not.toMatch(/crypto\.sign\s*\(/);
    expect(stationIdentity).toContain("helper.signRequestV1");
    expect(main).toContain('stage: "identity_recovery_required"');
    expect(main).toContain('["ABSENT_NEW", "READY_V2"].includes(identity.state)');
    expect(identity).toContain("SecCodeCopyGuestWithAttributes");
    expect(identity).toContain('parentContext.identifier == "com.mintvault.scanner"');
    expect(integrity).toContain("pinned MintVault Team Identifier");
    expect(main).toContain("loadReleaseTrust(process.resourcesPath)");
  });
});
