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
import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, bigint, primaryKey, unique } from "drizzle-orm/pg-core";
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
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionId] }) }),
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
  (t) => ({ uqTenantEmail: unique().on(t.tenantId, t.email) }),
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
  (t) => ({ uqUserLoc: unique().on(t.userId, t.locationId) }),
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
  (t) => ({ uqUserRole: unique().on(t.userId, t.roleId) }),
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

/** Canonical partner role codes (ADR-007). */
export const PARTNER_ROLE_CODES = [
  "PARTNER_OWNER",
  "PARTNER_MANAGER",
  "MVGS_ASSESSMENT_TECHNICIAN",
  "PARTNER_RECEPTION",
  "PARTNER_FINANCE_VIEWER",
  "PARTNER_TRAINEE",
] as const;
export type PartnerRoleCode = (typeof PARTNER_ROLE_CODES)[number];
