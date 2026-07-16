/**
 * Structured rarity migration — hermetic integration test.
 *
 * Runs the REAL migrations/add-structured-rarity-columns.sql (and its rollback)
 * inside a throwaway schema of the local disposable Postgres, exactly like
 * tests/auth-security-migration.test.ts. Proves: additive apply, all-nullable
 * columns, legacy `variant` untouched, bounded CHECK constraints, review-queue
 * defaults + uniqueness, and full reversibility. Never touches public / prod.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

function assertLocalTestDb(url: string): void {
  if (!url) throw new Error("TEST_DATABASE_URL is required for the structured rarity migration test");
  const parsed = new URL(url);
  const ok =
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === "55432" &&
    parsed.pathname.includes("mintvault_vq_phase10_local");
  if (!ok) {
    throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${parsed.hostname}:${parsed.port}${parsed.pathname}`);
  }
}

const readSql = (name: string): string => fs.readFileSync(path.resolve(process.cwd(), "migrations", name), "utf8");

const NEW_COLS = [
  "rarity_code",
  "rarity_label",
  "printed_symbol",
  "printed_symbol_count",
  "printed_symbol_colour",
  "finish_variant",
  "promo_type",
  "subset_name",
  "region",
  "era",
  "structured_variant_version",
];

describe("structured rarity migration (hermetic)", () => {
  let pool: Pool;
  const schema = `rarity_mig_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const forward = readSql("add-structured-rarity-columns.sql");
  const rollback = readSql("rollback-structured-rarity-columns.sql");

  beforeAll(async () => {
    assertLocalTestDb(TEST_URL);
    pool = new Pool({ connectionString: TEST_URL, ssl: false, max: 2 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    // Minimal LEGACY certificates table — the source-of-truth columns only.
    await pool.query(
      `SET search_path TO ${schema};
       CREATE TABLE certificates (
         id serial PRIMARY KEY,
         certificate_number text,
         variant text,
         variant_other text,
         rarity text,
         language text DEFAULT 'English'
       )`,
    );
    await pool.query(
      `INSERT INTO ${schema}.certificates (certificate_number, variant, rarity, language)
       VALUES ('MV-T1', 'REVERSE_HOLO', 'R', 'English')`,
    );
    // Apply the real forward migration (whole file, search_path first).
    await pool.query(`SET search_path TO ${schema};\n` + forward);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });

  it("applies cleanly and adds all 11 structured columns as NULLABLE with no default", async () => {
    const cols = await pool.query(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'certificates'`,
      [schema],
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
    for (const c of NEW_COLS) {
      expect(byName.has(c)).toBe(true);
      expect(byName.get(c)!.is_nullable).toBe("YES");
      expect(byName.get(c)!.column_default).toBeNull();
    }
  });

  it("leaves the legacy variant/rarity/language exactly as they were", async () => {
    const row = await pool.query(
      `SELECT variant, rarity, language FROM ${schema}.certificates WHERE certificate_number = 'MV-T1'`,
    );
    expect(row.rows[0]).toMatchObject({ variant: "REVERSE_HOLO", rarity: "R", language: "English" });
  });

  it("keeps the existing row valid and inserts a new row with all structured columns NULL", async () => {
    await pool.query(`INSERT INTO ${schema}.certificates (certificate_number, variant) VALUES ('MV-T2', 'HOLO')`);
    const row = await pool.query(
      `SELECT rarity_code, region, era, printed_symbol_count, structured_variant_version
       FROM ${schema}.certificates WHERE certificate_number = 'MV-T2'`,
    );
    expect(row.rows[0]).toEqual({
      rarity_code: null,
      region: null,
      era: null,
      printed_symbol_count: null,
      structured_variant_version: null,
    });
  });

  it("accepts valid structured values", async () => {
    await pool.query(
      `INSERT INTO ${schema}.certificates
         (certificate_number, rarity_code, printed_symbol_colour, printed_symbol_count, region, era, structured_variant_version)
       VALUES ('MV-T3', 'special_illustration_rare', 'gold', 2, 'japan', 'sv', 1)`,
    );
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM ${schema}.certificates WHERE certificate_number = 'MV-T3'`);
    expect(n.rows[0].n).toBe(1);
  });

  it.each([
    ["printed_symbol_colour", "'purple'"],
    ["region", "'mars'"],
    ["era", "'kanto'"],
    ["printed_symbol_count", "7"],
    ["printed_symbol_count", "0"],
    ["structured_variant_version", "0"],
  ])("rejects invalid %s = %s via CHECK constraint", async (col, val) => {
    await expect(
      pool.query(`INSERT INTO ${schema}.certificates (certificate_number, ${col}) VALUES ('MV-BAD', ${val})`),
    ).rejects.toThrow();
  });

  it("creates the review queue with pending default, review flag, and a status CHECK", async () => {
    await pool.query(`INSERT INTO ${schema}.rarity_mapping_reviews (legacy_value) VALUES ('REVERSE_HOLO')`);
    const row = await pool.query(
      `SELECT status, review_required, record_count FROM ${schema}.rarity_mapping_reviews WHERE legacy_value = 'REVERSE_HOLO'`,
    );
    expect(row.rows[0]).toMatchObject({ status: "pending", review_required: true, record_count: 0 });
    await expect(
      pool.query(`INSERT INTO ${schema}.rarity_mapping_reviews (legacy_value, status) VALUES ('X', 'bogus')`),
    ).rejects.toThrow();
  });

  it("blocks duplicate legacy_value review rows via the unique index", async () => {
    await expect(
      pool.query(`INSERT INTO ${schema}.rarity_mapping_reviews (legacy_value) VALUES ('REVERSE_HOLO')`),
    ).rejects.toThrow();
  });

  it("is fully reversible — rollback drops every new column, constraint and the review table, keeping legacy columns", async () => {
    await pool.query(`SET search_path TO ${schema};\n` + rollback);
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'certificates'`,
      [schema],
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const c of NEW_COLS) expect(names).not.toContain(c);
    expect(names).toEqual(expect.arrayContaining(["variant", "variant_other", "rarity", "language"]));
    const tbl = await pool.query(`SELECT to_regclass($1) AS t`, [`${schema}.rarity_mapping_reviews`]);
    expect(tbl.rows[0].t).toBeNull();
  });
});
