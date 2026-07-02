import type { Express } from "express";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { requireAdmin } from "../auth";
import { FEATURE_FLAGS } from "../config/feature-flags";
import { waitlistRateLimit, contactRateLimit, mvgsInterestRateLimit } from "../lib/rate-limiters";

/**
 * Public misc endpoints — health, flags, homepage stats, waitlist, contact
 * form, MVGS interest, legal pages. Extracted verbatim from server/routes.ts
 * (routes-split increment 4). Registration order preserved: called at the
 * exact point in registerRoutes() where these routes previously sat (right
 * after the domain route modules, before the redirect routes).
 */
export function registerPublicMiscRoutes(app: Express): void {
  // ── Health check — no auth, no DB, no shared state. First registered so
  // it answers even if downstream middleware throws. Used by deploy smoke
  // tests and by anything wanting a cheap liveness signal.
  app.get("/api/healthz", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // ── Public flags endpoint ──────────────────────────────────────────────────
  app.get("/api/config/public-flags", (_req, res) => {
    // FEATURE_FLAGS imported at top level
    res.json({
      legalPagesLive: FEATURE_FLAGS.LEGAL_PAGES_LIVE,
      transferFlowLive: FEATURE_FLAGS.TRANSFER_FLOW_LIVE,
      publicNameToggleLive: FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE,
    });
  });

  // ── v2 Homepage Stats ──────────────────────────────────────────────────────
  let homepageStatsCache: { data: any; ts: number } | null = null;
  app.get("/api/v2/homepage-stats", async (_req, res) => {
    try {
      if (homepageStatsCache && Date.now() - homepageStatsCache.ts < 60_000) {
        return res.json(homepageStatsCache.data);
      }
      const statsResult = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL) AS total_graded,
          COUNT(DISTINCT card_name) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL) AS unique_cards,
          COUNT(DISTINCT set_name) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL) AS unique_sets,
          ROUND(AVG(grade::numeric) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL), 1) AS avg_grade,
          COUNT(*) FILTER (WHERE ownership_status = 'claimed') AS claimed_count
        FROM certificates
      `);
      // recent_certs removed (2026-06-13): it derived cert_number from the DB
      // row id, surfacing fabricated numbers (MV584/593/595). The homepage now
      // sources live registry rows from /api/public/recent-graded instead.
      const stats = statsResult.rows[0] as any;
      const data = {
        total_graded: parseInt(stats.total_graded || "0"),
        unique_cards: parseInt(stats.unique_cards || "0"),
        unique_sets: parseInt(stats.unique_sets || "0"),
        avg_grade: parseFloat(stats.avg_grade || "0"),
        claimed_count: parseInt(stats.claimed_count || "0"),
      };
      homepageStatsCache = { data, ts: Date.now() };
      res.json(data);
    } catch (err: any) {
      console.error("[v2/homepage-stats] error:", err.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // ── v2 Founding-members waitlist (homepage CTA, replaces stats trio) ───────
  // Rate limit: 10 attempts per IP per hour. Idempotent insert — repeat
  // submissions of the same email return the same success message without
  // revealing whether the address was already on the list. Audit logged
  // only on first insert (entity_type='waitlist_signup').

  app.post("/api/v2/waitlist", waitlistRateLimit, async (req, res) => {
    try {
      const { email } = req.body as { email?: unknown };
      if (typeof email !== "string") {
        return res.status(400).json({ error: "Email is required." });
      }
      const trimmed = email.trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!trimmed || trimmed.length > 254 || !emailRegex.test(trimmed)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }

      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        null;
      const userAgent = (req.headers["user-agent"] as string | undefined) || null;

      // Atomic insert. The partial unique index on LOWER(email) WHERE
      // deleted_at IS NULL means duplicates are caught at the DB layer.
      // Treat unique-violation as "already on the list" → same success
      // response, no audit row, no enumeration leak.
      try {
        const inserted = await db.execute(sql`
          INSERT INTO waitlist_signups (email, source, ip_address, user_agent)
          VALUES (${trimmed}, 'homepage_founding_member', ${ip}, ${userAgent ? userAgent.slice(0, 500) : null})
          RETURNING id
        `);
        const newId = (inserted.rows[0] as any)?.id;
        if (newId != null) {
          await storage.writeAuditLog("waitlist_signup", String(newId), "created", null, {
            source: "homepage_founding_member",
            ip,
          });
        }
      } catch (insertErr: any) {
        // Postgres unique violation = "23505". Anything else is a real error.
        if (insertErr?.code !== "23505" && !/duplicate key/i.test(insertErr?.message || "")) {
          throw insertErr;
        }
        // Duplicate — refresh the existing row's created_at so admin queues
        // can sort by latest interest. Do not write a new audit log row;
        // the original one remains intact per spec.
        await db.execute(sql`
          UPDATE waitlist_signups
          SET created_at = NOW()
          WHERE LOWER(email) = LOWER(${trimmed}) AND deleted_at IS NULL
        `);
      }

      return res.json({ success: true, message: "You're on the list — we'll be in touch." });
    } catch (err: any) {
      console.error("[v2/waitlist] error:", err.message);
      return res.status(500).json({ error: "We couldn't add you right now. Please try again." });
    }
  });

  // ── Contact-form endpoint ─────────────────────────────────────────────────
  // Public POST. Validates with zod, writes to contact_inquiries BEFORE the
  // Resend send (so messages survive email failures), then attempts Resend
  // and records the outcome on the same row. Returns 200 even if Resend
  // throws — the message is in the DB, operator can read from there.

  const contactSchema = z.object({
    name: z.string().trim().min(1, "Name is required").max(100, "Name too long"),
    email: z.string().trim().email("Invalid email address").max(200, "Email too long"),
    topic: z.enum(["submission", "grading", "cert-vault", "ownership", "returns-shipping", "payment", "other"]),
    message: z
      .string()
      .trim()
      .min(10, "Message too short (min 10 characters)")
      .max(5000, "Message too long (max 5000 characters)"),
  });

  app.post("/api/contact", contactRateLimit, async (req, res) => {
    try {
      const parsed = contactSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        return res.status(400).json({
          error: firstIssue?.message || "Invalid submission",
          field: firstIssue?.path?.[0] ?? null,
        });
      }
      const { name, email, topic, message } = parsed.data;

      const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
      const userAgent = (req.headers["user-agent"] as string)?.slice(0, 500) || null;

      // Write BEFORE send so the message survives any Resend failure.
      const insertResult = await db.execute(sql`
        INSERT INTO contact_inquiries (name, email, topic, message, ip_address, user_agent)
        VALUES (${name}, ${email}, ${topic}, ${message}, ${ipAddress}, ${userAgent})
        RETURNING id
      `);
      const inquiryId = (insertResult.rows[0] as any)?.id as number;

      // Attempt the email. Don't fail the whole request on Resend errors —
      // the DB row already exists; operator can read from there or retry.
      const { sendContactInquiry } = await import("../email");
      try {
        await sendContactInquiry({
          name,
          email,
          topic,
          message,
          submittedAt: new Date(),
          inquiryId,
        });
        await db.execute(sql`
          UPDATE contact_inquiries SET email_sent_at = NOW() WHERE id = ${inquiryId}
        `);
        console.log(`[contact] inquiry ${inquiryId} sent to inbox (topic=${topic}, from=${String(email).replace(/^(.).*@/, "$1***@")})`);
      } catch (sendErr: any) {
        const errMsg = (sendErr?.message || String(sendErr)).slice(0, 1000);
        console.error(`[contact] inquiry ${inquiryId} Resend send failed: ${errMsg}`);
        await db.execute(sql`
          UPDATE contact_inquiries SET email_error = ${errMsg} WHERE id = ${inquiryId}
        `);
      }

      return res.json({ ok: true, inquiryId });
    } catch (err: any) {
      console.error("[contact] route error:", err?.message || err);
      return res.status(500).json({ error: "Couldn't process your message. Please try again." });
    }
  });

  // ── MVGS compliance interest (public, rate-limited) ──────────────────────
  // POST /api/mvgs/interest — captures the /mvgs/join form. Append-only into
  // mvgs_interest table; no read endpoint, no public listing.

  const mvgsInterestSchema = z.object({
    company: z.string().trim().min(1, "Company name is required").max(200, "Company name too long"),
    email: z.string().trim().email("Invalid email address").max(254, "Email too long"),
    message: z.string().trim().max(2000, "Message too long").optional(),
  });

  app.post("/api/mvgs/interest", mvgsInterestRateLimit, async (req, res) => {
    try {
      const parsed = mvgsInterestSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        return res.status(400).json({ error: firstIssue?.message || "Invalid submission" });
      }
      const { company, email, message } = parsed.data;
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        null;
      const { mvgsInterest } = await import("@shared/schema");
      await db.insert(mvgsInterest).values({
        company,
        email,
        message: message ?? null,
        ip,
      });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[mvgs-interest] error:", err?.message || err);
      return res.status(500).json({ error: "Couldn't record interest. Please try again." });
    }
  });

  // ── Legal page API routes ─────────────────────────────────────────────────
  app.get("/api/legal/:slug", async (req, res) => {
    // FEATURE_FLAGS imported at top level
    if (!FEATURE_FLAGS.LEGAL_PAGES_LIVE) return res.status(404).json({ error: "Not found" });

    const { LEGAL_SLUGS, LEGAL_ALIASES } = await import("../config/legal");
    const slug = String(req.params.slug);
    if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) return res.status(404).json({ error: "Not found" });

    try {
      const fileSlug = LEGAL_ALIASES[slug] || slug;
      const filePath = path.join(process.cwd(), "content", "legal", `${fileSlug}.md`);
      const content = fs.readFileSync(filePath, "utf-8");

      // Extract frontmatter title
      const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      const versionMatch = content.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
      const body = content.replace(/^---[\s\S]*?---\s*/m, "");

      res.json({
        slug,
        title: titleMatch?.[1] || slug,
        version: versionMatch?.[1] || "unknown",
        content: body,
      });
    } catch {
      res.status(404).json({ error: "Document not found" });
    }
  });

  // Admin preview — always available regardless of flag
  app.get("/api/admin/legal/:slug", requireAdmin, async (req, res) => {
    const { LEGAL_SLUGS, LEGAL_ALIASES } = await import("../config/legal");
    const slug = String(req.params.slug);
    if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) return res.status(404).json({ error: "Not found" });

    try {
      const fileSlug = LEGAL_ALIASES[slug] || slug;
      const filePath = path.join(process.cwd(), "content", "legal", `${fileSlug}.md`);
      const content = fs.readFileSync(filePath, "utf-8");
      const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      const versionMatch = content.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
      const body = content.replace(/^---[\s\S]*?---\s*/m, "");
      res.json({ slug, title: titleMatch?.[1] || slug, version: versionMatch?.[1] || "unknown", content: body });
    } catch {
      res.status(404).json({ error: "Document not found" });
    }
  });
}
