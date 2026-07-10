/**
 * Fail-closed smoke test for the dedicated Vault Quest clients (Phase 1).
 *
 * Proves, with NO database/network/R2 access, that:
 *  - the modules import cleanly with NO VAULT_QUEST_* vars set (so the MintVault
 *    app boots normally),
 *  - Vault Quest DB / R2 / B2 FAIL CLOSED when their vars are absent,
 *  - Vault Quest NEVER falls back to the grading vars (MINTVAULT_DATABASE_URL /
 *    R2_BUCKET_NAME) even when those ARE present,
 *  - the assertVqWriteKey write-prefix guard is preserved.
 *
 * Run: npx tsx scripts/vault-quest-migrate/smoke-fail-closed.ts
 */

// Guarantee the "unconfigured" condition regardless of the caller's shell.
for (const k of Object.keys(process.env)) if (k.startsWith("VAULT_QUEST_")) delete process.env[k];

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "  — " + extra : ""}`);
  }
}
async function throws(name: string, fn: () => unknown, matcher: RegExp) {
  try {
    await fn();
    ok(name, false, "did not throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(name, matcher.test(msg), `message was: ${msg.slice(0, 120)}`);
  }
}

const config = await import("../../server/config.ts");
const vqdb = await import("../../server/vault-quest/db.ts");
const vqr2 = await import("../../server/vault-quest/vq-r2.ts");
const vqb2 = await import("../../server/vault-quest/vq-b2.ts");
const rs = await import("../../server/vault-quest/render-saved.ts");

console.log("\n[1] modules import without VAULT_QUEST_* (MintVault app boots):");
ok("config, db, vq-r2, vq-b2, render-saved all imported", !!(config && vqdb && vqr2 && vqb2 && rs));

console.log("\n[2] config probes report not-configured WITHOUT throwing:");
ok("vaultQuestDbConfigured() === false", vqdb.vaultQuestDbConfigured() === false);
ok("vaultQuestR2Configured() === false", vqr2.vaultQuestR2Configured() === false);
ok("vaultQuestB2Configured() === false", vqb2.vaultQuestB2Configured() === false);

console.log("\n[3] Vault Quest fails CLOSED when its vars are absent:");
await throws("getVaultQuestDatabaseUrl() throws fail-closed", () => config.getVaultQuestDatabaseUrl(), /VAULT_QUEST_DATABASE_URL/);
await throws("DB proxy access fails closed", () => (vqdb.db as unknown as Record<string, unknown>).select, /VAULT_QUEST_DATABASE_URL/);
await throws("getVqR2Buffer() fails closed", () => vqr2.getVqR2Buffer("vq/art/x/main.png"), /VAULT_QUEST_R2/);
await throws("uploadToVqR2() fails closed", () => vqr2.uploadToVqR2("vq/art/x/main.png", Buffer.from("x"), "image/png"), /VAULT_QUEST_R2/);
await throws("uploadToVqB2() fails closed", () => vqb2.uploadToVqB2("db/x.dump", Buffer.from("x"), "application/octet-stream"), /VAULT_QUEST_B2/);

console.log("\n[4] fail-closed message mentions no-fallback intent:");
try {
  config.getVaultQuestDatabaseUrl();
} catch (e) {
  ok("error states it never falls back to grading DB", /never falls back/i.test((e as Error).message));
}

console.log("\n[5] assertVqWriteKey write-prefix guard preserved:");
await throws("blocks grading key images/…", () => vqr2.assertVqWriteKey("images/MV1/front.jpg"), /outside Vault Quest prefixes/);
await throws("blocks label key labels/…", () => vqr2.assertVqWriteKey("labels/MV1/front.png"), /outside Vault Quest prefixes/);
ok("allows vq/art/ key", vqr2.assertVqWriteKey("vq/art/GNV-001/main.png") === "vq/art/GNV-001/main.png");
ok(
  "VQ_WRITE_PREFIXES unchanged",
  JSON.stringify(vqr2.VQ_WRITE_PREFIXES) === JSON.stringify(["vq/art-candidates/", "vq/art/", "vq/characters/"]),
);
ok("render-saved re-exports assertVqWriteKey", typeof rs.assertVqWriteKey === "function");

console.log("\n[6] NO FALLBACK to grading vars even when they ARE present:");
process.env.MINTVAULT_DATABASE_URL = "postgres://grading-should-not-be-used/none";
process.env.R2_BUCKET_NAME = "grading-bucket-should-not-be-used";
process.env.R2_ENDPOINT = "https://grading-should-not-be-used";
process.env.R2_ACCESS_KEY_ID = "grading";
process.env.R2_SECRET_ACCESS_KEY = "grading";
await throws("DB still fails closed despite MINTVAULT_DATABASE_URL set", () => config.getVaultQuestDatabaseUrl(), /VAULT_QUEST_DATABASE_URL/);
await throws("R2 bucket still fails closed despite R2_BUCKET_NAME set", () => vqr2.getVqR2Bucket(), /VAULT_QUEST_R2_BUCKET/);
await throws("R2 client still fails closed despite R2_* set", () => vqr2.getVqR2Client(), /VAULT_QUEST_R2_ENDPOINT/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
