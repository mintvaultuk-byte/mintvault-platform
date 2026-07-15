import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import session, { MemoryStore } from "express-session";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import rateLimit from "express-rate-limit";
import { registerAuthRoutes } from "../server/routes/auth";

const adminUserState = vi.hoisted(() => ({
  user: {
    id: "admin-user-1",
    email: "mintvaultuk@gmail.com",
    pinHash: "hash",
    credentialVersion: 1,
    adminPassphraseHash: null as string | null,
  },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getUserByEmail: vi.fn(async () => adminUserState.user),
    writeAuditLog: vi.fn(async () => {}),
  },
}));

vi.mock("../server/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
}));

vi.mock("../server/customer-auth", () => ({
  createMagicToken: vi.fn(() => "token"),
  verifyMagicToken: vi.fn(() => null),
  requireCustomer: vi.fn((_req, res) => res.status(401).json({ error: "Unauthorized" })),
}));

vi.mock("../server/account-auth", () => ({
  hashPassword: vi.fn(async () => "hash"),
  verifyPassword: vi.fn(async (password: string) => password === "db-passphrase"),
  validatePassword: vi.fn(() => ({ ok: true })),
  createEmailVerificationToken: vi.fn(() => "verify-token"),
  createPasswordResetToken: vi.fn(() => "reset-token"),
  createAccountMagicLinkToken: vi.fn(() => "magic-token"),
  findUserByEmail: vi.fn(async () => null),
  findUserById: vi.fn(async () => null),
  countRecentFailedAttempts: vi.fn(async () => 0),
  logLoginAttempt: vi.fn(async () => {}),
  writeAuthAudit: vi.fn(async () => {}),
}));

vi.mock("../server/email", () => ({
  sendMagicLink: vi.fn(async () => {}),
  sendPinResetLink: vi.fn(async () => {}),
  sendWelcomeVerificationEmail: vi.fn(async () => {}),
  sendAccountMagicLinkEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendPasswordChangedEmail: vi.fn(async () => {}),
  sendEmailChangedNotification: vi.fn(async () => {}),
  sendAccountDeletedEmail: vi.fn(async () => {}),
}));

vi.mock("../server/pin", () => ({
  verifyPin: vi.fn(async (pin: string) => pin === "123456"),
  checkLockout: vi.fn(async () => ({ locked: false })),
  registerFailure: vi.fn(async () => ({ locked: false })),
  resetFailures: vi.fn(async () => {}),
  logPinEvent: vi.fn(async () => {}),
  hashIp: vi.fn(() => "ip-hash"),
  PIN_LOCKOUT_DURATION_MS: 15 * 60 * 1000,
}));

type TestApp = {
  base: string;
  close: () => Promise<void>;
};

function cookieHeader(cookies: string[]) {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function mergeCookies(existing: string[], response: Response) {
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const next = [...existing];
  for (const cookie of setCookie) {
    const name = cookie.split("=")[0];
    const index = next.findIndex((c) => c.startsWith(`${name}=`));
    const expired = /Max-Age=0/i.test(cookie) || /Expires=Thu, 01 Jan 1970/i.test(cookie);
    if (expired) {
      if (index >= 0) next.splice(index, 1);
      continue;
    }
    if (index >= 0) next[index] = cookie;
    else next.push(cookie);
  }
  return next;
}

async function withAuthApp<T>(
  run: (app: TestApp, store: MemoryStore) => Promise<T>,
  store = new MemoryStore()
): Promise<T> {
  process.env.ADMIN_PASSWORD = "correct-passphrase";
  const app = express();
  app.use(express.json());
  app.use(
    session({
      store,
      secret: "test-secret",
      name: "mv.sid",
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 60_000 },
    })
  );
  registerAuthRoutes(app);

  let server: Server | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await run({ base, close: () => new Promise((resolve) => server!.close(() => resolve())) }, store);
  } finally {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
}

async function request(base: string, path: string, init: RequestInit = {}, cookies: string[] = []) {
  const headers = new Headers(init.headers);
  if (cookies.length > 0) headers.set("cookie", cookieHeader(cookies));
  return fetch(`${base}${path}`, { ...init, headers });
}

async function login(base: string) {
  let cookies: string[] = [];
  const password = await request(
    base,
    "/api/admin/session",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct-passphrase" }),
    },
    cookies
  );
  expect(password.status).toBe(200);
  cookies = mergeCookies(cookies, password);

  const pin = await request(
    base,
    "/api/admin/pin",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456" }),
    },
    cookies
  );
  expect(pin.status).toBe(200);
  cookies = mergeCookies(cookies, pin);
  return cookies;
}

describe("admin auth reliability", () => {
  beforeEach(() => {
    adminUserState.user = {
      id: "admin-user-1",
      email: "mintvaultuk@gmail.com",
      pinHash: "hash",
      credentialVersion: 1,
      adminPassphraseHash: null,
    };
  });

  it("does not rate-limit harmless admin session refresh checks", async () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 5, validate: false, skip: (req) => req.method !== "POST" });
    const app = express();
    app.use("/api/admin/session", limiter);
    app.get("/api/admin/session", (_req, res) => res.json({ authenticated: false }));
    app.post("/api/admin/session", (_req, res) => res.json({ step: "PIN_REQUIRED" }));

    let server: Server | undefined;
    try {
      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => resolve());
      });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (let i = 0; i < 10; i += 1) {
        expect((await fetch(`${base}/api/admin/session`)).status).toBe(200);
      }
      expect((await fetch(`${base}/api/admin/session`, { method: "POST" })).status).toBe(200);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it("supports fresh login, browser refresh, multiple tabs, logout, and failed login", async () => {
    await withAuthApp(async ({ base }) => {
      const failed = await request(base, "/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(failed.status).toBe(401);

      let cookies = await login(base);
      const refresh = await request(base, "/api/admin/session", {}, cookies);
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toMatchObject({ authenticated: true });

      const [tabA, tabB] = await Promise.all([
        request(base, "/api/admin/session", {}, cookies),
        request(base, "/api/admin/session", {}, cookies),
      ]);
      expect(tabA.status).toBe(200);
      expect(tabB.status).toBe(200);

      const logout = await request(base, "/api/admin/logout", { method: "POST" }, cookies);
      expect(logout.status).toBe(200);
      expect(logout.headers.getSetCookie().join("\\n")).toContain("mv.sid=");
      cookies = mergeCookies(cookies, logout);

      const afterLogout = await request(base, "/api/admin/session", {}, cookies);
      expect(afterLogout.status).toBe(200);
      expect(await afterLogout.json()).toMatchObject({ authenticated: false, reason: "not_authenticated" });
    });
  });

  it("clears invalid and expired admin cookies without redirect loops", async () => {
    await withAuthApp(async ({ base }) => {
      const invalidCookie = ["mv.sid=s%3Ainvalid.invalid; Path=/; HttpOnly"];
      const first = await request(base, "/api/admin/session", {}, invalidCookie);
      expect(first.status).toBe(401);
      expect(await first.json()).toMatchObject({ authenticated: false, reason: "session_expired" });
      expect(first.headers.getSetCookie().join("\\n")).toContain("mv.sid=");

      const clearedCookies = mergeCookies(invalidCookie, first);
      const second = await request(base, "/api/admin/session", {}, clearedCookies);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ authenticated: false, reason: "not_authenticated" });
    });
  });

  it("clears stale pending-admin sessions after expiry", async () => {
    await withAuthApp(async ({ base }, store) => {
      let cookies = await login(base);

      const staleApp = express();
      staleApp.use(express.json());
      staleApp.use(
        session({
          store,
          secret: "test-secret",
          name: "mv.sid",
          resave: false,
          saveUninitialized: false,
          cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 60_000 },
        })
      );
      staleApp.get("/api/admin/session", (req, res) => {
        req.session.isAdmin = false;
        req.session.pendingAdmin = true;
        req.session.pendingAdminAt = Date.now() - 10 * 60 * 1000;
        req.session.save(() => res.json({ ok: true }));
      });
      let staleServer: Server | undefined;
      await new Promise<void>((resolve) => {
        staleServer = staleApp.listen(0, "127.0.0.1", () => resolve());
      });
      const staleBase = `http://127.0.0.1:${(staleServer!.address() as AddressInfo).port}`;
      const seeded = await request(staleBase, "/api/admin/session", {}, cookies);
      cookies = mergeCookies(cookies, seeded);
      await new Promise<void>((resolve) => staleServer!.close(() => resolve()));

      const expired = await request(base, "/api/admin/session", {}, cookies);
      expect(expired.status).toBe(401);
      expect(await expired.json()).toMatchObject({ authenticated: false, reason: "session_expired" });
    });
  });

  it("persists sessions across a server restart and a second app instance", async () => {
    const store = new MemoryStore();
    let cookies: string[] = [];
    await withAuthApp(async ({ base }) => {
      cookies = await login(base);
    }, store);

    await withAuthApp(async ({ base }) => {
      const res = await request(base, "/api/admin/session", {}, cookies);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ authenticated: true });
    }, store);
  });

  it("clear-session destroys only auth session state and expires the cookie", async () => {
    await withAuthApp(async ({ base }) => {
      const cookies = await login(base);
      const clear = await request(base, "/api/admin/clear-session", { method: "POST" }, cookies);
      expect(clear.status).toBe(200);
      expect(await clear.json()).toEqual({ success: true });
      expect(clear.headers.getSetCookie().join("\\n")).toContain("mv.sid=");

      const after = await request(base, "/api/admin/session", {}, mergeCookies(cookies, clear));
      expect(after.status).toBe(200);
      expect(await after.json()).toMatchObject({ authenticated: false, reason: "not_authenticated" });
    });
  });

  it("uses the DB admin passphrase hash when configured", async () => {
    adminUserState.user.adminPassphraseHash = "bcrypt-hash";
    await withAuthApp(async ({ base }) => {
      const ok = await request(base, "/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "db-passphrase" }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ step: "PIN_REQUIRED" });
    });
  });

  it("does not fall back to ADMIN_PASSWORD after a DB hash mismatch", async () => {
    adminUserState.user.adminPassphraseHash = "bcrypt-hash";
    await withAuthApp(async ({ base }) => {
      const denied = await request(base, "/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-passphrase" }),
      });
      expect(denied.status).toBe(401);
    });
  });

  it("invalidates an admin session when credential_version changes", async () => {
    await withAuthApp(async ({ base }) => {
      const cookies = await login(base);
      adminUserState.user = { ...adminUserState.user, credentialVersion: 2 };
      const refresh = await request(base, "/api/admin/session", {}, cookies);
      expect(refresh.status).toBe(401);
      expect(await refresh.json()).toMatchObject({ authenticated: false, reason: "session_expired" });
      expect(refresh.headers.getSetCookie().join("\\n")).toContain("mv.sid=");
    });
  });
});
