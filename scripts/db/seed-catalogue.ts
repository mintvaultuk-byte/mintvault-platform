/**
 * Seed the catalogue_items table from the canonical arrays in
 * shared/pokemon-rarity-catalogue.ts (the single source — NOT re-typed here) plus
 * the extra examples from the Catalogue Manager brief (designations).
 *
 * Idempotent: by default inserts only missing (category, value) rows and NEVER
 * clobbers founder edits (ON CONFLICT DO NOTHING). Pass --update to also refresh
 * label/aliases/description/metadata from the seed for existing rows.
 *
 *   npm run db:migrate -- --apply   # apply 0019 first (creates the table) — OWNER-GATED
 *   npx tsx scripts/db/seed-catalogue.ts           # insert-only seed  — OWNER-GATED (writes DB)
 *   npx tsx scripts/db/seed-catalogue.ts --update   # + refresh existing rows from seed
 *
 * WRITES to the database → a protected action; runs only with owner approval,
 * against the STAGING branch (local .env). Never re-types catalogue data.
 */
import { db } from "../../server/db";
import { catalogueItems } from "@shared/schema";
import {
  POKEMON_RARITIES,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  POKEMON_LANGUAGES,
  POKEMON_ERAS,
} from "@shared/pokemon-rarity-catalogue";

interface SeedRow {
  category: string;
  value: string;
  label: string;
  abbreviation?: string | null;
  aliases: string[];
  description: string;
  metadata: Record<string, unknown>;
  sortOrder: number;
  allowCrossCategory?: boolean;
}

function buildSeedRows(): SeedRow[] {
  const rows: SeedRow[] = [];

  POKEMON_RARITIES.forEach((r, i) =>
    rows.push({
      category: "rarity",
      value: r.value,
      label: r.label,
      abbreviation: r.codes[0] ?? null,
      aliases: [...r.aliases],
      description: r.description,
      metadata: { symbol: r.symbol, codes: r.codes, regions: r.regions, eras: r.eras },
      sortOrder: i,
    }),
  );

  POKEMON_FINISHES.forEach((f, i) =>
    rows.push({
      category: "finish",
      value: f.value,
      label: f.label,
      aliases: [...f.aliases],
      description: f.description,
      metadata: {},
      sortOrder: i,
    }),
  );

  POKEMON_PROMOS.forEach((p, i) =>
    rows.push({
      category: p.kind === "subset" ? "subset" : "promo",
      value: p.value,
      label: p.label,
      aliases: [...p.aliases],
      description: p.description,
      metadata: { kind: p.kind },
      sortOrder: i,
    }),
  );

  POKEMON_LANGUAGES.forEach((l, i) =>
    rows.push({
      category: "language",
      value: l.value,
      label: l.label,
      aliases: [...l.aliases],
      description: "",
      metadata: { region: l.region },
      sortOrder: i,
    }),
  );

  POKEMON_ERAS.forEach((e, i) =>
    rows.push({
      category: "era",
      value: String(e.value),
      label: e.label,
      aliases: [],
      description: "",
      metadata: {},
      sortOrder: i,
    }),
  );

  // Designations — brief examples. unlimited/first_edition/shadowless also exist
  // as Finishes today, so they are marked allow-cross-category (one-classification
  // guard permits the deliberate overlap). error/misprint/test_print are new.
  const designations: Array<{ value: string; label: string; aliases: string[]; cross?: boolean }> = [
    { value: "unlimited", label: "Unlimited", aliases: ["unlimited", "unlimited print"], cross: true },
    { value: "first_edition", label: "1st Edition", aliases: ["1st edition", "first edition", "1st ed"], cross: true },
    { value: "shadowless", label: "Shadowless", aliases: ["shadowless"], cross: true },
    { value: "error", label: "Error", aliases: ["error", "error card"] },
    { value: "misprint", label: "Misprint", aliases: ["misprint", "mis-print"] },
    { value: "test_print", label: "Test Print", aliases: ["test print", "test-print"] },
  ];
  designations.forEach((d, i) =>
    rows.push({
      category: "designation",
      value: d.value,
      label: d.label,
      aliases: d.aliases,
      description: "",
      metadata: {},
      sortOrder: i,
      allowCrossCategory: Boolean(d.cross),
    }),
  );

  return rows;
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const rows = buildSeedRows();
  let inserted = 0;
  let refreshed = 0;
  let skipped = 0;

  for (const row of rows) {
    const values = {
      ...row,
      allowCrossCategory: row.allowCrossCategory ?? false,
      createdBy: "seed",
      updatedBy: "seed",
    };
    if (update) {
      const res = await db
        .insert(catalogueItems)
        .values(values)
        .onConflictDoUpdate({
          target: [catalogueItems.category, catalogueItems.value],
          set: {
            label: row.label,
            abbreviation: row.abbreviation ?? null,
            aliases: row.aliases,
            description: row.description,
            metadata: row.metadata,
            allowCrossCategory: values.allowCrossCategory,
            updatedBy: "seed",
            updatedAt: new Date(),
          },
        })
        .returning({ id: catalogueItems.id });
      if (res.length) refreshed++;
    } else {
      const res = await db
        .insert(catalogueItems)
        .values(values)
        .onConflictDoNothing({ target: [catalogueItems.category, catalogueItems.value] })
        .returning({ id: catalogueItems.id });
      if (res.length) inserted++;
      else skipped++;
    }
  }

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[seed-catalogue] ${rows.length} seed rows:`, counts);
  console.log(
    update
      ? `[seed-catalogue] upserted (refreshed existing): ${refreshed}`
      : `[seed-catalogue] inserted new: ${inserted}, skipped existing: ${skipped}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-catalogue] failed:", err);
  process.exit(1);
});
