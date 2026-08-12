/**
 * MIGRATION 0074 — post-handover submission lifecycle + immutable location snapshot.
 *
 * WHAT 0074 FIXES: 0007 bounded partner_submissions.status to exactly three values, so a shop
 * could create a submission and hand it over and then the workflow simply STOPPED. There was no
 * value representing "MintVault has it", "being graded", "graded", "settling credits" or
 * "finished". The Partner dashboard could not derive ready-to-grade / grading-in-progress /
 * awaiting-settlement / completed counts from any column, which is why those tiles were deleted
 * rather than wired.
 *
 * It also converts location from a pure POINTER to a captured snapshot. location_id is immutable
 * in practice, but renaming a location silently rewrote the apparent grading origin of every
 * historical submission — which would have put the submission record permanently at odds with the
 * certificate's origin snapshot, frozen by 0035's ENABLE ALWAYS trigger.
 *
 * These tests apply the REAL migration file against a disposable PostgreSQL 17 cluster. They do
 * not read the SQL as text — every assertion is made against live catalog state or live DML.
 *
 * MUTATION TARGETS: narrowing the status domain back, or dropping location_name_snapshot, must
 * turn this file red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_LIFECYCLE,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let submissionSvc: typeof import("../server/partner/submission-service");

const TENANT = "cccccccc-4400-0000-0000-000000000001";
const LOCATION = "dddddddd-4400-0000-0000-000000000001";
const USER = "eeeeeeee-4400-0000-0000-000000000001";

/** The five states 0074 introduces, in workflow order. */
const NEW_STATES = ["received", "grading", "graded", "awaiting_settlement", "completed"] as const;
/** The three 0007 permitted; all must survive. */
const ORIGINAL_STATES = ["draft", "submitted_to_mintvault", "cancelled"] as const;

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(
    "CREATE TABLE certificates (id serial primary key, cert_id text, submission_id integer, secret text)"
  );
  await admin.query(
    "CREATE TABLE label_prints (id serial primary key, certificate_id integer, created_at timestamptz not null default now())"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

let seq = 0;
async function insertSubmission(status: string): Promise<string> {
  seq += 1;
  const r = await admin.query<{ id: string }>(
    `INSERT INTO partner_submissions
       (tenant_id, location_id, created_by, public_ref, card_count, status, version, location_name_snapshot)
     VALUES ($1,$2,$3,$4,0,$5,1,'Snapshot At Insert') RETURNING id`,
    [TENANT, LOCATION, USER, `REF-${status}-${seq}`, status]
  );
  return r.rows[0].id;
}

describe("Migration 0074 — submission lifecycle + location snapshot (PostgreSQL 17)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("submission-lifecycle");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_LIFECYCLE);

    await admin.query(
      "INSERT INTO partner_organisations (id, legal_name, status) VALUES ($1,'Lifecycle Ltd','ACTIVE')",
      [TENANT]
    );
    await admin.query(
      // partner_locations/partner_users carry BOTH tenant_id and partner_id NOT NULL; for a
      // top-level organisation these hold the same value.
      "INSERT INTO partner_locations (id, tenant_id, partner_id, name, status) VALUES ($1,$2,$2,'Original Name','ACTIVE')",
      [LOCATION, TENANT]
    );
    await admin.query(
      "INSERT INTO partner_users (id, tenant_id, partner_id, email, status) VALUES ($1,$2,$2,'lifecycle@example.test','ACTIVE')",
      [USER, TENANT]
    );
    submissionSvc = await import("../server/partner/submission-service");
  }, 180_000);

  afterAll(async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end();
    await cluster?.stop();
  });

  it("every one of the three original 0007 states is still accepted", async () => {
    for (const s of ORIGINAL_STATES) {
      await expect(insertSubmission(s), `original state ${s} must survive the widening`).resolves.toBeTruthy();
    }
  });

  it.each(NEW_STATES)("accepts the new lifecycle state '%s'", async (state) => {
    await expect(insertSubmission(state)).resolves.toBeTruthy();
  });

  it("still rejects a status outside the widened domain — this is a widening, not a removal", async () => {
    await expect(insertSubmission("teleported")).rejects.toThrow(/chk_partner_submissions_status|violates check/i);
  });

  it("the widened constraint is VALIDATED, so it genuinely applies to existing rows", async () => {
    const r = await admin.query<{ convalidated: boolean; def: string }>(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='partner_submissions'::regclass AND conname='chk_partner_submissions_status'`
    );
    expect(r.rowCount).toBe(1);
    // NOT VALID would let pre-existing bad rows survive unchecked.
    expect(r.rows[0].convalidated).toBe(true);
    expect(r.rows[0].def).toContain("awaiting_settlement");
  });

  it("location_name_snapshot exists, is nullable, and carries no default", async () => {
    const r = await admin.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name='partner_submissions' AND column_name='location_name_snapshot'`
    );
    expect(r.rowCount).toBe(1);
    // Nullable with no default is deliberate: NULL means "captured before snapshots existed".
    // A '' default would make legacy rows indistinguishable from a genuinely empty name.
    expect(r.rows[0].is_nullable).toBe("YES");
    expect(r.rows[0].column_default).toBeNull();
  });

  it("renaming the location does NOT rewrite a submission's captured origin — the whole point", async () => {
    const id = await insertSubmission("submitted_to_mintvault");
    await admin.query("UPDATE partner_locations SET name='Renamed Later' WHERE id=$1", [LOCATION]);

    const r = await admin.query<{ snapshot: string; current_name: string }>(
      `SELECT s.location_name_snapshot AS snapshot, l.name AS current_name
         FROM partner_submissions s JOIN partner_locations l ON l.id = s.location_id
        WHERE s.id = $1`,
      [id]
    );
    expect(r.rows[0].current_name).toBe("Renamed Later");
    // Before 0074 there was no second value here at all — the join WAS the answer, so this row
    // would now claim it originated at "Renamed Later".
    expect(r.rows[0].snapshot).toBe("Snapshot At Insert");

    await admin.query("UPDATE partner_locations SET name='Original Name' WHERE id=$1", [LOCATION]);
  });

  it("captures the location snapshot when the real draft writer creates a submission", async () => {
    const submission = await submissionSvc.createSubmissionDraft(
      {
        sessionId: "session-0044",
        tenantId: TENANT,
        userId: USER,
        locationId: null,
        mfaPassed: true,
        permissions: new Set(),
        viewOnly: false,
        sensitiveDisabled: false,
        orgWide: true,
      },
      { locationId: LOCATION, internalReference: "snapshot-writer" }
    );
    await admin.query("UPDATE partner_locations SET name='Writer Renamed Later' WHERE id=$1", [LOCATION]);
    const r = await admin.query<{ snapshot: string }>(
      "SELECT location_name_snapshot AS snapshot FROM partner_submissions WHERE id=$1",
      [submission.id]
    );
    expect(r.rows[0].snapshot).toBe("Original Name");
    await admin.query("UPDATE partner_locations SET name='Original Name' WHERE id=$1", [LOCATION]);
  });

  it("direct inserts without a snapshot are repaired by the trigger and later snapshot edits fail closed", async () => {
    const r = await admin.query<{ id: string; snapshot: string }>(
      `INSERT INTO partner_submissions
         (tenant_id, location_id, created_by, public_ref, card_count, status, version)
       VALUES ($1,$2,$3,'REF-TRIGGER-SNAPSHOT',0,'draft',1)
       RETURNING id, location_name_snapshot AS snapshot`,
      [TENANT, LOCATION, USER]
    );
    expect(r.rows[0].snapshot).toBe("Original Name");
    await expect(
      admin.query("UPDATE partner_submissions SET location_name_snapshot='tampered' WHERE id=$1", [r.rows[0].id])
    ).rejects.toThrow(/location_name_snapshot is immutable/i);
  });

  it("extends the management-audit action CHECK for the audited wallet backfill", async () => {
    await expect(
      admin.query(
        `INSERT INTO partner_management_audit
           (tenant_id, action_type, actor_user_id, actor_email, request_id, reason, result)
         VALUES ($1,'partner_wallet_backfilled',$2,'audit@example.test','wallet-action-proof','proof','succeeded')`,
        [TENANT, USER]
      )
    ).resolves.toBeTruthy();
  });

  it("the location FK is still enforced — a snapshot does not replace referential integrity", async () => {
    await expect(
      admin.query(
        `INSERT INTO partner_submissions
           (tenant_id, location_id, location_name_snapshot, created_by, public_ref, card_count, status, version)
         VALUES ($1,'99999999-9999-9999-9999-999999999999','Explicit Snapshot',$2,'REF-ORPHAN',0,'draft',1)`,
        [TENANT, USER]
      )
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // ── A8-F2 (HIGH) — pg_temp shadowing of the location snapshot ────────────────────────────
  //
  // partner_submissions_capture_location_snapshot() is SECURITY INVOKER, so the CALLER's
  // search_path applies, and pg_temp is searched ahead of public by default. Without a pinned
  // search_path AND a schema-qualified read, any role that can CREATE TEMP TABLE — a default
  // PUBLIC privilege every partner runtime role holds — shadows the lookup and forges the
  // snapshot. `AND l.tenant_id = NEW.tenant_id` does not help; it is evaluated against the temp
  // table. This defeats the provenance the whole snapshot exists to guarantee.
  //
  // The hardening was authored as 0048_partner_location_snapshot_search_path.sql (commit
  // 098345f7) for the lineage where this migration had already been applied as 0044. On THIS
  // lineage it was still unapplied and renumbered to 0074 — which sorts AFTER 0048 — so the
  // repair is folded into 0074 at source instead. These assertions exist because nothing else
  // pins it: no CI step reads the function body, and a future edit to the migration would
  // silently reopen the hole.
  it("A8-F2: the location-snapshot trigger pins search_path and reads public.partner_locations", async () => {
    const fn = await admin.query(
      `SELECT p.proconfig, p.prosrc, p.prosecdef
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'partner_submissions_capture_location_snapshot'`
    );
    expect(fn.rowCount, "the snapshot trigger function must exist").toBe(1);

    const { proconfig, prosrc } = fn.rows[0] as { proconfig: string[] | null; prosrc: string };

    // pg_temp must be present (legitimate temp objects stay reachable) but LAST, so it can
    // never shadow a public table. This is the house convention set by 0006.
    expect(proconfig, "search_path is not pinned at all").not.toBeNull();
    expect(proconfig).toContain("search_path=public, pg_temp");

    // Belt and braces: the read is schema-qualified, so the reference stays correct even if a
    // future edit drops the SET clause.
    expect(prosrc, "an unqualified partner_locations read survives").not.toMatch(
      /from\s+partner_locations/i
    );
    expect(prosrc, "the schema-qualified read is missing").toMatch(/from\s+public\.partner_locations/i);
  });

  it("A8-F2: a pg_temp table named partner_locations cannot forge the snapshot", async () => {
    // The actual attack, executed. Without the hardening this inserts 'FORGED ORIGIN' as the
    // immutable provenance of a submission; with it, the real location name wins.
    const attacker = new Client({ connectionString: cluster.url });
    await attacker.connect();
    try {
      await attacker.query(
        "CREATE TEMP TABLE partner_locations (id uuid, tenant_id uuid, partner_id uuid, name text, status text)"
      );
      await attacker.query(
        "INSERT INTO partner_locations (id, tenant_id, partner_id, name, status) VALUES ($1,$2,$2,'FORGED ORIGIN','ACTIVE')",
        [LOCATION, TENANT]
      );
      await attacker.query(
        `INSERT INTO partner_submissions
           (tenant_id, location_id, created_by, public_ref, card_count, status, version)
         VALUES ($1,$2,$3,'REF-FORGE',0,'draft',1)`,
        [TENANT, LOCATION, USER]
      );
      const row = await attacker.query(
        "SELECT location_name_snapshot FROM partner_submissions WHERE public_ref = 'REF-FORGE'"
      );
      expect(row.rows[0].location_name_snapshot).toBe("Original Name");
      expect(row.rows[0].location_name_snapshot).not.toBe("FORGED ORIGIN");
    } finally {
      await attacker.end();
    }
  });

  it("0074 adds NO partner-to-certificate column, because 0035 already provides one", async () => {
    // Guards against a future well-meaning duplicate link. The link is certificates.origin_partner_id.
    const dup = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='partner_submissions' AND column_name IN ('certificate_id','cert_id')`
    );
    expect(dup.rowCount).toBe(0);
    const origin = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='certificates' AND column_name='origin_partner_id'`
    );
    expect(origin.rowCount).toBe(1);
  });
});
