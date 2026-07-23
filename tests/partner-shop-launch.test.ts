import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { migratorUrlFrom, provisionRealisticRoles } from "./helpers/partner-realistic-db";
import type { PartnerPrincipal } from "../server/partner/session";

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LOCATION = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PACKAGE = "dddddddd-dddd-dddd-dddd-dddddddddddd";

async function seedMintVaultTables(admin: Client): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`
    CREATE TABLE audit_log (
      id serial PRIMARY KEY,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      action text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

describe("Partner Shop Launch minimum slice (real PostgreSQL)", () => {
  let pg: DisposablePostgres17;
  let admin: Client;
  let runtime: Client;
  let service: typeof import("../server/partner/shop-launch-service");
  let wallet: typeof import("../server/partner/partner-wallet-service");
  let principal: PartnerPrincipal;
  let packageId: string;

  beforeAll(async () => {
    pg = await startPostgres17("partner-shop-launch");
    admin = new Client({ connectionString: pg.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables(admin);
    const migrator = new Client({ connectionString: migratorUrlFrom(pg.url) });
    await migrator.connect();
    try {
      await applyMigrations(migrator, listMigrationFiles());
    } finally {
      await migrator.end();
    }

    await admin.query("CREATE ROLE partner_shop_launch_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_shop_launch_test");
    const runtimeUrl = new URL(pg.url);
    runtimeUrl.username = "partner_shop_launch_test";
    runtimeUrl.password = "synthetic";
    runtime = new Client({ connectionString: runtimeUrl.toString() });
    await runtime.connect();

    process.env.PARTNER_DATABASE_URL = runtimeUrl.toString();
    process.env.PARTNER_ADMIN_DATABASE_URL = pg.url;
    process.env.MINTVAULT_DATABASE_URL = pg.url;

    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'shop-launch','Shop Launch Partner','ACTIVE')",
      [TENANT]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'shop-launch-loc',$2,$2,'Pilot Shop','ACTIVE')",
      [LOCATION, TENANT]
    );
    await admin.query(
      "INSERT INTO partner_users (id, tenant_id, partner_id, email, password_hash, status, mfa_enabled, mfa_required) VALUES ($1,$2,$2,'owner@example.com','hash','ACTIVE',true,true)",
      [USER, TENANT]
    );
    await admin.query("INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)", [
      TENANT,
      USER,
      LOCATION,
    ]);
    await admin.query(
      `INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES
       (NULL,NULL,'partner_portal_enabled',true),
       (NULL,NULL,'partner_authentication_enabled',true),
       (NULL,NULL,'partner_emergency_stop',false),
       ($1,NULL,'partner_payments_enabled',true),
       ($1,NULL,'partner_corrections_enabled',true),
       ($1,NULL,'partner_pilot_enabled',true)`,
      [TENANT]
    );
    await admin.query(
      `INSERT INTO partner_pilot_authorisations (tenant_id, location_id, status, authorised_by_user_id, reason, authorised_at)
       VALUES ($1,$2,'authorised','test-admin','hostile-review fixture',now())`,
      [TENANT, LOCATION]
    );
    await admin.query(
      `INSERT INTO partner_credit_packages (id, name, credits, price_pence, currency, status, display_order)
       VALUES ($1,'Five credits',5,7500,'GBP','active',1)`,
      [PACKAGE]
    );
    packageId = PACKAGE;

    service = await import("../server/partner/shop-launch-service");
    wallet = await import("../server/partner/partner-wallet-service");
    await wallet.ensureWallet({ actorUserId: null, actorEmail: null }, TENANT);
    principal = {
      sessionId: "session",
      tenantId: TENANT,
      userId: USER,
      locationId: LOCATION,
      mfaPassed: true,
      permissions: new Set(),
      viewOnly: false,
      sensitiveDisabled: false,
      orgWide: true,
    };
  });

  afterAll(async () => {
    await (await import("../server/partner/db")).closePartnerPools().catch(() => {});
    await runtime?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await pg?.stop();
    delete process.env.PARTNER_DATABASE_URL;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
  });

  it("creates purchases from server-owned package price/credits and fulfils Stripe webhooks exactly once", async () => {
    const packages = await service.listEligibleCreditPackages(principal);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ id: packageId, credits: 5, price_pence: 7500 });

    const purchase = await service.createPartnerCreditPurchase(principal, {
      packageId,
      idempotencyKey: "purchase-key-1",
    });
    const replay = await service.createPartnerCreditPurchase(principal, {
      packageId,
      idempotencyKey: "purchase-key-1",
    });
    expect(replay.id).toBe(purchase.id);
    expect(replay.amount_pence).toBe(7500);
    expect(replay.credits).toBe(5);

    const event = {
      id: "evt_partner_launch_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_partner_launch_1",
          amount_total: 7500,
          currency: "gbp",
          payment_intent: "pi_partner_launch_1",
          metadata: {
            type: "partner_credit_purchase",
            tenant_id: TENANT,
            package_id: packageId,
            purchase_id: purchase.id,
          },
        },
      },
    } as any;

    await service.handlePartnerStripeEvent(event);
    await service.handlePartnerStripeEvent(event);

    const balance = await wallet.getBalance(TENANT);
    expect(balance.balance).toBe(5);
    const ledger = await admin.query(
      "SELECT count(*)::int n FROM partner_credit_ledger WHERE tenant_id=$1 AND source='stripe'",
      [TENANT]
    );
    expect(ledger.rows[0].n).toBe(1);
    const stored = await admin.query("SELECT status, fulfilled_at FROM partner_credit_purchases WHERE id=$1", [
      purchase.id,
    ]);
    expect(stored.rows[0].status).toBe("fulfilled");
    expect(stored.rows[0].fulfilled_at).toBeTruthy();
  });

  it("opens reconciliation instead of fulfilling when Stripe amount does not match the package snapshot", async () => {
    const purchase = await service.createPartnerCreditPurchase(principal, {
      packageId,
      idempotencyKey: "purchase-key-mismatch",
    });
    await service.handlePartnerStripeEvent({
      id: "evt_partner_launch_bad_amount",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_partner_launch_bad",
          amount_total: 1,
          currency: "gbp",
          payment_intent: "pi_partner_launch_bad",
          metadata: {
            type: "partner_credit_purchase",
            tenant_id: TENANT,
            package_id: packageId,
            purchase_id: purchase.id,
          },
        },
      },
    } as any);
    const cases = await admin.query(
      "SELECT case_type, severity FROM partner_payment_reconciliation_cases WHERE purchase_id=$1",
      [purchase.id]
    );
    expect(cases.rows[0]).toMatchObject({ case_type: "stripe_amount_mismatch", severity: "critical" });
  });

  it("routes customer correction requests from immutable origin snapshots and falls back to HQ when partner is suspended", async () => {
    await admin.query(
      `INSERT INTO partner_grading_origin_snapshots
         (certificate_number, origin_type, tenant_id, partner_display_name, location_id, location_display_name, grading_address, completed_at)
       VALUES ('MV-PARTNER-1','partner',$1,'Shop Launch Partner',$2,'Pilot Shop',$3::jsonb,now())`,
      [TENANT, LOCATION, JSON.stringify({ line1: "1 High Street", city: "London", country: "GB" })]
    );
    const routed = await service.createCustomerCorrectionRequest({
      certificateNumber: "MV-PARTNER-1",
      customerEmail: "customer@example.com",
      reason: "Please review the label spelling.",
    });
    expect(routed.tenant_id).toBe(TENANT);
    expect(routed.location_id).toBe(LOCATION);
    expect(routed.assigned_to).toBe("origin");

    await admin.query("UPDATE partner_organisations SET status='SUSPENDED' WHERE id=$1", [TENANT]);
    await admin.query(
      `INSERT INTO partner_grading_origin_snapshots
         (certificate_number, origin_type, tenant_id, partner_display_name, location_id, location_display_name, grading_address, completed_at)
       VALUES ('MV-PARTNER-2','partner',$1,'Shop Launch Partner',$2,'Pilot Shop',$3::jsonb,now())`,
      [TENANT, LOCATION, JSON.stringify({ line1: "1 High Street", city: "London", country: "GB" })]
    );
    const fallback = await service.createCustomerCorrectionRequest({
      certificateNumber: "MV-PARTNER-2",
      reason: "Please check the certificate.",
    });
    expect(fallback.tenant_id).toBeNull();
    expect(fallback.status).toBe("escalated");
    expect(fallback.assigned_to).toBe("mintvault_hq");
  });

  it("denies direct runtime mutation of wallet and immutable launch-history tables", async () => {
    await runtime.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
    await expect(
      runtime.query(
        `INSERT INTO partner_credit_ledger
          (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
         SELECT id, tenant_id, 1, 'purchase', 'runtime-forbidden', 'portal', 'bad direct write', 'partner_user',
                repeat('a',64)
           FROM partner_wallets WHERE tenant_id=$1`,
        [TENANT]
      )
    ).rejects.toBeTruthy();
    await expect(
      runtime.query("UPDATE partner_grading_origin_snapshots SET partner_display_name='Tampered'")
    ).rejects.toBeTruthy();
    await expect(runtime.query("DELETE FROM partner_launch_audit_events")).rejects.toBeTruthy();
  });
});
