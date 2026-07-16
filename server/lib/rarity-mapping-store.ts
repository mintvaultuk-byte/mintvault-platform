/**
 * Data access for the legacy rarity/variant review queue + the admin's picker
 * preferences (favourites / recently-used).
 *
 * READ side is over `certificates.variant` (distinct values + counts + a few
 * example cert numbers — cert numbers are public identifiers, never PII).
 * WRITE side only ever touches `rarity_mapping_reviews` (a mapping-rule row) and
 * the `pipeline_settings` KV — it NEVER rewrites a certificate. Approving a
 * mapping here records the rule as approved; it does not backfill any card.
 */
import { and, desc, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { certificates, rarityMappingReviews, type RarityMappingReview } from "@shared/schema";

export interface VariantCount {
  variant: string;
  count: number;
  exampleCertIds: string[];
}

/** Distinct legacy `variant` values with record counts + up to 3 example cert
 *  numbers each. Excludes NULL/empty/soft-deleted rows. Read-only. */
export async function getVariantCounts(): Promise<VariantCount[]> {
  const rows = await db
    .select({
      variant: certificates.variant,
      count: sql<number>`cast(count(*) as int)`,
      examples: sql<string[]>`(array_agg(${certificates.certId} order by ${certificates.id}))[1:3]`,
    })
    .from(certificates)
    .where(and(isNotNull(certificates.variant), ne(certificates.variant, ""), isNull(certificates.deletedAt)))
    .groupBy(certificates.variant)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({
    variant: r.variant as string,
    count: Number(r.count),
    exampleCertIds: Array.isArray(r.examples) ? (r.examples.filter(Boolean) as string[]) : [],
  }));
}

/** All saved mapping-review rows (empty if the table is absent — migration not
 *  yet applied on this DB). Never throws to the caller. */
export async function listRarityMappingReviews(): Promise<RarityMappingReview[]> {
  try {
    return await db.select().from(rarityMappingReviews).orderBy(desc(rarityMappingReviews.recordCount));
  } catch {
    return [];
  }
}

export interface ReviewDecisionInput {
  legacyValue: string;
  status: "pending" | "approved" | "rejected" | "ignored";
  proposedClassification?: string | null;
  proposedValue?: string | null;
  confidence?: string | null;
  reason?: string | null;
  recordCount?: number;
  reviewRequired?: boolean;
  reviewedBy?: string | null;
}

/**
 * Upsert one mapping-rule decision keyed by the legacy value (unique). This
 * writes ONLY the review row — no certificate is read or modified. Returns the
 * stored row.
 */
export async function upsertRarityMappingReviewDecision(input: ReviewDecisionInput): Promise<RarityMappingReview> {
  const now = new Date();
  const [row] = await db
    .insert(rarityMappingReviews)
    .values({
      legacyValue: input.legacyValue,
      proposedClassification: input.proposedClassification ?? null,
      proposedValue: input.proposedValue ?? null,
      confidence: input.confidence ?? null,
      reason: input.reason ?? null,
      recordCount: input.recordCount ?? 0,
      reviewRequired: input.reviewRequired ?? true,
      status: input.status,
      reviewedBy: input.reviewedBy ?? null,
      reviewedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rarityMappingReviews.legacyValue,
      set: {
        proposedClassification: input.proposedClassification ?? null,
        proposedValue: input.proposedValue ?? null,
        confidence: input.confidence ?? null,
        reason: input.reason ?? null,
        status: input.status,
        reviewedBy: input.reviewedBy ?? null,
        reviewedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

// ── Per-admin picker preferences (favourites / recently-used) ─────────────────
// Reuses the existing pipeline_settings KV store, keyed per admin so it stays
// per-user if more admins are ever added. Bounded sizes; values are opaque
// catalogue codes, never customer data.
const PREF_PREFIX = "rarity_prefs:";
const MAX_FAVOURITES = 64;
const MAX_RECENT = 8;

export interface RarityPreferences {
  favourites: string[];
  recent: string[];
}

const MAX_PREF_ENTRY_LEN = 64; // catalogue codes are well under this — reject blobs

function sanitiseList(list: unknown, max: number): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    // Cap each entry length so an admin can't stash a large blob in the pref row.
    const s = (typeof v === "string" ? v.trim() : "").slice(0, MAX_PREF_ENTRY_LEN);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export async function getRarityPreferences(adminKey: string): Promise<RarityPreferences> {
  try {
    const r = await db.execute(sql`SELECT value FROM pipeline_settings WHERE key = ${PREF_PREFIX + adminKey} LIMIT 1`);
    const row = r.rows[0] as { value: unknown } | undefined;
    const v = (row?.value ?? {}) as { favourites?: unknown; recent?: unknown };
    return { favourites: sanitiseList(v.favourites, MAX_FAVOURITES), recent: sanitiseList(v.recent, MAX_RECENT) };
  } catch {
    return { favourites: [], recent: [] };
  }
}

export async function setRarityPreferences(
  adminKey: string,
  prefs: RarityPreferences,
  updatedBy?: string,
): Promise<RarityPreferences> {
  const clean: RarityPreferences = {
    favourites: sanitiseList(prefs.favourites, MAX_FAVOURITES),
    recent: sanitiseList(prefs.recent, MAX_RECENT),
  };
  await db.execute(sql`
    INSERT INTO pipeline_settings (key, value, updated_at, updated_by)
    VALUES (${PREF_PREFIX + adminKey}, ${JSON.stringify(clean)}::jsonb, NOW(), ${updatedBy ?? null})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
  `);
  return clean;
}
