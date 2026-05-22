/**
 * server/routes/stolen.ts
 *
 * Stolen card registry — report, verify, status, admin list/clear.
 * Extracted from server/routes.ts for maintainability.
 */

import type { Express } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { requireAdmin } from "../auth";
import { sendStolenVerificationEmail } from "../email";
import { normalizeCertId, findCertByIdFlex } from "../routes";

export async function registerStolenRoutes(app: Express): Promise<void> {
  // ── Startup migration ────────────────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS stolen_reports (
        id            SERIAL PRIMARY KEY,
        cert_id       TEXT NOT NULL,
        reporter_name  TEXT NOT NULL,
        reporter_email TEXT NOT NULL,
        description   TEXT,
        verify_token  TEXT NOT NULL UNIQUE,
        verified_at   TIMESTAMP,
        cleared_at    TIMESTAMP,
        cleared_by    TEXT,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      ALTER TABLE certificates
        ADD COLUMN IF NOT EXISTS stolen_status TEXT,
        ADD COLUMN IF NOT EXISTS stolen_reported_at TIMESTAMP
    `);
  } catch (e: any) {
    console.error("[stolen] startup migration error:", e.message);
  }

  // Stolen-report — high-friction abuse surface. Generous enough for dealer batch-reports.
  const stolenReportRateLimit = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Daily report limit reached. Contact support@mintvaultuk.com if you need to file more." },
  });

  // POST /api/stolen/report — only the current registered keeper can flag
  // their own cert. Reporter email must match cert.ownerEmail; the verify
  // link sent to that address closes the loop on email-control proof.
  app.post("/api/stolen/report", stolenReportRateLimit, async (req, res) => {
    try {
      const { certId, reporterName, reporterEmail, description } = req.body;
      if (!certId || !reporterName || !reporterEmail) {
        return res.status(400).json({ error: "certId, reporterName, and reporterEmail are required" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) {
        return res.status(400).json({ error: "Invalid reporter email" });
      }
      const normalCertId = normalizeCertId(String(certId));
      const cert = await findCertByIdFlex(normalCertId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      // Ownership gate — unclaimed certs have no keeper to authenticate.
      if ((cert as any).ownershipStatus !== "claimed" || !(cert as any).ownerEmail) {
        return res
          .status(403)
          .json({ error: "This certificate has no registered keeper on file. Contact support@mintvaultuk.com." });
      }
      const reporterLc = String(reporterEmail).toLowerCase().trim();
      if (
        String((cert as any).ownerEmail)
          .toLowerCase()
          .trim() !== reporterLc
      ) {
        return res
          .status(403)
          .json({ error: "Only the current registered keeper can report a certificate as stolen." });
      }

      const token = crypto.randomBytes(32).toString("hex");
      const inserted = await db.execute(sql`
        INSERT INTO stolen_reports (cert_id, reporter_name, reporter_email, description, verify_token)
        VALUES (${normalCertId}, ${String(reporterName).slice(0, 200)}, ${reporterLc}, ${description ? String(description).slice(0, 1000) : null}, ${token})
        RETURNING id
      `);
      const reportId = (inserted.rows[0] as any)?.id ?? null;

      await storage.writeAuditLog("certificate", normalCertId, "stolen_reported", reporterLc, {
        reporterName: String(reporterName).slice(0, 200),
        description: description ? String(description).slice(0, 1000) : null,
        reportId,
      });

      // Send verification email
      const verifyUrl = `${req.protocol}://${req.get("host")}/api/stolen/verify/${token}`;
      try {
        await sendStolenVerificationEmail(
          String(reporterEmail),
          String(reporterName),
          normalCertId,
          cert.cardName || "Unknown card",
          verifyUrl
        );
      } catch (emailErr: any) {
        console.error("[stolen] email send error:", emailErr.message);
      }

      return res.json({ ok: true, message: "Verification email sent. Please check your inbox to confirm the report." });
    } catch (err: any) {
      console.error("[stolen] POST report error:", err.message);
      return res.status(500).json({ error: "Failed to submit report" });
    }
  });

  // GET /api/stolen/verify/:token — link clicked in email; marks report
  // verified, flags cert. Tokens expire 24h after creation (matches email
  // copy). JS-side TTL check on row.created_at avoids a second query.
  app.get("/api/stolen/verify/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const rows = await db.execute(sql`
        SELECT * FROM stolen_reports WHERE verify_token = ${token} LIMIT 1
      `);
      if (rows.rows.length === 0) {
        return res.status(404).send("Verification link not found or already used.");
      }
      const report = rows.rows[0] as any;
      if (report.verified_at) {
        return res.redirect("/stolen-card-protection?verified=already");
      }
      const createdAtMs = new Date(report.created_at).getTime();
      if (Date.now() - createdAtMs > 24 * 60 * 60 * 1000) {
        return res.redirect("/stolen-card-protection?verified=expired");
      }
      await db.execute(sql`
        UPDATE stolen_reports SET verified_at = NOW() WHERE verify_token = ${token}
      `);
      await db.execute(sql`
        UPDATE certificates SET stolen_status = 'reported_stolen', stolen_reported_at = NOW()
        WHERE certificate_number = ${report.cert_id}
      `);
      await storage.writeAuditLog("certificate", report.cert_id, "stolen_verified", report.reporter_email || null, {
        reportId: report.id,
        verifyToken: token,
      });
      return res.redirect(`/stolen-card-protection?verified=true&cert=${report.cert_id}`);
    } catch (err: any) {
      console.error("[stolen] GET verify error:", err.message);
      return res.status(500).send("Verification failed. Please try again.");
    }
  });

  // GET /api/stolen/status/:certId — public; returns whether a cert is flagged
  app.get("/api/stolen/status/:certId", async (req, res) => {
    try {
      const normalCertId = normalizeCertId(req.params.certId);
      const rows = await db.execute(sql`
        SELECT stolen_status, stolen_reported_at FROM certificates
        WHERE certificate_number = ${normalCertId} LIMIT 1
      `);
      if (rows.rows.length === 0) return res.status(404).json({ error: "Not found" });
      const row = rows.rows[0] as any;
      return res.json({
        stolen: row.stolen_status === "reported_stolen",
        reportedAt: row.stolen_reported_at || null,
      });
    } catch (err: any) {
      return res.status(500).json({ error: "Failed" });
    }
  });

  // GET /api/admin/stolen — admin only; list active stolen reports
  app.get("/api/admin/stolen", requireAdmin, async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT id, cert_id, reporter_name, reporter_email, description, verified_at, cleared_at, created_at
        FROM stolen_reports
        WHERE cleared_at IS NULL
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return res.json(rows.rows);
    } catch (err: any) {
      return res.status(500).json({ error: "Failed" });
    }
  });

  // POST /api/admin/stolen/:certId/clear — admin only; clears the stolen flag
  app.post("/api/admin/stolen/:certId/clear", requireAdmin, async (req, res) => {
    try {
      const normalCertId = normalizeCertId(String(req.params.certId));
      const adminEmail = req.session.adminEmail || "admin";
      await db.execute(sql`
        UPDATE certificates SET stolen_status = NULL, stolen_reported_at = NULL
        WHERE certificate_number = ${normalCertId}
      `);
      const cleared = await db.execute(sql`
        UPDATE stolen_reports SET cleared_at = NOW(), cleared_by = ${adminEmail}
        WHERE cert_id = ${normalCertId} AND cleared_at IS NULL
      `);
      await storage.writeAuditLog("certificate", normalCertId, "stolen_cleared", adminEmail, {
        clearedBy: adminEmail,
        reportCount: (cleared as any).rowCount ?? null,
      });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[stolen] admin clear error:", err.message);
      return res.status(500).json({ error: "Failed to clear stolen flag" });
    }
  });
}
