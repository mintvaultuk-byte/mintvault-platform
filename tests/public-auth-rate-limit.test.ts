import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { MemoryStore } from "express-rate-limit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicAuthRateLimit,
  PUBLIC_AUTH_RATE_LIMIT_MAX,
  publicAuthRateLimitKey,
} from "../server/lib/public-auth-rate-limit";

const servers: Server[] = [];

async function mount(): Promise<string> {
  const app = express();
  app.set("trust proxy", 1);
  app.post("/api/auth/login", createPublicAuthRateLimit(new MemoryStore()), (_req, res) =>
    res.status(401).json({ error: "invalid" })
  );
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function attempt(base: string, forwardedFor: string): Promise<number> {
  return (
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "x-forwarded-for": forwardedFor },
    })
  ).status;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("public account auth rate-limit client identity", () => {
  it("uses the trusted hop instead of attacker-prepended X-Forwarded-For entries", async () => {
    const base = await mount();
    const trustedClient = "203.0.113.41";

    for (let attemptNumber = 0; attemptNumber < PUBLIC_AUTH_RATE_LIMIT_MAX; attemptNumber++) {
      const forgedPrefix = `198.51.100.${attemptNumber + 1}`;
      expect(await attempt(base, `${forgedPrefix}, ${trustedClient}`)).toBe(401);
    }

    expect(await attempt(base, `192.0.2.200, ${trustedClient}`)).toBe(429);
    expect(await attempt(base, "192.0.2.200, 203.0.113.42")).toBe(401);
  });

  it("collapses rotating IPv6 addresses inside one /56 without merging adjacent /56s", async () => {
    const base = await mount();

    for (let attemptNumber = 0; attemptNumber < PUBLIC_AUTH_RATE_LIMIT_MAX; attemptNumber++) {
      const address = `2001:db8:abcd:12${attemptNumber.toString(16).padStart(2, "0")}::${attemptNumber + 1}`;
      expect(await attempt(base, address)).toBe(401);
    }

    expect(await attempt(base, "2001:db8:abcd:12ff::ffff")).toBe(429);
    expect(await attempt(base, "2001:db8:abcd:1300::1")).toBe(401);
  });

  it("falls back to one fail-safe key when no network address can be resolved", () => {
    const request = { ip: undefined, socket: { remoteAddress: undefined } };
    expect(publicAuthRateLimitKey(request as never)).toBe("public-auth-client-unresolved");
  });
});
