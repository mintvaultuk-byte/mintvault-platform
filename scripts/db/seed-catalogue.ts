/**
 * Seed the catalogue_items table from the canonical arrays in
 * shared/pokemon-rarity-catalogue.ts (the single source — NOT re-typed here) plus
 * the extra examples from the Catalogue Manager brief (designations).
 *
 * Idempotent: by default inserts only missing (category, value) rows and NEVER
 * clobbers founder edits (ON CONFLICT DO NOTHING). Pass --update to also refresh
 * label/aliases/description/metadata from the seed for existing rows.
 *
 *   npm run db:migrate               # DRY-RUN first: confirm `pending` lists ONLY
 *                                    # 0019_catalogue_manager.sql (the runner applies
 *                                    # ALL pending numbered migrations, not just 0019 —
 *                                    # 0017/0018 may ride along; reconcile deliberately).
 *   npm run db:migrate -- --apply    # apply pending (creates the table) — OWNER-GATED
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

  // These finish values ALSO exist as designations (edition marks). Both sides
  // must opt into allowCrossCategory for the one-classification-only rule.
  const CROSS_FINISHES = new Set(["first_edition", "unlimited", "shadowless"]);
  POKEMON_FINISHES.forEach((f, i) =>
    rows.push({
      category: "finish",
      value: f.value,
      label: f.label,
      aliases: [...f.aliases],
      description: f.description,
      metadata: {},
      sortOrder: i,
      allowCrossCategory: CROSS_FINISHES.has(f.value),
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
  // guard permits the deliberate overlap).
  //
  // TEST-ONLY VALUES ARE NOT SEEDED (hostile-review cleanup). An earlier draft
  // seeded a "Test Print" designation; it is not one of the historical persisted
  // codes, nothing in the app references it, and production seed output must not
  // carry test-shaped entries. The catalogue is owner-editable by design, so a
  // genuine Test Print designation can be added through the Catalogue Manager
  // without a code change.
  // `abbreviation` is the PERSISTED designation code. It MUST stay equal to the
  // historical hard-coded code (POKEMON_DESIGNATIONS) for every designation that
  // already exists on certificates — the snapshot mapper reads
  // `abbreviation || value`, so omitting it here would hand the pickers a new
  // code (e.g. "first_edition" instead of "FIRST_EDITION") and orphan every
  // stored value. Rows without a legacy equivalent are new and carry their own.
  const designations: Array<{ value: string; code: string; label: string; aliases: string[]; cross?: boolean }> = [
    { value: "promo", code: "PROMO", label: "Promo", aliases: ["promo", "promotional"] },
    { value: "tournament_stamp", code: "TOURNAMENT_STAMP", label: "Tournament / Event Stamp", aliases: ["tournament stamp", "event stamp"] },
    { value: "prerelease", code: "PRERELEASE", label: "Prerelease", aliases: ["prerelease", "pre-release"] },
    { value: "staff", code: "STAFF", label: "Staff", aliases: ["staff", "staff stamp"] },
    { value: "error_miscut", code: "ERROR_MISCUT", label: "Error / Miscut / Misprint", aliases: ["error", "miscut", "misprint", "mis-print", "error card"] },
    { value: "first_edition", code: "FIRST_EDITION", label: "1st Edition", aliases: ["1st edition", "first edition", "1st ed"], cross: true },
    { value: "shadowless", code: "SHADOWLESS", label: "Shadowless", aliases: ["shadowless"], cross: true },
    { value: "unlimited", code: "UNLIMITED", label: "Unlimited", aliases: ["unlimited", "unlimited print"], cross: true },
    { value: "japanese_print", code: "JAPANESE_PRINT", label: "Japanese Print", aliases: ["japanese print", "japanese"] },
    { value: "other_language", code: "OTHER_LANGUAGE", label: "Other Language", aliases: ["other language"] },
  ];
  designations.forEach((d, i) =>
    rows.push({
      category: "designation",
      value: d.value,
      label: d.label,
      abbreviation: d.code,
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
