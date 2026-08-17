/**
 * Watcher subsystem. Ports the strict-alternating state machine from the
 * old watcher.mjs into a single Electron process.
 *
 * Responsibilities:
 *   - claim only server-armed, certificate/side-bound LiDE capture sessions
 *   - invoke the ImageCaptureCore LiDE bridge and upload its original TIFF
 *     to the session-aware canonical evidence endpoint
 *   - retain the old hot-folder code only as a quarantined recovery archive:
 *     unbound TIFFs are refused, never paired or attached
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
const lide400    = require("./lide400-controller");
const cardFrame  = require("./lide400-card-frame");
const { detectCardBounds, derivePlacementProposal } = require("./lide400-card-detection");
const { COORDINATE_SPACE, assertUprightOrientation } = require("./lide400-preview-transform");

// BASE is overridable via MINTVAULT_SCANS_DIR so an isolated TEST instance can
// run on the same Mac without clobbering the live scanner's inbox / processed /
// failed / pending-queue. Default: the shared ~/mintvault-scans (live agent).
const BASE      = process.env.MINTVAULT_SCANS_DIR || path.join(os.homedir(), "mintvault-scans");
const INBOX     = path.join(BASE, "inbox");
const PROCESSED = path.join(BASE, "processed");
const FAILED    = path.join(BASE, "failed");
const REJECTED  = path.join(BASE, "rejected");
const DISCARDED = path.join(BASE, "discarded");
const CAPTURE_STAGING = path.join(BASE, "capture-staging");
// Local-only setup Preview JPEGs. This directory is never watched by the
// retired hot-folder path and never appears in a server/evidence request.
const POSITIONING_PREVIEW = path.join(BASE, "positioning-preview");
// Direct ImageCaptureCore output is intentionally kept outside the legacy
// hot-folder queue.  A completed physical scan is valuable evidence even when
// the app or network dies before the server's acknowledgement arrives.
const TARGETED_QUEUE = path.join(BASE, "targeted-capture-queue.json");
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
const TARGETED_RETRY_DELAYS_MS = [2_000, 5_000];
const TARGET_KEEPALIVE_MS = 60_000;
const PREVIEW_MAX_EDGE_PX = 1_400;
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const POSITIONING_PREVIEW_MAX_EDGE_PX = 1_800;
// Each ImageCaptureCore health probe opens and closes the physical scanner
// session. AirScan-backed LiDE devices need a short release interval; probing
// every target-poll tick can make the station report its *own* prior probe as
// `busy`. Server target polling remains fast, while physical readiness is
// intentionally sampled at a bounded operator-safe cadence.
const SCANNER_HEALTH_MIN_INTERVAL_MS = 15_000;

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
    this.targetCaptureInFlight = false;
    this.previewActionInFlight = false;
    this.positioningPreviewInFlight = false;
    this.lastScannerHealthAt = 0;
    this.scannerHealthPromise = null;
  }

  async start() {
    for (const dir of [BASE, INBOX, PROCESSED, FAILED, REJECTED, DISCARDED, CAPTURE_STAGING, POSITIONING_PREVIEW]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!server.hasToken()) {
      // A fresh production Mac is intentionally not a scanner credential yet.
      // Keep the local service/Preview available for first-run diagnostics, but
      // do not poll or accept a target until Keychain-backed station approval
      // plus an authorised operator session exists.
      this.log("authoritative capture disabled until MintVault station sign-in and approval complete", "info");
      stateMod.set({ state: "idle", lastError: null });
      this.emit("state-changed", stateMod.get());
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
    // A direct TIFF is tied to a specific server session and is never mixed
    // with legacy inbox recovery.  Reconcile it before accepting another
    // physical capture, so a crash cannot force a side-level rescan.
    await this.resumeTargetedCaptures();
    // Re-render/analyse a retained local setup Preview after an app update.
    // This is image-only local work: it never creates a target, TIFF, upload,
    // or evidence mutation. It lets a corrected display transform be reviewed
    // against the exact Preview that produced an older state record.
    await this.reanalyseStoredPositioningPreview();

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
    this.log(`startup: quarantining ${pending.length} legacy hot-folder queue entry/entries`);
    for (const entry of pending) {
      try {
        const candidates = [entry.frontPath, entry.backPath, entry.filePath].filter(Boolean);
        const rejectedDir = this.dateFolder(REJECTED);
        for (const candidate of candidates) {
          if (!fs.existsSync(candidate)) continue;
          const moved = this.moveFile(candidate, rejectedDir);
          if (moved) this.writeError(moved, "Legacy pending hot-folder upload quarantined at Canon LiDE target-session cutover.");
        }
        // The local files are retained for forensic recovery, but the old queue
        // can never be re-driven because it has no target-session evidence.
        this.removePending(entry.key);
      } catch (err) {
        this.log(`reconcile failed for ${entry.key}: ${err.message}`, "error");
      }
    }
  }

  // ── Targeted capture: arm → explicit scan → local preview → accept ─────

  readTargetedQueue() {
    try {
      const entries = JSON.parse(fs.readFileSync(TARGETED_QUEUE, "utf8"));
      return Array.isArray(entries) ? entries : [];
    } catch { return []; }
  }

  /** Count retained TIFFs that still need a server upload acknowledgement. */
  targetedPendingUploadCount() {
    return this.readTargetedQueue().filter((entry) => ["upload", "upload_retry"].includes(String(entry?.phase))).length;
  }

  writeTargetedQueue(entries) {
    const temp = `${TARGETED_QUEUE}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(entries, null, 2));
      fs.renameSync(temp, TARGETED_QUEUE);
    } catch (error) {
      this.log(`targeted capture queue write failed: ${error.message}`, "warn");
    }
  }

  addTargetedPending(entry) {
    const queue = this.readTargetedQueue().filter((item) => item.sessionId !== entry.sessionId);
    queue.push({ ...entry, updatedAt: new Date().toISOString() });
    this.writeTargetedQueue(queue);
  }

  removeTargetedPending(sessionId) {
    this.writeTargetedQueue(this.readTargetedQueue().filter((item) => item.sessionId !== sessionId));
  }

  activeTargetEntry() {
    const sessionId = stateMod.get().activeCapture?.id;
    return sessionId ? this.readTargetedQueue().find((entry) => entry.sessionId === sessionId) || null : null;
  }

  setTargetState(entry, stage, state = stage, lastError = null) {
    stateMod.set({
      state,
      activeCapture: {
        id: entry.sessionId,
        certId: entry.certId,
        side: entry.side,
        workstationId: entry.workstationId,
        stage,
        previewId: entry.previewId || null,
        attempt: Number(entry.attempt || 1),
      },
      lastError,
    });
    this.emitState();
  }

  isTransientCaptureFailure(errorOrResponse) {
    const status = Number(errorOrResponse?.status);
    if (RETRYABLE_STATUSES.has(status)) return true;
    const message = String(errorOrResponse?.body?.error || errorOrResponse?.message || errorOrResponse || "");
    return /(scanner busy|temporar|timed out|timeout|upload stalled|server slow|fetch failed|network|socket|econn|eai_again|connection reset|r2|object storage)/i.test(message);
  }

  async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async reconcileTargetedCapture(entry) {
    let status;
    try {
      status = await server.getCaptureStatus(entry.sessionId, lide400.deviceId());
    } catch (error) {
      this.log(`targeted status check failed for ${entry.sessionId}: ${error.message}`, "warn");
      return { accepted: false, state: null, unavailable: true };
    }
    if (!status.ok) {
      this.log(`targeted status check rejected for ${entry.sessionId}: ${status.body?.error || `HTTP ${status.status}`}`, "warn");
      return { accepted: false, state: null, unavailable: true };
    }
    return {
      accepted: status.body?.accepted === true,
      state: status.body?.capture?.state || null,
      capture: status.body?.capture
        ? { ...status.body.capture, cardRegistered: status.body?.card_registered === true }
        : null,
    };
  }

  async keepTargetAlive(entry) {
    if (Number(entry.lastKeepaliveAt || 0) + TARGET_KEEPALIVE_MS > Date.now()) return { ok: true, entry };
    let renewed;
    try {
      renewed = await server.renewCapture(entry.sessionId, lide400.deviceId());
    } catch (error) {
      this.log(`targeted keepalive failed for ${entry.sessionId}: ${error.message}`, "warn");
      return { ok: false, unavailable: true, error: error.message };
    }
    if (!renewed.ok) {
      const reason = renewed.body?.error || `Capture keepalive rejected — HTTP ${renewed.status}`;
      if (/expired|not awaiting|not found/i.test(reason)) {
        return this.expireTargetedCapture(entry, reason);
      }
      return { ok: false, error: reason };
    }
    const next = {
      ...entry,
      lastKeepaliveAt: Date.now(),
      expiresAt: renewed.body?.capture?.expiresAt || entry.expiresAt,
    };
    this.addTargetedPending(next);
    return { ok: true, entry: next };
  }

  async createPreviewDerivative(masterPath, previewPath) {
    const sharp = require("sharp");
    await sharp(masterPath, { limitInputPixels: false })
      // The LiDE platen is physically inverted relative to how staff place a
      // card. This affects the non-authoritative operator derivative only;
      // masterPath remains the byte-identical hardware TIFF for evidence.
      .rotate(180)
      .resize(PREVIEW_MAX_EDGE_PX, PREVIEW_MAX_EDGE_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toFile(previewPath);
    const stat = fs.statSync(previewPath);
    if (!stat.isFile() || stat.size < 4 || stat.size > PREVIEW_MAX_BYTES) {
      throw new Error("Preview derivative is unreadable or exceeds the station limit");
    }
    return previewPath;
  }

  async assessCaptureFrame(masterPath, provenance) {
    return cardFrame.assessLide400CardFrame(masterPath, provenance?.scanAreaMm);
  }

  async createPositioningPreviewDisplay(sourcePath, previewPath) {
    const sharp = require("sharp");
    const image = sharp(sourcePath, { limitInputPixels: false });
    const metadata = await image.metadata();
    assertUprightOrientation(metadata.orientation);
    const info = await image
      // Keep the setup Preview in the exact same presentation coordinate
      // space as a final Front/Back preview and its card/area overlays.
      .rotate(180)
      .resize(POSITIONING_PREVIEW_MAX_EDGE_PX, POSITIONING_PREVIEW_MAX_EDGE_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true })
      .toFile(previewPath);
    const stat = fs.statSync(previewPath);
    if (!stat.isFile() || stat.size < 4 || stat.size > PREVIEW_MAX_BYTES) {
      throw new Error("Positioning preview is unreadable or exceeds the station limit");
    }
    return { path: previewPath, image: { width: info.width, height: info.height, orientation: 1, format: "jpeg" } };
  }

  async analysePositioningPreview(sourcePath, areaMm) {
    const sharp = require("sharp");
    const image = sharp(sourcePath, { limitInputPixels: false });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) throw new Error("Positioning preview could not be decoded");
    const orientation = assertUprightOrientation(metadata.orientation);
    const { data, info } = await image
      .clone()
      // detectCardBounds returns a physical rectangle through the shared
      // transform. Analyse the displayed 180° raster, not a hidden raw view.
      .rotate(180)
      .resize({ width: Math.min(POSITIONING_PREVIEW_MAX_EDGE_PX, metadata.width), height: POSITIONING_PREVIEW_MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error("Positioning preview requires RGB scanner pixels");
    const cardCandidate = detectCardBounds(data, info.width, info.height, areaMm);
    const placement = derivePlacementProposal(cardCandidate, areaMm, lide400._private.PROFILE_AREA_MM);
    return {
      image: {
        width: metadata.width,
        height: metadata.height,
        density: metadata.density ?? null,
        format: metadata.format || null,
        orientation,
        coordinateSpace: COORDINATE_SPACE,
      },
      cardCandidate,
      placement,
    };
  }

  storedPositioningPreviewSource(entry) {
    const root = path.resolve(POSITIONING_PREVIEW) + path.sep;
    const displayPath = path.resolve(String(entry?.previewPath || ""));
    if (!displayPath.startsWith(root) || ![".jpg", ".jpeg"].includes(path.extname(displayPath).toLowerCase())) return null;
    const directory = path.dirname(displayPath);
    try {
      return fs.readdirSync(directory)
        .sort()
        .map((name) => path.resolve(directory, name))
        .find((candidate) => candidate.startsWith(root)
          && [".jpg", ".jpeg"].includes(path.extname(candidate).toLowerCase())
          && !candidate.endsWith(".display.jpg")
          && fs.statSync(candidate).isFile()) || null;
    } catch {
      return null;
    }
  }

  async reanalyseStoredPositioningPreview() {
    const entry = stateMod.get().positioningPreview;
    if (!entry || !["detected", "reposition", "not_detected"].includes(entry.status)) return false;
    const areaMm = entry.capture?.areaMm;
    if (!areaMm || !["x", "y", "width", "height"].every((key) => Number.isFinite(Number(areaMm[key])))) return false;
    const sourcePath = this.storedPositioningPreviewSource(entry);
    if (!sourcePath) return false;
    try {
      const analysis = await this.analysePositioningPreview(sourcePath, areaMm);
      const status = analysis.cardCandidate ? (analysis.placement.ready ? "detected" : "reposition") : "not_detected";
      stateMod.set({
        positioningPreview: {
          ...entry,
          status,
          reanalysedAt: new Date().toISOString(),
          capture: {
            ...entry.capture,
            coordinateSpace: COORDINATE_SPACE,
            rasterOrientation: analysis.image.orientation,
          },
          image: analysis.image,
          cardCandidate: analysis.cardCandidate,
          placement: analysis.placement,
        },
        lastError: null,
      });
      this.emitState();
      this.log(`positioning-preview ${JSON.stringify({ id: entry.id, stage: "reanalysed", cardDetected: Boolean(analysis.cardCandidate), placementReady: Boolean(analysis.placement.ready) })}`);
      return true;
    } catch (error) {
      this.log(`positioning-preview retained Preview reanalysis failed: ${error.message || String(error)}`, "warn");
      return false;
    }
  }

  positioningPreviewData(previewId) {
    const entry = stateMod.get().positioningPreview;
    if (!entry || entry.id !== previewId || !["detected", "reposition", "not_detected", "saved"].includes(entry.status)) {
      return { ok: false, error: "Positioning preview is stale or unavailable" };
    }
    const root = path.resolve(POSITIONING_PREVIEW) + path.sep;
    const previewPath = path.resolve(String(entry.previewPath || ""));
    if (!previewPath.startsWith(root) || ![".jpg", ".jpeg"].includes(path.extname(previewPath).toLowerCase())) {
      return { ok: false, error: "Positioning preview path is invalid" };
    }
    try {
      const stat = fs.statSync(previewPath);
      if (!stat.isFile() || stat.size < 4 || stat.size > PREVIEW_MAX_BYTES) throw new Error("Positioning preview file is unavailable");
      return { ok: true, previewId, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(previewPath).toString("base64")}` };
    } catch (error) {
      return { ok: false, error: error.message || "Positioning preview file is unavailable" };
    }
  }

  async runPositioningPreview() {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "Preview is unavailable while Scan, Accept, Rescan, or another Preview is in progress" };
    }
    const active = this.activeTargetEntry();
    if (active && active.phase !== "awaiting_scan") {
      return { ok: false, error: "Positioning Preview is unavailable while a card TIFF is awaiting Accept or Rescan" };
    }
    const health = stateMod.get().scannerHealth?.status;
    if (!["ready", "profile_unprovisioned"].includes(health)) {
      return { ok: false, error: "Canon LiDE 400 is not ready for a positioning Preview" };
    }
    this.positioningPreviewInFlight = true;
    const id = crypto.randomUUID();
    const directory = path.join(POSITIONING_PREVIEW, id);
    const startedAt = Date.now();
    fs.mkdirSync(directory, { recursive: true });
    stateMod.set({
      state: "positioning_preview_scanning",
      positioningPreview: { id, status: "scanning", startedAt: new Date().toISOString() },
      lastError: null,
    });
    this.emitState();
    this.log(`positioning-preview ${JSON.stringify({ id, stage: "started", at: new Date().toISOString() })}`);
    try {
      const capture = await lide400.positioningPreview(directory);
      if (capture.requestedDpi !== lide400._private.POSITIONING_PREVIEW_DPI || capture.driverResolutionDpi !== lide400._private.POSITIONING_PREVIEW_DPI) {
        throw new Error("Positioning Preview did not use the locked local setup resolution");
      }
      const areaMm = capture.appliedRegionMm;
      if (!areaMm || !["x", "y", "width", "height"].every((key) => Number.isFinite(Number(areaMm[key])))) {
        throw new Error("Positioning Preview did not report its physical hardware area");
      }
      const previewPath = path.join(directory, `${id}.display.jpg`);
      const display = await this.createPositioningPreviewDisplay(capture.path, previewPath);
      const analysis = await this.analysePositioningPreview(capture.path, areaMm);
      const status = analysis.cardCandidate ? (analysis.placement.ready ? "detected" : "reposition") : "not_detected";
      const positioningPreview = {
        id,
        status,
        previewPath,
        completedAt: new Date().toISOString(),
        capture: {
          sourceFormat: "jpeg",
          sourceDpi: capture.driverResolutionDpi,
          areaMm,
          sizeBytes: capture.sizeBytes,
          scanner: capture.scanner,
          coordinateSpace: capture.coordinateSpace,
          rasterOrientation: capture.rasterOrientation,
        },
        image: analysis.image,
        displayImage: display.image,
        cardCandidate: analysis.cardCandidate,
        placement: analysis.placement,
      };
      stateMod.set({
        // A server target remains only in awaiting_scan. Preview does not
        // claim, mutate, upload, or otherwise retarget that card-side session.
        state: active ? "awaiting_scan" : "idle",
        positioningPreview,
        lastError: null,
      });
      this.emitState();
      this.log(`positioning-preview ${JSON.stringify({ id, stage: status, elapsedMs: Date.now() - startedAt, cardDetected: Boolean(analysis.cardCandidate), placementReady: Boolean(analysis.placement.ready) })}`);
      return { ok: true, previewId: id, status, placementReady: Boolean(analysis.placement.ready) };
    } catch (error) {
      const reason = error?.message || String(error);
      stateMod.set({
        state: active ? "awaiting_scan" : "positioning_preview_error",
        positioningPreview: { id, status: "error", error: reason, completedAt: new Date().toISOString() },
        lastError: active ? null : reason,
      });
      this.emitState();
      this.log(`positioning-preview ${JSON.stringify({ id, stage: "failed", elapsedMs: Date.now() - startedAt, reason })}`, "warn");
      return { ok: false, error: reason };
    } finally {
      this.positioningPreviewInFlight = false;
    }
  }

  applyPositioningPreview(previewId) {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "Placement cannot be saved while scanner work is in progress" };
    }
    const entry = stateMod.get().positioningPreview;
    if (!entry || entry.id !== previewId || entry.status !== "detected" || !entry.placement?.ready) {
      return { ok: false, error: "This positioning preview is stale or not safe enough to establish a placement zone" };
    }
    try {
      const persisted = lide400.persistJigOrigin(entry.placement.originMm);
      stateMod.set({
        positioningPreview: { ...entry, status: "saved", savedAt: new Date().toISOString(), persisted },
        lastError: null,
      });
      this.emitState();
      this.log(`positioning-preview ${JSON.stringify({ id: entry.id, stage: "placement_saved", originMm: persisted.originMm, areaMm: persisted.areaMm })}`);
      return { ok: true, persisted };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  previewData(previewId) {
    const entry = this.activeTargetEntry();
    if (!entry || !["preview_ready", "preview_error"].includes(entry.phase) || entry.previewId !== previewId) {
      return { ok: false, error: "Preview is stale or no longer awaiting acceptance" };
    }
    const root = path.resolve(CAPTURE_STAGING) + path.sep;
    const previewPath = path.resolve(String(entry.previewPath || ""));
    if (!previewPath.startsWith(root) || path.extname(previewPath).toLowerCase() !== ".jpg") {
      return { ok: false, error: "Preview path is invalid" };
    }
    try {
      const stat = fs.statSync(previewPath);
      if (!stat.isFile() || stat.size < 4 || stat.size > PREVIEW_MAX_BYTES) throw new Error("Preview file is unavailable");
      return { ok: true, previewId, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(previewPath).toString("base64")}` };
    } catch (error) {
      return { ok: false, error: error.message || "Preview file is unavailable" };
    }
  }

  archivePreviewCandidate(entry, reason) {
    const archiveDir = this.dateFolder(DISCARDED);
    const files = [...new Set([entry.filePath, entry.previewPath].filter(Boolean))];
    for (const filePath of files) {
      if (!fs.existsSync(filePath)) continue;
      const moved = this.moveFile(filePath, archiveDir);
      if (moved && filePath === entry.filePath) this.writeError(moved, reason);
    }
  }

  expireTargetedCapture(entry, reason) {
    // An expired/cancelled session can no longer authorize this TIFF. Keep it
    // outside the live queue for audit/recovery, then release the station so
    // MintVault can arm a fresh card-side target.
    this.archivePreviewCandidate(entry, `Capture target expired or changed before acceptance. ${reason}`);
    this.removeTargetedPending(entry.sessionId);
    stateMod.set({ state: "error", activeCapture: null, lastError: reason });
    this.emitState();
    this.logCaptureStage(entry, "expired", { reason });
    return { ok: false, error: reason };
  }

  completeTargetedCapture(entry, capture) {
    const moved = this.moveFile(entry.filePath, this.dateFolder(PROCESSED));
    if (!moved && fs.existsSync(entry.filePath)) {
      // Acceptance is already server-authoritative. Keep the queue entry so
      // local archival can retry without another upload or physical scan.
      stateMod.set({ state: "error", activeCapture: null, lastError: "Image accepted — retaining local archive for retry" });
      this.emitState();
      return { ok: false, retryPending: true };
    }
    if (entry.previewPath && fs.existsSync(entry.previewPath)) this.moveFile(entry.previewPath, this.dateFolder(PROCESSED));
    this.removeTargetedPending(entry.sessionId);
    const certId = capture?.certificateNumber || entry.certId;
    const cardRegistered = capture?.cardRegistered === true;
    stateMod.set({
      state: "success",
      activeCapture: null,
      lastUploadedCert: certId,
      lastAcceptedCapture: {
        certId,
        side: entry.side,
        cardRegistered,
        acceptedAt: new Date().toISOString(),
      },
      /*
       * THE CARD IS ONLY FINISHED WHEN THE SERVER SAYS BOTH SIDES ARE REGISTERED.
       *
       * `cardRegistered` is the server's own answer (`card_registered` on the accept/status
       * response), never a local count of how many sides this app believes it has sent. Clearing on
       * an accepted FRONT would re-enable NEW CARD with the card still on the glass, which is
       * precisely the double-mint this record exists to prevent; keeping it set until the server
       * confirms completion is what makes FRONT -> BACK stay on the SAME MV.
       */
      ...(cardRegistered ? { openCardJob: null } : {}),
      lastError: null,
    });
    stateMod.pushRecent({ certId, side: entry.side, source: "targeted-lide" });
    this.emitState();
    this.logCaptureStage(entry, "accepted", { certId, elapsedMs: entry.capturedAtMs ? Date.now() - entry.capturedAtMs : null });
    this.log(`targeted ${entry.side} capture accepted for ${certId} (session ${entry.sessionId})`);
    setTimeout(() => {
      if (stateMod.get().state === "success") {
        stateMod.set({ state: "idle" });
        this.emitState();
      }
    }, 1_500);
    return { ok: true, certId };
  }

  failTargetedCapture(entry, reason, { notifyServer = false } = {}) {
    if (notifyServer) {
      void server.failCapture(entry.sessionId, lide400.deviceId(), reason).catch((error) => {
        this.log(`could not mark physical capture failed: ${error.message}`, "warn");
      });
    }
    const moved = entry.filePath && fs.existsSync(entry.filePath) ? this.moveFile(entry.filePath, this.dateFolder(FAILED)) : null;
    if (moved) this.writeError(moved, reason);
    if (entry.previewPath && fs.existsSync(entry.previewPath)) this.moveFile(entry.previewPath, this.dateFolder(FAILED));
    this.removeTargetedPending(entry.sessionId);
    stateMod.set({ state: "error", activeCapture: null, lastError: reason });
    this.emitState();
    this.logCaptureStage(entry, "failed", { reason });
    return { ok: false, error: reason };
  }

  async uploadTargetedCapture(entry) {
    if (!(await this.waitForStable(entry.filePath))) {
      this.setTargetState(entry, "uploading", "uploading", "TIFF still processing — retrying completed-write check");
      return { ok: false, retryPending: true };
    }
    const initial = await this.reconcileTargetedCapture(entry);
    if (initial.accepted) return this.completeTargetedCapture(entry, initial.capture);
    if (initial.unavailable) return { ok: false, retryPending: true };
    if (["failed", "expired", "cancelled"].includes(initial.state)) {
      return this.failTargetedCapture(entry, initial.capture?.failureReason || "Capture expired or was rejected — restart this side");
    }
    if (initial.state === "capturing") {
      this.setTargetState(entry, "uploading", "uploading", "Server is finalising the image — checking again shortly");
      return { ok: false, retryPending: true };
    }
    if (initial.state !== "claimed") return this.failTargetedCapture(entry, "Capture session is no longer available — restart this side");

    for (let attempt = Number(entry.uploadAttempts || 0); attempt <= TARGETED_RETRY_DELAYS_MS.length; attempt++) {
      this.setTargetState({ ...entry, attempt: attempt + 1 }, "uploading", "uploading", attempt ? `Upload interrupted — retrying ${attempt}/${TARGETED_RETRY_DELAYS_MS.length}` : null);
      let uploaded;
      const uploadStartedAt = Date.now();
      this.logCaptureStage(entry, "upload_started", { attempt: attempt + 1 });
      try {
        uploaded = await server.uploadCaptureEvidence(entry.sessionId, lide400.deviceId(), entry.filePath, entry.provenance);
      } catch (error) {
        uploaded = { ok: false, status: 0, body: { error: error.message || String(error) } };
      }
      if (uploaded.ok) {
        return this.completeTargetedCapture(entry, {
          certificateNumber: uploaded.body?.certId || entry.certId,
          cardRegistered: uploaded.body?.card_registered === true,
        });
      }
      this.logCaptureStage(entry, "upload_response_lost_or_rejected", { attempt: attempt + 1, status: uploaded.status, elapsedMs: Date.now() - uploadStartedAt });
      const reconciled = await this.reconcileTargetedCapture(entry);
      if (reconciled.accepted) return this.completeTargetedCapture(entry, reconciled.capture);
      if (!this.isTransientCaptureFailure(uploaded)) return this.failTargetedCapture(entry, uploaded.body?.error || `Image rejected — HTTP ${uploaded.status}`);
      if (["failed", "expired", "cancelled"].includes(reconciled.state)) return this.failTargetedCapture(entry, reconciled.capture?.failureReason || "Capture rejected — restart this side");
      if (reconciled.state === "capturing" || reconciled.unavailable) {
        this.addTargetedPending({ ...entry, phase: "upload", uploadAttempts: attempt + 1 });
        return { ok: false, retryPending: true };
      }
      if (attempt === TARGETED_RETRY_DELAYS_MS.length) {
        this.addTargetedPending({ ...entry, phase: "upload", uploadAttempts: 0, retryAfter: Date.now() + 60_000 });
        stateMod.set({ state: "error", activeCapture: null, lastError: "Upload interrupted — keeping this accepted side for safe retry" });
        this.emitState();
        return { ok: false, retryPending: true };
      }
      await this.sleep(TARGETED_RETRY_DELAYS_MS[attempt]);
    }
    return { ok: false, retryPending: true };
  }

  async restorePreviewCandidate(entry) {
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      const waiting = { ...entry, phase: "awaiting_scan", previewId: null, previewPath: null, filePath: null, provenance: null };
      this.addTargetedPending(waiting);
      this.setTargetState(waiting, "awaiting_scan", "awaiting_scan", "Previous scan was interrupted before a preview was ready — press Scan to try again");
      return waiting;
    }
    let restored = entry;
    if (!restored.previewPath || !fs.existsSync(restored.previewPath)) {
      const previewId = restored.previewId || crypto.randomUUID();
      const previewPath = path.join(path.dirname(restored.filePath), `${previewId}.preview.jpg`);
      await this.createPreviewDerivative(restored.filePath, previewPath);
      restored = { ...restored, phase: "preview_ready", previewId, previewPath };
      this.addTargetedPending(restored);
    }
    if (!restored.frameAssessment?.accepted) {
      const unsafe = {
        ...restored,
        phase: "preview_error",
        previewError: restored.previewError || "This staged TIFF predates the required card-boundary safety assessment — Rescan this side",
      };
      this.addTargetedPending(unsafe);
      this.setTargetState(unsafe, "preview_error", "preview_error", unsafe.previewError);
      return unsafe;
    }
    this.setTargetState(restored, "preview_ready", "preview_ready");
    return restored;
  }

  async resumeTargetedCaptures() {
    const queue = this.readTargetedQueue();
    if (!queue.length || this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) return false;
    for (const entry of queue) {
      if (!entry?.sessionId) {
        this.removeTargetedPending(entry?.sessionId);
        continue;
      }
      if (entry.phase === "upload") {
        if (!entry.filePath || !fs.existsSync(entry.filePath)) {
          this.removeTargetedPending(entry.sessionId);
          continue;
        }
        if (Number(entry.retryAfter || 0) > Date.now()) return true;
        this.targetCaptureInFlight = true;
        try { await this.uploadTargetedCapture(entry); } finally { this.targetCaptureInFlight = false; }
        return true;
      }
      const kept = await this.keepTargetAlive(entry);
      if (!kept.ok) return true;
      if (entry.phase === "preview_ready") {
        try { await this.restorePreviewCandidate(kept.entry); }
        catch (error) { this.setTargetState(kept.entry, "preview_error", "preview_error", error.message || "Preview unavailable — Rescan this side"); }
      } else if (entry.phase === "preview_error") {
        // Preserve the failed candidate exactly as-is. A restart must not
        // silently repair/regenerate a stale preview and make it acceptable.
        this.setTargetState(kept.entry, "preview_error", "preview_error", kept.entry.previewError || "Preview unavailable — Rescan this side");
      } else {
        this.setTargetState(kept.entry, "awaiting_scan", "awaiting_scan");
      }
      // One physical station stays bound to this target until it is accepted,
      // expired, or explicitly rescanned. Never claim a second card/side here.
      return true;
    }
    return false;
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

  /** One parseable record per direct-capture boundary for station diagnostics. */
  logCaptureStage(entry, stage, extra = {}) {
    this.log(`capture-stage ${JSON.stringify({
      sessionId: entry?.sessionId || entry?.id || null,
      certId: entry?.certId || entry?.certificateNumber || null,
      side: entry?.side || null,
      stage,
      at: new Date().toISOString(),
      ...extra,
    })}`);
  }

  // ── External controls ────────────────────────────────────────────────

  setMode(mode) {
    if (mode !== "AUTO" && mode !== "MANUAL") return;
    if (mode === "AUTO") {
      this.log("AUTO hot-folder ingest is retired: arm a target-bound LiDE capture from the workstation", "warn");
      stateMod.set({ mode: "MANUAL", lastError: "Unbound AUTO intake is disabled. Arm the card-side capture in MintVault first." });
      this.emitState();
      return;
    }
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
    void certId; void side; void replaceExisting; void cancel;
    return { ok: false, error: "Unbound TIFF attachment is retired. Arm a target-bound capture in MintVault." };
  }

  /**
   * Orphan picker arms a one-shot manual upload. The next .tif goes to
   * the specified cert+side regardless of mode. Cleared after use.
   */
  armOneShot({ certId, side, replaceExisting }) {
    void certId; void side; void replaceExisting;
    return { ok: false, error: "One-shot TIFF attachment is retired. Use a controlled capture session." };
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

  /** Refresh genuine ImageCaptureCore + locked-profile readiness for the tray. */
  async refreshScannerHealth({ force = false } = {}) {
    // ImageCaptureCore health opens a scanner session. Never let the periodic
    // tray poll contend with an operator-initiated Scan or an in-flight Accept
    // on the same station process.
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return stateMod.get().scannerHealth;
    }
    if (!force && this.lastScannerHealthAt && Date.now() - this.lastScannerHealthAt < SCANNER_HEALTH_MIN_INTERVAL_MS) {
      return stateMod.get().scannerHealth;
    }
    if (this.scannerHealthPromise) return this.scannerHealthPromise;
    this.scannerHealthPromise = (async () => {
      try {
        const scannerHealth = await lide400.health();
        this.lastScannerHealthAt = Date.now();
        stateMod.set({ scannerHealth });
        this.emitState();
        return scannerHealth;
      } finally {
        this.scannerHealthPromise = null;
      }
    })();
    return this.scannerHealthPromise;
  }

  /**
   * Claiming only displays a server-owned card-side target. It never starts
   * ImageCaptureCore: the physical scan can begin only through scanActiveTarget
   * after the operator has positioned the card and pressed Scan.
   */
  async pollTargetedCapture() {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight || this.uploading || !server.hasToken()) {
      return { ok: false, skipped: true };
    }
    if (await this.resumeTargetedCaptures()) return { ok: true, resumed: true };
    const health = stateMod.get().scannerHealth;
    if (health?.status !== "ready") {
      return { ok: false, waitingForDevice: true, health: health?.status || "checking" };
    }
    let claim;
    try {
      claim = await server.claimNextCapture(lide400.stationId(), lide400.deviceId());
    } catch (error) {
      this.log(`capture-session poll failed: ${error.message}`, "warn");
      return { ok: false, error: error.message };
    }
    if (!claim.ok) {
      this.log(`capture-session poll rejected: ${claim.body?.error || `HTTP ${claim.status}`}`, "warn");
      return { ok: false, error: claim.body?.error || `HTTP ${claim.status}` };
    }
    const capture = claim.body?.capture;
    if (!capture) return { ok: true, idle: true };
    const entry = this.targetEntryFromCapture(capture);
    this.addTargetedPending(entry);
    this.setTargetState(entry, "awaiting_scan", "awaiting_scan");
    this.logCaptureStage(entry, "target_claimed_waiting_for_operator");
    return { ok: true, armed: true, capture };
  }

  /**
   * The one place a server capture record becomes a local durable queue entry.
   *
   * Shared by the polling claim above and by `adoptArmedCapture` below so the two cannot drift: a
   * target adopted at the moment of arming and the same target rediscovered by a later poll produce
   * a byte-identical entry, which is what makes a restart mid-card resume rather than diverge.
   */
  targetEntryFromCapture(capture) {
    return {
      phase: "awaiting_scan",
      sessionId: capture.id,
      certId: capture.certificateNumber,
      side: capture.side === "back" ? "back" : "front",
      workstationId: capture.workstationId,
      expiresAt: capture.expiresAt || null,
      lastKeepaliveAt: Date.now(),
      previewId: null,
      previewPath: null,
      filePath: null,
      provenance: null,
      frameAssessment: null,
      capturedAtMs: null,
      uploadAttempts: 0,
    };
  }

  /**
   * COMMIT A CAPTURE THIS STATION JUST ARMED INTO THE SHARED STATE THE RENDERER READS.
   *
   * THE DEFECT THIS CLOSES. `start-new-card` and `arm-capture` both received a fully armed capture
   * session from the server and RETURNED it to the renderer as a function result — while the shared
   * state that actually drives the window (`stateMod.activeCapture`) stayed null. The operator was
   * therefore shown "No card ready" for a card that existed, was paid for, and had its FRONT armed
   * and waiting, until the idle poll happened to rediscover it up to 35 seconds later. Worse, the
   * physical Scan button is gated on `activeTargetEntry()`, which reads the durable queue — so until
   * that poll landed the card could not be photographed at all.
   *
   * Arming and adopting are now one act. Nothing waits for a poll to rediscover what this process
   * itself just created.
   *
   * IDEMPOTENT. Re-adopting the session already held is a no-op, so a retried arm that the server
   * answers from an existing session cannot produce a duplicate queue entry.
   *
   * REFUSES TO DISPLACE A DIFFERENT LIVE TARGET. If this station is already holding another session
   * the adoption is declined rather than overwriting it: migration 0075 guarantees the server will
   * only ever have one active target per station, so a mismatch means our local view is stale and
   * the reconciling poll — which can archive a staged TIFF safely — must be the one to resolve it.
   *
   * IT MUST CLAIM, NOT MERELY COPY. THIS IS THE WHOLE POINT AND IT WAS THE BUG.
   *
   * `POST /card-jobs/:id/capture-sessions` returns a capture in state `armed` with
   * `claimed_by_device_id` still NULL. Every subsequent scanner call — keepalive, status, evidence
   * upload — is scoped to THE DEVICE THAT CLAIMED THE SESSION. A first version of this method built
   * the local entry straight from the arm response and never claimed, so the station looked armed,
   * scanned a real 1200 DPI TIFF, generated its preview, and then had Accept answered with "Capture
   * session not found for this scanner" — because as far as the server was concerned no device held
   * it. The capture was archived and the operator got an error on a scan that had physically worked.
   *
   * So adoption goes through the SAME canonical claim the poll uses. The station ends up holding a
   * session the server agrees it holds, which is the only state in which the rest of the capture
   * lifecycle can function.
   */
  async adoptArmedCapture(capture) {
    if (!capture || typeof capture.id !== "string" || !capture.id) {
      return { ok: false, error: "MintVault did not return a usable capture target" };
    }
    const held = stateMod.get().activeCapture;
    if (held?.id === capture.id) return { ok: true, alreadyHeld: true, sessionId: capture.id };
    if (held?.id) {
      this.log(`refused to adopt capture ${capture.id}: station is still holding ${held.id}`, "warn");
      return { ok: false, error: "This station is still finishing another card side" };
    }

    /*
     * ALREADY CLAIMED BY THIS STATION — adopt it directly, do NOT try to claim again.
     *
     * The server now answers a re-arm of a card this station already holds by returning that same
     * session (it cannot create a second one; migration 0075 allows one live target per station).
     * That session is typically already `claimed`, and `claimNextCapture` only ever selects `armed`
     * rows — so routing this through the claim would answer "nothing to hand over" and leave the
     * operator with a red NOT ARMED panel over a card that is armed, claimed and ready to scan.
     *
     * The station code is compared explicitly: adopting a session claimed by a DIFFERENT Mac would
     * be taking someone else's card off their glass.
     */
    if (capture.state === "claimed" || capture.state === "capturing") {
      if (String(capture.workstationId || "") !== String(lide400.stationId())) {
        return { ok: false, error: "This card is already being captured at another station" };
      }
      const mine = this.targetEntryFromCapture(capture);
      this.addTargetedPending(mine);
      this.setTargetState(mine, "awaiting_scan", "awaiting_scan");
      this.logCaptureStage(mine, "target_readopted_already_claimed");
      return { ok: true, sessionId: mine.sessionId, certId: mine.certId, side: mine.side, alreadyClaimed: true };
    }

    // Claim it for THIS device, exactly as pollTargetedCapture does. 0075 guarantees a station has
    // at most one active target, so this returns the session that was just armed for it.
    let claim;
    try {
      claim = await server.claimNextCapture(lide400.stationId(), lide400.deviceId());
    } catch (error) {
      this.log(`could not claim armed capture ${capture.id}: ${error.message}`, "warn");
      return { ok: false, retryable: true, error: "MintVault could not hand this card to the scanner. Retry the scanner for this card." };
    }
    if (!claim.ok) {
      const reason = claim.body?.error || `HTTP ${claim.status}`;
      this.log(`claim rejected for armed capture ${capture.id}: ${reason}`, "warn");
      return { ok: false, error: `MintVault could not hand this card to the scanner: ${reason}` };
    }
    const claimed = claim.body?.capture;
    if (!claimed?.id) {
      // Armed but not claimable — most often it expired between the arm and this call. Reported
      // rather than papered over: adopting an unclaimed session is precisely the defect above.
      return { ok: false, error: "MintVault did not hand this card to the scanner. Retry the scanner for this card." };
    }
    if (claimed.id !== capture.id) {
      // The server handed over a DIFFERENT outstanding target for this station. Its answer wins —
      // it is the authority on what this Mac holds — but say so, because the operator asked for one
      // card and is now looking at another.
      this.log(`claimed ${claimed.id} (${claimed.certificateNumber}) rather than the just-armed ${capture.id}`, "warn");
    }

    const entry = this.targetEntryFromCapture(claimed);
    this.addTargetedPending(entry); // durable BEFORE the state the operator can act on
    this.setTargetState(entry, "awaiting_scan", "awaiting_scan");
    this.logCaptureStage(entry, "target_adopted_at_arm");
    return { ok: true, sessionId: entry.sessionId, certId: entry.certId, side: entry.side };
  }

  /**
   * Drop this station's local target for a card the server has just CANCELLED.
   *
   * The server has already made the capture session terminal inside the cancellation transaction,
   * so this is purely local hygiene: without it the window would keep showing a card that is dead,
   * and the operator would press Scan on a session that can only be refused.
   *
   * MATCHED ON THE MV NUMBER, because that is the identifier the local queue carries (`certId` is
   * `certificates.certificate_number`); the numeric certificate id never reaches this app. A
   * mismatch is a no-op — this must never clear a target belonging to a DIFFERENT card, so an
   * unrecognised cancellation leaves the current target exactly where it is.
   *
   * ANY STAGED TIFF IS ARCHIVED, NOT DELETED. A physical scan that happened moments before the
   * cancellation is kept under the local archive with its reason, so nothing an operator did with a
   * real card disappears without a trace.
   */
  releaseTargetForCancelledCard(certificateId, mvNumber) {
    const target = String(mvNumber || "").trim();
    if (!target) return { ok: false, error: "No cancelled card was identified" };
    const entry = this.readTargetedQueue().find((item) => item && item.certId === target);
    const active = stateMod.get().activeCapture;
    if (!entry && active?.certId !== target) return { ok: true, noop: true };
    if (entry) {
      this.archivePreviewCandidate(entry, `Card ${target} was cancelled at this station before capture.`);
      this.removeTargetedPending(entry.sessionId);
      this.logCaptureStage(entry, "target_released_card_cancelled", { certificateId: certificateId ?? null });
    }
    if (active?.certId === target) {
      stateMod.set({ state: "idle", activeCapture: null, lastError: null });
    }
    this.emitState();
    return { ok: true, released: true };
  }

  async scanActiveTarget() {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "A scan, Accept, Rescan, or positioning Preview action is already in progress" };
    }
    const current = this.activeTargetEntry();
    if (!current || current.phase !== "awaiting_scan") {
      return { ok: false, error: "No current card-side target is awaiting Scan" };
    }
    if (stateMod.get().scannerHealth?.status !== "ready") {
      return { ok: false, error: "Canon LiDE 400 is not ready for a locked-profile scan" };
    }
    // Claim the local single-flight guard before the first await. Otherwise
    // two rapid IPC clicks can both observe `awaiting_scan` and start two
    // physical scans while the device-bound keepalive resolves.
    this.targetCaptureInFlight = true;
    try {
      const kept = await this.keepTargetAlive(current);
      if (!kept.ok) return { ok: false, error: kept.error || "Capture target can no longer be used" };
      const previewId = crypto.randomUUID();
      const captureDir = path.join(CAPTURE_STAGING, current.sessionId, previewId);
      const scanning = { ...kept.entry, phase: "scanning", previewId, captureDir, attempt: 1 };
      this.addTargetedPending(scanning); // durable before a physical scan begins
      fs.mkdirSync(captureDir, { recursive: true });
      this.setTargetState(scanning, "scanning", current.side === "front" ? "scanning_front" : "scanning_back");
      this.logCaptureStage(scanning, "scan_started");
      let direct;
      let lastScanError = null;
      const startedAt = Date.now();
      for (let attempt = 0; attempt <= TARGETED_RETRY_DELAYS_MS.length; attempt++) {
        try {
          if (attempt) {
            const retrying = { ...scanning, attempt: attempt + 1 };
            this.setTargetState(retrying, "retrying_scan", current.side === "front" ? "scanning_front" : "scanning_back", `Scanner busy — retrying ${attempt}/${TARGETED_RETRY_DELAYS_MS.length}`);
            await this.sleep(TARGETED_RETRY_DELAYS_MS[attempt - 1]);
          }
          direct = await lide400.scan(captureDir);
          this.logCaptureStage(scanning, "scan_completed", { attempt: attempt + 1, elapsedMs: Date.now() - startedAt });
          break;
        } catch (error) {
          lastScanError = error;
          if (!this.isTransientCaptureFailure(error) || attempt === TARGETED_RETRY_DELAYS_MS.length) throw error;
          this.log(`targeted ${current.side} scanner start retry ${attempt + 1}: ${error.message}`, "warn");
        }
      }
      if (!direct) throw lastScanError || new Error("Scanner did not produce a TIFF");
      const previewPath = path.join(captureDir, `${previewId}.preview.jpg`);
      const processing = {
        ...scanning,
        phase: "preview_processing",
        filePath: direct.path,
        previewPath,
        provenance: direct.provenance,
        capturedAtMs: Date.now(),
      };
      this.addTargetedPending(processing);
      this.setTargetState(processing, "processing_preview", "finalising", "Generating non-authoritative preview from the 1200 DPI TIFF");
      await this.createPreviewDerivative(processing.filePath, previewPath);
      const frameAssessment = await this.assessCaptureFrame(processing.filePath, processing.provenance);
      const assessed = { ...processing, frameAssessment };
      if (!frameAssessment?.accepted) {
        const reason = frameAssessment?.reason || "Card-boundary safety check rejected this TIFF";
        const unsafe = { ...assessed, phase: "preview_error", previewError: reason };
        this.addTargetedPending(unsafe);
        this.setTargetState(unsafe, "preview_error", "preview_error", `${reason} — Rescan this side; the TIFF has not been uploaded`);
        this.logCaptureStage(unsafe, "frame_rejected_before_accept", { elapsedMs: Date.now() - startedAt, reason, frameAssessment });
        return { ok: false, error: reason, previewId };
      }
      const preview = { ...assessed, phase: "preview_ready" };
      this.addTargetedPending(preview);
      this.setTargetState(preview, "preview_ready", "preview_ready");
      this.logCaptureStage(preview, "preview_ready", { elapsedMs: Date.now() - startedAt });
      return { ok: true, previewId };
    } catch (error) {
      const reason = error?.message || String(error);
      const staged = this.activeTargetEntry();
      if (staged?.filePath && fs.existsSync(staged.filePath)) {
        const previewError = { ...staged, phase: "preview_error", previewError: reason };
        this.addTargetedPending(previewError);
        this.setTargetState(previewError, "preview_error", "preview_error", `${reason} — Rescan this side; the TIFF has not been uploaded`);
      } else {
        const waiting = { ...current, phase: "awaiting_scan", previewId: null, previewPath: null, filePath: null, provenance: null, frameAssessment: null };
        this.addTargetedPending(waiting);
        this.setTargetState(waiting, "awaiting_scan", "error", `${reason} — position the card and press Scan again`);
      }
      this.logCaptureStage(current, "scan_or_preview_failed", { reason });
      return { ok: false, error: reason };
    } finally {
      this.targetCaptureInFlight = false;
    }
  }

  async acceptPreview(previewId) {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "A scan, Accept, Rescan, or positioning Preview action is already in progress" };
    }
    const current = this.activeTargetEntry();
    if (!current || current.phase !== "preview_ready" || current.previewId !== previewId) {
      return { ok: false, error: "This preview is stale and cannot be accepted" };
    }
    if (!current.filePath || !fs.existsSync(current.filePath)) {
      return { ok: false, error: "The preview TIFF is no longer available; rescan this side" };
    }
    if (!current.frameAssessment?.accepted) {
      return { ok: false, error: "This TIFF did not pass the four-side card-boundary safety check and cannot be accepted" };
    }
    this.previewActionInFlight = true;
    try {
      const truth = await this.reconcileTargetedCapture(current);
      if (truth.accepted) return this.completeTargetedCapture(current, truth.capture);
      if (truth.unavailable) return { ok: false, error: "Unable to verify capture target; TIFF remains staged and no upload was attempted" };
      if (truth.state !== "claimed") {
        return this.expireTargetedCapture(current, "Capture target expired or changed before Accept — TIFF was not uploaded");
      }
      const kept = await this.keepTargetAlive(current);
      if (!kept.ok) return { ok: false, error: kept.error || "Capture target is no longer valid" };
      const upload = { ...kept.entry, phase: "upload", uploadAttempts: 0, retryAfter: null };
      this.addTargetedPending(upload); // durable before the only authoritative POST
      this.targetCaptureInFlight = true;
      return await this.uploadTargetedCapture(upload);
    } finally {
      this.targetCaptureInFlight = false;
      this.previewActionInFlight = false;
    }
  }

  async rescanPreview(previewId) {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "Rescan is unavailable while Scan, Accept, or positioning Preview is in progress" };
    }
    const current = this.activeTargetEntry();
    if (!current || !["preview_ready", "preview_error"].includes(current.phase) || current.previewId !== previewId) {
      return { ok: false, error: "This preview is stale and cannot be rescanned" };
    }
    this.previewActionInFlight = true;
    try {
      const truth = await this.reconcileTargetedCapture(current);
      if (truth.accepted) return this.completeTargetedCapture(current, truth.capture);
      if (truth.unavailable) return { ok: false, error: "Unable to verify capture target; Rescan is held to prevent a target crossover" };
      if (truth.state !== "claimed") {
        return this.expireTargetedCapture(current, "Capture target expired or changed — Rescan was blocked");
      }
      const kept = await this.keepTargetAlive(current);
      if (!kept.ok) return { ok: false, error: kept.error || "Capture target is no longer valid" };
      this.archivePreviewCandidate(kept.entry, "Operator chose Rescan before acceptance; this TIFF was never uploaded as card evidence.");
      const waiting = { ...kept.entry, phase: "awaiting_scan", previewId: null, previewPath: null, filePath: null, provenance: null, frameAssessment: null, capturedAtMs: null };
      this.addTargetedPending(waiting);
      this.setTargetState(waiting, "awaiting_scan", "awaiting_scan");
      this.logCaptureStage(waiting, "rescan_requested");
      return { ok: true };
    } finally {
      this.previewActionInFlight = false;
    }
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

    // A TIFF that appears in the historical hot folder has no server-issued
    // certificate/card/side session.  Do not ever turn it into a certificate
    // or attach it to an arbitrary existing one.  Preserve it for review with
    // an explicit reason, rather than silently deleting it.
    const rejectedDir = this.dateFolder(REJECTED);
    const reason = "Unbound hot-folder TIFF refused. Start a target-bound Canon LiDE capture from the MintVault workstation.";
    const moved = this.moveFile(filePath, rejectedDir);
    if (moved) this.writeError(moved, reason);
    this.log(`${reason} ${filename}`, "warn");
    stateMod.set({ state: "error", lastError: reason });
    this.emitState();
    return;

    // Pause check — runs before stable-write detection so a paused watcher
    // doesn't even open the file. Clears expired pause as a side effect so
    // the watcher self-heals without a click.
    // eslint-disable-next-line no-unreachable -- deliberate: the legacy path above was RETIRED with an early return and this body is retained as historical recovery context (see the c8-ignore note). Comment only; no runtime change.
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
    void frontPath; void backPath; void retryCount; void hashes; void idempotencyKey; void orientationUnconfirmed;
    return { ok: false, error: "Legacy unbound pair ingestion is retired; arm a target-bound capture session." };
    /* c8 ignore next -- retained below only as historical recovery context; unreachable. */
    // eslint-disable-next-line no-unreachable -- deliberate: the legacy path above was RETIRED with an early return and this body is retained as historical recovery context (see the c8-ignore note). Comment only; no runtime change.
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
    void filePath; void certId; void side; void replaceExisting; void source; void retryCount; void srcHash;
    return { ok: false, error: "Legacy TIFF attachment is retired; arm a target-bound capture session." };
    /* c8 ignore next -- retained below only as historical recovery context; unreachable. */
    // eslint-disable-next-line no-unreachable -- deliberate: the legacy path above was RETIRED with an early return and this body is retained as historical recovery context (see the c8-ignore note). Comment only; no runtime change.
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
        // eslint-disable-next-line no-unreachable -- deliberate: the legacy path above was RETIRED with an early return and this body is retained as historical recovery context (see the c8-ignore note). Comment only; no runtime change.
        return { ok: true, certId, side, deduped: true };
      }
    }
    // eslint-disable-next-line no-unreachable -- deliberate: the legacy path above was RETIRED with an early return and this body is retained as historical recovery context (see the c8-ignore note). Comment only; no runtime change.
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
    // eslint-disable-next-line no-unreachable -- deliberate: the legacy path above was RETIRED with an early return and this body is retained as historical recovery context (see the c8-ignore note). Comment only; no runtime change.
    return { ok: true, certId, side };
  }

  /**
   * Retry the last failed pair. Re-uploads from the failed/ folder.
   */
  async retryLastPair() {
    return { ok: false, error: "Legacy hot-folder retry is retired; use a new target-bound capture session." };
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
