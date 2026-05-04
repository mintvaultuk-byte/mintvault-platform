/**
 * Pending-switch cookie + nonce helpers for the /account/switch confirm flow.
 *
 * When a magic-link verify produces an email that differs from the existing
 * session's customerEmail, we don't switch silently. Instead we:
 *   1. INSERT a row into pending_switch_nonces (nonce, email_target)
 *   2. Issue a signed temp cookie containing {email, issuedAt, nonce}
 *   3. Redirect to /account/switch which renders a confirm page
 *   4. POST /account/switch/confirm verifies the cookie, atomically consumes
 *      the nonce row, regenerates the session, sets customerEmail.
 *
 * Cookie shape: {payloadB64url}.{hmacB64url}, HMAC-SHA256(SIGNED_URL_SECRET).
 * 5-min TTL on both the cookie and the DB row's consume-window. Single-use
 * enforced by the atomic UPDATE in consumePendingSwitch.
 */

import crypto from "crypto";
import type { Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";

const COOKIE_NAME = "__mv_pending_switch";
const COOKIE_TTL_SECONDS = 5 * 60;
const PAYLOAD_TTL_MS = 5 * 60 * 1000;

interface PendingSwitchPayload {
  email: string;
  issuedAt: number;
  nonce: string;
}

function getSecret(): string {
  const s = process.env.SIGNED_URL_SECRET;
  if (!s) throw new Error("SIGNED_URL_SECRET environment secret is required");
  return s;
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + "=".repeat(pad), "base64");
}

function sign(payloadJson: string): Buffer {
  return crypto.createHmac("sha256", getSecret()).update(payloadJson).digest();
}

export async function createPendingSwitchCookie(email: string): Promise<{ name: string; value: string; attrs: string; nonce: string }> {
  const nonce = crypto.randomBytes(32).toString("hex");
  const normalEmail = email.toLowerCase().trim();
  await db.execute(sql`
    INSERT INTO pending_switch_nonces (nonce, email_target)
    VALUES (${nonce}, ${normalEmail})
  `);
  const payload: PendingSwitchPayload = { email: normalEmail, issuedAt: Date.now(), nonce };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadJson);
  const sigB64 = b64urlEncode(sign(payloadJson));
  const value = `${payloadB64}.${sigB64}`;
  const isProd = process.env.NODE_ENV === "production";
  const attrs = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_TTL_SECONDS}${isProd ? "; Secure" : ""}`;
  return { name: COOKIE_NAME, value, attrs, nonce };
}

export type VerifiedPendingSwitch =
  | { valid: true; email: string; nonce: string }
  | { valid: false; reason: string };

export function verifyPendingSwitchCookie(rawCookie: string | undefined): VerifiedPendingSwitch {
  if (!rawCookie) return { valid: false, reason: "no_cookie" };
  const parts = rawCookie.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [payloadB64, sigB64] = parts;
  let payloadJson: string;
  let providedSig: Buffer;
  try {
    payloadJson = b64urlDecode(payloadB64).toString("utf8");
    providedSig = b64urlDecode(sigB64);
  } catch {
    return { valid: false, reason: "decode_failed" };
  }
  const expectedSig = sign(payloadJson);
  if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { valid: false, reason: "bad_signature" };
  }
  let payload: PendingSwitchPayload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { valid: false, reason: "bad_payload" };
  }
  if (typeof payload.email !== "string" || typeof payload.issuedAt !== "number" || typeof payload.nonce !== "string") {
    return { valid: false, reason: "schema_mismatch" };
  }
  if (Date.now() - payload.issuedAt > PAYLOAD_TTL_MS) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, email: payload.email, nonce: payload.nonce };
}

/** Atomic single-use consume. Returns true if this call consumed the nonce,
 *  false if it was already consumed, expired, or doesn't exist. */
export async function consumePendingSwitch(nonce: string): Promise<boolean> {
  const r = await db.execute(sql`
    UPDATE pending_switch_nonces
    SET consumed_at = NOW()
    WHERE nonce = ${nonce}
      AND consumed_at IS NULL
      AND issued_at > NOW() - INTERVAL '5 minutes'
    RETURNING nonce
  `);
  return r.rows.length === 1;
}

export function setPendingSwitchCookie(res: Response, value: string, attrs: string): void {
  // append rather than setHeader so we don't clobber express-session's mv.sid Set-Cookie
  res.append("Set-Cookie", `${COOKIE_NAME}=${value}; ${attrs}`);
}

export function clearPendingSwitchCookie(res: Response): void {
  const isProd = process.env.NODE_ENV === "production";
  res.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProd ? "; Secure" : ""}`);
}

/** Read a single cookie by name from req.headers.cookie. Avoids adding
 *  cookie-parser as a dependency just for this one cookie. */
export function readSwitchCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const parts = header.split(";").map((c) => c.trim());
  for (const c of parts) {
    const idx = c.indexOf("=");
    if (idx > 0 && c.slice(0, idx) === COOKIE_NAME) return c.slice(idx + 1);
  }
  return undefined;
}

export function maskEmail(email: string): string {
  const idx = email.indexOf("@");
  if (idx < 1) return "[invalid]";
  return email.slice(0, 2) + "***@" + email.slice(idx + 1);
}

export function ipHash(ip: string): string {
  return crypto.createHmac("sha256", getSecret()).update(ip).digest("hex").slice(0, 16);
}

/** Fire-and-forget cleanup — called from confirm + cancel handlers before
 *  their main work. Removes nonce rows older than 1 hour (consumed or not).
 *  Errors swallowed so cleanup never blocks the user-facing response. */
export function cleanupStaleNonces(): void {
  db.execute(sql`DELETE FROM pending_switch_nonces WHERE issued_at < NOW() - INTERVAL '1 hour'`)
    .catch((e: any) => console.warn("[account-switch] nonce cleanup failed:", e?.message ?? e));
}

export const PENDING_SWITCH_COOKIE_NAME = COOKIE_NAME;
