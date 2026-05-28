/**
 * Watcher subsystem. Ports the strict-alternating state machine from the
 * old watcher.mjs into a single Electron process.
 *
 * Responsibilities:
 *   - chokidar watch on ~/mintvault-scans/inbox/ scan files (size-stable detection)
 *   - AUTO mode: front → back → uploadPair → state.success → idle
 *   - MANUAL mode: emit "scan-detected" on every .tif; wait for renderer to
 *     reply with attach instructions via attachManualScan(); upload via
 *     /api/admin/certs/:id/image; never auto-pair while in manual mode
 *   - One-shot manual override (orphan picker): set armOneShot({certId,
 *     side, replaceExisting}); next .tif uploads to that cert, then mode
 *     reverts to whatever it was before
 *   - Move processed files to ~/mintvault-scans/processed/YYYY-MM-DD/,
 *     failed files to .../failed/, both with .error.txt sidecars on failure
 *   - Persist state on every transition via state.set()
 */

const fs       = require("node:fs");
const path     = require("node:path");
const os       = require("node:os");
const { EventEmitter } = require("node:events");

const stateMod = require("./state");
const server   = require("./server-client");

const BASE      = path.join(os.homedir(), "mintvault-scans");
const INBOX     = path.join(BASE, "inbox");
const PROCESSED = path.join(BASE, "processed");
const FAILED    = path.join(BASE, "failed");
// Crash-recovery queue: records every upload that's in flight so an
// interrupted upload (app killed / machine slept mid-POST) can be re-driven
// on the next startup. Written when an upload starts, cleared on success or
// permanent failure.
const PENDING_QUEUE = path.join(BASE, "pending-queue.json");
// On startup with ignoreInitial:false, chokidar fires "add" for every
// pre-existing inbox file. We hold those for this long before draining them
// sequentially so we don't fire a thundering herd of uploads.
const STARTUP_DEBOUNCE_MS = 2_000;

// Accept any image format SilverFast might output. The server-side
// scan-ingest endpoint runs everything through Sharp, which auto-detects
// the input format from buffer magic bytes — so all five are equivalent
// downstream. .bmp/.gif stay ignored because SilverFast never produces
// them and they could mask other artefacts.
const ACCEPTED = new Set([".tif", ".tiff", ".png", ".jpg", ".jpeg"]);
const IGNORED  = new Set([".bmp", ".gif"]);

const STABLE_MS  = 2_000;   // file size unchanged for this long → ready
const STABLE_POLL_MS = 500;
const RETRY_DELAY_MS = 5_000;

// HTTP status codes that trigger automatic retry with exponential backoff.
// These are all server-side errors — the request itself was valid.
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
// Permanent client errors — the request is wrong and retrying won't help.
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);
const MAX_RETRIES = 5;
const RETRY_BACKOFF = [5_000, 10_000, 20_000, 30_000, 60_000]; // 5s, 10s, 20s, 30s, 60s

class Watcher extends EventEmitter {
  constructor() {
    super();
    this.chokidar = null;
    this.bufferedFront = null;       // absolute path
    this.lastPair = null;            // for retry path
    this.oneShotManual = null;       // {certId, side, replaceExisting} if armed via orphan picker
    this.pendingManualPath = null;   // absolute path waiting for renderer to choose cert/side
    this.uploading = false;          // hard guard against concurrent uploads
    this.predictedNextCertCache = { value: null, ts: 0 };
    this.ready = false;              // false until the startup debounce drains
    this.initialFiles = [];          // pre-existing inbox files seen before ready
  }

  async start() {
    for (const dir of [BASE, INBOX, PROCESSED, FAILED]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!server.hasToken()) {
      this.log("FATAL: SCANNER_API_TOKEN not set — set in ~/.mintvault-scanner.env", "error");
      stateMod.set({ state: "error", lastError: "SCANNER_API_TOKEN missing" });
      this.emit("state-changed", stateMod.get());
      return;
    }

    // Lazy-load chokidar — npm install must have completed.
    let chokidar;
    try { chokidar = require("chokidar"); }
    catch (err) { this.log(`chokidar load failed: ${err.message}`, "error"); return; }

    // Crash recovery: re-drive any uploads that were in flight when the app
    // last died, BEFORE we start watching. Awaited sequentially so each
    // interrupted upload finishes (success → moved to processed, or fail →
    // moved to failed) and is out of the inbox before chokidar's initial
    // scan runs — that prevents the initial scan from double-processing the
    // same files.
    await this.requeuePending();

    this.chokidar = chokidar.watch(INBOX, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: false, // we do our own size-stable check
    });
    // Until the startup debounce fires, buffer "add" events for pre-existing
    // files instead of processing them immediately. New files scanned after
    // startup process normally.
    this.chokidar.on("add", (p) => {
      if (!this.ready) {
        this.initialFiles.push(p);
        return;
      }
      this.handleNewFile(p);
    });
    this.chokidar.on("error", (err) => this.log(`chokidar error: ${err.message}`, "error"));
    this.chokidar.on("ready", () => {
      // Let the initial scan settle, then drain pre-existing files one at a
      // time (await each) so we never fire a burst of concurrent uploads.
      setTimeout(async () => {
        const queued = this.initialFiles.splice(0);
        this.ready = true;
        if (queued.length) {
          this.log(`startup: draining ${queued.length} pre-existing inbox file(s) after ${STARTUP_DEBOUNCE_MS}ms debounce`);
          for (const p of queued) {
            await this.handleNewFile(p);
          }
        }
      }, STARTUP_DEBOUNCE_MS);
    });

    this.log(`watching ${INBOX}`);
    this.refreshNextCert(); // populate predicted next cert at boot
  }

  // ── Pending-queue persistence (crash recovery) ───────────────────────────

  readPendingQueue() {
    try {
      const arr = JSON.parse(fs.readFileSync(PENDING_QUEUE, "utf8"));
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  writePendingQueue(entries) {
    try {
      fs.writeFileSync(PENDING_QUEUE, JSON.stringify(entries, null, 2));
    } catch (err) {
      this.log(`pending-queue write failed: ${err.message}`, "warn");
    }
  }

  /** Record an in-flight upload. Idempotent on `key` so retries / re-queues
   *  refresh the existing entry rather than duplicating it. */
  addPending(entry) {
    const q = this.readPendingQueue().filter((e) => e.key !== entry.key);
    q.push({ ...entry, ts: Date.now() });
    this.writePendingQueue(q);
  }

  /** Drop an entry once its upload succeeds or permanently fails. */
  removePending(key) {
    const q = this.readPendingQueue().filter((e) => e.key !== key);
    this.writePendingQueue(q);
  }

  /** On startup, re-drive every entry still in the queue. Files already gone
   *  from disk (upload had actually succeeded before the crash, queue write
   *  just didn't land) are dropped as stale. Awaited sequentially. */
  async requeuePending() {
    const pending = this.readPendingQueue();
    if (!pending.length) return;
    this.log(`startup: re-queueing ${pending.length} interrupted upload(s) from pending-queue.json`);
    for (const entry of pending) {
      try {
        if (entry.type === "pair" && entry.frontPath && fs.existsSync(entry.frontPath)) {
          await this.uploadPair(entry.frontPath, entry.backPath || null);
        } else if (entry.type === "manual" && entry.filePath && fs.existsSync(entry.filePath)) {
          await this.uploadManual(entry.filePath, entry.certId, entry.side, entry.replaceExisting, entry.source || "requeue");
        } else {
          this.log(`pending entry stale (file gone), dropping: ${entry.key}`, "warn");
          this.removePending(entry.key);
        }
      } catch (err) {
        this.log(`re-queue failed for ${entry.key}: ${err.message}`, "error");
      }
    }
  }

  async stop() {
    if (this.chokidar) {
      await this.chokidar.close();
      this.chokidar = null;
    }
  }

  log(msg, level = "info") {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    if (level === "error") console.error(line); else console.log(line);
  }

  // ── External controls ────────────────────────────────────────────────

  setMode(mode) {
    if (mode !== "AUTO" && mode !== "MANUAL") return;
    const prev = stateMod.get().mode;
    if (prev === mode) return;
    // Switching modes resets buffered-front context — operator should not
    // straddle a half-paired front across an AUTO↔MANUAL flip.
    this.bufferedFront = null;
    stateMod.set({ mode, bufferedFront: null });
    this.log(`mode → ${mode}`);
    this.emitState();
  }

  /**
   * Renderer responds to a MANUAL mode "scan-detected" event with the
   * cert/side decision. If user cancels, we leave the file in inbox.
   */
  async attachManualScan({ certId, side, replaceExisting, cancel }) {
    if (!this.pendingManualPath) {
      return { ok: false, error: "no scan pending" };
    }
    const filePath = this.pendingManualPath;
    this.pendingManualPath = null;

    if (cancel) {
      this.log(`manual scan cancelled — file left in inbox: ${path.basename(filePath)}`);
      stateMod.set({ state: "idle" });
      this.emitState();
      return { ok: true, cancelled: true };
    }

    return this.uploadManual(filePath, certId, side, replaceExisting, "manual");
  }

  /**
   * Orphan picker arms a one-shot manual upload. The next .tif goes to
   * the specified cert+side regardless of mode. Cleared after use.
   */
  armOneShot({ certId, side, replaceExisting }) {
    this.oneShotManual = { certId, side, replaceExisting: !!replaceExisting };
    stateMod.set({
      state: "manual_pending",
      manualPending: this.oneShotManual,
    });
    this.log(`one-shot armed: ${certId} ${side}${replaceExisting ? " (replace)" : ""}`);
    this.emitState();
  }

  cancelOneShot() {
    if (!this.oneShotManual) return { ok: false, error: "no one-shot armed" };
    this.oneShotManual = null;
    stateMod.set({ state: "idle", manualPending: null });
    this.log("one-shot cancelled");
    this.emitState();
    return { ok: true };
  }

  /**
   * Refresh the predicted next-cert hint shown in the popover. Caches for
   * 30s — front + back of one card share a cert and we don't want two
   * sequential pre-flight calls per card.
   */
  async refreshNextCert(force = false) {
    if (!force) {
      const age = Date.now() - this.predictedNextCertCache.ts;
      if (age < 30_000 && this.predictedNextCertCache.value) return this.predictedNextCertCache.value;
    }
    try {
      const r = await server.getNextCertId();
      if (r.ok && r.body?.next) {
        this.predictedNextCertCache = { value: r.body.next, ts: Date.now() };
        stateMod.set({ predictedNextCert: r.body.next });
        this.emitState();
        return r.body.next;
      }
    } catch (err) {
      this.log(`next-cert fetch failed: ${err.message}`, "warn");
    }
    return this.predictedNextCertCache.value;
  }

  emitState() {
    this.emit("state-changed", stateMod.get());
  }

  // ── File handling ────────────────────────────────────────────────────

  async handleNewFile(filePath) {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();

    if (filename.startsWith(".") || filename === ".DS_Store") return;
    // Test-scan artifacts (written as test-scan-<ts>.tif by the "test scan"
    // button in main.js) must never enter the grading pipeline. In AUTO mode
    // they buffer as a front/back and pair with a real card TIFF, minting a
    // blank/mismatched cert. Skip them entirely — checked before the
    // extension filter so it catches the file regardless of how it's named.
    if (filename.startsWith("test-scan-")) {
      this.log(`ignored test-scan file (not a real scan): ${filename}`);
      return;
    }
    if (IGNORED.has(ext)) {
      this.log(`ignored (${ext} not accepted): ${filename}`, "debug");
      return;
    }
    if (!ACCEPTED.has(ext)) {
      this.log(`ignored (unknown ext ${ext}): ${filename}`, "debug");
      return;
    }

    // Pause check — runs before stable-write detection so a paused watcher
    // doesn't even open the file. Clears expired pause as a side effect so
    // the watcher self-heals without a click.
    const cur = stateMod.get();
    if (cur.pausedUntil) {
      if (cur.pausedUntil > Date.now()) {
        this.log(`paused — ignoring ${filename}`);
        return;
      } else {
        // Auto-expire: 30-min ceiling has passed, clear the flag.
        stateMod.set({ pausedUntil: null });
        this.emitState();
        this.log(`pause expired automatically — resuming`);
      }
    }

    // Wait for size to stabilise — SilverFast streams the scan file.
    const ok = await this.waitForStable(filePath);
    if (!ok) {
      this.log(`file disappeared/unstable: ${filename}`, "warn");
      return;
    }

    this.log(`new scan: ${filename}`);

    // Priority 1: one-shot manual override (orphan picker armed it).
    if (this.oneShotManual) {
      const { certId, side, replaceExisting } = this.oneShotManual;
      this.oneShotManual = null;
      return this.uploadManual(filePath, certId, side, replaceExisting, "one-shot");
    }

    const mode = stateMod.get().mode;

    // Priority 2: MANUAL mode — bubble to renderer for a decision.
    if (mode === "MANUAL") {
      this.pendingManualPath = filePath;
      stateMod.set({ state: "manual_pending" });
      this.emit("scan-detected", { filePath, filename, sizeBytes: fs.statSync(filePath).size });
      this.emitState();
      return;
    }

    // Priority 3: AUTO mode strict-alternating.
    return this.handleAutoFile(filePath);
  }

  /**
   * Resolves true once the file's size has been unchanged for STABLE_MS,
   * or false if the file vanishes / never stabilises within ~30s.
   */
  async waitForStable(filePath) {
    const deadline = Date.now() + 30_000;
    let lastSize = -1;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      let sz;
      try { sz = fs.statSync(filePath).size; }
      catch { return false; }
      if (sz !== lastSize) {
        lastSize = sz;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= STABLE_MS) {
        return true;
      }
      await new Promise(r => setTimeout(r, STABLE_POLL_MS));
    }
    return false;
  }

  // ── AUTO mode strict-alternating ─────────────────────────────────────

  async handleAutoFile(filePath) {
    const cur = stateMod.get();
    if (cur.state === "idle" || cur.state === "success" || cur.state === "error") {
      this.bufferedFront = filePath;
      stateMod.set({ state: "front_buffered", bufferedFront: filePath, lastError: null });
      this.log(`buffered front: ${path.basename(filePath)}`);
      this.emitState();
      return;
    }
    if (cur.state === "front_buffered" && this.bufferedFront) {
      const front = this.bufferedFront;
      this.bufferedFront = null;
      return this.uploadPair(front, filePath);
    }
    // uploading — buffer wins next pair would race; safest: leave file in
    // inbox, watcher will pick it up after the upload completes.
    this.log(`scan arrived during ${cur.state} — leaving in inbox: ${path.basename(filePath)}`, "warn");
  }

  async uploadPair(frontPath, backPath, retryCount = 0) {
    if (this.uploading && retryCount === 0) return;
    this.uploading = true;
    this.lastPair = { frontPath, backPath };
    // Record this upload as in-flight on the first attempt (not on retries —
    // addPending is keyed, so the entry already exists across retry rounds).
    if (retryCount === 0) {
      this.addPending({ key: frontPath, type: "pair", frontPath, backPath });
    }
    stateMod.set({ state: "uploading" });
    this.emitState();
    const retryLabel = retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : "";
    this.log(`uploading pair: ${path.basename(frontPath)} + ${path.basename(backPath)}${retryLabel}`);

    let r;
    try { r = await server.uploadPair(frontPath, backPath); }
    catch (err) { r = { ok: false, status: 0, body: { error: `network: ${err.message}` } }; }

    if (!r.ok) {
      const reason = r.body?.error || `HTTP ${r.status}`;
      // Retry on 502/503 with exponential backoff, up to MAX_RETRIES.
      if (RETRYABLE_STATUSES.has(r.status) && retryCount < MAX_RETRIES) {
        const delay = RETRY_BACKOFF[retryCount] || RETRY_BACKOFF[RETRY_BACKOFF.length - 1];
        this.log(`upload got ${r.status}, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES}): ${reason}`, "warn");
        await new Promise(rs => setTimeout(rs, delay));
        return this.uploadPair(frontPath, backPath, retryCount + 1);
      }
      this.uploading = false;
      return this.failPair(frontPath, backPath, reason, r.status);
    }

    // Success.
    const certId = r.body?.certId || null;
    const processedDir = this.dateFolder(PROCESSED);
    this.moveFile(frontPath, processedDir);
    this.moveFile(backPath,  processedDir);
    this.removePending(frontPath);
    this.bufferedFront = null;
    this.lastPair = null;
    this.uploading = false;
    stateMod.set({
      state: "success",
      bufferedFront: null,
      lastUploadedCert: certId || stateMod.get().lastUploadedCert,
      sessionPaired: stateMod.get().sessionPaired + 1,
      lastError: null,
    });
    if (certId) {
      stateMod.pushRecent({ certId, side: "front", source: "auto" });
      stateMod.pushRecent({ certId, side: "back",  source: "auto" });
    }
    this.emitState();
    this.log(`SUCCESS: ${certId || "(no certId)"} — pair uploaded`);
    // Refresh next-cert hint after each successful upload.
    this.refreshNextCert(true);
    setTimeout(() => {
      // After the success flash, return to idle so the next scan is treated
      // as a new front. Stable behaviour matches the old watcher.
      const s = stateMod.get();
      if (s.state === "success") {
        stateMod.set({ state: "idle" });
        this.emitState();
      }
    }, 1_500);
  }

  failPair(frontPath, backPath, reason, httpStatus) {
    this.log(`FAILED ${path.basename(frontPath)}: ${reason}`, "error");

    // Server errors (502/503/504) after all retries: keep files in inbox and
    // leave them in pending-queue.json so they retry on next restart.
    const isPermanent = PERMANENT_STATUSES.has(httpStatus);
    if (!isPermanent) {
      this.log(`server error (${httpStatus || "unknown"}) — keeping files in inbox for retry on restart`);
      // addPending was already called at upload start — leave it in the queue
      this.bufferedFront = null;
      this.lastPair = { frontPath, backPath };
      stateMod.set({ state: "error", bufferedFront: null, lastError: reason });
      this.emitState();
      return;
    }

    // Permanent client error (400/401/403/404): move to failed/, drop from queue.
    this.removePending(frontPath);
    const failDir = this.dateFolder(FAILED);
    let movedFront = null;
    let movedBack  = null;
    if (fs.existsSync(frontPath)) {
      movedFront = this.moveFile(frontPath, failDir);
    } else {
      this.log(`front file already gone, skipping move: ${path.basename(frontPath)}`, "warn");
    }
    if (backPath) {
      if (fs.existsSync(backPath)) {
        movedBack = this.moveFile(backPath, failDir);
      } else {
        this.log(`back file already gone, skipping move: ${path.basename(backPath)}`, "warn");
      }
    }
    if (movedFront) this.writeError(movedFront, reason);
    if (movedBack)  this.writeError(movedBack,  reason);
    this.bufferedFront = null;
    this.lastPair = { frontPath: movedFront, backPath: movedBack };
    stateMod.set({ state: "error", bufferedFront: null, lastError: reason });
    this.emitState();
  }

  // ── Manual / one-shot upload ─────────────────────────────────────────

  async uploadManual(filePath, certId, side, replaceExisting, source, retryCount = 0) {
    if (this.uploading && retryCount === 0) {
      this.log(`manual upload requested while uploading — deferring`, "warn");
      return { ok: false, error: "upload in flight" };
    }
    this.uploading = true;
    if (retryCount === 0) {
      this.addPending({ key: filePath, type: "manual", filePath, certId, side, replaceExisting: !!replaceExisting, source });
    }
    stateMod.set({ state: "uploading", manualPending: { certId, side, replaceExisting } });
    this.emitState();
    const retryLabel = retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : "";
    this.log(`manual upload: ${path.basename(filePath)} → ${certId} ${side}${replaceExisting ? " (replace)" : ""}${retryLabel}`);

    let r;
    try { r = await server.attachImage(certId, side, filePath, replaceExisting); }
    catch (err) { r = { ok: false, status: 0, body: { error: `network: ${err.message}` } }; }

    if (!r.ok) {
      const reason = r.body?.error || `HTTP ${r.status}`;
      // Retry on 502/503 with exponential backoff, up to MAX_RETRIES.
      if (RETRYABLE_STATUSES.has(r.status) && retryCount < MAX_RETRIES) {
        const delay = RETRY_BACKOFF[retryCount] || RETRY_BACKOFF[RETRY_BACKOFF.length - 1];
        this.log(`manual upload got ${r.status}, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES}): ${reason}`, "warn");
        await new Promise(rs => setTimeout(rs, delay));
        return this.uploadManual(filePath, certId, side, replaceExisting, source, retryCount + 1);
      }
      this.uploading = false;
      this.log(`manual upload FAILED: ${reason}`, "error");

      const isPermanent = PERMANENT_STATUSES.has(r.status);
      if (!isPermanent) {
        // Server error — keep in inbox + pending queue for retry on restart
        this.log(`server error (${r.status || "unknown"}) — keeping file in inbox for retry on restart`);
        stateMod.set({ state: "error", manualPending: null, lastError: reason });
        this.emitState();
        return { ok: false, error: reason };
      }

      // Permanent client error — move to failed/, drop from queue
      this.removePending(filePath);
      const failDir = this.dateFolder(FAILED);
      let moved = null;
      if (fs.existsSync(filePath)) {
        moved = this.moveFile(filePath, failDir);
      } else {
        this.log(`file already gone, skipping move to failed: ${path.basename(filePath)}`, "warn");
      }
      if (moved) this.writeError(moved, reason);
      stateMod.set({ state: "error", manualPending: null, lastError: reason });
      this.emitState();
      return { ok: false, error: reason };
    }
    this.uploading = false;
    this.removePending(filePath);

    const processedDir = this.dateFolder(PROCESSED);
    this.moveFile(filePath, processedDir);
    stateMod.set({
      state: "success",
      manualPending: null,
      lastUploadedCert: certId,
      sessionPaired: stateMod.get().sessionPaired + 1,
      lastError: null,
    });
    stateMod.pushRecent({ certId, side, source });
    this.emitState();
    this.log(`manual SUCCESS: ${certId} ${side}`);
    setTimeout(() => {
      const s = stateMod.get();
      if (s.state === "success") {
        stateMod.set({ state: "idle" });
        this.emitState();
      }
    }, 1_500);
    return { ok: true, certId, side };
  }

  /**
   * Retry the last failed pair. Re-uploads from the failed/ folder.
   */
  async retryLastPair() {
    if (!this.lastPair) return { ok: false, error: "no last pair to retry" };
    const { frontPath, backPath } = this.lastPair;
    if (!fs.existsSync(frontPath)) return { ok: false, error: "front file not found" };
    return this.uploadPair(frontPath, backPath, true);
  }

  /**
   * Move all files from today's failed/ folder back to inbox for reprocessing.
   * Returns the count of files moved.
   */
  retryFailed() {
    const today = new Date().toISOString().slice(0, 10);
    const failedToday = path.join(FAILED, today);
    if (!fs.existsSync(failedToday)) return { ok: true, moved: 0 };
    const files = fs.readdirSync(failedToday).filter(f => !f.endsWith(".error.txt") && !f.startsWith("."));
    let moved = 0;
    for (const f of files) {
      const src = path.join(failedToday, f);
      const dest = path.join(INBOX, f);
      try {
        fs.renameSync(src, dest);
        moved++;
        // Also remove the .error.txt sidecar if it exists
        const errFile = `${src}.error.txt`;
        if (fs.existsSync(errFile)) fs.unlinkSync(errFile);
      } catch (err) {
        this.log(`retry-failed: couldn't move ${f}: ${err.message}`, "warn");
      }
    }
    this.log(`retry-failed: moved ${moved} file(s) from failed/${today} → inbox`);
    return { ok: true, moved };
  }

  /**
   * Reset the front-buffered state — discards the buffered front (moves to
   * discarded/). Operator uses this when they front-scanned the wrong card.
   */
  resetBuffered() {
    if (!this.bufferedFront) {
      stateMod.set({ state: "idle" });
      this.emitState();
      return { ok: true, discarded: null };
    }
    const discardedDir = this.dateFolder(path.join(BASE, "discarded"));
    const moved = this.moveFile(this.bufferedFront, discardedDir);
    this.bufferedFront = null;
    stateMod.set({ state: "idle", bufferedFront: null });
    this.emitState();
    return { ok: true, discarded: moved };
  }

  // ── File helpers ─────────────────────────────────────────────────────

  dateFolder(parent) {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(parent, today);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  moveFile(srcPath, destDir) {
    if (!srcPath || !fs.existsSync(srcPath)) return null;
    const dest = path.join(destDir, path.basename(srcPath));
    try { fs.renameSync(srcPath, dest); return dest; }
    catch (err) {
      this.log(`move failed ${srcPath} → ${destDir}: ${err.message}`, "error");
      return null;
    }
  }

  writeError(filePath, reason) {
    try {
      fs.writeFileSync(`${filePath}.error.txt`, `${new Date().toISOString()}\n${reason}\n`);
    } catch {}
  }
}

module.exports = { Watcher, INBOX, FAILED };
