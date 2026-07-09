import { randomUUID } from "crypto";
import sharp from "sharp";
import type { CardContext } from "./generators";

export type ArtworkSlot = "main" | "prev";

export interface HiggsfieldConnection {
  connected: boolean;
  note: string;
  model: string;
  baseUrl: string;
}

export interface HiggsfieldArtworkResult {
  provider: "higgsfield";
  model: string;
  jobId?: string;
  png: Buffer;
  width: number;
  height: number;
}

// Live API gateway — extracted from the official `higgsfield` CLI binary and
// VERIFIED against the real API (2026-07-09):
//   auth      Bearer <oat_… access token from `higgsfield auth token`> + hf-workspace-id header
//   workspace GET  {base}/developer/v2alpha/account/workspaces          → [{id,…}]
//   cost      POST {base}/developer/v2alpha/jobs/{job_type}/cost        {params:{…}} → {credits}
//   create    POST {base}/developer/v2alpha/images/{job_type}/generations {params:{…}} → {id, job_type, credits}
//   poll      GET  {base}/developer/v2alpha/jobs/{id}                   → {status, result_url, …}
// (api.higgsfield.ai is dead — Cloudflare 521; platform.higgsfield.ai is a different service.)
const DEFAULT_API_BASE = "https://fnf-api-gw.higgsfield.ai/fnf";
// Default image model: Nano Banana (1 credit/image). Verified available via
// `higgsfield model list`; override with HIGGSFIELD_MODEL (e.g. z_image = 0.15cr,
// nano_banana_pro, seedream_v4_5, …).
const DEFAULT_MODEL = "nano_banana";
const MAX_PROMPT_CHARS = 3600;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function higgsfieldConnection(): HiggsfieldConnection {
  const apiKey = env("HIGGSFIELD_API_KEY");
  const model = env("HIGGSFIELD_MODEL") || DEFAULT_MODEL;
  // Accept either HIGGSFIELD_API_URL or HIGGSFIELD_API_BASE (both mean the API host);
  // default is already the live host, so neither is required.
  const baseUrl = (env("HIGGSFIELD_API_URL") || env("HIGGSFIELD_API_BASE") || DEFAULT_API_BASE).replace(/\/+$/, "");
  if (apiKey) {
    return { connected: true, note: `API key configured · model ${model}`, model, baseUrl };
  }
  const hfBin = env("HF_BIN");
  if (hfBin) {
    return {
      connected: false,
      note: "HF_BIN is configured, but Card Studio needs HIGGSFIELD_API_KEY for in-app image generation",
      model,
      baseUrl,
    };
  }
  return { connected: false, note: "HIGGSFIELD_API_KEY not set", model, baseUrl };
}

function clean(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function aspectRatioFor(slot: ArtworkSlot, mode: string): string {
  if (slot === "prev" || mode === "prev-portrait") return "1:1";
  if (mode === "family-sheet" || mode === "fsr-scene") return "16:9";
  return "4:3";
}

export function buildVaultQuestArtworkPrompt(ctx: CardContext, mode: string, slot: ArtworkSlot): string {
  const name = clean(ctx.name) || "unnamed Vault Quest subject";
  const type = clean(ctx.cardType) || "Creature";
  const element = clean(ctx.element) || "Neutral";
  const stage = clean(ctx.stageNumber) || "unspecified";
  const family = clean(ctx.familyName) || "unlinked family";
  const previous = clean(ctx.previousStage) || "previous evolution stage";
  const rarity = clean(ctx.rarity) || "standard rarity";
  const attack = clean(ctx.attack1Name);
  const subject =
    slot === "prev" || mode === "prev-portrait"
      ? `${previous}, the earlier evolution before ${name}`
      : mode === "family-sheet"
        ? `${family} evolution family, three original stages shown side by side`
        : `${name}, an original ${element} ${type.toLowerCase()} from Vault Quest`;

  const modeDirection: Record<string, string> = {
    main: "main creature/object artwork with a strong readable silhouette",
    "prev-portrait": "small previous-stage portrait, cute and simpler than the current stage",
    "family-sheet": "family sheet composition showing baby, teen, and final forms together",
    variant: "premium variant artwork with richer lighting and a more dramatic pose",
    "fsr-scene": "full-scene illustration with the subject interacting with its environment",
    cleaner: "cleaner simpler artwork with fewer background details",
    "more-mascot": "friendlier mascot-style artwork with rounded forms and expressive eyes",
    "less-pokemon": "more original silhouette and material language, less monster-battler familiar",
  };

  // IMPORTANT: never use the word "card" (or frame/stat/name-plate vocabulary) in
  // the POSITIVE prompt — tested live: "collectible-card illustration quality" +
  // "Card context: stage/rarity" made the model draw a full trading-card layout
  // with frame, name plate and text box. Character illustration language only.
  return [
    `Character illustration ONLY — a standalone painting of a single subject on a plain clean background. No frame, no border, no panel, no banner, no name plate, no text, no letters, no numbers, no logo, no watermark, no user interface.`,
    `Subject: ${subject}.`,
    `Style focus: ${modeDirection[mode] ?? modeDirection.main}.`,
    `Theme: ${element}-themed original creature design${type !== "Creature" ? ` (${type.toLowerCase()} object)` : ""}, maturity level ${stage} of 3 (1 = cute baby, 3 = powerful final form).`,
    attack ? `Personality/action cue: ${attack}.` : "Personality: friendly, adventurous, bold, family-safe.",
    "Art direction: premium character illustration, soft cinematic light, crisp readable silhouette, charming but not childish, fully original design.",
    "Composition: subject centred with generous breathing room on every side, simple clean or softly-lit plain background.",
    `Colour palette: driven by the ${element} theme with balanced secondary colours and strong contrast.`,
    "Do not imitate any famous franchise, character, or art style. Artwork only.",
  ].join(" ");
}

export function safeVqCardId(cardId: string): string {
  return clean(cardId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

export function validVqCardId(cardId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(cardId);
}

export function vqArtworkCandidateKey(cardId: string): string {
  return `vq/art-candidates/${safeVqCardId(cardId)}/${Date.now()}-${randomUUID()}.png`;
}

export function isCandidateKeyForCard(key: string, cardId: string): boolean {
  const safe = safeVqCardId(cardId);
  return key.startsWith(`vq/art-candidates/${safe}/`) && /^[A-Za-z0-9/._:-]+\.png$/.test(key);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/**
 * Resolve the Higgsfield workspace id (required as the hf-workspace-id header on
 * every call). Uses HIGGSFIELD_WORKSPACE_ID when set, otherwise fetches the
 * account's workspaces once and caches the first (private) workspace.
 */
let cachedWorkspaceId: string | null = null;
async function resolveWorkspaceId(baseUrl: string, key: string): Promise<string> {
  const fromEnv = env("HIGGSFIELD_WORKSPACE_ID");
  if (fromEnv) return fromEnv;
  if (cachedWorkspaceId) return cachedWorkspaceId;
  const res = await fetchWithTimeout(`${baseUrl}/developer/v2alpha/account/workspaces`, {
    headers: { Authorization: `Bearer ${key}` },
  }, 20_000);
  if (!res.ok) throw new Error(`Higgsfield workspaces failed (${res.status}) — token may have expired; run \`higgsfield auth token\` and update HIGGSFIELD_API_KEY.`);
  const data = (await readJson(res)) as { id?: string }[] | { items?: { id?: string }[] };
  const list = Array.isArray(data) ? data : (data.items ?? []);
  const id = list.find((w) => w?.id)?.id;
  if (!id) throw new Error("Higgsfield returned no workspaces for this account.");
  cachedWorkspaceId = id;
  return id;
}

interface HfJob {
  id?: string;
  status?: string;
  result_url?: string | null;
  min_result_url?: string | null;
  thumbnail_url?: string | null;
  detail?: unknown;
}

async function normaliseGeneratedImage(raw: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const png = await sharp(raw)
    .rotate()
    .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) {
    throw new Error("Higgsfield returned an image that is too small to use");
  }
  return { png, width: meta.width, height: meta.height };
}

export async function generateHiggsfieldArtwork(input: {
  prompt: string;
  mode: string;
  slot: ArtworkSlot;
}): Promise<HiggsfieldArtworkResult> {
  const key = env("HIGGSFIELD_API_KEY");
  const conn = higgsfieldConnection();
  if (!key || !conn.connected) {
    throw new Error("Higgsfield provider not connected — set HIGGSFIELD_API_KEY (from `higgsfield auth token`) and restart the local server.");
  }
  const workspaceId = await resolveWorkspaceId(conn.baseUrl, key);
  const headers = {
    Authorization: `Bearer ${key}`,
    "hf-workspace-id": workspaceId,
    "Content-Type": "application/json",
  };

  // Create: POST /developer/v2alpha/images/{job_type}/generations  {params:{…}}
  const body = {
    params: {
      prompt: input.prompt.slice(0, MAX_PROMPT_CHARS),
      aspect_ratio: aspectRatioFor(input.slot, input.mode),
    },
  };
  const createRes = await fetchWithTimeout(
    `${conn.baseUrl}/developer/v2alpha/images/${encodeURIComponent(conn.model)}/generations`,
    { method: "POST", headers, body: JSON.stringify(body) },
    45_000,
  );
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    if (createRes.status === 401) throw new Error("Higgsfield rejected the token (401) — it has likely expired. Run `higgsfield auth token` and update HIGGSFIELD_API_KEY in .env.");
    if (createRes.status === 402) throw new Error("Higgsfield: not enough credits to generate an image.");
    throw new Error(`Higgsfield create failed (${createRes.status})${errBody ? `: ${errBody.slice(0, 220)}` : ""}`);
  }
  const created = (await readJson(createRes)) as { id?: string };
  const jobId = created.id;
  if (!jobId) throw new Error("Higgsfield create returned no job id.");

  // Poll: GET /developer/v2alpha/jobs/{id} until completed/failed (~2 min cap).
  let job: HfJob | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1500 : 3000));
    const pollRes = await fetchWithTimeout(`${conn.baseUrl}/developer/v2alpha/jobs/${encodeURIComponent(jobId)}`, { headers }, 30_000);
    if (!pollRes.ok) {
      const errBody = await pollRes.text().catch(() => "");
      throw new Error(`Higgsfield poll failed (${pollRes.status})${errBody ? `: ${errBody.slice(0, 180)}` : ""}`);
    }
    const data = (await readJson(pollRes)) as HfJob;
    const status = (data.status ?? "").toLowerCase();
    if (["failed", "failure", "error", "errored", "cancelled", "canceled"].includes(status)) {
      throw new Error(`Higgsfield generation ${status}`);
    }
    if (status === "completed" && data.result_url) { job = data; break; }
  }
  if (!job?.result_url) throw new Error("Higgsfield did not finish in time — try Regenerate in a moment.");

  // Download the result (CDN URL — no auth header; don't leak the token to the CDN).
  const dl = await fetchWithTimeout(job.result_url, {}, 45_000);
  if (!dl.ok) throw new Error(`Higgsfield image download failed (${dl.status})`);
  const raw = Buffer.from(await dl.arrayBuffer());

  const image = await normaliseGeneratedImage(raw);
  return { provider: "higgsfield", model: conn.model, jobId, ...image };
}
