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
import { generateImageVariants, identifyCardFromBuffer, verifyAndEnrichCardData, verifyPokemonCardWithTcgApi, suggestDefectsFromBuffer, gradeCardFromBuffer, type EnrichedCardData, type DefectCandidate, type AiGrading } from "./ai-grading-service";

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
  const { maskRoundedCorners, padWithMat } = await import("./image-processing");
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

  // Generate variants via the unified pipeline (deskew + autoCrop + reCentre).
  // Pass certNumber so card-detect logs are traceable per cert (Fix 0).
  const frontVariants = await generateImageVariants(frontResized, certNumber);
  const backVariants = backResized ? await generateImageVariants(backResized, certNumber) : null;

  // Derive display-ready masked PNGs. Order matters: mask the un-padded
  // centred buffer (so the rounded-corner alpha mask sits on the actual
  // card corners, not pushed out to the bitmap corners after padding),
  // THEN pad the masked PNG with mat. Without this order, the rounded
  // corners would be invisible in the final image because the bitmap
  // edges are now far from the card.
  const frontMatRgb = (frontVariants as any).matRgb || { r: 255, g: 255, b: 255 };
  const frontUnpadded = (frontVariants as any).centredUnpadded as Buffer | undefined;
  const frontMaskedPng = frontUnpadded
    ? await padWithMat(await maskRoundedCorners(frontUnpadded), frontMatRgb)
    : await maskRoundedCorners(frontVariants.cropped); // fallback: pre-padding buffer absent (shouldn't happen on Option B path)

  const backMatRgb = backVariants ? ((backVariants as any).matRgb || { r: 255, g: 255, b: 255 }) : null;
  const backUnpadded = backVariants ? ((backVariants as any).centredUnpadded as Buffer | undefined) : undefined;
  const backMaskedPng = backVariants
    ? (backUnpadded
        ? await padWithMat(await maskRoundedCorners(backUnpadded), backMatRgb!)
        : await maskRoundedCorners(backVariants.cropped))
    : null;

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
 * Option A: scan-time AI runs three Haiku 4.5 calls in parallel —
 * identification, defect candidates, and per-zone grading. The grading
 * pre-populates the form so the admin reviews + verifies + approves
 * rather than starting from zero. Marketing positioning: "AI-graded,
 * human-verified".
 *
 * Returns identification fields for the response payload; grade reflects
 * the AI's overall_grade (admin can override pre-approve).
 */
export async function runAiOnCert(
  certId: number,
  frontCropped: Buffer,
  backCropped: Buffer | null,
): Promise<{ cardName: string | null; grade: number | string | null; strengthScore: number | null }> {
  // Resolve the MV-number for diagnostic context (retry logs, error traces).
  let certTag: string | number = certId;
  try {
    const r = await db.execute(sql`SELECT certificate_number FROM certificates WHERE id = ${certId}`);
    const row = r.rows[0] as any;
    if (row?.certificate_number) certTag = row.certificate_number;
  } catch { /* best-effort — fall back to numeric id */ }

  // Three parallel Haiku calls. All three Haiku, no shared rate-limit
  // contention beyond what rateLimit() already enforces.
  const [identification, defectCandidates, aiGrading] = await Promise.all([
    identifyCardFromBuffer(frontCropped, "image/jpeg", certTag),
    suggestDefectsFromBuffer(frontCropped, backCropped, certTag),
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
  const cardName = shouldWriteDetails ? (enrichedId.officialName || enrichedId.detected_name || null) : null;
  const setName = tcgVerified ? (enrichedId.officialSet || enrichedId.detected_set || null) : null;
  const cardNumber = shouldWriteDetails ? (enrichedId.detected_number || null) : null;
  const cardGame = enrichedId.detected_game && enrichedId.detected_game !== "other"
    ? enrichedId.detected_game
    : (shouldWriteDetails ? (enrichedId.detected_game || null) : null);
  const rarity = shouldWriteDetails ? (enrichedId.detected_rarity || null) : null;

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

  // Step 4: Save identification + defect candidates first (always safe to
  // overwrite — these are non-graded metadata). ai_analysis carries the
  // identification snapshot AND the AI grading payload (when successful)
  // alongside the model/pipeline tag.
  const aiAnalysisPayload: Record<string, unknown> = {
    identification: enrichedId,
    model: "claude-haiku-4-5-20251001",
    pipeline: "option_a",
  };
  if (aiGrading) {
    aiAnalysisPayload.grading = aiGrading;
  }

  await db.execute(sql`
    UPDATE certificates SET
      ai_analysis = ${JSON.stringify(aiAnalysisPayload)}::jsonb,
      ai_defect_candidates = ${JSON.stringify(defectCandidates)}::jsonb,
      card_name = CASE WHEN card_name IS NULL OR card_name = '' THEN ${cardName} ELSE card_name END,
      set_name = CASE WHEN set_name IS NULL OR set_name = '' THEN ${setName} ELSE set_name END,
      card_number_display = CASE WHEN card_number_display IS NULL OR card_number_display = '' THEN ${cardNumber} ELSE card_number_display END,
      card_game = CASE WHEN card_game IS NULL OR card_game = '' THEN ${cardGame} ELSE card_game END,
      rarity = CASE WHEN rarity IS NULL OR rarity = '' THEN ${rarity} ELSE rarity END,
      year_text = CASE WHEN year_text IS NULL OR year_text = '' THEN ${yearText} ELSE year_text END,
      updated_at = NOW()
    WHERE id = ${certId}
  `);

  // Step 5: Persist AI grading values into the per-zone columns. Gated on
  // `grade_approved_at IS NULL` — re-scanning an already-approved cert
  // must NEVER overwrite the published grade. The CASE WHEN is column-
  // level too, but the WHERE gate is the durable safety net: if a row
  // has been approved, this UPDATE simply doesn't fire.
  let gradeWritten = false;
  if (aiGrading) {
    const cornerValues = {
      frontTL: aiGrading.corners.front_top_left,
      frontTR: aiGrading.corners.front_top_right,
      frontBL: aiGrading.corners.front_bottom_left,
      frontBR: aiGrading.corners.front_bottom_right,
      backTL:  aiGrading.corners.back_top_left,
      backTR:  aiGrading.corners.back_top_right,
      backBL:  aiGrading.corners.back_bottom_left,
      backBR:  aiGrading.corners.back_bottom_right,
    };
    const edgeValues = {
      frontTop:    aiGrading.edges.front_top,
      frontRight:  aiGrading.edges.front_right,
      frontBottom: aiGrading.edges.front_bottom,
      frontLeft:   aiGrading.edges.front_left,
      backTop:     aiGrading.edges.back_top,
      backRight:   aiGrading.edges.back_right,
      backBottom:  aiGrading.edges.back_bottom,
      backLeft:    aiGrading.edges.back_left,
    };
    const surfaceValues = {
      front: aiGrading.surface.front_grade,
      back:  aiGrading.surface.back_grade,
      hasPrintLines:       aiGrading.surface.has_print_lines       || false,
      hasHoloScratches:    aiGrading.surface.has_holo_scratches    || false,
      hasSurfaceScratches: aiGrading.surface.has_surface_scratches || false,
      hasStaining:         aiGrading.surface.has_staining          || false,
      hasIndentation:      false,
      hasRollerMarks:      false,
      hasColorRegistration: false,
      hasCrease:           aiGrading.surface.has_crease            || false,
      hasTear:             aiGrading.surface.has_tear              || false,
    };

    const result = await db.execute(sql`
      UPDATE certificates SET
        corner_values        = ${JSON.stringify(cornerValues)}::jsonb,
        edge_values          = ${JSON.stringify(edgeValues)}::jsonb,
        surface_values       = ${JSON.stringify(surfaceValues)}::jsonb,
        centering_score      = ${aiGrading.centering.subgrade}::numeric,
        corners_score        = ${aiGrading.corners.subgrade}::numeric,
        edges_score          = ${aiGrading.edges.subgrade}::numeric,
        surface_score        = ${aiGrading.surface.subgrade}::numeric,
        centering_front_lr   = COALESCE(${aiGrading.centering.front_left_right}, centering_front_lr),
        centering_front_tb   = COALESCE(${aiGrading.centering.front_top_bottom}, centering_front_tb),
        centering_back_lr    = COALESCE(${aiGrading.centering.back_left_right},  centering_back_lr),
        centering_back_tb    = COALESCE(${aiGrading.centering.back_top_bottom},  centering_back_tb),
        ai_draft_grade       = ${aiGrading.overall_grade}::numeric,
        updated_at           = NOW()
      WHERE id = ${certId} AND grade_approved_at IS NULL
    `);
    gradeWritten = (result.rowCount ?? 0) > 0;
    if (!gradeWritten) {
      console.log(`[scan-ingest] cert=${certId}: cert already approved — AI grading written to ai_analysis only, per-zone columns preserved`);
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
        operations: aiGrading
          ? ["identify", "suggest_defects", "grade"]
          : ["identify", "suggest_defects"],
        identification_confidence: aiConfidence,
        tcg_verified: tcgVerified,
        card_game: cardGame,
        card_name: cardName,
        defect_candidate_count: defectCandidates.length,
        ai_grading_overall: aiGrading?.overall_grade ?? null,
        ai_grading_overall_confidence: aiGrading?.confidence?.overall ?? null,
        ai_grading_persisted: gradeWritten,
      })}::jsonb,
      NOW()
    )
  `);

  const overallReturned = aiGrading?.overall_grade ?? null;
  console.log(`[scan-ingest] cert=${certId}: Option-A AI complete — card="${cardName}" game=${cardGame} candidates=${defectCandidates.length} overall=${overallReturned} graded=${gradeWritten}`);
  return { cardName, grade: overallReturned, strengthScore: null };
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
