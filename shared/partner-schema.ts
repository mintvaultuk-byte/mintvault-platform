/**
 * Partner Network — Drizzle schema (Phase 1 foundation).
 *
 * Types + query surface for the partner_* family. The AUTHORITATIVE DDL is the numbered
 * migration `migrations/0001_partner_foundation.sql` (applied via the Phase 0.5 runner). This
 * file mirrors it for typed access; `tests/partner-schema-parity.test.ts` asserts the two agree
 * on table + column names so they cannot silently drift.
 *
 * Isolation: these are all tenant-scoped (tenant_id) except the global reference tables
 * (partner_roles/permissions/role_permissions). RLS is enforced in the DB (see the migration);
 * the app additionally sets app.tenant_id per transaction and never trusts a browser-supplied id.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigint,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- global reference tables ---
export const partnerRoles = pgTable("partner_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerPermissions = pgTable("partner_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerRolePermissions = pgTable(
  "partner_role_permissions",
  {
    roleId: uuid("role_id").notNull(),
    permissionId: uuid("permission_id").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionId] }) })
);

// --- tenant-scoped tables ---
export const partnerOrganisations = pgTable("partner_organisations", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicRef: text("public_ref").notNull().unique(),
  legalName: text("legal_name").notNull(),
  status: text("status").notNull().default("PENDING"),
  accreditationLevel: text("accreditation_level").notNull().default("PROVISIONAL_PARTNER"),
  health: text("health").notNull().default("NEEDS_ATTENTION"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // tenant_id is GENERATED ALWAYS AS (id) STORED in the DB. Marked generated here so Drizzle
  // excludes it from inserts (a typed insert including tenantId would otherwise 500 at runtime).
  tenantId: uuid("tenant_id").generatedAlwaysAs(sql`id`),
});

export const partnerLocations = pgTable("partner_locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicRef: text("public_ref").notNull().unique(),
  tenantId: uuid("tenant_id").notNull(),
  partnerId: uuid("partner_id").notNull(),
  name: text("name").notNull(),
  address: text("address"),
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerUsers = pgTable(
  "partner_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicRef: text("public_ref").notNull().unique(),
    tenantId: uuid("tenant_id").notNull(),
    partnerId: uuid("partner_id").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    status: text("status").notNull().default("ACTIVE"),
    credentialVersion: integer("credential_version").notNull().default(1),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uqTenantEmail: unique().on(t.tenantId, t.email) })
);

export const partnerUserLocations = pgTable(
  "partner_user_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    locationId: uuid("location_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uqUserLoc: unique().on(t.userId, t.locationId) })
);

export const partnerUserRoles = pgTable(
  "partner_user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    roleId: uuid("role_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uqUserRole: unique().on(t.userId, t.roleId) })
);

export const partnerSessions = pgTable("partner_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  locationId: uuid("location_id"),
  tokenHash: text("token_hash").notNull().unique(),
  credentialVersion: integer("credential_version").notNull(),
  mfaPassed: boolean("mfa_passed").notNull().default(false),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const partnerMfaMethods = pgTable("partner_mfa_methods", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  method: text("method").notNull(),
  secretRef: text("secret_ref"),
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerFeatureFlags = pgTable("partner_feature_flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id"),
  locationId: uuid("location_id"),
  flag: text("flag").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerAuditEvents = pgTable("partner_audit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id").notNull(),
  locationId: uuid("location_id"),
  actorUserId: uuid("actor_user_id"),
  deviceId: uuid("device_id"),
  action: text("action").notNull(),
  recordType: text("record_type"),
  recordId: text("record_id"),
  beforeValue: jsonb("before_value"),
  afterValue: jsonb("after_value"),
  ip: text("ip"),
  sessionId: uuid("session_id"),
  reason: text("reason"),
  correlationId: uuid("correlation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerSecurityEvents = pgTable("partner_security_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id").notNull(),
  severity: text("severity").notNull(),
  kind: text("kind").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerEmergencyControls = pgTable("partner_emergency_controls", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  locationId: uuid("location_id"),
  scope: text("scope").notNull(),
  frozen: boolean("frozen").notNull().default(false),
  reason: text("reason"),
  setBy: text("set_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Partner supplies orders are an operational fulfilment request, never a payment/order checkout.
 * The numbered migration 0102 owns constraints, RLS, composite tenant FKs and lifecycle triggers;
 * these definitions mirror the typed column contract so application code cannot drift from DDL.
 */
export const partnerSuppliesOrders = pgTable(
  "partner_supplies_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicRef: text("public_ref").notNull().unique(),
    tenantId: uuid("tenant_id").notNull(),
    partnerId: uuid("partner_id").notNull(),
    locationId: uuid("location_id").notNull(),
    requestingUserId: uuid("requesting_user_id").notNull(),
    partnerNameSnapshot: text("partner_name_snapshot").notNull(),
    shopNameSnapshot: text("shop_name_snapshot").notNull(),
    contactNameSnapshot: text("contact_name_snapshot").notNull(),
    contactEmailSnapshot: text("contact_email_snapshot").notNull(),
    contactPhoneSnapshot: text("contact_phone_snapshot"),
    deliveryAddressSnapshot: text("delivery_address_snapshot").notNull(),
    deliveryPostcodeSnapshot: text("delivery_postcode_snapshot").notNull(),
    deliveryCountrySnapshot: text("delivery_country_snapshot").notNull().default("GB"),
    notes: text("notes"),
    status: text("status").notNull().default("RECEIVED"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uqTenantIdempotency: unique().on(t.tenantId, t.idempotencyKey), uqIdentity: unique().on(t.id, t.tenantId) })
);

export const partnerSuppliesOrderItems = pgTable(
  "partner_supplies_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id").notNull(),
    productCode: text("product_code").notNull(),
    productLabelSnapshot: text("product_label_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uqOrderProduct: unique().on(t.orderId, t.productCode) })
);

export const partnerSuppliesOrderEvents = pgTable("partner_supplies_order_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id").notNull(),
  orderId: uuid("order_id").notNull(),
  eventType: text("event_type").notNull(),
  actorPartnerUserId: uuid("actor_partner_user_id"),
  actorAdminUserId: uuid("actor_admin_user_id"),
  actorAdminEmail: text("actor_admin_email"),
  beforeStatus: text("before_status"),
  afterStatus: text("after_status"),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerSuppliesOrderNotifications = pgTable(
  "partner_supplies_order_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id").notNull(),
    providerIdempotencyKey: text("provider_idempotency_key").notNull().unique(),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    uncertainDeliveryAt: timestamp("uncertain_delivery_at", { withTimezone: true }),
    // NULL means terminally sent or retry budget exhausted; only a real due timestamp is claimable.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uqOrderTenant: unique().on(t.orderId, t.tenantId) })
);

/** Canonical partner role codes (ADR-007). */
export const PARTNER_ROLE_CODES = [
  "PARTNER_OWNER",
  "PARTNER_MANAGER",
  "MVGS_ASSESSMENT_TECHNICIAN",
  "PARTNER_RECEPTION",
  "PARTNER_FINANCE_VIEWER",
  "PARTNER_TRAINEE",
  // AG-2: the least-privilege shop-floor role. Operates an APPROVED station and nothing else —
  // no grading, no credits, no staff, no station enrolment. Seeded by migration 0085.
  "SCANNER_OPERATOR",
] as const;
export type PartnerRoleCode = (typeof PARTNER_ROLE_CODES)[number];
