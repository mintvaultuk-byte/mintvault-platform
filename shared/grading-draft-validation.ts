import { validateStructuredVariant } from "./structured-variant-validate";
import { isLowerInformationRarityChange, languageLabel, normalizePokemonLanguage } from "./pokemon-rarity-catalogue";

const pick = (a: unknown, b: unknown) => (a === undefined ? (b ?? null) : a);

export class GradeDraftValidationError extends Error {
  status = 400;
}

export function validateGradeDraftIdentityAndVariant(cert: any, body: any): {
  nextLanguage: string | null;
  nextRarityCode: string | null;
  nextFinishVariant: string | null;
  nextPromoType: string | null;
} {
  const nextLanguage =
    body.language === undefined || body.language === null || (typeof body.language === "string" && body.language.trim() === "")
      ? (cert.language ?? null)
      : languageLabel(body.language, "");
  if (body.language !== undefined && !normalizePokemonLanguage(body.language)) {
    throw new GradeDraftValidationError(`Unsupported language: ${body.language}`);
  }
  const nextRarityCode = pick(body.rarity_code, cert.rarityCode) as string | null;
  const nextFinishVariant = pick(body.finish_variant, cert.finishVariant) as string | null;
  const nextPromoType = pick(body.promo_type, cert.promoType) as string | null;
  const structured = validateStructuredVariant({
    rarityCode: nextRarityCode,
    finishVariant: nextFinishVariant,
    promoType: nextPromoType,
    language: nextLanguage,
    era: pick(body.era, cert.era) as string | null,
    legacyVariant: pick(body.variant, cert.variant) as string | null,
  });
  if (!structured.ok) {
    throw new GradeDraftValidationError(structured.errors.join(" "));
  }
  if (
    body.rarity_code !== undefined &&
    isLowerInformationRarityChange(cert.rarityCode, body.rarity_code) &&
    body.rarity_override_confirmed !== true &&
    body.rarity_override_confirmed !== "true"
  ) {
    throw new GradeDraftValidationError("Rarity override requires explicit confirmation.");
  }
  return { nextLanguage, nextRarityCode, nextFinishVariant, nextPromoType };
}
