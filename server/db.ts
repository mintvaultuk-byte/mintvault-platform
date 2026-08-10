import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { databaseSslConfig, getDatabaseUrl } from "./config";

const DATABASE_URL = getDatabaseUrl();

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: databaseSslConfig(DATABASE_URL),
  max: 8,
  // 30s gives Neon's autosuspend cold-start (typically 1–5s, occasionally
  // longer under load) enough headroom that a warm-up doesn't surface as
  // a user-visible "DB connection timeout". A keep-warm SELECT 1 runs
  // every ~4 minutes from server/index.ts to keep compute hot during
  // active hours; this timeout is the safety net for the rare cold path.
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

pool.on("error", (err) => {
  console.error("[pg-pool] idle client error (evicted):", err.message);
});

export const db = drizzle(pool, { schema });
