/**
 * AI caption writer for the weekly reel — calls the Anthropic Messages API
 * via the existing server/anthropic-fetch.ts wrapper.
 *
 * Output: a single string (the caption). On any failure the helper throws
 * — callers (server/jobs/weekly-reel.ts) fall back to the template
 * caption and log a warning.
 */

import { anthropicFetch } from "../anthropic-fetch";
import type { AiCaptionStyle, PipelineSettings } from "./pipeline-settings";
import { buildHashtags } from "./hashtag-presets";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 500;

const SYSTEM_PROMPT =
  "You are a social media copywriter for MintVault UK, a professional trading card grading service. " +
  "Write engaging captions for weekly card grading highlight reels.";

const STYLE_PROMPT: Record<AiCaptionStyle, string> = {
  professional:
    "Write a professional Instagram caption for a weekly highlights reel featuring these graded cards: {cardList}. Top grade: {topGrade}.",
  casual:
    "Write a fun, casual caption for a weekly highlights reel featuring these graded cards: {cardList}. Top grade: {topGrade}.",
  hype: "Write an exciting, hype-focused caption for a weekly highlights reel featuring these graded cards: {cardList}. Top grade: {topGrade}.",
  educational:
    "Write an educational caption explaining card grading and featuring these graded cards: {cardList}. Top grade: {topGrade}.",
};

export interface AiCaptionInput {
  cards: Array<{ certNumber: string; cardName: string | null; grade: number | null }>;
  topGrade: string;
  settings: Pick<
    PipelineSettings,
    "ai_caption_style" | "ai_caption_include_hashtags" | "hashtag_preset" | "custom_hashtags" | "hashtag_count"
  >;
}

function cardListLine(c: AiCaptionInput["cards"][number]): string {
  const name = c.cardName ?? "Unknown card";
  const grade = c.grade != null ? `grade ${c.grade}` : "ungraded";
  return `${c.certNumber} (${name}, ${grade})`;
}

export async function generateAiCaption(input: AiCaptionInput): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  const cardList = input.cards.map(cardListLine).join(", ");
  const styleTemplate = STYLE_PROMPT[input.settings.ai_caption_style] ?? STYLE_PROMPT.professional;
  let userPrompt = styleTemplate.replace("{cardList}", cardList).replace("{topGrade}", input.topGrade);

  const hashtagInstruction = input.settings.ai_caption_include_hashtags
    ? " Include relevant hashtags at the end of the caption."
    : " Do not include any hashtags.";
  userPrompt += hashtagInstruction;

  const res = await anthropicFetch(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    },
    { apiKey }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as any;
  // Messages API returns content as an array of blocks; we want the text.
  const text: string = Array.isArray(body?.content)
    ? body.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim()
    : "";
  if (!text) throw new Error("Anthropic returned no text content");

  // If hashtags requested but the model didn't add any, append from the
  // configured preset so the caller always gets a usable caption.
  if (input.settings.ai_caption_include_hashtags && !text.includes("#")) {
    const tags = buildHashtags({
      preset: input.settings.hashtag_preset,
      customRaw: input.settings.custom_hashtags,
      count: input.settings.hashtag_count,
    });
    if (tags.length > 0) return `${text}\n\n${tags.join(" ")}`;
  }

  return text;
}
