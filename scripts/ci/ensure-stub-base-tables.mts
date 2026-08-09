/**
 * Provision the MintVault base tables the partner migration suites need, in every CI database that
 * applies the FULL migration set.
 *
 * WHY THIS REPLACED INLINE psql IN ci.yml. The workflow used to create the stub inline as
 * `certificates (id serial, cert_id text, secret text)`. Migration 0049 then landed referencing
 * further certificates columns (a unique index, a composite FK, and 38 column-level grants), and
 * every one of the six full-set appliers died in beforeAll with a missing-column error.
 *
 * HISTORICAL NOTE, because the error message is now misleading: at the time, 0049 named
 * `certificates.submission_id`, and the fix was to make the stub supply it. That was the wrong
 * direction. No such column exists on staging, on production, or in shared/schema.ts, and no
 * migration ever created one — 0049 itself was undeployable, and the whole estate was green only
 * because fixtures invented the column. 0049 now keys on (id, submission_item_id) and the
 * requirement was removed from this script. Do not add it back to make something pass.
 *
 * and because a failed beforeAll makes vitest report the file's tests as SKIPPED, the surface
 * reading was "14 skipped" — which looks like configuration, not breakage. The execution-floor
 * assertions are what turned that into a hard failure instead of a quiet green.
 *
 * The real defect was DUPLICATION: the stub was hand-written in YAML while the suites built the
 * same tables through tests/helpers/partner-realistic-db.ts. Two definitions of one schema, so any
 * migration adding a certificates column breaks CI until someone remembers the YAML copy.
 *
 * So this imports the helper the suites already use. There is now ONE definition. A future
 * migration needing another column is fixed in one place and both paths follow.
 *
 * Deliberately NOT `drizzle-kit push` / the real schema: shared/schema.ts's certificates has no
 * `secret` column (these suites insert cert_id/secret and assert the row survives rollback) and
 * declares vector(1536), which the plain postgres:17 service cannot create. That was tried; the
 * stub pair is the correct option, not a shortcut.
 */
import pg from "pg";
import {
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
  MIGRATOR_ROLE,
  MIGRATOR_PASSWORD,
} from "../../tests/helpers/partner-realistic-db";

/** audit_log has no helper — the partner suites only ever need it to exist for migrations to write to. */
const AUDIT_LOG_DDL = `CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  admin_user text,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
)`;

/** Tables the migrations alter must be OWNED BY the non-superuser migrator, or DDL hits "must be owner of table". */
const OWNED_BY_MIGRATOR = ["audit_log", "certificates", "label_prints"];

function isLoopback(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

const varNames = process.argv.slice(2);
if (varNames.length === 0) {
  console.error("[stub-base-tables] usage: ensure-stub-base-tables.mts VAR_NAME [VAR_NAME...]");
  process.exit(1);
}

let failed = false;

for (const varName of varNames) {
  const url = process.env[varName];
  if (!url) {
    // Fail loudly. Silently skipping is how a suite ends up "passing" without its schema.
    console.error(`[stub-base-tables] ${varName} is not set`);
    failed = true;
    continue;
  }
  // These connections run DDL as an admin. Refuse anything that is not a disposable loopback
  // database, so a misconfigured CI env can never point this at real infrastructure.
  if (!isLoopback(url)) {
    console.error(`[stub-base-tables] ${varName} is not a loopback URL; refusing to run DDL against it`);
    failed = true;
    continue;
  }

  const admin = new pg.Client({ connectionString: url });
  try {
    await admin.connect();
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER CREATEROLE NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL; END$$;`
    );
    await admin.query(AUDIT_LOG_DDL);
    await createMintvaultCertificatesTable(admin);
    await createMintvaultLabelPrintsTable(admin);
    for (const table of OWNED_BY_MIGRATOR) {
      await admin.query(`ALTER TABLE ${table} OWNER TO ${MIGRATOR_ROLE}`);
    }

    // Prove the columns 0049 actually needs are present, rather than trusting that the helper ran.
    //
    // `submission_id` is deliberately NOT in this list. certificates has no such column — not on
    // staging, not on production, not in shared/schema.ts, and no migration ever created one. This
    // check used to require it, which made it the last place in the repository still asserting the
    // phantom shape that 0049, eleven runtime SQL sites, the connector's certificate INSERT and
    // fifteen fixtures also assumed. The canonical relation is
    // certificate -> submission_item_id -> submission_items.submission_id.
    const REQUIRED_CERT_COLUMNS = ["submission_item_id", "certificate_number", "grade"] as const;
    const { rows } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'certificates'
          AND column_name = ANY($1)`,
      [REQUIRED_CERT_COLUMNS as unknown as string[]]
    );
    const present = new Set(rows.map((r) => r.column_name));
    const missing = REQUIRED_CERT_COLUMNS.filter((c) => !present.has(c));
    if (missing.length > 0) {
      // Almost always a STALE database: the helper uses CREATE TABLE IF NOT EXISTS, which silently
      // no-ops against a certificates table left over from before a migration added columns. CI
      // runners are ephemeral so this should not occur there; locally it means "drop and recreate
      // this database". Reported loudly rather than repaired in place, because adding the columns
      // here would reintroduce the second schema definition this script exists to remove.
      console.error(
        `[stub-base-tables] ${varName}: certificates is missing ${missing.join(", ")} — ` +
          `the database almost certainly pre-dates a migration that added them. Drop and recreate it.`
      );
      failed = true;
      continue;
    }
    console.log(`[stub-base-tables] ${varName}: base tables ready`);
  } catch (err) {
    console.error(`[stub-base-tables] ${varName}: ${(err as Error).message}`);
    failed = true;
  } finally {
    await admin.end().catch(() => {});
  }
}

process.exit(failed ? 1 : 0);
