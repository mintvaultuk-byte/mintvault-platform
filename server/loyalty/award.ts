/**
 * Loyalty points — award service.
 *
 * Single function, transactional: writes one row into loyalty_ledger and one
 * row into audit_log atomically. Idempotency for source-anchored awards is
 * enforced by a partial UNIQUE index in the migration; we catch the
 * duplicate-key error and return { status: "already-awarded" }.
 *
 * Admin-adjustment calls leave sourceId NULL and so are NOT idempotent —
 * every call writes a fresh row. That's deliberate: an operator nudging
 * a balance up by 5 then down by 2 should record both moves.
 *
 * No HTTP, no auth — those are the caller's job. This module is also
 * called from the admin endpoint and (eventually) from the submission /
 * certificate completion hooks.
 */

import { db } from "../db";
import { sql } from "drizzle-orm";
import { loyaltyLedger, auditLog } from "@shared/schema";

export type AwardReason  = "order_completed" | "admin_adjust" | "redeem" | "expire" | "referral";
export type AwardSourceType = "submission" | "certificate" | "admin" | "redemption" | null;

export interface AwardInput {
  userId:      string;
  delta:       number;                       // signed: positive=earn, negative=redeem/expire
  reason:      AwardReason;
  sourceType:  AwardSourceType;
  sourceId:    string | null;
  metadata?:   Record<string, unknown>;
  expiresAt?:  Date | null;
  /** Admin email/id if this came from a privileged route; 'system' for hooks. */
  adminUser?:  string;
}

export type AwardResult =
  | { status: "awarded";        ledgerId: string; balanceAfter: number }
  | { status: "already-awarded"; reason: string };

const DUPE_CODES = new Set(["23505"]); // pg unique_violation

export async function awardPoints(input: AwardInput): Promise<AwardResult> {
  if (!Number.isFinite(input.delta) || !Number.isInteger(input.delta)) {
    throw new Error(`awardPoints: delta must be an integer, got ${input.delta}`);
  }
  if (input.delta === 0) {
    throw new Error("awardPoints: delta=0 is meaningless; refuse to record a no-op");
  }
  if (!input.userId) throw new Error("awardPoints: userId required");
  if (!input.reason) throw new Error("awardPoints: reason required");

  const adminUser = input.adminUser || "system";
  const metadata  = input.metadata || {};
  const expiresAt = input.expiresAt ?? null;

  try {
    return await db.transaction(async (tx) => {
      // 1) Insert the ledger row — pg generates the uuid via gen_random_uuid().
      const inserted = await tx.insert(loyaltyLedger).values({
        userId:     input.userId,
        delta:      input.delta,
        reason:     input.reason,
        sourceType: input.sourceType,
        sourceId:   input.sourceId,
        metadata,
        expiresAt,
      }).returning({ id: loyaltyLedger.id });
      const ledgerId = inserted[0]?.id;
      if (!ledgerId) throw new Error("awardPoints: ledger insert returned no id");

      // 2) Compute balance_after — sum the user's non-expired deltas
      //    (the row we just inserted is visible inside this tx).
      const balanceRow = await tx.execute(sql`
        SELECT COALESCE(SUM(delta), 0)::int AS balance
        FROM loyalty_ledger
        WHERE user_id = ${input.userId}
          AND (expires_at IS NULL OR expires_at > NOW())
      `);
      const balanceAfter = Number((balanceRow.rows[0] as any)?.balance ?? 0);

      // 3) Audit row — same tx, same logical event.
      await tx.insert(auditLog).values({
        entityType: "loyalty_ledger",
        entityId:   ledgerId,
        action:     input.reason,
        adminUser,
        details: {
          delta:         input.delta,
          source_type:   input.sourceType,
          source_id:     input.sourceId,
          balance_after: balanceAfter,
        },
      });

      return { status: "awarded" as const, ledgerId, balanceAfter };
    });
  } catch (err: any) {
    // Partial unique-index violation = idempotency hit. The pg error codes
    // come through node-postgres as either err.code or err.cause?.code
    // depending on driver path; check both.
    const code = err?.code || err?.cause?.code;
    if (DUPE_CODES.has(String(code))) {
      return {
        status: "already-awarded" as const,
        reason: `duplicate (${input.sourceType}:${input.sourceId} ${input.reason})`,
      };
    }
    throw err;
  }
}
