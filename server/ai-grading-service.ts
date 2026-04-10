/**
 * MintVault AI Grading Service
 * Claude Vision API integration for card identification and grading analysis.
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { GRADING_SYSTEM_PROMPT, CARD_IDENTIFICATION_PROMPT } from "./grading-prompt";
import { CARD_GAME_MODULES } from "./card-game-knowledge";
import { lookupCard } from "./card-database";

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
  confidence: "high" | "medium" | "low";
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
  cropped: Buffer;
  greyscale: Buffer;
  highcontrast: Buffer;
  edgeenhanced: Buffer;
  inverted: Buffer;
}

/**
 * Generate all 5 analysis views from a single card image buffer.
 * Input is auto-cropped first, then 4 variants are derived.
 */
export async function generateImageVariants(buffer: Buffer): Promise<ImageVariants> {
  const cropped = await autoCropCard(buffer);

  const [greyscale, highcontrast, edgeenhanced, inverted] = await Promise.all([
    sharp(cropped).grayscale().jpeg({ quality: 85 }).toBuffer(),
    sharp(cropped).linear(1.5, -30).jpeg({ quality: 85 }).toBuffer(),
    sharp(cropped)
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
      .normalize()
      .jpeg({ quality: 85 })
      .toBuffer(),
    sharp(cropped).negate().jpeg({ quality: 85 }).toBuffer(),
  ]);

  console.log(`[ai/variants] generated 5 views: cropped=${(cropped.length / 1024).toFixed(0)}KB grey=${(greyscale.length / 1024).toFixed(0)}KB hi=${(highcontrast.length / 1024).toFixed(0)}KB edge=${(edgeenhanced.length / 1024).toFixed(0)}KB inv=${(inverted.length / 1024).toFixed(0)}KB`);

  return { original: buffer, cropped, greyscale, highcontrast, edgeenhanced, inverted };
}

// ── Pokémon TCG API verification ──────────────────────────────────────────

/**
 * Verify Claude's card identification against the official Pokémon TCG API.
 * If the API finds a match, use its set name and card details (source of truth).
 */
export async function verifyPokemonCardWithTcgApi(
  detectedName: string,
  detectedNumber: string | null
): Promise<{
  verified: boolean;
  officialSetName?: string;
  officialCardName?: string;
  officialSetCode?: string;
  officialRarity?: string;
  officialYear?: string;
  apiCardId?: string;
}> {
  const apiKey = process.env.POKEMON_TCG_API_KEY;
  if (!apiKey) {
    console.warn("[pokemon-tcg] API key not set, skipping verification");
    return { verified: false };
  }
  if (!detectedNumber) {
    console.log("[pokemon-tcg] no card number, skipping verification");
    return { verified: false };
  }

  try {
    const query = encodeURIComponent(`name:"${detectedName}" number:${detectedNumber}`);
    const res = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${query}&pageSize=5`,
      { headers: { "X-Api-Key": apiKey } }
    );

    if (!res.ok) {
      console.warn(`[pokemon-tcg] API error: ${res.status}`);
      return { verified: false };
    }

    const data = await res.json();
    if (!data.data || data.data.length === 0) {
      console.log(`[pokemon-tcg] no match for "${detectedName}" #${detectedNumber}`);
      return { verified: false };
    }

    const card = data.data[0];
    console.log(`[pokemon-tcg] verified: ${card.name} from ${card.set.name} (${card.set.id})`);

    return {
      verified: true,
      officialCardName: card.name,
      officialSetName: card.set.name,
      officialSetCode: card.set.id,
      officialRarity: card.rarity,
      officialYear: card.set.releaseDate?.split("-")[0],
      apiCardId: card.id,
    };
  } catch (err: any) {
    console.error("[pokemon-tcg] verification failed:", err.message);
    return { verified: false };
  }
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
 * Resizes to max 2000x2000 (preserves aspect ratio) and re-encodes as JPEG quality 85.
 * Output is typically 300-700 KB which is well under the 5 MB Anthropic limit.
 * 2000px on the longest edge is plenty of detail for card identification and grading.
 */
async function resizeForClaude(buffer: Buffer): Promise<{ buffer: Buffer; mediaType: "image/jpeg" }> {
  const inputSize = buffer.length;
  const resized = await sharp(buffer)
    .rotate() // auto-orient based on EXIF
    .resize(2000, 2000, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  console.log(`[ai/resize] ${(inputSize / 1024 / 1024).toFixed(2)}MB -> ${(resized.length / 1024 / 1024).toFixed(2)}MB`);
  return { buffer: resized, mediaType: "image/jpeg" };
}

// ── Auto-crop card from scanner background ────────────────────────────────

/**
 * Auto-crop a card image to its actual edges and center it with a clean border.
 * Uses sharp's trim to detect the card bounding box against a light background.
 * Adds a uniform white border and resizes to max 2000px for Claude Vision.
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
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
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
  cardGame?: string
): Promise<GradingAnalysis> {
  await rateLimit();

  const frontB64 = frontBuffer.toString("base64");
  const backB64 = backBuffer ? backBuffer.toString("base64") : null;

  const content: object[] = [imageBlock(frontB64)];
  if (backB64) content.push(imageBlock(backB64));

  let prompt = GRADING_SYSTEM_PROMPT;
  if (cardGame && CARD_GAME_MODULES[cardGame]) {
    prompt += "\n\n" + CARD_GAME_MODULES[cardGame];
  }
  content.push({ type: "text", text: prompt });

  let text: string;
  try {
    text = await callClaude(content, 4096);
  } catch (err: any) {
    throw new Error(`Claude API call failed: ${err.message}`);
  }

  try {
    return clampAllGrades(parseJson<GradingAnalysis>(text));
  } catch {
    const fixPrompt = `The following text was supposed to be valid JSON but failed to parse. Return ONLY the corrected valid JSON, nothing else:\n\n${text.slice(0, 8000)}`;
    try {
      const fixedText = await callClaude([{ type: "text", text: fixPrompt }], 4096);
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

async function callClaude(
  content: object[],
  maxTokens: number,
  model = "claude-sonnet-4-6"
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable not set");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as { content: { type: string; text: string }[] };
  if (!data.content?.[0]?.text) throw new Error("Claude returned empty response");
  return data.content[0].text;
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

// ── Card identification from raw buffer (for direct image uploads) ─────────

export async function identifyCardFromBuffer(
  buffer: Buffer,
  _mimeType: string // ignored — we re-encode to JPEG via resizeForClaude
): Promise<CardIdentification> {
  await rateLimit();
  const { buffer: resized, mediaType } = await resizeForClaude(buffer);
  const base64 = resized.toString("base64");
  const text = await callClaude(
    [imageBlock(base64, mediaType), { type: "text", text: CARD_IDENTIFICATION_PROMPT }],
    1024,
    "claude-haiku-4-5-20251001"
  );
  try {
    return normalizeCardNumber(parseJson<CardIdentification>(text));
  } catch {
    throw new Error(`Card identification returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

// ── Card identification ────────────────────────────────────────────────────

export async function identifyCard(frontKey: string): Promise<CardIdentification> {
  await rateLimit();
  const frontBase64 = await r2KeyToBase64(frontKey);
  if (!frontBase64) throw new Error("Failed to fetch front image for identification");

  const text = await callClaude(
    [imageBlock(frontBase64), { type: "text", text: CARD_IDENTIFICATION_PROMPT }],
    1024,
    "claude-haiku-4-5-20251001"
  );

  try {
    return normalizeCardNumber(parseJson<CardIdentification>(text));
  } catch {
    throw new Error(`Card identification returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

// ── Database verification ──────────────────────────────────────────────────

export async function verifyAndEnrichCardData(id: CardIdentification): Promise<EnrichedCardData> {
  try {
    const query = id.detected_number
      ? `${id.detected_name} ${id.detected_number}`
      : id.detected_name;
    const results = await lookupCard(id.detected_game, query);

    if (results.length > 0) {
      const match = results[0];
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

    // Fuzzy fallback — name only
    const fallback = await lookupCard(id.detected_game, id.detected_name);
    if (fallback.length > 0) {
      const match = fallback[0];
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
  } catch {
    // DB lookup failed — continue with unverified
  }

  return {
    ...id,
    verified: false,
    officialName:   id.detected_name,
    officialSet:    id.detected_set,
    officialNumber: id.detected_number,
    referenceImageUrl: null,
    dbSource: null,
  };
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

  let prompt = GRADING_SYSTEM_PROMPT;
  if (cardGame && CARD_GAME_MODULES[cardGame]) {
    prompt += "\n\n" + CARD_GAME_MODULES[cardGame];
  }
  content.push({ type: "text", text: prompt });

  let text: string;
  try {
    text = await callClaude(content, 4096);
  } catch (err: any) {
    throw new Error(`Claude API call failed: ${err.message}`);
  }

  // Parse with one retry if invalid JSON
  try {
    return clampAllGrades(parseJson<GradingAnalysis>(text));
  } catch {
    // Retry: ask Claude to fix the JSON
    const fixPrompt = `The following text was supposed to be valid JSON but failed to parse. Return ONLY the corrected valid JSON, nothing else:\n\n${text.slice(0, 8000)}`;
    try {
      const fixedText = await callClaude(
        [{ type: "text", text: fixPrompt }],
        4096
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
        is_full_art: false, is_textured: false, card_type: null, confidence: "low" as const,
        verified: false, officialName: "Unknown", officialSet: "Unknown",
        officialNumber: null, referenceImageUrl: null, dbSource: null,
      };

  // Full grading analysis (uses all images)
  const game = identification.detected_game !== "other" ? identification.detected_game : cardGame;
  const analysis = await analyzeCard(keys, game);

  return { identification, analysis };
}
