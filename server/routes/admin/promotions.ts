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
  deletePromotion,
  type PromotionInput,
} from "../../services/promotionService";
import {
  listPromoCodes,
  createPromoCode,
  deletePromoCode,
  normalizeCode,
  type PromoCodeInput,
} from "../../services/promoCodeService";

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

  // Stacking mode is optional; default to the safe non-stacking rule.
  let stacking_mode: "best_of" | "stack_on_top" = "best_of";
  if (body.stacking_mode !== undefined && body.stacking_mode !== null && body.stacking_mode !== "") {
    if (body.stacking_mode !== "best_of" && body.stacking_mode !== "stack_on_top") {
      return { error: "stacking_mode must be 'best_of' or 'stack_on_top'" };
    }
    stacking_mode = body.stacking_mode;
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
      stacking_mode,
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

  // Soft-delete (deleted_at + active=false + audit) — never a hard delete.
  app.delete("/api/admin/promotions/:id", requireAdmin, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid promotion id" });
    try {
      await deletePromotion(id, adminUserOf(req));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[promotions] delete error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to delete promotion" });
    }
  });

  // ── Promo codes (private, customer-entered; multiple at once) ──
  app.get("/api/admin/promo-codes", requireAdmin, async (_req, res) => {
    try {
      res.json({ codes: await listPromoCodes() });
    } catch (err: any) {
      console.error("[promo-codes] list error:", err?.message || err);
      res.status(500).json({ error: "Failed to list promo codes" });
    }
  });

  app.post("/api/admin/promo-codes", requireAdmin, async (req, res) => {
    const parsed = parseCodeInput(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    try {
      const code = await createPromoCode(parsed.input, adminUserOf(req));
      res.json({ code });
    } catch (err: any) {
      // Unique-violation when the code already exists (active) → friendly 409.
      if (err?.code === "23505" || /duplicate key|unique/i.test(err?.message || "")) {
        return res.status(409).json({ error: "That code already exists" });
      }
      console.error("[promo-codes] create error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to create promo code" });
    }
  });

  app.delete("/api/admin/promo-codes/:id", requireAdmin, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid promo code id" });
    try {
      await deletePromoCode(id, adminUserOf(req));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[promo-codes] delete error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to delete promo code" });
    }
  });
}

/** Validate + coerce a promo-code create body. Server is the source of truth. */
function parseCodeInput(body: any): { error: string } | { input: PromoCodeInput } {
  if (!body || typeof body !== "object") return { error: "Body must be an object" };

  const code = normalizeCode(body.code);
  if (!code) return { error: "code is required" };
  if (code.length > 64) return { error: "code must be ≤ 64 chars" };
  if (!/^[A-Z0-9._-]+$/.test(code)) return { error: "code may only contain letters, numbers, . _ -" };

  const percent = body.percent;
  if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 100) {
    return { error: "percent must be an integer between 1 and 100" };
  }

  let max_uses: number | null = null;
  if (body.max_uses !== undefined && body.max_uses !== null && String(body.max_uses).trim() !== "") {
    const m = Number(body.max_uses);
    if (!Number.isInteger(m) || m < 1) return { error: "max_uses must be an integer ≥ 1 (or empty for unlimited)" };
    max_uses = m;
  }

  let expires_at: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null && String(body.expires_at).trim() !== "") {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime())) return { error: "expires_at is not a valid date" };
    expires_at = d.toISOString();
  }

  const label = typeof body.label === "string" ? body.label.trim().slice(0, 200) : null;
  if (typeof body.active !== "boolean") return { error: "active must be a boolean" };

  return { input: { code, label, percent, max_uses, expires_at, active: body.active } };
}
