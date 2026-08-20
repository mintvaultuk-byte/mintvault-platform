import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { storage } from "../storage";
import {
  verifyAdminPassword,
  requireAdmin,
  isLoginRateLimited,
  isAdminPasswordLockedOut,
  registerAdminPasswordFailure,
  clearAdminPasswordFailures,
  isPinRateLimited,
  recordFailedLogin,
  recordFailedPin,
  clearLoginAttempts,
  clearPinAttempts,
  isPendingAdminValid,
  clearPendingAdmin,
  ADMIN_EMAIL,
  FAILED_LOGIN_DELAY_MS,
  isSuperAdminEmail,
  requireSuperAdmin,
} from "../auth";
import { recordAdminStepUp, clearAdminStepUp, ADMIN_STEP_UP_WINDOW_MINUTES } from "../lib/admin-step-up";
import { createMagicToken, verifyMagicToken, requireCustomer } from "../customer-auth";
import { sendMagicLink, sendPinResetLink } from "../email";
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  createEmailVerificationToken,
  createPasswordResetToken,
  createAccountMagicLinkToken,
  findUserByEmail,
  findUserById,
  countRecentFailedAttempts,
  logLoginAttempt,
  writeAuthAudit,
} from "../account-auth";
import {
  sendWelcomeVerificationEmail,
  sendAccountMagicLinkEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendEmailChangedNotification,
  sendAccountDeletedEmail,
} from "../email";
import { requireAuth } from "../middleware/auth";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { APP_BASE_URL } from "../app-url";
import {
  adminSessionSave,
  classifyAdminSession,
  clearAdminSession,
  logAdminSessionCreated,
  logAdminSessionValidationFailure,
} from "../lib/admin-auth-session";
import {
  ADMIN_ABSOLUTE_SESSION_MS,
  credentialVersionOf,
  clearSessionCookie,
  isAbsoluteSessionExpired,
  stampAuthSession,
} from "../lib/auth-security";
import { adminClientIpRateLimitKey } from "../lib/admin-client-ip";

export function registerAuthRoutes(app: Express): void {
  const adminCredentialRateLimit = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { error: "Too many login attempts, please try again later" },
    keyGenerator: adminClientIpRateLimitKey,
  });

  // ── Admin login ────────────────────────────────────────────────────────────
  app.post("/api/admin/login", adminCredentialRateLimit, async (req, res) => {
    try {
      if (isLoginRateLimited(req)) {
        return res.status(429).json({ error: "Too many login attempts, please try again later" });
      }
      // Durable, fleet-wide lockout (invariant I19). The in-memory check above is per-process, so on
      // the two-Machine topology it only ever bounded half the traffic and reset on every deploy.
      const durableLock = await isAdminPasswordLockedOut();
      if (durableLock.locked) {
        return res.status(429).json({ error: "Too many login attempts, please try again later" });
      }

      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const verification = await verifyAdminPassword(password);
      if (!verification.valid) {
        recordFailedLogin(req);
        await registerAdminPasswordFailure();
        await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(401).json({ error: "Invalid credentials" });
      }

      clearLoginAttempts(req);
      await clearAdminPasswordFailures();
      req.session.pendingAdmin = true;
      req.session.pendingAdminAt = Date.now();
      req.session.pinFailures = 0;
      await adminSessionSave(req);
      logAdminSessionCreated(req, "admin_login_pending");
      res.json({ step: "PIN_REQUIRED" });
    } catch (error: any) {
      console.error("Login error:", error.message);
      res.status(500).json({ error: "Invalid credentials" });
    }
  });

  app.post("/api/admin/session", adminCredentialRateLimit, async (req, res) => {
    try {
      if (isLoginRateLimited(req)) {
        return res.status(429).json({ error: "Too many login attempts, please try again later" });
      }
      // Durable, fleet-wide lockout (invariant I19). The in-memory check above is per-process, so on
      // the two-Machine topology it only ever bounded half the traffic and reset on every deploy.
      const durableLock = await isAdminPasswordLockedOut();
      if (durableLock.locked) {
        return res.status(429).json({ error: "Too many login attempts, please try again later" });
      }

      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const verification = await verifyAdminPassword(password);
      if (!verification.valid) {
        recordFailedLogin(req);
        await registerAdminPasswordFailure();
        await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(401).json({ error: "Invalid credentials" });
      }

      clearLoginAttempts(req);
      await clearAdminPasswordFailures();
      req.session.pendingAdmin = true;
      req.session.pendingAdminAt = Date.now();
      req.session.pinFailures = 0;
      await adminSessionSave(req);
      logAdminSessionCreated(req, "admin_login_pending");
      res.json({ step: "PIN_REQUIRED" });
    } catch (error: any) {
      console.error("Login error:", error.message);
      res.status(500).json({ error: "Invalid credentials" });
    }
  });

  /**
   * AG-3b — SUPER ADMIN STEP-UP: re-prove the human behind an existing admin session.
   *
   * NOT A SECOND LOGIN. It issues no session, regenerates nothing and changes no privilege — it
   * stamps the session already in hand. `requireSuperAdmin` still decides WHO may act; this decides
   * whether they have proved themselves RECENTLY enough for a destructive action.
   *
   * Demands the SAME two factors the admin login does — passphrase and PIN — verified through the
   * same helpers, so there is one definition of "this is the administrator" rather than a weaker
   * copy. Rate-limited with the same limiter for the same reason.
   *
   * The lockout counters are deliberately shared with login: an attacker who has stolen a session
   * cookie and is guessing the PIN to unlock destructive actions must burn the same budget as one
   * guessing at the front door, and must trip the same lockout.
   */
  app.post("/api/admin/step-up", adminCredentialRateLimit, requireSuperAdmin, async (req, res) => {
    try {
      const { password, pin } = req.body ?? {};
      if (typeof password !== "string" || typeof pin !== "string" || !password || !pin) {
        return res.status(400).json({ error: "Password and PIN are required" });
      }

      const { verifyPin, checkLockout, registerFailure, resetFailures, logPinEvent, hashIp } = await import("../pin");
      const ipH = hashIp(req.ip || "unknown");
      const adminEmail = String((req.session as { adminEmail?: string }).adminEmail || ADMIN_EMAIL);

      const lockState = await checkLockout(adminEmail);
      if (lockState.locked) {
        await logPinEvent(adminEmail, false, "locked", ipH);
        return res.status(423).json({ error: "Account locked. Try again later." });
      }

      const adminUser = await storage.getUserByEmail(adminEmail);
      if (!adminUser || !(adminUser as { pinHash?: string }).pinHash) {
        await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const passwordCheck = await verifyAdminPassword(password, adminUser);
      const pinValid = passwordCheck.valid && (await verifyPin(pin, (adminUser as { pinHash: string }).pinHash));
      if (!passwordCheck.valid || !pinValid) {
        const post = await registerFailure(adminEmail);
        await logPinEvent(adminEmail, false, post.locked ? "lockout_triggered" : "wrong_pin", ipH);
        await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(post.locked ? 423 : 401).json({ error: "Invalid credentials" });
      }

      await resetFailures(adminEmail);
      await logPinEvent(adminEmail, true, "admin_step_up", ipH);
      await recordAdminStepUp(req);
      return res.json({ ok: true, windowMinutes: ADMIN_STEP_UP_WINDOW_MINUTES });
    } catch (err) {
      console.error("[admin step-up] failed:", (err as Error).message);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/admin/pin", adminCredentialRateLimit, async (req, res) => {
    try {
      if (isPinRateLimited(req)) {
        return res.status(429).json({ error: "Too many attempts, please try again later" });
      }

      if (!isPendingAdminValid(req)) {
        clearPendingAdmin(req);
        return res.status(401).json({ error: "Session expired, please start again" });
      }

      const { pin } = req.body;
      if (!pin) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      // LOCK-3: verify against the admin user's per-user bcrypt pin_hash,
      // not the legacy env-var ADMIN_PIN. If the admin has no pin_hash yet
      // (first time after PIN-auth deploy), surface PIN_SETUP_REQUIRED so
      // the frontend routes to /auth/pin/setup with admin context.
      const { verifyPin, checkLockout, registerFailure, resetFailures, logPinEvent, hashIp } = await import("../pin");
      const ipH = hashIp(req.ip || "unknown");

      const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
      if (!adminUser) {
        await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (!(adminUser as any).pinHash) {
        // PIN not yet set — keep pendingAdmin flag in session, frontend
        // routes the admin to /auth/pin/setup which uses pendingAdmin
        // as the admin-context authorisation flag.
        return res.json({ step: "PIN_SETUP_REQUIRED" });
      }

      const lockState = await checkLockout(ADMIN_EMAIL);
      if (lockState.locked) {
        await logPinEvent(ADMIN_EMAIL, false, "locked", ipH);
        clearPendingAdmin(req);
        return res.status(423).json({ error: "Account locked. Try again later." });
      }

      const valid = await verifyPin(pin, (adminUser as any).pinHash);
      if (!valid) {
        const post = await registerFailure(ADMIN_EMAIL);
        await logPinEvent(ADMIN_EMAIL, false, post.locked ? "lockout_triggered" : "wrong_pin", ipH);
        recordFailedPin(req); // session-level counter retained for back-compat
        req.session.pinFailures = (req.session.pinFailures || 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));

        if (post.locked || req.session.pinFailures >= 5) {
          clearPendingAdmin(req);
          return res.status(401).json({ error: "Too many failed attempts, please start again" });
        }
        return res.status(401).json({ error: "Invalid credentials" });
      }

      clearPinAttempts(req);
      await resetFailures(ADMIN_EMAIL);

      // Regenerate session on privilege escalation to admin.
      // Prevents pre-existing customer/account-holder fields from
      // surviving into the new admin session document (PR 3a).
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });

      req.session.userId = undefined as unknown as string;
      req.session.userEmail = undefined as unknown as string;
      req.session.customerEmail = undefined as unknown as string;
      req.session.isAdmin = true;
      req.session.adminEmail = ADMIN_EMAIL;
      stampAuthSession(req, {
        userId: String((adminUser as any).id),
        credentialVersion: credentialVersionOf(adminUser),
        role: "admin",
      });
      clearPendingAdmin(req);
      await adminSessionSave(req);
      logAdminSessionCreated(req, "admin_login_success");
      res.json({ success: true });
    } catch (error: any) {
      console.error("PIN error:", error.message);
      res.status(500).json({ error: "Invalid credentials" });
    }
  });

  app.post("/api/admin/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        logAdminSessionValidationFailure(req, "admin_session_destroy_failed");
        return res.status(500).json({ error: "Logout failed" });
      }
      clearSessionCookie(res);
      logAdminSessionValidationFailure(req, "admin_logout");
      res.json({ success: true });
    });
  });

  app.post("/api/admin/clear-session", async (req, res) => {
    await clearAdminSession(req, res, "admin_session_clear");
    res.json({ success: true });
  });

  app.get("/api/admin/session", async (req, res) => {
    const status = classifyAdminSession(req);
    if (status.authenticated) {
      const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
      if (
        !adminUser ||
        isAbsoluteSessionExpired(req, ADMIN_ABSOLUTE_SESSION_MS) ||
        Number((req.session as any).credentialVersion ?? 1) !== credentialVersionOf(adminUser)
      ) {
        logAdminSessionValidationFailure(req, "admin_session_expired");
        await clearAdminSession(req, res, "admin_session_expired");
        return res.status(401).json({ authenticated: false, reason: "session_expired" });
      }
      return res.json({ authenticated: true, email: status.email, isSuperAdmin: isSuperAdminEmail(status.email) });
    }

    if (status.reason === "session_expired") {
      logAdminSessionValidationFailure(req, "admin_session_expired");
      await clearAdminSession(req, res, "admin_session_expired");
      return res.status(401).json({ authenticated: false, reason: "session_expired" });
    }

    if (status.reason === "invalid_session" && req.session?.pendingAdmin && !isPendingAdminValid(req)) {
      clearPendingAdmin(req);
      await adminSessionSave(req);
      logAdminSessionValidationFailure(req, "admin_session_invalid");
      return res.status(401).json({ authenticated: false, reason: "session_expired" });
    }

    if (status.reason === "wrong_portal") {
      logAdminSessionValidationFailure(req, "admin_session_wrong_portal");
      return res.status(403).json({ authenticated: false, reason: "wrong_portal" });
    }

    res.json({ authenticated: false, reason: status.reason });
  });

  async function verifyAdminPinConfirmation(req: Request, pin: unknown): Promise<boolean> {
    const cleanPin = String(pin || "").trim();
    if (!cleanPin) return false;
    const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
    const pinHash = (adminUser as any)?.pinHash;
    if (!adminUser || !pinHash) return false;
    const { verifyPin, checkLockout, registerFailure, resetFailures, logPinEvent, hashIp } = await import("../pin");
    const ipH = hashIp(req.ip || "unknown");
    const lockState = await checkLockout(ADMIN_EMAIL);
    if (lockState.locked) {
      await logPinEvent(ADMIN_EMAIL, false, "locked", ipH);
      return false;
    }
    const ok = await verifyPin(cleanPin, pinHash);
    if (!ok) {
      const post = await registerFailure(ADMIN_EMAIL);
      await logPinEvent(ADMIN_EMAIL, false, post.locked ? "lockout_triggered" : "wrong_pin", ipH);
      return false;
    }
    await resetFailures(ADMIN_EMAIL);
    return true;
  }

  app.get("/api/admin/credentials/status", requireAdmin, async (_req, res) => {
    const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
    const hasDbHash = !!((adminUser as any)?.adminPassphraseHash ?? (adminUser as any)?.admin_passphrase_hash);
    res.json({
      adminPassphraseHashConfigured: hasDbHash,
      breakGlassFallbackActive: !hasDbHash && !!process.env.ADMIN_PASSWORD,
      credentialVersion: credentialVersionOf(adminUser),
    });
  });

  function requireSameOriginCredentialMutation(req: Request, res: Response, next: () => void) {
    const origin = req.get("origin");
    if (!origin) return next();
    try {
      const expected = `${req.protocol}://${req.get("host")}`;
      if (new URL(origin).origin !== expected) return res.status(403).json({ error: "Forbidden" });
    } catch {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  }

  app.post(
    "/api/admin/credentials/passphrase",
    adminCredentialRateLimit,
    requireAdmin,
    requireSameOriginCredentialMutation,
    async (req, res) => {
      try {
        const { currentPassphrase, newPassphrase, confirmPassphrase, pin } = req.body || {};
        if (!(await verifyAdminPinConfirmation(req, pin))) {
          await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
          return res.status(401).json({ error: "Invalid credentials" });
        }
        if (!newPassphrase || String(newPassphrase).length < 14 || newPassphrase !== confirmPassphrase) {
          return res.status(400).json({ error: "Invalid credentials" });
        }
        const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
        const current = await verifyAdminPassword(String(currentPassphrase || ""), adminUser);
        if (!current.valid) {
          await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
          return res.status(401).json({ error: "Invalid credentials" });
        }
        const newHash = await hashPassword(String(newPassphrase));
        const updated = await db.execute(sql`
        UPDATE users
        SET admin_passphrase_hash = ${newHash},
            credential_version = credential_version + 1,
            updated_at = NOW()
        WHERE LOWER(email) = LOWER(${ADMIN_EMAIL}) AND deleted_at IS NULL
        RETURNING id, credential_version
      `);
        const row = updated.rows[0];
        if (!row) return res.status(409).json({ error: "Credential update failed" });
        stampAuthSession(req, {
          userId: String((row as any).id),
          credentialVersion: credentialVersionOf(row),
          role: "admin",
        });
        await adminSessionSave(req);
        await storage.writeAuditLog(
          "auth",
          ADMIN_EMAIL,
          "admin_passphrase_changed",
          (req.session as any).adminEmail || "admin",
          {}
        );
        return res.json({ ok: true });
      } catch (err: any) {
        console.error("[admin-credentials] passphrase change failed:", err?.message ?? err);
        return res.status(500).json({ error: "Credential update failed" });
      }
    }
  );

  app.post(
    "/api/admin/credentials/pin",
    adminCredentialRateLimit,
    requireAdmin,
    requireSameOriginCredentialMutation,
    async (req, res) => {
      try {
        const { currentPin, newPin, confirmPin } = req.body || {};
        if (!(await verifyAdminPinConfirmation(req, currentPin))) {
          await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
          return res.status(401).json({ error: "Invalid credentials" });
        }
        if (!newPin || newPin !== confirmPin) return res.status(400).json({ error: "Invalid credentials" });
        const { hashPin, validatePinStrength, WeakPinError, resetFailures } = await import("../pin");
        try {
          validatePinStrength(String(newPin));
        } catch (e: any) {
          if (e instanceof WeakPinError) return res.status(422).json({ error: "Invalid credentials" });
          throw e;
        }
        const newHash = await hashPin(String(newPin));
        const updated = await db.execute(sql`
        UPDATE users
        SET pin_hash = ${newHash},
            pin_set_at = NOW(),
            pin_failed_count = 0,
            pin_locked_until = NULL,
            credential_version = credential_version + 1,
            updated_at = NOW()
        WHERE LOWER(email) = LOWER(${ADMIN_EMAIL}) AND deleted_at IS NULL
        RETURNING id, credential_version
      `);
        const row = updated.rows[0];
        if (!row) return res.status(409).json({ error: "Credential update failed" });
        await resetFailures(ADMIN_EMAIL);
        stampAuthSession(req, {
          userId: String((row as any).id),
          credentialVersion: credentialVersionOf(row),
          role: "admin",
        });
        await adminSessionSave(req);
        await storage.writeAuditLog(
          "auth",
          ADMIN_EMAIL,
          "admin_pin_changed",
          (req.session as any).adminEmail || "admin",
          {}
        );
        return res.json({ ok: true });
      } catch (err: any) {
        console.error("[admin-credentials] pin change failed:", err?.message ?? err);
        return res.status(500).json({ error: "Credential update failed" });
      }
    }
  );

  app.post(
    "/api/admin/credentials/revoke-sessions",
    adminCredentialRateLimit,
    requireAdmin,
    requireSameOriginCredentialMutation,
    async (req, res) => {
      try {
        const { pin } = req.body || {};
        if (!(await verifyAdminPinConfirmation(req, pin))) {
          await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
          return res.status(401).json({ error: "Invalid credentials" });
        }
        const updated = await db.execute(sql`
        UPDATE users
        SET credential_version = credential_version + 1,
            updated_at = NOW()
        WHERE LOWER(email) = LOWER(${ADMIN_EMAIL}) AND deleted_at IS NULL
        RETURNING id, credential_version
      `);
        const row = updated.rows[0];
        if (!row) return res.status(409).json({ error: "Credential update failed" });
        stampAuthSession(req, {
          userId: String((row as any).id),
          credentialVersion: credentialVersionOf(row),
          role: "admin",
        });
        await adminSessionSave(req);
        await storage.writeAuditLog(
          "auth",
          ADMIN_EMAIL,
          "admin_sessions_revoked",
          (req.session as any).adminEmail || "admin",
          {}
        );
        return res.json({ ok: true });
      } catch (err: any) {
        console.error("[admin-credentials] revoke sessions failed:", err?.message ?? err);
        return res.status(500).json({ error: "Credential update failed" });
      }
    }
  );

  // ── Customer magic-link auth ───────────────────────────────────────────────
  const magicLinkRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login requests. Please wait 15 minutes." },
  });

  // Phase 3 — rate-limit sensitive auth mutations (password/email/account changes
  // + reset/verification email sends) to blunt brute-force of current-password,
  // token guessing, and email-bombing. 10 / 15 min / IP is well clear of any
  // legitimate use (nobody changes their password ten times in a quarter hour).
  const sensitiveAuthRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait 15 minutes and try again." },
  });

  // POST /api/customer/magic-link — send login link to email
  app.post("/api/customer/magic-link", magicLinkRateLimit, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email address is required." });
      }
      const normalEmail = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalEmail)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }

      const token = await createMagicToken(normalEmail);
      const baseUrl = APP_BASE_URL;
      // Wrap through /m/login/:token so the User-Agent sniff can intercept
      // mobile-webview clicks and show the "open in browser" intermediate
      // page. Real browsers 302 straight to /api/customer/verify/:token.
      const loginUrl = `${baseUrl}/m/login/${token}`;

      try {
        await sendMagicLink({ email: normalEmail, loginUrl });
      } catch (sendErr: any) {
        console.error("[magic-link] sendMagicLink failed:", sendErr.message);
        return res.status(500).json({
          success: false,
          error: "Could not send login link. Please try again or contact support@mintvaultuk.com.",
        });
      }
      res.json({ message: "Login link sent. Check your inbox." });
    } catch (err) {
      console.error("[customer] magic-link error:", err);
      res.status(500).json({ error: "Failed to send login link. Please try again." });
    }
  });

  // GET /api/customer/verify/:token — verify magic link, set session, redirect
  app.get("/api/customer/verify/:token", async (req, res) => {
    try {
      const token = String(req.params.token);
      const email = await verifyMagicToken(token);
      if (!email) {
        // Destroy any pre-existing session — prevents a failed verify from
        // leaving a stale customer/admin session visible to the recipient.
        return req.session.destroy(() => {
          res.redirect("/dashboard?error=invalid_link");
        });
      }

      // If an active session is already signed in as a DIFFERENT customer,
      // don't switch silently. Stash a 5-min HMAC-signed cookie + DB nonce
      // and route the user to /account/switch for explicit confirmation.
      // Same-email and no-session cases fall through to the existing flow.
      const existingCustomerEmail = (req.session as any)?.customerEmail as string | undefined;
      if (existingCustomerEmail && existingCustomerEmail.toLowerCase() !== email.toLowerCase()) {
        const { createPendingSwitchCookie, setPendingSwitchCookie } = await import("../account-switch");
        const cookie = await createPendingSwitchCookie(email);
        setPendingSwitchCookie(res, cookie.value, cookie.attrs);
        return res.redirect("/account/switch");
      }

      // Find-or-create the users row for this email. PIN auth requires a
      // users row to live on (pin_hash column). Cert-owners who came in
      // pre-PIN may not have one yet — create idempotently here.
      let user = await storage.getUserByEmail(email);
      if (!user) {
        user = await storage.createUser({ email });
      }

      // Regenerate session on privilege grant to cert-owner.
      // Prevents pre-existing admin/account-holder fields from
      // surviving into the new customer session document (PR 3a).
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });

      req.session.userId = undefined as unknown as string;
      req.session.userEmail = undefined as unknown as string;
      req.session.isAdmin = false;
      req.session.adminEmail = undefined as unknown as string;
      req.session.customerEmail = email;

      // Branch on whether the user has a PIN set. First-time enrollers go
      // to /auth/pin/setup; returning users with a PIN already set carry
      // on to /dashboard. Setup-required is also a session flag the setup
      // endpoint reads to authorise the write.
      const hasPin = !!(user as any).pinHash;
      if (!hasPin) {
        (req.session as any).pinSetupRequired = true;
        return res.redirect("/auth/pin/setup");
      }
      res.redirect("/dashboard?login=success");
    } catch (err) {
      console.error("[customer] verify error:", err);
      return req.session.destroy(() => {
        res.redirect("/dashboard?error=server_error");
      });
    }
  });

  // ── Account-switch confirm flow ─────────────────────────────────────────────
  const accountSwitchRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many switch attempts. Please wait 15 minutes." },
  });

  app.get("/account/switch", async (req, res) => {
    const { readSwitchCookie, verifyPendingSwitchCookie, clearPendingSwitchCookie } = await import("../account-switch");
    const raw = readSwitchCookie(req);
    const verified = verifyPendingSwitchCookie(raw);
    if (!verified.valid) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_expired");
    }
    const currentEmail = ((req.session as any)?.customerEmail as string | undefined) ?? "";
    if (!currentEmail) {
      // No active session to switch from — just clear the pending cookie and
      // route to /dashboard. The success path on /verify handles a fresh login.
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard");
    }
    const escape = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const currentEsc = escape(currentEmail);
    const pendingEsc = escape(verified.email);
    const nonceEsc = escape(verified.nonce);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switch account — MintVault</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #1A1612; color: #FAF7F1; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 480px; background: #221C16; border: 1px solid rgba(212,175,55,0.25); border-radius: 16px; padding: 32px; box-shadow: 0 10px 40px rgba(0,0,0,0.4); }
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #D4AF37; margin: 0 0 16px; }
  h1 { color: #FAF7F1; font-size: 24px; font-weight: 600; margin: 0 0 16px; }
  p { color: rgba(250,247,241,0.78); font-size: 15px; line-height: 1.55; margin: 0 0 16px; }
  strong.email { color: #D4AF37; font-weight: 600; word-break: break-all; }
  .actions { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
  button { font: inherit; font-size: 15px; padding: 12px 18px; border-radius: 10px; border: 0; cursor: pointer; width: 100%; }
  button.primary { background: linear-gradient(135deg,#B8960C,#D4AF37); color: #1A1400; font-weight: 700; }
  button.secondary { background: transparent; color: #FAF7F1; border: 1px solid rgba(250,247,241,0.25); }
  button:hover { filter: brightness(1.08); }
  form { margin: 0; }
  .meta { color: rgba(250,247,241,0.45); font-size: 12px; margin-top: 18px; }
</style></head>
<body>
  <div class="card">
    <p class="eyebrow">MintVault &middot; Account switch</p>
    <h1>Switch account?</h1>
    <p>You're currently signed in as <strong class="email">${currentEsc}</strong> on this device.</p>
    <p>Continuing will sign that account out and sign in as <strong class="email">${pendingEsc}</strong>.</p>
    <div class="actions">
      <form method="POST" action="/account/switch/confirm">
        <input type="hidden" name="nonce" value="${nonceEsc}">
        <button type="submit" class="primary">Switch to ${pendingEsc}</button>
      </form>
      <form method="POST" action="/account/switch/cancel">
        <button type="submit" class="secondary">Stay signed in as ${currentEsc}</button>
      </form>
    </div>
    <p class="meta">If you don't recognise either address, close this page. Doing nothing leaves your current session intact.</p>
  </div>
</body></html>`);
  });

  app.post("/account/switch/confirm", accountSwitchRateLimit, async (req, res) => {
    const {
      readSwitchCookie,
      verifyPendingSwitchCookie,
      consumePendingSwitch,
      clearPendingSwitchCookie,
      cleanupStaleNonces,
      maskEmail,
      ipHash,
    } = await import("../account-switch");
    cleanupStaleNonces();
    const raw = readSwitchCookie(req);
    const verified = verifyPendingSwitchCookie(raw);
    if (!verified.valid) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    const formNonce = String(req.body?.nonce ?? "").trim();
    if (!formNonce || formNonce !== verified.nonce) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    const consumed = await consumePendingSwitch(verified.nonce);
    if (!consumed) {
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    const fromEmail = ((req.session as any)?.customerEmail as string | undefined) ?? "";
    const toEmail = verified.email;
    try {
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
    } catch (err: any) {
      console.error("[account-switch] regenerate failed:", err?.message ?? err);
      clearPendingSwitchCookie(res);
      return res.redirect("/dashboard?error=switch_failed");
    }
    req.session.userId = undefined as unknown as string;
    req.session.userEmail = undefined as unknown as string;
    req.session.isAdmin = false;
    req.session.adminEmail = undefined as unknown as string;
    req.session.customerEmail = toEmail;
    clearPendingSwitchCookie(res);
    try {
      const ip = (req.ip as string) || "unknown";
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('session', ${verified.nonce}, 'customer_session_switch', 'system',
                ${JSON.stringify({
                  from_email_masked: maskEmail(fromEmail),
                  to_email_masked: maskEmail(toEmail),
                  ip_hash: ipHash(ip),
                  nonce: verified.nonce,
                })}::jsonb,
                NOW())
      `);
    } catch (auditErr: any) {
      console.warn("[account-switch] audit_log insert failed:", auditErr?.message ?? auditErr);
    }
    return res.redirect("/dashboard?login=success&switched=1");
  });

  app.post("/account/switch/cancel", async (_req, res) => {
    const { clearPendingSwitchCookie, cleanupStaleNonces } = await import("../account-switch");
    cleanupStaleNonces();
    clearPendingSwitchCookie(res);
    return res.redirect("/dashboard");
  });

  // ── Mobile-webview intermediate pages (PIN auth launch) ─────────────────────
  function isInAppWebview(ua: string): boolean {
    if (!ua) return false;
    return /\bwv\)|; wv;|FBAN\/|FBAV\/|Instagram |Twitter for|LinkedInApp|GoogleMail|Outlook(?:Mobile|-iOS|-Android)|YJApp|Snapchat\b|Line\/|MicroMessenger\b/i.test(
      ua
    );
  }

  function renderIntermediateHtml(realUrl: string, kind: "login" | "reset"): string {
    const escape = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const urlEsc = escape(realUrl);
    const heading = kind === "login" ? "Open in your browser" : "Open in your browser";
    const subhead =
      kind === "login"
        ? "For security, your sign-in link needs to open in your phone's real browser, not inside this email app."
        : "For security, your PIN reset link needs to open in your phone's real browser, not inside this email app.";
    const ctaLabel = kind === "login" ? "Open Sign-In Link" : "Open Reset Link";
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} — MintVault</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #1A1612; color: #FAF7F1; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 480px; background: #221C16; border: 1px solid rgba(212,175,55,0.25); border-radius: 16px; padding: 28px; box-shadow: 0 10px 40px rgba(0,0,0,0.4); }
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #D4AF37; margin: 0 0 14px; }
  h1 { color: #FAF7F1; font-size: 22px; font-weight: 600; margin: 0 0 14px; line-height: 1.25; }
  p { color: rgba(250,247,241,0.78); font-size: 14px; line-height: 1.55; margin: 0 0 14px; }
  .cta { display: block; width: 100%; padding: 14px 18px; border-radius: 12px; background: linear-gradient(135deg,#B8960C,#D4AF37); color: #1A1400; font-weight: 700; font-size: 15px; text-align: center; text-decoration: none; margin: 18px 0 12px; }
  .copy-block { background: #15110D; border: 1px solid rgba(250,247,241,0.08); border-radius: 8px; padding: 10px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; color: rgba(250,247,241,0.55); }
  .meta { color: rgba(250,247,241,0.45); font-size: 12px; margin-top: 16px; }
  .steps { color: rgba(250,247,241,0.55); font-size: 12px; line-height: 1.6; margin: 14px 0 0; padding-left: 18px; }
  .steps li { margin-bottom: 4px; }
</style></head>
<body>
  <div class="card">
    <p class="eyebrow">MintVault &middot; Continue in browser</p>
    <h1>${heading}</h1>
    <p>${subhead}</p>
    <a href="${urlEsc}" target="_blank" rel="noopener" class="cta" id="cta">${ctaLabel}</a>
    <p class="meta">If the button doesn't open your browser, long-press it and choose <em>Open in Browser</em>, or copy the link below into Safari / Chrome:</p>
    <div class="copy-block">${urlEsc}</div>
    <ol class="steps">
      <li>Tap the share / menu icon in this email view</li>
      <li>Choose <em>Open in Browser</em> (iOS) or <em>Open in Chrome</em> (Android)</li>
    </ol>
  </div>
  <script>
    // Defence in depth: try window.open as a JS fallback when the user taps
    // the CTA. In some webviews target=_blank is intercepted; window.open
    // can succeed where the anchor fails.
    document.getElementById("cta").addEventListener("click", function(e) {
      try { window.open(${JSON.stringify(realUrl)}, "_blank", "noopener"); } catch (_) {}
    });
  </script>
</body></html>`;
  }

  app.get("/m/login/:token", (req, res) => {
    const token = String(req.params.token);
    const realUrl = `${APP_BASE_URL}/api/customer/verify/${token}`;
    const ua = String(req.headers["user-agent"] || "");
    if (!isInAppWebview(ua)) {
      return res.redirect(302, realUrl);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.send(renderIntermediateHtml(realUrl, "login"));
  });

  app.get("/m/reset/:token", (req, res) => {
    const token = String(req.params.token);
    const realUrl = `${APP_BASE_URL}/auth/pin/reset/${token}`;
    const ua = String(req.headers["user-agent"] || "");
    if (!isInAppWebview(ua)) {
      return res.redirect(302, realUrl);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.send(renderIntermediateHtml(realUrl, "reset"));
  });

  // ── PIN auth (v1 launch) ────────────────────────────────────────────────────
  const pinLoginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts. Please wait 15 minutes." },
  });

  const pinSetupRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many PIN setup attempts. Please wait 15 minutes." },
  });

  // POST /api/auth/pin/setup — set the PIN on the user's row.
  app.post("/api/auth/pin/setup", pinSetupRateLimit, async (req, res) => {
    try {
      const { hashPin, validatePinStrength, WeakPinError, logPinEvent, hashIp, resetFailures } = await import("../pin");
      const pin = String(req.body?.pin || "").trim();
      const ipH = hashIp(req.ip || "unknown");

      // Determine target email + completion behaviour from session context
      let targetEmail: string | undefined;
      let completionMode: "customer" | "admin" | "reset_customer" | "reset_admin" | null = null;
      const resetEmail = (req.session as any)?.pinResetEmail as string | undefined;
      const resetIsAdmin = (req.session as any)?.pinResetIsAdmin === true;
      if (resetEmail) {
        targetEmail = resetEmail;
        completionMode = resetIsAdmin ? "reset_admin" : "reset_customer";
      } else if ((req.session as any)?.pendingAdmin) {
        targetEmail = ADMIN_EMAIL;
        completionMode = "admin";
      } else if ((req.session as any)?.customerEmail) {
        targetEmail = (req.session as any).customerEmail;
        completionMode = "customer";
      }
      if (!targetEmail || !completionMode) {
        return res.status(401).json({ error: "Not authorised to set a PIN. Please log in via your email link first." });
      }

      try {
        validatePinStrength(pin);
      } catch (e: any) {
        if (e instanceof WeakPinError) {
          await logPinEvent(targetEmail, false, "weak_pin", ipH);
          return res.status(422).json({ error: e.message, reason: e.reason });
        }
        throw e;
      }

      const hash = await hashPin(pin);
      const updatedUser = await db.execute(sql`
        UPDATE users
        SET pin_hash = ${hash},
            pin_set_at = NOW(),
            pin_failed_count = 0,
            pin_locked_until = NULL,
            credential_version = credential_version + 1,
            updated_at = NOW()
        WHERE LOWER(email) = LOWER(${targetEmail}) AND deleted_at IS NULL
        RETURNING id, credential_version
      `);
      await resetFailures(targetEmail);

      const isReset = completionMode.startsWith("reset_");
      await logPinEvent(targetEmail, true, isReset ? "pin_reset" : "pin_set", ipH);

      // Clear setup-context flags
      (req.session as any).pinResetEmail = undefined;
      (req.session as any).pinResetIsAdmin = undefined;
      (req.session as any).pinSetupRequired = undefined;

      // Complete the login appropriate to context. Reset paths come in
      // logged-out, so we regenerate + set the appropriate session field.
      if (completionMode === "admin" || completionMode === "reset_admin") {
        await new Promise<void>((resolve, reject) => {
          req.session.regenerate((err) => (err ? reject(err) : resolve()));
        });
        req.session.userId = undefined as unknown as string;
        req.session.userEmail = undefined as unknown as string;
        req.session.customerEmail = undefined as unknown as string;
        req.session.isAdmin = true;
        req.session.adminEmail = ADMIN_EMAIL;
        stampAuthSession(req, {
          userId: String((updatedUser.rows[0] as any)?.id),
          credentialVersion: credentialVersionOf(updatedUser.rows[0]),
          role: "admin",
        });
        clearPendingAdmin(req);
        await adminSessionSave(req);
        return res.json({ ok: true, redirect: "/admin" });
      }
      // customer or reset_customer
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      req.session.userId = undefined as unknown as string;
      req.session.userEmail = undefined as unknown as string;
      req.session.isAdmin = false;
      req.session.adminEmail = undefined as unknown as string;
      req.session.customerEmail = targetEmail;
      if (updatedUser.rows[0]) {
        stampAuthSession(req, {
          userId: String((updatedUser.rows[0] as any).id),
          credentialVersion: credentialVersionOf(updatedUser.rows[0]),
          role: "customer",
        });
      }
      return res.json({ ok: true, redirect: "/dashboard?login=success" });
    } catch (err: any) {
      console.error("[pin/setup] error:", err.message);
      res.status(500).json({ error: "Could not set PIN. Please try again." });
    }
  });

  // POST /api/auth/pin/login — primary cert-owner login. Email + PIN.
  app.post("/api/auth/pin/login", pinLoginRateLimit, async (req, res) => {
    try {
      const { verifyPin, checkLockout, registerFailure, resetFailures, logPinEvent, hashIp, PIN_LOCKOUT_DURATION_MS } =
        await import("../pin");
      const rawEmail = String(req.body?.email || "")
        .toLowerCase()
        .trim();
      const pin = String(req.body?.pin || "").trim();
      const ipH = hashIp(req.ip || "unknown");

      if (!rawEmail || !pin) {
        return res.status(400).json({ error: "Email and PIN are both required." });
      }

      // Lockout check first — even before user existence check, so a locked
      // account can't be probed via "is this email in our system" timing.
      const lockState = await checkLockout(rawEmail);
      if (lockState.locked) {
        await logPinEvent(rawEmail, false, "locked", ipH);
        const retryAfterSeconds = lockState.retryAfter
          ? Math.ceil((lockState.retryAfter.getTime() - Date.now()) / 1000)
          : Math.ceil(PIN_LOCKOUT_DURATION_MS / 1000);
        return res.status(423).json({
          error: `Too many incorrect attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
          retryAfterSeconds,
        });
      }

      const user = await storage.getUserByEmail(rawEmail);
      if (!user || !(user as any).pinHash) {
        await logPinEvent(rawEmail, false, user ? "no_pin_set" : "no_user", ipH);
        return res.status(401).json({ error: "Email or PIN incorrect." });
      }

      const ok = await verifyPin(pin, (user as any).pinHash);
      if (!ok) {
        const post = await registerFailure(rawEmail);
        await logPinEvent(rawEmail, false, post.locked ? "lockout_triggered" : "wrong_pin", ipH);
        if (post.locked && post.retryAfter) {
          const retryAfterSeconds = Math.ceil((post.retryAfter.getTime() - Date.now()) / 1000);
          return res.status(423).json({
            error: `Too many incorrect attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
            retryAfterSeconds,
          });
        }
        return res.status(401).json({ error: "Email or PIN incorrect." });
      }

      // PIN correct. Reset failure counters.
      await resetFailures(rawEmail);

      // LOCK-2: account-switch mismatch detection.
      const existingCustomerEmail = (req.session as any)?.customerEmail as string | undefined;
      if (existingCustomerEmail && existingCustomerEmail.toLowerCase() !== rawEmail) {
        const { createPendingSwitchCookie, setPendingSwitchCookie } = await import("../account-switch");
        const cookie = await createPendingSwitchCookie(rawEmail);
        setPendingSwitchCookie(res, cookie.value, cookie.attrs);
        return res.json({ ok: true, redirect: "/account/switch" });
      }

      // Regenerate session on privilege grant.
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      req.session.userId = user.id as string;
      req.session.userEmail = (user.email as string | null) ?? rawEmail;
      req.session.isAdmin = false;
      req.session.adminEmail = undefined as unknown as string;
      req.session.customerEmail = rawEmail;
      return res.json({ ok: true, redirect: "/dashboard?login=success" });
    } catch (err: any) {
      console.error("[pin/login] error:", err.message);
      res.status(500).json({ error: "Could not sign in. Please try again." });
    }
  });

  // POST /api/auth/pin/forgot — request a PIN-reset magic link by email.
  app.post("/api/auth/pin/forgot", magicLinkRateLimit, async (req, res) => {
    try {
      const { logPinEvent, hashIp } = await import("../pin");
      const rawEmail = String(req.body?.email || "")
        .toLowerCase()
        .trim();
      const ipH = hashIp(req.ip || "unknown");

      if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }

      const user = await storage.getUserByEmail(rawEmail);
      // Generic response either way
      const genericMsg = { ok: true, message: "If an account exists, a reset link has been sent." };

      // B10 — defense-in-depth: never mint a public PIN-reset token for the admin
      // account. Same generic response (no account enumeration); logged for audit.
      if (rawEmail === ADMIN_EMAIL.toLowerCase()) {
        await logPinEvent(rawEmail, false, "admin_blocked", ipH);
        return res.json(genericMsg);
      }

      if (!user) {
        await logPinEvent(rawEmail, false, "no_user", ipH);
        return res.json(genericMsg);
      }

      // Mint reset token + send email
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await db.execute(sql`
        INSERT INTO pin_reset_tokens (email, token, expires_at)
        VALUES (${rawEmail}, ${token}, ${expiresAt.toISOString()})
      `);
      const baseUrl = APP_BASE_URL;
      const resetUrl = `${baseUrl}/m/reset/${token}`;
      try {
        await sendPinResetLink({ email: rawEmail, resetUrl });
      } catch (sendErr: any) {
        console.error("[pin/forgot] sendPinResetLink failed:", sendErr.message);
      }
      await logPinEvent(rawEmail, true, "reset_link_sent", ipH);
      return res.json(genericMsg);
    } catch (err: any) {
      console.error("[pin/forgot] error:", err.message);
      // Still return generic success so timing doesn't leak existence
      return res.json({ ok: true, message: "If an account exists, a reset link has been sent." });
    }
  });

  // GET /auth/pin/reset/:token — consume the reset token, set a session
  // flag authorising a PIN write, redirect to /auth/pin/setup?reset=1.
  // Defense-in-depth rate limit on the token-consume endpoint. The token is a
  // 256-bit crypto.randomBytes value (unguessable), so this isn't closing a
  // real brute-force — it just caps abuse/DB load and keeps the whole reset
  // surface (request + consume) limited. Generous: a real user hits this once.
  const pinResetConsumeRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please request a new reset link." },
  });
  app.get("/auth/pin/reset/:token", pinResetConsumeRateLimit, async (req, res) => {
    try {
      const token = String(req.params.token);
      // Atomic single-use consume
      const r = await db.execute(sql`
        UPDATE pin_reset_tokens
        SET consumed_at = NOW()
        WHERE token = ${token}
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING email
      `);
      const row = r.rows[0] as { email: string } | undefined;
      if (!row) {
        return req.session.destroy(() => {
          res.redirect("/customer-login?error=reset_link_invalid");
        });
      }
      // Establish reset-authorised session.
      await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
      const user = await storage.getUserByEmail(row.email);
      const isAdmin = !!user && (user as any).role === "admin";
      (req.session as any).pinResetEmail = row.email.toLowerCase();
      (req.session as any).pinResetIsAdmin = isAdmin;
      return res.redirect("/auth/pin/setup?reset=1");
    } catch (err: any) {
      console.error("[pin/reset] error:", err.message);
      return req.session.destroy(() => {
        res.redirect("/customer-login?error=reset_link_invalid");
      });
    }
  });

  // POST /api/auth/logout-everywhere — admin-only. Truncates the session table.
  app.post("/api/auth/logout-everywhere", requireAdmin, async (req, res) => {
    try {
      const before = await db.execute(sql`SELECT COUNT(*)::int AS n FROM session`);
      const beforeCount = (before.rows[0] as any).n;
      await db.execute(sql`TRUNCATE session`);
      const adminEmail = (req.session as any)?.adminEmail || "admin";
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('session', 'all', 'logout_everywhere', ${adminEmail},
                ${JSON.stringify({ destroyed: beforeCount, reason: "PIN auth deploy: forced re-auth" })}::jsonb,
                NOW())
      `);
      return res.json({ ok: true, destroyed: beforeCount });
    } catch (err: any) {
      console.error("[logout-everywhere] error:", err.message);
      return res.status(500).json({ error: "Failed to truncate sessions" });
    }
  });

  // GET /api/customer/me — return current customer session info
  app.get("/api/customer/me", requireCustomer, (req, res) => {
    res.json({ email: req.session.customerEmail });
  });

  // ── Account auth (/api/auth/*) ────────────────────────────────────────────

  function getClientIpForAuth(req: any): string {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
    return req.ip || req.socket?.remoteAddress || "unknown";
  }

  function getAppBaseUrl(req: any): string {
    return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  }

  // POST /api/auth/signup
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { email, password, display_name } = req.body;
      if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });
      const pwCheck = validatePassword(password);
      if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.message });

      const existing = await findUserByEmail(email);
      if (existing && !existing.deleted_at)
        return res.status(409).json({ error: "An account with that email already exists" });

      const hash = await hashPassword(password);
      const result = await db.execute(sql`
        INSERT INTO users (email, password_hash, display_name, email_verified, role, created_at, updated_at)
        VALUES (${email.toLowerCase().trim()}, ${hash}, ${display_name?.trim() || null}, false, 'customer', NOW(), NOW())
        RETURNING id, email, display_name, email_verified
      `);
      const user = result.rows[0] as any;
      const verifyToken = await createEmailVerificationToken(user.id);
      const verifyUrl = `${getAppBaseUrl(req)}/api/auth/verify-email?token=${verifyToken}`;
      await sendWelcomeVerificationEmail(user.email, user.display_name, verifyUrl);
      await writeAuthAudit("auth.signup", user.id, getClientIpForAuth(req), { email: user.email });

      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;
      return res
        .status(201)
        .json({ id: user.id, email: user.email, display_name: user.display_name, email_verified: false });
    } catch (err: any) {
      console.error("[auth] signup error:", err.message);
      return res.status(500).json({ error: "Signup failed. Please try again." });
    }
  });

  // POST /api/auth/login
  app.post("/api/auth/login", async (req, res) => {
    const ip = getClientIpForAuth(req);
    const ua = req.headers["user-agent"] as string | undefined;
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(401).json({ error: "invalid_credentials" });

      const emailFailures = await countRecentFailedAttempts(email, 60);
      if (emailFailures >= 10) {
        await logLoginAttempt(email, ip, false, ua);
        await writeAuthAudit("auth.login.blocked", "unknown", ip, { email });
        return res.status(401).json({ error: "invalid_credentials" });
      }

      const user = await findUserByEmail(email);
      if (!user || user.deleted_at) {
        await logLoginAttempt(email, ip, false, ua);
        await writeAuthAudit("auth.login.failure", "unknown", ip, { email, reason: "user_not_found" });
        return res.status(401).json({ error: "invalid_credentials" });
      }
      if (!user.password_hash) {
        await logLoginAttempt(email, ip, false, ua);
        return res.status(401).json({ error: "invalid_credentials" });
      }

      const valid = await verifyPassword(password as string, user.password_hash as string);
      if (!valid) {
        await logLoginAttempt(email, ip, false, ua);
        await db.execute(
          sql`UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ${user.id as string}`
        );
        await writeAuthAudit("auth.login.failure", user.id as string, ip, { email });
        return res.status(401).json({ error: "invalid_credentials" });
      }

      // Success — regenerate session to prevent fixation
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;
      (req.session as any).customerEmail = user.email;
      (req.session as any).isAdmin = false;
      (req.session as any).adminEmail = undefined;
      // Defensive: a fresh session from regenerate() has no grader fields, but
      // clear them explicitly so an account login can never carry a grader role.
      (req.session as any).isGrader = false;
      (req.session as any).graderId = undefined;

      await db.execute(sql`
        UPDATE users SET last_login_at = NOW(), last_login_ip = ${ip}, failed_login_count = 0 WHERE id = ${user.id as string}
      `);
      await logLoginAttempt(email, ip, true, ua);
      await writeAuthAudit("auth.login.success", user.id as string, ip, { email });
      return res.json({
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        email_verified: user.email_verified,
      });
    } catch (err: any) {
      console.error("[auth] login error:", err.message);
      return res.status(500).json({ error: "Login failed. Please try again." });
    }
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", async (req, res) => {
    const userId = (req.session as any).userId as string | undefined;
    if (userId) await writeAuthAudit("auth.logout", userId, getClientIpForAuth(req), {});
    req.session.destroy(() => {});
    res.clearCookie("mv.sid");
    return res.json({ ok: true });
  });

  // POST /api/auth/magic-link
  app.post("/api/auth/magic-link", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });
      const user = await findUserByEmail(email);
      if (user && !user.deleted_at) {
        const token = await createAccountMagicLinkToken(user.id as string);
        const loginUrl = `${getAppBaseUrl(req)}/api/auth/magic-link/verify?token=${token}`;
        await sendAccountMagicLinkEmail(user.email as string, loginUrl);
        await writeAuthAudit("auth.magic_link.requested", user.id as string, getClientIpForAuth(req), { email });
      }
      return res.json({ ok: true, message: "If an account exists, a login link has been sent." });
    } catch (err: any) {
      console.error("[auth] magic-link error:", err.message);
      return res.json({ ok: true, message: "If an account exists, a login link has been sent." });
    }
  });

  // GET /api/auth/magic-link/verify?token=...
  app.get("/api/auth/magic-link/verify", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== "string") return res.redirect("/login?error=expired_link");
      // S2 — atomic single-use consume: only the FIRST concurrent request wins
      // the row (WHERE consumed_at IS NULL … RETURNING). Closes the TOCTOU race
      // where two concurrent requests could both consume the same token. Matches
      // the pattern used for password_reset / email_verification / pin_reset.
      const consumed = await db.execute(sql`
        UPDATE account_magic_link_tokens SET consumed_at = NOW()
        WHERE token = ${token} AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING user_id
      `);
      if (!consumed.rows.length) return res.redirect("/login?error=expired_link");
      const rec = consumed.rows[0] as any;
      const user = await findUserById(rec.user_id);
      if (!user || user.deleted_at) return res.redirect("/login?error=expired_link");

      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
      });
      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;
      await db.execute(
        sql`UPDATE users SET last_login_at = NOW(), last_login_ip = ${getClientIpForAuth(req)} WHERE id = ${user.id as string}`
      );
      await writeAuthAudit("auth.magic_link.used", user.id as string, getClientIpForAuth(req), {});
      return res.redirect("/dashboard");
    } catch (err: any) {
      console.error("[auth] magic-link verify error:", err.message);
      return res.redirect("/login?error=expired_link");
    }
  });

  // POST /api/auth/forgot-password
  app.post("/api/auth/forgot-password", sensitiveAuthRateLimit, async (req, res) => {
    try {
      const { email } = req.body;
      if (email) {
        const user = await findUserByEmail(email);
        if (user && !user.deleted_at && user.password_hash) {
          const token = await createPasswordResetToken(user.id as string);
          const resetUrl = `${getAppBaseUrl(req)}/reset-password?token=${token}`;
          await sendPasswordResetEmail(user.email as string, resetUrl);
          await writeAuthAudit("auth.password_reset.requested", user.id as string, getClientIpForAuth(req), { email });
        }
      }
      return res.json({ ok: true, message: "If an account exists with that email, a reset link has been sent." });
    } catch (err: any) {
      console.error("[auth] forgot-password error:", err.message);
      return res.json({ ok: true, message: "If an account exists with that email, a reset link has been sent." });
    }
  });

  // POST /api/auth/reset-password
  app.post("/api/auth/reset-password", sensitiveAuthRateLimit, async (req, res) => {
    try {
      const { token, new_password } = req.body;
      if (!token || !new_password) return res.status(400).json({ error: "Token and new password are required" });
      const pwCheck = validatePassword(new_password);
      if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.message });

      // Hash first — the slow / throw-prone step — so a hashing failure can't burn
      // an otherwise-valid reset link (the token is only spent once we're committed
      // to writing the new password).
      const hash = await hashPassword(new_password);
      // Phase 3 — atomic single-use consume: the conditional UPDATE is the
      // single-winner gate (flips consumed_at NULL→NOW() exactly once even under
      // concurrent requests with the same token); only the winner gets user_id back
      // and may reset the password. Replaces the prior SELECT→check→UPDATE (TOCTOU).
      const consumed = await db.execute(
        sql`UPDATE password_reset_tokens SET consumed_at = NOW()
            WHERE token = ${token} AND consumed_at IS NULL AND expires_at > NOW()
            RETURNING user_id`
      );
      if (!consumed.rows.length) {
        return res.status(400).json({ error: "Reset link has expired. Please request a new one." });
      }
      const resetUserId = (consumed.rows[0] as any).user_id as string;
      // A password reset is the ONLY remediation a customer has after a session theft, so it must
      // actually end the attacker's access. Previously this wrote password_hash and nothing else:
      // credential_version was not bumped and no session row was deleted, while the session cookie
      // carries a 30-day rolling maxAge (server/index.ts) and requireAuth
      // (server/middleware/auth.ts) checks only `req.session.userId`. A stolen `mv.sid` therefore
      // kept full account access for up to 30 days AFTER the victim reset their password.
      //
      // credential_version is bumped for parity with every other credential change in this file
      // (:361, :417, :459) and so any version-aware check is correct from here on.
      await db.execute(
        sql`UPDATE users
               SET password_hash = ${hash},
                   credential_version = COALESCE(credential_version, 1) + 1,
                   updated_at = NOW()
             WHERE id = ${resetUserId}`
      );
      // Revoke every live session for this user. connect-pg-simple stores the serialised session in
      // `session.sess`, and customer login sets `req.session.userId` (:1019), so that JSON field is
      // the user key. Deleting the row is authoritative and immediate: the store finds no sid, a
      // fresh empty session is created, and requireAuth 401s.
      //
      // TWO-MACHINE SAFE (invariant I19): the session store is shared PostgreSQL, not per-process
      // memory, so this revocation is visible to BOTH Fly Machines the instant it commits — there is
      // no per-Machine cache to miss.
      let revokedSessions = 0;
      try {
        const revoked = await db.execute(
          sql`DELETE FROM session WHERE sess ->> 'userId' = ${resetUserId} RETURNING sid`
        );
        revokedSessions = revoked.rows.length;
      } catch (revokeErr: any) {
        // Never let a revocation failure strand the user with a consumed token and an unchanged
        // password — the password IS already updated at this point. Surface it loudly instead.
        console.error("[auth] reset-password: session revocation FAILED:", revokeErr?.message);
      }
      const user = await findUserById(resetUserId);
      if (user) {
        await sendPasswordChangedEmail(user.email as string);
        await writeAuthAudit("auth.password_reset", user.id as string, getClientIpForAuth(req), {
          email: user.email,
          revokedSessions,
        });
      }
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] reset-password error:", err.message);
      return res.status(500).json({ error: "Password reset failed. Please try again." });
    }
  });

  // GET /api/auth/verify-email?token=...
  app.get("/api/auth/verify-email", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== "string") return res.redirect("/dashboard?verified=error");
      // Phase 3 — atomic single-use consume (same single-winner gate as reset-password).
      const consumed = await db.execute(
        sql`UPDATE email_verification_tokens SET consumed_at = NOW()
            WHERE token = ${token} AND consumed_at IS NULL AND expires_at > NOW()
            RETURNING user_id`
      );
      if (!consumed.rows.length) return res.redirect("/verify-email?error=expired");
      const verifyUserId = (consumed.rows[0] as any).user_id as string;
      await db.execute(
        sql`UPDATE users SET email_verified = true, email_verified_at = NOW(), updated_at = NOW() WHERE id = ${verifyUserId}`
      );
      await writeAuthAudit("auth.email.verified", verifyUserId, getClientIpForAuth(req), {});
      return res.redirect("/dashboard?verified=true");
    } catch (err: any) {
      console.error("[auth] verify-email error:", err.message);
      return res.redirect("/dashboard?verified=error");
    }
  });

  // POST /api/auth/resend-verification
  app.post("/api/auth/resend-verification", requireAuth, sensitiveAuthRateLimit, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const user = await findUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.email_verified) return res.status(400).json({ error: "Email already verified" });
      const token = await createEmailVerificationToken(userId);
      const verifyUrl = `${getAppBaseUrl(req)}/api/auth/verify-email?token=${token}`;
      await sendWelcomeVerificationEmail(user.email as string, user.display_name as string | null, verifyUrl);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] resend-verification error:", err.message);
      return res.status(500).json({ error: "Failed to send verification email" });
    }
  });

  // GET /api/auth/me
  app.get("/api/auth/me", async (req, res) => {
    const userId = (req.session as any).userId as string | undefined;
    if (!userId) return res.status(401).json({ error: "auth_required" });
    try {
      const user = await findUserById(userId);
      if (!user || user.deleted_at) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: "auth_required" });
      }
      const { FEATURE_FLAGS } = await import("../config/feature-flags");
      const base: Record<string, unknown> = {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        email_verified: user.email_verified,
        created_at: user.created_at,
      };
      if (FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE) {
        base.public_name = (user as any).public_name === true;
      }
      return res.json(base);
    } catch (err: any) {
      return res.status(500).json({ error: "Failed to get user" });
    }
  });

  // PUT /api/auth/change-password
  app.put("/api/auth/change-password", requireAuth, sensitiveAuthRateLimit, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { current_password, new_password } = req.body;
      if (!current_password || !new_password)
        return res.status(400).json({ error: "Both current and new password are required" });
      const pwCheck = validatePassword(new_password);
      if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.message });
      const user = await findUserById(userId);
      if (!user || !user.password_hash) return res.status(400).json({ error: "No password set on this account" });
      const valid = await verifyPassword(current_password, user.password_hash as string);
      if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
      const hash = await hashPassword(new_password);
      await db.execute(sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE id = ${userId}`);
      await sendPasswordChangedEmail(user.email as string);
      await writeAuthAudit("auth.password_changed", userId, getClientIpForAuth(req), { email: user.email });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] change-password error:", err.message);
      return res.status(500).json({ error: "Failed to change password" });
    }
  });

  // PUT /api/auth/change-email
  app.put("/api/auth/change-email", requireAuth, sensitiveAuthRateLimit, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { new_email, password } = req.body;
      if (!new_email || !password) return res.status(400).json({ error: "New email and password are required" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email))
        return res.status(400).json({ error: "Invalid email address" });
      const user = await findUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.password_hash) {
        const valid = await verifyPassword(password, user.password_hash as string);
        if (!valid) return res.status(401).json({ error: "Password is incorrect" });
      }
      const existing = await findUserByEmail(new_email);
      if (existing && existing.id !== userId) return res.status(409).json({ error: "That email is already in use" });
      const oldEmail = user.email as string;
      await db.execute(
        sql`UPDATE users SET email = ${new_email.toLowerCase().trim()}, email_verified = false, email_verified_at = NULL, updated_at = NOW() WHERE id = ${userId}`
      );
      (req.session as any).userEmail = new_email.toLowerCase().trim();
      const token = await createEmailVerificationToken(userId);
      const verifyUrl = `${getAppBaseUrl(req)}/api/auth/verify-email?token=${token}`;
      await sendWelcomeVerificationEmail(new_email, user.display_name as string | null, verifyUrl);
      await sendEmailChangedNotification(oldEmail, new_email);
      await writeAuthAudit("auth.email_changed", userId, getClientIpForAuth(req), { old_email: oldEmail, new_email });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] change-email error:", err.message);
      return res.status(500).json({ error: "Failed to change email" });
    }
  });

  // PUT /api/auth/profile
  app.put("/api/auth/profile", requireAuth, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { display_name, public_name } = req.body as { display_name?: string | null; public_name?: unknown };
      const { FEATURE_FLAGS } = await import("../config/feature-flags");

      if (public_name !== undefined && !FEATURE_FLAGS.PUBLIC_NAME_TOGGLE_LIVE) {
        return res.status(404).json({ error: "Not found" });
      }
      if (public_name !== undefined && typeof public_name !== "boolean") {
        return res.status(400).json({ error: "public_name must be a boolean" });
      }

      const touchDisplayName = Object.prototype.hasOwnProperty.call(req.body || {}, "display_name");

      let priorPublicName: boolean | null = null;
      if (public_name !== undefined) {
        const row = await db.execute(sql`SELECT public_name FROM users WHERE id = ${userId} LIMIT 1`);
        priorPublicName = (row.rows[0] as any)?.public_name === true;
      }

      if (touchDisplayName && public_name !== undefined) {
        await db.execute(sql`
          UPDATE users SET display_name = ${display_name?.trim() || null},
                          public_name = ${public_name},
                          updated_at = NOW()
          WHERE id = ${userId}
        `);
      } else if (touchDisplayName) {
        await db.execute(
          sql`UPDATE users SET display_name = ${display_name?.trim() || null}, updated_at = NOW() WHERE id = ${userId}`
        );
      } else if (public_name !== undefined) {
        await db.execute(sql`UPDATE users SET public_name = ${public_name}, updated_at = NOW() WHERE id = ${userId}`);
      }

      if (public_name !== undefined && priorPublicName !== public_name) {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES ('user', ${userId}, 'toggle_public_name', ${userId},
            ${JSON.stringify({ from: priorPublicName, to: public_name })}::jsonb)
        `);
        console.log(`[profile] user=${userId} toggled public_name ${priorPublicName} -> ${public_name}`);
      }

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[profile] update error:", err.message);
      return res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // DELETE /api/auth/delete-account
  app.delete("/api/auth/delete-account", requireAuth, sensitiveAuthRateLimit, async (req, res) => {
    try {
      const userId = (req.session as any).userId as string;
      const { password, confirmation } = req.body;
      if (confirmation !== "DELETE")
        return res.status(400).json({ error: 'Please type "DELETE" to confirm account deletion' });
      const user = await findUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.password_hash) {
        if (!password) return res.status(400).json({ error: "Password is required to delete your account" });
        const valid = await verifyPassword(password, user.password_hash as string);
        if (!valid) return res.status(401).json({ error: "Password is incorrect" });
      }
      // Soft delete — anonymise PII but preserve cert ownership chain
      await db.execute(sql`
        UPDATE users SET
          email = ${`deleted_${userId}@mintvault.invalid`},
          password_hash = NULL,
          display_name = 'Deleted User',
          deleted_at = NOW(),
          updated_at = NOW()
        WHERE id = ${userId}
      `);
      const emailForNotif = user.email as string;
      await writeAuthAudit("auth.account_deleted", userId, getClientIpForAuth(req), { email: emailForNotif });
      req.session.destroy(() => {});
      await sendAccountDeletedEmail(emailForNotif);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[auth] delete-account error:", err.message);
      return res.status(500).json({ error: "Failed to delete account" });
    }
  });
}
