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
  "0044_partner_mfa_pending_lifecycle",
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
  "0078_partner_connector_flag_read",
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

/**
 * Partner user management + the final-owner invariant, WITH the credit lifecycle.
 *
 * Submit now reserves a grading credit PER CARD (server/partner/submission-service.ts), so any
 * suite that drives a real submission through submit needs the wallet, ledger and reservation
 * tables. Listed in NUMERIC order because applyMigrationsRealistic applies the list as given.
 */
export const PARTNER_MIGRATIONS_WITH_USER_MANAGEMENT_CREDITS = [
  ...PARTNER_MIGRATIONS_WITH_G6B,
  "0018_correction_audit_index",
  "0031_partner_user_management",
  "0032_partner_final_owner_invariant",
  "0041_partner_submission_credit_lifecycle",
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
  // 0073_lineage_convergence WAS listed here (added with the canonical lineage,
  // c788fa68). It is APPLICATION-scope — see the MIGRATION SCOPE CONTRACT below —
  // and putting it in a list consumed by four partner-only suites is what broke
  // them: every one of those databases dies on
  //   "0073 requires the certificates table, which does not exist in this database."
  //
  // Only ONE suite genuinely needs 0073 (partner-rbac-migration, because 0073 and
  // not 0034 grants partner.cards.preview, which its TypeScript-map parity
  // assertions compare against). That suite already excluded 0073 from THIS list
  // and applies it explicitly through the real runner, so removing it here is a
  // no-op for the suite that wants it and a repair for the four that never did.
] as const;

/**
 * ── MIGRATION SCOPE CONTRACT ───────────────────────────────────────────────
 *
 * A migration is either PARTNER-scope (it models the Partner subsystem and runs
 * against a partner-only disposable database) or APPLICATION-scope (it also needs
 * the CORE MintVault schema — `certificates` and friends).
 *
 * WHY THIS EXISTS. `applyEveryMigrationRealistic()` used to apply
 * `listMigrationFiles()` — literally every numbered migration in the repository —
 * to a partner-only database. That was fine only for as long as every migration
 * happened to be partner-scoped. The moment 0073 landed (canonical lineage,
 * c788fa68, shipped as v1070) eleven partner suites began failing on
 *
 *     0073 requires the certificates table, which does not exist in this database.
 *
 * and the whole lineage became un-mergeable to main. Nothing in CI had changed;
 * an unrelated migration simply fell into an implicit glob.
 *
 * The rule is now an ALLOWLIST, not a filter: a new migration does NOT join the
 * partner harness merely by being a numbered .sql file. It must be classified
 * here, deliberately. tests/migration-scope-contract.test.ts fails until it is —
 * so the next scanner / Vault Quest / grading / payment migration cannot silently
 * break a partner-only harness the way 0073 did.
 *
 * Classification rule: does the migration read or write any table outside the
 * `partner_*` namespace in a way that requires it to already exist?
 */
export const APPLICATION_SCOPE_MIGRATIONS = [
  "0073_lineage_convergence",
  // Extends scanner_capture_sessions, which is a core-certificate dependency.
  "0075_partner_station_single_active_capture",
  // Allocates into core certificates/cert_counter while deriving the immutable
  // Partner mapping. It must never be pulled into the Partner-only harness.
  "0076_partner_pilot_certificate_allocation",
] as const;

/**
 * Every migration a partner-only disposable database may apply, in order.
 * Deliberately enumerated rather than globbed — see the contract above.
 */
export const PARTNER_SCHEMA_MIGRATIONS = [
  "0001_partner_foundation",
  "0002_partner_auth_support",
  "0003_partner_auth_hardening",
  "0004_partner_mfa_enrol",
  "0005_partner_mfa_replay_and_grants",
  "0006_partner_definer_role",
  "0007_partner_submissions",
  "0008_partner_connector_foundation",
  "0009_partner_connector_validation",
  "0010_partner_connector_import",
  "0011_partner_connector_reconciliation",
  "0012_partner_connector_import_attempts",
  "0013_partner_connector_claim_index",
  "0014_partner_connector_admin_actions",
  "0015_partner_management",
  "0016_partner_wallet_ledger",
  "0017_partner_credit_reservations",
  "0018_correction_audit_index",
  "0019_catalogue_manager",
  "0022_print_workflow_lifecycle",
  "0023_set_library_schema",
  "0024_set_library_base_tables",
  "0026_catalogue_abbreviation_unique",
  "0030_project_control",
  "0031_partner_user_management",
  "0032_partner_final_owner_invariant",
  "0033_partner_audit_action_precision",
  "0034_partner_rbac_seed",
  "0035_partner_certificate_origin",
  "0041_partner_submission_credit_lifecycle",
  "0042_partner_per_card_credit_settlement",
  "0043_partner_credit_hold_per_card",
  "0044_partner_mfa_pending_lifecycle",
  "0045_partner_stations",
  "0046_scanner_processing_jobs",
  "0047_scanner_evidence_staging",
  "0074_partner_submission_lifecycle_and_location_snapshot",
  "0078_partner_connector_flag_read",
] as const;

/** True when a declared list pulls in a migration that needs the core schema. */
export function requiresCoreSchema(migrations: readonly string[]): boolean {
  return migrations.some((m) => (APPLICATION_SCOPE_MIGRATIONS as readonly string[]).includes(m));
}

/**
 * Narrow a discovered migration list to what a PARTNER-only disposable database
 * may apply.
 *
 * Wrap `listMigrationFiles()` in this anywhere the target database contains only
 * the Partner schema. The raw discovery function returns EVERY numbered migration
 * in the repository, which is how 0073 — an application-scope migration needing
 * `certificates` — silently entered eleven partner suites and blocked the
 * mainline. Ordering, numbering and checksums still come from the runner's own
 * file list; this is a scope filter over it, not a second source of truth.
 *
 * Deliberately synchronous and pure so it can be dropped into an existing
 * expression without making the caller async.
 */
export function partnerScopeOnly<T extends { filename: string }>(files: readonly T[]): T[] {
  const declared = new Set<string>(PARTNER_SCHEMA_MIGRATIONS);
  return files.filter((f) => declared.has(f.filename.replace(/\.sql$/, "")));
}

/**
 * Provision the CORE schema an application-scope migration requires.
 *
 * This is the established pattern in this repository — ~38 suites already stand up
 * their own `certificates` fixture — reusing the SAME protected-column definition
 * the dedicated 0073 lineage suite uses, so there is one definition of "real
 * shape" rather than a second one that can drift.
 *
 * It deliberately does NOT weaken 0073: the migration still fails closed if this
 * has not been run. Providing what a migration requires is the opposite of
 * exempting it.
 */
export async function seedCoreSchemaForApplicationMigrations(client: pg.Client): Promise<void> {
  const { CERTIFICATES_PROTECTED_COLUMNS_SQL } = await import("./certificates-protected-columns");
  await client.query(`
    CREATE TABLE IF NOT EXISTS certificates (
      id serial PRIMARY KEY,
      certificate_number text,
      cert_id text,
      status text,
      deleted_at timestamptz,
      grade_approved_at timestamptz,
      grade_approved_by text,
      grader_status text,
      print_state text,
      updated_at timestamptz DEFAULT now()
    );
  `);
  await client.query(CERTIFICATES_PROTECTED_COLUMNS_SQL);
  /**
   * OWNERSHIP MATTERS. Migrations execute as the NON-superuser migration login, and
   * 0073 does `ALTER TABLE certificates …`, which PostgreSQL allows only for the
   * owner. Seeding this as the admin/superuser and leaving it owned by them makes
   * the migration fail with `must be owner of table certificates` — a harness
   * artefact that says nothing about the migration.
   *
   * On the real hosts the migration login owns the schema it maintains, so hand the
   * fixture over too. This keeps the non-superuser execution proof intact: the
   * migrator still is not a superuser, it simply owns what it must.
   */
  await client.query(`ALTER TABLE certificates OWNER TO ${MIGRATOR_ROLE}`);
}

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
/**
 * 0044 widens partner_submissions.status past the three states 0007 allowed (draft /
 * submitted_to_mintvault / cancelled) and adds the immutable location_name_snapshot. Any suite
 * exercising the post-handover lifecycle — received, grading, graded, awaiting_settlement,
 * completed — must use this list, or the CHECK constraint rejects every one of those states.
 */
export const PARTNER_MIGRATIONS_WITH_LIFECYCLE = [
  ...PARTNER_MIGRATIONS_WITH_G6B,
  "0018_correction_audit_index",
  "0031_partner_user_management",
  "0032_partner_final_owner_invariant",
  "0033_partner_audit_action_precision",
  "0034_partner_rbac_seed",
  // 0035 is included because the partner→certificate link lives there
  // (certificates.origin_partner_id). The lifecycle migration deliberately adds no second link,
  // and a suite that cannot see 0035's columns could not prove that.
  "0035_partner_certificate_origin",
  "0041_partner_submission_credit_lifecycle",
  "0042_partner_per_card_credit_settlement",
  "0043_partner_credit_hold_per_card",
  // RENUMBERED 0044 -> 0048 (2026-08-11): production had already applied a different 0044
  // (0044_partner_mfa_pending_lifecycle), and the migration runner rejects duplicate NUMBERS
  // before it runs anything. The applied file could not move, so this unapplied one did.
  "0074_partner_submission_lifecycle_and_location_snapshot",
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
  // MIGRATION SCOPE CONTRACT. A declared list may legitimately include an
  // APPLICATION-scope migration (0073 grants partner.cards.preview, which the RBAC
  // parity assertions need). Such a migration requires the core schema, and fails
  // closed without it — by design. Provision what it requires rather than exempting
  // it. Partner-only lists are untouched: this is a no-op for them.
  if (requiresCoreSchema(migrations)) {
    await seedCoreSchemaForApplicationMigrations(admin);
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
        await migrator.query(`GRANT partner_credit_lifecycle_definer TO ${MIGRATOR_ROLE} WITH INHERIT TRUE, SET FALSE`);
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
    //
    // The owner must be able to USE the schema its tables live in. On a managed provider the
    // schema owner has that implicitly; here `public` is owned by pn_migrator and its ACL lists
    // every other role in this model (partner_runtime, partner_definer,
    // partner_connector_runtime, partner_credit_lifecycle_definer) but not this one. Without the
    // grant the modelled separation is one that cannot exist in production — a table owner with
    // no access to its own schema — and an INSERT into partner_credit_reservation_events fails
    // with `permission denied for schema public` even on a superuser connection, which surfaces
    // as an opaque HTTP 500 from the submit route.
    await admin.query("GRANT USAGE ON SCHEMA public TO pn_credit_schema_owner");
    for (const table of ["partner_credit_reservations", "partner_credit_reservation_events"]) {
      await admin.query(`ALTER TABLE public.${table} OWNER TO pn_credit_schema_owner`);
    }
  }
}

/**
 * Apply EVERY numbered migration in the repository to a disposable database, in the order and
 * under the role conditions the real runner requires.
 *
 * Two things make this more than a one-liner, and both are load-bearing:
 *
 *  1. ORDER. 0041 revokes its own SET/INHERIT membership as its final act, so the repair grant
 *     that 0042 needs must land BETWEEN 0041 and 0042. Granting it up front is silently undone.
 *  2. allowDestructive. 0043 must DROP the single-hold-per-destination unique index so an N-card
 *     recovery can exist at all. The runner correctly refuses destructive SQL unless the operator
 *     opts in. Opting in is safe on a suite's OWN disposable database and still requires owner
 *     approval anywhere real — this flag changes nothing outside this process.
 *
 * Extracted from tests/partner-management-migration.test.ts, which established the pattern. Any
 * suite that applies listMigrationFiles() in full must use this, or it breaks the moment a
 * destructive migration lands.
 */
export async function applyEveryMigrationRealistic(migrator: pg.Client): Promise<void> {
  const { applyMigrations, listMigrationFiles } = await import("../../scripts/db/migrate");
  /**
   * ALLOWLIST, NOT A GLOB. This used to be `listMigrationFiles()` in full, which
   * meant any migration added anywhere in the repository was applied to a
   * partner-only database. 0073 is what exposed it. Restricting to the declared
   * PARTNER_SCHEMA_MIGRATIONS keeps "every migration this harness models" honest
   * and stops the next unrelated migration from joining silently.
   *
   * Ordering still comes from the runner's own numeric sort, so this is a filter
   * over the real file list rather than a second source of truth for order.
   */
  const all = partnerScopeOnly(listMigrationFiles());
  await applyMigrations(
    migrator,
    all.filter((f) => Number(f.number) <= 41),
    { allowDestructive: true }
  );
  await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
  try {
    await applyMigrations(migrator, all, { allowDestructive: true });
  } finally {
    // pg_auth_members is a CLUSTER-GLOBAL catalog, not per-database. Every caller of this helper
    // shares one PostgreSQL 17 server in CI, so an unrevoked INHERIT membership would be visible
    // to every other suite on that server for the rest of the job — and applyMigrationsRealistic()
    // asserts exactly this membership is ABSENT when a suite applies 0041 without 0042. 0041's own
    // closing REVOKE happens to clear it today because pn_migrator is its own grantor, but relying
    // on that makes the outcome order-dependent. Revoke it explicitly instead.
    await migrator.query("REVOKE partner_credit_lifecycle_definer FROM pn_migrator").catch(() => {}); // best-effort: never mask the real failure from applyMigrations
  }
}

/**
 * Pin the MintVault accounting URL to this suite's OWN disposable database.
 *
 * server/partner/db.ts asserts that PARTNER_ADMIN_DATABASE_URL / PARTNER_DATABASE_URL /
 * PARTNER_CONNECTOR_DATABASE_URL all name the SAME PostgreSQL database as
 * MINTVAULT_DATABASE_URL, because G6D settles a MintVault submission status and Partner credit
 * evidence in ONE transaction — a split would make that an unrecoverable distributed commit.
 * That assertion is correct and must not be relaxed.
 *
 * The consequence for tests: a suite that pins its own partner URLs but INHERITS an unrelated
 * MINTVAULT_DATABASE_URL from the environment trips the assertion. .github/workflows/ci.yml sets
 * MINTVAULT_DATABASE_URL globally (the PostgreSQL 16 Vault Quest database) for the whole job,
 * while every partner and connector suite uses its own PostgreSQL 17 database — so the mismatch
 * appears ONLY under CI's flat run and never when a suite is run on its own. Several connector
 * services swallow the throw and re-report it as a generic "transient_database_error", which is
 * why the symptom looked like cross-suite contamination rather than an environment mismatch.
 *
 * Call this immediately after pinning the partner URLs. Production topology is the same database,
 * so this makes the test environment match production rather than diverge from it.
 */
export function pinAccountingTopologyTo(url: string): void {
  process.env.MINTVAULT_DATABASE_URL = url;
}
