/**
 * Scan-ingest service — shared business logic for creating certs from scanner uploads.
 *
 * Extracted from routes.ts handlers so both the existing admin endpoints
 * and the new scan-ingest endpoint can reuse the same code paths.
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { uploadToR2, getR2Buffer, listR2Keys } from "./r2";
import {
  generateImageVariants,
  identifyCardFromBuffer,
  verifyAndEnrichCardData,
  verifyPokemonCardWithTcgApi,
  gradeCardFromBuffer,
  type EnrichedCardData,
  type AiGrading,
} from "./ai-grading-service";
import { runScanJob } from "./lib/scan-job-queue";

/**
 * Build a server-log suffix exposing the Postgres SQLSTATE + detail behind a
 * failed query. Drizzle wraps the pg error, so its message is only
 * "Failed query: <sql>"; the code/detail live on the error or its `.cause`.
 * SERVER LOGS ONLY — never returned to clients. This is why tonight's exact
 * cause was unreadable: the catches logged only err.message.
 */
export function pgErrorDetail(err: any): string {
  const code = err?.code ?? err?.cause?.code;
  const detail = err?.detail ?? err?.cause?.detail;
  const routine = err?.routine ?? err?.cause?.routine;
  const parts: string[] = [];
  if (code) parts.push(`SQLSTATE=${code}`);
  if (detail) parts.push(`detail=${detail}`);
  if (routine) parts.push(`routine=${routine}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

/** Elapsed ms since a process.hrtime.bigint() mark. */
function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * Boot migration — scanner durability columns on `certificates`. Additive +
 * idempotent (safe on every startup; cert_counter idiom).
 *   raw_uploaded: false until the raw scans are CONFIRMED in R2 — the scanner's
 *     precondition for moving the inbox file (the core invariant).
 *   ingest_idempotency_key: content-derived, stable-across-retries key. Its
 *     UNIQUE index is the atomic gate that makes a re-driven/raced ingest
 *     resolve to the SAME cert instead of allocating a duplicate.
 */
export async function ensureCertDurabilitySchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE certificates
    ADD COLUMN IF NOT EXISTS raw_uploaded BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS ingest_idempotency_key TEXT`);
  // The unique index IS the concurrency gate (a check-then-insert would race —
  // the cert_counter lesson). NULLs are non-distinct in a Postgres unique index,
  // so legacy / non-idempotent rows (null key) never collide. Swallow the
  // catalog-race SQLSTATEs so two machines booting at once are safe.
  try {
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_ingest_idem ON certificates (ingest_idempotency_key)`
    );
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code !== "23505" && code !== "42710" && code !== "42P07") throw err;
  }
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
      SELECT 'schema', 'certificates', 'cert_durability_migrate', 'system_migration',
             ${JSON.stringify({ columns: ["raw_uploaded", "ingest_idempotency_key"], index: "uq_certificates_ingest_idem" })}::jsonb, NOW()
      WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'cert_durability_migrate')`);
  } catch (auditErr: any) {
    console.error("[cert-durability-migrate] audit insert failed:", auditErr?.message);
  }
  console.log("[cert-durability-migrate] certificates.raw_uploaded + ingest_idempotency_key + unique index ensured");
}

/**
 * Idempotent, concurrency-safe cert creation for an admin scan.
 *
 * `idempotencyKey` is derived by the scanner from the scan CONTENT (front+back
 * SHA) and is STABLE across retries + process restarts — so a re-driven ingest
 * (crash recovery, or a retry racing the original) resolves to the SAME cert,
 * never a duplicate:
 *   1. fast path — a committed cert for this key exists → return it (no alloc).
 *   2. else allocate a number + INSERT gated by the UNIQUE index
 *      (ON CONFLICT DO NOTHING). The index, not a check-then-insert, is the
 *      atomic primitive against concurrent same-key POSTs.
 *   3. lost the concurrent race (a sibling POST with the same key inserted
 *      first) → re-select the winner. The number from step 2's getNextCertId()
 *      becomes a harmless counter gap; NO second cert is created.
 * A null key (interactive admin_ui ingest) skips the gate and always allocates —
 * NULLs don't collide in the unique index.
 */
export async function createCertForScan(idempotencyKey?: string | null): Promise<{
  id: number;
  certId: string;
  referenceNumber: string;
  rawUploaded: boolean;
  scanStatus: string | null;
  reused: boolean;
}> {
  // Normalise: empty / whitespace-only → no key (null), so a blank never lands
  // in the unique index (where a 2nd blank would 500 on a duplicate-key clash).
  idempotencyKey = typeof idempotencyKey === "string" && idempotencyKey.trim() ? idempotencyKey.trim() : null;
  const norm = (n: string) => String(n).replace(/^MV-?0+/, "MV");
  const mapRow = (r: any, reused: boolean) => ({
    id: r.id as number,
    certId: norm(r.certificate_number),
    referenceNumber: r.reference_number as string,
    rawUploaded: r.raw_uploaded === true,
    scanStatus: (r.scan_status as string) ?? null,
    reused,
  });

  // 1. Idempotent replay — the original ingest already committed this cert.
  if (idempotencyKey) {
    const existing = await db.execute(sql`
      SELECT id, certificate_number, reference_number, raw_uploaded, scan_status
      FROM certificates WHERE ingest_idempotency_key = ${idempotencyKey} LIMIT 1`);
    if (existing.rows.length) {
      const row = mapRow(existing.rows[0], true);
      console.log(`[scan-ingest] idempotent replay → existing ${row.certId} (raw_uploaded=${row.rawUploaded})`);
      return row;
    }
  }

  // 2. Allocate + insert, gated by the unique index on ingest_idempotency_key.
  const { generateReferenceNumber } = await import("./reference-number");
  const certNumber = await storage.getNextCertId();
  const refNum = generateReferenceNumber();
  const ins = await db.execute(sql`
    INSERT INTO certificates (certificate_number, status, label_type, grade_type, language, card_name, created_by, issued_at, updated_at, reference_number, source, raw_uploaded, scan_status, ingest_idempotency_key)
    VALUES (${certNumber}, 'active', 'Standard', 'numeric', 'English', NULL, 'admin_scan', NOW(), NOW(), ${refNum}, 'admin_scan', false, 'processing', ${idempotencyKey ?? null})
    ON CONFLICT (ingest_idempotency_key) DO NOTHING
    RETURNING id, certificate_number, reference_number, raw_uploaded, scan_status
  `);
  if (ins.rows.length) {
    const row = mapRow(ins.rows[0], false);
    console.log(`[scan-ingest] created cert ${row.certId} (id=${row.id}) ref=${refNum}`);
    return row;
  }

  // 3. Lost a concurrent same-key race — a sibling POST inserted first. Our
  //    getNextCertId() number is a harmless counter gap; resolve to the winner.
  const winner = await db.execute(sql`
    SELECT id, certificate_number, reference_number, raw_uploaded, scan_status
    FROM certificates WHERE ingest_idempotency_key = ${idempotencyKey} LIMIT 1`);
  if (!winner.rows.length) throw new Error(`idempotency conflict but no winning row for key`);
  const row = mapRow(winner.rows[0], true);
  console.log(
    `[scan-ingest] concurrent same-key race resolved → ${row.certId} (counter tick MV${certNumber.replace(/\D/g, "")} skipped)`
  );
  return row;
}

/**
 * Mark raw scans confirmed in R2 — set ONLY after uploadRawScansToR2 resolves.
 * This flag is the scanner's precondition for moving the inbox file to processed/.
 */
export async function markRawUploaded(certId: number): Promise<void> {
  await db.execute(sql`UPDATE certificates SET raw_uploaded = true, updated_at = NOW() WHERE id = ${certId}`);
}

/**
 * Reconciler — boot + interval sweep for incomplete scan ingests. Idempotent
 * and dedup-safe (deterministic R2 keys, no rescan).
 *
 *  (A) scan_status='failed' AND raw_uploaded=true: the raw scans ARE in R2, but
 *      the heavy pipeline failed. Re-drive processing from the retained raw.
 *  (B) raw_uploaded=false older than N min: the server has NO bytes (they live
 *      only in the scanner's retained inbox file) — it CANNOT fix this itself.
 *      Surface LOUD; recovery is the scanner re-driving the idempotent ingest.
 *  Both classes are queryable for the admin Capture Health view.
 */
export async function reconcileStuckScans(opts: { staleMinutes?: number; limit?: number } = {}): Promise<void> {
  const stale = opts.staleMinutes ?? 10;
  const limit = opts.limit ?? 20;

  // (A) Re-drive pipeline failures from R2 raw.
  let failed: { rows: any[] };
  try {
    failed = (await db.execute(sql`
      SELECT id, certificate_number FROM certificates
      WHERE scan_status = 'failed' AND raw_uploaded = true
      ORDER BY updated_at ASC LIMIT ${limit}`)) as any;
  } catch (e: any) {
    console.error(`[reconciler] query (failed) error: ${e?.message}${pgErrorDetail(e)}`);
    failed = { rows: [] };
  }
  for (const row of failed.rows) {
    const certId = row.id as number;
    const certNum = String(row.certificate_number);
    try {
      const frontKeys = await listR2Keys(`images/grading/${certId}/raw_front`);
      const backKeys = await listR2Keys(`images/grading/${certId}/raw_back`);
      const frontBuf = frontKeys.length ? await getR2Buffer(frontKeys[0]) : null;
      const backBuf = backKeys.length ? await getR2Buffer(backKeys[0]) : null;
      if (!frontBuf) {
        console.warn(`[reconciler] ${certNum}: scan_status=failed but no raw_front in R2 — cannot re-drive`);
        continue;
      }
      console.log(`[reconciler] re-driving pipeline for ${certNum} from retained R2 raw`);
      // Serialize re-drive through the SAME scan queue so a reconciler sweep can't
      // pile heavy pipelines onto a concurrent foreground scan burst.
      await runScanJob(() => processScanInBackground({ id: certId, certId: certNum }, frontBuf, backBuf, {}), certNum);
    } catch (e: any) {
      console.error(`[reconciler] re-drive failed ${certNum}: ${e?.message ?? e}${pgErrorDetail(e)}`);
    }
  }

  // (B) Raw never confirmed — surface for scanner re-supply (server can't fix).
  let noRaw: { rows: any[] };
  try {
    noRaw = (await db.execute(sql`
      SELECT certificate_number FROM certificates
      WHERE raw_uploaded = false AND scan_status = 'processing'
        AND issued_at < NOW() - ((${stale})::text || ' minutes')::interval
      ORDER BY issued_at ASC LIMIT 50`)) as any;
  } catch (e: any) {
    console.error(`[reconciler] query (no-raw) error: ${e?.message}${pgErrorDetail(e)}`);
    noRaw = { rows: [] };
  }
  const stuck = noRaw.rows.map((r) => r.certificate_number);
  if (stuck.length) {
    console.warn(
      `[reconciler] ${stuck.length} cert(s) raw_uploaded=false >${stale}min — awaiting scanner re-supply: ${stuck.join(", ")}`
    );
  }
}

/**
 * Persist the raw scanner buffers to R2 as a durability backup BEFORE
 * the full processing pipeline runs. Stored under deterministic paths
 * (raw_front.{ext}, raw_back.{ext}) keyed off the cert ID so a recovery
 * path can locate them.
 *
 * Kept separate from uploadImagesToCert because raw upload happens
 * synchronously inside POST /api/admin/scan-ingest (durability before
 * returning to the watcher), while the heavy pipeline runs async.
 */
export async function uploadRawScansToR2(
  certId: number,
  front: { buffer: Buffer; mimeType: string; ext: string },
  back: { buffer: Buffer; mimeType: string; ext: string } | null
): Promise<{ frontKey: string; backKey: string | null }> {
  const safeExt = (ext: string) => (ext.replace(/[^a-z0-9]/gi, "") || "bin").toLowerCase();
  const frontKey = `images/grading/${certId}/raw_front.${safeExt(front.ext)}`;
  const backKey = back ? `images/grading/${certId}/raw_back.${safeExt(back.ext)}` : null;
  await Promise.all([
    uploadToR2(frontKey, front.buffer, front.mimeType || "application/octet-stream"),
    back && backKey ? uploadToR2(backKey, back.buffer, back.mimeType || "application/octet-stream") : Promise.resolve(),
  ]);
  return { frontKey, backKey };
}

/**
 * Write the cert's scan_status column. null = ready (no special state).
 * Defensive: missing column (pre-migration) → no-op, swallowed.
 */
export async function setScanStatus(certId: number, status: "processing" | "failed" | null): Promise<void> {
  try {
    await db.execute(sql`UPDATE certificates SET scan_status = ${status}, updated_at = NOW() WHERE id = ${certId}`);
  } catch (err: any) {
    console.warn(`[scan-status] write failed for cert ${certId}: ${err?.message ?? err}`);
  }
}

/**
 * Run the heavy image processing + AI pipeline as a background job.
 * Called from inside setImmediate by the scan-ingest endpoint AFTER the
 * synchronous reply has been sent. Buffers are passed by reference from
 * the multipart upload — no re-fetch from R2 in the success path.
 *
 * Failure handling: scan_status flips to "failed" and an audit_log row
 * is written so admin can see the cert needs reprocessing. The raw R2
 * keys persisted by uploadRawScansToR2 stay around for recovery.
 */
export async function processScanInBackground(
  certInfo: { id: number; certId: string },
  frontBuf: Buffer,
  backBuf: Buffer | null,
  opts: { skipAi?: boolean } = {}
): Promise<void> {
  const t0 = process.hrtime.bigint();
  try {
    console.log(`[process-scan] start cert=${certInfo.certId} (id=${certInfo.id})`);
    const { frontVariants, backVariants, timing } = await uploadImagesToCert(certInfo.id, frontBuf, backBuf);
    console.log(`[process-scan] images processed cert=${certInfo.certId}`);

    let aiMs = 0;
    if (!opts.skipAi) {
      const tAi = process.hrtime.bigint();
      try {
        const aiResult = await runAiOnCert(certInfo.id, frontVariants.cropped, backVariants?.cropped || null);
        aiMs = elapsedMs(tAi);
        console.log(`[process-scan] AI done cert=${certInfo.certId} grade=${aiResult.grade}`);
      } catch (aiErr: any) {
        aiMs = elapsedMs(tAi);
        // AI failure doesn't fail the whole job — images are processed,
        // admin can manually trigger AI from the grading panel.
        console.error(
          `[process-scan] AI failed cert=${certInfo.certId}: ${aiErr?.message ?? aiErr}\n${aiErr?.stack ?? "(no stack)"}`
        );
      }
    }

    await setScanStatus(certInfo.id, null);
    // Per-step timing for capacity sizing (server log ONLY, never client-exposed).
    // sharp + r2 come from uploadImagesToCert's internal split; ai = both Haiku
    // calls + TCG verify; total = the whole background pipeline (processing → done).
    // One scan in isolation gives clean, uncontended numbers for sizing 2 scanners.
    console.log(
      `[scan-timing] cert=${certInfo.certId} sharp=${timing.sharpMs.toFixed(0)}ms ai=${aiMs.toFixed(0)}ms r2=${timing.r2Ms.toFixed(0)}ms total=${elapsedMs(t0).toFixed(0)}ms`
    );
    console.log(`[process-scan] ready cert=${certInfo.certId}`);
  } catch (err: any) {
    console.error(
      `[process-scan] failed cert=${certInfo.certId}: ${err?.message ?? err}${pgErrorDetail(err)}\n${err?.stack ?? "(no stack)"}`
    );
    await setScanStatus(certInfo.id, "failed");
    try {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES (
          'certificate',
          ${String(certInfo.id)},
          'scan_processing_failed',
          'system',
          ${JSON.stringify({ certId: certInfo.certId, error: String(err?.message ?? err) })}::jsonb,
          NOW()
        )
      `);
    } catch {
      /* audit write best-effort */
    }
  }
}

/**
 * Upload front + back images to R2 and save paths to the certificate.
 * Runs the unified image-processing pipeline (deskew, tight crop,
 * deterministic re-centre, rounded-corner mask) — Phase Y convergence
 * with the admin CaptureWizard path.
 *
 * Writes per side:
 *   grading/{id}/{side}_original.jpg     — raw scan (AI "before" reference)
 *   grading/{id}/{side}_cropped.jpg      — flat cropped (AI consumption)
 *   grading/{id}/{side}_cropped.jpg      — flattened display (rounded corners
 *                                           baked into white; was PNG-with-alpha
 *                                           pre-2026-05-11 audit fix)
 *   grading/{id}/{side}_{variant}.jpg    — greyscale/highcontrast/etc
 *   images/{certId}/{side}.jpg           — canonical display key (front_image_path)
 */
export async function uploadImagesToCert(
  certId: number,
  frontBuffer: Buffer,
  backBuffer: Buffer | null
): Promise<{ frontVariants: any; backVariants: any | null; timing: { sharpMs: number; r2Ms: number } }> {
  const tImg = process.hrtime.bigint();
  const { maskRoundedCorners, tightenForDisplay } = await import("./image-processing");
  const sharp = (await import("sharp")).default;

  // Resolve cert number for display-key path (images/{CERT}/…). The stored
  // certificate_number is already normalised ("MV145", not "MV-0000000145");
  // fall back to synthesising from db id if somehow missing.
  const certRow = (await db.execute(sql`SELECT certificate_number FROM certificates WHERE id = ${certId}`))
    .rows[0] as any;
  const certNumber: string = (certRow?.certificate_number as string | undefined) ?? `MV${certId}`;

  // Resize raw scans (scanner output can be very large). Front + back run in
  // parallel — Sharp releases the JS thread during the native encode so a
  // single-core Fly box still benefits despite both calls being CPU-bound.
  //
  // Encoder is plain libjpeg-turbo baseline (no mozjpeg, no progressive).
  // This output is INTERMEDIATE — it's decoded immediately by
  // generateImageVariants, so the mozjpeg encode work was wasted. Baseline
  // saves ~30-40% per encode at no visual cost (the bytes are never served).
  const resizeBuf = async (buf: Buffer) =>
    sharp(buf)
      .rotate()
      .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

  const [frontResized, backResized] = await Promise.all([
    resizeBuf(frontBuffer),
    backBuffer ? resizeBuf(backBuffer) : Promise.resolve(null),
  ]);

  // Generate variants via the unified pipeline (deskew + autoCrop + reCentre).
  // Pass certNumber so card-detect logs are traceable per cert (Fix 0).
  // Parallelised across sides — same rationale as the resize step above.
  const [frontVariants, backVariants] = await Promise.all([
    generateImageVariants(frontResized, certNumber),
    backResized ? generateImageVariants(backResized, certNumber) : Promise.resolve(null),
  ]);

  // Derive display-ready artefacts. The pipeline is:
  //   centredUnpadded → tightenForDisplay (second card-detect, no safety pad)
  //                   → maskRoundedCorners
  //                   → {toDisplayPng, toDisplayJpeg}
  //
  // Two encodings from a single masked buffer:
  //   - PNG with alpha-transparent rounded corners → canonical display key
  //     (front_image_path). Renders cleanly on both light and dark page bg.
  //   - JPEG with flatten-to-white rounded corners → front_cropped.jpg key
  //     (compatibility — DGR PDF and other consumers that expect a JPEG).
  //
  // Why tightenForDisplay instead of the earlier 10 px uniform inset (which
  // was the v592 trimForDisplay):
  //   - centredUnpadded carries an 8 px safety-pad strip from the FIRST
  //     card-detect pass (cropToCardBoundary). At full-res that scales to
  //     ~16–26 px of mat-coloured pixels on every side.
  //   - A uniform 10 px inset left a ~10 px visible strip of mat colour
  //     on the straight sides of the rounded mask — Cornelius's "thin
  //     frame around the card" report (v593 backfill).
  //   - tightenForDisplay re-runs detectCardBoundary with safetyPadPx=0 on
  //     this clean centred buffer. Card-edge contrast against the safety
  //     strip is strong and uniform, so zero-pad detection is safe here
  //     (unlike the first pass, which needs the pad against tilted scans).
  //   - Falls back to a 16 px uniform inset if detection fails.
  //
  // NOTE (rev 3b29948 → reverted): a previous attempt collapsed mask+flatten
  // into a single inline sharp() pipeline. That clipped the right edge of
  // cards on prod (v587). Keep the two-stage split — materialising between
  // mask and encode sidesteps a libvips pipeline-reordering bug. Don't
  // re-collapse without a visual diff harness.
  async function toDisplayPng(buf: Buffer): Promise<Buffer> {
    // No flatten — maskRoundedCorners already produced alpha=0 at the
    // rounded corners (image-processing.ts:38-50). Encode as PNG to keep
    // transparency.
    return sharp(buf).png({ compressionLevel: 9 }).toBuffer();
  }
  async function toDisplayJpeg(buf: Buffer): Promise<Buffer> {
    return sharp(buf)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer();
  }

  const frontUnpadded = (frontVariants as any).centredUnpadded as Buffer | undefined;
  const frontTight = await tightenForDisplay(frontUnpadded ?? frontVariants.cropped, certNumber, undefined, "front");
  const frontMaskedPng = await maskRoundedCorners(frontTight);
  const frontDisplayPng = await toDisplayPng(frontMaskedPng);
  const frontDisplayJpeg = await toDisplayJpeg(frontMaskedPng);

  const backUnpadded = backVariants ? ((backVariants as any).centredUnpadded as Buffer | undefined) : undefined;
  const backTight = backVariants
    ? await tightenForDisplay(backUnpadded ?? backVariants.cropped, certNumber, undefined, "back")
    : null;
  const backMaskedPng = backTight ? await maskRoundedCorners(backTight) : null;
  const backDisplayPng = backMaskedPng ? await toDisplayPng(backMaskedPng) : null;
  const backDisplayJpeg = backMaskedPng ? await toDisplayJpeg(backMaskedPng) : null;

  // All sharp/variant generation (resize + variants + display derivatives) is
  // done above; the R2 PUTs are kicked off + awaited below. This split is the
  // basis for the [scan-timing] sharp vs r2 numbers (small overlap: a couple of
  // PUTs start during the build, and makeDisplayDerivative does a tiny resize
  // inside the upload — counted under r2; negligible for sizing).
  const sharpMs = elapsedMs(tImg);

  // Upload all to R2 — explicit extension map per variant kind
  const prefix = `images/grading/${certId}`;
  const uploadKeys: Record<string, string> = {};
  const uploads: Promise<void>[] = [];

  // Flat JPG variants (including cropped — kept .jpg for AI compatibility with the old key shape)
  const jpgVariants = ["original", "cropped", "greyscale", "highcontrast", "edgeenhanced", "inverted"] as const;
  for (const vName of jpgVariants) {
    const buf = (frontVariants as any)[vName] as Buffer | undefined;
    if (!buf) continue;
    const k = `${prefix}/front_${vName}.jpg`;
    uploadKeys[`front_${vName}`] = k;
    uploads.push(uploadToR2(k, buf, "image/jpeg").then(() => {}));
  }
  if (backVariants) {
    for (const vName of jpgVariants) {
      const buf = (backVariants as any)[vName] as Buffer | undefined;
      if (!buf) continue;
      const k = `${prefix}/back_${vName}.jpg`;
      uploadKeys[`back_${vName}`] = k;
      uploads.push(uploadToR2(k, buf, "image/jpeg").then(() => {}));
    }
  }

  // Canonical display key → PNG with alpha-transparent rounded corners.
  // front_cropped.jpg → flatten-white JPEG (kept for DGR PDF + any other
  // consumer that expects a JPEG; same mask + trim as the PNG, just a
  // different encoding). DB column front_image_path / back_image_path are
  // extension-agnostic text — consumers derive media-type from the key.
  const frontJpegKey = `${prefix}/front_cropped.jpg`;
  const frontDisplayKey = `images/${certNumber}/front.png`;
  uploadKeys["front_cropped_display"] = frontJpegKey;
  uploadKeys["front_display"] = frontDisplayKey;
  uploads.push(uploadToR2(frontJpegKey, frontDisplayJpeg, "image/jpeg").then(() => {}));
  uploads.push(uploadToR2(frontDisplayKey, frontDisplayPng, "image/png").then(() => {}));
  if (backDisplayJpeg && backDisplayPng) {
    const backJpegKey = `${prefix}/back_cropped.jpg`;
    const backDisplayKey = `images/${certNumber}/back.png`;
    uploadKeys["back_cropped_display"] = backJpegKey;
    uploadKeys["back_display"] = backDisplayKey;
    uploads.push(uploadToR2(backJpegKey, backDisplayJpeg, "image/jpeg").then(() => {}));
    uploads.push(uploadToR2(backDisplayKey, backDisplayPng, "image/png").then(() => {}));
  }

  // 1600px q80 viewer derivatives — the grading panel loads these instead of
  // the full-res cropped JPEGs (which stay as the zoom/manual-tool source).
  const { makeDisplayDerivative } = await import("./image-processing");
  const frontViewerKey = `${prefix}/front_display.jpg`;
  uploadKeys["front_viewer_display"] = frontViewerKey;
  uploads.push(
    makeDisplayDerivative(frontDisplayJpeg)
      .then((buf) => uploadToR2(frontViewerKey, buf, "image/jpeg"))
      .then(() => {})
  );
  if (backDisplayJpeg) {
    const backViewerKey = `${prefix}/back_display.jpg`;
    uploadKeys["back_viewer_display"] = backViewerKey;
    uploads.push(
      makeDisplayDerivative(backDisplayJpeg)
        .then((buf) => uploadToR2(backViewerKey, buf, "image/jpeg"))
        .then(() => {})
    );
  }

  const tR2 = process.hrtime.bigint();
  await Promise.all(uploads);
  const r2Ms = elapsedMs(tR2);
  console.log(`[scan-ingest] cert=${certId}: uploaded ${uploads.length} image artefacts to R2 (incl. display PNG)`);

  // Persist R2 keys + crop_geometry forensics
  const cropGeometry = {
    front: (frontVariants as any).cropGeometry ?? null,
    back: backVariants ? ((backVariants as any).cropGeometry ?? null) : null,
    pipeline_version: "converged_v1",
    recorded_at: new Date().toISOString(),
  };

  await db.execute(sql`
    UPDATE certificates SET
      grading_front_original    = ${uploadKeys.front_original || null},
      grading_front_cropped     = ${uploadKeys.front_cropped_display || uploadKeys.front_cropped_png || uploadKeys.front_cropped || null},
      grading_front_greyscale   = ${uploadKeys.front_greyscale || null},
      grading_front_highcontrast = ${uploadKeys.front_highcontrast || null},
      grading_front_edgeenhanced = ${uploadKeys.front_edgeenhanced || null},
      grading_front_inverted    = ${uploadKeys.front_inverted || null},
      grading_back_original     = ${uploadKeys.back_original || null},
      grading_back_cropped      = ${uploadKeys.back_cropped_display || uploadKeys.back_cropped_png || uploadKeys.back_cropped || null},
      grading_back_greyscale    = ${uploadKeys.back_greyscale || null},
      grading_back_highcontrast  = ${uploadKeys.back_highcontrast || null},
      grading_back_edgeenhanced  = ${uploadKeys.back_edgeenhanced || null},
      grading_back_inverted     = ${uploadKeys.back_inverted || null},
      grading_front_display     = ${uploadKeys.front_viewer_display || null},
      grading_back_display      = ${uploadKeys.back_viewer_display || null},
      front_image_path          = ${uploadKeys.front_display || uploadKeys.front_cropped_display || uploadKeys.front_cropped_png || uploadKeys.front_cropped || uploadKeys.front_original || null},
      back_image_path           = ${uploadKeys.back_display || uploadKeys.back_cropped_display || uploadKeys.back_cropped_png || uploadKeys.back_cropped || uploadKeys.back_original || null},
      crop_geometry             = ${JSON.stringify(cropGeometry)}::jsonb,
      updated_at                = NOW()
    WHERE id = ${certId}
  `);

  return { frontVariants, backVariants, timing: { sharpMs, r2Ms } };
}

/**
 * Option A (minimum fast path): scan-time AI runs two Haiku 4.5 calls in
 * parallel — identification and centering measurement. The Haiku grade
 * call (gradeCardFromBuffer) is the only fast Haiku route that returns
 * centering data, so we still invoke it; but we only persist the
 * centering portion of its response on ingest. Corners/edges/surface/
 * overall are deferred to the admin's manual triggers from the grading
 * panel ("Detect Defects" / "Run All" / "Analyze with AI (Full)").
 *
 * Defect candidates are not generated automatically here either.
 *
 * Returns identification fields for the response payload; grade is null
 * on the fast path (admin's manual grade trigger fills it in).
 */
export async function runAiOnCert(
  certId: number,
  frontCropped: Buffer,
  backCropped: Buffer | null
): Promise<{ cardName: string | null; grade: number | string | null; strengthScore: number | null }> {
  // Master kill-switch (admin-facing) — DB-backed pipeline setting that
  // admins flip from /admin/weekly-reel. Defaults to true so default
  // deploy behaviour is "auto-AI on", matching the pre-flag era. Setting
  // it false in the UI skips all auto-AI work; admin triggers AI manually
  // from the grading panel.
  const { getSetting } = await import("./lib/pipeline-settings");
  const autoOn = await getSetting("ai_auto_ingest_enabled", true);
  if (!autoOn) {
    console.log(`[ai] skip auto-trigger: ai_auto_ingest_enabled is off for cert ${certId}`);
    return { cardName: null, grade: null, strengthScore: null };
  }

  // Resolve the MV-number for diagnostic context (retry logs, error traces).
  let certTag: string | number = certId;
  try {
    const r = await db.execute(sql`SELECT certificate_number FROM certificates WHERE id = ${certId}`);
    const row = r.rows[0] as any;
    if (row?.certificate_number) certTag = row.certificate_number;
  } catch {
    /* best-effort — fall back to numeric id */
  }

  // Two parallel Haiku calls — identify + the grade call (used here only
  // to extract centering; full grade is deferred to the admin's manual
  // trigger). gradeCardFromBuffer is the only Haiku route that returns
  // centering data; we discard corners/edges/surface/overall below.
  const [identification, aiGrading] = await Promise.all([
    identifyCardFromBuffer(frontCropped, "image/jpeg", certTag),
    gradeCardFromBuffer(frontCropped, backCropped, certTag),
  ]);

  const game = identification.detected_game?.toLowerCase() || "other";
  let enrichedId = await verifyAndEnrichCardData(identification);
  let tcgVerified = false;

  if (game === "pokemon") {
    const tcgResult = await verifyPokemonCardWithTcgApi(
      identification.detected_name,
      identification.detected_number,
      identification.detected_rarity,
      identification.set_code,
      identification.copyright_year
    );
    if (tcgResult.verified) {
      enrichedId = {
        ...enrichedId,
        verified: true,
        officialName: tcgResult.officialCardName || enrichedId.officialName,
        officialSet: tcgResult.officialSetName || enrichedId.officialSet,
        officialNumber: identification.detected_number,
        referenceImageUrl: tcgResult.referenceImageUrl || enrichedId.referenceImageUrl,
        dbSource: "pokemon-tcg-api",
        detected_set: tcgResult.officialSetName || enrichedId.detected_set,
        detected_rarity: tcgResult.officialRarity || enrichedId.detected_rarity,
        detected_year: tcgResult.officialYear || enrichedId.detected_year,
      };
      tcgVerified = true;
    }
  }

  // Step 3: Determine which identification fields are confident enough to
  // write through to the DB. Most fields gate on (tcgVerified || high
  // confidence). card_game is special — it's a closed enum derived from the
  // AI's view of the card type, and even at "medium" confidence it's
  // overwhelmingly correct ("is this a Pokémon card?" is much easier than
  // "exact set / number"). Always write card_game when the AI returned a
  // known slug, so the form's Card Game dropdown auto-populates and "Search
  // TCG" gates unblock — even when set/number weren't confident.
  const aiConfidence = identification.confidence || "low";
  const shouldWriteDetails = tcgVerified || aiConfidence === "high";
  const cardName = shouldWriteDetails ? enrichedId.officialName || enrichedId.detected_name || null : null;
  const setName = tcgVerified ? enrichedId.officialSet || enrichedId.detected_set || null : null;
  const cardNumber = shouldWriteDetails ? enrichedId.detected_number || null : null;
  const cardGame =
    enrichedId.detected_game && enrichedId.detected_game !== "other"
      ? enrichedId.detected_game
      : shouldWriteDetails
        ? enrichedId.detected_game || null
        : null;
  const rarity = shouldWriteDetails ? enrichedId.detected_rarity || null : null;

  // Year derivation — kept consistent with routes.ts identify-and-analyze.
  // Prefer Claude's copyright_year, fall back to TCG-verified detected_year.
  // Reject AI-only years > 5y from current year unless TCG confirmed.
  let yearText: string | null = null;
  if (shouldWriteDetails) {
    const rawYear = identification.copyright_year || enrichedId.detected_year || null;
    const match = rawYear ? String(rawYear).match(/\d{4}/) : null;
    yearText = match ? match[0] : null;
    if (yearText && !tcgVerified) {
      const y = parseInt(yearText, 10);
      const currentYear = new Date().getFullYear();
      if (isNaN(y) || Math.abs(y - currentYear) > 5) {
        console.warn(`[scan-ingest] year guard: AI guessed ${yearText} but TCG didn't verify — clearing`);
        yearText = null;
      }
    }
  }

  // Step 4: Save identification (always safe to overwrite — non-graded
  // metadata). ai_analysis carries the identification snapshot and, when
  // available, just the centering portion of the Haiku grade response.
  // The rest of the grade payload (corners/edges/surface/overall) is
  // discarded here so ai_analysis honestly reflects what got persisted.
  const aiAnalysisPayload: Record<string, unknown> = {
    identification: enrichedId,
    model: "claude-haiku-4-5-20251001",
    pipeline: "option_a_fast",
  };
  if (aiGrading) {
    aiAnalysisPayload.centering = aiGrading.centering;
  }

  // ai_defect_candidates intentionally NOT written here — the manual
  // "Detect Defects" endpoint owns that column on first user trigger.
  await db.execute(sql`
    UPDATE certificates SET
      ai_analysis = ${JSON.stringify(aiAnalysisPayload)}::jsonb,
      card_name = CASE WHEN card_name IS NULL OR card_name = '' THEN ${cardName} ELSE card_name END,
      set_name = CASE WHEN set_name IS NULL OR set_name = '' THEN ${setName} ELSE set_name END,
      card_number_display = CASE WHEN card_number_display IS NULL OR card_number_display = '' THEN ${cardNumber} ELSE card_number_display END,
      card_game = CASE WHEN card_game IS NULL OR card_game = '' THEN ${cardGame} ELSE card_game END,
      rarity = CASE WHEN rarity IS NULL OR rarity = '' THEN ${rarity} ELSE rarity END,
      year_text = CASE WHEN year_text IS NULL OR year_text = '' THEN ${yearText} ELSE year_text END,
      updated_at = NOW()
    WHERE id = ${certId}
  `);

  // Step 5: Persist ONLY centering on the fast path. Per-zone grading
  // (corners/edges/surface) and ai_draft_grade are deliberately not written
  // on ingest — the admin triggers those manually via the grading panel
  // (Detect Defects / Run All / Analyze with AI (Full)).
  //
  // Gated on `grade_approved_at IS NULL` — re-scanning an already-approved
  // cert must NEVER overwrite the published grade. centering_score column
  // is also CASE-guarded so we don't clobber a value the admin already
  // chose during their first review pass.
  let centeringWritten = false;
  if (aiGrading) {
    const result = await db.execute(sql`
      UPDATE certificates SET
        centering_score    = CASE WHEN centering_score IS NULL THEN ${aiGrading.centering.subgrade}::numeric ELSE centering_score END,
        centering_front_lr = COALESCE(${aiGrading.centering.front_left_right}, centering_front_lr),
        centering_front_tb = COALESCE(${aiGrading.centering.front_top_bottom}, centering_front_tb),
        centering_back_lr  = COALESCE(${aiGrading.centering.back_left_right},  centering_back_lr),
        centering_back_tb  = COALESCE(${aiGrading.centering.back_top_bottom},  centering_back_tb),
        updated_at         = NOW()
      WHERE id = ${certId} AND grade_approved_at IS NULL
    `);
    centeringWritten = (result.rowCount ?? 0) > 0;
    if (!centeringWritten) {
      console.log(`[scan-ingest] cert=${certId}: cert already approved — centering skipped, ai_analysis snapshot only`);
    }
  }

  // Audit row — model + per-call decision context. Keeps a paper trail of
  // what the cheaper Haiku pipeline actually wrote.
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
    VALUES (
      'certificate',
      ${String(certId)},
      'ai_scan_ingest',
      'system',
      ${JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        pipeline: "option_a_fast",
        operations: aiGrading ? ["identify", "centering"] : ["identify"],
        identification_confidence: aiConfidence,
        tcg_verified: tcgVerified,
        card_game: cardGame,
        card_name: cardName,
        centering_subgrade: aiGrading?.centering?.subgrade ?? null,
        centering_persisted: centeringWritten,
      })}::jsonb,
      NOW()
    )
  `);

  const centeringSubgrade = aiGrading?.centering?.subgrade ?? null;
  console.log(
    `[scan-ingest] cert=${certId}: Option-A fast-path complete (identify + centering only) — card="${cardName}" game=${cardGame} centering=${centeringSubgrade} persisted=${centeringWritten}`
  );
  return { cardName, grade: null, strengthScore: null };
}

// ── Auto-trigger gate ──────────────────────────────────────────────────────
// In-process map of AI calls fired automatically (e.g. by the upload-images
// handler on first full upload). Only the automatic trigger registers here;
// manual endpoints (measure-centering, detect-defects, grade-card) deliberately
// don't participate — user-initiated races are their choice. The map prevents
// duplicate auto-fires from racing each other (e.g. front + back uploaded as
// separate requests that each see empty ai_analysis). Cleared on process exit.

const inFlightAutoAi = new Map<number, Promise<unknown>>();

/**
 * Fire runAiOnCert only if no auto-triggered AI call is currently in flight
 * for this cert. The DB-backed `ai_auto_ingest_enabled` kill-switch is
 * checked inside runAiOnCert itself (returns an empty result when off),
 * so this wrapper stays synchronous and the caller's `if (promise) {…}`
 * pattern doesn't need to change.
 */
export function runAiOnCertIfIdle(
  certId: number,
  frontCropped: Buffer,
  backCropped: Buffer | null
): Promise<{ cardName: string | null; grade: number | string | null; strengthScore: number | null }> | null {
  if (inFlightAutoAi.has(certId)) {
    console.log(`[ai] skip auto-trigger: already in-flight for cert ${certId}`);
    return null;
  }
  const p = runAiOnCert(certId, frontCropped, backCropped).finally(() => {
    inFlightAutoAi.delete(certId);
  });
  inFlightAutoAi.set(certId, p);
  return p;
}
