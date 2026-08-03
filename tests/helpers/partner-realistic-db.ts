/**
 * Test helper (DB-F1): apply the Partner Network migrations under a REALISTIC role model, so the
 * SECURITY DEFINER functions are NOT owned by a superuser in the runtime proof.
 *
 * Role layout (mirrors managed Postgres, e.g. Neon):
 *   - cluster admin / superuser: creates DB + roles only (the `admin` client passed in).
 *   - pn_migrator:   NON-superuser, NON-BYPASSRLS, owns the schema + tables (applies migrations).
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

/** Partner user management + invitations. Depends on G5 partner-management audit/profile tables. */
export const PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT = [
  ...PARTNER_MIGRATIONS_WITH_G5,
  "0031_partner_user_management",
] as const;

/** Partner user management plus the DB-level final-owner invariant. */
export const PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT = [
  ...PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT,
  "0032_partner_final_owner_invariant",
] as const;

/** 0033 — additive audit-action precision (partner_user_mfa_reset et al). */
export const PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION = [
  ...PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_INVARIANT,
  "0033_partner_audit_action_precision",
] as const;

/**
 * 0034 — the Partner RBAC reference catalogue (roles / permissions / role→permission mappings).
 *
 * Use THIS list in any suite that needs a usable RBAC catalogue without calling the test-only
 * seedPartnerRbac() helper. Applying the real migration is what proves the PRODUCTION path works:
 * the original first-owner-invitation blocker survived precisely because thirteen suites seeded RBAC
 * by hand in beforeAll, so no test ever exercised an environment built the way a deployment is.
 */
export const PARTNER_MIGRATIONS_WITH_RBAC_SEED = [
  ...PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION,
  "0034_partner_rbac_seed",
] as const;

/** G6D — Partner submission credit reservation, consumption and release integration. */
export const PARTNER_MIGRATIONS_WITH_G6D = [
  ...PARTNER_MIGRATIONS_WITH_G6B,
  "0018_correction_audit_index",
  "0041_partner_submission_credit_lifecycle",
] as const;

/**
 * G6D per-card settlement. 0042 replaces 0041's single-reservation connector release function
 * with an N-reservation one, so any suite exercising multi-card submissions must use this list.
 * 0042 requires INHERIT membership on the lifecycle definer, which the realistic harness now
 * provides via the provider-style ADMIN grant (see applyMigrationsRealistic).
 */
export const PARTNER_MIGRATIONS_WITH_PER_CARD = [
  ...PARTNER_MIGRATIONS_WITH_G6D,
  "0042_partner_per_card_credit_settlement",
  // 0043 re-keys the active-hold unique index per RESERVATION (so an N-card recovery can exist at
  // all) and adds the tenant-isolation policy 0041 omitted on partner_submission_credit_holds.
  "0043_partner_credit_hold_per_card",
] as const;
export const MIGRATOR_ROLE = "pn_migrator";
export const MIGRATOR_PASSWORD = "realistic-migrator-pw"; // synthetic, disposable-DB only

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
    // On Neon the project owner IS the DATABASE owner (pg_database.datdba), not merely the schema
    // owner. definer-guard distinguishes the database owner from every other role, so the harness
    // must reproduce that or it cannot exercise the real policy.
    await admin.query(`ALTER DATABASE "${rows[0].db}" OWNER TO ${MIGRATOR_ROLE}`);
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
 * Full realistic setup: provision roles (superuser), then apply ALL partner migrations as the
 * NON-superuser pn_migrator. `admin` must be connected to the target DB; `adminUrl` is its URL.
 */
export async function applyMigrationsRealistic(
  admin: pg.Client,
  adminUrl: string,
  migrations: readonly string[] = PARTNER_MIGRATIONS
): Promise<void> {
  await provisionRealisticRoles(admin);
  if (migrations.includes("0041_partner_submission_credit_lifecycle")) {
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
    /**
     * MODEL NEON'S PROVIDER-GRANTED MEMBERSHIP ROW.
     *
     * WHY (hostile review, 2026-08-03): this harness previously ran 0041 as the SUPERUSER, which
     * defeated the entire point of the file — and it hid two production defects:
     *   1. `definer-guard.ts` rejected the ADMIN-only membership row that survives on Neon,
     *      so credit settlement returned HTTP 409 on the real database while tests were green.
     *   2. 0041 was neither re-runnable nor rollback-capable, because the deployment owner ends
     *      up without INHERIT on the definer and so fails the ownership check.
     * Neither is reachable as a superuser: a superuser passes every ownership check, and 0041's
     * own final assertion short-circuits on `rolsuper`.
     *
     * On Neon, `cloud_admin` grants the project owner ADMIN OPTION on these roles. Because
     * PostgreSQL 16+ records the GRANTOR per membership row, 0041's closing
     * `REVOKE ADMIN OPTION FOR ... FROM current_user` cannot remove a row granted by someone
     * else — which is exactly why the row survives in production. Granting it here from the
     * superuser reproduces that grantor asymmetry faithfully: pn_migrator can grant itself SET
     * (so the ownership transfer works), and its own REVOKE leaves the ADMIN row behind.
     */
    // ADMIN only — INHERIT and SET are explicitly FALSE. PostgreSQL 16+ otherwise defaults a role
    // grant to SET TRUE (and INHERIT from the member's rolinherit), which would NOT be the Neon
    // shape: there the provider row carries admin_option=true, inherit_option=false,
    // set_option=false. Getting this wrong makes 0041's own closing assertion fire.
    await admin.query(
      `GRANT partner_credit_lifecycle_definer TO ${MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
  }
  const migrator = new pg.Client({ connectionString: migratorUrlFrom(adminUrl) });
  await migrator.connect();
  try {
    /**
     * EXPLICIT HARNESS GUARD. The whole value of this helper is that migrations run as a
     * NON-superuser, because a superuser passes every ownership check and short-circuits 0041's
     * own closing assertion — which is how two production defects shipped green. Reintroducing a
     * superuser executor must fail loudly HERE rather than silently weakening every downstream
     * assertion, since several of those assertions cannot themselves detect the difference.
     */
    const executorRole = await migrator.query<{ rolname: string; rolsuper: boolean }>(
      "SELECT current_user AS rolname, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper"
    );
    if (executorRole.rows[0]?.rolsuper !== false) {
      throw new Error(
        `applyMigrationsRealistic must execute migrations as a NON-superuser; got ` +
          `'${executorRole.rows[0]?.rolname}' with rolsuper=${executorRole.rows[0]?.rolsuper}. ` +
          `Running migrations as a superuser invalidates the entire realistic role-model proof.`
      );
    }
    for (const name of migrations) {
      /**
       * 0042 replaces functions OWNED BY partner_credit_lifecycle_definer, and
       * `CREATE OR REPLACE FUNCTION` performs an ownership check via the INHERIT form of
       * pg_has_role. 0041 deliberately revokes its own SET/INHERIT membership at the end, so
       * after 0041 the migrator holds only the provider-style ADMIN row and CANNOT maintain
       * those functions. That is precisely the deadlock discovered on staging.
       *
       * The fix is the owner-approved role repair, and the migrator can execute it itself
       * because ADMIN OPTION is exactly the right to grant the role onward. Running the SAME
       * statement here — no superuser involved — is the proof that the proposed staging repair
       * is correct, sufficient and self-service. Note INHERIT only: SET is not granted, so
       * SET ROLE into the definer remains impossible.
       */
      if (name === "0042_partner_per_card_credit_settlement") {
        // SET FALSE is NOT optional. PostgreSQL 16+ defaults a role grant to SET TRUE, so
        // `WITH INHERIT TRUE` alone would silently also confer SET ROLE into the definer.
        await migrator.query(
          `GRANT partner_credit_lifecycle_definer TO ${MIGRATOR_ROLE} WITH INHERIT TRUE, SET FALSE`
        );
      }
      // EVERY migration — including 0041 and 0042 — runs as the NON-SUPERUSER pn_migrator.
      // There is deliberately no executor swap here any more.
      await migrator.query(migrationSql(name));
    }
  } finally {
    await migrator.end();
  }
  if (migrations.includes("0041_partner_submission_credit_lifecycle")) {
    // Assert the POST-MIGRATION shape matches Neon: the ADMIN-option row survives, but the
    // migrator retains no usable (SET/INHERIT) privilege. Asserting "no rows at all" was the
    // superuser-only outcome and is what made this check vacuous.
    const membership = await admin.query<{
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(
      `SELECT m.admin_option, m.inherit_option, m.set_option
         FROM pg_auth_members m
         JOIN pg_roles role ON role.oid=m.roleid
         JOIN pg_roles member ON member.oid=m.member
        WHERE role.rolname='partner_credit_lifecycle_definer'
          AND member.rolname=$1`,
      [MIGRATOR_ROLE]
    );
    if (!membership.rows.some((r) => r.admin_option === true)) {
      throw new Error(
        `Expected the provider-style ADMIN membership row for ${MIGRATOR_ROLE} on ` +
          `partner_credit_lifecycle_definer to survive 0041. The harness no longer reproduces ` +
          `Neon's grantor asymmetry, so it cannot detect the guard contradiction it exists to catch.`
      );
    }
    // SET ROLE must never become possible — not even after the role repair, which grants INHERIT only.
    if (membership.rows.some((r) => r.set_option === true)) {
      throw new Error(
        "pn_migrator holds SET on partner_credit_lifecycle_definer. SET ROLE into the definer " +
          "must never be reachable from the migration login."
      );
    }
    // Without the owner-approved repair, 0041 must leave NO usable (INHERIT) membership — that
    // is the deadlock this harness now reproduces faithfully. When 0042 is in the set the repair
    // has deliberately been applied, so INHERIT is expected.
    const repairApplied = migrations.includes("0042_partner_per_card_credit_settlement");
    if (!repairApplied && membership.rows.some((r) => r.inherit_option === true)) {
      throw new Error(
        "0041 left pn_migrator with a USABLE (INHERIT) membership of partner_credit_lifecycle_definer. " +
          "The migration must revoke runtime capability even though the provider-granted ADMIN row survives."
      );
    }
    // Model the deployed separation between a schema owner and the migration
    // login only after migrations have created the accounting tables.
    for (const table of ["partner_credit_reservations", "partner_credit_reservation_events"]) {
      await admin.query(`ALTER TABLE public.${table} OWNER TO pn_credit_schema_owner`);
    }
  }
}
