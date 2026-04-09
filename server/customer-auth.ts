import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

// ── In-memory magic-link token store ──────────────────────────────────────────
// Tokens are 32-byte hex strings. Each token maps to {email, expiresAt}.
// Lost on server restart — acceptable for MVP.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface MagicToken {
  email: string;
  expiresAt: number;
}

const tokenStore = new Map<string, MagicToken>();

// Periodically prune expired tokens (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [token, record] of tokenStore) {
    if (record.expiresAt < now) tokenStore.delete(token);
  }
}, 60 * 60 * 1000);

export function createMagicToken(email: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  tokenStore.set(token, { email: email.toLowerCase().trim(), expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function verifyMagicToken(token: string): string | null {
  const record = tokenStore.get(token);
  if (!record) return null;
  if (record.expiresAt < Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  tokenStore.delete(token); // single-use
  return record.email;
}

// ── Customer session middleware ────────────────────────────────────────────────
export function requireCustomer(req: Request, res: Response, next: NextFunction) {
  if (req.session?.customerEmail) return next();
  res.status(401).json({ error: "Not authenticated. Please log in via your dashboard link." });
}
