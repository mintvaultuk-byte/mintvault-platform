/**
 * Injectable vision provider for card identification.
 *
 * The provider is an interface so the pipeline is fully exercisable with ZERO
 * real calls: tests + the local no-key path use the deterministic mock; the
 * `anthropicVisionProvider` (Claude Haiku via the low-level `anthropicFetch`)
 * is the only one that spends, and it is selected ONLY when a key is present.
 * The prompt is defined HERE and never returned to the client (no prompt/token
 * leakage). We call `anthropicFetch` directly so nothing in the grading service
 * is imported or modified.
 */
import { anthropicFetch } from "../../anthropic-fetch";
import type { RawAiCardObservation } from "@shared/card-identification";

export const IDENTIFY_MODEL = "claude-haiku-4-5-20251001";

export interface VisionInput {
  frontBase64: string;
  frontMediaType: string;
  backBase64?: string | null;
  backMediaType?: string | null;
}

export interface VisionResult {
  observation: RawAiCardObservation;
  /** Actual cost in USD when the provider reports usage; null for the mock. */
  actualCostUsd: number | null;
}

export interface CardIdVisionProvider {
  readonly name: string;
  readonly model: string;
  /** True only when a real, chargeable call would occur. */
  readonly spends: boolean;
  identify(input: VisionInput): Promise<VisionResult>;
}

/** Selected when no API key is configured — never spends, always "unavailable". */
export class ProviderUnavailableError extends Error {
  code = "provider_unavailable" as const;
}

export const unavailableProvider: CardIdVisionProvider = {
  name: "none",
  model: "none",
  spends: false,
  async identify(): Promise<VisionResult> {
    throw new ProviderUnavailableError("AI identification is unavailable — use manual entry.");
  },
};

// ── Prompt (server-only; never exposed) ──────────────────────────────────────
const IDENTIFY_PROMPT = [
  "You are a Pokémon TCG identification assistant for a professional grading lab.",
  "Look ONLY at the provided card image(s) and report what is VISIBLE. Do not guess.",
  "If a value is not clearly visible, use null — never invent set codes, card numbers or rarities.",
  "Return ONLY a JSON object (no prose, no explanation) with these keys:",
  "{game, cardName, year, setNameGuess, setCodeGuess, collectorNumberText, languageGuess,",
  " rarityGuess, printedSymbolDescription, printedSymbolColourGuess, printedSymbolCountGuess,",
  " finishGuess, promoGuess, visibleStampText, regulationMark, modelConfidence, evidenceNotes}.",
  "collectorNumberText: exactly as printed, e.g. '176/191' or 'SWSH123'.",
  "printedSymbolColourGuess: one of black,silver,gold,rainbow or null. printedSymbolCountGuess: integer or null.",
  "modelConfidence: 0..1. evidenceNotes: max 3 short strings describing what you SAW (no reasoning chains).",
].join("\n");

function extractJson(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in provider response");
  return JSON.parse(m[0]);
}

function coerceObservation(raw: Record<string, unknown>): RawAiCardObservation {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
  const n = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
  const notes = Array.isArray(raw.evidenceNotes)
    ? raw.evidenceNotes.filter((x) => typeof x === "string").slice(0, 3).map((x) => String(x).slice(0, 140))
    : [];
  return {
    game: s(raw.game) ?? "pokemon",
    cardName: s(raw.cardName),
    year: s(raw.year),
    setNameGuess: s(raw.setNameGuess),
    setCodeGuess: s(raw.setCodeGuess),
    collectorNumberText: s(raw.collectorNumberText),
    languageGuess: s(raw.languageGuess),
    rarityGuess: s(raw.rarityGuess),
    printedSymbolDescription: s(raw.printedSymbolDescription),
    printedSymbolColourGuess: s(raw.printedSymbolColourGuess),
    printedSymbolCountGuess: n(raw.printedSymbolCountGuess),
    finishGuess: s(raw.finishGuess),
    promoGuess: s(raw.promoGuess),
    visibleStampText: s(raw.visibleStampText),
    regulationMark: s(raw.regulationMark),
    modelConfidence: n(raw.modelConfidence),
    evidenceNotes: notes,
  };
}

// Haiku pricing (USD/token) — used only to record actual cost after a real call.
const HAIKU_IN = 1 / 1_000_000;
const HAIKU_OUT = 5 / 1_000_000;

/** The real Anthropic vision provider. Only constructed when an API key exists. */
export function anthropicVisionProvider(apiKey: string): CardIdVisionProvider {
  return {
    name: "anthropic",
    model: IDENTIFY_MODEL,
    spends: true,
    async identify(input: VisionInput): Promise<VisionResult> {
      const content: unknown[] = [
        { type: "image", source: { type: "base64", media_type: input.frontMediaType, data: input.frontBase64 } },
      ];
      if (input.backBase64) {
        content.push({ type: "image", source: { type: "base64", media_type: input.backMediaType ?? "image/jpeg", data: input.backBase64 } });
      }
      content.push({ type: "text", text: IDENTIFY_PROMPT });

      const res = await anthropicFetch(
        { model: IDENTIFY_MODEL, max_tokens: 1024, messages: [{ role: "user", content }] },
        { apiKey, timeoutMs: 30_000 },
      );
      if (!res.ok) throw new Error(`provider_http_${res.status}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = body.content?.find((c) => c.type === "text")?.text ?? "";
      const observation = coerceObservation(extractJson(text));
      const inTok = body.usage?.input_tokens ?? 0;
      const outTok = body.usage?.output_tokens ?? 0;
      const actualCostUsd = inTok * HAIKU_IN + outTok * HAIKU_OUT;
      return { observation, actualCostUsd };
    },
  };
}

/** Deterministic mock — tests + local no-key dev. NEVER a real call, ZERO cost. */
export function mockVisionProvider(observation: RawAiCardObservation): CardIdVisionProvider {
  return {
    name: "mock",
    model: "mock",
    spends: false,
    async identify(): Promise<VisionResult> {
      return { observation, actualCostUsd: 0 };
    },
  };
}

/**
 * Select the provider for the current environment. Returns `unavailable` when no
 * key is set (local dev / tests never pass a key), so opening the page or hitting
 * the route without an explicit test mock can NEVER reach Anthropic.
 */
export function selectProvider(): CardIdVisionProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return unavailableProvider;
  return anthropicVisionProvider(apiKey);
}
