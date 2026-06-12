/**
 * Promotions engine — one active promotion at a time.
 *
 * Activation creates a Stripe coupon per discounted tier (percent_off,
 * duration "once") and stores the coupon IDs on the row. Stripe failure
 * rolls the DB write back — a promo is never persisted active with missing
 * coupon IDs. Deactivation keeps the coupons (already-issued usage is fine).
 *
 * NOTE on application: the grading submission flow charges via Stripe
 * PaymentIntents (server-computed amount), where coupons cannot attach.
 * The active promo's percentages are therefore applied server-side in
 * /api/create-payment-intent (competing with Vault Club / bulk via max(),
 * never stacking) and recorded in the intent metadata. The coupons exist
 * as the canonical Stripe-side record of the promotion and for any future
 * Checkout-Session flows.
 *
 * Tier key → grading tier_id mapping:
 *   vault_queue → "standard", standard → "priority",
 *   express → "express", black_label → "gold".
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { getUncachableStripeClient } from "../stripeClient";
import type { PromotionInput, PromotionRecord } from "@shared/schema";

const TIER_KEYS = ["vault_queue", "standard", "express", "black_label"] as const;
type TierKey = (typeof TIER_KEYS)[number];

const TIER_DISPLAY_NAME: Record<TierKey, string> = {
  vault_queue: "Vault Queue",
  standard: "Standard",
  express: "Express",
  black_label: "Black Label",
};

/** Promo tier key → grading service tier_id (as used by checkout). */
export const PROMO_TIER_TO_TIER_ID: Record<TierKey, string> = {
  vault_queue: "standard",
  standard: "priority",
  express: "express",
  black_label: "gold",
};

function rowToRecord(row: any): PromotionRecord {
  return {
    id: Number(row.id),
    name: row.name,
    bannerText: row.banner_text,
    vaultQueuePct: Number(row.vault_queue_pct),
    standardPct: Number(row.standard_pct),
    expressPct: Number(row.express_pct),
    blackLabelPct: Number(row.black_label_pct),
    vaultQueueCouponId: row.vault_queue_coupon_id ?? null,
    standardCouponId: row.standard_coupon_id ?? null,
    expressCouponId: row.express_coupon_id ?? null,
    blackLabelCouponId: row.black_label_coupon_id ?? null,
    active: !!row.active,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export async function getActivePromotion(): Promise<PromotionRecord | null> {
  const rows = (await db.execute(sql`SELECT * FROM promotions WHERE active = true ORDER BY updated_at DESC LIMIT 1`))
    .rows;
  if (!rows.length) return null;
  const promo = rowToRecord(rows[0]);
  // Expired promos are treated as inactive even before the sweep/manual
  // deactivation runs — never apply an expired discount.
  if (promo.expiresAt && promo.expiresAt < new Date()) return null;
  return promo;
}

export async function listPromotions(limit = 20): Promise<PromotionRecord[]> {
  const rows = (await db.execute(sql`SELECT * FROM promotions ORDER BY created_at DESC LIMIT ${limit}`)).rows;
  return rows.map(rowToRecord);
}

function validateInput(data: PromotionInput): string | null {
  if (!data.name?.trim() || data.name.length > 100) return "Name is required (max 100 chars)";
  if (!data.banner_text?.trim() || data.banner_text.length > 200) return "Banner text is required (max 200 chars)";
  for (const key of TIER_KEYS) {
    const pct = data[`${key}_pct` as const];
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return `${TIER_DISPLAY_NAME[key]} discount must be 0-100`;
  }
  if (data.expires_at && isNaN(Date.parse(data.expires_at))) return "Invalid expiry date";
  return null;
}

/**
 * Create or update a promotion. When activating: deactivates any currently
 * active promo (audited), creates Stripe coupons for every tier with pct > 0,
 * then flips active. Stripe failure rolls back the row (delete on create,
 * restore-inactive on update).
 */
export async function savePromotion(
  data: PromotionInput,
  adminUser: string,
  id?: number
): Promise<{ promo?: PromotionRecord; error?: string }> {
  const invalid = validateInput(data);
  if (invalid) return { error: invalid };

  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;

  // 1. Upsert the row (inactive first — activation is the gated step below)
  let promoId: number;
  let isNewRow = false;
  if (id != null) {
    const updated = (
      await db.execute(sql`
        UPDATE promotions SET
          name = ${data.name.trim()},
          banner_text = ${data.banner_text.trim()},
          vault_queue_pct = ${data.vault_queue_pct},
          standard_pct = ${data.standard_pct},
          express_pct = ${data.express_pct},
          black_label_pct = ${data.black_label_pct},
          expires_at = ${expiresAt},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING id
      `)
    ).rows;
    if (!updated.length) return { error: "Promotion not found" };
    promoId = id;
  } else {
    const inserted = (
      await db.execute(sql`
        INSERT INTO promotions (name, banner_text, vault_queue_pct, standard_pct, express_pct, black_label_pct, expires_at, active)
        VALUES (${data.name.trim()}, ${data.banner_text.trim()}, ${data.vault_queue_pct}, ${data.standard_pct}, ${data.express_pct}, ${data.black_label_pct}, ${expiresAt}, false)
        RETURNING id
      `)
    ).rows;
    promoId = Number((inserted[0] as any).id);
    isNewRow = true;
  }

  if (!data.active) {
    // Saving as draft also deactivates this promo if it was previously active
    await db.execute(sql`UPDATE promotions SET active = false, updated_at = NOW() WHERE id = ${promoId}`);
    const rows = (await db.execute(sql`SELECT * FROM promotions WHERE id = ${promoId}`)).rows;
    return { promo: rowToRecord(rows[0]) };
  }

  // 2. Activation path — deactivate any other active promo first (audited)
  const currentActive = (
    await db.execute(sql`SELECT id, name FROM promotions WHERE active = true AND id != ${promoId}`)
  ).rows as any[];
  for (const row of currentActive) {
    await db.execute(sql`UPDATE promotions SET active = false, updated_at = NOW() WHERE id = ${row.id}`);
    await storage.writeAuditLog("promotion", String(row.id), "PROMO_DEACTIVATED", adminUser, {
      reason: "replaced_by_new_activation",
      replaced_by: promoId,
      name: row.name,
    });
  }

  // 3. Create Stripe coupons for every tier with pct > 0. Any failure rolls
  //    the row back so we never persist an active promo with missing coupons.
  const couponIds: Partial<Record<TierKey, string>> = {};
  try {
    const stripe = await getUncachableStripeClient();
    for (const key of TIER_KEYS) {
      const pct = data[`${key}_pct` as const];
      if (pct > 0) {
        const coupon = await stripe.coupons.create({
          percent_off: pct,
          duration: "once",
          name: `${data.name.trim()} - ${TIER_DISPLAY_NAME[key]}`,
          metadata: { mintvault_promo_id: String(promoId), tier: key },
        });
        couponIds[key] = coupon.id;
      }
    }
  } catch (err: any) {
    // Rollback: delete a freshly created row, or leave an existing row inactive
    if (isNewRow) {
      await db.execute(sql`DELETE FROM promotions WHERE id = ${promoId}`).catch(() => {});
    } else {
      await db
        .execute(sql`UPDATE promotions SET active = false, updated_at = NOW() WHERE id = ${promoId}`)
        .catch(() => {});
    }
    console.error(`[promotions] Stripe coupon creation failed for promo ${promoId}: ${err?.message || err}`);
    return { error: `Stripe coupon creation failed: ${err?.message || "unknown error"}. Promotion was not activated.` };
  }

  // 4. Persist coupon IDs + activate
  await db.execute(sql`
    UPDATE promotions SET
      vault_queue_coupon_id = ${couponIds.vault_queue ?? null},
      standard_coupon_id = ${couponIds.standard ?? null},
      express_coupon_id = ${couponIds.express ?? null},
      black_label_coupon_id = ${couponIds.black_label ?? null},
      active = true,
      updated_at = NOW()
    WHERE id = ${promoId}
  `);

  const rows = (await db.execute(sql`SELECT * FROM promotions WHERE id = ${promoId}`)).rows;
  const promo = rowToRecord(rows[0]);

  await storage.writeAuditLog("promotion", String(promoId), "PROMO_ACTIVATED", adminUser, {
    name: promo.name,
    banner_text: promo.bannerText,
    tiers: {
      vault_queue: promo.vaultQueuePct,
      standard: promo.standardPct,
      express: promo.expressPct,
      black_label: promo.blackLabelPct,
    },
    coupon_ids: couponIds,
    expires_at: promo.expiresAt?.toISOString() ?? null,
  });

  return { promo };
}

export async function deactivatePromotion(id: number, adminUser: string): Promise<{ ok: boolean; error?: string }> {
  const rows = (await db.execute(sql`SELECT id, name, active FROM promotions WHERE id = ${id}`)).rows as any[];
  if (!rows.length) return { ok: false, error: "Promotion not found" };

  await db.execute(sql`UPDATE promotions SET active = false, updated_at = NOW() WHERE id = ${id}`);
  // Stripe coupons intentionally NOT deleted — duration "once", already-issued is fine.
  await storage.writeAuditLog("promotion", String(id), "PROMO_DEACTIVATED", adminUser, {
    name: rows[0].name,
    was_active: !!rows[0].active,
  });
  return { ok: true };
}
