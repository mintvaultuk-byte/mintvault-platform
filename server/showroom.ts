/**
 * server/showroom.ts
 *
 * Showroom feature — username validation, endpoint handlers, in-memory cache.
 * Endpoints are registered in server/routes.ts via registerShowroomRoutes().
 */

import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { writeAuthAudit } from "./account-auth";
import { requireAuth } from "./middleware/auth";
import { getR2SignedUrl } from "./r2";
import { isActiveStatus } from "./vault-club-tiers";

// ── Reserved usernames ────────────────────────────────────────────────────────

const RESERVED = new Set([
  "admin", "mintvault", "mint-vault", "mintvaultuk", "vault", "support", "help",
  "api", "www", "mail", "staff", "team", "cornelius", "oliver", "neil", "sophie",
  "tinylegends", "tinylegendsranch", "apex", "apexdigital", "apexdigitalco",
  "root", "system", "login", "signup", "dashboard", "showroom", "showrooms",
  "club", "vaultclub", "pricing", "terms", "privacy", "contact", "about",
  "grading", "pop", "popreport", "verify", "tools", "community",
]);

// Basic UK profanity blocklist — common words only
const PROFANITY = new Set([
  "fuck", "shit", "cunt", "cock", "dick", "piss", "wank", "arse", "arsehole",
  "asshole", "ass", "bitch", "bastard", "bollocks", "bugger", "twat", "whore",
  "slut", "fag", "faggot", "nigger", "prick", "spastic", "retard", "bellend",
  "tosser", "wanker", "shite", "knob",
]);

// ── Username validation ───────────────────────────────────────────────────────

export type UsernameCheckResult =
  | { available: true; reason: null }
  | { available: false; reason: "invalid" | "reserved" | "taken" };

export function validateUsernameFormat(username: string): {
  ok: boolean;
  message?: string;
} {
  if (!username || username.length < 3) return { ok: false, message: "Too short (minimum 3 characters)" };
  if (username.length > 20) return { ok: false, message: "Too long (maximum 20 characters)" };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(username) && !/^[a-z0-9]$/.test(username)) {
    return { ok: false, message: "Only lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen." };
  }
  if (/--/.test(username)) return { ok: false, message: "Cannot contain consecutive hyphens" };
  if (!/^[a-z0-9-]+$/.test(username)) return { ok: false, message: "Only lowercase letters, numbers, and hyphens allowed" };
  // Profanity check — any word in the username
  const parts = username.split("-");
  for (const part of parts) {
    if (PROFANITY.has(part)) return { ok: false, message: "Username contains a restricted word" };
  }
  // Also check the whole string without hyphens
  const flat = username.replace(/-/g, "");
  for (const word of PROFANITY) {
    if (flat.includes(word)) return { ok: false, message: "Username contains a restricted word" };
  }
  return { ok: true };
}

export async function checkUsername(username: string): Promise<UsernameCheckResult> {
  const norm = username.toLowerCase().trim();
  const fmt = validateUsernameFormat(norm);
  if (!fmt.ok) return { available: false, reason: "invalid" };
  if (RESERVED.has(norm)) return { available: false, reason: "reserved" };
  const rows = await db.execute(sql`
    SELECT id FROM users WHERE LOWER(username) = ${norm} LIMIT 1
  `);
  if (rows.rows.length > 0) return { available: false, reason: "taken" };
  return { available: true, reason: null };
}

export function suggestUsername(displayName: string | null, email: string): string {
  const source = displayName || email.split("@")[0];
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
  return base || "collector";
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

class SimpleCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;
  constructor(ttlMs: number) { this.ttlMs = ttlMs; }
  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) { this.store.delete(key); return null; }
    return entry.data;
  }
  set(key: string, data: T): void {
    this.store.set(key, { data, expiry: Date.now() + this.ttlMs });
  }
  invalidate(key: string): void { this.store.delete(key); }
}

const showroomCache = new SimpleCache<unknown>(60_000);  // 60s TTL
const showroomsListCache = new SimpleCache<unknown>(60_000);

// ── Route registration ────────────────────────────────────────────────────────

export function registerShowroomRoutes(app: Express): void {

  const checkUsernameLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => {
      const fwd = req.headers["x-forwarded-for"];
      if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
      return req.ip || "unknown";
    },
  });

  // GET /api/showroom/check-username?username=xxx
  app.get("/api/showroom/check-username", checkUsernameLimit, async (req: Request, res: Response) => {
    const raw = typeof req.query.username === "string" ? req.query.username : "";
    const username = raw.toLowerCase().trim();
    if (!username) return res.json({ available: false, reason: "invalid" });
    try {
      const result = await checkUsername(username);
      return res.json(result);
    } catch (err: any) {
      console.error("[showroom] check-username error:", err.message);
      return res.status(500).json({ available: false, reason: "invalid" });
    }
  });

  // POST /api/showroom/claim
  app.post("/api/showroom/claim", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any).userId as string;
      // Check if already claimed
      const existing = await db.execute(sql`
        SELECT username FROM users WHERE id = ${userId} AND username IS NOT NULL LIMIT 1
      `);
      if (existing.rows.length > 0 && (existing.rows[0] as any).username) {
        return res.status(409).json({ error: "You have already claimed a username. Usernames cannot be changed." });
      }

      const raw = typeof req.body.username === "string" ? req.body.username : "";
      const username = raw.toLowerCase().trim();
      const result = await checkUsername(username);

      if (!result.available) {
        const messages: Record<string, string> = {
          invalid: "That username is invalid. Use 3-20 lowercase letters, numbers, or hyphens.",
          reserved: "That username is reserved and cannot be claimed.",
          taken: "That username has already been taken.",
        };
        return res.status(409).json({ error: messages[result.reason] || "Username not available", reason: result.reason });
      }

      await db.execute(sql`
        UPDATE users
        SET username = ${username}, showroom_claimed_at = NOW(), updated_at = NOW()
        WHERE id = ${userId}
      `);

      showroomsListCache.invalidate("list");

      const ip = (() => {
        const fwd = req.headers["x-forwarded-for"];
        if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
        return req.ip || "unknown";
      })();
      await writeAuthAudit("showroom.claimed", userId, ip, { username });

      return res.json({ success: true, username });
    } catch (err: any) {
      console.error("[showroom] claim error:", err.message);
      return res.status(500).json({ error: "Failed to claim username. Please try again." });
    }
  });

  // PUT /api/showroom/settings
  app.put("/api/showroom/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any).userId as string;
      let { bio } = req.body;
      if (bio !== undefined && bio !== null) {
        bio = String(bio).slice(0, 280);
        // Strip HTML tags
        bio = bio.replace(/<[^>]*>/g, "").trim();
        // Reject URLs
        if (/https?:\/\/|www\./i.test(bio)) {
          return res.status(400).json({ error: "Bio cannot contain URLs." });
        }
      }

      await db.execute(sql`
        UPDATE users SET showroom_bio = ${bio ?? null}, updated_at = NOW() WHERE id = ${userId}
      `);

      // Invalidate cache for this user's showroom
      const user = await db.execute(sql`SELECT username FROM users WHERE id = ${userId} LIMIT 1`);
      const username = (user.rows[0] as any)?.username;
      if (username) showroomCache.invalidate(username.toLowerCase());

      const ip = (() => {
        const fwd = req.headers["x-forwarded-for"];
        if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
        return req.ip || "unknown";
      })();
      await writeAuthAudit("showroom.bio_updated", userId, ip, {});

      return res.json({ success: true });
    } catch (err: any) {
      console.error("[showroom] settings error:", err.message);
      return res.status(500).json({ error: "Failed to save settings." });
    }
  });

  // GET /api/showroom/:username
  app.get("/api/showroom/:username", async (req: Request, res: Response) => {
    const username = String(req.params.username).toLowerCase().trim();
    const cached = showroomCache.get(username);
    if (cached) return res.json(cached);

    try {
      const userRows = await db.execute(sql`
        SELECT id, display_name, showroom_bio, showroom_active, showroom_claimed_at, username,
               vault_club_tier, vault_club_status
        FROM users
        WHERE LOWER(username) = ${username}
          AND deleted_at IS NULL
        LIMIT 1
      `);
      if (userRows.rows.length === 0) {
        return res.status(404).json({ error: "not_found" });
      }
      const user = userRows.rows[0] as any;

      const ownerTier = isActiveStatus(user.vault_club_status) ? (user.vault_club_tier || null) : null;

      if (!user.showroom_active) {
        const payload = {
          username: user.username,
          display_name: user.display_name || user.username,
          bio: user.showroom_bio || null,
          claimed_at: user.showroom_claimed_at,
          active: false,
          vault_club_tier: ownerTier,
          stats: null,
          cards: [],
        };
        showroomCache.set(username, payload);
        return res.json(payload);
      }

      // Full data — fetch all approved, publicly owned certs for this user
      const certsRows = await db.execute(sql`
        SELECT
          c.certificate_number AS cert_id,
          c.card_name, c.set_name,
          c.year_text AS year,
          c.card_number_display AS card_number,
          c.grade AS grade_overall, c.grade_type, c.front_image_path,
          c.issued_at AS created_at
        FROM certificates c
        WHERE c.current_owner_user_id = ${user.id}
          AND c.ownership_status = 'claimed'
          AND c.grade_approved_by IS NOT NULL
        ORDER BY c.issued_at DESC
      `);

      const cards = await Promise.all(
        certsRows.rows.map(async (c: any) => {
          let frontImageUrl: string | null = null;
          if (c.front_image_path) {
            try { frontImageUrl = await getR2SignedUrl(c.front_image_path, 3600); } catch { /* ok */ }
          }
          const grade = c.grade_overall != null ? parseFloat(String(c.grade_overall)) : null;
          const isBlackLabel = grade !== null && grade >= 10;
          return {
            cert_id: c.cert_id,
            card_name: c.card_name || null,
            set_name: c.set_name || null,
            year: c.year ? parseInt(c.year) : null,
            card_number: c.card_number || null,
            grade: grade,
            is_black_label: isBlackLabel,
            front_image_url: frontImageUrl,
            graded_at: c.created_at,
          };
        })
      );

      // Stats
      const total_cards = cards.length;
      const numericGrades = cards.map(c => c.grade).filter((g): g is number => g !== null);
      const average_grade = numericGrades.length
        ? Math.round((numericGrades.reduce((a, b) => a + b, 0) / numericGrades.length) * 10) / 10
        : null;
      const black_label_count = cards.filter(c => c.is_black_label).length;
      const grade_breakdown: Record<string, number> = {};
      for (const g of numericGrades) {
        const key = String(Math.floor(g));
        grade_breakdown[key] = (grade_breakdown[key] || 0) + 1;
      }

      const payload = {
        username: user.username,
        display_name: user.display_name || user.username,
        bio: user.showroom_bio || null,
        claimed_at: user.showroom_claimed_at,
        active: true,
        vault_club_tier: ownerTier,
        stats: {
          total_cards,
          grade_breakdown,
          black_label_count,
          average_grade,
        },
        cards,
      };
      showroomCache.set(username, payload);
      return res.json(payload);
    } catch (err: any) {
      console.error("[showroom] get error:", err.message);
      return res.status(500).json({ error: "Failed to load showroom." });
    }
  });

  // GET /api/showrooms?limit=50&offset=0
  app.get("/api/showrooms", async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 100);
    const offset = parseInt(String(req.query.offset || "0"), 10);
    const cacheKey = `list:${limit}:${offset}`;
    const cached = showroomsListCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
      const rows = await db.execute(sql`
        SELECT u.username, u.display_name, u.showroom_bio, u.showroom_claimed_at,
          u.vault_club_tier, u.vault_club_status,
          COUNT(DISTINCT c.id) AS total_cards,
          COUNT(DISTINCT CASE WHEN c.grade = 10 THEN c.id END) AS black_label_count
        FROM users u
        LEFT JOIN certificates c
          ON c.current_owner_user_id = u.id
          AND c.ownership_status = 'claimed'
          AND c.grade_approved_by IS NOT NULL
        WHERE u.showroom_active = true
          AND u.username IS NOT NULL
          AND u.deleted_at IS NULL
        GROUP BY u.id, u.username, u.display_name, u.showroom_bio, u.showroom_claimed_at,
                 u.vault_club_tier, u.vault_club_status
        ORDER BY u.showroom_claimed_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const showrooms = rows.rows.map((r: any) => ({
        username: r.username,
        display_name: r.display_name || r.username,
        bio: r.showroom_bio ? r.showroom_bio.slice(0, 100) : null,
        total_cards: parseInt(r.total_cards || "0", 10),
        black_label_count: parseInt(r.black_label_count || "0", 10),
        claimed_at: r.showroom_claimed_at,
        vault_club_tier: isActiveStatus(r.vault_club_status) ? (r.vault_club_tier || null) : null,
      }));

      const payload = { showrooms, limit, offset };
      showroomsListCache.set(cacheKey, payload);
      return res.json(payload);
    } catch (err: any) {
      console.error("[showroom] list error:", err.message);
      return res.status(500).json({ error: "Failed to load showrooms." });
    }
  });

  // GET /api/showroom-me — returns current user's showroom data (for dashboard)
  app.get("/api/showroom-me", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any).userId as string;
      const rows = await db.execute(sql`
        SELECT username, showroom_active, showroom_bio, showroom_claimed_at
        FROM users WHERE id = ${userId} LIMIT 1
      `);
      if (rows.rows.length === 0) return res.status(404).json({ error: "not_found" });
      return res.json(rows.rows[0]);
    } catch (err: any) {
      console.error("[showroom] showroom-me error:", err.message);
      return res.status(500).json({ error: "Failed to load showroom data." });
    }
  });
}
