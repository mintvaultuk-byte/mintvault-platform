/**
 * PERMANENT DELETION OF A SETUP-ONLY PARTNER — proven against real PostgreSQL.
 *
 * WHY A MOCKED DATABASE WOULD PROVE NOTHING HERE. Every property under test is a PostgreSQL
 * behaviour, not an application one:
 *
 *   * the ON DELETE SET NULL that migration 0108 installed, and whether a retained audit row
 *     genuinely survives the Partner it describes;
 *   * the ON DELETE CASCADE that takes derivative profile/user/location/session state with it;
 *   * the ON DELETE RESTRICT foreign keys that must keep refusing, from as far as two cascades away
 *     (`partner_credit_reservations` RESTRICTs into `partner_locations` and carries no tenant
 *     column of its own — a "which tables reference the organisation?" check cannot see it);
 *   * and the assessment itself, which reads `pg_constraint` rather than a hand-written list, so it
 *     is only meaningful against a real catalogue.
 *
 * A stubbed pool would let all four be wrong while the suite stayed green.
 *
 * The database is built by the REAL migration runner over the declared partner-scope migration set,
 * under the same non-superuser role model production uses, so the constraints exercised here are
 * byte-for-byte the ones a deployment gets.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let deletion: typeof import("../server/partner/partner-deletion-service");
let savedEnv: Record<string, string | undefined> = {};

/**
 * The partner schema this proof needs, declared rather than globbed.
 *
 * First-shop onboarding gives the base: organisation, profile, locations, users, invitations,
 * contacts, branding, wallet, credit ledger and reservations, Card Jobs and supplies orders. Added
 * on top are the four subsystems whose foreign keys must keep REFUSING a deletion (stations,
 * grading leases, public presence, Google presence) and the three migrations under test.
 *
 * Listed in the order the runner applies them, which is the order they are given.
 */
const SAFE_DELETE_MIGRATIONS = [
  ...PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  "0045_partner_stations",
  "0087_partner_grading_edit_lease",
  "0102_partner_public_presence",
  "0103_partner_google_presence",
  "0106_lineage_convergence_public_presence",
  "0107_partner_management_audit_idempotency_scope",
  "0108_partner_setup_only_deletion_retention",
  "0109_partner_card_job_purpose",
  "0110_partner_permanent_deletion_audit_vocabulary",
] as const;

const actor = {
  actorUserId: "00000000-0000-4000-8000-0000000000aa",
  actorEmail: "owner@mintvault.test",
  requestId: "safe-delete-test",
};

interface Shop {
  tenantId: string;
  locationId: string;
  userId: string;
  label: string;
  legalName: string;
}

/**
 * The MintVault-internal tables migration 0010 grants on. They must exist before the partner
 * migrations run, exactly as they do on a real deployment.
 */
async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  // 0018 indexes this table; it is core MintVault, not partner, so the harness must provide it.
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  /*
   * `certificates` is created HERE, before the migrations, with only the provenance column the
   * assessment reads. It deliberately carries NO foreign key back to the organisation, because that
   * is the real shape (migration 0035 stores an immutable provenance SNAPSHOT) and it is exactly why
   * the catalogue walk cannot see it and the assessment has to check it explicitly.
   */
  await admin.query(
    "CREATE TABLE certificates (id serial primary key, certificate_number text unique, origin_partner_id uuid)"
  );
  for (const table of ["users", "submissions", "submission_items", "audit_log", "certificates"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

/**
 * A shop EXACTLY as the first-shop wizard leaves it — and that shape is the whole point.
 *
 * Setting up a shop through the admin UI necessarily writes a management-audit trail, a profile, a
 * Main location, an Owner user with a session and an MFA enrolment, an invitation, a primary
 * contact, branding, and a wallet. Six of those tables carry ON DELETE RESTRICT. A fixture that
 * created only an organisation would prove nothing, because the organisation alone was never the
 * thing that made every Partner on staging undeletable.
 */
async function makeSetupOnlyShop(label: string): Promise<Shop> {
  const legalName = `${label} Cards Ltd`;
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}-${Date.now()}`, legalName]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [tenantId, label]);
  const locationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
       VALUES ($1,$2,$2,'Main location','1 High Street','ACTIVE') RETURNING id`,
      [`loc-${label}-${Date.now()}`, tenantId]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}-${Date.now()}`, tenantId, `${label}@shop.test`]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)`, [
    tenantId,
    userId,
    locationId,
  ]);
  await admin.query(
    `INSERT INTO partner_sessions (tenant_id, user_id, location_id, token_hash, credential_version, absolute_expires_at)
     VALUES ($1,$2,$3,$4,1, now() + interval '1 day')`,
    [tenantId, userId, locationId, `hash-${label}-${Date.now()}`]
  );
  await admin.query(
    `INSERT INTO partner_mfa_methods (tenant_id, user_id, method, status, secret_ref)
     VALUES ($1,$2,'totp','ACTIVE',$3)`,
    [tenantId, userId, `secret-${label}`]
  );
  await admin.query(
    `INSERT INTO partner_invitations (tenant_id, user_id, email, role_code, token_hash, expires_at, status, invited_by_email)
     VALUES ($1,$2,$3,'PARTNER_OWNER',$4, now() + interval '7 days','PENDING','ops@mintvault.test')`,
    [tenantId, userId, `${label}@shop.test`, `invite-${label}-${Date.now()}`]
  );
  await admin.query(
    `INSERT INTO partner_contacts (tenant_id, full_name, email, contact_type, is_primary, active)
     VALUES ($1,'Sam Operator',$2,'operations',true,true)`,
    [tenantId, `${label}-ops@shop.test`]
  );
  await admin.query(`INSERT INTO partner_branding (tenant_id) VALUES ($1)`, [tenantId]);
  await admin.query(`INSERT INTO partner_wallets (tenant_id) VALUES ($1)`, [tenantId]);

  // The audit trail creating a shop necessarily leaves behind — the retention 0108 exists for.
  for (const action of ["partner_created", "partner_first_shop_onboarded", "status_changed"]) {
    await admin.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, reason, result)
       VALUES ($1,$2,$3,$4,'setup','shop created','succeeded')`,
      [tenantId, action, actor.actorUserId, actor.actorEmail]
    );
  }
  await admin.query(
    `INSERT INTO partner_audit_events (tenant_id, action, record_type, record_id, reason)
     VALUES ($1,'partner_location_created','partner_location',$2,'setup')`,
    [tenantId, locationId]
  );
  await admin.query(
    `INSERT INTO partner_security_events (tenant_id, severity, kind, detail)
     VALUES ($1,'info','partner_owner_invited','{}'::jsonb)`,
    [tenantId]
  );

  return { tenantId, locationId, userId, label, legalName };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code ?? "UNKNOWN" };
  }
}

function deleteShop(shop: Shop, overrides: Partial<{ reason: string; confirmLegalName: string }> = {}) {
  return deletion.deletePartnerPermanently(actor, shop.tenantId, {
    reason: overrides.reason ?? "Disposable staging shop, setup only.",
    confirmLegalName: overrides.confirmLegalName ?? shop.legalName,
  });
}

describe("permanent deletion of a setup-only Partner (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-safe-delete");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, SAFE_DELETE_MIGRATIONS);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    deletion = await import("../server/partner/partner-deletion-service");
  }, 300_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ---- ASSESSMENT ---------------------------------------------------------------------------
  it("reports a shop with setup records only as deletable, and does not let retained audit block it", async () => {
    const shop = await makeSetupOnlyShop("assess1");
    // Proof the fixture is the hard case rather than an empty organisation: these are the very rows
    // that made every Partner on staging undeletable before 0108.
    expect(await count(`SELECT count(*) n FROM partner_management_audit WHERE tenant_id=$1`, [shop.tenantId])).toBe(3);
    expect(await count(`SELECT count(*) n FROM partner_profiles WHERE tenant_id=$1`, [shop.tenantId])).toBe(1);

    const assessment = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(assessment.blockers).toEqual([]);
    expect(assessment.canDelete).toBe(true);
    expect(assessment.confirmationPhrase).toBe(shop.legalName);
  });

  it("blocks on financial history — a wallet with a single ledger row is not setup state", async () => {
    const shop = await makeSetupOnlyShop("financial");
    const walletId = (
      await admin.query<{ id: string }>(`SELECT id FROM partner_wallets WHERE tenant_id=$1`, [shop.tenantId])
    ).rows[0].id;
    await admin.query(
      `INSERT INTO partner_credit_ledger
         (wallet_id, tenant_id, amount, entry_type, source, reason, idempotency_key, actor_type, request_fingerprint)
       VALUES ($1,$2,5,'purchase','admin','test credit',$3,'admin',$4)`,
      [walletId, shop.tenantId, `ledger-${shop.label}`, "a".repeat(64)]
    );

    const assessment = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(assessment.canDelete).toBe(false);
    expect(assessment.blockers.map((blocker) => blocker.code)).toContain("FINANCIAL_HISTORY_EXISTS");
  });

  it("blocks on grading history — one Card Job is enough", async () => {
    const shop = await makeSetupOnlyShop("grading");
    const submissionId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_submissions (tenant_id, location_id, created_by, card_count, status)
         VALUES ($1,$2,$3,1,'draft') RETURNING id`,
        [shop.tenantId, shop.locationId, shop.userId]
      )
    ).rows[0].id;
    const cardId = (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, quantity)
         VALUES ($1,$2,1,'Test card',1) RETURNING id`,
        [shop.tenantId, submissionId]
      )
    ).rows[0].id;
    await admin.query(
      `INSERT INTO partner_card_jobs (tenant_id, submission_id, card_id, ordinal, card_reference, status)
       VALUES ($1,$2,$3,1,$4,'NEEDS_SCAN')`,
      [shop.tenantId, submissionId, cardId, `partner-submission-card:${cardId}:1`]
    );

    const assessment = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(assessment.canDelete).toBe(false);
    expect(assessment.blockers.map((blocker) => blocker.code)).toContain("GRADING_HISTORY_EXISTS");
  });

  it("blocks on station history", async () => {
    const shop = await makeSetupOnlyShop("stations");
    await admin.query(
      `INSERT INTO partner_stations (tenant_id, location_id, station_code, status, public_key_pem, public_key_fingerprint)
       VALUES ($1,$2,'MV-STN-AAAAAAAAAA','ACTIVE','pem',$3)`,
      [shop.tenantId, shop.locationId, "f".repeat(64)]
    );
    const assessment = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(assessment.canDelete).toBe(false);
    expect(assessment.blockers.map((blocker) => blocker.code)).toContain("STATION_HISTORY_RETAINED");
  });

  it("blocks on supplies order history, through a COMPOSITE foreign key", async () => {
    /*
     * `partner_supplies_orders` reaches the shop three ways at once: a plain tenant_id, and two
     * COMPOSITE keys — (location_id, tenant_id) and (requesting_user_id, tenant_id) — into tables
     * that themselves CASCADE from the organisation. Multi-column edges are the case a join built
     * from a single column silently gets wrong, so this proves the walk composes all of them.
     */
    const shop = await makeSetupOnlyShop("orders");
    await admin.query(
      `INSERT INTO partner_supplies_orders
         (tenant_id, partner_id, location_id, requesting_user_id, partner_name_snapshot, shop_name_snapshot,
          contact_name_snapshot, contact_email_snapshot, delivery_address_snapshot, delivery_postcode_snapshot,
          idempotency_key, request_fingerprint)
       VALUES ($1,$1,$2,$3,'Shop','Main','Sam','sam@shop.test','1 High Street','AB1 2CD',$4,$5)`,
      [shop.tenantId, shop.locationId, shop.userId, `supplies-order-key-${shop.label}`, "c".repeat(64)]
    );
    const assessment = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(assessment.canDelete).toBe(false);
    expect(assessment.blockers.map((blocker) => blocker.code)).toContain("ORDER_HISTORY_EXISTS");
  });

  it("blocks on issued certificates, which carry no foreign key back to the shop", async () => {
    /*
     * `certificates.origin_partner_id` is a permanent provenance SNAPSHOT with no foreign key
     * (migration 0035), so the catalogue walk CANNOT see it — deleting the organisation would
     * succeed at the database and strand live certificates pointing at a shop that no longer exists.
     * The assessment therefore checks certificates explicitly, and this is what proves that check is
     * wired rather than merely intended.
     */
    const shop = await makeSetupOnlyShop("certificates");
    const clean = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(clean.canDelete).toBe(true);

    await admin.query(`INSERT INTO certificates (certificate_number, origin_partner_id) VALUES ($1,$2)`, [
      `MV-${shop.label}`,
      shop.tenantId,
    ]);
    const blocked = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(blocked.canDelete).toBe(false);
    expect(blocked.blockers.map((blocker) => blocker.code)).toContain("CERTIFICATE_HISTORY_EXISTS");

    const refused = await settle(deleteShop(shop));
    expect(refused).toMatchObject({ ok: false, code: "PARTNER_DELETE_BLOCKED" });
    expect(await count(`SELECT count(*) n FROM partner_organisations WHERE id=$1`, [shop.tenantId])).toBe(1);
  });

  /**
   * The case a naive dependency check MISSES.
   *
   * `partner_credit_reservations` has NO tenant foreign key to the organisation at all. It RESTRICTs
   * into `partner_locations`, which itself CASCADEs from the organisation — so the delete fails two
   * edges out, at a table that never appears in a list of "things referencing partner_organisations".
   * This is the reason the assessment walks the catalogue transitively instead of reading a list.
   */
  it("blocks on a dependency two cascades away that has no tenant foreign key", async () => {
    const shop = await makeSetupOnlyShop("transitive");
    const walletId = (
      await admin.query<{ id: string }>(`SELECT id FROM partner_wallets WHERE tenant_id=$1`, [shop.tenantId])
    ).rows[0].id;
    await admin.query(
      `INSERT INTO partner_credit_reservations
         (wallet_id, tenant_id, location_id, reserved_credits, status, card_reference, idempotency_key,
          request_fingerprint, expires_at, actor_type, source, reason)
       VALUES ($1,$2,$3,1,'active',$4,$5,$6, now() + interval '1 day','partner_user','portal','test reservation')`,
      [walletId, shop.tenantId, shop.locationId, `card-${shop.label}`, `res-${shop.label}`, "b".repeat(64)]
    );

    const assessment = await deletion.assessPartnerDeletion(shop.tenantId);
    expect(assessment.canDelete).toBe(false);
    expect(assessment.blockers.map((blocker) => blocker.code)).toContain("FINANCIAL_HISTORY_EXISTS");

    // And the refusal is not merely advisory: the guarded delete refuses too, changing nothing.
    const refused = await settle(deleteShop(shop));
    expect(refused).toMatchObject({ ok: false, code: "PARTNER_DELETE_BLOCKED" });
    expect(await count(`SELECT count(*) n FROM partner_organisations WHERE id=$1`, [shop.tenantId])).toBe(1);
  });

  // ---- GUARDS -------------------------------------------------------------------------------
  it("refuses without the exact typed legal name, and destroys nothing", async () => {
    const shop = await makeSetupOnlyShop("confirm");
    const wrong = await settle(deleteShop(shop, { confirmLegalName: "Some Other Shop Ltd" }));
    expect(wrong).toMatchObject({ ok: false, code: "PARTNER_DELETE_CONFIRMATION_REQUIRED" });
    // A near miss is still a miss: the point of typing the name is that it identifies THIS shop.
    const nearMiss = await settle(deleteShop(shop, { confirmLegalName: shop.legalName.toLowerCase() }));
    expect(nearMiss).toMatchObject({ ok: false, code: "PARTNER_DELETE_CONFIRMATION_REQUIRED" });
    expect(await count(`SELECT count(*) n FROM partner_organisations WHERE id=$1`, [shop.tenantId])).toBe(1);
  });

  it("requires a written reason, admin step-up and its own rate limit at the route", () => {
    /*
     * Asserted against the ROUTE SOURCE because these guards are middleware and request shaping, not
     * service logic — calling the service directly would prove nothing about them. Their ORDER
     * matters too: step-up runs before the handler, so a caller without a fresh re-authentication
     * never reaches the deletion at all.
     */
    const routes = readFileSync("server/partner/partner-management-routes.ts", "utf8");
    const start = routes.indexOf('"/partners/:partnerId/permanent-delete"');
    expect(start).toBeGreaterThan(-1);
    const block = routes.slice(start, start + 900);
    expect(block).toContain("requireAdminStepUp()");
    expect(block).toContain("partnerDeleteRateLimit");
    expect(block).toContain("requireReason(req.body?.reason)");
    expect(block).toContain('requireNonEmpty(req.body?.confirmLegalName, "confirmLegalName")');
    // Far below the general 60-per-minute mutation budget: destroying a shop is not an ordinary edit.
    expect(routes).toMatch(/partnerDeleteRateLimit = rateLimit\(\{[\s\S]{0,300}max: 5,/);
  });

  // ---- THE DELETION ITSELF ------------------------------------------------------------------
  it("deletes the shop, keeps every audit and security row, and attributes them to a tombstone", async () => {
    const shop = await makeSetupOnlyShop("delete1");
    const other = await makeSetupOnlyShop("bystander");

    const { result, alreadyCompleted } = await deleteShop(shop);
    expect(alreadyCompleted).toBe(false);
    expect(result.legalName).toBe(shop.legalName);

    // GONE: the organisation and everything derivative of it.
    expect(await count(`SELECT count(*) n FROM partner_organisations WHERE id=$1`, [shop.tenantId])).toBe(0);
    for (const table of [
      "partner_profiles",
      "partner_locations",
      "partner_users",
      "partner_sessions",
      "partner_mfa_methods",
      "partner_user_locations",
      "partner_invitations",
      "partner_contacts",
      "partner_branding",
      "partner_wallets",
    ]) {
      expect({
        table,
        rows: await count(`SELECT count(*) n FROM ${table} WHERE tenant_id=$1`, [shop.tenantId]),
      }).toEqual({ table, rows: 0 });
    }

    // KEPT: every retained row, now with a NULL tenant and an intact attribution key.
    const retainedAudit = await admin.query<{ tenant_id: string | null; deleted_tenant_id: string }>(
      `SELECT tenant_id, deleted_tenant_id FROM partner_management_audit WHERE deleted_tenant_id=$1`,
      [shop.tenantId]
    );
    // Three setup rows, plus the attempt row and the terminal row this deletion itself wrote.
    expect(retainedAudit.rowCount).toBe(5);
    expect(retainedAudit.rows.every((row) => row.tenant_id === null)).toBe(true);
    expect(retainedAudit.rows.every((row) => row.deleted_tenant_id === shop.tenantId)).toBe(true);

    const terminal = await admin.query<{ result: string; reason: string }>(
      `SELECT result, reason FROM partner_management_audit
        WHERE deleted_tenant_id=$1 AND action_type='partner_permanently_deleted' AND result='succeeded'`,
      [shop.tenantId]
    );
    expect(terminal.rowCount).toBe(1);
    expect(terminal.rows[0].reason).toBe("Disposable staging shop, setup only.");

    expect(
      await count(`SELECT count(*) n FROM partner_audit_events WHERE deleted_tenant_id=$1 AND tenant_id IS NULL`, [
        shop.tenantId,
      ])
    ).toBe(1);
    // The setup security event, plus the high-severity record of the deletion itself.
    expect(
      await count(`SELECT count(*) n FROM partner_security_events WHERE deleted_tenant_id=$1 AND tenant_id IS NULL`, [
        shop.tenantId,
      ])
    ).toBe(2);
    expect(
      await count(
        `SELECT count(*) n FROM partner_security_events WHERE deleted_tenant_id=$1 AND kind='partner_permanently_deleted'`,
        [shop.tenantId]
      )
    ).toBe(1);

    const tombstone = await admin.query<{ legal_name: string; deletion_reason: string; deleted_by_email: string }>(
      `SELECT legal_name, deletion_reason, deleted_by_email FROM partner_deleted_tombstones WHERE tenant_id=$1`,
      [shop.tenantId]
    );
    expect(tombstone.rowCount).toBe(1);
    expect(tombstone.rows[0].legal_name).toBe(shop.legalName);
    expect(tombstone.rows[0].deleted_by_email).toBe(actor.actorEmail);

    // CROSS-TENANT: the bystander shop is untouched in every table the deletion wrote to.
    expect(await count(`SELECT count(*) n FROM partner_organisations WHERE id=$1`, [other.tenantId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM partner_users WHERE tenant_id=$1`, [other.tenantId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM partner_management_audit WHERE tenant_id=$1`, [other.tenantId])).toBe(3);
    expect(
      await count(`SELECT count(*) n FROM partner_management_audit WHERE deleted_tenant_id=$1`, [other.tenantId])
    ).toBe(0);
    expect(await count(`SELECT count(*) n FROM partner_deleted_tombstones WHERE tenant_id=$1`, [other.tenantId])).toBe(
      0
    );
  });

  it("leaves no orphan rows anywhere in the partner schema", async () => {
    const shop = await makeSetupOnlyShop("orphans");
    await deleteShop(shop);

    /*
     * Swept from the CATALOGUE rather than a written list, for the same reason the assessment is: a
     * table added by a future migration joins this check automatically. Anything still carrying the
     * deleted tenant id would be an orphan; the three retained-history tables are exempt only in the
     * sense that they now carry it under `deleted_tenant_id`, with `tenant_id` NULL by design.
     */
    const { rows: tenantTables } = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='tenant_id' AND table_name LIKE 'partner\\_%'
        ORDER BY table_name`
    );
    const stragglers: string[] = [];
    for (const { table_name: table } of tenantTables) {
      if (table === "partner_deleted_tombstones") continue;
      const rows = await count(`SELECT count(*) n FROM ${table} WHERE tenant_id=$1`, [shop.tenantId]);
      if (rows > 0) stragglers.push(`${table}:${rows}`);
    }
    expect(stragglers).toEqual([]);
  });

  it("frees the identity, so the same shop and the same Owner email can be created again", async () => {
    const shop = await makeSetupOnlyShop("recreate");
    await deleteShop(shop);

    // The genuinely load-bearing one: partner_users.email is unique GLOBALLY (migration 0003), so a
    // Partner whose Owner account survived deletion could never be onboarded again under that email.
    const recreated = await makeSetupOnlyShop("recreate");
    expect(recreated.tenantId).not.toBe(shop.tenantId);
    expect(recreated.legalName).toBe(shop.legalName);
    expect(await count(`SELECT count(*) n FROM partner_users WHERE email=$1`, ["recreate@shop.test"])).toBe(1);

    // And the first shop's history is still there, still attributed to the FIRST tenant id.
    expect(
      await count(`SELECT count(*) n FROM partner_management_audit WHERE deleted_tenant_id=$1`, [shop.tenantId])
    ).toBe(5);
    expect(
      await count(`SELECT count(*) n FROM partner_management_audit WHERE tenant_id=$1`, [recreated.tenantId])
    ).toBe(3);
  });

  it("treats a second deletion of the same shop as an idempotent replay, not a failure", async () => {
    const shop = await makeSetupOnlyShop("replay");
    await deleteShop(shop);
    const again = await deleteShop(shop);
    expect(again.alreadyCompleted).toBe(true);
    expect(again.result.legalName).toBe(shop.legalName);
  });

  it("refuses a shop that does not exist rather than reporting success", async () => {
    const missing = await settle(
      deletion.deletePartnerPermanently(actor, "00000000-0000-4000-8000-00000000dead", {
        reason: "should not happen",
        confirmLegalName: "anything",
      })
    );
    expect(missing).toMatchObject({ ok: false, code: "PARTNER_NOT_FOUND" });
  });
});
