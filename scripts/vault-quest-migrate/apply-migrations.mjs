/**
 * Phase 2 · Step 1 — apply Vault Quest migrations to a CLEAN dedicated database.
 *
 * Applies migrations-vq/0000…0006 (whole-file, in order) to VAULT_QUEST_DATABASE_URL.
 * Each file runs in its own transaction with search_path=public. Migrations are
 * additive and idempotent (CREATE TABLE/COLUMN/INDEX IF NOT EXISTS), so re-running
 * is safe.
 *
 *   DRY-RUN (default): connects, runs each file inside a transaction, then ROLLBACK
 *                      — validates syntax/connectivity with ZERO persisted writes.
 *   --commit         : applies for real (per-file COMMIT).
 *
 * Target is the NEW Vault Quest DB only; refuses the grading production host.
 *
 *   VAULT_QUEST_DATABASE_URL=... node scripts/vault-quest-migrate/apply-migrations.mjs [--commit]
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, requireEnv, assertNotGradingProd, hostOf, isCommit } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(here, "..", "..", "migrations-vq");

const DEST = requireEnv("VAULT_QUEST_DATABASE_URL");
assertNotGradingProd(DEST, "DEST (migrations target)");
const commit = isCommit();

const files = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

console.log(`[apply-migrations] target host=${hostOf(DEST)} mode=${commit ? "COMMIT" : "DRY-RUN (rollback)"}`);
console.log(`[apply-migrations] ${files.length} migration files: ${files.join(", ")}`);

const client = await connect(DEST);
try {
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = public");
    await client.query(sql); // Postgres ignores `--` comments and `--> statement-breakpoint`
    if (commit) {
      await client.query("COMMIT");
      console.log(`  applied   ${f}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`  validated ${f} (rolled back)`);
    }
  }
  console.log(`[apply-migrations] ${commit ? "DONE — migrations applied." : "DRY-RUN OK — re-run with --commit to apply."}`);
} catch (err) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* ignore */
  }
  console.error(`[apply-migrations] FAILED:`, err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
