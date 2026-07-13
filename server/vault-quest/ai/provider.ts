/**
 * Vault Quest AI provider abstraction (Phase 5).
 *
 * Model/provider choices live here in config, not hard-coded at call sites, so a
 * future model swap is a one-line change. Text runs on the existing
 * ANTHROPIC_API_KEY; artwork generation uses the existing MintVault Higgsfield
 * API-key path when configured. Nothing here fails the Studio when a provider is
 * absent — clicks surface a provider-not-connected state instead.
 */
import { anthropicFetch } from "../../anthropic-fetch";
import { higgsfieldConnection } from "./higgsfield";
import { deriveHiggsfieldStatus, getLastHiggsfieldOutcome, type HiggsfieldStatus } from "./provider-status";
import { checkVqFeature } from "../lib/vq-feature-flags-store";

export type ProviderKind = "text" | "image";

export interface ProviderStatus {
  id: string;
  kind: ProviderKind;
  label: string;
  connected: boolean;
  note: string;
  /** 7-state detail (Phase 10A-3), Higgsfield only for now. `connected` above stays
   *  the simple boolean the existing UI reads; this is the honest detail behind it —
   *  see the note field for a human-readable reason when not fully `connected`. */
  status?: HiggsfieldStatus;
}

const STATUS_NOTE: Record<HiggsfieldStatus, string> = {
  connected: "connected",
  configured_unverified: "key configured — not yet verified by a real call",
  not_configured: "HIGGSFIELD_API_KEY not set",
  authentication_invalid: "token invalid or expired — run `higgsfield auth token` and update HIGGSFIELD_API_KEY",
  provider_unavailable: "provider had a problem on the last attempt — try again shortly",
  rate_limited: "rate limited — try again shortly",
  disabled_by_owner: "turned off by the owner",
};

// Text model is overridable via env; defaults to the model the rest of the app uses.
const TEXT_MODEL = process.env.VQ_AI_TEXT_MODEL || "claude-haiku-4-5-20251001";

export interface TextProvider {
  id: string;
  model: string;
  complete(system: string, user: string, maxTokens?: number): Promise<string>;
}

/** The active text provider, or null if no key is configured. */
export function getTextProvider(): TextProvider | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return {
    id: "anthropic",
    model: TEXT_MODEL,
    async complete(system, user, maxTokens = 1024) {
      const res = await anthropicFetch(
        { model: TEXT_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
        { apiKey, timeoutMs: 30_000 },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`text provider error ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      const data = (await res.json()) as { content?: { text?: string }[] };
      return (data.content?.[0]?.text ?? "").trim();
    },
  };
}

/** Image providers shown in Card Studio. Higgsfield is the active artwork path.
 *  `status` is derived from a REAL observed outcome (Phase 10A-3), composed with
 *  the owner emergency kill switch (Phase 10A-4) — a generation-disabled operator
 *  toggle reports `disabled_by_owner` rather than a confusing "looks broken". */
export async function imageProviders(): Promise<ProviderStatus[]> {
  const has = (v: string | undefined) => !!v && v.trim().length > 0;
  const higgsfield = higgsfieldConnection();
  const genCheck = await checkVqFeature("generation");
  const status = deriveHiggsfieldStatus({ connected: higgsfield.connected }, getLastHiggsfieldOutcome(), { disabledByOwner: !genCheck.ok });
  // `connected` stays true through `configured_unverified` too (key present, not yet
  // proven bad) so a fresh restart doesn't flash a scary red before the first real
  // call — it flips false only once a REAL failure (auth/rate/provider) is observed.
  const connected = status === "connected" || status === "configured_unverified";
  return [
    { id: "higgsfield", kind: "image", label: "Higgsfield", connected, note: STATUS_NOTE[status], status },
    { id: "openai-images", kind: "image", label: "OpenAI Images", connected: false, note: has(process.env.OPENAI_API_KEY) ? "configured elsewhere; out of scope for Vault Quest artwork" : "out of scope for this pass" },
    { id: "nano-banana", kind: "image", label: "Nano Banana", connected: false, note: "out of scope for this pass" },
    { id: "nano-banana-pro", kind: "image", label: "Nano Banana Pro", connected: false, note: "out of scope for this pass" },
  ];
}

/** All provider statuses (text + image) for the Studio settings/AI panel. */
export async function providerStatuses(): Promise<ProviderStatus[]> {
  const text = getTextProvider();
  return [
    {
      id: "anthropic",
      kind: "text",
      label: "Anthropic (text)",
      connected: !!text,
      note: text ? `model ${text.model}` : "ANTHROPIC_API_KEY not set",
    },
    ...(await imageProviders()),
  ];
}
