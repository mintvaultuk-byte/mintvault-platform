/**
 * Vault Quest admin routes (Phase 1b) — all under /api/admin/vault-quest, all
 * behind requireAdmin. Isolated: imports only the VQ storage/render/guard modules
 * plus shared infra (requireAdmin, r2, multer config). Touches no grading route.
 *
 * Render endpoints (preview/export) are DB-free — they render from the posted
 * card and optional R2 artwork, so they work before the vq_ tables are pushed.
 * List/get/save require the vq_ tables (staging push, gated behind the deploy hold).
 */
import type { Express, Request, Response } from "express";
import { requireAdmin } from "../auth";
import { uploadToR2, getR2Buffer } from "../r2";
import { toolsUpload } from "../lib/multer-configs";
import { vqStorage, type CharacterBibleContext, type CharacterBiblePatch } from "../vault-quest/storage";
import { validateArtwork } from "../vault-quest/upload-guard";
import { intOrNull, isCandidateReferencedInPack } from "../vault-quest/lib/write-sanitize";
import { renderCard, type RenderCardInput } from "../vault-quest/render-service";
import { evaluateCard } from "../vault-quest/qa-engine";
import { vqArtKey, vqCharacterArtworkKey, vqCharacterCandidateKey, vqCharacterApprovedKey, fetchArt, renderSavedFromStudio, assertVqWriteKey } from "../vault-quest/render-saved";
import { normalizePdf } from "../vault-quest/pdf-normalize";
import { VQ_ELEMENTS, VQ_ELEMENTS_NEEDS_APPROVAL } from "../vault-quest/lib/vq-constants";
import { canTransition, isVqStatus } from "@shared/vq-workflow";
import { setIntegrity, cardMetadata } from "../vault-quest/qa-set";
import { startExportJob, getExportJob, jobStatus } from "../vault-quest/export-jobs";
import { generate, type GenerateReq } from "../vault-quest/generate";
import { runGenerator, generateFullCard, generateCharacterDescription, DESCRIPTION_FIELD_KEYS, type GenKind, type CardContext } from "../vault-quest/ai/generators";
import { providerStatuses } from "../vault-quest/ai/provider";
import { AI_DISCLAIMER, guardInput, guardOutput } from "../vault-quest/ai/guardrails";
import {
  buildVaultQuestArtworkPrompt,
  generateHiggsfieldArtwork,
  higgsfieldConnection,
  higgsfieldCreditsPerImage,
  isCandidateKeyForCard,
  validVqCardId,
  vqArtworkCandidateKey,
  type ArtworkSlot,
  type HiggsfieldArtworkResult,
} from "../vault-quest/ai/higgsfield";
import {
  VQ_REFERENCE_TYPES,
  vqPackCompleteness,
  type InsertVqCard,
  type VqCharacter,
  type VqArtworkCandidate,
  type VqReferenceType,
} from "@shared/vq-schema";
import { scoreCharacterIdentity, identityThreshold, type IdentityResult } from "../vault-quest/ai/identity";
import { validateStudioBackground } from "../vault-quest/ai/bg-validate";
import { VQ_IMAGE_MODELS, vqValidImageModel, vqCreditsPerImage } from "@shared/vq-schema";

type VqEditorPayload = RenderCardInput & {
  artR2Key?: string | null;
  prevArtR2Key?: string | null;
  artCandidateKey?: string | null;
  prevArtCandidateKey?: string | null;
  notes?: string | null;
  status?: string;
  variantTier?: string | null;
  baseCardId?: string | null;
  effects?: unknown[] | null;
};

const VQ_SUPPORT_CARD_TYPES = new Set(["Tactic", "Relic", "Vault", "Collector", "Place"]);

/** Map the editor payload to a DB insert row (drops render-only fields). */
function toInsert(body: VqEditorPayload): InsertVqCard {
  return {
    cardId: body.cardId,
    variantTier: body.variantTier ?? null,
    baseCardId: body.baseCardId ?? null,
    collectorNumber: body.collectorNumber,
    name: body.name,
    displayName: body.displayName ?? null,
    cardType: body.cardType,
    element: body.element,
    rarity: body.rarity ?? null,
    familyId: body.familyId ?? null,
    stageNumber: intOrNull(body.stageNumber),
    lifeStage: body.lifeStage ?? null,
    health: intOrNull(body.health),
    guard: intOrNull(body.guard),
    shift: intOrNull(body.shift),
    attack1Name: body.attack1Name ?? null,
    attack1Cost: intOrNull(body.attack1Cost),
    attack1Damage: intOrNull(body.attack1Damage),
    attack1Effect: body.attack1Effect ?? null,
    attack2Name: body.attack2Name ?? null,
    attack2Cost: intOrNull(body.attack2Cost),
    attack2Damage: intOrNull(body.attack2Damage),
    attack2Effect: body.attack2Effect ?? null,
    vulnerability: body.vulnerability ?? null,
    keywords: body.keywords ?? [],
    effects: body.effects ?? null,
    // Store only the DERIVED key (gated on the client's "art present" flag) — never
    // a client-supplied key.
    artR2Key: (body.artR2Key || body.artCandidateKey) ? vqArtKey(body.cardId, "main") : null,
    prevArtR2Key: (body.prevArtR2Key || body.prevArtCandidateKey) ? vqArtKey(body.cardId, "prev") : null,
    setCode: body.setCode ?? "GNV",
    language: body.language ?? "EN",
    year: intOrNull(body.year) ?? 2026,
    edition: body.edition ?? "FIRST EDITION",
    status: body.status ?? "draft",
    notes: body.notes ?? null,
  };
}

async function promoteArtworkCandidate(cardId: string, slot: ArtworkSlot, candidateKey?: string | null): Promise<string | null> {
  const key = String(candidateKey ?? "").trim();
  if (!key) return null;
  if (!validVqCardId(cardId)) throw new Error("Card ID can only use letters, numbers, dots, dashes, and underscores.");
  if (!isCandidateKeyForCard(key, cardId)) throw new Error("Artwork candidate does not belong to this card.");
  const buf = await getR2Buffer(key);
  if (!buf) throw new Error("Artwork candidate expired or was not found.");
  const guard = await validateArtwork(buf);
  if (!guard.ok) throw new Error(guard.error ?? "Artwork candidate failed validation.");
  const png = await (await import("sharp")).default(buf).png().toBuffer();
  const draftKey = assertVqWriteKey(vqArtKey(cardId, slot));
  await uploadToR2(draftKey, png, "image/png");
  // The candidate is now actually promoted into draft art — flip the audit flag
  // here (on Save Draft), not on Use. Best-effort: never fail the save.
  await vqStorage.markAiGenerationAppliedByCandidate(key).catch(() => {});
  await vqStorage.markArtworkCandidateStatusByKey(key, "draft_saved").catch(() => {});
  return draftKey;
}

const CHARACTER_PATCH_KEYS: (keyof CharacterBiblePatch)[] = [
  "characterDna",
  "visualDescription",
  "bodyShape",
  "colours",
  "markings",
  "eyes",
  "tailAccessories",
  "personality",
  "stageProgressionNotes",
  "elementIdentity",
  "negativePrompt",
  "masterArtworkPrompt",
  // NOTE: referenceArtworkR2Key / approvedArtworkR2Key / approvalStatus are
  // deliberately NOT client-writable here. They are set only by the dedicated
  // artwork/approve routes (which re-derive + prefix-guard the R2 key). Allowing
  // them via the free-form Bible PATCH let a crafted call store an arbitrary key
  // or fake `approvalStatus` (spoofing the Full-Card "has master portrait" gate).
  // The client Bible save only ever sends the text/DNA fields + `locked`.
  "locked",
];

function characterPatchFromBody(body: Record<string, unknown>): CharacterBiblePatch {
  const patch: CharacterBiblePatch = {};
  for (const key of CHARACTER_PATCH_KEYS) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === "locked") {
      patch.locked = value === true;
    } else {
      (patch as Record<string, string | null | boolean>)[key] = value == null ? null : String(value).trim() || null;
    }
  }
  return patch;
}

function withCharacterBibleContext(ctx: CardContext, bible: CharacterBibleContext): CardContext {
  const ch = bible.character;
  if (!ch) return ctx;
  return {
    ...ctx,
    name: ch.characterName,
    cardType: bible.card.cardType,
    element: ch.element,
    stageNumber: ch.stageNumber,
    familyId: ch.familyId,
    familyName: bible.family?.name ?? ch.familyName ?? ctx.familyName,
    familyElement: ch.element,
    canonicalStageName: ch.characterName,
    baseName: ch.characterName,
    baseCardId: bible.card.baseCardId ?? ctx.baseCardId,
    variantTier: bible.card.variantTier ?? ctx.variantTier,
    previousStage: bible.previousCharacter?.characterName ?? ctx.previousStage,
    previousCharacterName: bible.previousCharacter?.characterName,
    previousCharacterDna: bible.previousCharacter?.characterDna ?? undefined,
    previousVisualDescription: bible.previousCharacter?.visualDescription ?? undefined,
    characterDna: ch.characterDna ?? undefined,
    visualDescription: ch.visualDescription ?? undefined,
    bodyShape: ch.bodyShape ?? undefined,
    colours: ch.colours ?? undefined,
    markings: ch.markings ?? undefined,
    eyes: ch.eyes ?? undefined,
    tailAccessories: ch.tailAccessories ?? undefined,
    personality: ch.personality ?? undefined,
    stageProgressionNotes: ch.stageProgressionNotes ?? undefined,
    elementIdentity: ch.elementIdentity ?? undefined,
    negativePrompt: ch.negativePrompt ?? undefined,
    masterArtworkPrompt: ch.masterArtworkPrompt ?? undefined,
    referenceArtworkR2Key: ch.referenceArtworkR2Key ?? undefined,
    approvedArtworkR2Key: ch.approvedArtworkR2Key ?? undefined,
  };
}

// Trusted, server-curated Character Bible free-text. These legitimately enumerate
// "no card frame / no trading card layout / no set symbol" as NEGATIVE instructions
// to the image model, so they are exempt from the banned-LAYOUT request check.
// User-entered fields and model output are NEVER exempt (they keep being guarded).
const TRUSTED_BIBLE_TEXT_KEYS: (keyof CardContext)[] = [
  "characterDna", "visualDescription", "bodyShape", "colours", "markings", "eyes",
  "tailAccessories", "personality", "stageProgressionNotes", "elementIdentity",
  "negativePrompt", "masterArtworkPrompt", "previousCharacterDna", "previousVisualDescription",
];
function stripTrustedBibleText(ctx: CardContext): CardContext {
  const clean = { ...ctx };
  for (const key of TRUSTED_BIBLE_TEXT_KEYS) delete (clean as Record<string, unknown>)[key];
  return clean;
}

function missingBibleFields(bible: CharacterBibleContext): string[] {
  const ch = bible.character;
  if (!ch) return ["character row"];
  const missing = [
    !ch.characterDna && "character DNA",
    !ch.visualDescription && "visual description",
    !ch.bodyShape && "body shape",
    !ch.colours && "colours",
    !ch.eyes && "eyes",
    !ch.masterArtworkPrompt && "master artwork prompt",
    !ch.negativePrompt && "negative prompt",
  ].filter(Boolean) as string[];
  if (ch.stageNumber > 1 && !bible.previousCharacter?.characterDna) missing.push("previous-stage DNA");
  return missing;
}

// Build the STANDALONE-CHARACTER master-art prompt from trusted Character Bible DNA.
// This is the bootstrap prompt (works with no approved artwork yet). The masterArtworkPrompt
// is curated + already forbids card frames/layout/text — it is trusted, so it is NOT
// re-screened by the layout guard (same rule as the /ai/artwork builder-output exemption).
// `prev` is the previous evolution stage: its DNA is woven in for cross-stage continuity.
// Per-Reference-Pack-type framing appended to the trusted DNA prompt. Only the two
// required types matter for the TCG; the rest are future game-ready references.
const REFERENCE_PROMPT_STYLES: Record<VqReferenceType, string> = {
  // master_portrait is built by masterReferencePrompt() (strict studio rules), not this string.
  master_portrait:
    "Reference type: MASTER REFERENCE — permanent studio character reference on a plain background.",
  action_pose:
    "Reference type: ACTION POSE — the SAME character in a dynamic action pose, mid-motion and energetic, with the full body still completely visible, plain background.",
  face_closeup:
    "Reference type: FACE CLOSE-UP — head and face only, filling the frame: clear eyes, ears, facial markings and a characterful expression.",
  colour_sheet:
    "Reference type: COLOUR SHEET — neutral flat lighting on a plain background, colours rendered perfectly accurate to the palette, no dramatic shadows or stylised colour grading.",
  turnaround_sheet:
    "Reference type: TURNAROUND SHEET — model-sheet style turnaround of the same character: front view, side view and back view side by side, consistent proportions, plain background.",
};
const VALID_REFERENCE_TYPES = new Set<string>(VQ_REFERENCE_TYPES.map((t) => t.value));
function parseReferenceType(v: unknown): VqReferenceType {
  const s = String(v ?? "").trim();
  return (VALID_REFERENCE_TYPES.has(s) ? s : "master_portrait") as VqReferenceType;
}

// MASTER REFERENCE — the permanent canonical source image every future asset inherits
// from. A clean STUDIO REFERENCE but in Vault Quest's own 2D card-art style: premium
// hand-illustrated 2D cartoon/anime creature art, plain studio backdrop, neutral pose,
// even lighting, locked identity — explicitly NOT a 3D/toy/plastic render, no text.
// Built from the DNA atoms (NOT the illustration-flavoured masterArtworkPrompt, whose
// "cinematic lighting" language fights the studio rules).
function masterReferencePrompt(ch: VqCharacter): string {
  const t = (v: unknown) => String(v ?? "").trim();
  const idBits = [
    `${ch.characterName}, an original ${t(ch.element) || "elemental"} creature`,
    t(ch.bodyShape) && `body shape: ${t(ch.bodyShape)}`,
    t(ch.colours) && `colours: ${t(ch.colours)}`,
    t(ch.markings) && `markings: ${t(ch.markings)}`,
    t(ch.eyes) && `eyes: ${t(ch.eyes)}`,
    t(ch.tailAccessories) && `tail/accessories: ${t(ch.tailAccessories)}`,
  ].filter(Boolean).join("; ");
  const visual = t(ch.visualDescription);
  const ownNeg = t(ch.negativePrompt);
  return [
    "Create a high-quality 2D illustrated character reference in the premium Vault Quest trading-card art style — an official animation / model reference of the character, NOT an action illustration.",
    "Style: hand-drawn 2D cartoon/anime creature illustration, premium collectible-card art quality, clean crisp linework and soft cel shading — the same look as Vault Quest card artwork. It is a flat 2D illustration serving as a permanent studio character reference. It is NOT a 3D render, NOT CGI, NOT a sculpted or vinyl toy, NOT a plastic or clay model, NOT concept art, NOT a promotional scene, and NOT a framed trading card.",
    `Subject: ${idBits}.`,
    visual ? `Locked visual description: ${visual}.` : "",
    "BACKGROUND (must be absolutely plain): a single flat colour — pure white (#FFFFFF), OR very light cream, OR very light neutral grey. One solid uniform colour edge to edge. The ONLY thing allowed on the background is a single soft contact shadow directly beneath the feet. Absolutely no gradient, no scenery, no environment, no floor, no horizon, no props, no decorative elements, no texture, no vignette, no glow, no lighting effects, and no colour other than the plain backdrop.",
    "Pose: standing naturally in a calm neutral pose, facing roughly 30–45° towards the camera, the ENTIRE creature completely visible from head to toe — never crop the ears, tail or feet. Not aggressive, not jumping, not attacking, not running, no motion effects. A neutral, natural facial expression.",
    "Camera: eye level. The creature occupies roughly 70% of the frame, centred with clear plain margin on every side. Portrait orientation, high resolution.",
    "Lighting: soft and even from the front. No coloured lighting, no rim lighting, no dramatic or cinematic lighting, no depth-of-field. Only the one soft contact shadow under the feet.",
    "Identity is LOCKED — never change the body shape, silhouette, colours, markings, eyes, tail, accessories, species, proportions, face, ear shape or eye spacing.",
    `Negative — strictly avoid: no scenery; no environment; no background objects or props; no flames or fire behind the creature; no smoke; no fog; no particles; no embers; no sparkles; no glowing background; no lighting effects; no coloured backdrop; no gradient; no textured background; no floor texture; no horizon; no vignette; no decorative elements; no motion effects; no depth of field; no bokeh; no lens blur; no dramatic shadows (only one soft contact shadow under the feet); no 3D render; no CGI; no sculpture; no vinyl toy; no plastic or clay model; no card frame; no trading card layout; no logo; no text; no letters; no numbers; no words; no captions; no title; no labels; no name plate; no colour palette; no swatches; no model-sheet annotations; no watermark; no UI.${ownNeg ? ` ${ownNeg}` : ""}`,
  ].filter(Boolean).join(" ");
}

// Appended on a retry after the background validation fails — turns the plain-background
// instruction up to maximum emphasis.
const STRICTER_BG_SUFFIX =
  " CRITICAL: the previous attempt had an unacceptable background. The background MUST be one single flat plain colour (pure white #FFFFFF, light cream, or light neutral grey) with NOTHING on it except a soft contact shadow under the feet. Zero scenery, zero effects, zero gradient, zero texture, zero colour in the background. Isolate the creature completely on an empty plain studio backdrop.";

function characterMasterArtworkPrompt(ch: VqCharacter, prev?: VqCharacter | null, referenceType: VqReferenceType = "master_portrait"): string {
  // Master Reference = strict studio rules. Action Pose / Face Close-up / Colour Sheet /
  // Turnaround keep their own styling (unchanged).
  if (referenceType === "master_portrait") return masterReferencePrompt(ch);
  const master = (ch.masterArtworkPrompt ?? "").trim();
  const dna = (ch.characterDna ?? "").trim();
  const visual = (ch.visualDescription ?? "").trim();
  const base = master || [`Standalone original character artwork of ${ch.characterName}.`, visual, dna].filter(Boolean).join(" ");
  const continuity = prev
    ? ` Evolution continuity — this is the next stage after ${prev.characterName}: keep the SAME species identity, the same core colours (${(prev.colours ?? "").trim()}), the same markings (${(prev.markings ?? "").trim()}) and signature features, evolved to be larger and more mature. It must read as clearly the same creature line, not a different creature.`
    : "";
  const neg = (ch.negativePrompt ?? "").trim();
  return `${base}${continuity} ${REFERENCE_PROMPT_STYLES[referenceType]}${neg ? ` ${neg}` : ""}`.trim();
}

// ── Phase 2: visual identity lock ────────────────────────────────────────────
// Collect the APPROVED reference images to feed the generator as image_references.
// Priority = the character's OWN pack in VQ_REFERENCE_TYPES order — EXPANDABLE:
// a new reference type joins the pipeline just by being added to that shared
// array (no pipeline change) — then the previous stage's core pack as the
// evolution anchor for stage 2/3.
const PREV_STAGE_ANCHOR_TYPES: VqReferenceType[] = ["master_portrait", "action_pose", "colour_sheet"];
async function collectReferenceImages(character: VqCharacter, prevCharacter?: VqCharacter | null): Promise<{ buffers: Buffer[]; used: string[]; ownRefCount: number }> {
  const buffers: Buffer[] = [];
  const used: string[] = [];
  let ownRefCount = 0;
  for (const t of VQ_REFERENCE_TYPES) {
    const key = character.referencePack?.[t.value]?.r2Key;
    if (!key || !key.startsWith("vq/characters/")) continue;
    const buf = await getR2Buffer(key);
    if (buf) { buffers.push(buf); used.push(`own:${t.value}`); ownRefCount++; }
  }
  if (prevCharacter) {
    for (const t of PREV_STAGE_ANCHOR_TYPES) {
      const key = prevCharacter.referencePack?.[t]?.r2Key;
      if (!key || !key.startsWith("vq/characters/")) continue;
      const buf = await getR2Buffer(key);
      if (buf) { buffers.push(buf); used.push(`prev:${t}`); }
    }
  }
  return { buffers, used, ownRefCount };
}

// Identity-lock framing appended when references are attached. Own refs ⇒ SAME
// creature, only pose/camera/lighting/background/expression/action may change.
// Prev-stage refs only ⇒ evolution of that creature line, never a new species.
const IDENTITY_LOCK_PROMPT =
  " The attached reference images ARE this exact character — its permanent locked visual identity. Reproduce the SAME creature with identical proportions, markings, colours, eyes, ears, tail, body shape and silhouette. ONLY the pose, camera angle, lighting, background, expression and action may differ from the references.";
const EVOLUTION_REF_PROMPT =
  " The attached reference images show the PREVIOUS evolution stage of this creature line. Design THIS stage as a clear evolution of that same creature — same family visual language, same core colours and markings, grown larger and more mature. Never a different species.";

// Score a generated image against the character's OWN approved references; persist
// the score and auto-reject below threshold (stored for audit, never shown as a pick).
async function scoreAndGateCandidate(candidateId: number, generatedPng: Buffer, ownRefs: Buffer[], character: VqCharacter): Promise<{ identity: IdentityResult | null; autoRejected: boolean }> {
  if (!ownRefs.length) return { identity: null, autoRejected: false };
  const identity = await scoreCharacterIdentity(generatedPng, ownRefs, character);
  if (!identity) return { identity: null, autoRejected: false }; // scorer unavailable → keep with warning
  await vqStorage.setArtworkCandidateIdentity(candidateId, identity.score, identity.breakdown as unknown as Record<string, unknown>).catch(() => {});
  if (identity.verdict === "reject") {
    await vqStorage.markArtworkCandidateStatusById(candidateId, "auto_rejected").catch(() => {});
    return { identity, autoRejected: true };
  }
  return { identity, autoRejected: false };
}

// Generate ONE standalone master-art candidate from Character Bible DNA (Higgsfield → R2
// → candidate row). Approved references are attached as image_references so the model
// reuses the exact character; the result is identity-scored and auto-rejected on drift.
// Throws on provider errors (mapped by artworkErrorResponse). Reused by the single /
// "3 more" / family generate routes. Never approves, locks, or touches cards.
interface GenCandidateResult { candidate: VqArtworkCandidate; artwork: HiggsfieldArtworkResult; key: string; identity: IdentityResult | null; autoRejected: boolean; referencesUsed: string[] }
async function generateCharacterCandidate(character: VqCharacter, referenceType: VqReferenceType = "master_portrait", opts?: { model?: string }): Promise<GenCandidateResult | { rejected: true; reason: string }> {
  const prev = character.evolvesFromCharacterId ? (await vqStorage.getCharacter(character.evolvesFromCharacterId)) ?? null : null;
  const basePrompt = characterMasterArtworkPrompt(character, prev, referenceType);
  if (basePrompt.length < 20) throw new Error("Character Bible has no master artwork prompt or DNA yet — fill the Bible first.");
  const { buffers, used, ownRefCount } = await collectReferenceImages(character, prev);
  const idLock = ownRefCount > 0 ? IDENTITY_LOCK_PROMPT : used.length > 0 ? EVOLUTION_REF_PROMPT : "";
  const model = vqValidImageModel(opts?.model);

  // MASTER REFERENCE: after each generation, validate the studio background; if it fails,
  // retry ONCE with a stricter prompt before giving up. Only a passing image is kept.
  const isMaster = referenceType === "master_portrait";
  const maxAttempts = isMaster ? 2 : 1;
  let artwork: HiggsfieldArtworkResult | null = null;
  let prompt = "";
  let bgReason: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    prompt = basePrompt + idLock + (attempt > 1 ? STRICTER_BG_SUFFIX : "");
    const generated = await generateHiggsfieldArtwork({ prompt, mode: "main", slot: "main", imageReferences: buffers.length ? buffers : undefined, model });
    if (!isMaster) { artwork = generated; break; }
    const bg = await validateStudioBackground(generated.png);
    if (bg.ok) { artwork = generated; break; }
    bgReason = bg.reason;
    if (attempt === maxAttempts) {
      // Background never passed — reject WITHOUT uploading/recording (don't clutter R2/gallery,
      // don't consume the approval workflow). The image is discarded.
      return { rejected: true, reason: `studio background rejected (${bg.reason})` };
    }
  }
  if (!artwork) return { rejected: true, reason: bgReason ? `studio background rejected (${bgReason})` : "no image produced" };

  const key = assertVqWriteKey(vqCharacterCandidateKey(character.characterId));
  await uploadToR2(key, artwork.png, "image/png");
  const candidate = await vqStorage.recordArtworkCandidate({
    characterId: character.characterId, cardId: character.cardId, slot: "main", referenceType, source: "generated",
    provider: artwork.provider, model: artwork.model, prompt, r2Key: key,
    width: artwork.width, height: artwork.height, status: "candidate", aiGenerationId: null, createdBy: "admin",
  });
  await vqStorage.recordAiGeneration({
    cardId: character.cardId, kind: "character-artwork", mode: referenceType, provider: artwork.provider,
    model: artwork.model, generatedBy: "admin", prompt, output: { characterId: character.characterId, candidateKey: key, referenceType, referencesUsed: used }, applied: false,
  }).catch(() => {});
  const ownRefs = buffers.slice(0, ownRefCount);
  const { identity, autoRejected } = await scoreAndGateCandidate(candidate.id, artwork.png, ownRefs, character);
  return { candidate, artwork, key, identity, autoRejected, referencesUsed: used };
}

// Map a Higgsfield failure to a clean status: 503 not-connected, 402 plan/credit, else 500.
function artworkErrorResponse(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : "artwork generation failed";
  if (/not connected|rejected the token|401|Invalid credentials/i.test(msg)) {
    res.status(503).json({ error: "Artwork provider not connected — token missing or expired", connected: false });
  } else if (/minimum_basic_plan|plan_required|basic_plan|not enough credits|insufficient|402|\b403\b/i.test(msg)) {
    res.status(402).json({ error: "Higgsfield needs a higher plan or more credits.", planLimit: true });
  } else {
    res.status(500).json({ error: msg });
  }
}

export function registerVaultQuestAdminRoutes(app: Express): void {
  // ---- editor helpers ----
  app.get("/api/admin/vault-quest/config", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const gameConfig = await vqStorage.getConfig().catch(() => ({}));
      // Merge DB-added elements (from "add new element") with the built-in palette;
      // anything not built-in is flagged NEEDS_APPROVAL by convention.
      const elements: Record<string, unknown> = { ...VQ_ELEMENTS };
      const needsApproval = new Set<string>(VQ_ELEMENTS_NEEDS_APPROVAL);
      try {
        for (const name of await vqStorage.listElementNames()) {
          if (!(name in elements)) { elements[name] = { placeholder: true }; needsApproval.add(name); }
        }
      } catch { /* elements table absent — built-in palette only */ }
      res.json({ elements, needsApproval: [...needsApproval], gameConfig });
    } catch {
      res.json({ elements: VQ_ELEMENTS, needsApproval: [...VQ_ELEMENTS_NEEDS_APPROVAL], gameConfig: {} });
    }
  });

  // Image provider/model catalogue + per-image credit estimate. Display only, never billed.
  // Higgsfield is the wired provider; OpenAI Images is surfaced ONLY as availability (key
  // presence) — image generation for OpenAI is intentionally NOT wired into VQ.
  app.get("/api/admin/vault-quest/artwork-cost", requireAdmin, (_req: Request, res: Response) => {
    const conn = higgsfieldConnection();
    res.json({
      model: conn.model,
      connected: conn.connected,
      creditsPerImage: higgsfieldCreditsPerImage(),
      masterImagesPerItem: 3,
      models: VQ_IMAGE_MODELS,
      providers: [
        { id: "higgsfield", label: "Higgsfield", connected: conn.connected, enabled: true, note: conn.connected ? `model ${conn.model}` : "not connected" },
        { id: "openai", label: "OpenAI Images", connected: false, enabled: false, note: process.env.OPENAI_API_KEY ? "API key present — not wired for Vault Quest yet" : "API key missing" },
      ],
    });
  });

  // ---- Character Bible (VQ-only; one row per canonical stage creature) ----
  app.get("/api/admin/vault-quest/characters", requireAdmin, async (req: Request, res: Response) => {
    try {
      const setCode = String(req.query.setCode || "GNV").trim() || "GNV";
      res.json({ characters: await vqStorage.listCharacters(setCode) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to list Character Bible" });
    }
  });

  app.post("/api/admin/vault-quest/characters/seed", requireAdmin, async (req: Request, res: Response) => {
    try {
      const setCode = String((req.body as { setCode?: string })?.setCode || "GNV").trim() || "GNV";
      const result = await vqStorage.seedCharactersFromCards(setCode);
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to seed Character Bible" });
    }
  });

  app.get("/api/admin/vault-quest/characters/:characterId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      res.json({ character });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load character" });
    }
  });

  app.patch("/api/admin/vault-quest/characters/:characterId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const body = req.body as Record<string, unknown>;
      const patch = characterPatchFromBody(body);
      const character = await vqStorage.updateCharacterBible(characterId, patch, "admin", String(body.reason ?? "bible edit"));
      res.json({ character });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "failed to update character";
      res.status(/locked/i.test(msg) ? 423 : 500).json({ error: msg });
    }
  });

  app.get("/api/admin/vault-quest/characters/:characterId/revisions", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json({ revisions: await vqStorage.listCharacterRevisions(String(req.params.characterId)) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load character revisions" });
    }
  });

  app.post(
    "/api/admin/vault-quest/characters/:characterId/artwork",
    requireAdmin,
    toolsUpload.single("file"),
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const character = await vqStorage.getCharacter(characterId);
        if (!character) return res.status(404).json({ error: "character not found" });
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) return res.status(400).json({ error: "no file uploaded (field 'file')" });
        const guard = await validateArtwork(file.buffer);
        if (!guard.ok) return res.status(400).json({ error: guard.error });
        const png = await (await import("sharp")).default(file.buffer).png().toBuffer();
        const key = assertVqWriteKey(vqCharacterArtworkKey(characterId, "reference"));
        await uploadToR2(key, png, "image/png");
        const updated = await vqStorage.setCharacterArtworkKey(characterId, "reference", key, "admin");
        await vqStorage.recordArtworkCandidate({
          characterId,
          cardId: character.cardId,
          slot: "main",
          source: "upload",
          provider: "admin-upload",
          model: "manual",
          prompt: null,
          r2Key: key,
          width: guard.width,
          height: guard.height,
          status: "reference_uploaded",
          aiGenerationId: null,
          createdBy: "admin",
        }).catch(() => {});
        res.json({ character: updated, key, width: guard.width, height: guard.height });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to upload character artwork" });
      }
    },
  );

  app.get("/api/admin/vault-quest/characters/:characterId/art/:kind", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const kind = String(req.params.kind) === "approved" ? "approved" : "reference";
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      const key = kind === "approved" ? character.approvedArtworkR2Key : character.referenceArtworkR2Key;
      if (!key || !key.startsWith("vq/characters/")) return res.status(404).json({ error: "no artwork on file" });
      const buf = await getR2Buffer(key);
      if (!buf) return res.status(404).json({ error: "no artwork on file" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load character artwork" });
    }
  });

  app.post("/api/admin/vault-quest/characters/:characterId/approve-artwork", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      if (character.locked) return res.status(423).json({ error: "Character is locked — unlock before changing its reference pack." });
      const sourceKey = character.referenceArtworkR2Key;
      if (!sourceKey || !sourceKey.startsWith("vq/characters/")) {
        return res.status(400).json({ error: "Upload reference artwork before approving this character." });
      }
      const buf = await getR2Buffer(sourceKey);
      if (!buf) return res.status(404).json({ error: "reference artwork was not found" });
      const guard = await validateArtwork(buf);
      if (!guard.ok) return res.status(422).json({ error: guard.error ?? "reference artwork failed validation" });
      const png = await (await import("sharp")).default(buf).png().toBuffer();
      // Manual reference upload approves as the MASTER PORTRAIT pack slot.
      const approvedKey = assertVqWriteKey(vqCharacterApprovedKey(characterId, "master_portrait"));
      await uploadToR2(approvedKey, png, "image/png");
      const updated = await vqStorage.setCharacterReferencePack(characterId, "master_portrait", approvedKey, null, "admin");
      await vqStorage.markArtworkCandidateStatusByKey(sourceKey, "approved").catch(() => {});
      res.json({ character: updated, key: approvedKey, packCompleteness: vqPackCompleteness(updated.referencePack), width: guard.width, height: guard.height });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve artwork" });
    }
  });

  // ── Master artwork BOOTSTRAP (founder-only). Generates a STANDALONE character
  // candidate from Character Bible DNA — allowed WITHOUT approved artwork (this is
  // how the first reference is created). Never approves/locks/creates cards. ──
  app.post("/api/admin/vault-quest/characters/:characterId/generate-artwork", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      const body0 = (req.body ?? {}) as { referenceType?: string; model?: string };
      const referenceType = parseReferenceType(body0.referenceType);
      const model = String(body0.model ?? "").trim() || undefined;
      // Text before pixels: reference artwork may only be generated from an APPROVED description.
      if (character.descriptionStatus !== "approved") {
        return res.status(422).json({ error: "Description not approved — Generate, review and Approve the character description before generating artwork.", descriptionStatus: character.descriptionStatus });
      }
      const conn = higgsfieldConnection();
      if (!conn.connected) return res.status(503).json({ error: "Artwork provider not connected", provider: "higgsfield", note: conn.note, connected: false });

      // Master Reference ALWAYS produces THREE studio candidates — ENFORCED server-side,
      // so even a raw API call with referenceType=master_portrait yields 3, never 1.
      if (referenceType === "master_portrait") {
        const created: { candidateId: number; key: string; width: number; height: number; identityScore: number | null; model: string }[] = [];
        let autoRejectedCount = 0, bgRejectedCount = 0;
        for (let i = 0; i < 3; i++) {
          try {
            const r = await generateCharacterCandidate(character, referenceType, { model });
            if ("rejected" in r) { bgRejectedCount++; continue; } // studio background failed
            if (r.autoRejected) { autoRejectedCount++; continue; }
            created.push({ candidateId: r.candidate.id, key: r.key, width: r.artwork.width, height: r.artwork.height, identityScore: r.identity?.score ?? null, model: r.artwork.model });
          } catch (e) {
            if (!created.length && !autoRejectedCount && !bgRejectedCount) return artworkErrorResponse(res, e);
            break;
          }
        }
        return res.status(201).json({ referenceType, created, autoRejected: autoRejectedCount, bgRejected: bgRejectedCount, count: created.length });
      }

      const r = await generateCharacterCandidate(character, referenceType, { model });
      if ("rejected" in r) return res.status(422).json({ error: r.reason, rejected: true });
      const { candidate, artwork, key, identity, autoRejected, referencesUsed } = r;
      if (autoRejected) {
        // Identity drifted below threshold — candidate stored for audit, never shown.
        return res.status(422).json({
          error: `Identity Score ${identity?.score}/${identity?.threshold} — the generated image drifted from the approved references, so it was auto-rejected. Generate again.`,
          autoRejected: true,
          identityScore: identity?.score ?? null,
          identityThreshold: identity?.threshold ?? identityThreshold(),
        });
      }
      const thumb = await (await import("sharp")).default(artwork.png).resize(320, 320, { fit: "inside" }).png().toBuffer();
      res.status(201).json({
        candidateId: candidate.id, key, referenceType, width: artwork.width, height: artwork.height,
        identityScore: identity?.score ?? null, model: artwork.model, referencesUsed,
        preview: `data:image/png;base64,${thumb.toString("base64")}`,
      });
    } catch (err) {
      artworkErrorResponse(res, err);
    }
  });

  // Generate N more candidates (default 3, max 3) for THIS character only. Partial-tolerant:
  // if a later image fails (e.g. credits), the ones already created are still returned.
  app.post("/api/admin/vault-quest/characters/:characterId/generate-artwork/batch", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      const body = (req.body ?? {}) as { count?: number; referenceType?: string; model?: string };
      const count = Math.max(1, Math.min(3, Number(body.count) || 3));
      const referenceType = parseReferenceType(body.referenceType);
      const model = String(body.model ?? "").trim() || undefined;
      if (character.descriptionStatus !== "approved") {
        return res.status(422).json({ error: "Description not approved — Generate, review and Approve the character description before generating artwork.", descriptionStatus: character.descriptionStatus });
      }
      const conn = higgsfieldConnection();
      if (!conn.connected) return res.status(503).json({ error: "Artwork provider not connected", provider: "higgsfield", note: conn.note, connected: false });
      const created: { candidateId: number; key: string; width: number; height: number; identityScore: number | null; model: string }[] = [];
      let autoRejectedCount = 0, bgRejectedCount = 0;
      for (let i = 0; i < count; i++) {
        try {
          const r = await generateCharacterCandidate(character, referenceType, { model });
          if ("rejected" in r) { bgRejectedCount++; continue; }
          if (r.autoRejected) { autoRejectedCount++; continue; } // stored for audit, never shown
          created.push({ candidateId: r.candidate.id, key: r.key, width: r.artwork.width, height: r.artwork.height, identityScore: r.identity?.score ?? null, model: r.artwork.model });
        } catch (e) {
          if (!created.length && !autoRejectedCount && !bgRejectedCount) return artworkErrorResponse(res, e); // first one failed → clean error
          break; // a later one failed → return the ones that succeeded
        }
      }
      res.status(201).json({ characterId, referenceType, created, autoRejected: autoRejectedCount, bgRejected: bgRejectedCount });
    } catch (err) {
      artworkErrorResponse(res, err);
    }
  });

  // Reject a candidate — marks it rejected only. Does NOT delete the R2 object.
  app.post("/api/admin/vault-quest/characters/:characterId/reject-candidate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const candidateId = Number((req.body as { candidateId?: number })?.candidateId);
      if (!Number.isInteger(candidateId)) return res.status(400).json({ error: "candidateId required" });
      const cand = await vqStorage.getArtworkCandidate(candidateId);
      if (!cand || cand.characterId !== characterId) return res.status(404).json({ error: "candidate not found for this character" });
      // Don't reject/delete a candidate that is the SOURCE of an approved reference-
      // pack slot — it would leave reference_pack.<type>.candidateId dangling.
      // (Real occurrence found in staging: GNV-F03-S2 master_portrait → deleted cand.)
      const character = await vqStorage.getCharacter(characterId);
      if (isCandidateReferencedInPack(character?.referencePack, candidateId)) {
        return res.status(409).json({ error: "This candidate is the approved reference for this character — replace or re-approve a different one before rejecting it." });
      }
      // "delete" only hides it from the gallery (status flag) — the R2 object is kept.
      const action = String((req.body as { action?: string })?.action) === "delete" ? "deleted" : "rejected";
      await vqStorage.markArtworkCandidateStatusById(candidateId, action); // R2 object intentionally kept
      res.json({ ok: true, candidateId, status: action });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to reject candidate" });
    }
  });

  // List a character's master-art candidates (thumbnail gallery).
  app.get("/api/admin/vault-quest/characters/:characterId/candidates", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const typeFilter = req.query.type ? parseReferenceType(req.query.type) : undefined;
      const rows = await vqStorage.listArtworkCandidates(characterId, typeFilter);
      // auto_rejected = audit-only (identity drift); deleted = founder-hidden. Neither is shown.
      res.json({
        candidates: rows
          .filter((r) => r.status !== "auto_rejected" && r.status !== "deleted")
          .map((r) => ({ id: r.id, status: r.status, source: r.source, referenceType: r.referenceType, identityScore: r.identityScore, identityBreakdown: r.identityBreakdown, prompt: r.prompt, width: r.width, height: r.height, createdAt: r.createdAt })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to list candidates" });
    }
  });

  // Serve a single candidate image (validated to belong to the character).
  app.get("/api/admin/vault-quest/characters/:characterId/candidate/:candidateId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      const candidateId = Number(req.params.candidateId);
      if (!validVqCardId(characterId) || !Number.isInteger(candidateId)) return res.status(400).json({ error: "invalid id" });
      const cand = await vqStorage.getArtworkCandidate(candidateId);
      if (!cand || cand.characterId !== characterId || !cand.r2Key.startsWith("vq/characters/")) return res.status(404).json({ error: "candidate not found" });
      const buf = await getR2Buffer(cand.r2Key);
      if (!buf) return res.status(404).json({ error: "candidate image expired" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load candidate" });
    }
  });

  // Approve a candidate as the character's reference/approved artwork. Promotes to the
  // approved/ folder + stores the key on the Bible. Does NOT touch vq_cards or its status.
  app.post("/api/admin/vault-quest/characters/:characterId/approve-candidate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const body = (req.body ?? {}) as { candidateId?: number; lock?: boolean };
      const candidateId = Number(body.candidateId);
      if (!Number.isInteger(candidateId)) return res.status(400).json({ error: "candidateId required" });
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      if (character.locked) return res.status(423).json({ error: "Character is locked — unlock before changing its reference pack." });
      const cand = await vqStorage.getArtworkCandidate(candidateId);
      if (!cand || cand.characterId !== characterId || !cand.r2Key.startsWith("vq/characters/")) {
        return res.status(404).json({ error: "candidate not found for this character" });
      }
      if (cand.status === "rejected" || cand.status === "auto_rejected") {
        return res.status(422).json({ error: "This candidate was rejected — it cannot be approved as a reference." });
      }
      const buf = await getR2Buffer(cand.r2Key);
      if (!buf) return res.status(404).json({ error: "candidate image not found" });
      const referenceType = parseReferenceType(cand.referenceType); // approve for the candidate's OWN type
      // Approve ONLY — approving never locks (locking is a separate, explicit step on
      // the character Lock button). This removes the old "Approve + Lock fails when the
      // pack is incomplete" confusion.
      const guard = await validateArtwork(buf);
      if (!guard.ok) return res.status(422).json({ error: guard.error ?? "candidate failed validation" });
      const png = await (await import("sharp")).default(buf).png().toBuffer();
      const approvedKey = assertVqWriteKey(vqCharacterApprovedKey(characterId, referenceType));
      await uploadToR2(approvedKey, png, "image/png");
      const updated = await vqStorage.setCharacterReferencePack(characterId, referenceType, approvedKey, candidateId, "admin", cand.identityScore ?? null);
      await vqStorage.markArtworkCandidateStatusById(candidateId, "approved").catch(() => {});
      res.json({ character: updated, key: approvedKey, referenceType, locked: updated.locked, packCompleteness: vqPackCompleteness(updated.referencePack), width: guard.width, height: guard.height });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve candidate" });
    }
  });

  // Serve an approved Reference Pack image by type.
  app.get("/api/admin/vault-quest/characters/:characterId/pack/:type", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const referenceType = parseReferenceType(req.params.type);
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      const key = character.referencePack?.[referenceType]?.r2Key;
      if (!key || !key.startsWith("vq/characters/")) return res.status(404).json({ error: "no approved image for this reference type" });
      const buf = await getR2Buffer(key);
      if (!buf) return res.status(404).json({ error: "approved image not found" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load pack image" });
    }
  });

  // Generate master-art candidates for a whole family (Stage 1→2→3), each from its own
  // DNA, with each later stage referencing the previous stage's DNA for continuity.
  // Sequential (spends Higgsfield credits per stage). No approval/lock/card changes.
  app.post("/api/admin/vault-quest/characters/family/:familyId/generate-artwork", requireAdmin, async (req: Request, res: Response) => {
    try {
      const familyId = String(req.params.familyId);
      if (!validVqCardId(familyId)) return res.status(400).json({ error: "invalid family id" });
      const fam = (await vqStorage.listCharacters("GNV"))
        .filter((c) => c.familyId === familyId)
        .sort((a, b) => a.stageNumber - b.stageNumber);
      if (fam.length === 0) return res.status(404).json({ error: "no characters for this family" });
      const model = String((req.body as { model?: string })?.model ?? "").trim() || undefined;
      const conn = higgsfieldConnection();
      if (!conn.connected) return res.status(503).json({ error: "Artwork provider not connected", provider: "higgsfield", note: conn.note, connected: false });
      const generated: { characterId: string; stageNumber: number; candidateId: number; key: string; identityScore: number | null }[] = [];
      let autoRejectedCount = 0, bgRejectedCount = 0, descSkipped = 0;
      for (const ch of fam) {
        // Each stage references the previous stage's DNA + approved pack (evolution anchor,
        // handled inside generateCharacterCandidate → collectReferenceImages).
        if (ch.descriptionStatus !== "approved") { descSkipped++; continue; } // text before pixels
        try {
          const r = await generateCharacterCandidate(ch, "master_portrait", { model });
          if ("rejected" in r) { bgRejectedCount++; continue; }
          if (r.autoRejected) { autoRejectedCount++; continue; }
          generated.push({ characterId: ch.characterId, stageNumber: ch.stageNumber, candidateId: r.candidate.id, key: r.key, identityScore: r.identity?.score ?? null });
        } catch (e) {
          if (!generated.length && !autoRejectedCount && !bgRejectedCount) return artworkErrorResponse(res, e);
          break; // a later stage failed → return the ones that succeeded
        }
      }
      res.status(201).json({ familyId, generated, autoRejected: autoRejectedCount, bgRejected: bgRejectedCount, descriptionSkipped: descSkipped });
    } catch (err) {
      artworkErrorResponse(res, err);
    }
  });

  // Approve family references — batch-approve a chosen candidate for EACH of the family's 3
  // stages at once. Only runs when every stage has a selected candidate. Validate-then-mutate
  // (all selections checked before any approval). No lock, no card approval, no card status.
  app.post("/api/admin/vault-quest/characters/family/:familyId/approve-references", requireAdmin, async (req: Request, res: Response) => {
    try {
      const familyId = String(req.params.familyId);
      if (!validVqCardId(familyId)) return res.status(400).json({ error: "invalid family id" });
      const selections = ((req.body as { selections?: { characterId: string; candidateId: number }[] })?.selections) ?? [];
      const fam = (await vqStorage.listCharacters("GNV"))
        .filter((c) => c.familyId === familyId)
        .sort((a, b) => a.stageNumber - b.stageNumber);
      if (fam.length === 0) return res.status(404).json({ error: "no characters for this family" });
      const selByChar = new Map(selections.map((s) => [String(s.characterId), Number(s.candidateId)]));
      const missing = fam.filter((c) => !Number.isInteger(selByChar.get(c.characterId)));
      if (missing.length) {
        return res.status(400).json({ error: `All ${fam.length} stages need a selected candidate first — missing ${missing.map((m) => `Stage ${m.stageNumber}`).join(", ")}.` });
      }
      // Pre-validate EVERY selection before mutating anything (atomic-ish).
      const lockedStage = fam.find((c) => c.locked);
      if (lockedStage) {
        return res.status(423).json({ error: `Stage ${lockedStage.stageNumber} is locked — unlock it before changing the family's reference pack.` });
      }
      const toApprove: { ch: VqCharacter; candidateId: number; referenceType: VqReferenceType; identityScore: number | null; png: Buffer }[] = [];
      for (const ch of fam) {
        const candidateId = selByChar.get(ch.characterId) as number;
        const cand = await vqStorage.getArtworkCandidate(candidateId);
        if (!cand || cand.characterId !== ch.characterId || !cand.r2Key.startsWith("vq/characters/")) {
          return res.status(404).json({ error: `candidate ${candidateId} not found for ${ch.characterId}` });
        }
        if (cand.status === "rejected" || cand.status === "auto_rejected") {
          return res.status(422).json({ error: `${ch.characterId}: candidate ${candidateId} was rejected — pick another.` });
        }
        const buf = await getR2Buffer(cand.r2Key);
        if (!buf) return res.status(404).json({ error: `candidate image missing for ${ch.characterId}` });
        const guard = await validateArtwork(buf);
        if (!guard.ok) return res.status(422).json({ error: `${ch.characterId}: ${guard.error ?? "candidate failed validation"}` });
        toApprove.push({ ch, candidateId, referenceType: parseReferenceType(cand.referenceType), identityScore: cand.identityScore ?? null, png: await (await import("sharp")).default(buf).png().toBuffer() });
      }
      const approved: { characterId: string; stageNumber: number; referenceType: string; key: string }[] = [];
      for (const { ch, candidateId, referenceType, identityScore, png } of toApprove) {
        const approvedKey = assertVqWriteKey(vqCharacterApprovedKey(ch.characterId, referenceType));
        await uploadToR2(approvedKey, png, "image/png");
        await vqStorage.setCharacterReferencePack(ch.characterId, referenceType, approvedKey, candidateId, "admin", identityScore);
        await vqStorage.markArtworkCandidateStatusById(candidateId, "approved").catch(() => {});
        approved.push({ characterId: ch.characterId, stageNumber: ch.stageNumber, referenceType, key: approvedKey });
      }
      res.json({ familyId, approved });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve family references" });
    }
  });

  // ── Character Description workflow (Anthropic text only — never artwork) ────
  // Generate/Improve returns a PREVIEW of all 12 identity fields; the client fills
  // the draft, the founder edits, saves, then explicitly approves. Stage 2/3 inherit
  // the previous stage's identity and must evolve it clearly.
  app.post("/api/admin/vault-quest/characters/:characterId/describe", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      if (character.locked) return res.status(423).json({ error: "Character is locked — unlock before regenerating its description." });
      const mode = String((req.body as { mode?: string })?.mode) === "improve" ? "improve" : "generate";
      const prev = character.evolvesFromCharacterId ? (await vqStorage.getCharacter(character.evolvesFromCharacterId)) ?? null : null;
      const pick = (ch: typeof character) => Object.fromEntries(DESCRIPTION_FIELD_KEYS.map((k) => [k, (ch as unknown as Record<string, unknown>)[k] ?? ""]));
      const describeOnce = () => generateCharacterDescription(mode, {
        characterName: character.characterName,
        element: character.element,
        stageNumber: character.stageNumber,
        familyName: character.familyName,
        previous: prev ? { characterName: prev.characterName, fields: pick(prev) } : null,
        current: pick(character),
      });
      // Generation is stochastic — retry once on a malformed/incomplete result before failing.
      let result = await describeOnce();
      if (!result.fields && !/not connected/i.test(result.note ?? "")) result = await describeOnce();
      if (!result.fields) {
        const notConnected = /not connected/i.test(result.note ?? "");
        return res.status(notConnected ? 503 : 422).json({ error: result.note ?? "description generation failed" });
      }
      await vqStorage.recordAiGeneration({
        cardId: character.cardId, kind: "character-description", mode, provider: result.provider,
        model: result.model, generatedBy: "admin", prompt: `describe:${mode}`,
        output: { characterId, fields: result.fields }, applied: false,
      }).catch(() => {});
      res.json({ fields: result.fields, mode, provider: result.provider, model: result.model, disclaimer: AI_DISCLAIMER });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "description generation failed" });
    }
  });

  app.post("/api/admin/vault-quest/characters/:characterId/approve-description", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const character = await vqStorage.getCharacter(characterId);
      if (!character) return res.status(404).json({ error: "character not found" });
      const empty = DESCRIPTION_FIELD_KEYS.filter((k) => !String((character as unknown as Record<string, unknown>)[k] ?? "").trim());
      if (empty.length) return res.status(422).json({ error: `Description incomplete — fill ${empty.join(", ")} before approving.` });
      const updated = await vqStorage.setCharacterDescriptionStatus(characterId, "approved", "admin");
      res.json({ character: updated, descriptionStatus: updated.descriptionStatus });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve description" });
    }
  });

  app.post("/api/admin/vault-quest/characters/:characterId/lock", requireAdmin, async (req: Request, res: Response) => {
    try {
      const characterId = String(req.params.characterId);
      if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
      const locked = ((req.body as { locked?: boolean })?.locked ?? true) === true;
      // Locking requires the REQUIRED reference pack (Master Reference + Action Pose) to be
      // complete — defence-in-depth behind the disabled Lock button. Unlocking is always allowed.
      if (locked) {
        const existing = await vqStorage.getCharacter(characterId);
        if (!existing) return res.status(404).json({ error: "character not found" });
        if (vqPackCompleteness(existing.referencePack) !== "complete") {
          return res.status(422).json({ error: "Complete the required reference pack (Master Reference + Action Pose) before locking." });
        }
      }
      const character = await vqStorage.setCharacterLocked(characterId, locked, "admin");
      res.json({ character });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to update character lock" });
    }
  });

  // ---- cards list / get / save (DB) ----
  app.get("/api/admin/vault-quest/cards", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { setCode, status, cardType, element } = req.query as Record<string, string>;
      const cards = await vqStorage.listCards({ setCode, status, cardType, element });
      res.json({ cards });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to list cards" });
    }
  });

  app.get("/api/admin/vault-quest/cards/:cardId", requireAdmin, async (req: Request, res: Response) => {
    try {
      // Studio payload: card + family-derived previousStage/familyName + base card (variants).
      const studio = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!studio) return res.status(404).json({ error: "card not found" });
      res.json(studio);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to get card" });
    }
  });

  app.post("/api/admin/vault-quest/cards", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as VqEditorPayload;
      if (!body.cardId || !body.name || !body.cardType || !body.element) {
        return res.status(400).json({ error: "cardId, name, cardType and element are required" });
      }
      // Relational fields have no FK — validate the parents exist and share this
      // card's set, so a save can't mint a dangling variant/family reference or a
      // cross-set inheritance link (the columns are otherwise trusted verbatim).
      const cardSet = body.setCode ?? "GNV";
      if (body.baseCardId) {
        const base = await vqStorage.getCard(String(body.baseCardId));
        if (!base) return res.status(400).json({ error: "baseCardId does not reference an existing card" });
        if (base.setCode !== cardSet) return res.status(400).json({ error: "a variant and its base card must be in the same set" });
      }
      if (body.familyId) {
        const fam = await vqStorage.getFamily(String(body.familyId));
        if (!fam) return res.status(400).json({ error: "familyId does not reference an existing family" });
        if (fam.setCode !== cardSet) return res.status(400).json({ error: "a card and its family must be in the same set" });
      }
      // Single-door status: SAVE never sets a forward workflow status. A new card is
      // a draft; an existing card keeps its current status. Forward transitions
      // (ready/approved/export_ready/…) happen ONLY through /status, which runs the
      // full workflow gate. This prevents bypassing canTransition via the save route.
      const art = await fetchArt(body);
      const { qa } = await renderCard(body, art, "preview");
      const promotedMain = await promoteArtworkCandidate(body.cardId, "main", body.artCandidateKey);
      const promotedPrev = await promoteArtworkCandidate(body.cardId, "prev", body.prevArtCandidateKey);
      const existing = await vqStorage.getCard(body.cardId);
      const keepStatus = existing ? existing.status : "draft";
      const saveBody = {
        ...body,
        artR2Key: promotedMain ?? body.artR2Key,
        prevArtR2Key: promotedPrev ?? body.prevArtR2Key,
        status: keepStatus,
      };
      const saved = await vqStorage.saveCard(toInsert(saveBody), "admin");
      res.json({ card: saved, qa });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to save card" });
    }
  });

  // ---- generate a new card / family from the locked template (create-only) ----
  app.post("/api/admin/vault-quest/generate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as GenerateReq;
      if (body.mode !== "card" && body.mode !== "family") return res.status(400).json({ error: "mode must be 'card' or 'family'" });
      const result = await generate(body);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "generate failed" });
    }
  });

  // ---- AI Assist (Phases 2-7): generate PREVIEW-ONLY suggestions, audited ----
  const AI_KINDS: GenKind[] = ["name", "family-names", "gameplay", "flavour", "artwork-prompt"];
  app.post("/api/admin/vault-quest/ai/generate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as { kind?: string; mode?: string; context?: CardContext; n?: number };
      if (!body.kind || !AI_KINDS.includes(body.kind as GenKind)) return res.status(400).json({ error: `kind must be one of ${AI_KINDS.join(", ")}` });
      const ctx = (body.context ?? {}) as CardContext;
      const result = await runGenerator(body.kind as GenKind, String(body.mode ?? "generate"), ctx, Number(body.n) || 6);
      // Audit every generation (applied=false until the admin clicks Apply).
      let generationId: number | null = null;
      if (result.suggestions.length > 0) {
        generationId = await vqStorage.recordAiGeneration({
          cardId: (ctx as { cardId?: string }).cardId ?? null,
          kind: body.kind,
          mode: String(body.mode ?? "generate"),
          provider: result.provider,
          model: result.model,
          generatedBy: "admin",
          prompt: result.promptSummary,
          output: result.suggestions as unknown as Record<string, unknown>,
          applied: false,
        });
      }
      res.json({ ...result, generationId, disclaimer: AI_DISCLAIMER });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "AI generate failed" });
    }
  });

  app.post("/api/admin/vault-quest/ai/artwork", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as { context?: CardContext & { cardId?: string }; mode?: string; slot?: string; promptOverride?: string; model?: string };
      const ctx = (body.context ?? {}) as CardContext & { cardId?: string };
      const cardId = String(ctx.cardId ?? "").trim();
      if (!cardId) return res.status(400).json({ error: "Set a Card ID before generating artwork." });
      if (!validVqCardId(cardId)) return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
      const bible = await vqStorage.getCharacterBibleForCard(cardId).catch(() => undefined);
      // Text before pixels: card artwork for a Bible character requires its APPROVED description.
      if (bible?.character && bible.character.descriptionStatus !== "approved") {
        return res.status(422).json({ error: `Description not approved for ${bible.character.characterName} — approve the character description in the Character Bible before generating artwork.`, descriptionStatus: bible.character.descriptionStatus });
      }
      const promptCtx = bible?.character ? withCharacterBibleContext(ctx, bible) : ctx;
      if (!promptCtx.name && body.mode !== "family-sheet") return res.status(400).json({ error: "Set a card name before generating artwork." });
      if (!promptCtx.element) return res.status(400).json({ error: "Set an element before generating artwork." });

      const slot: ArtworkSlot = body.slot === "prev" ? "prev" : "main";
      const mode = String(body.mode ?? (slot === "prev" ? "prev-portrait" : "main")).trim() || "main";
      if ((slot === "prev" || mode === "prev-portrait") && !promptCtx.previousStage) {
        return res.status(400).json({ error: "Set the previous-stage name before generating previous-stage art." });
      }

      // Guard the USER-entered context only — never the trusted Bible fields the
      // server hydrated in (their negative prompts legitimately say "no card frame").
      const inGuard = guardInput(JSON.stringify(ctx));
      if (!inGuard.ok) return res.status(422).json({ error: `Blocked by guardrails: ${inGuard.violations.join("; ")}` });

      let prompt = buildVaultQuestArtworkPrompt(promptCtx, mode, slot);
      let promptProvider = "vault-quest-fallback";
      let promptModel = "rules";
      let promptNote: string | undefined;
      // A ready-made clean prompt (from Generate Full Card) is used as-is — but only
      // after it passes the guardrails; otherwise generate one from context.
      const override = String(body.promptOverride ?? "").trim();
      if (override && guardInput(override).ok && !guardOutput("artwork-prompt", override).hard.length) {
        prompt = override;
        promptProvider = "full-card";
        promptModel = "provided";
      } else {
        const promptResult = await runGenerator("artwork-prompt", mode, stripTrustedBibleText(promptCtx), 1).catch((err: unknown) => ({
          suggestions: [],
          provider: "none",
          model: "none",
          promptSummary: "",
          dropped: 0,
          note: err instanceof Error ? err.message : "Text prompt generator unavailable.",
        }));
        const suggestedPrompt = promptResult.suggestions[0]?.text?.trim();
        if (suggestedPrompt) {
          prompt = suggestedPrompt;
          promptProvider = promptResult.provider;
          promptModel = promptResult.model;
        } else {
          promptNote = promptResult.note;
        }
      }

      // Screen only MODEL/USER-supplied prompts (an override or a generated one) for
      // layout/IP. The rules-builder output is assembled from trusted Character Bible
      // fields and legitimately lists "no card frame / no trading card layout" as
      // negatives — it is never re-flagged. If a model prompt fails, fall back to the
      // trusted builder (whose input name/element was already guarded above).
      if (promptProvider !== "vault-quest-fallback") {
        const outGuard = guardOutput("artwork-prompt", prompt);
        if (outGuard.hard.length) {
          prompt = buildVaultQuestArtworkPrompt(promptCtx, mode, slot);
          promptProvider = "vault-quest-fallback";
          promptModel = "rules";
          promptNote = "Text prompt was blocked by guardrails, so Vault Quest used the safe fallback prompt.";
        }
      }

      // Clean provider-not-connected response (503) BEFORE attempting generation —
      // so a missing Higgsfield key on prod reports cleanly and never blocks text
      // AI or Save Draft (those are independent routes).
      const conn = higgsfieldConnection();
      if (!conn.connected) return res.status(503).json({ error: "Artwork provider not connected", provider: "higgsfield", note: conn.note, connected: false });

      // Phase 2 visual identity lock: attach the character's APPROVED references
      // (a variant's bible resolves to its BASE character, so variants reuse the
      // base pack — background/pose/lighting may change, the creature may not).
      // Stage 2/3 additionally anchor on the previous stage's pack.
      let referenceBuffers: Buffer[] = [];
      let ownRefCount = 0;
      let referencesUsed: string[] = [];
      if (bible?.character) {
        const collected = await collectReferenceImages(bible.character, bible.previousCharacter);
        referenceBuffers = collected.buffers;
        ownRefCount = collected.ownRefCount;
        referencesUsed = collected.used;
        if (ownRefCount > 0) prompt += IDENTITY_LOCK_PROMPT;
        else if (referencesUsed.length > 0) prompt += EVOLUTION_REF_PROMPT;
      }

      const artwork = await generateHiggsfieldArtwork({ prompt, mode, slot, imageReferences: referenceBuffers.length ? referenceBuffers : undefined, model: String(body.model ?? "").trim() || undefined });
      const candidateKey = assertVqWriteKey(vqArtworkCandidateKey(cardId));
      await uploadToR2(candidateKey, artwork.png, "image/png");
      // Audit is best-effort: the image is already generated + uploaded, so a
      // logging failure must NOT 500 the request (matches /ai/generate).
      let generationId: number | null = null;
      try {
        generationId = await vqStorage.recordAiGeneration({
          cardId,
          kind: "artwork-image",
          mode,
          provider: artwork.provider,
          model: artwork.model,
          generatedBy: "admin",
          prompt,
          output: {
            candidateKey,
            slot,
            width: artwork.width,
            height: artwork.height,
            jobId: artwork.jobId ?? null,
            promptProvider,
            promptModel,
            promptNote: promptNote ?? null,
          },
          applied: false,
        });
      } catch { /* audit table optional; never fail an already-generated image */ }
      const candRow = await vqStorage.recordArtworkCandidate({
        characterId: bible?.character?.characterId ?? null,
        cardId,
        slot,
        source: "generated",
        provider: artwork.provider,
        model: artwork.model,
        prompt,
        r2Key: candidateKey,
        width: artwork.width,
        height: artwork.height,
        status: "candidate",
        aiGenerationId: generationId,
        createdBy: "admin",
      }).catch(() => null);

      // Identity gate: card art must stay the SAME character as the approved pack.
      // Below-threshold results are auto-rejected — stored for audit, never shown.
      let cardIdentity: IdentityResult | null = null;
      if (bible?.character && ownRefCount > 0 && candRow) {
        const gate = await scoreAndGateCandidate(candRow.id, artwork.png, referenceBuffers.slice(0, ownRefCount), bible.character);
        cardIdentity = gate.identity;
        if (gate.autoRejected) {
          return res.status(422).json({
            error: `Identity Score ${gate.identity?.score}/${gate.identity?.threshold} — the artwork drifted from the approved character, so it was auto-rejected. Generate again.`,
            autoRejected: true,
            identityScore: gate.identity?.score ?? null,
            identityThreshold: gate.identity?.threshold ?? identityThreshold(),
          });
        }
      }

      res.status(201).json({
        identityScore: cardIdentity?.score ?? null,
        referencesUsed,
        candidateKey,
        slot,
        provider: artwork.provider,
        model: artwork.model,
        generationId,
        prompt,
        promptProvider,
        promptModel,
        note: promptNote,
        width: artwork.width,
        height: artwork.height,
        preview: `data:image/png;base64,${artwork.png.toString("base64")}`,
        disclaimer: AI_DISCLAIMER,
      });
    } catch (err) {
      // Expired/invalid token → clean 503 "provider not connected" (not a crash).
      // Higgsfield plan/credit limits → clean 402 with an actionable message.
      // Real generation faults stay 500. Text AI + Save Draft are unaffected either way.
      const msg = err instanceof Error ? err.message : "Artwork generation failed";
      const notConnected = /not connected|rejected the token|401|Invalid credentials/i.test(msg);
      const planLimit = /minimum_basic_plan|plan_required|basic_plan|not enough credits|insufficient|402|\b403\b/i.test(msg);
      if (notConnected) {
        return res.status(503).json({ error: "Artwork provider not connected — token missing or expired", connected: false });
      }
      if (planLimit) {
        return res.status(402).json({
          error: "Artwork needs a higher Higgsfield plan or more credits — text is saved; you can upload art manually.",
          connected: true,
          planLimit: true,
        });
      }
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/admin/vault-quest/ai/artwork/use", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as { cardId?: string; slot?: string; candidateKey?: string; generationId?: number | null };
      const cardId = String(body.cardId ?? "").trim();
      const candidateKey = String(body.candidateKey ?? "").trim();
      if (!cardId) return res.status(400).json({ error: "Set a Card ID before using artwork." });
      if (!validVqCardId(cardId)) return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
      if (!candidateKey || !isCandidateKeyForCard(candidateKey, cardId)) return res.status(400).json({ error: "Artwork candidate does not belong to this card." });
      const slot: ArtworkSlot = body.slot === "prev" ? "prev" : "main";
      const buf = await getR2Buffer(candidateKey);
      if (!buf) return res.status(404).json({ error: "Artwork candidate expired or was not found." });
      const guard = await validateArtwork(buf);
      if (!guard.ok) return res.status(422).json({ error: guard.error ?? "Artwork candidate failed validation." });
      // Use = attach + validate ONLY. It does not approve artwork, does not change
      // card status, and does not mark the audit applied — that happens when the
      // candidate is actually promoted into draft art on Save Draft.
      await vqStorage.markArtworkCandidateStatusByKey(candidateKey, "attached").catch(() => {});
      res.json({ candidateKey, slot, width: guard.width, height: guard.height });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to use artwork" });
    }
  });

  // Generate Full Card (one flow): all text fields + a clean artwork prompt in one
  // Anthropic call. PREVIEW-ONLY — audited, never applied/saved server-side. The
  // client applies the fields client-side, then calls /ai/artwork for the image.
  app.post("/api/admin/vault-quest/ai/full-card", requireAdmin, async (req: Request, res: Response) => {
    try {
      const ctx = ((req.body as { context?: CardContext })?.context ?? {}) as CardContext & { cardId?: string };
      const cardId = String(ctx.cardId ?? "").trim();
      if (!cardId) return res.status(400).json({ error: "Set a Card ID before generating a full card." });
      const bible = await vqStorage.getCharacterBibleForCard(cardId);
      const cardType = bible?.card.cardType ?? String(ctx.cardType ?? "");
      const isCreature = !VQ_SUPPORT_CARD_TYPES.has(cardType || "Creature");
      if (isCreature) {
        if (!bible?.character) {
          return res.status(422).json({ error: "Character Bible missing — generate text only or create Character Bible first." });
        }
        const missing = missingBibleFields(bible);
        if (missing.length) {
          return res.status(422).json({
            error: `Character Bible incomplete — add ${missing.join(", ")} before Generate Full Card.`,
            missing,
          });
        }
      }
      const safeCtx = bible?.character ? withCharacterBibleContext(ctx, bible) : ctx;
      const result = await generateFullCard(safeCtx);
      if (!result.fields || Object.keys(result.fields).length === 0) {
        const notConnected = /not connected/i.test(result.note ?? "");
        return res.status(notConnected ? 503 : 422).json({ error: result.note ?? "Full card generation failed" });
      }
      // Full Card artwork requires an APPROVED description (text before pixels) and then
      // keys off the approved MASTER REFERENCE (pack entry, synced to approvedArtworkR2Key).
      const hasMasterPortrait = !!(bible?.character?.referencePack?.master_portrait?.r2Key || bible?.character?.approvedArtworkR2Key);
      const descriptionApproved = bible?.character?.descriptionStatus === "approved";
      const artworkBlockedReason =
        isCreature && bible?.character && !descriptionApproved
          ? "Description not approved — Full Card drafted text only. Approve the character description in the Character Bible before generating Full Card artwork."
          : isCreature && bible?.character && !hasMasterPortrait
            ? "Approved Master Reference missing — Full Card drafted text only. Approve a Master Reference in the Character Bible before generating Full Card artwork."
            : undefined;
      try {
        await vqStorage.recordAiGeneration({
          cardId,
          kind: "full-card",
          mode: "generate",
          provider: result.provider,
          model: result.model,
          generatedBy: "admin",
          prompt: bible?.character ? "full-card-character-bible" : "full-card",
          output: {
            fields: result.fields,
            characterId: bible?.character?.characterId ?? null,
            artworkBlockedReason: artworkBlockedReason ?? null,
          },
          applied: false,
        });
      } catch { /* audit best-effort; never fail the suggestion */ }
      res.json({
        fields: result.fields,
        artworkPrompt: artworkBlockedReason ? "" : result.artworkPrompt,
        artworkBlockedReason,
        warnings: result.warnings,
        disclaimer: AI_DISCLAIMER,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "full card generation failed" });
    }
  });

  app.post("/api/admin/vault-quest/ai/generations/:id/applied", requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });
      await vqStorage.markAiGenerationApplied(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed" });
    }
  });

  // taxonomy for the dropdowns + provider status (keywords/effects derived from cards)
  app.get("/api/admin/vault-quest/taxonomy", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const cards = await vqStorage.listCards({ setCode: "GNV" });
      const keywords = new Set<string>();
      const effects = new Set<string>();
      for (const c of cards) {
        (c.keywords ?? []).forEach((k) => k && keywords.add(k));
        const eff = c.effects;
        if (Array.isArray(eff)) (eff as unknown[]).forEach((e) => typeof e === "string" && e && effects.add(e));
      }
      res.json({ keywords: [...keywords].sort(), effects: [...effects].sort(), providers: providerStatuses() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "taxonomy failed" });
    }
  });

  // add-new element (placeholder palette, NEEDS_APPROVAL by convention)
  app.post("/api/admin/vault-quest/elements", requireAdmin, async (req: Request, res: Response) => {
    try {
      const name = String((req.body as { name?: string }).name ?? "").trim();
      if (!/^[A-Za-z][A-Za-z0-9 ]{0,23}$/.test(name)) return res.status(400).json({ error: "element name must be 1-24 letters/digits/spaces" });
      const el = await vqStorage.createElement(name);
      res.status(201).json({ element: el.name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "add element failed" });
    }
  });

  // add-new family (auto id, create-only, no cards)
  app.post("/api/admin/vault-quest/families", requireAdmin, async (req: Request, res: Response) => {
    try {
      const b = req.body as { name?: string; element?: string; stage1Name?: string; stage2Name?: string; stage3Name?: string; setCode?: string };
      const name = String(b.name ?? "").trim();
      const element = String(b.element ?? "").trim();
      if (!name || !element) return res.status(400).json({ error: "family name and element are required" });
      const setCode = (b.setCode ?? "GNV").trim() || "GNV";
      const existing = await vqStorage.listFamilies(setCode);
      let max = 0;
      for (const f of existing) { const m = /F(\d+)/.exec(f.familyId ?? ""); if (m) max = Math.max(max, Number(m[1])); }
      const familyId = `${setCode}-F${String(max + 1).padStart(2, "0")}`;
      await vqStorage.createFamilyAndCards(
        { familyId, setCode, element, name, stage1Name: b.stage1Name?.trim() || null, stage2Name: b.stage2Name?.trim() || null, stage3Name: b.stage3Name?.trim() || null },
        [],
      );
      res.status(201).json({ familyId, name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "add family failed" });
    }
  });

  // ---- live preview (DB-free) ----
  app.post("/api/admin/vault-quest/cards/preview", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as VqEditorPayload & { artCandidateKey?: string | null; prevArtCandidateKey?: string | null; cardId?: string };
      let art = await fetchArt(body);
      // Show an un-promoted artwork candidate in the preview (read-only; the key must
      // belong to this card). Lets Generate Full Card / Use Image preview before Save.
      const cid = String(body.cardId ?? "").trim();
      if (body.artCandidateKey && cid && isCandidateKeyForCard(body.artCandidateKey, cid)) {
        const buf = await getR2Buffer(body.artCandidateKey);
        if (buf) art = { ...art, mainArt: buf };
      }
      if (body.prevArtCandidateKey && cid && isCandidateKeyForCard(body.prevArtCandidateKey, cid)) {
        const buf = await getR2Buffer(body.prevArtCandidateKey);
        if (buf) art = { ...art, prevArt: buf };
      }
      const { qa, previewPng } = await renderCard(body, art, "preview");
      res.json({
        qa,
        preview: previewPng ? `data:image/png;base64,${previewPng.toString("base64")}` : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "preview failed" });
    }
  });

  // ---- export svg/png/pdf (DB-free) ----
  app.post("/api/admin/vault-quest/cards/export/:fmt", requireAdmin, async (req: Request, res: Response) => {
    const fmt = String(req.params.fmt);
    if (!["svg", "png", "pdf"].includes(fmt)) return res.status(400).json({ error: "fmt must be svg, png or pdf" });
    try {
      const body = req.body as VqEditorPayload;
      const art = await fetchArt(body);
      const result = await renderCard(body, art, "all");
      if (result.qa.status === "reject") return res.status(422).json({ error: "card fails QA", qa: result.qa });
      const base = (body.cardId || "card").replace(/[^A-Za-z0-9._-]/g, "_");
      if (fmt === "svg") {
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.svg"`);
        return res.send(result.svg);
      }
      if (fmt === "png") {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.png"`);
        // 600-DPI master (print-grade), not the 300-DPI live-preview PNG.
        return res.send(result.masterPng ?? result.previewPng);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
      return res.send(result.pdf ? normalizePdf(result.pdf) : result.pdf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "export failed" });
    }
  });

  // ---- artwork upload -> R2 vq/art/ (served later by id) ----
  app.post(
    "/api/admin/vault-quest/cards/:cardId/art",
    requireAdmin,
    toolsUpload.single("file"),
    async (req: Request, res: Response) => {
      try {
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) return res.status(400).json({ error: "no file uploaded (field 'file')" });
        const guard = await validateArtwork(file.buffer);
        if (!guard.ok) return res.status(400).json({ error: guard.error });
        const cardId = String(req.params.cardId);
        // Root cause fix: params are URL-decoded, so a crafted id could smuggle
        // "../" into the key. Validate the id, then hard-guard the final key.
        if (!validVqCardId(cardId)) return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
        const slot = (req.query.slot as string) === "prev" ? "prev" : "main";
        const png = await (await import("sharp")).default(file.buffer).png().toBuffer();
        const key = assertVqWriteKey(vqArtKey(cardId, slot));
        await uploadToR2(key, png, "image/png");
        res.json({ key, slot, width: guard.width, height: guard.height });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "upload failed" });
      }
    },
  );

  // ---- serve stored artwork BY CARD ID (never the raw R2 key) ----
  app.get("/api/admin/vault-quest/cards/:cardId/art/:slot", requireAdmin, async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      if (!validVqCardId(cardId)) return res.status(400).json({ error: "invalid card id" });
      const slot = String(req.params.slot) === "prev" ? "prev" : "main";
      const key = `vq/art/${cardId}/${slot}.png`;
      const buf = await getR2Buffer(key);
      if (!buf) return res.status(404).json({ error: "no artwork on file" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load artwork" });
    }
  });

  // ---- import a card master (CSV/JSON) ----
  // Dry run by default: parses + validates every row and returns the report,
  // touching NO database — usable before the vq_ tables exist. `?commit=true`
  // writes set/families/config/cards to the DB, which requires the vq_ tables
  // (the DB push is a separate, founder-approved gate). Same importer as the
  // `seed.ts` CLI, so the canonical 150-card master imports with no code change.
  app.post(
    "/api/admin/vault-quest/import",
    requireAdmin,
    toolsUpload.single("file"),
    async (req: Request, res: Response) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) return res.status(400).json({ error: "no file uploaded (field 'file')" });
      const os = await import("os");
      const nodePath = await import("path");
      const fs = await import("fs/promises");
      const ext = /\.json$/i.test(file.originalname || "") ? ".json" : ".csv";
      const tmp = nodePath.join(os.tmpdir(), `vq-import-${Date.now()}-${process.pid}${ext}`);
      try {
        await fs.writeFile(tmp, file.buffer);
        const { importMaster } = await import("../vault-quest/seed");
        const report = await importMaster(tmp, { commit: req.query.commit === "true", editedBy: "admin-import" });
        res.json({ report });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "import failed" });
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    },
  );

  // ---- dashboard aggregates (fast, render-free) ----
  app.get("/api/admin/vault-quest/dashboard", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await vqStorage.dashboardSummary(String(req.query.setCode || "GNV")));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "dashboard failed" });
    }
  });

  // ---- families ----
  app.get("/api/admin/vault-quest/families", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json({ families: await vqStorage.listFamilies() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to list families" });
    }
  });
  app.get("/api/admin/vault-quest/families/:familyId", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await vqStorage.familyTree(String(req.params.familyId)));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load family" });
    }
  });

  // ---- revisions (history) ----
  app.get("/api/admin/vault-quest/cards/:cardId/revisions", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json({ revisions: await vqStorage.listRevisions(String(req.params.cardId)) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load revisions" });
    }
  });

  // ---- full QA evaluation for a saved card (resolves variants + runs render QA) ----
  app.get("/api/admin/vault-quest/cards/:cardId/evaluate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const studio = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!studio) return res.status(404).json({ error: "card not found" });
      const art = await fetchArt(studio.card);
      const evaluation = await evaluateCard({ card: studio.card, previousStage: studio.previousStage, familyName: studio.familyName, base: studio.base, mainArt: art.mainArt, prevArt: art.prevArt });
      res.json(evaluation);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "evaluation failed" });
    }
  });

  // ---- status transition (gated by the workflow + QA) ----
  app.post("/api/admin/vault-quest/cards/:cardId/status", requireAdmin, async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      const body = req.body as { to?: string; note?: string; override?: boolean };
      if (!body.to || !isVqStatus(body.to)) return res.status(400).json({ error: "invalid target status" });
      const studio = await vqStorage.getStudioCard(cardId);
      if (!studio) return res.status(404).json({ error: "card not found" });
      const from = isVqStatus(studio.card.status) ? studio.card.status : "draft";
      const art = await fetchArt(studio.card);
      const evaluation = await evaluateCard({ card: studio.card, previousStage: studio.previousStage, familyName: studio.familyName, base: studio.base, mainArt: art.mainArt, prevArt: art.prevArt });
      const check = canTransition(from, body.to, evaluation.gates, !!body.override);
      if (!check.ok) return res.status(422).json({ error: "transition blocked", reasons: check.reasons, evaluation });
      const card = await vqStorage.setCardStatusAudited(cardId, body.to, body.note, "admin", from);
      res.json({ card, evaluation: { ...evaluation, status: body.to } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "transition failed";
      // A lost compare-and-set (another tab changed the status first) is a conflict,
      // not a server fault — tell the client to reload, don't surface a 500.
      if (/concurrently|status changed/i.test(msg)) return res.status(409).json({ error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // ---- render a SAVED card by id (resolves variant + art from R2) ----
  app.get("/api/admin/vault-quest/cards/:cardId/render/:fmt", requireAdmin, async (req: Request, res: Response) => {
    const fmt = String(req.params.fmt);
    if (!["svg", "png", "pdf"].includes(fmt)) return res.status(400).json({ error: "fmt must be svg, png or pdf" });
    try {
      const studio = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!studio) return res.status(404).json({ error: "card not found" });
      const { result } = await renderSavedFromStudio(studio, "all");
      if (result.qa.status === "reject") return res.status(422).json({ error: "card fails QA", qa: result.qa });
      const fname = studio.card.cardId.replace(/[^A-Za-z0-9._-]/g, "_");
      if (fmt === "svg") { res.setHeader("Content-Type", "image/svg+xml"); res.setHeader("Content-Disposition", `attachment; filename="${fname}.svg"`); return res.send(result.svg); }
      if (fmt === "png") { res.setHeader("Content-Type", "image/png"); res.setHeader("Content-Disposition", `attachment; filename="${fname}.png"`); return res.send(result.masterPng ?? result.previewPng); }
      res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${fname}.pdf"`); return res.send(result.pdf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "render failed" });
    }
  });

  // ---- Export Centre + Proxy (Phases 10/11) ----
  type Selector = { ids?: string[]; familyId?: string; status?: string; approvedOnly?: boolean };
  const MAX_BATCH = 200; // hard cap: bounds render work + blocks a crafted huge `ids` DoS
  async function resolveCardIds(sel: Selector): Promise<string[]> {
    let ids: string[];
    if (sel.ids?.length) {
      ids = sel.ids;
    } else {
      let cards = await vqStorage.listCards({ setCode: "GNV" });
      if (sel.familyId) cards = cards.filter((c) => c.familyId === sel.familyId);
      if (sel.status) cards = cards.filter((c) => c.status === sel.status);
      if (sel.approvedOnly) cards = cards.filter((c) => ["approved", "export_ready", "printed_proxy"].includes(c.status));
      ids = cards.map((c) => c.cardId);
    }
    return ids.slice(0, MAX_BATCH);
  }

  // set-integrity QA (collector-number uniqueness / completeness / base refs)
  app.get("/api/admin/vault-quest/qa/set", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(setIntegrity(await vqStorage.listCards({ setCode: "GNV" })));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "set QA failed" });
    }
  });

  // per-card metadata JSON (print house)
  app.get("/api/admin/vault-quest/cards/:cardId/metadata", requireAdmin, async (req: Request, res: Response) => {
    try {
      const s = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!s) return res.status(404).json({ error: "card not found" });
      res.json(cardMetadata(s.card, s.previousStage));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "metadata failed" });
    }
  });

  // batch QA matrix (dashboard "Run QA" over a selection; capped)
  app.post("/api/admin/vault-quest/qa/batch", requireAdmin, async (req: Request, res: Response) => {
    try {
      const ids = await resolveCardIds(req.body as Selector);
      // One batched load (2 queries) instead of 3 queries per card, then art is
      // fetched only for cards that actually have artwork on file.
      const studios = await vqStorage.getStudioCardsBatch(ids);
      const results = [];
      for (const s of studios) {
        const art = await fetchArt(s.card);
        const e = await evaluateCard({ card: s.card, previousStage: s.previousStage, familyName: s.familyName, base: s.base, mainArt: art.mainArt, prevArt: art.prevArt });
        results.push({ cardId: s.card.cardId, status: e.status, render: e.renderStatus, readiness: e.readiness, rejects: e.qa.filter((i) => i.level === "reject").length });
      }
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "batch QA failed" });
    }
  });

  // Export/proxy are async background jobs: POST kicks the job off and returns a
  // jobId immediately (no request timeout / no event-loop block), the client polls
  // status for progress, then downloads the finished file. See export-jobs.ts.
  function startBatch(kind: "pack" | "proxy") {
    return async (req: Request, res: Response) => {
      try {
        const ids = await resolveCardIds(req.body as Selector);
        if (!ids.length) return res.status(400).json({ error: "no cards selected" });
        const { id } = startExportJob(kind, ids);
        res.status(202).json({ jobId: id, count: ids.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : `${kind} failed to start`;
        // Concurrency back-pressure is a "try again shortly", not a server error.
        if (/too many exports/i.test(msg)) return res.status(429).json({ error: msg });
        res.status(500).json({ error: msg });
      }
    };
  }

  // proxy sheet PDF (A4 3×3) — background job
  app.post("/api/admin/vault-quest/proxy", requireAdmin, startBatch("proxy"));
  // export pack (.zip): svg/png/pdf + per-card metadata + manifest + checksums — background job
  app.post("/api/admin/vault-quest/export/pack", requireAdmin, startBatch("pack"));

  // job progress (poll)
  app.get("/api/admin/vault-quest/export/jobs/:id", requireAdmin, (req: Request, res: Response) => {
    const job = getExportJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: "job not found or expired" });
    res.json(jobStatus(job));
  });

  // download the finished file (streamed from the temp file; kept until TTL so it
  // can be re-downloaded)
  app.get("/api/admin/vault-quest/export/jobs/:id/file", requireAdmin, async (req: Request, res: Response) => {
    const job = getExportJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: "job not found or expired" });
    if (job.state === "running") return res.status(409).json({ error: "export still running" });
    if (job.state === "error") return res.status(422).json({ error: job.error ?? "export failed" });
    if (!job.filePath) return res.status(410).json({ error: "export file no longer available" });
    const fs = await import("fs");
    if (!fs.existsSync(job.filePath)) return res.status(410).json({ error: "export file no longer available" });
    res.setHeader("Content-Type", job.contentType ?? "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${job.fileName ?? "export.bin"}"`);
    if (job.bytes) res.setHeader("Content-Length", String(job.bytes));
    const stream = fs.createReadStream(job.filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "failed to read export file" });
      else res.destroy();
    });
    // if the client disconnects mid-download, tear the read stream down (no fd leak)
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
}
