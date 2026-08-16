import crypto from "crypto";

/**
 * Phone-QR upload token — stateless, signed, expiring and target-bound (invariant I19).
 *
 * REPLACES a module-level `Map<string, {certId, imageType, expiresAt}>` in server/routes.ts. That
 * store was authoritative and per-process, which is broken on the two-Machine production topology:
 * the admin's browser minted a token on Machine A and encoded it into a QR code, but the phone that
 * scans it is a DIFFERENT client with no session affinity, so roughly half of scans were routed to
 * Machine B — whose Map had never seen the token — and failed with "Invalid or expired token". The
 * feature broke intermittently and looked like a token-expiry bug. It also lost every outstanding
 * token on each rolling deploy.
 *
 * This carries no security regression: the old scheme was 128 bits of randomness in a server-side
 * map; this is a full 256-bit HMAC over the target, verified in constant time. It is strictly
 * stronger because the target is INSIDE the signed payload — a token minted for
 * (MV123, front) cannot be replayed against (MV999, back), which the map-based scheme only prevented
 * for imageType and never for certId.
 *
 * Shape: "<expEpochSeconds>.<hmacHex>", hmac = HMAC-SHA256(SIGNED_URL_SECRET, `${certId}.${imageType}.${exp}`).
 * Deliberately identical in construction to server/lib/pdf-token.ts — one signed-token idiom in this
 * codebase, not two.
 *
 * NOT REVOCABLE BEFORE EXPIRY, by design. A stateless token cannot be withdrawn early; the 15-minute
 * TTL is the bound. That matches the previous behaviour (the old map was only pruned opportunistically
 * and had no revocation path either) and suits the use case: a QR code shown on screen for one upload.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes — the on-screen QR lifetime, unchanged from before

function secret(): string {
  const s = process.env.SIGNED_URL_SECRET;
  if (!s) throw new Error("SIGNED_URL_SECRET environment secret is required");
  return s;
}

function sign(certId: string, imageType: string, exp: number): string {
  return crypto.createHmac("sha256", secret()).update(`${certId}.${imageType}.${exp}`).digest("hex");
}

/** Mint a signed, expiring token bound to exactly this certificate and image side. */
export function generateUploadToken(
  certId: string,
  imageType: string,
  ttlMs: number = DEFAULT_TTL_MS
): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlMs;
  const exp = Math.floor(expiresAt / 1000);
  return { token: `${exp}.${sign(certId, imageType, exp)}`, expiresAt };
}

/**
 * Constant-time verify. Returns false for missing, malformed, expired, or wrong-target tokens.
 * Because the target is signed, a mismatched certId or imageType simply fails to verify — no
 * separate equality check is needed, and none can be forgotten.
 */
export function verifyUploadToken(certId: string, imageType: string, token: unknown): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isInteger(exp) || exp <= 0) return false;
  if (exp * 1000 < Date.now()) return false; // expired
  const expected = sign(certId, imageType, exp);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  // Unequal length (including malformed or legacy 32-char map tokens) is rejected before
  // timingSafeEqual, which throws on a length mismatch.
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
