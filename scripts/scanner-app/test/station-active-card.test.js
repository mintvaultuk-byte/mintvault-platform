/**
 * THE ACTIVE-CARD CONTRACT AT A STATION.
 *
 * Four defects are pinned here, all of which were invisible to the existing suites because they live
 * in the seam between "the server answered" and "the operator can act on it":
 *
 *   1. ACTIVE CAPTURE STATE WAS LOST. `start-new-card` armed a capture and returned it to the
 *      renderer as a function result while `stateMod.activeCapture` stayed null. The window said
 *      "No card ready" for a card that was paid for and armed, and — worse — `scanActiveTarget`
 *      reads the DURABLE QUEUE, so the card could not be photographed at all until a poll happened
 *      to rediscover it up to 35 seconds later.
 *   2. NEW CARD RE-ENABLED ITSELF MID-CARD. `activeCapture` is null in four states that are all
 *      still mid-card, so a second press bought a second MV for the card already on the glass.
 *   3. THE CREDIT FIGURE NEVER MOVED. It was read once at setup and rendered from that snapshot for
 *      the rest of the shift.
 *   4. THERE WAS NO WAY OUT. A started card whose arm failed had no cancellation, so its Grading
 *      Credit stayed reserved for the full 365-day TTL.
 *
 * The behavioural half runs against the REAL Watcher with a real temp scans directory, so the
 * durable queue on disk is genuinely written and read. The source-contract half pins the wiring in
 * main.js/app.js that no unit can reach without an Electron IPC harness — and each of those
 * assertions names the exact defect it prevents, so a future edit that reintroduces one fails here
 * rather than on a shop floor.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const APP = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(APP, "main.js"), "utf8");
const renderer = fs.readFileSync(path.join(APP, "renderer", "app.js"), "utf8");
const html = fs.readFileSync(path.join(APP, "renderer", "index.html"), "utf8");
const preload = fs.readFileSync(path.join(APP, "preload.js"), "utf8");
const serverClient = fs.readFileSync(path.join(APP, "lib", "server-client.js"), "utf8");
const stationClient = fs.readFileSync(path.join(APP, "lib", "station-client.js"), "utf8");

/** A real Watcher over an isolated scans directory, so the durable queue is genuinely on disk. */
function isolatedWatcher(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-active-card-"));
  const previousScansDir = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = tempDir;
  const watcherPath = require.resolve("../lib/watcher");
  const statePath = require.resolve("../lib/state");
  delete require.cache[watcherPath];
  delete require.cache[statePath];
  const { Watcher } = require("../lib/watcher");
  const state = require("../lib/state");
  const server = require("../lib/server-client");
  const lide = require("../lib/lide400-controller");
  const originalDeviceId = lide.deviceId;
  const originalStationId = lide.stationId;
  const originalClaim = server.claimNextCapture;
  lide.deviceId = () => "mac-mintvault-station-a";
  // Adoption compares an already-claimed session's workstation against THIS station, so the
  // fixture must carry a station code — otherwise every session looks like another Mac's.
  lide.stationId = () => "mintvault-station-a";
  /*
   * Adoption CLAIMS through the server; it does not copy the arm response. The default stub hands
   * back whatever was asked for, so the ordinary tests read naturally — and `server.claimNextCapture`
   * is overridable per test so the failure paths are reachable.
   */
  let nextClaim = null;
  server.claimNextCapture = async () => ({ ok: true, status: 200, body: { capture: nextClaim } });
  for (const dir of ["capture-staging", "processed", "failed", "discarded"]) {
    fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
  }
  state.set({
    state: "idle",
    activeCapture: null,
    openCardJob: null,
    scannerHealth: { status: "ready" },
    lastError: null,
  });
  t.after(() => {
    lide.deviceId = originalDeviceId;
    lide.stationId = originalStationId;
    server.claimNextCapture = originalClaim;
    if (previousScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = previousScansDir;
    delete require.cache[watcherPath];
    delete require.cache[statePath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const watcher = new Watcher();
  // Adoption asks the server to hand this station the target. Route the fixture's expectation
  // through the same call so every adoption in this file is a genuine claim.
  const adopt = async (capture) => {
    nextClaim = capture;
    return watcher.adoptArmedCapture(capture);
  };
  return {
    tempDir,
    watcher,
    state,
    server,
    adopt,
    setClaim: (c) => {
      nextClaim = c;
    },
  };
}

function armedCapture(overrides = {}) {
  return {
    id: "capture-session-armed",
    certificateNumber: "MV272",
    side: "front",
    workstationId: "mintvault-station-a",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

test("a pending NEW CARD operation survives state reload and keeps its original idempotency key", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-pending-new-card-"));
  const priorScansDir = process.env.MINTVAULT_SCANS_DIR;
  const statePath = require.resolve("../lib/state");
  process.env.MINTVAULT_SCANS_DIR = tempDir;
  delete require.cache[statePath];
  const first = require("../lib/state");
  first.load();
  first.set({
    pendingNewCardStart: {
      clientOpId: "new-restart-safe-operation",
      cardName: "",
      startedAt: "2026-08-19T05:00:00.000Z",
    },
  });

  delete require.cache[statePath];
  const restarted = require("../lib/state");
  restarted.load();
  assert.equal(restarted.get().pendingNewCardStart?.clientOpId, "new-restart-safe-operation");

  t.after(() => {
    if (priorScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = priorScansDir;
    delete require.cache[statePath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── FIX 1 — the armed capture reaches shared state immediately ────────────────────────────────

test("an armed capture becomes the station's active target immediately, without waiting for a poll", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);

  const adopted = await adopt(armedCapture());

  assert.equal(adopted.ok, true);
  // The renderer's source of truth — this is what said "No card ready" for an armed card.
  assert.equal(state.get().activeCapture.certId, "MV272");
  assert.equal(state.get().activeCapture.side, "front");
  assert.equal(state.get().activeCapture.stage, "awaiting_scan");
  assert.equal(state.get().state, "awaiting_scan");
  // The DURABLE queue — this is what gates the physical Scan button. State without the queue would
  // have shown the card and still refused to photograph it.
  const queue = watcher.readTargetedQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].sessionId, "capture-session-armed");
  assert.equal(queue[0].phase, "awaiting_scan");
  assert.equal(watcher.activeTargetEntry().certId, "MV272");
});

test("adopting the target this station already holds changes nothing", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  await adopt(armedCapture());

  const again = await adopt(armedCapture());

  assert.equal(again.ok, true);
  assert.equal(again.alreadyHeld, true);
  assert.equal(watcher.readTargetedQueue().length, 1, "a retried arm must not duplicate the durable target");
  assert.equal(state.get().activeCapture.id, "capture-session-armed");
});

test("an ENOSPC capture-journal failure prevents ImageCaptureCore from starting a physical scan", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  await adopt(armedCapture());
  const active = watcher.activeTargetEntry();
  state.set({
    placementApproval: {
      state: "GREEN",
      sessionId: active.sessionId,
      certId: active.certId,
      side: active.side,
      approvedAtMs: Date.now(),
    },
  });
  const lide = require("../lib/lide400-controller");
  const originalScan = lide.scan;
  const originalWrite = watcher.writeTargetedQueue;
  let physicalScans = 0;
  lide.scan = async () => { physicalScans++; throw new Error("must not run"); };
  watcher.writeTargetedQueue = () => { throw new Error("ENOSPC: capture journal full"); };
  t.after(() => {
    lide.scan = originalScan;
    watcher.writeTargetedQueue = originalWrite;
  });

  const result = await watcher.scanActiveTarget();

  assert.equal(result.ok, false);
  assert.match(result.error, /ENOSPC: capture journal full/i);
  assert.equal(physicalScans, 0, "the LiDE must never start until the scan journal is durable");
});

test("a TIFF found in a pre-written scanning journal is retained and refused after restart recovery", (t) => {
  const { watcher, tempDir } = isolatedWatcher(t);
  const captureDir = path.join(tempDir, "capture-staging", "capture-session-armed", "interrupted-preview");
  fs.mkdirSync(captureDir, { recursive: true });
  const entry = {
    ...watcher.targetEntryFromCapture(armedCapture()),
    phase: "scanning",
    previewId: "interrupted-preview",
    captureDir,
  };
  watcher.addTargetedPending(entry);
  const tiff = path.join(captureDir, "hardware-output.tiff");
  fs.writeFileSync(tiff, "retained-but-not-authoritative");

  const recovered = watcher.recoverInterruptedPhysicalScan(entry);

  assert.equal(recovered.phase, "preview_error");
  assert.equal(recovered.filePath, tiff);
  assert.match(recovered.previewError, /cannot be uploaded/i);
  assert.equal(watcher.readTargetedQueue()[0].filePath, tiff, "the restart journal retains the exact TIFF path");
});

test("adoption refuses to displace a DIFFERENT live target rather than overwriting it", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  await adopt(armedCapture());

  const intruder = await adopt(armedCapture({ id: "other-session", certificateNumber: "MV999" }));

  assert.equal(intruder.ok, false);
  assert.equal(state.get().activeCapture.certId, "MV272", "the held card must survive");
  assert.equal(watcher.readTargetedQueue().length, 1);
});

test("a capture with no session id is refused instead of clearing the panel", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);

  assert.equal((await adopt(null)).ok, false);
  assert.equal((await adopt({ certificateNumber: "MV272" })).ok, false);
  assert.equal(state.get().activeCapture, null);
});

test("adoption CLAIMS the session for this device — it never merely copies the arm response", async (t) => {
  /*
   * THE DEFECT THIS PINS, AND IT COST A REAL SCAN (staging, MV272, 17 Aug 10:35).
   *
   * `POST /card-jobs/:id/capture-sessions` returns a capture in state `armed` with
   * `claimed_by_device_id` NULL. Every later scanner call — keepalive, status, evidence upload — is
   * scoped to THE DEVICE THAT CLAIMED THE SESSION. The first version of adoption built the local
   * entry straight from that arm response and never claimed, so the station looked armed, captured a
   * genuine 1200 DPI TIFF over 57 seconds, produced its preview, passed the frame safety check — and
   * then had the upload answered with "Capture session not found for this scanner", because no device
   * held it. The TIFF was archived and the operator got an error sound on a scan that had worked.
   */
  const { watcher, state, server } = isolatedWatcher(t);
  const calls = [];
  server.claimNextCapture = async (workstationId, deviceId) => {
    calls.push({ workstationId, deviceId });
    return { ok: true, status: 200, body: { capture: armedCapture() } };
  };

  const adopted = await watcher.adoptArmedCapture(armedCapture());

  assert.equal(adopted.ok, true);
  assert.equal(calls.length, 1, "adoption must claim through the server exactly once");
  assert.equal(calls[0].deviceId, "mac-mintvault-station-a", "the claim must carry THIS device");
  assert.equal(state.get().activeCapture.id, "capture-session-armed");
});

test("RETRY on a card this station already holds re-adopts it instead of failing", async (t) => {
  /*
   * THE DEFECT THIS PINS, AND IT DEAD-ENDED A REAL BENCH (staging, MV272, 17 Aug 10:46 and 10:52).
   *
   * Migration 0075 allows ONE live target per station. The Scanner's keepalive renews the target it
   * holds, so the server's expiry sweep can never reclaim the slot — which made RETRY SCANNER
   * guaranteed to fail for as long as the app kept the card alive, and to fail as a raw unique
   * violation reduced to `500 "Station request could not be completed"`.
   *
   * The server now answers a re-arm of the SAME card with the session it already holds. That
   * session is `claimed`, and `claimNextCapture` only ever selects `armed` rows, so routing it
   * through the claim would report "nothing to hand over" and leave the red panel up over a card
   * that is armed and ready. Adoption therefore takes an already-claimed session directly.
   */
  const { watcher, state } = isolatedWatcher(t);
  const server = require("../lib/server-client");
  let claims = 0;
  server.claimNextCapture = async () => {
    claims++;
    return { ok: true, status: 200, body: { capture: null } };
  };

  const readopted = await watcher.adoptArmedCapture(
    armedCapture({ state: "claimed", workstationId: "mintvault-station-a" })
  );

  assert.equal(readopted.ok, true);
  assert.equal(readopted.alreadyClaimed, true);
  assert.equal(claims, 0, "a session this station already holds must not be re-claimed");
  assert.equal(state.get().activeCapture.certId, "MV272");
  assert.equal(state.get().activeCapture.side, "front");
  assert.equal(state.get().state, "awaiting_scan");
  assert.equal(watcher.activeTargetEntry().sessionId, "capture-session-armed", "the physical Scan gate must be open");
});

test("a session claimed by ANOTHER station is never taken off that station's glass", async (t) => {
  const { watcher, state } = isolatedWatcher(t);

  const refused = await watcher.adoptArmedCapture(armedCapture({ state: "claimed", workstationId: "some-other-mac" }));

  assert.equal(refused.ok, false);
  assert.match(refused.error, /another station/i);
  assert.equal(state.get().activeCapture, null);
  assert.equal(watcher.readTargetedQueue().length, 0);
});

test("a live target suppresses a stale arm error — the red NOT ARMED panel cannot cover an armed card", () => {
  /*
   * DEFECT PINNED. The panel rendered on `armError` alone, so a refused RETRY drew "SCANNER NOT
   * ARMED" in red directly beneath a capture panel showing MV272 / FRONT with SCAN enabled. Both
   * were on screen at once and only one of them was true.
   */
  assert.match(renderer, /const needsArming = Boolean\(openCard\) && !active && !awaitingNextSide;/);
  // A card between an accepted side and its next armed side is NOT a fault and must not go red.
  assert.match(renderer, /const awaitingNextSide =/);
  assert.match(renderer, /els\.openCardPanel\.hidden = !needsArming;/);
  // And main must not RECORD a blocking arm error while the station holds a target.
  assert.match(
    main,
    /if \(open && !stateMod\.get\(\)\.activeCapture && \(!open\.cardJobId \|\| open\.cardJobId === cardJobId\)\)/
  );
});

test("a claim the server refuses leaves NOTHING adopted, so no scan can start against it", async (t) => {
  const { watcher, state } = isolatedWatcher(t);
  const server = require("../lib/server-client");
  server.claimNextCapture = async () => ({ ok: false, status: 409, body: { error: "already claimed elsewhere" } });

  const refused = await watcher.adoptArmedCapture(armedCapture());

  assert.equal(refused.ok, false);
  assert.match(refused.error, /already claimed elsewhere/);
  // Refusing loudly is the whole point: a half-adopted target is what let a 57-second capture run
  // against a session the server did not think this station held.
  assert.equal(state.get().activeCapture, null);
  assert.equal(watcher.readTargetedQueue().length, 0);
  assert.equal(watcher.activeTargetEntry(), null);
});

test("an armed session that lapses before the claim is reported, not adopted", async (t) => {
  const { watcher, state } = isolatedWatcher(t);
  const server = require("../lib/server-client");
  // `armed` but past expiry: the claim predicate requires expires_at > NOW(), so the server hands
  // back nothing. Adopting anyway would recreate the exact failure above.
  server.claimNextCapture = async () => ({ ok: true, status: 200, body: { capture: null } });

  const refused = await watcher.adoptArmedCapture(armedCapture());

  assert.equal(refused.ok, false);
  assert.match(refused.error, /Retry the scanner for this card/);
  assert.equal(state.get().activeCapture, null);
  assert.equal(watcher.readTargetedQueue().length, 0);
});

test("a network failure during the claim is retryable and adopts nothing", async (t) => {
  const { watcher, state } = isolatedWatcher(t);
  const server = require("../lib/server-client");
  server.claimNextCapture = async () => {
    throw new Error("fetch failed");
  };

  const refused = await watcher.adoptArmedCapture(armedCapture());

  assert.equal(refused.ok, false);
  assert.equal(refused.retryable, true);
  assert.equal(state.get().activeCapture, null);
  assert.equal(watcher.readTargetedQueue().length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * STALE ERROR TEXT MUST NEVER OUTLIVE THE CONDITION THAT CAUSED IT.
 *
 * Observed on staging at 12:21Z: the window showed "MV272 — SCANNER NOT ARMED / Station request
 * could not be completed" (an arm refusal frozen at 11:00Z, whose server-side cause had been fixed
 * and deployed at 11:19Z) above "Scanner service needs attention — see service logs" (the GENERIC
 * fallback, rendered because `state` was `error` while `lastError` had not survived — so the one
 * genuinely useful sentence, "LiDE 400 capture must decode as RGB colour evidence", was the only
 * thing NOT on screen). Two messages, both misleading, on a healthy station.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */

/** Boot a fresh state module over a written state.json, exactly as the app does on launch. */
function bootWithPersistedState(t, persisted) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-stale-error-"));
  const previousScansDir = process.env.MINTVAULT_SCANS_DIR;
  process.env.MINTVAULT_SCANS_DIR = tempDir;
  fs.mkdirSync(path.join(tempDir, "app-state"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "app-state", "state.json"), JSON.stringify(persisted, null, 2));
  const statePath = require.resolve("../lib/state");
  delete require.cache[statePath];
  const state = require("../lib/state");
  t.after(() => {
    if (previousScansDir === undefined) delete process.env.MINTVAULT_SCANS_DIR;
    else process.env.MINTVAULT_SCANS_DIR = previousScansDir;
    delete require.cache[statePath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return state.load();
}

test("a prior run's arm error is cleared on boot, but the open CARD is kept", (t) => {
  const loaded = bootWithPersistedState(t, {
    state: "error",
    lastError: "LiDE 400 capture must decode as RGB colour evidence",
    openCardJob: {
      cardJobId: "job-1",
      mvNumber: "MV272",
      certificateId: 469,
      armError: "Station request could not be completed",
    },
  });

  assert.equal(loaded.openCardJob.armError, null, "this run has attempted no arm; it cannot claim one failed");
  // The CARD survives — the station is still mid-card, so NEW CARD must stay disabled behind it.
  assert.equal(loaded.openCardJob.cardJobId, "job-1");
  assert.equal(loaded.openCardJob.mvNumber, "MV272");
  assert.equal(loaded.openCardJob.certificateId, 469);
});

test("a specific failure reason SURVIVES a restart — it is the sentence the operator needs", (t) => {
  const loaded = bootWithPersistedState(t, {
    state: "error",
    lastError: "LiDE 400 capture must decode as RGB colour evidence",
  });

  assert.equal(loaded.state, "error");
  assert.equal(loaded.lastError, "LiDE 400 capture must decode as RGB colour evidence");
});

test("an error state carrying NO reason is dropped rather than shown as a generic fault", (t) => {
  const loaded = bootWithPersistedState(t, { state: "error", lastError: null });

  // This exact combination is what rendered "Scanner service needs attention — see service logs"
  // on a healthy station, for a failure nobody had described.
  assert.equal(loaded.state, "idle");
  assert.equal(loaded.lastError, null);
});

test("a live target overrides persisted error text — session state beats remembered failure", (t) => {
  const { watcher, state } = isolatedWatcher(t);
  state.set({
    state: "error",
    lastError: "LiDE 400 capture must decode as RGB colour evidence",
    openCardJob: {
      cardJobId: "job-1",
      mvNumber: "MV272",
      certificateId: 469,
      armError: "Station request could not be completed",
    },
  });

  watcher.setTargetState(watcher.targetEntryFromCapture(armedCapture()), "awaiting_scan", "awaiting_scan");

  assert.equal(state.get().state, "awaiting_scan");
  assert.equal(state.get().lastError, null, "the remembered failure describes a world that no longer exists");
  assert.equal(state.get().openCardJob.armError, null, "no red NOT ARMED panel over an armed card");
  assert.equal(state.get().openCardJob.cardJobId, "job-1", "the card itself is untouched");
});

test("a successful RETRY clears the prior error state on the same card", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  state.set({
    state: "error",
    lastError: "Capture rejected — restart this side",
    openCardJob: {
      cardJobId: "job-1",
      mvNumber: "MV272",
      certificateId: 469,
      armError: "Station request could not be completed",
    },
  });

  const retried = await adopt(armedCapture());

  assert.equal(retried.ok, true);
  assert.equal(state.get().state, "awaiting_scan");
  assert.equal(state.get().lastError, null);
  assert.equal(state.get().openCardJob.armError, null);
  assert.equal(state.get().activeCapture.certId, "MV272");
});

test("a background placement re-analysis must not erase a real capture failure reason", async (t) => {
  /*
   * THE DEFECT THIS PINS, and it is what actually produced "Scanner service needs attention" on a
   * station that knew perfectly well what had gone wrong. The boot-time re-analysis of a RETAINED
   * placement Preview wrote `lastError: null` while leaving `state` at `error` — so the specific
   * sentence recorded two minutes earlier ("Detected card geometry is implausible…") was destroyed
   * by an unrelated background refresh, and the renderer fell back to the generic message.
   *
   * Re-measuring a placement photograph says nothing about whether a capture failure was resolved.
   */
  const { watcher, state } = isolatedWatcher(t);
  const reason =
    "Detected card geometry is implausible for a complete standard card; rescan with all four edges visible";
  state.set({
    state: "error",
    lastError: reason,
    positioningPreview: {
      id: "prev-1",
      status: "detected",
      capture: { areaMm: { x: 0, y: 0, width: 216, height: 297 } },
    },
  });
  // Drive the real re-analysis, with only the image work stubbed — the state write is the subject.
  watcher.storedPositioningPreviewSource = () => "/dev/null";
  watcher.analysePositioningPreview = async () => ({
    image: { orientation: "upright" },
    cardCandidate: { cardBoundsMm: { x: 10, y: 10, width: 63, height: 88 } },
    placement: { ready: true, originMm: { x: 0, y: 0 } },
  });

  const reanalysed = await watcher.reanalyseStoredPositioningPreview();

  assert.equal(reanalysed, true, "the re-analysis itself must still run");
  assert.equal(state.get().positioningPreview.status, "detected");
  assert.equal(state.get().lastError, reason, "the capture failure reason must survive an unrelated refresh");
  assert.equal(state.get().state, "error");
});

test("the recovery panel is driven by current state, so RETRY never disappears with a cleared error", () => {
  /*
   * Clearing the stale arm error removed the panel entirely — and with it the RETRY and CANCEL
   * buttons — leaving an open card with no visible way to arm it. The authoritative condition is
   * "this station holds a card with no target on the glass", not "did an arm fail".
   */
  assert.match(renderer, /const needsArming = Boolean\(openCard\) && !active && !awaitingNextSide;/);
  assert.match(renderer, /els\.openCardPanel\.hidden = !needsArming;/);
  // With no remembered reason the panel still states the situation — never the generic fallback.
  assert.match(renderer, /"This card has no armed scanner target\. "/);
  assert.doesNotMatch(renderer, /openCardDetail\.textContent = [^;]*Scanner service needs attention/);
  // And an open card with no live capture reads NOT ARMED, never "PREPARING…".
  assert.match(renderer, /els\.targetSide\.textContent = "NOT ARMED";/);
  assert.match(renderer, /PREPARING BACK/);
  assert.doesNotMatch(renderer, /textContent = [^;]*PREPARING…/);
});

test("the generic fallback appears ONLY when there is no specific reason", () => {
  // explainFailure returns the real detail whenever there is one, and the "see service logs"
  // sentence solely for an empty reason — which `load()` above now prevents from persisting.
  assert.match(renderer, /return detail \|\| "Scanner service needs attention — see service logs";/);
  // And the status line renders that reason rather than a fixed string.
  assert.match(renderer, /\? explainFailure\(lastState\.lastError\)/);
});

// ── FIX 4 — the open-card record survives the whole card ──────────────────────────────────────

test("an accepted FRONT keeps the card open; only the server's card_registered closes it", (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  state.set({ openCardJob: { cardJobId: "job-1", mvNumber: "MV272", certificateId: 469, armError: null } });
  const entry = watcher.targetEntryFromCapture(armedCapture());
  watcher.addTargetedPending(entry);

  watcher.completeTargetedCapture({ ...entry, filePath: null }, { certificateNumber: "MV272", cardRegistered: false });

  assert.equal(state.get().openCardJob?.cardJobId, "job-1", "the card is still on the glass after FRONT");
  assert.equal(state.get().lastAcceptedCapture.side, "front");
  assert.equal(state.get().lastAcceptedCapture.cardRegistered, false);
});

test("the server confirming BOTH sides is what frees the station for the next card", (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  state.set({ openCardJob: { cardJobId: "job-1", mvNumber: "MV272", certificateId: 469, armError: null } });
  const entry = watcher.targetEntryFromCapture(armedCapture({ id: "back-session", side: "back" }));
  watcher.addTargetedPending(entry);

  watcher.completeTargetedCapture({ ...entry, filePath: null }, { certificateNumber: "MV272", cardRegistered: true });

  assert.equal(state.get().openCardJob, null);
  assert.equal(state.get().lastAcceptedCapture.cardRegistered, true);
});

// ── FIX 5 — a cancelled card stops being this station's target ────────────────────────────────

test("cancelling the held card releases its local target", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  await adopt(armedCapture({ certificateNumber: "MV273" }));

  const released = watcher.releaseTargetForCancelledCard(471, "MV273");

  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(state.get().activeCapture, null);
  assert.equal(watcher.readTargetedQueue().length, 0);
  assert.equal(state.get().state, "idle");
});

test("cancelling a DIFFERENT card never clears the target on the glass", async (t) => {
  const { watcher, state, adopt } = isolatedWatcher(t);
  await adopt(armedCapture({ certificateNumber: "MV272" }));

  const result = watcher.releaseTargetForCancelledCard(471, "MV273");

  assert.equal(result.noop, true);
  assert.equal(state.get().activeCapture.certId, "MV272");
  assert.equal(watcher.readTargetedQueue().length, 1);
});

// ── The wiring only an Electron IPC harness could execute ─────────────────────────────────────

test("FIX 1: the NEW and ARM handlers commit the armed capture into shared state", () => {
  // Returning `capture` to the renderer is NOT enough — the window and the Scan gate read stateMod.
  assert.match(main, /const adopted = watcher\s*\?\s*await watcher\.adoptArmedCapture\(capture\)/);
  assert.match(main, /const adopted = await watcher\.adoptArmedCapture\(capture\)/);
  assert.match(main, /pushStateToRenderer\(\);\n\s+await refreshAvailableCredits\(\);/);
});

test("authorising a FIX also ARMS and commits it — the only recovery for a lapsed target", () => {
  /*
   * DEFECT PINNED. `fix-authorise` answers "which sides may be re-captured" and creates NO capture
   * session, so the picker closed itself and left the operator with a positioned card and nothing on
   * the glass. It matters more than it looks: capture sessions expire after five minutes, so ANY
   * card left on the bench longer than that needs re-arming, and this is the only route to it.
   */
  const start = main.indexOf('ipcMain.handle("authorise-fix"');
  const end = main.indexOf("P6 — NEW CARD");
  assert.ok(start >= 0 && end > start, "the authorise-fix handler must be locatable");
  const block = main.slice(start, end);
  assert.match(block, /await server\.armCapture\(cardJobId\)/);
  assert.match(block, /watcher\.adoptArmedCapture\(capture\)/);
  // And the station is then mid-card, so NEW must stay disabled behind it.
  assert.match(block, /openCardJob: \{/);
  assert.match(block, /armError: captureError/);
  // A failed arm is surfaced rather than swallowed by a closing modal.
  assert.match(renderer, /could not be armed/);
});

test("FIX 2: every reservation-affecting action re-asks the server for the balance", () => {
  assert.match(main, /async function refreshAvailableCredits\(\)/);
  assert.match(main, /availableCredits: available,/);
  assert.match(main, /walletRefreshGeneration: Number\(stateMod\.get\(\)\.walletRefreshGeneration \|\| 0\) \+ 1/);
  // Including a refusal: "no credits" must be shown beside the real figure.
  assert.match(main, /await refreshAvailableCredits\(\);\n\s+return \{\s+ok: false,\s+retryable: false/);
  // Cancellation returns a credit, so it must refresh too.
  assert.match(main, /await refreshAvailableCredits\(\);\n\s+return \{ ok: true, cancellation \}/);
  // The renderer prefers the live figure over the sign-in snapshot, and never renders 0 for unknown.
  assert.match(renderer, /const live = lastState\?\.availableCredits/);
  assert.match(renderer, /typeof credits === "number" \? String\(credits\) : "—"/);
  // No local optimistic counter anywhere: nothing decrements or increments the displayed figure.
  assert.doesNotMatch(renderer, /availableCredits\s*[-+]{2}|availableCredits\s*[-+]=/);
  assert.doesNotMatch(main, /availableCredits\s*[-+]{2}|availableCredits\s*[-+]=/);
});

test("FIX 4: NEW CARD is gated on the server-confirmed open card, not on activeCapture alone", () => {
  assert.match(
    renderer,
    /Boolean\(active\) \|\| Boolean\(openCard\) \|\| noAvailableCredits \|\| actionInFlight \|\| newCardInFlight/
  );
  assert.match(renderer, /const noAvailableCredits = billingLocked\(state\);/);
  assert.match(renderer, /els\.creditEmptyPanel\.hidden = !noAvailableCredits;/);
  assert.match(html, /NO GRADING CREDITS AVAILABLE/);
  assert.match(html, /TOP UP NOW/);
  assert.match(html, /id="billingLockModal"/);
  assert.match(renderer, /function shouldShowBillingLock\(state\)/);
  assert.match(renderer, /billingLocked\(state\) && !stationHasReservedCardInProgress\(state\)/);
  assert.match(renderer, /billingModalDismissedAtZero = billingLocked\(lastState\)/);
  assert.match(renderer, /let renderedWalletRefreshGeneration = null/);
  assert.match(renderer, /walletRefreshGeneration !== renderedWalletRefreshGeneration/);
  // The in-flight guard is a module flag checked before the first await — reading `disabled` alone
  // lost the race against the state-update that re-rendered the button mid-request.
  assert.match(renderer, /if \(newCardInFlight \|\| els\.newCardBtn\.disabled\) return;/);
  assert.match(renderer, /newCardInFlight = true;/);
  // And it is NOT unconditionally re-enabled in the finally block, which is how it came back to
  // life with a paid, unphotographed card still on the counter.
  assert.doesNotMatch(renderer, /finally \{\n\s+newCardInFlight = false;\n[^}]*els\.newCardBtn\.disabled = false;/);
  // The record is set BEFORE arming, so an arm failure leaves the button disabled.
  assert.match(main, /stateMod\.set\(\{\n\s+openCardJob: \{/);
  assert.match(main, /armError: captureError/);
  assert.match(main, /const persistedStart = stateMod\.get\(\)\.pendingNewCardStart/);
  assert.match(main, /if \(!pendingNewCardOpId && persistedStart\?\.clientOpId\) pendingNewCardOpId = persistedStart\.clientOpId/);
  assert.match(main, /pendingNewCardStart: \{\s*clientOpId: pendingNewCardOpId,/);
  assert.match(main, /stateMod\.set\(\{ pendingNewCardStart: null \}\)/);
});

test("ZERO-CREDIT billing lock opens automatically, survives manual close, and unlocks only from wallet refresh", () => {
  /*
   * Startup/restart/reconnect all feed either stationSetup.summary.availableCredits or
   * state.availableCredits, and every render runs the billing lock decision. Closing the modal is
   * only visual: `billingLocked` remains true and NEW CARD remains disabled until the server reports
   * available credits greater than zero.
   */
  assert.match(renderer, /function availableCreditsFromState\(state\)/);
  assert.match(
    renderer,
    /const credits = typeof live === "number" \? live : stationSetup\?\.summary\?\.availableCredits/
  );
  assert.match(renderer, /renderBillingLock\(lastState \|\| \{\}\)/);
  assert.match(renderer, /renderBillingLock\(lastState\);/);
  assert.match(renderer, /if \(!locked\) \{\s*billingModalDismissedAtZero = false;/);
  assert.match(renderer, /walletRefreshGeneration !== renderedWalletRefreshGeneration/);
  assert.match(renderer, /billingModalDismissedAtZero = false;/);
  assert.match(renderer, /closeModal\(els\.billingLockModal\)/);
  assert.match(renderer, /startBillingPoll\(\)/);
  assert.match(renderer, /window\.scanner\.refreshAvailableCredits\(\)/);
  assert.match(renderer, /if \(result\?\.code === "INSUFFICIENT_CREDITS"\) billingModalDismissedAtZero = false;/);
});

test("TOP-UP modal uses server packs and Stripe Checkout only; it never invents price or grants credits", () => {
  for (const label of ["5 CREDITS", "10 CREDITS", "25 CREDITS", "50 CREDITS", "100 CREDITS"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(renderer, /const REQUIRED_BILLING_PACK_CREDITS = \[5, 10, 25, 50, 100\]/);
  assert.match(renderer, /window\.scanner\.creditPacks\(\)/);
  assert.match(renderer, /packForCredits\(credits\)/);
  assert.match(renderer, /button\.dataset\.packCode = pack\?\.code \|\| ""/);
  assert.match(renderer, /window\.scanner\.creditCheckout\(\{ packCode \}\)/);
  assert.match(renderer, /TOP-UP PACKS NOT YET CONFIGURED/);
  assert.match(preload, /creditPacks: \(\) => ipcRenderer\.invoke\("credit-packs"\)/);
  assert.match(preload, /creditCheckout: \(payload\) => ipcRenderer\.invoke\("credit-checkout", payload\)/);
  assert.match(preload, /refreshAvailableCredits: \(\) => ipcRenderer\.invoke\("refresh-available-credits"\)/);
  assert.match(main, /ipcMain\.handle\("credit-packs"/);
  assert.match(main, /ipcMain\.handle\("credit-checkout"/);
  assert.match(main, /shell\.openExternal\(url\)/);
  assert.match(stationClient, /creditPacks\(\)/);
  assert.match(stationClient, /operatorJson\("GET", "\/api\/partner\/credits\/packs"\)/);
  assert.match(stationClient, /creditCheckout\(packCode\)/);
  assert.match(stationClient, /operatorJson\("POST", "\/api\/partner\/credits\/checkout", \{ packCode \}\)/);
  assert.doesNotMatch(renderer, /£|GBP|VAT|pricePence|stripePriceId/);
  assert.doesNotMatch(renderer, /appendFoundationCredit|fulfilPartnerCreditPurchase|availableCredits\s*[-+]=/);
});

test("FIX 5: cancellation is a Card Job authority, never submission cancellation", () => {
  assert.match(serverClient, /\/api\/partner\/card-jobs\/\$\{encodeURIComponent\(cardJobId\)\}\/cancel/);
  assert.match(preload, /cancelCardJob: \(payload\) => ipcRenderer\.invoke\("cancel-card-job", payload\)/);
  assert.match(main, /ipcMain\.handle\("cancel-card-job"/);
  // A lost response must NOT clear the open-card record — the outcome is unknown, and the operation
  // is idempotent server-side, so the correct answer is "retry", not "assume it worked".
  assert.match(
    main,
    /return \{ ok: false, retryable: true, error: err && err\.message \? err\.message : "Could not reach MintVault" \};/
  );
  /*
   * The station cancels a CARD JOB and nothing else. Submission cancellation is the wrong authority
   * here — it releases the credit through the submission and leaves the Card Job stranded in
   * NEEDS_SCAN — and a direct wallet call would bypass the reservation engine entirely.
   */
  assert.doesNotMatch(serverClient, /submissions\/[^"'`]*cancel|partner\/wallet|credits\/(adjust|release)/i);
  assert.doesNotMatch(main, /cancel-submission|submission-cancel/i);
  // Both recovery routes are reachable from the window, and cancellation is confirmed first.
  assert.match(html, /id="retryArmBtn"/);
  assert.match(html, /id="cancelCardBtn"/);
  assert.match(renderer, /keeps its number for ever — it is never deleted and never reissued/);
});

// ── FIX 3 (root cause) — a saved placement must survive a restart ─────────────────────────────

test("a placement saved to the station config is still provisioned after a restart", (t) => {
  /*
   * DEFECT PINNED. `persistJigOrigin` wrote the placement to disk AND to `process.env`, and nothing
   * ever read the file back. The calibration therefore worked until the app was relaunched and then
   * silently vanished — and `jigOrigin() === null` reports `profile_unprovisioned`, which gates BOTH
   * `pollTargetedCapture` and `scanActiveTarget`. A correctly calibrated station could neither claim
   * its armed card nor photograph one, and the only thing the operator saw was "No card ready".
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-station-config-"));
  const configPath = path.join(dir, "station.env");
  fs.writeFileSync(
    configPath,
    "MINTVAULT_STATION_LABEL=staging\nMINTVAULT_LIDE_SCAN_X_MM=20\nMINTVAULT_LIDE_SCAN_Y_MM=20\n"
  );
  const priorConfig = process.env.MINTVAULT_STATION_CONFIG_PATH;
  const priorX = process.env.MINTVAULT_LIDE_SCAN_X_MM;
  const priorY = process.env.MINTVAULT_LIDE_SCAN_Y_MM;
  // A FRESH process is exactly the case that used to fail: the file is saved, the env is empty.
  delete process.env.MINTVAULT_LIDE_SCAN_X_MM;
  delete process.env.MINTVAULT_LIDE_SCAN_Y_MM;
  process.env.MINTVAULT_STATION_CONFIG_PATH = configPath;
  const controllerPath = require.resolve("../lib/lide400-controller");
  delete require.cache[controllerPath];
  const lide = require("../lib/lide400-controller");
  t.after(() => {
    if (priorConfig === undefined) delete process.env.MINTVAULT_STATION_CONFIG_PATH;
    else process.env.MINTVAULT_STATION_CONFIG_PATH = priorConfig;
    if (priorX === undefined) delete process.env.MINTVAULT_LIDE_SCAN_X_MM;
    else process.env.MINTVAULT_LIDE_SCAN_X_MM = priorX;
    if (priorY === undefined) delete process.env.MINTVAULT_LIDE_SCAN_Y_MM;
    else process.env.MINTVAULT_LIDE_SCAN_Y_MM = priorY;
    delete require.cache[controllerPath];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(lide._private.jigOrigin(), { x: 20, y: 20 }, "a saved placement must survive a restart");

  /*
   * THE PLATEN ORIGIN IS A LEGAL PLACEMENT AGAIN — and this assertion has now been inverted TWICE,
   * which is worth recording honestly rather than quietly flipping back.
   *
   * It originally accepted (0, 0). On 2026-08-17 it was inverted to REFUSE (0, 0), on the strength of
   * a real measurement: the platen's first ~1.23 mm of top edge and ~0.72 mm of left edge carry a
   * bezel contamination band on all eight preserved masters. The measurement was sound. Making it a
   * hard bound on the ORIGIN was not, and the cost was immediate and total:
   *
   *   - every VALID station calibration in staging was at (0, 0), written by the previous build;
   *   - `jigOrigin()` refuses rather than clamps (correctly — silently relocating a station's
   *     physical capture area would change what every stored coordinate means);
   *   - the server's `assertLegalCaptureWindow` applies the same shared constant, so it refused too;
   *   - result: 0 of 11 capture sessions ever acquired an acquisition_region. No station could arm
   *     any capture at all, while still advertising itself as calibrated and ready.
   *
   * MV272 was caught in exactly this: a preserved FRONT captured at (0, 0), a BACK that could not be
   * armed, and a capture window that could not be moved because the card was open.
   *
   * The bezel is still real; it is just not the origin's problem to solve. The canonical detector
   * finds the card as a connected component rather than a global bounding box, so a bezel band no
   * longer stretches card bounds, and the 4 mm evidence floor is measured on the master regardless of
   * where the window sits. `defaultOriginMm` remains (20, 20), so the RECOMMENDED position is
   * unchanged — this governs only what an operator is FORBIDDEN to choose.
   */
  fs.writeFileSync(configPath, "MINTVAULT_LIDE_SCAN_X_MM=0\nMINTVAULT_LIDE_SCAN_Y_MM=0\n");
  assert.deepEqual(
    lide._private.jigOrigin(),
    { x: 0, y: 0 },
    "the platen origin must stay provisioned: refusing it stranded every station and MV272 with it"
  );

  // A window that would hang off the far edge of the glass is still refused — that bound is real.
  fs.writeFileSync(configPath, "MINTVAULT_LIDE_SCAN_X_MM=200\nMINTVAULT_LIDE_SCAN_Y_MM=20\n");
  assert.equal(lide._private.jigOrigin(), null);

  // An explicit launch-time override still wins over the file — when it is itself a legal window.
  fs.writeFileSync(configPath, "MINTVAULT_LIDE_SCAN_X_MM=20\nMINTVAULT_LIDE_SCAN_Y_MM=20\n");
  process.env.MINTVAULT_LIDE_SCAN_X_MM = "7";
  assert.equal(lide._private.jigOrigin().x, 7);
  delete process.env.MINTVAULT_LIDE_SCAN_X_MM;

  // A file with no placement is genuinely unprovisioned, not a fabricated 0,0.
  fs.writeFileSync(configPath, "MINTVAULT_STATION_LABEL=staging\n");
  assert.equal(lide._private.jigOrigin(), null);

  // The file is operator-editable, so it must never be a channel for arbitrary process environment.
  fs.writeFileSync(
    configPath,
    "MINTVAULT_API_BASE=https://evil.test\nMINTVAULT_LIDE_SCAN_X_MM=25\nMINTVAULT_LIDE_SCAN_Y_MM=25\n"
  );
  assert.deepEqual(lide._private.jigOrigin(), { x: 25, y: 25 });
  assert.notEqual(process.env.MINTVAULT_API_BASE, "https://evil.test");
});

test("FIX 3: the capture panel names the MV and the required side from shared state", () => {
  assert.match(renderer, /els\.targetCert\.textContent = active\.certId;/);
  assert.match(renderer, /els\.targetSide\.textContent = toTitle\(active\.side\) \|\| "—";/);
  // A started-but-unarmed card is NAMED rather than falling through to "No card ready", which is
  // what made pressing NEW again look like the only option.
  assert.match(renderer, /if \(state\.openCardJob\) \{/);
  assert.match(renderer, /els\.targetCert\.textContent = state\.openCardJob\.mvNumber \|\| "Card started";/);
  assert.match(renderer, /els\.targetSide\.textContent = "READY TO GRADE";/);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * FRONT SAVED → BACK ARMED — the transition that had no caller.
 *
 * THE DEFECT (staging, MV272, 17 Aug 12:09). FRONT was captured, uploaded, validated and persisted
 * as an immutable 43 MB master (evidence row 5), and the Card Job correctly advanced NEEDS_SCAN →
 * CAPTURING. Then nothing armed BACK. The server does not auto-arm the next side, and the Scanner's
 * poll only CLAIMS sessions that already exist — so no back session was ever created and none could
 * be claimed. The window said "FRONT SAVED / flip the card for Back" AND "NOT ARMED" at once, both
 * true, with no path between them. The operator flipped the card and pressed the only control that
 * responded, which ran a placement Preview: it moves the head and sounds exactly like a capture but
 * is never evidence, so a full physical BACK acquisition produced nothing at all.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */

test("the next outstanding side is armed from the SERVER, and the client never names the side", () => {
  assert.match(main, /async function armNextOutstandingSide\(trigger\)/);
  // Only the Card Job id is sent — authoriseStationCapture computes the outstanding side from the
  // evidence ledger, so an accepted side can never be re-armed and the client invents nothing.
  assert.match(main, /result = await server\.armCapture\(cardJobId\);/);
  assert.doesNotMatch(main, /armCapture\(cardJobId,\s*["'](front|back)["']\)/);
});

test("it fires on the server-accepted edge exactly once per accepted side", () => {
  // Keyed on the acceptance timestamp: one accepted side arms once, however many state changes
  // follow it. Without the key, every subsequent state-change would re-arm.
  assert.match(main, /accepted\.acceptedAt !== lastArmedForAcceptance/);
  assert.match(main, /lastArmedForAcceptance = accepted\.acceptedAt;/);
  // A finished card is never re-armed — the server's own card_registered is the completion signal.
  assert.match(main, /!accepted\.cardRegistered/);
  assert.match(main, /!s\.activeCapture/);
  // And a single-flight guard stops the edge and the reconciler racing each other.
  assert.match(main, /if \(!cardJobId \|\| state\.activeCapture \|\| armNextInFlight\) return/);
});

test("RESTART / RECONNECT resolves to the outstanding side, not to nothing", () => {
  /*
   * The poll alone cannot recover this: it only claims sessions that already exist, and after an
   * accepted FRONT no back session exists to claim. The reconciler on the same loop is what makes a
   * restarted or reconnected station arrive at BACK rather than sitting at NOT ARMED for ever.
   */
  assert.match(
    main,
    /if \(!stateMod\.get\(\)\.activeCapture && stateMod\.get\(\)\.openCardJob\) \{\s*\n\s*await armNextOutstandingSide\("poll reconcile"\);/
  );
});

test("a finished card stops the reconciler instead of asking for ever", () => {
  // NOTHING_TO_CAPTURE means both sides are present: the card is complete, not broken.
  assert.match(main, /if \(error\.code === "NOTHING_TO_CAPTURE"\) return \{ ok: true, complete: true \}/);
});

test("an in-flight arm flag is never resurrected from a dead process", (t) => {
  const loaded = bootWithPersistedState(t, {
    state: "idle",
    armingNextSide: true,
    openCardJob: { cardJobId: "job-1", mvNumber: "MV272", certificateId: 469, armError: null },
  });
  assert.equal(loaded.armingNextSide, false);
  assert.equal(loaded.openCardJob.cardJobId, "job-1", "the card itself survives");
});

test("a card between an accepted side and its next armed side reads as PROGRESS, not a fault", () => {
  assert.match(renderer, /const awaitingNextSide =/);
  assert.match(renderer, /Boolean\(state\.armingNextSide\)/);
  assert.match(renderer, /state\.lastQueuedCapture && !state\.lastQueuedCapture\.cardRegistered && openCard/);
  assert.match(renderer, /state\.lastAcceptedCapture && !state\.lastAcceptedCapture\.cardRegistered && openCard/);
  // The locally captured/queued side and the server-saved side are NAMED separately, so the operator
  // can see which boundary their scan has crossed without mistaking upload-task grant for evidence
  // finalisation.
  assert.match(renderer, /is captured locally and queued to MintVault/);
  assert.match(renderer, /is saved by MintVault\. MintVault is arming the next side for this same card/);
});
