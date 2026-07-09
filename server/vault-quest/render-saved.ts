/**
 * Shared helpers for rendering a SAVED Vault Quest card (used by the admin routes
 * and the background export/proxy jobs). Kept in one place so the security-critical
 * art-key derivation lives once, and so batch jobs can render a pre-loaded studio
 * payload with NO extra DB round-trip (the N+1 fix).
 */
import { getR2Buffer } from "../r2";
import { renderCard, type RenderFormat, type RenderResult } from "./render-service";
import { resolveVariant, cardRowToRenderInput } from "./qa-engine";
import { normalizePdf } from "./pdf-normalize";
import { isCandidateKeyForCard } from "./ai/higgsfield";
import type { VqCardRow } from "@shared/vq-schema";

/** Deterministic VQ artwork key — derived from the card id, never client-supplied. */
export function vqArtKey(cardId: string, slot: "main" | "prev"): string {
  return `vq/art/${cardId}/${slot}.png`;
}

/**
 * HARD prefix guard for every Vault Quest R2 WRITE. VQ may only ever write inside
 * its own isolated prefixes — it must never be able to touch MintVault grading /
 * customer paths (images/, certificates/, labels/, scans/, uploads/, …). Called
 * at every VQ upload site; throws on anything outside the allowlist or any key
 * that could be normalised elsewhere (`..`, backslash, leading slash, control
 * chars). R2 keys are literal strings, so this is defence-in-depth — but it makes
 * the isolation a hard invariant instead of a convention.
 */
export const VQ_WRITE_PREFIXES = ["vq/art-candidates/", "vq/art/"] as const;
export function assertVqWriteKey(key: string): string {
  const ok =
    VQ_WRITE_PREFIXES.some((p) => key.startsWith(p)) &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.startsWith("/") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f]/.test(key);
  if (!ok) throw new Error(`blocked R2 write outside Vault Quest prefixes: "${key.slice(0, 80)}"`);
  return key;
}

/**
 * Fetch artwork buffers by CARD ID only (keys are derived, never taken from the
 * request body). Skips the R2 round-trip entirely when the card carries no
 * art-present flag, and fetches the two slots in parallel when it does — so an
 * art-less card costs 0 R2 calls instead of 2.
 */
export async function fetchArt(input: {
  cardId?: string | null;
  artR2Key?: string | null;
  prevArtR2Key?: string | null;
  artCandidateKey?: string | null;
  prevArtCandidateKey?: string | null;
}): Promise<{ mainArt?: Buffer; prevArt?: Buffer }> {
  const cardId = (input.cardId ?? "").trim();
  if (!cardId) return { mainArt: undefined, prevArt: undefined };
  const mainCandidate = (input.artCandidateKey ?? "").trim();
  const prevCandidate = (input.prevArtCandidateKey ?? "").trim();
  const [mainArt, prevArt] = await Promise.all([
    mainCandidate && isCandidateKeyForCard(mainCandidate, cardId)
      ? getR2Buffer(mainCandidate)
      : input.artR2Key ? getR2Buffer(vqArtKey(cardId, "main")) : Promise.resolve(null),
    prevCandidate && isCandidateKeyForCard(prevCandidate, cardId)
      ? getR2Buffer(prevCandidate)
      : input.prevArtR2Key ? getR2Buffer(vqArtKey(cardId, "prev")) : Promise.resolve(null),
  ]);
  return { mainArt: mainArt ?? undefined, prevArt: prevArt ?? undefined };
}

export type StudioPayload = {
  card: VqCardRow;
  previousStage: string | null;
  familyName: string | null;
  base: VqCardRow | null;
};

/**
 * Render an already-loaded studio payload (no DB hit). Resolves variant gameplay
 * from the base card, maps to render input, pulls art, and renders at the given
 * format. Callers that only need the master PNG (proxy) still pass "all" because
 * the locked engine has no master-only mode — the extra svg/pdf is cheap next to
 * the raster and we never touch the render engine.
 */
export async function renderSavedFromStudio(
  studio: StudioPayload,
  format: RenderFormat = "all",
): Promise<{ studio: StudioPayload; result: RenderResult }> {
  const resolved = studio.card.baseCardId ? resolveVariant(studio.card, studio.base) : studio.card;
  const input = cardRowToRenderInput(resolved, studio.previousStage, studio.familyName);
  const art = await fetchArt(studio.card);
  const result = await renderCard(input, art, format);
  // Deterministic PDF bytes → stable export-pack checksums (see pdf-normalize).
  if (result.pdf) result.pdf = normalizePdf(result.pdf);
  return { studio, result };
}
