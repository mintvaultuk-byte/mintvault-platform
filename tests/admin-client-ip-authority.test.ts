import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClientIpRateLimitKey, canonicalAdminIp, resolveAdminClientIp } from "../server/lib/admin-client-ip";

let adminIpAllowlist: (req: Request, res: Response, next: NextFunction) => unknown;
const original = {
  allowlist: process.env.ADMIN_IP_ALLOWLIST,
  flyAppName: process.env.FLY_APP_NAME,
  flyMachineId: process.env.FLY_MACHINE_ID,
};

beforeAll(async () => {
  process.env.MINTVAULT_DATABASE_URL ??= "postgres://u:p@127.0.0.1:1/none";
  process.env.SESSION_SECRET ??= "test-only-not-a-real-secret";
  ({ adminIpAllowlist } = await import("../server/auth"));
});

afterAll(() => {
  if (original.allowlist === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
  else process.env.ADMIN_IP_ALLOWLIST = original.allowlist;
  if (original.flyAppName === undefined) delete process.env.FLY_APP_NAME;
  else process.env.FLY_APP_NAME = original.flyAppName;
  if (original.flyMachineId === undefined) delete process.env.FLY_MACHINE_ID;
  else process.env.FLY_MACHINE_ID = original.flyMachineId;
});

function flyRequest({
  clientIp = "198.51.100.9",
  peerIp = "172.19.0.7",
  port = "443",
  xff,
}: {
  clientIp?: string | string[];
  peerIp?: string;
  port?: string | string[];
  xff?: string;
} = {}): Request {
  return {
    headers: {
      "fly-client-ip": clientIp,
      "fly-forwarded-port": port,
      ...(xff === undefined ? {} : { "x-forwarded-for": xff }),
    },
    socket: { remoteAddress: peerIp },
  } as unknown as Request;
}

async function listen(application: express.Express): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function modelFlyProxyPeer(req: Request, _res: Response, next: NextFunction): void {
  Object.defineProperty(req.socket, "remoteAddress", { configurable: true, value: "172.19.0.7" });
  next();
}

describe("CC-OA-001 — canonical Admin client-IP authority", () => {
  it("uses Fly's overwritten client-IP header and ignores caller-controlled forwarding headers", () => {
    process.env.FLY_APP_NAME = "mintvault-v2";
    const req = flyRequest({
      clientIp: "2001:0DB8:0:0:0:0:0:1",
      xff: "203.0.113.7, 198.51.100.90, 66.241.125.187",
    });
    expect(resolveAdminClientIp(req)).toBe("2001:db8::1");
    expect(adminClientIpRateLimitKey(req)).toBe("2001:db8::1");
  });

  it("ignores empty, malformed, multiple, and proxy-appended XFF values", () => {
    process.env.FLY_APP_NAME = "mintvault-v2";
    for (const xff of [undefined, "", ",,,", "not-an-ip", "203.0.113.7, 198.51.100.90, 66.241.125.187"]) {
      expect(resolveAdminClientIp(flyRequest({ clientIp: "198.51.100.9", xff }))).toBe("198.51.100.9");
    }
  });

  it("fails closed for a non-proxy peer or missing, duplicate, and malformed Fly authority", () => {
    process.env.FLY_APP_NAME = "mintvault-v2";
    expect(resolveAdminClientIp(flyRequest({ peerIp: "127.0.0.1" }))).toBeNull();
    expect(resolveAdminClientIp(flyRequest({ peerIp: "203.0.113.20" }))).toBeNull();
    expect(resolveAdminClientIp(flyRequest({ clientIp: ["198.51.100.9", "203.0.113.7"] }))).toBeNull();
    expect(resolveAdminClientIp(flyRequest({ clientIp: "198.51.100.9, 203.0.113.7" }))).toBeNull();
    expect(resolveAdminClientIp(flyRequest({ clientIp: "not-an-ip" }))).toBeNull();
    expect(resolveAdminClientIp(flyRequest({ port: "0" }))).toBeNull();
    expect(resolveAdminClientIp(flyRequest({ port: "443, 9" }))).toBeNull();
    expect(adminClientIpRateLimitKey(flyRequest({ peerIp: "127.0.0.1" }))).toBe("admin-client-ip-unresolved");
  });

  it("canonicalises IPv6 and IPv4-mapped IPv6 without accepting zones or invalid forms", () => {
    expect(canonicalAdminIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalAdminIp("::FFFF:CB00:7109")).toBe("203.0.113.9");
    expect(canonicalAdminIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(canonicalAdminIp("fe80::1%eth0")).toBeNull();
    expect(canonicalAdminIp("010.0.0.1")).toBeNull();
  });

  it("keeps direct/local requests on socket authority and ignores XFF", () => {
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_MACHINE_ID;
    const req = {
      headers: { "x-forwarded-for": "203.0.113.7" },
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      ip: "203.0.113.7",
    } as unknown as Request;
    expect(resolveAdminClientIp(req)).toBe("127.0.0.1");
    expect(adminClientIpRateLimitKey(req)).toBe("127.0.0.1");
  });
});

describe("CC-OA-001 — real Express allowlist and limiter regressions", () => {
  it("does not let a forged leftmost XFF bypass the Admin allowlist", async () => {
    process.env.FLY_APP_NAME = "mintvault-v2";
    process.env.ADMIN_IP_ALLOWLIST = "203.0.113.7";
    const application = express();
    application.use(modelFlyProxyPeer, adminIpAllowlist);
    application.get("/api/admin/probe", (_req, res) => res.json({ ok: true }));
    const { baseUrl, server } = await listen(application);
    try {
      const denied = await fetch(`${baseUrl}/api/admin/probe`, {
        headers: {
          "Fly-Client-IP": "198.51.100.9",
          "Fly-Forwarded-Port": "443",
          "X-Forwarded-For": "203.0.113.7, 198.51.100.9, 66.241.125.187",
        },
      });
      expect(denied.status).toBe(403);

      const missingAuthority = await fetch(`${baseUrl}/api/admin/probe`, {
        headers: { "X-Forwarded-For": "203.0.113.7, 66.241.125.187" },
      });
      expect(missingAuthority.status).toBe(403);

      const admitted = await fetch(`${baseUrl}/api/admin/probe`, {
        headers: {
          "Fly-Client-IP": "203.0.113.7",
          "Fly-Forwarded-Port": "443",
          "X-Forwarded-For": "198.51.100.9, 66.241.125.187",
        },
      });
      expect(admitted.status).toBe(200);

      process.env.ADMIN_IP_ALLOWLIST = "2001:db8::1";
      const admittedIpv6 = await fetch(`${baseUrl}/api/admin/probe`, {
        headers: {
          "Fly-Client-IP": "2001:0DB8:0:0:0:0:0:1",
          "Fly-Forwarded-Port": "443",
          "X-Forwarded-For": "not-an-ip, 2a09:8280:1::106:3eba:0",
        },
      });
      expect(admittedIpv6.status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("wires every protected Admin and Super Admin limiter to the shared authority", () => {
    const files = [
      "server/index.ts",
      "server/routes/auth.ts",
      "server/command-centre/routes.ts",
      "server/routes/admin/catalogue.ts",
      "server/routes/admin/project-control.ts",
      "server/routes.ts",
      "server/partner/admin-routes.ts",
      "server/partner/connector-admin-routes.ts",
      "server/partner/dashboard-routes.ts",
      "server/partner/flag-admin-routes.ts",
      "server/partner/partner-management-routes.ts",
      "server/routes/admin/commercial-growth.ts",
      "server/routes/growth-mcp.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).toContain("keyGenerator: adminClientIpRateLimitKey");
    }
  });

  it("cannot evade the Admin limiter by rotating forged forwarded headers", async () => {
    process.env.FLY_APP_NAME = "mintvault-v2";
    delete process.env.ADMIN_IP_ALLOWLIST;
    const limiter = rateLimit({
      windowMs: 60_000,
      max: 2,
      validate: false,
      legacyHeaders: false,
      keyGenerator: adminClientIpRateLimitKey,
    });
    const application = express();
    application.use(modelFlyProxyPeer, adminIpAllowlist, limiter);
    application.get("/api/admin/probe", (_req, res) => res.json({ ok: true }));
    const { baseUrl, server } = await listen(application);
    try {
      const status = async (clientIp: string, forgedIp: string): Promise<number> =>
        (
          await fetch(`${baseUrl}/api/admin/probe`, {
            headers: {
              "Fly-Client-IP": clientIp,
              "Fly-Forwarded-Port": "443",
              Forwarded: `for=${forgedIp}`,
              "X-Forwarded-For": `${forgedIp}, 66.241.125.187`,
              "X-Real-IP": forgedIp,
            },
          })
        ).status;

      expect(await status("198.51.100.9", "203.0.113.1")).toBe(200);
      expect(await status("198.51.100.9", "203.0.113.2")).toBe(200);
      expect(await status("198.51.100.9", "203.0.113.3")).toBe(429);
      expect(await status("198.51.100.10", "203.0.113.3")).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("preserves direct/local allowlist behavior without trusting forwarded headers", async () => {
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_MACHINE_ID;
    process.env.ADMIN_IP_ALLOWLIST = "127.0.0.1";
    const application = express();
    application.use(adminIpAllowlist);
    application.get("/api/admin/probe", (_req, res) => res.json({ ok: true }));
    const { baseUrl, server } = await listen(application);
    try {
      const response = await fetch(`${baseUrl}/api/admin/probe`, {
        headers: { "X-Forwarded-For": "203.0.113.7" },
      });
      expect(response.status).toBe(200);
    } finally {
      await close(server);
    }
  });
});
