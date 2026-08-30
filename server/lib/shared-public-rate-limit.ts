import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type pg from "pg";
import { PostgresFixedWindowRateLimitStore } from "./public-auth-rate-limit-store-pg";

export type SharedPublicRateLimitOptions = {
  namespace: string;
  windowMs: number;
  max: number;
  message: string;
};

/** Build a fleet-wide, fail-closed IP limiter backed by the main PostgreSQL authority. */
export function createSharedPublicRateLimit(pool: pg.Pool, options: SharedPublicRateLimitOptions) {
  if (!/^[a-z0-9_-]+$/.test(options.namespace)) throw new Error("invalid shared public limiter namespace");
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    passOnStoreError: false,
    store: new PostgresFixedWindowRateLimitStore(pool, options.windowMs, `public:${options.namespace}:`),
    keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket.remoteAddress || "public-client-unresolved", 56),
    message: { error: options.message },
  });
}
