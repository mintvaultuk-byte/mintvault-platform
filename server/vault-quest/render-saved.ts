/**
 * Shared helpers for rendering a SAVED Vault Quest card (used by the admin routes
 * and the background export/proxy jobs). Kept in one place so the security-critical
 * art-key derivation lives once, and so batch jobs can render a pre-loaded studio
 * payload with NO extra DB round-trip (the N+1 fix).
 */
import { randomUUID } from "node:crypto";
import { getR2Buffer } from "../r2";
import { renderCard, type RenderFormat, type RenderResult } from "./render-service";
import { resolveVariant, cardRowToRenderInput } from "./qa-engine";
import { normalizePdf } from "./pdf-normalize";
import { isCandidateKeyForCard } from "./ai/higgsfield";
import { assertVqWriteKey, assertVqReadKey, VQ_WRITE_PREFIXES } from "./lib/vq-keys";
import type { VqCardRow } from "@shared/vq-schema";

// Re-exported so existing call-sites (workflow-engine, routes/vault-quest-admin)
// keep importing the R2 key-space guards from render-saved. The pure logic now
// lives in ./lib/vq-keys so it is unit-testable without the render engine.
export { assertVqWriteKey, assertVqReadKey, VQ_WRITE_PREFIXES };

/** Deterministic VQ artwork key — derived from the card id, never client-supplied. */
export function vqArtKey(cardId: string, slot: "main" | "prev"): string {
  return `vq/art/${cardId}/${slot}.png`;
}

/** Deterministic Character Bible artwork key. */
export function vqCharacterArtworkKey(characterId: string, kind: "reference" | "approved"): string {
  const safe = characterId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `vq/characters/${safe}/${kind}.png`;
}

const safeCharId = (characterId: string) => characterId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

/** Unique candidate key for a generated Character Bible master-art candidate (gallery keeps many). */
export function vqCharacterCandidateKey(characterId: string): string {
  return `vq/characters/${safeCharId(characterId)}/candidates/${Date.now()}-${randomUUID()}.png`;
}

/** Approved Character Bible reference artwork — one canonical image per Reference Pack type. */
export function vqCharacterApprovedKey(characterId: string, referenceType = "master_portrait"): string {
  const safeType = referenceType.replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return `vq/characters/${safeCharId(characterId)}/approved/${safeType}.png`;
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
      ? getR2Buffer(assertVqReadKey(mainCandidate))
      : input.artR2Key ? getR2Buffer(assertVqReadKey(vqArtKey(cardId, "main"))) : Promise.resolve(null),
    prevCandidate && isCandidateKeyForCard(prevCandidate, cardId)
      ? getR2Buffer(assertVqReadKey(prevCandidate))
      : input.prevArtR2Key ? getR2Buffer(assertVqReadKey(vqArtKey(cardId, "prev"))) : Promise.resolve(null),
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
