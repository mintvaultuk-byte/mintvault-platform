/**
 * Supplies/orders commercial proof against a real disposable PostgreSQL 17 cluster.
 * Stripe itself is deliberately a deterministic boundary double: this test proves the server's
 * signed-webhook/refund contract and all database effects without making a provider charge.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const LOCATION_A = "11111111-1111-4111-8111-111111111112";
const LOCATION_B = "22222222-2222-4222-8222-222222222223";
const USER_A = "11111111-1111-4111-8111-111111111113";

let nextCheckout = 0;
let nextRefund = 0;
let failNextCheckout = false;
const checkoutCreate = vi.fn(async () => {
  if (failNextCheckout) {
    failNextCheckout = false;
    throw new Error("synthetic Stripe checkout outage");
  }
  return { id: `cs_supply_${++nextCheckout}`, url: `https://checkout.local/${nextCheckout}` };
});
const checkoutRetrieve = vi.fn(async (id: string) => ({ id, url: `https://checkout.local/restored` }));
const refundCreate = vi.fn(async () => ({ id: `re_supply_${++nextRefund}` }));

vi.mock("../server/stripeClient", () => ({
  getUncachableStripeClient: vi.fn(async () => ({
    checkout: { sessions: { create: checkoutCreate, retrieve: checkoutRetrieve } },
    refunds: { create: refundCreate },
  })),
}));

let cluster: DisposablePostgres17;
let admin: Client;
let service: typeof import("../server/partner/supply-service");

const principal = { tenantId: TENANT_A, locationId: LOCATION_A, userId: USER_A, email: "owner@shop.test" } as any;
const adminActor = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@mintvault.test" };

describe("Partner supply orders — real PostgreSQL security and payment evidence", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-supply-orders");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await admin.query("CREATE TABLE users (id varchar primary key, email varchar unique)");
    await admin.query(
      "CREATE TABLE submissions (id serial primary key, user_id varchar, status varchar(30) not null default 'draft', tracking_number text unique, deleted_at timestamptz, grading_status varchar(30), assigned_grader_id varchar, scan_status varchar(30), scan_assigned_to varchar, shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz, return_tracking text, return_carrier text, return_service text, status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now())"
    );
    await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
    await admin.query(
      "CREATE TABLE audit_log (id serial primary key, entity_type text not null, entity_id text not null, action text not null, admin_user text, details jsonb, created_at timestamptz not null default now())"
    );
    for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
      await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
    }
    /*
     * A DECLARED migration list, not applyEveryMigrationRealistic().
     *
     * The recovered suite globbed every migration and pre-created the core certificates/label_prints
     * fixtures its own lineage needed. On this lineage those helpers do not exist, and the supplies
     * slice depends on nothing outside the partner namespace — so the harness declares exactly the
     * partner chain plus 0111. That also keeps it honest about scope: if 0111 ever grows a core
     * dependency, this list stops applying rather than silently picking the table up from a glob.
     */
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_FIRST_SHOP,
      "0102_partner_public_presence",
      "0106_lineage_convergence_public_presence",
      "0107_partner_management_audit_idempotency_scope",
      "0112_partner_supply_commerce",
    ]);
    await admin.query(
      `INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES
      ($1,'supply-a','Supply A Ltd','ACTIVE'), ($2,'supply-b','Supply B Ltd','ACTIVE')`,
      [TENANT_A, TENANT_B]
    );
    await admin.query(
      `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, address, status) VALUES
      ($1,'supply-a-location',$2,$2,'Supply A Shop','1 Approved Way, Bristol, BS1 1AA','ACTIVE'),
      ($3,'supply-b-location',$4,$4,'Supply B Shop','2 Isolated Road, Leeds, LS1 2BB','ACTIVE')`,
      [LOCATION_A, TENANT_A, LOCATION_B, TENANT_B]
    );
    // Suspended avoids the unrelated final-owner trigger while still supplying a valid historical
    // submitted_by FK; direct service tests do not stand in for the real session/RBAC middleware.
    await admin.query(
      "INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, status) VALUES ($1,'supply-user',$2,$2,'owner@shop.test','SUSPENDED')",
      [USER_A, TENANT_A]
    );
    await admin.query(
      "CREATE ROLE supply_runtime LOGIN PASSWORD 'synthetic-supply-runtime' NOSUPERUSER NOBYPASSRLS INHERIT"
    );
    await admin.query("GRANT partner_runtime TO supply_runtime");
    const runtime = new URL(cluster.url);
    runtime.username = "supply_runtime";
    runtime.password = "synthetic-supply-runtime";
    process.env.PARTNER_DATABASE_URL = runtime.toString();
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    service = await import("../server/partner/supply-service");
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("derives product/price/tax/totals server-side and snapshots an authorised delivery override", async () => {
    await expect(
      service.createPartnerSupplyCheckout(
        principal,
        {
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          items: [{ productCode: "nfc_tags", quantity: 1 }],
        },
        { origin: "http://local.test" }
      )
    ).rejects.toMatchObject({ code: "product_not_priced" });

    await expect(
      service.updateSupplyCatalogueForSuperAdmin(adminActor, "holographic_printing_paper", {
        active: true,
        activePricePence: "2000",
      })
    ).rejects.toMatchObject({ code: "invalid_catalogue" });

    await service.updateSupplyCatalogueForSuperAdmin(adminActor, "holographic_printing_paper", {
      active: true,
      activePricePence: 2000,
    });
    const checkout = await service.createPartnerSupplyCheckout(
      principal,
      {
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        // Forged unit price and tax fields are intentionally ignored by the service input shape.
        items: [
          { productCode: "plastic_mintvault_slab_box", quantity: 2, pricePence: 1 },
          { productCode: "holographic_printing_paper", quantity: 1, taxPence: 0 },
        ],
        deliveryAddress: {
          recipientName: "Supply A receiving",
          line1: "9 One-off Lane",
          city: "Bath",
          postcode: "BA1 1AA",
          country: "United Kingdom",
        },
      },
      { origin: "http://local.test", returnPath: "/partner/supplies" }
    );
    expect(checkout.checkoutUrl).toBe("https://checkout.local/1");
    expect(checkoutCreate.mock.calls[0][0].line_items.map((line: any) => line.price_data.unit_amount)).toEqual([
      7500, 2000,
    ]);
    const { rows } = await admin.query<{
      gross_total_pence: number;
      tax_treatment: string;
      delivery_address: Record<string, string>;
      payment_status: string;
      stripe_checkout_session_id: string;
    }>(
      `SELECT o.gross_total_pence, o.tax_treatment, o.delivery_address, p.status AS payment_status, p.stripe_checkout_session_id
         FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id WHERE o.id=$1`,
      [checkout.orderId]
    );
    expect(rows[0]).toMatchObject({
      gross_total_pence: 17000,
      tax_treatment: "UNCONFIGURED",
      payment_status: "PENDING",
      stripe_checkout_session_id: "cs_supply_1",
    });
    expect(rows[0].delivery_address).toMatchObject({
      source: "partner_override",
      line1: "9 One-off Lane",
      city: "Bath",
    });

    await service.updateSupplyTaxForSuperAdmin(adminActor, { taxTreatment: "VAT_INCLUDED", vatRateBasisPoints: 2000 });
    const vatCheckout = await service.createPartnerSupplyCheckout(
      principal,
      {
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
        items: [{ productCode: "plastic_mintvault_slab_box", quantity: 1 }],
      },
      { origin: "http://local.test" }
    );
    const vat = await admin.query<{
      net_total_pence: number;
      vat_total_pence: number;
      tax_treatment: string;
      delivery_address: Record<string, string>;
    }>(
      "SELECT net_total_pence, vat_total_pence, tax_treatment, delivery_address FROM partner_supply_orders WHERE id=$1",
      [vatCheckout.orderId]
    );
    expect(vat.rows[0]).toMatchObject({ tax_treatment: "VAT_INCLUDED", net_total_pence: 6250, vat_total_pence: 1250 });
    expect(vat.rows[0].delivery_address).toMatchObject({
      source: "approved_location",
      address: "1 Approved Way, Bristol, BS1 1AA",
    });
  });

  it("uses the signed Stripe checkout session as the only paid transition and collapses a replay", async () => {
    const { rows } = await admin.query<{ id: string }>(
      "SELECT id FROM partner_supply_orders ORDER BY created_at LIMIT 1"
    );
    const orderId = rows[0].id;
    const paid = await service.fulfilPartnerSupplyOrder("evt_supply_1", {
      id: "cs_supply_1",
      payment_status: "paid",
      payment_intent: "pi_supply_1",
      metadata: { type: "partner_supply_order", order_id: orderId, tenant_id: TENANT_A },
    } as any);
    expect(paid).toEqual({ paid: true });
    const replay = await service.fulfilPartnerSupplyOrder("evt_supply_1", {
      id: "cs_supply_1",
      payment_status: "paid",
      payment_intent: "pi_supply_1",
      metadata: { type: "partner_supply_order", order_id: orderId, tenant_id: TENANT_A },
    } as any);
    expect(replay).toMatchObject({ paid: false, reason: "duplicate_or_not_pending" });
    const state = await admin.query<{ status: string; payment_status: string; events: number }>(
      `SELECT o.status, p.status AS payment_status, (SELECT count(*)::int FROM partner_supply_order_events WHERE order_id=o.id AND action='stripe_payment_confirmed') AS events
         FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id WHERE o.id=$1`,
      [orderId]
    );
    expect(state.rows[0]).toMatchObject({ status: "PAID", payment_status: "PAID", events: 1 });
  });

  it("recovers the same pending checkout after a transient provider failure without duplicating its order", async () => {
    const input = {
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      items: [{ productCode: "plastic_mintvault_slab_box", quantity: 1 }],
    };
    failNextCheckout = true;
    await expect(
      service.createPartnerSupplyCheckout(principal, input, { origin: "http://local.test" })
    ).rejects.toMatchObject({ code: "checkout_unavailable" });
    const recovered = await service.createPartnerSupplyCheckout(principal, input, { origin: "http://local.test" });
    const row = await admin.query<{ count: number; stripe_checkout_session_id: string | null }>(
      `SELECT count(*)::int AS count, max(p.stripe_checkout_session_id) AS stripe_checkout_session_id
         FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id
        WHERE o.tenant_id=$1 AND o.idempotency_key=$2`,
      [TENANT_A, input.idempotencyKey]
    );
    expect(row.rows[0]).toMatchObject({ count: 1, stripe_checkout_session_id: expect.any(String) });
    expect(recovered.orderId).toBeTruthy();
    expect(checkoutCreate.mock.calls.at(-1)?.[1]).toEqual({
      idempotencyKey: `partner-supply-checkout:${recovered.orderId}`,
    });
  });

  it("fails closed across tenants and permits no runtime rewrite of paid state", async () => {
    const runtime = new Client({ connectionString: process.env.PARTNER_DATABASE_URL });
    await runtime.connect();
    try {
      await runtime.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_B]);
      expect((await runtime.query("SELECT id FROM partner_supply_orders")).rows).toHaveLength(0);
      await expect(runtime.query("UPDATE partner_supply_orders SET status='REFUNDED'")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await runtime.end();
    }
  });

  it("records partial and full Stripe refunds without creating wallet credit, and routes dispatched orders to manual review", async () => {
    const paidOrder = (
      await admin.query<{ id: string }>("SELECT id FROM partner_supply_orders WHERE status='PAID' LIMIT 1")
    ).rows[0].id;
    const part = await service.refundSupplyOrderForSuperAdmin(adminActor, paidOrder, 1000, "packing issue", {
      refunds: { create: refundCreate },
    } as any);
    expect(part).toEqual({ amountPence: 1000, fullyRefunded: false });
    const full = await service.refundSupplyOrderForSuperAdmin(
      adminActor,
      paidOrder,
      undefined,
      "cancelled before dispatch",
      { refunds: { create: refundCreate } } as any
    );
    expect(full.fullyRefunded).toBe(true);
    const refundState = await admin.query<{
      status: string;
      refunded_total_pence: number;
      refunds: number;
      wallets: number;
    }>(
      `SELECT o.status, p.refunded_total_pence, (SELECT count(*)::int FROM partner_supply_refunds r WHERE r.order_id=o.id) AS refunds,
              (SELECT count(*)::int FROM partner_credit_ledger WHERE tenant_id=o.tenant_id) AS wallets
         FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id WHERE o.id=$1`,
      [paidOrder]
    );
    expect(refundState.rows[0]).toMatchObject({
      status: "REFUNDED",
      refunded_total_pence: 17000,
      refunds: 2,
      wallets: 0,
    });

    const pendingVat = (
      await admin.query<{ id: string; stripe_checkout_session_id: string }>(
        "SELECT o.id, p.stripe_checkout_session_id FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id WHERE o.status='PENDING_PAYMENT' LIMIT 1"
      )
    ).rows[0];
    await service.fulfilPartnerSupplyOrder("evt_supply_2", {
      id: pendingVat.stripe_checkout_session_id,
      payment_status: "paid",
      payment_intent: "pi_supply_2",
      metadata: { type: "partner_supply_order", order_id: pendingVat.id, tenant_id: TENANT_A },
    } as any);
    await service.moveSupplyOrderForSuperAdmin(adminActor, pendingVat.id, "processing");
    await service.moveSupplyOrderForSuperAdmin(adminActor, pendingVat.id, "dispatched", "TRACK-1");
    await expect(
      service.refundSupplyOrderForSuperAdmin(adminActor, pendingVat.id, undefined, undefined, {
        refunds: { create: refundCreate },
      } as any)
    ).rejects.toMatchObject({ code: "manual_exception_required" });
    await expect(
      service.requestSupplyManualExceptionForSuperAdmin(adminActor, pendingVat.id, "carrier dispute")
    ).resolves.toBeUndefined();
    const audit = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM partner_supply_order_events WHERE order_id=$1 AND action='manual_exception_required'",
      [pendingVat.id]
    );
    expect(audit.rows[0].count).toBe(2);
    const dashboard = await import("../server/partner/dashboard-service");
    await expect(dashboard.getAlerts(100)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `supply-exception-${pendingVat.id}`,
          partnerId: TENANT_A,
          severity: "medium",
          kind: "supply_manual_exception",
          // Supplies now lives under the consolidated Partner Network navigation.
          link: "/admin/partners/supplies",
        }),
      ])
    );
  });

  /*
   * The stock-count test that lived here is REMOVED with the feature it covered. Migration 0070's
   * partner_supply_stock_counts requires partner_grading_work_items, which does not exist on this
   * lineage, and shop stock counting is outside the catalogue/orders/checkout scope this package
   * was asked for. Both are recoverable together from 0549c0cc if they are ever wanted.
   */
});
