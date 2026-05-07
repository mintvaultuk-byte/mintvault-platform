/**
 * scripts/run-rag-phase-0-migration.ts
 *
 * Phase 0 of the RAG retrieval workstream — pure infrastructure. Enables
 * the pgvector extension on the shared Neon DB and adds two columns to
 * the certificates table:
 *
 *   - embedding   vector(1536)  (nullable; populated by hourly cron)
 *   - embedded_at timestamptz   (null = not yet embedded; non-null = ts of last embed)
 *
 * Idempotent — every statement uses IF NOT EXISTS. Re-runs are safe.
 *
 * NOTE: drizzle-kit's interactive resolver blocks db:push in non-TTY
 * shells, so we follow the established pattern of applying additive
 * migrations as raw SQL (see scripts/run-ai-dashboard-migration.ts).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/run-rag-phase-0-migration.ts
 *
 * Status: PENDING APPROVAL — do not run without explicit go-ahead.
 */

import pg from "pg";

const DATABASE_URL = process.env.MINTVAULT_DATABASE_URL;
if (!DATABASE_URL) {
  console.error("MINTVAULT_DATABASE_URL is not set");
  process.exit(1);
}

try {
  const parsed = new URL(DATABASE_URL);
  console.log(`[migration] target host=${parsed.hostname} db=${parsed.pathname.slice(1)}`);
} catch {
  /* ignore */
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("[migration] enabling pgvector extension...");
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    console.log("[migration] adding certificates.embedding (vector 1536, nullable)...");
    await client.query(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS embedding vector(1536)`);

    console.log("[migration] adding certificates.embedded_at (timestamptz, nullable)...");
    await client.query(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ`);

    await client.query("COMMIT");
    console.log("[migration] COMMIT — pgvector enabled, columns added.");

    const checks = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM pg_extension WHERE extname = 'vector')::int AS has_vector_ext,
        (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_name = 'certificates' AND column_name = 'embedding')::int AS has_embedding,
        (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_name = 'certificates' AND column_name = 'embedded_at')::int AS has_embedded_at,
        (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version
    `);
    console.log("[migration] verification:", checks.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[migration] FAILED:", err.message);
    await pool.end();
    process.exit(1);
  });
