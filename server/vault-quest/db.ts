/**
 * Vault Quest dedicated database client.
 *
 * Vault Quest reads VAULT_QUEST_DATABASE_URL ONLY. It NEVER falls back to the
 * MintVault grading database (MINTVAULT_DATABASE_URL). If the variable is unset
 * the client fails CLOSED — the first Vault Quest query throws a clear error and
 * Vault Quest routes surface "not configured", while the MintVault app itself
 * still boots normally (this module never connects at import time; the pool is
 * built lazily on first query).
 *
 * Sessions / admin login stay on the MintVault database (server/db.ts). This
 * client is for vq_ tables only.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as vqSchema from "@shared/vq-schema";
import { getVaultQuestDatabaseUrl } from "../config";

let vqPool: pg.Pool | null = null;
let vqDb: NodePgDatabase<typeof vqSchema> | null = null;

/** True when VAULT_QUEST_DATABASE_URL is present — lets routes check config without connecting. */
export function vaultQuestDbConfigured(): boolean {
  return !!process.env.VAULT_QUEST_DATABASE_URL;
}

/** The dedicated Vault Quest pg pool (built lazily on first use; never at import). */
export function getVqPool(): pg.Pool {
  if (vqPool) return vqPool;
  const url = getVaultQuestDatabaseUrl(); // throws a clear fail-closed error if unset
  vqPool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 8,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    keepAlive: true,
  });
  vqPool.on("error", (err) => {
    console.error("[vq-pg-pool] idle client error (evicted):", err.message);
  });
  return vqPool;
}

function realDb(): NodePgDatabase<typeof vqSchema> {
  if (vqDb) return vqDb;
  vqDb = drizzle(getVqPool(), { schema: vqSchema });
  return vqDb;
}

/**
 * Lazy Drizzle handle for the Vault Quest database. Importing this binding does
 * NOT connect — the pool is created on the FIRST query. A missing
 * VAULT_QUEST_DATABASE_URL therefore fails closed on Vault Quest routes only;
 * the MintVault app boots regardless. Storage code uses this exactly like the
 * old shared `db` (`db.select().from(...)`, `db.transaction(...)`).
 */
export const db: NodePgDatabase<typeof vqSchema> = new Proxy(
  {} as NodePgDatabase<typeof vqSchema>,
  {
    get(_target, prop) {
      const real = realDb() as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
  },
);
