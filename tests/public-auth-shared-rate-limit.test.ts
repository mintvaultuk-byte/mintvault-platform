import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import {
  createPublicAuthRateLimit,
  PUBLIC_AUTH_RATE_LIMIT_MAX,
  PUBLIC_AUTH_RATE_LIMIT_WINDOW_MS,
} from "../server/lib/public-auth-rate-limit";
import { PostgresFixedWindowRateLimitStore } from "../server/lib/public-auth-rate-limit-store-pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let poolA: pg.Pool;
let poolB: pg.Pool;
const servers: Server[] = [];

async function mount(pool: pg.Pool, prefix: string): Promise<string> {
  const app = express();
  app.set("trust proxy", 1);
  app.post(
    "/api/auth/login",
    createPublicAuthRateLimit(new PostgresFixedWindowRateLimitStore(pool, PUBLIC_AUTH_RATE_LIMIT_WINDOW_MS, prefix)),
    (_req, res) => res.status(401).json({ error: "invalid" })
  );
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(503).json({ error: "unavailable" });
  });
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

beforeAll(async () => {
  cluster = await startPostgres17("public-auth-shared-rate-limit");
  poolA = new pg.Pool({ connectionString: cluster.url, max: 5 });
  poolB = new pg.Pool({ connectionString: cluster.url, max: 5 });
  const migration = listMigrationFiles().find(
    (candidate) => candidate.filename === "0121_main_runtime_role_authority.sql"
  );
  if (!migration) throw new Error("0121 main runtime authority migration missing");
  await applyMigrations(poolA, [migration]);
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all([poolA?.end(), poolB?.end()]);
  await cluster?.stop();
});

describe("fleet-wide public auth rate limiting", () => {
  it("shares one spoof-resistant budget across Machines and process replacement", async () => {
    const prefix = "public:test_auth_mail:";
    const first = await mount(poolA, prefix);
    const second = await mount(poolB, prefix);
    const trustedClient = "203.0.113.71";

    for (let hit = 0; hit < PUBLIC_AUTH_RATE_LIMIT_MAX; hit++) {
      const machine = hit % 2 === 0 ? first : second;
      expect(await attempt(machine, `198.51.100.${hit + 1}, ${trustedClient}`)).toBe(401);
    }

    // A newly constructed limiter (rolling restart) reads the existing row.
    const replacement = await mount(poolA, prefix);
    expect(await attempt(replacement, `192.0.2.200, ${trustedClient}`)).toBe(429);

    // A different route class has an independent quota and cannot be starved.
    const credential = await mount(poolB, "public:test_auth_credential:");
    expect(await attempt(credential, trustedClient)).toBe(401);
  });

  it("increments one atomic counter under concurrent requests from both Machines", async () => {
    const prefix = "public:test_auth_concurrent:";
    const first = await mount(poolA, prefix);
    const second = await mount(poolB, prefix);
    const client = "203.0.113.99";
    const statuses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => attempt(index % 2 === 0 ? first : second, client))
    );

    expect(statuses.filter((status) => status === 401)).toHaveLength(PUBLIC_AUTH_RATE_LIMIT_MAX);
    expect(statuses.filter((status) => status === 429)).toHaveLength(12 - PUBLIC_AUTH_RATE_LIMIT_MAX);
    expect(
      (
        await poolA.query<{ hit_count: number }>(
          `SELECT hit_count FROM public.public_rate_limit_buckets WHERE bucket_key=$1`,
          [`${prefix}${client}`]
        )
      ).rows[0].hit_count
    ).toBe(12);
  });

  it("prunes expired attacker-controlled buckets in a bounded opportunistic sweep", async () => {
    await poolA.query(
      `INSERT INTO public.public_rate_limit_buckets(bucket_key,hit_count,reset_at)
       SELECT 'expired:' || n, 1, now() - interval '1 minute' FROM generate_series(1, 12) n`
    );
    const store = new PostgresFixedWindowRateLimitStore(poolA, 60_000, "public:test_sweep:");
    await store.increment("203.0.113.120");
    expect(
      (
        await poolA.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM public.public_rate_limit_buckets WHERE bucket_key LIKE 'expired:%'`
        )
      ).rows[0].count
    ).toBe("0");
  });
});
