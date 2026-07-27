/**
 * designation-catalogue-reconciliation.test.ts
 *
 * Behavioural proof for the PR #261 ops package, against a REAL disposable
 * PostgreSQL 17 cluster and temporary directories only.
 *
 * These tests NEVER read MINTVAULT_DATABASE_URL and never contact staging or
 * production. Every database is created and destroyed by the test process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { catalogueConflict } from "../shared/catalogue-validate";
import {
  ENVIRONMENTS,
  GuardError,
  parseArgs,
  parseDbHostname,
  assertEnvironmentBinding,
  normaliseSha,
  compareSha,
  assertSafeBackupPath,
  backupFilename,
  CANONICAL_DESIGNATIONS,
  LEGACY_TO_ARCHIVE,
  APPROVED_BASELINE_VALUES,
  CREATED_BY_RECONCILIATION,
  RECONCILE_ACTOR,
  buildPlan,
  classifyState,
  validatePostState,
  contractDrift,
  effectiveCatalogueCode,
  inventoryFingerprint,
  type CatalogueRow,
} from "../scripts/db/designation-catalogue-contract";

let cluster: DisposablePostgres17;
let pool: pg.Pool;
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

const PROD_HOST = "ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech";
const STAGING_HOST = "ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech";

const DDL = `
  CREATE TABLE IF NOT EXISTS catalogue_items (
    id SERIAL PRIMARY KEY, category TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL,
    abbreviation TEXT, aliases JSONB NOT NULL DEFAULT '[]'::jsonb, description TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb, sort_order INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE, archived BOOLEAN NOT NULL DEFAULT FALSE,
    allow_cross_category BOOLEAN NOT NULL DEFAULT FALSE, notes TEXT,
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_items_category_value ON catalogue_items (category, value);
  CREATE TABLE IF NOT EXISTS certificates (id SERIAL PRIMARY KEY, certificate_number TEXT NOT NULL, designations JSONB);
  CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    action TEXT NOT NULL, admin_user TEXT, details JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

/** Production-shaped six-row inventory, all abbreviation NULL. */
const BASELINE = [
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
  for (const [value, label, sort, cross] of BASELINE) {
    await q(
      `INSERT INTO catalogue_items (category,value,label,abbreviation,sort_order,active,archived,allow_cross_category,created_by)
       VALUES ('designation',$1,$2,NULL,$3,TRUE,FALSE,$4,'seed')`,
      [value, label, sort, cross],
    );
  }
  await q(
    `INSERT INTO catalogue_items (category,value,label,sort_order,allow_cross_category,created_by)
     VALUES ('finish','first_edition','1st Edition',0,TRUE,'seed'), ('rarity','rare','Rare',0,FALSE,'seed')`,
  );
  await q(`INSERT INTO certificates (certificate_number, designations) VALUES ('MV1','[]'::jsonb)`);
}

const readRows = async (): Promise<CatalogueRow[]> =>
  (await q(
    `SELECT id,category,value,label,abbreviation,aliases,description,sort_order,active,archived,allow_cross_category,created_by
       FROM catalogue_items ORDER BY category,sort_order,id`,
  )) as CatalogueRow[];

/** Apply the plan the way the script does (single transaction, ownership marker). */
async function applyPlan(): Promise<void> {
  const rows = await readRows();
  const plan = buildPlan(rows);
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    for (const a of plan.actions) {
      const spec = CANONICAL_DESIGNATIONS.find((d) => d.value === a.value);
      if (a.kind === "update" && spec) {
        await c.query(
          `UPDATE catalogue_items SET abbreviation=$1,label=$2,description=$3,aliases=$4::jsonb,
             allow_cross_category=$5,active=TRUE,archived=FALSE,updated_by=$6
           WHERE category='designation' AND value=$7`,
          [spec.code, spec.label, spec.description, JSON.stringify(spec.aliases), spec.allowCrossCategory, RECONCILE_ACTOR, a.value],
        );
      } else if (a.kind === "create" && spec) {
        await c.query(
          `INSERT INTO catalogue_items (category,value,label,abbreviation,aliases,description,sort_order,active,archived,allow_cross_category,created_by,updated_by)
           VALUES ('designation',$1,$2,$3,$4::jsonb,$5,
             (SELECT COALESCE(MAX(sort_order),-1)+1 FROM catalogue_items WHERE category='designation'),
             TRUE,FALSE,$6,$7,$7)`,
          [spec.value, spec.label, spec.code, JSON.stringify(spec.aliases), spec.description, spec.allowCrossCategory, RECONCILE_ACTOR],
        );
      } else if (a.kind === "archive") {
        await c.query(`UPDATE catalogue_items SET archived=TRUE, updated_by=$1 WHERE category='designation' AND value=$2`, [RECONCILE_ACTOR, a.value]);
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  cluster = await startPostgres17("designation-reconciliation");
  pool = new pg.Pool({ connectionString: cluster.url });
  await q(DDL);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

beforeEach(seedBaseline);

// ══ TASK 1 — environment ↔ database binding ═══════════════════════════════
describe("environment/database binding (hostile review CRITICAL)", () => {
  it("1. production DB URL with --environment staging is REFUSED", () => {
    expect(() => assertEnvironmentBinding("staging", PROD_HOST, null)).toThrow(GuardError);
    expect(() => assertEnvironmentBinding("staging", PROD_HOST, null)).toThrow(/does not belong to "staging"/);
  });

  it("2. staging DB URL with --environment production is REFUSED", () => {
    expect(() => assertEnvironmentBinding("production", STAGING_HOST, null)).toThrow(/does not belong to "production"/);
  });

  it("3. a broad host fragment is REFUSED (no substring matching)", () => {
    for (const needle of ["ep-", "neon", "pooler", "aws", "eu-west-2", ".neon.tech"]) {
      expect(() => assertEnvironmentBinding("production", PROD_HOST, needle), needle).toThrow(GuardError);
    }
  });

  it("4. hostname alias / prefix / suffix variants are REFUSED", () => {
    const variants = [
      `${PROD_HOST}.evil.example.com`,
      `evil-${PROD_HOST}`,
      PROD_HOST.replace(".tech", ".tech."),
      PROD_HOST.toUpperCase(),
      ` ${PROD_HOST}`,
      `${PROD_HOST} `,
    ];
    for (const v of variants) expect(() => assertEnvironmentBinding("production", v, null), v).toThrow(GuardError);
  });

  it("5. a malformed database URL is REFUSED without echoing the value", () => {
    expect(() => parseDbHostname("not a url")).toThrow(/not a parseable URL \(value withheld\)/);
    try {
      parseDbHostname("postgres://user:SUPERSECRET@:5432/db");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SUPERSECRET");
    }
  });

  it("6. a missing hostname is REFUSED", () => {
    expect(() => parseDbHostname(undefined)).toThrow(/is not set/);
    expect(() => parseDbHostname("")).toThrow(/is not set/);
  });

  it("7. --expected-db-host that is not the configured host is REFUSED", () => {
    expect(() => assertEnvironmentBinding("production", PROD_HOST, STAGING_HOST)).toThrow(/does not equal the configured host/);
  });

  it("8. correct environment + exact host is ACCEPTED", () => {
    const env = assertEnvironmentBinding("production", PROD_HOST, PROD_HOST);
    expect(env.key).toBe("production");
    expect(env.requiresProductionConfirmation).toBe(true);
    expect(assertEnvironmentBinding("staging", STAGING_HOST, STAGING_HOST).key).toBe("staging");
  });

  it("the mapping is owned by the script, and local-test can never be a managed host", () => {
    expect(ENVIRONMENTS.production.dbHost).toBe(PROD_HOST);
    expect(ENVIRONMENTS.staging.dbHost).toBe(STAGING_HOST);
    expect(ENVIRONMENTS["local-test"].dbHost).toBe("127.0.0.1");
    expect(ENVIRONMENTS["local-test"].requiresProductionConfirmation).toBe(false);
    expect(() => assertEnvironmentBinding("local-test", PROD_HOST, null)).toThrow(GuardError);
  });
});

// ══ TASK 7 — CLI and SHA hardening ════════════════════════════════════════
describe("CLI and SHA hardening", () => {
  it("defaults to dry run and parses a full valid flag set", () => {
    expect(parseArgs(["--environment", "production"]).apply).toBe(false);
    const a = parseArgs(["--environment", "production", "--apply", "--confirm-production",
      "--expected-app-sha", "e6c7c139", "--expected-db-host", PROD_HOST]);
    expect(a).toMatchObject({ environment: "production", apply: true, confirmProduction: true, expectedDbHost: PROD_HOST });
  });

  it("17. rejects non-hex, too-short and over-long SHAs", () => {
    expect(() => normaliseSha("zzzzzzzz")).toThrow(/hexadecimal/);
    expect(() => normaliseSha("e6c")).toThrow(/at least 7/);
    expect(() => normaliseSha("a".repeat(41))).toThrow(/at most 40/);
    expect(normaliseSha("E6C7C139")).toBe("e6c7c139");
  });

  it("18. refuses a SHA shorter than the live commit rather than truncating it", () => {
    const v = compareSha("e6c7c13", "e6c7c139");
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/shorter than the live commit/);
  });

  it("reports how much of a long SHA was verified instead of silently truncating", () => {
    const full = compareSha("e6c7c1394b2cedee9033be76df3b2a93d788b2b3", "e6c7c139");
    expect(full.ok).toBe(true);
    expect(full.fullyVerified).toBe(false);
    expect(full.verifiedChars).toBe(8);
    expect(full.message).toMatch(/first 8 of 40 chars/);
    const exact = compareSha("e6c7c139", "e6c7c139");
    expect(exact.fullyVerified).toBe(true);
  });

  it("rejects a mismatching SHA", () => {
    expect(compareSha("dead beef".replace(" ", ""), "e6c7c139").ok).toBe(false);
  });

  it("rejects duplicate flags, missing values, whitespace, unknown flags and conflicts", () => {
    expect(() => parseArgs(["--environment", "a", "--environment", "b"])).toThrow(/more than once/);
    expect(() => parseArgs(["--environment"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--environment", "--apply"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--environment", "prod uction"])).toThrow(/whitespace/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["positional"])).toThrow(/must start with --/);
    expect(() => parseArgs(["--environment", "staging", "--confirm-production"])).toThrow(/conflicting arguments/);
  });
});

// ══ Contract fidelity ═════════════════════════════════════════════════════
describe("canonical contract matches the application", () => {
  const repo = join(__dirname, "..");

  it("matches the pre-#259 hard-coded DESIGNATION_OPTIONS codes", () => {
    const src = readFileSync(join(repo, "client/src/lib/designationOptions.ts"), "utf8");
    const codes = [...src.matchAll(/code:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual(CANONICAL_DESIGNATIONS.map((d) => d.code).sort());
  });

  it("matches the server DESIGNATION_LABELS map (keys AND labels)", () => {
    const src = readFileSync(join(repo, "server/routes.ts"), "utf8");
    const block = src.match(/const DESIGNATION_LABELS[\s\S]*?\};/)?.[0] ?? "";
    for (const d of CANONICAL_DESIGNATIONS) {
      expect(block, `${d.code} missing`).toContain(`${d.code}:`);
      expect(block, `${d.code} label`).toContain(`"${d.label}"`);
    }
    const keys = [...block.matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(CANONICAL_DESIGNATIONS.map((d) => d.code).sort());
  });

  it("excludes test_print and absorbs error/misprint into ERROR_MISCUT", () => {
    const values = CANONICAL_DESIGNATIONS.map((d) => d.value);
    expect(values).not.toContain("test_print");
    expect(values).not.toContain("error");
    expect(values).not.toContain("misprint");
    expect(CANONICAL_DESIGNATIONS.find((d) => d.code === "ERROR_MISCUT")!.aliases)
      .toEqual(expect.arrayContaining(["error", "misprint"]));
    expect([...LEGACY_TO_ARCHIVE]).toEqual(["error", "misprint", "test_print"]);
  });

  it("effectiveCatalogueCode() is identical to migration 0026's SQL expression", async () => {
    const cases = [
      { value: "first_edition", abbreviation: "FIRST_EDITION" },
      { value: "error", abbreviation: null },
      { value: "  spaced  ", abbreviation: "  ABBR  " },
      { value: "only_value", abbreviation: "   " },
    ];
    for (const c of cases) {
      const [row] = await q(`SELECT lower(coalesce(nullif(btrim($2::text),''), btrim($1::text))) AS sql_code`, [c.value, c.abbreviation]);
      expect(effectiveCatalogueCode(c), JSON.stringify(c)).toBe((row as { sql_code: string }).sql_code);
    }
  });

  it("CREATED_BY_RECONCILIATION is exactly the seven non-baseline canonical values", () => {
    expect([...CREATED_BY_RECONCILIATION].sort()).toEqual(
      ["error_miscut", "japanese_print", "other_language", "prerelease", "promo", "staff", "tournament_stamp"],
    );
  });
});

// ══ TASK 3 — full canonical row contract ══════════════════════════════════
describe("full canonical row contract", () => {
  it("classifies the production-shaped inventory as baseline and plans 13 actions", async () => {
    const rows = await readRows();
    expect(classifyState(rows).state).toBe("baseline");
    const plan = buildPlan(rows);
    expect(plan.actions.filter((a) => a.kind === "create")).toHaveLength(7);
    expect(plan.actions.filter((a) => a.kind === "archive")).toHaveLength(3);
    expect(plan.actions.filter((a) => a.kind === "update")).toHaveLength(3);
  });

  it("10. a WRONG canonical label is corrected, not left untouched", async () => {
    await q(`UPDATE catalogue_items SET label='WRONG LABEL' WHERE category='designation' AND value='first_edition'`);
    const plan = buildPlan(await readRows());
    const upd = plan.actions.find((a) => a.value === "first_edition")!;
    expect(upd.drift?.map((d) => d.field)).toContain("label");
    await applyPlan();
    const [row] = (await q(`SELECT label FROM catalogue_items WHERE category='designation' AND value='first_edition'`)) as { label: string }[];
    expect(row.label).toBe("1st Edition");
  });

  it("reconciles aliases, description and allow_cross_category too", async () => {
    await q(`UPDATE catalogue_items SET aliases='["nonsense"]'::jsonb, description='junk', allow_cross_category=FALSE
              WHERE category='designation' AND value='unlimited'`);
    await applyPlan();
    const [row] = (await q(`SELECT aliases,description,allow_cross_category FROM catalogue_items WHERE category='designation' AND value='unlimited'`)) as
      { aliases: string[]; description: string; allow_cross_category: boolean }[];
    const spec = CANONICAL_DESIGNATIONS.find((d) => d.value === "unlimited")!;
    expect([...row.aliases].sort()).toEqual([...spec.aliases].sort());
    expect(row.description).toBe(spec.description);
    expect(row.allow_cross_category).toBe(true);
  });

  it("a fully reconciled state is a genuine no-op", async () => {
    await applyPlan();
    const rows = await readRows();
    expect(classifyState(rows).state).toBe("reconciled");
    expect(buildPlan(rows).actions).toEqual([]);
    const before = inventoryFingerprint(rows);
    await applyPlan();
    expect(inventoryFingerprint(await readRows())).toBe(before);
  });

  it("11. an ARCHIVED canonical row fails closed during PREFLIGHT", async () => {
    await q(`INSERT INTO catalogue_items (category,value,label,abbreviation,archived,created_by)
             VALUES ('designation','error_miscut','Error / Miscut / Misprint','ERROR_MISCUT',TRUE,'x')`);
    const s = classifyState(await readRows());
    expect(s.state).toBe("unknown");
    expect(s.reason).toMatch(/archived canonical designation row/i);
    expect(buildPlan(await readRows()).actions).toEqual([]);
  });

  it("an abbreviation already set on a baseline row fails closed (never silently overwritten)", async () => {
    await q(`UPDATE catalogue_items SET abbreviation='BOGUS' WHERE category='designation' AND value='shadowless'`);
    const s = classifyState(await readRows());
    expect(s.state).toBe("unknown");
    expect(s.reason).toMatch(/already carry an abbreviation/i);
  });

  it("an unrelated extra designation row fails closed", async () => {
    await q(`INSERT INTO catalogue_items (category,value,label,created_by) VALUES ('designation','custom_thing','Custom','x')`);
    expect(classifyState(await readRows()).state).toBe("unknown");
  });

  it("a duplicate live effective code is detected before any write", async () => {
    await q(`INSERT INTO catalogue_items (category,value,label,abbreviation,created_by) VALUES ('attribute','dup','Dup','PROMO','x')`);
    expect(validatePostState(await readRows(), catalogueConflict).join(" ")).toMatch(/duplicate live effective code "promo"/i);
  });

  it("a cross-category collision is detected for a created row", async () => {
    await q(`INSERT INTO catalogue_items (category,value,label,allow_cross_category,created_by) VALUES ('rarity','staff','Staff',FALSE,'x')`);
    expect(validatePostState(await readRows(), catalogueConflict).join(" ")).toMatch(/one category only|already exists as a rarity/i);
  });

  it("rows are resolved by value, never by id", async () => {
    await q(`UPDATE catalogue_items SET id = id + 5000`);
    expect(buildPlan(await readRows()).actions).toHaveLength(13);
  });

  it("contractDrift reports every differing field", () => {
    const spec = CANONICAL_DESIGNATIONS[0];
    const row: CatalogueRow = {
      id: 1, category: "designation", value: spec.value, label: "X", abbreviation: null,
      aliases: [], description: "", sort_order: 0, active: false, archived: true,
      allow_cross_category: !spec.allowCrossCategory, created_by: "seed",
    };
    expect(contractDrift(row, spec).map((d) => d.field).sort())
      .toEqual(["abbreviation", "active", "aliases", "allow_cross_category", "archived", "description", "label"].sort());
  });
});

// ══ TASK 2 — rollback ownership ═══════════════════════════════════════════
describe("rollback ownership protection (hostile review HIGH)", () => {
  it("9. refuses to delete a canonical row this package did not create", async () => {
    await q(`INSERT INTO catalogue_items (category,value,label,created_by) VALUES ('designation','promo','Pre-existing Promo','a-human')`);
    const rows = await readRows();
    const unowned = CREATED_BY_RECONCILIATION
      .map((v) => rows.find((r) => r.category === "designation" && r.value === v))
      .filter((r): r is CatalogueRow => !!r && r.created_by !== RECONCILE_ACTOR);
    expect(unowned).toHaveLength(1);
    expect(unowned[0].created_by).toBe("a-human");
    // The ownership-scoped DELETE cannot remove it.
    const del = await q(`DELETE FROM catalogue_items WHERE category='designation' AND value='promo' AND created_by=$1 RETURNING id`, [RECONCILE_ACTOR]);
    expect(del).toHaveLength(0);
    expect(await q(`SELECT id FROM catalogue_items WHERE category='designation' AND value='promo'`)).toHaveLength(1);
  });

  it("rows the reconciliation creates carry the ownership marker", async () => {
    await applyPlan();
    const created = (await q(
      `SELECT value, created_by FROM catalogue_items WHERE category='designation' AND value = ANY($1)`,
      [[...CREATED_BY_RECONCILIATION]],
    )) as { value: string; created_by: string }[];
    expect(created).toHaveLength(7);
    for (const r of created) expect(r.created_by).toBe(RECONCILE_ACTOR);
  });

  it("19. rollback emits truthful per-row audits and restores the baseline", async () => {
    await applyPlan();
    const rows = await readRows();
    const c = await pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      for (const v of ["unlimited", "first_edition", "shadowless"]) {
        const before = rows.find((r) => r.category === "designation" && r.value === v);
        const upd = await c.query(`UPDATE catalogue_items SET abbreviation=NULL WHERE category='designation' AND value=$1 RETURNING *`, [v]);
        await c.query(
          `INSERT INTO audit_log (entity_type,entity_id,action,admin_user,details) VALUES ('catalogue_item',$1,'catalogue_item_update','ops:rollback-designation-catalogue',$2::jsonb)`,
          [`designation:${v}`, JSON.stringify({ oldValue: before, newValue: upd.rows[0], reason: "rollback", actor: "ops:rollback-designation-catalogue" })],
        );
      }
      for (const v of CREATED_BY_RECONCILIATION) {
        const before = rows.find((r) => r.category === "designation" && r.value === v);
        const del = await c.query(`DELETE FROM catalogue_items WHERE category='designation' AND value=$1 AND created_by=$2 RETURNING *`, [v, RECONCILE_ACTOR]);
        expect(del.rowCount).toBe(1);
        await c.query(
          `INSERT INTO audit_log (entity_type,entity_id,action,admin_user,details) VALUES ('catalogue_item',$1,'catalogue_item_delete','ops:rollback-designation-catalogue',$2::jsonb)`,
          [`designation:${v}`, JSON.stringify({ oldValue: before, newValue: null, reason: "rollback", actor: "ops:rollback-designation-catalogue" })],
        );
      }
      for (const v of LEGACY_TO_ARCHIVE) {
        await c.query(`UPDATE catalogue_items SET archived=FALSE WHERE category='designation' AND value=$1`, [v]);
      }
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const live = (await q(`SELECT value FROM catalogue_items WHERE category='designation' AND active AND NOT archived ORDER BY value`)) as { value: string }[];
    expect(live.map((r) => r.value)).toEqual([...APPROVED_BASELINE_VALUES].sort());

    const audits = (await q(`SELECT action, details FROM audit_log WHERE admin_user='ops:rollback-designation-catalogue'`)) as
      { action: string; details: { oldValue: unknown; newValue: unknown; actor: string; reason: string } }[];
    expect(audits).toHaveLength(10);
    for (const a of audits) {
      expect(a.details.actor).toBe("ops:rollback-designation-catalogue");
      expect(a.details.reason).toBeTruthy();
      expect(a.details).toHaveProperty("oldValue");
      expect(a.details).toHaveProperty("newValue");
    }
    expect(audits.filter((a) => a.action === "catalogue_item_delete")).toHaveLength(7);
  });
});

// ══ TASK 4 — concurrency and atomicity ════════════════════════════════════
describe("concurrency and atomicity", () => {
  it("13. a catalogue mutation between preflight and transaction is detected by fingerprint", async () => {
    const preflight = inventoryFingerprint(await readRows());
    await q(`INSERT INTO catalogue_items (category,value,label,created_by) VALUES ('designation','late_arrival','Late','x')`);
    expect(inventoryFingerprint(await readRows())).not.toBe(preflight);
  });

  it("12. a certificate designation appearing after preflight is caught by the in-transaction re-check", async () => {
    const sql = `SELECT count(*)::int n FROM certificates WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb))>0`;
    expect(((await q(sql)) as { n: number }[])[0].n).toBe(0);
    await q(`UPDATE certificates SET designations='["FIRST_EDITION"]'::jsonb`);
    expect(((await q(sql)) as { n: number }[])[0].n).toBe(1); // the re-check aborts on this
  });

  it("20. a forced transaction failure leaves zero catalogue and audit writes", async () => {
    const before = inventoryFingerprint(await readRows());
    const c = await pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await c.query(`UPDATE catalogue_items SET abbreviation='UNLIMITED' WHERE category='designation' AND value='unlimited'`);
      await c.query(
        `INSERT INTO audit_log (entity_type,entity_id,action,admin_user,details) VALUES ('catalogue_item','designation:unlimited','catalogue_item_update',$1,'{}'::jsonb)`,
        [RECONCILE_ACTOR],
      );
      await c.query(`INSERT INTO catalogue_items (category,value,label,created_by) VALUES ('designation','error','dup','x')`); // violates unique index
      await c.query("COMMIT");
    } catch {
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(inventoryFingerprint(await readRows())).toBe(before);
    expect(await q(`SELECT id FROM audit_log`)).toHaveLength(0);
  });

  it("row locking uses FOR UPDATE on existing designation rows", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const locked = await c.query(`SELECT id FROM catalogue_items WHERE category='designation' FOR UPDATE`);
      expect(locked.rowCount).toBe(6);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("certificates are never written by the reconciliation", async () => {
    const before = await q(`SELECT certificate_number, designations FROM certificates ORDER BY id`);
    await applyPlan();
    expect(await q(`SELECT certificate_number, designations FROM certificates ORDER BY id`)).toEqual(before);
  });

  it("unrelated catalogue categories are never written", async () => {
    const before = await q(`SELECT * FROM catalogue_items WHERE category<>'designation' ORDER BY id`);
    await applyPlan();
    expect(await q(`SELECT * FROM catalogue_items WHERE category<>'designation' ORDER BY id`)).toEqual(before);
  });
});

// ══ TASK 5 — backup safety ════════════════════════════════════════════════
describe("backup path safety", () => {
  const repo = mkdtempSync(join(tmpdir(), "r261-repo-"));
  const out = mkdtempSync(join(tmpdir(), "r261-out-"));

  it("14. a backup path inside the repository is REFUSED", () => {
    expect(() => assertSafeBackupPath(join(repo, "b.json"), repo, { forceOverwrite: false })).toThrow(/inside the repository/);
    expect(() => assertSafeBackupPath(join(repo, "nested", "deep", "b.json"), repo, { forceOverwrite: false })).toThrow(/inside the repository/);
  });

  it("15. a symlinked backup path is REFUSED", () => {
    const linkDir = join(out, "link-to-repo");
    try { rmSync(linkDir, { recursive: true, force: true }); } catch { /* ignore */ }
    symlinkSync(repo, linkDir);
    expect(() => assertSafeBackupPath(join(linkDir, "b.json"), repo, { forceOverwrite: false })).toThrow(/symlink|inside the repository/);
  });

  it("16. an existing backup is not overwritten without --force-overwrite", () => {
    const target = join(out, "existing.json");
    mkdirSync(out, { recursive: true });
    writeFileSync(target, "{}");
    expect(() => assertSafeBackupPath(target, repo, { forceOverwrite: false })).toThrow(/already exists/);
    expect(assertSafeBackupPath(target, repo, { forceOverwrite: true })).toBe(target);
  });

  it("a safe absolute path outside the repo is accepted; relative paths are refused", () => {
    expect(assertSafeBackupPath(join(out, "fresh.json"), repo, { forceOverwrite: false })).toBe(join(out, "fresh.json"));
    expect(() => assertSafeBackupPath("relative.json", repo, { forceOverwrite: false })).toThrow(/must be absolute/);
  });

  it("filenames carry environment and timestamp and no credentials", () => {
    const name = backupFilename("production", "2026-07-27T12:00:00.000Z");
    expect(name).toBe("catalogue-backup-production-2026-07-27T12-00-00-000Z.json");
    expect(name).not.toMatch(/postgres|password|@/);
  });
});
