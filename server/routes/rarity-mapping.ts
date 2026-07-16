/**
 * Admin-only routes for the structured rarity/variant integration:
 *   • GET  /api/admin/rarity-mapping-reviews         — read-only legacy audit
 *   • POST /api/admin/rarity-mapping-reviews/decision — approve/reject/ignore a
 *                                                       mapping RULE (never a cert)
 *   • GET  /api/admin/rarity-preferences             — favourites / recently-used
 *   • PUT  /api/admin/rarity-preferences             — save favourites / recent
 *
 * All routes are behind `requireAdmin` (graders 403, no session 401) and the
 * global same-origin/CSRF check. Mutations carry a dedicated rate limiter
 * (the global admin limiter skips logged-in admins). Nothing here rewrites a
 * certificate or backfills any value — approvals record the rule only.
 */
import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../auth";
import { storage } from "../storage";
import { normalizeCertId } from "../lib/cert-id";
import {
  getVariantCounts,
  listRarityMappingReviews,
  upsertRarityMappingReviewDecision,
  getRarityPreferences,
  setRarityPreferences,
} from "../lib/rarity-mapping-store";
import { buildAuditRows, summariseAudit } from "@shared/rarity-legacy-audit";
import { REVIEW_STATUSES } from "@shared/schema";

const rarityMutationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many rarity changes. Please wait a few minutes and try again." },
});

const CLASSIFICATIONS = ["rarity", "finish", "promo", "subset", "ambiguous"] as const;

function adminEmail(req: { session?: { adminEmail?: string } }): string {
  return req.session?.adminEmail || "admin";
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

export function registerRarityMappingRoutes(app: Express): void {
  // ── Read-only legacy audit: distinct variant values + counts + proposal ─────
  app.get("/api/admin/rarity-mapping-reviews", requireAdmin, async (_req, res) => {
    try {
      const counts = await getVariantCounts();
      const rows = buildAuditRows(counts.map((c) => ({ value: c.variant, count: c.count })));
      const exampleByValue = new Map(counts.map((c) => [c.variant, c.exampleCertIds]));
      const saved = await listRarityMappingReviews();
      const savedByValue = new Map(saved.map((r) => [r.legacyValue, r]));

      const items = rows.map((row) => {
        const decision = savedByValue.get(row.legacyValue);
        return {
          legacyValue: row.legacyValue,
          recordCount: row.recordCount,
          classification: row.classification,
          proposedValue: row.proposedValue,
          confidence: row.confidence,
          reviewRequired: row.reviewRequired,
          reason: row.reason,
          // Cert numbers are public identifiers (not PII); normalised for display.
          exampleCertIds: (exampleByValue.get(row.legacyValue) ?? []).map((c) => normalizeCertId(c)),
          status: decision?.status ?? "pending",
          reviewedBy: decision?.reviewedBy ?? null,
          reviewedAt: decision?.reviewedAt ?? null,
        };
      });

      res.json({ items, summary: summariseAudit(rows) });
    } catch (err) {
      console.error("[rarity-mapping] audit failed:", err instanceof Error ? err.message : String(err));
      fail(res, 500, "Failed to load legacy variant audit.");
    }
  });

  // ── Approve / reject / ignore a mapping RULE (never rewrites a certificate) ──
  app.post("/api/admin/rarity-mapping-reviews/decision", rarityMutationLimit, requireAdmin, async (req, res) => {
    try {
      const legacyValue = typeof req.body?.legacyValue === "string" ? req.body.legacyValue.trim() : "";
      const status = req.body?.decision ?? req.body?.status;
      if (!legacyValue) return fail(res, 400, "legacyValue is required.");
      if (!REVIEW_STATUSES.includes(status)) {
        return fail(res, 400, `decision must be one of: ${REVIEW_STATUSES.join(", ")}.`);
      }
      const proposedClassification =
        req.body?.proposedClassification == null ? null : String(req.body.proposedClassification);
      if (proposedClassification && !CLASSIFICATIONS.includes(proposedClassification as (typeof CLASSIFICATIONS)[number])) {
        return fail(res, 400, `proposedClassification must be one of: ${CLASSIFICATIONS.join(", ")}.`);
      }
      const proposedValue = req.body?.proposedValue == null ? null : String(req.body.proposedValue).trim() || null;
      const reason = req.body?.reason == null ? null : String(req.body.reason).slice(0, 500);

      const saved = await upsertRarityMappingReviewDecision({
        legacyValue,
        status,
        proposedClassification,
        proposedValue,
        reason,
        reviewedBy: adminEmail(req),
      });

      // Audit the RULE decision only. Cert strings are non-PII; no cert changes.
      await storage.writeAuditLog("rarity_mapping_review", legacyValue, status, adminEmail(req), {
        proposedClassification,
        proposedValue,
      });

      res.json({ ok: true, review: saved });
    } catch (err) {
      console.error("[rarity-mapping] decision failed:", err instanceof Error ? err.message : String(err));
      fail(res, 500, "Failed to record mapping decision.");
    }
  });

  // ── Per-admin picker preferences (favourites / recently-used) ───────────────
  app.get("/api/admin/rarity-preferences", requireAdmin, async (req, res) => {
    try {
      res.json(await getRarityPreferences(adminEmail(req)));
    } catch (err) {
      console.error("[rarity-mapping] load prefs failed:", err instanceof Error ? err.message : String(err));
      res.json({ favourites: [], recent: [] });
    }
  });

  app.put("/api/admin/rarity-preferences", rarityMutationLimit, requireAdmin, async (req, res) => {
    try {
      const favourites = Array.isArray(req.body?.favourites) ? req.body.favourites : [];
      const recent = Array.isArray(req.body?.recent) ? req.body.recent : [];
      const saved = await setRarityPreferences(adminEmail(req), { favourites, recent }, adminEmail(req));
      res.json(saved);
    } catch (err) {
      console.error("[rarity-mapping] save prefs failed:", err instanceof Error ? err.message : String(err));
      fail(res, 500, "Failed to save preferences.");
    }
  });
}
