/**
 * Phase 8A — apply VQ migrations 0008–0011 to STAGING ONLY. Idempotent
 * (CREATE ... IF NOT EXISTS). Refuses any non-staging host. VQ-only tables.
 *   npx tsx --env-file=.env scripts/phase8/apply-migrations.ts
 * Rollback: DROP TABLE IF EXISTS <table>;  (each table is FK-free / isolated)
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../../server/db";
import { sql } from "drizzle-orm";

const STAGING_FRAGMENT = "ep-purple-voice";
const PROD_FRAGMENT = "ep-wispy-morning";
const FILES = ["0008_export_jobs.sql", "0009_generation_requests.sql", "0010_artwork_revisions.sql", "0011_feature_flags.sql"];

function host(): string {
  try { return new URL(process.env.MINTVAULT_DATABASE_URL || "").hostname; } catch { return "unknown"; }
}

async function main(): Promise<number> {
  const h = host();
  if (h.includes(PROD_FRAGMENT) || !h.includes(STAGING_FRAGMENT)) {
    console.error(`ABORT: host is not the known staging branch (${h}).`);
    return 2;
  }
  console.log(`Applying to STAGING (${h})\n`);
  const dir = path.resolve(process.cwd(), "migrations-vq");
  for (const file of FILES) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const statements = raw
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.replace(/^\s*--.*$/gm, "").trim()) // strip comment-only lines
      .filter((s) => s.length > 0);
    console.log(`── ${file} (${statements.length} statements)`);
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
      const first = stmt.split("\n")[0].slice(0, 70);
      console.log(`   ok: ${first}…`);
    }
  }
  console.log("\nApply complete.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => {
  console.error("apply error:", e instanceof Error ? e.message : e);
  process.exit(3);
});
