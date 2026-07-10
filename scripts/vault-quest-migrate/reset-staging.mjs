/**
 * Phase 2 · rollback helper — reset the NEW Vault Quest STAGING database so a
 * rehearsal can be redone from scratch.
 *
 * Drops the 12 vq_ tables from VAULT_QUEST_DATABASE_URL only. It NEVER touches the
 * shared source DB (MINTVAULT_DATABASE_URL) — the current shared staging data is
 * always left intact, so "rollback to shared staging" is simply: stop pointing
 * Vault Quest at the new staging resources.
 *
 * Heavily guarded: refuses the grading production host, and requires BOTH
 * --commit AND the literal flag --yes-drop-staging.
 *
 *   VAULT_QUEST_DATABASE_URL=... node scripts/vault-quest-migrate/reset-staging.mjs --commit --yes-drop-staging
 */
import { VQ_TABLES, connect, requireEnv, assertNotGradingProd, hostOf, isCommit, hasFlag } from "./lib.mjs";

const DEST = requireEnv("VAULT_QUEST_DATABASE_URL");
assertNotGradingProd(DEST, "reset target");
const confirmed = isCommit() && hasFlag("--yes-drop-staging");

console.log(`[reset-staging] target host=${hostOf(DEST)}  mode=${confirmed ? "DROP (confirmed)" : "DRY-RUN"}`);
if (!confirmed) {
  console.log(`[reset-staging] DRY-RUN — would DROP these tables from the NEW staging DB:`);
  for (const t of VQ_TABLES) console.log(`  DROP TABLE IF EXISTS public."${t}" CASCADE;`);
  console.log(`[reset-staging] Re-run with --commit --yes-drop-staging to actually drop. Source DB is never touched.`);
  process.exit(0);
}

const client = await connect(DEST);
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL search_path = public");
  for (const t of VQ_TABLES) {
    await client.query(`DROP TABLE IF EXISTS public."${t}" CASCADE`);
    console.log(`  dropped ${t}`);
  }
  await client.query("COMMIT");
  console.log(`[reset-staging] DONE — new staging DB reset. Re-run apply-migrations + copy to redo.`);
} catch (err) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* ignore */
  }
  console.error(`[reset-staging] FAILED:`, err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
