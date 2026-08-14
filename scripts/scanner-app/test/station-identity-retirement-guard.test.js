"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("fresh identity creation runs retirement recovery and refuses any prior namespace residue", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-identity-create-guard-"));
  const prior = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = root;
  const helperPath = require.resolve("../lib/identity-helper-client");
  const identityPath = require.resolve("../lib/station-identity");
  const runtimePath = require.resolve("../lib/runtime-paths");
  const originalHelper = require.cache[helperPath];
  t.after(() => {
    if (prior === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = prior;
    if (originalHelper) require.cache[helperPath] = originalHelper;
    else delete require.cache[helperPath];
    delete require.cache[identityPath];
    delete require.cache[runtimePath];
    fs.rmSync(root, { recursive: true, force: true });
  });

  delete require.cache[runtimePath];
  const runtimePaths = require("../lib/runtime-paths");
  runtimePaths.configureRuntime({ isPackaged: false });
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeyFingerprint = crypto.createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
  let creates = 0;
  require.cache[helperPath] = {
    id: helperPath,
    filename: helperPath,
    loaded: true,
    exports: {
      status: () => ({ state: "ABSENT_NEW", schemaVersion: 2 }),
      create: () => {
        creates += 1;
        return {
          state: "READY_V2",
          schemaVersion: 2,
          installationId: crypto.randomUUID(),
          publicKeyPem,
          publicKeyFingerprint,
        };
      },
    },
  };
  delete require.cache[identityPath];
  const identity = require("../lib/station-identity");
  let recoveryChecks = 0;
  identity.configureRetirementGuard(() => { recoveryChecks += 1; });

  const residue = path.join(root, "capture-queue", "artifacts", "prior-identity.mvq");
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, "old encrypted custody");
  assert.throws(() => identity.enrolmentPublicPayload("1.2.1"), { code: "IDENTITY_RECOVERY_REQUIRED" });
  assert.equal(recoveryChecks, 1);
  assert.equal(creates, 0);

  fs.unlinkSync(residue);
  const payload = identity.enrolmentPublicPayload("1.2.1");
  assert.equal(payload.publicKeyFingerprint, publicKeyFingerprint);
  assert.equal(recoveryChecks, 2);
  assert.equal(creates, 1);
});
