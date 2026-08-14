const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const contract = require("./package-contract");
const preparation = require("./prepare-macos-package");

function inspect(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} package-input verification failed`);
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function signature(filePath) {
  const output = inspect("/usr/bin/codesign", ["-d", "--verbose=4", filePath]);
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  return {
    identifier: /^Identifier=(.+)$/m.exec(output)?.[1]?.trim() || "",
    teamIdentifier: team === "not set" ? "" : team,
    hardenedRuntime: /\bflags=0x[0-9a-f]+\(runtime\)/i.test(output),
  };
}

module.exports = async function beforePack() {
  const mode = contract.packageMode();
  const record = JSON.parse(fs.readFileSync(preparation.PREPARATION_RECORD, "utf8"));
  if (!process.env.MINTVAULT_PREPARATION_ID || record.preparationId !== process.env.MINTVAULT_PREPARATION_ID
      || record.phase !== "READY" || record.mode !== mode) {
    throw new Error("electron-builder may run only through the fresh MintVault package orchestrator");
  }
  if (Date.now() - Date.parse(record.sealedAt) > 2 * 60 * 60 * 1000) throw new Error("package preparation record is stale");
  const source = preparation.sourceState();
  if (record.sourceCommit !== source.sourceCommit || (mode === "release" && source.sourceTreeState !== "clean")) {
    throw new Error("source changed after package preparation");
  }
  const trust = JSON.parse(fs.readFileSync(preparation.RELEASE_TRUST, "utf8"));
  if (trust.packageMode !== mode || trust.teamIdentifier !== record.teamIdentifier || trust.version !== record.version
      || trust.updateBaseUrl !== record.updateBaseUrl) {
    throw new Error("release trust does not match the fresh package preparation");
  }
  for (const [name, expectedIdentifier] of [["capture", contract.CAPTURE_HELPER_IDENTIFIER], ["identity", contract.IDENTITY_HELPER_IDENTIFIER]]) {
    const helper = record.helpers[name];
    const helperPath = path.join(preparation.ROOT, "native", "bin", helper.name);
    const manifestName = name === "capture" ? "helper-manifest.json" : "identity-helper-manifest.json";
    const sourceName = name === "capture" ? "mintvault-lide-bridge.m" : "mv-identity-helper.swift";
    const manifest = JSON.parse(fs.readFileSync(path.join(preparation.ROOT, "native", "bin", manifestName), "utf8"));
    const digest = contract.run("/usr/bin/shasum", ["-a", "256", helperPath]).trim().split(/\s+/)[0];
    const sourceDigest = contract.run("/usr/bin/shasum", ["-a", "256", path.join(preparation.ROOT, "native", sourceName)]).trim().split(/\s+/)[0];
    const authorityDigest = name === "identity"
      ? contract.run("/usr/bin/shasum", ["-a", "256", preparation.RELEASE_TEAM_PIN_SWIFT]).trim().split(/\s+/)[0]
      : null;
    const expectedBinding = { preparationId: record.preparationId, packageMode: record.mode, sourceCommit: record.sourceCommit, teamIdentifier: record.teamIdentifier };
    if (digest !== helper.sha256 || helper.identifier !== expectedIdentifier || manifest.sha256 !== digest
        || manifest.sourceSha256 !== sourceDigest
        || (name === "identity" && manifest.authoritySourceSha256 !== authorityDigest)
        || JSON.stringify(manifest.packageBinding) !== JSON.stringify(expectedBinding)) {
      throw new Error(`${name} helper input is stale or belongs to another preparation`);
    }
    inspect("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", helperPath]);
    const details = signature(helperPath);
    if (details.identifier !== expectedIdentifier) throw new Error(`${name} helper signing identifier drifted`);
    if (mode === "release" && (details.teamIdentifier !== record.teamIdentifier || !details.hardenedRuntime)) {
      throw new Error(`${name} helper is not a pinned hardened release input`);
    }
    if (mode === "local" && details.teamIdentifier) throw new Error(`${name} helper local input is not ad-hoc`);
  }
  const expectedPinSource = `module.exports = Object.freeze(${JSON.stringify(record.releaseTeamPin)});\n`;
  if (fs.readFileSync(preparation.RELEASE_TEAM_PIN_JS, "utf8") !== expectedPinSource) {
    throw new Error("packaged runtime Team pin does not match the preparation authority");
  }
};
