import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;

function restoreEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_VITEST === undefined) delete process.env.VITEST;
  else process.env.VITEST = ORIGINAL_VITEST;
}

async function importService() {
  vi.resetModules();
  return import("../server/partner/partner-management-service");
}

describe("partner management test hooks production safety", () => {
  afterEach(async () => {
    restoreEnv();
    const svc = await importService();
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    svc.__setCreatePartnerFailurePointForTest(null);
    svc.__setInvitePartnerFailurePointForTest(null);
    svc.__setInvitePartnerBarrierForTest(null);
    svc.__setAcceptPartnerBarrierForTest(null);
    restoreEnv();
  });

  it("production fails closed before considering VITEST", async () => {
    process.env.NODE_ENV = "production";
    process.env.VITEST = "true";
    const svc = await importService();

    expect(() => svc.__setCreatePartnerFailurePointForTest("after_org_insert")).toThrow(
      "partner management test hooks are only available under the test runner."
    );
    expect(() => svc.__setInvitePartnerFailurePointForTest("after_user_insert")).toThrow(
      "partner management test hooks are only available under the test runner."
    );
    expect(() => svc.__setInvitePartnerBarrierForTest({ point: "after_duplicate_check", parties: 2 })).toThrow(
      "partner management test hooks are only available under the test runner."
    );
    expect(() => svc.__setAcceptPartnerBarrierForTest({ point: "before_invitation_lock", parties: 2 })).toThrow(
      "partner management test hooks are only available under the test runner."
    );
  });

  it("production remains inert with conflicting test-like inputs", async () => {
    process.env.NODE_ENV = "production";
    process.env.VITEST = "true";
    const svc = await importService();

    expect(() => svc.__setCreatePartnerFailurePointForTest(null)).toThrow(
      "partner management test hooks are only available under the test runner."
    );
  });

  it("NODE_ENV=test can arm and clear hooks", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const svc = await importService();

    expect(() => svc.__setCreatePartnerFailurePointForTest("after_org_insert")).not.toThrow();
    expect(() => svc.__setCreatePartnerFailurePointForTest(null)).not.toThrow();
  });

  it("Vitest mode can arm and clear hooks outside production", async () => {
    delete process.env.NODE_ENV;
    process.env.VITEST = "true";
    const svc = await importService();

    expect(() => svc.__setInvitePartnerFailurePointForTest("before_invitation_insert")).not.toThrow();
    expect(() => svc.__setInvitePartnerFailurePointForTest(null)).not.toThrow();
  });
});
