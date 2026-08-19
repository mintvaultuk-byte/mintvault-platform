/**
 * Phase 0.5 — Database migration-safety registry.
 *
 * Single source of truth for what the schema-management surface is allowed to touch:
 *  - MANAGED tables: derived DYNAMICALLY from shared/schema.ts (the Drizzle allowlist).
 *    New schema.ts tables are auto-included; nothing is hardcoded.
 *  - UNMANAGED inventory: every non-managed object that exists on a real MintVault
 *    database (verified by read-only prod inspection 2026-07-17), classified per object
 *    type (tables, views, materialized views, schemas), each with a reason.
 *
 * The preflight (scripts/db/preflight-schema.ts) fails closed: any live object that is in
 * NEITHER the managed set NOR the classified inventory (and is not vq_* / a system object)
 * is an UNKNOWN and must stop the pipeline — a newly-appeared object is never silently
 * treated as disposable.
 *
 * Pure metadata. No database access, no writes.
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
  | "numbered_migration" // owned by immutable numbered SQL migration(s), not runtime DDL
  | "legacy_active" // older object still read/written; candidate for eventual retirement
  | "pending_schema_adoption" // should be brought into shared/schema.ts later
  | "unknown_investigate"; // presence/ownership unclear; must be investigated before adoption/removal

export interface UnmanagedEntry {
  schema: string;
  name: string;
  objectType: "table" | "view" | "materialized_view";
  class: UnmanagedClass;
  purpose: string;
  active: boolean;
  owningSubsystem: string;
  reason: string;
  futureDisposition: string;
  evidenceSource: string;
}

const INSPECTION = "read-only prod inspection 2026-07-17 (information_schema / pg_catalog)";

/**
 * Classified inventory of objects live on MintVault production but absent from
 * shared/schema.ts (and not vq_*, which is managed by drizzle-vq.config.ts). None of
 * these must ever be a drop candidate.
 */
export const UNMANAGED_INVENTORY: readonly UnmanagedEntry[] = [
  // ---- Payments / credits / subscriptions (dropping any = financial incident) ----
  {
    schema: "public",
    name: "member_credits",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "Vault Club prepaid grading/reholder credits",
    active: true,
    owningSubsystem: "vault-club/credits",
    reason: "created by runtime migrateAccountSchema()",
    futureDisposition: "keep runtime-managed or adopt into schema.ts with care",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "estimate_credits",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "AI estimate credit balances (email-keyed)",
    active: true,
    owningSubsystem: "ai-estimate",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "estimate_free_uses",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "free AI-estimate usage counter",
    active: true,
    owningSubsystem: "ai-estimate",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "promo_codes",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "typed promo codes with uses_count cap",
    active: true,
    owningSubsystem: "payments/promotions",
    reason: "hand-applied migration",
    futureDisposition: "candidate for schema.ts adoption",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "promotions",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "auto-promotion config, single-active partial unique",
    active: true,
    owningSubsystem: "payments/promotions",
    reason: "migrations/add-promotions.sql",
    futureDisposition: "candidate for schema.ts adoption",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "stripe_webhook_events",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "Stripe event idempotency ledger",
    active: true,
    owningSubsystem: "payments/stripe",
    reason: "migratePaymentIdempotencySchema() at boot",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "vault_club_subscriptions",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "Vault Club recurring subscriptions",
    active: true,
    owningSubsystem: "vault-club",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "vault_club_events",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "Vault Club Stripe event idempotency",
    active: true,
    owningSubsystem: "vault-club",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "vault_club_consents",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "Vault Club consent records",
    active: true,
    owningSubsystem: "vault-club",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "subscription_reminders",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "subscription reminder scheduling",
    active: true,
    owningSubsystem: "vault-club",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "value_protection_tiers",
    objectType: "table",
    class: "legacy_active",
    purpose: "declared-value protection tiers",
    active: true,
    owningSubsystem: "grading/pricing",
    reason: "hand-SQL, still referenced",
    futureDisposition: "review for schema.ts adoption",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "reholder_credits",
    objectType: "view",
    class: "legacy_active",
    purpose: "reholder credit entitlements (VIEW, not a table)",
    active: true,
    owningSubsystem: "vault-club/credits",
    reason: "database view; not a Drizzle-managed table",
    futureDisposition: "keep as view; document source query",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "public_slab_image_projection",
    objectType: "view",
    class: "numbered_migration",
    purpose: "anonymous slab-image proxy lookup; its view definition enforces the certificate publication boundary",
    active: true,
    owningSubsystem: "partner-network/public",
    reason: "created by historical migration 0064; deliberately outside the Drizzle table model",
    futureDisposition: "preserve; retire only with the anonymous slab-image proxy",
    evidenceSource: "historical migration 0064 and read-only production inspection 2026-08-19",
  },

  // ---- Auth / sessions (dropping = lockout / broken login lockouts) ----
  {
    schema: "public",
    name: "session",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "connect-pg-simple session store",
    active: true,
    owningSubsystem: "auth/session",
    reason: "provisioned out-of-band (createTableIfMissing=false)",
    futureDisposition: "keep out of Drizzle",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "sessions",
    objectType: "table",
    class: "unknown_investigate",
    purpose: "second session-shaped table coexisting with 'session'",
    active: false,
    owningSubsystem: "auth/session (?)",
    reason: "duplicate; authoritative one is 'session'",
    futureDisposition: "investigate; drop only after confirming dead",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "pin_attempts",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "admin PIN attempt lockout counters",
    active: true,
    owningSubsystem: "auth/pin",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "pin_reset_tokens",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "admin PIN reset tokens",
    active: true,
    owningSubsystem: "auth/pin",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "pending_switch_nonces",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "account-switch nonces",
    active: true,
    owningSubsystem: "auth",
    reason: "runtime-created",
    futureDisposition: "keep runtime-managed",
    evidenceSource: INSPECTION,
  },

  // ---- Grading / AI operational data ----
  {
    schema: "public",
    name: "grading_records",
    objectType: "table",
    class: "legacy_active",
    purpose: "per-operator grading records",
    active: true,
    owningSubsystem: "grading",
    reason: "runtime per-operator migrate",
    futureDisposition: "review for schema.ts adoption",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "grading_sessions",
    objectType: "table",
    class: "legacy_active",
    purpose: "grading session snapshots",
    active: true,
    owningSubsystem: "grading",
    reason: "runtime migrate",
    futureDisposition: "review for schema.ts adoption",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "ai_accuracy_log",
    objectType: "table",
    class: "legacy_active",
    purpose: "AI grade-vs-final accuracy log",
    active: true,
    owningSubsystem: "grading/ai",
    reason: "runtime-created",
    futureDisposition: "keep or adopt",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "ai_grade_corrections",
    objectType: "table",
    class: "legacy_active",
    purpose: "AI grade correction records",
    active: true,
    owningSubsystem: "grading/ai",
    reason: "runtime-created",
    futureDisposition: "keep or adopt",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "ai_override_audit",
    objectType: "table",
    class: "legacy_active",
    purpose: "AI override audit trail",
    active: true,
    owningSubsystem: "grading/ai",
    reason: "runtime-created",
    futureDisposition: "keep or adopt",
    evidenceSource: INSPECTION,
  },

  // ---- Project Control durable sync / seed state ----
  // Production retains these migration-owned relations although this canonical line
  // deliberately does not carry their historical 0039/0040 SQL files. They are
  // protected inventory, never Drizzle- or runtime-managed.
  {
    schema: "public",
    name: "pc_sync_runs",
    objectType: "table",
    class: "numbered_migration",
    purpose: "Project Control durable synchronisation-attempt audit ledger",
    active: true,
    owningSubsystem: "project-control/live-evidence",
    reason: "created by historical migration 0039_project_control_live_evidence.sql",
    futureDisposition: "preserve as migration-owned; do not schema-sync or drop",
    evidenceSource: "historical migration 0039 and read-only production inspection 2026-08-19",
  },
  {
    schema: "public",
    name: "pc_sync_leases",
    objectType: "table",
    class: "numbered_migration",
    purpose: "Project Control cross-machine synchronisation lease state",
    active: true,
    owningSubsystem: "project-control/live-evidence",
    reason: "created by historical migration 0039_project_control_live_evidence.sql",
    futureDisposition: "preserve as migration-owned; do not schema-sync or drop",
    evidenceSource: "historical migration 0039 and read-only production inspection 2026-08-19",
  },
  {
    schema: "public",
    name: "pc_sync_checkpoints",
    objectType: "table",
    class: "numbered_migration",
    purpose: "Project Control source synchronisation cursors and ETag checkpoints",
    active: true,
    owningSubsystem: "project-control/live-evidence",
    reason: "created by historical migration 0039_project_control_live_evidence.sql",
    futureDisposition: "preserve as migration-owned; do not schema-sync or drop",
    evidenceSource: "historical migration 0039 and read-only production inspection 2026-08-19",
  },
  {
    schema: "public",
    name: "pc_evidence_snapshots",
    objectType: "table",
    class: "numbered_migration",
    purpose: "Project Control append-only evidence observations",
    active: true,
    owningSubsystem: "project-control/live-evidence",
    reason: "created by historical migration 0039_project_control_live_evidence.sql",
    futureDisposition: "preserve as migration-owned; do not schema-sync or drop",
    evidenceSource: "historical migration 0039 and read-only production inspection 2026-08-19",
  },
  {
    schema: "public",
    name: "pc_seed_state",
    objectType: "table",
    class: "numbered_migration",
    purpose: "Project Control singleton seed-manifest state",
    active: true,
    owningSubsystem: "project-control/seed-reconciliation",
    reason: "created by historical migration 0040_project_control_seed_reconciliation.sql",
    futureDisposition: "preserve as migration-owned; do not schema-sync or drop",
    evidenceSource: "historical migration 0040 and read-only production inspection 2026-08-19",
  },
  {
    schema: "public",
    name: "pc_seed_runs",
    objectType: "table",
    class: "numbered_migration",
    purpose: "Project Control seed-reconciliation run history",
    active: true,
    owningSubsystem: "project-control/seed-reconciliation",
    reason: "created by historical migration 0040_project_control_seed_reconciliation.sql",
    futureDisposition: "preserve as migration-owned; do not schema-sync or drop",
    evidenceSource: "historical migration 0040 and read-only production inspection 2026-08-19",
  },

  // ---- Catalogue / misc ----
  {
    schema: "public",
    name: "custom_sets",
    objectType: "table",
    class: "numbered_migration",
    purpose: "operator-defined custom card sets",
    active: true,
    owningSubsystem: "catalogue",
    reason: "migrations/0024_set_library_base_tables.sql",
    futureDisposition: "keep numbered-migration-managed",
    evidenceSource: "migration 0024 (canonical Set Library base schema)",
  },
  {
    schema: "public",
    name: "custom_variants",
    objectType: "table",
    class: "legacy_active",
    purpose: "operator-defined custom variants",
    active: true,
    owningSubsystem: "catalogue",
    reason: "runtime-created",
    futureDisposition: "review for adoption",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "tcgdex_sets",
    objectType: "table",
    class: "numbered_migration",
    purpose: "TCGdex canonical set catalogue",
    active: true,
    owningSubsystem: "catalogue",
    reason: "migrations/0024_set_library_base_tables.sql",
    futureDisposition: "keep numbered-migration-managed",
    evidenceSource: "migration 0024 (canonical Set Library base schema)",
  },
  {
    schema: "public",
    name: "set_review_decisions",
    objectType: "table",
    class: "numbered_migration",
    purpose: "set-review decision log",
    active: true,
    owningSubsystem: "catalogue",
    reason: "migrations/0023_set_library_schema.sql and migrations/0024_set_library_base_tables.sql",
    futureDisposition: "keep numbered-migration-managed",
    evidenceSource: "migrations 0023/0024 (canonical Set Library schema)",
  },
  {
    schema: "public",
    name: "audit_logs",
    objectType: "table",
    class: "unknown_investigate",
    purpose: "plural table coexisting with managed singular 'audit_log'",
    active: false,
    owningSubsystem: "audit (?)",
    reason: "duplicate of managed audit_log",
    futureDisposition: "investigate; confirm authoritative before any action",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "bot_logs",
    objectType: "table",
    class: "unknown_investigate",
    purpose: "bot-detection log",
    active: false,
    owningSubsystem: "bot-detection (?)",
    reason: "confirm active before adoption/removal",
    futureDisposition: "investigate",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "bot_seen",
    objectType: "table",
    class: "unknown_investigate",
    purpose: "bot-seen tracking",
    active: false,
    owningSubsystem: "bot-detection (?)",
    reason: "confirm active",
    futureDisposition: "investigate",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "bot_settings",
    objectType: "table",
    class: "unknown_investigate",
    purpose: "bot-detection settings",
    active: false,
    owningSubsystem: "bot-detection (?)",
    reason: "confirm active",
    futureDisposition: "investigate",
    evidenceSource: INSPECTION,
  },
  {
    schema: "public",
    name: "population_report",
    objectType: "materialized_view",
    class: "legacy_active",
    purpose: "population report (grade distribution) materialized view",
    active: true,
    owningSubsystem: "reporting",
    reason: "materialized view; not a Drizzle-managed table",
    futureDisposition: "keep; document refresh cadence",
    evidenceSource: INSPECTION,
  },
  // Created by the Phase 0.5 numbered-migration runner itself (scripts/db/migrate.ts). Present on
  // any DB the runner has applied a migration to; intentionally outside shared/schema.ts.
  {
    schema: "public",
    name: "schema_migrations",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "Phase 0.5 numbered-migration journal (filename/checksum/status)",
    active: true,
    owningSubsystem: "db-migration-runner",
    reason: "bootstrapped by scripts/db/migrate.ts, never by schema.ts",
    futureDisposition: "keep runner-managed",
    evidenceSource: "Phase 0.5 runner (scripts/db/migrate.ts)",
  },
  // ---- Legacy TIFF evidence lineage ----
  // These records predate the current certificate_image_evidence ledger. They
  // remain protected as migration-owned historical evidence until retention and
  // any migration path are explicitly reviewed.
  {
    schema: "public",
    name: "certificate_image_masters",
    objectType: "table",
    class: "numbered_migration",
    purpose: "content-addressed TIFF scanner masters",
    active: true,
    owningSubsystem: "scanner/evidence",
    reason: "created by historical migration 0067_certificate_immutable_evidence_ledger.sql",
    futureDisposition: "preserve as historical evidence; do not schema-sync or drop",
    evidenceSource: "historical migration 0067 and read-only production inspection 2026-08-19",
  },
  {
    schema: "public",
    name: "certificate_image_workings",
    objectType: "table",
    class: "numbered_migration",
    purpose: "browser and analysis derivatives linked to TIFF masters",
    active: true,
    owningSubsystem: "scanner/evidence",
    reason: "created by historical migration 0067_certificate_immutable_evidence_ledger.sql",
    futureDisposition: "preserve as historical evidence; do not schema-sync or drop",
    evidenceSource: "historical migration 0067 and read-only production inspection 2026-08-19",
  },
  {
    schema: "public",
    name: "certificate_image_crops",
    objectType: "table",
    class: "numbered_migration",
    purpose: "crop and measurement derivatives linked to working images",
    active: true,
    owningSubsystem: "scanner/evidence",
    reason: "created by historical migration 0067_certificate_immutable_evidence_ledger.sql",
    futureDisposition: "preserve as historical evidence; do not schema-sync or drop",
    evidenceSource: "historical migration 0067 and read-only production inspection 2026-08-19",
  },
  // ---- Distributed Grading Network: signed-station scanner evidence ----------
  //
  // Created by migrations 0046/0047 and LIVE on production since v1069. They were
  // never registered here, so `classifyLiveObjects` filed all three under
  // `unknown` — and unknown is the fail-closed trigger. That is not only a test
  // artefact: runPreflight() is a production tool, so preflight against the real
  // database reports them too. Registering them is the fix for both.
  //
  // They are deliberately NOT named `partner_*`: isPartnerNetworkName() would then
  // sweep them into the Partner Network bucket, which they are not — they are
  // scanner/station evidence owned by the capture pipeline, not by the Partner
  // Portal's tenant model.
  {
    schema: "public",
    name: "scanner_processing_jobs",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "durable derivative-processing queue for Canon LiDE captures",
    active: true,
    owningSubsystem: "scanner-station",
    reason: "migration-authoritative raw SQL (0046); deliberately not in shared/schema.ts",
    futureDisposition: "keep migration-managed",
    evidenceSource: "migrations/0046_scanner_processing_jobs.sql",
  },
  {
    schema: "public",
    name: "scanner_capture_sessions",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "target-bound capture sessions (arming, FRONT-before-BACK, expiry)",
    active: true,
    owningSubsystem: "scanner-station",
    reason: "migration-authoritative raw SQL (0045/0047); deliberately not in shared/schema.ts",
    futureDisposition: "keep migration-managed",
    evidenceSource: "migrations/0047_scanner_evidence_staging.sql",
  },
  {
    schema: "public",
    name: "scanner_evidence_staging",
    objectType: "table",
    class: "intentionally_unmanaged",
    purpose: "server-owned opaque staging for immutable TIFF masters before finalisation",
    active: true,
    owningSubsystem: "scanner-station",
    reason: "migration-authoritative raw SQL (0047); deliberately not in shared/schema.ts",
    futureDisposition: "keep migration-managed",
    evidenceSource: "migrations/0047_scanner_evidence_staging.sql",
  },
] as const;

/** Non-public schemas known and expected. Any other schema is an unknown that must fail preflight. */
export const KNOWN_SCHEMAS: readonly { name: string; reason: string }[] = [
  { name: "public", reason: "application schema" },
  { name: "drizzle", reason: "Drizzle migration metadata schema" },
  { name: "stripe", reason: "Stripe integration schema (verified on prod)" },
] as const;

/**
 * Orphan sequences (not owned by a table column) that are known and expected. Sequences
 * OWNED by a column follow their table and are never flagged; only orphans are checked.
 */
export const KNOWN_ORPHAN_SEQUENCES: readonly string[] = [
  "ai_predictions_id_seq",
  // Trusted Intake Connector G3 — connector-scoped destination-reference allocator (migration
  // 0010_partner_connector_import.sql). Deliberately a free-standing sequence, not owned by any
  // column (see connector-reference.ts) — used only via nextval(), never as a column DEFAULT.
  "partner_connector_submission_ref_seq",
];

export function isVaultQuestName(name: string): boolean {
  return name.startsWith("vq_");
}

/** Partner Network tables are managed by drizzle-partner.config.ts + migrations/0001+; not unknown. */
export function isPartnerNetworkName(name: string): boolean {
  return name.startsWith("partner_") || name === "field_welders";
}

export function inventoriedTables(): string[] {
  return UNMANAGED_INVENTORY.filter((e) => e.objectType === "table")
    .map((e) => e.name)
    .sort();
}
export function inventoriedViews(): string[] {
  return UNMANAGED_INVENTORY.filter((e) => e.objectType === "view")
    .map((e) => e.name)
    .sort();
}
export function inventoriedMatviews(): string[] {
  return UNMANAGED_INVENTORY.filter((e) => e.objectType === "materialized_view")
    .map((e) => e.name)
    .sort();
}

export interface NonPublicObject {
  schema: string;
  name: string;
  kind: string; // 'table' | 'view' | 'materialized_view'
}

export interface LiveObjects {
  tables: string[]; // public schema
  views: string[]; // public schema
  matviews: string[]; // public schema
  schemas: string[]; // all non-system schemas
  orphanSequences: string[]; // public schema
  enums: string[]; // public schema
  nonPublicObjects?: NonPublicObject[]; // objects in non-public, non-system schemas
}

export interface Classification {
  managed: string[];
  unmanaged: string[];
  vaultQuest: string[];
  partnerNetwork: string[]; // partner_* / field_welders — managed by drizzle-partner.config + migrations
  integrationOwned: { schema: string; name: string; kind: string }[]; // in a known non-public schema
  unknown: { objectType: string; name: string }[];
}

/** Classify a full object set. `unknown` (anything unaccounted-for) is the fail-closed trigger. */
export function classifyLiveObjects(objs: LiveObjects): Classification {
  const managedSet = new Set(managedTables());
  const invTables = new Set(inventoriedTables());
  const invViews = new Set(inventoriedViews());
  const invMatviews = new Set(inventoriedMatviews());
  const knownSchemas = new Set(KNOWN_SCHEMAS.map((s) => s.name));
  const knownOrphanSeq = new Set(KNOWN_ORPHAN_SEQUENCES);

  const result: Classification = {
    managed: [],
    unmanaged: [],
    vaultQuest: [],
    partnerNetwork: [],
    integrationOwned: [],
    unknown: [],
  };

  for (const t of objs.tables) {
    if (isVaultQuestName(t)) result.vaultQuest.push(t);
    else if (isPartnerNetworkName(t)) result.partnerNetwork.push(t);
    else if (managedSet.has(t)) result.managed.push(t);
    else if (invTables.has(t)) result.unmanaged.push(t);
    else result.unknown.push({ objectType: "table", name: t });
  }
  for (const v of objs.views) {
    if (isVaultQuestName(v)) result.vaultQuest.push(v);
    else if (isPartnerNetworkName(v)) result.partnerNetwork.push(v);
    else if (invViews.has(v)) result.unmanaged.push(v);
    else result.unknown.push({ objectType: "view", name: v });
  }
  for (const m of objs.matviews) {
    if (isVaultQuestName(m)) result.vaultQuest.push(m);
    else if (isPartnerNetworkName(m)) result.partnerNetwork.push(m);
    else if (invMatviews.has(m)) result.unmanaged.push(m);
    else result.unknown.push({ objectType: "materialized_view", name: m });
  }
  for (const s of objs.schemas) {
    if (!knownSchemas.has(s)) result.unknown.push({ objectType: "schema", name: s });
  }
  for (const seq of objs.orphanSequences) {
    if (!knownOrphanSeq.has(seq)) result.unknown.push({ objectType: "orphan_sequence", name: seq });
  }
  // Any enum is unknown: shared/schema.ts materialises no pg enums (verified none on prod).
  for (const e of objs.enums) {
    result.unknown.push({ objectType: "enum", name: e });
  }
  // Objects in non-public schemas: if the schema is a known integration schema, the object
  // is integration-owned (reported, never a drop candidate — Drizzle push is public-scoped).
  // If the schema is unknown, the schema itself is already flagged unknown above; the object
  // is additionally surfaced so it is never silent.
  for (const o of objs.nonPublicObjects ?? []) {
    if (knownSchemas.has(o.schema) && o.schema !== "public") {
      result.integrationOwned.push(o);
    } else if (!knownSchemas.has(o.schema)) {
      result.unknown.push({ objectType: `${o.kind}@${o.schema}`, name: `${o.schema}.${o.name}` });
    }
  }
  return result;
}

/** Back-compat helper used by table-only callers/tests. */
export function classifyLiveTables(tables: string[]): {
  managed: string[];
  unmanaged: string[];
  vaultQuest: string[];
  unknown: string[];
} {
  const c = classifyLiveObjects({ tables, views: [], matviews: [], schemas: [], orphanSequences: [], enums: [] });
  return {
    managed: c.managed,
    unmanaged: c.unmanaged,
    vaultQuest: c.vaultQuest,
    unknown: c.unknown.map((u) => u.name),
  };
}

export function inventoriedUnmanaged(): string[] {
  return UNMANAGED_INVENTORY.map((e) => e.name).sort();
}
