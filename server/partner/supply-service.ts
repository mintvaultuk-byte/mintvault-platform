import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import {
  MAX_PARTNER_SUPPLY_IMAGE_BYTES,
  MAX_PARTNER_SUPPLY_ITEM_QUANTITY,
  PARTNER_SUPPLY_CURRENCY,
  type PartnerSupplyImageType,
  type PartnerSupplyOrderStatus,
  type PartnerSupplyTaxTreatment,
} from "@shared/partner-supply-products";
import { getUncachableStripeClient } from "../stripeClient";
import { deleteFromR2, getR2SignedUrl, uploadToR2 } from "../r2";
import { writePartnerAudit } from "./audit";
import { partnerAdminQuery, withPartnerAdminTransaction, withTenant } from "./db";
import type { PartnerPrincipal } from "./session";

export const PARTNER_SUPPLY_CHECKOUT_TYPE = "partner_supply_order";

export class PartnerSupplyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type SupplyProductRow = {
  code: string;
  display_name: string;
  units_per_pack: number;
  description: string | null;
  image_key: string | null;
  image_content_type: string | null;
  sort_order: number;
  active_price_pence: number | null;
  active: boolean;
};

type SupplyOperationsRow = SupplyProductRow & {
  known_units: number | null;
  paid_ordered_units: number;
  awaiting_dispatch_units: number;
};

type TaxSettingRow = {
  tax_treatment: PartnerSupplyTaxTreatment;
  vat_rate_basis_points: number | null;
};

type PriceSnapshot = {
  taxTreatment: PartnerSupplyTaxTreatment;
  vatRateBasisPoints: number | null;
  grossTotalPence: number;
  netTotalPence: number | null;
  vatTotalPence: number | null;
};

type AddressSnapshot = Record<string, string>;
type CheckoutLineItem = {
  display_name: string;
  units_per_pack: number;
  active_price_pence: number;
  quantity: number;
};

export type SupplyCheckoutInput = {
  items: unknown;
  deliveryAddress?: unknown;
  idempotencyKey?: unknown;
};

export type SupplyAdminActor = { userId?: string | null; email: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRICE_PENCE = 10_000_000;

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new PartnerSupplyError(400, "invalid_request", `${label} is invalid.`);
  }
  return value;
}

function checkoutIdempotencyKey(value: unknown): string {
  if (value == null || value === "") return randomUUID();
  return requiredUuid(value, "Checkout retry key");
}

function parseItems(value: unknown): Array<{ code: string; quantity: number }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new PartnerSupplyError(400, "invalid_items", "Choose at least one supply item.");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PartnerSupplyError(400, "invalid_items", "One or more supply items are invalid.");
    }
    const code =
      typeof (item as { productCode?: unknown }).productCode === "string"
        ? (item as { productCode: string }).productCode.trim()
        : "";
    const rawQuantity = (item as { quantity?: unknown }).quantity;
    const quantity = typeof rawQuantity === "number" ? rawQuantity : null;
    if (
      !code ||
      seen.has(code) ||
      !Number.isSafeInteger(quantity) ||
      quantity == null ||
      quantity < 1 ||
      quantity > MAX_PARTNER_SUPPLY_ITEM_QUANTITY
    ) {
      throw new PartnerSupplyError(
        400,
        "invalid_items",
        "Each supply item must be unique and have an allowed quantity."
      );
    }
    seen.add(code);
    return { code, quantity };
  });
}

function text(value: unknown, label: string, required = false): string | undefined {
  if (value == null || value === "") {
    if (required) throw new PartnerSupplyError(400, "invalid_delivery_address", `${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new PartnerSupplyError(400, "invalid_delivery_address", `${label} is invalid.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160)
    throw new PartnerSupplyError(400, "invalid_delivery_address", `${label} is invalid.`);
  return trimmed;
}

/** This accepts only a one-off shop delivery address. Customer IDs or customer address references
 * are intentionally not represented in either input or the persisted snapshot. */
function overrideAddress(value: unknown): AddressSnapshot | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PartnerSupplyError(400, "invalid_delivery_address", "Delivery address is invalid.");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["recipientName", "line1", "line2", "city", "postcode", "country"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new PartnerSupplyError(400, "invalid_delivery_address", "Delivery address contains unsupported fields.");
  }
  const snapshot: AddressSnapshot = {
    source: "partner_override",
    line1: text(raw.line1, "Address line 1", true)!,
    city: text(raw.city, "Town or city", true)!,
    postcode: text(raw.postcode, "Postcode", true)!,
    country: text(raw.country, "Country", true)!,
  };
  const recipientName = text(raw.recipientName, "Recipient name");
  const line2 = text(raw.line2, "Address line 2");
  if (recipientName) snapshot.recipientName = recipientName;
  if (line2) snapshot.line2 = line2;
  return snapshot;
}

function taxSnapshot(setting: TaxSettingRow, grossTotalPence: number): PriceSnapshot {
  if (setting.tax_treatment === "UNCONFIGURED") {
    return {
      taxTreatment: "UNCONFIGURED",
      vatRateBasisPoints: null,
      grossTotalPence,
      netTotalPence: null,
      vatTotalPence: null,
    };
  }
  const rate = setting.vat_rate_basis_points;
  if (!Number.isSafeInteger(rate) || rate == null || rate < 0 || rate > 10000) {
    throw new Error("Partner supply tax configuration is invalid.");
  }
  const netTotalPence = Math.round((grossTotalPence * 10000) / (10000 + rate));
  return {
    taxTreatment: "VAT_INCLUDED",
    vatRateBasisPoints: rate,
    grossTotalPence,
    netTotalPence,
    vatTotalPence: grossTotalPence - netTotalPence,
  };
}

function paymentSnapshotParams(snapshot: PriceSnapshot): Array<number | string | null> {
  return [
    PARTNER_SUPPLY_CURRENCY,
    snapshot.grossTotalPence,
    snapshot.taxTreatment,
    snapshot.vatRateBasisPoints,
    snapshot.netTotalPence,
    snapshot.vatTotalPence,
  ];
}

async function appendOrderEvent(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  input: {
    tenantId: string;
    orderId: string;
    action: string;
    actorType: "partner" | "super_admin" | "stripe_webhook" | "system";
    actor?: SupplyAdminActor | PartnerPrincipal | null;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const actor = input.actor;
  const actorUserId = actor && "userId" in actor ? (actor.userId ?? null) : null;
  const actorEmail = actor && "email" in actor ? (actor.email ?? null) : null;
  await client.query(
    `INSERT INTO partner_supply_order_events (tenant_id, order_id, action, actor_type, actor_user_id, actor_email, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.tenantId,
      input.orderId,
      input.action,
      input.actorType,
      actorUserId,
      actorEmail,
      JSON.stringify(input.details ?? {}),
    ]
  );
}

export async function listPartnerSupplyProducts(): Promise<{
  currency: string;
  taxTreatment: PartnerSupplyTaxTreatment;
  vatRateBasisPoints: number | null;
  products: Array<SupplyProductRow & { purchasable: boolean }>;
}> {
  const { rows } = await partnerAdminQuery<SupplyProductRow & TaxSettingRow>(
    `SELECT p.code, p.display_name, p.description, p.units_per_pack, p.active_price_pence, p.active,
            p.image_key, p.image_content_type, p.sort_order,
            t.tax_treatment, t.vat_rate_basis_points
       FROM partner_supply_products p CROSS JOIN partner_supply_tax_settings t
      ORDER BY p.sort_order, p.display_name`
  );
  const setting = rows[0];
  return {
    currency: PARTNER_SUPPLY_CURRENCY,
    taxTreatment: setting?.tax_treatment ?? "UNCONFIGURED",
    vatRateBasisPoints: setting?.vat_rate_basis_points ?? null,
    products: await Promise.all(
      rows.map(async (row) => ({
        code: row.code,
        display_name: row.display_name,
        description: row.description,
        units_per_pack: row.units_per_pack,
        active_price_pence: row.active_price_pence,
        active: row.active,
        image_key: row.image_key,
        image_content_type: row.image_content_type,
        sort_order: row.sort_order,
        /*
         * A SIGNED, short-lived url — never the stored object key, and never a bucket path. The key
         * stays server-side so a catalogue response can never become a durable public link.
         */
        image_url: row.image_key ? await getR2SignedUrl(row.image_key, 3600).catch(() => null) : null,
        // Catalogued and on sale are different facts: a product with no price is visible to
        // MintVault and cannot be bought.
        purchasable: row.active && row.active_price_pence != null,
      }))
    ),
  };
}

export async function createPartnerSupplyCheckout(
  principal: PartnerPrincipal,
  input: SupplyCheckoutInput,
  opts: { origin: string; returnPath?: unknown }
): Promise<{ orderId: string; checkoutUrl: string }> {
  const requestedItems = parseItems(input.items);
  const idempotencyKey = checkoutIdempotencyKey(input.idempotencyKey);
  const requestedOverride = overrideAddress(input.deliveryAddress);
  const pending = await withTenant(
    { tenantId: principal.tenantId, locationId: principal.locationId },
    async (client) => {
      const existing = await client.query<{
        id: string;
        status: PartnerSupplyOrderStatus;
        stripe_checkout_session_id: string | null;
      }>(
        `SELECT o.id, o.status, p.stripe_checkout_session_id
         FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id
        WHERE o.tenant_id=$1 AND o.idempotency_key=$2`,
        [principal.tenantId, idempotencyKey]
      );
      if (existing.rows.length === 1) return { existing: existing.rows[0] };

      const catalogue = await client.query<SupplyProductRow>(
        `SELECT code, display_name, units_per_pack, active_price_pence, active
         FROM partner_supply_products WHERE code = ANY($1::text[])`,
        [requestedItems.map((item) => item.code)]
      );
      if (catalogue.rows.length !== requestedItems.length) {
        throw new PartnerSupplyError(400, "unknown_product", "One or more selected supplies are unavailable.");
      }
      const byCode = new Map(catalogue.rows.map((product) => [product.code, product]));
      const items = requestedItems.map((request) => {
        const product = byCode.get(request.code)!;
        if (!product.active || product.active_price_pence == null || product.active_price_pence > MAX_PRICE_PENCE) {
          throw new PartnerSupplyError(
            409,
            "product_not_priced",
            `${product.display_name} is not currently available to buy.`
          );
        }
        return {
          ...product,
          quantity: request.quantity,
          gross_line_total_pence: product.active_price_pence * request.quantity,
        };
      });
      const grossTotalPence = items.reduce((total, item) => total + item.gross_line_total_pence, 0);
      if (!Number.isSafeInteger(grossTotalPence) || grossTotalPence <= 0)
        throw new PartnerSupplyError(400, "invalid_total", "Order total is invalid.");
      const tax = await client.query<TaxSettingRow>(
        "SELECT tax_treatment, vat_rate_basis_points FROM partner_supply_tax_settings WHERE singleton=true"
      );
      if (tax.rows.length !== 1) throw new Error("Partner supply tax configuration is unavailable.");
      const snapshot = taxSnapshot(tax.rows[0], grossTotalPence);

      const location = await client.query<{ id: string; name: string; address: string | null }>(
        `SELECT id, name, address FROM partner_locations
        WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'`,
        [principal.locationId, principal.tenantId]
      );
      if (location.rows.length !== 1 || !location.rows[0].address?.trim()) {
        throw new PartnerSupplyError(
          409,
          "approved_delivery_address_required",
          "Your approved shop delivery address is unavailable. Contact MintVault support."
        );
      }
      const deliveryAddress = requestedOverride ?? {
        source: "approved_location",
        locationId: location.rows[0].id,
        locationName: location.rows[0].name,
        address: location.rows[0].address.trim(),
      };
      const orderId = randomUUID();
      const order = await client.query<{ id: string }>(
        `INSERT INTO partner_supply_orders
        (id, tenant_id, location_id, idempotency_key, delivery_address, currency, gross_total_pence,
         tax_treatment, vat_rate_basis_points, net_total_pence, vat_total_pence, submitted_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          orderId,
          principal.tenantId,
          location.rows[0].id,
          idempotencyKey,
          JSON.stringify(deliveryAddress),
          ...paymentSnapshotParams(snapshot),
          principal.userId,
        ]
      );
      for (const item of items) {
        await client.query(
          `INSERT INTO partner_supply_order_items
          (tenant_id, order_id, product_code, product_name_snapshot, units_per_pack_snapshot, quantity, gross_unit_price_pence, gross_line_total_pence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            principal.tenantId,
            orderId,
            item.code,
            item.display_name,
            item.units_per_pack,
            item.quantity,
            item.active_price_pence,
            item.gross_line_total_pence,
          ]
        );
      }
      await client.query(
        `INSERT INTO partner_supply_payments
        (tenant_id, order_id, currency, gross_total_pence, tax_treatment, vat_rate_basis_points, net_total_pence, vat_total_pence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [principal.tenantId, orderId, ...paymentSnapshotParams(snapshot)]
      );
      await appendOrderEvent(client, {
        tenantId: principal.tenantId,
        orderId,
        action: "checkout_created",
        actorType: "partner",
        actor: principal,
      });
      await writePartnerAudit(client as never, {
        tenantId: principal.tenantId,
        locationId: location.rows[0].id,
        actorUserId: principal.userId,
        action: "partner_supply_checkout_created",
        recordType: "partner_supply_order",
        recordId: orderId,
        after: {
          gross_total_pence: snapshot.grossTotalPence,
          tax_treatment: snapshot.taxTreatment,
          delivery_source: deliveryAddress.source,
        },
      });
      return { orderId: order.rows[0].id, items, snapshot };
    }
  );

  let orderId: string;
  let checkoutItems: CheckoutLineItem[];
  if ("existing" in pending) {
    const existing = pending.existing;
    if (!existing || existing.status !== "PENDING_PAYMENT") {
      throw new PartnerSupplyError(
        409,
        "checkout_already_processed",
        "This checkout has already been processed. View your orders for its current status."
      );
    }
    if (existing.stripe_checkout_session_id) {
      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(existing.stripe_checkout_session_id);
      if (!session.url)
        throw new PartnerSupplyError(502, "checkout_unavailable", "Could not restore checkout. Try again.");
      return { orderId: existing.id, checkoutUrl: session.url };
    }
    // A transient Stripe outage occurs after an immutable pending order has been recorded. Reuse
    // that exact order and its provider idempotency key instead of orphaning the retry key or
    // re-deriving a price from today's catalogue.
    checkoutItems = await withTenant(
      { tenantId: principal.tenantId, locationId: principal.locationId },
      async (client) => {
        const { rows } = await client.query<CheckoutLineItem>(
          `SELECT product_name_snapshot AS display_name, units_per_pack_snapshot AS units_per_pack,
                gross_unit_price_pence AS active_price_pence, quantity
           FROM partner_supply_order_items
          WHERE tenant_id=$1 AND order_id=$2 ORDER BY id`,
          [principal.tenantId, existing.id]
        );
        if (rows.length === 0) throw new Error("Pending partner supply order has no item snapshot.");
        return rows;
      }
    );
    orderId = existing.id;
  } else {
    orderId = pending.orderId;
    checkoutItems = pending.items.map((item) => ({
      display_name: item.display_name,
      units_per_pack: item.units_per_pack,
      active_price_pence: item.active_price_pence!,
      quantity: item.quantity,
    }));
  }

  const stripe = await getUncachableStripeClient();
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        payment_method_types: ["card"],
        mode: "payment",
        line_items: checkoutItems.map((item) => ({
          price_data: {
            currency: PARTNER_SUPPLY_CURRENCY.toLowerCase(),
            product_data: { name: `${item.display_name} (${item.units_per_pack} per pack)` },
            unit_amount: item.active_price_pence!,
          },
          quantity: item.quantity,
        })),
        metadata: {
          type: PARTNER_SUPPLY_CHECKOUT_TYPE,
          order_id: orderId,
          tenant_id: principal.tenantId,
          partner_user_id: principal.userId,
        },
        success_url: `${opts.origin}${safeReturnPath(opts.returnPath)}?supply_order=success`,
        cancel_url: `${opts.origin}${safeReturnPath(opts.returnPath)}?supply_order=cancelled`,
      },
      { idempotencyKey: `partner-supply-checkout:${orderId}` }
    );
  } catch (err) {
    console.error("[partner-supply] Stripe checkout creation failed", (err as Error).message);
    throw new PartnerSupplyError(502, "checkout_unavailable", "Could not start checkout. Try again.");
  }
  if (!session.url) throw new PartnerSupplyError(502, "checkout_unavailable", "Could not start checkout. Try again.");
  await withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const updated = await client.query(
      `UPDATE partner_supply_payments SET stripe_checkout_session_id=$1, updated_at=now()
        WHERE tenant_id=$2 AND order_id=$3 AND stripe_checkout_session_id IS NULL`,
      [session.id, principal.tenantId, orderId]
    );
    if (updated.rowCount !== 1) throw new Error("Partner supply checkout session could not be recorded.");
  });
  return { orderId, checkoutUrl: session.url };
}

function safeReturnPath(raw: unknown): string {
  const fallback = "/partner/supplies";
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("://")) return fallback;
  return raw;
}

export async function listPartnerSupplyOrders(principal: PartnerPrincipal): Promise<unknown[]> {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const { rows } = await client.query(
      `SELECT o.id, o.status, o.delivery_address, o.currency, o.gross_total_pence, o.tax_treatment,
              o.vat_rate_basis_points, o.net_total_pence, o.vat_total_pence, o.tracking_reference,
              o.created_at, o.paid_at, o.dispatched_at, o.completed_at, o.cancelled_at, o.refunded_at,
              p.status AS payment_status, p.refunded_total_pence,
              COALESCE(jsonb_agg(jsonb_build_object('productCode', i.product_code, 'name', i.product_name_snapshot,
                'unitsPerPack', i.units_per_pack_snapshot, 'quantity', i.quantity, 'grossUnitPricePence', i.gross_unit_price_pence,
                'grossLineTotalPence', i.gross_line_total_pence) ORDER BY i.created_at) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
         FROM partner_supply_orders o
         JOIN partner_supply_payments p ON p.order_id=o.id
         LEFT JOIN partner_supply_order_items i ON i.order_id=o.id
        WHERE o.tenant_id=$1
        GROUP BY o.id, p.status, p.refunded_total_pence
        ORDER BY o.created_at DESC`,
      [principal.tenantId]
    );
    return rows;
  });
}

/*
 * STOCK / OPERATIONS INDICATORS ARE DELIBERATELY NOT PART OF THIS RECONCILIATION.
 *
 * The recovered build carried three functions here — listSupplyOperationsForSuperAdmin,
 * listPartnerSupplyOperations and recordPartnerSupplyStock — backed by migration 0070's
 * partner_supply_stock_counts. That migration cannot run on this lineage: it requires
 * partner_grading_work_items, which exists neither in these migrations nor on staging, so it would
 * fail closed at its own precondition.
 *
 * Shop stock counting is also outside the catalogue/orders/checkout scope this package was asked
 * for, and half-wiring a warehouse indicator into a money surface is not something to do quietly.
 * The code is recoverable from codex/mintvault-final-product-integration (0549c0cc) if it is ever
 * wanted, together with the grading work-items table it depends on.
 */

export async function fulfilPartnerSupplyOrder(
  eventId: string,
  session: Pick<Stripe.Checkout.Session, "id" | "metadata" | "payment_status" | "payment_intent">
): Promise<{ paid: boolean; reason?: string }> {
  if (session.payment_status !== "paid") return { paid: false, reason: "not_paid" };
  const meta = session.metadata ?? {};
  const orderId = meta.order_id;
  const tenantId = meta.tenant_id;
  if (meta.type !== PARTNER_SUPPLY_CHECKOUT_TYPE || !UUID_RE.test(orderId ?? "") || !UUID_RE.test(tenantId ?? "")) {
    console.error(`[webhook] partner_supply malformed session ${session.id} event ${eventId}`);
    return { paid: false, reason: "malformed_metadata" };
  }
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
  return withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{
      status: PartnerSupplyOrderStatus;
      payment_status: string;
      stripe_checkout_session_id: string | null;
    }>(
      `SELECT o.status, p.status AS payment_status, p.stripe_checkout_session_id
         FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id
        WHERE o.id=$1 AND o.tenant_id=$2 FOR UPDATE`,
      [orderId, tenantId]
    );
    const current = rows[0];
    if (!current || current.stripe_checkout_session_id !== session.id) {
      console.error(`[webhook] partner_supply session/order mismatch event ${eventId}`);
      return { paid: false, reason: "session_mismatch" };
    }
    if (current.status !== "PENDING_PAYMENT" || current.payment_status !== "PENDING") {
      return { paid: false, reason: "duplicate_or_not_pending" };
    }
    const payment = await client.query(
      `UPDATE partner_supply_payments
          SET status='PAID', stripe_payment_intent_id=$1, paid_at=now(), updated_at=now()
        WHERE order_id=$2 AND status='PENDING'`,
      [paymentIntentId, orderId]
    );
    const order = await client.query(
      `UPDATE partner_supply_orders SET status='PAID', paid_at=now(), updated_at=now()
        WHERE id=$1 AND status='PENDING_PAYMENT'`,
      [orderId]
    );
    if (payment.rowCount !== 1 || order.rowCount !== 1)
      throw new Error("Partner supply webhook payment transition was not applied.");
    await appendOrderEvent(client, {
      tenantId,
      orderId,
      action: "stripe_payment_confirmed",
      actorType: "stripe_webhook",
      details: {
        stripe_event_id: eventId,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      },
    });
    await writePartnerAudit(client, {
      tenantId,
      action: "partner_supply_order_paid",
      recordType: "partner_supply_order",
      recordId: orderId,
      after: {
        stripe_event_id: eventId,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      },
    });
    return { paid: true };
  });
}

export async function listSupplyOrdersForSuperAdmin(): Promise<unknown[]> {
  const { rows } = await partnerAdminQuery(
    `SELECT o.id, o.status, o.delivery_address, o.currency, o.gross_total_pence, o.tax_treatment,
            o.vat_rate_basis_points, o.net_total_pence, o.vat_total_pence, o.tracking_reference, o.created_at,
            org.legal_name AS partner_name, l.name AS location_name, p.status AS payment_status, p.refunded_total_pence,
            COALESCE(jsonb_agg(jsonb_build_object('productCode', i.product_code, 'name', i.product_name_snapshot,
              'unitsPerPack', i.units_per_pack_snapshot, 'quantity', i.quantity, 'grossUnitPricePence', i.gross_unit_price_pence,
              'grossLineTotalPence', i.gross_line_total_pence) ORDER BY i.created_at) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
       FROM partner_supply_orders o
       JOIN partner_organisations org ON org.id=o.tenant_id
       JOIN partner_locations l ON l.id=o.location_id AND l.tenant_id=o.tenant_id
       JOIN partner_supply_payments p ON p.order_id=o.id
       LEFT JOIN partner_supply_order_items i ON i.order_id=o.id
      GROUP BY o.id, org.legal_name, l.name, p.status, p.refunded_total_pence
      ORDER BY o.created_at DESC`
  );
  return rows;
}

export async function listSupplyOrderAuditForSuperAdmin(orderId: unknown): Promise<unknown[]> {
  requiredUuid(orderId, "Order ID");
  const { rows } = await partnerAdminQuery(
    `SELECT action, actor_type, actor_user_id, actor_email, details, created_at
       FROM partner_supply_order_events WHERE order_id=$1 ORDER BY id DESC`,
    [orderId]
  );
  return rows;
}

export async function moveSupplyOrderForSuperAdmin(
  actor: SupplyAdminActor,
  orderId: unknown,
  action: "processing" | "dispatched" | "completed",
  trackingReference?: unknown
): Promise<void> {
  const id = requiredUuid(orderId, "Order ID");
  const transitions = {
    processing: { from: "PAID", to: "PROCESSING", timestamp: "" },
    dispatched: { from: "PROCESSING", to: "DISPATCHED", timestamp: ", dispatched_at=now(), tracking_reference=$3" },
    completed: { from: "DISPATCHED", to: "COMPLETED", timestamp: ", completed_at=now()" },
  } as const;
  const transition = transitions[action];
  const tracking = action === "dispatched" ? (text(trackingReference, "Tracking reference") ?? null) : null;
  await withPartnerAdminTransaction(async (client) => {
    const current = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM partner_supply_orders WHERE id=$1 FOR UPDATE",
      [id]
    );
    if (current.rows.length !== 1) throw new PartnerSupplyError(404, "order_not_found", "Order not found.");
    const sql =
      action === "dispatched"
        ? `UPDATE partner_supply_orders SET status='DISPATCHED', updated_at=now()${transition.timestamp} WHERE id=$1 AND status=$2`
        : `UPDATE partner_supply_orders SET status='${transition.to}', updated_at=now()${transition.timestamp} WHERE id=$1 AND status=$2`;
    const updated =
      action === "dispatched"
        ? await client.query(sql, [id, transition.from, tracking])
        : await client.query(sql, [id, transition.from]);
    if (updated.rowCount !== 1)
      throw new PartnerSupplyError(
        409,
        "invalid_order_transition",
        "That order cannot move to the selected fulfilment state."
      );
    await appendOrderEvent(client, {
      tenantId: current.rows[0].tenant_id,
      orderId: id,
      action: `super_admin_marked_${action}`,
      actorType: "super_admin",
      actor,
      details: tracking ? { tracking_reference: tracking } : {},
    });
    await writePartnerAudit(client, {
      tenantId: current.rows[0].tenant_id,
      actorUserId: actor.userId ?? null,
      action: `partner_supply_order_${action}`,
      recordType: "partner_supply_order",
      recordId: id,
      after: tracking ? { tracking_reference: tracking } : {},
    });
  });
}

type RefundStripeClient = Pick<Stripe, "refunds">;

export async function refundSupplyOrderForSuperAdmin(
  actor: SupplyAdminActor,
  orderId: unknown,
  amountPence?: unknown,
  reason?: unknown,
  stripeOverride?: RefundStripeClient
): Promise<{ amountPence: number; fullyRefunded: boolean }> {
  const id = requiredUuid(orderId, "Order ID");
  const requestedReason = text(reason, "Refund reason");
  const outcome = await withPartnerAdminTransaction<
    { manualException: true } | { amountPence: number; fullyRefunded: boolean }
  >(async (client) => {
    const { rows } = await client.query<{
      tenant_id: string;
      order_status: PartnerSupplyOrderStatus;
      payment_id: string;
      payment_status: string;
      stripe_payment_intent_id: string | null;
      gross_total_pence: number;
      refunded_total_pence: number;
    }>(
      `SELECT o.tenant_id, o.status AS order_status, p.id AS payment_id, p.status AS payment_status,
              p.stripe_payment_intent_id, p.gross_total_pence, p.refunded_total_pence
         FROM partner_supply_orders o JOIN partner_supply_payments p ON p.order_id=o.id
        WHERE o.id=$1 FOR UPDATE`,
      [id]
    );
    const current = rows[0];
    if (!current) throw new PartnerSupplyError(404, "order_not_found", "Order not found.");
    if (["DISPATCHED", "COMPLETED"].includes(current.order_status)) {
      await appendOrderEvent(client, {
        tenantId: current.tenant_id,
        orderId: id,
        action: "manual_exception_required",
        actorType: "super_admin",
        actor,
        details: { requested_action: "refund" },
      });
      await writePartnerAudit(client, {
        tenantId: current.tenant_id,
        actorUserId: actor.userId ?? null,
        action: "partner_supply_manual_exception_required",
        recordType: "partner_supply_order",
        recordId: id,
        after: { requested_action: "refund" },
      });
      return { manualException: true };
    }
    if (
      !["PAID", "PROCESSING", "PARTIALLY_REFUNDED"].includes(current.order_status) ||
      !current.stripe_payment_intent_id
    ) {
      throw new PartnerSupplyError(409, "refund_not_available", "This order is not in a refundable paid state.");
    }
    const remaining = current.gross_total_pence - current.refunded_total_pence;
    const amount = amountPence == null ? remaining : typeof amountPence === "number" ? amountPence : null;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > remaining) {
      throw new PartnerSupplyError(
        400,
        "invalid_refund_amount",
        "Refund amount must not exceed the remaining paid total."
      );
    }
    const stripe = stripeOverride ?? (await getUncachableStripeClient());
    let refund: Stripe.Refund;
    try {
      refund = await stripe.refunds.create(
        { payment_intent: current.stripe_payment_intent_id, amount, metadata: { partner_supply_order_id: id } },
        {
          idempotencyKey: `partner-supply-refund:${id}:${current.refunded_total_pence}:${amount}`,
        }
      );
    } catch (err) {
      console.error("[partner-supply] Stripe refund failed", (err as Error).message);
      throw new PartnerSupplyError(502, "refund_unavailable", "Stripe could not process this refund. Try again.");
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO partner_supply_refunds (tenant_id, order_id, payment_id, stripe_refund_id, amount_pence, admin_email, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (stripe_refund_id) DO NOTHING RETURNING id`,
      [current.tenant_id, id, current.payment_id, refund.id, amount, actor.email, requestedReason ?? null]
    );
    const fullyRefunded = current.refunded_total_pence + amount === current.gross_total_pence;
    if (inserted.rowCount === 1) {
      const payment = await client.query(
        `UPDATE partner_supply_payments SET refunded_total_pence=refunded_total_pence+$1,
           status=CASE WHEN refunded_total_pence+$1=gross_total_pence THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
           updated_at=now() WHERE id=$2`,
        [amount, current.payment_id]
      );
      const order = await client.query(
        `UPDATE partner_supply_orders SET status=$1, refunded_at=CASE WHEN $1='REFUNDED' THEN now() ELSE refunded_at END,
           updated_at=now() WHERE id=$2`,
        [fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED", id]
      );
      if (payment.rowCount !== 1 || order.rowCount !== 1)
        throw new Error("Partner supply refund transition was not applied.");
      await appendOrderEvent(client, {
        tenantId: current.tenant_id,
        orderId: id,
        action: "stripe_refund_recorded",
        actorType: "super_admin",
        actor,
        details: { amount_pence: amount, stripe_refund_id: refund.id, full_refund: fullyRefunded },
      });
      await writePartnerAudit(client, {
        tenantId: current.tenant_id,
        actorUserId: actor.userId ?? null,
        action: "partner_supply_order_refunded",
        recordType: "partner_supply_order",
        recordId: id,
        after: { amount_pence: amount, stripe_refund_id: refund.id, full_refund: fullyRefunded },
        reason: requestedReason ?? null,
      });
    }
    return { amountPence: amount, fullyRefunded };
  });
  if ("manualException" in outcome) {
    throw new PartnerSupplyError(
      409,
      "manual_exception_required",
      "Dispatched or completed orders require manual exception review."
    );
  }
  return outcome;
}

export async function cancelSupplyOrderForSuperAdmin(
  actor: SupplyAdminActor,
  orderId: unknown,
  reason?: unknown
): Promise<void> {
  const id = requiredUuid(orderId, "Order ID");
  const requestedReason = text(reason, "Cancellation reason");
  const { rows } = await partnerAdminQuery<{ status: PartnerSupplyOrderStatus; tenant_id: string }>(
    "SELECT status, tenant_id FROM partner_supply_orders WHERE id=$1",
    [id]
  );
  const current = rows[0];
  if (!current) throw new PartnerSupplyError(404, "order_not_found", "Order not found.");
  if (["DISPATCHED", "COMPLETED"].includes(current.status)) {
    await withPartnerAdminTransaction(async (client) =>
      appendOrderEvent(client, {
        tenantId: current.tenant_id,
        orderId: id,
        action: "manual_exception_required",
        actorType: "super_admin",
        actor,
        details: { requested_action: "cancel" },
      })
    );
    throw new PartnerSupplyError(
      409,
      "manual_exception_required",
      "Dispatched or completed orders require manual exception review."
    );
  }
  if (current.status === "PENDING_PAYMENT") {
    await withPartnerAdminTransaction(async (client) => {
      const changed = await client.query(
        "UPDATE partner_supply_orders SET status='CANCELLED', cancelled_at=now(), updated_at=now() WHERE id=$1 AND status='PENDING_PAYMENT'",
        [id]
      );
      if (changed.rowCount !== 1)
        throw new PartnerSupplyError(409, "invalid_order_transition", "This checkout is no longer pending.");
      await appendOrderEvent(client, {
        tenantId: current.tenant_id,
        orderId: id,
        action: "super_admin_cancelled_pending_checkout",
        actorType: "super_admin",
        actor,
        details: requestedReason ? { reason: requestedReason } : {},
      });
      await writePartnerAudit(client, {
        tenantId: current.tenant_id,
        actorUserId: actor.userId ?? null,
        action: "partner_supply_order_cancelled",
        recordType: "partner_supply_order",
        recordId: id,
        reason: requestedReason ?? null,
      });
    });
    return;
  }
  await refundSupplyOrderForSuperAdmin(actor, id, undefined, requestedReason);
}

/** Records, but never auto-resolves, a post-dispatch commercial exception. This is deliberately
 * separate from refund/cancel so the Admin UI can route an issue for human handling without
 * contacting Stripe or modifying paid fulfilment history. */
export async function requestSupplyManualExceptionForSuperAdmin(
  actor: SupplyAdminActor,
  orderId: unknown,
  reason?: unknown
): Promise<void> {
  const id = requiredUuid(orderId, "Order ID");
  const requestedReason = text(reason, "Manual exception reason");
  const { rows } = await partnerAdminQuery<{ status: PartnerSupplyOrderStatus; tenant_id: string }>(
    "SELECT status, tenant_id FROM partner_supply_orders WHERE id=$1",
    [id]
  );
  const current = rows[0];
  if (!current) throw new PartnerSupplyError(404, "order_not_found", "Order not found.");
  if (!(["DISPATCHED", "COMPLETED"] as PartnerSupplyOrderStatus[]).includes(current.status)) {
    throw new PartnerSupplyError(
      409,
      "manual_exception_not_required",
      "Manual exception review is only for dispatched or completed orders."
    );
  }
  await withPartnerAdminTransaction(async (client) => {
    await appendOrderEvent(client, {
      tenantId: current.tenant_id,
      orderId: id,
      action: "manual_exception_required",
      actorType: "super_admin",
      actor,
      details: { requested_action: "manual_review", ...(requestedReason ? { reason: requestedReason } : {}) },
    });
    await writePartnerAudit(client, {
      tenantId: current.tenant_id,
      actorUserId: actor.userId ?? null,
      action: "partner_supply_manual_exception_requested",
      recordType: "partner_supply_order",
      recordId: id,
      after: { requested_action: "manual_review" },
      reason: requestedReason ?? null,
    });
  });
}

/**
 * THE CATALOGUE IS EDITABLE. Every field, every product, including the price.
 *
 * The recovered build could only toggle `active` and set a price, and refused outright to change
 * the slab box because `pricing_mode = 'LOCKED'` pinned it at 7500 pence. Owner decision
 * (2026-08-22): no selling price is permanently hard-coded, so the mode is gone and £75 is simply
 * the value migration 0111 seeded.
 *
 * WHAT A PRICE CHANGE DOES AND DOES NOT DO. It updates ONE row. It cannot reach a historical order,
 * because an order line stores `gross_unit_price_pence` at the moment it was placed and nothing
 * ever writes to that column again. There is no Stripe Price object to replace either: checkout
 * builds `price_data` inline from this row, so a price is only ever read forward.
 *
 * Fields are updated only when PRESENT. `undefined` means "leave it alone" and `null` is a
 * deliberate clear — collapsing the two would let a form that posts three fields silently blank the
 * two it did not render.
 */
export async function updateSupplyCatalogueForSuperAdmin(
  actor: SupplyAdminActor,
  code: unknown,
  body: {
    active?: unknown;
    activePricePence?: unknown;
    displayName?: unknown;
    description?: unknown;
    unitsPerPack?: unknown;
    sortOrder?: unknown;
  }
): Promise<void> {
  if (typeof code !== "string" || !code) throw new PartnerSupplyError(400, "unknown_product", "Product not found.");
  const { rows } = await partnerAdminQuery<SupplyProductRow>("SELECT * FROM partner_supply_products WHERE code=$1", [
    code,
  ]);
  const current = rows[0];
  if (!current) throw new PartnerSupplyError(404, "unknown_product", "Product not found.");

  const active = body.active === undefined ? current.active : body.active;
  if (typeof active !== "boolean") {
    throw new PartnerSupplyError(400, "invalid_catalogue", "Catalogue values are invalid.");
  }

  // undefined = keep the configured price. null = the explicit admin operation that takes a product
  // off sale while leaving it catalogued. Malformed input is never coerced into either.
  const suppliedPrice = body.activePricePence;
  if (suppliedPrice !== undefined && suppliedPrice !== null && typeof suppliedPrice !== "number") {
    throw new PartnerSupplyError(400, "invalid_catalogue", "Catalogue values are invalid.");
  }
  const price: number | null = suppliedPrice === undefined ? current.active_price_pence : suppliedPrice;
  if (!(price == null || (Number.isSafeInteger(price) && price >= 1 && price <= MAX_PRICE_PENCE))) {
    throw new PartnerSupplyError(400, "invalid_catalogue", "A price must be a whole number of pence.");
  }

  const displayName = body.displayName === undefined ? current.display_name : normaliseProductName(body.displayName);
  const description =
    body.description === undefined ? current.description : normaliseProductDescription(body.description);
  const unitsPerPack = body.unitsPerPack === undefined ? current.units_per_pack : normalisePackSize(body.unitsPerPack);
  const sortOrder = body.sortOrder === undefined ? current.sort_order : normaliseSortOrder(body.sortOrder);

  await partnerAdminQuery(
    `UPDATE partner_supply_products
        SET active=$1, active_price_pence=$2, display_name=$3, description=$4,
            units_per_pack=$5, sort_order=$6, updated_at=now()
      WHERE code=$7`,
    [active, price, displayName, description, unitsPerPack, sortOrder, code]
  );
  console.info("[partner-supply] catalogue updated", {
    code,
    actor: actor.email,
    active,
    priceChanged: price !== current.active_price_pence,
    configuredPrice: price != null,
  });
}

/** A product code is an identity, so it is generated from the name and never taken from the browser. */
function productCodeFrom(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (slug.length < 3) throw new PartnerSupplyError(400, "invalid_catalogue", "Give the product a longer name.");
  return slug;
}

function normaliseProductName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 120) {
    throw new PartnerSupplyError(400, "invalid_catalogue", "A product name of up to 120 characters is required.");
  }
  return name;
}

function normaliseProductDescription(value: unknown): string | null {
  if (value === null) return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > 2000) {
    throw new PartnerSupplyError(400, "invalid_catalogue", "A description must be 2000 characters or fewer.");
  }
  return text;
}

function normalisePackSize(value: unknown): number {
  const units = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(units) || units < 1 || units > 1_000_000) {
    throw new PartnerSupplyError(400, "invalid_catalogue", "Units per pack must be a whole number of at least 1.");
  }
  return units;
}

function normaliseSortOrder(value: unknown): number {
  const order = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(order) || order < 0 || order > 100000) {
    throw new PartnerSupplyError(400, "invalid_catalogue", "Sort order must be a whole number.");
  }
  return order;
}

/**
 * ADD A SUPPLY PRODUCT — the capability the recovered build did not have.
 *
 * There was no INSERT anywhere: the three products were seeded by the migration and pinned there by
 * a CHECK constraint naming them. A fourth product was impossible at the database, so no screen
 * could have added one. 0111 removes that constraint and this is the authority that uses it.
 *
 * A new product is deliberately created with NO PRICE. It is catalogued, visible to MintVault, and
 * not purchasable until somebody decides what it costs — which is the honest state of a product
 * nobody has priced, and keeps "exists" and "on sale" separable.
 */
export async function createSupplyProductForSuperAdmin(
  actor: SupplyAdminActor,
  body: {
    displayName?: unknown;
    description?: unknown;
    unitsPerPack?: unknown;
    activePricePence?: unknown;
    sortOrder?: unknown;
  }
): Promise<{ code: string }> {
  const displayName = normaliseProductName(body.displayName);
  const description = normaliseProductDescription(body.description ?? null);
  const unitsPerPack = body.unitsPerPack === undefined ? 1 : normalisePackSize(body.unitsPerPack);
  const sortOrder = body.sortOrder === undefined ? 100 : normaliseSortOrder(body.sortOrder);
  const suppliedPrice = body.activePricePence;
  if (suppliedPrice !== undefined && suppliedPrice !== null && typeof suppliedPrice !== "number") {
    throw new PartnerSupplyError(400, "invalid_catalogue", "A price must be a whole number of pence.");
  }
  const price: number | null = suppliedPrice === undefined || suppliedPrice === null ? null : suppliedPrice;
  if (price !== null && !(Number.isSafeInteger(price) && price >= 1 && price <= MAX_PRICE_PENCE)) {
    throw new PartnerSupplyError(400, "invalid_catalogue", "A price must be a whole number of pence.");
  }
  const code = productCodeFrom(displayName);

  const inserted = await partnerAdminQuery<{ code: string }>(
    `INSERT INTO partner_supply_products (code, display_name, description, units_per_pack, active_price_pence, active, sort_order)
     VALUES ($1,$2,$3,$4,$5,true,$6)
     ON CONFLICT (code) DO NOTHING
     RETURNING code`,
    [code, displayName, description, unitsPerPack, price, sortOrder]
  );
  if (inserted.rows.length === 0) {
    // A duplicate NAME is the realistic mistake, and it must not silently overwrite a live product.
    throw new PartnerSupplyError(409, "duplicate_product", "A supply product with that name already exists.");
  }
  console.info("[partner-supply] product created", { code, actor: actor.email, priced: price != null });
  return { code };
}

/**
 * SET OR REPLACE A PRODUCT IMAGE.
 *
 * Validation is by CONTENT, not by filename or by the client's declared type: the magic bytes are
 * checked and the image is then actually decoded, so a renamed executable or a truncated file is
 * refused before anything reaches storage. The object key is server-generated and includes a random
 * component, so an admin cannot choose a path and a replaced image cannot be served from a stale
 * cached url.
 *
 * The previous object is deleted AFTER the row points at the new one; a failure there leaves an
 * orphaned object rather than a product whose image key points at nothing.
 */
export async function setSupplyProductImageForSuperAdmin(
  actor: SupplyAdminActor,
  code: unknown,
  file: { buffer: Buffer; mimetype?: string } | undefined
): Promise<{ imageUrl: string }> {
  if (typeof code !== "string" || !code) throw new PartnerSupplyError(400, "unknown_product", "Product not found.");
  if (!file?.buffer?.length) throw new PartnerSupplyError(400, "image_required", "Choose an image file.");
  if (file.buffer.length > MAX_PARTNER_SUPPLY_IMAGE_BYTES) {
    throw new PartnerSupplyError(413, "image_too_large", "That image is larger than 4 MB.");
  }

  const detected = detectSupplyImageType(file.buffer);
  if (!detected) {
    throw new PartnerSupplyError(400, "image_invalid", "Upload a PNG, JPEG or WEBP image.");
  }
  // Decode it for real. Magic bytes prove the first few bytes; a decode proves it is an image.
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(file.buffer).metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
  } catch {
    throw new PartnerSupplyError(400, "image_invalid", "That file could not be read as an image.");
  }

  const { rows } = await partnerAdminQuery<SupplyProductRow>("SELECT * FROM partner_supply_products WHERE code=$1", [
    code,
  ]);
  const current = rows[0];
  if (!current) throw new PartnerSupplyError(404, "unknown_product", "Product not found.");

  const extension = detected === "image/png" ? "png" : detected === "image/webp" ? "webp" : "jpg";
  const key = `supplies/products/${code}/${randomUUID()}.${extension}`;
  await uploadToR2(key, file.buffer, detected);
  await partnerAdminQuery(
    "UPDATE partner_supply_products SET image_key=$1, image_content_type=$2, image_updated_at=now(), updated_at=now() WHERE code=$3",
    [key, detected, code]
  );
  if (current.image_key && current.image_key !== key) {
    await deleteFromR2(current.image_key).catch(() => {});
  }
  console.info("[partner-supply] product image set", { code, actor: actor.email, contentType: detected });
  return { imageUrl: await getR2SignedUrl(key, 3600) };
}

/** Remove a product's image. The product itself and its orders are untouched. */
export async function removeSupplyProductImageForSuperAdmin(actor: SupplyAdminActor, code: unknown): Promise<void> {
  if (typeof code !== "string" || !code) throw new PartnerSupplyError(400, "unknown_product", "Product not found.");
  const { rows } = await partnerAdminQuery<SupplyProductRow>("SELECT * FROM partner_supply_products WHERE code=$1", [
    code,
  ]);
  const current = rows[0];
  if (!current) throw new PartnerSupplyError(404, "unknown_product", "Product not found.");
  await partnerAdminQuery(
    "UPDATE partner_supply_products SET image_key=NULL, image_content_type=NULL, image_updated_at=NULL, updated_at=now() WHERE code=$1",
    [code]
  );
  if (current.image_key) await deleteFromR2(current.image_key).catch(() => {});
  console.info("[partner-supply] product image removed", { code, actor: actor.email });
}

/**
 * Magic-byte detection. The declared Content-Type is not consulted at all — a browser can claim
 * anything, and the whole point of this check is to establish what the bytes actually are.
 */
export function detectSupplyImageType(buffer: Buffer): PartnerSupplyImageType | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function updateSupplyTaxForSuperAdmin(
  actor: SupplyAdminActor,
  input: { taxTreatment?: unknown; vatRateBasisPoints?: unknown }
): Promise<void> {
  const treatment = input.taxTreatment;
  const rawRate = input.vatRateBasisPoints;
  const rate = typeof rawRate === "number" ? rawRate : null;
  if (treatment !== "UNCONFIGURED" && treatment !== "VAT_INCLUDED") {
    throw new PartnerSupplyError(400, "invalid_tax_configuration", "Tax treatment is invalid.");
  }
  if (treatment === "UNCONFIGURED" && rate != null)
    throw new PartnerSupplyError(400, "invalid_tax_configuration", "Unconfigured tax cannot include a VAT rate.");
  if (
    treatment === "VAT_INCLUDED" &&
    (typeof rate !== "number" || !Number.isSafeInteger(rate) || rate < 0 || rate > 10000)
  ) {
    throw new PartnerSupplyError(400, "invalid_tax_configuration", "VAT rate is invalid.");
  }
  await partnerAdminQuery(
    "UPDATE partner_supply_tax_settings SET tax_treatment=$1, vat_rate_basis_points=$2, updated_at=now() WHERE singleton=true",
    [treatment, treatment === "VAT_INCLUDED" ? rate : null]
  );
  console.info("[partner-supply] tax configuration updated", { actor: actor.email, treatment });
}
