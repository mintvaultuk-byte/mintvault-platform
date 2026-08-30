/**
 * Customer session identity — login paths stamp a live, versioned users-row
 * authority before the collection can be read.
 *
 * WHY THIS SUITE EXISTS — the defect found on production 2026-08-23:
 *
 *   The whole customer-facing surface used to trust one cached session key:
 *   `customerEmail`. That made a stale or unverified email an authorization
 *   credential. `requireCustomer` now resolves the live users row, validates the
 *   credential-version stamp, and requires verified email ownership.
 *
 *   `/api/auth/magic-link/verify` set `userId` + `userEmail`, then redirected to
 *   `/dashboard` — and never set `customerEmail`. Reproduced on staging with a
 *   real claimed certificate (MV580): after the magic-link login `/api/auth/me`
 *   returned 200 with the correct identity while `/api/customer/certificates`
 *   returned 401, so the dashboard rendered its logged-out state and the claimed
 *   card was invisible. The same omission was in `/api/auth/signup`, and
 *   `/api/auth/change-email` left `customerEmail` on the OLD address — a
 *   stale-identity read of the previous email's collection.
 *
 *   It mattered because a claimant has no other way in: completeClaimByToken()
 *   creates the owner's `users` row with no password and no PIN, so password and
 *   PIN login both reject them and the magic link is their only route.
 *
 * These tests drive the REAL handlers registered by registerAuthRoutes() and then
 * feed the resulting session to the REAL requireCustomer middleware. Each one
 * FAILS against the pre-fix handlers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn(async () => ({ rows: [] as Record<string, unknown>[] })));
const findUserById = vi.hoisted(() => vi.fn());
const findUserByEmail = vi.hoisted(() => vi.fn());

vi.mock("../server/db", () => ({
  db: {
    execute,
    transaction: vi.fn(async (work: (tx: { execute: typeof execute }) => unknown) => work({ execute })),
  },
}));
vi.mock("../server/storage", () => ({ storage: { writeAuditLog: vi.fn(async () => {}), getUserByEmail: vi.fn() } }));
vi.mock("../server/account-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/account-auth")>();
  return {
    ...actual,
    findUserById,
    findUserByEmail,
    countRecentFailedAttempts: vi.fn(async () => 0),
    logLoginAttempt: vi.fn(async () => {}),
    writeAuthAudit: vi.fn(async () => {}),
    createEmailVerificationToken: vi.fn(async () => "verify-token"),
    createAccountMagicLinkToken: vi.fn(async () => "magic-token"),
    hashPassword: vi.fn(async () => "hashed"),
    verifyPassword: vi.fn(async () => true),
  };
});
vi.mock("../server/email", () => ({
  sendAccountDeletedEmail: vi.fn(async () => {}),
  sendAccountMagicLinkEmail: vi.fn(async () => {}),
  sendEmailChangedNotification: vi.fn(async () => {}),
  sendMagicLink: vi.fn(async () => {}),
  sendPasswordChangedEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendPinResetLink: vi.fn(async () => {}),
  sendWelcomeVerificationEmail: vi.fn(async () => {}),
}));
vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  return { ...actual, requireAdmin: (_r: unknown, _s: unknown, n: () => void) => n() };
});

type Handler = (req: any, res: any, next?: any) => unknown;
const routes = new Map<string, Handler>();

/** A fake Express that records the FINAL handler of each registered route. */
function fakeApp() {
  const record =
    (method: string) =>
    (path: string, ...handlers: Handler[]) => {
      routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
    };
  return {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
    use: () => {},
  };
}

/** A session object shaped like express-session's, including regenerate(). */
function fakeSession(seed: Record<string, unknown> = {}) {
  const s: Record<string, unknown> = { ...seed };
  s.regenerate = (cb: (e?: Error) => void) => {
    for (const k of Object.keys(s)) if (k !== "regenerate" && k !== "destroy" && k !== "save") delete s[k];
    cb();
  };
  s.destroy = (cb: () => void) => cb();
  s.save = (cb: () => void) => cb();
  return s;
}

/** A request shaped like Express's, enough for getAppBaseUrl() and the IP helpers. */
function fakeReq(extra: Record<string, unknown>) {
  return {
    headers: {},
    ip: "127.0.0.1",
    protocol: "https",
    sessionID: "acting-session",
    get: (h: string) => (h.toLowerCase() === "host" ? "mintvault.test" : undefined),
    ...extra,
  };
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined, redirected: undefined };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  r.redirect = (u: string) => ((r.redirected = u), r);
  r.clearCookie = () => r;
  r.cookie = () => r;
  r.setHeader = () => r;
  return r;
}

/** Ask the REAL requireCustomer middleware whether this session can read the collection. */
async function collectionReadable(session: Record<string, unknown>): Promise<boolean> {
  const { requireCustomer } = await import("../server/customer-auth");
  let passed = false;
  const res = fakeRes();
  await requireCustomer({ session } as any, res as any, () => {
    passed = true;
  });
  return passed;
}

beforeEach(async () => {
  routes.clear();
  execute.mockReset();
  execute.mockResolvedValue({ rows: [] });
  findUserById.mockReset();
  findUserByEmail.mockReset();
  const { registerAuthRoutes } = await import("../server/routes/auth");
  registerAuthRoutes(fakeApp() as never);
});

describe("customer session identity — the key the collection is read by", () => {
  it("registers the account login paths under test (non-vacuous)", () => {
    expect(routes.has("GET /api/auth/magic-link/verify")).toBe(true);
    expect(routes.has("POST /api/auth/signup")).toBe(true);
    expect(routes.has("PUT /api/auth/change-email")).toBe(true);
    expect(routes.has("PUT /api/auth/change-password")).toBe(true);
  });

  it("REGRESSION: account magic-link verifies and stamps the live identity", async () => {
    const user = {
      id: "u-1",
      email: "claimant@example.test",
      deleted_at: null,
      display_name: null,
      credential_version: 4,
    };
    execute.mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] }); // token consume
    execute.mockResolvedValueOnce({
      rows: [{ id: "u-1", email: "claimant@example.test", credential_version: 4 }],
    }); // verification + login update
    execute.mockResolvedValueOnce({
      rows: [{ id: "u-1", email: "claimant@example.test", email_verified: true, credential_version: 4 }],
    }); // live requireCustomer authority
    findUserById.mockResolvedValue(user);

    const session = fakeSession();
    const res = fakeRes();
    await routes.get("GET /api/auth/magic-link/verify")!(fakeReq({ query: { token: "magic-token" }, session }), res);

    expect(res.redirected).toBe("/dashboard");
    expect(session.userId).toBe("u-1");
    expect(session.customerEmail).toBe("claimant@example.test");
    expect(session.credentialVersion).toBe(4);
    expect(await collectionReadable(session)).toBe(true);
  });

  it("REGRESSION: signup is authenticated but cannot read customer records before verification", async () => {
    findUserByEmail.mockResolvedValue(null);
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "u-2",
            email: "new@example.test",
            display_name: null,
            email_verified: false,
            credential_version: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "u-2", email: "new@example.test", email_verified: false, credential_version: 1 }],
      });

    const session = fakeSession();
    const res = fakeRes();
    await routes.get("POST /api/auth/signup")!(
      fakeReq({ body: { email: "new@example.test", password: "correcthorse1", display_name: "New" }, session }),
      res
    );

    expect(res.body, JSON.stringify(res.body)).toBeTruthy();
    expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
    expect(session.customerEmail).toBe("new@example.test");
    expect(session.credentialVersion).toBe(1);
    expect(await collectionReadable(session)).toBe(false);
  });

  it("REGRESSION: changing email moves the collection identity off the old address", async () => {
    const user = { id: "u-3", email: "old@example.test", password_hash: "h", display_name: null, deleted_at: null };
    findUserById.mockResolvedValue(user);
    findUserByEmail.mockResolvedValue(null);
    execute
      .mockResolvedValueOnce({ rows: [{ email: "new@example.test", credential_version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ sid: "peer-session" }] });

    const session = fakeSession({ userId: "u-3", userEmail: "old@example.test", customerEmail: "old@example.test" });
    const res = fakeRes();
    await routes.get("PUT /api/auth/change-email")!(
      fakeReq({ body: { new_email: "New@Example.test", password: "correcthorse1" }, session }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(session.userEmail).toBe("new@example.test");
    // The old address must not keep serving its collection to this session.
    expect(session.customerEmail).toBe("new@example.test");
    expect(session.credentialVersion).toBe(2);
  });

  it("requireCustomer still refuses a session that carries only the account identity", async () => {
    const accountOnly = fakeSession({ userId: "u-9", userEmail: "someone@example.test" });
    expect(await collectionReadable(accountOnly)).toBe(false);
  });

  it("REGRESSION: a password change preserves the acting session and rejects a stale peer even if row cleanup fails", async () => {
    const user = {
      id: "u-10",
      email: "owner@example.test",
      password_hash: "old-hash",
      deleted_at: null,
      email_verified: true,
      credential_version: 7,
    };
    findUserById.mockResolvedValue(user);
    execute
      .mockResolvedValueOnce({ rows: [{ credential_version: 8 }] }) // password + version rotation
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // durable password-changed notification enqueue
      .mockRejectedValueOnce(new Error("session store temporarily unavailable")); // physical peer cleanup

    const current = fakeSession({
      userId: "u-10",
      userEmail: "owner@example.test",
      customerEmail: "owner@example.test",
      authUserId: "u-10",
      authRole: "customer",
      credentialVersion: 7,
    });
    const peer = fakeSession({
      userId: "u-10",
      userEmail: "owner@example.test",
      customerEmail: "owner@example.test",
      authUserId: "u-10",
      authRole: "customer",
      credentialVersion: 7,
    });
    const res = fakeRes();

    await routes.get("PUT /api/auth/change-password")!(
      fakeReq({ body: { current_password: "old-password-1", new_password: "new-password-2" }, session: current }),
      res
    );

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(current.credentialVersion).toBe(8);

    execute
      .mockResolvedValueOnce({
        rows: [{ id: "u-10", email: "owner@example.test", email_verified: true, credential_version: 8 }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "u-10", email: "owner@example.test", email_verified: true, credential_version: 8 }],
      });
    expect(await collectionReadable(current)).toBe(true);
    expect(await collectionReadable(peer)).toBe(false);
  });
});
