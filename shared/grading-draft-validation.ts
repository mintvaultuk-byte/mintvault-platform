import { validateStructuredVariant } from "./structured-variant-validate";
import { decideRarityChange, languageLabel, normalizePokemonLanguage } from "./pokemon-rarity-catalogue";

const pick = (a: unknown, b: unknown) => (a === undefined ? (b ?? null) : a);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const first = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) if (has(o, key)) return o[key];
  return undefined;
};
const legacyLanguageKey = (v: unknown) => String(v ?? "").trim().toLowerCase();
const isLegacyAmbiguousLanguage = (v: unknown) => legacyLanguageKey(v) === "chinese";

export class GradeDraftValidationError extends Error {
  status = 400;
}

export function parseRarityOverrideIntent(body: Record<string, unknown>): boolean {
  const raw = body.rarity_override_confirmed;
  if (raw === undefined) return false;
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  throw new GradeDraftValidationError("Malformed rarity override confirmation.");
}

export function validateGradeDraftIdentityAndVariant(cert: any, body: any): {
  nextLanguage: string | null;
  nextRarityCode: string | null;
  nextFinishVariant: string | null;
  nextPromoType: string | null;
} {
  const payload = (body ?? {}) as Record<string, unknown>;
  const languageSubmitted = has(payload, "language");
  const rawLanguage = first(payload, "language");
  let nextLanguage: string | null = cert.language ?? null;
  if (languageSubmitted) {
    const empty = rawLanguage === null || rawLanguage === undefined || (typeof rawLanguage === "string" && rawLanguage.trim() === "");
    if (empty) {
      nextLanguage = null;
    } else {
      const normalized = normalizePokemonLanguage(rawLanguage as string);
      if (!normalized) {
        if (isLegacyAmbiguousLanguage(rawLanguage) && isLegacyAmbiguousLanguage(cert.language)) {
          nextLanguage = cert.language ?? "Chinese";
        } else {
          throw new GradeDraftValidationError(
            isLegacyAmbiguousLanguage(rawLanguage)
              ? "Ambiguous legacy language \"Chinese\" must be explicitly changed to Simplified Chinese or Traditional Chinese."
              : `Unsupported language: ${rawLanguage}`,
          );
        }
      } else {
        nextLanguage = languageLabel(rawLanguage as string, "");
      }
    }
  }
  const rawRarity = first(payload, "rarity_code", "rarityCode");
  const rawFinish = first(payload, "finish_variant", "finishVariant");
  const rawPromo = first(payload, "promo_type", "promoType");
  const rawEra = first(payload, "era");
  const rawVariant = first(payload, "variant");
  const nextRarityCode = pick(rawRarity, cert.rarityCode) as string | null;
  const nextFinishVariant = pick(rawFinish, cert.finishVariant) as string | null;
  const nextPromoType = pick(rawPromo, cert.promoType) as string | null;
  const raritySubmitted = has(payload, "rarity_code") || has(payload, "rarityCode");
  const structuredSubmitted =
    raritySubmitted ||
    has(payload, "finish_variant") ||
    has(payload, "finishVariant") ||
    has(payload, "promo_type") ||
    has(payload, "promoType") ||
    has(payload, "era");
  if (structuredSubmitted) {
    const structuredLanguage = normalizePokemonLanguage(nextLanguage ?? "") ? nextLanguage : null;
    const structured = validateStructuredVariant({
      rarityCode: raritySubmitted ? nextRarityCode : null,
      finishVariant: has(payload, "finish_variant") || has(payload, "finishVariant") ? nextFinishVariant : null,
      promoType: has(payload, "promo_type") || has(payload, "promoType") ? nextPromoType : null,
      language: structuredLanguage,
      era: pick(rawEra, cert.era) as string | null,
      legacyVariant: pick(rawVariant, cert.variant) as string | null,
    });
    if (!structured.ok) {
      throw new GradeDraftValidationError(structured.errors.join(" "));
    }
  }
  const overrideConfirmed = parseRarityOverrideIntent(payload);
  if (raritySubmitted) {
    const decision = decideRarityChange(cert.rarityCode, nextRarityCode);
    if (decision.requiresConfirmation && !overrideConfirmed) {
      throw new GradeDraftValidationError("Rarity override requires explicit confirmation.");
    }
    if (decision.requiresConfirmation && overrideConfirmed) {
      const overrideFrom = String(payload.rarity_override_from ?? "").trim();
      const overrideTo = String(payload.rarity_override_to ?? "").trim();
      if (
        !overrideFrom ||
        !overrideTo ||
        overrideFrom !== String(cert.rarityCode ?? "").trim() ||
        overrideTo !== String(nextRarityCode ?? "").trim()
      ) {
        throw new GradeDraftValidationError("Rarity override confirmation does not match this rarity transition.");
      }
    }
  }
  return { nextLanguage, nextRarityCode, nextFinishVariant, nextPromoType };
}
