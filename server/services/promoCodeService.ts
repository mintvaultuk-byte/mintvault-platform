/**
 * promoCodeService.ts — customer-entered promo CODES (e.g. FRIEND15 = 15% off a
 * grading order). Distinct from the singleton auto-promo: codes are private (not
 * shown publicly), MULTIPLE can exist at once, each gated behind a typed code.
 *
 * Rules (locked): flat % per code on the whole grading order; ONE code per order;
 * codes NEVER stack — a code competes as a best_of arm (see resolveGradingDiscount,
 * codePercent). Usage is an optional TOTAL cap (max_uses; NULL = unlimited) counted
 * only on a SUCCESSFUL charge. Soft-delete + audit, same discipline as promotions.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { auditLog } from "@shared/schema";

export interface PromoCode {
  id: number;
  code: string;
  label: string | null;
  percent: number;
  max_uses: number | null;
  uses_count: number;
  expires_at: string | null;
  active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PromoCodeInput {
  code: string;
  label?: string | null;
  percent: number;
  max_uses?: number | null;
  expires_at?: string | null;
  active: boolean;
}

export type PromoCodeRejection = "not_found" | "inactive" | "expired" | "over_limit";

export interface PromoCodeValidation {
  valid: boolean;
  percent: number;
  reason: PromoCodeRejection | null;
  id: number | null;
  code: string | null; // normalized (UPPERCASE, trimmed) when found
}

/** Codes are stored + matched UPPERCASE and trimmed. */
export function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

/**
 * Validate a typed code (READ-ONLY — never increments uses_count). Rejects if not
 * found / soft-deleted / inactive / expired / at-or-over its usage cap.
 */
export async function validatePromoCode(rawCode: string): Promise<PromoCodeValidation> {
  const code = normalizeCode(rawCode);
  if (!code) return { valid: false, percent: 0, reason: "not_found", id: null, code: null };

  const res = await db.execute(
    sql`SELECT id, percent, max_uses, uses_count, expires_at, active
        FROM promo_codes WHERE code = ${code} AND deleted_at IS NULL LIMIT 1`
  );
  const row = res.rows[0] as
    | {
        id: number;
        percent: number;
        max_uses: number | null;
        uses_count: number;
        expires_at: string | null;
        active: boolean;
      }
    | undefined;

  if (!row) return { valid: false, percent: 0, reason: "not_found", id: null, code: null };
  if (!row.active) return { valid: false, percent: 0, reason: "inactive", id: row.id, code };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return { valid: false, percent: 0, reason: "expired", id: row.id, code };
  }
  if (row.max_uses !== null && row.uses_count >= row.max_uses) {
    return { valid: false, percent: 0, reason: "over_limit", id: row.id, code };
  }
  const percent = Math.max(0, Math.min(100, Math.trunc(row.percent)));
  return { valid: true, percent, reason: null, id: row.id, code };
}

/** All non-deleted codes, newest first (admin list). */
export async function listPromoCodes(): Promise<PromoCode[]> {
  const res = await db.execute(
    sql`SELECT * FROM promo_codes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`
  );
  return res.rows as unknown as PromoCode[];
}

/** Create a code + audit. code is normalized; uniqueness enforced by the partial index. */
export async function createPromoCode(data: PromoCodeInput, adminUser: string): Promise<PromoCode> {
  const code = normalizeCode(data.code);
  const expiresAt = data.expires_at && data.expires_at.trim().length > 0 ? data.expires_at : null;
  const maxUses = data.max_uses === null || data.max_uses === undefined ? null : Math.trunc(data.max_uses);

  return await db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      INSERT INTO promo_codes (code, label, percent, max_uses, expires_at, active, updated_at)
      VALUES (${code}, ${data.label ?? null}, ${Math.trunc(data.percent)}, ${maxUses}, ${expiresAt}, ${data.active}, NOW())
      RETURNING *
    `);
    const row = res.rows[0] as unknown as PromoCode;
    await tx.insert(auditLog).values({
      entityType: "promo_code",
      entityId: String(row.id),
      action: "PROMO_CODE_CREATED",
      adminUser,
      details: { code, percent: data.percent, max_uses: maxUses, expires_at: expiresAt, active: data.active },
    });
    return row;
  });
}

/** SOFT-delete a code (deleted_at + active=false) + audit. Never a hard DELETE. */
export async function deletePromoCode(id: number, adminUser: string): Promise<void> {
  await db.transaction(async (tx) => {
    const cur = await tx.execute(
      sql`SELECT code FROM promo_codes WHERE id = ${id} AND deleted_at IS NULL LIMIT 1 FOR UPDATE`
    );
    const row = cur.rows[0] as { code: string } | undefined;
    if (!row) throw new Error(`Promo code ${id} not found`);
    await tx.execute(
      sql`UPDATE promo_codes SET deleted_at = NOW(), active = false, updated_at = NOW() WHERE id = ${id}`
    );
    await tx.insert(auditLog).values({
      entityType: "promo_code",
      entityId: String(id),
      action: "PROMO_CODE_DELETED",
      adminUser,
      details: { code: row.code },
    });
  });
}

/**
 * Atomically count a redemption on a SUCCESSFUL charge. The cap is guarded in the
 * UPDATE itself (uses_count < max_uses) so it can never exceed the cap even under
 * concurrency. If the cap was hit between quote and charge the UPDATE matches no
 * row — we still audit (over_cap: true) and NEVER fail the payment, since the
 * charge already reflects the discount. Always writes a PROMO_CODE_REDEEMED audit.
 */
export async function redeemPromoCode(
  id: number,
  code: string | null,
  percent: number | null,
  submissionId: number
): Promise<void> {
  const res = await db.execute(sql`
    UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = NOW()
    WHERE id = ${id} AND deleted_at IS NULL AND (max_uses IS NULL OR uses_count < max_uses)
    RETURNING id
  `);
  const overCap = res.rows.length === 0;
  await db.insert(auditLog).values({
    entityType: "promo_code",
    entityId: String(id),
    action: "PROMO_CODE_REDEEMED",
    adminUser: null,
    details: { code, percent, submission_id: submissionId, over_cap: overCap },
  });
  if (overCap) {
    console.warn(
      `[promo_code] over-cap redemption (cap hit between quote and charge): code_id=${id} submission=${submissionId}`
    );
  }
}
