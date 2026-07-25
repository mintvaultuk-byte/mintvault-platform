import { sendServerError } from "../lib/error-response";
import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import { storage } from "../storage";
import { requireAdmin } from "../auth";
import { uploadToR2 } from "../r2";
import { db } from "../db";
import { sql, inArray } from "drizzle-orm";
import { lookupCard, isAllowedLang } from "../services/tcgdex";
import { importTcgdexSets, isTcgdexImportRunning } from "../services/tcgdex-sets-import";
import { resolveEnglishSetByNameAndNumber } from "../services/tcgdex-set-resolve";
import { COLLECTOR_NUMBER_RE } from "../services/collector-number";
import { getFeatureFlag } from "../config/feature-flags";
import { normalizeCertId } from "../lib/cert-id";
import {
  listSetLibrary,
  recordSetReviewDecision,
  SetLibraryError,
  updateSetLibraryRecord,
} from "../services/set-library";

const adminCustomSetEditLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many set edit attempts. Please wait a few minutes and try again." },
});

const adminSetLibraryMutationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many set library changes. Please wait a few minutes and try again." },
});

function sendSetLibraryError(res: Response, err: unknown): void {
  if (err instanceof SetLibraryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("[set-library] request failed:", err instanceof Error ? err.message : String(err));
  res.status(500).json({ error: "Set library request failed" });
}

export function registerAdminConfigRoutes(app: Express): void {
  app.get("/api/admin/sets", requireAdmin, async (req, res) => {
    try {
      res.json(await listSetLibrary(req.query));
    } catch (err) {
      sendSetLibraryError(res, err);
    }
  });

  app.patch("/api/admin/sets/:source/:setId", adminSetLibraryMutationLimit, requireAdmin, async (req, res) => {
    try {
      const actor = { id: (req.session as { adminEmail?: string }).adminEmail || "admin", role: "admin" as const };
      res.json(await updateSetLibraryRecord(req.params.source, req.params.setId, req.body || {}, actor));
    } catch (err) {
      sendSetLibraryError(res, err);
    }
  });

  app.post("/api/admin/sets/:source/:setId/review", adminSetLibraryMutationLimit, requireAdmin, async (req, res) => {
    try {
      const actor = { id: (req.session as { adminEmail?: string }).adminEmail || "admin", role: "admin" as const };
      res.json(
        await recordSetReviewDecision(
          req.params.source,
          req.params.setId,
          req.body?.suggestionKey,
          req.body?.decision,
          req.body?.reason,
          actor
        )
      );
    } catch (err) {
      sendSetLibraryError(res, err);
    }
  });

  app.get("/api/admin/db-info", requireAdmin, async (_req, res) => {
    try {
      const { getDatabaseUrl } = await import("../config");
      const dbUrl = getDatabaseUrl();
      let neonHost = "";
      let dbName = "";
      try {
        const parsed = new URL(dbUrl);
        neonHost = parsed.hostname;
        dbName = parsed.pathname.replace(/^\//, "");
      } catch {}

      const timeResult = await db.execute(sql`SELECT NOW() AS server_time`);
      const serverTime = timeResult.rows[0]?.server_time;

      const cmResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM card_master WHERE is_deleted = false`);
      const cardMasterActive = parseInt((cmResult.rows[0]?.cnt as string) || "0", 10);

      const csResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM card_sets WHERE is_deleted = false`);
      const cardSetsActive = parseInt((csResult.rows[0]?.cnt as string) || "0", 10);

      const certResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM certificates WHERE deleted_at IS NULL`);
      const certificatesCount = parseInt((certResult.rows[0]?.cnt as string) || "0", 10);

      const voidedResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM certificates WHERE status = 'voided'`);
      const voidedCount = parseInt((voidedResult.rows[0]?.cnt as string) || "0", 10);

      const lastIssued = await storage.getLastIssuedMvNumber();

      res.json({
        env: process.env.NODE_ENV || "development",
        host: neonHost,
        database: dbName,
        source: "MINTVAULT_DATABASE_URL",
        server_time: serverTime,
        card_master_active_count: cardMasterActive,
        card_sets_active_count: cardSetsActive,
        certificates_count: certificatesCount,
        voided_count: voidedCount,
        last_issued_mv: lastIssued.mvNumber,
        last_issued_seq: lastIssued.lastIssued,
      });
    } catch (error: any) {
      console.error("DB info error:", error.message);
      res.status(500).json({ error: "Failed to get DB info" });
    }
  });

  app.post("/api/admin/backup-card-master", requireAdmin, async (req, res) => {
    try {
      const result = await db.execute(sql`SELECT * FROM card_master WHERE is_deleted = false ORDER BY id`);
      const rows = result.rows as any[];

      if (rows.length === 0) {
        return res.json({ success: true, message: "No active card_master rows to back up", rowCount: 0 });
      }

      const headers = Object.keys(rows[0]);
      const csvLines = [headers.join(",")];
      for (const row of rows) {
        csvLines.push(
          headers
            .map((h) => {
              const val = row[h];
              if (val === null || val === undefined) return "";
              const str = String(val);
              return str.includes(",") || str.includes('"') || str.includes("\n")
                ? `"${str.replace(/"/g, '""')}"`
                : str;
            })
            .join(",")
        );
      }
      const csvContent = csvLines.join("\n");

      const now = new Date();
      const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const r2Key = `backups/card_master_${dateStr}.csv`;

      await uploadToR2(r2Key, Buffer.from(csvContent, "utf-8"), "text/csv");

      await storage.writeAuditLog("backup", "card_master", "backup_created", req.session.adminEmail || "admin", {
        r2Key,
        rowCount: rows.length,
        timestamp: now.toISOString(),
      });

      res.json({ success: true, r2Key, rowCount: rows.length, timestamp: now.toISOString() });
    } catch (error: any) {
      console.error("Backup error:", error.message);
      res.status(500).json({ error: "Failed to create backup" });
    }
  });

  app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
    try {
      const stats = await storage.getDashboardStats();
      stats.recentCerts = stats.recentCerts.map((c: any) => ({ ...c, certId: normalizeCertId(c.certId) }));
      res.json(stats);
    } catch (error: any) {
      console.error("Stats error:", error.message, error.stack);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  app.get("/api/admin/service-tiers", requireAdmin, async (_req, res) => {
    try {
      const tiers = await storage.getServiceTiers();
      res.json(tiers);
    } catch (error: any) {
      console.error("Admin service tiers error:", error.message);
      res.status(500).json({ error: "Failed to fetch service tiers" });
    }
  });

  app.put("/api/admin/service-tiers/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid tier ID" });

      const { pricePerCard, turnaroundDays, maxValueGbp, isActive, features } = req.body;

      const parsedPrice = pricePerCard !== undefined ? parseInt(pricePerCard, 10) : undefined;
      const parsedTurnaround = turnaroundDays !== undefined ? parseInt(turnaroundDays, 10) : undefined;
      const parsedMaxValue = maxValueGbp !== undefined ? parseInt(maxValueGbp, 10) : undefined;

      if (
        (parsedPrice !== undefined && (isNaN(parsedPrice) || parsedPrice < 1)) ||
        (parsedTurnaround !== undefined && (isNaN(parsedTurnaround) || parsedTurnaround < 1)) ||
        (parsedMaxValue !== undefined && (isNaN(parsedMaxValue) || parsedMaxValue < 0))
      ) {
        return res
          .status(400)
          .json({ error: "Invalid numeric values. Price and turnaround must be positive integers." });
      }

      const updated = await storage.updateServiceTier(id, {
        pricePerCard: parsedPrice,
        turnaroundDays: parsedTurnaround,
        maxValueGbp: parsedMaxValue,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        features: features !== undefined ? features : undefined,
      });

      if (!updated) return res.status(404).json({ error: "Tier not found" });

      await storage.writeAuditLog("service_tier", String(id), "update", req.session.adminEmail || "admin", {
        pricePerCard,
        turnaroundDays,
        maxValueGbp,
        isActive,
      });

      res.json(updated);
    } catch (error: any) {
      console.error("Update service tier error:", error.message);
      res.status(500).json({ error: "Failed to update service tier" });
    }
  });

  // ── Tier capacity management ──────────────────────────────────────────────

  app.get("/api/admin/capacity", requireAdmin, async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT tc.*,
          (SELECT COUNT(*) FROM submissions s
           WHERE s.service_tier = tc.tier_id
             AND s.status IN ('new', 'received', 'in_grading')
             AND s.deleted_at IS NULL
          ) AS current_queue_count
        FROM tier_capacity tc
        ORDER BY tc.tier_id
      `);
      res.json(result.rows);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  app.put("/api/admin/capacity/:tierId", requireAdmin, async (req, res) => {
    try {
      const { tierId } = req.params;
      const { status, paused_until, paused_message, max_concurrent } = req.body;

      if (status && !["open", "paused", "waitlist"].includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be open, paused, or waitlist." });
      }

      await db.execute(sql`
        UPDATE tier_capacity SET
          status = COALESCE(${status || null}, status),
          paused_until = ${paused_until || null},
          paused_message = ${paused_message || null},
          max_concurrent = COALESCE(${max_concurrent ? Number(max_concurrent) : null}, max_concurrent),
          paused_at = ${status === "paused" || status === "waitlist" ? sql`NOW()` : sql`paused_at`},
          paused_by = ${status === "paused" || status === "waitlist" ? (req.session as any)?.adminEmail || "admin" : sql`paused_by`},
          updated_at = NOW()
        WHERE tier_id = ${tierId}
      `);

      console.log(
        `[capacity] tier ${tierId} → ${status || "updated"} by ${(req.session as any)?.adminEmail || "admin"}`
      );
      res.json({ ok: true });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/capacity/pause-all", requireAdmin, async (req, res) => {
    try {
      const message = req.body.message || "Submissions temporarily paused";
      await db.execute(sql`
        UPDATE tier_capacity SET
          status = 'paused',
          paused_message = ${message},
          paused_at = NOW(),
          paused_by = ${(req.session as any)?.adminEmail || "admin"},
          updated_at = NOW()
      `);
      console.log(`[capacity] ALL TIERS PAUSED by ${(req.session as any)?.adminEmail || "admin"}`);
      res.json({ ok: true });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/capacity/resume-all", requireAdmin, async (req, res) => {
    try {
      await db.execute(sql`
        UPDATE tier_capacity SET status = 'open', paused_until = NULL, paused_message = NULL, updated_at = NOW()
      `);
      console.log(`[capacity] ALL TIERS RESUMED by ${(req.session as any)?.adminEmail || "admin"}`);
      res.json({ ok: true });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── Variant + rarity options ──────────────────────────────────────────────

  app.get("/api/admin/variant-options", requireAdmin, async (_req, res) => {
    try {
      const variants = await storage.getDistinctVariants();
      res.json(variants);
    } catch {
      res.status(500).json({ error: "Failed to fetch variant options" });
    }
  });

  app.get("/api/admin/rarity-other-options", requireAdmin, async (_req, res) => {
    try {
      const values = await storage.getDistinctRarityOthers();
      res.json(values);
    } catch {
      res.status(500).json({ error: "Failed to fetch rarity other options" });
    }
  });

  // ── Custom sets CRUD ────────────────────────────────────────────────────────

  app.post("/api/admin/custom-sets", requireAdmin, async (req, res) => {
    try {
      const { setId, setName, series, ptcgoCode, releaseDate, totalCards, notes } = req.body;
      if (!setId || !setName) return res.status(400).json({ error: "setId and setName required" });
      await db.execute(sql`
        INSERT INTO custom_sets (set_id, set_name, series, ptcgo_code, release_date, total_cards, notes, created_by)
        VALUES (${setId}, ${setName}, ${series || null}, ${ptcgoCode || null}, ${releaseDate || null}, ${totalCards || null}, ${notes || null}, ${(req.session as any)?.adminEmail || "admin"})
      `);
      console.log(`[custom-set] added "${setId}" — ${setName}`);
      res.json({ ok: true, setId, setName });
    } catch (err: any) {
      const pgCode = err.code || err.cause?.code;
      if (pgCode === "23505") return res.status(409).json({ error: `Set "${req.body.setId}" already exists` });
      console.error("[custom-set] insert failed:", err);
      res.status(500).json({ error: "Couldn't add set — check server logs" });
    }
  });

  app.patch("/api/admin/custom-sets/:setId", requireAdmin, adminCustomSetEditLimit, async (req, res) => {
    try {
      const adminUser = (req.session as { adminEmail?: string })?.adminEmail || "admin";
      const result = await updateSetLibraryRecord("custom", String(req.params.setId), req.body || {}, {
        id: adminUser,
        role: "admin",
      });
      return res.json(result);
    } catch (err: unknown) {
      return sendSetLibraryError(res, err);
    }
  });

  app.delete("/api/admin/custom-sets/:setId", requireAdmin, async (req, res) => {
    try {
      await db.execute(sql`DELETE FROM custom_sets WHERE set_id = ${req.params.setId}`);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[custom-set] delete failed:", err);
      res.status(500).json({ error: "Couldn't delete set — check server logs" });
    }
  });

  // ── TCGdex set-catalogue import (admin-triggered, runs in the background) ─────
  // The import is ~209 rate-limited TCGdex calls (~3.5 min) — too long for a sync
  // request (fly proxy would time out) — so kick it off and return 202. Idempotent
  // UPSERT (safe to re-run, no deletes). Poll GET …/status for the row count.
  app.post("/api/admin/tcgdex-sets/import", requireAdmin, async (req, res) => {
    if (isTcgdexImportRunning()) return res.status(409).json({ error: "A TCGdex set import is already running" });
    const adminUser = (req.session as any)?.adminEmail || "admin";
    void importTcgdexSets()
      .then((s) => console.log(`[tcgdex-import] (admin ${adminUser}) ${JSON.stringify(s)}`))
      .catch((e) => console.error(`[tcgdex-import] (admin ${adminUser}) failed: ${e.message}`));
    await storage.writeAuditLog("tcgdex_sets", "import", "tcgdex_sets_import_started", adminUser, {});
    return res.status(202).json({
      ok: true,
      started: true,
      message: "TCGdex set import started (~2–4 min). Poll /api/admin/tcgdex-sets/status.",
    });
  });

  app.get("/api/admin/tcgdex-sets/status", requireAdmin, async (_req, res) => {
    try {
      const r = await db.execute(sql`SELECT COUNT(*)::int AS n, MAX(synced_at) AS last FROM tcgdex_sets`);
      const row = r.rows[0] as any;
      return res.json({
        running: isTcgdexImportRunning(),
        count: Number(row?.n || 0),
        lastSyncedAt: row?.last || null,
      });
    } catch (e: any) {
      return sendServerError(res, e);
    }
  });

  // ── AI feature flags (DB-backed runtime overrides) ───────────────────────

  app.get("/api/admin/ai-feature-flags", requireAdmin, async (_req, res) => {
    try {
      const { getAllAiFlags, AI_FLAG_NAMES } = await import("../config/feature-flags");
      const { featureOverrides } = await import("@shared/schema");
      const flags = await getAllAiFlags();

      const meta = await db
        .select({
          name: featureOverrides.name,
          updatedAt: featureOverrides.updatedAt,
          updatedBy: featureOverrides.updatedBy,
          reason: featureOverrides.reason,
        })
        .from(featureOverrides)
        .where(inArray(featureOverrides.name, AI_FLAG_NAMES as unknown as string[]));
      const metaByName = new Map<string, any>();
      for (const r of meta) metaByName.set(r.name, r);

      res.json({
        flags: flags.map((f) => ({
          ...f,
          updatedAt: metaByName.get(f.name)?.updatedAt || null,
          updatedBy: metaByName.get(f.name)?.updatedBy || null,
          reason: metaByName.get(f.name)?.reason || null,
        })),
      });
    } catch (err: any) {
      console.error("[ai-feature-flags] GET failed:", err);
      sendServerError(res, err);
    }
  });

  app.post("/api/admin/ai-feature-flags", requireAdmin, async (req, res) => {
    try {
      const { AI_FLAG_NAMES, invalidateFeatureFlagCache } = await import("../config/feature-flags");
      const { name, enabled, reason } = req.body || {};
      if (!AI_FLAG_NAMES.includes(name)) {
        return res.status(400).json({ error: "Unknown flag name" });
      }
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be boolean" });
      }
      const adminEmail = req.session.adminEmail || "admin";
      await db.execute(sql`
        INSERT INTO feature_overrides (name, enabled, updated_at, updated_by, reason)
        VALUES (${name}, ${enabled}, NOW(), ${adminEmail}, ${reason || null})
        ON CONFLICT (name) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by,
          reason = EXCLUDED.reason
      `);
      invalidateFeatureFlagCache();
      await storage.writeAuditLog("feature_flag", name, "override_set", adminEmail, {
        enabled,
        reason: reason || null,
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[ai-feature-flags] POST failed:", err);
      sendServerError(res, err);
    }
  });

  app.delete("/api/admin/ai-feature-flags/:name", requireAdmin, async (req, res) => {
    try {
      const { AI_FLAG_NAMES, invalidateFeatureFlagCache } = await import("../config/feature-flags");
      const name = String(req.params.name);
      if (!AI_FLAG_NAMES.includes(name as any)) {
        return res.status(400).json({ error: "Unknown flag name" });
      }
      const adminEmail = req.session.adminEmail || "admin";
      await db.execute(sql`DELETE FROM feature_overrides WHERE name = ${name}`);
      invalidateFeatureFlagCache();
      await storage.writeAuditLog("feature_flag", name, "override_cleared", adminEmail, {});
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[ai-feature-flags] DELETE failed:", err);
      sendServerError(res, err);
    }
  });

  // ── AI dashboard stats ────────────────────────────────────────────────────

  app.get("/api/admin/ai-dashboard-stats", requireAdmin, async (_req, res) => {
    try {
      const top = await db.execute(sql`
        SELECT
          COUNT(*)::int                                                     AS total_graded,
          COUNT(*) FILTER (WHERE DATE_TRUNC('month', grade_approved_at) = DATE_TRUNC('month', NOW()))::int AS this_month,
          ROUND(AVG(grade)::numeric, 2)                                     AS average_grade,
          ROUND(AVG(grading_time_seconds)::numeric, 0)::int                 AS avg_time_seconds,
          COUNT(*) FILTER (WHERE grade_strength_score >= 96)::int           AS pristine_10p_count
        FROM certificates
        WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL
      `);
      const topRow = top.rows[0] || {};

      const dist = await db.execute(sql`
        SELECT grade::text AS grade, COUNT(*)::int AS count
        FROM certificates
        WHERE grade_approved_at IS NOT NULL AND deleted_at IS NULL AND grade IS NOT NULL
        GROUP BY grade
        ORDER BY grade DESC
      `);

      const activity = await db.execute(sql`
        SELECT TO_CHAR(d::date, 'YYYY-MM-DD') AS day,
               COALESCE(c.cnt, 0)::int AS count
        FROM generate_series(NOW() - INTERVAL '29 days', NOW(), INTERVAL '1 day') AS d
        LEFT JOIN (
          SELECT DATE(grade_approved_at) AS day, COUNT(*)::int AS cnt
          FROM certificates
          WHERE grade_approved_at >= NOW() - INTERVAL '30 days'
            AND deleted_at IS NULL
          GROUP BY day
        ) c ON DATE(d) = c.day
        ORDER BY day
      `);

      const accuracy = await db.execute(sql`
        WITH preds AS (
          SELECT
            p.cert_id,
            COALESCE(
              (p.prediction->>'overall_grade')::numeric,
              (p.prediction->>'overall')::numeric
            ) AS predicted,
            c.grade::numeric AS actual
          FROM ai_predictions p
          JOIN certificates c ON c.certificate_number = p.cert_id
          WHERE p.call_type IN ('full_grade', 'quick_grade')
            AND c.grade_approved_at IS NOT NULL
            AND c.deleted_at IS NULL
            AND c.grade IS NOT NULL
        )
        SELECT
          (SELECT COUNT(*) FROM ai_predictions WHERE call_type IN ('full_grade','quick_grade'))::int AS prediction_count,
          COUNT(*)::int                                                                        AS approved_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE predicted = actual) / NULLIF(COUNT(*), 0), 1)   AS exact_agreement_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ABS(predicted - actual) <= 0.5) / NULLIF(COUNT(*), 0), 1) AS within_half_point_pct,
          ROUND(AVG(ABS(predicted - actual))::numeric, 2)                                      AS mean_absolute_error
        FROM preds
        WHERE predicted IS NOT NULL
      `);
      const accRow = (accuracy.rows[0] as any) || {};
      const approvedCount = Number(accRow.approved_count || 0);
      const aiAccuracy =
        approvedCount >= 30
          ? {
              prediction_count: Number(accRow.prediction_count || 0),
              approved_count: approvedCount,
              exact_agreement_pct: accRow.exact_agreement_pct != null ? Number(accRow.exact_agreement_pct) : null,
              within_half_point_pct: accRow.within_half_point_pct != null ? Number(accRow.within_half_point_pct) : null,
              mean_absolute_error: accRow.mean_absolute_error != null ? Number(accRow.mean_absolute_error) : null,
            }
          : {
              prediction_count: Number(accRow.prediction_count || 0),
              approved_count: approvedCount,
              exact_agreement_pct: null,
              within_half_point_pct: null,
              mean_absolute_error: null,
            };

      res.json({
        total_graded: Number(topRow.total_graded || 0),
        this_month: Number(topRow.this_month || 0),
        average_grade: topRow.average_grade != null ? Number(topRow.average_grade) : null,
        avg_time_seconds: topRow.avg_time_seconds != null ? Number(topRow.avg_time_seconds) : null,
        grade_distribution: dist.rows,
        pristine_10p_count: Number(topRow.pristine_10p_count || 0),
        ai_accuracy: aiAccuracy,
        last_30_days: activity.rows,
      });
    } catch (err: any) {
      console.error("[ai-dashboard-stats] failed:", err);
      sendServerError(res, err);
    }
  });

  // ── AI divergence ─────────────────────────────────────────────────────────

  app.get("/api/admin/ai-divergence", requireAdmin, async (req, res) => {
    try {
      const sinceDays =
        req.query.sinceDays == null || req.query.sinceDays === ""
          ? 30
          : Math.max(1, parseInt(String(req.query.sinceDays), 10) || 30);

      const callTypeRaw = req.query.callType ? String(req.query.callType) : null;
      const callType = callTypeRaw === "haiku_quick_grade" ? "quick_grade" : callTypeRaw;
      const callTypeClause =
        callType === "full_grade" || callType === "quick_grade"
          ? sql` AND p.call_type = ${callType}`
          : sql` AND p.call_type IN ('full_grade', 'quick_grade')`;

      const rowsRes = await db.execute(sql`
        WITH latest_pred AS (
          SELECT DISTINCT ON (p.cert_id)
            p.cert_id,
            p.model,
            p.call_type,
            p.created_at AS prediction_at,
            COALESCE(
              (p.prediction->>'overall_grade')::numeric,
              (p.prediction->>'overall')::numeric
            ) AS ai_overall,
            (p.prediction->'centering'->>'subgrade')::numeric AS ai_centering,
            (p.prediction->'corners'  ->>'subgrade')::numeric AS ai_corners,
            (p.prediction->'edges'    ->>'subgrade')::numeric AS ai_edges,
            (p.prediction->'surface'  ->>'subgrade')::numeric AS ai_surface
          FROM ai_predictions p
          WHERE 1 = 1
            ${callTypeClause}
          ORDER BY p.cert_id, p.created_at DESC
        )
        SELECT
          c.certificate_number AS cert_id,
          c.card_name,
          c.grade_approved_at,
          lp.model,
          lp.call_type,
          lp.prediction_at,
          lp.ai_overall, lp.ai_centering, lp.ai_corners, lp.ai_edges, lp.ai_surface,
          c.grade::numeric           AS human_overall,
          c.centering_score::numeric AS human_centering,
          c.corners_score::numeric   AS human_corners,
          c.edges_score::numeric     AS human_edges,
          c.surface_score::numeric   AS human_surface
        FROM latest_pred lp
        JOIN certificates c ON c.certificate_number = lp.cert_id
        WHERE c.grade_approved_at IS NOT NULL
          AND c.grade IS NOT NULL
          AND c.deleted_at IS NULL
          AND c.grade_approved_at >= NOW() - (${sinceDays} || ' days')::interval
        ORDER BY c.grade_approved_at DESC
      `);

      const ZONES = ["overall", "centering", "corners", "edges", "surface"] as const;
      type Zone = (typeof ZONES)[number];

      type CertRow = {
        cert_id: string;
        card_name: string | null;
        approved_at: string | null;
        model: string;
        call_type: string;
        prediction_at: string | null;
        grades: Record<Zone, { ai: number | null; human: number | null; divergence: number | null }>;
        max_zone_divergence: number;
        any_field_missing: boolean;
      };

      const certs: CertRow[] = (rowsRes.rows as any[]).map((r) => {
        const grades: CertRow["grades"] = {} as any;
        let maxAbs = 0;
        let anyMissing = false;
        for (const z of ZONES) {
          const ai = r["ai_" + z] != null ? Number(r["ai_" + z]) : null;
          const human = r["human_" + z] != null ? Number(r["human_" + z]) : null;
          const div = ai != null && human != null ? Math.round((ai - human) * 100) / 100 : null;
          if (div != null && Math.abs(div) > maxAbs) maxAbs = Math.abs(div);
          if (ai == null) anyMissing = true;
          grades[z] = { ai, human, divergence: div };
        }
        return {
          cert_id: String(r.cert_id),
          card_name: r.card_name ?? null,
          approved_at: r.grade_approved_at ? new Date(r.grade_approved_at).toISOString() : null,
          model: String(r.model || ""),
          call_type: String(r.call_type || ""),
          prediction_at: r.prediction_at ? new Date(r.prediction_at).toISOString() : null,
          grades,
          max_zone_divergence: maxAbs,
          any_field_missing: anyMissing,
        };
      });

      function zoneStats(divs: number[]) {
        if (divs.length === 0)
          return {
            n: 0,
            mean_divergence: null,
            median_divergence: null,
            stddev: null,
            ai_too_generous_pct: null,
            ai_too_harsh_pct: null,
            exact_match_pct: null,
          };
        const sorted = [...divs].sort((a, b) => a - b);
        const n = divs.length;
        const mean = divs.reduce((a, b) => a + b, 0) / n;
        const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        const variance = divs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
        const stddev = Math.sqrt(variance);
        const generous = divs.filter((d) => d > 0).length;
        const harsh = divs.filter((d) => d < 0).length;
        const exact = divs.filter((d) => d === 0).length;
        return {
          n,
          mean_divergence: Math.round(mean * 100) / 100,
          median_divergence: Math.round(median * 100) / 100,
          stddev: Math.round(stddev * 100) / 100,
          ai_too_generous_pct: Math.round((generous / n) * 100),
          ai_too_harsh_pct: Math.round((harsh / n) * 100),
          exact_match_pct: Math.round((exact / n) * 100),
        };
      }

      const by_zone: Record<Zone, ReturnType<typeof zoneStats>> = {} as any;
      for (const z of ZONES) {
        by_zone[z] = zoneStats(certs.map((c) => c.grades[z].divergence).filter((d): d is number => d != null));
      }

      const bandKey = (g: number | null): string | null => {
        if (g == null) return null;
        if (g === 10) return "10";
        if (g >= 9.5) return "9.5-9.9";
        if (g === 9) return "9";
        if (g === 8) return "8";
        if (g < 8) return "below 8";
        return null;
      };
      const bands: Record<string, number[]> = { "10": [], "9.5-9.9": [], "9": [], "8": [], "below 8": [] };
      for (const c of certs) {
        const k = bandKey(c.grades.overall.human);
        const d = c.grades.overall.divergence;
        if (k && d != null) bands[k].push(d);
      }
      const by_grade_band: Record<string, { n: number; mean_overall_divergence: number | null }> = {};
      for (const [k, divs] of Object.entries(bands)) {
        by_grade_band[k] =
          divs.length === 0
            ? { n: 0, mean_overall_divergence: null }
            : {
                n: divs.length,
                mean_overall_divergence: Math.round((divs.reduce((a, b) => a + b, 0) / divs.length) * 100) / 100,
              };
      }

      const byModelMap = new Map<string, number[]>();
      for (const c of certs) {
        const d = c.grades.overall.divergence;
        if (d == null) continue;
        if (!byModelMap.has(c.model)) byModelMap.set(c.model, []);
        byModelMap.get(c.model)!.push(d);
      }
      const by_model: Record<string, { n: number; mean_overall_divergence: number | null }> = {};
      for (const [model, divs] of byModelMap.entries()) {
        by_model[model] = {
          n: divs.length,
          mean_overall_divergence: Math.round((divs.reduce((a, b) => a + b, 0) / divs.length) * 100) / 100,
        };
      }

      certs.sort((a, b) => b.max_zone_divergence - a.max_zone_divergence);

      res.json({
        generated_at: new Date().toISOString(),
        sample_size: certs.length,
        summary: { by_zone, by_grade_band, by_model },
        certs,
      });
    } catch (err: any) {
      console.error("[ai-divergence] failed:", err);
      sendServerError(res, err);
    }
  });

  // ── AI Capture Health dashboard ──────────────────────────────────────────

  app.get("/api/admin/ai-capture-health", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10) || 25));
      const onlyFailing = String(req.query.onlyFailing ?? "false") === "true";
      const sinceDaysRaw = req.query.sinceDays;
      const sinceDays =
        sinceDaysRaw == null || sinceDaysRaw === "" ? null : Math.max(1, parseInt(String(sinceDaysRaw), 10) || 0);

      const sinceClause = sinceDays
        ? sql` AND grade_approved_at >= NOW() - (${sinceDays} || ' days')::interval`
        : sql``;

      const certRows = await db.execute(sql`
        SELECT
          certificate_number AS cert_id,
          grade_approved_at,
          card_name, set_name, card_number_display, rarity, year_text,
          grade::numeric AS grade_overall,
          centering_score, corners_score, edges_score, surface_score,
          defects, label_type,
          grading_front_original, grading_back_original,
          grading_time_seconds,
          embedded_at,
          (embedding IS NOT NULL) AS has_embedding
        FROM certificates
        WHERE grade_approved_at IS NOT NULL
          AND deleted_at IS NULL
          ${sinceClause}
        ORDER BY grade_approved_at DESC
        LIMIT ${limit}
      `);
      const certs = certRows.rows as any[];

      if (certs.length === 0) {
        return res.json({
          generated_at: new Date().toISOString(),
          summary: { total_checked: 0, fully_green: 0, any_red: 0, any_amber: 0, by_field: {} },
          certs: [],
        });
      }

      const certIds = certs.map((c) => String(c.cert_id));

      const predRows = await db.execute(sql`
        SELECT cert_id, COUNT(*)::int AS cnt
        FROM ai_predictions
        WHERE cert_id IN (${sql.join(
          certIds.map((id) => sql`${id}`),
          sql`, `
        )})
        GROUP BY cert_id
      `);
      const predCounts = new Map<string, number>();
      for (const r of predRows.rows as any[]) predCounts.set(String(r.cert_id), Number(r.cnt));

      const auditRows = await db.execute(sql`
        SELECT entity_id, ARRAY_AGG(DISTINCT action) AS actions
        FROM audit_log
        WHERE entity_type = 'certificate'
          AND entity_id IN (${sql.join(
            certIds.map((id) => sql`${id}`),
            sql`, `
          )})
          AND action IN ('grade_approved','approved','metadata_backfill','CERT_ID_ALLOCATED','OWNER_ASSIGNED','approve_grade','approve_and_publish')
        GROUP BY entity_id
      `);
      const auditActions = new Map<string, string[]>();
      for (const r of auditRows.rows as any[]) auditActions.set(String(r.entity_id), r.actions || []);

      type CheckStatus = "green" | "amber" | "red";
      const FIELD_KEYS = [
        "card_metadata",
        "grade_fields",
        "defects",
        "images",
        "grading_time",
        "embedding",
        "ai_predictions",
        "audit_log",
      ] as const;
      type FieldKey = (typeof FIELD_KEYS)[number];

      const byField: Record<FieldKey, { green: number; amber: number; red: number }> = Object.fromEntries(
        FIELD_KEYS.map((k) => [k, { green: 0, amber: 0, red: 0 }])
      ) as any;

      const isEmpty = (v: unknown): boolean => v == null || (typeof v === "string" && v.trim() === "");
      const now = Date.now();

      const out = certs.map((cert) => {
        const certId = String(cert.cert_id);

        const metaMissing: string[] = [];
        for (const f of ["card_name", "set_name", "card_number_display", "rarity", "year_text"]) {
          if (isEmpty(cert[f])) metaMissing.push(f);
        }
        const cardMetadata = {
          status: (metaMissing.length === 0 ? "green" : "red") as CheckStatus,
          missing: metaMissing.length ? metaMissing : null,
        };

        const gradeMissing: string[] = [];
        if (cert.grade_overall == null) gradeMissing.push("grade_overall");
        if (cert.centering_score == null) gradeMissing.push("grade_centering");
        if (cert.corners_score == null) gradeMissing.push("grade_corners");
        if (cert.edges_score == null) gradeMissing.push("grade_edges");
        if (cert.surface_score == null) gradeMissing.push("grade_surface");
        const gradeFields = {
          status: (gradeMissing.length === 0 ? "green" : "red") as CheckStatus,
          missing: gradeMissing.length ? gradeMissing : null,
        };

        const defectsArr = Array.isArray(cert.defects) ? cert.defects : [];
        const isPerfect = Number(cert.grade_overall) === 10 || cert.label_type === "black";
        let defects: { status: CheckStatus; note: string | null };
        if (defectsArr.length > 0) {
          defects = { status: "green", note: null };
        } else if (isPerfect) {
          defects = {
            status: "green",
            note: `intentional zero (grade=${cert.grade_overall ?? "10"}${cert.label_type === "black" ? "/black" : ""})`,
          };
        } else {
          defects = { status: "red", note: null };
        }

        const imgMissing: string[] = [];
        if (isEmpty(cert.grading_front_original)) imgMissing.push("grading_front_original");
        else if (
          typeof cert.grading_front_original === "string" &&
          !cert.grading_front_original.startsWith("images/")
        ) {
          imgMissing.push(
            `grading_front_original looks like a URL not an R2 key (${String(cert.grading_front_original).slice(0, 32)}…)`
          );
        }
        if (isEmpty(cert.grading_back_original)) imgMissing.push("grading_back_original");
        const images = {
          status: (imgMissing.length === 0 ? "green" : "red") as CheckStatus,
          missing: imgMissing.length ? imgMissing : null,
        };

        const gt = Number(cert.grading_time_seconds);
        const grading_time =
          Number.isFinite(gt) && gt > 0
            ? { status: "green" as CheckStatus, value_seconds: gt }
            : { status: "red" as CheckStatus, value_seconds: null };

        const minsSinceApproved = cert.grade_approved_at
          ? Math.floor((now - new Date(cert.grade_approved_at).getTime()) / 60_000)
          : null;
        let embedding: { status: CheckStatus; embedded_at: string | null; minutes_since_approved: number | null };
        if (cert.embedded_at && cert.has_embedding) {
          embedding = {
            status: "green",
            embedded_at: new Date(cert.embedded_at).toISOString(),
            minutes_since_approved: minsSinceApproved,
          };
        } else if (minsSinceApproved != null && minsSinceApproved < 120) {
          embedding = { status: "amber", embedded_at: null, minutes_since_approved: minsSinceApproved };
        } else {
          embedding = { status: "red", embedded_at: null, minutes_since_approved: minsSinceApproved };
        }

        const predCount = predCounts.get(certId) || 0;
        const ai_predictions =
          predCount > 0
            ? { status: "green" as CheckStatus, count: predCount }
            : { status: "red" as CheckStatus, count: 0 };

        const actions = auditActions.get(certId) || [];
        const audit_log =
          actions.length > 0
            ? { status: "green" as CheckStatus, actions_seen: actions }
            : { status: "red" as CheckStatus, actions_seen: [] };

        const checks = {
          card_metadata: cardMetadata,
          grade_fields: gradeFields,
          defects,
          images,
          grading_time,
          embedding,
          ai_predictions,
          audit_log,
        };

        let any_red = false,
          any_amber = false;
        for (const k of FIELD_KEYS) {
          const s = (checks as any)[k].status as CheckStatus;
          byField[k][s]++;
          if (s === "red") any_red = true;
          if (s === "amber") any_amber = true;
        }

        return {
          cert_id: certId,
          grade_approved_at: cert.grade_approved_at ? new Date(cert.grade_approved_at).toISOString() : null,
          card_name: cert.card_name ?? null,
          grade_overall: cert.grade_overall != null ? String(cert.grade_overall) : null,
          checks,
          any_red,
          any_amber,
        };
      });

      const filtered = onlyFailing ? out.filter((c) => c.any_red) : out;

      const summary = {
        total_checked: out.length,
        fully_green: out.filter((c) => !c.any_red && !c.any_amber).length,
        any_red: out.filter((c) => c.any_red).length,
        any_amber: out.filter((c) => c.any_amber).length,
        by_field: byField,
      };

      res.json({ generated_at: new Date().toISOString(), summary, certs: filtered });
    } catch (err: any) {
      console.error("[ai-capture-health] failed:", err);
      sendServerError(res, err);
    }
  });

  // ── TCGdex card lookup (admin-authed, gated by feature flag) ────────────
  // GET /api/admin/tcgdex-lookup?code=SV5K&number=075&lang=ja&certId=MV123
  //
  // Returns canonical card/set metadata from TCGdex. If auto_add_missing_sets
  // is ON and the set is confirmed but missing from custom_sets, inserts it.
  // Otherwise writes to pending_set_lookups for manual review.

  const CODE_RE = /^[A-Za-z0-9._-]{1,20}$/;
  const NUMBER_RE = COLLECTOR_NUMBER_RE;

  // GET /api/admin/tcgdex-resolve-set?name=Charizard&number=4/102
  // English-only set resolution from card NAME + NUMBER — the fallback for when
  // the AI couldn't read the printed set code (set_code null). Returns a set ONLY
  // on a CONFIRMED UNIQUE match in the imported tcgdex_sets catalogue (the print
  // total disambiguates when present); ambiguous/no-match → { found: false } so the
  // form leaves the Set field blank. Never guesses a set.
  app.get("/api/admin/tcgdex-resolve-set", requireAdmin, async (req, res) => {
    try {
      const lookupEnabled = await getFeatureFlag("AI_CARD_LOOKUP_PREFILL_ENABLED");
      if (!lookupEnabled) return res.status(503).json({ error: "Card lookup is disabled" });

      const name = String(req.query.name || "").trim();
      const number = String(req.query.number || "").trim();
      if (!name || !number) return res.status(400).json({ error: "name and number are required" });
      if (name.length > 60) return res.status(400).json({ error: "Invalid card name" });
      if (!NUMBER_RE.test(number)) return res.status(400).json({ error: "Invalid card number format" });

      const resolved = await resolveEnglishSetByNameAndNumber(name, number);
      if (!resolved) return res.json({ found: false });
      return res.json({
        found: true,
        set_id: resolved.set_id,
        set_name: resolved.set_name,
        release_date: resolved.release_date,
      });
    } catch (e: any) {
      console.error("[tcgdex-resolve-set] error:", e.message);
      return sendServerError(res, e);
    }
  });

  app.get("/api/admin/tcgdex-lookup", requireAdmin, async (req, res) => {
    try {
      // ── Feature gate ────────────────────────────────────────────────────
      const lookupEnabled = await getFeatureFlag("AI_CARD_LOOKUP_PREFILL_ENABLED");
      if (!lookupEnabled) {
        return res.status(503).json({ error: "Card lookup is disabled" });
      }

      // ── Input validation (OWASP: whitelist chars, these flow into URLs) ─
      const code = String(req.query.code || "").trim();
      const number = String(req.query.number || "").trim();
      const lang = String(req.query.lang || "en")
        .trim()
        .toLowerCase();
      const certId = req.query.certId ? String(req.query.certId).trim() : null;

      if (!code || !number) {
        return res.status(400).json({ error: "code and number are required" });
      }
      if (!CODE_RE.test(code)) {
        return res.status(400).json({ error: "Invalid set code format" });
      }
      if (!NUMBER_RE.test(number)) {
        return res.status(400).json({ error: "Invalid card number format" });
      }
      if (!isAllowedLang(lang)) {
        return res.status(400).json({ error: `Unsupported language: ${lang}` });
      }

      const adminEmail = req.session.adminEmail || "admin";
      console.log(`[card-lookup] code="${code}" number="${number}" lang="${lang}" certId="${certId}" by=${adminEmail}`);

      // ── TCGdex resolution ───────────────────────────────────────────────
      const result = await lookupCard(code, number, lang);
      if (!result) {
        return res.json({
          found: false,
          message: "Card not found in TCGdex",
        });
      }

      // ── Check if set exists in custom_sets ──────────────────────────────
      const existingSet = await db.execute(
        sql`SELECT set_id FROM custom_sets WHERE LOWER(set_id) = LOWER(${result.set_id}) LIMIT 1`
      );
      const setExists = existingSet.rows.length > 0;

      let needs_manual_add = false;
      let auto_added = false;

      if (!setExists) {
        const autoAddEnabled = await getFeatureFlag("AI_AUTO_ADD_MISSING_SETS_ENABLED");

        if (autoAddEnabled) {
          // ── Auto-seed: insert into custom_sets ────────────────────────
          try {
            await db.execute(sql`
              INSERT INTO custom_sets (set_id, set_name, series, release_date, total_cards, created_by)
              VALUES (
                ${result.set_id},
                ${result.set_name},
                ${result.series},
                ${result.release_date},
                ${result.total_cards},
                ${"auto:tcgdex"}
              )
            `);
            auto_added = true;

            await storage.writeAuditLog("custom_set", result.set_id, "auto_seed", "system:tcgdex", {
              source: "tcgdex",
              tcgdex_card_id: result.external_card_id,
              before: null,
              after: {
                set_id: result.set_id,
                set_name: result.set_name,
                series: result.series,
                release_date: result.release_date,
                total_cards: result.total_cards,
              },
            });

            console.log(`[card-lookup] auto-seeded set "${result.set_id}" — ${result.set_name}`);
          } catch (seedErr: any) {
            const pgCode = seedErr.code || seedErr.cause?.code;
            if (pgCode === "23505") {
              // Race condition: another request inserted it first — fine
              console.log(`[card-lookup] set "${result.set_id}" already exists (race ok)`);
            } else {
              console.error(`[card-lookup] auto-seed failed for "${result.set_id}":`, seedErr);
              needs_manual_add = true;
            }
          }
        } else {
          // ── Manual path: upsert pending_set_lookups ───────────────────
          needs_manual_add = true;

          try {
            await db.execute(sql`
              INSERT INTO pending_set_lookups (printed_code, card_number, language, cert_id, tcgdex_data)
              VALUES (
                ${code},
                ${number},
                ${lang},
                ${certId},
                ${JSON.stringify({
                  set_id: result.set_id,
                  set_name: result.set_name,
                  series: result.series,
                  release_date: result.release_date,
                  total_cards: result.total_cards,
                  external_card_id: result.external_card_id,
                })}::jsonb
              )
            `);
            console.log(`[card-lookup] queued pending set lookup: code="${code}" → "${result.set_id}"`);
          } catch (queueErr: any) {
            console.error("[card-lookup] pending_set_lookups insert failed:", queueErr);
          }
        }
      }

      return res.json({
        found: true,
        card_name: result.card_name, // English — what the prefill uses
        card_name_local: result.card_name_local, // native-language original
        set_id: result.set_id,
        set_name: result.set_name, // English
        set_name_local: result.set_name_local, // native-language original
        series: result.series,
        release_date: result.release_date,
        total_cards: result.total_cards,
        external_card_id: result.external_card_id,
        rarity: result.rarity,
        resolved_lang: result.resolved_lang, // lang the lookup resolved on — drives the form's Language auto-fill
        set_exists: setExists || auto_added,
        auto_added,
        needs_manual_add,
        source: "tcgdex",
      });
    } catch (err: any) {
      console.error("[card-lookup] failed:", err);
      res.status(500).json({ error: "Card lookup failed — check server logs" });
    }
  });
}
