/**
 * Instagram caption generator.
 *
 * Uses the existing server/anthropic-fetch.ts wrapper rather than the
 * @anthropic-ai/sdk package — the rest of this codebase calls Claude that
 * way (server/routes.ts L2441, L7664, L8657, L8786, etc.) and there's no
 * need to introduce a new dependency. Model: claude-sonnet-4-6 — the right
 * tier for caption work (fast, $3/$15 per MTok, current as of 2026-05).
 *
 * Output contract: JSON-only response, parsed into { caption, hashtags }.
 * The system prompt enforces the format; we strip ```json fences if the
 * model adds them anyway. Never throws on bad model output — falls back to
 * a generic caption + the static hashtag baseline so the cron job can still
 * post.
 */
import { anthropicFetch } from "../anthropic-fetch";
import type { IgPostData } from "./types";

export const BASE_HASHTAGS = [
  "#PokemonCards",
  "#PokemonGrading",
  "#PSAGrading",
  "#CGCCards",
  "#MintVault",
  "#GradedCards",
  "#PokemonCollector",
  "#TCGGrading",
  "#PokemonTCG",
  "#CardGrading",
  "#UKPokemon",
  "#VaultClub",
  "#GradedPokemon",
  "#PokemonInvestor",
  "#CardCollector",
] as const;

const FALLBACK_CAPTION: Record<string, string> = {
  card_reveal:       "Fresh out of the vault. Another graded card joins the registry.",
  grade_breakdown:   "Inside the grade — a closer look at how each subgrade lands.",
  service_explainer: "Choose the right service tier for your collection.",
  vault_club:        "Vault Club — priority grading and member-only perks.",
  market_insight:    "From the MintVault registry — a glance at this week's grading activity.",
};

const SYSTEM_PROMPT = [
  "You are the social media voice for MintVault, a premium UK Pokémon and TCG grading service.",
  "Brand tone: confident, knowledgeable, collector-focused. Not hype. Not emoji-heavy. Premium but approachable.",
  "Output JSON only, no prose, no fences. Schema: { \"caption\": string, \"hashtags\": string }",
  "Caption: max 220 characters. Direct, specific, no clichés. No emojis unless the post type is vault_club or market_insight (then max one).",
  "Hashtags: 15-20 tags space-separated, mix niche + broad. Always include the BASE set provided in the user prompt.",
  "Never fabricate grades, cert IDs, prices, or card names. Use only the data provided.",
].join(" ");

function buildUserPrompt(d: IgPostData): string {
  const lines: string[] = [
    `Post type: ${d.postType}`,
    `Base hashtags to include: ${BASE_HASHTAGS.join(" ")}`,
  ];

  switch (d.postType) {
    case "card_reveal":
      lines.push(
        `Card: ${d.cardName ?? "(unknown)"}`,
        `Set: ${d.setName ?? "(unknown)"}`,
        `Year: ${d.year ?? "(unknown)"}`,
        `Card number: ${d.cardNumber ?? "(unknown)"}`,
        `Rarity: ${d.rarity ?? "(unknown)"}`,
        `Game: ${d.cardGame ?? "Pokémon"}`,
        `Variant: ${d.variant ?? "(none)"}`,
        `Overall grade: ${d.gradeOverall ?? "(unknown)"}`,
        `Subgrades — centering ${d.gradeCentering ?? "—"}, corners ${d.gradeCorners ?? "—"}, edges ${d.gradeEdges ?? "—"}, surface ${d.gradeSurface ?? "—"}`,
        `Cert ID: ${d.certId ?? "(unknown)"}`,
        d.labelType === "black" ? "This is a Black Label cert (all four subgrades = 10). Lean into that." : "",
      );
      break;
    case "grade_breakdown":
      lines.push(
        `Card: ${d.cardName ?? "(unknown)"}`,
        `Overall grade: ${d.gradeOverall ?? "(unknown)"}`,
        `Subgrades — centering ${d.gradeCentering ?? "—"}, corners ${d.gradeCorners ?? "—"}, edges ${d.gradeEdges ?? "—"}, surface ${d.gradeSurface ?? "—"}`,
        `Grader's note: ${d.insight ?? "(none)"}`,
      );
      break;
    case "service_explainer":
      lines.push(
        `Service tier: ${d.tierName ?? "(unknown)"}`,
        `Tagline: ${d.tierTagline ?? "(none)"}`,
        `Price: ${d.tierPricePence != null ? `£${(d.tierPricePence / 100).toFixed(2)} per card` : "(unknown)"}`,
        `Turnaround: ${d.tierTurnaroundLabel ?? (d.tierTurnaroundDays ? `${d.tierTurnaroundDays} days` : "(unknown)")}`,
      );
      break;
    case "vault_club":
      lines.push(
        `Monthly: ${d.vaultClubMonthly ?? "£9.99/mo"}`,
        `Annual: ${d.vaultClubAnnual ?? "£99/yr"}`,
        `Benefits: ${(d.vaultClubBenefits ?? []).join(" • ")}`,
      );
      break;
    case "market_insight":
      lines.push(
        `Stat headline: ${d.insightStat ?? "(unknown)"}`,
        `Context: ${d.insightContext ?? "(none)"}`,
      );
      break;
  }

  lines.push("Return ONLY the JSON object. No prose, no fences.");
  return lines.filter(Boolean).join("\n");
}

export interface CaptionResult {
  caption: string;
  hashtags: string;
  fromFallback: boolean;
}

export async function generateCaption(d: IgPostData): Promise<CaptionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[ig-caption] ANTHROPIC_API_KEY not set — using fallback caption");
    return {
      caption:  FALLBACK_CAPTION[d.postType] ?? "MintVault — UK card grading.",
      hashtags: BASE_HASHTAGS.join(" "),
      fromFallback: true,
    };
  }

  try {
    const res = await anthropicFetch(
      {
        model:      "claude-sonnet-4-6",
        max_tokens: 400,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: "user", content: buildUserPrompt(d) }],
      },
      { apiKey, timeoutMs: 30_000 },
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[ig-caption] Anthropic API ${res.status}: ${errBody.slice(0, 300)}`);
      throw new Error(`HTTP ${res.status}`);
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const rawText = data.content?.find((c) => c.type === "text")?.text ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed: { caption?: string; hashtags?: string } = {};
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn(`[ig-caption] Model returned non-JSON output, falling back. First 200 chars: ${cleaned.slice(0, 200)}`);
      throw new Error("non-JSON output");
    }

    return {
      caption:  String(parsed.caption ?? FALLBACK_CAPTION[d.postType] ?? "").slice(0, 220),
      hashtags: String(parsed.hashtags ?? BASE_HASHTAGS.join(" ")),
      fromFallback: false,
    };
  } catch (err: any) {
    console.error(`[ig-caption] Generation failed (${err?.message ?? err}) — using fallback`);
    return {
      caption:  FALLBACK_CAPTION[d.postType] ?? "MintVault — UK card grading.",
      hashtags: BASE_HASHTAGS.join(" "),
      fromFallback: true,
    };
  }
}
