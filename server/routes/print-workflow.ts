/**
 * routes/print-workflow.ts — HTTP surface for the Approval → Printing → Printed
 * lifecycle. Mounted from server/routes.ts. All routes are requireAdmin-gated;
 * print-capable staff reach them through the existing /api/staff/print proxy
 * (which sets __graderProxy). Terminal `complete` is admin-only (staff proxy
 * whitelist excludes it AND the handler rejects proxied staff defensively).
 *
 * These endpoints own STATE + records only. The PDF bytes are still produced by
 * the untouched /api/admin/print-batch renderer; the client renders there first,
 * then calls /workflow/batch here with the same batchId to persist state.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth";
import { normalizeCertId } from "../lib/cert-id";
import { sendServerError } from "../lib/error-response";
import { canPerform, type PrintAction } from "@shared/print-lifecycle";
import {
  listPrintQueue,
  listBatches,
  getBatchDetail,
  listCertEvents,
  persistBatch,
  markBatchPrinted,
  requestReprint,
  markCompleted,
  resolveActor,
} from "../print-workflow";

const BATCH_ID_RE = /^[a-f0-9]{16}$/;

const certIdsSchema = z.object({
  certIds: z.array(z.string()).min(1).max(200),
});

const batchSchema = z.object({
  certIds: z.array(z.string()).min(1).max(48),
  batchId: z.string().regex(BATCH_ID_RE, "batchId must be the 16-hex id returned by /api/admin/print-batch"),
  kind: z.enum(["batch", "reprint"]).default("batch"),
  reason: z.string().trim().min(10).max(500).optional(),
  reasonCategory: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

const reprintSchema = z.object({
  certIds: z.array(z.string()).min(1).max(48),
  reason: z.string().trim().min(10).max(500),
  reasonCategory: z.enum(["lost_label", "damaged_print", "printer_error", "customer_replacement", "correction"]),
});

/** Guard an action against the resolved role; 403 if not permitted. */
function ensurePermission(req: Request, res: Response, action: PrintAction): boolean {
  const { role } = resolveActor(req);
  if (!canPerform(action, role)) {
    res.status(403).json({ error: `Your role (${role}) may not perform "${action}".` });
    return false;
  }
  return true;
}

export function registerPrintWorkflowRoutes(app: Express): void {
  // ── Reads ──────────────────────────────────────────────────────────────────
  app.get("/api/admin/printing/workflow/queue", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json({ rows: await listPrintQueue() });
    } catch (err) {
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/printing/workflow/batches", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json({ batches: await listBatches() });
    } catch (err) {
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/printing/workflow/batches/:batchId", requireAdmin, async (req: Request, res: Response) => {
    try {
      const detail = await getBatchDetail(String(req.params.batchId));
      if (!detail) return res.status(404).json({ error: "Batch not found" });
      res.json(detail);
    } catch (err) {
      sendServerError(res, err);
    }
  });

  app.get("/api/admin/printing/workflow/events", requireAdmin, async (req: Request, res: Response) => {
    try {
      const certId = req.query.certId ? normalizeCertId(String(req.query.certId)) : "";
      if (!certId) return res.status(400).json({ error: "certId query param required" });
      res.json({ events: await listCertEvents(certId) });
    } catch (err) {
      sendServerError(res, err);
    }
  });

  // ── Batch persist (after the renderer produced the artefacts) ───────────────
  app.post("/api/admin/printing/workflow/batch", requireAdmin, async (req: Request, res: Response) => {
    try {
      if (!ensurePermission(req, res, "create_batch")) return;
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      const { certIds, batchId, kind, reason, reasonCategory, notes } = parsed.data;
      const ids = certIds.map((c) => normalizeCertId(c));
      const identity = resolveActor(req);
      const result = await persistBatch({
        batchId,
        certIds: ids,
        kind,
        identity,
        reason: reason ?? null,
        reasonCategory: reasonCategory ?? null,
        notes: notes ?? null,
      });
      res.json({
        ...result,
        batchId,
        pdfUrl: `/api/admin/print-batch/${batchId}/pdf`,
      });
    } catch (err) {
      sendServerError(res, err);
    }
  });

  // ── Mark a batch physically printed ─────────────────────────────────────────
  app.post("/api/admin/printing/workflow/mark-printed", requireAdmin, async (req: Request, res: Response) => {
    try {
      if (!ensurePermission(req, res, "mark_printed")) return;
      const batchId = String((req.body || {}).batchId || "");
      if (!BATCH_ID_RE.test(batchId)) return res.status(400).json({ error: "Valid batchId required" });
      const result = await markBatchPrinted(batchId, resolveActor(req));
      res.json(result);
    } catch (err) {
      sendServerError(res, err);
    }
  });

  // ── Reprint request (reason + category required; duplicate protection) ──────
  app.post("/api/admin/printing/workflow/reprint", requireAdmin, async (req: Request, res: Response) => {
    try {
      if (!ensurePermission(req, res, "reprint")) return;
      const parsed = reprintSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      const ids = parsed.data.certIds.map((c) => normalizeCertId(c));
      const result = await requestReprint({
        certIds: ids,
        reason: parsed.data.reason,
        reasonCategory: parsed.data.reasonCategory,
        identity: resolveActor(req),
      });
      res.json(result);
    } catch (err) {
      sendServerError(res, err);
    }
  });

  // ── Mark completed (TERMINAL — admin only) ──────────────────────────────────
  app.post("/api/admin/printing/workflow/complete", requireAdmin, async (req: Request, res: Response) => {
    try {
      // Defence in depth: the staff proxy whitelist already excludes this path,
      // and the permission matrix denies staff_print; reject proxied staff too.
      if ((req as any).__graderProxy === true) {
        return res.status(403).json({ error: "Marking completed is restricted to admins." });
      }
      if (!ensurePermission(req, res, "complete")) return;
      const parsed = certIdsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "certIds array required" });
      const ids = parsed.data.certIds.map((c) => normalizeCertId(c));
      const result = await markCompleted({ certIds: ids, identity: resolveActor(req) });
      res.json(result);
    } catch (err) {
      sendServerError(res, err);
    }
  });
}
