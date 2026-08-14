#!/usr/bin/env node
const path = require("node:path");
const integrity = require("../lib/helper-integrity");

integrity.configureRuntime({
  isPackaged: false,
  resourcesPath: path.resolve(__dirname, ".."),
  execPath: process.execPath,
});
const verified = integrity.verifiedCaptureHelper();
const identity = integrity.verifiedIdentityHelper();
process.stdout.write(`${JSON.stringify({
  ok: true,
  helpers: [verified, identity].map((entry) => ({
    helper: entry.path,
    helperVersion: entry.manifest.helperVersion,
    protocolVersion: entry.manifest.protocolVersion,
    sha256: entry.manifest.sha256,
    signingIdentifier: entry.helperSignature.identifier,
    teamIdentifier: entry.helperSignature.teamIdentifier || null,
  })),
})}\n`);
