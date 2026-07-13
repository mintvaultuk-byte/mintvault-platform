/**
 * Stage-to-stage Evolution Difference gate.
 *
 * Root cause this fixes: Stage 2/3 Master Reference generation had NO check at all
 * that the new stage actually looks like a genuine evolution of the previous one.
 * The only text nudge was one soft sentence ("grown larger and more mature" —
 * EVOLUTION_REF_PROMPT in vault-quest-admin.ts) with zero scoring/gating behind it,
 * so a near-duplicate of the previous stage (same body, same silhouette, only a
 * minor appendage/accessory change) sailed straight through to approval.
 *
 * This module is the pure, independently-testable half of the fix: given a 0-100
 * "how much has this genuinely evolved from the previous stage" score, decide
 * pass/fail against a stage-specific configurable minimum. Deliberately separate
 * from identity — a candidate can have perfect family-identity preservation
 * (colours/eyes/markings/element) and still fail here (looks the same shape), and
 * a candidate can pass here while failing identity (evolved too far, wrong colours)
 * — the two are graded independently on purpose, mirroring pose-diversity.ts.
 */

import sharp from "sharp";
import { anthropicFetch } from "../../anthropic-fetch";

export interface EvolutionDifferenceVerdict {
  /** 0-100: 0 = looks essentially identical to the previous stage, 100 = dramatically more evolved. */
  difference: number;
  verdict: "pass" | "fail";
  threshold: number;
  /** The stage this verdict was judged for (2 or 3+) — the threshold depends on it. */
  stageNumber: number;
}

/** Minimum evolution-difference to pass for a given stage transition, in the SAME
 *  0-100 space as pose-diversity. Stage 2 vs Stage 1 defaults to 55 (env override
 *  VQ_EVOLUTION_DIFF_MIN_S2); Stage 3 vs Stage 2 (and any later stage) defaults to
 *  60 (env override VQ_EVOLUTION_DIFF_MIN_S3) — the final stage is expected to be
 *  an even more decisive leap than the first evolution. */
export function evolutionDifferenceThreshold(stageNumber: number): number {
  const envVar = stageNumber >= 3 ? process.env.VQ_EVOLUTION_DIFF_MIN_S3 : process.env.VQ_EVOLUTION_DIFF_MIN_S2;
  const n = Number(envVar);
  if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  return stageNumber >= 3 ? 60 : 55;
}

/** Pure pass/fail derivation — no network call, no mocking needed to test it. */
export function evaluateEvolutionDifference(difference: number, stageNumber: number): EvolutionDifferenceVerdict {
  const threshold = evolutionDifferenceThreshold(stageNumber);
  const clamped = Number.isFinite(difference) ? Math.max(0, Math.min(100, Math.round(difference))) : 0;
  return { difference: clamped, verdict: clamped >= threshold ? "pass" : "fail", threshold, stageNumber };
}

/** Shared rubric text — used both by identity.ts's combined vision call (when the
 *  character already has its own approved references) and by the standalone
 *  scoreEvolutionDifference() below (bootstrap: no own references yet). Kept in one
 *  place so the two paths can never drift apart in wording. */
export function evolutionDifferencePromptFragment(stageNumber: number): string {
  const stageDesc =
    stageNumber >= 3
      ? "This is the FINAL and most powerful stage of the line — it should show the strongest proportions and most developed anatomy, a mature face and body, and expanded elemental features, armour, markings or silhouette, unmistakably more advanced than the previous stage."
      : "This is a visibly older and more capable stage — it should show a larger body and stronger proportions, more developed limbs, fins, wings, tail, horns, armour or elemental features, and a more confident expression and stance, with a clearly different silhouette.";
  return (
    `${stageDesc} Score "evolutionDifference" 0-100: comparing the NEW image against the PREVIOUS EVOLUTION STAGE reference, judge how much the overall SILHOUETTE, body proportions, apparent age/maturity, limb development, elemental-feature growth, head-to-body ratio, detail complexity and size/power impression have genuinely changed. ` +
    `0 = looks essentially identical to the previous stage — same body size, same silhouette, same proportions, at most a minor appendage, accessory or colour difference (a duplicate pose or a cosmetic variant, not an evolution). ` +
    `100 = unmistakably more evolved — substantially larger/stronger body, a clearly different silhouette, visibly more developed limbs/fins/wings/horns/armour, and a more mature face and stance. ` +
    `Do NOT reward this score for pose, camera angle, lighting or background differences alone, and do NOT reward mere uniform scaling (a bigger version of the exact same shape) — only genuine anatomical/structural evolution counts.`
  );
}

const VISION_MODEL = process.env.VQ_AI_TEXT_MODEL || "claude-haiku-4-5-20251001";

async function toJpegBase64(png: Buffer): Promise<string> {
  const jpg = await sharp(png).resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  return jpg.toString("base64");
}

const clampScore = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};

/**
 * Standalone evolution-difference scoring call, used ONLY for the bootstrap case —
 * a stage>1 character generating its VERY FIRST Master Reference, before it has any
 * approved reference of its own to score identity against (scoreCharacterIdentity
 * has nothing to compare for identity purposes yet). Once the character has its own
 * approved reference, evolution-difference is scored in the SAME vision call as
 * identity via scoreCharacterIdentity's `opts.evolutionPrevPng` instead — this
 * standalone path exists so the bootstrap case is never left completely unscored.
 */
export async function scoreEvolutionDifference(
  generatedPng: Buffer,
  prevStagePng: Buffer,
  character: { characterName: string; stageNumber: number; element?: string | null },
): Promise<EvolutionDifferenceVerdict | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const content: unknown[] = [
      { type: "text", text: `PREVIOUS EVOLUTION STAGE reference image of "${character.characterName}" — the approved form immediately before this stage:` },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(prevStagePng) } },
      { type: "text", text: "NEW STAGE candidate image to judge:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(generatedPng) } },
      {
        type: "text",
        text: `This NEW image is meant to be a genuine evolution of the SAME creature line — recognisably descended from the previous stage (same core colour palette, eye design, key markings, elemental identity and art style), but visibly older and more developed. ${evolutionDifferencePromptFragment(character.stageNumber)} Return STRICT JSON only: {"evolutionDifference":0,"notes":"one short sentence"}`,
      },
    ];
    const res = await anthropicFetch(
      { model: VISION_MODEL, max_tokens: 200, messages: [{ role: "user", content }] },
      { apiKey, timeoutMs: 45_000 },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { text?: string }[] };
    const raw = (data.content?.[0]?.text ?? "").trim();
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
    return evaluateEvolutionDifference(clampScore(parsed.evolutionDifference), character.stageNumber);
  } catch {
    return null; // fail-open — an Anthropic outage must not block the whole art pipeline
  }
}
