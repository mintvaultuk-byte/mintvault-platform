/**
 * Server-side glue for the structured Pokémon rarity/variant columns.
 *
 * The client picker posts a proposed selection alongside the normal certificate
 * form. This validates it AUTHORITATIVELY (unknown codes / bad enums → reject),
 * derives the symbol/colour/count/region from the catalogue (never trusting the
 * client), and merges the resulting nullable-column values into the route's
 * insert/update `data` object. The legacy `variant`/`rarity` columns are never
 * read or written here.
 *
 * Opt-in by presence: if the request carries NONE of the structured keys, the
 * columns are left completely untouched (a partial PUT can never erase them).
 */
import {
  validateStructuredVariant,
  structuredColumnsToCertFields,
} from "@shared/structured-variant-validate";
import type { CatalogueSnapshot } from "@shared/pokemon-rarity-catalogue";

const STRUCTURED_KEYS = ["rarityCode", "finishVariant", "promoType", "subsetName", "era"] as const;

export interface StructuredApplyResult {
  ok: boolean;
  /** Hard errors — the route must return 400 without writing. */
  errors: string[];
  /** Soft advisories (unsupported era/region, long combo, ambiguous legacy). */
  warnings: string[];
  /** Whether the request opted into structured fields at all. */
  applied: boolean;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  return v == null ? null : String(v);
}

/**
 * Validate + merge structured columns into `data` when the request opts in.
 * Mutates `data` in place with the derived column values. Returns ok:false with
 * errors when the selection is invalid (route should 400 and not persist).
 */
export function applyStructuredVariantFromBody(
  body: Record<string, unknown>,
  data: Record<string, unknown>,
  cat?: CatalogueSnapshot,
): StructuredApplyResult {
  const optedIn = STRUCTURED_KEYS.some((k) => k in body);
  if (!optedIn) return { ok: true, errors: [], warnings: [], applied: false };

  const result = validateStructuredVariant(
    {
      rarityCode: str(body.rarityCode),
      finishVariant: str(body.finishVariant),
      promoType: str(body.promoType),
      subsetName: str(body.subsetName),
      language: str(body.language),
      era: str(body.era),
      legacyVariant: str(body.variant),
    },
    cat,
  );

  if (!result.ok) {
    return { ok: false, errors: result.errors, warnings: result.warnings, applied: true };
  }
  Object.assign(data, structuredColumnsToCertFields(result.columns));
  return { ok: true, errors: [], warnings: result.warnings, applied: true };
}
