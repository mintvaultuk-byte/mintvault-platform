/**
 * One-image-per-request enforcement (spend-guard Phase 3A, item 1). Pure, no I/O.
 *
 * Every SINGLE-generation Vault Quest route (the main /generate-artwork route and
 * the card-artwork route) must produce exactly one provider output per paid call.
 * Historically these routes never read a `count`/`requestedImages` field from the
 * body at all — so a client-supplied count was already silently ignored, not
 * enforced. This makes that contract EXPLICIT and tested: an absent count still
 * normalizes to 1 (no behaviour change for the existing client), but any present
 * value other than 1 (0, negative, a string, null, 2+) is rejected with a
 * structured 400 BEFORE any spend/reservation/provider work.
 *
 * This does NOT apply to /generate-artwork/batch or the family route — those are
 * separate, already-gated, EXPLICITLY multi-image endpoints (their own `count`/
 * per-character-loop is the intentional design, not a violation of "one image per
 * [single-image] request").
 */
export interface ImageCountValidation {
  ok: boolean;
  count: number;
  error?: string;
}

export function validateSingleImageCount(raw: unknown): ImageCountValidation {
  // Only a genuinely ABSENT field normalizes to 1 (the existing client never sends
  // this field at all). An explicit `null` is a malformed/unexpected value from a
  // caller that DID try to say something about count — reject it, don't guess.
  if (raw === undefined) return { ok: true, count: 1 };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, count: 0, error: "Image count must be a whole number." };
  }
  if (n !== 1) {
    return {
      ok: false,
      count: n,
      error: `This route generates exactly 1 image per request — got ${n}. Use the batch endpoint for more than one.`,
    };
  }
  return { ok: true, count: 1 };
}
