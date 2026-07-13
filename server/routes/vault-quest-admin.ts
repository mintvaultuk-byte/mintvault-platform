/**
 * Vault Quest admin routes (Phase 1b) — all under /api/admin/vault-quest, all
 * behind requireAdmin. Isolated: imports only the VQ storage/render/guard modules
 * plus shared infra (requireAdmin, r2, multer config). Touches no grading route.
 *
 * Render endpoints (preview/export) are DB-free — they render from the posted
 * card and optional R2 artwork, so they work before the vq_ tables are pushed.
 * List/get/save require the vq_ tables (staging push, gated behind the deploy hold).
 */
import type { Express, Request, Response, NextFunction } from "express";
import { requireAdmin } from "../auth";
import { uploadToR2, getR2Buffer } from "../r2";
import { toolsUpload } from "../lib/multer-configs";
import { vqStorage, type CharacterBibleContext, type CharacterBiblePatch } from "../vault-quest/storage";
import { validateArtwork } from "../vault-quest/upload-guard";
import { intOrNull, isCandidateReferencedInPack } from "../vault-quest/lib/write-sanitize";
import { renderCard, type RenderCardInput } from "../vault-quest/render-service";
import { evaluateCard } from "../vault-quest/qa-engine";
import {
  vqCharacterArtworkKey,
  vqCharacterCandidateKey,
  fetchArt,
  renderSavedFromStudio,
  assertVqWriteKey,
  assertVqReadKey,
} from "../vault-quest/render-saved";
import { normalizePdf } from "../vault-quest/pdf-normalize";
import { VQ_ELEMENTS, VQ_ELEMENTS_NEEDS_APPROVAL } from "../vault-quest/lib/vq-constants";
import { canTransition, isVqStatus } from "@shared/vq-workflow";
import { setIntegrity, cardMetadata } from "../vault-quest/qa-set";
import { startExport, getExportStatusView, resolveExportDownload } from "../vault-quest/export-jobs";
import { getR2ObjectStream } from "../r2";
import { checkGenerationSpend } from "../vault-quest/lib/generation-guard";
import {
  reserveOrDecide,
  finalizeSuccess,
  finalizeFailure,
  classifyAndMapThrown,
  idempotencyResponseFor,
} from "../vault-quest/lib/generation-idempotency-store";
import { checkVqFeature, setVqFeatureFlag } from "../vault-quest/lib/vq-feature-flags-store";
import { getVqOpsStatus } from "../vault-quest/lib/vq-ops-status";
import {
  promoteCardArtRevision,
  promoteCharacterReferenceRevision,
  listRevisionHistory,
  restoreArtworkRevision,
  getActiveRevisionKey,
  getRevisionById,
} from "../vault-quest/lib/vq-artwork-revisions-store";
import type { VqFeature } from "../vault-quest/lib/vq-feature-state";
import type { GenerationPayload } from "../vault-quest/lib/generation-idempotency";
import { randomUUID } from "crypto";
import { generate, type GenerateReq } from "../vault-quest/generate";
import {
  runGenerator,
  generateFullCard,
  generateCharacterDescription,
  DESCRIPTION_FIELD_KEYS,
  type GenKind,
  type CardContext,
} from "../vault-quest/ai/generators";
import { providerStatuses } from "../vault-quest/ai/provider";
import { AI_DISCLAIMER, guardInput, guardOutput } from "../vault-quest/ai/guardrails";
import {
  buildVaultQuestArtworkPrompt,
  generateHiggsfieldArtwork,
  higgsfieldConnection,
  higgsfieldCreditsPerImage,
  effectiveCreditsPerImage,
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
import { scoreEvolutionDifference, type EvolutionDifferenceVerdict } from "../vault-quest/ai/evolution-diversity";
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
    // Phase 10A-6 (R5-F1): pass through VERBATIM — the caller (the /cards route) has
    // ALREADY resolved this to a safe, server-known value (a freshly promoted revision
    // key, or the card's own existing DB value) before calling toInsert. Re-deriving
    // vqArtKey(cardId, slot) here would silently discard a real immutable revisioned
    // pointer and reset display to the legacy flat key on every save without a new
    // candidate — never trust a raw client-supplied string directly, but toInsert is
    // never handed one; the route resolves it first (see promoteArtworkCandidate below).
    artR2Key: body.artR2Key ?? null,
    prevArtR2Key: body.prevArtR2Key ?? null,
    setCode: body.setCode ?? "GNV",
    language: body.language ?? "EN",
    year: intOrNull(body.year) ?? 2026,
    edition: body.edition ?? "FIRST EDITION",
    status: body.status ?? "draft",
    notes: body.notes ?? null,
  };
}

/**
 * Promote a generated candidate into the card's DRAFT art slot as an immutable
 * revision (Phase 10A-6, R5-F1/F2) — replaces the old overwrite-in-place
 * `uploadToR2(vqArtKey(cardId,slot), ...)`. The upload+ledger+pointer swap is
 * atomic (see vq-artwork-revisions-store.ts): if anything fails, the card's
 * CURRENT art is completely untouched.
 */
async function promoteArtworkCandidate(
  cardId: string,
  slot: ArtworkSlot,
  candidateKey?: string | null,
  actor?: string | null
): Promise<string | null> {
  const key = String(candidateKey ?? "").trim();
  if (!key) return null;
  if (!validVqCardId(cardId)) throw new Error("Card ID can only use letters, numbers, dots, dashes, and underscores.");
  if (!isCandidateKeyForCard(key, cardId)) throw new Error("Artwork candidate does not belong to this card.");
  const buf = await getR2Buffer(key);
  if (!buf) throw new Error("Artwork candidate expired or was not found.");
  const guard = await validateArtwork(buf);
  if (!guard.ok) throw new Error(guard.error ?? "Artwork candidate failed validation.");
  const png = await (await import("sharp")).default(buf).png().toBuffer();
  const { r2Key } = await promoteCardArtRevision({
    cardId,
    slot,
    buffer: png,
    width: guard.width,
    height: guard.height,
    createdBy: actor ?? null,
  });
  // The candidate is now actually promoted into draft art — flip the audit flag
  // here (on Save Draft), not on Use. Best-effort: never fail the save.
  await vqStorage.markAiGenerationAppliedByCandidate(key).catch(() => {});
  await vqStorage.markArtworkCandidateStatusByKey(key, "draft_saved").catch(() => {});
  return r2Key;
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
  "previousCharacterDna",
  "previousVisualDescription",
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
  // master_portrait AND action_pose are both built by studioReferencePrompt() (strict,
  // shared studio rules) — these two strings are not used for prompt construction.
  master_portrait: "Reference type: MASTER REFERENCE — permanent studio character reference on a plain background.",
  action_pose:
    "Reference type: ACTION POSE — the SAME character caught mid-action on the SAME plain studio backdrop as the Master Reference.",
  face_closeup:
    "Reference type: FACE CLOSE-UP — head and face only, filling the frame: clear eyes, ears, facial markings and a characterful expression.",
  colour_sheet:
    "Reference type: COLOUR SHEET — neutral flat lighting on a plain background, colours rendered perfectly accurate to the palette, no dramatic shadows or stylised colour grading.",
  turnaround_sheet:
    "Reference type: TURNAROUND SHEET — model-sheet style turnaround of the same character: front view, side view and back view side by side, consistent proportions, plain background.",
};
const VALID_REFERENCE_TYPES = new Set<string>(VQ_REFERENCE_TYPES.map((t) => t.value));
// Master Reference candidate count (founder decision) — ALWAYS this many, enforced
// server-side regardless of what a client requests. Every candidate independently
// passes the SAME identity/background/evolution-difference gates either way, so
// fewer candidates does not mean lower quality, only fewer choices to review.
// The ONLY place this count is defined — spend estimate, D10 payload count and the
// generation loop below all read this constant, so it can never drift out of sync.
const MASTER_CANDIDATE_COUNT = 2;
function parseReferenceType(v: unknown): VqReferenceType {
  const s = String(v ?? "").trim();
  return (VALID_REFERENCE_TYPES.has(s) ? s : "master_portrait") as VqReferenceType;
}

// MASTER REFERENCE + ACTION REFERENCE — both are permanent PRODUCTION REFERENCE LIBRARY
// assets, not finished illustration artwork, and both must resemble a professional
// character turnaround/reference sheet. The approved Master establishes the canonical
// studio environment (background, lighting, framing); the Action Reference exists purely
// to teach the system how the creature moves while preserving that exact environment —
// so the two prompts share ONE builder and differ ONLY in the `poseSection` argument.
// Built from the DNA atoms (NOT the illustration-flavoured masterArtworkPrompt, whose
// "cinematic lighting" language fights the studio rules).
function studioReferencePrompt(ch: VqCharacter, poseSection: string): string {
  const t = (v: unknown) => String(v ?? "").trim();
  const idBits = [
    `${ch.characterName}, an original ${t(ch.element) || "elemental"} creature`,
    t(ch.bodyShape) && `body shape: ${t(ch.bodyShape)}`,
    t(ch.colours) && `colours: ${t(ch.colours)}`,
    t(ch.markings) && `markings: ${t(ch.markings)}`,
    t(ch.eyes) && `eyes: ${t(ch.eyes)}`,
    t(ch.tailAccessories) && `tail/accessories: ${t(ch.tailAccessories)}`,
  ]
    .filter(Boolean)
    .join("; ");
  const visual = t(ch.visualDescription);
  const ownNeg = t(ch.negativePrompt);
  return [
    "Create a high-quality 2D illustrated character reference in the premium Vault Quest trading-card art style — an official animation / model reference of the character for the production reference library, NOT a finished illustration and NOT a dramatic action scene.",
    "Style: hand-drawn 2D cartoon/anime creature illustration, premium collectible-card art quality, clean crisp linework and soft cel shading — the same look as Vault Quest card artwork. It is a flat 2D illustration serving as a permanent studio character reference, like a professional character turnaround/reference sheet. It is NOT a 3D render, NOT CGI, NOT a sculpted or vinyl toy, NOT a plastic or clay model, NOT concept art, NOT a promotional scene, and NOT a framed trading card.",
    `Subject: ${idBits}.`,
    visual ? `Locked visual description: ${visual}.` : "",
    "BACKGROUND (must be absolutely plain): a single flat colour — pure white (#FFFFFF), OR very light cream, OR very light neutral grey. One solid uniform colour edge to edge. The ONLY thing allowed on the background is a single soft contact shadow directly beneath the feet. Absolutely no gradient, no scenery, no forests, no rocks, no environment, no floor, no horizon, no props, no decorative elements, no texture, no vignette, no glow, no smoke, no particles, no atmospheric effects, no environmental lighting, no lighting effects, and no colour other than the plain backdrop.",
    poseSection,
    "Camera: eye level. The creature occupies roughly 70% of the frame, centred with clear plain margin on every side. Portrait orientation, high resolution.",
    "Lighting: soft and even from the front. No coloured lighting, no rim lighting, no dramatic or cinematic lighting, no environmental lighting, no cinematic depth-of-field. Only the one soft contact shadow under the feet.",
    "Identity is LOCKED — never change the body shape, silhouette, colours, markings, eyes, tail, accessories, species, proportions, face, ear shape or eye spacing.",
    `Negative — strictly avoid: no scenery; no forests; no rocks; no environment; no background objects or props; no flames or fire behind the creature; no smoke; no fog; no particles; no embers; no sparkles; no glowing background; no atmospheric effects; no environmental lighting; no lighting effects; no coloured backdrop; no gradient; no textured background; no floor texture; no horizon; no vignette; no decorative elements; no motion effects; no cinematic depth of field; no bokeh; no lens blur; no dramatic shadows (only one soft contact shadow under the feet); no 3D render; no CGI; no sculpture; no vinyl toy; no plastic or clay model; no card frame; no trading card layout; no logo; no text; no letters; no numbers; no words; no captions; no title; no labels; no name plate; no colour palette; no swatches; no model-sheet annotations; no watermark; no UI.${ownNeg ? ` ${ownNeg}` : ""}`,
  ]
    .filter(Boolean)
    .join(" ");
}

const MASTER_POSE_SECTION =
  "Pose: standing naturally in a calm neutral pose, facing roughly 30–45° towards the camera, the ENTIRE creature completely visible from head to toe — never crop the ears, tail or feet. Not aggressive, not jumping, not attacking, not running, no motion effects. A neutral, natural facial expression.";

function masterReferencePrompt(ch: VqCharacter): string {
  return studioReferencePrompt(ch, MASTER_POSE_SECTION);
}

// ACTION REFERENCE: the ONLY intentional differences from the Master are pose, movement,
// expression, limb positions, body rotation, head angle and tail position — background,
// lighting, framing and art style are IDENTICAL (enforced by sharing studioReferencePrompt
// verbatim). Finished environmental artwork belongs later, during card-art generation.
const ACTION_POSE_SECTION =
  "Pose: the SAME character caught mid-action on the SAME plain studio backdrop as the Master Reference — genuinely running, leaping, attacking, dodging, crouching to pounce, roaring, or twisting through the air. Limb positions, body rotation, head angle and tail position MUST be substantially and unmistakably different from the Master's neutral standing pose — this is NOT a standing pose with a slightly different camera angle, it is a completely different physical action. The ENTIRE creature must remain completely visible from head to toe at all times — never crop the ears, tail or feet, even mid-action. Match the Master's exact framing and camera distance; only the pose itself changes.";

function actionReferencePrompt(ch: VqCharacter): string {
  return studioReferencePrompt(ch, ACTION_POSE_SECTION);
}

// Appended on a retry after the background validation fails — turns the plain-background
// instruction up to maximum emphasis. Shared by Master and Action Reference retries.
const STRICTER_BG_SUFFIX =
  " CRITICAL: the previous attempt had an unacceptable background. The background MUST be one single flat plain colour (pure white #FFFFFF, light cream, or light neutral grey) with NOTHING on it except a soft contact shadow under the feet. Zero scenery, zero forests, zero rocks, zero smoke, zero particles, zero atmospheric or environmental effects, zero gradient, zero texture, zero colour in the background. Isolate the creature completely on an empty plain studio backdrop, exactly like the Master Reference.";

function characterMasterArtworkPrompt(
  ch: VqCharacter,
  prev?: VqCharacter | null,
  referenceType: VqReferenceType = "master_portrait"
): string {
  // Master Reference and Action Reference = strict, SHARED studio rules (same background/
  // lighting/framing, differing only in pose). Face Close-up / Colour Sheet / Turnaround
  // keep their own styling (unchanged).
  if (referenceType === "master_portrait") return masterReferencePrompt(ch);
  if (referenceType === "action_pose") return actionReferencePrompt(ch);
  const master = (ch.masterArtworkPrompt ?? "").trim();
  const dna = (ch.characterDna ?? "").trim();
  const visual = (ch.visualDescription ?? "").trim();
  const base =
    master || [`Standalone original character artwork of ${ch.characterName}.`, visual, dna].filter(Boolean).join(" ");
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
async function collectReferenceImages(
  character: VqCharacter,
  prevCharacter?: VqCharacter | null
): Promise<{ buffers: Buffer[]; used: string[]; ownRefCount: number }> {
  const buffers: Buffer[] = [];
  const used: string[] = [];
  let ownRefCount = 0;
  for (const t of VQ_REFERENCE_TYPES) {
    const key = character.referencePack?.[t.value]?.r2Key;
    if (!key || !key.startsWith("vq/characters/")) continue;
    const buf = await getR2Buffer(key);
    if (buf) {
      buffers.push(buf);
      used.push(`own:${t.value}`);
      ownRefCount++;
    }
  }
  if (prevCharacter) {
    for (const t of PREV_STAGE_ANCHOR_TYPES) {
      const key = prevCharacter.referencePack?.[t]?.r2Key;
      if (!key || !key.startsWith("vq/characters/")) continue;
      const buf = await getR2Buffer(key);
      if (buf) {
        buffers.push(buf);
        used.push(`prev:${t}`);
      }
    }
  }
  return { buffers, used, ownRefCount };
}

// Identity-lock framing appended when references are attached. Own refs ⇒ SAME
// creature, only pose/camera/lighting/background/expression/action may change.
// Prev-stage refs only ⇒ evolution of that creature line, never a new species.
const IDENTITY_LOCK_PROMPT =
  " The attached reference images ARE this exact character — its permanent locked visual identity. Reproduce the SAME creature with identical proportions, markings, colours, eyes, ears, tail, body shape and silhouette. ONLY the pose, camera angle, lighting, background, expression and action may differ from the references.";
// Action Reference override: unlike the general IDENTITY_LOCK_PROMPT above (still used
// for face/colour/turnaround references, where a different background or framing is
// fine), the Action Reference must NOT vary background, lighting or framing from the
// Master — those are part of its locked identity too. Only pose-related attributes may
// change. See studioReferencePrompt/ACTION_POSE_SECTION for the matching base prompt.
const ACTION_IDENTITY_LOCK_PROMPT =
  " The attached reference images ARE this exact character — its permanent locked visual identity, including its exact plain studio background, lighting and camera framing. Reproduce the SAME creature with identical proportions, markings, colours, eyes, ears, tail, body shape and silhouette, on the SAME plain background with the SAME lighting and framing as the Master Reference. The ONLY things that may differ from the references are the pose, movement, expression, limb positions, body rotation, head angle and tail position — nothing else.";
const EVOLUTION_REF_PROMPT =
  " The attached reference images show the PREVIOUS evolution stage of this creature line. Design THIS stage as a clear evolution of that same creature — same family visual language, same core colours and markings, grown larger and more mature. Never a different species.";

// Action Reference pose-diversity fix: IDENTITY_LOCK_PROMPT above is deliberately
// permissive about pose ("ONLY the pose ... may differ") — correct for identity,
// but on its own it gives the generator no PRESSURE to actually change the pose, so
// it kept defaulting to a near-duplicate of the Master's neutral stance. This mandate
// is appended ONLY for action_pose generations, on top of the identity lock, so
// identity stays non-negotiable while pose variation becomes an explicit requirement
// rather than an afterthought.
const POSE_DIVERSITY_MANDATE =
  " CRITICAL POSE REQUIREMENT: this image's pose MUST be substantially and unmistakably different from the character's neutral standing Master Reference — different limb positions, different head/camera angle, different weight distribution, different silhouette. A pose that merely repeats a standing/neutral stance with only minor rotation is UNACCEPTABLE. Show the character genuinely captured in motion or an active stance — running, jumping, attacking, landing, roaring, dodging, charging, celebrating, crouching, a defensive stance, looking backwards, casting an ability, interacting with an object — never a near-duplicate of a standing reference.";
// Appended on a retry after the pose-diversity check fails (mirrors STRICTER_BG_SUFFIX).
const STRICTER_POSE_SUFFIX =
  " CRITICAL: the previous attempt was rejected for looking too similar to the neutral standing Master Reference. Go further — pick a clearly dynamic, energetic action (mid-run, mid-leap, mid-attack, airborne, twisting) with an obviously different silhouette and camera angle, not a minor variation on standing still.";

// Evolution-differentiation fix: the existing EVOLUTION_REF_PROMPT is deliberately
// gentle ("grown larger and more mature") — correct as a soft base framing, but on
// its own it gave the model no real pressure to differentiate, so Stage 2/3 Master
// References kept coming back as near-duplicates of the previous stage with only a
// minor appendage/accessory change. This mandate is appended ONLY for stage>1 Master
// Reference generations, on top of the existing evolution-continuity framing, so
// family identity stays locked (same colours/eyes/markings/element/art style) while a
// SUBSTANTIAL visual evolution becomes an explicit, unambiguous requirement.
function evolutionDiversityMandate(stageNumber: number): string {
  const stageDesc =
    stageNumber >= 3
      ? "This is the FINAL and most powerful form — the strongest proportions and most developed anatomy of the whole line, a mature face and body, expanded elemental features, armour, markings or silhouette, unmistakably more advanced than the previous stage."
      : "This is a visibly older and more capable stage — a larger body and stronger proportions, more developed limbs, fins, wings, tail, horns, armour or elemental features, a more confident expression and stance, a clearly different silhouette.";
  return (
    ` CRITICAL EVOLUTION REQUIREMENT: this image MUST be a SUBSTANTIAL visual evolution from the previous stage reference, not a cosmetic variant. ${stageDesc} It must remain recognisably descended from the previous stage — same core colour palette, eye design, key markings, elemental identity and art style — but the overall scale, body proportions, limb development, head-to-body ratio, silhouette, tail/fins/wings/horns, maturity, posture, elemental features and detail complexity must all visibly change. ` +
    `Do NOT produce: the same body with only a small appendage or accessory change; a creature that is merely larger with an otherwise identical silhouette; a version that differs only in wings, fins or tail; a pose variation of the same form; or a colour variant. The previous stage and this stage must look unmistakably like two different points in a growth sequence, not the same creature redrawn.`
  );
}
// Appended on a retry after the evolution-difference check fails (mirrors STRICTER_POSE_SUFFIX).
const STRICTER_EVOLUTION_SUFFIX =
  " CRITICAL: the previous attempt looked too similar to the previous evolution stage — it read as a duplicate pose or a minor cosmetic variant, not a genuine evolution. Go further: substantially change the body proportions, silhouette, limb development and maturity. A bigger version of the exact same shape is NOT acceptable — the overall form itself must read as a clearly later stage in the growth sequence.";

// Whether generateCharacterCandidate can actually retry (and therefore make a 2nd paid
// provider call) for this request — mirrors generateCharacterCandidate's maxAttempts,
// which allows a 2nd attempt for EVERY Master Reference (studio-background retry, and
// for stage>1 also an evolution-difference retry) and for Action Reference (background
// and/or pose-diversity retry). Spend estimation just needs to know "can this reference
// type ever need a 2nd attempt", not which check triggered it.
function generationCanRetry(referenceType: VqReferenceType): boolean {
  return referenceType === "action_pose" || referenceType === "master_portrait";
}

// Score a generated image against the character's OWN approved references; persist
// the score and auto-reject below threshold (stored for audit, never shown as a pick).
async function scoreAndGateCandidate(
  candidateId: number,
  generatedPng: Buffer,
  ownRefs: Buffer[],
  character: VqCharacter
): Promise<{ identity: IdentityResult | null; autoRejected: boolean }> {
  if (!ownRefs.length) return { identity: null, autoRejected: false };
  const identity = await scoreCharacterIdentity(generatedPng, ownRefs, character);
  if (!identity) return { identity: null, autoRejected: false }; // scorer unavailable → keep with warning
  await vqStorage
    .setArtworkCandidateIdentity(candidateId, identity.score, identity.breakdown as unknown as Record<string, unknown>)
    .catch(() => {});
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
// providerCalls = actual number of paid Higgsfield creates this made (a master or
// action_pose can retry once on studio-background failure → up to 2), so the caller
// records ACTUAL spend, not just candidate count (Reviewer 1 F-1 / financial accuracy).
interface GenCandidateResult {
  candidate: VqArtworkCandidate;
  artwork: HiggsfieldArtworkResult;
  key: string;
  identity: IdentityResult | null;
  autoRejected: boolean;
  referencesUsed: string[];
  providerCalls: number;
}
async function generateCharacterCandidate(
  character: VqCharacter,
  referenceType: VqReferenceType = "master_portrait",
  opts?: { model?: string }
): Promise<GenCandidateResult | { rejected: true; reason: string; providerCalls: number }> {
  const prev = character.evolvesFromCharacterId
    ? ((await vqStorage.getCharacter(character.evolvesFromCharacterId)) ?? null)
    : null;
  const basePrompt = characterMasterArtworkPrompt(character, prev, referenceType);
  if (basePrompt.length < 20)
    throw new Error("Character Bible has no master artwork prompt or DNA yet — fill the Bible first.");
  const { buffers, used, ownRefCount } = await collectReferenceImages(character, prev);
  const isMaster = referenceType === "master_portrait";
  const isActionPose = referenceType === "action_pose";
  // Evolution-differentiation fix: only meaningful for a stage>1 Master Reference
  // with a resolvable previous-stage reference image. Deliberately independent of
  // ownRefCount — this stays active even after the stage's OWN Master is approved
  // (e.g. "Replace Master"), so a regeneration that's ALSO too-similar to the
  // previous stage keeps getting caught, not just the very first bootstrap attempt.
  const prevMasterIdx = used.indexOf("prev:master_portrait");
  const prevPng = prevMasterIdx >= 0 ? buffers[prevMasterIdx] : undefined;
  const evolutionGateActive = isMaster && character.stageNumber > 1 && !!prevPng;
  // Action Reference's identity lock must ALSO forbid drifting background/lighting/
  // framing away from the references (the general IDENTITY_LOCK_PROMPT explicitly
  // permits that, which is correct for face/colour/turnaround but wrong here).
  // Evolution-gated Master generations NEVER use the standard identity lock, even
  // once the stage has its own approved reference — "reproduce identical
  // proportions" would just re-lock onto whatever under-evolved form is already
  // approved; EVOLUTION_REF_PROMPT (evolve from the PREVIOUS stage) stays correct
  // in every case here.
  const idLock = evolutionGateActive
    ? EVOLUTION_REF_PROMPT
    : ownRefCount > 0
      ? isActionPose
        ? ACTION_IDENTITY_LOCK_PROMPT
        : IDENTITY_LOCK_PROMPT
      : used.length > 0
        ? EVOLUTION_REF_PROMPT
        : "";
  const model = vqValidImageModel(opts?.model);

  // Action Reference pose-diversity gate: only meaningful when we actually have the
  // Master's own image to compare against (a bootstrap generation with no approved
  // Master yet has nothing to diff pose against — background validation below still
  // applies regardless, since the plain-studio-backdrop rule doesn't depend on having
  // a Master image to compare to, only on the prompt's own strict rules).
  const masterIdx = used.indexOf("own:master_portrait");
  const masterPng = masterIdx >= 0 ? buffers[masterIdx] : undefined;
  const poseGateActive = isActionPose && !!masterPng;
  const bgCheckActive = isMaster || isActionPose;

  // MASTER REFERENCE and ACTION REFERENCE: validate the studio background after each
  // generation — background is checked FIRST and is a hard, non-negotiable gate (an
  // Action Reference with a scenic/environmental background is a defect, not a
  // judgment call), retrying ONCE with a stricter prompt before giving up, then
  // discarding without ever uploading/recording (mirrors the Master's existing
  // precedent exactly). ACTION POSE that clears the background check (when pose-
  // gated) additionally scores identity+pose in the SAME vision call pre-upload;
  // an evolution-gated MASTER that clears the background check instead scores
  // evolution-difference against the previous stage. Either way this retries ONCE
  // more with a stricter prompt on failure — never spends a 3rd credit chasing
  // diversity, and never uploads/shows a near-duplicate for approval when a
  // genuinely different one was reachable in 2 tries. Only a passing (or attempts-
  // exhausted) image is kept; either way the LAST attempt is what's charged.
  const maxAttempts = isMaster || isActionPose ? 2 : 1;
  let artwork: HiggsfieldArtworkResult | null = null;
  let prompt = "";
  let bgReason: string | undefined;
  let providerCalls = 0; // every generateHiggsfieldArtwork below is a PAID create
  let preScored: IdentityResult | null = null; // action_pose/evolution: reused after upload so scoring isn't done twice
  let preScoredEvolution: EvolutionDifferenceVerdict | null = null; // evolution: reused after upload
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const poseSuffix = isActionPose ? POSE_DIVERSITY_MANDATE + (attempt > 1 ? STRICTER_POSE_SUFFIX : "") : "";
    const evoSuffix = evolutionGateActive
      ? evolutionDiversityMandate(character.stageNumber) + (attempt > 1 ? STRICTER_EVOLUTION_SUFFIX : "")
      : "";
    prompt = basePrompt + idLock + poseSuffix + evoSuffix + (bgCheckActive && attempt > 1 ? STRICTER_BG_SUFFIX : "");
    providerCalls++;
    const generated = await generateHiggsfieldArtwork({
      prompt,
      mode: "main",
      slot: "main",
      imageReferences: buffers.length ? buffers : undefined,
      model,
    });

    if (bgCheckActive) {
      const bg = await validateStudioBackground(generated.png);
      if (!bg.ok) {
        bgReason = bg.reason;
        if (attempt === maxAttempts) {
          // Background never passed — reject WITHOUT uploading/recording (don't clutter
          // R2/gallery, don't consume the approval workflow). The image is discarded —
          // but it WAS charged.
          return { rejected: true, reason: `studio background rejected (${bg.reason})`, providerCalls };
        }
        continue;
      }
      if (isMaster && !evolutionGateActive) {
        artwork = generated;
        break;
      }
      // Action Reference: background passed. Fall through to the pose-diversity check
      // below (if a Master exists to diff against) rather than accepting immediately.
      // Evolution-gated Master: background passed. Fall through to the evolution-
      // difference check below rather than accepting immediately.
    }

    if (evolutionGateActive) {
      const ownRefs = buffers.slice(0, ownRefCount);
      // Own references exist (stage already has an approved Master) — score identity
      // AND evolution-difference in the SAME vision call. Bootstrap (no own refs yet)
      // — nothing to identity-score against, so evolution-difference alone is scored
      // via a small standalone call.
      const scored = ownRefs.length > 0 ? await scoreCharacterIdentity(generated.png, ownRefs, character, { evolutionPrevPng: prevPng }) : null;
      const evoVerdict = scored?.evolutionDifference ?? (await scoreEvolutionDifference(generated.png, prevPng!, character));
      if (evoVerdict?.verdict === "fail" && attempt < maxAttempts) {
        continue; // too similar to the previous stage — discard, retry once with a stricter prompt
      }
      artwork = generated;
      preScored = scored;
      preScoredEvolution = evoVerdict;
      break;
    }

    if (poseGateActive) {
      const ownRefs = buffers.slice(0, ownRefCount);
      const scored = await scoreCharacterIdentity(generated.png, ownRefs, character, { masterPng });
      if (scored?.poseDiversity?.verdict === "fail" && attempt < maxAttempts) {
        continue; // too similar to the Master's pose — discard, retry once with a stricter prompt
      }
      artwork = generated;
      preScored = scored;
      break;
    }

    artwork = generated;
    break;
  }
  if (!artwork)
    return {
      rejected: true,
      reason: bgReason ? `studio background rejected (${bgReason})` : "no image produced",
      providerCalls,
    };

  const key = assertVqWriteKey(vqCharacterCandidateKey(character.characterId));
  await uploadToR2(key, artwork.png, "image/png");
  const candidate = await vqStorage.recordArtworkCandidate({
    characterId: character.characterId,
    cardId: character.cardId,
    slot: "main",
    referenceType,
    source: "generated",
    provider: artwork.provider,
    model: artwork.model,
    prompt,
    r2Key: key,
    width: artwork.width,
    height: artwork.height,
    status: "candidate",
    aiGenerationId: null,
    createdBy: "admin",
  });
  await vqStorage
    .recordAiGeneration({
      cardId: character.cardId,
      kind: "character-artwork",
      mode: referenceType,
      provider: artwork.provider,
      model: artwork.model,
      generatedBy: "admin",
      prompt,
      output: { characterId: character.characterId, candidateKey: key, referenceType, referencesUsed: used },
      applied: false,
    })
    .catch(() => {});

  const ownRefs = buffers.slice(0, ownRefCount);
  let identity: IdentityResult | null;
  let autoRejected: boolean;
  if (poseGateActive) {
    // Already scored (identity AND pose, one vision call) inside the retry loop above —
    // reuse it rather than scoring a second time.
    //
    // The two gates are independent but NOT symmetric in how a failure is handled:
    //   - identity failure ⇒ existing behaviour, UNCHANGED: mark auto_rejected, hidden
    //     from the candidate list entirely (the list route filters auto_rejected out).
    //   - pose-diversity failure (identity still passing) ⇒ NEW, and deliberately
    //     stays VISIBLE as a normal candidate (status stays "candidate") so the founder
    //     can see the "Pose Diversity: Fail" badge and understand why the retry budget
    //     was spent, rather than it silently vanishing. Approval is blocked instead,
    //     both client-side (button disabled) and server-side (approve-candidate route).
    // A candidate that fails BOTH gates follows the identity path (existing, hidden).
    identity = preScored;
    if (identity) {
      await vqStorage
        .setArtworkCandidateIdentity(candidate.id, identity.score, {
          ...identity.breakdown,
          poseDiversity: identity.poseDiversity,
        } as unknown as Record<string, unknown>)
        .catch(() => {});
    }
    autoRejected = identity ? identity.verdict === "reject" : false;
    if (autoRejected) await vqStorage.markArtworkCandidateStatusById(candidate.id, "auto_rejected").catch(() => {});
  } else if (evolutionGateActive) {
    // Already scored (identity, when own references exist, AND evolution-difference,
    // always) inside the retry loop above — reuse rather than scoring twice.
    //
    // Mirrors the pose-diversity precedent exactly: an evolution-difference failure
    // alone (identity still passing, or no identity to score yet) does NOT hide the
    // candidate — it stays VISIBLE with an "Evolution Difference: Fail" badge so the
    // founder can see why the retry budget was spent, and is blocked from approval
    // instead, both client-side (button disabled) and server-side (approve-candidate
    // route). An identity DRIFT failure (when own references exist) still follows the
    // existing, unchanged auto_rejected/hidden behaviour.
    identity = preScored;
    if (identity) {
      await vqStorage
        .setArtworkCandidateIdentity(candidate.id, identity.score, {
          ...identity.breakdown,
          evolutionDifference: preScoredEvolution,
        } as unknown as Record<string, unknown>)
        .catch(() => {});
    } else if (preScoredEvolution) {
      // Bootstrap (no own references yet) — nothing to identity-score, but still
      // persist the evolution-difference result so it stays visible/gate-able. No
      // identity score is claimed (stored as null, not 0 — renders as unscored "—"
      // in the UI, never a false "Reject").
      await vqStorage
        .setArtworkCandidateIdentity(candidate.id, null, { evolutionDifference: preScoredEvolution } as unknown as Record<string, unknown>)
        .catch(() => {});
    }
    autoRejected = identity ? identity.verdict === "reject" : false;
    if (autoRejected) await vqStorage.markArtworkCandidateStatusById(candidate.id, "auto_rejected").catch(() => {});
  } else {
    ({ identity, autoRejected } = await scoreAndGateCandidate(candidate.id, artwork.png, ownRefs, character));
  }
  return { candidate, artwork, key, identity, autoRejected, referencesUsed: used, providerCalls };
}

// Phase 10A D10 — read the client-persisted idempotency key (the browser mints + stores
// it per action-context across reloads/tabs; see admin-vault-quest.tsx). Falls back to a
// server-minted key so an older/raw client caller still works, though a fallback key gives
// NO cross-request dedup (a fresh key every call) — real protection needs the client to
// resend the SAME key for the SAME logical action. Never trust a client-sent key blindly
// for anything beyond dedup: it only ever gates OUR OWN reservation row, never auth/data.
function readIdempotencyKey(req: Request): string {
  const raw = (req.body as { idempotencyKey?: unknown })?.idempotencyKey ?? req.header("Idempotency-Key");
  const s = String(raw ?? "").trim();
  return s.length >= 8 && s.length <= 200 ? s : randomUUID();
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

// Phase 10A-4 — the "writes" emergency kill switch (env hard-off > DB toggle >
// default-on; see lib/vq-feature-state.ts) applied to every MUTATING VQ admin
// route in one place, so an operator flips ONE switch to freeze all writes
// instead of hunting down every route. Reads (GET) are always allowed — this is
// a maintenance/emergency gate, not an outage; existing exports/candidates/status
// stay viewable. Runs BEFORE requireAdmin is even reached on each individual
// route, so a frozen VQ never touches the DB for a write attempt.
// Relative to the app.use("/api/admin/vault-quest", ...) mount point — Express
// strips the matched prefix from req.path inside a prefix-mounted middleware, so
// this must NOT be the full absolute path (that silently never matches — caught
// by tests/vq-ops-route-spy.integration.test.ts's escape-hatch proof).
const VQ_WRITES_GATE_BYPASS = "/ops/feature-flags";
function vqWritesGate(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET") {
    next();
    return;
  }
  // The toggle route itself (Phase 10A-5, R4-F4) is the ONE deliberate, audited
  // exception — an emergency writes-freeze must never trap the owner unable to
  // un-freeze it. Every other mutation is gated.
  if (req.path.startsWith(VQ_WRITES_GATE_BYPASS)) {
    next();
    return;
  }
  checkVqFeature("writes")
    .then((check) => {
      if (check.ok) return next();
      res.setHeader("Retry-After", String(check.response.retryAfterSeconds));
      res.status(check.response.status).json(check.response.body);
    })
    .catch(next);
}

/** Feature-specific gate for a single route (generation/exports) — narrower than
 *  the global writes gate, so an operator can pause JUST paid generation or JUST
 *  exports without freezing card edits/approvals. Call and `return` on `!ok`
 *  BEFORE any spend check, reservation, or provider/R2 call. */
async function vqFeatureGateOrRespond(res: Response, feature: "generation" | "exports"): Promise<boolean> {
  const check = await checkVqFeature(feature);
  if (check.ok) return true;
  res.setHeader("Retry-After", String(check.response.retryAfterSeconds));
  res.status(check.response.status).json(check.response.body);
  return false;
}

const VQ_TOGGLEABLE_FEATURES: readonly VqFeature[] = ["generation", "exports", "writes"];

export function registerVaultQuestAdminRoutes(app: Express): void {
  app.use("/api/admin/vault-quest", vqWritesGate);

  // ---- ops observability (Phase 10A-5) ----
  // Read-only, bounded-aggregate operational snapshot: feature-flag state, honest
  // provider status, current spend ceilings/windows, export job counts. Never
  // calls a paid provider, never dumps unbounded rows.
  app.get("/api/admin/vault-quest/ops/status", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await getVqOpsStatus(Date.now()));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "ops status failed" });
    }
  });

  // The owner's emergency toggle (R4-F4) — deliberately exempt from vqWritesGate
  // (see VQ_WRITES_GATE_BYPASS above) so a writes-freeze can always be undone.
  app.post("/api/admin/vault-quest/ops/feature-flags/:feature", requireAdmin, async (req: Request, res: Response) => {
    try {
      const feature = String(req.params.feature) as VqFeature;
      if (!VQ_TOGGLEABLE_FEATURES.includes(feature)) {
        return res.status(400).json({ error: `unknown feature — must be one of ${VQ_TOGGLEABLE_FEATURES.join(", ")}` });
      }
      const body = (req.body ?? {}) as { enabled?: unknown; reason?: unknown };
      if (typeof body.enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) is required" });
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
      await setVqFeatureFlag(feature, body.enabled, req.session?.adminEmail || "admin", reason);
      res.json({ ok: true, feature, enabled: body.enabled });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to set feature flag" });
    }
  });

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
          if (!(name in elements)) {
            elements[name] = { placeholder: true };
            needsApproval.add(name);
          }
        }
      } catch {
        /* elements table absent — built-in palette only */
      }
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
        {
          id: "higgsfield",
          label: "Higgsfield",
          connected: conn.connected,
          enabled: true,
          note: conn.connected ? `model ${conn.model}` : "not connected",
        },
        {
          id: "openai",
          label: "OpenAI Images",
          connected: false,
          enabled: false,
          note: process.env.OPENAI_API_KEY ? "API key present — not wired for Vault Quest yet" : "API key missing",
        },
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
      const character = await vqStorage.updateCharacterBible(
        characterId,
        patch,
        "admin",
        String(body.reason ?? "bible edit"),
        { allowWhileLocked: body.confirmReplaceLocked === true }
      );
      res.json({ character });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "failed to update character";
      res.status(/locked/i.test(msg) ? 423 : 500).json({ error: msg });
    }
  });

  app.get(
    "/api/admin/vault-quest/characters/:characterId/revisions",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        res.json({ revisions: await vqStorage.listCharacterRevisions(String(req.params.characterId)) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to load character revisions" });
      }
    }
  );

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
        await vqStorage
          .recordArtworkCandidate({
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
          })
          .catch(() => {});
        res.json({ character: updated, key, width: guard.width, height: guard.height });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to upload character artwork" });
      }
    }
  );

  app.get(
    "/api/admin/vault-quest/characters/:characterId/art/:kind",
    requireAdmin,
    async (req: Request, res: Response) => {
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
    }
  );

  app.post(
    "/api/admin/vault-quest/characters/:characterId/approve-artwork",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const character = await vqStorage.getCharacter(characterId);
        if (!character) return res.status(404).json({ error: "character not found" });
        if (character.locked)
          return res.status(423).json({ error: "Character is locked — unlock before changing its reference pack." });
        const sourceKey = character.referenceArtworkR2Key;
        if (!sourceKey || !sourceKey.startsWith("vq/characters/")) {
          return res.status(400).json({ error: "Upload reference artwork before approving this character." });
        }
        const buf = await getR2Buffer(sourceKey);
        if (!buf) return res.status(404).json({ error: "reference artwork was not found" });
        const guard = await validateArtwork(buf);
        if (!guard.ok) return res.status(422).json({ error: guard.error ?? "reference artwork failed validation" });
        const png = await (await import("sharp")).default(buf).png().toBuffer();
        // Manual reference upload approves as the MASTER PORTRAIT pack slot — atomic
        // immutable revision (Phase 10A-6, R5-F2), never an overwrite-in-place.
        const { r2Key: approvedKey, character: updated } = await promoteCharacterReferenceRevision({
          characterId,
          referenceType: "master_portrait",
          buffer: png,
          width: guard.width,
          height: guard.height,
          createdBy: req.session?.adminEmail || "admin",
        });
        await vqStorage.markArtworkCandidateStatusByKey(sourceKey, "approved").catch(() => {});
        res.json({
          character: updated,
          key: approvedKey,
          packCompleteness: vqPackCompleteness(updated.referencePack),
          width: guard.width,
          height: guard.height,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve artwork" });
      }
    }
  );

  // ── Master artwork BOOTSTRAP (founder-only). Generates a STANDALONE character
  // candidate from Character Bible DNA — allowed WITHOUT approved artwork (this is
  // how the first reference is created). Never approves/locks/creates cards. ──
  app.post(
    "/api/admin/vault-quest/characters/:characterId/generate-artwork",
    requireAdmin,
    async (req: Request, res: Response) => {
      // Declared OUTSIDE the try so the outer catch (a thrown provider error) can still
      // finalize the reservation — see readIdempotencyKey's doc comment for the design.
      let reservedRowId: number | null = null;
      const finishOk = async (chargedCredits: number, candidateId: number | null, modelUsed: string | null) => {
        if (reservedRowId != null) await finalizeSuccess(reservedRowId, { chargedCredits, candidateId, modelUsed });
      };
      const finishErr = async (err: unknown) => {
        if (reservedRowId != null) await finalizeFailure(reservedRowId, classifyAndMapThrown(err));
      };
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
          return res
            .status(422)
            .json({
              error:
                "Description not approved — Generate, review and Approve the character description before generating artwork.",
              descriptionStatus: character.descriptionStatus,
            });
        }
        const conn = higgsfieldConnection();
        if (!conn.connected)
          return res
            .status(503)
            .json({
              error: "Artwork provider not connected",
              provider: "higgsfield",
              note: conn.note,
              connected: false,
            });
        if (!(await vqFeatureGateOrRespond(res, "generation"))) return; // emergency kill switch (Phase 10A-4)

        // Spend gate (Phase 10A-2): master ALWAYS makes MASTER_CANDIDATE_COUNT
        // candidates, others 1. Enforce the ceiling BEFORE any paid provider call.
        const isMaster = referenceType === "master_portrait";
        const perImage = effectiveCreditsPerImage(model); // price the upgraded model (F-2)
        // Price for the WORST CASE, not the common case: a Master Reference can retry
        // once on a failed studio-background check (and, for stage>1, also on a failed
        // evolution-difference check), and an action_pose request with an approved
        // Master can retry once on a failed pose-diversity check — up to 2 paid calls
        // either way, see generationCanRetry. The image COUNT requested is still 1 (or
        // MASTER_CANDIDATE_COUNT for master, below), only the per-image credit estimate
        // doubles, so the separate maxImagesPerRequest check is untouched.
        const retryPossible = generationCanRetry(referenceType);
        const perImageForSpend = retryPossible ? perImage * 2 : perImage;
        const spend = await checkGenerationSpend({
          requestedImages: isMaster ? MASTER_CANDIDATE_COUNT : 1,
          perImageCredits: perImageForSpend,
          scope: "single",
          nowMs: Date.now(),
        });
        if (!spend.allow) return res.status(spend.http).json({ error: spend.message, reason: spend.reason });

        // Double-pay protection (Phase 10A D10): reserve BEFORE any provider call. A
        // duplicate (reload / 2nd tab / retry / 2nd Fly machine) reusing the SAME client-
        // persisted key gets replayed, told to wait, or refused — never a second charge.
        const idempotencyKey = readIdempotencyKey(req);
        const payload: GenerationPayload = {
          generationType: "character-artwork-single",
          characterId,
          referenceType,
          model,
          count: isMaster ? MASTER_CANDIDATE_COUNT : 1,
        };
        const reserve = await reserveOrDecide({
          idempotencyKey,
          payload,
          adminId: req.session?.adminEmail,
          maxAuthorisedSpend: spend.estimatedCredits,
        });
        if (reserve.durable) {
          if (!reserve.proceed) {
            const r = idempotencyResponseFor(reserve.action, reserve.row);
            return res.status(r.status).json(r.body);
          }
          reservedRowId = reserve.rowId;
        }

        // Master Reference ALWAYS produces MASTER_CANDIDATE_COUNT studio candidates —
        // ENFORCED server-side, so even a raw API call with referenceType=master_portrait
        // yields that many, never 1. Each candidate independently passes the SAME
        // identity/background/evolution-difference gates as before.
        if (isMaster) {
          const created: {
            candidateId: number;
            key: string;
            width: number;
            height: number;
            identityScore: number | null;
            model: string;
          }[] = [];
          let autoRejectedCount = 0,
            bgRejectedCount = 0,
            providerCalls = 0;
          for (let i = 0; i < MASTER_CANDIDATE_COUNT; i++) {
            try {
              const r = await generateCharacterCandidate(character, referenceType, { model });
              providerCalls += r.providerCalls; // ACTUAL paid creates (master may retry → up to 2 each)
              if ("rejected" in r) {
                bgRejectedCount++;
                continue;
              } // studio background failed
              if (r.autoRejected) {
                autoRejectedCount++;
                continue;
              }
              created.push({
                candidateId: r.candidate.id,
                key: r.key,
                width: r.artwork.width,
                height: r.artwork.height,
                identityScore: r.identity?.score ?? null,
                model: r.artwork.model,
              });
            } catch (e) {
              if (!created.length && !autoRejectedCount && !bgRejectedCount) {
                await finishErr(e);
                return artworkErrorResponse(res, e);
              }
              break;
            }
          }
          // Finalize on ACTUAL paid creates (incl. bg-retries + auto/bg-rejected, which still billed).
          await finishOk(providerCalls * perImage, created[0]?.candidateId ?? null, model ?? null);
          return res
            .status(201)
            .json({
              referenceType,
              created,
              autoRejected: autoRejectedCount,
              bgRejected: bgRejectedCount,
              count: created.length,
              idempotencyKey,
            });
        }

        const r = await generateCharacterCandidate(character, referenceType, { model });
        if ("rejected" in r) {
          await finishOk(r.providerCalls * perImage, null, model ?? null);
          return res.status(422).json({ error: r.reason, rejected: true });
        }
        const { candidate, artwork, key, identity, autoRejected, referencesUsed } = r;
        if (autoRejected) {
          // Identity drifted below threshold — candidate stored for audit, never shown.
          // (A pose-diversity failure alone does NOT hit this branch — see the comment
          // in generateCharacterCandidate: it stays visible with a Pose Diversity badge
          // and is blocked from approval instead, not hidden like an identity failure.)
          await finishOk(r.providerCalls * perImage, candidate.id, artwork.model);
          return res.status(422).json({
            error: `Identity Score ${identity?.score}/${identity?.threshold} — the generated image drifted from the approved references, so it was auto-rejected. Generate again.`,
            autoRejected: true,
            identityScore: identity?.score ?? null,
            identityThreshold: identity?.threshold ?? identityThreshold(),
          });
        }
        const thumb = await (await import("sharp"))
          .default(artwork.png)
          .resize(320, 320, { fit: "inside" })
          .png()
          .toBuffer();
        await finishOk(r.providerCalls * perImage, candidate.id, artwork.model);
        res.status(201).json({
          candidateId: candidate.id,
          key,
          referenceType,
          width: artwork.width,
          height: artwork.height,
          identityScore: identity?.score ?? null,
          poseDiversity: identity?.poseDiversity ?? null,
          model: artwork.model,
          referencesUsed,
          preview: `data:image/png;base64,${thumb.toString("base64")}`,
          idempotencyKey,
        });
      } catch (err) {
        await finishErr(err);
        artworkErrorResponse(res, err);
      }
    }
  );

  // Generate N more candidates (default 3, max 3) for THIS character only. Partial-tolerant:
  // if a later image fails (e.g. credits), the ones already created are still returned.
  app.post(
    "/api/admin/vault-quest/characters/:characterId/generate-artwork/batch",
    requireAdmin,
    async (req: Request, res: Response) => {
      let reservedRowId: number | null = null;
      const finishOk = async (chargedCredits: number, candidateId: number | null, modelUsed: string | null) => {
        if (reservedRowId != null) await finalizeSuccess(reservedRowId, { chargedCredits, candidateId, modelUsed });
      };
      const finishErr = async (err: unknown) => {
        if (reservedRowId != null) await finalizeFailure(reservedRowId, classifyAndMapThrown(err));
      };
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
          return res
            .status(422)
            .json({
              error:
                "Description not approved — Generate, review and Approve the character description before generating artwork.",
              descriptionStatus: character.descriptionStatus,
            });
        }
        const conn = higgsfieldConnection();
        if (!conn.connected)
          return res
            .status(503)
            .json({
              error: "Artwork provider not connected",
              provider: "higgsfield",
              note: conn.note,
              connected: false,
            });
        if (!(await vqFeatureGateOrRespond(res, "generation"))) return; // emergency kill switch (Phase 10A-4)
        // Spend gate (Phase 10A-2) BEFORE any paid provider call.
        const perImage = effectiveCreditsPerImage(model); // price the upgraded model (F-2)
        // Price for the worst case: EACH of the `count` candidates can independently
        // retry once (background, pose-diversity or evolution-difference) — see
        // generationCanRetry / the matching comment on the single-generate route.
        const retryPossible = generationCanRetry(referenceType);
        const perImageForSpend = retryPossible ? perImage * 2 : perImage;
        const spend = await checkGenerationSpend({
          requestedImages: count,
          perImageCredits: perImageForSpend,
          scope: "batch",
          nowMs: Date.now(),
        });
        if (!spend.allow) return res.status(spend.http).json({ error: spend.message, reason: spend.reason });

        // Double-pay protection (Phase 10A D10) — reserve BEFORE any provider call.
        const idempotencyKey = readIdempotencyKey(req);
        const payload: GenerationPayload = {
          generationType: "character-artwork-batch",
          characterId,
          referenceType,
          model,
          count,
        };
        const reserve = await reserveOrDecide({
          idempotencyKey,
          payload,
          adminId: req.session?.adminEmail,
          maxAuthorisedSpend: spend.estimatedCredits,
        });
        if (reserve.durable) {
          if (!reserve.proceed) {
            const r = idempotencyResponseFor(reserve.action, reserve.row);
            return res.status(r.status).json(r.body);
          }
          reservedRowId = reserve.rowId;
        }

        const created: {
          candidateId: number;
          key: string;
          width: number;
          height: number;
          identityScore: number | null;
          model: string;
        }[] = [];
        let autoRejectedCount = 0,
          bgRejectedCount = 0,
          providerCalls = 0;
        for (let i = 0; i < count; i++) {
          try {
            const r = await generateCharacterCandidate(character, referenceType, { model });
            providerCalls += r.providerCalls; // ACTUAL paid creates
            if ("rejected" in r) {
              bgRejectedCount++;
              continue;
            }
            if (r.autoRejected) {
              autoRejectedCount++;
              continue;
            } // stored for audit, never shown
            created.push({
              candidateId: r.candidate.id,
              key: r.key,
              width: r.artwork.width,
              height: r.artwork.height,
              identityScore: r.identity?.score ?? null,
              model: r.artwork.model,
            });
          } catch (e) {
            if (!created.length && !autoRejectedCount && !bgRejectedCount) {
              await finishErr(e);
              return artworkErrorResponse(res, e);
            } // first one failed → clean error
            break; // a later one failed → return the ones that succeeded
          }
        }
        await finishOk(providerCalls * perImage, created[0]?.candidateId ?? null, model ?? null);
        res
          .status(201)
          .json({
            characterId,
            referenceType,
            created,
            autoRejected: autoRejectedCount,
            bgRejected: bgRejectedCount,
            idempotencyKey,
          });
      } catch (err) {
        await finishErr(err);
        artworkErrorResponse(res, err);
      }
    }
  );

  // Reject a candidate — marks it rejected only. Does NOT delete the R2 object.
  app.post(
    "/api/admin/vault-quest/characters/:characterId/reject-candidate",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const candidateId = Number((req.body as { candidateId?: number })?.candidateId);
        if (!Number.isInteger(candidateId)) return res.status(400).json({ error: "candidateId required" });
        const cand = await vqStorage.getArtworkCandidate(candidateId);
        if (!cand || cand.characterId !== characterId)
          return res.status(404).json({ error: "candidate not found for this character" });
        // Don't reject/delete a candidate that is the SOURCE of an approved reference-
        // pack slot — it would leave reference_pack.<type>.candidateId dangling.
        // (Real occurrence found in staging: GNV-F03-S2 master_portrait → deleted cand.)
        const character = await vqStorage.getCharacter(characterId);
        if (isCandidateReferencedInPack(character?.referencePack, candidateId)) {
          return res
            .status(409)
            .json({
              error:
                "This candidate is the approved reference for this character — replace or re-approve a different one before rejecting it.",
            });
        }
        // "delete" only hides it from the gallery (status flag) — the R2 object is kept.
        const action = String((req.body as { action?: string })?.action) === "delete" ? "deleted" : "rejected";
        await vqStorage.markArtworkCandidateStatusById(candidateId, action); // R2 object intentionally kept
        res.json({ ok: true, candidateId, status: action });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to reject candidate" });
      }
    }
  );

  // List a character's master-art candidates (thumbnail gallery).
  app.get(
    "/api/admin/vault-quest/characters/:characterId/candidates",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const typeFilter = req.query.type ? parseReferenceType(req.query.type) : undefined;
        const rows = await vqStorage.listArtworkCandidates(characterId, typeFilter);
        // auto_rejected = audit-only (identity drift); deleted = founder-hidden. Neither is shown.
        res.json({
          candidates: rows
            .filter((r) => r.status !== "auto_rejected" && r.status !== "deleted")
            .map((r) => ({
              id: r.id,
              status: r.status,
              source: r.source,
              referenceType: r.referenceType,
              identityScore: r.identityScore,
              identityBreakdown: r.identityBreakdown,
              prompt: r.prompt,
              width: r.width,
              height: r.height,
              createdAt: r.createdAt,
            })),
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to list candidates" });
      }
    }
  );

  // Serve a single candidate image (validated to belong to the character).
  app.get(
    "/api/admin/vault-quest/characters/:characterId/candidate/:candidateId",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        const candidateId = Number(req.params.candidateId);
        if (!validVqCardId(characterId) || !Number.isInteger(candidateId))
          return res.status(400).json({ error: "invalid id" });
        const cand = await vqStorage.getArtworkCandidate(candidateId);
        if (!cand || cand.characterId !== characterId || !cand.r2Key.startsWith("vq/characters/"))
          return res.status(404).json({ error: "candidate not found" });
        const buf = await getR2Buffer(cand.r2Key);
        if (!buf) return res.status(404).json({ error: "candidate image expired" });
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "private, max-age=60");
        return res.send(buf);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to load candidate" });
      }
    }
  );

  // Full revision history for one artwork slot (Phase 10A-6) — founder-facing
  // "what changed, when, by whom" view. Read-only; works for either entity type.
  app.get("/api/admin/vault-quest/artwork-revisions", requireAdmin, async (req: Request, res: Response) => {
    try {
      const entityType = String(req.query.entityType) === "card" ? "card" : "character";
      const entityId = String(req.query.entityId ?? "").trim();
      const slot = String(req.query.slot ?? "").trim();
      if (!entityId || !slot || !validVqCardId(entityId))
        return res.status(400).json({ error: "entityId and slot are required" });
      const history = await listRevisionHistory(entityType, entityId, slot);
      res.json({
        entityType,
        entityId,
        slot,
        revisions: history.map((r) => ({
          id: r.id,
          r2Key: r.r2Key,
          isActive: r.isActive,
          backupState: r.backupState,
          width: r.width,
          height: r.height,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          archivedAt: r.archivedAt,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load revision history" });
    }
  });

  // Serve one specific (possibly archived) revision's image bytes — the Archive/History
  // panel's thumbnails. Character entities only for now (card art history isn't shown
  // in any UI yet); the key is re-validated with assertVqReadKey regardless of what's
  // stored, exactly like every other VQ image route.
  app.get(
    "/api/admin/vault-quest/artwork-revisions/:revisionId/image",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const revisionId = Number(req.params.revisionId);
        if (!Number.isInteger(revisionId)) return res.status(400).json({ error: "invalid revisionId" });
        const revision = await getRevisionById(revisionId);
        if (!revision || revision.entityType !== "character") return res.status(404).json({ error: "revision not found" });
        const buf = await getR2Buffer(assertVqReadKey(revision.r2Key));
        if (!buf) return res.status(404).json({ error: "revision image not found in storage" });
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "private, max-age=300");
        return res.send(buf);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to load revision image" });
      }
    }
  );

  // Roll back to a previous revision (Phase 10A-6) — a RECOVERY action, not a new
  // upload. Fails safely (no pointer change) if the target asset is missing or
  // its stored hash no longer matches what's actually in R2.
  app.post(
    "/api/admin/vault-quest/artwork-revisions/:revisionId/restore",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const revisionId = Number(req.params.revisionId);
        if (!Number.isInteger(revisionId)) return res.status(400).json({ error: "invalid revisionId" });
        const target = await getRevisionById(revisionId);
        if (!target) return res.status(404).json({ error: "That revision no longer exists.", reason: "not_found" });
        // Restoring changes the active pointer exactly like approving a candidate does,
        // so it gets the SAME locked/confirm gate (this route had none before Phase B —
        // closing that gap now that it's actually wired into the UI).
        if (target.entityType === "character") {
          const character = await vqStorage.getCharacter(target.entityId);
          const confirmReplaceLocked = (req.body as { confirmReplaceLocked?: boolean } | undefined)?.confirmReplaceLocked === true;
          if (character?.locked && !confirmReplaceLocked)
            return res
              .status(423)
              .json({ error: "Character is locked — unlock before restoring an older reference, or confirm the restore.", locked: true });
        }
        const outcome = await restoreArtworkRevision(revisionId, req.session?.adminEmail || "admin");
        if (!outcome.ok) {
          const messages: Record<string, string> = {
            not_found: "That revision no longer exists.",
            asset_missing: "That revision's image is no longer in storage — cannot restore it.",
            integrity_mismatch:
              "That revision's stored image no longer matches its recorded checksum — refusing to restore a possibly-corrupted asset.",
          };
          return res.status(422).json({ error: messages[outcome.reason] ?? "restore failed", reason: outcome.reason });
        }
        res.json({
          ok: true,
          revisionId: outcome.revision.id,
          r2Key: outcome.revision.r2Key,
          previousKey: outcome.previousKey,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to restore revision" });
      }
    }
  );

  // Approve a candidate as the character's reference/approved artwork. Promotes to the
  // approved/ folder + stores the key on the Bible. Does NOT touch vq_cards or its status.
  app.post(
    "/api/admin/vault-quest/characters/:characterId/approve-candidate",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const body = (req.body ?? {}) as { candidateId?: number; lock?: boolean; confirmReplaceLocked?: boolean };
        const candidateId = Number(body.candidateId);
        if (!Number.isInteger(candidateId)) return res.status(400).json({ error: "candidateId required" });
        const character = await vqStorage.getCharacter(characterId);
        if (!character) return res.status(404).json({ error: "character not found" });
        // A locked/canonical character may still have its reference replaced via an
        // explicit, confirmed Replace action (Phase B founder decision) — the character
        // stays locked; promoteCharacterReferenceRevision below still archives the old
        // image and keeps full history either way. Without the flag, still hard-blocked.
        if (character.locked && body.confirmReplaceLocked !== true)
          return res
            .status(423)
            .json({ error: "Character is locked — unlock before changing its reference pack, or confirm the Replace action.", locked: true });
        const cand = await vqStorage.getArtworkCandidate(candidateId);
        if (!cand || cand.characterId !== characterId || !cand.r2Key.startsWith("vq/characters/")) {
          return res.status(404).json({ error: "candidate not found for this character" });
        }
        if (cand.status === "rejected" || cand.status === "auto_rejected") {
          return res.status(422).json({ error: "This candidate was rejected — it cannot be approved as a reference." });
        }
        // Pose-diversity gate (Action Reference fix): a candidate that fails this stays
        // visible (unlike an identity failure) so the founder can see why, but must never
        // be approvable as the reference. This is the REAL guard — the client-side
        // disabled button is UX only, this is what actually blocks it.
        const poseDiversity = (cand.identityBreakdown as { poseDiversity?: { verdict?: string } } | null)
          ?.poseDiversity;
        if (poseDiversity?.verdict === "fail") {
          return res
            .status(422)
            .json({
              error:
                "This candidate's pose is too similar to the Master Reference (Pose Diversity: Fail) — it cannot be approved. Generate another.",
            });
        }
        // Evolution-difference gate (Stage 2/3 differentiation fix): mirrors the
        // pose-diversity guard exactly — a candidate that fails this stays visible so
        // the founder can see why, but must never be approvable as the reference. This
        // is the REAL guard — the client-side disabled button is UX only.
        const evolutionDifference = (cand.identityBreakdown as { evolutionDifference?: { verdict?: string } } | null)
          ?.evolutionDifference;
        if (evolutionDifference?.verdict === "fail") {
          return res
            .status(422)
            .json({
              error:
                "This candidate looks too similar to the previous evolution stage (Evolution Difference: Fail) — it cannot be approved. Generate another.",
            });
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
        // Atomic immutable revision (Phase 10A-6, R5-F2) — never an overwrite-in-place.
        const { r2Key: approvedKey, character: updated } = await promoteCharacterReferenceRevision({
          characterId,
          referenceType,
          buffer: png,
          width: guard.width,
          height: guard.height,
          sourceCandidateId: candidateId,
          identityScore: cand.identityScore ?? null,
          createdBy: req.session?.adminEmail || "admin",
        });
        await vqStorage.markArtworkCandidateStatusById(candidateId, "approved").catch(() => {});
        res.json({
          character: updated,
          key: approvedKey,
          referenceType,
          locked: updated.locked,
          packCompleteness: vqPackCompleteness(updated.referencePack),
          width: guard.width,
          height: guard.height,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve candidate" });
      }
    }
  );

  // Serve an approved Reference Pack image by type.
  app.get(
    "/api/admin/vault-quest/characters/:characterId/pack/:type",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const referenceType = parseReferenceType(req.params.type);
        const character = await vqStorage.getCharacter(characterId);
        if (!character) return res.status(404).json({ error: "character not found" });
        const key = character.referencePack?.[referenceType]?.r2Key;
        if (!key || !key.startsWith("vq/characters/"))
          return res.status(404).json({ error: "no approved image for this reference type" });
        const buf = await getR2Buffer(key);
        if (!buf) return res.status(404).json({ error: "approved image not found" });
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "private, max-age=60");
        return res.send(buf);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to load pack image" });
      }
    }
  );

  // Generate master-art candidates for a whole family (Stage 1→2→3), each from its own
  // DNA, with each later stage referencing the previous stage's DNA for continuity.
  // Sequential (spends Higgsfield credits per stage). No approval/lock/card changes.
  app.post(
    "/api/admin/vault-quest/characters/family/:familyId/generate-artwork",
    requireAdmin,
    async (req: Request, res: Response) => {
      let reservedRowId: number | null = null;
      const finishOk = async (chargedCredits: number, candidateId: number | null, modelUsed: string | null) => {
        if (reservedRowId != null) await finalizeSuccess(reservedRowId, { chargedCredits, candidateId, modelUsed });
      };
      const finishErr = async (err: unknown) => {
        if (reservedRowId != null) await finalizeFailure(reservedRowId, classifyAndMapThrown(err));
      };
      try {
        const familyId = String(req.params.familyId);
        if (!validVqCardId(familyId)) return res.status(400).json({ error: "invalid family id" });
        const fam = (await vqStorage.listCharacters("GNV"))
          .filter((c) => c.familyId === familyId)
          .sort((a, b) => a.stageNumber - b.stageNumber);
        if (fam.length === 0) return res.status(404).json({ error: "no characters for this family" });
        const model = String((req.body as { model?: string })?.model ?? "").trim() || undefined;
        const conn = higgsfieldConnection();
        if (!conn.connected)
          return res
            .status(503)
            .json({
              error: "Artwork provider not connected",
              provider: "higgsfield",
              note: conn.note,
              connected: false,
            });
        if (!(await vqFeatureGateOrRespond(res, "generation"))) return; // emergency kill switch (Phase 10A-4)
        // Spend gate (Phase 10A-2): family generates one image per eligible character in ONE
        // press, so it is capped by the per-BATCH credit ceiling (D8), not the per-image count.
        const perImage = effectiveCreditsPerImage(model); // price the upgraded model (F-2)
        const eligible = fam.filter((c) => c.descriptionStatus === "approved").length;
        const spend = await checkGenerationSpend({
          requestedImages: Math.max(1, eligible),
          perImageCredits: perImage,
          scope: "family",
          nowMs: Date.now(),
        });
        if (!spend.allow) return res.status(spend.http).json({ error: spend.message, reason: spend.reason });

        // Double-pay protection (Phase 10A D10) — reserve BEFORE any provider call.
        const idempotencyKey = readIdempotencyKey(req);
        const payload: GenerationPayload = {
          generationType: "character-artwork-family",
          familyId,
          model,
          count: eligible,
        };
        const reserve = await reserveOrDecide({
          idempotencyKey,
          payload,
          adminId: req.session?.adminEmail,
          maxAuthorisedSpend: spend.estimatedCredits,
        });
        if (reserve.durable) {
          if (!reserve.proceed) {
            const r = idempotencyResponseFor(reserve.action, reserve.row);
            return res.status(r.status).json(r.body);
          }
          reservedRowId = reserve.rowId;
        }

        const generated: {
          characterId: string;
          stageNumber: number;
          candidateId: number;
          key: string;
          identityScore: number | null;
        }[] = [];
        let autoRejectedCount = 0,
          bgRejectedCount = 0,
          descSkipped = 0,
          providerCalls = 0;
        for (const ch of fam) {
          // Each stage references the previous stage's DNA + approved pack (evolution anchor,
          // handled inside generateCharacterCandidate → collectReferenceImages).
          if (ch.descriptionStatus !== "approved") {
            descSkipped++;
            continue;
          } // text before pixels
          try {
            const r = await generateCharacterCandidate(ch, "master_portrait", { model });
            providerCalls += r.providerCalls; // ACTUAL paid creates (master may retry → up to 2 each)
            if ("rejected" in r) {
              bgRejectedCount++;
              continue;
            }
            if (r.autoRejected) {
              autoRejectedCount++;
              continue;
            }
            generated.push({
              characterId: ch.characterId,
              stageNumber: ch.stageNumber,
              candidateId: r.candidate.id,
              key: r.key,
              identityScore: r.identity?.score ?? null,
            });
          } catch (e) {
            if (!generated.length && !autoRejectedCount && !bgRejectedCount) {
              await finishErr(e);
              return artworkErrorResponse(res, e);
            }
            break; // a later stage failed → return the ones that succeeded
          }
        }
        await finishOk(providerCalls * perImage, generated[0]?.candidateId ?? null, model ?? null);
        res
          .status(201)
          .json({
            familyId,
            generated,
            autoRejected: autoRejectedCount,
            bgRejected: bgRejectedCount,
            descriptionSkipped: descSkipped,
            idempotencyKey,
          });
      } catch (err) {
        await finishErr(err);
        artworkErrorResponse(res, err);
      }
    }
  );

  // Approve family references — batch-approve a chosen candidate for EACH of the family's 3
  // stages at once. Only runs when every stage has a selected candidate. Validate-then-mutate
  // (all selections checked before any approval). No lock, no card approval, no card status.
  app.post(
    "/api/admin/vault-quest/characters/family/:familyId/approve-references",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const familyId = String(req.params.familyId);
        if (!validVqCardId(familyId)) return res.status(400).json({ error: "invalid family id" });
        const selections =
          (req.body as { selections?: { characterId: string; candidateId: number }[] })?.selections ?? [];
        const fam = (await vqStorage.listCharacters("GNV"))
          .filter((c) => c.familyId === familyId)
          .sort((a, b) => a.stageNumber - b.stageNumber);
        if (fam.length === 0) return res.status(404).json({ error: "no characters for this family" });
        const selByChar = new Map(selections.map((s) => [String(s.characterId), Number(s.candidateId)]));
        const missing = fam.filter((c) => !Number.isInteger(selByChar.get(c.characterId)));
        if (missing.length) {
          return res
            .status(400)
            .json({
              error: `All ${fam.length} stages need a selected candidate first — missing ${missing.map((m) => `Stage ${m.stageNumber}`).join(", ")}.`,
            });
        }
        // Pre-validate EVERY selection before mutating anything (atomic-ish).
        const lockedStage = fam.find((c) => c.locked);
        if (lockedStage) {
          return res
            .status(423)
            .json({
              error: `Stage ${lockedStage.stageNumber} is locked — unlock it before changing the family's reference pack.`,
            });
        }
        const toApprove: {
          ch: VqCharacter;
          candidateId: number;
          referenceType: VqReferenceType;
          identityScore: number | null;
          png: Buffer;
        }[] = [];
        for (const ch of fam) {
          const candidateId = selByChar.get(ch.characterId) as number;
          const cand = await vqStorage.getArtworkCandidate(candidateId);
          if (!cand || cand.characterId !== ch.characterId || !cand.r2Key.startsWith("vq/characters/")) {
            return res.status(404).json({ error: `candidate ${candidateId} not found for ${ch.characterId}` });
          }
          if (cand.status === "rejected" || cand.status === "auto_rejected") {
            return res
              .status(422)
              .json({ error: `${ch.characterId}: candidate ${candidateId} was rejected — pick another.` });
          }
          const buf = await getR2Buffer(cand.r2Key);
          if (!buf) return res.status(404).json({ error: `candidate image missing for ${ch.characterId}` });
          const guard = await validateArtwork(buf);
          if (!guard.ok)
            return res
              .status(422)
              .json({ error: `${ch.characterId}: ${guard.error ?? "candidate failed validation"}` });
          toApprove.push({
            ch,
            candidateId,
            referenceType: parseReferenceType(cand.referenceType),
            identityScore: cand.identityScore ?? null,
            png: await (await import("sharp")).default(buf).png().toBuffer(),
          });
        }
        const approved: { characterId: string; stageNumber: number; referenceType: string; key: string }[] = [];
        const familyActor = req.session?.adminEmail || "admin";
        for (const { ch, candidateId, referenceType, identityScore, png } of toApprove) {
          // Atomic immutable revision per stage (Phase 10A-6, R5-F2) — never an
          // overwrite-in-place; a failure on one stage leaves earlier-approved stages
          // (already committed in their own transaction) and later stages untouched.
          const { r2Key: approvedKey } = await promoteCharacterReferenceRevision({
            characterId: ch.characterId,
            referenceType,
            buffer: png,
            sourceCandidateId: candidateId,
            identityScore,
            createdBy: familyActor,
          });
          await vqStorage.markArtworkCandidateStatusById(candidateId, "approved").catch(() => {});
          approved.push({ characterId: ch.characterId, stageNumber: ch.stageNumber, referenceType, key: approvedKey });
        }
        res.json({ familyId, approved });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve family references" });
      }
    }
  );

  // ── Character Description workflow (Anthropic text only — never artwork) ────
  // Generate/Improve returns a PREVIEW of all 12 identity fields; the client fills
  // the draft, the founder edits, saves, then explicitly approves. Stage 2/3 inherit
  // the previous stage's identity and must evolve it clearly.
  app.post(
    "/api/admin/vault-quest/characters/:characterId/describe",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const character = await vqStorage.getCharacter(characterId);
        if (!character) return res.status(404).json({ error: "character not found" });
        // No locked check here (Phase B): this only drafts a suggestion into the
        // response body — nothing is persisted until the PATCH save, which enforces
        // its own allowWhileLocked confirmation. Safe to draft even while locked.
        const mode = String((req.body as { mode?: string })?.mode) === "improve" ? "improve" : "generate";
        const prev = character.evolvesFromCharacterId
          ? ((await vqStorage.getCharacter(character.evolvesFromCharacterId)) ?? null)
          : null;
        const pick = (ch: typeof character) =>
          Object.fromEntries(
            DESCRIPTION_FIELD_KEYS.map((k) => [k, (ch as unknown as Record<string, unknown>)[k] ?? ""])
          );
        const describeOnce = () =>
          generateCharacterDescription(mode, {
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
        await vqStorage
          .recordAiGeneration({
            cardId: character.cardId,
            kind: "character-description",
            mode,
            provider: result.provider,
            model: result.model,
            generatedBy: "admin",
            prompt: `describe:${mode}`,
            output: { characterId, fields: result.fields },
            applied: false,
          })
          .catch(() => {});
        res.json({
          fields: result.fields,
          mode,
          provider: result.provider,
          model: result.model,
          disclaimer: AI_DISCLAIMER,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "description generation failed" });
      }
    }
  );

  app.post(
    "/api/admin/vault-quest/characters/:characterId/approve-description",
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const characterId = String(req.params.characterId);
        if (!validVqCardId(characterId)) return res.status(400).json({ error: "invalid character id" });
        const character = await vqStorage.getCharacter(characterId);
        if (!character) return res.status(404).json({ error: "character not found" });
        const empty = DESCRIPTION_FIELD_KEYS.filter(
          (k) => !String((character as unknown as Record<string, unknown>)[k] ?? "").trim()
        );
        if (empty.length)
          return res.status(422).json({ error: `Description incomplete — fill ${empty.join(", ")} before approving.` });
        const updated = await vqStorage.setCharacterDescriptionStatus(characterId, "approved", "admin");
        res.json({ character: updated, descriptionStatus: updated.descriptionStatus });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "failed to approve description" });
      }
    }
  );

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
          return res
            .status(422)
            .json({ error: "Complete the required reference pack (Master Reference + Action Pose) before locking." });
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
        if (base.setCode !== cardSet)
          return res.status(400).json({ error: "a variant and its base card must be in the same set" });
      }
      if (body.familyId) {
        const fam = await vqStorage.getFamily(String(body.familyId));
        if (!fam) return res.status(400).json({ error: "familyId does not reference an existing family" });
        if (fam.setCode !== cardSet)
          return res.status(400).json({ error: "a card and its family must be in the same set" });
      }
      // Single-door status: SAVE never sets a forward workflow status. A new card is
      // a draft; an existing card keeps its current status. Forward transitions
      // (ready/approved/export_ready/…) happen ONLY through /status, which runs the
      // full workflow gate. This prevents bypassing canTransition via the save route.
      const art = await fetchArt(body);
      const { qa } = await renderCard(body, art, "preview");
      const actor = req.session?.adminEmail || "admin";
      const promotedMain = await promoteArtworkCandidate(body.cardId, "main", body.artCandidateKey, actor);
      const promotedPrev = await promoteArtworkCandidate(body.cardId, "prev", body.prevArtCandidateKey, actor);
      const existing = await vqStorage.getCard(body.cardId);
      const keepStatus = existing ? existing.status : "draft";
      // Phase 10A-6 (R5-F1): fall back to SERVER-authoritative sources ONLY, never the
      // client-echoed body.artR2Key. Otherwise a save with no NEW candidate this round
      // (a plain gameplay edit) would either (a) trust an unvalidated client string, or
      // (b) previously re-derive the legacy flat key and silently revert a real
      // revisioned pointer back to a stale/non-existent path.
      //   1. promotedMain/Prev — a candidate was promoted THIS save (fresh, just written).
      //   2. existing.artR2Key — the card already existed; already correct (a direct
      //      upload via /cards/:cardId/art already wrote this column itself).
      //   3. the ledger's own active-revision key — covers a BRAND-NEW card whose art
      //      was uploaded via the direct-upload route before the card's first Save (no
      //      `existing` row yet for that route's pointer-update to have landed on).
      const [ledgerMain, ledgerPrev] = existing
        ? [null, null] // existing already reflects the truth; skip the extra reads
        : await Promise.all([
            getActiveRevisionKey("card", body.cardId, "main"),
            getActiveRevisionKey("card", body.cardId, "prev"),
          ]);
      const saveBody = {
        ...body,
        artR2Key: promotedMain ?? existing?.artR2Key ?? ledgerMain ?? null,
        prevArtR2Key: promotedPrev ?? existing?.prevArtR2Key ?? ledgerPrev ?? null,
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
      if (body.mode !== "card" && body.mode !== "family")
        return res.status(400).json({ error: "mode must be 'card' or 'family'" });
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
      if (!body.kind || !AI_KINDS.includes(body.kind as GenKind))
        return res.status(400).json({ error: `kind must be one of ${AI_KINDS.join(", ")}` });
      const ctx = (body.context ?? {}) as CardContext;
      const result = await runGenerator(
        body.kind as GenKind,
        String(body.mode ?? "generate"),
        ctx,
        Number(body.n) || 6
      );
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
    let reservedRowId: number | null = null;
    const finishOk = async (chargedCredits: number, candidateId: number | null, modelUsed: string | null) => {
      if (reservedRowId != null) await finalizeSuccess(reservedRowId, { chargedCredits, candidateId, modelUsed });
    };
    const finishErr = async (err: unknown) => {
      if (reservedRowId != null) await finalizeFailure(reservedRowId, classifyAndMapThrown(err));
    };
    try {
      const body = req.body as {
        context?: CardContext & { cardId?: string };
        mode?: string;
        slot?: string;
        promptOverride?: string;
        model?: string;
      };
      const ctx = (body.context ?? {}) as CardContext & { cardId?: string };
      const cardId = String(ctx.cardId ?? "").trim();
      if (!cardId) return res.status(400).json({ error: "Set a Card ID before generating artwork." });
      if (!validVqCardId(cardId))
        return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
      const bible = await vqStorage.getCharacterBibleForCard(cardId).catch(() => undefined);
      // Text before pixels: card artwork for a Bible character requires its APPROVED description.
      if (bible?.character && bible.character.descriptionStatus !== "approved") {
        return res
          .status(422)
          .json({
            error: `Description not approved for ${bible.character.characterName} — approve the character description in the Character Bible before generating artwork.`,
            descriptionStatus: bible.character.descriptionStatus,
          });
      }
      const promptCtx = bible?.character ? withCharacterBibleContext(ctx, bible) : ctx;
      if (!promptCtx.name && body.mode !== "family-sheet")
        return res.status(400).json({ error: "Set a card name before generating artwork." });
      if (!promptCtx.element) return res.status(400).json({ error: "Set an element before generating artwork." });

      const slot: ArtworkSlot = body.slot === "prev" ? "prev" : "main";
      const mode = String(body.mode ?? (slot === "prev" ? "prev-portrait" : "main")).trim() || "main";
      if ((slot === "prev" || mode === "prev-portrait") && !promptCtx.previousStage) {
        return res.status(400).json({ error: "Set the previous-stage name before generating previous-stage art." });
      }

      // Guard the USER-entered context only — never the trusted Bible fields the
      // server hydrated in (their negative prompts legitimately say "no card frame").
      const inGuard = guardInput(JSON.stringify(ctx));
      if (!inGuard.ok)
        return res.status(422).json({ error: `Blocked by guardrails: ${inGuard.violations.join("; ")}` });

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
        const promptResult = await runGenerator("artwork-prompt", mode, stripTrustedBibleText(promptCtx), 1).catch(
          (err: unknown) => ({
            suggestions: [],
            provider: "none",
            model: "none",
            promptSummary: "",
            dropped: 0,
            note: err instanceof Error ? err.message : "Text prompt generator unavailable.",
          })
        );
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
      if (!conn.connected)
        return res
          .status(503)
          .json({ error: "Artwork provider not connected", provider: "higgsfield", note: conn.note, connected: false });
      if (!(await vqFeatureGateOrRespond(res, "generation"))) return; // emergency kill switch (Phase 10A-4)

      // Spend gate (Phase 10A-2): card artwork is a single paid image — cap BEFORE the call.
      // Price the EFFECTIVE (upgraded) model so a z_image+references request isn't undercounted (F-2).
      const perImage = effectiveCreditsPerImage(String(body.model ?? "").trim() || undefined);
      const spend = await checkGenerationSpend({
        requestedImages: 1,
        perImageCredits: perImage,
        scope: "single",
        nowMs: Date.now(),
      });
      if (!spend.allow) return res.status(spend.http).json({ error: spend.message, reason: spend.reason });

      // Double-pay protection (Phase 10A D10) — reserve BEFORE any provider call.
      const idempotencyKey = readIdempotencyKey(req);
      const payload: GenerationPayload = {
        generationType: "card-artwork",
        cardId,
        model: String(body.model ?? "").trim() || undefined,
        count: 1,
      };
      const reserve = await reserveOrDecide({
        idempotencyKey,
        payload,
        adminId: req.session?.adminEmail,
        maxAuthorisedSpend: spend.estimatedCredits,
      });
      if (reserve.durable) {
        if (!reserve.proceed) {
          const rr = idempotencyResponseFor(reserve.action, reserve.row);
          return res.status(rr.status).json(rr.body);
        }
        reservedRowId = reserve.rowId;
      }

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

      const artwork = await generateHiggsfieldArtwork({
        prompt,
        mode,
        slot,
        imageReferences: referenceBuffers.length ? referenceBuffers : undefined,
        model: String(body.model ?? "").trim() || undefined,
      });
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
      } catch {
        /* audit table optional; never fail an already-generated image */
      }
      const candRow = await vqStorage
        .recordArtworkCandidate({
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
        })
        .catch(() => null);

      // Identity gate: card art must stay the SAME character as the approved pack.
      // Below-threshold results are auto-rejected — stored for audit, never shown.
      let cardIdentity: IdentityResult | null = null;
      if (bible?.character && ownRefCount > 0 && candRow) {
        const gate = await scoreAndGateCandidate(
          candRow.id,
          artwork.png,
          referenceBuffers.slice(0, ownRefCount),
          bible.character
        );
        cardIdentity = gate.identity;
        if (gate.autoRejected) {
          await finishOk(perImage, candRow?.id ?? null, artwork.model);
          return res.status(422).json({
            error: `Identity Score ${gate.identity?.score}/${gate.identity?.threshold} — the artwork drifted from the approved character, so it was auto-rejected. Generate again.`,
            autoRejected: true,
            identityScore: gate.identity?.score ?? null,
            identityThreshold: gate.identity?.threshold ?? identityThreshold(),
          });
        }
      }

      await finishOk(perImage, candRow?.id ?? null, artwork.model);
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
        idempotencyKey,
      });
    } catch (err) {
      await finishErr(err);
      // Expired/invalid token → clean 503 "provider not connected" (not a crash).
      // Higgsfield plan/credit limits → clean 402 with an actionable message.
      // Real generation faults stay 500. Text AI + Save Draft are unaffected either way.
      const msg = err instanceof Error ? err.message : "Artwork generation failed";
      const notConnected = /not connected|rejected the token|401|Invalid credentials/i.test(msg);
      const planLimit = /minimum_basic_plan|plan_required|basic_plan|not enough credits|insufficient|402|\b403\b/i.test(
        msg
      );
      if (notConnected) {
        return res
          .status(503)
          .json({ error: "Artwork provider not connected — token missing or expired", connected: false });
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
      if (!validVqCardId(cardId))
        return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
      if (!candidateKey || !isCandidateKeyForCard(candidateKey, cardId))
        return res.status(400).json({ error: "Artwork candidate does not belong to this card." });
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
          return res
            .status(422)
            .json({ error: "Character Bible missing — generate text only or create Character Bible first." });
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
      const hasMasterPortrait = !!(
        bible?.character?.referencePack?.master_portrait?.r2Key || bible?.character?.approvedArtworkR2Key
      );
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
      } catch {
        /* audit best-effort; never fail the suggestion */
      }
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
      res.json({ keywords: [...keywords].sort(), effects: [...effects].sort(), providers: await providerStatuses() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "taxonomy failed" });
    }
  });

  // add-new element (placeholder palette, NEEDS_APPROVAL by convention)
  app.post("/api/admin/vault-quest/elements", requireAdmin, async (req: Request, res: Response) => {
    try {
      const name = String((req.body as { name?: string }).name ?? "").trim();
      if (!/^[A-Za-z][A-Za-z0-9 ]{0,23}$/.test(name))
        return res.status(400).json({ error: "element name must be 1-24 letters/digits/spaces" });
      const el = await vqStorage.createElement(name);
      res.status(201).json({ element: el.name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "add element failed" });
    }
  });

  // add-new family (auto id, create-only, no cards)
  app.post("/api/admin/vault-quest/families", requireAdmin, async (req: Request, res: Response) => {
    try {
      const b = req.body as {
        name?: string;
        element?: string;
        stage1Name?: string;
        stage2Name?: string;
        stage3Name?: string;
        setCode?: string;
      };
      const name = String(b.name ?? "").trim();
      const element = String(b.element ?? "").trim();
      if (!name || !element) return res.status(400).json({ error: "family name and element are required" });
      const setCode = (b.setCode ?? "GNV").trim() || "GNV";
      const existing = await vqStorage.listFamilies(setCode);
      let max = 0;
      for (const f of existing) {
        const m = /F(\d+)/.exec(f.familyId ?? "");
        if (m) max = Math.max(max, Number(m[1]));
      }
      const familyId = `${setCode}-F${String(max + 1).padStart(2, "0")}`;
      await vqStorage.createFamilyAndCards(
        {
          familyId,
          setCode,
          element,
          name,
          stage1Name: b.stage1Name?.trim() || null,
          stage2Name: b.stage2Name?.trim() || null,
          stage3Name: b.stage3Name?.trim() || null,
        },
        []
      );
      res.status(201).json({ familyId, name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "add family failed" });
    }
  });

  // ---- live preview (DB-free) ----
  app.post("/api/admin/vault-quest/cards/preview", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as VqEditorPayload & {
        artCandidateKey?: string | null;
        prevArtCandidateKey?: string | null;
        cardId?: string;
      };
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
        if (!validVqCardId(cardId))
          return res
            .status(400)
            .json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
        const slot = (req.query.slot as string) === "prev" ? "prev" : "main";
        const png = await (await import("sharp")).default(file.buffer).png().toBuffer();
        // Atomic immutable revision (Phase 10A-6, R5-F2) — a manual admin upload gets
        // the SAME durability guarantee as an AI-generated candidate promotion. If the
        // card row doesn't exist yet (a brand-new card, art uploaded before first Save),
        // the pointer-column update is a harmless no-op — the /cards save route picks
        // the key up from the ledger itself (getActiveRevisionKey) on first save.
        const { r2Key: key } = await promoteCardArtRevision({
          cardId,
          slot,
          buffer: png,
          width: guard.width,
          height: guard.height,
          createdBy: req.session?.adminEmail || "admin",
        });
        res.json({ key, slot, width: guard.width, height: guard.height });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "upload failed" });
      }
    }
  );

  // ---- serve stored artwork BY CARD ID (admin preview thumbnail; never the raw R2 key) ----
  app.get("/api/admin/vault-quest/cards/:cardId/art/:slot", requireAdmin, async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      if (!validVqCardId(cardId)) return res.status(400).json({ error: "invalid card id" });
      const slot = String(req.params.slot) === "prev" ? "prev" : "main";
      // Phase 10A-6 (R5-F1): resolve the STORED pointer — the card's own column is
      // authoritative for both legacy flat keys and new revisioned keys; the ledger's
      // active-revision key is the fallback for a brand-new, not-yet-saved card whose
      // art was just uploaded directly. Never re-derive the deterministic flat path.
      const card = await vqStorage.getCard(cardId).catch(() => undefined);
      const storedKey = slot === "main" ? card?.artR2Key : card?.prevArtR2Key;
      const key = storedKey || (await getActiveRevisionKey("card", cardId, slot));
      if (!key) return res.status(404).json({ error: "no artwork on file" });
      const buf = await getR2Buffer(assertVqReadKey(key));
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
    }
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
      const evaluation = await evaluateCard({
        card: studio.card,
        previousStage: studio.previousStage,
        familyName: studio.familyName,
        base: studio.base,
        mainArt: art.mainArt,
        prevArt: art.prevArt,
      });
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
      const evaluation = await evaluateCard({
        card: studio.card,
        previousStage: studio.previousStage,
        familyName: studio.familyName,
        base: studio.base,
        mainArt: art.mainArt,
        prevArt: art.prevArt,
      });
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
      if (fmt === "svg") {
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Content-Disposition", `attachment; filename="${fname}.svg"`);
        return res.send(result.svg);
      }
      if (fmt === "png") {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename="${fname}.png"`);
        return res.send(result.masterPng ?? result.previewPng);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}.pdf"`);
      return res.send(result.pdf);
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
      if (sel.approvedOnly)
        cards = cards.filter((c) => ["approved", "export_ready", "printed_proxy"].includes(c.status));
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
        const e = await evaluateCard({
          card: s.card,
          previousStage: s.previousStage,
          familyName: s.familyName,
          base: s.base,
          mainArt: art.mainArt,
          prevArt: art.prevArt,
        });
        results.push({
          cardId: s.card.cardId,
          status: e.status,
          render: e.renderStatus,
          readiness: e.readiness,
          rejects: e.qa.filter((i) => i.level === "reject").length,
        });
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
        if (!(await vqFeatureGateOrRespond(res, "exports"))) return; // emergency kill switch (Phase 10A-4)
        const ids = await resolveCardIds(req.body as Selector);
        if (!ids.length) return res.status(400).json({ error: "no cards selected" });
        const ownerAdminId = req.session?.adminEmail || "admin";
        const { jobId, count } = await startExport(kind, ownerAdminId, ids);
        res.status(202).json({ jobId, count });
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = err instanceof Error ? err.message : `${kind} failed to start`;
        // Concurrency back-pressure ("too many exports") is our own safe text → surface it.
        if (status === 429 || /too many exports/i.test(msg)) return res.status(429).json({ error: msg });
        // Otherwise return a GENERIC 500 — never echo err.message, which could carry raw
        // Postgres text (e.g. "column \"ids\" does not exist") on an unexpected DB error.
        console.error(`[vq-export] ${kind} start failed:`, msg);
        res.status(500).json({ error: `${kind} failed to start` });
      }
    };
  }

  // proxy sheet PDF (A4 3×3) — background job
  app.post("/api/admin/vault-quest/proxy", requireAdmin, startBatch("proxy"));
  // export pack (.zip): svg/png/pdf + per-card metadata + manifest + checksums — background job
  app.post("/api/admin/vault-quest/export/pack", requireAdmin, startBatch("pack"));

  // job progress (poll) — durable (Postgres) first, legacy in-memory fallback, so a
  // poll that lands on a different Fly machine than the POST still finds the job.
  app.get("/api/admin/vault-quest/export/jobs/:id", requireAdmin, async (req: Request, res: Response) => {
    const view = await getExportStatusView(String(req.params.id));
    if (!view) return res.status(404).json({ error: "job not found or expired" });
    res.json(view);
  });

  // download the finished file. Durable jobs stream from shared R2 (same-origin,
  // behind admin auth) so any machine can serve it; legacy jobs stream the temp file.
  app.get("/api/admin/vault-quest/export/jobs/:id/file", requireAdmin, async (req: Request, res: Response) => {
    const plan = await resolveExportDownload(String(req.params.id));
    switch (plan.kind) {
      case "not_found":
        return res.status(404).json({ error: "job not found or expired" });
      case "running":
        return res.status(409).json({ error: "export still running" });
      case "failed":
        return res.status(422).json({ error: plan.message });
      case "gone":
        return res.status(410).json({ error: "export file no longer available" });
      case "r2": {
        const obj = await getR2ObjectStream(plan.outputKey);
        if (!obj) return res.status(410).json({ error: "export file no longer available" });
        res.setHeader("Content-Type", plan.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${plan.fileName}"`);
        const len = plan.bytes ?? obj.contentLength;
        if (len) res.setHeader("Content-Length", String(len));
        res.on("close", () => (obj.body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.());
        obj.body.on("error", () => {
          if (!res.headersSent) res.status(500).json({ error: "failed to read export file" });
          else res.destroy();
        });
        return obj.body.pipe(res);
      }
      case "file": {
        const fs = await import("fs");
        if (!fs.existsSync(plan.filePath)) return res.status(410).json({ error: "export file no longer available" });
        res.setHeader("Content-Type", plan.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${plan.fileName}"`);
        if (plan.bytes) res.setHeader("Content-Length", String(plan.bytes));
        const stream = fs.createReadStream(plan.filePath);
        stream.on("error", () => {
          if (!res.headersSent) res.status(500).json({ error: "failed to read export file" });
          else res.destroy();
        });
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
    }
  });
}
