/**
 * reconcile-designation-catalogue.ts — one-shot, idempotent reconciliation of the
 * DB-backed designation catalogue to the canonical application contract.
 *
 * WHY THIS EXISTS
 * PR #259 switches the Card Details designation picker from the hard-coded
 * `DESIGNATION_OPTIONS` array to the DB-backed catalogue. The live catalogue was
 * seeded with lowercase internal values (`first_edition`, `error`, ...) and no
 * abbreviations, so the DB-backed picker would present the wrong option set and
 * persist codes that `DESIGNATION_LABELS` (server/routes.ts) cannot resolve.
 * This script makes the catalogue match the canonical contract BEFORE #259 ships.
 *
 * SAFE TO RUN BEFORE THE DEPLOY. The pre-#259 application does not read
 * designation rows at all — `buildSnapshotFromRows` on main emits no
 * `designations` key and there is no `mapDesignationRow`. The reconciliation is
 * therefore INERT until PR #259 is deployed.
 *
 * SCOPE — this script touches `catalogue_items` ONLY. It never reads or writes
 * certificates, grading, MVGS, Pristine/P10, centering, labels, cert_counter,
 * the schema, or the migration journal.
 *
 * USAGE
 *   # dry run (default — writes nothing)
 *   npx tsx scripts/db/reconcile-designation-catalogue.ts --environment staging
 *
 *   # apply to production (all four flags required)
 *   npx tsx scripts/db/reconcile-designation-catalogue.ts \
 *     --environment production \
 *     --apply \
 *     --confirm-production \
 *     --expected-app-sha e6c7c1394b2cedee9033be76df3b2a93d788b2b3 \
 *     --expected-db-host ep-wispy-morning
 *
 * The database URL comes from MINTVAULT_DATABASE_URL. Credentials are never
 * printed — only the host is echoed, and only for identity confirmation.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { catalogueConflict, type CatalogueEntryLike } from "../../shared/catalogue-validate";

/**
 * `effectiveCatalogueCode` and the persisted-code pattern are defined LOCALLY on
 * purpose. This script must run against production while production is still on
 * `main`, where those helpers do not yet exist (PR #259 adds them to
 * shared/catalogue-validate.ts). The definitions below are byte-for-byte
 * equivalent to both PR #259's shared helpers AND to migration 0026's SQL
 * expression `lower(coalesce(nullif(btrim(abbreviation),''), btrim(value)))`.
 * `tests/designation-catalogue-reconciliation.test.ts` asserts that equivalence
 * against a real PostgreSQL cluster, so the three cannot drift.
 */
export function effectiveCatalogueCode(row: { value?: string | null; abbreviation?: string | null }): string {
  const abbr = (row.abbreviation ?? "").trim();
  return (abbr || (row.value ?? "").trim()).toLowerCase();
}

/**
 * SSL policy, matching `server/db.ts`: managed hosts (Neon) require TLS, a local
 * disposable cluster does not offer it. Without this the script cannot be
 * exercised end-to-end against a throwaway PostgreSQL.
 */
export function sslFor(hostname: string): false | { rejectUnauthorized: boolean } {
  const isLocal = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  return isLocal ? false : { rejectUnauthorized: false };
}

/** Mirrors PR #259's CATALOGUE_CODE_PATTERN — conservative persisted-code charset. */
export const CATALOGUE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function invalidCatalogueCode(field: "value" | "abbreviation", raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (v.length > 64) return `${field} "${v}" is too long — persisted codes are limited to 64 characters.`;
  if (!CATALOGUE_CODE_PATTERN.test(v)) return `${field} "${v}" is not a valid persisted code.`;
  return null;
}

// ── The canonical contract ──────────────────────────────────────────────────
// Mirrors DESIGNATION_LABELS in server/routes.ts and the pre-#259
// DESIGNATION_OPTIONS array. A test asserts this list matches both, so the
// three can never drift.
export interface DesignationSpec {
  value: string;
  code: string; // persisted code == abbreviation
  label: string;
  aliases: string[];
  description: string;
  allowCrossCategory: boolean;
}

export const CANONICAL_DESIGNATIONS: readonly DesignationSpec[] = [
  { value: "unlimited", code: "UNLIMITED", label: "Unlimited", aliases: ["unlimited", "unlimited print"], description: "Unlimited print run variant.", allowCrossCategory: true },
  { value: "first_edition", code: "FIRST_EDITION", label: "1st Edition", aliases: ["1st edition", "first edition", "1st ed"], description: "1st Edition marking (WOTC era).", allowCrossCategory: true },
  { value: "shadowless", code: "SHADOWLESS", label: "Shadowless", aliases: ["shadowless"], description: "WOTC shadowless print variant.", allowCrossCategory: true },
  { value: "promo", code: "PROMO", label: "Promo", aliases: ["promo", "promotional"], description: "Not from regular booster packs; promotional distribution.", allowCrossCategory: false },
  { value: "tournament_stamp", code: "TOURNAMENT_STAMP", label: "Tournament / Event Stamp", aliases: ["tournament stamp", "event stamp"], description: "Stamped for tournament/event (often has year/stamp).", allowCrossCategory: false },
  { value: "prerelease", code: "PRERELEASE", label: "Prerelease", aliases: ["prerelease", "pre-release"], description: "Prerelease stamp/marking.", allowCrossCategory: false },
  { value: "staff", code: "STAFF", label: "Staff", aliases: ["staff", "staff stamp"], description: "Staff stamp/edition.", allowCrossCategory: false },
  { value: "error_miscut", code: "ERROR_MISCUT", label: "Error / Miscut / Misprint", aliases: ["error", "miscut", "misprint", "mis-print", "error card"], description: "Manufacturing error; document clearly.", allowCrossCategory: false },
  { value: "japanese_print", code: "JAPANESE_PRINT", label: "Japanese Print", aliases: ["japanese print", "japanese"], description: "Card is Japanese (language should also be set).", allowCrossCategory: false },
  { value: "other_language", code: "OTHER_LANGUAGE", label: "Other Language", aliases: ["other language"], description: "Non-English/Japanese language print.", allowCrossCategory: false },
];

/**
 * Legacy rows that must be ARCHIVED (never deleted — archived rows keep their
 * code, stay readable, and are exempt from migration 0026's uniqueness rule).
 *   error / misprint → absorbed by ERROR_MISCUT (see its alias list)
 *   test_print       → test-only; never a historical persisted code
 */
export const LEGACY_TO_ARCHIVE: readonly string[] = ["error", "misprint", "test_print"];

/** The exact live-row inventory this script is approved to start from. */
export const APPROVED_BASELINE_VALUES: readonly string[] = [
  "unlimited", "first_edition", "shadowless", "error", "misprint", "test_print",
];

// ── Types ───────────────────────────────────────────────────────────────────
export interface CatalogueRow {
  id: number;
  category: string;
  value: string;
  label: string;
  abbreviation: string | null;
  aliases: string[] | null;
  description: string | null;
  sort_order: number;
  active: boolean;
  archived: boolean;
  allow_cross_category: boolean;
}

export type StartState = "baseline" | "reconciled" | "unknown";

export interface PlannedAction {
  kind: "update" | "create" | "archive";
  value: string;
  detail: string;
}

export interface Plan {
  state: StartState;
  actions: PlannedAction[];
  reason?: string;
}

// ── Pure planning logic (unit-testable, no DB) ──────────────────────────────

const liveDesignations = (rows: CatalogueRow[]): CatalogueRow[] =>
  rows.filter((r) => r.category === "designation" && r.active && !r.archived);

/**
 * Classify the starting inventory. Only two states are acceptable:
 *   baseline   — the approved pre-reconciliation six-row set
 *   reconciled — already reconciled (script becomes a no-op)
 * Anything else fails closed rather than guessing.
 */
export function classifyState(rows: CatalogueRow[]): StartState {
  const live = liveDesignations(rows);
  const liveValues = live.map((r) => r.value).sort();

  const baselineValues = [...APPROVED_BASELINE_VALUES].sort();
  const isBaseline =
    liveValues.length === baselineValues.length &&
    liveValues.every((v, i) => v === baselineValues[i]) &&
    live.every((r) => (r.abbreviation ?? "").trim() === "");
  if (isBaseline) return "baseline";

  const canonValues = CANONICAL_DESIGNATIONS.map((d) => d.value).sort();
  const archivedValues = rows
    .filter((r) => r.category === "designation" && r.archived)
    .map((r) => r.value)
    .sort();
  const isReconciled =
    liveValues.length === canonValues.length &&
    liveValues.every((v, i) => v === canonValues[i]) &&
    CANONICAL_DESIGNATIONS.every((d) => {
      const row = live.find((r) => r.value === d.value);
      return !!row && (row.abbreviation ?? "").trim().toUpperCase() === d.code;
    }) &&
    LEGACY_TO_ARCHIVE.every((v) => archivedValues.includes(v));
  if (isReconciled) return "reconciled";

  return "unknown";
}

/** Build the exact action list. Rows are resolved by (category, value) — never by id. */
export function buildPlan(rows: CatalogueRow[]): Plan {
  const state = classifyState(rows);
  if (state === "reconciled") return { state, actions: [], reason: "already reconciled — no-op" };
  if (state === "unknown") {
    const live = liveDesignations(rows)
      .map((r) => `${r.value}(abbr=${r.abbreviation ?? "null"})`)
      .join(", ");
    return {
      state,
      actions: [],
      reason: `live designation inventory does not match the approved baseline or the reconciled state. Found: [${live}]`,
    };
  }

  const actions: PlannedAction[] = [];
  const byValue = new Map(rows.filter((r) => r.category === "designation").map((r) => [r.value, r]));

  for (const spec of CANONICAL_DESIGNATIONS) {
    const existing = byValue.get(spec.value);
    if (existing) {
      if ((existing.abbreviation ?? "").trim().toUpperCase() !== spec.code) {
        actions.push({ kind: "update", value: spec.value, detail: `abbreviation ${existing.abbreviation ?? "null"} -> ${spec.code}` });
      }
    } else {
      actions.push({ kind: "create", value: spec.value, detail: `create designation ${spec.value} / ${spec.code} / "${spec.label}"` });
    }
  }
  for (const v of LEGACY_TO_ARCHIVE) {
    const existing = byValue.get(v);
    if (existing && !existing.archived) {
      actions.push({ kind: "archive", value: v, detail: `archive legacy row ${v} (id ${existing.id})` });
    }
  }
  return { state, actions };
}

/**
 * Validate the POST-state against the shared catalogue rules and migration
 * 0026's uniqueness policy. Returns a list of problems (empty === valid).
 */
export function validatePostState(rows: CatalogueRow[]): string[] {
  const problems: string[] = [];

  // Persisted-code character/length rules (shared validator).
  for (const spec of CANONICAL_DESIGNATIONS) {
    const bad = invalidCatalogueCode("abbreviation", spec.code) ?? invalidCatalogueCode("value", spec.value);
    if (bad) problems.push(bad);
  }

  // Simulate the end state.
  const simulated: CatalogueRow[] = rows
    .filter((r) => r.category !== "designation")
    .map((r) => ({ ...r }));
  for (const spec of CANONICAL_DESIGNATIONS) {
    const prior = rows.find((r) => r.category === "designation" && r.value === spec.value);
    simulated.push({
      id: prior?.id ?? -1,
      category: "designation",
      value: spec.value,
      label: spec.label,
      abbreviation: spec.code,
      aliases: spec.aliases,
      description: spec.description,
      sort_order: prior?.sort_order ?? 0,
      active: true,
      archived: false,
      allow_cross_category: spec.allowCrossCategory,
    });
  }
  for (const v of LEGACY_TO_ARCHIVE) {
    const prior = rows.find((r) => r.category === "designation" && r.value === v);
    if (prior) simulated.push({ ...prior, archived: true });
  }

  // Migration 0026: unique lower(abbreviation||value) over LIVE designation+attribute rows.
  const seen = new Map<string, string[]>();
  for (const r of simulated) {
    if (!(r.category === "designation" || r.category === "attribute")) continue;
    if (!r.active || r.archived) continue;
    const code = effectiveCatalogueCode({ value: r.value, abbreviation: r.abbreviation });
    if (!code) continue;
    seen.set(code, [...(seen.get(code) ?? []), r.value]);
  }
  for (const [code, owners] of seen) {
    if (owners.length > 1) problems.push(`duplicate live effective code "${code}" held by: ${owners.join(", ")}`);
  }

  // Shared cross-category / duplicate-value guard for every row we create.
  const asEntry = (r: CatalogueRow): CatalogueEntryLike => ({
    id: r.id,
    category: r.category,
    value: r.value,
    abbreviation: r.abbreviation,
    allowCrossCategory: r.allow_cross_category,
    active: r.active,
    archived: r.archived,
  });
  for (const spec of CANONICAL_DESIGNATIONS) {
    if (rows.some((r) => r.category === "designation" && r.value === spec.value)) continue; // existing row, not a create
    const candidate: CatalogueEntryLike = {
      category: "designation",
      value: spec.value,
      abbreviation: spec.code,
      allowCrossCategory: spec.allowCrossCategory,
      active: true,
      archived: false,
    };
    const conflict = catalogueConflict(rows.map(asEntry), candidate);
    if (conflict) problems.push(`create "${spec.value}": ${conflict}`);
  }

  return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
interface Args {
  environment: string | null;
  apply: boolean;
  confirmProduction: boolean;
  expectedAppSha: string | null;
  expectedDbHost: string | null;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  return {
    environment: get("environment"),
    apply: argv.includes("--apply"),
    confirmProduction: argv.includes("--confirm-production"),
    expectedAppSha: get("expected-app-sha"),
    expectedDbHost: get("expected-db-host"),
  };
}

const ENV_HOSTS: Record<string, string> = {
  staging: "https://mintvault-v2.fly.dev",
  production: "https://mintvault.fly.dev",
};

class GuardError extends Error {}

async function liveAppSha(environment: string): Promise<string> {
  const base = ENV_HOSTS[environment];
  const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new GuardError(`could not read ${base}/api/version (HTTP ${res.status})`);
  const body = (await res.json()) as { commit?: string };
  if (!body.commit) throw new GuardError(`${base}/api/version returned no commit`);
  return body.commit;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (s: string) => console.log(s);

  // ── Guard: environment must be explicit and known ─────────────────────────
  if (!args.environment || !(args.environment in ENV_HOSTS)) {
    throw new GuardError(`--environment must be one of: ${Object.keys(ENV_HOSTS).join(", ")}`);
  }
  const environment = args.environment;

  // ── Guard: production apply needs the extra confirmations ─────────────────
  if (args.apply && environment === "production" && !args.confirmProduction) {
    throw new GuardError("--confirm-production is required to apply to production");
  }
  if (args.apply && !args.expectedAppSha) {
    throw new GuardError("--expected-app-sha is required with --apply");
  }
  if (args.apply && !args.expectedDbHost) {
    throw new GuardError("--expected-db-host is required with --apply");
  }

  const url = process.env.MINTVAULT_DATABASE_URL;
  if (!url) throw new GuardError("MINTVAULT_DATABASE_URL is not set");
  const host = new URL(url).hostname;

  log(`── designation catalogue reconciliation ──`);
  log(`   environment : ${environment}`);
  log(`   mode        : ${args.apply ? "APPLY" : "DRY RUN (no writes)"}`);
  log(`   db host     : ${host}`); // host only — never the credentials

  // ── Guard: DB identity ────────────────────────────────────────────────────
  if (args.expectedDbHost && !host.includes(args.expectedDbHost)) {
    throw new GuardError(`db host "${host}" does not contain expected "${args.expectedDbHost}" — refusing`);
  }

  // ── Guard: application SHA ────────────────────────────────────────────────
  if (args.expectedAppSha) {
    const live = await liveAppSha(environment);
    const expectedShort = args.expectedAppSha.slice(0, live.length);
    if (live !== expectedShort) {
      throw new GuardError(`${environment} is running commit ${live}, expected ${expectedShort} — refusing`);
    }
    log(`   app commit  : ${live} (matches --expected-app-sha)`);
  }

  const client = new pg.Client({ connectionString: url, ssl: sslFor(host) });
  await client.connect();

  try {
    // ── Guard: catalogue_items must exist (migration 0019) ──────────────────
    const reg = await client.query(`SELECT to_regclass('public.catalogue_items')::text t`);
    if (!reg.rows[0].t) throw new GuardError("catalogue_items does not exist — apply migration 0019 first");

    // ── Guard: no certificate may carry a designation ──────────────────────
    const withDes = await client.query(
      `SELECT count(*)::int n FROM certificates WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb)) > 0`
    );
    const certTotal = await client.query(`SELECT count(*)::int n FROM certificates`);
    log(`   certificates: ${certTotal.rows[0].n} total, ${withDes.rows[0].n} with designations`);
    if (withDes.rows[0].n !== 0) {
      throw new GuardError(
        `${withDes.rows[0].n} certificate(s) already store a designation — this script is only approved for an empty-designation estate. STOP and re-review.`
      );
    }

    const rowsRes = await client.query<CatalogueRow>(
      `SELECT id, category, value, label, abbreviation, aliases, description,
              sort_order, active, archived, allow_cross_category
       FROM catalogue_items ORDER BY category, sort_order, id`
    );
    const rows = rowsRes.rows;

    log("");
    log("BEFORE — live designation rows:");
    for (const r of liveDesignations(rows)) log(`   ${r.value.padEnd(18)} abbr=${String(r.abbreviation)}`);

    const plan = buildPlan(rows);
    if (plan.state === "unknown") throw new GuardError(plan.reason ?? "unknown catalogue state");
    if (plan.state === "reconciled") {
      log("");
      log("✔ already reconciled — nothing to do (idempotent no-op).");
      return;
    }

    const problems = validatePostState(rows);
    if (problems.length) {
      throw new GuardError(`post-state validation failed:\n   - ${problems.join("\n   - ")}`);
    }

    log("");
    log(`PLAN (${plan.actions.length} actions):`);
    for (const a of plan.actions) log(`   [${a.kind.toUpperCase().padEnd(7)}] ${a.detail}`);

    if (!args.apply) {
      log("");
      log("DRY RUN — nothing was written. Re-run with --apply (plus the production flags) to execute.");
      return;
    }

    // ── Apply: ONE transaction, rolled back on any error ───────────────────
    const actor = `ops:reconcile-designation-catalogue`;
    const auditRow = async (action: string, category: string, value: string, details: unknown) =>
      client.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
         VALUES ('catalogue_item', $1, $2, $3, $4::jsonb)`,
        [`${category}:${value}`, action, actor, JSON.stringify(details)]
      );

    await client.query("BEGIN");
    try {
      for (const a of plan.actions) {
        const spec = CANONICAL_DESIGNATIONS.find((d) => d.value === a.value);
        if (a.kind === "update" && spec) {
          const before = rows.find((r) => r.category === "designation" && r.value === a.value);
          const upd = await client.query(
            `UPDATE catalogue_items SET abbreviation = $1, updated_by = $2, updated_at = now()
             WHERE category = 'designation' AND value = $3 RETURNING *`,
            [spec.code, actor, a.value]
          );
          if (upd.rowCount !== 1) throw new Error(`update ${a.value} affected ${upd.rowCount} rows`);
          await auditRow("catalogue_item_update", "designation", a.value, {
            oldValue: before, newValue: upd.rows[0], reason: "PR#259 canonical designation reconciliation",
          });
        } else if (a.kind === "create" && spec) {
          const ins = await client.query(
            `INSERT INTO catalogue_items
               (category, value, label, abbreviation, aliases, description, metadata,
                sort_order, active, archived, allow_cross_category, created_by, updated_by)
             VALUES ('designation', $1, $2, $3, $4::jsonb, $5, '{}'::jsonb,
                     (SELECT COALESCE(MAX(sort_order),-1)+1 FROM catalogue_items WHERE category='designation'),
                     TRUE, FALSE, $6, $7, $7)
             RETURNING *`,
            [spec.value, spec.label, spec.code, JSON.stringify(spec.aliases), spec.description, spec.allowCrossCategory, actor]
          );
          if (ins.rowCount !== 1) throw new Error(`create ${a.value} affected ${ins.rowCount} rows`);
          await auditRow("catalogue_item_create", "designation", a.value, { newValue: ins.rows[0] });
        } else if (a.kind === "archive") {
          const before = rows.find((r) => r.category === "designation" && r.value === a.value);
          const arc = await client.query(
            `UPDATE catalogue_items SET archived = TRUE, updated_by = $1, updated_at = now()
             WHERE category = 'designation' AND value = $2 RETURNING *`,
            [actor, a.value]
          );
          if (arc.rowCount !== 1) throw new Error(`archive ${a.value} affected ${arc.rowCount} rows`);
          await auditRow("catalogue_item_update", "designation", a.value, {
            oldValue: before, newValue: arc.rows[0], reason: "archived — superseded by ERROR_MISCUT / test-only",
          });
        }
      }

      // ── In-transaction post-check: 0026 uniqueness must hold ─────────────
      const dupes = await client.query(
        `SELECT lower(coalesce(nullif(btrim(abbreviation),''),btrim(value))) code, count(*) n
           FROM catalogue_items
          WHERE active = TRUE AND archived = FALSE
            AND category IN ('designation','attribute')
            AND btrim(coalesce(nullif(btrim(abbreviation),''),btrim(value))) <> ''
          GROUP BY 1 HAVING count(*) > 1`
      );
      if (dupes.rowCount !== 0) {
        throw new Error(`duplicate live effective codes after change: ${JSON.stringify(dupes.rows)}`);
      }
      const liveCount = await client.query(
        `SELECT count(*)::int n FROM catalogue_items WHERE category='designation' AND active AND NOT archived`
      );
      if (liveCount.rows[0].n !== CANONICAL_DESIGNATIONS.length) {
        throw new Error(`expected ${CANONICAL_DESIGNATIONS.length} live designations, found ${liveCount.rows[0].n}`);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const after = await client.query<CatalogueRow>(
      `SELECT value, abbreviation FROM catalogue_items
        WHERE category='designation' AND active AND NOT archived ORDER BY sort_order, id`
    );
    log("");
    log("AFTER — live designation rows:");
    for (const r of after.rows) log(`   ${r.value.padEnd(18)} abbr=${r.abbreviation}`);
    log("");
    log(`✔ committed ${plan.actions.length} actions in one transaction.`);
    log(`   next: rerun migration 0026 duplicate detection, then apply 0026 with scripts/db/migrate.ts --apply`);
  } finally {
    await client.end();
  }
}

// Only run when invoked directly (so tests can import the pure helpers).
const invokedDirectly =
  process.argv[1] !== undefined && /reconcile-designation-catalogue/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof GuardError ? `\n🚫 REFUSED: ${msg}` : `\n❌ FAILED: ${msg}`);
    process.exit(1);
  });
}

export { main, GuardError };
export const CONTRACT_FINGERPRINT = createHash("sha256")
  .update(CANONICAL_DESIGNATIONS.map((d) => `${d.value}:${d.code}:${d.label}`).join("|"))
  .digest("hex")
  .slice(0, 12);
