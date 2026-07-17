/**
 * Phase 0.5 — Database migration-safety registry.
 *
 * Single source of truth for:
 *  - MANAGED tables: derived DYNAMICALLY from shared/schema.ts (the Drizzle-managed
 *    allowlist). New schema.ts tables are auto-included; nothing is hardcoded.
 *  - UNMANAGED inventory: every table that exists on a real MintVault database but is
 *    NOT represented in shared/schema.ts, each classified and explained. These are
 *    created by runtime migrate*() boot functions or hand-applied migrations/*.sql.
 *
 * The preflight (scripts/db/preflight-schema.ts) fails closed: any live table that is
 * in NEITHER set is an UNKNOWN and must stop the pipeline — a newly-appeared table is
 * never silently treated as disposable.
 *
 * This module performs NO database writes and NO schema changes. It is pure metadata.
 */
import * as schema from "../../shared/schema";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

/** Tables Drizzle is allowed to manage — derived live from shared/schema.ts. */
export function managedTables(): string[] {
  return Object.values(schema)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableName(t))
    .sort();
}

export type UnmanagedClass =
  | "intentionally_unmanaged" // created by runtime migrate*() or hand-SQL by design; stays out of schema.ts
  | "legacy_active" // older table still read/written; candidate for eventual retirement
  | "pending_schema_adoption" // should be brought into shared/schema.ts later
  | "unknown_investigate"; // presence/ownership unclear; must be investigated before adoption/removal

export interface UnmanagedEntry {
  table: string;
  class: UnmanagedClass;
  reason: string;
}

/**
 * Classified inventory of tables live on MintVault production (2026-07-17 read-only
 * inspection) that are absent from shared/schema.ts and are not vq_* (Vault Quest,
 * managed separately via drizzle-vq.config.ts). Every one of these must NEVER be a
 * drop candidate.
 */
export const UNMANAGED_INVENTORY: readonly UnmanagedEntry[] = [
  // Payments / credits / subscriptions — dropping any of these is a financial incident.
  { table: "member_credits", class: "intentionally_unmanaged", reason: "Vault Club prepaid grading/reholder credits; created by runtime migrateAccountSchema()." },
  { table: "estimate_credits", class: "intentionally_unmanaged", reason: "AI estimate credit balances (email-keyed); runtime-created." },
  { table: "estimate_free_uses", class: "intentionally_unmanaged", reason: "Free AI-estimate usage counter; runtime-created." },
  { table: "reholder_credits", class: "intentionally_unmanaged", reason: "Reholder credit entitlements; runtime-created." },
  { table: "promo_codes", class: "intentionally_unmanaged", reason: "Typed promo codes with uses_count cap; hand-applied migration." },
  { table: "promotions", class: "intentionally_unmanaged", reason: "Auto-promotion config with single-active partial unique; migrations/add-promotions.sql." },
  { table: "stripe_webhook_events", class: "intentionally_unmanaged", reason: "Stripe event idempotency ledger; migratePaymentIdempotencySchema() at boot." },
  { table: "vault_club_subscriptions", class: "intentionally_unmanaged", reason: "Vault Club recurring subscriptions; runtime-created." },
  { table: "vault_club_events", class: "intentionally_unmanaged", reason: "Vault Club Stripe event idempotency; runtime-created." },
  { table: "vault_club_consents", class: "intentionally_unmanaged", reason: "Vault Club consent records; runtime-created." },
  { table: "subscription_reminders", class: "intentionally_unmanaged", reason: "Subscription reminder scheduling; runtime-created." },
  { table: "value_protection_tiers", class: "legacy_active", reason: "Declared-value protection tiers; hand-SQL, still referenced." },

  // Auth / sessions — dropping these logs everyone out / breaks login lockouts.
  { table: "session", class: "intentionally_unmanaged", reason: "connect-pg-simple session store; createTableIfMissing=false, provisioned out-of-band." },
  { table: "sessions", class: "unknown_investigate", reason: "Second session-shaped table coexisting with 'session'; confirm which is live before any action." },
  { table: "pin_attempts", class: "intentionally_unmanaged", reason: "Admin PIN attempt lockout counters; runtime-created." },
  { table: "pin_reset_tokens", class: "intentionally_unmanaged", reason: "Admin PIN reset tokens; runtime-created." },
  { table: "pending_switch_nonces", class: "intentionally_unmanaged", reason: "Account-switch nonces; runtime-created." },

  // Grading / AI operational data.
  { table: "grading_records", class: "legacy_active", reason: "Per-operator grading records; runtime migrate (per-operator schema)." },
  { table: "grading_sessions", class: "legacy_active", reason: "Grading session snapshots; runtime migrate." },
  { table: "ai_accuracy_log", class: "legacy_active", reason: "AI grade-vs-final accuracy log; runtime-created." },
  { table: "ai_grade_corrections", class: "legacy_active", reason: "AI grade correction records; runtime-created." },
  { table: "ai_override_audit", class: "legacy_active", reason: "AI override audit trail; runtime-created." },

  // Catalogue / misc.
  { table: "custom_sets", class: "legacy_active", reason: "Operator-defined custom card sets; runtime-created." },
  { table: "custom_variants", class: "legacy_active", reason: "Operator-defined custom variants; runtime-created." },
  { table: "tcgdex_sets", class: "intentionally_unmanaged", reason: "TCGdex canonical set cache; runtime-created." },
  { table: "set_review_decisions", class: "pending_schema_adoption", reason: "Set-review decision log; candidate for schema.ts adoption." },
  { table: "audit_logs", class: "unknown_investigate", reason: "Plural table coexisting with the managed singular 'audit_log'; confirm which is authoritative." },
  { table: "bot_logs", class: "unknown_investigate", reason: "Bot-detection log; confirm active before adoption/removal." },
  { table: "bot_seen", class: "unknown_investigate", reason: "Bot-seen tracking; confirm active." },
  { table: "bot_settings", class: "unknown_investigate", reason: "Bot-detection settings; confirm active." },
] as const;

/** Vault Quest tables are managed by drizzle-vq.config.ts; matched by prefix, never by this registry. */
export function isVaultQuestTable(table: string): boolean {
  return table.startsWith("vq_");
}

export function inventoriedUnmanaged(): string[] {
  return UNMANAGED_INVENTORY.map((e) => e.table).sort();
}

/**
 * Classify a set of live table names against managed + inventoried-unmanaged.
 * `unknown` = live tables in neither set and not vq_* — these are the fail-closed trigger.
 */
export function classifyLiveTables(liveTables: string[]): {
  managed: string[];
  unmanaged: string[];
  vaultQuest: string[];
  unknown: string[];
} {
  const managedSet = new Set(managedTables());
  const unmanagedSet = new Set(inventoriedUnmanaged());
  const managed: string[] = [];
  const unmanaged: string[] = [];
  const vaultQuest: string[] = [];
  const unknown: string[] = [];
  for (const t of liveTables) {
    if (isVaultQuestTable(t)) vaultQuest.push(t);
    else if (managedSet.has(t)) managed.push(t);
    else if (unmanagedSet.has(t)) unmanaged.push(t);
    else unknown.push(t);
  }
  return { managed, unmanaged, vaultQuest, unknown };
}
