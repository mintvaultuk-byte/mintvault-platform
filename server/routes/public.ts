import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { BUILD_STAMP, serviceTierToPricingTier } from "@shared/schema";
import { storage } from "../storage";
import { getStripePublishableKey } from "../stripeClient";
import { getR2SignedUrl } from "../r2";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { APP_BASE_URL } from "../app-url";
import { FEATURE_FLAGS } from "../config/feature-flags";
import fs from "fs";
import path from "path";

/** Normalise cert IDs: MV-0000000001 → MV1 */
function normalizeCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  if (m) return `MV${m[1]}`;
  return raw;
}

export function registerPublicRoutes(app: Express): void {
  // ── Health check — no auth, no DB, no shared state ──────────────────────
  app.get("/api/healthz", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // ── Public flags endpoint ──────────────────────────────────────────────────
  app.get("/api/config/public-flags", (_req, res) => {
    res.json({
      legalPagesLive: FEATURE_FLAGS.LEGAL_PAGES_LIVE,
      transferFlowLive: FEATURE_FLAGS.TRANSFER_FLOW_LIVE,
      publicNameToggleLive: FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE,
    });
  });

  // ── Version endpoint ────────────────────────────────────────────────────
  app.get("/api/version", (_req, res) => {
    res.json({
      build: BUILD_STAMP,
      timestamp: new Date().toISOString(),
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
      // Hero slab stack shows grade RANGE, not just the 3 most recent.
      // For each distinct numeric grade, pick the most recent cert; then take
      // the top 3 grades (highest first). Falls back to <3 rows if DB has
      // fewer distinct grades — caller degrades gracefully.
      const recentResult = await db.execute(sql`
        SELECT DISTINCT ON (grade::numeric)
               id, card_name, set_name, grade, grade_type,
               REGEXP_REPLACE(REGEXP_REPLACE(id::text, '^0+', ''), '^', 'MV') AS cert_number,
               front_image_path
        FROM certificates
        WHERE deleted_at IS NULL AND grade IS NOT NULL
          AND grade_type = 'numeric'
          AND card_name IS NOT NULL AND card_name != '' AND card_name != '(untitled)'
        ORDER BY grade::numeric DESC, issued_at DESC
        LIMIT 3
      `);
      const stats = statsResult.rows[0] as any;
      const data = {
        total_graded: parseInt(stats.total_graded || "0"),
        unique_cards: parseInt(stats.unique_cards || "0"),
        unique_sets: parseInt(stats.unique_sets || "0"),
        avg_grade: parseFloat(stats.avg_grade || "0"),
        claimed_count: parseInt(stats.claimed_count || "0"),
        recent_certs: (recentResult.rows as any[]).map((r) => ({
          id: r.id,
          card_name: r.card_name,
          set_name: r.set_name,
          grade: r.grade,
          grade_type: r.grade_type,
          cert_number: r.cert_number,
          front_image_path: r.front_image_path,
        })),
      };
      homepageStatsCache = { data, ts: Date.now() };
      res.json(data);
    } catch (err: any) {
      console.error("[v2/homepage-stats] error:", err.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // ── v2 Founding-members waitlist (homepage CTA, replaces stats trio) ───────
  const waitlistRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts from this device. Please try again later." },
  });

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
  const contactRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many contact-form submissions from this device. Please wait 15 minutes." },
  });

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
        console.log(`[contact] inquiry ${inquiryId} sent to inbox (topic=${topic}, from=${email})`);
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
  const mvgsInterestRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many submissions from this device. Please wait an hour." },
  });

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

  // ── Featured certificates ──────────────────────────────────────────────────
  app.get("/api/featured-certificates", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT certificate_number AS cert_id, card_name, set_name,
               grade AS grade_overall, grade_type, card_game, front_image_path
        FROM certificates
        WHERE status = 'active'
          AND deleted_at IS NULL
          AND card_name IS NOT NULL
          AND grade IS NOT NULL
          AND front_image_path IS NOT NULL
        ORDER BY issued_at DESC NULLS LAST
        LIMIT 5
      `);
      const rows = result.rows as any[];
      const items = await Promise.all(
        rows.map(async (row) => {
          let frontImageUrl: string | null = null;
          if (row.front_image_path) {
            try {
              frontImageUrl = await getR2SignedUrl(row.front_image_path, 3600);
            } catch {
              /* ignore */
            }
          }
          if (!frontImageUrl) return null;
          return {
            certId: normalizeCertId(String(row.cert_id)),
            cardName: row.card_name,
            setName: row.set_name,
            gradeOverall: row.grade_overall,
            gradeType: row.grade_type || "numeric",
            cardGame: row.card_game,
            frontImageUrl,
          };
        })
      );
      res.json(items.filter(Boolean));
    } catch {
      res.json([]);
    }
  });

  // ── Stripe publishable key ─────────────────────────────────────────────────
  app.get("/api/stripe/publishable-key", async (_req, res) => {
    try {
      const publishableKey = await getStripePublishableKey();
      res.json({ publishableKey });
    } catch (error: any) {
      console.error("Error getting Stripe publishable key:", error.message);
      res.status(500).json({ error: "Failed to get payment configuration" });
    }
  });

  // ── Service tiers ──────────────────────────────────────────────────────────
  app.get("/api/service-tiers", async (req, res) => {
    try {
      const serviceType = req.query.serviceType as string | undefined;
      const tiers = await storage.getServiceTiers(serviceType);
      const pricingData = tiers.map(serviceTierToPricingTier);

      // Enrich with capacity status
      const capacityRows = await db.execute(
        sql`SELECT tier_id, status, paused_until, paused_message FROM tier_capacity`
      );
      const capacityMap = new Map((capacityRows.rows as any[]).map((r) => [r.tier_id, r]));

      const enriched = pricingData.map((tier: any) => {
        const cap = capacityMap.get(tier.tierId) || capacityMap.get(tier.id);
        return {
          ...tier,
          capacityStatus: cap?.status || "open",
          capacityPausedUntil: cap?.paused_until || null,
          capacityMessage: cap?.paused_message || null,
        };
      });

      res.json(enriched);
    } catch (error: any) {
      console.error("Error fetching service tiers:", error.message);
      res.status(500).json({ error: "Failed to fetch service tiers" });
    }
  });

  // ── Value protection tiers ─────────────────────────────────────────────────
  app.get("/api/value-protection-tiers", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, min_value_pence, max_value_pence, fee_pence,
               requires_photos, display_name
        FROM value_protection_tiers
        ORDER BY min_value_pence ASC
      `);
      res.json(result.rows || []);
    } catch (e: any) {
      // Table may not exist yet — return empty array
      console.error("[value-protection-tiers] error:", e.message);
      res.json([]);
    }
  });

  // ── Tier capacity (public read) ────────────────────────────────────────────
  app.get("/api/tier-capacity", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT tier_id, status, paused_until, paused_message
        FROM tier_capacity
        ORDER BY tier_id
      `);
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pokemon TCG sets list (cached 24h, merged with custom sets) ──────────
  let cachedTcgSets: any[] | null = null;
  let tcgCacheTime = 0;

  app.get("/api/pokemon-sets", async (_req, res) => {
    try {
      // Fetch TCG API sets (cached 24h)
      if (!cachedTcgSets || Date.now() - tcgCacheTime > 24 * 60 * 60 * 1000) {
        const apiKey = process.env.POKEMON_TCG_API_KEY;
        const headers: Record<string, string> = {};
        if (apiKey) headers["X-Api-Key"] = apiKey;
        const r = await fetch("https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=250", { headers });
        if (r.ok) {
          const data = await r.json();
          cachedTcgSets = (data.data || []).map((s: any) => ({
            id: s.id,
            name: s.name,
            series: s.series,
            ptcgoCode: s.ptcgoCode || null,
            releaseDate: s.releaseDate,
            total: s.total,
            source: "tcg",
          }));
          tcgCacheTime = Date.now();
        }
      }

      // Fetch custom sets from DB
      const customRows = await db.execute(sql`SELECT * FROM custom_sets ORDER BY created_at DESC`);
      const customSets = (customRows.rows as any[]).map((s) => ({
        id: s.set_id,
        name: s.set_name,
        series: s.series || "Custom",
        ptcgoCode: s.ptcgo_code || null,
        releaseDate: s.release_date ? new Date(s.release_date).toISOString().split("T")[0] : null,
        total: s.total_cards || 0,
        source: "custom",
      }));

      // Merge: custom sets first, then TCG API sets (dedup by id)
      const tcg = cachedTcgSets || [];
      const customIds = new Set(customSets.map((s) => s.id));
      const merged = [...customSets, ...tcg.filter((s) => !customIds.has(s.id))];

      res.json(merged);
    } catch (err: any) {
      console.error("[pokemon-sets] error:", err.message);
      res.json(cachedTcgSets || []);
    }
  });

  // ── Population report (public) ─────────────────────────────────────────────
  app.get("/api/population", async (req, res) => {
    try {
      const game = typeof req.query.game === "string" ? req.query.game.trim() : undefined;
      const set = typeof req.query.set === "string" ? req.query.set.trim() : undefined;
      const card = typeof req.query.card === "string" ? req.query.card.trim() : undefined;
      const rows = await storage.getGlobalPopulation({
        game: game || undefined,
        set: set || undefined,
        card: card || undefined,
      });

      // Counters + recent certs for the showcase hero
      const countersResult = await db.execute(sql`
        SELECT
          COUNT(*)::int as total_graded,
          COUNT(DISTINCT card_name)::int as unique_cards,
          COUNT(DISTINCT set_name)::int as unique_sets,
          COUNT(CASE WHEN ownership_status = 'claimed' THEN 1 END)::int as claimed_count,
          ROUND(AVG(grade::numeric), 1) as avg_grade
        FROM certificates
        WHERE deleted_at IS NULL AND grade IS NOT NULL
      `);
      const counters = countersResult.rows[0] as any;

      const recentResult = await db.execute(sql`
        SELECT certificate_number, card_name, set_name, grade, label_type, front_image_path, grade_approved_at
        FROM certificates
        WHERE deleted_at IS NULL AND grade IS NOT NULL AND grade_approved_at IS NOT NULL
        ORDER BY grade_approved_at DESC
        LIMIT 12
      `);
      const recent = await Promise.all(
        (recentResult.rows as any[]).map(async (r) => {
          let imageUrl: string | null = null;
          const imgKey = r.front_image_path;
          if (imgKey) {
            try {
              imageUrl = await getR2SignedUrl(imgKey, 3600);
            } catch {}
          }
          const certNum = String(r.certificate_number).replace(/^MV-?0+/, "MV");
          return {
            certificate_number: certNum,
            card_name: r.card_name || null,
            card_set: r.set_name || null,
            grade: r.grade ? parseFloat(r.grade) : null,
            label_type: r.label_type || "Standard",
            card_image_front_url: imageUrl,
            approved_at: r.grade_approved_at,
          };
        })
      );

      res.json({
        counters: {
          total_graded: counters.total_graded || 0,
          unique_cards: counters.unique_cards || 0,
          unique_sets: counters.unique_sets || 0,
          claimed_count: counters.claimed_count || 0,
          avg_grade: counters.avg_grade ? parseFloat(counters.avg_grade) : 0,
        },
        recent,
        population: rows,
      });
    } catch (err) {
      console.error("[population] error:", err);
      res.status(500).json({ error: "Failed to load population data." });
    }
  });

  // ── Population — filtered cert list ─────────────────────────────────────────
  app.get("/api/population/certs", async (req, res) => {
    try {
      const card = typeof req.query.card === "string" ? req.query.card.trim() : "";
      const set = typeof req.query.set === "string" ? req.query.set.trim() : "";
      if (!card && !set) return res.status(400).json({ error: "card or set required" });

      const cardEsc = card.replace(/'/g, "''").replace(/%/g, "\\%");
      const setEsc = set.replace(/'/g, "''").replace(/%/g, "\\%");

      const conditions: string[] = [`status = 'active'`, `deleted_at IS NULL`, `grade_type = 'numeric'`];
      if (card) conditions.push(`LOWER(card_name) LIKE LOWER('%${cardEsc}%')`);
      if (set) conditions.push(`LOWER(set_name) LIKE LOWER('%${setEsc}%')`);

      const result = await db.execute(
        sql.raw(`
        SELECT cert_id, card_name, set_name, card_game, grade_overall, created_at
        FROM certificates
        WHERE ${conditions.join(" AND ")}
        ORDER BY grade_overall DESC NULLS LAST, created_at DESC
        LIMIT 500
      `)
      );

      res.json(
        (result.rows as any[]).map((r) => ({
          certId: r.cert_id,
          cardName: r.card_name,
          setName: r.set_name,
          cardGame: r.card_game,
          grade: r.grade_overall,
          gradedAt: r.created_at,
        }))
      );
    } catch (err) {
      console.error("[population/certs] error:", err);
      res.status(500).json({ error: "Failed to load certificates." });
    }
  });
}
