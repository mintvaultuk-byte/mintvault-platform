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
  // (certificates.origin_partner_id). 0044 deliberately adds no second link, and a suite that
  // cannot see 0035's columns could not prove that.
  "0035_partner_certificate_origin",
  "0041_partner_submission_credit_lifecycle",
  "0042_partner_per_card_credit_settlement",
  "0043_partner_credit_hold_per_card",
  "0044_partner_submission_lifecycle_and_location_snapshot",
] as const;

/**
 * 0045 — per-card Partner grading bridge/provenance. Requires the MintVault certificates table.
 *
 * 0046 grants partner_connector_runtime the RLS-scoped SELECT on partner_profiles(tenant_id,
 * trading_name) that the importer's origin-snapshot query needs to record the approved partner
 * trading name. Included here rather than in a separate list because every suite that drives a real
 * connector import already uses this list, and without 0046 that import fails 42501 — which is
 * exactly the production condition this harness exists to reproduce.
 */
export const PARTNER_MIGRATIONS_WITH_GRADING_BRIDGE = [
  ...PARTNER_MIGRATIONS_WITH_LIFECYCLE,
  "0045_partner_grading_work_items",
  "0046_partner_connector_profile_read",
] as const;
/**
 * Create the MintVault `certificates` table a partner migration needs.
 *
 * WHY THIS EXISTS: migration 0045 both creates
 *   CREATE UNIQUE INDEX ... ON certificates(id, submission_id, submission_item_id)
 * and issues COLUMN-LEVEL grants naming 38 distinct certificates columns. `IF NOT EXISTS` on the
 * index guards its NAME, not its columns, and a column-level GRANT naming a missing column is a
 * hard 42703 — so a fixture whose certificates table is missing ANY of them makes 0045 fail and
 * the whole suite abort inside beforeAll. vitest renders a beforeAll throw as "N skipped", which
 * reads exactly like a benign env gate; that is how two critical suites sat red while looking
 * merely unconfigured.
 *
 * Several suites previously hand-rolled their own certificates table, each with a different
 * subset of columns, so every new migration broke a different arbitrary set of them. This is the
 * single definition. Extend it here when a migration needs another column, and every suite that
 * uses it stays correct.
 *
 * Types are deliberately loose (text/integer/timestamptz) — these fixtures exercise partner
 * migrations against a stand-in for the HQ table, not the HQ schema itself.
 */
export async function createMintvaultCertificatesTable(admin: pg.Client): Promise<void> {
  await admin.query(`CREATE TABLE IF NOT EXISTS certificates (
    id serial PRIMARY KEY,
    cert_id text,
    secret text,
    certificate_number text,
    reference_number text,
    submission_id integer,
    submission_item_id integer,
    card_id integer,
    status text,
    label_type text,
    grade_type text,
    language text,
    card_game text,
    set_name text,
    card_name text,
    card_number_display text,
    year_text text,
    variant text,
    front_image_path text,
    back_image_path text,
    grading_front_original text,
    grading_back_original text,
    grader_status text,
    print_state text,
    created_by text,
    integrity_hash text,
    logbook_version integer,
    logbook_last_issued_at timestamptz,
    issued_at timestamptz,
    deleted_at timestamptz,
    grade_approved_at timestamptz,
    archived_to_b2_at timestamptz,
    origin_type text,
    origin_partner_id uuid,
    origin_partner_public_ref text,
    origin_partner_legal_name text,
    origin_partner_trading_name text,
    origin_location_id uuid,
    origin_location_public_ref text,
    origin_location_name text,
    origin_location_address text,
    origin_captured_at timestamptz,
    origin_snapshot_version integer,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

/**
 * Create the MintVault `label_prints` table a partner/print migration needs.
 *
 * Migration 0022 backfills `print_state` with a subquery that reads `lp.cert_id` and
 * `lp.printed_at`. Its DO block is guarded on the label_prints TABLE existing
 * (information_schema.tables), not on its COLUMNS — so a stub table with only
 * (id, certificate_id, created_at) satisfies the guard and then fails at
 * `column lp.cert_id does not exist`. Same class as the certificates fixture above: the guard
 * protects against the table being absent, not against it being the wrong shape.
 */
export async function createMintvaultLabelPrintsTable(admin: pg.Client): Promise<void> {
  await admin.query(`CREATE TABLE IF NOT EXISTS label_prints (
    id serial PRIMARY KEY,
    certificate_id integer,
    cert_id text,
    printed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}

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
    /**
     * G6D credit-lifecycle roles, provisioned HERE rather than left to whichever suite happens to
     * run first.
     *
     * pg_roles and pg_auth_members are CLUSTER-GLOBAL. Every partner suite in CI shares one
     * PostgreSQL 17 server, and only partner-management-migration created these roles inline. So
     * the connector migration suites passed only when that suite had already run on the same
     * server: under CI's flat `vitest run`, applyEveryMigrationRealistic()'s
     * `GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE` had no role to
     * grant, and migration 0042 then failed closed with "pn_migrator lacks INHERIT membership".
     * Reproduced from clean databases: 2 of 5 connector suites failed that way with 21 tests
     * skipped, and the outcome flipped purely on suite order.
     *
     * ADMIN TRUE gives applyEveryMigrationRealistic() the admin option its INHERIT grant needs.
     *
     * INHERIT stays FALSE, deliberately and load-bearingly: applyMigrationsRealistic() asserts this
     * membership is ABSENT when a suite applies 0041 WITHOUT 0042, and applyEveryMigrationRealistic()
     * grants INHERIT itself only around the full-set apply and revokes it in a finally. Granting
     * INHERIT here would silently disarm that assertion — a weakened proof dressed up as a fix.
     * SET is never granted.
     *
     * This models Neon's provider-granted membership row; the INHERIT step models the
     * owner-approved staging repair 0042 documents as its prerequisite.
     */
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE partner_credit_lifecycle_definer
           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END$$;`
    );
    await admin.query(
      `DO $$ BEGIN
         CREATE ROLE pn_credit_schema_owner
           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END$$;`
    );
    await admin.query(
      `GRANT partner_credit_lifecycle_definer TO ${MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
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
  const all = listMigrationFiles();
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

/**
 * Bring a test `certificates` table up to the FULL production column set, derived from the Drizzle
 * schema itself rather than from a hand-maintained list.
 *
 * WHY THIS EXISTS. `createMintvaultCertificatesTable` declares ~55 columns. The production
 * `certificates` table declares ~150. Anything that goes through `storage.listCertificates()` —
 * which is every print path, because `createBatchAtomic` renders from it — issues a full
 * `SELECT` of all of them and dies with 42703 on the first one the fixture omits (`nfc_uid`).
 * That is why NO suite had ever executed createBatchAtomic, and why the approval columns
 * (grade, the four sub-scores, graded_at, grade_approved_by) were missing too.
 *
 * Hand-extending the shared list would fix today and rot tomorrow: a column added to
 * shared/schema.ts would silently break the next print test with the same opaque 42703. So this
 * reads `getTableColumns(certificates)` and adds whatever the live schema declares and the table
 * lacks, using each column's own `getSQLType()`. Every column is added NULLABLE with no default:
 * the point is queryability, not re-implementing production's constraints.
 *
 * ADDITIVE AND OPT-IN. Existing suites keep the small fixture unless they call this, so nothing
 * that relies on the narrow shape changes semantics.
 */
export async function alignCertificatesTableToSchema(
  admin: pg.Client
): Promise<{ added: string[]; unsupported: string[] }> {
  const [{ getTableColumns }, schema] = await Promise.all([import("drizzle-orm"), import("../../shared/schema")]);
  const columns = getTableColumns(schema.certificates as never) as Record<
    string,
    { name: string; getSQLType(): string }
  >;
  const existing = new Set(
    (
      await admin.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='certificates'"
      )
    ).rows.map((r) => r.column_name)
  );
  /**
   * Columns the LIVE certificates table has but the Drizzle model does NOT declare, because some
   * production code reads them through raw SQL rather than the model. Deriving from
   * getTableColumns() alone therefore under-builds the table and the raw query 42703s.
   *
   * `claim_code` is the confirmed case: storage.getOrGenerateClaimCode() SELECTs it directly
   * (server/storage.ts), createBatchAtomic's renderer calls that per certificate, and
   * shared/schema.ts declares only claim_code_hash / _created_at / _used_at. Verified against the
   * live staging schema, which has all four.
   *
   * `private_notes`, `auth_status` and `auth_notes` are the same story one level deeper:
   * server/grader.ts's applyCertGradeDraft UPDATE writes all three in raw SQL and shared/schema.ts
   * declares none of them. All three are present on the live certificates table (`text`, with
   * auth_status defaulting to 'genuine'). Without them any suite that drives a real grading draft
   * save dies with 42703 — which is exactly how the partner grading adapter went unproven.
   */
  const RAW_SQL_ONLY_COLUMNS: Array<[string, string]> = [
    ["claim_code", "text"],
    ["private_notes", "text"],
    ["auth_status", "text"],
    ["auth_notes", "text"],
  ];

  const added: string[] = [];
  const unsupported: string[] = [];
  for (const [name, type] of RAW_SQL_ONLY_COLUMNS) {
    if (existing.has(name)) continue;
    await admin.query(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
    added.push(name);
  }
  for (const col of Object.values(columns)) {
    if (existing.has(col.name)) continue;
    try {
      await admin.query(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS "${col.name}" ${col.getSQLType()}`);
      added.push(col.name);
    } catch {
      // A type the disposable cluster cannot provide — in practice only pgvector's `vector`, which
      // needs an extension the plain postgres:17 image lacks. The column must still EXIST, because
      // storage.listCertificates() SELECTs it by name and would otherwise 42703 the whole print
      // path. Fall back to a placeholder type: nothing under test reads its value, only its
      // presence. Recorded so a caller can assert on what was degraded.
      try {
        await admin.query(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS "${col.name}" text`);
        added.push(col.name);
        unsupported.push(`${col.name} (declared ${col.getSQLType()}, created as text)`);
      } catch (inner) {
        unsupported.push(`${col.name}: ${(inner as Error).message}`);
      }
    }
  }
  return { added, unsupported };
}

/**
 * Schema-parity guard. Returns every column the Drizzle `certificates` model declares that the
 * database does not have, so a test can assert it is empty. Without this, a production column added
 * to shared/schema.ts reaches the print path as a 42703 at runtime instead of a red schema test.
 */
export async function certificatesSchemaDrift(admin: pg.Client): Promise<string[]> {
  const [{ getTableColumns }, schema] = await Promise.all([import("drizzle-orm"), import("../../shared/schema")]);
  const columns = getTableColumns(schema.certificates as never) as Record<string, { name: string }>;
  const existing = new Set(
    (
      await admin.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='certificates'"
      )
    ).rows.map((r) => r.column_name)
  );
  return Object.values(columns)
    .map((c) => c.name)
    .filter((n) => !existing.has(n))
    .sort();
}

/**
 * Generic form of the certificates alignment: bring ANY test table up to the columns its Drizzle
 * model declares. `createMintvaultLabelPrintsTable` is the second confirmed divergence — it
 * declares (certificate_id, cert_id, printed_at, created_at) while both shared/schema.ts and the
 * live staging schema declare (id, cert_id, sheet_ref, queued_at, printed_at). createBatchAtomic
 * INSERTs sheet_ref, so the print path 42703s on the fixture rather than on anything real.
 *
 * Same contract as alignCertificatesTableToSchema: additive, opt-in, columns added NULLABLE with
 * no default, per-column tolerance with a text fallback for types the disposable cluster lacks.
 */
export async function alignTableToDrizzleModel(
  admin: pg.Client,
  tableName: string,
  model: unknown
): Promise<{ added: string[]; unsupported: string[] }> {
  const { getTableColumns } = await import("drizzle-orm");
  const columns = getTableColumns(model as never) as Record<string, { name: string; getSQLType(): string }>;
  const existing = new Set(
    (
      await admin.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [tableName]
      )
    ).rows.map((r) => r.column_name)
  );
  const added: string[] = [];
  const unsupported: string[] = [];
  for (const col of Object.values(columns)) {
    if (existing.has(col.name)) continue;
    try {
      await admin.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS "${col.name}" ${col.getSQLType()}`);
      added.push(col.name);
    } catch {
      try {
        await admin.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS "${col.name}" text`);
        added.push(col.name);
        unsupported.push(`${col.name} (declared ${col.getSQLType()}, created as text)`);
      } catch (inner) {
        unsupported.push(`${col.name}: ${(inner as Error).message}`);
      }
    }
  }
  return { added, unsupported };
}
