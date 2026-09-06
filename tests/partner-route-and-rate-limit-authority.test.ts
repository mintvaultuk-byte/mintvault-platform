import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  MemoryRateLimitStore,
  UnavailableRateLimitStore,
  partnerSharedRateLimitStoreInstalled,
  setPartnerRateLimitStore,
} from "../server/partner/rate-limit";

const read = (path: string) => readFileSync(path, "utf8");

describe("Partner public-route and fleet-rate-limit authority", () => {
  it("defines public authentication/onboarding endpoints in exactly one router", () => {
    const publicRoutes = read("server/partner/public-routes.ts");
    const authenticatedRoutes = read("server/partner/routes.ts");
    for (const endpoint of [
      '"/auth/login"',
      '"/auth/password-reset/request"',
      '"/auth/password-reset/consume"',
      '"/invitations/accept"',
    ]) {
      expect(publicRoutes).toContain(endpoint);
      expect(authenticatedRoutes).not.toContain(endpoint);
    }
    expect(authenticatedRoutes).not.toContain("SHADOWED DUPLICATE");
  });

  it("uses an unavailable default so sensitive routes fail closed until PostgreSQL is installed", async () => {
    await expect(new UnavailableRateLimitStore().hit("key", 1_000)).rejects.toThrow(/not ready/);
    const rateLimitSource = read("server/partner/rate-limit.ts");
    expect(rateLimitSource).toContain("let store: RateLimitStore = new UnavailableRateLimitStore()");
    expect(rateLimitSource).not.toContain("let store: RateLimitStore = new MemoryRateLimitStore()");
    const installer = read("server/partner/rate-limit-store-pg.ts");
    expect(installer).not.toMatch(/falling back to the per-machine|remain PER-MACHINE/);
  });

  it("does not let an injected per-machine memory store satisfy production readiness", () => {
    setPartnerRateLimitStore(new MemoryRateLimitStore());
    expect(partnerSharedRateLimitStoreInstalled()).toBe(false);
    expect(read("server/partner/rate-limit-store-pg.ts")).toContain("installSharedPostgresPartnerRateLimitStore");
  });

  it("does not install or mark ready when the canonical runtime credential probe rejects privilege", async () => {
    setPartnerRateLimitStore(new MemoryRateLimitStore());
    const query = vi.fn();
    const { installSharedPartnerRateLimitStore } = await import("../server/partner/rate-limit-store-pg");

    await expect(
      installSharedPartnerRateLimitStore({
        capabilityProbe: async () => ({
          ok: false,
          checkedAt: new Date(0).toISOString(),
          capability: "partner_runtime_no_bypassrls",
          code: "PARTNER_RUNTIME_SUPERUSER_FORBIDDEN",
        }),
        query,
      })
    ).resolves.toBe(false);

    expect(query).not.toHaveBeenCalled();
    expect(partnerSharedRateLimitStoreInstalled()).toBe(false);
  });
});
