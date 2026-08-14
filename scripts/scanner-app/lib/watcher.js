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
const crypto   = require("node:crypto");
const { EventEmitter } = require("node:events");

const stateMod   = require("./state");
const server     = require("./server-client");
const backDetect = require("./back-detect");
const lide400    = require("./lide400-controller");
const cardFrame  = require("./lide400-card-frame");
const helperIntegrity = require("./helper-integrity");
const scannerPackage = require("../package.json");
const runtimePaths = require("./runtime-paths");
const { readBoundedJson, readBoundedRegularFile } = require("./bounded-file");
const {
  EncryptedCaptureQueue,
  QueueCorruptionError,
  DISPOSITIONS: QUEUE_DISPOSITIONS,
  _private: { canonicalJson },
} = require("./encrypted-capture-queue");
const { detectCardBounds, derivePlacementProposal } = require("./lide400-card-detection");
const { COORDINATE_SPACE, assertUprightOrientation } = require("./lide400-preview-transform");

// The central runtime-path contract permits MINTVAULT_SCANS_DIR only for an
// explicitly unpackaged test/development instance. A packaged app always uses
// the same home-rooted custody directory across relaunch/update.
const BASE      = runtimePaths.scansBase();
const INBOX     = path.join(BASE, "inbox");
const PROCESSED = path.join(BASE, "processed");
const FAILED    = path.join(BASE, "failed");
const REJECTED  = path.join(BASE, "rejected");
const DISCARDED = path.join(BASE, "discarded");
const CAPTURE_STAGING = path.join(BASE, "capture-staging");
// Local-only setup Preview JPEGs. This directory is never watched by the
// retired hot-folder path and never appears in a server/evidence request.
const POSITIONING_PREVIEW = path.join(BASE, "positioning-preview");
// One-time migration source for pre-WP5 targeted queues. It is removed only
// after every record is durably represented by capture-queue/index.v1.json.
const LEGACY_TARGETED_QUEUE = path.join(BASE, "targeted-capture-queue.json");
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
const CALIBRATION_PROOF_MIN_BYTES = 64 * 1024;
const CALIBRATION_PROOF_MAX_BYTES = 512 * 1024 * 1024;
// Each ImageCaptureCore health probe opens and closes the physical scanner
// session. AirScan-backed LiDE devices need a short release interval; probing
// every target-poll tick can make the station report its *own* prior probe as
// `busy`. Server target polling remains fast, while physical readiness is
// intentionally sampled at a bounded operator-safe cadence.
const SCANNER_HEALTH_MIN_INTERVAL_MS = 15_000;
const AUTHORITATIVE_CAPTURE_PURPOSE = "AUTHORITATIVE_CARD_CAPTURE";

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function directoryContainsFiles(directory) {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isFile()) return true;
    if (entry.isDirectory() && directoryContainsFiles(path.join(directory, entry.name))) return true;
  }
  return false;
}

function regularFilesForRetirement(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error("Scanner setup residue is unsafe for station identity retirement");
    }
    if (entry.isDirectory()) regularFilesForRetirement(candidate, files);
    else files.push(candidate);
    if (files.length > 32) throw new Error("Scanner setup residue must be cleared before station identity retirement");
  }
  return files;
}

function disposeHelperCapture(capture) {
  if (!capture?.path) return;
  if (!Number.isInteger(capture.artifactDescriptor)) {
    try { fs.unlinkSync(capture.path); } catch { /* best effort for test/development capture */ }
    return;
  }
  try {
    const opened = fs.fstatSync(capture.artifactDescriptor);
    let current = null;
    try { current = fs.lstatSync(capture.path); } catch { /* already unlinked */ }
    if (current && current.dev === opened.dev && current.ino === opened.ino) fs.unlinkSync(capture.path);
  } finally {
    try { fs.closeSync(capture.artifactDescriptor); } catch { /* already closed */ }
  }
}

function requiredAuthorityString(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 256) throw new Error(`Capture authorisation is missing ${label}`);
  return text;
}

function requiredAuthorityIdentifier(value, label) {
  const text = requiredAuthorityString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,255}$/.test(text)) {
    throw new Error(`Capture authorisation has an invalid ${label}`);
  }
  return text;
}

function parseServerTimestamp(value, label) {
  const text = requiredAuthorityString(value, label);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new Error(`Capture authorisation has an invalid ${label}`);
  return { text, millis };
}

function captureEntryFromAuthorisation(capture) {
  if (!capture || typeof capture !== "object") throw new Error("Server did not return a capture authorisation");
  const side = capture.side;
  if (side !== "front" && side !== "back") throw new Error("Capture authorisation has an invalid side");
  const revision = Number(capture.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Capture authorisation has an invalid evidence revision");
  const issued = parseServerTimestamp(capture.authorisationIssuedAt, "server issued-at timestamp");
  const expires = parseServerTimestamp(capture.authorisationExpiresAt, "server expiry timestamp");
  if (expires.millis <= issued.millis) throw new Error("Capture authorisation expiry must follow server issuance");
  if (capture.capturePurpose !== AUTHORITATIVE_CAPTURE_PURPOSE) throw new Error("Capture authorisation purpose is not authoritative card capture");
  if (capture.originalOperatorRole !== "SCANNER_OPERATOR") throw new Error("Capture authorisation is not bound to a SCANNER_OPERATOR");
  const semanticOperationId = requiredAuthorityIdentifier(capture.semanticOperationId, "semantic operation ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(semanticOperationId)) {
    throw new Error("Capture authorisation has an invalid semantic operation ID");
  }
  return {
    sessionId: requiredAuthorityIdentifier(capture.id, "capture session ID"),
    captureAuthorisationId: requiredAuthorityIdentifier(capture.captureAuthorisationId, "capture authorisation ID"),
    semanticOperationId,
    cardJobId: requiredAuthorityIdentifier(capture.cardJobId, "Card Job ID"),
    certId: requiredAuthorityIdentifier(capture.certificateNumber, "certificate number"),
    side,
    revision,
    profileRevisionId: requiredAuthorityIdentifier(capture.profileRevisionId, "capture profile revision ID"),
    tenantId: requiredAuthorityIdentifier(capture.tenantId, "tenant ID"),
    locationId: requiredAuthorityIdentifier(capture.locationId, "location ID"),
    stationCredentialId: requiredAuthorityIdentifier(capture.stationId, "station ID"),
    workstationId: requiredAuthorityIdentifier(capture.workstationId, "workstation ID"),
    originalOperatorId: requiredAuthorityIdentifier(capture.originalOperatorId, "original operator ID"),
    originalOperatorRole: capture.originalOperatorRole,
    capturePurpose: capture.capturePurpose,
    cancelEligible: capture.cancelEligible === true,
    authorisationIssuedAt: issued.text,
    authorisationExpiresAt: expires.text,
    sessionExpiresAt: capture.expiresAt || null,
  };
}

const RENEWAL_PINNED_FIELDS = Object.freeze([
  "sessionId",
  "captureAuthorisationId",
  "semanticOperationId",
  "cardJobId",
  "certId",
  "side",
  "revision",
  "profileRevisionId",
  "tenantId",
  "locationId",
  "stationCredentialId",
  "workstationId",
  "originalOperatorId",
  "originalOperatorRole",
    "capturePurpose",
    "cancelEligible",
  "authorisationIssuedAt",
  "authorisationExpiresAt",
]);

function renewedCaptureAuthority(entry, body) {
  if (body?.capture?.state !== "claimed") throw new Error("Capture renewal did not confirm a current claimed target");
  const renewed = captureEntryFromAuthorisation(body.capture);
  if (RENEWAL_PINNED_FIELDS.some((field) => renewed[field] !== entry[field])) {
    throw new Error("Capture renewal changed the immutable card-side/operator tuple");
  }
  const serverNow = parseServerTimestamp(body.serverNow, "renewal server timestamp");
  const leaseExpires = parseServerTimestamp(body.capture.expiresAt, "renewal lease expiry");
  const issued = parseServerTimestamp(renewed.authorisationIssuedAt, "server issued-at timestamp");
  const authorityExpires = parseServerTimestamp(renewed.authorisationExpiresAt, "server expiry timestamp");
  if (serverNow.millis < issued.millis || serverNow.millis >= authorityExpires.millis
      || leaseExpires.millis <= serverNow.millis || leaseExpires.millis > authorityExpires.millis) {
    throw new Error("Capture renewal returned an invalid server-timed authority window");
  }
  return Object.freeze({ ...renewed, sessionExpiresAt: leaseExpires.text });
}

// AUTO-mode mint throttle: refuse to mint a new cert if one was created less
// than this long ago. Guards against a runaway AUTO batch minting a flood of
// phantom certs. The pair stays in the inbox and is re-driven once the window
// clears.
const AUTO_THROTTLE_MS = 20_000;

function fsyncParent(directory) {
  const handle = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

class Watcher extends EventEmitter {
  constructor({ captureQueueKeyProtector = null } = {}) {
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
    this.profileAcceptanceInFlight = false;
    this.preparedPositioningCalibration = null;
    this.recoveryPlaintextWork = 0;
    this.updateInstallPending = false;
    this.identityRetirementPending = false;
    this.initialDrainTimer = null;
    this.initialDrainPromise = null;
    this.lastScannerHealthAt = 0;
    this.scannerHealthPromise = null;
    this.captureQueue = new EncryptedCaptureQueue({ baseDir: BASE, keyProtector: captureQueueKeyProtector });
  }

  prepareCaptureDirectories() {
    for (const directory of [BASE, INBOX, PROCESSED, FAILED, REJECTED, DISCARDED, CAPTURE_STAGING, POSITIONING_PREVIEW]) {
      ensurePrivateDirectory(directory);
    }
  }

  async start() {
    if (this.updateInstallPending || this.identityRetirementPending) {
      throw new Error("Scanner service cannot restart during an exclusive lifecycle transition");
    }
    if (this.recoveryPlaintextWork !== 0 || this.initialDrainPromise) {
      throw new Error("Scanner recovery is already in progress");
    }
    this.ready = false;
    this.initialFiles = [];
    this.prepareCaptureDirectories();

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

    // WP5 recovery runs before any polling or new physical work. A corrupt
    // index or an unencryptable orphan is a fail-closed startup error, never an
    // empty queue. Verified upload scratch duplicates are unlinked; all other
    // abandoned capture bytes are encrypted into QUARANTINED records.
    await this.withRecoveryPlaintextWork(async () => {
      const recoveredCiphertexts = this.captureQueue.recoverOrphanCiphertexts();
      if (recoveredCiphertexts) this.log(`startup: recovered ${recoveredCiphertexts} unindexed encrypted capture artifact(s) into quarantine`, "warn");
      const resolvedAccepted = this.finalizeAcceptedCaptures();
      if (resolvedAccepted) this.log(`startup: completed ${resolvedAccepted} accepted encrypted capture resolution(s)`, "info");
      this.captureQueue.assertReferencedArtifactsPresent();
      await this.migrateLegacyTargetedQueue();

      // Crash recovery: re-drive any uploads that were in flight when the app
      // last died, BEFORE we start watching. Awaited sequentially so each
      // interrupted upload finishes (success → moved to processed, or fail →
      // moved to failed) and is out of the inbox before chokidar's initial
      // scan runs — that prevents the initial scan from double-processing the
      // same files.
      await this.requeuePending();
      // The legacy queue migration may have surfaced paths in inbox/rejected.
      // Sweep last so no legacy recovery step can recreate retained plaintext.
      await this.sweepAbandonedCapturePlaintext();
      // A direct TIFF is tied to a specific server session and is never mixed
      // with legacy inbox recovery.  Reconcile it before accepting another
      // physical capture, so a crash cannot force a side-level rescan.
      await this.resumeTargetedCaptures();
      await this.sweepPositioningProofPlaintext();
      // Re-render/analyse a retained local setup Preview after an app update.
      // This is image-only local work: it never creates a target, TIFF, upload,
      // or evidence mutation. It lets a corrected display transform be reviewed
      // against the exact Preview that produced an older state record.
      await this.reanalyseStoredPositioningPreview();
    });

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
      this.initialDrainTimer = setTimeout(() => {
        this.initialDrainTimer = null;
        this.initialDrainPromise = this.withRecoveryPlaintextWork(async () => {
          const queued = this.initialFiles.splice(0);
          this.ready = true;
          if (queued.length) {
            this.log(`startup: draining ${queued.length} pre-existing inbox file(s) after ${STARTUP_DEBOUNCE_MS}ms debounce`);
            for (const p of queued) {
              await this.handleNewFile(p);
            }
          }
        }).catch((error) => {
          this.log(`startup inbox recovery failed: ${error.message || String(error)}`, "error");
        }).finally(() => { this.initialDrainPromise = null; });
      }, STARTUP_DEBOUNCE_MS);
    });

    this.log(`watching ${INBOX}`);
    this.refreshNextCert(); // populate predicted next cert at boot
  }

  // ── Pending-queue persistence (crash recovery) ───────────────────────────

  readPendingQueue() {
    if (!fs.existsSync(PENDING_QUEUE)) return [];
    try {
      const arr = readBoundedJson(PENDING_QUEUE, { maximumBytes: 8 * 1024 * 1024, label: "Legacy pending queue" });
      if (!Array.isArray(arr) || arr.length > 512) throw new Error("Legacy pending queue schema is invalid");
      return arr;
    } catch { throw new QueueCorruptionError("Legacy pending queue is corrupt and requires recovery"); }
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
    const lifecycleDenied = this.updateInstallDenial();
    if (lifecycleDenied) return lifecycleDenied;
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
        for (const candidate of candidates) {
          if (!fs.existsSync(candidate)) continue;
          await this.quarantinePlaintext(
            candidate,
            "Legacy pending hot-folder upload quarantined at Canon LiDE target-session cutover.",
          );
        }
        // The encrypted artifacts remain for forensic recovery, but the old
        // unbound queue can never be re-driven as authoritative evidence.
        this.removePending(entry.key);
      } catch (err) {
        this.log(`reconcile failed for ${entry.key}: ${err.message}`, "error");
      }
    }
  }

  // ── Targeted capture: arm → explicit scan → local preview → accept ─────

  readTargetedQueue() {
    return this.captureQueue.entries().filter((entry) =>
      !["QUARANTINED", "ACCEPTED", "RESOLVED"].includes(String(entry.lifecycleState || ""))
    );
  }

  /** Count retained TIFFs that still need a server upload acknowledgement. */
  targetedPendingUploadCount() {
    return this.captureQueue.entries().filter((entry) =>
      entry.lifecycleState !== "RESOLVED" && Boolean(entry.artifact || entry.previewArtifact)
    ).length;
  }

  writeTargetedQueue(entries) {
    this.captureQueue.writeEntries(entries);
  }

  addTargetedPending(entry) {
    const existing = entry.queueEntryId
      ? null
      : this.readTargetedQueue().find((item) => item.sessionId === entry.sessionId);
    const phase = String(entry.phase || existing?.phase || "awaiting_scan");
    const lifecycleState = entry.lifecycleState || existing?.lifecycleState || (
      phase === "upload_retry" ? "RETRYING" : phase === "needs_reconciliation" ? "NEEDS_RECONCILIATION" : "PENDING_UPLOAD"
    );
    return this.captureQueue.upsert({
      ...existing,
      ...entry,
      queueEntryId: entry.queueEntryId || existing?.queueEntryId || crypto.randomUUID(),
      semanticOperationId: entry.semanticOperationId || existing?.semanticOperationId || crypto.randomUUID(),
      lifecycleState,
    });
  }

  removeTargetedPending(sessionId) {
    for (const entry of this.readTargetedQueue().filter((item) => item.sessionId === sessionId)) {
      this.captureQueue.remove(entry.queueEntryId);
    }
  }

  async migrateLegacyTargetedQueue() {
    if (!fs.existsSync(LEGACY_TARGETED_QUEUE)) return;
    let entries;
    try { entries = readBoundedJson(LEGACY_TARGETED_QUEUE, { maximumBytes: 8 * 1024 * 1024, label: "Legacy targeted capture queue" }); }
    catch { throw new QueueCorruptionError("Legacy targeted capture queue is corrupt and requires recovery"); }
    if (!Array.isArray(entries) || entries.length > 512) throw new QueueCorruptionError("Legacy targeted capture queue schema is invalid");
    for (const entry of entries) {
      for (const candidate of [entry?.filePath, entry?.previewPath].filter(Boolean)) {
        if (fs.existsSync(candidate)) {
          await this.quarantinePlaintext(candidate, "Pre-WP5 targeted queue evidence lacks the complete authenticated authorisation tuple");
        }
      }
    }
    fs.unlinkSync(LEGACY_TARGETED_QUEUE);
    fsyncParent(BASE);
  }

  capturePlaintextPaths() {
    const paths = [];
    const walk = (directory) => {
      if (!fs.existsSync(directory)) return;
      for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, dirent.name);
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) walk(candidate);
        else if (dirent.isFile() && /\.(?:tiff?|jpe?g)$/i.test(dirent.name)) paths.push(candidate);
      }
    };
    for (const directory of [INBOX, REJECTED, CAPTURE_STAGING, this.captureQueue.scratchDir, PROCESSED, FAILED, DISCARDED]) walk(directory);
    return paths;
  }

  async quarantinePlaintext(plaintextPath, reason) {
    if (!fs.existsSync(plaintextPath)) return null;
    const ext = path.extname(plaintextPath).toLowerCase();
    const isPreview = ext === ".jpg" || ext === ".jpeg";
    const quarantined = this.addTargetedPending({
      queueEntryId: crypto.randomUUID(),
      semanticOperationId: crypto.randomUUID(),
      phase: "quarantined",
      lifecycleState: "QUARANTINED",
      disposition: null,
      localOutcome: "UNBOUND_PLAINTEXT_QUARANTINED",
      quarantineReason: reason,
      originalRelativePath: path.relative(BASE, plaintextPath),
    });
    return this.captureQueue.attachFile(quarantined, plaintextPath, {
      kind: isPreview ? "PREVIEW_JPEG" : "TIFF_MASTER",
      mimeType: isPreview ? "image/jpeg" : "image/tiff",
      quarantine: true,
    });
  }

  async sweepAbandonedCapturePlaintext() {
    // First attach paths named by a durable target record. The index update is
    // committed and fsynced before attachFile unlinks the plaintext.
    for (const original of this.readTargetedQueue()) {
      let entry = original;
      if (entry.filePath && fs.existsSync(entry.filePath) && !entry.artifact) {
        entry = await this.captureQueue.attachFile(entry, entry.filePath, { kind: "TIFF_MASTER", mimeType: "image/tiff" });
        entry = this.addTargetedPending({ ...entry, filePath: null });
      }
      if (entry.previewPath && fs.existsSync(entry.previewPath) && !entry.previewArtifact) {
        entry = await this.captureQueue.attachFile(entry, entry.previewPath, { kind: "PREVIEW_JPEG", mimeType: "image/jpeg" });
        this.addTargetedPending({ ...entry, previewPath: null });
      }
    }

    const knownDigests = new Set();
    for (const entry of this.captureQueue.entries()) {
      if (entry.artifact?.sha256) knownDigests.add(entry.artifact.sha256);
      if (entry.previewArtifact?.sha256) knownDigests.add(entry.previewArtifact.sha256);
    }
    for (const plaintextPath of this.capturePlaintextPaths()) {
      const digest = await this.sha256File(plaintextPath);
      const insideScratch = path.resolve(plaintextPath).startsWith(path.resolve(this.captureQueue.scratchDir) + path.sep);
      if (insideScratch && digest && knownDigests.has(digest)) {
        fs.unlinkSync(plaintextPath);
        continue;
      }
      await this.quarantinePlaintext(plaintextPath, "Abandoned or unmatched plaintext recovered during startup sweep");
    }
  }

  async sweepPositioningProofPlaintext() {
    if (!fs.existsSync(POSITIONING_PREVIEW)) return 0;
    let removed = 0;
    const walk = (directory) => {
      for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, dirent.name);
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) walk(candidate);
        else if (dirent.isFile() && /\.tiff?$/i.test(dirent.name)) {
          fs.unlinkSync(candidate);
          removed++;
        }
      }
    };
    walk(POSITIONING_PREVIEW);
    if (removed) this.log(`startup: removed ${removed} abandoned setup-only calibration proof TIFF(s)`, "warn");
    return removed;
  }

  captureStorageStatus() {
    return this.captureQueue.storageStatus();
  }

  identityRetirementFiles() {
    if (this.updateInstallPending || this.uploading || this.targetCaptureInFlight || this.previewActionInFlight
        || this.positioningPreviewInFlight || this.profileAcceptanceInFlight || this.scannerHealthPromise
        || this.recoveryPlaintextWork !== 0 || this.initialDrainTimer || this.initialDrainPromise) {
      throw new Error("Scanner work must quiesce before station identity retirement");
    }
    if (this.readPendingQueue().length) throw new Error("Legacy capture recovery must finish before station identity retirement");
    const entries = this.captureQueue.entries();
    if (entries.some((entry) => entry.artifact || entry.previewArtifact)) {
      throw new Error("Encrypted evidence custody must resolve before station identity retirement");
    }
    for (const directory of [this.captureQueue.artifactsDir, this.captureQueue.quarantineDir, this.captureQueue.scratchDir, CAPTURE_STAGING]) {
      if (directoryContainsFiles(directory)) throw new Error("Capture files must resolve before station identity retirement");
    }
    for (const directory of [INBOX, PROCESSED, FAILED, REJECTED, DISCARDED]) {
      if (regularFilesForRetirement(directory).length) {
        throw new Error("Plaintext capture custody must resolve before station identity retirement");
      }
    }
    return [
      this.captureQueue.indexPath,
      this.captureQueue.keyPath,
      LEGACY_TARGETED_QUEUE,
      PENDING_QUEUE,
      HASH_LOG,
      ...regularFilesForRetirement(POSITIONING_PREVIEW),
    ].filter((candidate) => fs.existsSync(candidate));
  }

  identityRetirementRawFiles() {
    return [
      this.captureQueue.indexPath,
      this.captureQueue.keyPath,
      LEGACY_TARGETED_QUEUE,
      PENDING_QUEUE,
      HASH_LOG,
      ...regularFilesForRetirement(this.captureQueue.artifactsDir),
      ...regularFilesForRetirement(this.captureQueue.quarantineDir),
      ...regularFilesForRetirement(this.captureQueue.scratchDir),
      ...regularFilesForRetirement(CAPTURE_STAGING),
      ...regularFilesForRetirement(POSITIONING_PREVIEW),
      ...regularFilesForRetirement(INBOX),
      ...regularFilesForRetirement(PROCESSED),
      ...regularFilesForRetirement(FAILED),
      ...regularFilesForRetirement(REJECTED),
      ...regularFilesForRetirement(DISCARDED),
    ].filter((candidate) => fs.existsSync(candidate));
  }

  completeIdentityRetirement() {
    if (this.captureQueue.cachedKey?.raw) this.captureQueue.cachedKey.raw.fill(0);
    this.captureQueue.cachedKey = null;
    this.bufferedFront = null;
    this.lastPair = null;
    this.oneShotManual = null;
    this.pendingManualPath = null;
    this.predictedNextCertCache = { value: null, ts: 0 };
    this.lastCertMintAt = 0;
    this.preparedPositioningCalibration = null;
    stateMod.resetForIdentityRetirement();
    this.emitState();
  }

  beginRecoveryPlaintextWork() {
    this.recoveryPlaintextWork += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.recoveryPlaintextWork = Math.max(0, this.recoveryPlaintextWork - 1);
    };
  }

  async withRecoveryPlaintextWork(operation) {
    const release = this.beginRecoveryPlaintextWork();
    try { return await operation(); }
    finally { release(); }
  }

  setUpdateInstallPending(value) {
    this.updateInstallPending = value === true;
  }

  setIdentityRetirementPending(value) {
    this.identityRetirementPending = value === true;
  }

  updateInstallDenial() {
    return this.updateInstallPending
      ? { ok: false, code: "update_install_pending", error: "MintVault Scanner is quiesced while the signed update is installed." }
      : this.identityRetirementPending
        ? { ok: false, code: "identity_retirement_pending", error: "MintVault Scanner is securely retiring the prior station identity." }
      : null;
  }

  isRestartSafeForUpdate() {
    return !this.uploading
      && !this.targetCaptureInFlight
      && !this.previewActionInFlight
      && !this.positioningPreviewInFlight
      && !this.profileAcceptanceInFlight
      && !this.scannerHealthPromise
      && this.recoveryPlaintextWork === 0
      && !this.initialDrainTimer
      && !this.initialDrainPromise
      && !this.updateInstallPending
      && !this.identityRetirementPending;
  }

  activeTargetEntry() {
    const sessionId = stateMod.get().activeCapture?.id;
    return sessionId ? this.readTargetedQueue().find((entry) => entry.sessionId === sessionId) || null : null;
  }

  cancellableCardJob() {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight || this.uploading) {
      return { ok: false, error: "Card cancellation is unavailable while physical or evidence work is in progress" };
    }
    const entry = this.activeTargetEntry();
    const allowedPhase = ["awaiting_scan", "preview_ready", "preview_error"].includes(String(entry?.phase || ""));
    const accepted = stateMod.get().lastAcceptedCapture;
    if (!entry || entry.cancelEligible !== true || entry.side !== "front" || !allowedPhase
        || (accepted?.certId && accepted.certId === entry.certId)) {
      return { ok: false, error: "This Card Job can no longer be cancelled because evidence may already be accepted" };
    }
    return {
      ok: true,
      entry,
      target: {
        cardJobId: entry.cardJobId,
        captureSessionId: entry.sessionId,
        captureAuthorisationId: entry.captureAuthorisationId,
      },
    };
  }

  beginCardCancellation() {
    const current = this.cancellableCardJob();
    if (!current.ok) return current;
    this.previewActionInFlight = true;
    return current;
  }

  beginCardCancellationForTarget(target) {
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight || this.uploading) {
      return { ok: false, error: "Card cancellation recovery is waiting for current physical work to stop" };
    }
    const entry = this.readTargetedQueue().find((candidate) =>
      candidate.cardJobId === target.cardJobId
      && candidate.sessionId === target.captureSessionId
      && candidate.captureAuthorisationId === target.captureAuthorisationId
    ) || null;
    this.previewActionInFlight = true;
    if (entry) this.setTargetState(entry, "cancel_pending", "cancel_pending", "MintVault is reconciling this Card Job cancellation.");
    return { ok: true, entry, target, recovering: true };
  }

  pendingCardCancellation() {
    const entry = this.readTargetedQueue().find((candidate) => candidate.cancelOperationId && candidate.cancelState === "PENDING");
    if (!entry) return null;
    return {
      operationId: entry.cancelOperationId,
      target: {
        cardJobId: entry.cardJobId,
        captureSessionId: entry.sessionId,
        captureAuthorisationId: entry.captureAuthorisationId,
      },
    };
  }

  markCardCancellationPending(target, operationId) {
    const entry = this.readTargetedQueue().find((candidate) =>
      candidate.cardJobId === target.cardJobId
      && candidate.sessionId === target.captureSessionId
      && candidate.captureAuthorisationId === target.captureAuthorisationId
    );
    if (!entry) return { ok: true, localTargetAbsent: true };
    if (entry.cancelOperationId && entry.cancelOperationId !== operationId) {
      throw new Error("Card Job target is already bound to a different cancellation operation");
    }
    const pending = this.addTargetedPending({ ...entry, cancelOperationId: operationId, cancelState: "PENDING" });
    this.setTargetState(pending, "cancel_pending", "cancel_pending", "MintVault is reconciling this Card Job cancellation.");
    return { ok: true, entry: pending };
  }

  finishCardCancellation() {
    this.previewActionInFlight = false;
  }

  applyCardJobCancellation(target) {
    const prior = this.captureQueue.entries().find((entry) =>
      entry.cardJobId === target.cardJobId
      && entry.sessionId === target.captureSessionId
      && entry.disposition === "CANCELLED"
    );
    if (prior) return { ok: true, alreadyApplied: true };
    const entry = this.activeTargetEntry();
    if (!entry) return { ok: true, localTargetAbsent: true };
    if (entry.cardJobId !== target.cardJobId || entry.sessionId !== target.captureSessionId
        || entry.captureAuthorisationId !== target.captureAuthorisationId) return { ok: false, error: "The cancelled Card Job no longer matches the local active target" };
    this.archivePreviewCandidate(entry, "MintVault cancelled this Card Job before its first accepted side and released its reservation.", {
      disposition: "CANCELLED",
      localOutcome: null,
    });
    stateMod.set({ state: "idle", activeCapture: null, lastError: null });
    this.emitState();
    this.logCaptureStage(entry, "card_job_cancelled_before_evidence");
    return { ok: true };
  }

  applyCardJobCancellationRefusal(target) {
    const entry = this.readTargetedQueue().find((candidate) =>
      candidate.cardJobId === target.cardJobId
      && candidate.sessionId === target.captureSessionId
      && candidate.captureAuthorisationId === target.captureAuthorisationId
    );
    if (entry) {
      const refused = this.addTargetedPending({
        ...entry,
        cancelEligible: false,
        cancelOperationId: null,
        cancelState: "REFUSED_ACCEPTED_EVIDENCE",
      });
      this.setTargetState(refused, refused.phase, refused.phase, "This Card Job already has accepted evidence and cannot be cancelled.");
    }
    return { ok: false, retryable: false, code: "CARD_JOB_HAS_ACCEPTED_EVIDENCE", error: "This Card Job already has accepted evidence and cannot be cancelled." };
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
        cancelEligible: entry.cancelEligible === true,
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
    let sessionId;
    try { sessionId = entry.artifact ? this.authenticatedMasterMetadata(entry).captureSessionId : entry.sessionId; }
    catch (error) { return { legacyAccepted: false, state: null, unavailable: false, integrityError: error.message }; }
    try {
      status = await server.getCaptureStatus(sessionId, lide400.deviceId());
    } catch (error) {
      this.log(`targeted status check failed for ${sessionId}: ${error.message}`, "warn");
      return { legacyAccepted: false, state: null, unavailable: true };
    }
    if (!status.ok) {
      this.log(`targeted status check rejected for ${sessionId}: ${status.body?.error || `HTTP ${status.status}`}`, "warn");
      return { legacyAccepted: false, state: null, unavailable: true };
    }
    return {
      legacyAccepted: status.body?.accepted === true,
      state: status.body?.capture?.state || null,
      disposition: typeof status.body?.disposition === "string"
        ? status.body.disposition.toUpperCase()
        : null,
      dispositionBinding: status.body?.disposition_binding || null,
      capture: status.body?.capture
        ? { ...status.body.capture, cardRegistered: status.body?.card_registered === true }
        : null,
    };
  }

  applyServerDisposition(entry, result) {
    const disposition = result?.disposition;
    if (!disposition) return null;
    if (!QUEUE_DISPOSITIONS.has(disposition)) {
      const reason = "Server returned an unknown evidence disposition; encrypted evidence remains unresolved";
      this.addTargetedPending({ ...entry, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", disposition: null, serverDispositionObserved: disposition, reconciliationReason: reason });
      return { ok: false, retryPending: true, error: reason };
    }
    let expected;
    try { expected = this.dispositionBinding(entry); }
    catch (error) { return { ok: false, retryPending: true, error: error.message }; }
    if (canonicalJson(result.dispositionBinding) !== canonicalJson(expected)) {
      const reason = "Server evidence disposition did not match the complete authenticated capture tuple";
      this.addTargetedPending({ ...entry, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", disposition: null, serverDispositionObserved: disposition, reconciliationReason: reason });
      return { ok: false, retryPending: true, error: reason };
    }
    if (disposition === "STILL_REQUIRED") {
      this.addTargetedPending({ ...entry, disposition, serverDispositionAt: new Date().toISOString() });
      return null;
    }
    if (disposition === "ACCEPTED") {
      return this.completeTargetedCapture(entry, result.capture, { authoritativeDispositionVerified: true });
    }
    if (["SUPERSEDED", "CANCELLED", "INVALID_TARGET", "REQUIRES_FIX"].includes(disposition)) {
      const reason = `Server disposition ${disposition} ended this queued candidate; encrypted evidence is retained for audit`;
      this.archivePreviewCandidate(entry, reason, { disposition, localOutcome: null });
      stateMod.set({ state: "error", activeCapture: null, lastError: reason });
      this.emitState();
      return { ok: false, disposition, error: reason };
    }
    return null;
  }

  async keepTargetAlive(entry, { force = false } = {}) {
    if (!force && Number(entry.lastKeepaliveAt || 0) + TARGET_KEEPALIVE_MS > Date.now()) return { ok: true, entry };
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
    let current;
    try { current = renewedCaptureAuthority(entry, renewed.body); }
    catch (error) { return { ok: false, error: error.message }; }
    const next = {
      ...entry,
      lastKeepaliveAt: Date.now(),
      sessionExpiresAt: current.sessionExpiresAt,
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

  async validateCaptureMaster(masterPath, provenance, expectedProfileRevisionId, descriptor = null) {
    const stat = Number.isInteger(descriptor) ? fs.fstatSync(descriptor) : fs.lstatSync(masterPath);
    if (!stat.isFile() || (!Number.isInteger(descriptor) && stat.isSymbolicLink()) || stat.nlink !== 1
        || stat.size < 64 * 1024 || stat.size > 512 * 1024 * 1024) {
      throw new Error("LiDE TIFF size or file type is outside the locked capture profile");
    }
    const area = provenance?.scanAreaMm;
    const values = [area?.width, area?.height].map(Number);
    if (provenance?.profileVersion !== lide400.PROFILE_VERSION || Number(provenance?.requestedDpi) !== 1200 ||
        Number(provenance?.driverResolutionDpi) !== 1200 || !values.every(Number.isFinite) ||
        Math.abs(values[0] - 100) > 0.25 || Math.abs(values[1] - 130) > 0.25) {
      throw new Error("LiDE capture provenance does not match the locked 1200 DPI profile");
    }
    if (lide400.requiresLockedProfile() && (
      provenance?.profileRevisionId !== expectedProfileRevisionId
      || !/^[a-f0-9]{64}$/.test(String(provenance?.profileDigestSha256 || ""))
    )) {
      throw new Error("LiDE capture did not use the exact server-authorised locked profile revision");
    }
    if (provenance?.helperAttestedByteLength != null && (
      provenance.helperAttestedByteLength !== stat.size
      || !/^[a-f0-9]{64}$/.test(String(provenance.helperAttestedSha256 || ""))
    )) {
      throw new Error("LiDE capture no longer matches the trusted helper byte attestation");
    }
    const metadata = await require("sharp")(masterPath, { limitInputPixels: false }).metadata();
    const expectedWidth = Math.round((values[0] / 25.4) * 1200);
    const expectedHeight = Math.round((values[1] / 25.4) * 1200);
    const within = (actual, expected) => Number.isInteger(actual) && Math.abs(actual - expected) <= Math.ceil(expected * 0.02);
    if (metadata.format !== "tiff" || metadata.channels !== 3 || metadata.depth !== "uchar" ||
        !within(metadata.width, expectedWidth) || !within(metadata.height, expectedHeight)) {
      throw new Error("LiDE TIFF format, colour depth, or raster dimensions do not match the locked profile");
    }
    return {
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      channels: metadata.channels,
      depth: metadata.depth,
      requestedDpi: 1200,
      driverResolutionDpi: 1200,
      byteLength: stat.size,
    };
  }

  authenticatedMasterMetadata(entry) {
    if (!entry?.artifact) throw new QueueCorruptionError("Encrypted TIFF metadata is unavailable");
    this.captureQueue.assertEntryBinding(entry, entry.artifact);
    const metadata = entry.artifact.authenticatedMetadata;
    if (metadata.kind !== "TIFF_MASTER" || metadata.mimeType !== "image/tiff") {
      throw new QueueCorruptionError("Queued capture is not an authenticated TIFF master");
    }
    const authority = captureEntryFromAuthorisation({
      id: metadata.captureSessionId,
      captureAuthorisationId: metadata.captureAuthorisationId,
      semanticOperationId: metadata.semanticOperationId,
      cardJobId: metadata.cardJobId,
      certificateNumber: metadata.certificateNumber,
      side: metadata.side,
      revision: metadata.revision,
      profileRevisionId: metadata.profileRevisionId,
      tenantId: metadata.tenantId,
      locationId: metadata.locationId,
      stationId: metadata.stationId,
      workstationId: metadata.workstationId,
      originalOperatorId: metadata.originalOperatorId,
      originalOperatorRole: metadata.originalOperatorRole,
      capturePurpose: metadata.capturePurpose,
      authorisationIssuedAt: metadata.authorisationIssuedAt,
      authorisationExpiresAt: metadata.authorisationExpiresAt,
    });
    if (authority.workstationId !== lide400.stationId()) throw new QueueCorruptionError("Queued capture belongs to another workstation");
    if (metadata.appVersion !== scannerPackage.version || metadata.captureHelperVersion !== helperIntegrity.HELPER_VERSION ||
        metadata.identityHelperVersion !== helperIntegrity.IDENTITY_HELPER_VERSION ||
        metadata.captureProvenance?.helperVersion !== helperIntegrity.HELPER_VERSION) {
      throw new QueueCorruptionError("Queued capture app/helper provenance does not match the trusted runtime");
    }
    if (!metadata.masterValidation || !metadata.frameAssessment || !metadata.captureProvenance) {
      throw new QueueCorruptionError("Queued capture validation provenance is incomplete");
    }
    return metadata;
  }

  async verifyEncryptedCandidate(entry) {
    const metadata = this.authenticatedMasterMetadata(entry);
    const scratch = this.captureQueue.scratchPath(entry, ".verify.tif");
    try {
      await this.captureQueue.decryptToFile(entry.artifact, scratch);
      const masterValidation = await this.validateCaptureMaster(scratch, metadata.captureProvenance, metadata.profileRevisionId);
      const frameAssessment = await this.assessCaptureFrame(scratch, metadata.captureProvenance);
      if (canonicalJson(masterValidation) !== canonicalJson(metadata.masterValidation) ||
          canonicalJson(frameAssessment) !== canonicalJson(metadata.frameAssessment)) {
        throw new QueueCorruptionError("Queued TIFF validation or frame assessment no longer reproduces");
      }
      if (frameAssessment.accepted !== true) throw new QueueCorruptionError("Queued TIFF does not pass the authenticated frame gate");
      return metadata;
    } finally {
      try { fs.unlinkSync(scratch); } catch (error) { if (error?.code !== "ENOENT") this.log("verification scratch cleanup will be retried at startup", "warn"); }
    }
  }

  dispositionBinding(entry) {
    const metadata = this.authenticatedMasterMetadata(entry);
    return Object.freeze({
      capture_session_id: metadata.captureSessionId,
      capture_authorisation_id: metadata.captureAuthorisationId,
      semantic_operation_id: metadata.semanticOperationId,
      card_job_id: metadata.cardJobId,
      certificate_number: metadata.certificateNumber,
      side: metadata.side,
      revision: metadata.revision,
      profile_revision_id: metadata.profileRevisionId,
      tenant_id: metadata.tenantId,
      location_id: metadata.locationId,
      station_id: metadata.stationId,
      workstation_id: metadata.workstationId,
      original_operator_id: metadata.originalOperatorId,
      original_operator_role: metadata.originalOperatorRole,
      purpose: metadata.capturePurpose,
      authorisation_issued_at: metadata.authorisationIssuedAt,
      authorisation_expires_at: metadata.authorisationExpiresAt,
      device_captured_at: metadata.deviceCapturedAt,
      device_timestamp_authority: metadata.deviceTimestampAuthority,
      sha256: metadata.sha256,
      byte_length: metadata.byteLength,
      mime_type: metadata.mimeType,
      app_version: metadata.appVersion,
      capture_helper_version: metadata.captureHelperVersion,
      identity_helper_version: metadata.identityHelperVersion,
    });
  }

  resultFromDispositionBody(body, capture = null) {
    return {
      disposition: typeof body?.disposition === "string" ? body.disposition.toUpperCase() : null,
      dispositionBinding: body?.disposition_binding || null,
      capture: capture || body?.capture || null,
    };
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
      const bytes = readBoundedRegularFile(previewPath, {
        minimumBytes: 4,
        maximumBytes: PREVIEW_MAX_BYTES,
        label: "Positioning preview",
      });
      return { ok: true, previewId, dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` };
    } catch (error) {
      return { ok: false, error: error.message || "Positioning preview file is unavailable" };
    }
  }

  async runPositioningPreview() {
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return updateDenied;
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight || this.profileAcceptanceInFlight) {
      return { ok: false, error: "Preview is unavailable while Scan, Accept, Rescan, or another Preview is in progress" };
    }
    const active = this.activeTargetEntry();
    if (active && active.phase !== "awaiting_scan") {
      return { ok: false, error: "Positioning Preview is unavailable while a card TIFF is awaiting Accept or Rescan" };
    }
    const health = stateMod.get().scannerHealth?.status;
    if (!["ready", "profile_unprovisioned", "profile_invalid"].includes(health)) {
      return { ok: false, error: "Canon LiDE 400 is not ready for a positioning Preview" };
    }
    this.positioningPreviewInFlight = true;
    if (this.scannerHealthPromise) await this.scannerHealthPromise;
    const updateDeniedAfterHealth = this.updateInstallDenial();
    if (updateDeniedAfterHealth) {
      this.positioningPreviewInFlight = false;
      return updateDeniedAfterHealth;
    }
    this.preparedPositioningCalibration = null;
    const id = crypto.randomUUID();
    const directory = path.join(POSITIONING_PREVIEW, id);
    const startedAt = Date.now();
    ensurePrivateDirectory(directory);
    stateMod.set({
      state: "positioning_preview_scanning",
      positioningPreview: { id, status: "scanning", startedAt: new Date().toISOString() },
      lastError: null,
    });
    this.emitState();
    this.log(`positioning-preview ${JSON.stringify({ id, stage: "started", at: new Date().toISOString() })}`);
    let capture = null;
    try {
      capture = await lide400.positioningPreview(directory);
      if (capture.requestedDpi !== lide400._private.POSITIONING_PREVIEW_DPI || capture.driverResolutionDpi !== lide400._private.POSITIONING_PREVIEW_DPI) {
        throw new Error("Positioning Preview did not use the locked local setup resolution");
      }
      const areaMm = capture.appliedRegionMm;
      if (!areaMm || !["x", "y", "width", "height"].every((key) => Number.isFinite(Number(areaMm[key])))) {
        throw new Error("Positioning Preview did not report its physical hardware area");
      }
      const previewPath = path.join(directory, `${id}.display.jpg`);
      const sourceReadPath = Number.isInteger(capture.artifactDescriptor) ? `/dev/fd/${capture.artifactDescriptor}` : capture.path;
      const display = await this.createPositioningPreviewDisplay(sourceReadPath, previewPath);
      const analysis = await this.analysePositioningPreview(sourceReadPath, areaMm);
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
      disposeHelperCapture(capture);
      this.positioningPreviewInFlight = false;
    }
  }

  applyPositioningPreview(previewId) {
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return updateDenied;
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight || this.profileAcceptanceInFlight) {
      return { ok: false, error: "Placement cannot be saved while scanner work is in progress" };
    }
    const entry = stateMod.get().positioningPreview;
    if (!entry || entry.id !== previewId || entry.status !== "detected" || !entry.placement?.ready) {
      return { ok: false, error: "This positioning preview is stale or not safe enough to establish a placement zone" };
    }
    try {
      if (lide400.requiresLockedProfile()) {
        throw new Error("Packaged Scanner placement must pass MintVault's 1200-DPI profile acceptance flow");
      }
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

  positioningCalibrationCandidate(previewId) {
    const entry = stateMod.get().positioningPreview;
    if (!entry || entry.id !== previewId || entry.status !== "detected" || !entry.placement?.ready) {
      return { ok: false, error: "This positioning preview is stale or not safe enough to create a locked profile" };
    }
    const tolerance = Number(entry.placement.placementToleranceMm);
    const scanner = entry.capture?.scanner || {};
    const card = entry.cardCandidate?.cardBoundsMm;
    const origin = entry.placement.originMm;
    const area = entry.placement.areaMm;
    if (!Number.isFinite(tolerance) || !card || !origin || !area) {
      return { ok: false, error: "Positioning preview calibration geometry is incomplete" };
    }
    return {
      ok: true,
      candidate: {
        scannerHardware: {
          manufacturer: "Canon",
          model: String(scanner.model || "CanoScan LiDE 400"),
          deviceId: String(scanner.deviceId || ""),
          serial: scanner.serial == null ? null : String(scanner.serial),
        },
        scannerProfileVersion: lide400.PROFILE_VERSION,
        acquisitionRegion: {
          x: Number(origin.x), y: Number(origin.y), width: Number(area.width), height: Number(area.height),
        },
        workingRegion: {
          x: Number(card.x), y: Number(card.y), width: Number(card.width), height: Number(card.height),
        },
        placementToleranceMm: { left: tolerance, right: tolerance, top: tolerance, bottom: tolerance },
        calibrationVersion: lide400._private.CALIBRATION_VERSION,
        requestedDpi: 1200,
        colourMode: "RGB",
        bitDepth: 8,
        outputFormat: "TIFF",
        presentationRotationDegrees: 180,
      },
    };
  }

  async validateCalibrationProof(proofPath, capture, candidate) {
    const root = path.resolve(path.dirname(proofPath)) + path.sep;
    const resolved = path.resolve(proofPath);
    if (!resolved.startsWith(root) || ![".tif", ".tiff"].includes(path.extname(resolved).toLowerCase())) {
      throw new Error("Calibration proof path is unsafe");
    }
    const descriptor = capture?.artifactDescriptor;
    const stat = Number.isInteger(descriptor) ? fs.fstatSync(descriptor) : fs.lstatSync(resolved);
    if ((!Number.isInteger(descriptor) && stat.isSymbolicLink()) || !stat.isFile() || stat.nlink !== 1
        || stat.size < CALIBRATION_PROOF_MIN_BYTES || stat.size > CALIBRATION_PROOF_MAX_BYTES) {
      throw new Error("Calibration proof TIFF is missing, unsafe, or outside the accepted size range");
    }
    if (capture.requestedDpi !== 1200 || capture.driverResolutionDpi !== 1200) {
      throw new Error("Calibration capability proof did not use exact 1200 DPI");
    }
    if (capture.helperVersion !== helperIntegrity.HELPER_VERSION) {
      throw new Error("Calibration capability proof did not use the current sealed capture helper");
    }
    if (capture.helperAttestedByteLength != null && (
      capture.helperAttestedByteLength !== stat.size
      || !/^[a-f0-9]{64}$/.test(String(capture.helperAttestedSha256 || ""))
    )) {
      throw new Error("Calibration capability proof does not match the capture helper byte attestation");
    }
    const expected = candidate.acquisitionRegion;
    const applied = capture.appliedRegionMm;
    if (!applied || !["x", "y", "width", "height"].every((key) =>
      Number.isFinite(Number(applied[key])) && Math.abs(Number(applied[key]) - Number(expected[key])) <= 0.1)) {
      throw new Error("Calibration capability proof did not use the accepted hardware region");
    }
    const expectedHardware = candidate.scannerHardware;
    if (String(capture.scanner?.model || "") !== expectedHardware.model
        || (expectedHardware.deviceId && String(capture.scanner?.deviceId || "") !== expectedHardware.deviceId)
        || (expectedHardware.serial && String(capture.scanner?.serial || "") !== expectedHardware.serial)) {
      throw new Error("Calibration capability proof came from a different scanner");
    }
    const sharp = require("sharp");
    const stablePath = Number.isInteger(descriptor) ? `/dev/fd/${descriptor}` : resolved;
    const metadata = await sharp(stablePath, { limitInputPixels: false }).metadata();
    const expectedWidthPx = Math.round((Number(expected.width) / 25.4) * 1200);
    const expectedHeightPx = Math.round((Number(expected.height) / 25.4) * 1200);
    if (metadata.format !== "tiff" || metadata.space !== "srgb" || metadata.channels !== 3
        || metadata.depth !== "uchar" || Number(metadata.density) !== 1200
        || !Number.isSafeInteger(metadata.width) || Math.abs(metadata.width - expectedWidthPx) > 2
        || !Number.isSafeInteger(metadata.height) || Math.abs(metadata.height - expectedHeightPx) > 2) {
      throw new Error("Calibration capability proof is not an exact 1200-DPI RGB 8-bit TIFF");
    }
    const frameAssessment = await cardFrame.assessLide400CardFrame(stablePath, expected);
    if (frameAssessment.accepted !== true) {
      throw new Error(frameAssessment.reason || "Calibration capability proof did not contain a complete usable card frame");
    }
    const sha256 = Number.isInteger(descriptor)
      ? lide400._private.sha256Descriptor(descriptor, stat.size)
      : await new Promise((resolveHash, rejectHash) => {
        const hash = crypto.createHash("sha256");
        const input = fs.createReadStream(resolved, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
        input.on("data", (chunk) => hash.update(chunk));
        input.on("error", rejectHash);
        input.on("end", () => resolveHash(hash.digest("hex")));
      });
    if (capture.helperAttestedSha256 != null && sha256 !== capture.helperAttestedSha256) {
      throw new Error("Calibration capability proof digest changed after helper attestation");
    }
    return Object.freeze({
      sha256,
      sizeBytes: stat.size,
      format: "TIFF",
      requestedDpi: 1200,
      driverResolutionDpi: 1200,
      colourMode: "RGB",
      bitDepth: 8,
      widthPx: metadata.width,
      heightPx: metadata.height,
      acquisitionRegion: { ...expected },
      captureHelperVersion: capture.helperVersion,
      frameAssessment: {
        accepted: true,
        cardBoundsMm: frameAssessment.cardBoundsMm,
        evidenceMarginMm: frameAssessment.evidenceMarginMm,
      },
    });
  }

  async preparePositioningCalibration(previewId) {
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return updateDenied;
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "Profile verification cannot start while scanner work is in progress" };
    }
    const base = this.positioningCalibrationCandidate(previewId);
    if (!base.ok) return base;
    const current = stateMod.get().positioningPreview;
    if (this.preparedPositioningCalibration?.previewId === previewId) {
      return { ok: true, candidate: this.preparedPositioningCalibration.operation.request, reusedProof: true };
    }
    try {
      const resumed = lide400.resumeLockedProfileAcceptance(base.candidate);
      if (resumed) {
        this.preparedPositioningCalibration = Object.freeze({ previewId, operation: resumed });
        stateMod.set({
          positioningPreview: {
            ...current,
            verificationStatus: "verified_1200",
            verifiedAt: resumed.request.profile.deviceCreatedAt,
            capabilityProof: {
              sha256: resumed.request.profile.capabilityProof.sha256,
              sizeBytes: resumed.request.profile.capabilityProof.sizeBytes,
              requestedDpi: 1200,
              driverResolutionDpi: 1200,
              format: "TIFF",
            },
            calibrationError: null,
          },
          lastError: null,
        });
        this.emitState();
        return { ok: true, candidate: resumed.request, reusedProof: true };
      }
    } catch (error) {
      return { ok: false, code: error.code || "profile_recovery_required", error: error.message || String(error) };
    }
    this.positioningPreviewInFlight = true;
    if (this.scannerHealthPromise) await this.scannerHealthPromise;
    const updateDeniedAfterHealth = this.updateInstallDenial();
    if (updateDeniedAfterHealth) {
      this.positioningPreviewInFlight = false;
      return updateDeniedAfterHealth;
    }
    stateMod.set({ positioningPreview: { ...current, verificationStatus: "scanning_1200", calibrationError: null } });
    this.emitState();
    const directory = path.join(POSITIONING_PREVIEW, previewId, "profile-proof");
    ensurePrivateDirectory(directory);
    let proofPath = null;
    let proofCapture = null;
    try {
      return await this.withRecoveryPlaintextWork(async () => {
        const capture = await lide400.scanCalibrationRegion(directory, base.candidate.acquisitionRegion);
        proofCapture = capture;
        proofPath = capture.path;
        const capabilityProof = await this.validateCalibrationProof(proofPath, capture, base.candidate);
        const candidate = Object.freeze({ ...base.candidate, capabilityProof });
        const entry = stateMod.get().positioningPreview;
        if (!entry || entry.id !== previewId || entry.status !== "detected") {
          throw new Error("Positioning Preview changed before profile verification completed");
        }
        const operation = lide400.beginLockedProfileAcceptance(candidate);
        this.preparedPositioningCalibration = Object.freeze({ previewId, operation });
        stateMod.set({
          positioningPreview: {
            ...entry,
            verificationStatus: "verified_1200",
            verifiedAt: new Date().toISOString(),
            capabilityProof: {
              sha256: capabilityProof.sha256,
              sizeBytes: capabilityProof.sizeBytes,
              requestedDpi: capabilityProof.requestedDpi,
              driverResolutionDpi: capabilityProof.driverResolutionDpi,
              format: capabilityProof.format,
            },
            calibrationError: null,
          },
          lastError: null,
        });
        this.emitState();
        return { ok: true, candidate: operation.request };
      });
    } catch (error) {
      this.preparedPositioningCalibration = null;
      const entry = stateMod.get().positioningPreview;
      if (entry?.id === previewId) {
        stateMod.set({ positioningPreview: { ...entry, verificationStatus: "failed", calibrationError: error.message || String(error) } });
        this.emitState();
      }
      return { ok: false, error: error.message || String(error) };
    } finally {
      if (proofCapture) disposeHelperCapture(proofCapture);
      else if (proofPath && fs.existsSync(proofPath)) fs.unlinkSync(proofPath);
      try { fs.rmdirSync(directory); } catch {}
      this.positioningPreviewInFlight = false;
    }
  }

  commitPositioningCalibration(previewId, calibration) {
    const entry = stateMod.get().positioningPreview;
    const prepared = this.preparedPositioningCalibration;
    const candidate = entry?.id === previewId && entry?.status === "detected"
      && prepared?.previewId === previewId && prepared?.operation?.request?.profile?.capabilityProof
      ? { ok: true, operation: prepared.operation }
      : { ok: false, error: "This positioning Preview has no verified 1200-DPI capability proof" };
    if (!candidate.ok) return candidate;
    try {
      const persisted = lide400.finalizeLockedProfileAcceptance(candidate.operation, calibration);
      this.preparedPositioningCalibration = null;
      stateMod.set({
        positioningPreview: { ...entry, status: "saved", savedAt: new Date().toISOString(), persisted },
        lastError: null,
      });
      this.emitState();
      this.log(`positioning-preview ${JSON.stringify({ id: entry.id, stage: "profile_activated", profileRevisionId: persisted.profileRevisionId, profileDigestSha256: persisted.profileDigestSha256 })}`);
      return { ok: true, persisted };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async submitPositioningCalibration(previewId, submitter) {
    if (this.profileAcceptanceInFlight) {
      return { ok: false, code: "profile_acceptance_in_flight", error: "This Scanner profile is already awaiting MintVault acceptance" };
    }
    if (typeof submitter !== "function") return { ok: false, error: "Scanner profile acceptance transport is unavailable" };
    this.profileAcceptanceInFlight = true;
    try {
      const prepared = await this.preparePositioningCalibration(previewId);
      if (!prepared.ok) return prepared;
      const accepted = await submitter(prepared.candidate);
      if (!accepted?.ok) {
        return {
          ok: false,
          code: accepted?.body?.error?.code || "profile_acceptance_failed",
          error: accepted?.body?.error?.message || accepted?.body?.error || "MintVault did not accept the verified Scanner profile.",
        };
      }
      return this.commitPositioningCalibration(previewId, accepted.body?.calibration);
    } finally {
      this.profileAcceptanceInFlight = false;
    }
  }

  previewData(previewId) {
    const entry = this.activeTargetEntry();
    if (!entry || !["preview_ready", "preview_error"].includes(entry.phase) || entry.previewId !== previewId) {
      return { ok: false, error: "Preview is stale or no longer awaiting acceptance" };
    }
    try {
      if (!entry.previewArtifact) throw new Error("Encrypted preview is unavailable");
      const bytes = this.captureQueue.readArtifactSync(entry.previewArtifact, PREVIEW_MAX_BYTES);
      return { ok: true, previewId, dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` };
    } catch (error) {
      return { ok: false, error: error.message || "Preview file is unavailable" };
    }
  }

  archivePreviewCandidate(entry, reason, { disposition = null, localOutcome = "LOCAL_QUARANTINE" } = {}) {
    return this.captureQueue.upsert({
      ...entry,
      phase: "quarantined",
      lifecycleState: "QUARANTINED",
      disposition,
      localOutcome,
      quarantineReason: reason,
      quarantinedAt: new Date().toISOString(),
    });
  }

  expireTargetedCapture(entry, reason) {
    // An expired/cancelled session can no longer authorize this TIFF. Keep it
    // outside the live queue for audit/recovery, then release the station so
    // MintVault can arm a fresh card-side target.
    this.archivePreviewCandidate(entry, `Capture target expired or changed before acceptance. ${reason}`, {
      localOutcome: "SERVER_SESSION_TERMINAL_WITHOUT_DISPOSITION",
    });
    stateMod.set({ state: "error", activeCapture: null, lastError: reason });
    this.emitState();
    this.logCaptureStage(entry, "expired", { reason });
    return { ok: false, error: reason };
  }

  completeTargetedCapture(entry, capture, { authoritativeDispositionVerified = false } = {}) {
    if (!authoritativeDispositionVerified) {
      const reason = "Encrypted evidence cannot resolve without a verified canonical ACCEPTED disposition";
      this.addTargetedPending({ ...entry, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", disposition: null, reconciliationReason: reason });
      return { ok: false, retryPending: true, error: reason };
    }
    const metadata = this.authenticatedMasterMetadata(entry);
    const certId = metadata.certificateNumber;
    // A successful finalisation is the server's authoritative ACCEPTED
    // disposition. Only then may the redundant local ciphertext be resolved.
    const accepted = this.captureQueue.upsert({
      ...entry,
      phase: "accepted",
      lifecycleState: "ACCEPTED",
      disposition: "ACCEPTED",
      serverAcceptedAt: new Date().toISOString(),
    });
    try {
      this.finalizeAcceptedCapture(accepted);
    } catch (error) {
      stateMod.set({ state: "error", activeCapture: null, lastError: "Image accepted — encrypted local resolution remains pending" });
      this.emitState();
      return { ok: false, retryPending: true, error: error.message };
    }
    stateMod.set({
      state: "success",
      activeCapture: null,
      lastUploadedCert: certId,
      lastAcceptedCapture: {
        certId,
        side: metadata.side,
        cardRegistered: capture?.cardRegistered === true,
        acceptedAt: new Date().toISOString(),
      },
      lastError: null,
    });
    stateMod.pushRecent({ certId, side: metadata.side, source: "targeted-lide" });
    this.emitState();
    this.logCaptureStage(entry, "accepted", { certId, elapsedMs: entry.capturedAtMs ? Date.now() - entry.capturedAtMs : null });
    this.log(`targeted ${metadata.side} capture accepted for ${certId} (session ${metadata.captureSessionId})`);
    setTimeout(() => {
      if (stateMod.get().state === "success") {
        stateMod.set({ state: "idle" });
        this.emitState();
      }
    }, 1_500);
    return { ok: true, certId };
  }

  finalizeAcceptedCapture(entry) {
    if (entry.lifecycleState !== "ACCEPTED" || entry.disposition !== "ACCEPTED") {
      throw new QueueCorruptionError("Only a canonical ACCEPTED queue record may be resolved locally");
    }
    // ACCEPTED is the durable deletion-authorisation journal state. Delete
    // ciphertext first; then commit RESOLVED. If the process dies between
    // those operations, startup sees ACCEPTED and safely retries both steps.
    if (entry.artifact) this.captureQueue.destroyArtifact(entry.artifact);
    if (entry.previewArtifact) this.captureQueue.destroyArtifact(entry.previewArtifact);
    return this.captureQueue.upsert({
      ...entry,
      phase: "resolved",
      lifecycleState: "RESOLVED",
      artifact: null,
      previewArtifact: null,
      resolvedAt: new Date().toISOString(),
    });
  }

  finalizeAcceptedCaptures() {
    let resolved = 0;
    for (const entry of this.captureQueue.entries().filter((candidate) => candidate.lifecycleState === "ACCEPTED")) {
      this.finalizeAcceptedCapture(entry);
      resolved++;
    }
    return resolved;
  }

  failTargetedCapture(entry, reason, { notifyServer = false } = {}) {
    if (notifyServer) {
      void server.failCapture(entry.sessionId, lide400.deviceId(), reason).catch((error) => {
        this.log(`could not mark physical capture failed: ${error.message}`, "warn");
      });
    }
    this.archivePreviewCandidate(entry, reason, { localOutcome: "LOCAL_CAPTURE_FAILURE" });
    stateMod.set({ state: "error", activeCapture: null, lastError: reason });
    this.emitState();
    this.logCaptureStage(entry, "failed", { reason });
    return { ok: false, error: reason };
  }

  async uploadTargetedCapture(entry) {
    let durable = entry;
    if (!durable.artifact) return this.failTargetedCapture(durable, "Authenticated encrypted TIFF is unavailable; capture is quarantined for recovery");
    let metadata;
    try { metadata = await this.verifyEncryptedCandidate(durable); }
    catch (error) { return this.failTargetedCapture(durable, error.message || "Encrypted TIFF validation failed"); }

    const initial = await this.reconcileTargetedCapture(durable);
    const initialDisposition = this.applyServerDisposition(durable, initial);
    if (initialDisposition) return initialDisposition;
    if (initial.unavailable) {
      this.addTargetedPending({ ...durable, phase: "upload_retry", lifecycleState: "RETRYING", retryAfter: Date.now() + 60_000 });
      return { ok: false, retryPending: true };
    }
    if (["failed", "expired", "cancelled"].includes(initial.state)) {
      return this.failTargetedCapture(durable, initial.capture?.failureReason || "Capture expired or was rejected — restart this side");
    }
    if (initial.state === "capturing") {
      this.setTargetState(durable, "uploading", "uploading", "Server is finalising the image — checking again shortly");
      return { ok: false, retryPending: true };
    }
    if (initial.state === "captured" || initial.legacyAccepted) {
      this.addTargetedPending({ ...durable, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", reconciliationReason: "Legacy accepted state lacks a canonical tuple-bound disposition" });
      return { ok: false, retryPending: true };
    }
    if (initial.state !== "claimed") return this.failTargetedCapture(durable, "Capture session is no longer available — restart this side");

    for (let attempt = Number(durable.uploadAttempts || 0); attempt <= TARGETED_RETRY_DELAYS_MS.length; attempt++) {
      const lifecycleState = attempt === 0 && durable.lifecycleState === "PENDING_UPLOAD" ? "PENDING_UPLOAD" : "RETRYING";
      durable = this.addTargetedPending({ ...durable, phase: attempt ? "upload_retry" : "upload", lifecycleState, uploadAttempts: attempt });
      this.setTargetState({ ...durable, attempt: attempt + 1 }, "uploading", "uploading", attempt ? `Upload interrupted — retrying ${attempt}/${TARGETED_RETRY_DELAYS_MS.length}` : null);
      let uploaded;
      const uploadStartedAt = Date.now();
      this.logCaptureStage(durable, "upload_started", { attempt: attempt + 1 });
      const uploadPath = this.captureQueue.scratchPath(durable, ".tif");
      try {
        await this.captureQueue.decryptToFile(durable.artifact, uploadPath);
        // uploadCaptureEvidence requests a fresh short-lived grant internally
        // on every invocation; no grant is ever persisted in this queue.
        uploaded = await server.uploadCaptureEvidence(metadata.captureSessionId, lide400.deviceId(), uploadPath, metadata.captureProvenance, {
          captureAuthorisationId: metadata.captureAuthorisationId,
          semanticOperationId: metadata.semanticOperationId,
          cardJobId: metadata.cardJobId,
          certificateNumber: metadata.certificateNumber,
          side: metadata.side,
          revision: metadata.revision,
          profileRevisionId: metadata.profileRevisionId,
          tenantId: metadata.tenantId,
          locationId: metadata.locationId,
          stationId: metadata.stationId,
          workstationId: metadata.workstationId,
          originalOperatorId: metadata.originalOperatorId,
          originalOperatorRole: metadata.originalOperatorRole,
          capturePurpose: metadata.capturePurpose,
          authorisationIssuedAt: metadata.authorisationIssuedAt,
          authorisationExpiresAt: metadata.authorisationExpiresAt,
          deviceCapturedAt: metadata.deviceCapturedAt,
          deviceTimestampAuthority: metadata.deviceTimestampAuthority,
          appVersion: metadata.appVersion,
          captureHelperVersion: metadata.captureHelperVersion,
          identityHelperVersion: metadata.identityHelperVersion,
          expectedSha256: metadata.sha256,
          expectedByteLength: metadata.byteLength,
          expectedMimeType: metadata.mimeType,
        });
      } catch (error) {
        uploaded = { ok: false, status: 0, body: { error: error.message || String(error) } };
      } finally {
        try { fs.unlinkSync(uploadPath); } catch (error) { if (error?.code !== "ENOENT") this.log("upload scratch cleanup will be retried at startup", "warn"); }
      }
      if (uploaded.ok) {
        durable = this.addTargetedPending({ ...durable, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", uploadAttempts: attempt + 1 });
        const responseDisposition = this.applyServerDisposition(durable, this.resultFromDispositionBody(uploaded.body, {
          cardRegistered: uploaded.body?.card_registered === true,
        }));
        if (responseDisposition) return responseDisposition;
        const reconciled = await this.reconcileTargetedCapture(durable);
        const reconciledDisposition = this.applyServerDisposition(durable, reconciled);
        if (reconciledDisposition) return reconciledDisposition;
        this.addTargetedPending({ ...durable, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", disposition: null, reconciliationReason: "Successful upload transport lacks a canonical tuple-bound server disposition" });
        return { ok: false, retryPending: true };
      }
      this.logCaptureStage(durable, "upload_response_lost_or_rejected", { attempt: attempt + 1, status: uploaded.status, elapsedMs: Date.now() - uploadStartedAt });
      durable = this.addTargetedPending({ ...durable, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", uploadAttempts: attempt + 1 });
      const responseDisposition = this.applyServerDisposition(durable, this.resultFromDispositionBody(uploaded.body));
      if (responseDisposition) return responseDisposition;
      const reconciled = await this.reconcileTargetedCapture(durable);
      const reconciledDisposition = this.applyServerDisposition(durable, reconciled);
      if (reconciledDisposition) return reconciledDisposition;
      if (!this.isTransientCaptureFailure(uploaded)) return this.failTargetedCapture(durable, uploaded.body?.error || `Image rejected — HTTP ${uploaded.status}`);
      if (["failed", "expired", "cancelled"].includes(reconciled.state)) return this.failTargetedCapture(durable, reconciled.capture?.failureReason || "Capture rejected — restart this side");
      if (reconciled.state === "capturing" || reconciled.state === "captured" || reconciled.legacyAccepted || reconciled.unavailable) {
        this.addTargetedPending({ ...durable, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", uploadAttempts: attempt + 1 });
        return { ok: false, retryPending: true };
      }
      if (attempt === TARGETED_RETRY_DELAYS_MS.length) {
        this.addTargetedPending({ ...durable, phase: "upload_retry", lifecycleState: "RETRYING", uploadAttempts: 0, retryAfter: Date.now() + 60_000 });
        stateMod.set({ state: "error", activeCapture: null, lastError: "Upload interrupted — keeping this accepted side for safe retry" });
        this.emitState();
        return { ok: false, retryPending: true };
      }
      await this.sleep(TARGETED_RETRY_DELAYS_MS[attempt]);
    }
    return { ok: false, retryPending: true };
  }

  async restorePreviewCandidate(entry) {
    if (!entry.artifact) {
      const waiting = { ...entry, phase: "awaiting_scan", previewId: null, previewPath: null, filePath: null, provenance: null };
      this.addTargetedPending(waiting);
      this.setTargetState(waiting, "awaiting_scan", "awaiting_scan", "Previous scan was interrupted before a preview was ready — press Scan to try again");
      return waiting;
    }
    let restored = entry;
    if (!restored.previewArtifact) {
      const releaseRecovery = this.beginRecoveryPlaintextWork();
      const previewId = restored.previewId || crypto.randomUUID();
      const masterPath = this.captureQueue.scratchPath(restored, ".tif");
      const previewPath = this.captureQueue.scratchPath(restored, ".jpg");
      try {
        await this.captureQueue.decryptToFile(restored.artifact, masterPath);
        await this.createPreviewDerivative(masterPath, previewPath);
        restored = await this.captureQueue.attachFile({ ...restored, phase: "preview_ready", previewId }, previewPath, { kind: "PREVIEW_JPEG", mimeType: "image/jpeg" });
        restored = this.addTargetedPending({ ...restored, previewPath: null });
      } finally {
        for (const candidate of [masterPath, previewPath]) {
          try { fs.unlinkSync(candidate); } catch (error) { if (error?.code !== "ENOENT") this.log("preview scratch cleanup will be retried at startup", "warn"); }
        }
        releaseRecovery();
      }
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
    const updateDeniedAtEntry = this.updateInstallDenial();
    if (updateDeniedAtEntry) return false;
    const queue = this.readTargetedQueue();
    if (!queue.length || this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) return false;
    for (const entry of queue) {
      if (!entry?.sessionId) {
        this.removeTargetedPending(entry?.sessionId);
        continue;
      }
      if (entry.cancelOperationId && entry.cancelState === "PENDING") {
        this.setTargetState(entry, "cancel_pending", "cancel_pending", "MintVault is reconciling this Card Job cancellation.");
        return true;
      }
      if (["upload", "upload_retry", "needs_reconciliation"].includes(entry.phase)) {
        if (!entry.artifact) return this.failTargetedCapture(entry, "Encrypted TIFF is missing; capture is quarantined for recovery");
        if (Number(entry.retryAfter || 0) > Date.now()) return true;
        this.targetCaptureInFlight = true;
        try { await this.uploadTargetedCapture(entry); } finally { this.targetCaptureInFlight = false; }
        return true;
      }
      const kept = await this.keepTargetAlive(entry);
      if (this.updateInstallDenial()) return false;
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

  async stop({ requireIdle = true } = {}) {
    if (requireIdle && !this.isRestartSafeForUpdate()) {
      const error = new Error("Scanner service restart is deferred until physical and recovery work is idle");
      error.code = "restart_deferred";
      throw error;
    }
    if (this.initialDrainTimer) {
      clearTimeout(this.initialDrainTimer);
      this.initialDrainTimer = null;
      this.initialFiles = [];
      this.ready = false;
    }
    if (this.chokidar) {
      await this.chokidar.close();
      this.chokidar = null;
    }
    if (this.initialDrainPromise) await this.initialDrainPromise;
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
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return { status: "paused_for_update", ...updateDenied };
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
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return updateDenied;
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight || this.uploading) {
      return { ok: false, skipped: true };
    }
    if (await this.resumeTargetedCaptures()) return { ok: true, resumed: true };
    const updateDeniedAfterResume = this.updateInstallDenial();
    if (updateDeniedAfterResume) return updateDeniedAfterResume;
    // Already-authorised delivery may recover with station-only signatures,
    // but claiming or physically scanning a new target always needs a live
    // operator session as well as the ACTIVE station.
    if (!server.hasToken()) return { ok: false, skipped: true, humanRequired: true };
    const storage = this.captureStorageStatus();
    if (!storage.ok) {
      stateMod.set({ state: "storage_pressure", lastError: "Capture paused: free disk capacity is below the encrypted-queue safety floor" });
      this.emitState();
      return { ok: false, storagePressure: true, storage };
    }
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
    const updateDeniedAfterClaim = this.updateInstallDenial();
    if (updateDeniedAfterClaim) return updateDeniedAfterClaim;
    if (!claim.ok) {
      this.log(`capture-session poll rejected: ${claim.body?.error || `HTTP ${claim.status}`}`, "warn");
      return { ok: false, error: claim.body?.error || `HTTP ${claim.status}` };
    }
    const capture = claim.body?.capture;
    if (!capture) return { ok: true, idle: true };
    let authority;
    try {
      authority = captureEntryFromAuthorisation(capture);
      if (authority.workstationId !== lide400.stationId()) throw new Error("Capture authorisation is bound to another workstation");
    } catch (error) {
      this.log(`capture authorisation rejected before scan: ${error.message}`, "error");
      stateMod.set({ state: "error", activeCapture: null, lastError: error.message });
      this.emitState();
      return { ok: false, error: error.message, authorisationRejected: true };
    }
    const entry = {
      queueEntryId: crypto.randomUUID(),
      phase: "awaiting_scan",
      lifecycleState: "PENDING_UPLOAD",
      ...authority,
      lastKeepaliveAt: Date.now(),
      previewId: null,
      previewPath: null,
      filePath: null,
      provenance: null,
      frameAssessment: null,
      capturedAtMs: null,
      uploadAttempts: 0,
    };
    this.addTargetedPending(entry);
    this.setTargetState(entry, "awaiting_scan", "awaiting_scan");
    this.logCaptureStage(entry, "target_claimed_waiting_for_operator");
    return { ok: true, armed: true, capture };
  }

  async scanActiveTarget() {
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return updateDenied;
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "A scan, Accept, Rescan, or positioning Preview action is already in progress" };
    }
    const current = this.activeTargetEntry();
    if (!current || current.phase !== "awaiting_scan") {
      return { ok: false, error: "No current card-side target is awaiting Scan" };
    }
    if (current.cancelOperationId && current.cancelState === "PENDING") {
      return { ok: false, code: "cancel_pending", error: "Card cancellation is awaiting MintVault reconciliation; Scan remains locked." };
    }
    if (stateMod.get().scannerHealth?.status !== "ready") {
      return { ok: false, error: "Canon LiDE 400 is not ready for a locked-profile scan" };
    }
    const storage = this.captureStorageStatus();
    if (!storage.ok) return { ok: false, error: "Capture paused: free disk capacity is below the encrypted-queue safety floor", storagePressure: true };
    // Claim the local single-flight guard before the first await. Otherwise
    // two rapid IPC clicks can both observe `awaiting_scan` and start two
    // physical scans while the device-bound keepalive resolves.
    this.targetCaptureInFlight = true;
    let direct = null;
    try {
      if (this.scannerHealthPromise) await this.scannerHealthPromise;
      const deniedAfterHealth = this.updateInstallDenial();
      if (deniedAfterHealth) return deniedAfterHealth;
      const kept = await this.keepTargetAlive(current, { force: true });
      if (!kept.ok) return { ok: false, error: kept.error || "Capture target can no longer be used" };
      const deniedAfterTargetAuthority = this.updateInstallDenial();
      if (deniedAfterTargetAuthority) return deniedAfterTargetAuthority;
      const previewId = crypto.randomUUID();
      const captureDir = path.join(CAPTURE_STAGING, current.sessionId, previewId);
      const scanning = { ...kept.entry, phase: "scanning", previewId, captureDir, attempt: 1 };
      this.addTargetedPending(scanning); // durable before a physical scan begins
      ensurePrivateDirectory(path.dirname(captureDir));
      ensurePrivateDirectory(captureDir);
      this.setTargetState(scanning, "scanning", current.side === "front" ? "scanning_front" : "scanning_back");
      this.logCaptureStage(scanning, "scan_started");
      let lastScanError = null;
      let liveEntry = kept.entry;
      const startedAt = Date.now();
      for (let attempt = 0; attempt <= TARGETED_RETRY_DELAYS_MS.length; attempt++) {
        try {
          if (attempt) {
            const retrying = { ...scanning, attempt: attempt + 1 };
            this.setTargetState(retrying, "retrying_scan", current.side === "front" ? "scanning_front" : "scanning_back", `Scanner busy — retrying ${attempt}/${TARGETED_RETRY_DELAYS_MS.length}`);
            await this.sleep(TARGETED_RETRY_DELAYS_MS[attempt - 1]);
          }
          const immediate = await this.keepTargetAlive(liveEntry, { force: true });
          if (!immediate.ok) throw new Error(immediate.error || "Capture target can no longer be used");
          liveEntry = immediate.entry;
          const deniedImmediatelyBeforeScan = this.updateInstallDenial();
          if (deniedImmediatelyBeforeScan) return deniedImmediatelyBeforeScan;
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
      if (direct.provenance?.helperVersion !== helperIntegrity.HELPER_VERSION) {
        throw new Error("LiDE capture helper version does not match the trusted application manifest");
      }
      if (Number.isInteger(direct.artifactDescriptor)) fs.fchmodSync(direct.artifactDescriptor, 0o600);
      else fs.chmodSync(direct.path, 0o600);
      const masterReadPath = Number.isInteger(direct.artifactDescriptor) ? `/dev/fd/${direct.artifactDescriptor}` : direct.path;
      const previewPath = path.join(captureDir, `${previewId}.preview.jpg`);
      const completed = this.addTargetedPending({
        ...scanning,
        phase: "validating_master",
        filePath: direct.path,
        previewPath,
        provenance: direct.provenance,
        capturedAtMs: Date.now(),
        appVersion: scannerPackage.version,
        captureHelperVersion: direct.provenance.helperVersion,
        identityHelperVersion: helperIntegrity.IDENTITY_HELPER_VERSION,
      });
      const masterValidation = await this.validateCaptureMaster(masterReadPath, completed.provenance, completed.profileRevisionId, direct.artifactDescriptor);
      const processing = this.addTargetedPending({
        ...completed,
        phase: "preview_processing",
        masterValidation,
      });
      this.setTargetState(processing, "processing_preview", "finalising", "Generating non-authoritative preview from the 1200 DPI TIFF");
      await this.createPreviewDerivative(masterReadPath, previewPath);
      fs.chmodSync(previewPath, 0o600);
      const frameAssessment = await this.assessCaptureFrame(masterReadPath, processing.provenance);
      // Both master and derivative are encrypted and indexed before the
      // operator can Accept (the first point at which network ambiguity is
      // possible). attachFile fsyncs ciphertext + index before unlinking each
      // plaintext source.
      let assessed = await this.captureQueue.attachFile({ ...processing, frameAssessment }, processing.filePath, {
        kind: "TIFF_MASTER", mimeType: "image/tiff",
        sourceDescriptor: direct.artifactDescriptor,
        expectedSha256: processing.provenance?.helperAttestedSha256 || null,
        expectedByteLength: processing.provenance?.helperAttestedByteLength || null,
      });
      assessed = this.addTargetedPending({
        ...assessed,
        filePath: null,
        evidenceDigest: assessed.artifact.sha256,
        evidenceSize: assessed.artifact.byteLength,
        evidenceMime: assessed.artifact.mimeType,
      });
      assessed = await this.captureQueue.attachFile(assessed, previewPath, { kind: "PREVIEW_JPEG", mimeType: "image/jpeg" });
      assessed = this.addTargetedPending({ ...assessed, previewPath: null });
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
      let staged = this.activeTargetEntry();
      if (staged?.filePath && fs.existsSync(staged.filePath) && !staged.artifact) {
        try {
          staged = await this.captureQueue.attachFile(staged, staged.filePath, {
            kind: "TIFF_MASTER",
            mimeType: "image/tiff",
            quarantine: true,
            sourceDescriptor: Number.isInteger(direct?.artifactDescriptor) ? direct.artifactDescriptor : null,
            expectedSha256: staged.provenance?.helperAttestedSha256 || null,
            expectedByteLength: staged.provenance?.helperAttestedByteLength || null,
          });
          staged = this.addTargetedPending({ ...staged, filePath: null });
        } catch (encryptionError) {
          this.log(`capture quarantine failed closed: ${encryptionError.message}`, "error");
        }
      }
      if (staged?.previewPath && fs.existsSync(staged.previewPath) && !staged.previewArtifact) {
        try {
          staged = await this.captureQueue.attachFile(staged, staged.previewPath, { kind: "PREVIEW_JPEG", mimeType: "image/jpeg", quarantine: true });
          staged = this.addTargetedPending({ ...staged, previewPath: null });
        } catch (encryptionError) {
          this.log(`preview quarantine failed closed: ${encryptionError.message}`, "error");
        }
      }
      if (staged?.artifact || (staged?.filePath && fs.existsSync(staged.filePath))) {
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
      if (Number.isInteger(direct?.artifactDescriptor)) {
        try { fs.closeSync(direct.artifactDescriptor); } catch { /* descriptor was already closed during failure cleanup */ }
      }
      this.targetCaptureInFlight = false;
    }
  }

  async acceptPreview(previewId) {
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return updateDenied;
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "A scan, Accept, Rescan, or positioning Preview action is already in progress" };
    }
    const current = this.activeTargetEntry();
    if (!current || current.phase !== "preview_ready" || current.previewId !== previewId) {
      return { ok: false, error: "This preview is stale and cannot be accepted" };
    }
    if (current.cancelOperationId && current.cancelState === "PENDING") {
      return { ok: false, code: "cancel_pending", error: "Card cancellation is awaiting MintVault reconciliation; Accept remains locked." };
    }
    if (!current.artifact) {
      return { ok: false, error: "The encrypted preview TIFF is no longer available; rescan this side" };
    }
    this.previewActionInFlight = true;
    try {
      try { await this.verifyEncryptedCandidate(current); }
      catch (error) { return { ok: false, error: error.message || "Encrypted TIFF failed validation" }; }
      const truth = await this.reconcileTargetedCapture(current);
      const disposition = this.applyServerDisposition(current, truth);
      if (disposition) return disposition;
      if (truth.unavailable) return { ok: false, error: "Unable to verify capture target; TIFF remains staged and no upload was attempted" };
      if (truth.state === "captured" || truth.legacyAccepted) {
        this.addTargetedPending({ ...current, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", reconciliationReason: "Legacy accepted state lacks a canonical tuple-bound disposition" });
        return { ok: false, retryPending: true, error: "Server acceptance is awaiting canonical reconciliation" };
      }
      if (truth.state !== "claimed") {
        return this.expireTargetedCapture(current, "Capture target expired or changed before Accept — TIFF was not uploaded");
      }
      const kept = await this.keepTargetAlive(current);
      if (!kept.ok) return { ok: false, error: kept.error || "Capture target is no longer valid" };
      const upload = { ...kept.entry, phase: "upload", lifecycleState: "PENDING_UPLOAD", uploadAttempts: 0, retryAfter: null };
      this.addTargetedPending(upload); // durable before the only authoritative POST
      this.targetCaptureInFlight = true;
      return await this.uploadTargetedCapture(upload);
    } finally {
      this.targetCaptureInFlight = false;
      this.previewActionInFlight = false;
    }
  }

  async rescanPreview(previewId) {
    const updateDenied = this.updateInstallDenial();
    if (updateDenied) return updateDenied;
    if (this.targetCaptureInFlight || this.previewActionInFlight || this.positioningPreviewInFlight) {
      return { ok: false, error: "Rescan is unavailable while Scan, Accept, or positioning Preview is in progress" };
    }
    const current = this.activeTargetEntry();
    if (!current || !["preview_ready", "preview_error"].includes(current.phase) || current.previewId !== previewId) {
      return { ok: false, error: "This preview is stale and cannot be rescanned" };
    }
    if (current.cancelOperationId && current.cancelState === "PENDING") {
      return { ok: false, code: "cancel_pending", error: "Card cancellation is awaiting MintVault reconciliation; Rescan remains locked." };
    }
    this.previewActionInFlight = true;
    try {
      const truth = await this.reconcileTargetedCapture(current);
      const disposition = this.applyServerDisposition(current, truth);
      if (disposition) return disposition;
      if (truth.unavailable) return { ok: false, error: "Unable to verify capture target; Rescan is held to prevent a target crossover" };
      if (truth.state === "captured" || truth.legacyAccepted) {
        this.addTargetedPending({ ...current, phase: "needs_reconciliation", lifecycleState: "NEEDS_RECONCILIATION", reconciliationReason: "Legacy accepted state lacks a canonical tuple-bound disposition" });
        return { ok: false, retryPending: true, error: "Server acceptance is awaiting canonical reconciliation" };
      }
      if (truth.state !== "claimed") {
        return this.expireTargetedCapture(current, "Capture target expired or changed — Rescan was blocked");
      }
      const kept = await this.keepTargetAlive(current);
      if (!kept.ok) return { ok: false, error: kept.error || "Capture target is no longer valid" };
      const rescanRequestOperationId = kept.entry.rescanRequestOperationId || crypto.randomUUID();
      const requesting = this.addTargetedPending({ ...kept.entry, rescanRequestOperationId });
      let response;
      try {
        response = await server.requestRescanAuthorisation(
          requesting.sessionId,
          lide400.deviceId(),
          requesting.captureAuthorisationId,
          rescanRequestOperationId,
        );
      } catch (error) {
        return { ok: false, error: `Fresh Rescan authorisation is unavailable: ${error.message}` };
      }
      if (!response.ok) return { ok: false, error: response.body?.error || `Fresh Rescan authorisation was rejected — HTTP ${response.status}` };
      let fresh;
      try { fresh = captureEntryFromAuthorisation(response.body?.capture); }
      catch (error) { return { ok: false, error: error.message }; }
      const pinned = [
        "sessionId",
        "cardJobId",
        "certId",
        "side",
        "profileRevisionId",
        "tenantId",
        "locationId",
        "stationCredentialId",
        "workstationId",
        "originalOperatorId",
        "originalOperatorRole",
        "capturePurpose",
        "cancelEligible",
      ];
      if (pinned.some((field) => fresh[field] !== requesting[field]) || fresh.workstationId !== lide400.stationId()) {
        return { ok: false, error: "Fresh Rescan authorisation changed the pinned card-side/station tuple" };
      }
      if (fresh.captureAuthorisationId === requesting.captureAuthorisationId || fresh.semanticOperationId === requesting.semanticOperationId || fresh.revision <= requesting.revision) {
        return { ok: false, error: "Fresh Rescan authorisation did not advance authorisation, operation, and evidence revision" };
      }
      const replacement = {
        ...fresh,
        queueEntryId: crypto.randomUUID(),
        phase: "awaiting_scan",
        lifecycleState: "PENDING_UPLOAD",
        disposition: null,
        previewId: null,
        previewPath: null,
        previewArtifact: null,
        filePath: null,
        artifact: null,
        provenance: null,
        frameAssessment: null,
        masterValidation: null,
        capturedAtMs: null,
        appVersion: null,
        captureHelperVersion: null,
        identityHelperVersion: null,
        quarantineReason: null,
        quarantinedAt: null,
        rescanRequestOperationId: null,
        lastKeepaliveAt: Date.now(),
        uploadAttempts: 0,
      };
      const { next: waiting } = this.captureQueue.replaceForRescan(requesting.queueEntryId, replacement, {
        reason: "Operator chose Rescan before acceptance; this TIFF was never uploaded as card evidence.",
      });
      this.setTargetState(waiting, "awaiting_scan", "awaiting_scan");
      this.logCaptureStage(waiting, "rescan_requested");
      return { ok: true };
    } finally {
      this.previewActionInFlight = false;
    }
  }

  // ── File handling ────────────────────────────────────────────────────

  async handleNewFile(filePath) {
    const lifecycleDenied = this.updateInstallDenial();
    if (lifecycleDenied) return lifecycleDenied;
    return this.withRecoveryPlaintextWork(() => this.handleNewFileImpl(filePath));
  }

  async handleNewFileImpl(filePath) {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();

    if (filename.startsWith(".") || filename === ".DS_Store") return;
    // Test-scan artifacts (written as test-scan-<ts>.tif by the "test scan"
    // button in main.js) must never enter the grading pipeline. In AUTO mode
    // they buffer as a front/back and pair with a real card TIFF, minting a
    // blank/mismatched cert. Skip them entirely — checked before the
    // extension filter so it catches the file regardless of how it's named.
    if (filename.startsWith("test-scan-")) {
      await this.quarantinePlaintext(filePath, "Local test-scan TIFF is not authoritative card evidence");
      this.log(`encrypted test-scan file into non-authoritative quarantine: ${filename}`);
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
    const reason = "Unbound hot-folder TIFF refused. Start a target-bound Canon LiDE capture from the MintVault workstation.";
    await this.quarantinePlaintext(filePath, reason);
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
    ensurePrivateDirectory(parent);
    ensurePrivateDirectory(dir);
    return dir;
  }

  moveFile(srcPath, destDir) {
    if (!srcPath || !fs.existsSync(srcPath)) return null;
    const dest = path.join(destDir, path.basename(srcPath));
    try {
      ensurePrivateDirectory(destDir);
      fs.renameSync(srcPath, dest);
      fs.chmodSync(dest, 0o600);
      return dest;
    }
    catch (err) {
      this.log(`move failed ${srcPath} → ${destDir}: ${err.message}`, "error");
      return null;
    }
  }

  writeError(filePath, reason) {
    try {
      fs.writeFileSync(`${filePath}.error.txt`, `${new Date().toISOString()}\n${reason}\n`, { mode: 0o600 });
    } catch {}
  }
}

module.exports = { Watcher, INBOX, FAILED };
