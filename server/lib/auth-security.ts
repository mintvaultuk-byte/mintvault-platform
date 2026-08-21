import type { Request, Response } from "express";

export const SESSION_COOKIE_NAME = "mv.sid";
export const ADMIN_ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const STAFF_ABSOLUTE_SESSION_MS = 14 * 24 * 60 * 60 * 1000;

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE =
  /(password|passphrase|pin|token|access_token|refresh_token|authorization|authorization_code|code_verifier|codeVerifier|clientAssertion|client_secret|credential|cookie|session|secret|passwordHash|pinHash|invitationLink|inviteToken)/i;
const INVITATION_URL_TOKEN_RE = /(\/partner\/invite\?token=)[A-Za-z0-9_-]+/g;

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export function stampAuthSession(
  req: Request,
  opts: { userId: string; credentialVersion: number; role: "admin" | "staff" | "customer" }
) {
  const s = req.session as any;
  const now = Date.now();
  s.authUserId = opts.userId;
  s.authRole = opts.role;
  s.credentialVersion = opts.credentialVersion;
  s.authenticatedAt = now;
}

export function credentialVersionOf(row: unknown): number {
  const version = Number((row as any)?.credentialVersion ?? (row as any)?.credential_version ?? 1);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

export function isAbsoluteSessionExpired(req: Request, maxAgeMs: number): boolean {
  const created = Number((req.session as any)?.authenticatedAt ?? 0);
  if (!created || !Number.isFinite(created)) return true;
  return Date.now() - created > maxAgeMs;
}

export async function destroySessionAndClearCookie(req: Request, res: Response): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
  clearSessionCookie(res);
}

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(INVITATION_URL_TOKEN_RE, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactSensitive(inner);
  }
  return out;
}
