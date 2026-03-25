import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const ADMIN_EMAIL = "admin@mintvaultuk.co.uk";

const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const pinAttempts = new Map<string, { count: number; firstAttempt: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_PIN_ATTEMPTS = 5;
const FAILED_LOGIN_DELAY_MS = 400;
const PENDING_ADMIN_TTL_MS = 5 * 60 * 1000;

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first.trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    const padded = Buffer.alloc(bufA.length);
    bufB.copy(padded);
    crypto.timingSafeEqual(bufA, padded);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isLoginRateLimited(req: Request): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry) return false;

  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }

  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

export function isPinRateLimited(req: Request): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = pinAttempts.get(ip);

  if (!entry) return false;

  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    pinAttempts.delete(ip);
    return false;
  }

  return entry.count >= MAX_PIN_ATTEMPTS;
}

export function recordFailedLogin(req: Request): void {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

export function recordFailedPin(req: Request): number {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = pinAttempts.get(ip);

  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    pinAttempts.set(ip, { count: 1, firstAttempt: now });
    return 1;
  } else {
    entry.count++;
    return entry.count;
  }
}

export function clearLoginAttempts(req: Request): void {
  const ip = getClientIp(req);
  loginAttempts.delete(ip);
}

export function clearPinAttempts(req: Request): void {
  const ip = getClientIp(req);
  pinAttempts.delete(ip);
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const raw = process.env.ADMIN_PASSWORD;
  if (!raw) return false;
  return timingSafeEqual(password.trim(), raw.trim());
}

export async function verifyAdminPin(pin: string): Promise<boolean> {
  const raw = process.env.ADMIN_PIN;
  if (!raw) return false;
  return timingSafeEqual(pin.trim(), raw.trim());
}

export function isPendingAdminValid(req: Request): boolean {
  if (!req.session?.pendingAdmin) return false;
  if (!req.session?.pendingAdminAt) return false;
  const elapsed = Date.now() - req.session.pendingAdminAt;
  return elapsed < PENDING_ADMIN_TTL_MS;
}

export function clearPendingAdmin(req: Request): void {
  if (req.session) {
    req.session.pendingAdmin = false;
    req.session.pendingAdminAt = undefined;
    req.session.pinFailures = 0;
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

export function adminIpAllowlist(req: Request, res: Response, next: NextFunction) {
  const allowlist = process.env.ADMIN_IP_ALLOWLIST;
  if (!allowlist) return next();

  const allowed = allowlist.split(",").map(ip => ip.trim()).filter(Boolean);
  if (allowed.length === 0) return next();

  const clientIp = getClientIp(req);
  if (allowed.includes(clientIp)) return next();

  return res.status(403).json({ error: "Forbidden" });
}

export { ADMIN_EMAIL, FAILED_LOGIN_DELAY_MS };

declare module "express-session" {
  interface SessionData {
    isAdmin: boolean;
    adminEmail: string;
    pendingAdmin: boolean;
    pendingAdminAt: number | undefined;
    pinFailures: number;
  }
}
