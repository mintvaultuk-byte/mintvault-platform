#!/usr/bin/env node
const path = require("node:path");
const integrity = require("../lib/helper-integrity");

integrity.configureRuntime({
  isPackaged: false,
  resourcesPath: path.resolve(__dirname, ".."),
  execPath: process.execPath,
});
const verified = integrity.verifiedCaptureHelper();
process.stdout.write(`${JSON.stringify({
  ok: true,
  helper: verified.path,
  helperVersion: verified.manifest.helperVersion,
  protocolVersion: verified.manifest.protocolVersion,
  sha256: verified.manifest.sha256,
  signingIdentifier: verified.helperSignature.identifier,
  teamIdentifier: verified.helperSignature.teamIdentifier || null,
})}\n`);
