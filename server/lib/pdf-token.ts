import crypto from "crypto";

// H-a — hardened access token for the public, token-gated PII PDFs (packing
// slip + shipping label). Replaces the old `HMAC(sid).hex.slice(0,16)` scheme,
// which was 64-bit, never expired, and compared with `!==` (timing-unsafe).
//
// Token shape (stateless, no DB): "<expEpochSeconds>.<hmacHex>" where
//   hmac = HMAC-SHA256(SIGNED_URL_SECRET, `${id}.${exp}`)   (full 256-bit)
// Properties: timing-safe verify, 256-bit entropy, expiring (TTL baked + signed),
// and owner-bound — the id is inside the signed payload, so a token minted for
// submission A cannot unlock submission B's PDF.

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — comfortably covers the "print + ship your cards" window

function secret(): string {
  const s = process.env.SIGNED_URL_SECRET;
  if (!s) throw new Error("SIGNED_URL_SECRET environment secret is required");
  return s;
}

function sign(id: string, exp: number): string {
  return crypto.createHmac("sha256", secret()).update(`${id}.${exp}`).digest("hex");
}

/** Mint a signed, expiring, owner-bound token for the given record id. */
export function generatePdfToken(id: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const exp = Math.floor((Date.now() + ttlMs) / 1000);
  return `${exp}.${sign(id, exp)}`;
}

/** Constant-time verify. Returns false for missing/malformed/expired/wrong-owner tokens. */
export function verifyPdfToken(id: string, token: unknown): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isInteger(exp) || exp <= 0) return false;
  if (exp * 1000 < Date.now()) return false; // expired
  const expected = sign(id, exp);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  // Unequal length (incl. malformed/legacy 16-char tokens) → reject before
  // timingSafeEqual, which throws on length mismatch.
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
