const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const authority = require("../lib/station-authority");

test("human authority distinguishes offline, MFA, enrolment and least privilege", () => {
  assert.equal(authority.sessionStage({ transportError: true }).stage, "offline");
  assert.deepEqual(authority.sessionStage({ ok: false, status: 401 }), { stage: "sign_in", clearSession: true });
  assert.equal(authority.sessionStage({ ok: false, status: 503 }).stage, "degraded");
  assert.equal(authority.sessionStage({ ok: true, body: { mfaPassed: false } }).stage, "mfa");
  assert.equal(
    authority.sessionStage({ ok: true, body: { mfaPassed: false, mfaEnrolmentRequired: true } }).stage,
    "mfa_enrolment_required"
  );

  const operator = authority.sessionStage({
    ok: true,
    body: { mfaPassed: true, permissions: ["partner.cards.scan"] },
  });
  assert.equal(authority.requiredCapabilityStage(operator, { enrolled: true }).stage, "authenticated");
  assert.equal(authority.requiredCapabilityStage(operator, { enrolled: false }).stage, "no_partner_access");
});

test("station status and physical action gates fail closed", () => {
  assert.deepEqual(authority.stationStage("ACTIVE"), { stage: "active" });
  assert.deepEqual(authority.stationStage("REJECTED"), { stage: "rejected", terminalIdentity: true });
  assert.deepEqual(authority.stationStage("CANCELLED"), { stage: "cancelled", terminalIdentity: true });
  assert.deepEqual(authority.stationStage("EXPIRED"), { stage: "expired", terminalIdentity: true });
  assert.deepEqual(authority.stationStage("SUSPENDED"), { stage: "suspended" });
  assert.deepEqual(authority.stationStage("REVOKED"), { stage: "revoked" });
  assert.equal(authority.stationStage("unexpected").stage, "degraded");
  assert.equal(authority.operationalDenial({ stage: "active" }), null);
  assert.deepEqual(authority.operationalDenial({ stage: "revoked" }), {
    ok: false,
    code: "revoked",
    error: "This human and station are not currently authorised for physical work.",
  });
  assert.match(authority.operationalDenial({ stage: "offline" }).error, /New physical operations are paused/);
});

test("ACTIVE is withheld until both server calibration and the device-bound profile are live", () => {
  const active = { stage: "active" };
  const binding = {
    localProfileRevisionId: "profile-a",
    localProfileDigestSha256: "a".repeat(64),
    serverProfileRevisionId: "profile-a",
    serverProfileDigestSha256: "a".repeat(64),
  };
  assert.equal(authority.scannerProfileStage({ stationStage: active, scannerHealth: "checking", calibrationStatus: "VALID", canServiceStation: false }).stage, "scanner_checking");
  assert.equal(authority.scannerProfileStage({ stationStage: active, scannerHealth: "profile_unprovisioned", calibrationStatus: "VALID", canServiceStation: true }).stage, "profile_setup_required");
  assert.equal(authority.scannerProfileStage({ stationStage: active, scannerHealth: "ready", calibrationStatus: "UNPROVISIONED", canServiceStation: false }).stage, "profile_setup_locked");
  assert.equal(authority.scannerProfileStage({ stationStage: active, scannerHealth: "disconnected", calibrationStatus: "VALID", canServiceStation: true }).stage, "scanner_disconnected");
  assert.equal(authority.scannerProfileStage({ stationStage: active, scannerHealth: "ready", calibrationStatus: "ALIEN", canServiceStation: true }).stage, "degraded");
  assert.deepEqual(authority.scannerProfileStage({ stationStage: active, scannerHealth: "ready", calibrationStatus: "VALID", canServiceStation: false, ...binding }), active);
  assert.equal(authority.scannerProfileStage({
    stationStage: active,
    scannerHealth: "ready",
    calibrationStatus: "VALID",
    canServiceStation: false,
    ...binding,
    serverProfileRevisionId: "profile-b",
  }).stage, "profile_check");
  assert.equal(authority.scannerProfileStage({
    stationStage: active,
    scannerHealth: "ready",
    calibrationStatus: "VALID",
    canServiceStation: false,
    ...binding,
    serverProfileDigestSha256: null,
  }).stage, "degraded");
  assert.equal(authority.profileSetupDenial({ stage: "profile_setup_required", canServiceStation: true }), null);
  assert.equal(authority.profileSetupDenial({ stage: "profile_check", canServiceStation: true }), null);
  assert.notEqual(authority.operationalDenial({ stage: "profile_check", canServiceStation: true }), null);
  assert.match(authority.profileSetupDenial({ stage: "profile_setup_locked", canServiceStation: false }).error, /Partner Owner|Super Admin/);
});

test("shift change remains reachable in every state that still has a local human", () => {
  for (const stage of ["active", "pending", "offline", "mfa", "mfa_enrolment_required", "no_partner_access"]) {
    assert.equal(authority.withLocalSession({ stage }, true).canSignOut, true, stage);
  }
  assert.equal(authority.withLocalSession({ stage: "sign_in" }, false).canSignOut, false);
});

test("every new physical-operation IPC checks live authority before touching the watcher", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
  for (const handler of ["authorise-fix", "start-new-card", "scan-target", "run-positioning-preview", "apply-positioning-preview", "accept-capture-preview", "rescan-capture-preview"]) {
    const start = main.indexOf(`registerIpc("${handler}"`);
    assert.notEqual(start, -1, `${handler} handler exists`);
    const end = main.indexOf("\n  });", start);
    const body = main.slice(start, end);
    assert.match(body, /requireLive(?:Operational|ProfileSetup)Authority\(\)/, `${handler} performs a fresh gate`);
    const operationalGate = body.indexOf("requireLiveOperationalAuthority()");
    const profileGate = body.indexOf("requireLiveProfileSetupAuthority()");
    const gate = operationalGate === -1 ? profileGate : profileGate === -1 ? operationalGate : Math.min(operationalGate, profileGate);
    const watcherUse = body.indexOf("watcher");
    if (watcherUse !== -1) assert.ok(gate < watcherUse, `${handler} gates before watcher access`);
  }
  const applyStart = main.indexOf('registerIpc("apply-positioning-preview"');
  const applyBody = main.slice(applyStart, main.indexOf("\n  });", applyStart));
  assert.match(applyBody, /requireLiveProfileSetupAuthority\(\)/);
  assert.match(applyBody, /submitPositioningCalibration\([\s\S]*stationClient\.saveCalibration\(candidate\)/);
  assert.match(main, /serverProfileRevisionId[\s\S]*localProfileRevisionId[\s\S]*serverProfileDigestSha256/);
  assert.match(main, /20_000 \+ Math\.floor\(Math\.random\(\) \* 10_000\)/);
  assert.match(main, /webContents\.send\("station-setup-update", setup\)/);
  assert.match(main, /scannerHealth\?\.status \|\| "checking"\) === "checking"\) return/);
  assert.match(main, /lockedHardware = lide400\.currentLockedProfile\(\)\?\.scannerHardware/);
  assert.match(main, /async function stationSetupState\(options\) \{[\s\S]*watcherBootDeferredForRetirement[\s\S]*startDeferredWatcherAfterRetirement\(\)/);
  assert.match(main, /async function stationSetupState\(options\) \{[\s\S]*if \(!stationIdentity\.hasOperatorSession\(\)\) \{\s*return stationAuthority\.withLocalSession\(\{ ok: true, stage: "sign_in" \}, false\)/);
  assert.match(main, /const replay = stationAuthorityLatch\.current\(\);\s*if \(replay\) return stationAuthority\.withLocalSession/s);
  assert.match(main, /async function cancelCurrentCard\(\)[\s\S]*beginCardCancellation\(\)[\s\S]*requireLiveOperationalAuthority\(\)[\s\S]*cancelCardOperation\.beginOrResume/);
  assert.match(main, /terminalIdentityRetirement\.retire\(\{[\s\S]*status: station\.status,[\s\S]*stationCode: station\.stationCode,[\s\S]*publicKeyFingerprint: station\.publicKeyFingerprint/);
  assert.ok(
    main.indexOf("if (resolved.terminalIdentity)") < main.indexOf("if (!versionTuple(station.minimumSupportedVersion))"),
    "terminal credentials are handled before operational version/profile policy",
  );
  assert.match(main, /terminalIdentityRetirement\.recoverIfRetired\(\{ watcher \}\)[\s\S]*watcher\.start\(\)/);
  assert.match(main, /retirementRecovery\.awaitingTerminalReproof[\s\S]*watcherBootDeferredForRetirement = true/);
  assert.match(main, /if \(!watcherBootDeferredForRetirement\) await watcher\.start\(\)/);
  assert.doesNotMatch(main, /allowIdentityRetirementPending/);
});

test("a signed station replay rejection latches fail closed until authenticated resync", () => {
  const modulePath = require.resolve("../lib/station-authority-latch");
  delete require.cache[modulePath];
  const latch = require(modulePath);
  assert.equal(latch.current(), null);
  latch.observe({ ok: false, status: 409, body: { error: { code: "station_replay" } } });
  assert.equal(latch.current().stage, "replay_state_desync");
  latch.observe({ ok: true, status: 200, body: { ok: true } });
  assert.equal(latch.current().stage, "replay_state_desync");
  latch.clearAfterResync();
  assert.equal(latch.current(), null);
  latch.observe({ ok: false, status: 409, body: { error: { code: "station_replay" } } });
  latch.clearAfterIdentityRetirement();
  assert.equal(latch.current(), null);
});
