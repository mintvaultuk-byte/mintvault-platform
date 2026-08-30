import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../server/db", () => ({ db: { execute } }));

function fakeSession(seed: Record<string, unknown>) {
  const session: Record<string, unknown> = { ...seed };
  session.destroyed = false;
  session.destroy = (callback: () => void) => {
    session.destroyed = true;
    callback();
  };
  return session;
}

function fakeRes() {
  const response: any = { statusCode: 200, body: undefined, cookieCleared: false };
  response.status = (statusCode: number) => ((response.statusCode = statusCode), response);
  response.json = (body: unknown) => ((response.body = body), response);
  response.clearCookie = () => ((response.cookieCleared = true), response);
  return response;
}

const liveUser = {
  id: "customer-1",
  email: "live@example.test",
  email_verified: true,
  credential_version: 5,
};

describe("customer credential-version session authority", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("accepts the current version, refreshes cached identity, and rejects a stale peer", async () => {
    const { requireAuth } = await import("../server/middleware/auth");
    const current = fakeSession({
      userId: "customer-1",
      userEmail: "stale@example.test",
      authUserId: "customer-1",
      authRole: "customer",
      credentialVersion: 5,
    });
    const peer = fakeSession({
      userId: "customer-1",
      userEmail: "live@example.test",
      authUserId: "customer-1",
      authRole: "customer",
      credentialVersion: 4,
    });
    execute.mockResolvedValue({ rows: [liveUser] });

    let currentPassed = false;
    const currentRes = fakeRes();
    await requireAuth({ session: current } as any, currentRes, () => {
      currentPassed = true;
    });
    expect(currentPassed).toBe(true);
    expect(current.userEmail).toBe("live@example.test");

    let peerPassed = false;
    const peerRes = fakeRes();
    await requireAuth({ session: peer } as any, peerRes, () => {
      peerPassed = true;
    });
    expect(peerPassed).toBe(false);
    expect(peerRes.statusCode).toBe(401);
    expect(peer.destroyed).toBe(true);
    expect(peerRes.cookieCleared).toBe(true);
  });

  it("keeps an unverified account signed in but refuses access to email-keyed customer records", async () => {
    const { requireCustomer } = await import("../server/customer-auth");
    const session = fakeSession({
      userId: "customer-1",
      userEmail: "live@example.test",
      customerEmail: "live@example.test",
      authUserId: "customer-1",
      authRole: "customer",
      credentialVersion: 5,
    });
    execute.mockResolvedValue({ rows: [{ ...liveUser, email_verified: false }] });

    let passed = false;
    const res = fakeRes();
    await requireCustomer({ session } as any, res, () => {
      passed = true;
    });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "email_verification_required" });
    expect(session.destroyed).toBe(false);
  });

  it("physically deletes both customer session shapes while preserving the acting sid", async () => {
    const dialect = new PgDialect();
    let compiled: ReturnType<PgDialect["sqlToQuery"]> | undefined;
    execute.mockImplementation(async (query) => {
      compiled = dialect.sqlToQuery(query);
      return { rows: [{ sid: "peer-a" }, { sid: "peer-b" }] };
    });
    const { revokeCustomerSessions } = await import("../server/customer-session-authority");

    await expect(revokeCustomerSessions("customer-1", "acting-sid")).resolves.toBe(2);
    expect(compiled?.sql).toMatch(/DELETE FROM session/);
    expect(compiled?.sql).toContain("sess ->> 'userId'");
    expect(compiled?.sql).toContain("sess ->> 'authUserId'");
    expect(compiled?.sql).toContain("sid <>");
    expect(compiled?.params).toEqual(["customer-1", "customer-1", "acting-sid"]);
  });
});
