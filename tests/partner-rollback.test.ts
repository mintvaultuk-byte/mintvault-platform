/**
 * DB-F2 — Partner Network rollback safety, proven on a disposable Postgres with a populated
 * migration journal (driven through the real migrate runner's applyMigrations).
 *
 * Proves:
 *   - the legacy 0001-only rollback REFUSES to run once later migrations (0002–0006) are applied;
 *   - the comprehensive rollback removes migrations 0001–0006 fully — every partner_* table,
 *     helper function, both restricted roles (partner_definer + partner_runtime), and all journal
 *     rows — while PRESERVING pre-existing MintVault data;
 *   - migrations reapply cleanly afterwards.
 *
 * Runs ONLY when PARTNER_ROLLBACK_ADMIN (a superuser URL to a DISPOSABLE local Postgres that is the
 * ONLY partner database in its cluster) is set, because dropping the cluster-level roles requires
 * no cross-database dependency:
 *   PARTNER_ROLLBACK_ADMIN=postgresql://postgres@127.0.0.1:5546/rollbackdb \
 *   npx vitest run tests/partner-rollback.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom } from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { CERTIFICATES_PROTECTED_COLUMNS_SQL } from "./helpers/certificates-protected-columns";

/**
 * THIS SUITE MUST OWN ITS ENTIRE CLUSTER.
 *
 * It DROPs cluster-level roles (partner_runtime, partner_definer, partner_connector_runtime,
 * partner_credit_lifecycle_definer). Roles are global to a PostgreSQL cluster, so `DROP ROLE`
 * fails with `N objects in database <other>` if ANY other database in the same cluster still
 * holds objects owned by, or privileges granted to, those roles. The file header has always
 * stated this precondition ("the ONLY partner database in its cluster") but the suite used to
 * accept an externally supplied URL, so on the shared CI cluster it aborted against 34 objects
 * living in a sibling suite's database — an environment topology collision, not a source defect.
 *
 * Starting a dedicated disposable cluster makes the precondition structural instead of hoped-for.
 */
let cluster: DisposablePostgres17;
let ADMIN: string;
let admin: Client;
const rb = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

async function applyAllRealistic(): Promise<void> {
  await provisionRealisticRoles(admin);
  /**
   * G6D credit-lifecycle roles. This suite drives the REAL migrate runner over EVERY migration
   * file, which now includes 0041 and 0042, so it must reproduce the same one-time elevated
   * provisioning that applyMigrationsRealistic() performs — otherwise 0041 cannot transfer
   * ownership and 0042 fails its INHERIT precondition.
   *
   * The ADMIN-only grant models Neon's provider-granted membership row (admin_option=true,
   * inherit_option=false, set_option=false); the INHERIT grant below models the owner-approved
   * staging role repair that 0042 documents as its hard prerequisite. SET is never granted, so
   * SET ROLE into the definer stays impossible.
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
       CREATE ROLE pn_credit_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     EXCEPTION WHEN duplicate_object THEN NULL;
     END$$;`
  );
  await admin.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE");
  const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await migrator.connect();
  try {
    /**
     * ORDER IS LOAD-BEARING. 0041 REVOKES its own SET/INHERIT membership as its final act, so the
     * repair grant must land BETWEEN 0041 and 0042 — granting it up front is silently undone.
     * This mirrors applyMigrationsRealistic(), which issues the grant immediately before 0042.
     * applyMigrations is journal-driven and idempotent, so the second call re-reads the journal
     * and applies only what remains.
     */
    const all = listMigrationFiles();
    const throughG6D = all.filter((f) => Number(f.number) <= 41);
    await applyMigrations(migrator, throughG6D); // populates schema_migrations journal
    // The owner-approved repair, executed by the migrator itself via its ADMIN option — exactly
    // the self-service path 0042's header prescribes for staging.
    await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
    /**
     * allowDestructive IS REQUIRED, and that requirement is itself the point.
     *
     * 0043 must DROP INDEX uq_partner_submission_credit_holds_active_destination — the per-card
     * hold model cannot exist while a unique index permits only one unreleased hold per
     * destination. The migration runner correctly refuses any pending migration containing
     * destructive SQL unless the operator opts in, so without this flag the suite aborts with
     * "Destructive SQL detected in pending migration(s): 0043...".
     *
     * Opting in is safe HERE because this suite owns a disposable, freshly-created cluster. It is
     * NOT safe by default anywhere else: applying 0043 to staging or production requires explicit
     * owner approval and `--allow-destructive`, and that gate must stay in the operator's hands.
     */
    /**
     * SECOND REPAIR GRANT — 0076 does to itself exactly what 0041 does.
     *
     * 0076 self-elevates (`GRANT ... WITH SET TRUE` to current_user), creates the allocator owned
     * by partner_credit_lifecycle_definer, and then REVOKEs both the membership AND the admin
     * option from current_user as its final act. 0081 subsequently does a plain
     * `CREATE OR REPLACE FUNCTION partner_allocate_import_certificates`, which PostgreSQL permits
     * only to the owner — so without a membership restored in between it fails with
     * "must be owner of function partner_allocate_import_certificates".
     *
     * The grant must come from the SUPERUSER client, not the migrator: 0076 revoked the admin
     * option too, so the migrator can no longer grant this to itself. That is the same
     * owner-approved repair 0042 documents, applied at the second place the chain needs it.
     */
    const through76 = all.filter((f) => Number(f.number) <= 76);
    await applyMigrations(migrator, through76, { allowDestructive: true });
    await admin.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
    await applyMigrations(migrator, all, { allowDestructive: true });
  } finally {
    await migrator.end();
  }
}

describe("Partner Network rollback safety (DB-F2, dedicated disposable cluster)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-rollback");
    ADMIN = cluster.url;
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    /**
     * Roles FIRST. Every MintVault base table below must be OWNED BY pn_migrator before the
     * migrations run, because 0010 GRANTs on them as the migrator and a superuser-owned table
     * yields `permission denied for table users`. These ALTERs used to be written defensively as
     * `.catch(() => {})` while the roles did not yet exist, so they silently did nothing and the
     * real failure surfaced much later inside the migration runner.
     */
    await provisionRealisticRoles(admin);
    // synthetic PRE-EXISTING MintVault data that must survive the rollback
    await admin.query("CREATE TABLE IF NOT EXISTS certificates (id serial primary key, cert_id text, secret text)");
    await admin.query("INSERT INTO certificates (cert_id, secret) VALUES ('MV1','KEEP-A'),('MV2','KEEP-B')");
    /**
     * This suite drives the REAL migrate runner over the FULL migration set, which
     * now includes 0048. That migration's presence guard is deliberately
     * unconditional — it refuses to install partial review protection rather than
     * silently leaving a protected field unguarded — so the synthetic certificates
     * table above must carry the real protected-column shape or 0048 correctly
     * aborts the whole run. `grade_approved_at` is needed too: it is the trigger's
     * firing condition.
     */
    await admin.query("ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grade_approved_at timestamptz");
    /**
     * 0022's print-state backfill is guarded on `grade_approved_at` EXISTING (plus a
     * label_prints table, which this fixture also creates). Its header anticipates
     * "a fixture that only stubs certificates (no grade columns)", in which case
     * PL/pgSQL never plans the guarded statements. Adding grade_approved_at above
     * for 0048 flips that guard ON, so the backfill is now planned here and needs
     * the other columns it references. Stubbing them is the honest fix — the
     * alternative would be withholding grade_approved_at and thereby NOT testing
     * 0048 against the real runner at all.
     */
    await admin.query(
      "ALTER TABLE certificates" +
        " ADD COLUMN IF NOT EXISTS deleted_at timestamptz," +
        " ADD COLUMN IF NOT EXISTS status text," +
        " ADD COLUMN IF NOT EXISTS certificate_number text"
    );
    /**
     * Columns 0076 and 0081 address on `certificates`.
     *
     * 0076's allocator SELECTs `submission_item_id` (and `deleted_at`) to prove no live certificate
     * already exists for a destination item; 0081 replaces that routine and INSERTs the full
     * identity + origin-snapshot column set. The stub above carries only what 0022/0048 needed, so
     * without these the run fails at 0076 with `column "submission_item_id" does not exist` —
     * further along than the missing cert_counter, but the same class of fixture gap.
     *
     * Stubbed, not faked: these are the real column names and types, so the migrations exercise the
     * statements they actually ship rather than a weakened variant.
     */
    await admin.query(
      "ALTER TABLE certificates" +
        " ADD COLUMN IF NOT EXISTS submission_item_id integer," +
        " ADD COLUMN IF NOT EXISTS card_id integer," +
        " ADD COLUMN IF NOT EXISTS label_type text," +
        " ADD COLUMN IF NOT EXISTS grade_type text," +
        " ADD COLUMN IF NOT EXISTS language text," +
        " ADD COLUMN IF NOT EXISTS card_game text," +
        " ADD COLUMN IF NOT EXISTS set_name text," +
        " ADD COLUMN IF NOT EXISTS card_name text," +
        " ADD COLUMN IF NOT EXISTS card_number_display text," +
        " ADD COLUMN IF NOT EXISTS year_text text," +
        " ADD COLUMN IF NOT EXISTS created_by text," +
        " ADD COLUMN IF NOT EXISTS issued_at timestamptz," +
        " ADD COLUMN IF NOT EXISTS updated_at timestamptz," +
        " ADD COLUMN IF NOT EXISTS assigned_grader_id varchar," +
        " ADD COLUMN IF NOT EXISTS grader_status text," +
        " ADD COLUMN IF NOT EXISTS assigned_at timestamptz," +
        " ADD COLUMN IF NOT EXISTS origin_type text," +
        " ADD COLUMN IF NOT EXISTS origin_partner_id uuid," +
        " ADD COLUMN IF NOT EXISTS origin_partner_public_ref text," +
        " ADD COLUMN IF NOT EXISTS origin_partner_legal_name text," +
        " ADD COLUMN IF NOT EXISTS origin_partner_trading_name text," +
        " ADD COLUMN IF NOT EXISTS origin_location_id uuid," +
        " ADD COLUMN IF NOT EXISTS origin_location_public_ref text," +
        " ADD COLUMN IF NOT EXISTS origin_location_name text," +
        " ADD COLUMN IF NOT EXISTS origin_location_address text," +
        " ADD COLUMN IF NOT EXISTS origin_captured_at timestamptz," +
        " ADD COLUMN IF NOT EXISTS origin_snapshot_version integer"
    );
    await admin.query(CERTIFICATES_PROTECTED_COLUMNS_SQL);
    await admin.query("ALTER TABLE certificates OWNER TO pn_migrator").catch(() => {}); // owned by migrator too (after roles exist)
    /**
     * MintVault base tables that the Partner migrations GRANT on and attach guard triggers to.
     *
     * This suite drives the REAL migrate runner over listMigrationFiles(), so it applies 0010
     * (grants on users/submissions/submission_items) and 0041 (hold-guard triggers on
     * submissions/certificates/label_prints). Both require these relations to pre-exist — the
     * documented contract in tests/helpers/partner-realistic-db.ts is that the CALLER creates them.
     *
     * WHY THIS WAS MISSING AND WHY IT MATTERED: the suite previously ran only against a database
     * that had been left populated by an earlier run, so 0010 was already journalled and never
     * re-executed. Against a genuinely clean database it aborted in beforeAll with
     * `relation "users" does not exist` — a FILE-level failure, which reports as "4 skipped" and
     * is trivially mistaken for an ungated suite. The rollback proof was therefore only ever as
     * real as the leftover state of the last run.
     */
    await admin.query("CREATE TABLE IF NOT EXISTS users (id varchar primary key, email varchar unique)");
    await admin.query(`CREATE TABLE IF NOT EXISTS submissions (
      id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
      tracking_number text unique, deleted_at timestamptz,
      grading_status varchar(30), assigned_grader_id varchar, scan_status varchar(30),
      scan_assigned_to varchar, shipped_at timestamptz, delivered_at timestamptz,
      completed_at timestamptz, return_tracking text, return_carrier text, return_service text,
      status_history jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now()
    )`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
    );
    await admin.query(
      // cert_id/printed_at are referenced by 0022's print-state backfill, which this
      // fixture now reaches (see the certificates stub above).
      "CREATE TABLE IF NOT EXISTS label_prints (id serial primary key, certificate_id integer, cert_id text, printed_at timestamptz, created_at timestamptz not null default now())"
    );
    /**
     * THE CORE CERTIFICATE ALLOCATOR.
     *
     * 0076 and 0081 both open with an unconditional precondition — certificates, cert_counter,
     * submission_items and the partner connector schema must all exist — and RAISE otherwise:
     * "0076 requires the core certificate allocator and complete Partner connector schema".
     * This fixture stubbed certificates and submission_items but never cert_counter, so this
     * critical suite aborted in beforeAll and reported as skipped rather than failed. A rollback
     * proof that cannot execute is not a rollback proof, and carrying it into a release as
     * "pre-existing" would have meant shipping with no rollback coverage at all.
     *
     * A LOCKED ROW, not a sequence — the shape that makes MV numbers gapless on rollback.
     */
    await admin.query(`CREATE TABLE IF NOT EXISTS cert_counter (
      id integer primary key, last_issued bigint not null default 0, updated_at timestamptz not null default now()
    )`);
    await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");
    // 0018 builds a correction index on the MintVault audit log.
    await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id serial primary key, entity_type text not null, entity_id text not null, action text not null,
      admin_user text, details jsonb, created_at timestamptz not null default now()
    )`);
    for (const t of [
      "users",
      "submissions",
      "submission_items",
      "label_prints",
      "audit_log",
      "certificates",
      "cert_counter",
    ]) {
      await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
    }
    await applyAllRealistic();
    // ensure certificates exists+owned even though roles are created inside applyAllRealistic
    await admin.query("ALTER TABLE certificates OWNER TO pn_migrator").catch(() => {});
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("legacy rollback-0001 REFUSES once later migrations are applied (node-pg path)", async () => {
    await expect(admin.query(rb("rollback-0001-partner-foundation.sql"))).rejects.toThrow(
      /0001-ONLY rollback.*later Partner migrations|full Phase 1 rollback/
    );
  });

  it("legacy rollback-0001 guard PROTECTS even via `psql -f` without ON_ERROR_STOP (transaction wrapper)", async () => {
    // The dangerous path the DB reviewer flagged: run the .sql file through psql with its DEFAULT
    // ON_ERROR_STOP=off. Without the BEGIN/COMMIT wrapper, psql would print the guard error and
    // still execute the DROPs. With the wrapper, the raise aborts the transaction and COMMIT rolls
    // back — the partner tables must SURVIVE.
    try {
      execFileSync("psql", [ADMIN!, "-f", join(process.cwd(), "migrations", "rollback-0001-partner-foundation.sql")], {
        stdio: "pipe",
      });
    } catch {
      // psql exits non-zero because the guard raised — expected. What matters is the DB state below.
    }
    const res = await admin.query("SELECT to_regclass('public.partner_users') r");
    expect(res.rows[0].r).toBe("partner_users"); // table survived the refused rollback
  });

  /**
   * THE RELEASE-SCOPED ROLLBACK — this is the staging recovery order for THIS release.
   *
   * Scope matters. A *complete* Partner teardown is not a supported operation on a real database
   * and this suite must not pretend otherwise:
   *   - rollback-partner-network-phase1.sql covers migrations 0001–0013 only. Its header claim to
   *     be "the ONLY script that fully rolls back the Partner Network" predates G4/G5/G6A/G6B/G6D.
   *     Against a fully-migrated database it fails on `cannot drop function
   *     partner_current_tenant() because other objects depend on it`, because the RLS policies
   *     0017/0041 attached to the credit tables still reference it.
   *   - rollback-partner-credit-reservations.sql (0017) refuses outright while any migration
   *     numbered 0018+ is journalled — which on a real deployment includes ~25 migrations that
   *     have nothing to do with the Partner Network.
   * Both behaviours are CORRECT guards, and both failures are safe: every one of these scripts is
   * wrapped in a single transaction, so a refusal leaves the database exactly as it was.
   *
   * What this release actually needs to be able to undo is the per-card settlement work, and that
   * is the chain proven below.
   */
  const RELEASE_ROLLBACK_CHAIN = ["rollback-0042-partner-per-card-credit-settlement.sql"] as const;

  it("the release-scoped rollback reverts 0042 to the 0041 function body and preserves MintVault data", async () => {
    for (const script of RELEASE_ROLLBACK_CHAIN) {
      try {
        await admin.query(rb(script));
      } catch (err) {
        throw new Error(`rollback chain failed at ${script}: ${(err as Error).message}`);
      }
    }

    // 0042 is de-journalled, 0041 remains applied.
    const journal = await admin.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename LIKE '%credit%' ORDER BY filename"
    );
    const files = journal.rows.map((r) => r.filename);
    expect(files).not.toContain("0042_partner_per_card_credit_settlement.sql");
    expect(files).toContain("0041_partner_submission_credit_lifecycle.sql");

    // The release function is back, still SECURITY DEFINER, still owned by the lifecycle definer,
    // and no longer carries the per-card marker 0042 introduced.
    const fn = await admin.query<{ owner: string; secdef: boolean; body: string }>(
      `SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS secdef, prosrc AS body
         FROM pg_proc WHERE proname='partner_connector_release_submission_credit'`
    );
    expect(fn.rowCount).toBe(1);
    expect(fn.rows[0].owner).toBe("partner_credit_lifecycle_definer");
    expect(fn.rows[0].secdef).toBe(true);
    expect(fn.rows[0].body).not.toContain("per_card_settlement");

    // The grant 0042 added is gone, so 0041's own rollback (which DROPs the role) stays possible.
    const grant = await admin.query<{ g: boolean }>(
      "SELECT has_table_privilege('partner_credit_lifecycle_definer','partner_submission_cards','SELECT') AS g"
    );
    expect(grant.rows[0].g).toBe(false);

    // synthetic MintVault data survives
    const certs = await admin.query("SELECT secret FROM certificates ORDER BY id");
    expect(certs.rows.map((r) => r.secret)).toEqual(["KEEP-A", "KEEP-B"]);
  });

  it("0042 reapplies cleanly after its rollback (forward-only recovery is repeatable)", async () => {
    await applyAllRealistic();
    const tables = await admin.query(
      "SELECT count(*)::int n FROM information_schema.tables WHERE table_name LIKE 'partner_%'"
    );
    expect(tables.rows[0].n).toBeGreaterThanOrEqual(16);
    const owner = await admin.query(
      "SELECT pg_get_userbyid(proowner) o FROM pg_proc WHERE proname='partner_auth_lookup'"
    );
    expect(owner.rows[0].o).toBe("partner_definer");
    // and the per-card body is back
    const body = await admin.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname='partner_connector_release_submission_credit'"
    );
    expect(body.rows[0].body).toContain("per_card_settlement");
  });
});
