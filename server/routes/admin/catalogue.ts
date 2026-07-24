/**
 * Catalogue Manager API.
 *
 *   Live pickers (admin OR staff/grader — read-only):
 *     GET  /api/catalogue/snapshot          canonical picker/validation snapshot
 *
 *   Management (Super Admin only):
 *     GET  /api/admin/catalogue/items       full rows (?category=&search=&includeInactive=&includeArchived=)
 *     POST /api/admin/catalogue/items       create
 *     PUT  /api/admin/catalogue/items/:id   edit
 *     POST /api/admin/catalogue/items/:id/active    enable / disable  { active }
 *     POST /api/admin/catalogue/items/:id/archive   archive / restore { archived }
 *     POST /api/admin/catalogue/reorder     { category, orderedIds }
 *     GET  /api/admin/catalogue/export      export JSON (backup)
 *     POST /api/admin/catalogue/import      import JSON
 *     GET  /api/admin/catalogue/audit       recent catalogue audit entries
 *
 * Every mutation invalidates the in-process snapshot cache and is audited via the
 * existing audit_log table (entity_type = "catalogue_item").
 */
import type { Express, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { desc, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { requireSuperAdmin } from "../../auth";
import { db } from "../../db";
import { auditLog, CATALOGUE_CATEGORIES, type CatalogueCategory } from "@shared/schema";
import {
  listCatalogueItems,
  getCatalogueItem,
  createCatalogueItem,
  updateCatalogueItem,
  setCatalogueActive,
  setCatalogueArchived,
  reorderCatalogue,
  searchCatalogueItems,
  exportCatalogue,
  importCatalogue,
  CatalogueValidationError,
} from "../../services/catalogueService";
import { getCatalogueSnapshot, invalidateCatalogueCache } from "../../lib/catalogue-provider";

const catalogueMutationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many catalogue changes. Please wait a few minutes and try again." },
});

/** Read access for live pickers: admin OR any logged-in staff/grader. */
function adminOrStaffRead(req: Request, res: Response, next: NextFunction): void {
  const session = req.session as { isAdmin?: boolean; isGrader?: boolean } | undefined;
  if (session?.isAdmin || session?.isGrader) return next();
  res.status(401).json({ error: "Authentication required" });
}

function actor(req: Request): string {
  return (req.session as { adminEmail?: string }).adminEmail || "admin";
}

function fail(res: Response, err: unknown, fallback: string): void {
  if (err instanceof CatalogueValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid catalogue item.", details: err.issues });
    return;
  }
  console.error(`[catalogue] ${fallback}:`, err instanceof Error ? err.message : String(err));
  res.status(500).json({ error: fallback });
}

function parseCategory(v: unknown): CatalogueCategory | undefined {
  return CATALOGUE_CATEGORIES.includes(v as CatalogueCategory) ? (v as CatalogueCategory) : undefined;
}

export function registerCatalogueRoutes(app: Express): void {
  // ── Live picker snapshot (admin OR staff) ──────────────────────────────────
  app.get("/api/catalogue/snapshot", adminOrStaffRead, async (_req, res) => {
    try {
      res.json({ snapshot: await getCatalogueSnapshot(), categories: CATALOGUE_CATEGORIES });
    } catch (err) {
      fail(res, err, "Failed to load catalogue.");
    }
  });

  // ── Manager: list full rows ────────────────────────────────────────────────
  app.get("/api/admin/catalogue/items", requireSuperAdmin, async (req, res) => {
    try {
      const category = parseCategory(req.query.category);
      const search = typeof req.query.search === "string" ? req.query.search : "";
      const includeInactive = req.query.includeInactive !== "false";
      const includeArchived = req.query.includeArchived === "true";
      const rows = search
        ? await searchCatalogueItems(search, category)
        : await listCatalogueItems({ category, includeInactive, includeArchived });
      res.json({ items: search ? rows : rows, categories: CATALOGUE_CATEGORIES });
    } catch (err) {
      fail(res, err, "Failed to list catalogue items.");
    }
  });

  // ── Create ─────────────────────────────────────────────────────────────────
  app.post("/api/admin/catalogue/items", catalogueMutationLimit, requireSuperAdmin, async (req, res) => {
    try {
      const item = await createCatalogueItem(req.body, actor(req));
      invalidateCatalogueCache();
      res.status(201).json({ item });
    } catch (err) {
      fail(res, err, "Failed to create catalogue item.");
    }
  });

  // ── Update ─────────────────────────────────────────────────────────────────
  app.put("/api/admin/catalogue/items/:id", catalogueMutationLimit, requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
      const item = await updateCatalogueItem(id, req.body, actor(req));
      invalidateCatalogueCache();
      res.json({ item });
    } catch (err) {
      fail(res, err, "Failed to update catalogue item.");
    }
  });

  // ── Enable / disable ───────────────────────────────────────────────────────
  app.post("/api/admin/catalogue/items/:id/active", catalogueMutationLimit, requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
      const item = await setCatalogueActive(id, Boolean(req.body?.active), actor(req));
      invalidateCatalogueCache();
      res.json({ item });
    } catch (err) {
      fail(res, err, "Failed to change catalogue item state.");
    }
  });

  // ── Archive / restore ──────────────────────────────────────────────────────
  app.post("/api/admin/catalogue/items/:id/archive", catalogueMutationLimit, requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
      const item = await setCatalogueArchived(id, Boolean(req.body?.archived), actor(req));
      invalidateCatalogueCache();
      res.json({ item });
    } catch (err) {
      fail(res, err, "Failed to archive catalogue item.");
    }
  });

  // ── Reorder ────────────────────────────────────────────────────────────────
  app.post("/api/admin/catalogue/reorder", catalogueMutationLimit, requireSuperAdmin, async (req, res) => {
    try {
      const category = parseCategory(req.body?.category);
      if (!category) return res.status(400).json({ error: "Unknown category." });
      const orderedIds = Array.isArray(req.body?.orderedIds)
        ? req.body.orderedIds.map(Number).filter(Number.isInteger)
        : [];
      await reorderCatalogue(category, orderedIds, actor(req));
      invalidateCatalogueCache();
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "Failed to reorder catalogue.");
    }
  });

  // ── Export ─────────────────────────────────────────────────────────────────
  app.get("/api/admin/catalogue/export", requireSuperAdmin, async (_req, res) => {
    try {
      const data = await exportCatalogue();
      res.setHeader("Content-Disposition", 'attachment; filename="catalogue-export.json"');
      res.json(data);
    } catch (err) {
      fail(res, err, "Failed to export catalogue.");
    }
  });

  // ── Import ─────────────────────────────────────────────────────────────────
  app.post("/api/admin/catalogue/import", catalogueMutationLimit, requireSuperAdmin, async (req, res) => {
    try {
      const result = await importCatalogue(req.body, actor(req));
      invalidateCatalogueCache();
      res.json({ result });
    } catch (err) {
      fail(res, err, "Failed to import catalogue.");
    }
  });

  // ── Recent audit entries ───────────────────────────────────────────────────
  app.get("/api/admin/catalogue/audit", requireSuperAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "catalogue_item"))
        .orderBy(desc(auditLog.createdAt))
        .limit(limit);
      res.json({ entries: rows });
    } catch (err) {
      fail(res, err, "Failed to load catalogue audit log.");
    }
  });
}
