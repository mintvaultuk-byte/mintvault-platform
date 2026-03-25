import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { getDatabaseUrl } from "./config";

const DATABASE_URL = getDatabaseUrl();

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });
