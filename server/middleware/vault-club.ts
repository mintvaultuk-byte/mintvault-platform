/**
 * server/middleware/vault-club.ts
 *
 * Tier-gating middleware for Vault Club-protected routes.
 * Usage:
 *   app.get("/protected", requireVaultClub("silver"), handler)
 */

import type { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { TIER_ORDER, isActiveStatus, type VaultClubTier } from "../vault-club-tiers";

export function requireVaultClub(minTier: VaultClubTier = "bronze") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req.session as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "auth_required" });
    }

    try {
      const rows = await db.execute(sql`
        SELECT vault_club_tier, vault_club_status
        FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
      `);
      if (rows.rows.length === 0) {
        return res.status(401).json({ error: "auth_required" });
      }
      const user = rows.rows[0] as any;
      const tier = user.vault_club_tier as VaultClubTier | null;
      const status = user.vault_club_status as string | null;

      if (!tier || !isActiveStatus(status)) {
        return res.status(403).json({ error: "vault_club_required", minTier });
      }

      if (TIER_ORDER[tier] < TIER_ORDER[minTier]) {
        return res.status(403).json({ error: "higher_tier_required", minTier, currentTier: tier });
      }

      next();
    } catch (err: any) {
      console.error("[vault-club middleware] error:", err.message);
      return res.status(500).json({ error: "Authorization check failed." });
    }
  };
}
