import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";

// ── Database-backed magic-link token store ────────────────────────────────────
// Tokens are 32-byte hex strings persisted in customer_magic_link_tokens.
// Single-use (consumed_at set atomically on verify). 15-minute TTL.
// Multi-machine safe — replaces prior in-memory Map that broke on 2-machine prod.
const TOKEN_TTL_MS = 15 * 60 * 1000;

export async function createMagicToken(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.execute(sql`
    INSERT INTO customer_magic_link_tokens (email, token, expires_at)
    VALUES (${email.toLowerCase().trim()}, ${token}, ${expiresAt.toISOString()})
  `);
  return token;
}

export async function verifyMagicToken(token: string): Promise<string | null> {
  // Atomic single-UPDATE-with-RETURNING: succeeds only if token exists, is
  // unconsumed, and unexpired — all in one statement. Prevents race where two
  // parallel requests could both observe consumed_at IS NULL.
  const rows = await db.execute(sql`
    UPDATE customer_magic_link_tokens
    SET consumed_at = NOW()
    WHERE token = ${token}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING email
  `);
  const row = rows.rows[0] as { email: string } | undefined;
  return row?.email ?? null;
}

// ── Customer session middleware ────────────────────────────────────────────────
export function requireCustomer(req: Request, res: Response, next: NextFunction) {
  if (req.session?.customerEmail) return next();
  res.status(401).json({ error: "Not authenticated. Please log in via your dashboard link." });
}
