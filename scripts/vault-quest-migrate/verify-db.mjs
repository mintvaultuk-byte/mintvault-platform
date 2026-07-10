/**
 * Phase 2 · Step 3 — verify the DB copy: ordered row counts + per-table checksums.
 *
 *   SOURCE: MINTVAULT_DATABASE_URL    DEST: VAULT_QUEST_DATABASE_URL
 *
 * For each of the 12 vq_ tables, compares row count AND an order-independent
 * content checksum (md5 over string_agg of every row, needs no PK). PASS only when
 * BOTH match. Read-only on both sides.
 *
 *   MINTVAULT_DATABASE_URL=... VAULT_QUEST_DATABASE_URL=... \
 *     node scripts/vault-quest-migrate/verify-db.mjs
 */
import { VQ_TABLES, connect, requireEnv, hostOf, tableFingerprint } from "./lib.mjs";

const SOURCE = requireEnv("MINTVAULT_DATABASE_URL");
const DEST = requireEnv("VAULT_QUEST_DATABASE_URL");

console.log(`[verify-db] SOURCE host=${hostOf(SOURCE)}  DEST host=${hostOf(DEST)}`);

const src = await connect(SOURCE, { readOnly: true });
const dest = await connect(DEST, { readOnly: true });

let allPass = true;
try {
  console.log(`  table                       source            dest              count  checksum`);
  for (const t of VQ_TABLES) {
    const s = await tableFingerprint(src, t);
    const d = await tableFingerprint(dest, t);
    const countOk = s.n === d.n;
    const hashOk = s.h === d.h;
    const pass = countOk && hashOk;
    allPass = allPass && pass;
    console.log(
      `  ${t.padEnd(26)} n=${String(s.n).padEnd(6)}${s.h.slice(0, 8)}  n=${String(d.n).padEnd(6)}${d.h.slice(0, 8)}  ${countOk ? "✓" : "✗"}      ${hashOk ? "✓" : "✗"}  ${pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(`[verify-db] ${allPass ? "ALL TABLES MATCH ✓" : "MISMATCH ✗ — do NOT cut over"}`);
  process.exitCode = allPass ? 0 : 1;
} catch (err) {
  console.error(`[verify-db] FAILED:`, err.message);
  process.exitCode = 1;
} finally {
  await src.end();
  await dest.end();
}
