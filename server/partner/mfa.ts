/**
 * Partner Portal — MFA foundation (Phase 1). RFC 6238 TOTP + single-use recovery codes, with an
 * AES-256-GCM secret-encryption abstraction. Implemented with Node's built-in crypto (no new dep).
 *
 * Secrets are encrypted at rest via `encryptSecret`. The encryption key comes from
 * PARTNER_MFA_ENC_KEY (32 bytes, base64 or hex). If no key is configured, encrypt/decrypt FAIL
 * CLOSED (throw) — MFA cannot silently store plaintext. For local tests a clearly-synthetic key is
 * injected via env and never committed. MFA secrets/recovery codes never appear in logs/responses.
 */
import crypto from "node:crypto";

// ---------------- encryption abstraction (fail closed) ----------------
function encKey(): Buffer {
  const raw = process.env.PARTNER_MFA_ENC_KEY;
  if (!raw) throw new Error("PARTNER_MFA_ENC_KEY not configured — MFA secret encryption fails closed.");
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("PARTNER_MFA_ENC_KEY must be 32 bytes (hex or base64).");
  return buf;
}

export function mfaEncryptionConfigured(): boolean {
  try {
    encKey();
    return true;
  } catch {
    return false;
  }
}

/** Returns "v1:<iv b64>:<tag b64>:<ciphertext b64>". Throws (fail closed) with no key. */
export function encryptSecret(plaintext: string): string {
  const key = encKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const key = encKey();
  const [v, ivb, tagb, ctb] = blob.split(":");
  if (v !== "v1" || !ivb || !tagb || !ctb) throw new Error("bad ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivb, "base64"));
  decipher.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctb, "base64")), decipher.final()]).toString("utf8");
}

// ---------------- TOTP (RFC 6238) ----------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = "";
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx === -1) throw new Error("bad base32");
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (bin % 1_000_000).toString().padStart(6, "0");
}

/** Verify a 6-digit TOTP with ±1 step tolerance. `now` in ms (tests pass a fixed clock). */
export function verifyTotp(base32Secret: string, code: string, nowMs: number, stepSeconds = 30): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(base32Secret);
  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  for (let w = -1; w <= 1; w++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, counter + w)), Buffer.from(code))) return true;
  }
  return false;
}

/** Current TOTP (for enrolment verification / tests). */
export function currentTotp(base32Secret: string, nowMs: number, stepSeconds = 30): string {
  return hotp(base32Decode(base32Secret), Math.floor(nowMs / 1000 / stepSeconds));
}

// ---------------- recovery codes (single use) ----------------
export function generateRecoveryCodes(n = 10): { plaintext: string[]; hashes: string[] } {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    plaintext.push(code);
    hashes.push(crypto.createHash("sha256").update(code).digest("hex"));
  }
  return { plaintext, hashes };
}

export function recoveryHash(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}
