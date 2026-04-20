/**
 * scripts/run-marketplace-migration.ts
 *
 * Standalone migration runner for marketplace schema.
 * Captures before/after snapshots of existing tables to verify
 * the migration is safe and additive.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/run-marketplace-migration.ts
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../shared/schema";

const DATABASE_URL = process.env.MINTVAULT_DATABASE_URL;
if (!DATABASE_URL) {
  console.error("MINTVAULT_DATABASE_URL is not set");
  process.exit(1);
}

// Show which DB we're connecting to (mask password)
try {
  const parsed = new URL(DATABASE_URL);
  console.log(`\nConnecting to: ${parsed.hostname}${parsed.pathname}`);
} catch {
  console.log("\nConnecting to database (unable to parse URL)");
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const db = drizzle(pool, { schema });

async function countTable(tableName: string): Promise<number> {
  const result = await db.execute(sql.raw(`SELECT COUNT(*)::int AS c FROM ${tableName}`));
  return (result.rows[0] as any).c;
}

async function run() {
  // ── Pre-flight snapshot ─────────────────────────────────────────────────
  console.log("\n=== BEFORE MIGRATION ===");

  const existingTables = ["users", "certificates", "submissions", "audit_log"];
  const before: Record<string, number> = {};

  for (const table of existingTables) {
    before[table] = await countTable(table);
    console.log(`  ${table}: ${before[table]} rows`);
  }

  // ── Run migration ───────────────────────────────────────────────────────
  console.log("\n=== RUNNING MIGRATION ===");

  const { migrateMarketplaceSchema } = await import("../server/marketplace-schema");
  await migrateMarketplaceSchema();

  console.log("  Migration function returned successfully.");

  // ── Post-flight snapshot ────────────────────────────────────────────────
  console.log("\n=== AFTER MIGRATION ===");

  const after: Record<string, number> = {};
  for (const table of existingTables) {
    after[table] = await countTable(table);
    console.log(`  ${table}: ${after[table]} rows`);
  }

  const marketplaceTables = [
    "marketplace_listings",
    "marketplace_orders",
    "marketplace_offers",
    "marketplace_listing_images",
    "marketplace_order_events",
    "marketplace_shipments",
    "marketplace_conversations",
    "marketplace_messages",
    "marketplace_reviews",
    "marketplace_disputes",
    "marketplace_watchlist",
    "marketplace_dac7_quarterly",
  ];

  const marketplaceCounts: Record<string, number> = {};
  for (const table of marketplaceTables) {
    marketplaceCounts[table] = await countTable(table);
    console.log(`  ${table}: ${marketplaceCounts[table]} rows`);
  }

  // ── Verification ────────────────────────────────────────────────────────
  console.log("\n=== VERIFICATION ===");

  console.log("\nExisting table row counts unchanged:");
  let allExistingOk = true;
  for (const table of existingTables) {
    const ok = before[table] === after[table];
    if (!ok) allExistingOk = false;
    console.log(`  ${ok ? "✅" : "❌"} ${table}: ${before[table]} → ${after[table]}`);
  }

  console.log("\nNew marketplace tables are empty (0 rows):");
  let allMarketplaceOk = true;
  for (const table of marketplaceTables) {
    const ok = marketplaceCounts[table] === 0;
    if (!ok) allMarketplaceOk = false;
    console.log(`  ${ok ? "✅" : "❌"} ${table}: ${marketplaceCounts[table]}`);
  }

  // ── Verify seller columns on users ──────────────────────────────────────
  console.log("\nSeller columns on users table:");
  const sellerCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'users'
      AND (column_name LIKE 'seller_%' OR column_name = 'stripe_connect_account_id')
    ORDER BY column_name
  `);
  for (const row of sellerCols.rows as any[]) {
    console.log(`  ✅ ${row.column_name}`);
  }
  const expectedSellerCols = [
    "seller_business_number", "seller_charges_enabled", "seller_date_of_birth",
    "seller_default_from_postcode", "seller_display_name", "seller_is_business",
    "seller_kyc_completed_at", "seller_kyc_requirements_json", "seller_legal_name",
    "seller_nino_or_tin_encrypted", "seller_onboarded_at", "seller_payouts_enabled",
    "seller_rating_average", "seller_rating_count", "seller_status",
    "seller_total_sales", "seller_vat_number", "stripe_connect_account_id",
  ];
  const foundCols = (sellerCols.rows as any[]).map((r: any) => r.column_name);
  const missingCols = expectedSellerCols.filter(c => !foundCols.includes(c));
  if (missingCols.length > 0) {
    console.log(`  ❌ Missing columns: ${missingCols.join(", ")}`);
    allExistingOk = false;
  }

  // ── Verify current_listing_id on certificates ───────────────────────────
  console.log("\ncurrent_listing_id on certificates table:");
  const listingCol = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'certificates'
      AND column_name = 'current_listing_id'
  `);
  if (listingCol.rows.length > 0) {
    console.log("  ✅ current_listing_id exists");
  } else {
    console.log("  ❌ current_listing_id NOT FOUND");
    allExistingOk = false;
  }

  // ── Final result ────────────────────────────────────────────────────────
  console.log("\n=== RESULT ===");
  if (allExistingOk && allMarketplaceOk) {
    console.log("✅ Migration completed successfully. All checks passed.\n");
  } else {
    console.log("❌ Migration completed but some checks failed. Review above.\n");
    process.exit(1);
  }
}

run()
  .catch((err) => {
    console.error("\n❌ MIGRATION FAILED:", err);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
