/**
 * Partner supplies ordering — canonical domain service.
 *
 * This file owns ONE small operational contract: a Partner submits an immutable supplies request
 * for one server-selected location, then a durable outbox attempts the existing Resend notification.
 * It is deliberately not a generic order engine, checkout, price list, inventory system or a second
 * source of truth for Partner locations/contacts. Tenant/user/location all come from the validated
 * Partner session; the browser can only provide fixed product codes, bounded quantities and notes.
 */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { sendPartnerSuppliesOrderNotification } from "../email";
import { writePartnerAudit } from "./audit";
import { partnerAdminQuery, partnerRuntimeQuery, withPartnerAdminTransaction, withTenant } from "./db";
import type { PartnerPrincipal } from "./session";

export const SUPPLIES_PRODUCTS = [
  { code: "PLASTIC_GRADED_SLABS", label: "Plastic graded slabs" },
  { code: "PRINT_PAPER_LABEL_STOCK", label: "Print paper / label stock" },
  { code: "NFC_TAGS", label: "NFC tags" },
] as const;

export type SuppliesProductCode = (typeof SUPPLIES_PRODUCTS)[number]["code"];
export type SuppliesOrderStatus = "RECEIVED" | "PROCESSING" | "DISPATCHED" | "CANCELLED";
type NotificationStatus = "PENDING" | "CLAIMED" | "SENT" | "FAILED";

const PRODUCT_BY_CODE = new Map(SUPPLIES_PRODUCTS.map((product) => [product.code, product]));
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UK_POSTCODE_RE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const NOTE_SECRET_RE = /\b(?:password|passphrase|pwd|secret|credential|api[ _-]?key|access[ _-]?key|private[ _-]?key|token|session|cookie|mfa|totp|otp|bearer)\b/i;
const SUPPLIES_MIGRATION = "0102_partner_supplies_orders.sql";
const CLAIM_LEASE_SECONDS = 5 * 60;
const MAX_NOTIFICATION_ATTEMPTS = 12;
// Resend retains an idempotency key for 24h. Keep one hour of clock/queue margin: once a worker
// could have sent more than 23h ago, a same-key retry is no longer an effectively-once operation.
const RESEND_SAFE_RETRY_WINDOW_SECONDS = 23 * 60 * 60;

export class SuppliesError extends Error {
  constructor(
    readonly code:
      | "SUPPLIES_UNAVAILABLE"
      | "VALIDATION_ERROR"
      | "IDEMPOTENCY_CONFLICT"
      | "LOCATION_SELECTION_REQUIRED"
      | "DELIVERY_ADDRESS_REQUIRED"
      | "DELIVERY_CONTACT_REQUIRED"
      | "NOT_FOUND"
      | "INVALID_STATUS_TRANSITION"
      | "NOTIFICATION_RECONCILIATION_REQUIRED",
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export type SuppliesItemInput = { productCode: SuppliesProductCode; quantity: number };
export type CreateSuppliesOrderInput = { items: SuppliesItemInput[]; notes?: string | null; idempotencyKey: string };

export type SuppliesOrderView = {
  id: string;
  reference: string;
  status: SuppliesOrderStatus;
  partnerName: string;
  shopName: string;
  contact: { name: string; email: string; phone: string | null };
  delivery: { address: string; postcode: string; country: string };
  notes: string | null;
  items: Array<{ productCode: SuppliesProductCode; label: string; quantity: number }>;
  createdAt: string;
  updatedAt: string;
  notificationStatus: NotificationStatus | null;
  notificationRecovery: "RETRY_AVAILABLE" | "RECONCILIATION_REQUIRED" | null;
};

type DeliverySnapshot = {
  tenantId: string;
  partnerId: string;
  locationId: string;
  requestingUserId: string;
  partnerName: string;
  shopName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  address: string;
  postcode: string;
  country: string;
};

type SuppliesOrderRow = {
  id: string;
  public_ref: string;
  status: SuppliesOrderStatus;
  partner_name_snapshot: string;
  shop_name_snapshot: string;
  contact_name_snapshot: string;
  contact_email_snapshot: string;
  contact_phone_snapshot: string | null;
  delivery_address_snapshot: string;
  delivery_postcode_snapshot: string;
  delivery_country_snapshot: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  notification_status?: NotificationStatus | null;
  notification_failure_code?: "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED" | "PROVIDER_UNCERTAIN" | null;
  notification_uncertain_delivery_at?: string | null;
};

type SuppliesItemRow = { product_code: SuppliesProductCode; product_label_snapshot: string; quantity: number };

let suppliesSchemaHealthy = false;

function fingerprint(input: { items: SuppliesItemInput[]; notes: string | null }): string {
  const items = [...input.items]
    .sort((a, b) => a.productCode.localeCompare(b.productCode))
    .map((item) => ({ productCode: item.productCode, quantity: item.quantity }));
  return crypto.createHash("sha256").update(JSON.stringify({ items, notes: input.notes })).digest("hex");
}

function normalizeItems(raw: unknown): SuppliesItemInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SUPPLIES_PRODUCTS.length) {
    throw new SuppliesError("VALIDATION_ERROR", "Select at least one valid supplies product.", 400);
  }
  const unique = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== "object") {
      throw new SuppliesError("VALIDATION_ERROR", "Each supplies item must be valid.", 400);
    }
    const candidate = item as { productCode?: unknown; quantity?: unknown };
    if (typeof candidate.productCode !== "string" || !PRODUCT_BY_CODE.has(candidate.productCode as SuppliesProductCode)) {
      throw new SuppliesError("VALIDATION_ERROR", "An unknown supplies product was requested.", 400);
    }
    if (
      typeof candidate.quantity !== "number" ||
      !Number.isInteger(candidate.quantity) ||
      !Number.isSafeInteger(candidate.quantity) ||
      candidate.quantity < 1 ||
      candidate.quantity > 1000
    ) {
      throw new SuppliesError("VALIDATION_ERROR", "Each supplies quantity must be a whole number from 1 to 1000.", 400);
    }
    if (unique.has(candidate.productCode)) {
      throw new SuppliesError("VALIDATION_ERROR", "Choose each supplies product only once.", 400);
    }
    unique.add(candidate.productCode);
    return { productCode: candidate.productCode as SuppliesProductCode, quantity: candidate.quantity };
  });
}

function normalizeNotes(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw new SuppliesError("VALIDATION_ERROR", "Notes must be plain text.", 400);
  const notes = raw.trim();
  if (!notes) return null;
  if (notes.length > 1000) throw new SuppliesError("VALIDATION_ERROR", "Notes must be 1000 characters or fewer.", 400);
  // Notes travel to an operational email. Credentials must never be placed in that channel.
  if (NOTE_SECRET_RE.test(notes)) {
    throw new SuppliesError("VALIDATION_ERROR", "Notes cannot contain credentials or authentication details.", 400);
  }
  return notes;
}

function normalizeCreateInput(input: CreateSuppliesOrderInput): { items: SuppliesItemInput[]; notes: string | null; idempotencyKey: string } {
  if (!input || typeof input !== "object" || !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey ?? "")) {
    throw new SuppliesError("VALIDATION_ERROR", "A valid request idempotency key is required.", 400);
  }
  return { items: normalizeItems(input.items), notes: normalizeNotes(input.notes), idempotencyKey: input.idempotencyKey };
}

function postcodeFromAddress(address: string): string | null {
  const match = address.match(UK_POSTCODE_RE)?.[0];
  return match ? match.toUpperCase().replace(/\s+/g, " ").trim() : null;
}

async function schemaRelationsPresent(query: <T extends { present: boolean }>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>): Promise<boolean> {
  const { rows } = await query(
    `SELECT to_regclass('public.partner_supplies_orders') IS NOT NULL
            AND to_regclass('public.partner_supplies_order_items') IS NOT NULL
            AND to_regclass('public.partner_supplies_order_events') IS NOT NULL
            AND to_regclass('public.partner_supplies_order_notifications') IS NOT NULL AS present`
  );
  return rows[0]?.present === true;
}

/** Feature-local schema gate: a missing Supplies migration must never take login/dashboard down. */
export async function assertSuppliesSchemaAvailable(): Promise<void> {
  if (suppliesSchemaHealthy) return;
  let present = false;
  try {
    present = await schemaRelationsPresent(partnerRuntimeQuery);
  } catch {
    present = false;
  }
  if (!present) {
    throw new SuppliesError(
      "SUPPLIES_UNAVAILABLE",
      `Supplies ordering is temporarily unavailable. Apply migrations/${SUPPLIES_MIGRATION}.`,
      503
    );
  }
  suppliesSchemaHealthy = true;
}

/** Test-only: clear the success cache after replacing a disposable schema. */
export function __resetSuppliesSchemaForTests(): void {
  suppliesSchemaHealthy = false;
}

async function resolveDeliverySnapshot(client: PoolClient, principal: PartnerPrincipal): Promise<DeliverySnapshot> {
  if (!principal.locationId) {
    throw new SuppliesError(
      "LOCATION_SELECTION_REQUIRED",
      "Select an active shop location before requesting supplies.",
      409
    );
  }
  const { rows } = await client.query<{
    tenant_id: string;
    partner_id: string;
    location_id: string;
    user_id: string;
    legal_name: string;
    trading_name: string | null;
    location_name: string;
    location_address: string | null;
    contact_name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
  }>(
    `SELECT o.id AS tenant_id, l.partner_id, l.id AS location_id, u.id AS user_id,
            o.legal_name, p.trading_name, l.name AS location_name, l.address AS location_address,
            c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
       FROM partner_locations l
       JOIN partner_organisations o ON o.id=l.tenant_id
       JOIN partner_users u ON u.id=$2 AND u.tenant_id=l.tenant_id AND u.status='ACTIVE'
       LEFT JOIN partner_profiles p ON p.tenant_id=o.id
       LEFT JOIN partner_contacts c ON c.tenant_id=o.id AND c.is_primary AND c.active
      WHERE l.id=$1 AND l.tenant_id=$3 AND l.status='ACTIVE'`,
    [principal.locationId, principal.userId, principal.tenantId]
  );
  const row = rows[0];
  if (!row) {
    throw new SuppliesError("LOCATION_SELECTION_REQUIRED", "Select an active shop location before requesting supplies.", 409);
  }
  const address = row.location_address?.trim() ?? "";
  const postcode = address ? postcodeFromAddress(address) : null;
  if (!address || address.length < 12 || !postcode) {
    throw new SuppliesError(
      "DELIVERY_ADDRESS_REQUIRED",
      "This shop needs a complete delivery address with postcode. Ask your Partner Owner or MintVault administrator to update the location.",
      409
    );
  }
  const contactName = row.contact_name?.trim() ?? "";
  const contactEmail = row.contact_email?.trim().toLowerCase() ?? "";
  if (!contactName || !EMAIL_RE.test(contactEmail)) {
    throw new SuppliesError(
      "DELIVERY_CONTACT_REQUIRED",
      "This Partner needs an active operational contact with a valid email before supplies can be requested.",
      409
    );
  }
  return {
    tenantId: row.tenant_id,
    partnerId: row.partner_id,
    locationId: row.location_id,
    requestingUserId: row.user_id,
    partnerName: row.trading_name?.trim() || row.legal_name,
    shopName: row.location_name,
    contactName,
    contactEmail,
    contactPhone: row.contact_phone?.trim() || null,
    address,
    postcode,
    country: "GB",
  };
}

function mapOrder(row: SuppliesOrderRow, items: SuppliesItemRow[]): SuppliesOrderView {
  const uncertainAt = row.notification_uncertain_delivery_at ? new Date(row.notification_uncertain_delivery_at).getTime() : Number.NaN;
  const reconciliationRequired =
    row.notification_status !== "SENT" &&
    Number.isFinite(uncertainAt) &&
    Date.now() - uncertainAt >= RESEND_SAFE_RETRY_WINDOW_SECONDS * 1000;
  return {
    id: row.id,
    reference: row.public_ref,
    status: row.status,
    partnerName: row.partner_name_snapshot,
    shopName: row.shop_name_snapshot,
    contact: { name: row.contact_name_snapshot, email: row.contact_email_snapshot, phone: row.contact_phone_snapshot },
    delivery: {
      address: row.delivery_address_snapshot,
      postcode: row.delivery_postcode_snapshot,
      country: row.delivery_country_snapshot,
    },
    notes: row.notes,
    items: items.map((item) => ({ productCode: item.product_code, label: item.product_label_snapshot, quantity: Number(item.quantity) })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notificationStatus: row.notification_status ?? null,
    notificationRecovery:
      reconciliationRequired ? "RECONCILIATION_REQUIRED" : row.notification_status === "FAILED" ? "RETRY_AVAILABLE" : null,
  };
}

async function loadOrderInTenant(client: PoolClient, orderId: string): Promise<SuppliesOrderView | null> {
  const order = await client.query<SuppliesOrderRow>(
    `SELECT o.*, n.status AS notification_status, n.failure_code AS notification_failure_code,
            n.uncertain_delivery_at AS notification_uncertain_delivery_at
       FROM partner_supplies_orders o
       LEFT JOIN partner_supplies_order_notifications n ON n.order_id=o.id AND n.tenant_id=o.tenant_id
      WHERE o.id=$1 AND o.tenant_id=partner_current_tenant()`,
    [orderId]
  );
  if (order.rows.length !== 1) return null;
  const items = await client.query<SuppliesItemRow>(
    `SELECT product_code, product_label_snapshot, quantity
       FROM partner_supplies_order_items
      WHERE order_id=$1 AND tenant_id=partner_current_tenant()
      ORDER BY product_code ASC`,
    [orderId]
  );
  return mapOrder(order.rows[0], items.rows);
}

export async function getSuppliesDeliveryPreview(principal: PartnerPrincipal): Promise<{
  partnerName: string;
  shopName: string;
  contact: { name: string; email: string; phone: string | null };
  delivery: { address: string; postcode: string; country: string };
}> {
  await assertSuppliesSchemaAvailable();
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const snapshot = await resolveDeliverySnapshot(client, principal);
    return {
      partnerName: snapshot.partnerName,
      shopName: snapshot.shopName,
      contact: { name: snapshot.contactName, email: snapshot.contactEmail, phone: snapshot.contactPhone },
      delivery: { address: snapshot.address, postcode: snapshot.postcode, country: snapshot.country },
    };
  });
}

export async function createSuppliesOrder(
  principal: PartnerPrincipal,
  rawInput: CreateSuppliesOrderInput
): Promise<{ order: SuppliesOrderView; replayed: boolean }> {
  await assertSuppliesSchemaAvailable();
  const input = normalizeCreateInput(rawInput);
  const requestFingerprint = fingerprint(input);

  const create = async (): Promise<{ order: SuppliesOrderView; replayed: boolean }> =>
    withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
      const replay = await client.query<{ id: string; request_fingerprint: string }>(
        `SELECT id, request_fingerprint FROM partner_supplies_orders
          WHERE tenant_id=$1 AND idempotency_key=$2`,
        [principal.tenantId, input.idempotencyKey]
      );
      if (replay.rows.length === 1) {
        if (replay.rows[0].request_fingerprint !== requestFingerprint) {
          throw new SuppliesError("IDEMPOTENCY_CONFLICT", "This request key was already used for different supplies details.", 409);
        }
        const order = await loadOrderInTenant(client, replay.rows[0].id);
        if (!order) throw new SuppliesError("NOT_FOUND", "The existing supplies order could not be loaded.", 404);
        return { order, replayed: true };
      }

      const snapshot = await resolveDeliverySnapshot(client, principal);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO partner_supplies_orders
           (tenant_id, partner_id, location_id, requesting_user_id,
            partner_name_snapshot, shop_name_snapshot, contact_name_snapshot, contact_email_snapshot, contact_phone_snapshot,
            delivery_address_snapshot, delivery_postcode_snapshot, delivery_country_snapshot, notes, idempotency_key, request_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          snapshot.tenantId,
          snapshot.partnerId,
          snapshot.locationId,
          snapshot.requestingUserId,
          snapshot.partnerName,
          snapshot.shopName,
          snapshot.contactName,
          snapshot.contactEmail,
          snapshot.contactPhone,
          snapshot.address,
          snapshot.postcode,
          snapshot.country,
          input.notes,
          input.idempotencyKey,
          requestFingerprint,
        ]
      );
      const orderId = inserted.rows[0]?.id;
      if (!orderId) throw new Error("supplies order insert returned no id");
      for (const item of input.items) {
        const product = PRODUCT_BY_CODE.get(item.productCode)!;
        await client.query(
          `INSERT INTO partner_supplies_order_items (tenant_id, order_id, product_code, product_label_snapshot, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [snapshot.tenantId, orderId, product.code, product.label, item.quantity]
        );
      }
      await client.query(
        `INSERT INTO partner_supplies_order_notifications (tenant_id, order_id, provider_idempotency_key)
         VALUES ($1,$2,$3)`,
        [snapshot.tenantId, orderId, `partner-supplies-order:${orderId}:v1`]
      );
      await client.query(
        `INSERT INTO partner_supplies_order_events
           (tenant_id, order_id, event_type, actor_partner_user_id, after_status, detail)
         VALUES ($1,$2,'ORDER_RECEIVED',$3,'RECEIVED',$4::jsonb)`,
        [snapshot.tenantId, orderId, principal.userId, JSON.stringify({ itemCount: input.items.length })]
      );
      await writePartnerAudit(client, {
        tenantId: snapshot.tenantId,
        locationId: snapshot.locationId,
        actorUserId: principal.userId,
        sessionId: principal.sessionId,
        action: "partner_supplies_order_received",
        recordType: "partner_supplies_order",
        recordId: orderId,
        after: { status: "RECEIVED", itemCount: input.items.length },
      });
      const order = await loadOrderInTenant(client, orderId);
      if (!order) throw new Error("supplies order did not reload after insert");
      return { order, replayed: false };
    });

  try {
    return await create();
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    if (pg?.code !== "23505" || pg.constraint !== "uq_partner_supplies_orders_tenant_idempotency") throw error;
    // A concurrent submit won the unique race. Re-open a fresh scoped transaction and return only
    // the same immutable intent; a changed payload using the reused key remains a conflict.
    return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
      const replay = await client.query<{ id: string; request_fingerprint: string }>(
        `SELECT id, request_fingerprint FROM partner_supplies_orders WHERE tenant_id=$1 AND idempotency_key=$2`,
        [principal.tenantId, input.idempotencyKey]
      );
      if (replay.rows.length !== 1) throw error;
      if (replay.rows[0].request_fingerprint !== requestFingerprint) {
        throw new SuppliesError("IDEMPOTENCY_CONFLICT", "This request key was already used for different supplies details.", 409);
      }
      const order = await loadOrderInTenant(client, replay.rows[0].id);
      if (!order) throw error;
      return { order, replayed: true };
    });
  }
}

export async function listOwnSuppliesOrders(principal: PartnerPrincipal): Promise<SuppliesOrderView[]> {
  await assertSuppliesSchemaAvailable();
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const orders = await client.query<SuppliesOrderRow>(
      `SELECT o.*, n.status AS notification_status, n.failure_code AS notification_failure_code,
              n.uncertain_delivery_at AS notification_uncertain_delivery_at
         FROM partner_supplies_orders o
         LEFT JOIN partner_supplies_order_notifications n ON n.order_id=o.id AND n.tenant_id=o.tenant_id
        WHERE o.tenant_id=$1 AND o.requesting_user_id=$2
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 200`,
      [principal.tenantId, principal.userId]
    );
    if (orders.rows.length === 0) return [];
    const orderIds = orders.rows.map((order) => order.id);
    const items = await client.query<SuppliesItemRow & { order_id: string }>(
      `SELECT order_id, product_code, product_label_snapshot, quantity
         FROM partner_supplies_order_items
        WHERE tenant_id=$1 AND order_id = ANY($2::uuid[])
        ORDER BY order_id, product_code`,
      [principal.tenantId, orderIds]
    );
    const byOrder = new Map<string, SuppliesItemRow[]>();
    for (const item of items.rows) byOrder.set(item.order_id, [...(byOrder.get(item.order_id) ?? []), item]);
    return orders.rows.map((order) => mapOrder(order, byOrder.get(order.id) ?? []));
  });
}

type ClaimedNotification = {
  notificationId: string;
  tenantId: string;
  orderId: string;
  claimToken: string;
  attemptCount: number;
  providerIdempotencyKey: string;
  order: SuppliesOrderRow;
  items: SuppliesItemRow[];
};

async function suppliesSchemaAvailableToAdmin(): Promise<boolean> {
  if (suppliesSchemaHealthy) return true;
  try {
    const present = await schemaRelationsPresent(partnerAdminQuery);
    if (present) suppliesSchemaHealthy = true;
    return present;
  } catch {
    return false;
  }
}

async function claimDueNotifications(limit: number, onlyOrderId?: string): Promise<ClaimedNotification[]> {
  return withPartnerAdminTransaction(async (client) => {
    const filter = onlyOrderId ? "AND n.order_id=$2::uuid" : "";
    const params: unknown[] = [Math.min(Math.max(limit, 1), 25)];
    if (onlyOrderId) params.push(onlyOrderId);
    const claimed = await client.query<{
      id: string;
      tenant_id: string;
      order_id: string;
      claim_token: string;
      attempt_count: number;
      provider_idempotency_key: string;
    }>(
      `WITH due AS (
         SELECT n.id
           FROM partner_supplies_order_notifications n
           JOIN partner_supplies_orders o ON o.id=n.order_id AND o.tenant_id=n.tenant_id
          WHERE o.status='RECEIVED'
            AND n.attempt_count < ${MAX_NOTIFICATION_ATTEMPTS}
            ${filter}
            -- A dead worker may have reached Resend before it could record SENT. Do not retry
            -- beyond Resend's conservative same-key window: reconciliation is then required.
            AND NOT (
              n.uncertain_delivery_at IS NOT NULL
              AND n.uncertain_delivery_at <= now() - interval '${RESEND_SAFE_RETRY_WINDOW_SECONDS} seconds'
            )
            AND (
              (n.status IN ('PENDING','FAILED') AND n.next_attempt_at <= now())
              OR (n.status='CLAIMED' AND n.claim_expires_at <= now())
            )
          ORDER BY n.next_attempt_at, n.id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE partner_supplies_order_notifications n
          SET status='CLAIMED', attempt_count=n.attempt_count+1, last_attempt_at=now(),
              uncertain_delivery_at=COALESCE(n.uncertain_delivery_at, now()),
              next_attempt_at=now() + interval '${CLAIM_LEASE_SECONDS} seconds',
              claim_token=gen_random_uuid(), claim_expires_at=now() + interval '${CLAIM_LEASE_SECONDS} seconds',
              failure_code=NULL, updated_at=now()
         FROM due
        WHERE n.id=due.id
       RETURNING n.id, n.tenant_id, n.order_id, n.claim_token, n.attempt_count, n.provider_idempotency_key`,
      params
    );
    const result: ClaimedNotification[] = [];
    for (const notification of claimed.rows) {
      const order = await client.query<SuppliesOrderRow>(
        `SELECT o.* FROM partner_supplies_orders o WHERE o.id=$1 AND o.tenant_id=$2`,
        [notification.order_id, notification.tenant_id]
      );
      const items = await client.query<SuppliesItemRow>(
        `SELECT product_code, product_label_snapshot, quantity
           FROM partner_supplies_order_items WHERE order_id=$1 AND tenant_id=$2 ORDER BY product_code`,
        [notification.order_id, notification.tenant_id]
      );
      if (order.rows.length !== 1 || items.rows.length === 0) throw new Error("supplies notification claim lost canonical order data");
      await client.query(
        `INSERT INTO partner_supplies_order_events
           (tenant_id, order_id, event_type, after_status, detail)
         VALUES ($1,$2,'NOTIFICATION_ATTEMPTED',$3,$4::jsonb)`,
        [notification.tenant_id, notification.order_id, order.rows[0].status, JSON.stringify({ attemptNumber: notification.attempt_count })]
      );
      result.push({
        notificationId: notification.id,
        tenantId: notification.tenant_id,
        orderId: notification.order_id,
        claimToken: notification.claim_token,
        attemptCount: Number(notification.attempt_count),
        providerIdempotencyKey: notification.provider_idempotency_key,
        order: order.rows[0],
        items: items.rows,
      });
    }
    return result;
  });
}

/**
 * A worker can die after it claims an outbox row but before it records the provider result. Once
 * the provider's same-key guarantee is outside its safe window, surface that uncertainty as an
 * immutable operational event rather than leaving a hidden pending/claimed row or risking a
 * duplicate.
 */
async function normalizeStaleUncertainNotifications(): Promise<void> {
  await withPartnerAdminTransaction(async (client) => {
    const normalized = await client.query<{ tenant_id: string; order_id: string; attempt_count: number; prior_status: NotificationStatus }>(
      `WITH stale AS (
         SELECT id, status AS prior_status
           FROM partner_supplies_order_notifications
          WHERE status IN ('PENDING','CLAIMED')
            AND uncertain_delivery_at IS NOT NULL
            AND uncertain_delivery_at <= now() - interval '${RESEND_SAFE_RETRY_WINDOW_SECONDS} seconds'
          FOR UPDATE
       )
       UPDATE partner_supplies_order_notifications n
          SET status='FAILED', claim_token=NULL, claim_expires_at=NULL, failure_code='PROVIDER_UNCERTAIN',
              next_attempt_at=NULL, updated_at=now()
         FROM stale
        WHERE n.id=stale.id
       RETURNING n.tenant_id, n.order_id, n.attempt_count, stale.prior_status`
    );
    for (const notification of normalized.rows) {
      await client.query(
        `INSERT INTO partner_supplies_order_events
           (tenant_id, order_id, event_type, detail)
         VALUES ($1,$2,'NOTIFICATION_RECONCILIATION_REQUIRED',$3::jsonb)`,
        [
          notification.tenant_id,
          notification.order_id,
          JSON.stringify({
            attemptNumber: Number(notification.attempt_count),
            priorStatus: notification.prior_status,
            reason: "provider_idempotency_window_elapsed",
          }),
        ]
      );
    }
  });
}

function notificationFailureCode(error: unknown): "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED" | "PROVIDER_UNCERTAIN" {
  const message = error instanceof Error ? error.message : "";
  // This is the one known state where no provider request was possible: the Resend client did not
  // exist. Every post-claim provider response remains delivery-uncertain by default.
  if (message === "email provider unavailable") return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_UNCERTAIN";
}

async function markNotificationSent(claim: ClaimedNotification, providerMessageId: string): Promise<void> {
  await withPartnerAdminTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE partner_supplies_order_notifications
          SET status='SENT', sent_at=now(), provider_message_id=$3, claim_token=NULL, claim_expires_at=NULL,
              next_attempt_at=NULL, failure_code=NULL, uncertain_delivery_at=NULL, updated_at=now()
        WHERE id=$1 AND claim_token=$2 AND status='CLAIMED'`,
      [claim.notificationId, claim.claimToken, providerMessageId]
    );
    if ((updated.rowCount ?? 0) !== 1) return;
    await client.query(
      `INSERT INTO partner_supplies_order_events
         (tenant_id, order_id, event_type, after_status, detail)
       VALUES ($1,$2,'NOTIFICATION_SENT',$3,$4::jsonb)`,
      [claim.tenantId, claim.orderId, claim.order.status, JSON.stringify({ attemptNumber: claim.attemptCount, providerMessageId })]
    );
  });
}

async function markNotificationFailed(
  claim: ClaimedNotification,
  failureCode: "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED" | "PROVIDER_UNCERTAIN"
): Promise<void> {
  await withPartnerAdminTransaction(async (client) => {
    const delay = claim.attemptCount === 1 ? "15 minutes" : "2 hours";
    const updated = await client.query(
      `UPDATE partner_supplies_order_notifications
          SET status='FAILED', claim_token=NULL, claim_expires_at=NULL, failure_code=$3,
              uncertain_delivery_at=CASE WHEN $3='PROVIDER_UNCERTAIN' THEN COALESCE(uncertain_delivery_at, last_attempt_at, now()) ELSE NULL END,
              next_attempt_at=CASE
                WHEN attempt_count >= $4 THEN NULL
                WHEN $3='PROVIDER_UNCERTAIN'
                  AND COALESCE(uncertain_delivery_at, last_attempt_at, now()) <= now() - interval '${RESEND_SAFE_RETRY_WINDOW_SECONDS} seconds' THEN NULL
                ELSE now() + $5::interval
              END,
              updated_at=now()
        WHERE id=$1 AND claim_token=$2 AND status='CLAIMED'`,
      [claim.notificationId, claim.claimToken, failureCode, MAX_NOTIFICATION_ATTEMPTS, delay]
    );
    if ((updated.rowCount ?? 0) !== 1) return;
    await client.query(
      `INSERT INTO partner_supplies_order_events
         (tenant_id, order_id, event_type, after_status, detail)
       VALUES ($1,$2,'NOTIFICATION_FAILED',$3,$4::jsonb)`,
      [claim.tenantId, claim.orderId, claim.order.status, JSON.stringify({ attemptNumber: claim.attemptCount, failureCode })]
    );
  });
}

/**
 * Bounded worker entry point. It tolerates absent schema/configuration as a no-op so a rolling
 * deployment can never take unrelated MintVault work down; an order route has already provided the
 * clear local migration error before it can enqueue work.
 */
export async function processPartnerSuppliesNotificationBatch(options: { limit?: number; onlyOrderId?: string } = {}): Promise<{
  processed: number;
  sent: number;
  failed: number;
  state: "READY" | "UNAVAILABLE";
}> {
  if (!(await suppliesSchemaAvailableToAdmin())) return { processed: 0, sent: 0, failed: 0, state: "UNAVAILABLE" };
  await normalizeStaleUncertainNotifications();
  const claims = await claimDueNotifications(options.limit ?? 10, options.onlyOrderId);
  let sent = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      const receipt = await sendPartnerSuppliesOrderNotification({
        orderReference: claim.order.public_ref,
        partnerName: claim.order.partner_name_snapshot,
        shopName: claim.order.shop_name_snapshot,
        contactName: claim.order.contact_name_snapshot,
        contactEmail: claim.order.contact_email_snapshot,
        contactPhone: claim.order.contact_phone_snapshot,
        deliveryAddress: claim.order.delivery_address_snapshot,
        deliveryPostcode: claim.order.delivery_postcode_snapshot,
        deliveryCountry: claim.order.delivery_country_snapshot,
        submittedAt: new Date(claim.order.created_at).toISOString(),
        items: claim.items.map((item) => ({ label: item.product_label_snapshot, quantity: Number(item.quantity) })),
        notes: claim.order.notes,
        idempotencyKey: claim.providerIdempotencyKey,
      });
      if (!receipt) throw new Error("email provider unavailable");
      await markNotificationSent(claim, receipt.id);
      sent += 1;
    } catch (error) {
      await markNotificationFailed(claim, notificationFailureCode(error));
      failed += 1;
    }
  }
  return { processed: claims.length, sent, failed, state: "READY" };
}

/** Attempt the just-committed order once. Failure is durable and never turns order creation into a false rollback. */
export async function attemptNewSuppliesOrderNotification(orderId: string): Promise<NotificationStatus> {
  try {
    await processPartnerSuppliesNotificationBatch({ limit: 1, onlyOrderId: orderId });
  } catch {
    // The committed outbox is the recovery authority. Never leak a provider/DB error to the Partner
    // and never recreate the order because an optional after-commit attempt had a platform fault.
  }
  try {
    const { rows } = await partnerAdminQuery<{ status: NotificationStatus }>(
      `SELECT status FROM partner_supplies_order_notifications WHERE order_id=$1`,
      [orderId]
    );
    return rows[0]?.status ?? "PENDING";
  } catch {
    return "PENDING";
  }
}

export async function listSuppliesOrdersForAdmin(options: { status?: SuppliesOrderStatus; limit?: number } = {}): Promise<SuppliesOrderView[]> {
  if (!(await suppliesSchemaAvailableToAdmin())) {
    throw new SuppliesError("SUPPLIES_UNAVAILABLE", `Supplies ordering is temporarily unavailable. Apply migrations/${SUPPLIES_MIGRATION}.`, 503);
  }
  const params: unknown[] = [];
  const where: string[] = [];
  if (options.status) {
    params.push(options.status);
    where.push(`o.status=$${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 200, 1), 500));
  const { rows } = await partnerAdminQuery<SuppliesOrderRow>(
    `SELECT o.*, n.status AS notification_status, n.failure_code AS notification_failure_code,
            n.uncertain_delivery_at AS notification_uncertain_delivery_at
       FROM partner_supplies_orders o
       LEFT JOIN partner_supplies_order_notifications n ON n.order_id=o.id AND n.tenant_id=o.tenant_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${params.length}`,
    params
  );
  if (rows.length === 0) return [];
  const orderIds = rows.map((row) => row.id);
  const items = await partnerAdminQuery<SuppliesItemRow & { order_id: string }>(
    `SELECT order_id, product_code, product_label_snapshot, quantity
       FROM partner_supplies_order_items WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, product_code`,
    [orderIds]
  );
  const byOrder = new Map<string, SuppliesItemRow[]>();
  for (const item of items.rows) byOrder.set(item.order_id, [...(byOrder.get(item.order_id) ?? []), item]);
  return rows.map((row) => mapOrder(row, byOrder.get(row.id) ?? []));
}

export async function transitionSuppliesOrderAsAdmin(input: {
  orderId: string;
  status: SuppliesOrderStatus;
  actorUserId: string;
  actorEmail: string;
  requestId: string;
}): Promise<SuppliesOrderView> {
  if (!(await suppliesSchemaAvailableToAdmin())) {
    throw new SuppliesError("SUPPLIES_UNAVAILABLE", `Supplies ordering is temporarily unavailable. Apply migrations/${SUPPLIES_MIGRATION}.`, 503);
  }
  return withPartnerAdminTransaction(async (client) => {
    const current = await client.query<SuppliesOrderRow & { tenant_id: string }>(
      `SELECT * FROM partner_supplies_orders WHERE id=$1 FOR UPDATE`,
      [input.orderId]
    );
    const order = current.rows[0];
    if (!order) throw new SuppliesError("NOT_FOUND", "Supplies order not found.", 404);
    const allowed =
      (order.status === "RECEIVED" && (input.status === "PROCESSING" || input.status === "CANCELLED")) ||
      (order.status === "PROCESSING" && (input.status === "DISPATCHED" || input.status === "CANCELLED"));
    if (!allowed) {
      throw new SuppliesError("INVALID_STATUS_TRANSITION", `Cannot change a ${order.status.toLowerCase()} supplies order to ${input.status.toLowerCase()}.`, 409);
    }
    const updated = await client.query<SuppliesOrderRow>(
      `UPDATE partner_supplies_orders SET status=$2 WHERE id=$1 AND tenant_id=$3 RETURNING *`,
      [input.orderId, input.status, order.tenant_id]
    );
    // The operational notification describes a newly received request. Once the lifecycle leaves
    // RECEIVED, retire any unsent due work in the same authoritative transition transaction; the
    // worker also joins this current lifecycle state when it claims, so a late scheduler cannot
    // revive cancelled/completed stock instructions.
    const suppressed = await client.query(
      `UPDATE partner_supplies_order_notifications
          SET next_attempt_at=NULL, updated_at=now()
        WHERE order_id=$1 AND tenant_id=$2 AND status IN ('PENDING','FAILED') AND next_attempt_at IS NOT NULL`,
      [input.orderId, order.tenant_id]
    );
    const eventType = `STATUS_${input.status}`;
    await client.query(
      `INSERT INTO partner_supplies_order_events
         (tenant_id, order_id, event_type, actor_admin_user_id, actor_admin_email, before_status, after_status, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        order.tenant_id,
        input.orderId,
        eventType,
        input.actorUserId,
        input.actorEmail,
        order.status,
        input.status,
        JSON.stringify({ requestId: input.requestId, suppressedNotificationCount: suppressed.rowCount ?? 0 }),
      ]
    );
    await writePartnerAudit(client, {
      tenantId: order.tenant_id,
      actorUserId: input.actorUserId,
      action: "partner_supplies_order_status_changed",
      recordType: "partner_supplies_order",
      recordId: input.orderId,
      before: { status: order.status },
      after: { status: input.status, suppressedNotificationCount: suppressed.rowCount ?? 0 },
      correlationId: /^[0-9a-f-]{36}$/i.test(input.requestId) ? input.requestId : null,
    });
    const itemRows = await client.query<SuppliesItemRow>(
      `SELECT product_code, product_label_snapshot, quantity FROM partner_supplies_order_items
        WHERE order_id=$1 AND tenant_id=$2 ORDER BY product_code`,
      [input.orderId, order.tenant_id]
    );
    const notification = await client.query<{
      status: NotificationStatus;
      failure_code: SuppliesOrderRow["notification_failure_code"];
      uncertain_delivery_at: string | null;
    }>(
      `SELECT status, failure_code, uncertain_delivery_at FROM partner_supplies_order_notifications WHERE order_id=$1 AND tenant_id=$2`,
      [input.orderId, order.tenant_id]
    );
    return mapOrder(
      {
        ...updated.rows[0],
        notification_status: notification.rows[0]?.status ?? null,
        notification_failure_code: notification.rows[0]?.failure_code ?? null,
        notification_uncertain_delivery_at: notification.rows[0]?.uncertain_delivery_at ?? null,
      },
      itemRows.rows
    );
  });
}

/**
 * Requeue an unsent terminal notification after a fresh Super Admin step-up. Automatic retries
 * remain bounded; this is the explicit recovery authority for an operational provider outage.
 * The immutable order and Resend idempotency key are intentionally never recreated or rotated.
 */
export async function retrySuppliesOrderNotificationAsAdmin(input: {
  orderId: string;
  actorUserId: string;
  actorEmail: string;
  requestId: string;
}): Promise<SuppliesOrderView> {
  if (!(await suppliesSchemaAvailableToAdmin())) {
    throw new SuppliesError("SUPPLIES_UNAVAILABLE", `Supplies ordering is temporarily unavailable. Apply migrations/${SUPPLIES_MIGRATION}.`, 503);
  }
  return withPartnerAdminTransaction(async (client) => {
    const current = await client.query<
      SuppliesOrderRow & {
        tenant_id: string;
        notification_status: NotificationStatus;
        attempt_count: number;
        notification_failure_code: SuppliesOrderRow["notification_failure_code"];
        notification_uncertain_delivery_at: string | null;
      }
    >(
      `SELECT o.*, n.status AS notification_status, n.attempt_count,
              n.failure_code AS notification_failure_code, n.uncertain_delivery_at AS notification_uncertain_delivery_at
         FROM partner_supplies_orders o
         JOIN partner_supplies_order_notifications n ON n.order_id=o.id AND n.tenant_id=o.tenant_id
        WHERE o.id=$1
        FOR UPDATE OF o, n`,
      [input.orderId]
    );
    const order = current.rows[0];
    if (!order) throw new SuppliesError("NOT_FOUND", "Supplies order not found.", 404);
    const uncertainAt = order.notification_uncertain_delivery_at ? new Date(order.notification_uncertain_delivery_at).getTime() : Number.NaN;
    if (Number.isFinite(uncertainAt) && Date.now() - uncertainAt >= RESEND_SAFE_RETRY_WINDOW_SECONDS * 1000) {
      throw new SuppliesError(
        "NOTIFICATION_RECONCILIATION_REQUIRED",
        "Notification delivery is uncertain outside the safe provider retry window. Verify the Resend record and operational inbox before any resend.",
        409
      );
    }
    if (order.status !== "RECEIVED") {
      throw new SuppliesError("VALIDATION_ERROR", "Only a received supplies order can have its failed notification retried.", 409);
    }
    if (order.notification_status !== "FAILED") {
      throw new SuppliesError("VALIDATION_ERROR", "Only a failed, unsent supplies notification can be retried.", 409);
    }
    const requeued = await client.query<{ status: NotificationStatus }>(
      `UPDATE partner_supplies_order_notifications
          SET status='PENDING', attempt_count=0, next_attempt_at=now(),
              claim_token=NULL, claim_expires_at=NULL, failure_code=NULL, updated_at=now()
        WHERE order_id=$1 AND tenant_id=$2 AND status='FAILED'
        RETURNING status`,
      [input.orderId, order.tenant_id]
    );
    if (requeued.rows.length !== 1) throw new SuppliesError("VALIDATION_ERROR", "The supplies notification is no longer retryable.", 409);
    await client.query(
      `INSERT INTO partner_supplies_order_events
         (tenant_id, order_id, event_type, actor_admin_user_id, actor_admin_email, after_status, detail)
       VALUES ($1,$2,'NOTIFICATION_REQUEUED',$3,$4,$5,$6::jsonb)`,
      [
        order.tenant_id,
        input.orderId,
        input.actorUserId,
        input.actorEmail,
        order.status,
        JSON.stringify({ requestId: input.requestId, priorAttemptCount: Number(order.attempt_count), priorFailureCode: order.notification_failure_code }),
      ]
    );
    await writePartnerAudit(client, {
      tenantId: order.tenant_id,
      actorUserId: input.actorUserId,
      action: "partner_supplies_notification_requeued",
      recordType: "partner_supplies_order",
      recordId: input.orderId,
      before: { notificationStatus: "FAILED", attemptCount: Number(order.attempt_count), failureCode: order.notification_failure_code },
      after: { notificationStatus: "PENDING", attemptCount: 0 },
      correlationId: /^[0-9a-f-]{36}$/i.test(input.requestId) ? input.requestId : null,
    });
    const items = await client.query<SuppliesItemRow>(
      `SELECT product_code, product_label_snapshot, quantity FROM partner_supplies_order_items
        WHERE order_id=$1 AND tenant_id=$2 ORDER BY product_code`,
      [input.orderId, order.tenant_id]
    );
    return mapOrder({ ...order, notification_status: "PENDING" }, items.rows);
  });
}
