/**
 * Partner grading bridge — migration 0049 apply / rollback / reapply proof on a disposable
 * PostgreSQL 17 with the realistic NON-SUPERUSER, NOBYPASSRLS migrator role model.
 *
 * 0049 is the only migration on this branch that has never been applied anywhere real, and its
 * rollback is the file an operator would reach for at the worst possible moment. So the rollback is
 * tested here at least as hard as the forward migration.
 *
 * WHY THE ROLE MODEL MATTERS. Every statement runs as pn_migrator: NOSUPERUSER, NOBYPASSRLS, owner
 * of the schema. That is what a deployed migrator actually is. Running this proof as a superuser
 * would hide the single worst defect the rollback ever had — see T7 — because a superuser has
 * BYPASSRLS and therefore sees rows the real migrator cannot.
 *
 * T7 is the one to read first. 0049 sets FORCE ROW LEVEL SECURITY, which applies the tenant policy
 * to the table OWNER too. With no app.tenant_id set, partner_current_tenant() is NULL, every row is
 * filtered, and the rollback's "is there live grading evidence?" count returned 0 WITH A LINKED ROW
 * PRESENT. The guard was blind: it dropped the table and COMMITTED. This suite pins the repair by
 * seeding real evidence and asserting the rollback REFUSES — as the migrator, not as a superuser.
 *
 * Runs ONLY when PARTNER_GRADING_BRIDGE_MIGRATION_ADMIN is a superuser URL to a DISPOSABLE loopback
 * PostgreSQL that is the ONLY partner database in its cluster. The admin connection exists solely to
 * provision roles and to observe rows the migrator is not allowed to see; every migration and every
 * rollback runs as pn_migrator.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  migratorUrlFrom,
  createMintvaultCertificatesTable,
  createMintvaultLabelPrintsTable,
} from "./helpers/partner-realistic-db";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";

const ADMIN = process.env.PARTNER_GRADING_BRIDGE_MIGRATION_ADMIN;
function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN);

const MIGRATION = "0049_partner_grading_work_items.sql";
const ROLLBACK = "rollback-0049-partner-grading-work-items.sql";
const rb = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

/** Two tenants, so RLS isolation is provable rather than assumed. */
const A = "aaaa1111-0000-0000-0000-000000000045";
const B = "bbbb2222-0000-0000-0000-000000000045";

let admin: Client;

/** A fresh pn_migrator connection. Every migration/rollback runs through one of these. */
async function migratorClient(): Promise<Client> {
  const c = new Client({ connectionString: migratorUrlFrom(ADMIN!) });
  await c.connect();
  return c;
}

async function applyAllRealistic(): Promise<void> {
  const migrator = await migratorClient();
  try {
    /**
     * ORDER IS LOAD-BEARING. 0041 revokes its own SET/INHERIT membership as its final act, so the
     * INHERIT repair grant must land BETWEEN 0041 and 0042 — granting it up front is silently
     * undone and 0042 then fails closed.
     *
     * allowDestructive: 0043 drops the single-hold-per-destination unique index. The runner
     * correctly refuses destructive SQL unless the operator opts in; that is safe on this suite's
     * own disposable database and still requires owner approval anywhere real.
     */
    const all = listMigrationFiles();
    await applyMigrations(
      migrator,
      all.filter((f) => Number(f.number) <= 41),
      { allowDestructive: true }
    );
    await migrator.query("GRANT partner_credit_lifecycle_definer TO pn_migrator WITH INHERIT TRUE, SET FALSE");
    await applyMigrations(migrator, all, { allowDestructive: true });
  } finally {
    await migrator.end();
  }
}

/** Run the rollback file as the MIGRATOR. Resolves on success, rejects with the server error. */
async function runRollbackAsMigrator(): Promise<void> {
  const migrator = await migratorClient();
  try {
    await migrator.query(rb(ROLLBACK));
  } finally {
    await migrator.end();
  }
}

/**
 * Roll back everything ABOVE 0049, newest first, as the migrator.
 *
 * This suite applies the FULL migration set, so 0050-0056 now sit above 0049. Every rollback in
 * that series refuses while a higher-numbered journal row exists — correctly — so rollback-0049
 * cannot be exercised in isolation any more, and T7-T12 were failing with
 * "rollback-0049 refused: 7 later migration journal row(s) exist" instead of the 0049-specific
 * refusals they exist to pin. Descending order is the supported recovery path (each file
 * de-journals itself), so this reproduces exactly what an operator would do before touching 0049.
 */
async function rollBackEverythingAbove0049(): Promise<void> {
  const migrator = await migratorClient();
  try {
    const higher = [
      // NEWEST FIRST, and every file above 0049 must be listed. Several of these carry their own
      // descending-order guard (rollback-0052 refuses while anything >52 is journalled,
      // rollback-0053 while anything >53), so omitting a newer file does not merely leave one
      // stray row — it makes the middle of this list refuse too, and 0049 then reports several
      // remaining rows rather than the one that was actually forgotten. Add new rollbacks here.
      "rollback-0057-partner-credits-purchase-permission.sql",
      "rollback-0056-partner-hq-control-tables-write-deny.sql",
      "rollback-0055-partner-ledger-preserve-search-path.sql",
      "rollback-0054-cert-counter-monotonic-allocator.sql",
      "rollback-0053-partner-mfa-failure-lockout.sql",
      "rollback-0052-partner-internal-evidence-rls.sql",
      "rollback-0051-partner-runtime-flag-control-least-privilege.sql",
      "rollback-0050-partner-connector-profile-read.sql",
    ];
    for (const f of higher) await migrator.query(rb(f));
  } finally {
    await migrator.end();
  }
}

/** Apply ONLY 0049 as the migrator (used to prove reapply after a successful rollback). */
async function applyGradingBridgeOnly(): Promise<void> {
  const migrator = await migratorClient();
  try {
    const only = listMigrationFiles().filter((f) => f.filename === MIGRATION);
    expect(only, "0049 must be discoverable by the real migration runner").toHaveLength(1);
    await applyMigrations(migrator, only, { allowDestructive: true });
  } finally {
    await migrator.end();
  }
}

/**
 * Seed the full FK chain 0049 requires, and return one work-item's identifiers.
 *
 * Inserted through the ADMIN connection: this is fixture construction, not the thing under test,
 * and the rows must exist regardless of RLS. What the tests actually prove is what the MIGRATOR can
 * see and do afterwards.
 */
let seedCounter = 0;

async function seedWorkItem(tenant: string, opts: { linkCertificate?: boolean } = {}): Promise<string> {
  // Unique per call, so re-seeding within a run (and re-running against a reused database) cannot
  // collide on the unique keys these tables carry.
  const suffix = `${tenant.slice(0, 8)}-${++seedCounter}-${process.pid}`;
  const { rows: user } = await admin.query<{ id: string }>(
    `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, status)
     VALUES ($1, $1, $2, 'Bridge', 'ACTIVE') RETURNING id`,
    [tenant, `bridge-${suffix}@example.test`]
  );
  const { rows: loc } = await admin.query<{ id: string }>(
    `INSERT INTO partner_locations (tenant_id, partner_id, public_ref, name, status)
     VALUES ($1, $1, $2, 'Bridge Location', 'ACTIVE') RETURNING id`,
    [tenant, `loc-${suffix}`]
  );
  const { rows: sub } = await admin.query<{ id: string }>(
    `INSERT INTO partner_submissions (tenant_id, location_id, created_by, status)
     VALUES ($1, $2, $3, 'submitted_to_mintvault') RETURNING id`,
    [tenant, loc[0].id, user[0].id]
  );
  const { rows: card } = await admin.query<{ id: string }>(
    `INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, quantity)
     VALUES ($1, $2, 1, 'Charizard', 1) RETURNING id`,
    [tenant, sub[0].id]
  );
  const { rows: handoff } = await admin.query<{ id: string }>(
    `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot)
     VALUES ($1, $2, 'pending', '{}'::jsonb) RETURNING id`,
    [tenant, sub[0].id]
  );
  const { rows: dest } = await admin.query<{ id: number }>(
    `INSERT INTO submissions (user_id, tracking_number) VALUES (NULL, $1) RETURNING id`,
    [`track-${suffix}`]
  );
  const { rows: item } = await admin.query<{ id: number }>(
    `INSERT INTO submission_items (submission_id) VALUES ($1) RETURNING id`,
    [dest[0].id]
  );
  const { rows: rec } = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records (tenant_id, partner_submission_id, handoff_id, source_handoff_idempotency_key, state)
     VALUES ($1, $2, $3, $4, 'imported') RETURNING id`,
    [tenant, sub[0].id, handoff[0].id, `idem-${suffix}`]
  );
  const { rows: vr } = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_validation_runs
       (connector_record_id, validation_attempt, source_submission_version, source_handoff_status,
        source_fingerprint, source_fingerprint_version, outcome)
     VALUES ($1, 1, 1, 'pending', $2, 1, 'valid') RETURNING id`,
    [rec[0].id, `fp-${suffix}`]
  );
  const { rows: imp } = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_imports
       (connector_record_id, partner_organisation_id, partner_location_id, partner_submission_id,
        partner_handoff_id, validation_run_id, destination_submission_id,
        source_fingerprint, source_fingerprint_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) RETURNING id`,
    [rec[0].id, tenant, loc[0].id, sub[0].id, handoff[0].id, vr[0].id, dest[0].id, `fp-${suffix}`]
  );
  /**
   * 0049 links a work item to a certificate through a COMPOSITE foreign key —
   * REFERENCES certificates(id, submission_id, submission_item_id) — backed by the unique index it
   * creates on the protected certificates table. A certificate row whose submission_id/
   * submission_item_id do not match this work item's destination is rejected, by design: it is what
   * stops a work item pointing at a certificate belonging to a different submission. So the
   * certificate has to be minted here, against THIS destination, rather than passed in.
   */
  let certificateId: number | null = null;
  if (opts.linkCertificate) {
    const { rows: cert } = await admin.query<{ id: number }>(
      `INSERT INTO certificates (cert_id, secret, certificate_number, submission_id, submission_item_id)
       VALUES ($1, 's', $2, $3, $4) RETURNING id`,
      [`MV45-${suffix}`, `MV-45-${suffix}`, dest[0].id, item[0].id]
    );
    certificateId = cert[0].id;
  }

  const { rows: wi } = await admin.query<{ id: string }>(
    `INSERT INTO partner_grading_work_items (
       tenant_id, partner_organisation_id, partner_location_id, partner_submission_id,
       partner_submission_card_id, partner_handoff_id, connector_import_id, connector_record_id,
       validation_run_id, destination_submission_id, submission_item_id, card_ordinal,
       front_image_key, back_image_key, certificate_id, certificate_linked_at
     ) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,
               CASE WHEN $13::integer IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [
      tenant,
      loc[0].id,
      sub[0].id,
      card[0].id,
      handoff[0].id,
      imp[0].id,
      rec[0].id,
      vr[0].id,
      dest[0].id,
      item[0].id,
      `partner-submissions/${tenant}/${sub[0].id}/${card[0].id}/front-seed.jpg`,
      `partner-submissions/${tenant}/${sub[0].id}/${card[0].id}/back-seed.jpg`,
      certificateId,
    ]
  );
  return wi[0].id;
}

(isLocal ? describe : describe.skip)(
  "Partner grading bridge — migration 0049 apply/rollback/reapply (disposable DB, realistic roles)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await provisionRealisticRoles(admin);
      // MintVault base tables the migration chain grants against / alters. Owned by pn_migrator,
      // because the migrations run as that non-superuser role and would otherwise hit
      // "must be owner of table".
      await admin.query(
        "CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE)"
      );
      await admin.query(
        "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
      );
      await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer NOT NULL)");
      await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
        admin_user text, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await createMintvaultCertificatesTable(admin);
      await createMintvaultLabelPrintsTable(admin);
      /**
       * cert_counter is a MintVault table no migration creates, and 0049 grants against it only
       * `IF to_regclass('public.cert_counter') IS NOT NULL`. Without it the grant silently no-ops
       * and T6/T10/T11/T12 would assert on privileges that were never granted — passing or failing
       * for reasons unrelated to the rollback. It must exist for those proofs to mean anything.
       */
      // MUST match storage.ts:1336-1340 / 0054's definition verbatim — see the note in
      // tests/partner-security-repairs-0047-0048.test.ts. A `value` column here made 0052's
      // column-level GRANT (last_issued, updated_at) a hard 42703, aborting the chain in beforeAll
      // and rendering this suite as "12 skipped" rather than red.
      await admin.query(`CREATE TABLE IF NOT EXISTS cert_counter (
         id integer PRIMARY KEY DEFAULT 1,
         last_issued integer NOT NULL DEFAULT 0,
         updated_at timestamptz NOT NULL DEFAULT NOW()
       )`);
      for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints", "cert_counter"]) {
        await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
      }
      await applyAllRealistic();
      await admin.query(
        `INSERT INTO partner_organisations (id, public_ref, legal_name, status)
         VALUES ($1,'rA45','A45 Ltd','ACTIVE'),($2,'rB45','B45 Ltd','ACTIVE') ON CONFLICT DO NOTHING`,
        [A, B]
      );
    }, 120_000);

    afterAll(async () => {
      await admin?.query("RESET ROLE").catch(() => {});
      await admin?.end().catch(() => {});
    });

    it("T1: 0049 is applied and journaled with a checksum", async () => {
      const { rows } = await admin.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM schema_migrations WHERE filename = $1",
        [MIGRATION]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it("T2: reapplying the full set is a clean no-op — 0049 is not pending", async () => {
      const migrator = await migratorClient();
      try {
        const plan = await planMigrations(migrator, listMigrationFiles());
        expect(plan.pending).not.toContain(MIGRATION);
        // The field is `checksumMismatches`. An earlier revision read `plan.changed`, which does
        // not exist on MigratePlan — `undefined ?? []` made the assertion unfailable, so the
        // checksum-drift proof for 0049 proved nothing. Test files are excluded from `npm run
        // check` (tsconfig `exclude: **/*.test.ts`), so tsc never flagged the bad property.
        expect(plan.checksumMismatches, "no applied migration may have drifted from its checksum").toEqual([]);
        // Non-vacuity: the plan really did inspect the journal, so an empty mismatch list is a
        // finding rather than an artefact of nothing having been read.
        expect(plan.alreadyApplied, "the plan must have observed applied migrations").toContain(MIGRATION);
      } finally {
        await migrator.end();
      }
    });

    it("T3: the work-items table exists with FORCE row level security and a tenant policy", async () => {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid = 'public.partner_grading_work_items'::regclass`
      );
      expect(rows[0].relrowsecurity).toBe(true);
      // FORCE is what makes the policy apply to the OWNER too. It is also precisely what made the
      // original rollback guard blind, so it is asserted explicitly rather than assumed.
      expect(rows[0].relforcerowsecurity).toBe(true);
      const { rows: pol } = await admin.query<{ polname: string }>(
        `SELECT polname FROM pg_policy WHERE polrelid = 'public.partner_grading_work_items'::regclass`
      );
      expect(pol.map((p) => p.polname)).toContain("partner_grading_work_items_tenant_isolation");
    });

    it("T4: partner_runtime cannot read another tenant's work items", async () => {
      await seedWorkItem(A);
      await seedWorkItem(B);
      await admin.query("SET ROLE partner_runtime");
      try {
        await admin.query("SELECT set_config('app.tenant_id', $1, false)", [A]);
        const { rows } = await admin.query<{ tenant_id: string }>("SELECT tenant_id FROM partner_grading_work_items");
        expect(rows.length).toBeGreaterThan(0); // not vacuous: tenant A really can see its own rows
        expect(rows.every((r) => r.tenant_id === A)).toBe(true);
      } finally {
        await admin.query("RESET ROLE");
      }
    });

    it("T5: the certificates-scope unique index 0049 creates on the PROTECTED table exists", async () => {
      const { rows } = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'certificates' AND indexname = 'uq_partner_grading_work_items_certificate_scope'`
      );
      expect(rows).toHaveLength(1);
    });

    it("T6: partner_connector_runtime holds the cert_counter and sequence privileges 0049 grants", async () => {
      // 0049 grants cert_counter at TABLE level; 0052 then narrows it to columns and 0054
      // re-asserts that narrowed form. After the full chain the table-level privilege is therefore
      // GONE by design, and asking has_table_privilege here was asserting the pre-0052 state.
      // The increment the connector actually performs is UPDATE(last_issued), so that is what must
      // still hold — and the column form is the stronger assertion, because it also proves the
      // narrowing landed rather than the blanket grant surviving.
      const counter = await admin.query<{ ok: boolean; id_locked: boolean }>(
        `SELECT has_column_privilege('partner_connector_runtime','cert_counter','last_issued','UPDATE') AS ok,
                NOT has_column_privilege('partner_connector_runtime','cert_counter','id','UPDATE') AS id_locked`
      );
      expect(counter.rows[0].ok, "the connector must still be able to advance the allocator").toBe(true);
      expect(
        counter.rows[0].id_locked,
        "0052/0054 must have removed UPDATE(id) — that is the allocator re-point primitive"
      ).toBe(true);
      const seq = await admin.query<{ ok: boolean }>(
        "SELECT has_sequence_privilege('partner_connector_runtime','certificates_id_seq','USAGE') AS ok"
      );
      expect(seq.rows[0].ok).toBe(true);
    });

    it("T7: the rollback REFUSES as the real migrator when a certificate is linked, and drops nothing", async () => {
      // 0050-0056 sit above 0049 and every one of them refuses while a higher journal row exists,
      // so they must come off first before 0049's OWN refusal semantics can be reached. T1-T6
      // above deliberately run against the complete chain; from here down the suite is exercising
      // rollback-0049 in isolation, which is only a reachable state once the higher rows are gone.
      await rollBackEverythingAbove0049();

      // The defect this pins: FORCE RLS filtered every row from the migrator, the evidence count
      // came back 0 with a linked row present, and the rollback dropped the table and COMMITTED.
      await seedWorkItem(A, { linkCertificate: true });

      await expect(runRollbackAsMigrator()).rejects.toThrow(/rollback-0049 refused[\s\S]*live grading evidence/i);

      // The table must still be here. A refusal that dropped anything would be worse than no guard.
      const { rows } = await admin.query<{ present: string | null }>(
        "SELECT to_regclass('public.partner_grading_work_items')::text AS present"
      );
      expect(rows[0].present).toBe("partner_grading_work_items");
      // And FORCE RLS must be back on: the rollback lifts it inside the transaction, so a ROLLBACK
      // has to restore it. If it did not, the table would ship un-forced after a failed rollback.
      const { rows: force } = await admin.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.partner_grading_work_items'::regclass`
      );
      expect(force[0].relforcerowsecurity).toBe(true);
    });

    it("T8: the rollback also refuses on an advanced status or an assigned grader, not just a linked certificate", async () => {
      // The original predicate only looked at certificate_id, so in-flight assignments and advanced
      // statuses — real cards mid-workflow — were destroyed silently.
      await admin.query("DELETE FROM partner_grading_work_items");
      const id = await seedWorkItem(B);
      await admin.query("UPDATE partner_grading_work_items SET status = 'pending_review' WHERE id = $1", [id]);
      await expect(runRollbackAsMigrator()).rejects.toThrow(/status_advanced=1/);

      await admin.query("UPDATE partner_grading_work_items SET status = 'ready_for_assignment' WHERE id = $1", [id]);
      const { rows: u } = await admin.query<{ id: string }>(
        `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, status)
         VALUES ($1, $1, $2, 'Grader', 'ACTIVE') RETURNING id`,
        [B, `grader45-${process.pid}@example.test`]
      );
      await admin.query("UPDATE partner_grading_work_items SET assigned_partner_grader_id = $1, assigned_at = now() WHERE id = $2", [
        u[0].id,
        id,
      ]);
      await expect(runRollbackAsMigrator()).rejects.toThrow(/grader_assigned=1/);
    });

    it("T9: the refusal message carries counts and work-item ids but NO customer data", async () => {
      let message = "";
      await runRollbackAsMigrator().catch((e: Error) => {
        message = e.message;
      });
      expect(message).toMatch(/rollback-0049 refused/);
      // A migration log must not become a customer-data sink.
      expect(message).not.toMatch(/MV-0000000045|Charizard|@example\.test|partner-submissions\//);
    });

    it("T10: with the evidence cleared, the rollback SUCCEEDS and reverses every object it created", async () => {
      await admin.query("DELETE FROM partner_grading_work_items");
      await runRollbackAsMigrator();

      const { rows: tbl } = await admin.query<{ present: string | null }>(
        "SELECT to_regclass('public.partner_grading_work_items')::text AS present"
      );
      expect(tbl[0].present).toBeNull();

      // The index on the PROTECTED certificates table was missing from the original drop list and
      // survived a "clean" rollback.
      const { rows: idx } = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'certificates' AND indexname = 'uq_partner_grading_work_items_certificate_scope'`
      );
      expect(idx).toHaveLength(0);

      // A rolled-back 0049 must not leave the connector runtime able to mutate the certificate counter.
      const counter = await admin.query<{ ok: boolean }>(
        "SELECT has_table_privilege('partner_connector_runtime','cert_counter','UPDATE') AS ok"
      );
      expect(counter.rows[0].ok).toBe(false);
      const seq = await admin.query<{ ok: boolean }>(
        "SELECT has_sequence_privilege('partner_connector_runtime','certificates_id_seq','USAGE') AS ok"
      );
      expect(seq.rows[0].ok).toBe(false);

      const { rows: journal } = await admin.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [MIGRATION]);
      expect(journal).toHaveLength(0);
    });

    it("T11: 0049 REAPPLIES cleanly after a successful rollback, restoring table, index and grants", async () => {
      await applyGradingBridgeOnly();

      const { rows: tbl } = await admin.query<{ present: string | null }>(
        "SELECT to_regclass('public.partner_grading_work_items')::text AS present"
      );
      expect(tbl[0].present).toBe("partner_grading_work_items");
      const { rows: force } = await admin.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.partner_grading_work_items'::regclass`
      );
      expect(force[0].relforcerowsecurity).toBe(true);
      const { rows: idx } = await admin.query(
        `SELECT 1 FROM pg_indexes WHERE tablename='certificates'
          AND indexname='uq_partner_grading_work_items_certificate_scope'`
      );
      expect(idx).toHaveLength(1);
      const counter = await admin.query<{ ok: boolean }>(
        "SELECT has_table_privilege('partner_connector_runtime','cert_counter','UPDATE') AS ok"
      );
      expect(counter.rows[0].ok).toBe(true);
      const { rows: journal } = await admin.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [MIGRATION]);
      expect(journal).toHaveLength(1);
    });

    it("T12: a second rollback on an already-rolled-back database is safe and still revokes", async () => {
      await runRollbackAsMigrator(); // clean: T11 left no work items
      // D5: privilege reversal used to be nested inside "IF the table EXISTS", so a repeated
      // rollback left the connector runtime holding certificates privileges forever.
      await expect(runRollbackAsMigrator()).resolves.toBeUndefined();
      const counter = await admin.query<{ ok: boolean }>(
        "SELECT has_table_privilege('partner_connector_runtime','cert_counter','UPDATE') AS ok"
      );
      expect(counter.rows[0].ok).toBe(false);
    });
  }
);
