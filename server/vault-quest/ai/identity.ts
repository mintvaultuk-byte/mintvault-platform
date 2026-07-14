/**
 * Character Identity Score (Phase 2 — visual identity lock).
 *
 * After a referenced generation, the new image is compared against the character's
 * APPROVED references with Anthropic vision. Each locked trait is scored 0-100 and
 * the overall score decides whether the candidate is even shown: below the
 * threshold it is auto-rejected (stored for audit, never surfaced as a pick).
 *
 * Fail-open by design: if the scoring call itself fails (key missing, timeout),
 * the candidate is kept WITH a warning — an Anthropic outage must not block the
 * whole art pipeline. Only a real low score rejects.
 */
import sharp from "sharp";
import { anthropicFetch } from "../../anthropic-fetch";
import type { VqCharacter } from "@shared/vq-schema";
import { evaluatePoseDiversity, type PoseDiversityVerdict } from "./pose-diversity";
import { evaluateActionNovelty, type ActionNoveltyVerdict } from "./action-novelty";
import { evaluateEvolutionDifference, evolutionDifferencePromptFragment, type EvolutionDifferenceVerdict } from "./evolution-diversity";

export interface IdentityBreakdown {
  bodyShape: number;
  colours: number;
  markings: number;
  eyes: number;
  silhouette: number;
  accessories: number;
  familyTraits: number;
  stageTraits: number;
  notes?: string;
}

export interface IdentityResult {
  score: number; // 0-100 overall
  breakdown: IdentityBreakdown;
  verdict: "pass" | "reject";
  threshold: number;
  /** Only present when `opts.masterPng` was supplied — the Action Reference
   *  pose-diversity gate (independent of the identity verdict above). */
  poseDiversity?: PoseDiversityVerdict;
  /** Only present when `opts.existingActionPng` was supplied — the Action Reference
   *  REPLACEMENT novelty gate: how different this pose is from the CURRENTLY approved
   *  Action pose (independent of identity and of poseDiversity — see action-novelty.ts). */
  actionNovelty?: ActionNoveltyVerdict;
  /** Only present when `opts.evolutionPrevPng` was supplied — the Stage 2/3
   *  evolution-difference gate (independent of the identity verdict above and of
   *  poseDiversity — see evolution-diversity.ts). */
  evolutionDifference?: EvolutionDifferenceVerdict;
}

const VISION_MODEL = process.env.VQ_AI_TEXT_MODEL || "claude-haiku-4-5-20251001";

/** Overall score below this ⇒ auto-reject (override with VQ_IDENTITY_MIN). */
export function identityThreshold(): number {
  const n = Number(process.env.VQ_IDENTITY_MIN);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 70;
}

async function toJpegBase64(png: Buffer): Promise<string> {
  // Downscale for the vision call — identity traits survive 512px; tokens stay small.
  const jpg = await sharp(png).resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  return jpg.toString("base64");
}

const clampScore = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};

/**
 * Score a generated image against the character's approved reference image(s).
 * Returns null when scoring is UNAVAILABLE (no key / API failure) — callers keep
 * the candidate and surface a warning instead of rejecting blind.
 */
export async function scoreCharacterIdentity(
  generatedPng: Buffer,
  referencePngs: Buffer[],
  character: Pick<VqCharacter, "characterName" | "bodyShape" | "colours" | "markings" | "eyes" | "tailAccessories" | "stageNumber" | "element">,
  opts?: {
    /** The character's approved Master Reference (neutral standing pose). When supplied,
     *  the SAME vision call also scores pose-diversity against THIS specific image (one
     *  round trip, not a second paid/timed call) — see pose-diversity.ts. Omit for
     *  reference types that aren't pose-gated (master_portrait itself, face_closeup, etc). */
    masterPng?: Buffer;
    /** The character's CURRENTLY approved Action pose (only for an Action Reference
     *  REPLACEMENT). When supplied, the SAME vision call also scores how different the
     *  new pose is from THIS specific image — the replacement-novelty gate (one round
     *  trip). Independent of identity and of masterPng's poseDiversity. Omit for a
     *  first Action (nothing to replace) or non-action reference types. */
    existingActionPng?: Buffer;
    /** The PREVIOUS evolution stage's approved Master Reference. When supplied, the SAME
     *  vision call also scores evolution-difference against THIS specific image (one
     *  round trip) — see evolution-diversity.ts. Only meaningful for stage 2/3 Master
     *  Reference generation; omit otherwise. Completely independent of the identity
     *  breakdown above, which still compares against the character's OWN referencePngs. */
    evolutionPrevPng?: Buffer;
  },
): Promise<IdentityResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || referencePngs.length === 0) return null;
  const masterPng = opts?.masterPng;
  const existingActionPng = opts?.existingActionPng;
  const evolutionPrevPng = opts?.evolutionPrevPng;
  try {
    const refs = referencePngs.slice(0, 2); // primary references are enough to judge identity
    const content: unknown[] = [
      { type: "text", text: `APPROVED REFERENCE image(s) of the character "${character.characterName}" (stage ${character.stageNumber}, ${character.element}):` },
      ...(await Promise.all(refs.map(async (r) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(r) } })))),
      ...(masterPng ? [
        { type: "text", text: "MASTER REFERENCE — this is the character's canonical neutral standing pose. Compare the NEW image's POSE (not identity) against THIS specific image:" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(masterPng) } },
      ] : []),
      ...(existingActionPng ? [
        { type: "text", text: "EXISTING APPROVED ACTION POSE — the character's currently approved action pose that this NEW image is meant to REPLACE. Compare the NEW image's ACTION/POSE (not identity) against THIS specific image — the new one must be a clearly DIFFERENT action, not a repeat of it:" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(existingActionPng) } },
      ] : []),
      ...(evolutionPrevPng ? [
        { type: "text", text: "PREVIOUS EVOLUTION STAGE reference — the character's approved form immediately before this stage. Compare the NEW image's EVOLUTION (not identity against the approved references above) against THIS specific image:" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(evolutionPrevPng) } },
      ] : []),
      { type: "text", text: "NEWLY GENERATED image to judge:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(generatedPng) } },
      {
        type: "text",
        text: `Locked DNA (authoritative): body shape: ${character.bodyShape ?? "-"}; colours: ${character.colours ?? "-"}; markings: ${character.markings ?? "-"}; eyes: ${character.eyes ?? "-"}; accessories: ${character.tailAccessories ?? "-"}.
Score how faithfully the NEW image preserves the SAME character as the approved reference(s). Pose, camera angle, lighting, background, expression and action are ALLOWED to change — do not penalise them. Score 0-100 for each locked trait (100 = identical trait, 0 = different creature): bodyShape, colours, markings, eyes, silhouette, accessories, familyTraits (element/family visual language), stageTraits (maturity level fits stage ${character.stageNumber}).${masterPng ? ` Additionally, and completely SEPARATELY from the identity traits above, score "poseDifference": how different is the NEW image's body pose, limb positions, head/camera angle, weight distribution and silhouette compared to the MASTER REFERENCE's neutral standing pose — 0 = essentially the same pose (only minor rotation/framing changes, e.g. still standing with feet/body-angle/head-rotation/tail nearly unchanged), 100 = a genuinely different action or pose (e.g. running, leaping, crouching, twisting, attacking, airborne, dynamic balance shift). This score must NOT affect or be averaged into the identity trait scores — a wildly different pose with perfect identity preservation should still score full marks on every identity trait above.` : ""}${existingActionPng ? ` Additionally, and completely SEPARATELY from every score above, score "actionDifference": how different is the NEW image's ACTION — its action category, body silhouette, limb arrangement, head direction, body rotation, centre of gravity, tail position and movement direction — compared to the EXISTING APPROVED ACTION POSE it is replacing — 0 = essentially the same action (same category and near-identical silhouette/limbs, only minor variation), 100 = a clearly different action (a different category entirely, e.g. sprinting vs roaring vs dodging, with an obviously different silhouette). A pose can be very different from the Master yet nearly identical to the existing action — in that case poseDifference is high but actionDifference is LOW. This score must NOT affect or be averaged into any identity or pose score above.` : ""}${evolutionPrevPng ? ` Additionally, and completely SEPARATELY from the identity traits above and from the approved reference(s) (which are NOT relevant to this next score), compare the NEW image against the PREVIOUS EVOLUTION STAGE reference: ${evolutionDifferencePromptFragment(character.stageNumber)} This score must NOT affect or be averaged into the identity trait scores above.` : ""} Return STRICT JSON only: {"bodyShape":0,"colours":0,"markings":0,"eyes":0,"silhouette":0,"accessories":0,"familyTraits":0,"stageTraits":0,"overall":0${masterPng ? ',"poseDifference":0' : ""}${existingActionPng ? ',"actionDifference":0' : ""}${evolutionPrevPng ? ',"evolutionDifference":0' : ""},"notes":"one short sentence"}`,
      },
    ];
    const res = await anthropicFetch(
      { model: VISION_MODEL, max_tokens: 300, messages: [{ role: "user", content }] },
      { apiKey, timeoutMs: 45_000 },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { text?: string }[] };
    const raw = (data.content?.[0]?.text ?? "").trim();
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
    const breakdown: IdentityBreakdown = {
      bodyShape: clampScore(parsed.bodyShape),
      colours: clampScore(parsed.colours),
      markings: clampScore(parsed.markings),
      eyes: clampScore(parsed.eyes),
      silhouette: clampScore(parsed.silhouette),
      accessories: clampScore(parsed.accessories),
      familyTraits: clampScore(parsed.familyTraits),
      stageTraits: clampScore(parsed.stageTraits),
      notes: String(parsed.notes ?? "").slice(0, 300) || undefined,
    };
    const overall = parsed.overall != null ? clampScore(parsed.overall) : Math.round(
      (breakdown.bodyShape + breakdown.colours + breakdown.markings + breakdown.eyes + breakdown.silhouette + breakdown.accessories + breakdown.familyTraits + breakdown.stageTraits) / 8,
    );
    const threshold = identityThreshold();
    const poseDiversity = masterPng && parsed.poseDifference != null ? evaluatePoseDiversity(Number(parsed.poseDifference)) : undefined;
    const actionNovelty =
      existingActionPng && parsed.actionDifference != null ? evaluateActionNovelty(Number(parsed.actionDifference)) : undefined;
    const evolutionDifference =
      evolutionPrevPng && parsed.evolutionDifference != null
        ? evaluateEvolutionDifference(Number(parsed.evolutionDifference), character.stageNumber)
        : undefined;
    return { score: overall, breakdown, verdict: overall >= threshold ? "pass" : "reject", threshold, poseDiversity, actionNovelty, evolutionDifference };
  } catch {
    return null; // scoring unavailable — never block the pipeline on the scorer itself
  }
}
