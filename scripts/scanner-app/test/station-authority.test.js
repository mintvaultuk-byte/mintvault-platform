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
  assert.equal(authority.stationStage("unexpected").stage, "degraded");
  assert.equal(authority.operationalDenial({ stage: "active" }), null);
  assert.deepEqual(authority.operationalDenial({ stage: "revoked" }), {
    ok: false,
    code: "revoked",
    error: "This human and station are not currently authorised for physical work.",
  });
  assert.match(authority.operationalDenial({ stage: "offline" }).error, /New physical operations are paused/);
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
    const start = main.indexOf(`ipcMain.handle("${handler}"`);
    assert.notEqual(start, -1, `${handler} handler exists`);
    const end = main.indexOf("\n  });", start);
    const body = main.slice(start, end);
    assert.match(body, /requireLiveOperationalAuthority\(\)/, `${handler} performs a fresh gate`);
    const gate = body.indexOf("requireLiveOperationalAuthority()");
    const watcherUse = body.indexOf("watcher");
    if (watcherUse !== -1) assert.ok(gate < watcherUse, `${handler} gates before watcher access`);
  }
  assert.match(main, /20_000 \+ Math\.floor\(Math\.random\(\) \* 10_000\)/);
  assert.match(main, /webContents\.send\("station-setup-update", setup\)/);
  assert.match(main, /async function stationSetupState\(options\) \{\s*if \(!stationIdentity\.hasOperatorSession\(\)\) \{\s*return stationAuthority\.withLocalSession\(\{ ok: true, stage: "sign_in" \}, false\)/s);
  assert.match(main, /const replay = stationAuthorityLatch\.current\(\);\s*if \(replay\) return stationAuthority\.withLocalSession/s);
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
});
