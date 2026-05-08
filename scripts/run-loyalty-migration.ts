/**
 * scripts/run-loyalty-migration.ts
 *
 * Loyalty scaffold migration — additive. Creates two tables, two indexes,
 * and one view:
 *
 *   loyalty_ledger        — append-only points ledger
 *   loyalty_redemptions   — redemption records (paired to a ledger row)
 *   loyalty_balance VIEW  — non-expired SUM(delta) per user
 *
 * SAFETY: refuses to run against the prod DB endpoint
 * (ep-wispy-morning-ab6f4o08). Applies cleanly against the staging
 * branch (ep-purple-voice-abfez796). Always prints the SQL it would
 * run before executing — paste into Neon's SQL editor manually for prod
 * after legal review of the loyalty programme T&Cs.
 *
 * Idempotent — every statement uses IF NOT EXISTS / OR REPLACE. Re-runs
 * are safe.
 *
 * Usage (apply against staging):
 *   MINTVAULT_DATABASE_URL=<staging-branch-url> \
 *     npx tsx --env-file=.env scripts/run-loyalty-migration.ts
 *
 * Usage (print SQL only, no apply):
 *   PRINT_ONLY=true npx tsx scripts/run-loyalty-migration.ts
 */

import pg from "pg";

const PROD_HOST_HINT    = "ep-wispy-morning";
const STAGING_HOST_HINT = "ep-purple-voice";

const SQL_STATEMENTS: { label: string; sql: string }[] = [
  {
    label: "loyalty_ledger table",
    sql: `
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  source_type TEXT,
  source_id   VARCHAR,
  metadata    JSONB DEFAULT '{}'::jsonb,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
    `.trim(),
  },
  {
    label: "loyalty_ledger user/created index",
    sql: `
CREATE INDEX IF NOT EXISTS loyalty_ledger_user_created_idx
  ON loyalty_ledger (user_id, created_at DESC);
    `.trim(),
  },
  {
    label: "loyalty_ledger source idempotency partial UNIQUE",
    sql: `
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_ledger_source_idem_uniq
  ON loyalty_ledger (user_id, source_type, source_id, reason)
  WHERE source_id IS NOT NULL;
    `.trim(),
  },
  {
    label: "loyalty_redemptions table",
    sql: `
CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR NOT NULL,
  submission_id VARCHAR,
  points_spent  INTEGER NOT NULL,
  tier          TEXT NOT NULL,
  ledger_id     VARCHAR NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
    `.trim(),
  },
  {
    label: "loyalty_balance view",
    sql: `
CREATE OR REPLACE VIEW loyalty_balance AS
SELECT user_id, COALESCE(SUM(delta), 0)::int AS balance
FROM loyalty_ledger
WHERE expires_at IS NULL OR expires_at > NOW()
GROUP BY user_id;
    `.trim(),
  },
];

const VERIFY_SQL = `
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name = 'loyalty_ledger')::int       AS has_ledger,
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name = 'loyalty_redemptions')::int  AS has_redemptions,
  (SELECT COUNT(*) FROM information_schema.views
     WHERE table_name = 'loyalty_balance')::int      AS has_view,
  (SELECT COUNT(*) FROM pg_indexes
     WHERE indexname = 'loyalty_ledger_source_idem_uniq')::int AS has_uniq_idx,
  (SELECT COUNT(*) FROM pg_indexes
     WHERE indexname = 'loyalty_ledger_user_created_idx')::int AS has_time_idx
`;

function printSql(): void {
  console.log("");
  console.log("───────────────────────────────────────────────────────────");
  console.log("Loyalty scaffold migration SQL (paste into Neon SQL editor)");
  console.log("───────────────────────────────────────────────────────────");
  for (const s of SQL_STATEMENTS) {
    console.log(`-- ${s.label}`);
    console.log(s.sql);
    console.log("");
  }
  console.log("-- Verification query (run after the above)");
  console.log(VERIFY_SQL);
  console.log("───────────────────────────────────────────────────────────");
  console.log("");
}

async function applyMigration(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of SQL_STATEMENTS) {
      console.log(`[migration] ${s.label}…`);
      await client.query(s.sql);
    }
    await client.query("COMMIT");
    console.log("[migration] COMMIT — schema applied.");
    const verify = await client.query(VERIFY_SQL);
    console.log("[migration] verification:", verify.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

(async () => {
  printSql();

  if (process.env.PRINT_ONLY === "true") {
    console.log("[migration] PRINT_ONLY=true — exiting without applying.");
    process.exit(0);
  }

  const url = process.env.MINTVAULT_DATABASE_URL;
  if (!url) {
    console.error("[migration] MINTVAULT_DATABASE_URL not set — printing SQL only and exiting.");
    process.exit(0);
  }

  let host = "";
  try { host = new URL(url).hostname; } catch { /* ignore */ }

  if (host.includes(PROD_HOST_HINT)) {
    console.error("");
    console.error("[migration] ✗ REFUSING to apply against prod (" + host + ").");
    console.error("[migration]   Per the spec: 'DO NOT apply migration to prod.'");
    console.error("[migration]   Paste the SQL above into Neon's prod SQL editor manually");
    console.error("[migration]   after legal sign-off of the loyalty programme T&Cs.");
    process.exit(1);
  }

  if (!host.includes(STAGING_HOST_HINT)) {
    console.error("");
    console.error("[migration] ⚠ DATABASE_URL does not point at the expected staging branch");
    console.error("[migration]   (expected hostname to contain '" + STAGING_HOST_HINT + "', got '" + host + "').");
    console.error("[migration]   Refusing to apply to an unknown DB. Either:");
    console.error("[migration]     1) point MINTVAULT_DATABASE_URL at the staging Neon branch URL, OR");
    console.error("[migration]     2) run with PRINT_ONLY=true and paste the SQL manually into Neon");
    process.exit(1);
  }

  console.log(`[migration] target host=${host} — applying…`);
  try {
    await applyMigration(url);
    console.log("[migration] done.");
    process.exit(0);
  } catch (err: any) {
    console.error("[migration] FAILED:", err.message);
    process.exit(1);
  }
})();
