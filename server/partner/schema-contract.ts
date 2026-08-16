/**
 * Partner schema contract (invariant I18).
 *
 * WHY THIS EXISTS. Production is a MINIMUM two-Machine Fly deployment with rolling deploys, so a new
 * application version and the database schema are promoted by SEPARATE actions. When a version is
 * deployed against a database that has not yet received the migration it depends on, the failure is
 * currently invisible and actively misleading. The concrete case this module was written for:
 *
 *   `partner_users.password_set_at` is created by migration 0077. This application version requires
 *   it in FOUR places. Against a 0076 database the result is not one clear error but three unrelated
 *   ones at once — every partner login 503s as `credential_provenance_unavailable`, password-reset
 *   consume 500s on `undefined_column`, invitation-accept 500s the same way, and the Super Admin
 *   onboarding-readiness panel silently renders "LOGIN BLOCKED — add a partner user" for an
 *   organisation that has users. All three recovery routes are dead simultaneously and none of them
 *   names the cause.
 *
 * `scripts/db/preflight-schema.ts` does not catch this: it classifies OBJECTS (tables, views, enums,
 * sequences), not COLUMNS, so a table that exists with a missing column reads as present.
 *
 * WHAT IT DOES. Probes the specific columns, indexes and function projections this build requires,
 * and reports exactly which migration supplies anything missing. The partner surface then fails
 * closed with a diagnosable configuration error instead of a scatter of unrelated 401s and 500s.
 *
 * CACHING RULE (matches mount.ts's definer-health cache): only a HEALTHY verdict is cached, and only
 * for the process lifetime — the schema cannot change without a migration plus a redeploy. A missing
 * or transient-error verdict is never cached, so a one-off blip cannot permanently brick the surface
 * and an operator who applies the migration sees recovery on the next request without a restart.
 *
 * ADDING TO THIS CONTRACT. When a change depends on a new migration, add its requirement here in the
 * SAME commit. That is what makes "this version proves its own schema" true rather than aspirational.
 */
import { partnerRuntimeQuery } from "./db";

export interface SchemaRequirement {
  /** Human-readable description used verbatim in the operator-facing error. */
  readonly what: string;
  /** The migration file that supplies it — the actionable half of the message. */
  readonly migration: string;
  /** Returns true when the requirement is satisfied. */
  readonly probe: () => Promise<boolean>;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await partnerRuntimeQuery<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS present`,
    [table, column]
  );
  return rows[0]?.present === true;
}

async function indexExists(indexName: string): Promise<boolean> {
  const { rows } = await partnerRuntimeQuery<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1
     ) AS present`,
    [indexName]
  );
  return rows[0]?.present === true;
}

/**
 * Whether partner_auth_lookup() PROJECTS a named output column.
 *
 * The column existing on partner_users is not sufficient: the login path reads
 * `SELECT * FROM partner_auth_lookup($1)`, which returns exactly the columns the DEPLOYED FUNCTION
 * declares. 0077 both adds the column and re-declares the function; a database where only one of
 * those happened would pass a column-only probe and still refuse every login.
 */
async function functionProjects(functionName: string, outputColumn: string): Promise<boolean> {
  const { rows } = await partnerRuntimeQuery<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public'
          AND p.proname=$1
          AND $2 = ANY (p.proargnames)
     ) AS present`,
    [functionName, outputColumn]
  );
  return rows[0]?.present === true;
}

/** Everything THIS build requires beyond the schema its predecessor ran on. */
export const PARTNER_SCHEMA_CONTRACT: readonly SchemaRequirement[] = [
  {
    what: "column partner_users.password_set_at",
    migration: "0077_partner_credential_lifecycle_hardening.sql",
    probe: () => columnExists("partner_users", "password_set_at"),
  },
  {
    what: "partner_auth_lookup() projecting password_set_at",
    migration: "0077_partner_credential_lifecycle_hardening.sql",
    probe: () => functionProjects("partner_auth_lookup", "password_set_at"),
  },
  {
    what: "unique index uq_partner_password_reset_one_live (one live recovery link per user)",
    migration: "0077_partner_credential_lifecycle_hardening.sql",
    probe: () => indexExists("uq_partner_password_reset_one_live"),
  },
];

/*
 * DELIBERATELY NOT IN THE CONTRACT ABOVE: `partner_card_jobs` (migration 0080).
 *
 * It was added here first, and that was a design error caught by the test suite: this contract gates
 * the ENTIRE partner surface, so requiring a table that only the SUBMIT path needs took login,
 * /api/partner/me, the dashboard and every other route down with a 503 whenever 0080 was absent.
 * Measured, not theorised — it turned partner-mfa-enrolment-mandatory and partner-onboarding-matrix
 * red with `expected 503 to be 200`.
 *
 * The right scope for a surface-wide gate is schema the surface CANNOT FUNCTION WITHOUT — 0077's
 * auth projection genuinely gates every login, so it belongs. A submit-path dependency does not:
 * a partner with no Card Job table can still sign in, read their dashboard and see their credits,
 * and should. The submit path raises its own clear, migration-naming error instead (see
 * server/partner/submission-service.ts), which satisfies I18's real requirement — never a
 * MISLEADING failure — without over-blocking.
 */

export interface SchemaContractResult {
  ok: boolean;
  /** Populated only when ok === false. Each entry names the requirement AND its migration. */
  missing: string[];
  /** Set when the probe itself could not run (connectivity, permissions). Never cached. */
  error?: string;
}

let cachedHealthy = false;
let loggedContractProblem = false;

/**
 * Evaluate the contract. Only a healthy verdict is cached (see the caching rule above).
 * Never throws — a probe failure is reported, not raised, so this can be used inside a request gate.
 */
export async function checkPartnerSchemaContract(): Promise<SchemaContractResult> {
  if (cachedHealthy) return { ok: true, missing: [] };
  const missing: string[] = [];
  try {
    for (const requirement of PARTNER_SCHEMA_CONTRACT) {
      const satisfied = await requirement.probe();
      if (!satisfied) missing.push(`${requirement.what} (apply migrations/${requirement.migration})`);
    }
  } catch (err) {
    // Do NOT cache and do NOT claim the schema is bad — we could not tell. Fail closed at the gate.
    return { ok: false, missing: [], error: (err as Error).message };
  }
  if (missing.length === 0) {
    cachedHealthy = true;
    return { ok: true, missing: [] };
  }
  if (!loggedContractProblem) {
    loggedContractProblem = true;
    // eslint-disable-next-line no-console
    console.error(
      "[partner] SCHEMA CONTRACT UNSATISFIED — refusing to serve the partner surface. " +
        "This build requires schema this database does not have. Missing:\n  - " +
        missing.join("\n  - ") +
        "\nApply the migration(s) above with `npm run db:migrate -- --apply`, then this surface " +
        "recovers on the next request with no restart required."
    );
  }
  return { ok: false, missing };
}

/** Test-only: clear the cached healthy verdict so a test can re-evaluate after schema changes. */
export function __resetSchemaContractForTests(): void {
  cachedHealthy = false;
  loggedContractProblem = false;
}
