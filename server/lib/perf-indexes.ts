import { db } from "../db";
import { sql } from "drizzle-orm";

/**
 * Non-grading hot-path performance indexes. Idempotent (IF NOT EXISTS), safe to
 * run on every boot, and touches NO grading logic — it only speeds up existing
 * queries. Phase 5 of the cleanup will fold all boot migrations into one
 * versioned system; this lives here in the meantime, clearly labelled.
 */
export async function ensurePerfIndexes(): Promise<void> {
  // The ubiquitous public/admin filter is
  //   WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at DESC
  // (population, dashboard, public lists, cert browser). A PARTIAL index over
  // only the non-deleted rows lets Postgres seek to a status and read rows
  // already in created_at order — instead of scanning the whole table and
  // sorting it in memory. Smaller + faster than a full composite index.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_certificates_active_scan
    ON certificates (status, created_at DESC)
    WHERE deleted_at IS NULL
  `);
}
