/**
 * Scan-ingest service — shared business logic for creating certs from scanner uploads.
 *
 * Extracted from routes.ts handlers so both the existing admin endpoints
 * and the new scan-ingest endpoint can reuse the same code paths.
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { uploadToR2 } from "./r2";
import { generateImageVariants, identifyCardFromBuffer, verifyAndEnrichCardData, verifyPokemonCardWithTcgApi, analyzeCardFromBuffers, type EnrichedCardData } from "./ai-grading-service";

/**
 * Create a new certificate for an admin scan.
 * Returns the DB row with id and certificate_number.
 */
export async function createCertForScan(): Promise<{ id: number; certId: string; referenceNumber: string }> {
  const { generateReferenceNumber } = await import("./reference-number");
  const certNumber = await storage.getNextCertId();
  const refNum = generateReferenceNumber();

  const result = await db.execute(sql`
    INSERT INTO certificates (certificate_number, status, label_type, grade_type, language, card_name, created_by, issued_at, updated_at, reference_number, source)
    VALUES (${certNumber}, 'active', 'Standard', 'numeric', 'English', NULL, 'admin_scan', NOW(), NOW(), ${refNum}, 'admin_scan')
    RETURNING id, certificate_number
  `);

  const row = result.rows[0] as any;
  // Normalise cert ID (MV-0000000134 → MV134)
  const normalised = row.certificate_number.replace(/^MV-?0+/, "MV");

  console.log(`[scan-ingest] created cert ${normalised} (id=${row.id}) with ref=${refNum}`);
  return { id: row.id, certId: normalised, referenceNumber: refNum };
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
 *   grading/{id}/{side}_cropped.png      — masked display (alpha corners)
 *   grading/{id}/{side}_{variant}.jpg    — greyscale/highcontrast/etc
 *   images/{certId}/{side}.png           — canonical display key (front_image_path)
 */
export async function uploadImagesToCert(
  certId: number,
  frontBuffer: Buffer,
  backBuffer: Buffer | null,
): Promise<{ frontVariants: any; backVariants: any | null }> {
  const { maskRoundedCorners } = await import("./image-processing");
  const sharp = (await import("sharp")).default;

  // Resolve cert number for display-key path (images/{CERT}/…). The stored
  // certificate_number is already normalised ("MV145", not "MV-0000000145");
  // fall back to synthesising from db id if somehow missing.
  const certRow = (await db.execute(sql`SELECT certificate_number FROM certificates WHERE id = ${certId}`)).rows[0] as any;
  const certNumber: string = (certRow?.certificate_number as string | undefined) ?? `MV${certId}`;

  // Resize raw scans (scanner output can be very large)
  const resizeBuf = async (buf: Buffer) =>
    sharp(buf).rotate().resize(3000, 3000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();

  const frontResized = await resizeBuf(frontBuffer);
  const backResized = backBuffer ? await resizeBuf(backBuffer) : null;

  // Generate variants via the unified pipeline (deskew + autoCrop + reCentre)
  const frontVariants = await generateImageVariants(frontResized);
  const backVariants = backResized ? await generateImageVariants(backResized) : null;

  // Derive display-ready masked PNGs from the flat cropped output
  const frontMaskedPng = await maskRoundedCorners(frontVariants.cropped);
  const backMaskedPng = backVariants ? await maskRoundedCorners(backVariants.cropped) : null;

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

  // Masked display PNG (with alpha rounded corners) + canonical display key
  const frontPngKey = `${prefix}/front_cropped.png`;
  const frontDisplayKey = `images/${certNumber}/front.png`;
  uploadKeys["front_cropped_png"] = frontPngKey;
  uploadKeys["front_display"] = frontDisplayKey;
  uploads.push(uploadToR2(frontPngKey, frontMaskedPng, "image/png").then(() => {}));
  uploads.push(uploadToR2(frontDisplayKey, frontMaskedPng, "image/png").then(() => {}));
  if (backMaskedPng) {
    const backPngKey = `${prefix}/back_cropped.png`;
    const backDisplayKey = `images/${certNumber}/back.png`;
    uploadKeys["back_cropped_png"] = backPngKey;
    uploadKeys["back_display"] = backDisplayKey;
    uploads.push(uploadToR2(backPngKey, backMaskedPng, "image/png").then(() => {}));
    uploads.push(uploadToR2(backDisplayKey, backMaskedPng, "image/png").then(() => {}));
  }

  await Promise.all(uploads);
  console.log(`[scan-ingest] cert=${certId}: uploaded ${uploads.length} image artefacts to R2 (incl. display PNG)`);

  // Persist R2 keys + crop_geometry forensics
  const cropGeometry = {
    front: (frontVariants as any).cropGeometry ?? null,
    back: backVariants ? (backVariants as any).cropGeometry ?? null : null,
    pipeline_version: "converged_v1",
    recorded_at: new Date().toISOString(),
  };

  await db.execute(sql`
    UPDATE certificates SET
      grading_front_original    = ${uploadKeys.front_original || null},
      grading_front_cropped     = ${uploadKeys.front_cropped_png || uploadKeys.front_cropped || null},
      grading_front_greyscale   = ${uploadKeys.front_greyscale || null},
      grading_front_highcontrast = ${uploadKeys.front_highcontrast || null},
      grading_front_edgeenhanced = ${uploadKeys.front_edgeenhanced || null},
      grading_front_inverted    = ${uploadKeys.front_inverted || null},
      grading_back_original     = ${uploadKeys.back_original || null},
      grading_back_cropped      = ${uploadKeys.back_cropped_png || uploadKeys.back_cropped || null},
      grading_back_greyscale    = ${uploadKeys.back_greyscale || null},
      grading_back_highcontrast  = ${uploadKeys.back_highcontrast || null},
      grading_back_edgeenhanced  = ${uploadKeys.back_edgeenhanced || null},
      grading_back_inverted     = ${uploadKeys.back_inverted || null},
      front_image_path          = ${uploadKeys.front_display || uploadKeys.front_cropped_png || uploadKeys.front_cropped || uploadKeys.front_original || null},
      back_image_path           = ${uploadKeys.back_display || uploadKeys.back_cropped_png || uploadKeys.back_cropped || uploadKeys.back_original || null},
      crop_geometry             = ${JSON.stringify(cropGeometry)}::jsonb,
      updated_at                = NOW()
    WHERE id = ${certId}
  `);

  return { frontVariants, backVariants };
}

/**
 * Run AI identification + grading on a certificate's images.
 * Uses cropped variants already uploaded to R2.
 */
export async function runAiOnCert(
  certId: number,
  frontCropped: Buffer,
  backCropped: Buffer | null,
): Promise<{ cardName: string | null; grade: number | string | null; strengthScore: number | null }> {
  // Resolve the MV-number for diagnostic context (retry logs, error traces).
  // One extra lookup on a path that already takes 30-90s — negligible.
  let certTag: string | number = certId;
  try {
    const r = await db.execute(sql`SELECT certificate_number FROM certificates WHERE id = ${certId}`);
    const row = r.rows[0] as any;
    if (row?.certificate_number) certTag = row.certificate_number;
  } catch { /* best-effort — fall back to numeric id */ }

  // Step 1: Identify the card
  const identification = await identifyCardFromBuffer(frontCropped, "image/jpeg", certTag);
  const game = identification.detected_game?.toLowerCase();

  let enrichedId = await verifyAndEnrichCardData(identification);
  let tcgVerified = false;

  if (game === "pokemon") {
    const tcgResult = await verifyPokemonCardWithTcgApi(
      identification.detected_name,
      identification.detected_number,
      identification.detected_rarity,
      identification.set_code,
      identification.copyright_year,
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

  // Step 2: Full grading analysis
  const analysis = await analyzeCardFromBuffers(frontCropped, backCropped, game, certTag);

  // Step 3: Extract strength score
  const strengthScore = typeof (analysis as any).grade_strength_score === "number"
    ? Math.max(0, Math.min(100, Math.round((analysis as any).grade_strength_score)))
    : null;

  // Step 4: Determine card details to write
  const aiConfidence = identification.confidence || "low";
  const shouldWriteDetails = tcgVerified || aiConfidence === "high";
  const cardName = shouldWriteDetails ? (enrichedId.officialName || enrichedId.detected_name || null) : null;
  const setName = tcgVerified ? (enrichedId.officialSet || enrichedId.detected_set || null) : null;
  const cardNumber = shouldWriteDetails ? (enrichedId.detected_number || null) : null;
  const cardGame = shouldWriteDetails ? (enrichedId.detected_game || null) : null;
  const rarity = shouldWriteDetails ? (enrichedId.detected_rarity || null) : null;

  // Step 5: Save to certificate
  await db.execute(sql`
    UPDATE certificates SET
      ai_analysis = ${JSON.stringify({ identification: enrichedId, grading: analysis })}::jsonb,
      ai_draft_grade = ${typeof analysis.overall_grade === "number" ? analysis.overall_grade : null},
      card_name = CASE WHEN card_name IS NULL OR card_name = '' THEN ${cardName} ELSE card_name END,
      set_name = CASE WHEN set_name IS NULL OR set_name = '' THEN ${setName} ELSE set_name END,
      card_number_display = CASE WHEN card_number_display IS NULL OR card_number_display = '' THEN ${cardNumber} ELSE card_number_display END,
      card_game = CASE WHEN card_game IS NULL OR card_game = '' THEN ${cardGame} ELSE card_game END,
      rarity = CASE WHEN rarity IS NULL OR rarity = '' THEN ${rarity} ELSE rarity END,
      grade_strength_score = ${strengthScore},
      updated_at = NOW()
    WHERE id = ${certId}
  `);

  const gradeValue = typeof analysis.overall_grade === "number" ? analysis.overall_grade : null;
  console.log(`[scan-ingest] cert=${certId}: AI complete — card="${cardName}" grade=${gradeValue} strength=${strengthScore}`);

  return { cardName, grade: gradeValue, strengthScore };
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
 * for this cert. Returns the promise if fired, or null if skipped.
 * Use this from automatic trigger paths only.
 */
export function runAiOnCertIfIdle(
  certId: number,
  frontCropped: Buffer,
  backCropped: Buffer | null,
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
