import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { destroySessionAndClearCookie } from "./lib/auth-security";
import { loadCustomerSessionAuthority } from "./customer-session-authority";
import { enqueueCustomerNotification } from "./customer-notification-outbox";

// ── Database-backed magic-link token store ────────────────────────────────────
// Tokens are 32-byte hex strings persisted in customer_magic_link_tokens.
// Single-use (consumed_at set atomically on verify). 15-minute TTL.
// Multi-machine safe — replaces prior in-memory Map that broke on 2-machine prod.
const TOKEN_TTL_MS = 15 * 60 * 1000;

export async function createMagicToken(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const recipient = email.toLowerCase().trim();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO public.customer_magic_link_tokens (email, token, expires_at)
      VALUES (${recipient}, ${token}, ${expiresAt.toISOString()})
    `);
    await enqueueCustomerNotification(tx, {
      eventKey: `customer-magic:${crypto.createHash("sha256").update(`${recipient}\0${token}`).digest("hex")}`,
      kind: "CUSTOMER_MAGIC_LINK",
      aggregateType: "customer_email",
      aggregateId: crypto.createHash("sha256").update(recipient).digest("hex"),
      recipient,
      payload: { token },
      expiresAt,
    });
  });
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
export async function requireCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const authority = await loadCustomerSessionAuthority(req);
    if (!authority) {
      await destroySessionAndClearCookie(req, res);
      return res.status(401).json({ error: "Not authenticated. Please log in via your dashboard link." });
    }
    if (!authority.emailVerified) {
      return res.status(403).json({
        error: "email_verification_required",
        message: "Verify your email address before accessing customer records.",
      });
    }

    // Downstream legacy routes may still consume these fields, but they are now
    // refreshed from the live users row rather than trusted as session authority.
    req.session.userId = authority.userId;
    req.session.userEmail = authority.email;
    req.session.customerEmail = authority.email;
    return next();
  } catch (err) {
    console.error("[customer-auth] session authority check failed:", err);
    return res.status(503).json({ error: "Authentication service temporarily unavailable." });
  }
}
