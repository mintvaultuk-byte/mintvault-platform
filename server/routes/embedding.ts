/**
 * server/routes/embedding.ts
 *
 * RAG embedding and B2 cold-archive admin routes.
 * Extracted from server/routes.ts for maintainability.
 */

import type { Express } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { requireAdmin } from "../auth";
import { normalizeCertId } from "../routes";

export function registerEmbeddingRoutes(app: Express): void {
  // ── RAG Phase 0 corpus status ────────────────────────────────────────────
  // Surfaces the embed-corpus job's progress so the dashboard can show
  // "X/Y cards embedded for future retrieval system." Fail-softs to
  // sensible nulls when the embedding column doesn't exist yet (pre-
  // migration), so the dashboard panel doesn't break the whole page.
  app.get("/api/admin/embedding-status", requireAdmin, async (_req, res) => {
    try {
      const r = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL)::int           AS total_approved,
          COUNT(*) FILTER (WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL AND embedded_at IS NOT NULL)::int AS embedded_count,
          (SELECT certificate_number FROM certificates
             WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL AND embedded_at IS NULL
             ORDER BY grade_approved_at ASC NULLS LAST LIMIT 1) AS oldest_unembedded_cert_id
        FROM certificates
      `);
      const row = (r.rows[0] || {}) as any;
      const total = Number(row.total_approved || 0);
      const embedded = Number(row.embedded_count || 0);
      res.json({
        embedded_count: embedded,
        total_approved: total,
        percentage: total > 0 ? Math.round((embedded / total) * 1000) / 10 : 0,
        oldest_unembedded_cert_id: row.oldest_unembedded_cert_id || null,
      });
    } catch (err: any) {
      // Migration likely hasn't run — return a graceful "ready: false"
      // shape rather than 500'ing the whole panel.
      console.warn("[embedding-status] query failed (migration may be pending):", err?.message || err);
      res.json({
        embedded_count: 0,
        total_approved: 0,
        percentage: 0,
        oldest_unembedded_cert_id: null,
        ready: false,
        error: err?.message || "embedding column not present",
      });
    }
  });

  // ── RAG embed-corpus admin controls ──────────────────────────────────────
  let lastForceRunAtMs = 0;
  const FORCE_RUN_DEBOUNCE_MS = 60_000;

  // GET /api/admin/embed-corpus/last-run — drives the button countdown so
  // the operator can see exactly how long until the next force-run is
  // allowed.
  app.get("/api/admin/embed-corpus/last-run", requireAdmin, (_req, res) => {
    res.json({
      lastRunAtMs: lastForceRunAtMs > 0 ? lastForceRunAtMs : null,
      windowMs: FORCE_RUN_DEBOUNCE_MS,
    });
  });

  app.post("/api/admin/embed-corpus/run", requireAdmin, async (req, res) => {
    try {
      const adminEmail = req.session.adminEmail || "admin";
      const now = Date.now();
      if (now - lastForceRunAtMs < FORCE_RUN_DEBOUNCE_MS) {
        const waitSec = Math.ceil((FORCE_RUN_DEBOUNCE_MS - (now - lastForceRunAtMs)) / 1000);
        await storage.writeAuditLog("rag_corpus", "embed_corpus", "force_run", adminEmail, {
          skipped: true,
          picked: 0,
          reason: "debounced",
          waitSec,
        });
        return res.json({ ok: true, skipped: true, picked: 0, waitSec });
      }
      lastForceRunAtMs = now;
      const { runEmbedCorpusJob } = await import("../jobs/embed-corpus");
      const stats = await runEmbedCorpusJob();
      await storage.writeAuditLog("rag_corpus", "embed_corpus", "force_run", adminEmail, {
        skipped: false,
        picked: stats.picked,
        embedded: stats.embedded,
        skippedCount: stats.skipped,
        failed: stats.failed,
        reason: stats.reason || null,
      });
      return res.json({
        ok: true,
        skipped: false,
        picked: stats.picked,
        embedded: stats.embedded,
        skippedCount: stats.skipped,
        failed: stats.failed,
        reason: stats.reason || null,
      });
    } catch (err: any) {
      console.error("[embed-corpus/run] failed:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/embed-corpus/cert/:certId", requireAdmin, async (req, res) => {
    try {
      const adminEmail = req.session.adminEmail || "admin";
      const normalCertId = normalizeCertId(String(req.params.certId));
      const { generateEmbeddingForCert } = await import("../embedding-service");
      const result = await generateEmbeddingForCert(normalCertId, { force: true });
      await storage.writeAuditLog("certificate", normalCertId, "rag_force_reembed", adminEmail, {
        status: result.status,
        reason: result.reason || null,
      });
      return res.json({ ok: result.status !== "no-data", ...result });
    } catch (err: any) {
      console.error(`[embed-corpus/cert] ${req.params.certId} failed:`, err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── B2 cold-archive endpoints ───────────────────────────────────────────
  // POST /api/admin/archival/run — body: { dryRun?, batchSize?, ageDays? }
  app.post("/api/admin/archival/run", requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const dryRun = body.dryRun === true;
      const batchSizeRaw = Number(body.batchSize);
      const ageDaysRaw = Number(body.ageDays);
      const batchSize =
        Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.min(500, Math.floor(batchSizeRaw)) : 50;
      const ageDays = Number.isFinite(ageDaysRaw) && ageDaysRaw >= 0 ? Math.floor(ageDaysRaw) : 90;
      const { archiveStaleImages } = await import("../workers/r2-to-b2-archival");
      const summary = await archiveStaleImages({ dryRun, batchSize, ageDays });
      res.json(summary);
    } catch (err: any) {
      console.error("[archival-b2] manual run error:", err?.message || err);
      res.status(500).json({ error: err?.message || "archival run failed" });
    }
  });

  // GET /api/admin/archival/status — pending / archived / recent failures
  app.get("/api/admin/archival/status", requireAdmin, async (_req, res) => {
    try {
      const ageDaysParam = 90; // matches the cron's default
      const counts = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE grade_approved_at < NOW() - (${ageDaysParam}::int * INTERVAL '1 day')
              AND deleted_at IS NULL AND archived_to_b2_at IS NULL
          )::int AS pending,
          COUNT(*) FILTER (WHERE archived_to_b2_at IS NOT NULL)::int AS archived,
          COUNT(*) FILTER (
            WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL
          )::int AS total_eligible
        FROM certificates
      `);
      const row = counts.rows[0] as { pending: number; archived: number; total_eligible: number };

      // Last 20 failures from audit_log (action='archive_failed')
      const failuresRows = await db.execute(sql`
        SELECT entity_id AS cert_id, details, created_at
        FROM audit_log
        WHERE entity_type = 'certificate' AND action = 'archive_failed'
        ORDER BY created_at DESC
        LIMIT 20
      `);

      res.json({
        age_days_threshold: ageDaysParam,
        pending: row?.pending ?? 0,
        archived: row?.archived ?? 0,
        total_eligible: row?.total_eligible ?? 0,
        recent_failures: failuresRows.rows.map((r: any) => ({
          cert_id: r.cert_id,
          created_at: r.created_at,
          details: r.details,
        })),
      });
    } catch (err: any) {
      console.error("[archival-b2] status error:", err?.message || err);
      res.status(500).json({ error: err?.message || "archival status query failed" });
    }
  });
}
