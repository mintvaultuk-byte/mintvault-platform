import crypto from "node:crypto";

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/business.manage";
const KEY_BYTES = 32;

export interface GoogleBusinessConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
  keyVersion: number;
}

export type GoogleConfigReadiness =
  | { ready: true; config: GoogleBusinessConfig }
  | { ready: false; reason: "not_configured" };

function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const value = raw.trim();
  try {
    if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
    const decoded = Buffer.from(value, "base64");
    return decoded.length === KEY_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

export function googleBusinessConfigReadiness(env: NodeJS.ProcessEnv = process.env): GoogleConfigReadiness {
  const clientId = env.GOOGLE_BUSINESS_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_BUSINESS_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_BUSINESS_OAUTH_REDIRECT_URI?.trim();
  const encryptionKey = parseEncryptionKey(env.GOOGLE_BUSINESS_OAUTH_ENC_KEY);
  if (!clientId || !clientSecret || !redirectUri || !encryptionKey) return { ready: false, reason: "not_configured" };
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      return { ready: false, reason: "not_configured" };
    }
  } catch {
    return { ready: false, reason: "not_configured" };
  }
  const keyVersion = Number(env.GOOGLE_BUSINESS_OAUTH_KEY_VERSION ?? "1");
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) return { ready: false, reason: "not_configured" };
  return { ready: true, config: { clientId, clientSecret, redirectUri, encryptionKey, keyVersion } };
}

export function encryptGoogleSecret(plain: string, config: GoogleBusinessConfig, aad: string): string {
  if (!plain || !aad) throw new Error("google_secret_input_invalid");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptGoogleSecret(value: string, config: GoogleBusinessConfig, aad: string): string {
  const [version, ivRaw, tagRaw, cipherRaw, extra] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !cipherRaw || extra) throw new Error("google_secret_format_invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.encryptionKey, Buffer.from(ivRaw, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherRaw, "base64url")), decipher.final()]).toString("utf8");
}

export interface GoogleOAuthProof {
  state: string;
  stateHash: string;
  verifier: string;
  challenge: string;
}

export function createGoogleOAuthProof(): GoogleOAuthProof {
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(64).toString("base64url");
  return {
    state,
    stateHash: hashGoogleOAuthState(state),
    verifier,
    challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function hashGoogleOAuthState(state: string): string {
  return crypto.createHash("sha256").update(state, "utf8").digest("hex");
}

export function googleOAuthAuthorizationUrl(
  config: GoogleBusinessConfig,
  proof: Pick<GoogleOAuthProof, "state" | "challenge">
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: proof.state,
    code_challenge: proof.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function oauthVerifierAad(input: {
  tenantId: string;
  locationId: string;
  userId: string;
  sessionId: string;
}): string {
  return `google-oauth:${input.tenantId}:${input.locationId}:${input.userId}:${input.sessionId}`;
}

export function refreshTokenAad(input: { tenantId: string; locationId: string; connectionId: string }): string {
  return `google-refresh:${input.tenantId}:${input.locationId}:${input.connectionId}`;
}
