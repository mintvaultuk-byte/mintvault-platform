/**
 * Trusted Intake Connector — Phase G1: migration/rollback/preflight proof (disposable Postgres,
 * realistic non-superuser role model — mirrors tests/partner-rollback.test.ts's pattern).
 *
 * Proves:
 *   - migration 0008 applies on a fresh database and is journaled;
 *   - reapplying the FULL migration set is a clean no-op (0 newly applied);
 *   - preflight reports zero unknown objects after 0008;
 *   - partner_connector_runtime is NOSUPERUSER/NOBYPASSRLS, and PUBLIC has no privilege on either
 *     new table;
 *   - the G1-only rollback removes exactly the two new tables + the new role and nothing else —
 *     partner_submission_handoffs, partner_submissions, and synthetic pre-existing MintVault data
 *     all survive;
 *   - migrations reapply cleanly after rollback.
 *
 * Runs ONLY when PARTNER_CONNECTOR_MIGRATION_ADMIN is set (superuser URL to a DISPOSABLE local
 * Postgres that is the ONLY partner database in its cluster):
 *   PARTNER_CONNECTOR_MIGRATION_ADMIN=postgresql://postgres@127.0.0.1:5550/dispo \
 *   npx vitest run tests/partner-connector-migration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { provisionRealisticRoles, migratorUrlFrom, applyEveryMigrationRealistic, partnerScopeOnly } from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { runPreflight } from "../scripts/db/preflight-schema";

const ADMIN = process.env.PARTNER_CONNECTOR_MIGRATION_ADMIN;
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN);

let admin: Client;
const rb = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

/**
 * The partner migration filenames the journal query (`filename LIKE '00%_partner%'`) selects,
 * derived from the migrations directory instead of hard-coded.
 *
 * SQL LIKE semantics: `_` is a SINGLE-CHARACTER wildcard, so '00%_partner%' means "starts with 00,
 * then anything, then any one character, then partner, then anything" — the regex below is the
 * equivalent. Sorted by filename to match the query's ORDER BY.
 */
function partnerMigrationFilenames(): string[] {
  return listMigrationFiles()
    .map((f) => f.filename)
    .filter((n) => /^00.+partner/.test(n))
    .sort();
}

function expectedPartnerJournalCount(): number {
  return partnerMigrationFilenames().length;
}

async function applyAllRealistic(): Promise<void> {
  await provisionRealisticRoles(admin);
  const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await migrator.connect();
  try {
    await applyEveryMigrationRealistic(migrator);
  } finally {
    await migrator.end();
  }
}

(isLocal ? describe : describe.skip)(
  "Trusted Intake Connector G1 — migration, preflight, rollback (disposable DB)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      // synthetic PRE-EXISTING MintVault data that must survive the G1 rollback
      await admin.query("CREATE TABLE IF NOT EXISTS certificates (id serial primary key, cert_id text, secret text)");
      await admin.query("INSERT INTO certificates (cert_id, secret) VALUES ('MV1','KEEP-A')");
      // Minimal representative MintVault tables — migration 0010 (G3, applied below via
      // listMigrationFiles(), which discovers every migration file present including 0010) grants
      // partner_connector_runtime access to these, so they must exist and be owned by pn_migrator
      // before migrations run. pn_migrator itself must exist FIRST (provisionRealisticRoles creates
      // it) — ALTER TABLE ... OWNER TO a not-yet-existing role fails silently under .catch(() => {}),
      // which otherwise masks this ordering bug entirely.
      await provisionRealisticRoles(admin);
      await admin.query(
        "CREATE TABLE IF NOT EXISTS users (id varchar primary key default gen_random_uuid(), email varchar unique)"
      );
      await admin.query(
        "CREATE TABLE IF NOT EXISTS submissions (id serial primary key, user_id varchar not null, tracking_number text not null unique)"
      );
      await admin.query(
        "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
      );
      await admin.query("ALTER TABLE users OWNER TO pn_migrator");
      await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
      await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
      await applyAllRealistic();
      await admin.query("ALTER TABLE certificates OWNER TO pn_migrator").catch(() => {});
    }, 60_000);

    afterAll(async () => {
      await admin?.end().catch(() => {});
    });

    it("applies migration 0008 and journals it", async () => {
      const { rows } = await admin.query(
        "SELECT status FROM schema_migrations WHERE filename = '0008_partner_connector_foundation.sql'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
    });

    it("every partner migration journal row is present and applied", async () => {
      const { rows } = await admin.query(
        "SELECT filename, status FROM schema_migrations WHERE filename LIKE '00%_partner%' ORDER BY filename"
      );
      // Derived from migrations/, NOT hard-coded. This assertion previously read `toHaveLength(15)`
      // and had rotted to 19 as later partner migrations landed — and because this whole suite was
      // never wired into CI, nobody saw it. Substituting a new magic number just re-arms the same
      // trap for the next migration, so the expectation is computed from the same source of truth
      // the journal is populated from.
      expect(rows).toHaveLength(expectedPartnerJournalCount());
      expect(rows.map((r) => r.filename)).toEqual(partnerMigrationFilenames());
      for (const r of rows) expect(r.status).toBe("applied");
    });

    it("reapplying the full migration set is a clean no-op", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const plan = await planMigrations(migrator, partnerScopeOnly(listMigrationFiles()));
        expect(plan.pending).toHaveLength(0);
        expect(plan.checksumMismatches).toHaveLength(0);
        expect(plan.inconsistent).toHaveLength(0);
        const { applied } = await applyMigrations(migrator, partnerScopeOnly(listMigrationFiles()));
        expect(applied).toHaveLength(0);
      } finally {
        await migrator.end();
      }
    });

    it("preflight reports zero unknown objects", async () => {
      const result = await runPreflight(ADMIN!);
      expect(result.definerViolations).toEqual([]);
      expect(result.unknown).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("the two new tables exist and are classified as Partner Network (not unknown)", async () => {
      const result = await runPreflight(ADMIN!);
      expect(result.partnerNetwork).toEqual(
        expect.arrayContaining(["partner_connector_records", "partner_connector_events"])
      );
    });

    it("partner_connector_runtime is NOLOGIN, NOSUPERUSER, NOBYPASSRLS", async () => {
      const { rows } = await admin.query(
        "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'partner_connector_runtime'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolcanlogin).toBe(false);
      expect(rows[0].rolsuper).toBe(false);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("PUBLIC has no privilege on either new connector table", async () => {
      const priv = async (table: string) =>
        admin.query<{ has: boolean }>("SELECT has_table_privilege('public', $1, 'SELECT') AS has", [table]);
      const records = await priv("partner_connector_records");
      const events = await priv("partner_connector_events");
      expect(records.rows[0].has).toBe(false);
      expect(events.rows[0].has).toBe(false);
    });

    it("only partner_connector_runtime holds DML on the two new tables (partner_runtime holds none)", async () => {
      const { rows } = await admin.query<{ grantee: string; table_name: string; privilege_type: string }>(
        `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_name IN ('partner_connector_records','partner_connector_events')
          AND table_schema = 'public'`
      );
      const grantees = new Set(rows.map((r) => r.grantee));
      expect(grantees.has("partner_runtime")).toBe(false);
      expect(grantees.has("partner_connector_runtime")).toBe(true);
    });

    it("G1-only rollback REFUSES once migration 0009 (G2) is present, and changes nothing", async () => {
      // Mirrors the established rollback-0001-partner-foundation.sql refusal pattern (see
      // tests/partner-rollback.test.ts) — a G1-only rollback must not silently CASCADE-drop G2's
      // dependent validation tables while leaving schema_migrations claiming 0009 is still applied.
      await expect(admin.query(rb("rollback-partner-connector-g1.sql"))).rejects.toThrow(
        /refuses to run.*migration 0009/i
      );
      // The refused script's own BEGIN was never matched by a COMMIT (it errored first), which
      // leaves this connection's session in "aborted transaction" state for any further query —
      // reset it explicitly before the next test reuses `admin`.
      await admin.query("ROLLBACK").catch(() => {});

      // Nothing changed: G1 objects, G2 objects, and the journal are all untouched by the refused attempt.
      const records = await admin.query("SELECT to_regclass('public.partner_connector_records') r");
      expect(records.rows[0].r).toBe("partner_connector_records");
      const validationRuns = await admin.query("SELECT to_regclass('public.partner_connector_validation_runs') r");
      expect(validationRuns.rows[0].r).toBe("partner_connector_validation_runs");
      const journal = await admin.query(
        "SELECT count(*)::int n FROM schema_migrations WHERE filename IN ('0008_partner_connector_foundation.sql','0009_partner_connector_validation.sql')"
      );
      expect(journal.rows[0].n).toBe(2);
    });

    it("G2 rollback REFUSES once migration 0010 (G3) is present, and changes nothing", async () => {
      await expect(admin.query(rb("rollback-partner-connector-g2.sql"))).rejects.toThrow(
        /refuses to run.*migration 0010/i
      );
      await admin.query("ROLLBACK").catch(() => {});
      const imports = await admin.query("SELECT to_regclass('public.partner_connector_imports') r");
      expect(imports.rows[0].r).toBe("partner_connector_imports");
    });

    it("G3 rollback REFUSES once migration 0011 (G3E) is present, and changes nothing", async () => {
      await expect(admin.query(rb("rollback-partner-connector-g3.sql"))).rejects.toThrow(
        /refuses to run.*migration 0011/i
      );
      await admin.query("ROLLBACK").catch(() => {});
      const records = await admin.query("SELECT to_regclass('public.partner_connector_records') r");
      expect(records.rows[0].r).toBe("partner_connector_records");
    });

    it("G3E rollback REFUSES once migration 0012 (G3F) is present, and changes nothing", async () => {
      await expect(admin.query(rb("rollback-partner-connector-g3e.sql"))).rejects.toThrow(
        /refuses to run.*migration 0012/i
      );
      await admin.query("ROLLBACK").catch(() => {});
      const attempts = await admin.query("SELECT to_regclass('public.partner_connector_import_attempts') r");
      expect(attempts.rows[0].r).toBe("partner_connector_import_attempts");
    });

    // G3F/G3E/G3/G2 guard on OBJECT PRESENCE (to_regclass), so they still unwind in order. G1 is
    // where the chain now stops, and it stops SAFELY: migration 0014 (G4) grants on
    // partner_connector_runtime, so PostgreSQL's own dependency tracking refuses the role drop, and
    // because the whole script is one transaction the refusal is ATOMIC — G1's tables are not
    // half-dropped. Rolling 0014 back first is not an option: it refuses while 0015+ are applied,
    // and the migrations above it (0018/0022/0023/0024) ship no rollback script at all.
    //
    // This is fail-closed behaviour working as designed, not a defect: nothing is silently dropped
    // and no Phase 1/2 data is at risk. The assertion covers exactly that — the four layers that DO
    // unwind, the G1 refusal, its atomicity, and the survival of everything it must not touch.
    it("rolling back G3F, G3E, G3, G2 unwinds them; G1 then fails closed atomically with 0014 applied", async () => {
      await admin.query(rb("rollback-partner-connector-g3f.sql"));
      await admin.query(rb("rollback-partner-connector-g3e.sql"));
      await admin.query(rb("rollback-partner-connector-g3.sql"));
      await admin.query(rb("rollback-partner-connector-g2.sql"));

      // The four layers above G1 are gone.
      const attempts = await admin.query("SELECT to_regclass('public.partner_connector_import_attempts') r");
      expect(attempts.rows[0].r).toBeNull();
      const validationRuns = await admin.query("SELECT to_regclass('public.partner_connector_validation_runs') r");
      expect(validationRuns.rows[0].r).toBeNull();

      // G1 refuses: 0014's admin-actions table still holds grants on partner_connector_runtime.
      await expect(admin.query(rb("rollback-partner-connector-g1.sql"))).rejects.toThrow(
        /partner_connector_runtime.*cannot be dropped because some objects depend on it/i
      );
      await admin.query("ROLLBACK").catch(() => {});

      // ATOMIC: G1's own objects are untouched by the refused attempt — not half-dropped.
      const records = await admin.query("SELECT to_regclass('public.partner_connector_records') r");
      const events = await admin.query("SELECT to_regclass('public.partner_connector_events') r");
      expect(records.rows[0].r).toBe("partner_connector_records");
      expect(events.rows[0].r).toBe("partner_connector_events");
      const role = await admin.query(
        "SELECT count(*)::int n FROM pg_roles WHERE rolname = 'partner_connector_runtime'"
      );
      expect(role.rows[0].n).toBe(1);
      const g1Journal = await admin.query(
        "SELECT count(*)::int n FROM schema_migrations WHERE filename = '0008_partner_connector_foundation.sql'"
      );
      expect(g1Journal.rows[0].n).toBe(1);

      // Phase 1/2 objects survive untouched.
      const handoffs = await admin.query("SELECT to_regclass('public.partner_submission_handoffs') r");
      expect(handoffs.rows[0].r).toBe("partner_submission_handoffs");
      const submissions = await admin.query("SELECT to_regclass('public.partner_submissions') r");
      expect(submissions.rows[0].r).toBe("partner_submissions");
      const runtimeRole = await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname = 'partner_runtime'");
      expect(runtimeRole.rows[0].n).toBe(1);

      // Synthetic pre-existing MintVault data survives.
      const certs = await admin.query("SELECT secret FROM certificates ORDER BY id");
      expect(certs.rows.map((r) => r.secret)).toEqual(["KEEP-A"]);

      // The layers that DID roll back left the journal consistent (0009 removed, 0008 retained).
      const journal = await admin.query(
        "SELECT count(*)::int n FROM schema_migrations WHERE filename = '0009_partner_connector_validation.sql'"
      );
      expect(journal.rows[0].n).toBe(0);
    });

    it("migrations 0009–0013 reapply cleanly after the partial rollback", async () => {
      const migrator = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
      await migrator.connect();
      try {
        const { applied } = await applyMigrations(migrator, partnerScopeOnly(listMigrationFiles()));
        // 0008 was never rolled back (G1 fails closed above), so it is correctly NOT reapplied.
        expect(applied).not.toContain("0008_partner_connector_foundation.sql");
        expect(applied).toContain("0009_partner_connector_validation.sql");
        expect(applied).toContain("0010_partner_connector_import.sql");
        expect(applied).toContain("0011_partner_connector_reconciliation.sql");
        expect(applied).toContain("0012_partner_connector_import_attempts.sql");
        expect(applied).toContain("0013_partner_connector_claim_index.sql");
      } finally {
        await migrator.end();
      }
      const result = await runPreflight(ADMIN!);
      expect(result.ok).toBe(true);
    });
  }
);
