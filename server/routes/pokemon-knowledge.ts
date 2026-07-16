/**
 * Pokémon Knowledge Engine — admin routes (+ staff READ-ONLY mirrors).
 *
 * Auth model (server-enforced):
 *   • READS  — admin OR logged-in staff (read-only Knowledge Hub for staff)
 *   • WRITES — admin only, rate-limited (limiter BEFORE requireAdmin), audited
 *   • exports/handbook — admin only (Phase 26: no private exports for staff yet)
 *
 * Imports NEVER write canonical records — they create draft runs the founder
 * approves. Nothing in this file touches certificates, grading, or labels.
 */
import type { Express, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../auth";
import { storage } from "../storage";
import {
  searchSets,
  getSetDetail,
  upsertSetKnowledge,
  restoreRevision,
  createImportRun,
  decideImportRun,
  listImportRuns,
  starterSeedCandidates,
  listReviewQueue,
  resolveReviewItem,
  listAllSetsForExport,
  knowledgeStats,
  KnowledgeValidationError,
} from "../lib/pokemon-knowledge-store";
import {
  generateHandbookPdf,
  generateDeskSheetPdf,
  DESK_SHEET_FILENAMES,
  type DeskSheetKind,
  type HandbookSetRow,
} from "../lib/pokemon-handbook";
import { catalogueCounts, catalogueChecksum } from "@shared/pokemon-knowledge";

const knowledgeMutationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many knowledge changes. Please wait a few minutes and try again." },
});

/** Read access: admin OR any logged-in staff member (staff are read-only). */
function adminOrStaffRead(req: Request, res: Response, next: NextFunction): void {
  const session = req.session as { isAdmin?: boolean; isGrader?: boolean } | undefined;
  if (session?.isAdmin || session?.isGrader) return next();
  res.status(401).json({ error: "Authentication required" });
}

function adminEmail(req: Request): string {
  return (req.session as { adminEmail?: string }).adminEmail || "admin";
}

function fail(res: Response, err: unknown, fallback: string): void {
  if (err instanceof KnowledgeValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(`[pokemon-knowledge] ${fallback}:`, err instanceof Error ? err.message : String(err));
  res.status(500).json({ error: fallback });
}

// Per-machine PDF cache — keyed by catalogue checksum + set-directory shape.
// Regenerated when the catalogue version changes, sets change, or ?regenerate=1.
const pdfCache = new Map<string, Buffer>();

async function handbookSets(): Promise<HandbookSetRow[]> {
  const all = await listAllSetsForExport();
  return all
    .filter((s) => !s.archived)
    .map((s) => ({ setCode: s.setCode, name: s.canonicalName, year: s.year, region: s.region, language: s.language, era: s.era, status: s.status }));
}

export function registerPokemonKnowledgeRoutes(app: Express): void {
  // ── Overview (catalogue counts are code-side; set counts from DB) ───────────
  app.get("/api/admin/pokemon-knowledge/overview", adminOrStaffRead, async (_req, res) => {
    try {
      res.json({ catalogue: catalogueCounts(), ...(await knowledgeStats()) });
    } catch (err) {
      fail(res, err, "Failed to load knowledge overview.");
    }
  });

  // ── Set search + detail ──────────────────────────────────────────────────────
  app.get("/api/admin/pokemon-knowledge/sets", adminOrStaffRead, async (req, res) => {
    try {
      res.json(await searchSets(req.query as Record<string, string>));
    } catch (err) {
      fail(res, err, "Set search failed.");
    }
  });

  app.get("/api/admin/pokemon-knowledge/sets/:setKey", adminOrStaffRead, async (req, res) => {
    try {
      const detail = await getSetDetail(String(req.params.setKey), String(req.query.language ?? "en"));
      if (!detail) return res.status(404).json({ error: "Set not found." });
      res.json(detail);
    } catch (err) {
      fail(res, err, "Failed to load set detail.");
    }
  });

  // ── Canonical set create/update (admin, revisioned, audited) ────────────────
  app.post("/api/admin/pokemon-knowledge/sets", knowledgeMutationLimit, requireAdmin, async (req, res) => {
    try {
      const editor = adminEmail(req);
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 300) : null;
      const { row, created } = await upsertSetKnowledge(req.body ?? {}, editor, reason);
      await storage.writeAuditLog("pokemon_set_knowledge", `${row.setKey}:${row.language}`, created ? "create" : "update", editor, {
        canonicalName: row.canonicalName,
        version: row.version,
      });
      res.json({ ok: true, set: row, created });
    } catch (err) {
      fail(res, err, "Failed to save set.");
    }
  });

  app.post("/api/admin/pokemon-knowledge/sets/:entityKey/restore", knowledgeMutationLimit, requireAdmin, async (req, res) => {
    try {
      const editor = adminEmail(req);
      const entityKey = String(req.params.entityKey);
      const row = await restoreRevision(entityKey, Number(req.body?.revisionNumber), editor);
      await storage.writeAuditLog("pokemon_set_knowledge", entityKey, "restore", editor, {
        revisionNumber: Number(req.body?.revisionNumber),
        newVersion: row.version,
      });
      res.json({ ok: true, set: row });
    } catch (err) {
      fail(res, err, "Failed to restore revision.");
    }
  });

  // ── Imports (draft-only; approval applies) ───────────────────────────────────
  app.get("/api/admin/pokemon-knowledge/imports", adminOrStaffRead, async (_req, res) => {
    try {
      res.json(await listImportRuns());
    } catch (err) {
      fail(res, err, "Failed to list imports.");
    }
  });

  app.post("/api/admin/pokemon-knowledge/imports", knowledgeMutationLimit, requireAdmin, async (req, res) => {
    try {
      const editor = adminEmail(req);
      const source = String(req.body?.source ?? "manual").slice(0, 30);
      const run = await createImportRun(source, req.body?.records ?? [], editor, str300(req.body?.sourceReference));
      await storage.writeAuditLog("pokemon_import_run", String(run.id), "create_draft", editor, {
        source,
        records: run.recordsTotal,
      });
      res.json({ ok: true, run });
    } catch (err) {
      fail(res, err, "Failed to create import draft.");
    }
  });

  app.post("/api/admin/pokemon-knowledge/imports/starter", knowledgeMutationLimit, requireAdmin, async (req, res) => {
    try {
      const editor = adminEmail(req);
      const run = await createImportRun("starter_seed", starterSeedCandidates(), editor, "Built-in MintVault starter dataset");
      await storage.writeAuditLog("pokemon_import_run", String(run.id), "create_draft", editor, { source: "starter_seed", records: run.recordsTotal });
      res.json({ ok: true, run });
    } catch (err) {
      fail(res, err, "Failed to create starter import draft.");
    }
  });

  app.post("/api/admin/pokemon-knowledge/imports/:id/decision", knowledgeMutationLimit, requireAdmin, async (req, res) => {
    try {
      const editor = adminEmail(req);
      const decision = req.body?.decision;
      if (decision !== "approved" && decision !== "rejected") {
        return res.status(400).json({ error: "decision must be 'approved' or 'rejected'." });
      }
      const { run, applied } = await decideImportRun(Number(req.params.id), decision, editor);
      await storage.writeAuditLog("pokemon_import_run", String(run.id), decision, editor, { applied });
      pdfCache.clear(); // set directory changed
      res.json({ ok: true, run, applied });
    } catch (err) {
      fail(res, err, "Failed to record import decision.");
    }
  });

  // ── Review queue ─────────────────────────────────────────────────────────────
  app.get("/api/admin/pokemon-knowledge/review-queue", adminOrStaffRead, async (req, res) => {
    try {
      res.json(await listReviewQueue(typeof req.query.status === "string" ? req.query.status : undefined));
    } catch (err) {
      fail(res, err, "Failed to load review queue.");
    }
  });

  app.post("/api/admin/pokemon-knowledge/review-queue/:id/decision", knowledgeMutationLimit, requireAdmin, async (req, res) => {
    try {
      const editor = adminEmail(req);
      const status = req.body?.decision;
      if (!["approved", "rejected", "ignored"].includes(status)) {
        return res.status(400).json({ error: "decision must be approved, rejected or ignored." });
      }
      const row = await resolveReviewItem(Number(req.params.id), status, editor, typeof req.body?.note === "string" ? req.body.note : undefined);
      await storage.writeAuditLog("pokemon_review_queue", String(row.id), status, editor, { kind: row.kind, entityKey: row.entityKey });
      res.json({ ok: true, item: row });
    } catch (err) {
      fail(res, err, "Failed to resolve review item.");
    }
  });

  // ── Exports (admin only — catalogue + set directory, never customer data) ────
  app.get("/api/admin/pokemon-knowledge/export.json", requireAdmin, async (_req, res) => {
    try {
      const sets = await listAllSetsForExport();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="MintVault_Pokemon_Knowledge_v${catalogueCounts().version}.json"`);
      res.send(JSON.stringify({ version: catalogueCounts().version, checksum: catalogueChecksum(), catalogue: catalogueCounts(), sets }, null, 2));
    } catch (err) {
      fail(res, err, "Export failed.");
    }
  });

  app.get("/api/admin/pokemon-knowledge/export.csv", requireAdmin, async (_req, res) => {
    try {
      const sets = await listAllSetsForExport();
      const esc = (v: unknown): string => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = "set_key,language,canonical_name,set_code,series,era,region,year,main_count,secret_count,status,confidence,source_type";
      const rows = sets.map((x) =>
        [x.setKey, x.language, x.canonicalName, x.setCode, x.series, x.era, x.region, x.year, x.mainCount, x.secretCount, x.status, x.confidence, x.sourceType].map(esc).join(","),
      );
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="MintVault_Pokemon_Sets_v${catalogueCounts().version}.csv"`);
      res.send([header, ...rows].join("\n"));
    } catch (err) {
      fail(res, err, "Export failed.");
    }
  });

  // ── Handbook + desk sheets (admin; cached per catalogue+directory state) ─────
  app.get("/api/admin/pokemon-knowledge/handbook.pdf", requireAdmin, async (req, res) => {
    try {
      const sets = await handbookSets();
      const key = `handbook:${catalogueChecksum()}:${sets.length}`;
      let pdf = req.query.regenerate === "1" ? undefined : pdfCache.get(key);
      if (!pdf) {
        pdf = await generateHandbookPdf({ sets });
        pdfCache.set(key, pdf);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="MintVault_Pokemon_Identification_Guide_v${catalogueCounts().version}.pdf"`);
      res.send(pdf);
    } catch (err) {
      fail(res, err, "Failed to generate handbook.");
    }
  });

  app.get("/api/admin/pokemon-knowledge/desk-sheet/:kind.pdf", requireAdmin, async (req, res) => {
    try {
      const kind = req.params.kind as DeskSheetKind;
      if (!(kind in DESK_SHEET_FILENAMES)) return res.status(404).json({ error: "Unknown desk sheet." });
      const sets = await handbookSets();
      const key = `sheet:${kind}:${catalogueChecksum()}:${sets.length}`;
      let pdf = req.query.regenerate === "1" ? undefined : pdfCache.get(key);
      if (!pdf) {
        pdf = await generateDeskSheetPdf(kind, { sets });
        pdfCache.set(key, pdf);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${DESK_SHEET_FILENAMES[kind]}"`);
      res.send(pdf);
    } catch (err) {
      fail(res, err, "Failed to generate desk sheet.");
    }
  });
}

function str300(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, 300) : undefined;
}
