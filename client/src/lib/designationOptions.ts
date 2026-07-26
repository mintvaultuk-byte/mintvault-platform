/**
 * Designation options.
 *
 * The list is now DB-backed via the Catalogue Manager (`designation` category)
 * and reaches components through `useCatalogue().designations`. This module no
 * longer owns a duplicate copy — it re-exports the canonical seed (which is the
 * offline/placeholder fallback) and a label helper that resolves against a
 * supplied snapshot, defaulting to the seed for legacy callers.
 */
import { POKEMON_DESIGNATIONS, type PokemonDesignation } from "@shared/pokemon-rarity-catalogue";

export type DesignationOption = PokemonDesignation;

/** Seed/fallback only — prefer `useCatalogue().designations` in components. */
export const DESIGNATION_OPTIONS: readonly DesignationOption[] = POKEMON_DESIGNATIONS;

export function getDesignationLabel(
  code: string,
  options: readonly DesignationOption[] = POKEMON_DESIGNATIONS
): string {
  const opt = options.find((d) => d.code === code);
  return opt?.label || code;
}
