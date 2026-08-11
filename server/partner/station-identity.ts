import crypto from "node:crypto";

export const STATION_CODE_RE = /^MV-STN-[A-Z2-7]{10,24}$/;
export const STATION_SIGNATURE_MAX_SKEW_MS = 2 * 60_000;

export type StationRequestEnvelope = {
  stationCode: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: bigint;
  contentSha256: string;
};

export class StationIdentityError extends Error {
  constructor(
    readonly code:
      | "invalid_station_code"
      | "invalid_timestamp"
      | "expired_timestamp"
      | "invalid_nonce"
      | "invalid_content_hash"
      | "invalid_signature"
      | "invalid_public_key",
    message: string
  ) {
    super(message);
  }
}

function requiredHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const raw = headers[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value.trim())
    throw new StationIdentityError("invalid_signature", `Missing ${key} header`);
  return value.trim();
}

export function canonicalStationRequest(input: StationRequestEnvelope): string {
  return [
    "mintvault-station-request-v1",
    input.stationCode,
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce.toString(),
    input.contentSha256,
  ].join("\n");
}

export function normalizeStationPublicKey(publicKeyPem: string): string {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new StationIdentityError("invalid_public_key", "Station public key must be Ed25519");
    }
    return key.export({ format: "pem", type: "spki" }).toString();
  } catch (error) {
    if (error instanceof StationIdentityError) throw error;
    throw new StationIdentityError("invalid_public_key", "Station public key is invalid");
  }
}

export function stationPublicKeyFingerprint(publicKeyPem: string): string {
  const normalised = normalizeStationPublicKey(publicKeyPem);
  const key = crypto.createPublicKey(normalised);
  return crypto
    .createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
}

export function createStationCode(randomBytes = crypto.randomBytes): string {
  // RFC 4648 Base32 alphabet excluding ambiguous human characters. 80 bits is
  // ample for 10k stations; the database unique constraint remains definitive.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let body = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      body += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) body += alphabet[(value << (5 - bits)) & 31];
  return `MV-STN-${body}`;
}

export function parseStationRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  now = Date.now()
): { envelope: StationRequestEnvelope; signature: string } {
  const stationCode = requiredHeader(headers, "x-mintvault-station-id").toUpperCase();
  if (!STATION_CODE_RE.test(stationCode)) {
    throw new StationIdentityError("invalid_station_code", "Station identity is invalid");
  }
  const timestamp = Number(requiredHeader(headers, "x-mintvault-station-timestamp"));
  if (!Number.isSafeInteger(timestamp))
    throw new StationIdentityError("invalid_timestamp", "Station timestamp is invalid");
  if (Math.abs(now - timestamp) > STATION_SIGNATURE_MAX_SKEW_MS) {
    throw new StationIdentityError("expired_timestamp", "Station request timestamp is outside the permitted window");
  }
  const rawNonce = requiredHeader(headers, "x-mintvault-station-nonce");
  if (!/^[1-9][0-9]{0,18}$/.test(rawNonce))
    throw new StationIdentityError("invalid_nonce", "Station request nonce is invalid");
  const nonce = BigInt(rawNonce);
  const contentSha256 = requiredHeader(headers, "x-mintvault-content-sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw new StationIdentityError("invalid_content_hash", "Station content hash is invalid");
  }
  return {
    envelope: { stationCode, method, path, timestamp, nonce, contentSha256 },
    signature: requiredHeader(headers, "x-mintvault-station-signature"),
  };
}

/** Verify the signed request-body digest whenever Express retained raw bytes. */
export function assertStationRequestBodyDigest(envelope: StationRequestEnvelope, rawBody: unknown): void {
  if (!Buffer.isBuffer(rawBody)) return;
  const actual = crypto.createHash("sha256").update(rawBody).digest("hex");
  if (actual !== envelope.contentSha256) {
    throw new StationIdentityError("invalid_content_hash", "Station request body does not match its signed digest");
  }
}

export function verifyStationSignature(
  publicKeyPem: string,
  envelope: StationRequestEnvelope,
  signature: string
): boolean {
  try {
    const key = crypto.createPublicKey(normalizeStationPublicKey(publicKeyPem));
    return crypto.verify(
      null,
      Buffer.from(canonicalStationRequest(envelope)),
      key,
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}
