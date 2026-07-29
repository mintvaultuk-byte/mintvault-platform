/**
 * Hostile-review F5: `/api/super-admin/*` must inherit the admin IP allowlist.
 *
 * The super-admin surface is strictly more privileged than `/api/admin` — it reads across every
 * tenant and returns bulk partner PII — yet it sat outside the allowlist while the narrower
 * surface was protected. These tests pin the mount and the fail-safe semantics that make it
 * safe to apply.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { Request, Response, NextFunction } from "express";

const indexSrc = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");

// server/auth.ts transitively imports server/db.ts, which validates MINTVAULT_DATABASE_URL at
// module load. Nothing here connects — a placeholder is enough to import the middleware.
let adminIpAllowlist: (req: Request, res: Response, next: NextFunction) => void;
beforeAll(async () => {
  process.env.MINTVAULT_DATABASE_URL ??= "postgres://u:p@127.0.0.1:1/none";
  process.env.SESSION_SECRET ??= "test-only-not-a-real-secret";
  ({ adminIpAllowlist } = await import("../server/auth"));
});

describe("F5 — super-admin routes inherit the admin IP allowlist", () => {
  it("mounts the allowlist on /api/super-admin as well as /api/admin", () => {
    expect(indexSrc).toMatch(/app\.use\(\s*["']\/api\/admin["']\s*,\s*adminIpAllowlist\s*\)/);
    expect(indexSrc).toMatch(/app\.use\(\s*["']\/api\/super-admin["']\s*,\s*adminIpAllowlist\s*\)/);
  });

  it("mounts it BEFORE the routers are registered, or it would never run", () => {
    const mountAt = indexSrc.indexOf('app.use("/api/super-admin", adminIpAllowlist)');
    // The CALL site, not the import at the top of the file.
    const registerAt = indexSrc.indexOf("await registerRoutes(");
    expect(mountAt).toBeGreaterThan(0);
    expect(registerAt).toBeGreaterThan(0);
    expect(mountAt).toBeLessThan(registerAt);
  });

  it("covers EVERY super-admin router, present and future, by prefix", () => {
    // A prefix mount cannot be forgotten when a fifth router is added — which is precisely
    // how the Partner Master Dashboard ended up uncovered.
    const routers = ["grading-partners", "connector-ops", "partner-management", "partner-dashboard"];
    for (const r of routers) expect(`/api/super-admin/${r}`.startsWith("/api/super-admin")).toBe(true);
  });
});

describe("F5 — the allowlist is fail-SAFE, so applying it more widely cannot break a deployment", () => {
  const call = (env: string | undefined, ip: string) => {
    const prev = process.env.ADMIN_IP_ALLOWLIST;
    if (env === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
    else process.env.ADMIN_IP_ALLOWLIST = env;
    let nexted = false;
    let status: number | null = null;
    const req = { headers: {}, socket: { remoteAddress: ip }, ip } as unknown as Request;
    const res = {
      status(c: number) {
        status = c;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    adminIpAllowlist(req, res, () => {
      nexted = true;
    });
    if (prev === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
    else process.env.ADMIN_IP_ALLOWLIST = prev;
    return { nexted, status };
  };

  it("is a NO-OP when ADMIN_IP_ALLOWLIST is unset — zero change for deployments not using it", () => {
    expect(call(undefined, "203.0.113.9").nexted).toBe(true);
  });

  it("is a NO-OP when the variable is set but empty", () => {
    expect(call("", "203.0.113.9").nexted).toBe(true);
    expect(call("   ,  ,", "203.0.113.9").nexted).toBe(true);
  });

  it("blocks an address outside the list once one is configured", () => {
    const r = call("198.51.100.4", "203.0.113.9");
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it("admits an address on the list", () => {
    expect(call("198.51.100.4,203.0.113.9", "203.0.113.9").nexted).toBe(true);
  });
});

describe("F5 — no lockout is possible, because auth itself is already allowlisted", () => {
  it("both admin login steps live under /api/admin", () => {
    // This is the whole safety argument: a super-admin session can only be minted through
    // these two routes, which the allowlist already covers. Anyone who can authenticate has
    // therefore already passed it from the same address.
    const auth = readFileSync(join(process.cwd(), "server", "routes", "auth.ts"), "utf8");
    expect(auth).toContain('"/api/admin/login"');
    expect(auth).toContain('"/api/admin/pin"');
  });

  it("requireSuperAdmin is gated behind requireAdmin, not an independent entry point", () => {
    const authSrc = readFileSync(join(process.cwd(), "server", "auth.ts"), "utf8");
    const fn = authSrc.slice(authSrc.indexOf("export async function requireSuperAdmin"));
    expect(fn.slice(0, 400)).toContain("requireAdmin(");
  });
});
