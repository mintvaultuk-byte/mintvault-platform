import type { Request, Response } from "express";

const SESSION_COOKIE_NAME = "mv.sid";

type AdminAuthReason =
  | "admin_login_pending"
  | "admin_login_success"
  | "admin_logout"
  | "admin_session_expired"
  | "admin_session_invalid"
  | "admin_session_wrong_portal"
  | "admin_session_save_failed"
  | "admin_session_destroy_failed"
  | "admin_session_clear";

function machineId(): string {
  return process.env.FLY_MACHINE_ID || process.env.HOSTNAME || "local";
}

function requestId(req: Request): string {
  const header = req.header("fly-request-id") || req.header("x-request-id");
  if (header) return header;
  return "unavailable";
}

function hasSessionCookie(req: Request): boolean {
  const raw = req.headers.cookie;
  if (!raw) return false;
  return raw.split(";").some((part) => part.trim().startsWith(`${SESSION_COOKIE_NAME}=`));
}

function logAdminAuth(req: Request, reason: AdminAuthReason, extra: Record<string, unknown> = {}) {
  console.log(
    `[admin-auth] ${reason} machine=${machineId()} requestId=${requestId(req)} ` +
      `method=${req.method} path=${req.path} cookiePresent=${hasSessionCookie(req)} ${JSON.stringify(extra)}`
  );
}

function clearAdminCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export function adminSessionSave(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

export function adminSessionDestroy(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export async function clearAdminSession(req: Request, res: Response, reason: AdminAuthReason): Promise<void> {
  try {
    if (req.session) {
      await adminSessionDestroy(req);
    }
    logAdminAuth(req, reason);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logAdminAuth(req, "admin_session_destroy_failed", { reason, error: message });
  } finally {
    clearAdminCookie(res);
  }
}

export function classifyAdminSession(
  req: Request
):
  | { authenticated: true; email: string }
  | { authenticated: false; reason: "session_expired" | "invalid_session" | "wrong_portal" | "not_authenticated" } {
  const s = req.session as Partial<{
    isAdmin: boolean;
    adminEmail: string;
    isGrader: boolean;
    isStaff: boolean;
    pendingAdmin: boolean;
  }>;
  if (s?.isAdmin === true && s.adminEmail) return { authenticated: true, email: s.adminEmail };
  if (s?.isAdmin === true) return { authenticated: false, reason: "invalid_session" };

  const cookiePresent = hasSessionCookie(req);
  if (s?.isGrader || s?.isStaff) return { authenticated: false, reason: "wrong_portal" };
  if (s?.pendingAdmin) return { authenticated: false, reason: "invalid_session" };
  if (cookiePresent) return { authenticated: false, reason: "session_expired" };
  return { authenticated: false, reason: "not_authenticated" };
}

export function logAdminSessionCreated(
  req: Request,
  reason: Extract<AdminAuthReason, "admin_login_pending" | "admin_login_success">
) {
  logAdminAuth(req, reason);
}

export function logAdminSessionValidationFailure(req: Request, reason: AdminAuthReason) {
  logAdminAuth(req, reason);
}

export function shouldRateLimitAdminCredentialRequest(req: Request): boolean {
  return req.method === "POST";
}
