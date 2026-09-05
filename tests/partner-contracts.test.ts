/** Mounted Partner contracts: real login, restricted runtime and owned PostgreSQL only. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrationsRealistic } from "./helpers/partner-realistic-db";
import {
  seedPartnerBrowserDatabase,
  PARTNER_BROWSER_TENANT as A,
  PARTNER_BROWSER_LOCATION as LOCATION,
  PARTNER_BROWSER_IDENTITIES,
} from "../scripts/ci/partner-browser-fixture";

const B = "b1111111-1111-4111-8111-111111111111";
const USER_B = "b3333333-3333-4333-8333-333333333333";
const PAID = "c1111111-1111-4111-8111-111111111111";
const LEGACY = "d1111111-1111-4111-8111-111111111111";
const LOCATION_B = "b2222222-2222-4222-8222-222222222222";
const PAID_B = "c2222222-2222-4222-8222-222222222222";
const LEGACY_B = "d2222222-2222-4222-8222-222222222222";
let cluster: DisposablePostgres17;
let admin: Client;
let server: http.Server;
let base: string;
const password = randomBytes(24).toString("hex");
const cookies = new Map<string, string>();
const email = vi.hoisted(() => ({ send: vi.fn(async () => ({ id: "synthetic-contract-notification" })) }));
vi.mock("../server/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/email")>()),
  sendPartnerSuppliesOrderNotification: email.send,
}));

describe("Partner mounted paid/legacy contracts", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-contracts");
    const control = new Client({ connectionString: cluster.url });
    await control.connect();
    try {
      await control.query("CREATE DATABASE mintvault_partner_browser_runtime_contracts");
    } finally {
      await control.end();
    }
    const url = new URL(cluster.url);
    url.pathname = "/mintvault_partner_browser_runtime_contracts";
    const fixture = await seedPartnerBrowserDatabase(url.toString(), password);
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    await applyMigrationsRealistic(admin, url.toString(), ["0112_partner_supply_commerce"]);
    await admin.query("BEGIN");
    await admin.query(
      "INSERT INTO partner_contacts (tenant_id,full_name,email,contact_type,is_primary,active) VALUES ($1,'Synthetic operations','operations@example.test','operations',true,true)",
      [A]
    );
    await admin.query(
      "INSERT INTO partner_organisations (id,public_ref,legal_name,status) VALUES ($1,'contracts-b','Other Shop','ACTIVE')",
      [B]
    );
    await admin.query(
      `INSERT INTO partner_users (id,public_ref,tenant_id,partner_id,email,password_hash,password_set_at,status,mfa_required)
      SELECT $1,'contracts-user-b',$2,$2,'other@partner-browser.example.test',password_hash,now(),'ACTIVE',false
      FROM partner_users WHERE id=$3`,
      [USER_B, B, PARTNER_BROWSER_IDENTITIES[0].id]
    );
    await admin.query(
      "INSERT INTO partner_user_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM partner_roles WHERE code='PARTNER_OWNER'",
      [B, USER_B]
    );
    await admin.query(
      "INSERT INTO partner_locations (id,public_ref,tenant_id,partner_id,name,status) VALUES ($1,'contracts-location-b',$2,$2,'Other location','ACTIVE')",
      [LOCATION_B, B]
    );
    await admin.query("INSERT INTO partner_user_locations (tenant_id,user_id,location_id) VALUES ($1,$2,$3)", [
      B,
      USER_B,
      LOCATION_B,
    ]);
    await admin.query(
      `INSERT INTO partner_supplies_orders
      (id,public_ref,tenant_id,partner_id,location_id,requesting_user_id,partner_name_snapshot,shop_name_snapshot,
       contact_name_snapshot,contact_email_snapshot,delivery_address_snapshot,delivery_postcode_snapshot,
       idempotency_key,request_fingerprint)
      VALUES ($1,'SUP-CONTRACT-LEGACY',$2,$2,$3,$4,'Historical partner','Historical shop','Historical owner',
       'historical@example.test','2 Previous Street','TE2 2ST','contract-legacy-001',repeat('a',64))`,
      [LEGACY, A, LOCATION, PARTNER_BROWSER_IDENTITIES[0].id]
    );
    await admin.query(
      `INSERT INTO partner_supplies_order_items
      (tenant_id,order_id,product_code,product_label_snapshot,quantity)
      VALUES ($1,$2,'PLASTIC_GRADED_SLABS','Historical slabs',3)`,
      [A, LEGACY]
    );
    await admin.query(
      `INSERT INTO partner_supply_orders
      (id,tenant_id,location_id,idempotency_key,status,delivery_address,gross_total_pence,tax_treatment,submitted_by_user_id,paid_at)
      VALUES ($1,$2,$3,$1,'PAID','{"line1":"3 Paid Snapshot Road","city":"Test Town","postcode":"TE3 3ST","country":"GB"}',7500,'UNCONFIGURED',$4,now())`,
      [PAID, A, LOCATION, PARTNER_BROWSER_IDENTITIES[0].id]
    );
    await admin.query(
      `INSERT INTO partner_supply_payments
      (tenant_id,order_id,status,gross_total_pence,tax_treatment,paid_at)
      VALUES ($1,$2,'PAID',7500,'UNCONFIGURED',now())`,
      [A, PAID]
    );
    await admin.query(
      `INSERT INTO partner_supply_order_items
      (tenant_id,order_id,product_code,product_name_snapshot,units_per_pack_snapshot,quantity,gross_unit_price_pence,gross_line_total_pence)
      VALUES ($1,$2,'plastic_mintvault_slab_box','Paid snapshot slab box',50,1,7500,7500)`,
      [A, PAID]
    );
    await admin.query(
      `INSERT INTO partner_supplies_orders
      (id,public_ref,tenant_id,partner_id,location_id,requesting_user_id,partner_name_snapshot,shop_name_snapshot,
       contact_name_snapshot,contact_email_snapshot,delivery_address_snapshot,delivery_postcode_snapshot,idempotency_key,request_fingerprint)
      SELECT $1,'SUP-CONTRACT-B',$2,$2,$3,$4,'Other partner','Other shop','Other owner','other@example.test',
       '4 Other Street','TE4 4ST','contract-legacy-b001',repeat('b',64)`,
      [LEGACY_B, B, LOCATION_B, USER_B]
    );
    await admin.query(
      `INSERT INTO partner_supplies_order_items (tenant_id,order_id,product_code,product_label_snapshot,quantity)
      VALUES ($1,$2,'NFC_TAGS','Other tags',7)`,
      [B, LEGACY_B]
    );
    await admin.query(
      `INSERT INTO partner_supply_orders
      (id,tenant_id,location_id,idempotency_key,status,delivery_address,gross_total_pence,tax_treatment,submitted_by_user_id,paid_at)
      VALUES ($1,$2,$3,$1,'PAID','{"line1":"4 Other Street"}',15000,'UNCONFIGURED',$4,now())`,
      [PAID_B, B, LOCATION_B, USER_B]
    );
    await admin.query(
      `INSERT INTO partner_supply_payments (tenant_id,order_id,status,gross_total_pence,tax_treatment,paid_at)
      VALUES ($1,$2,'PAID',15000,'UNCONFIGURED',now())`,
      [B, PAID_B]
    );
    await admin.query(
      `INSERT INTO partner_supply_order_items
      (tenant_id,order_id,product_code,product_name_snapshot,units_per_pack_snapshot,quantity,gross_unit_price_pence,gross_line_total_pence)
      VALUES ($1,$2,'plastic_mintvault_slab_box','Other snapshot box',50,2,7500,15000)`,
      [B, PAID_B]
    );
    await admin.query("COMMIT");
    process.env.PARTNER_DATABASE_URL = fixture.runtimeUrl;
    process.env.PARTNER_ADMIN_DATABASE_URL = url.toString();
    process.env.MINTVAULT_DATABASE_URL = url.toString();
    process.env.PARTNER_MFA_ENC_KEY = randomBytes(32).toString("hex");
    const { createPartnerApp } = await import("../server/partner/app");
    server = http.createServer(createPartnerApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const email of [
      ...PARTNER_BROWSER_IDENTITIES.map((identity) => identity.email),
      "other@partner-browser.example.test",
    ]) {
      const response = await fetch(`${base}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toMatch(/^mv\.partner\.sid=/);
      cookies.set(email.split("@")[0], cookie!);
    }
  }, 180_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools();
    await admin?.end();
    await cluster?.stop();
  });

  const get = (path: string, role = "owner") =>
    fetch(`${base}/api/partner/supplies/${path}`, {
      headers: { cookie: cookies.get(role)! },
    });

  for (const role of ["owner", "manager", "finance"]) {
    it(`${role} reads the paid aggregate with server snapshots, never legacy requests`, async () => {
      const response = await get("orders", role);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const { orders } = await response.json();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        id: PAID,
        status: "PAID",
        payment_status: "PAID",
        gross_total_pence: 7500,
        tax_treatment: "UNCONFIGURED",
        vat_total_pence: null,
        net_total_pence: null,
        delivery_address: { line1: "3 Paid Snapshot Road" },
        items: [{ name: "Paid snapshot slab box", unitsPerPack: 50, quantity: 1, grossLineTotalPence: 7500 }],
      });
    });
  }
  it("retains a separately authorised legacy request history", async () => {
    const response = await get("requests");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const { orders } = await response.json();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: LEGACY,
      reference: "SUP-CONTRACT-LEGACY",
      shopName: "Historical shop",
      delivery: { postcode: "TE2 2ST" },
      items: [{ label: "Historical slabs", quantity: 3 }],
    });
    expect((await get("requests", "finance")).status).toBe(403);
  });
  it("fails closed across tenants on both aggregates", async () => {
    for (const path of ["orders", "requests"]) {
      const response = await get(path, "other");
      expect(response.status).toBe(200);
      const { orders } = await response.json();
      expect(orders.map((order: { id: string }) => order.id)).toEqual([path === "orders" ? PAID_B : LEGACY_B]);
    }
  });
  it("does not rewrite either history or payment snapshots when profiles change or reads repeat", async () => {
    const history = async () =>
      (
        await admin.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM partner_supplies_orders t) legacy,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM partner_supplies_order_items t) legacy_items,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM partner_supply_orders t) paid,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM partner_supply_order_items t) paid_items,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM partner_supply_payments t) payments`)
      ).rows[0];
    const before = await history();
    await admin.query(
      "UPDATE partner_locations SET name='Current renamed shop',address_line1='Changed current address' WHERE id=$1",
      [LOCATION]
    );
    for (const path of ["orders", "requests"]) expect((await get(path)).status).toBe(200);
    expect(await history()).toEqual(before);
  });
  it("shares legacy idempotency and guards across canonical and compatibility POSTs without payment effects", async () => {
    const cookie = cookies.get("owner")!;
    expect(
      (
        await fetch(`${base}/api/partner/session/location`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ locationId: LOCATION }),
        })
      ).status
    ).toBe(200);
    const paidBefore = (await admin.query("SELECT to_jsonb(t) row FROM partner_supply_payments t ORDER BY id")).rows;
    const input = { items: [{ productCode: "NFC_TAGS", quantity: 2 }], notes: "Synthetic alias proof" };
    const post = (path: string, role = "owner") =>
      fetch(`${base}/api/partner/supplies/${path}`, {
        method: "POST",
        headers: {
          cookie: cookies.get(role)!,
          "content-type": "application/json",
          "Idempotency-Key": "contract-alias-idempotency-001",
        },
        body: JSON.stringify(input),
      });
    for (const path of ["requests", "orders"]) expect((await post(path, "finance")).status).toBe(403);
    const first = await post("requests");
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.replayed).toBe(false);
    const second = await post("orders");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ replayed: true, order: { id: created.order.id, status: "RECEIVED" } });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM partner_supplies_orders WHERE idempotency_key='contract-alias-idempotency-001'"
        )
      ).rows[0].n
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM partner_supplies_order_events WHERE order_id=$1 AND event_type='ORDER_RECEIVED'",
          [created.order.id]
        )
      ).rows[0].n
    ).toBe(1);
    expect((await admin.query("SELECT to_jsonb(t) row FROM partner_supply_payments t ORDER BY id")).rows).toEqual(
      paidBefore
    );
  });
});
