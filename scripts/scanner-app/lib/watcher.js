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
const crypto   = require("node:crypto");
const { EventEmitter } = require("node:events");

const stateMod   = require("./state");
const server     = require("./server-client");
const backDetect = require("./back-detect");

// BASE is overridable via MINTVAULT_SCANS_DIR so an isolated TEST instance can
// run on the same Mac without clobbering the live scanner's inbox / processed /
// failed / pending-queue. Default: the shared ~/mintvault-scans (live agent).
const BASE      = process.env.MINTVAULT_SCANS_DIR || path.join(os.homedir(), "mintvault-scans");
const INBOX     = path.join(BASE, "inbox");
const PROCESSED = path.join(BASE, "processed");
const FAILED    = path.join(BASE, "failed");
const REJECTED  = path.join(BASE, "rejected");
// Crash-recovery queue: records every upload that's in flight so an
// interrupted upload (app killed / machine slept mid-POST) can be re-driven
// on the next startup. Written when an upload starts, cleared on success or
// permanent failure.
const PENDING_QUEUE = path.join(BASE, "pending-queue.json");
// Content-hash dedup log: the last HASH_LOG_MAX uploads as {hash, cert, side,
// ts}. Before each upload we SHA-256 the source bytes; if the same hash was
// already uploaded to the SAME cert+side, we skip the re-upload. A different
// cert+side with the same hash is a legitimate scan reuse, not a duplicate.
const HASH_LOG = path.join(BASE, "upload-hashes.json");
const HASH_LOG_MAX = 200;
// On startup with ignoreInitial:false, chokidar fires "add" for every
// pre-existing inbox file. We hold those for this long before draining them
// sequentially so we don't fire a thundering herd of uploads.
const STARTUP_DEBOUNCE_MS = 2_000;

// Phase 58A production evidence baseline is SilverFast TIFF. Allowing JPEG
// or PNG here would create a record that cannot satisfy the immutable
// 16-bit TIFF-master invariant, so those files must not enter the queue.
const ACCEPTED = new Set([".tif", ".tiff"]);
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
// Max-lifetime guard: total POST attempts across ALL sessions (incl. restart
// re-drives) before a stuck pair is moved to failed/ and stops retrying forever.
const MAX_LIFETIME_ATTEMPTS = 5;
// After a successful (immediate) ingest response the server is still backgrounding
// the raw R2 PUT. The watcher holds the inbox file until raw_uploaded=true here,
// then moves it (the core-invariant completion signal).
const RAW_CONFIRM_POLL_MS = 2_000;
const RAW_CONFIRM_TIMEOUT_MS = 120_000; // 2 min; on timeout the file stays in inbox for the reconciler

// AUTO-mode mint throttle: refuse to mint a new cert if one was created less
// than this long ago. Guards against a runaway AUTO batch minting a flood of
// phantom certs. The pair stays in the inbox and is re-driven once the window
// clears.
const AUTO_THROTTLE_MS = 20_000;

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
    this.lastCertMintAt = 0;         // epoch-ms of last AUTO cert mint (throttle)
  }

  async start() {
    for (const dir of [BASE, INBOX, PROCESSED, FAILED, REJECTED]) {
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

  /** Read a single pending entry by key (null if absent). */
  getPending(key) {
    return this.readPendingQueue().find((e) => e.key === key) || null;
  }

  /** Content-derived, STABLE ingest idempotency key for a front+back pair.
   *  Identical bytes → identical key on every retry and after a process restart,
   *  so a re-driven ingest resolves to the SAME server cert (never a duplicate).
   *  Persisted in the pending entry and re-read on re-drive — never regenerated
   *  per-attempt. A genuinely new scan (new bytes) yields a new key → new cert. */
  deriveIngestKey(hashes) {
    const basis = `${hashes?.front || "nofront"}:${hashes?.back || "noback"}`;
    return `mvscan:${crypto.createHash("sha256").update(basis).digest("hex")}`;
  }

  /** Small JPEG data-URL of a captured side (front or back), for the confirmation
   *  popup. Generated from the on-disk file (sharp decodes TIFF). Returns null on
   *  failure / no path — the popup still shows the number, just without that image. */
  async makeThumb(imgPath) {
    if (!imgPath) return null;
    try {
      const sharp = require("sharp");
      const buf = await sharp(imgPath, { limitInputPixels: false })
        .rotate()
        .resize(460, null, { fit: "inside" })
        .jpeg({ quality: 68 })
        .toBuffer();
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch (err) {
      this.log(`confirm thumb failed for ${path.basename(imgPath)}: ${err.message}`, "warn");
      return null;
    }
  }

  /** Process inbox files HELD by the confirmation gate, after the operator acks.
   *  Stops as soon as a completed pair re-sets confirmCard (one card at a time),
   *  preserving scan-one-write-one. Files are never lost — a restart's startup
   *  drain re-runs this if an ack's drain didn't finish. */
  async drainInbox() {
    let files;
    try {
      files = fs
        .readdirSync(INBOX)
        .filter(
          (f) => ACCEPTED.has(path.extname(f).toLowerCase()) && !f.startsWith("test-scan-") && !f.startsWith(".")
        )
        // ARRIVAL order (mtime), NOT alphabetical. A held front+back pair must
        // drain front-first; `.sort()` (lexicographic) put "Untitled (2).tif"
        // before "Untitled.tif" and so buffered the back as the front — the
        // MV219 swap (2026-06-23). Content detection in handleAutoFile is the
        // real order-independent guarantee; mtime just keeps the FALLBACK order
        // correct (oldest = scanned first = front) when detection can't confirm.
        .map((f) => { try { return { f, mtime: fs.statSync(path.join(INBOX, f)).mtimeMs }; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => a.mtime - b.mtime)
        .map((e) => e.f);
    } catch {
      return;
    }
    for (const f of files) {
      if (stateMod.get().confirmCard) break; // a completed pair re-gated — stop
      const full = path.join(INBOX, f);
      if (!fs.existsSync(full)) continue;
      try {
        await this.handleNewFile(full);
      } catch (err) {
        // One bad file must not abort the drain — it stays in inbox and is
        // retried on the next ack or the startup drain. Logged loudly.
        this.log(`drain: handleNewFile failed for ${f}: ${err.message} — held for retry`, "error");
      }
    }
  }

  /** On startup, re-drive every entry still in the queue. Files already gone
   *  from disk (upload had actually succeeded before the crash, queue write
   *  just didn't land) are dropped as stale. Awaited sequentially. */
  async requeuePending() {
    const pending = this.readPendingQueue();
    if (!pending.length) return;
    this.log(`startup: reconciling ${pending.length} interrupted upload(s) from pending-queue.json`);
    for (const entry of pending) {
      try {
        const frontHere = entry.frontPath && fs.existsSync(entry.frontPath);
        const manualHere = entry.type === "manual" && entry.filePath && fs.existsSync(entry.filePath);
        if (entry.type === "pair" && frontHere) {
          // File retained → re-drive. The PERSISTED content key makes the server
          // resolve to the SAME cert (no duplicate, no rescan).
          await this.uploadPair(entry.frontPath, entry.backPath || null, 0, null, entry.idempotencyKey || null);
          continue;
        }
        if (manualHere) {
          await this.uploadManual(entry.filePath, entry.certId, entry.side, entry.replaceExisting, entry.source || "requeue");
          continue;
        }
        // File GONE — do NOT blind-drop (the old silent-discard bug). Reconcile
        // against R2: if the cert's raw is confirmed, the work completed (crash
        // between move and queue-write) → safe to drop. Otherwise the scan was
        // LOST mid-flight → keep the entry + surface LOUD, never discard silently.
        if (entry.certId) {
          let s;
          try { s = await server.getScanStatus(entry.certId); } catch { s = null; }
          if (s && s.ok && s.body && s.body.raw_uploaded === true) {
            this.log(`reconcile: ${entry.certId} confirmed in R2 (file already moved) — dropping queue entry ${entry.key}`);
            this.removePending(entry.key);
          } else {
            this.log(`⚠️ LOST SCAN: ${entry.key} file gone AND cert ${entry.certId} raw NOT confirmed — manual recovery needed, entry kept`, "error");
          }
        } else {
          this.log(`⚠️ LOST SCAN: ${entry.key} file gone and no certId recorded — manual recovery needed, entry kept`, "error");
        }
      } catch (err) {
        this.log(`reconcile failed for ${entry.key}: ${err.message}`, "error");
      }
    }
  }

  // ── Content-hash dedup ───────────────────────────────────────────────────

  /** SHA-256 of the source file's bytes (pre-conversion). null on read error. */
  async sha256File(filePath) {
    try {
      const buf = await fs.promises.readFile(filePath);
      return crypto.createHash("sha256").update(buf).digest("hex");
    } catch (err) {
      this.log(`hash failed for ${path.basename(filePath)}: ${err.message}`, "warn");
      return null;
    }
  }

  readHashLog() {
    try {
      const arr = JSON.parse(fs.readFileSync(HASH_LOG, "utf8"));
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  writeHashLog(entries) {
    try {
      fs.writeFileSync(HASH_LOG, JSON.stringify(entries, null, 2));
    } catch (err) {
      this.log(`hash-log write failed: ${err.message}`, "warn");
    }
  }

  /** Record a completed upload. Keeps only the most recent HASH_LOG_MAX. */
  recordUpload(hash, cert, side) {
    if (!hash || !cert || !side) return;
    const log = this.readHashLog();
    log.push({ hash, cert, side, ts: Date.now() });
    this.writeHashLog(log.slice(-HASH_LOG_MAX));
  }

  /** Find a prior upload of this exact hash to the SAME cert+side. */
  findUpload(hash, cert, side) {
    if (!hash) return null;
    return this.readHashLog().find((e) => e.hash === hash && e.cert === cert && e.side === side) || null;
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

    // Scan-confirmation gate (scan-one-write-one). While a confirmation popup is
    // awaiting acknowledgment, HOLD new scans in the inbox — they are processed
    // on ack via drainInbox(). This stops a fast operator's next scan from
    // replacing an unacknowledged confirmation. Stale confirmCards are cleared on
    // boot (state.load), so this can never strand the startup drain.
    {
      const cc = stateMod.get().confirmCard;
      if (cc) {
        this.log(`scan HELD — acknowledge the current card (${cc.certId || "incomplete scan"}) first: ${filename}`);
        return;
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
      // AUTO mint throttle — don't mint a fresh cert within AUTO_THROTTLE_MS
      // of the last one. Leave both files in the inbox and re-drive the pair
      // once the window clears, rather than discarding the scan.
      const since = Date.now() - this.lastCertMintAt;
      if (since < AUTO_THROTTLE_MS) {
        const secs = Math.round(since / 1000);
        const wait = AUTO_THROTTLE_MS - since;
        this.log(`AUTO throttle: skipped, ${secs}s since last cert — retrying in ${Math.ceil(wait / 1000)}s`, "warn");
        setTimeout(() => this.handleAutoFile(filePath), wait + 250);
        return;
      }
      const a = this.bufferedFront;
      const b = filePath;
      this.bufferedFront = null;

      // Game-agnostic duplicate guard (independent of front/back content —
      // see back-detect.js's looksLikeSameCard): if these two scans are the
      // SAME card face — front scanned twice, e.g. the operator forgot a
      // front was already buffered (possibly minutes earlier) and re-scanned
      // it — refuse to auto-pair. Uploading would mint a real, numbered cert
      // with the same picture on both sides (MV476/MV479). Neither scan is
      // deleted — both move to rejected/ for manual review/rescan, the same
      // convention an operator's own "Reject & rescan" already uses.
      try {
        const dupe = await backDetect.looksLikeSameCard(a, b);
        if (dupe.same) {
          const reason = `both scans look like the same card face (distance=${dupe.distance.toFixed(1)}, threshold=${backDetect.SAME_MAX}) — refusing to auto-pair as front+back`;
          this.log(`DUPLICATE SCAN: ${path.basename(a)} + ${path.basename(b)} — ${reason}`, "error");
          const rejDir = this.dateFolder(REJECTED);
          for (const f of [a, b]) {
            const moved = this.moveFile(f, rejDir);
            if (moved) this.writeError(moved, reason);
          }
          stateMod.set({
            state: "error",
            bufferedFront: null,
            lastError: "Duplicate scan detected — both files moved to rejected/, please rescan (see log for details)",
          });
          this.emitState();
          return;
        }
      } catch (err) {
        // Never let the guard itself block a legitimate pair — if the check
        // errors, fall through to the existing front/back logic as before.
        this.log(`duplicate-scan check error (continuing): ${err.message}`, "warn");
      }

      // Decide front vs back by CONTENT, not arrival order (order-independent —
      // see back-detect.js). Falls back to scan order (the buffered file `a` was
      // scanned first = front) and FLAGS the card when detection can't confirm —
      // never a silent guess. This governs which file becomes frontPath, so the
      // cert's stored front AND the confirmation popup's thumbnail are both the
      // true front regardless of the order the two scans arrived in.
      let front = a, back = b, orientationUnconfirmed = false;
      try {
        const det = await backDetect.identifyFrontBack(a, b);
        if (det.confident) {
          front = det.front;
          back = det.back;
          this.log(`front/back by content — front=${path.basename(front)} back=${path.basename(back)} [${det.reason}]`);
        } else {
          orientationUnconfirmed = true;
          this.log(`front/back UNCONFIRMED — falling back to scan order (front=${path.basename(a)}); card flagged for review [${det.reason}]`, "warn");
        }
      } catch (err) {
        orientationUnconfirmed = true;
        this.log(`front/back detection error — using scan order (front=${path.basename(a)}): ${err.message}`, "warn");
      }
      return this.uploadPair(front, back, 0, null, null, orientationUnconfirmed);
    }
    // uploading — buffer wins next pair would race; safest: leave file in
    // inbox, watcher will pick it up after the upload completes.
    this.log(`scan arrived during ${cur.state} — leaving in inbox: ${path.basename(filePath)}`, "warn");
  }

  async uploadPair(frontPath, backPath, retryCount = 0, hashes = null, idempotencyKey = null, orientationUnconfirmed = false) {
    if (this.uploading && retryCount === 0) return;
    this.uploading = true;
    this.lastPair = { frontPath, backPath };
    // Hash the source bytes once (first attempt) — for dedup AND to derive the
    // stable content key. Threaded through retries to avoid re-reads.
    if (retryCount === 0 && !hashes) {
      hashes = {
        front: await this.sha256File(frontPath),
        back: backPath ? await this.sha256File(backPath) : null,
      };
    }
    // Content-derived key: a fresh ingest derives it; a re-drive (requeue) passes
    // the PERSISTED key in — never regenerated per-attempt.
    if (!idempotencyKey) idempotencyKey = this.deriveIngestKey(hashes);

    if (retryCount === 0) {
      // Max-lifetime guard — `attempts` counts fresh start-of-ingest tries
      // (initial + each restart re-drive), persisted across restarts. We make up
      // to MAX_LIFETIME_ATTEMPTS tries; this invocation is terminal once those
      // are already used (prior.attempts has reached the max).
      const prior = this.getPending(idempotencyKey);
      const priorAttempts = prior?.attempts || 0;
      const attempts = priorAttempts + 1;
      if (attempts > MAX_LIFETIME_ATTEMPTS) {
        this.uploading = false;
        this.log(`pair exhausted ${MAX_LIFETIME_ATTEMPTS} lifetime attempts — moving to failed/`, "error");
        return this.failPair(frontPath, backPath, `exhausted ${MAX_LIFETIME_ATTEMPTS} attempts; last: ${prior?.lastError || "unknown"}`, 0, {
          terminal: true,
          attempts: priorAttempts, // the actual number of tries made
          idempotencyKey,
        });
      }
      this.addPending({ key: idempotencyKey, type: "pair", frontPath, backPath, idempotencyKey, attempts, certId: prior?.certId || null });
    }

    stateMod.set({ state: "uploading" });
    this.emitState();
    const retryLabel = retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : "";
    this.log(`uploading pair: ${path.basename(frontPath)} + ${path.basename(backPath)}${retryLabel} [${idempotencyKey.slice(7, 17)}…]`);

    let r;
    try { r = await server.uploadPair(frontPath, backPath, idempotencyKey); }
    catch (err) { r = { ok: false, status: 0, body: { error: `network: ${err.message}` } }; }

    if (!r.ok) {
      const reason = r.body?.error || `HTTP ${r.status}`;
      this.patchPending(idempotencyKey, { lastError: reason });
      if (RETRYABLE_STATUSES.has(r.status) && retryCount < MAX_RETRIES) {
        const delay = RETRY_BACKOFF[retryCount] || RETRY_BACKOFF[RETRY_BACKOFF.length - 1];
        this.log(`upload got ${r.status}, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES}): ${reason}`, "warn");
        await new Promise(rs => setTimeout(rs, delay));
        return this.uploadPair(frontPath, backPath, retryCount + 1, hashes, idempotencyKey, orientationUnconfirmed);
      }
      this.uploading = false;
      return this.failPair(frontPath, backPath, reason, r.status, { idempotencyKey });
    }

    // Success — the server has ALLOCATED the cert (immediate response), but the
    // raw R2 PUT is still backgrounded. Record certId on the pending entry, then
    // HOLD the inbox file until raw_uploaded=true before moving it (the invariant).
    const certId = r.body?.certId || null;
    this.lastCertMintAt = Date.now();
    if (certId) this.patchPending(idempotencyKey, { certId });
    if (certId && hashes) {
      this.recordUpload(hashes.front, certId, "front");
      if (hashes.back) this.recordUpload(hashes.back, certId, "back");
    }

    // Capture BOTH thumbnails NOW — confirmAndMove relocates the files on
    // success, so grab them from frontPath/backPath first. The blocking popup
    // shows front AND back so the operator can confirm both sides scanned before
    // labelling. backThumb is null when there's no back (single-sided scan).
    const [frontThumb, backThumb] = await Promise.all([
      this.makeThumb(frontPath),
      this.makeThumb(backPath),
    ]);
    const incompleteCard = {
      certId: null,
      thumb: frontThumb,
      backThumb,
      status: "incomplete",
      note: "Scan incomplete — no number assigned. Do NOT label. Rescan this card.",
      ts: Date.now(),
    };

    const confirmed = await this.confirmAndMove(certId, frontPath, backPath, idempotencyKey, r.body?.raw_uploaded === true);
    this.bufferedFront = null;
    this.lastPair = null;
    this.uploading = false;

    if (!confirmed) {
      // Raw not confirmed within the window — file STAYS in inbox, pending entry
      // retained; the reconciler / next restart finishes it. Not an error.
      this.log(`${certId}: cert created but raw not yet confirmed — file held in inbox for reconcile`, "warn");
      // The cert WAS created — STILL surface the assigned number so the operator
      // can label the card (never leave a created cert with no number on screen),
      // flagged "image still finalizing". No certId at all → tell them to rescan.
      stateMod.set({
        state: "idle",
        bufferedFront: null,
        confirmCard: certId
          ? {
              certId,
              thumb: frontThumb,
              backThumb,
              status: "raw_pending",
              note: orientationUnconfirmed
                ? "Image still finalizing — number IS assigned. ⚠ Front/back not auto-confirmed: verify before labelling."
                : "Image still finalizing — the number IS assigned. OK to write it on the card.",
              warn: orientationUnconfirmed,
              ts: Date.now(),
            }
          : incompleteCard,
      });
      this.emitState();
      return;
    }

    stateMod.set({
      state: "success",
      bufferedFront: null,
      lastUploadedCert: certId || stateMod.get().lastUploadedCert,
      sessionPaired: stateMod.get().sessionPaired + 1,
      lastError: null,
      confirmCard: certId
        ? { certId, thumb: frontThumb, backThumb, status: "confirmed",
            note: orientationUnconfirmed
              ? "⚠ Front/back not auto-confirmed — check the Front and Back above match the card before labelling."
              : null,
            warn: orientationUnconfirmed,
            ts: Date.now() }
        : incompleteCard,
    });
    if (certId) {
      stateMod.pushRecent({ certId, side: "front", source: "auto" });
      stateMod.pushRecent({ certId, side: "back",  source: "auto" });
    }
    this.emitState();
    this.log(`SUCCESS: ${certId || "(no certId)"} — pair uploaded + raw confirmed in R2`);
    this.refreshNextCert(true);
    setTimeout(() => {
      const s = stateMod.get();
      if (s.state === "success") {
        stateMod.set({ state: "idle" });
        this.emitState();
      }
    }, 1_500);
  }

  /** Merge fields into an existing pending entry (no-op if absent). */
  patchPending(key, fields) {
    const q = this.readPendingQueue();
    const i = q.findIndex((e) => e.key === key);
    if (i === -1) return;
    q[i] = { ...q[i], ...fields };
    this.writePendingQueue(q);
  }

  /** Operator pressed "Reject & rescan" on the scan-confirmation popup.
   *  Soft-deletes the just-minted cert server-side (so the number dies with
   *  the bad scan), cleans up any still-held inbox files + pending entry
   *  (raw_pending case — otherwise a restart would re-drive the ingest into
   *  the deleted cert until attempts exhausted), and returns the app to idle
   *  ready for the rescan. On server failure the popup STAYS UP so the
   *  operator knows the cert still exists. Incomplete cards (no certId) have
   *  nothing server-side — treated as a plain ack.
   */
  async rejectConfirmCard() {
    const s = stateMod.get();
    const c = s.confirmCard;
    if (!c) return { ok: false, error: "no card on the confirmation popup" };

    if (c.certId) {
      let r;
      try {
        r = await server.softDeleteCert(c.certId, "Operator rejected at scan-confirmation popup — reject & rescan");
      } catch (err) {
        r = { ok: false, error: err?.message || String(err) };
      }
      // 404/410 = already gone/deleted — that IS the desired end-state.
      const gone = r.ok || r.status === 404 || r.status === 410;
      if (!gone) {
        const why = r.body?.error || r.error || `HTTP ${r.status || "?"}`;
        this.log(`REJECT failed for ${c.certId}: ${why}`, "error");
        return { ok: false, error: why };
      }

      // raw_pending: the inbox file(s) + pending entry are still held for the
      // reconciler. The cert is now deleted, so re-driving would only burn
      // attempts against deleted_at-guarded no-ops — move files to rejected/
      // (kept, never auto-retried) and drop the entry.
      const entry = this.readPendingQueue().find((e) => e.certId === c.certId);
      if (entry) {
        const rejDir = this.dateFolder(REJECTED);
        for (const f of [entry.frontPath, entry.backPath]) {
          if (f && fs.existsSync(f)) this.moveFile(f, rejDir);
        }
        this.removePending(entry.key);
        this.log(`${c.certId}: held inbox files moved to rejected/, pending entry dropped`);
      }
      this.log(`REJECTED ${c.certId} — operator reject & rescan (cert soft-deleted)`);
    } else {
      this.log("REJECT on incomplete card — nothing server-side, clearing popup");
    }

    stateMod.set({ confirmCard: null, state: "idle", lastError: null });
    this.emitState();
    this.refreshNextCert(true);
    return { ok: true, certId: c.certId || null };
  }

  /** CORE INVARIANT: hold the inbox file until the server confirms raw_uploaded=
   *  true (raw scans durably in R2), then drop the queue entry and move the file
   *  to processed/ as the final act. A crash anywhere before the move leaves the
   *  file in inbox for the reconciler — re-drive is idempotent (same content key
   *  → same cert, deterministic R2 keys overwrite). Returns true if moved. */
  async confirmAndMove(certId, frontPath, backPath, idempotencyKey, alreadyConfirmed) {
    if (!certId) return false;
    let rawOk = alreadyConfirmed;
    if (!rawOk) {
      const deadline = Date.now() + RAW_CONFIRM_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((rs) => setTimeout(rs, RAW_CONFIRM_POLL_MS));
        let s;
        try { s = await server.getScanStatus(certId); } catch { s = null; }
        if (s && s.ok && s.body && s.body.raw_uploaded === true) { rawOk = true; break; }
      }
    }
    if (!rawOk) return false; // leave file in inbox for the reconciler
    // R2 confirmed → move the files (the completion signal), THEN drop the queue
    // entry. If we crash between the two, the entry survives WITH its certId, so
    // requeuePending reconciles it against R2 (raw_uploaded=true → safe to drop)
    // rather than relying on the moved file being re-detected.
    const processedDir = this.dateFolder(PROCESSED);
    this.moveFile(frontPath, processedDir);
    if (backPath) this.moveFile(backPath, processedDir);
    this.removePending(idempotencyKey);
    return true;
  }

  failPair(frontPath, backPath, reason, httpStatus, opts = {}) {
    const key = opts.idempotencyKey || frontPath;
    this.log(`FAILED ${path.basename(frontPath)}: ${reason}`, "error");

    // Move to failed/ ONLY when terminal: a permanent client error (4xx) OR the
    // max-lifetime guard tripped. Transient server errors (5xx) keep the files in
    // inbox + pending-queue for restart retry — the lifetime guard in uploadPair
    // eventually routes them here with { terminal: true }, so no retry-forever.
    const moveToFailed = opts.terminal === true || PERMANENT_STATUSES.has(httpStatus);
    if (!moveToFailed) {
      this.log(`server error (${httpStatus || "unknown"}) — keeping files in inbox for retry on restart`);
      this.bufferedFront = null;
      this.lastPair = { frontPath, backPath };
      stateMod.set({ state: "error", bufferedFront: null, lastError: reason });
      this.emitState();
      return;
    }

    // Terminal — move to failed/, write a .error.txt sidecar, drop from queue.
    this.removePending(key);
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
    const sidecar = opts.terminal
      ? `${reason}\nattempts: ${opts.attempts ?? MAX_LIFETIME_ATTEMPTS}/${MAX_LIFETIME_ATTEMPTS}`
      : reason;
    if (movedFront) this.writeError(movedFront, sidecar);
    if (movedBack)  this.writeError(movedBack,  sidecar);
    this.bufferedFront = null;
    this.lastPair = { frontPath: movedFront, backPath: movedBack };
    stateMod.set({ state: "error", bufferedFront: null, lastError: reason });
    this.emitState();
  }

  // ── Manual / one-shot upload ─────────────────────────────────────────

  async uploadManual(filePath, certId, side, replaceExisting, source, retryCount = 0, srcHash = null) {
    if (this.uploading && retryCount === 0) {
      this.log(`manual upload requested while uploading — deferring`, "warn");
      return { ok: false, error: "upload in flight" };
    }
    // Content-hash dedup (first attempt only). Skip the upload if this exact
    // file already went to this cert+side; move it to processed/ as normal.
    if (retryCount === 0) {
      srcHash = await this.sha256File(filePath);
      if (srcHash && this.findUpload(srcHash, certId, side)) {
        this.log(`dedup: identical file already uploaded to ${certId} ${side}, skipping`);
        this.removePending(filePath);
        const processedDir = this.dateFolder(PROCESSED);
        this.moveFile(filePath, processedDir);
        stateMod.set({ state: "success", manualPending: null, lastUploadedCert: certId, lastError: null });
        this.emitState();
        setTimeout(() => {
          const s = stateMod.get();
          if (s.state === "success") { stateMod.set({ state: "idle" }); this.emitState(); }
        }, 1_500);
        return { ok: true, certId, side, deduped: true };
      }
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
        return this.uploadManual(filePath, certId, side, replaceExisting, source, retryCount + 1, srcHash);
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
    // Record for content-hash dedup.
    this.recordUpload(srcHash, certId, side);
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
