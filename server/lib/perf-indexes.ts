import { db } from "../db";
import { sql } from "drizzle-orm";

/**
 * Non-grading hot-path performance indexes. Idempotent, safe to run every boot,
 * touches NO grading logic — only speeds up existing queries. CONCURRENTLY so it
 * never takes a blocking lock that could contend with the other boot-time
 * ALTER TABLE certificates migrations (the earlier plain CREATE INDEX failed at
 * boot for that reason). Runs after a delay from server/index-boot so the
 * schema migrations have settled first. Phase 5 will fold all boot migrations
 * into one versioned system.
 */
export async function ensurePerfIndexes(): Promise<void> {
  const indexes: { name: string; ddl: string }[] = [
    {
      // The ubiquitous "WHERE status='active' AND deleted_at IS NULL ORDER BY
      // created_at DESC" filter (public lists, population, cert browser, dashboard):
      // a PARTIAL index over only the non-deleted rows lets Postgres seek to a
      // status and read rows already in created_at order — no table scan + sort.
      // NB: the Drizzle field certificates.createdAt maps to the DB column
      // "issued_at" (not "created_at") — verified against the live schema.
      name: "idx_certificates_active_scan",
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_certificates_active_scan
            ON certificates (status, issued_at DESC) WHERE deleted_at IS NULL`,
    },
  ];
  for (const idx of indexes) {
    try {
      await db.execute(sql.raw(idx.ddl));
      console.log(`[perf-indexes] ${idx.name} ensured`);
    } catch (e: any) {
      // Surface the REAL Postgres reason (drizzle's e.message is just the SQL).
      const reason = e?.cause?.message ?? e?.message;
      const code = e?.cause?.code ?? e?.code;
      console.error(`[perf-indexes] ${idx.name} failed: ${reason} (code ${code})`);
    }
  }
}
