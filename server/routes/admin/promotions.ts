/**
 * Admin promotions API — all behind requireAdmin.
 *
 *   GET    /api/admin/promotions            list (newest 20)
 *   GET    /api/admin/promotions/active     the single active promo or null
 *   POST   /api/admin/promotions            create + (optionally) activate
 *   PUT    /api/admin/promotions/:id        edit + (optionally) activate
 *   POST   /api/admin/promotions/:id/deactivate
 *
 * Admin identity for audit comes from req.session.adminEmail (set by the
 * admin auth flow). All numeric/string inputs are validated server-side —
 * client-supplied percentages are never trusted.
 */
import type { Express, Request } from "express";
import { requireAdmin } from "../../auth";
import {
  listPromotions,
  getActivePromotion,
  savePromotion,
  deactivatePromotion,
  type PromotionInput,
} from "../../services/promotionService";

function adminUserOf(req: Request): string {
  return req.session?.adminEmail || "admin";
}

/** Validate + coerce the request body into a PromotionInput. Returns an error
 *  string (→ 400) or the clean input. Percentages must be integers 0–100. */
function parseInput(body: any, id?: number): { error: string } | { input: PromotionInput } {
  if (!body || typeof body !== "object") return { error: "Body must be an object" };

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "name is required" };
  if (name.length > 100) return { error: "name must be ≤ 100 chars" };

  const banner_text = typeof body.banner_text === "string" ? body.banner_text.trim() : "";
  if (!banner_text) return { error: "banner_text is required" };
  if (banner_text.length > 200) return { error: "banner_text must be ≤ 200 chars" };

  const pcts: Record<string, number> = {};
  for (const key of ["standard_pct", "priority_pct", "express_pct"]) {
    const v = body[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
      return { error: `${key} must be an integer between 0 and 100` };
    }
    pcts[key] = v;
  }

  let expires_at: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null && String(body.expires_at).trim() !== "") {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime())) return { error: "expires_at is not a valid date" };
    expires_at = new Date(body.expires_at).toISOString();
  }

  if (typeof body.active !== "boolean") return { error: "active must be a boolean" };

  return {
    input: {
      ...(id !== undefined ? { id } : {}),
      name,
      banner_text,
      standard_pct: pcts.standard_pct,
      priority_pct: pcts.priority_pct,
      express_pct: pcts.express_pct,
      expires_at,
      active: body.active,
    },
  };
}

export function registerPromotionRoutes(app: Express): void {
  app.get("/api/admin/promotions", requireAdmin, async (_req, res) => {
    try {
      res.json({ promotions: await listPromotions() });
    } catch (err: any) {
      console.error("[promotions] list error:", err?.message || err);
      res.status(500).json({ error: "Failed to list promotions" });
    }
  });

  app.get("/api/admin/promotions/active", requireAdmin, async (_req, res) => {
    try {
      res.json({ promotion: await getActivePromotion() });
    } catch (err: any) {
      console.error("[promotions] active error:", err?.message || err);
      res.status(500).json({ error: "Failed to fetch active promotion" });
    }
  });

  app.post("/api/admin/promotions", requireAdmin, async (req, res) => {
    const parsed = parseInput(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    try {
      const promo = await savePromotion(parsed.input, adminUserOf(req));
      res.json({ promotion: promo });
    } catch (err: any) {
      console.error("[promotions] create error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to save promotion" });
    }
  });

  app.put("/api/admin/promotions/:id", requireAdmin, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid promotion id" });
    const parsed = parseInput(req.body, id);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    try {
      const promo = await savePromotion(parsed.input, adminUserOf(req));
      res.json({ promotion: promo });
    } catch (err: any) {
      console.error("[promotions] update error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to save promotion" });
    }
  });

  app.post("/api/admin/promotions/:id/deactivate", requireAdmin, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid promotion id" });
    try {
      await deactivatePromotion(id, adminUserOf(req));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[promotions] deactivate error:", err?.message || err);
      res.status(500).json({ error: "Failed to deactivate promotion" });
    }
  });
}
