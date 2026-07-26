/**
 * Live catalogue snapshot for the grading pickers.
 *
 * Loads the DB-backed catalogue (the single source of truth managed from
 * Admin → System → Catalogue Manager) and returns it in the SAME shape the
 * canonical pure helpers in shared/pokemon-rarity-catalogue.ts consume. The seed
 * arrays are the instant placeholder + offline fallback, so a picker renders
 * immediately and never breaks if the API is briefly unavailable.
 *
 * Every picker uses this hook instead of importing the hard-coded arrays.
 */
import { useQuery } from "@tanstack/react-query";
import { SEED_CATALOGUE, type CatalogueSnapshot } from "@shared/pokemon-rarity-catalogue";

interface SnapshotResponse {
  snapshot: CatalogueSnapshot;
  categories: string[];
}

export const CATALOGUE_SNAPSHOT_KEY = "/api/catalogue/snapshot";

export function useCatalogue(): CatalogueSnapshot {
  const { data } = useQuery<SnapshotResponse | null>({
    queryKey: [CATALOGUE_SNAPSHOT_KEY],
    staleTime: 5 * 60 * 1000,
    placeholderData: { snapshot: SEED_CATALOGUE, categories: [] },
  });
  return data?.snapshot ?? SEED_CATALOGUE;
}
