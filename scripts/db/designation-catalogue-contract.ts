/**
 * designation-catalogue-contract.ts — the single source of truth shared by
 * scripts/db/reconcile-designation-catalogue.ts,
 * scripts/db/rollback-designation-catalogue.ts and
 * scripts/db/export-catalogue-backup.ts.
 *
 * Holds the environment↔database binding, the canonical designation contract,
 * the hardened CLI parsing, and the pure planning logic. Keeping all three in
 * one module is what stops the reconcile and rollback paths drifting apart.
 *
 * This module performs NO I/O and touches nothing outside `catalogue_items`
 * reasoning. It never reads certificates, grading, MVGS, Pristine/P10,
 * centering, labels or certificate rendering.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ── Environment ↔ database binding ──────────────────────────────────────────
/**
 * HOSTILE-REVIEW CRITICAL FIX.
 *
 * Previously `--environment` only chose which `/api/version` URL to poll; the
 * database came solely from MINTVAULT_DATABASE_URL, so a production URL run
 * with `--environment staging` skipped `--confirm-production` entirely, and the
 * host guard used substring matching (`ep-`, `neon`, `pooler` … all matched
 * BOTH environments).
 *
 * The mapping below is owned by the SCRIPT, not the operator. The hostname
 * parsed from MINTVAULT_DATABASE_URL must match the configured host for the
 * selected environment by EXACT string equality — never substring, prefix or
 * suffix — so an environment label can no longer be attached to the wrong
 * database.
 *
 * These are hostnames only. They contain no credentials.
 *
 * `local-test` exists so the CLI itself can be exercised end-to-end against a
 * disposable cluster. It is bound to 127.0.0.1 by the same exact-equality rule,
 * so it can never resolve to a managed database.
 */
export interface EnvironmentContract {
  readonly key: string;
  /** Public base URL used to verify the running application commit. */
  readonly appBaseUrl: string | null;
  /** The ONLY database hostname this environment may ever touch. */
  readonly dbHost: string;
  /** Whether `--confirm-production` is mandatory for `--apply`. */
  readonly requiresProductionConfirmation: boolean;
}

export const ENVIRONMENTS: Readonly<Record<string, EnvironmentContract>> = {
  staging: {
    key: "staging",
    appBaseUrl: "https://mintvault-v2.fly.dev",
    dbHost: "ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech",
    requiresProductionConfirmation: false,
  },
  production: {
    key: "production",
    appBaseUrl: "https://mintvault.fly.dev",
    dbHost: "ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech",
    requiresProductionConfirmation: true,
  },
  "local-test": {
    key: "local-test",
    appBaseUrl: null, // no deployed app to verify
    dbHost: "127.0.0.1",
    requiresProductionConfirmation: false,
  },
};

export const ENVIRONMENT_KEYS = Object.keys(ENVIRONMENTS);

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/**
 * Parse the hostname from a database URL. Never returns, logs or embeds the URL
 * itself — a malformed URL yields a generic message so credentials can never
 * reach a log line or an exception string.
 */
export function parseDbHostname(rawUrl: string | undefined): string {
  if (!rawUrl || rawUrl.trim() === "") {
    throw new GuardError("MINTVAULT_DATABASE_URL is not set");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GuardError("MINTVAULT_DATABASE_URL is not a parseable URL (value withheld)");
  }
  const host = url.hostname;
  if (!host || host.trim() === "") {
    throw new GuardError("MINTVAULT_DATABASE_URL has no hostname (value withheld)");
  }
  if (host !== host.trim()) {
    throw new GuardError("MINTVAULT_DATABASE_URL hostname has surrounding whitespace");
  }
  return host;
}

/**
 * THE binding guard. Exact equality on every comparison.
 *
 * @param environmentKey the `--environment` value
 * @param actualHost     hostname parsed from MINTVAULT_DATABASE_URL
 * @param expectedDbHost optional `--expected-db-host` operator confirmation
 */
export function assertEnvironmentBinding(
  environmentKey: string,
  actualHost: string,
  expectedDbHost: string | null,
): EnvironmentContract {
  const env = ENVIRONMENTS[environmentKey];
  if (!env) {
    throw new GuardError(`--environment must be one of: ${ENVIRONMENT_KEYS.join(", ")}`);
  }
  if (actualHost !== env.dbHost) {
    throw new GuardError(
      `database host does not belong to "${environmentKey}".\n` +
        `   expected exactly : ${env.dbHost}\n` +
        `   actual           : ${actualHost}\n` +
        `   Refusing — the environment label and the database must match exactly.`,
    );
  }
  if (expectedDbHost !== null) {
    if (expectedDbHost !== env.dbHost) {
      throw new GuardError(
        `--expected-db-host does not equal the configured host for "${environmentKey}".\n` +
          `   configured : ${env.dbHost}\n` +
          `   supplied   : ${expectedDbHost}`,
      );
    }
    if (expectedDbHost !== actualHost) {
      throw new GuardError(
        `--expected-db-host does not equal the actual database hostname.\n` +
          `   supplied : ${expectedDbHost}\n` +
          `   actual   : ${actualHost}`,
      );
    }
  }
  return env;
}

/** SSL policy, matching `server/db.ts`. */
export function sslFor(hostname: string): false | { rejectUnauthorized: boolean } {
  const isLocal = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  return isLocal ? false : { rejectUnauthorized: false };
}

// ── Persisted-code helpers ──────────────────────────────────────────────────
/**
 * Byte-equivalent to migration 0026's SQL
 * `lower(coalesce(nullif(btrim(abbreviation),''), btrim(value)))` and to PR
 * #259's shared helper. Defined locally because this package must run against
 * production while production is still on `main`, where the shared helper does
 * not exist. A test pins the equivalence against a real PostgreSQL cluster.
 */
export function effectiveCatalogueCode(row: { value?: string | null; abbreviation?: string | null }): string {
  const abbr = (row.abbreviation ?? "").trim();
  return (abbr || (row.value ?? "").trim()).toLowerCase();
}

export const CATALOGUE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function invalidCatalogueCode(field: "value" | "abbreviation", raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (v.length > 64) return `${field} "${v}" is too long — persisted codes are limited to 64 characters.`;
  if (!CATALOGUE_CODE_PATTERN.test(v)) return `${field} "${v}" is not a valid persisted code.`;
  return null;
}

// ── The canonical designation contract ──────────────────────────────────────
/**
 * The FULL approved row contract — not just the abbreviation. Sourced from the
 * pre-#259 `client/src/lib/designationOptions.ts` (codes, labels, help text)
 * and `DESIGNATION_LABELS` in `server/routes.ts` (codes + labels). Aliases and
 * the cross-category flags come from `scripts/db/seed-catalogue.ts`. Nothing
 * here is invented; a test asserts the codes and labels against both sources.
 */
export interface DesignationSpec {
  readonly value: string;
  readonly code: string; // persisted code == abbreviation
  readonly label: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly allowCrossCategory: boolean;
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

/** Legacy rows archived (never deleted) — absorbed by ERROR_MISCUT / test-only. */
export const LEGACY_TO_ARCHIVE: readonly string[] = ["error", "misprint", "test_print"];

/** The only live inventory this package is approved to start from. */
export const APPROVED_BASELINE_VALUES: readonly string[] = [
  "unlimited", "first_edition", "shadowless", "error", "misprint", "test_print",
];

/** Rows the reconciliation CREATES — the only rows rollback may ever delete. */
export const CREATED_BY_RECONCILIATION: readonly string[] = CANONICAL_DESIGNATIONS
  .map((d) => d.value)
  .filter((v) => !APPROVED_BASELINE_VALUES.includes(v));

/** Canonical rows that already exist in the baseline and are only UPDATED. */
export const PRE_EXISTING_CANONICAL: readonly string[] = CANONICAL_DESIGNATIONS
  .map((d) => d.value)
  .filter((v) => APPROVED_BASELINE_VALUES.includes(v));

/** The audit actor stamped on every row this package creates. */
export const RECONCILE_ACTOR = "ops:reconcile-designation-catalogue";
export const ROLLBACK_ACTOR = "ops:rollback-designation-catalogue";

// ── Row shape ───────────────────────────────────────────────────────────────
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
  created_by: string | null;
}

export type StartState = "baseline" | "reconciled" | "unknown";

export interface FieldDrift {
  field: string;
  from: unknown;
  to: unknown;
}

export interface PlannedAction {
  kind: "update" | "create" | "archive";
  value: string;
  detail: string;
  drift?: FieldDrift[];
}

export interface Plan {
  state: StartState;
  actions: PlannedAction[];
  reason?: string;
}

const designationRows = (rows: CatalogueRow[]): CatalogueRow[] => rows.filter((r) => r.category === "designation");
const liveDesignations = (rows: CatalogueRow[]): CatalogueRow[] =>
  designationRows(rows).filter((r) => r.active && !r.archived);

const sameStringSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Every contract field that differs between a stored row and its spec.
 * `abbreviation` is compared case-sensitively because it is the PERSISTED CODE.
 */
export function contractDrift(row: CatalogueRow, spec: DesignationSpec): FieldDrift[] {
  const drift: FieldDrift[] = [];
  if ((row.abbreviation ?? "") !== spec.code) drift.push({ field: "abbreviation", from: row.abbreviation, to: spec.code });
  if (row.label !== spec.label) drift.push({ field: "label", from: row.label, to: spec.label });
  if ((row.description ?? "") !== spec.description) drift.push({ field: "description", from: row.description, to: spec.description });
  if (row.allow_cross_category !== spec.allowCrossCategory) {
    drift.push({ field: "allow_cross_category", from: row.allow_cross_category, to: spec.allowCrossCategory });
  }
  if (!sameStringSet(row.aliases ?? [], spec.aliases)) drift.push({ field: "aliases", from: row.aliases, to: [...spec.aliases] });
  if (!row.active) drift.push({ field: "active", from: row.active, to: true });
  if (row.archived) drift.push({ field: "archived", from: row.archived, to: false });
  return drift;
}

/**
 * Classify the starting inventory. Only two states are acceptable; everything
 * else fails closed rather than guessing.
 *
 *   baseline   — exactly the six approved rows, all live, NO abbreviation set.
 *                Label / alias / description drift IS permitted here: those are
 *                safe canonical differences the reconciliation corrects.
 *   reconciled — the ten canonical rows live with EVERY contract field matching,
 *                the three legacy rows archived, and no other designation rows.
 *
 * Deliberately fails closed on:
 *   • an abbreviation already set on a baseline row (the persisted code is the
 *     one field we must never silently overwrite);
 *   • an ARCHIVED canonical row (resurrecting one is not an approved rule);
 *   • any unexpected extra designation row.
 */
export function classifyState(rows: CatalogueRow[]): { state: StartState; reason?: string } {
  const all = designationRows(rows);
  const live = liveDesignations(rows);
  const canonicalValues = CANONICAL_DESIGNATIONS.map((d) => d.value);

  // An archived canonical row is ambiguous — detected in PREFLIGHT, not late.
  const archivedCanonical = all.filter((r) => r.archived && canonicalValues.includes(r.value));
  if (archivedCanonical.length > 0) {
    return {
      state: "unknown",
      reason:
        `archived canonical designation row(s) present: ` +
        `${archivedCanonical.map((r) => `${r.value}(id ${r.id})`).join(", ")}. ` +
        `Resurrecting an archived canonical row is not an approved operation — resolve manually.`,
    };
  }

  // ── baseline ──
  const baselineSorted = [...APPROVED_BASELINE_VALUES].sort();
  const allValuesSorted = all.map((r) => r.value).sort();
  if (sameStringSet(allValuesSorted, baselineSorted) && all.every((r) => r.active && !r.archived)) {
    const withAbbr = all.filter((r) => (r.abbreviation ?? "").trim() !== "");
    if (withAbbr.length > 0) {
      return {
        state: "unknown",
        reason:
          `baseline row(s) already carry an abbreviation: ` +
          `${withAbbr.map((r) => `${r.value}=${r.abbreviation}`).join(", ")}. ` +
          `The persisted code must never be silently overwritten — resolve manually.`,
      };
    }
    return { state: "baseline" };
  }

  // ── reconciled ──
  const liveValuesSorted = live.map((r) => r.value).sort();
  const canonSorted = [...canonicalValues].sort();
  const archivedValues = all.filter((r) => r.archived).map((r) => r.value).sort();
  const expectedArchived = [...LEGACY_TO_ARCHIVE].sort();
  if (
    sameStringSet(liveValuesSorted, canonSorted) &&
    sameStringSet(archivedValues, expectedArchived) &&
    all.length === canonicalValues.length + LEGACY_TO_ARCHIVE.length
  ) {
    const drifted = CANONICAL_DESIGNATIONS.flatMap((spec) => {
      const row = live.find((r) => r.value === spec.value);
      if (!row) return [`${spec.value} missing`];
      const d = contractDrift(row, spec);
      return d.length ? [`${spec.value}: ${d.map((x) => x.field).join("/")}`] : [];
    });
    if (drifted.length === 0) return { state: "reconciled" };
    return {
      state: "unknown",
      reason: `ten canonical rows present but contract fields drifted: ${drifted.join("; ")}`,
    };
  }

  return {
    state: "unknown",
    reason:
      `designation inventory matches neither the approved baseline nor the reconciled state. ` +
      `Live: [${live.map((r) => `${r.value}(abbr=${r.abbreviation ?? "null"})`).join(", ")}]` +
      (archivedValues.length ? ` Archived: [${archivedValues.join(", ")}]` : ""),
  };
}

/** Build the exact action list. Rows are resolved by (category, value) — never by id. */
export function buildPlan(rows: CatalogueRow[]): Plan {
  const { state, reason } = classifyState(rows);
  if (state === "reconciled") return { state, actions: [], reason: "already reconciled — no-op" };
  if (state === "unknown") return { state, actions: [], reason };

  const actions: PlannedAction[] = [];
  const byValue = new Map(designationRows(rows).map((r) => [r.value, r]));

  for (const spec of CANONICAL_DESIGNATIONS) {
    const existing = byValue.get(spec.value);
    if (existing) {
      const drift = contractDrift(existing, spec);
      if (drift.length > 0) {
        actions.push({
          kind: "update",
          value: spec.value,
          detail: `reconcile ${spec.value} → ${drift.map((d) => d.field).join(", ")}`,
          drift,
        });
      }
    } else {
      actions.push({ kind: "create", value: spec.value, detail: `create ${spec.value} / ${spec.code} / "${spec.label}"` });
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

/** Validate the POST-state against the shared rules and migration 0026's policy. */
export function validatePostState(
  rows: CatalogueRow[],
  catalogueConflict: (existing: CatalogueEntryLike[], candidate: CatalogueEntryLike, excludeId?: number) => string | null,
): string[] {
  const problems: string[] = [];

  for (const spec of CANONICAL_DESIGNATIONS) {
    const bad = invalidCatalogueCode("abbreviation", spec.code) ?? invalidCatalogueCode("value", spec.value);
    if (bad) problems.push(bad);
  }

  const simulated: CatalogueRow[] = rows.filter((r) => r.category !== "designation").map((r) => ({ ...r }));
  for (const spec of CANONICAL_DESIGNATIONS) {
    const prior = rows.find((r) => r.category === "designation" && r.value === spec.value);
    simulated.push({
      id: prior?.id ?? -1,
      category: "designation",
      value: spec.value,
      label: spec.label,
      abbreviation: spec.code,
      aliases: [...spec.aliases],
      description: spec.description,
      sort_order: prior?.sort_order ?? 0,
      active: true,
      archived: false,
      allow_cross_category: spec.allowCrossCategory,
      created_by: prior?.created_by ?? RECONCILE_ACTOR,
    });
  }
  for (const v of LEGACY_TO_ARCHIVE) {
    const prior = rows.find((r) => r.category === "designation" && r.value === v);
    if (prior) simulated.push({ ...prior, archived: true });
  }

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

  const asEntry = (r: CatalogueRow): CatalogueEntryLike => ({
    id: r.id,
    category: r.category,
    value: r.value,
    abbreviation: r.abbreviation,
    allowCrossCategory: r.allow_cross_category,
  });
  for (const spec of CANONICAL_DESIGNATIONS) {
    if (rows.some((r) => r.category === "designation" && r.value === spec.value)) continue;
    const conflict = catalogueConflict(rows.map(asEntry), {
      category: "designation",
      value: spec.value,
      abbreviation: spec.code,
      allowCrossCategory: spec.allowCrossCategory,
    });
    if (conflict) problems.push(`create "${spec.value}": ${conflict}`);
  }
  return problems;
}

export interface CatalogueEntryLike {
  id?: number;
  category: string;
  value: string;
  label?: string;
  abbreviation?: string | null;
  aliases?: string[] | null;
  description?: string | null;
  allowCrossCategory?: boolean;
}

/**
 * Stable fingerprint of the designation inventory. Compared between the
 * preflight read and the in-transaction locked read so a concurrent catalogue
 * edit aborts the run instead of silently applying a stale plan.
 */
export function inventoryFingerprint(rows: CatalogueRow[]): string {
  return designationRows(rows)
    .map((r) =>
      [r.value, r.abbreviation ?? "", r.label, r.description ?? "", r.active ? "1" : "0", r.archived ? "1" : "0",
        r.allow_cross_category ? "1" : "0", [...(r.aliases ?? [])].sort().join("|"), r.created_by ?? ""].join(""),
    )
    .sort()
    .join("");
}

// ── Hardened CLI parsing (shared by all three scripts) ──────────────────────
export interface ParsedArgs {
  environment: string | null;
  apply: boolean;
  confirmProduction: boolean;
  expectedAppSha: string | null;
  expectedDbHost: string | null;
  outDir: string | null;
  forceOverwrite: boolean;
}

const VALUE_FLAGS = ["environment", "expected-app-sha", "expected-db-host", "out-dir"] as const;
const BOOL_FLAGS = ["apply", "confirm-production", "force-overwrite"] as const;

/**
 * Rejects duplicate flags, missing values, unknown flags and whitespace-bearing
 * values rather than silently taking the first/last occurrence.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const seen = new Map<string, number>();
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new GuardError(`unexpected argument "${token}" — every option must start with --`);
    }
    const name = token.slice(2);
    const isValueFlag = (VALUE_FLAGS as readonly string[]).includes(name);
    const isBoolFlag = (BOOL_FLAGS as readonly string[]).includes(name);
    if (!isValueFlag && !isBoolFlag) {
      throw new GuardError(`unknown flag --${name}`);
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if ((seen.get(name) ?? 0) > 1) {
      throw new GuardError(`flag --${name} supplied more than once — refusing (ambiguous)`);
    }
    if (isValueFlag) {
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new GuardError(`--${name} requires a value`);
      }
      if (raw !== raw.trim() || /\s/.test(raw)) {
        throw new GuardError(`--${name} value must not contain whitespace`);
      }
      values.set(name, raw);
      i++;
    }
  }

  const args: ParsedArgs = {
    environment: values.get("environment") ?? null,
    apply: seen.has("apply"),
    confirmProduction: seen.has("confirm-production"),
    expectedAppSha: values.get("expected-app-sha") ?? null,
    expectedDbHost: values.get("expected-db-host") ?? null,
    outDir: values.get("out-dir") ?? null,
    forceOverwrite: seen.has("force-overwrite"),
  };

  // Conflicting arguments: confirming production while naming another environment.
  if (args.confirmProduction && args.environment !== null && args.environment !== "production") {
    throw new GuardError(
      `--confirm-production supplied with --environment ${args.environment} — conflicting arguments, refusing`,
    );
  }
  return args;
}

// ── SHA validation ──────────────────────────────────────────────────────────
export const MIN_SHA_LENGTH = 7;
const HEX = /^[0-9a-f]+$/;

export function normaliseSha(raw: string, flag = "--expected-app-sha"): string {
  const v = raw.toLowerCase();
  if (!HEX.test(v)) throw new GuardError(`${flag} must be hexadecimal`);
  if (v.length < MIN_SHA_LENGTH) throw new GuardError(`${flag} must be at least ${MIN_SHA_LENGTH} hex characters`);
  if (v.length > 40) throw new GuardError(`${flag} must be at most 40 hex characters`);
  return v;
}

export interface ShaVerdict {
  ok: boolean;
  message: string;
  /** How many characters of the expected SHA the live endpoint could confirm. */
  verifiedChars: number;
  /** True when the FULL supplied SHA was confirmed (via git), not just a prefix. */
  fullyVerified: boolean;
}

/**
 * Compare a supplied SHA against the live `/api/version` commit.
 *
 * `/api/version` publishes only a SHORT sha, so a full 40-character value
 * cannot be confirmed end-to-end from HTTP alone. Rather than silently
 * truncating, this reports exactly how many characters were verified, and the
 * caller additionally confirms the full value against git when a full SHA is
 * supplied (see `verifyFullShaAgainstGit`).
 */
export function compareSha(expected: string, live: string): ShaVerdict {
  const e = expected.toLowerCase();
  const l = live.toLowerCase().trim();
  if (!HEX.test(l)) return { ok: false, message: `live /api/version commit "${live}" is not hexadecimal`, verifiedChars: 0, fullyVerified: false };
  if (e.length < l.length) {
    return {
      ok: false,
      message: `--expected-app-sha (${e.length} chars) is shorter than the live commit (${l.length} chars) — supply at least the full short SHA`,
      verifiedChars: 0,
      fullyVerified: false,
    };
  }
  const prefix = e.slice(0, l.length);
  if (prefix !== l) {
    return { ok: false, message: `live commit is ${l}, expected ${prefix}`, verifiedChars: 0, fullyVerified: false };
  }
  return {
    ok: true,
    message: e.length === l.length ? `matched (${l.length} chars)` : `first ${l.length} of ${e.length} chars matched via /api/version`,
    verifiedChars: l.length,
    fullyVerified: e.length === l.length,
  };
}

// ── Backup path safety ──────────────────────────────────────────────────────
export const DEFAULT_BACKUP_DIR = "mintvault-production-backups";

/**
 * Refuse a backup destination that is inside the repository, is (or traverses)
 * a symlink, or would overwrite an existing file without an explicit override.
 */
export function assertSafeBackupPath(
  target: string,
  repoRoot: string,
  opts: { forceOverwrite: boolean },
): string {
  if (!isAbsolute(target)) throw new GuardError(`backup path must be absolute: ${target}`);
  const resolved = resolve(target);
  const realRepo = existsSync(repoRoot) ? realpathSync(repoRoot) : resolve(repoRoot);

  const insideRepo = (p: string) => p === realRepo || p.startsWith(realRepo + sep);

  // Literal containment.
  if (insideRepo(resolved)) {
    throw new GuardError(
      `refusing to write a backup inside the repository (${resolved}). Use --out-dir outside the repo.`,
    );
  }

  // Symlink REDIRECTION: resolve the deepest existing ancestor and re-derive
  // the true destination. This catches "out/link-to-repo/backup.json" without
  // falsely rejecting benign platform symlinks in the path (on macOS /var is a
  // symlink to /private/var, so every tmpdir and many home paths contain one —
  // rejecting any ancestor symlink would refuse legitimate destinations).
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existsSync(ancestor)) {
    const realAncestor = realpathSync(ancestor);
    const realDestination = resolve(realAncestor, relative(ancestor, resolved));
    if (insideRepo(realDestination)) {
      throw new GuardError(`refusing: "${resolved}" resolves inside the repository via a symlink`);
    }
  }

  // The destination file itself must never be a symlink — writing through one
  // would silently clobber whatever it points at.
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new GuardError(`refusing: "${resolved}" is a symlink`);
  }

  if (existsSync(resolved) && !opts.forceOverwrite) {
    throw new GuardError(`backup file already exists: ${resolved} — pass --force-overwrite to replace it`);
  }
  return resolved;
}

/** `catalogue-backup-<environment>-<timestamp>.json` */
export function backupFilename(environment: string, isoTimestamp: string): string {
  const stamp = isoTimestamp.replace(/[:.]/g, "-");
  return `catalogue-backup-${environment}-${stamp}.json`;
}
