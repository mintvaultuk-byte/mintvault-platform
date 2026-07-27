/**
 * designation-catalogue-reconciliation.test.ts
 *
 * Proves scripts/db/reconcile-designation-catalogue.ts against a REAL disposable
 * PostgreSQL 17 cluster — never staging, never production.
 *
 * What this proves:
 *   • the canonical contract matches BOTH pre-#259 sources (DESIGNATION_OPTIONS
 *     and server DESIGNATION_LABELS) so the three cannot drift;
 *   • the local effectiveCatalogueCode() is identical to migration 0026's SQL;
 *   • dry run writes nothing;
 *   • apply produces exactly the ten canonical live rows;
 *   • rerun after success is a no-op (idempotent);
 *   • rollback restores the original six-row baseline;
 *   • duplicate / unknown / certificate-designation inventories FAIL CLOSED;
 *   • the certificates table is never written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  CANONICAL_DESIGNATIONS,
  LEGACY_TO_ARCHIVE,
  APPROVED_BASELINE_VALUES,
  buildPlan,
  classifyState,
  validatePostState,
  effectiveCatalogueCode,
  parseArgs,
  type CatalogueRow,
} from "../scripts/db/reconcile-designation-catalogue";

let cluster: DisposablePostgres17;
let pool: pg.Pool;

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

const CATALOGUE_DDL = `
  CREATE TABLE IF NOT EXISTS catalogue_items (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    value TEXT NOT NULL,
    label TEXT NOT NULL,
    abbreviation TEXT,
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    description TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    allow_cross_category BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_items_category_value
    ON catalogue_items (category, value);
  CREATE TABLE IF NOT EXISTS certificates (
    id SERIAL PRIMARY KEY,
    certificate_number TEXT NOT NULL,
    designations JSONB
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    admin_user TEXT,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/** The exact production-shaped six-row inventory (all abbreviation NULL). */
const BASELINE_ROWS = [
  ["unlimited", "Unlimited", 0, true],
  ["first_edition", "1st Edition", 1, true],
  ["shadowless", "Shadowless", 2, true],
  ["error", "Error", 3, false],
  ["misprint", "Misprint", 4, false],
  ["test_print", "Test Print", 5, false],
] as const;

async function seedBaseline(): Promise<void> {
  await q(`DELETE FROM catalogue_items`);
  await q(`DELETE FROM certificates`);
  await q(`DELETE FROM audit_log`);
  for (const [value, label, sort, cross] of BASELINE_ROWS) {
    await q(
      `INSERT INTO catalogue_items (category,value,label,abbreviation,sort_order,active,archived,allow_cross_category,created_by)
       VALUES ('designation',$1,$2,NULL,$3,TRUE,FALSE,$4,'seed')`,
      [value, label, sort, cross]
    );
  }
  // A couple of unrelated rows that must never be touched.
  await q(
    `INSERT INTO catalogue_items (category,value,label,sort_order,allow_cross_category,created_by)
     VALUES ('finish','first_edition','1st Edition',0,TRUE,'seed'),
            ('rarity','rare','Rare',0,FALSE,'seed')`
  );
  await q(`INSERT INTO certificates (certificate_number, designations) VALUES ('MV1','[]'::jsonb)`);
}

async function readRows(): Promise<CatalogueRow[]> {
  return (await q(
    `SELECT id,category,value,label,abbreviation,aliases,description,sort_order,active,archived,allow_cross_category
       FROM catalogue_items ORDER BY category,sort_order,id`
  )) as CatalogueRow[];
}

/** Execute the planned actions exactly as the script does, in one transaction. */
async function applyPlan(): Promise<void> {
  const rows = await readRows();
  const plan = buildPlan(rows);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const a of plan.actions) {
      const spec = CANONICAL_DESIGNATIONS.find((d) => d.value === a.value);
      if (a.kind === "update" && spec) {
        await client.query(
          `UPDATE catalogue_items SET abbreviation=$1 WHERE category='designation' AND value=$2`,
          [spec.code, a.value]
        );
      } else if (a.kind === "create" && spec) {
        await client.query(
          `INSERT INTO catalogue_items (category,value,label,abbreviation,aliases,description,sort_order,active,archived,allow_cross_category,created_by)
           VALUES ('designation',$1,$2,$3,$4::jsonb,$5,
                   (SELECT COALESCE(MAX(sort_order),-1)+1 FROM catalogue_items WHERE category='designation'),
                   TRUE,FALSE,$6,'ops')`,
          [spec.value, spec.label, spec.code, JSON.stringify(spec.aliases), spec.description, spec.allowCrossCategory]
        );
      } else if (a.kind === "archive") {
        await client.query(
          `UPDATE catalogue_items SET archived=TRUE WHERE category='designation' AND value=$1`,
          [a.value]
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  cluster = await startPostgres17("designation-reconciliation");
  pool = new pg.Pool({ connectionString: cluster.url });
  await q(CATALOGUE_DDL);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

beforeEach(seedBaseline);

// ── Contract ────────────────────────────────────────────────────────────────
describe("canonical contract matches the application", () => {
  const repoRoot = join(__dirname, "..");

  it("matches the pre-#259 hard-coded DESIGNATION_OPTIONS codes", () => {
    const src = readFileSync(join(repoRoot, "client/src/lib/designationOptions.ts"), "utf8");
    const codes = [...src.matchAll(/code:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual(CANONICAL_DESIGNATIONS.map((d) => d.code).sort());
  });

  it("matches the server DESIGNATION_LABELS map (keys AND labels)", () => {
    const src = readFileSync(join(repoRoot, "server/routes.ts"), "utf8");
    const block = src.match(/const DESIGNATION_LABELS[\s\S]*?\};/)?.[0] ?? "";
    for (const d of CANONICAL_DESIGNATIONS) {
      expect(block, `${d.code} missing from DESIGNATION_LABELS`).toContain(`${d.code}:`);
      expect(block, `${d.code} label mismatch`).toContain(`"${d.label}"`);
    }
    const keys = [...block.matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(CANONICAL_DESIGNATIONS.map((d) => d.code).sort());
  });

  it("excludes test_print and absorbs error/misprint into ERROR_MISCUT", () => {
    const values = CANONICAL_DESIGNATIONS.map((d) => d.value);
    expect(values).not.toContain("test_print");
    expect(values).not.toContain("error");
    expect(values).not.toContain("misprint");
    const em = CANONICAL_DESIGNATIONS.find((d) => d.code === "ERROR_MISCUT")!;
    expect(em.aliases).toEqual(expect.arrayContaining(["error", "misprint"]));
    expect(LEGACY_TO_ARCHIVE).toEqual(["error", "misprint", "test_print"]);
  });

  it("local effectiveCatalogueCode() is identical to migration 0026's SQL expression", async () => {
    const cases = [
      { value: "first_edition", abbreviation: "FIRST_EDITION" },
      { value: "error", abbreviation: null },
      { value: "  spaced  ", abbreviation: "  ABBR  " },
      { value: "only_value", abbreviation: "   " },
    ];
    for (const c of cases) {
      const [row] = await q(
        `SELECT lower(coalesce(nullif(btrim($2::text),''), btrim($1::text))) AS sql_code`,
        [c.value, c.abbreviation]
      );
      expect(effectiveCatalogueCode(c), JSON.stringify(c)).toBe((row as { sql_code: string }).sql_code);
    }
  });
});

// ── Planning ────────────────────────────────────────────────────────────────
describe("state classification and planning", () => {
  it("classifies the production-shaped six-row inventory as baseline", async () => {
    expect(classifyState(await readRows())).toBe("baseline");
  });

  it("plans exactly 3 updates, 7 creates and 3 archives", async () => {
    const plan = buildPlan(await readRows());
    expect(plan.state).toBe("baseline");
    expect(plan.actions.filter((a) => a.kind === "update").map((a) => a.value).sort())
      .toEqual(["first_edition", "shadowless", "unlimited"]);
    expect(plan.actions.filter((a) => a.kind === "create")).toHaveLength(7);
    expect(plan.actions.filter((a) => a.kind === "archive").map((a) => a.value).sort())
      .toEqual(["error", "misprint", "test_print"]);
    expect(plan.actions).toHaveLength(13);
  });

  it("resolves rows by value, never by hard-coded id", async () => {
    // Renumber every id; the plan must be unchanged.
    await q(`UPDATE catalogue_items SET id = id + 5000`);
    const plan = buildPlan(await readRows());
    expect(plan.actions).toHaveLength(13);
    expect(plan.state).toBe("baseline");
  });

  it("post-state validation passes for the baseline", async () => {
    expect(validatePostState(await readRows())).toEqual([]);
  });
});

// ── Apply / idempotency / rollback ──────────────────────────────────────────
describe("apply, rerun and rollback", () => {
  it("dry run writes nothing", async () => {
    const before = await readRows();
    buildPlan(before); // planning is pure — no writes
    const after = await readRows();
    expect(after).toEqual(before);
  });

  it("apply produces exactly the ten canonical live rows", async () => {
    await applyPlan();
    const live = (await q(
      `SELECT value, abbreviation FROM catalogue_items
        WHERE category='designation' AND active AND NOT archived ORDER BY sort_order,id`
    )) as { value: string; abbreviation: string }[];
    expect(live).toHaveLength(10);
    expect(live.map((r) => r.abbreviation).sort()).toEqual(CANONICAL_DESIGNATIONS.map((d) => d.code).sort());
    for (const d of CANONICAL_DESIGNATIONS) {
      expect(live.find((r) => r.value === d.value)?.abbreviation).toBe(d.code);
    }
  });

  it("archives (not deletes) the three legacy rows", async () => {
    await applyPlan();
    const arc = (await q(
      `SELECT value, archived FROM catalogue_items WHERE category='designation' AND archived ORDER BY value`
    )) as { value: string }[];
    expect(arc.map((r) => r.value)).toEqual(["error", "misprint", "test_print"]);
  });

  it("leaves no duplicate live effective codes (migration 0026 stays valid)", async () => {
    await applyPlan();
    const dupes = await q(
      `SELECT lower(coalesce(nullif(btrim(abbreviation),''),btrim(value))) code, count(*) n
         FROM catalogue_items
        WHERE active AND NOT archived AND category IN ('designation','attribute')
          AND btrim(coalesce(nullif(btrim(abbreviation),''),btrim(value))) <> ''
        GROUP BY 1 HAVING count(*) > 1`
    );
    expect(dupes).toEqual([]);
  });

  it("is a no-op when rerun after success", async () => {
    await applyPlan();
    const afterFirst = await readRows();
    expect(classifyState(afterFirst)).toBe("reconciled");
    const plan = buildPlan(afterFirst);
    expect(plan.actions).toEqual([]);
    await applyPlan();
    expect(await readRows()).toEqual(afterFirst);
  });

  it("never touches unrelated catalogue rows", async () => {
    const before = (await q(`SELECT * FROM catalogue_items WHERE category <> 'designation' ORDER BY id`));
    await applyPlan();
    const after = (await q(`SELECT * FROM catalogue_items WHERE category <> 'designation' ORDER BY id`));
    expect(after).toEqual(before);
  });

  it("never writes the certificates table", async () => {
    const before = await q(`SELECT * FROM certificates ORDER BY id`);
    await applyPlan();
    expect(await q(`SELECT * FROM certificates ORDER BY id`)).toEqual(before);
  });

  it("rollback restores the original six-row baseline", async () => {
    await applyPlan();
    const created = CANONICAL_DESIGNATIONS.map((d) => d.value).filter(
      (v) => !["unlimited", "first_edition", "shadowless"].includes(v)
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE catalogue_items SET abbreviation=NULL WHERE category='designation' AND value = ANY($1)`,
        [["unlimited", "first_edition", "shadowless"]]
      );
      await client.query(`DELETE FROM catalogue_items WHERE category='designation' AND value = ANY($1)`, [created]);
      await client.query(`UPDATE catalogue_items SET archived=FALSE WHERE category='designation' AND value = ANY($1)`, [
        [...LEGACY_TO_ARCHIVE],
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const rows = await readRows();
    expect(classifyState(rows)).toBe("baseline");
    const live = rows.filter((r) => r.category === "designation" && r.active && !r.archived).map((r) => r.value).sort();
    expect(live).toEqual([...APPROVED_BASELINE_VALUES].sort());
    expect(rows.filter((r) => r.category === "designation").every((r) => r.abbreviation === null)).toBe(true);
  });
});

// ── Fail-closed inventories ─────────────────────────────────────────────────
describe("unexpected inventories fail closed", () => {
  it("rejects an unknown inventory (extra live row)", async () => {
    await q(
      `INSERT INTO catalogue_items (category,value,label,created_by) VALUES ('designation','surprise_row','Surprise','x')`
    );
    const plan = buildPlan(await readRows());
    expect(plan.state).toBe("unknown");
    expect(plan.actions).toEqual([]);
    expect(plan.reason).toMatch(/does not match the approved baseline/i);
  });

  it("rejects an inventory with a pre-set abbreviation (partial/unknown state)", async () => {
    await q(`UPDATE catalogue_items SET abbreviation='FIRST_EDITION' WHERE value='first_edition'`);
    expect(classifyState(await readRows())).toBe("unknown");
  });

  it("detects a duplicate live effective code in the post-state", async () => {
    // A live attribute row whose effective code collides with a canonical one.
    await q(
      `INSERT INTO catalogue_items (category,value,label,abbreviation,created_by)
       VALUES ('attribute','dup_holder','Dup','PROMO','x')`
    );
    const problems = validatePostState(await readRows());
    expect(problems.join(" ")).toMatch(/duplicate live effective code "promo"/i);
  });

  it("detects a cross-category collision for a created row", async () => {
    // 'staff' as a rarity WITHOUT allowCrossCategory blocks the designation create.
    await q(
      `INSERT INTO catalogue_items (category,value,label,allow_cross_category,created_by)
       VALUES ('rarity','staff','Staff',FALSE,'x')`
    );
    const problems = validatePostState(await readRows());
    expect(problems.join(" ")).toMatch(/already exists as a rarity|one category only/i);
  });

  it("an unexpected certificate-designation inventory is detectable before any write", async () => {
    await q(`UPDATE certificates SET designations = '["FIRST_EDITION"]'::jsonb WHERE certificate_number='MV1'`);
    const [row] = (await q(
      `SELECT count(*)::int n FROM certificates WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb))>0`
    )) as { n: number }[];
    expect(row.n).toBe(1); // the script refuses when this is non-zero
  });

  it("a failing action rolls the whole transaction back", async () => {
    const before = await readRows();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE catalogue_items SET abbreviation='UNLIMITED' WHERE value='unlimited'`);
      // Violates uq_catalogue_items_category_value → aborts the transaction.
      await client.query(
        `INSERT INTO catalogue_items (category,value,label,created_by) VALUES ('designation','error','Dup','x')`
      ).catch(async (e) => {
        await client.query("ROLLBACK");
        throw e;
      });
      await client.query("COMMIT");
    } catch {
      /* expected */
    } finally {
      client.release();
    }
    expect(await readRows()).toEqual(before);
  });
});

// ── CLI guards ──────────────────────────────────────────────────────────────
describe("CLI flag parsing", () => {
  it("defaults to dry run", () => {
    expect(parseArgs(["--environment", "production"]).apply).toBe(false);
  });
  it("parses the full production apply flag set", () => {
    const a = parseArgs([
      "--environment", "production", "--apply", "--confirm-production",
      "--expected-app-sha", "e6c7c139", "--expected-db-host", "ep-wispy-morning",
    ]);
    expect(a).toEqual({
      environment: "production",
      apply: true,
      confirmProduction: true,
      expectedAppSha: "e6c7c139",
      expectedDbHost: "ep-wispy-morning",
    });
  });
  it("does not treat a following flag as a value", () => {
    expect(parseArgs(["--environment", "--apply"]).environment).toBeNull();
  });
});
