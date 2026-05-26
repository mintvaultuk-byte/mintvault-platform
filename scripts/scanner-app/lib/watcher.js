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
const RETRYABLE_STATUSES = new Set([502, 503]);
const MAX_RETRIES = 3;
const RETRY_BACKOFF = [5_000, 10_000, 20_000]; // 5s, 10s, 20s

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

    this.chokidar = chokidar.watch(INBOX, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false, // we do our own size-stable check
    });
    this.chokidar.on("add", (p) => this.handleNewFile(p));
    this.chokidar.on("error", (err) => this.log(`chokidar error: ${err.message}`, "error"));

    this.log(`watching ${INBOX}`);
    this.refreshNextCert(); // populate predicted next cert at boot
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
      return this.failPair(frontPath, backPath, reason);
    }

    // Success.
    const certId = r.body?.certId || null;
    const processedDir = this.dateFolder(PROCESSED);
    this.moveFile(frontPath, processedDir);
    this.moveFile(backPath,  processedDir);
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

  failPair(frontPath, backPath, reason) {
    this.log(`FAILED ${path.basename(frontPath)}: ${reason}`, "error");
    const failDir = this.dateFolder(FAILED);
    const movedFront = this.moveFile(frontPath, failDir);
    const movedBack  = backPath ? this.moveFile(backPath, failDir) : null;
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
      const failDir = this.dateFolder(FAILED);
      const moved = this.moveFile(filePath, failDir);
      if (moved) this.writeError(moved, reason);
      stateMod.set({ state: "error", manualPending: null, lastError: reason });
      this.emitState();
      return { ok: false, error: reason };
    }
    this.uploading = false;

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

module.exports = { Watcher, INBOX };
