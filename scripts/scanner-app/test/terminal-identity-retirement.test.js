"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _private } = require("../lib/terminal-identity-retirement");

function fixture(t, { afterRetire = () => {}, pendingSemantic = false, evidence = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-terminal-retire-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appSupport = path.join(root, "support");
  const scansBase = path.join(root, "scans");
  fs.mkdirSync(appSupport, { recursive: true });
  fs.mkdirSync(scansBase, { recursive: true });
  const semanticFile = path.join(appSupport, "semantic.json");
  const profileFile = path.join(appSupport, "profile.json");
  const queueFile = path.join(scansBase, "queue.json");
  const operatorSessionFile = path.join(appSupport, "operator-session.json");
  for (const file of [semanticFile, profileFile, queueFile]) fs.writeFileSync(file, path.basename(file));
  fs.writeFileSync(operatorSessionFile, "old-human-session");
  const fingerprint = "a".repeat(64);
  const state = {
    value: { state: "READY_V2", stationCode: "MV-STN-TERMINAL", publicKeyFingerprint: fingerprint },
    retires: 0,
    cleanup: 0,
    semanticCleanup: 0,
  };
  const guard = { pendingSemantic, evidence, rawExtraFiles: [] };
  const identity = {
    identityStatus: () => ({ ...state.value }),
    retireIdentity: (expected) => {
      assert.equal(expected, fingerprint);
      state.retires += 1;
      state.value = { state: "ABSENT_NEW" };
      return { state: "ABSENT_NEW", retiredFingerprint: fingerprint };
    },
    clearOperatorSession: () => {
      try { fs.unlinkSync(operatorSessionFile); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    },
  };
  const semantic = {
    retirementFiles: () => {
      if (guard.pendingSemantic) throw new Error("Pending semantic operations must reconcile");
      return [semanticFile];
    },
    retirementPaths: () => [semanticFile],
    completeIdentityRetirement: () => { state.semanticCleanup += 1; },
  };
  const profile = { retirementFiles: () => [profileFile] };
  const watcher = {
    identityRetirementFiles: () => {
      if (guard.evidence) throw new Error("Encrypted evidence custody must resolve");
      return [queueFile];
    },
    identityRetirementRawFiles: () => [queueFile, ...guard.rawExtraFiles],
    completeIdentityRetirement: () => { state.cleanup += 1; },
  };
  const tombstonePath = path.join(appSupport, "retirement.json");
  const coordinator = _private.createCoordinator({
    identity, semantic, profile, appSupport, scansBase,
    tombstonePath,
    afterRetire,
  });
  return {
    coordinator, identity, watcher, state, guard, fingerprint, tombstonePath,
    appSupport, scansBase, operatorSessionFile, files: [semanticFile, profileFile, queueFile],
  };
}

function terminalRequest(f, status) {
  return {
    status,
    stationCode: "MV-STN-TERMINAL",
    publicKeyFingerprint: f.fingerprint,
    watcher: f.watcher,
  };
}

test("only exact terminal status retires once and leaves a fresh local namespace", (t) => {
  const f = fixture(t);
  for (const status of ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "UNKNOWN"]) {
    assert.equal(f.coordinator.retire(terminalRequest(f, status)).retired, false);
  }
  const result = f.coordinator.retire(terminalRequest(f, "REJECTED"));
  assert.equal(result.retired, true);
  assert.equal(f.state.retires, 1);
  assert.equal(f.state.cleanup, 1);
  assert.equal(f.state.semanticCleanup, 1);
  for (const file of f.files) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(f.operatorSessionFile), false);
  assert.equal(f.coordinator.recoverIfRetired({ watcher: f.watcher }).recovered, false);
});

test("retirement refuses pending semantic work or encrypted evidence without touching the key", (t) => {
  for (const option of [{ pendingSemantic: true }, { evidence: true }]) {
    const f = fixture(t, option);
    assert.throws(
      () => f.coordinator.retire(terminalRequest(f, "EXPIRED")),
      /Pending semantic|Encrypted evidence/,
    );
    assert.equal(f.state.retires, 0);
    for (const file of f.files) assert.equal(fs.existsSync(file), true);
  }
});

test("crash after exact key retirement recovers cleanup before a second identity", (t) => {
  let crash = true;
  const f = fixture(t, { afterRetire: () => { if (crash) throw new Error("injected crash after retire"); } });
  assert.throws(
    () => f.coordinator.retire(terminalRequest(f, "CANCELLED")),
    /injected crash/,
  );
  assert.equal(f.state.value.state, "ABSENT_NEW");
  assert.equal(f.state.retires, 1);
  for (const file of f.files) assert.equal(fs.existsSync(file), true, "identity-scoped state remains until tombstone recovery");
  crash = false;
  const recovered = f.coordinator.recoverIfRetired({ watcher: f.watcher });
  assert.equal(recovered.recovered, true);
  for (const file of f.files) assert.equal(fs.existsSync(file), false);
  assert.equal(f.state.cleanup, 1);
});

test("retirement failure never deletes state or silently creates a second identity", (t) => {
  const f = fixture(t);
  f.identity.retireIdentity = () => { throw new Error("helper retirement failed"); };
  assert.throws(
    () => f.coordinator.retire(terminalRequest(f, "REJECTED")),
    /helper retirement failed/,
  );
  assert.equal(f.state.value.state, "READY_V2");
  for (const file of f.files) assert.equal(fs.existsSync(file), true);
  assert.equal(f.coordinator.readTombstone().phase, "PREPARED");
});

test("missing or different authoritative fingerprint cannot retire the local key", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.coordinator.retire({ ...terminalRequest(f, "REJECTED"), publicKeyFingerprint: undefined }),
    /did not identify the exact device credential/,
  );
  assert.throws(
    () => f.coordinator.retire({ ...terminalRequest(f, "REJECTED"), publicKeyFingerprint: "b".repeat(64) }),
    /does not match this device identity/,
  );
  assert.equal(f.state.retires, 0);
});

test("a precreated or stale PREPARED tombstone cannot omit guarded custody", (t) => {
  const f = fixture(t);
  _private.durableWrite(f.tombstonePath, {
    schemaVersion: 1,
    phase: "PREPARED",
    terminalStatus: "REJECTED",
    stationCode: "MV-STN-TERMINAL",
    publicKeyFingerprint: f.fingerprint,
    files: [],
    preparedAt: new Date().toISOString(),
  });
  assert.throws(
    () => f.coordinator.retire(terminalRequest(f, "REJECTED")),
    /custody set changed/,
  );
  assert.equal(f.state.retires, 0);
  for (const file of f.files) assert.equal(fs.existsSync(file), true);
});

test("custody that becomes pending after PREPARED keeps the exact key intact", (t) => {
  for (const guardName of ["pendingSemantic", "evidence"]) {
    const f = fixture(t);
    f.identity.retireIdentity = () => { throw new Error("prepare-only injected helper refusal"); };
    assert.throws(() => f.coordinator.retire(terminalRequest(f, "EXPIRED")), /prepare-only/);
    f.guard[guardName] = true;
    f.identity.retireIdentity = () => {
      f.state.retires += 1;
      throw new Error("key must not be touched");
    };
    assert.throws(
      () => f.coordinator.retire(terminalRequest(f, "EXPIRED")),
      /Pending semantic|Encrypted evidence/,
    );
    assert.equal(f.state.retires, 0);
  }
});

test("operator-session deletion failure keeps the tombstone and restart recovery retries it", (t) => {
  const f = fixture(t);
  let fail = true;
  const clear = f.identity.clearOperatorSession;
  f.identity.clearOperatorSession = () => {
    if (fail) throw new Error("injected operator-session unlink failure");
    clear();
  };
  assert.throws(() => f.coordinator.retire(terminalRequest(f, "REJECTED")), /unlink failure/);
  assert.equal(f.state.value.state, "ABSENT_NEW");
  assert.equal(fs.existsSync(f.operatorSessionFile), true);
  assert.equal(f.coordinator.readTombstone().phase, "PREPARED");
  fail = false;
  assert.equal(f.coordinator.recoverIfRetired({ watcher: f.watcher }).recovered, true);
  assert.equal(fs.existsSync(f.operatorSessionFile), false);
  assert.equal(f.coordinator.readTombstone(), null);
});

test("boot recovery finishes an exact native RETIREMENT_INCOMPLETE transition", (t) => {
  const f = fixture(t);
  let first = true;
  f.identity.retireIdentity = (expected) => {
    assert.equal(expected, f.fingerprint);
    f.state.retires += 1;
    if (first) {
      first = false;
      f.state.value = {
        state: "RETIREMENT_INCOMPLETE",
        stationCode: "MV-STN-TERMINAL",
        publicKeyFingerprint: f.fingerprint,
        credentialUsable: false,
      };
      throw new Error("injected native retirement interruption");
    }
    f.state.value = { state: "ABSENT_NEW" };
    return { state: "ABSENT_NEW", retiredFingerprint: f.fingerprint };
  };
  assert.throws(() => f.coordinator.retire(terminalRequest(f, "CANCELLED")), /native retirement interruption/);
  assert.equal(f.coordinator.readTombstone().phase, "PREPARED");
  assert.equal(f.coordinator.recoverIfRetired({ watcher: f.watcher }).recovered, true);
  assert.equal(f.state.retires, 2);
  assert.equal(f.coordinator.readTombstone(), null);
});

test("cold boot recovery never asks a RETIRE-journalled helper to unwrap custody", (t) => {
  const f = fixture(t);
  let first = true;
  f.identity.retireIdentity = (expected) => {
    assert.equal(expected, f.fingerprint);
    f.state.retires += 1;
    if (first) {
      first = false;
      f.state.value = {
        state: "RETIREMENT_INCOMPLETE",
        stationCode: "MV-STN-TERMINAL",
        publicKeyFingerprint: f.fingerprint,
        credentialUsable: true,
      };
      throw new Error("injected crash after native RETIRE journal");
    }
    f.state.value = { state: "ABSENT_NEW" };
    return { state: "ABSENT_NEW", retiredFingerprint: f.fingerprint };
  };
  assert.throws(() => f.coordinator.retire(terminalRequest(f, "REJECTED")), /RETIRE journal/);
  f.guard.pendingSemantic = true;
  f.guard.evidence = true;
  assert.equal(f.coordinator.recoverIfRetired({ watcher: f.watcher }).recovered, true);
  assert.equal(f.state.retires, 2);
  assert.equal(f.coordinator.readTombstone(), null);
});

test("plaintext arriving after PREPARED cannot cross into a fresh identity", (t) => {
  const f = fixture(t);
  const arrived = path.join(f.scansBase, "inbox-arrived-after-prepare.tiff");
  const originalRetire = f.identity.retireIdentity;
  f.identity.retireIdentity = (expected) => {
    const result = originalRetire(expected);
    fs.writeFileSync(arrived, "prior identity card bytes");
    f.guard.rawExtraFiles.push(arrived);
    return result;
  };
  assert.throws(
    () => f.coordinator.retire(terminalRequest(f, "EXPIRED")),
    /Unexpected identity-scoped custody/,
  );
  assert.equal(f.state.value.state, "ABSENT_NEW");
  assert.equal(fs.existsSync(arrived), true);
  assert.equal(f.coordinator.readTombstone().phase, "PREPARED");
});
