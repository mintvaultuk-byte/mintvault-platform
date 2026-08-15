/**
 * OWNER REQUIREMENT — "rarity / finish / variant selections must actually persist".
 *
 * Every other classification test in this repo is component- or unit-level: they prove
 * the picker emits the right value and the form carries it, but none of them writes a
 * row and reads it back. This one exercises the REAL server write/read path
 * (storage.updateCertificate / storage.getCertificate) against a REAL disposable
 * PostgreSQL cluster, then re-asserts the raw column contents over an INDEPENDENT pg
 * connection, so a passing ORM cache can never be mistaken for a persisted row.
 *
 * Every value is asserted to exist in the canonical catalogue BEFORE it is written, so
 * this test can never go green against an invented rarity the picker would refuse.
 *
 * Gated on TEST_DATABASE_URL (the repository convention for DB-backed suites) and runs
 * ONLY against a local throwaway database. Anywhere else it skips — but the skip is
 * declared, never silent: see the always-on guard below.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mintvault_test npx vitest run \
 *     tests/grading-classification-persistence.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { POKEMON_RARITIES, POKEMON_FINISHES } from "@shared/pokemon-rarity-catalogue";

const TEST_URL = process.env.TEST_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL || "";

function isLocalThrowaway(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

const isLocal = isLocalThrowaway(TEST_URL);

describe("classification persistence proof — run conditions", () => {
  it("is never silently skipped: it runs on a local throwaway DB or declares why not", () => {
    if (!isLocal) {
      console.warn(
        "[grading-classification-persistence] SKIPPED: no local throwaway database. Run with " +
          "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/<db> to execute the real round trip."
      );
    }
    // A remote/absent URL is a legitimate reason to skip; a malformed one is not.
    expect(TEST_URL === "" || isLocal || /^postgres/.test(TEST_URL)).toBe(true);
  });
});

const describeDb = isLocal ? describe : describe.skip;

const rarityValues = new Set(POKEMON_RARITIES.map((r) => r.value));
const finishValues = new Set(POKEMON_FINISHES.map((f) => f.value));

const PROBE = "MV-CLASSIFICATION-PERSIST-PROBE";

let pool: Pool;
let storage: typeof import("../server/storage").storage;
let certRowId: number;

beforeAll(async () => {
  if (!isLocal) return;
  // The storage layer resolves its connection from MINTVAULT_DATABASE_URL. Bind it to the
  // SAME local throwaway URL before the module is imported, so the real write path and the
  // independent verification connection can never address different databases.
  process.env.MINTVAULT_DATABASE_URL = TEST_URL;
  pool = new Pool({ connectionString: TEST_URL, ssl: false, max: 2 });
  ({ storage } = await import("../server/storage"));
  await pool.query(`DELETE FROM certificates WHERE certificate_number = $1`, [PROBE]);
  const inserted = await pool.query(
    `INSERT INTO certificates (certificate_number, card_name, grade_type, grade)
     VALUES ($1, 'Persistence Probe', 'numeric', '9') RETURNING id`,
    [PROBE]
  );
  certRowId = inserted.rows[0].id;
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM certificates WHERE certificate_number = $1`, [PROBE]);
  await pool.end();
});

/** Raw column read on an independent connection — never the ORM's return value. */
async function rawRow(): Promise<Record<string, unknown>> {
  const res = await pool.query(
    `SELECT rarity_code, finish_variant, promo_type, subset_name, rarity, language
     FROM certificates WHERE id = $1`,
    [certRowId]
  );
  return res.rows[0];
}

/** The real save path, then the real reload path. */
async function saveAndReload(patch: Record<string, unknown>) {
  await storage.updateCertificate(certRowId, patch as never);
  const reloaded = await storage.getCertificate(certRowId);
  const raw = await rawRow();
  return { reloaded, raw };
}

describeDb("classification persists through the REAL save → DB → reload path", () => {
  it("rarity unset → select Rare → saved, in the DB, and still selected after reload", async () => {
    expect(rarityValues.has("rare")).toBe(true);
    expect((await rawRow()).rarity_code).toBeNull();

    const { reloaded, raw } = await saveAndReload({ rarityCode: "rare" });
    expect(raw.rarity_code).toBe("rare");
    expect(reloaded?.rarityCode).toBe("rare");
  });

  it("changing to another supported rarity replaces the first and persists", async () => {
    const { reloaded, raw } = await saveAndReload({ rarityCode: "double_rare" });
    expect(raw.rarity_code).toBe("double_rare");
    expect(reloaded?.rarityCode).toBe("double_rare");
  });

  // Each tier is asserted to exist in the catalogue BEFORE it is written, so a renamed or
  // removed value fails loudly instead of silently persisting junk.
  const REQUIRED_RARITIES = [
    "rare",
    "double_rare",
    "illustration_rare",
    "ultra_rare",
    "special_illustration_rare",
    "hyper_rare",
    "ace_spec",
  ];

  it.each(REQUIRED_RARITIES)("required rarity %s exists in the catalogue and survives a round trip", async (value) => {
    expect(rarityValues.has(value)).toBe(true);
    const { reloaded, raw } = await saveAndReload({ rarityCode: value });
    expect(raw.rarity_code).toBe(value);
    expect(reloaded?.rarityCode).toBe(value);
  });

  it("'Holo Rare' is a rarity PLUS a separate finish, and both persist together", async () => {
    // The catalogue tracks the holo FINISH separately from the rare CLASS.
    expect(rarityValues.has("rare_holo")).toBe(true);
    expect(finishValues.has("holo")).toBe(true);
    const { reloaded, raw } = await saveAndReload({ rarityCode: "rare_holo", finishVariant: "holo" });
    expect(raw.rarity_code).toBe("rare_holo");
    expect(raw.finish_variant).toBe("holo");
    expect(reloaded?.rarityCode).toBe("rare_holo");
    expect(reloaded?.finishVariant).toBe("holo");
  });

  it("'Silver Star' IS a real structured rarity (silver_star_rare) and persists", async () => {
    expect(rarityValues.has("silver_star_rare")).toBe(true);
    const { reloaded, raw } = await saveAndReload({ rarityCode: "silver_star_rare" });
    expect(raw.rarity_code).toBe("silver_star_rare");
    expect(reloaded?.rarityCode).toBe("silver_star_rare");
  });

  it("'Gold Star' is NOT a structured rarity — it is carried by the LEGACY rarity field", async () => {
    // Documents the real asymmetry between the two rarity systems so nobody "fixes" this
    // by inventing a structured gold_star value.
    expect([...rarityValues].some((v) => v.includes("gold"))).toBe(false);
    const { reloaded, raw } = await saveAndReload({ rarity: "GOLD_STAR" });
    expect(raw.rarity).toBe("GOLD_STAR");
    expect(reloaded?.rarity).toBe("GOLD_STAR");
  });
});

describeDb("finish and clear persist independently of rarity", () => {
  it("Holo persists", async () => {
    expect(finishValues.has("holo")).toBe(true);
    const { reloaded, raw } = await saveAndReload({ finishVariant: "holo" });
    expect(raw.finish_variant).toBe("holo");
    expect(reloaded?.finishVariant).toBe("holo");
  });

  it("Reverse Holo persists", async () => {
    expect(finishValues.has("reverse_holo")).toBe(true);
    const { reloaded, raw } = await saveAndReload({ finishVariant: "reverse_holo" });
    expect(raw.finish_variant).toBe("reverse_holo");
    expect(reloaded?.finishVariant).toBe("reverse_holo");
  });

  it("clearing the finish persists as NULL and does NOT disturb the rarity", async () => {
    await saveAndReload({ rarityCode: "rare", finishVariant: "holo" });
    const { reloaded, raw } = await saveAndReload({ finishVariant: null });
    expect(raw.finish_variant).toBeNull();
    expect(raw.rarity_code).toBe("rare");
    expect(reloaded?.finishVariant).toBeNull();
    expect(reloaded?.rarityCode).toBe("rare");
  });

  it("clearing the rarity persists as NULL and does NOT disturb the finish", async () => {
    await saveAndReload({ rarityCode: "rare", finishVariant: "reverse_holo" });
    const { reloaded, raw } = await saveAndReload({ rarityCode: null });
    expect(raw.rarity_code).toBeNull();
    expect(raw.finish_variant).toBe("reverse_holo");
    expect(reloaded?.rarityCode).toBeNull();
    expect(reloaded?.finishVariant).toBe("reverse_holo");
  });

  it("a promo/subset value persists alongside rarity and finish", async () => {
    const { reloaded, raw } = await saveAndReload({
      rarityCode: "rare",
      finishVariant: "holo",
      promoType: "mcdonalds",
      subsetName: "Trainer Gallery",
    });
    expect(raw.promo_type).toBe("mcdonalds");
    expect(raw.subset_name).toBe("Trainer Gallery");
    expect(raw.rarity_code).toBe("rare");
    expect(raw.finish_variant).toBe("holo");
    expect(reloaded?.promoType).toBe("mcdonalds");
    expect(reloaded?.subsetName).toBe("Trainer Gallery");
  });
});
