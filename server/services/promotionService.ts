/**
 * promotionService.ts — promotions engine data layer + Stripe coupon orchestration.
 *
 * One active promotion at a time (DB-enforced by the partial unique index
 * `one_active_promotion` on promotions(active) WHERE active = true).
 *
 * Tier keys mirror the code's real grading checkout tier ids
 * (shared/schema.ts pricingTiers): standard (= "Vault Queue"),
 * priority (= "Standard"), express. "Black Label" is a post-grading label
 * type, not a checkout tier, so it has no promo column. The Stripe coupon's
 * metadata.tier carries the code key so prompt 2's checkout can match it.
 *
 * All activation work runs in ONE DB transaction. If any Stripe coupon create
 * throws, the transaction rolls back so no promo row is ever persisted with
 * partial/null coupon ids — and the ids of any coupons created before the
 * failure are logged so they can be reconciled (Stripe has no transaction).
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { auditLog } from "@shared/schema";
import { getUncachableStripeClient } from "../stripeClient";

// Ordered tier map — column keys mirror the real pricingTiers ids.
const PROMO_TIERS = [
  { key: "standard", label: "Vault Queue", pctCol: "standard_pct", couponCol: "standard_coupon_id" },
  { key: "priority", label: "Standard", pctCol: "priority_pct", couponCol: "priority_coupon_id" },
  { key: "express", label: "Express", pctCol: "express_pct", couponCol: "express_coupon_id" },
] as const;

export type TierKey = (typeof PROMO_TIERS)[number]["key"];

/** How the promo combines with vault-club / bulk discounts at the grading
 *  checkout. Per-promo setting; defaults to best_of (the locked non-stacking
 *  rule). See server/routes/submissions.ts for the resolver. */
export type StackingMode = "best_of" | "stack_on_top";

export interface PromotionInput {
  id?: number; // present when editing (PUT)
  name: string;
  banner_text: string;
  standard_pct: number;
  priority_pct: number;
  express_pct: number;
  stacking_mode: StackingMode;
  expires_at?: string | null;
  active: boolean;
}

export interface Promotion {
  id: number;
  name: string;
  banner_text: string;
  standard_pct: number;
  priority_pct: number;
  express_pct: number;
  standard_coupon_id: string | null;
  priority_coupon_id: string | null;
  express_coupon_id: string | null;
  stacking_mode: StackingMode;
  active: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

type CouponIds = Record<TierKey, string | null>;

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(`[promotions] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
}

/**
 * Idempotent boot migration — ensures the promotions table, its single-active
 * partial unique index, and the stacking_mode column exist. Mirrors
 * migrations/add-promotions.sql exactly so prod gets the same schema staging
 * was verified on. Safe to run on every boot (all IF NOT EXISTS). Called from
 * registerRoutes() alongside the other startup migrations.
 */
export async function migratePromotionsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      banner_text VARCHAR(200) NOT NULL,
      standard_pct INTEGER NOT NULL DEFAULT 0 CHECK (standard_pct BETWEEN 0 AND 100),
      priority_pct INTEGER NOT NULL DEFAULT 0 CHECK (priority_pct BETWEEN 0 AND 100),
      express_pct  INTEGER NOT NULL DEFAULT 0 CHECK (express_pct  BETWEEN 0 AND 100),
      standard_coupon_id VARCHAR(100),
      priority_coupon_id VARCHAR(100),
      express_coupon_id  VARCHAR(100),
      active BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_promotion
      ON promotions ((active)) WHERE active = true
  `);
  await db.execute(sql`
    ALTER TABLE promotions
      ADD COLUMN IF NOT EXISTS stacking_mode VARCHAR(20) NOT NULL DEFAULT 'best_of'
      CHECK (stacking_mode IN ('best_of', 'stack_on_top'))
  `);
  // Soft-delete marker. A deleted promo is set active=false too, so it never
  // conflicts with the active=true partial unique index. All reads filter it out.
  await db.execute(sql`
    ALTER TABLE promotions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
  `);

  // ── Promo codes (customer-entered discount codes; private, multiple at once) ──
  // Distinct from the singleton auto-promo. A code's % is a best_of arm (never
  // stacks). code is stored UPPERCASE+trimmed; the unique index is partial on
  // deleted_at IS NULL so a soft-deleted code's string can be reused.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(64) NOT NULL,
      label VARCHAR(200),
      percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 100),
      max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 1),
      uses_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_unique
      ON promo_codes (code) WHERE deleted_at IS NULL
  `);

  console.log("[promotions-migrate] promotions table + index + stacking_mode + deleted_at + promo_codes ensured");
}

/** The single active promotion, or null. Expiry is enforced at READ time: a
 *  promo whose expires_at has passed is treated as not active everywhere this
 *  helper is consumed (live grading checkout, public pricing banner, admin
 *  "active" read), so an admin-set expiry actually stops the discount without
 *  needing a sweeper. (active stays true in the row until a manual deactivate,
 *  which keeps the singleton index honest — see deactivatePromotion.) */
export async function getActivePromotion(): Promise<Promotion | null> {
  const res = await db.execute(
    sql`SELECT * FROM promotions WHERE active = true AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`
  );
  return (res.rows[0] as unknown as Promotion) ?? null;
}

/** All non-deleted promotions, newest first (admin list). */
export async function listPromotions(): Promise<Promotion[]> {
  const res = await db.execute(
    sql`SELECT * FROM promotions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`
  );
  return res.rows as unknown as Promotion[];
}

/**
 * Create (POST) or edit (PUT, when data.id is set) a promotion. When
 * data.active === true, Stripe coupons are minted for each tier with pct > 0
 * and the previous active promo (if any) is deactivated — all atomically.
 */
export async function savePromotion(data: PromotionInput, adminUser: string): Promise<Promotion> {
  const expiresAt = data.expires_at && data.expires_at.trim().length > 0 ? data.expires_at : null;

  if (!data.active) {
    // Inactive: plain insert/update, no Stripe, no coupons.
    const couponIds: CouponIds = { standard: null, priority: null, express: null };
    return await db.transaction(async (tx) => {
      const row = await upsertRow(tx, data, couponIds, false, expiresAt);
      log("saved inactive promo", { id: row.id, name: data.name });
      return row;
    });
  }

  // Active path — coupons + singleton swap, one transaction.
  log("activation start", {
    name: data.name,
    tiers: { standard: data.standard_pct, priority: data.priority_pct, express: data.express_pct },
  });

  const createdCoupons: Array<{ tier: TierKey; id: string }> = [];
  try {
    return await db.transaction(async (tx) => {
      // 0. Auto-expire any stale active row whose expiry has already passed,
      //    BEFORE the singleton swap below. The partial unique index allows only
      //    one active=true row; if that row is expired-but-still-active it would
      //    otherwise make this activation fail the index. Clearing it here (with a
      //    distinct PROMO_AUTO_EXPIRED audit, separate from a normal swap) means
      //    activating a new promo always succeeds over a dead row. Excludes the
      //    row being edited (data.id) so re-activating it isn't self-expired.
      const excludeId = data.id ?? -1; // serial ids are positive → -1 excludes nothing on insert
      const expiredRows = await tx.execute(sql`
        UPDATE promotions
        SET active = false, updated_at = NOW()
        WHERE active = true
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
          AND id <> ${excludeId}
        RETURNING id, expires_at
      `);
      for (const r of expiredRows.rows as Array<{ id: number; expires_at: string }>) {
        await tx.insert(auditLog).values({
          entityType: "promotion",
          entityId: String(r.id),
          action: "PROMO_AUTO_EXPIRED",
          adminUser,
          details: { expires_at: r.expires_at, reason: "expired_on_activate" },
        });
        log("auto-expired stale active promo", { id: r.id, expires_at: r.expires_at });
      }

      // a. Lock the current (unexpired) active promo (if any).
      const cur = await tx.execute(sql`SELECT id FROM promotions WHERE active = true LIMIT 1 FOR UPDATE`);
      const oldId: number | null = (cur.rows[0] as { id: number } | undefined)?.id ?? null;

      // b. Mint a Stripe coupon for every tier with pct > 0.
      const stripe = await getUncachableStripeClient();
      const couponIds: CouponIds = { standard: null, priority: null, express: null };
      for (const t of PROMO_TIERS) {
        const pct = data[t.pctCol as keyof PromotionInput] as number;
        if (pct > 0) {
          const coupon = await stripe.coupons.create({
            percent_off: pct,
            duration: "once",
            name: `${data.name} - ${t.label}`,
            metadata: { mintvault_promo: "1", tier: t.key },
          });
          couponIds[t.key] = coupon.id;
          createdCoupons.push({ tier: t.key, id: coupon.id });
          log("coupon created", { tier: t.key, coupon_id: coupon.id, percent_off: pct });
        }
      }

      // d. Deactivate the old active promo BEFORE activating the new one, so the
      //    singleton index never sees two active rows mid-transaction.
      if (oldId !== null && oldId !== data.id) {
        await tx.execute(sql`UPDATE promotions SET active = false, updated_at = NOW() WHERE id = ${oldId}`);
      }

      // c. Insert (or update) the promo row WITH the coupon ids, active = true.
      const row = await upsertRow(tx, data, couponIds, true, expiresAt);

      // e. Audit (inside the txn for atomicity).
      await tx.insert(auditLog).values({
        entityType: "promotion",
        entityId: String(row.id),
        action: "PROMO_ACTIVATED",
        adminUser,
        details: {
          name: data.name,
          banner_text: data.banner_text,
          tiers: { standard: data.standard_pct, priority: data.priority_pct, express: data.express_pct },
          coupon_ids: couponIds,
          deactivated_promo_id: oldId,
          expires_at: expiresAt,
        },
      });

      log("activation success", { id: row.id, deactivated_promo_id: oldId });
      return row;
    });
  } catch (err: any) {
    // Stripe has no transaction — surface any coupons minted before the failure
    // so they can be reconciled/voided manually. Never swallow the error.
    if (createdCoupons.length > 0) {
      console.error(
        "[promotions] ACTIVATION FAILED after creating Stripe coupons — these are now orphaned, reconcile in Stripe:",
        JSON.stringify(createdCoupons)
      );
    }
    console.error("[promotions] activation error:", err?.message || err);
    throw new Error(`Promotion activation failed: ${err?.message || err}`);
  }
}

/** Deactivate a promotion. Stripe coupons are intentionally kept. */
export async function deactivatePromotion(id: number, adminUser: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE promotions SET active = false, updated_at = NOW() WHERE id = ${id}`);
    await tx.insert(auditLog).values({
      entityType: "promotion",
      entityId: String(id),
      action: "PROMO_DEACTIVATED",
      adminUser,
      details: {},
    });
  });
  log("deactivated", { id });
}

/**
 * SOFT-delete a promotion: set deleted_at = NOW() AND active = false in one
 * statement (so deleting the live promo also stops it running), and audit it.
 * Never a hard DELETE — the row persists with deleted_at and is filtered out of
 * every read (getActivePromotion / listPromotions). Stripe coupons are kept.
 */
export async function deletePromotion(id: number, adminUser: string): Promise<void> {
  await db.transaction(async (tx) => {
    const cur = await tx.execute(
      sql`SELECT name, active FROM promotions WHERE id = ${id} AND deleted_at IS NULL LIMIT 1 FOR UPDATE`
    );
    const row = cur.rows[0] as { name: string; active: boolean } | undefined;
    if (!row) throw new Error(`Promotion ${id} not found`);

    await tx.execute(
      sql`UPDATE promotions SET deleted_at = NOW(), active = false, updated_at = NOW() WHERE id = ${id}`
    );
    await tx.insert(auditLog).values({
      entityType: "promotion",
      entityId: String(id),
      action: "PROMO_DELETED",
      adminUser,
      details: { name: row.name, was_active: row.active },
    });
  });
  log("deleted (soft)", { id });
}

/** INSERT (no id) or UPDATE (id present) the promo row, returning the saved row. */
async function upsertRow(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  data: PromotionInput,
  couponIds: CouponIds,
  active: boolean,
  expiresAt: string | null
): Promise<Promotion> {
  if (data.id) {
    const res = await tx.execute(sql`
      UPDATE promotions SET
        name = ${data.name},
        banner_text = ${data.banner_text},
        standard_pct = ${data.standard_pct},
        priority_pct = ${data.priority_pct},
        express_pct = ${data.express_pct},
        standard_coupon_id = ${couponIds.standard},
        priority_coupon_id = ${couponIds.priority},
        express_coupon_id = ${couponIds.express},
        stacking_mode = ${data.stacking_mode},
        active = ${active},
        expires_at = ${expiresAt},
        updated_at = NOW()
      WHERE id = ${data.id}
      RETURNING *
    `);
    const row = res.rows[0] as unknown as Promotion | undefined;
    if (!row) throw new Error(`Promotion ${data.id} not found`);
    return row;
  }
  const res = await tx.execute(sql`
    INSERT INTO promotions
      (name, banner_text, standard_pct, priority_pct, express_pct,
       standard_coupon_id, priority_coupon_id, express_coupon_id, stacking_mode, active, expires_at, updated_at)
    VALUES
      (${data.name}, ${data.banner_text}, ${data.standard_pct}, ${data.priority_pct}, ${data.express_pct},
       ${couponIds.standard}, ${couponIds.priority}, ${couponIds.express}, ${data.stacking_mode}, ${active}, ${expiresAt}, NOW())
    RETURNING *
  `);
  return res.rows[0] as unknown as Promotion;
}
