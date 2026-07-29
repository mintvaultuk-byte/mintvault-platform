/**
 * Test helper (DB-F1): apply the Partner Network migrations under a REALISTIC role model, so the
 * SECURITY DEFINER functions are NOT owned by a superuser in the runtime proof.
 *
 * Role layout (mirrors managed Postgres, e.g. Neon):
 *   - cluster admin / superuser: creates DB + roles only (the `admin` client passed in).
 *   - pn_migrator:   NON-superuser, NON-BYPASSRLS, owns the schema + tables (applies ordinary migrations).
 *   - deployment owner: the elevated `admin` connection passed to this helper. It applies only
 *                       migrations that must create/revoke membership in a BYPASSRLS definer role.
 *   - partner_definer: NOLOGIN, NON-superuser, BYPASSRLS — provisioned by the elevated admin, owns
 *                      ONLY the three pre-auth SECURITY DEFINER functions (reassigned by 0006).
 *   - partner_runtime: NON-superuser, NOBYPASSRLS — created by migration 0001, execute-only.
 *
 * Using this instead of applying migrations as a superuser is what makes the DB-F1 proof real:
 * with a non-superuser table/function owner, the pre-auth lookups only return rows because
 * partner_definer (BYPASSRLS) owns them — exactly the production condition.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const PARTNER_MIGRATIONS = [
  "0001_partner_foundation",
  "0002_partner_auth_support",
  "0003_partner_auth_hardening",
  "0004_partner_mfa_enrol",
  "0005_partner_mfa_replay_and_grants",
  "0006_partner_definer_role",
  "0007_partner_submissions",
  "0008_partner_connector_foundation",
  "0009_partner_connector_validation",
] as const;

/**
 * G3 (migration 0010) is deliberately NOT in PARTNER_MIGRATIONS above — 0010 grants
 * partner_connector_runtime access to the MintVault-internal `users`/`submissions`/
 * `submission_items` tables, which must already exist before it runs. Every EXISTING G1/G2 test
 * file calls applyMigrationsRealistic() without creating those tables (they don't need G3's schema
 * at all) — silently requiring them there would be an unrelated regression for every G1/G2 test.
 * G3 test files call this instead, which requires the caller to have already created those three
 * tables (see tests/partner-connector-import-service.test.ts's seedMintVaultTables()).
 */
export const PARTNER_MIGRATIONS_WITH_G3 = [...PARTNER_MIGRATIONS, "0010_partner_connector_import"] as const;

/** G3E (0011) also needs users/submissions/submission_items pre-created — same reason as G3. */
export const PARTNER_MIGRATIONS_WITH_G3E = [
  ...PARTNER_MIGRATIONS_WITH_G3,
  "0011_partner_connector_reconciliation",
] as const;

/** G3F — append-only import-attempt evidence table (0012) + hot-path claim-index correction (0013). */
export const PARTNER_MIGRATIONS_WITH_G3F = [
  ...PARTNER_MIGRATIONS_WITH_G3E,
  "0012_partner_connector_import_attempts",
  "0013_partner_connector_claim_index",
] as const;

/** G4 — append-only Super-Admin operational-action audit table (0014). */
export const PARTNER_MIGRATIONS_WITH_G4 = [
  ...PARTNER_MIGRATIONS_WITH_G3F,
  "0014_partner_connector_admin_actions",
] as const;

/** G5 — internal Super-Admin partner-management tables (0015). */
export const PARTNER_MIGRATIONS_WITH_G5 = [...PARTNER_MIGRATIONS_WITH_G4, "0015_partner_management"] as const;

/**
 * G6A — partner wallet + immutable append-only credit ledger (0016). Like the G3+ lists this includes
 * 0010, so callers must pre-create users/submissions/submission_items before applying (0010 grants on
 * them). See tests/partner-wallet-migration.test.ts's seedMintVaultTables().
 */
export const PARTNER_MIGRATIONS_WITH_G6A = [...PARTNER_MIGRATIONS_WITH_G5, "0016_partner_wallet_ledger"] as const;

/** G6B — partner credit reservation lifecycle + append-only reservation event evidence. */
export const PARTNER_MIGRATIONS_WITH_G6B = [
  ...PARTNER_MIGRATIONS_WITH_G6A,
  "0017_partner_credit_reservations",
] as const;

/** G6D — Partner submission credit reservation, consumption and release integration. */
export const PARTNER_MIGRATIONS_WITH_G6D = [
  ...PARTNER_MIGRATIONS_WITH_G6B,
  "0018_correction_audit_index",
  "0027_partner_submission_credit_lifecycle",
] as const;

export const MIGRATOR_ROLE = "pn_migrator";
export const MIGRATOR_PASSWORD = "realistic-migrator-pw"; // synthetic, disposable-DB only

/**
 * Migrations whose SECURITY DEFINER ownership transfer has to be performed by the governed
 * deployment owner. PostgreSQL 16+ tracks membership grantors, so a restricted migration login
 * cannot safely grant and revoke membership in a BYPASSRLS definer that it does not administer.
 */
export const DEPLOYMENT_OWNER_MIGRATIONS = new Set(["0027_partner_submission_credit_lifecycle"]);

export interface RealisticMigrationExecution {
  restrictedMigrator: string[];
  deploymentOwner: string[];
}

function migrationSql(name: string): string {
  return readFileSync(join(process.cwd(), "migrations", `${name}.sql`), "utf8");
}

/** Provision the realistic roles using an already-connected SUPERUSER admin client. Idempotent. */
export async function provisionRealisticRoles(admin: pg.Client): Promise<void> {
  const roleProvisionLock = 4_150_206;
  await admin.query("SELECT pg_advisory_lock($1)", [roleProvisionLock]);
  try {
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER CREATEROLE NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END$$;`
    );
    // Elevated one-time provisioning of the BYPASSRLS definer role (the documented requirement).
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END$$;`
    );
    await admin.query("GRANT partner_definer TO " + MIGRATOR_ROLE);
    // pn_migrator owns the schema (as a managed-PG project owner would) so it can grant schema USAGE.
    await admin.query("ALTER SCHEMA public OWNER TO " + MIGRATOR_ROLE);
    const { rows } = await admin.query<{ db: string }>("SELECT current_database() AS db");
    await admin.query(`GRANT CREATE ON DATABASE "${rows[0].db}" TO ${MIGRATOR_ROLE}`);
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [roleProvisionLock]).catch(() => {});
  }
}

/** Build a pn_migrator connection URL from a superuser admin URL (same host/port/db). */
export function migratorUrlFrom(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = MIGRATOR_ROLE;
  u.password = MIGRATOR_PASSWORD;
  return u.toString();
}

/**
 * Full realistic setup: provision roles, apply ordinary Partner migrations as the NON-superuser
 * pn_migrator, then apply any owner-operated migration as the elevated deployment owner. `admin`
 * must be connected to the target disposable DB; production uses the same role split through the
 * governed numbered migration runner, not this test helper.
 */
export async function applyMigrationsRealistic(
  admin: pg.Client,
  adminUrl: string,
  migrations: readonly string[] = PARTNER_MIGRATIONS
): Promise<RealisticMigrationExecution> {
  const execution: RealisticMigrationExecution = {
    restrictedMigrator: [],
    deploymentOwner: [],
  };
  await provisionRealisticRoles(admin);
  if (migrations.includes("0027_partner_submission_credit_lifecycle")) {
    // Provision the dedicated G6D definer as an elevated one-time operation,
    // then let the migration login grant and revoke its own temporary
    // membership. The post-migration assertion proves no SET ROLE path remains.
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_credit_lifecycle_definer
           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END$$;`
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE pn_credit_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END$$;`
    );
  }
  const migrator = new pg.Client({ connectionString: migratorUrlFrom(adminUrl) });
  await migrator.connect();
  try {
    for (const name of migrations) {
      if (DEPLOYMENT_OWNER_MIGRATIONS.has(name)) continue;
      await migrator.query(migrationSql(name));
      execution.restrictedMigrator.push(name);
    }
  } finally {
    await migrator.end();
  }
  for (const name of migrations) {
    if (!DEPLOYMENT_OWNER_MIGRATIONS.has(name)) continue;
    await admin.query(migrationSql(name));
    execution.deploymentOwner.push(name);
  }
  if (migrations.includes("0027_partner_submission_credit_lifecycle")) {
    const membership = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_auth_members m
         JOIN pg_roles role ON role.oid=m.roleid
         JOIN pg_roles member ON member.oid=m.member
        WHERE role.rolname='partner_credit_lifecycle_definer'
          AND member.rolname=$1`,
      [MIGRATOR_ROLE]
    );
    if (membership.rows[0]?.count !== "0") {
      throw new Error("0019 left pn_migrator as a member of partner_credit_lifecycle_definer.");
    }
    // Model the deployed separation between a schema owner and the migration
    // login only after migrations have created the accounting tables.
    for (const table of ["partner_credit_reservations", "partner_credit_reservation_events"]) {
      await admin.query(`ALTER TABLE public.${table} OWNER TO pn_credit_schema_owner`);
    }
  }
  return execution;
}
