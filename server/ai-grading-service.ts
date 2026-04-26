/**
 * MintVault AI Grading Service
 * Claude Vision API integration for card identification and grading analysis.
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { GRADING_SYSTEM_PROMPT, CARD_IDENTIFICATION_PROMPT } from "./grading-prompt";
import { CARD_GAME_MODULES } from "./card-game-knowledge";
import { lookupCard } from "./card-database";
import { anthropicFetch } from "./anthropic-fetch";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CardIdentification {
  detected_name: string;
  detected_set: string;
  detected_number: string | null;
  detected_year: string | null;
  detected_game: string;
  detected_language: string;
  detected_rarity: string | null;
  is_holo: boolean;
  is_foil: boolean;
  is_reverse_holo: boolean;
  is_full_art: boolean;
  is_textured: boolean;
  card_type: string | null;
  set_code: string | null;
  copyright_year: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string | null;
}

export interface EnrichedCardData extends CardIdentification {
  verified: boolean;
  officialName: string;
  officialSet: string;
  officialNumber: string | null;
  referenceImageUrl: string | null;
  dbSource: string | null;
}

export interface CornerDetail { grade: number; notes: string; }
export interface EdgeDetail   { grade: number; notes: string; }

export interface AiDefect {
  id: number;
  type: string;
  location: "front" | "back";
  position_x_percent: number;
  position_y_percent: number;
  width_percent: number;
  height_percent: number;
  severity: "minor" | "moderate" | "major";
  description: string;
  detected_in: string;
}

export interface GradingAnalysis {
  card_identification: {
    detected_name: string;
    detected_set: string;
    detected_number: string | null;
    detected_year: string | null;
    detected_game: string;
    detected_language: string;
    detected_rarity: string | null;
    is_holo: boolean;
    is_foil: boolean;
    is_reverse_holo: boolean;
    is_full_art: boolean;
    is_textured: boolean;
    card_type: string | null;
    identification_confidence: string;
  };
  centering: {
    subgrade: number;
    front_left_right: string;
    front_top_bottom: string;
    back_left_right: string;
    back_top_bottom: string;
    front_grade: number;
    back_grade: number;
    notes: string;
  };
  corners: {
    subgrade: number;
    front_top_left: CornerDetail;
    front_top_right: CornerDetail;
    front_bottom_left: CornerDetail;
    front_bottom_right: CornerDetail;
    back_top_left: CornerDetail;
    back_top_right: CornerDetail;
    back_bottom_left: CornerDetail;
    back_bottom_right: CornerDetail;
    notes: string;
  };
  edges: {
    subgrade: number;
    front_top: EdgeDetail;
    front_right: EdgeDetail;
    front_bottom: EdgeDetail;
    front_left: EdgeDetail;
    back_top: EdgeDetail;
    back_right: EdgeDetail;
    back_bottom: EdgeDetail;
    back_left: EdgeDetail;
    notes: string;
  };
  surface: {
    subgrade: number;
    front_grade: number;
    back_grade: number;
    front_notes: string;
    back_notes: string;
    notes: string;
  };
  defects: AiDefect[];
  overall_grade: number | "AA" | "NO";
  grade_label: string;
  grade_calculation: {
    weighted_raw: number;
    rounded: number;
    lowest_subgrade: number;
    max_from_lowest: number;
    applied_cap: number | null;
    final: number;
  };
  grade_explanation: string;
  confidence: {
    centering: "high" | "medium" | "low";
    corners: "high" | "medium" | "low";
    edges: "high" | "medium" | "low";
    surface: "high" | "medium" | "low";
    overall: "high" | "medium" | "low";
  };
  confidence_notes: string;
  photo_quality_notes: string[];
  is_authentic: boolean;
  is_altered: boolean;
  authentication_notes: string;
  recommendations: string[];
}

// ── Rate limiting ──────────────────────────────────────────────────────────

let lastAiCallTs = 0;
const MIN_CALL_INTERVAL_MS = 5000;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastAiCallTs;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_INTERVAL_MS - elapsed));
  }
  lastAiCallTs = Date.now();
}

// ── Image variant generation (greyscale, hi-contrast, edge, inverted) ─────

export interface ImageVariants {
  original: Buffer;
  /** Padded JPEG: cropped + reCentred + extended with mat-coloured border.
   *  Used as both display storage (front_cropped.jpg) and AI variant source. */
  cropped: Buffer;
  /** Un-padded JPEG: cropped + reCentred only. Surfaced so the caller can
   *  apply maskRoundedCorners on the actual card corners (not on the mat
   *  bitmap corners after padding) and then pad the masked PNG. */
  centredUnpadded: Buffer;
  greyscale: Buffer;
  highcontrast: Buffer;
  edgeenhanced: Buffer;
  inverted: Buffer;
}

/**
 * Generate all 5 analysis views from a single card image buffer.
 *
 * Cropping chain (unified with the admin CaptureWizard path — Phase Y
 * convergence): deskew → cropToYellowBorder || autoCrop → reCentreBitmap.
 * This inherits the Phase 1 Bugs 1-3 fixes (mat-agnostic deskew, re-trim
 * logging, alpha-mask white fill — though mask isn't applied here) and
 * produces a card-centred flat JPEG suitable both for AI consumption and
 * for downstream round-corner masking at the scan-ingest layer.
 *
 * Returned `cropped` is a flat JPEG. The display-ready masked PNG is the
 * caller's responsibility (see scan-ingest-service uploadImagesToCert).
 *
 * Kept the old `autoCropCard` export in place for any non-variant callers
 * (e.g. /api/admin/grade-with-ai in routes.ts).
 */
export async function generateImageVariants(buffer: Buffer, certId?: string | number): Promise<ImageVariants & { cropGeometry?: { pre_padding_px: { top: number; bottom: number; left: number; right: number }; post_asymmetry_px: { horizontal: number; vertical: number }; extended: boolean }; matRgb?: { r: number; g: number; b: number } }> {
  const { deskewCard, cropToYellowBorder, autoCrop, reCentreBitmap, padWithMat } = await import("./image-processing");

  // Step 1: deskew small rotations before cropping
  const { buffer: deskewed, angle } = await deskewCard(buffer);
  if (Math.abs(angle) > 0.05) console.log(`[ai/variants] deskewed ${angle.toFixed(2)}°${certId != null ? ` cert=${certId}` : ""}`);

  // Step 2: tight card-boundary crop (mat-agnostic); fall back to sharp.trim-based autoCrop
  const yellowResult = await cropToYellowBorder(deskewed, certId);
  let rectCropped: Buffer;
  let matRgb: { r: number; g: number; b: number };
  if (yellowResult) {
    rectCropped = yellowResult.buffer;
    matRgb = yellowResult.matRgb;
  } else {
    const ac = await autoCrop(deskewed);
    rectCropped = ac.buffer;
    matRgb = ac.matRgb;
  }

  // Step 3: deterministic re-centre — measure actual card edges vs mat colour
  // and shift to centre (Fix 2). matRgb is sourced from the pre-crop buffer
  // (where the outer strip is reliably mat); without it, the fallback samples
  // the cropped buffer's outer strip — which is the card's yellow border, not
  // mat — and extend padding gets filled with yellow ⇒ bogus "wraparound"
  // strip below the card.
  const { buffer: centred, pre_padding_px, post_asymmetry_px, extended } = await reCentreBitmap(rectCropped, { certId, matRgb });

  // Step 4: encode the un-padded centred buffer as JPEG. Surfaced as
  // `centredUnpadded` so the caller can mask rounded corners on the actual
  // card (not on the bitmap corners after padding).
  const centredUnpadded = await sharp(centred).jpeg({ quality: 95 }).toBuffer();

  // Step 5: extend with mat-coloured padding so the final cropped output has
  // a passport-style frame around the card (CARD_MAT_PADDING_PCT). The AI
  // variants are derived from the padded buffer because they're consumed by
  // the manual "Run AI" admin endpoints, where seeing the card framed in mat
  // doesn't degrade grading meaningfully (Claude handles framed photos
  // routinely). The display PNG flow lives in scan-ingest's
  // uploadImagesToCert: maskRoundedCorners(centredUnpadded) → padWithMat.
  const cropped = await padWithMat(centredUnpadded, matRgb);

  // Step 6: derive the four analysis variants from the padded flat image
  const [greyscale, highcontrast, edgeenhanced, inverted] = await Promise.all([
    sharp(cropped).grayscale().jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer(),
    sharp(cropped).linear(1.5, -30).jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer(),
    sharp(cropped)
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
      .normalize()
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer(),
    sharp(cropped).negate().jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer(),
  ]);

  console.log(`[ai/variants] generated 5 views: cropped=${(cropped.length / 1024).toFixed(0)}KB grey=${(greyscale.length / 1024).toFixed(0)}KB hi=${(highcontrast.length / 1024).toFixed(0)}KB edge=${(edgeenhanced.length / 1024).toFixed(0)}KB inv=${(inverted.length / 1024).toFixed(0)}KB (re-centre asym=${post_asymmetry_px.horizontal}/${post_asymmetry_px.vertical}px, extended=${extended})`);

  return {
    original: buffer,
    cropped,
    centredUnpadded,
    greyscale,
    highcontrast,
    edgeenhanced,
    inverted,
    cropGeometry: { pre_padding_px, post_asymmetry_px, extended },
    matRgb,
  };
}

// ── Pokémon card-code → TCG API set ID normalisation ─────────────────────

/** Map printed card set codes to the TCG API's internal set IDs */
const CARD_CODE_TO_TCG_ID: Record<string, string> = {
  // Scarlet & Violet era
  SVI: "sv1", PAL: "sv2", OBF: "sv3", MEW: "sv3pt5",
  PAR: "sv4", KSS: "sv4pt5", TEF: "sv5", TWM: "sv6",
  SFA: "sv6pt5", SCR: "sv7", SSP: "sv8", PRE: "sv8pt5",
  JTG: "sv9", DRI: "sv10", BLT: "sv11", WHT: "sv12", MEG: "sv13",
  SVP: "svp",
  // Sword & Shield era (common)
  SWH: "swsh1", RCL: "swsh2", DAA: "swsh3", VIV: "swsh4",
  BST: "swsh5", CRE: "swsh6", EVS: "swsh7", FST: "swsh8",
  BRS: "swsh9", ASR: "swsh10", LOR: "swsh11", SIT: "swsh12",
  CRZ: "swsh12pt5",
  // Promos / specials
  "M24EN": "mcd19",
};

/** Resolve a printed card code to TCG API set ID(s) to try */
function resolveSetCodeToTcgIds(setCode: string | null | undefined): string[] {
  if (!setCode) return [];
  const upper = setCode.replace(/\s+/g, "").toUpperCase();
  const mapped = CARD_CODE_TO_TCG_ID[upper];
  if (mapped) return [mapped, upper.toLowerCase()];
  return [upper.toLowerCase()];
}

// ── Pokémon TCG API verification ──────────────────────────────────────────

/**
 * Verify Claude's card identification against the official Pokémon TCG API.
 * If the API finds a match, use its set name and card details (source of truth).
 */
export async function verifyPokemonCardWithTcgApi(
  detectedName: string,
  detectedNumber: string | null,
  detectedRarity?: string | null,
  setCode?: string | null,
  copyrightYear?: string | null
): Promise<{
  verified: boolean;
  officialSetName?: string;
  officialCardName?: string;
  officialSetCode?: string;
  officialRarity?: string;
  officialYear?: string;
  apiCardId?: string;
  referenceImageUrl?: string;
  rejectReason?: string;
  trustAi?: boolean;
}> {
  const apiKey = process.env.POKEMON_TCG_API_KEY;
  if (!apiKey) {
    console.warn("[pokemon-tcg] API key not set, skipping verification");
    return { verified: false, rejectReason: "API key not configured" };
  }
  if (!detectedNumber) {
    return { verified: false, rejectReason: "No card number detected" };
  }

  // Detect Japanese/promo patterns
  const isPromoPattern = setCode && /^(M\d+|S-?P|SVP|SVPja|.*ja$)/i.test(setCode);

  // TCG API expects card numbers without leading zeros (e.g. "13" not "013")
  const queryNumber = detectedNumber ? detectedNumber.replace(/^0+/, "") || detectedNumber : detectedNumber;

  try {
    let results: any[] = [];

    // Strategy 1: If we have a set code, search by set.id + number (most precise)
    if (setCode) {
      // Use the card-code → TCG API ID map, then fall back to raw variants
      const mapped = resolveSetCodeToTcgIds(setCode);
      const codeClean = normaliseSetCode(setCode).toLowerCase();
      const codeVariants = [...mapped, codeClean, setCode.replace(/\s+/g, "-").toLowerCase(), setCode.toLowerCase()];
      const uniqueCodes = [...new Set(codeVariants)];
      for (const code of uniqueCodes) {
        if (results.length > 0) break;
        const setQuery = encodeURIComponent(`set.id:${code} number:${queryNumber}`);
        const queryUrl = `https://api.pokemontcg.io/v2/cards?q=${setQuery}&pageSize=5`;
        console.log(`[tcg-verify] strategy 1 URL: ${queryUrl}`);
        const setRes = await fetch(queryUrl, { headers: { "X-Api-Key": apiKey } });
        if (setRes.ok) {
          const setData = await setRes.json();
          results = setData.data || [];
          console.log(`[identify-debug] strategy 1 (${code}): ${results.length} cards`);
        }
      }
    }

    // Strategy 2: Fallback to name + number search, with guards
    if (results.length === 0) {
      console.log(`[identify-debug] TCG query strategy 2: name:"${detectedName}" number:${queryNumber}`);
      const nameQuery = encodeURIComponent(`name:"${detectedName}" number:${queryNumber}`);
      const nameRes = await fetch(`https://api.pokemontcg.io/v2/cards?q=${nameQuery}&pageSize=10`, { headers: { "X-Api-Key": apiKey } });
      if (nameRes.ok) {
        const nameData = await nameRes.json();
        const rawResults = nameData.data || [];

        // Filter out mismatches: reject if card name, number, or year doesn't match
        results = rawResults.filter((card: any) => {
          // Name guard: card name must match AI-detected name
          if (normaliseCardName(card.name) !== normaliseCardName(detectedName)) {
            console.log(`[tcg-verify] strategy 2: rejected ${card.name} — name mismatch (AI: ${detectedName})`);
            return false;
          }
          // Number guard: TCG card number must match AI-detected number (strip leading zeros)
          if (detectedNumber && card.number && String(card.number).replace(/^0+/, "") !== String(detectedNumber).replace(/^0+/, "")) {
            console.log(`[tcg-verify] strategy 2: rejected ${card.set.name} #${card.number} — number mismatch (AI: ${detectedNumber}, TCG: ${card.number})`);
            return false;
          }
          // Year guard: set release year must be within 1 year of copyright_year
          if (copyrightYear) {
            const cardYear = parseInt(copyrightYear, 10);
            const setYear = parseInt(card.set.releaseDate?.split("-")[0] || "0", 10);
            if (setYear > 0 && Math.abs(setYear - cardYear) > 1) {
              console.log(`[tcg-verify] strategy 2: rejected ${card.set.name} #${card.number} — year mismatch (AI: ${copyrightYear}, TCG: ${setYear})`);
              return false;
            }
          }
          return true;
        });

        if (rawResults.length > 0 && results.length === 0) {
          console.log(`[tcg-verify] strategy 2: all ${rawResults.length} results rejected by guards`);
        }
      }
    }

    if (results.length === 0) {
      // If Claude has high confidence + set_code, trust its identification even without TCG match
      // (many promos, Japanese sets, and new releases aren't in the TCG database)
      console.log(`[pokemon-tcg] no match for "${detectedName}" #${detectedNumber} (code=${setCode}, promo=${isPromoPattern})`);
      return {
        verified: false,
        trustAi: true, // signal to caller: use Claude's raw data for name/number/year, but leave set_name for manual entry
        rejectReason: isPromoPattern
          ? "Japanese/promo set — not in TCG database. AI data used for name/number/year."
          : "Not found in TCG database. AI data used for name/number/year.",
      };
    }

    // Ambiguity check: if name+number appears in multiple DIFFERENT sets, reject unless we can disambiguate
    const uniqueSets = new Set(results.map((c: any) => c.set.id));
    if (uniqueSets.size > 1) {
      // Try to disambiguate by copyright year
      if (copyrightYear) {
        const yearNum = parseInt(copyrightYear, 10);
        const yearFiltered = results.filter((c: any) => {
          const setYear = parseInt(c.set.releaseDate?.split("-")[0] || "0", 10);
          return Math.abs(setYear - yearNum) <= 1;
        });
        if (yearFiltered.length === 1) {
          const card = yearFiltered[0];
          console.log(`[pokemon-tcg] year-disambiguated: ${card.id} from ${card.set.name} (©${copyrightYear} matches ${card.set.releaseDate})`);
          return buildResult(card);
        }
        if (yearFiltered.length > 1) {
          // Still ambiguous within the year range — try rarity match
          if (detectedRarity) {
            const rarityLower = detectedRarity.toLowerCase();
            const rarityMatch = yearFiltered.find((c: any) => c.rarity?.toLowerCase().includes(rarityLower));
            if (rarityMatch) {
              console.log(`[pokemon-tcg] year+rarity match: ${rarityMatch.id} (${rarityMatch.rarity})`);
              return buildResult(rarityMatch);
            }
          }
        }
      }

      // Can't disambiguate — reject
      const setNames = [...uniqueSets].map(sid => results.find((c: any) => c.set.id === sid)?.set.name).join(", ");
      console.warn(`[pokemon-tcg] ambiguous: "${detectedName}" #${detectedNumber} found in ${uniqueSets.size} sets: ${setNames}`);
      return { verified: false, rejectReason: `Multiple sets contain ${detectedName} ${detectedNumber} — please specify set` };
    }

    // Single set match — pick best variant by rarity if multiple
    let card = results[0];
    if (results.length > 1 && detectedRarity) {
      const rarityLower = detectedRarity.toLowerCase();
      const rarityMatch = results.find((c: any) =>
        c.rarity?.toLowerCase().includes(rarityLower) || rarityLower.includes(c.rarity?.toLowerCase() || "")
      );
      if (rarityMatch) card = rarityMatch;
    }

    // Year sanity check: reject if set release year differs >1 from copyright year
    if (copyrightYear) {
      const yearNum = parseInt(copyrightYear, 10);
      const setYear = parseInt(card.set.releaseDate?.split("-")[0] || "0", 10);
      if (setYear > 0 && Math.abs(setYear - yearNum) > 1) {
        console.warn(`[pokemon-tcg] year mismatch: card ©${copyrightYear} vs set ${card.set.name} (${setYear}) — rejecting`);
        return { verified: false, rejectReason: `Year mismatch: card shows ©${copyrightYear} but TCG match is from ${setYear}` };
      }
    }

    // Number sanity check: TCG card number must match what the AI detected (strip leading zeros)
    if (detectedNumber && card.number && String(card.number).replace(/^0+/, "") !== String(detectedNumber).replace(/^0+/, "")) {
      console.warn(`[pokemon-tcg] number mismatch: AI detected #${detectedNumber} but TCG match is #${card.number} — rejecting`);
      return { verified: false, rejectReason: `Card number mismatch: detected #${detectedNumber} but TCG match is #${card.number}` };
    }

    // Name sanity check: TCG card name must match AI-detected name
    if (normaliseCardName(card.name) !== normaliseCardName(detectedName)) {
      console.warn(`[pokemon-tcg] name mismatch: AI="${detectedName}" TCG="${card.name}" — rejecting (set_code may be wrong)`);
      return { verified: false, trustAi: true, rejectReason: `Name mismatch: AI detected "${detectedName}" but TCG match is "${card.name}" — likely wrong set code` };
    }

    console.log(`[pokemon-tcg] verified: ${card.id} ${card.name} #${card.number} from ${card.set.name} (${card.rarity})`);
    return buildResult(card);
  } catch (err: any) {
    console.error("[pokemon-tcg] verification failed:", err.message);
    return { verified: false, rejectReason: "TCG API error" };
  }
}

function buildResult(card: any) {
  return {
    verified: true,
    officialCardName: card.name,
    officialSetName: card.set.name,
    officialSetCode: card.set.id,
    officialRarity: card.rarity,
    officialYear: card.set.releaseDate?.split("-")[0],
    apiCardId: card.id,
    referenceImageUrl: card.images?.large || card.images?.small || null,
  };
}

// ── Grade clamping (whole numbers only) ───────────────────────────────────

/** Clamp any grade value to a whole number 1-10 */
function clampGrade(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (isNaN(n)) return 1;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

/** Enforce whole-number grades on all fields of a GradingAnalysis result */
function clampAllGrades(result: GradingAnalysis): GradingAnalysis {
  if (typeof result.overall_grade === "number") {
    result.overall_grade = clampGrade(result.overall_grade);
  }
  if (result.centering) result.centering.subgrade = clampGrade(result.centering.subgrade);
  if (result.corners)   result.corners.subgrade   = clampGrade(result.corners.subgrade);
  if (result.edges)     result.edges.subgrade     = clampGrade(result.edges.subgrade);
  if (result.surface)   result.surface.subgrade   = clampGrade(result.surface.subgrade);
  return result;
}

// ── Image resize for Claude Vision API ────────────────────────────────────

/**
 * Resize an image buffer to fit Anthropic Claude Vision API constraints.
 * Resizes to max 2576x2576 (Opus 4.7 supports up to 3.75MP / 2576px long edge).
 * JPEG quality 95 preserves fine detail for grading (scratches, whitening, print dots).
 */
export async function resizeForClaude(buffer: Buffer): Promise<{ buffer: Buffer; mediaType: "image/jpeg" }> {
  const inputSize = buffer.length;
  const resized = await sharp(buffer)
    .rotate() // auto-orient based on EXIF
    .resize(2576, 2576, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();
  console.log(`[ai/resize] ${(inputSize / 1024 / 1024).toFixed(2)}MB -> ${(resized.length / 1024 / 1024).toFixed(2)}MB`);
  return { buffer: resized, mediaType: "image/jpeg" };
}

// ── Auto-crop card from scanner background ────────────────────────────────

/**
 * Auto-crop a card image to its actual edges and center it with a clean border.
 * Uses sharp's trim to detect the card bounding box against a light background.
 * Adds a uniform white border and resizes to max 2576px for Claude Vision (Opus 4.7).
 */
export async function autoCropCard(buffer: Buffer, borderPx = 40): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");

  let trimmed: Buffer;
  try {
    trimmed = await sharp(buffer)
      .rotate()
      .trim({ background: "white", threshold: 25 })
      .toBuffer();
  } catch (err) {
    console.warn("[ai/auto-crop] trim failed, falling back to original:", err);
    trimmed = buffer;
  }

  const trimmedMeta = await sharp(trimmed).metadata();

  const final = await sharp(trimmed)
    .extend({
      top: borderPx, bottom: borderPx, left: borderPx, right: borderPx,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .resize(2576, 2576, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();

  console.log(
    `[ai/auto-crop] ${meta.width}x${meta.height} -> ${trimmedMeta.width ?? "?"}x${trimmedMeta.height ?? "?"} (trimmed) -> ${(final.length / 1024).toFixed(0)}KB JPEG`
  );
  return final;
}

// ── Analyze card from raw buffers (no R2 keys needed) ─────────────────────

/**
 * Run full grading analysis on raw image buffers (already cropped/resized).
 * This is the buffer-based counterpart to analyzeCard() which uses R2 keys.
 */
export async function analyzeCardFromBuffers(
  frontBuffer: Buffer,
  backBuffer: Buffer | null,
  cardGame?: string,
  certId?: string | number,
): Promise<GradingAnalysis> {
  await rateLimit();

  const frontB64 = frontBuffer.toString("base64");
  const backB64 = backBuffer ? backBuffer.toString("base64") : null;

  const content: object[] = [imageBlock(frontB64)];
  if (backB64) content.push(imageBlock(backB64));

  // Build system prompt (static grading prompt + optional game-specific module)
  let systemPrompt = GRADING_SYSTEM_PROMPT;
  if (cardGame && CARD_GAME_MODULES[cardGame]) {
    systemPrompt += "\n\n" + CARD_GAME_MODULES[cardGame];
  }

  // Add a brief instruction in user content to trigger grading
  content.push({ type: "text", text: "Grade this card. Return ONLY valid JSON." });

  let text: string;
  try {
    text = await callClaude(content, 4096, "claude-opus-4-7", {
      thinking: true,
      systemPrompt,
      label: "grade",
      certId,
    });
  } catch (err: any) {
    throw new Error(`Claude API call failed: ${err.message}`);
  }

  try {
    return clampAllGrades(parseJson<GradingAnalysis>(text));
  } catch {
    const fixPrompt = `The following text was supposed to be valid JSON but failed to parse. Return ONLY the corrected valid JSON, nothing else:\n\n${text.slice(0, 8000)}`;
    try {
      const fixedText = await callClaude([{ type: "text", text: fixPrompt }], 4096, "claude-opus-4-7", { label: "json-fix", certId });
      return clampAllGrades(parseJson<GradingAnalysis>(fixedText));
    } catch {
      throw new Error("AI returned invalid JSON and could not be corrected automatically");
    }
  }
}

// ── R2 image fetching ──────────────────────────────────────────────────────

async function fetchR2Buffer(key: string): Promise<Buffer> {
  const endpoint  = process.env.R2_ENDPOINT;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket    = process.env.R2_BUCKET_NAME;
  if (!endpoint || !accessKey || !secretKey || !bucket) {
    throw new Error("R2 credentials not configured");
  }
  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const result = await client.send(cmd);
  if (!result.Body) throw new Error(`Empty body for R2 key: ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function r2KeyToBase64(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    const buf = await fetchR2Buffer(key);
    const { buffer: resized } = await resizeForClaude(buf);
    return resized.toString("base64");
  } catch {
    return null;
  }
}

function imageBlock(base64: string, mediaType = "image/jpeg"): object {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

// ── Claude API call ────────────────────────────────────────────────────────

/**
 * Retry policy for the Claude API call.
 *
 * - 120s per-attempt timeout (Opus 4.7 grading with 6 images + adaptive
 *   thinking regularly exceeds the old 30s ceiling — that was the root
 *   cause of the "This operation was aborted" failures on MV149/MV150)
 * - Max 2 retries on AbortError, low-level network errors, or HTTP 5xx
 * - Backoff: 1s then 3s
 * - Never retries 4xx (auth / bad request / rate limit) — caller decides
 */
const CLAUDE_TIMEOUT_MS = 120_000;
const CLAUDE_RETRY_BACKOFF_MS = [0, 1000, 3000]; // index = attempt number (1, 2, 3)
const CLAUDE_MAX_ATTEMPTS = 3;

// Per-million-token USD pricing. cacheWrite default is input × 1.25 per
// Anthropic's pricing structure; cacheRead is input × 0.10. Used by the cost
// logger so Haiku/Sonnet calls don't get logged at Opus rates.
interface ModelPricing { input: number; output: number; cacheWrite: number; cacheRead: number; }
const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":          { input: 5,  output: 25, cacheWrite: 6.25,  cacheRead: 0.5  },
  "claude-sonnet-4-6":        { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3  },
  "claude-haiku-4-5-20251001":{ input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1  },
};
const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["claude-opus-4-7"];
function pricingFor(model: string): ModelPricing {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  // Loose fallback by family substring so a future date-suffixed model still
  // logs sensible numbers until the map is updated.
  if (model.includes("haiku"))  return MODEL_PRICING["claude-haiku-4-5-20251001"];
  if (model.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
  if (model.includes("opus"))   return MODEL_PRICING["claude-opus-4-7"];
  return DEFAULT_PRICING;
}

function isRetryableClaudeError(err: any, response?: Response | null): { retry: boolean; reason: string } {
  if (response && !response.ok) {
    if (response.status >= 500) return { retry: true, reason: `HTTP ${response.status}` };
    return { retry: false, reason: `HTTP ${response.status}` };
  }
  const name = err?.name || "";
  const code = err?.code || "";
  if (name === "AbortError") return { retry: true, reason: "abort" };
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return { retry: true, reason: `network ${code}` };
  }
  if (typeof err?.message === "string" && /fetch failed|network/i.test(err.message)) {
    return { retry: true, reason: "network" };
  }
  return { retry: false, reason: "other" };
}

async function callClaude(
  content: object[],
  maxTokens: number,
  model = "claude-opus-4-7",
  options?: { thinking?: boolean; systemPrompt?: string; label?: string; certId?: string | number },
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable not set");

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };

  // Adaptive thinking (self-determines budget — no xhigh forcing)
  if (options?.thinking) {
    body.thinking = { type: "adaptive" };
  }

  // System prompt with prompt caching
  if (options?.systemPrompt) {
    body.system = [{
      type: "text",
      text: options.systemPrompt,
      cache_control: { type: "ephemeral" },
    }];
  }

  const certTag = options?.certId != null ? `cert=${options.certId}` : (options?.label || "unknown");
  let response: Response | null = null;
  let lastErr: any = null;

  for (let attempt = 1; attempt <= CLAUDE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const delay = CLAUDE_RETRY_BACKOFF_MS[attempt - 1];
      await new Promise(r => setTimeout(r, delay));
      const decision = isRetryableClaudeError(lastErr, response);
      console.log(`[ai/retry] ${attempt - 1}/${CLAUDE_MAX_ATTEMPTS - 1} for ${certTag} after ${decision.reason} (${delay}ms delay)`);
    }

    response = null;
    lastErr = null;
    try {
      response = await anthropicFetch(body, { apiKey, timeoutMs: CLAUDE_TIMEOUT_MS });
    } catch (err: any) {
      lastErr = err;
      const decision = isRetryableClaudeError(err, null);
      if (decision.retry && attempt < CLAUDE_MAX_ATTEMPTS) continue;
      throw new Error(`Claude API ${err?.name || "error"} after ${attempt} attempt${attempt > 1 ? "s" : ""} (${CLAUDE_TIMEOUT_MS}ms per attempt) for ${certTag}: ${err?.message || err}`);
    }

    if (!response.ok) {
      const decision = isRetryableClaudeError(null, response);
      if (decision.retry && attempt < CLAUDE_MAX_ATTEMPTS) continue;
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status} for ${certTag}: ${errText.slice(0, 300)}`);
    }

    break; // success — fall through to parse
  }

  if (!response || !response.ok) {
    throw new Error(`Claude API exhausted retries for ${certTag}: ${lastErr?.message || "unknown"}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const usage = data.usage as any;

  // ── Cost logging ──────────────────────────────────────────────────────────
  const inputTokens = usage?.input_tokens || 0;
  const cacheCreation = usage?.cache_creation_input_tokens || 0;
  const cacheRead = usage?.cache_read_input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const pricing = pricingFor(model);
  const costUsd =
    (inputTokens / 1_000_000) * pricing.input +
    (cacheCreation / 1_000_000) * pricing.cacheWrite +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (outputTokens / 1_000_000) * pricing.output;
  const costGbp = costUsd * 0.79; // approximate USD→GBP
  const label = options?.label || "unknown";
  console.log(`[ai-cost] ${label} (${model}): input=${inputTokens} cached=${cacheRead} cache-write=${cacheCreation} output=${outputTokens} → £${costGbp.toFixed(4)} ($${costUsd.toFixed(4)})`);
  // ── End cost logging ──────────────────────────────────────────────────────

  const contentArr = data.content as { type: string; text?: string; thinking?: string }[] | undefined;
  if (!contentArr?.length) throw new Error("Claude returned empty content array");

  // With adaptive thinking, content[0] may be a thinking block — find the text block
  const textBlock = contentArr.find(b => b.type === "text");
  if (!textBlock?.text) {
    throw new Error(`Claude returned no text block. Content types: [${contentArr.map(b => b.type).join(", ")}]`);
  }
  return textBlock.text;
}

function parseJson<T>(text: string): T {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned) as T;
}

/** Strip "/total" suffix from card numbers (e.g. "212/197" → "212") */
function normalizeCardNumber(result: CardIdentification): CardIdentification {
  if (result.detected_number && typeof result.detected_number === "string") {
    result.detected_number = result.detected_number.split("/")[0].trim();
  }
  return result;
}

// ── GPT-5 second opinion for card identification ──────────────────────────

async function identifyWithGpt(base64: string): Promise<CardIdentification | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "high" } },
          { type: "text", text: CARD_IDENTIFICATION_PROMPT },
        ],
      }],
    });

    const text = response.choices[0]?.message?.content || "";
    const parsed = normalizeCardNumber(parseJson<CardIdentification>(text));
    console.log(`[identify-debug] GPT response: name="${parsed.detected_name}" set="${parsed.detected_set}" number="${parsed.detected_number}" set_code="${parsed.set_code}" copyright_year="${parsed.copyright_year}" confidence="${parsed.confidence}"`);
    return parsed;
  } catch (err: any) {
    console.warn(`[identify-debug] GPT call failed: ${err.message}`);
    return null;
  }
}

/** Normalise set code: strip whitespace, uppercase. "M24 EN" and "M24EN" become "M24EN" */
function normaliseSetCode(code: string | null | undefined): string {
  return String(code || "").replace(/\s+/g, "").toUpperCase();
}

/** Normalise card name for comparison: lowercase, strip TCG suffixes */
export function normaliseCardName(name: string): string {
  return name
    .replace(/[-\s]?(EX|GX|V|VMAX|VSTAR|V-UNION|Tag Team|★|δ|◇|ex|gx)$/gi, "")
    .toLowerCase()
    .trim();
}

/** Reconcile Claude + GPT results. Returns the best identification. */
function reconcileIdentifications(claude: CardIdentification, gpt: CardIdentification | null): CardIdentification {
  if (!gpt) {
    console.log("[identify-debug] GPT unavailable, using Claude only");
    return claude;
  }

  const claudeNorm = normaliseSetCode(claude.set_code);
  const gptNorm = normaliseSetCode(gpt.set_code);
  console.log(`[normalise-debug] claude raw: "${claude.set_code}" → normalised: "${claudeNorm}"`);
  console.log(`[normalise-debug] gpt raw: "${gpt.set_code}" → normalised: "${gptNorm}"`);

  const codeAgree = claudeNorm && gptNorm && claudeNorm === gptNorm;
  const numberAgree = claude.detected_number === gpt.detected_number;
  const yearAgree = claude.copyright_year === gpt.copyright_year;
  console.log(`[normalise-debug] agreement after normalise: code=${codeAgree} number=${numberAgree} year=${yearAgree}`);

  console.log(`[identify-debug] claude=${claude.detected_name}/${claude.set_code}/${claude.detected_number}/${claude.copyright_year} gpt=${gpt.detected_name}/${gpt.set_code}/${gpt.detected_number}/${gpt.copyright_year} agreement: code=${codeAgree} number=${numberAgree} year=${yearAgree}`);

  // Both agree on key fields → high confidence, use Claude
  if (codeAgree && numberAgree) {
    return { ...claude, confidence: "high", reasoning: `${claude.reasoning || ""} [GPT agrees on set_code + number]` };
  }

  // Disagree on set_code → use whichever has higher confidence
  if (claude.confidence === "high" && gpt.confidence !== "high") return claude;
  if (gpt.confidence === "high" && claude.confidence !== "high") {
    // Use GPT's data with Claude as fallback for missing fields
    return {
      ...claude,
      detected_set: gpt.detected_set || claude.detected_set,
      set_code: gpt.set_code || claude.set_code,
      copyright_year: gpt.copyright_year || claude.copyright_year,
      confidence: "medium" as const,
      reasoning: `GPT confident (${gpt.reasoning?.slice(0, 60)}), Claude uncertain`,
    };
  }

  // Both disagree → medium confidence, use Claude, flag for review
  return { ...claude, confidence: "medium" as const, reasoning: `${claude.reasoning || ""} [GPT disagrees: set_code=${gpt.set_code}, year=${gpt.copyright_year}]` };
}

// ── Card identification from raw buffer (for direct image uploads) ─────────

export async function identifyCardFromBuffer(
  buffer: Buffer,
  _mimeType: string,
  certId?: string | number,
): Promise<CardIdentification> {
  await rateLimit();
  const { buffer: resized, mediaType } = await resizeForClaude(buffer);
  const base64 = resized.toString("base64");

  // Run Claude + GPT in parallel
  const [claudeText, gptResult] = await Promise.all([
    callClaude(
      [imageBlock(base64, mediaType), { type: "text", text: CARD_IDENTIFICATION_PROMPT }],
      1024,
      "claude-haiku-4-5-20251001",
      { label: "identify-haiku", certId }
    ),
    identifyWithGpt(base64),
  ]);

  let claudeResult: CardIdentification;
  try {
    claudeResult = normalizeCardNumber(parseJson<CardIdentification>(claudeText));
    console.log(`[identify-debug] raw Claude response: name="${claudeResult.detected_name}" set="${claudeResult.detected_set}" number="${claudeResult.detected_number}" year="${claudeResult.detected_year}" set_code="${claudeResult.set_code}" copyright_year="${claudeResult.copyright_year}" game="${claudeResult.detected_game}" confidence="${claudeResult.confidence}"`);
  } catch {
    throw new Error(`Card identification returned invalid JSON: ${claudeText.slice(0, 200)}`);
  }

  // Coerce detected_game to a known slug — Haiku occasionally returns the
  // display label ("Pokémon", "Magic: The Gathering") or null. Fall back to
  // "other" so downstream lookups still work; the admin can correct in form.
  claudeResult.detected_game = normaliseGameSlug(claudeResult.detected_game);

  // Reconcile the two opinions
  return reconcileIdentifications(claudeResult, gptResult);
}

const KNOWN_GAME_SLUGS = ["pokemon", "yugioh", "mtg", "onepiece", "sports", "digimon", "lorcana", "other"] as const;
type KnownGameSlug = typeof KNOWN_GAME_SLUGS[number];

/**
 * Map any Claude/GPT-supplied game string to a canonical slug. Returns
 * "other" rather than throwing so a malformed identification doesn't
 * fail-stop the whole scan-ingest pipeline.
 */
export function normaliseGameSlug(raw: unknown): KnownGameSlug {
  if (typeof raw !== "string" || !raw.trim()) return "other";
  const s = raw.trim().toLowerCase().replace(/[éè]/g, "e").replace(/[^a-z0-9]/g, "");
  if ((KNOWN_GAME_SLUGS as readonly string[]).includes(s)) return s as KnownGameSlug;
  // Common label variants
  if (s === "magic" || s === "magicthegathering" || s === "mtgcards") return "mtg";
  if (s === "yugiohtcg" || s === "yugiohcards") return "yugioh";
  if (s === "pokemontcg" || s === "pokemoncards") return "pokemon";
  return "other";
}

// ── Defect-candidate suggestion (Option B: scan-time Haiku pass) ──────────
//
// Surface-level defect detection on the front+back buffers. Output format
// matches the existing client-side `Defect` shape (severity: significant,
// x_percent/y_percent) so confirming a candidate is a one-line copy into
// the persisted defects array — no translation layer.
//
// Conservative by design: the prompt instructs Haiku to under-flag rather
// than over-flag, since false-positives create grader friction.

const DEFECT_SUGGESTION_PROMPT = `You are an assistant for a professional card grader. Examine the supplied card image(s) and list any visible defects you suspect. Be CONSERVATIVE — only flag defects clearly visible in the image. The grader will confirm or reject each candidate, so under-flagging is safer than over-flagging.

Return ONLY valid JSON with this exact shape, no other text:

{
  "defectCandidates": [
    {
      "type": "Whitening",
      "severity": "minor",
      "description": "Whitening on top-left corner where blue paint has worn",
      "location": "front",
      "image_side": "front",
      "x_percent": 5,
      "y_percent": 5
    }
  ]
}

Field rules:
- type: One of "Scratch", "Print Line", "Whitening", "Silvering", "Corner Softness", "Corner Rounding", "Edge Chip", "Edge Roughness", "Indentation", "Stain", "Crease", "Ink Spot", "Foil Peel", "Roller Mark", "Colour Fade", "Registration Error", "Holo Scratch", "Missing Ink", "Other"
- severity: "minor" | "moderate" | "significant" — significant means it clearly limits the grade
- description: One short sentence, neutral grading language, plain English
- location: "front" | "back" — which side of the card the defect is on
- image_side: same as location (kept for compatibility with the existing Defect shape)
- x_percent: 0–100, horizontal position on the card (0 = left edge, 100 = right edge)
- y_percent: 0–100, vertical position on the card (0 = top edge, 100 = bottom edge)

If no defects are clearly visible, return { "defectCandidates": [] }. Do not invent defects.

SHINY CARDS: Reflective/holographic surfaces produce light glare and reflections that are NOT defects. Only report physical wear, scratches, prints, or damage.`;

export interface DefectCandidate {
  type: string;
  severity: "minor" | "moderate" | "significant";
  description: string;
  location: string;
  image_side: string;
  x_percent: number;
  y_percent: number;
}

export async function suggestDefectsFromBuffer(
  frontBuffer: Buffer,
  backBuffer: Buffer | null,
  certId?: string | number,
): Promise<DefectCandidate[]> {
  await rateLimit();
  const { buffer: frontResized, mediaType: frontMime } = await resizeForClaude(frontBuffer);
  const content: object[] = [imageBlock(frontResized.toString("base64"), frontMime)];
  if (backBuffer) {
    const { buffer: backResized, mediaType: backMime } = await resizeForClaude(backBuffer);
    content.push(imageBlock(backResized.toString("base64"), backMime));
  }
  content.push({ type: "text", text: DEFECT_SUGGESTION_PROMPT });

  let text: string;
  try {
    text = await callClaude(content, 2048, "claude-haiku-4-5-20251001", { label: "suggest-defects-haiku", certId });
  } catch (err: any) {
    console.warn(`[suggest-defects] call failed for cert=${certId}: ${err.message}`);
    return [];
  }

  let parsed: { defectCandidates?: unknown };
  try {
    parsed = parseJson<{ defectCandidates?: unknown }>(text);
  } catch {
    console.warn(`[suggest-defects] non-JSON response for cert=${certId}: ${text.slice(0, 200)}`);
    return [];
  }

  const raw = Array.isArray(parsed.defectCandidates) ? parsed.defectCandidates : [];
  const validSeverity = new Set(["minor", "moderate", "significant"]);
  const validLocation = new Set(["front", "back"]);

  const cleaned: DefectCandidate[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    const severity = typeof r.severity === "string" ? r.severity.toLowerCase() : "";
    const location = typeof r.location === "string" ? r.location.toLowerCase() : "";
    if (!validSeverity.has(severity)) continue;
    if (!validLocation.has(location)) continue;
    const x = Number(r.x_percent);
    const y = Number(r.y_percent);
    if (!Number.isFinite(x) || x < 0 || x > 100) continue;
    if (!Number.isFinite(y) || y < 0 || y > 100) continue;
    cleaned.push({
      type:        typeof r.type === "string" && r.type.trim() ? r.type.trim() : "Other",
      severity:    severity as DefectCandidate["severity"],
      description: typeof r.description === "string" ? r.description.trim() : "",
      location,
      image_side:  typeof r.image_side === "string" ? r.image_side.toLowerCase() : location,
      x_percent:   Math.round(x),
      y_percent:   Math.round(y),
    });
  }
  console.log(`[suggest-defects] cert=${certId}: ${cleaned.length} candidate(s) accepted (raw: ${raw.length})`);
  return cleaned;
}

// ── Card identification ────────────────────────────────────────────────────

export async function identifyCard(frontKey: string): Promise<CardIdentification> {
  await rateLimit();
  const frontBase64 = await r2KeyToBase64(frontKey);
  if (!frontBase64) throw new Error("Failed to fetch front image for identification");

  const text = await callClaude(
    [imageBlock(frontBase64), { type: "text", text: CARD_IDENTIFICATION_PROMPT }],
    1024,
    "claude-haiku-4-5-20251001",
    { label: "identify-haiku-r2" }
  );

  try {
    return normalizeCardNumber(parseJson<CardIdentification>(text));
  } catch {
    throw new Error(`Card identification returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

// ── Database verification ──────────────────────────────────────────────────

/**
 * Verify AI identification against external card databases.
 * A match is only marked `verified: true` when name + number + year all agree.
 * For Pokémon, callers should prefer `verifyPokemonCardWithTcgApi()` which has
 * richer disambiguation logic — this function is the general-purpose fallback.
 */
export async function verifyAndEnrichCardData(id: CardIdentification): Promise<EnrichedCardData> {
  const unverified: EnrichedCardData = {
    ...id,
    verified: false,
    officialName:   id.detected_name,
    officialSet:    id.detected_set,
    officialNumber: id.detected_number,
    referenceImageUrl: null,
    dbSource: null,
  };

  try {
    const query = id.detected_number
      ? `${id.detected_name} ${id.detected_number}`
      : id.detected_name;
    const results = await lookupCard(id.detected_game, query);

    // Find a match that passes all three guards: name, number, year
    const match = findGuardedMatch(results, id);
    if (match) {
      return {
        ...id,
        verified: true,
        officialName:   match.name,
        officialSet:    match.setName,
        officialNumber: match.number,
        referenceImageUrl: match.imageUrl,
        dbSource: match.source,
      };
    }

    // Name-only fallback — still requires guards
    if (id.detected_number) {
      const fallback = await lookupCard(id.detected_game, id.detected_name);
      const fallbackMatch = findGuardedMatch(fallback, id);
      if (fallbackMatch) {
        return {
          ...id,
          verified: true,
          officialName:   fallbackMatch.name,
          officialSet:    fallbackMatch.setName,
          officialNumber: fallbackMatch.number,
          referenceImageUrl: fallbackMatch.imageUrl,
          dbSource: fallbackMatch.source,
        };
      }
    }
  } catch {
    // DB lookup failed — continue with unverified
  }

  return unverified;
}

/** Find first result where name matches AND card number matches AND year is within ±1 */
function findGuardedMatch(
  results: { name: string; number: string | null; year: string | null; setName: string; imageUrl: string | null; source: string }[],
  id: CardIdentification,
): typeof results[number] | null {
  for (const r of results) {
    // Name guard: base name must match (ignore suffixes like -EX, -V, VSTAR etc.)
    const aiName = id.detected_name.replace(/[-\s]?(EX|GX|V|VMAX|VSTAR|ex)$/i, "").toLowerCase();
    const dbName = r.name.replace(/[-\s]?(EX|GX|V|VMAX|VSTAR|ex)$/i, "").toLowerCase();
    if (aiName !== dbName) {
      console.log(`[verify-guard] name mismatch: AI="${id.detected_name}" DB="${r.name}" — skipping`);
      continue;
    }

    // Number guard: must match if both present
    if (id.detected_number && r.number) {
      const aiNum = String(id.detected_number).replace(/^0+/, "");
      const dbNum = String(r.number).replace(/^0+/, "");
      if (aiNum !== dbNum) {
        console.log(`[verify-guard] number mismatch: AI=#${id.detected_number} DB=#${r.number} — skipping`);
        continue;
      }
    }

    // Year guard: must be within ±1 if both present
    const aiYear = parseInt(id.copyright_year || id.detected_year || "", 10);
    const dbYear = parseInt(r.year || "", 10);
    if (aiYear > 0 && dbYear > 0 && Math.abs(aiYear - dbYear) > 1) {
      console.log(`[verify-guard] year mismatch: AI=${aiYear} DB=${dbYear} — skipping`);
      continue;
    }

    console.log(`[verify-guard] match found: "${r.name}" #${r.number} from ${r.setName} (${r.year})`);
    return r;
  }
  return null;
}

// ── Full grading analysis ──────────────────────────────────────────────────

export interface ImageKeys {
  frontOriginal:     string | null;
  backOriginal:      string | null;
  frontGreyscale:    string | null;
  frontHighcontrast: string | null;
  backGreyscale:     string | null;
  backHighcontrast:  string | null;
  angledOriginal?:   string | null;
  closeupOriginal?:  string | null;
}

export async function analyzeCard(
  keys: ImageKeys,
  cardGame?: string
): Promise<GradingAnalysis> {
  await rateLimit();

  // Fetch images in parallel
  const [
    frontB64, backB64,
    frontGreyB64, frontHiB64,
    backGreyB64, backHiB64,
    angledB64, closeupB64,
  ] = await Promise.all([
    r2KeyToBase64(keys.frontOriginal),
    r2KeyToBase64(keys.backOriginal),
    r2KeyToBase64(keys.frontGreyscale),
    r2KeyToBase64(keys.frontHighcontrast),
    r2KeyToBase64(keys.backGreyscale),
    r2KeyToBase64(keys.backHighcontrast),
    r2KeyToBase64(keys.angledOriginal ?? null),
    r2KeyToBase64(keys.closeupOriginal ?? null),
  ]);

  if (!frontB64) throw new Error("Front image is required for AI analysis but could not be fetched");
  if (!backB64)  throw new Error("Back image is required for AI analysis but could not be fetched");

  const content: object[] = [
    imageBlock(frontB64),
    imageBlock(backB64),
  ];

  // Add enhancement variants if available
  if (frontGreyB64) content.push(imageBlock(frontGreyB64));
  if (frontHiB64)   content.push(imageBlock(frontHiB64));
  if (backGreyB64)  content.push(imageBlock(backGreyB64));
  if (backHiB64)    content.push(imageBlock(backHiB64));
  if (angledB64)    content.push(imageBlock(angledB64));
  if (closeupB64)   content.push(imageBlock(closeupB64));

  let systemPrompt = GRADING_SYSTEM_PROMPT;
  if (cardGame && CARD_GAME_MODULES[cardGame]) {
    systemPrompt += "\n\n" + CARD_GAME_MODULES[cardGame];
  }
  content.push({ type: "text", text: "Grade this card. Return ONLY valid JSON." });

  let text: string;
  try {
    text = await callClaude(content, 4096, "claude-opus-4-7", {
      thinking: true,
      systemPrompt,
      label: "grade-r2",
    });
  } catch (err: any) {
    throw new Error(`Claude API call failed: ${err.message}`);
  }

  // Parse with one retry if invalid JSON
  try {
    return clampAllGrades(parseJson<GradingAnalysis>(text));
  } catch {
    const fixPrompt = `The following text was supposed to be valid JSON but failed to parse. Return ONLY the corrected valid JSON, nothing else:\n\n${text.slice(0, 8000)}`;
    try {
      const fixedText = await callClaude(
        [{ type: "text", text: fixPrompt }],
        4096,
        "claude-opus-4-7",
        { label: "json-fix-r2" }
      );
      return clampAllGrades(parseJson<GradingAnalysis>(fixedText));
    } catch {
      throw new Error("AI returned invalid JSON and could not be corrected automatically");
    }
  }
}

// ── Identify + Analyze combined ────────────────────────────────────────────

export interface IdentifyAndAnalyzeResult {
  identification: EnrichedCardData;
  analysis: GradingAnalysis;
}

export async function identifyAndAnalyze(
  keys: ImageKeys,
  cardGame?: string
): Promise<IdentifyAndAnalyzeResult> {
  // Run identification first (quick, uses front image only)
  const rawId = keys.frontOriginal
    ? await identifyCard(keys.frontOriginal)
    : null;

  const identification = rawId
    ? await verifyAndEnrichCardData(rawId)
    : {
        detected_name: "Unknown", detected_set: "Unknown", detected_number: null,
        detected_year: null, detected_game: cardGame || "other", detected_language: "English",
        detected_rarity: null, is_holo: false, is_foil: false, is_reverse_holo: false,
        is_full_art: false, is_textured: false, card_type: null, set_code: null, copyright_year: null, confidence: "low" as const, reasoning: null,
        verified: false, officialName: "Unknown", officialSet: "Unknown",
        officialNumber: null, referenceImageUrl: null, dbSource: null,
      };

  // Full grading analysis (uses all images)
  const game = identification.detected_game !== "other" ? identification.detected_game : cardGame;
  const analysis = await analyzeCard(keys, game);

  return { identification, analysis };
}
