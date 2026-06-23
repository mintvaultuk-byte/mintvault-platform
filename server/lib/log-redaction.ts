/**
 * Redacts sensitive fields from an API response body before it is written to
 * the request log (the response logger in server/index.ts).
 *
 * Phase 1 (security/redact-logs-and-errors): widened from the Phase 0 seam
 * (which stripped only `password`) to a recursive deny-list that covers auth
 * tokens, secrets, cookies, signed/presigned URLs, JWTs, and email addresses —
 * by KEY name and, for strings, by VALUE shape (so a signed URL or JWT nested
 * in an arbitrarily-named field is still caught). Structure is preserved
 * (the key stays, the value becomes the placeholder) so logs remain useful for
 * debugging. The input is never mutated.
 */

export const REDACTED = "[REDACTED]";

// Key names whose VALUE must never be logged. Compared after lower-casing and
// stripping non-alphanumerics, so `customer_email`, `customerEmail`,
// `customer-email` all match `customeremail`.
const SENSITIVE_KEYS = new Set([
  // auth / secrets
  "password",
  "pass",
  "pwd",
  "passwordhash",
  "pinhash",
  "pin",
  "otp",
  "token",
  "tokens",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "resettoken",
  "magiclinktoken",
  "verificationtoken",
  "apikey",
  "secret",
  "clientsecret",
  "stripeclientsecret",
  "paymentintentclientsecret",
  "sessionsecret",
  "signedurlsecret",
  "signature",
  "authorization",
  "auth",
  "cookie",
  "setcookie",
  "sessionid",
  "sid",
  // signed URLs / object access
  "signedurl",
  "presignedurl",
  "uploadurl",
  "downloadurl",
  // PII — email + phone
  "email",
  "emailaddress",
  "customeremail",
  "useremail",
  "adminemail",
  "graderemail",
  "staffemail",
  "toemail",
  "fromemail",
  "recipientemail",
  "phone",
  "phonenumber",
  "mobile",
]);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a STRING value looks sensitive regardless of its key name. */
function valueLooksSensitive(value: string): boolean {
  if (value.length === 0) return false;
  // Presigned / signature-bearing URL (R2/S3, Azure SAS, generic ?token=).
  // Linear literal-alternation scan — safe even on very long strings.
  if (/^https?:\/\//i.test(value) && /[?&](x-amz-signature|x-amz-credential|signature|sig|token|se|sv)=/i.test(value)) {
    return true;
  }
  // JWT / email regexes only on bounded-length inputs that contain the marker
  // char first — avoids running backtracking-prone patterns on huge strings.
  if (value.length <= 2048) {
    if (value.includes(".") && JWT_RE.test(value)) return true;
    if (value.includes("@") && EMAIL_RE.test(value)) return true;
  }
  // Opaque token/secret: bounded 40–128 chars of base64url/hex, no spaces.
  // Upper bound avoids redacting long legitimate base64 blobs (e.g. embedded
  // image/PDF data), which are not secrets.
  if (value.length >= 40 && value.length <= 128 && /^[A-Za-z0-9_+/=-]+$/.test(value)) return true;
  return false;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// `ancestors` tracks only the objects on the CURRENT recursion path, so genuine
// cycles are caught while benign shared references (the same object appearing in
// two sibling fields) are NOT falsely redacted.
function sanitizeValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    return valueLooksSensitive(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return REDACTED; // pathological nesting guard
  if (ancestors.has(value as object)) return REDACTED; // true cycle on this path

  // Only recurse into plain objects and arrays. Dates, Buffers, Maps and class
  // instances are returned untouched so the log keeps their natural shape (and
  // we never explode a Buffer into per-byte fields).
  if (!Array.isArray(value) && !isPlainObject(value as object)) return value;

  ancestors.add(value as object);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => sanitizeValue(v, depth + 1, ancestors));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = SENSITIVE_KEYS.has(normalizeKey(k)) ? REDACTED : sanitizeValue(v, depth + 1, ancestors);
    }
    out = obj;
  }
  ancestors.delete(value as object);
  return out;
}

export function sanitizeResponseBodyForLog(body: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!body || typeof body !== "object") return body;
  return sanitizeValue(body, 0, new Set<object>()) as Record<string, any>;
}
