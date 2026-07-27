/**
 * catalogue-abbreviation-unique-migration.test.ts — DB-backed.
 *
 * Applies the REAL migrations/0026_catalogue_abbreviation_unique.sql (and its
 * rollback) against a disposable PostgreSQL 17 cluster. Proves the persisted-code
 * uniqueness rule the hostile review asked for, that it is additive, that it
 * fails LOUDLY on incompatible pre-existing data instead of with a bare index
 * error, and that it is fully reversible. Never touches staging or production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const { Pool } = pg;

let cluster: DisposablePostgres17 | null = null;
let pool: pg.Pool | null = null;

const readSql = (name: string) => fs.readFileSync(path.resolve(process.cwd(), "migrations", name), "utf8");
const MIGRATION = readSql("0026_catalogue_abbreviation_unique.sql");
const ROLLBACK = readSql("rollback-0026-catalogue-abbreviation-unique.sql");
/** 0019 creates the table this migration indexes. */
const CREATE_0019 = readSql("0019_catalogue_manager.sql");

const q = async (text: string, params: unknown[] = []) => (await pool!.query(text, params)).rows;

const insert = (row: {
  category: string;
  value: string;
  label?: string;
  abbreviation?: string | null;
  active?: boolean;
  archived?: boolean;
}) =>
  q(
    `INSERT INTO catalogue_items (category, value, label, abbreviation, active, archived)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      row.category,
      row.value,
      row.label ?? row.value,
      row.abbreviation ?? null,
      row.active ?? true,
      row.archived ?? false,
    ],
  );

beforeAll(async () => {
  cluster = await startPostgres17("catalogue-abbr-unique");
  pool = new Pool({ connectionString: cluster.url, max: 4 });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

beforeEach(async () => {
  await q("DROP TABLE IF EXISTS catalogue_items CASCADE");
  await pool!.query(CREATE_0019);
});

describe("0026 — catalogue persisted-code uniqueness (real migration, real PostgreSQL)", () => {
  it("applies cleanly on an empty catalogue and creates exactly one new index", async () => {
    const before = await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'catalogue_items'`);
    await pool!.query(MIGRATION);
    const after = await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'catalogue_items'`);
    expect(after.length).toBe(before.length + 1);
    expect(after.map((r) => r.indexname)).toContain("uq_catalogue_items_live_effective_code");
  });

  it("is ADDITIVE — it creates/alters/drops no table or column", () => {
    expect(MIGRATION).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(MIGRATION).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(MIGRATION).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(MIGRATION).not.toMatch(/\bDELETE\s+FROM\b|\bUPDATE\s+catalogue_items\b/i);
  });

  it("BLOCKS a duplicate persisted code where one row's abbreviation equals another's value", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "first_edition", abbreviation: "FIRST_EDITION" });
    // A second row whose VALUE collides with the first row's ABBREVIATION.
    await expect(insert({ category: "designation", value: "FIRST_EDITION" })).rejects.toThrow(
      /uq_catalogue_items_live_effective_code|duplicate key/i,
    );
  });

  it("BLOCKS two rows with the same abbreviation in one category", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "promo_a", abbreviation: "PROMO" });
    await expect(insert({ category: "designation", value: "promo_b", abbreviation: "PROMO" })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("is case-insensitive on the persisted code", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "staff", abbreviation: "STAFF" });
    await expect(insert({ category: "designation", value: "other", abbreviation: "staff" })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("ALLOWS the same code in DIFFERENT categories (cross-category is a separate rule)", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "unlimited", abbreviation: "UNLIMITED" });
    await expect(insert({ category: "finish", value: "unlimited", abbreviation: "UNLIMITED" })).resolves.toBeDefined();
  });

  it("M-2 POLICY: a retired row keeps its code and a live replacement may reuse it", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "old", abbreviation: "PROMO", archived: true });
    await insert({ category: "designation", value: "older", abbreviation: "PROMO", active: false });
    // The live replacement is still permitted.
    await expect(insert({ category: "designation", value: "new", abbreviation: "PROMO" })).resolves.toBeDefined();
  });

  it("fails LOUDLY, naming the offending codes, when pre-existing data is incompatible", async () => {
    // Seed a collision BEFORE the index exists — the 0019 (category,value) index
    // permits it, which is exactly the gap this migration closes.
    await insert({ category: "designation", value: "promo_a", abbreviation: "PROMO" });
    await insert({ category: "designation", value: "promo_b", abbreviation: "PROMO" });
    await expect(pool!.query(MIGRATION)).rejects.toThrow(/0026 BLOCKED[\s\S]*designation\+attribute\/promo/i);
    // And it left NO half-built index behind.
    const idx = await q(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'uq_catalogue_items_live_effective_code'`,
    );
    expect(idx).toHaveLength(0);
  });

  it("existing valid seed-shaped data applies without reconciliation", async () => {
    // The shipped seeder's designation rows, which all carry distinct codes.
    for (const [value, abbr] of [
      ["promo", "PROMO"],
      ["tournament_stamp", "TOURNAMENT_STAMP"],
      ["prerelease", "PRERELEASE"],
      ["staff", "STAFF"],
      ["error_miscut", "ERROR_MISCUT"],
      ["first_edition", "FIRST_EDITION"],
      ["shadowless", "SHADOWLESS"],
      ["unlimited", "UNLIMITED"],
      ["japanese_print", "JAPANESE_PRINT"],
      ["other_language", "OTHER_LANGUAGE"],
    ]) {
      await insert({ category: "designation", value, abbreviation: abbr });
    }
    await expect(pool!.query(MIGRATION)).resolves.toBeDefined();
  });

  it("is fully reversible and re-appliable", async () => {
    await pool!.query(MIGRATION);
    await pool!.query(ROLLBACK);
    expect(
      await q(`SELECT indexname FROM pg_indexes WHERE indexname = 'uq_catalogue_items_live_effective_code'`),
    ).toHaveLength(0);
    // After rollback the previously-blocked insert is possible again...
    await insert({ category: "designation", value: "promo_a", abbreviation: "PROMO" });
    await insert({ category: "designation", value: "promo_b", abbreviation: "PROMO" });
    // ...and re-applying now correctly refuses, naming the data to reconcile.
    await expect(pool!.query(MIGRATION)).rejects.toThrow(/0026 BLOCKED/);
  });

  it("M-3: designation and attribute SHARE one persisted-code namespace", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "promo_d", abbreviation: "PROMO" });
    // Both categories write into certificates.designations, so the same code in
    // the other category would be indistinguishable once stored.
    await expect(insert({ category: "attribute", value: "promo_a", abbreviation: "PROMO" })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("M-3: different codes across designation/attribute are allowed", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "promo", abbreviation: "PROMO" });
    await expect(insert({ category: "attribute", value: "signed", abbreviation: "SIGNED" })).resolves.toBeDefined();
  });

  it("M-3: the shared namespace does NOT bleed into unrelated categories", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "holo", abbreviation: "HOLO" });
    // finish is its own namespace — the same code is fine there.
    await expect(insert({ category: "finish", value: "holo2", abbreviation: "HOLO" })).resolves.toBeDefined();
  });

  it("M-2: an ARCHIVED row in the shared namespace does not block a live replacement", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "attribute", value: "old_promo", abbreviation: "PROMO", archived: true });
    await expect(insert({ category: "designation", value: "promo", abbreviation: "PROMO" })).resolves.toBeDefined();
  });

  it("M-2: REACTIVATING an archived duplicate fails at the database too", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "retired", abbreviation: "PROMO", archived: true });
    await insert({ category: "designation", value: "live_one", abbreviation: "PROMO" });
    // Restoring the retired row would create two LIVE rows with code PROMO.
    await expect(
      q(`UPDATE catalogue_items SET archived = FALSE WHERE value = 'retired'`),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("is idempotent — re-running the migration is a no-op", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "promo", abbreviation: "PROMO" });
    await expect(pool!.query(MIGRATION)).resolves.toBeDefined();
    const idx = await q(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'uq_catalogue_items_live_effective_code'`,
    );
    expect(idx).toHaveLength(1);
  });

  it("is a truthful NO-OP when catalogue_items does not exist (0019 not applied)", async () => {
    await q("DROP TABLE IF EXISTS catalogue_items CASCADE");
    // The guard must not be followed by a statement that fails anyway.
    await expect(pool!.query(MIGRATION)).resolves.toBeDefined();
    expect(
      await q(`SELECT indexname FROM pg_indexes WHERE indexname = 'uq_catalogue_items_live_effective_code'`),
    ).toHaveLength(0);
  });

  it("does not touch 0019 — that migration is already applied in production", () => {
    // Guard the checksum-safety promise: 0026 must never reference or rewrite 0019.
    expect(MIGRATION).not.toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+uq_catalogue_items_category_value/i);
    expect(CREATE_0019).toContain("uq_catalogue_items_category_value");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-2 (final hostile review) — the rule is scoped to the categories that
// actually persist `abbreviation || value`. An earlier revision applied it to
// every category and aborted against the real staging catalogue.
// ─────────────────────────────────────────────────────────────────────────────

/** The REAL live staging rarity rows that the over-broad rule rejected. */
const STAGING_RARITIES: Array<[string, string]> = [
  ["ace_spec", "ACE"],
  ["jp_ace_spec", "ACE"],
  ["hyper_rare", "HR"],
  ["jp_hyper_rare", "HR"],
  ["rare", "R"],
  ["rare_holo", "R"],
  ["double_rare", "RR"],
  ["jp_double_rare", "RR"],
  ["shiny_rare", "SR"],
  ["jp_super_rare", "SR"],
  ["shiny_ultra_rare", "SSR"],
  ["jp_shiny_super_rare", "SSR"],
  ["ultra_rare", "UR"],
  ["jp_ultra_rare", "UR"],
];

describe("0026 HIGH-2 — scoped to abbreviation-persisting categories", () => {
  it("ACCEPTS the real staging rarity dataset (7 shared abbreviations, 14 rows)", async () => {
    for (const [value, abbr] of STAGING_RARITIES) {
      await insert({ category: "rarity", value, abbreviation: abbr });
    }
    // The forward migration must apply against this data, not abort.
    await expect(pool!.query(MIGRATION)).resolves.toBeDefined();
    expect(
      (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'catalogue_items'`)).map((r) => r.indexname),
    ).toContain("uq_catalogue_items_live_effective_code");
    expect((await q(`SELECT count(*)::int AS n FROM catalogue_items`))[0].n).toBe(14);
  });

  it("still ACCEPTS shared rarity abbreviations AFTER the index exists", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "rarity", value: "hyper_rare", abbreviation: "HR" });
    await expect(insert({ category: "rarity", value: "jp_hyper_rare", abbreviation: "HR" })).resolves.toBeDefined();
  });

  it("leaves every other value-keyed category free to share abbreviations", async () => {
    await pool!.query(MIGRATION);
    for (const category of ["finish", "promo", "subset", "language", "era"]) {
      await insert({ category, value: `${category}_alpha`, abbreviation: "X" });
      await expect(insert({ category, value: `${category}_beta`, abbreviation: "X" })).resolves.toBeDefined();
    }
  });

  it("STILL rejects a genuine designation/attribute collision", async () => {
    await pool!.query(MIGRATION);
    await insert({ category: "designation", value: "promo_a", abbreviation: "PROMO" });
    await expect(insert({ category: "attribute", value: "promo_b", abbreviation: "PROMO" })).rejects.toThrow(
      /uq_catalogue_items_live_effective_code|duplicate key/i,
    );
  });

  it("fails loudly on a designation collision, and NOT on a rarity one", async () => {
    // Rarity duplicates present -> migration must still apply.
    for (const [value, abbr] of STAGING_RARITIES) await insert({ category: "rarity", value, abbreviation: abbr });
    await expect(pool!.query(MIGRATION)).resolves.toBeDefined();

    // A real designation collision -> loud, named failure.
    await q("DROP TABLE IF EXISTS catalogue_items CASCADE");
    await pool!.query(CREATE_0019);
    await insert({ category: "designation", value: "promo_a", abbreviation: "PROMO" });
    await insert({ category: "designation", value: "promo_b", abbreviation: "PROMO" });
    await expect(pool!.query(MIGRATION)).rejects.toThrow(/0026 BLOCKED.*designation\+attribute\/promo/is);
  });

  it("re-running CONVERGES on the scoped index even if the over-broad one exists", async () => {
    // Simulate a cluster where the earlier, over-broad revision was applied.
    await pool!.query(`
      CREATE UNIQUE INDEX uq_catalogue_items_live_effective_code
        ON catalogue_items (
          (CASE WHEN category IN ('designation','attribute') THEN 'designation+attribute' ELSE category END),
          lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value)))
        )
        WHERE active = TRUE AND archived = FALSE
          AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> '';
    `);
    // Under the OLD index these two rarity rows are rejected...
    await insert({ category: "rarity", value: "hyper_rare", abbreviation: "HR" });
    await expect(insert({ category: "rarity", value: "jp_hyper_rare", abbreviation: "HR" })).rejects.toThrow();
    // ...re-running the migration replaces it with the correctly scoped index.
    await pool!.query(MIGRATION);
    await expect(insert({ category: "rarity", value: "jp_hyper_rare", abbreviation: "HR" })).resolves.toBeDefined();
  });

  it("forward, idempotent rerun and rollback all pass with the staging dataset present", async () => {
    for (const [value, abbr] of STAGING_RARITIES) await insert({ category: "rarity", value, abbreviation: abbr });
    await pool!.query(MIGRATION);
    await pool!.query(MIGRATION); // rerun
    expect(
      (await q(`SELECT indexname FROM pg_indexes WHERE tablename='catalogue_items'`))
        .filter((r) => r.indexname === "uq_catalogue_items_live_effective_code").length,
    ).toBe(1);
    await pool!.query(ROLLBACK);
    expect(
      (await q(`SELECT indexname FROM pg_indexes WHERE tablename='catalogue_items'`)).map((r) => r.indexname),
    ).not.toContain("uq_catalogue_items_live_effective_code");
    expect((await q(`SELECT count(*)::int AS n FROM catalogue_items`))[0].n).toBe(14); // no row rewritten
  });
});
