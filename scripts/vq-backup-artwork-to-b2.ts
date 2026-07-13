/**
 * VQ approved-artwork B2 cold-backup — CLI (Phase 10A-8, R5-F4).
 *
 * NET-NEW, isolated from server/workers/r2-to-b2-archival.ts (the grading/cert
 * worker) — shares only the generic B2/R2 clients, no business logic. Every
 * key this touches is asserted via assertVqBackupKey (approved VQ artwork
 * only; never a cert/grading object, never a churn/candidate key).
 *
 * DRY RUN BY DEFAULT. Nothing is uploaded to B2 or written to the DB unless
 * --live is passed. Not wired into any automatic cron/sweep — manual
 * invocation only, pending owner approval to schedule it.
 *
 *   npx tsx --env-file=.env scripts/vq-backup-artwork-to-b2.ts \
 *     [--live] [--retry-failed] [--batch=50] [--retention-days=90] \
 *     --r2=<bucket> [--prod] [--json]
 *
 * Exit: 0 clean · 1 some rows failed/mismatched/rejected · 2 usage/refusal · 3 runtime error.
 */
import { backupVqArtworkRevisions } from "../server/vault-quest/lib/vq-b2-backup";
import { checkR2Identity, r2IdentityMessage } from "../server/vault-quest/lib/r2-identity";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const dbHost = (() => {
    try {
      return new URL(process.env.MINTVAULT_DATABASE_URL || "").hostname;
    } catch {
      return "unknown";
    }
  })();
  const isProd = /wispy-morning/.test(dbHost); // prod branch host fragment
  if (isProd && !hasFlag("prod")) {
    console.error(`REFUSED: target looks like PRODUCTION (${dbHost}). Re-run with --prod to proceed.`);
    return 2;
  }

  // R2 IDENTITY GUARD (same pattern as vq-reconcile-orphans.ts): a staging DB
  // does NOT imply staging R2. Refuse to read R2 unless the operator names
  // the expected bucket and it matches R2_BUCKET_NAME.
  const r2id = checkR2Identity({
    expectedBucket: arg("r2"),
    actualBucket: process.env.R2_BUCKET_NAME,
    actualEndpoint: process.env.R2_ENDPOINT,
  });
  if (!r2id.ok) {
    console.error(r2IdentityMessage(r2id));
    return 2;
  }
  console.error(r2IdentityMessage(r2id));

  if (!process.env.B2_ENDPOINT || !process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !process.env.B2_BUCKET) {
    console.error(
      "REFUSED: B2 credentials/bucket not fully configured (B2_ENDPOINT, B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET)."
    );
    return 2;
  }

  const live = hasFlag("live");
  const batchSize = Number(arg("batch") || 50);
  const retentionDays = Number(arg("retention-days") || 90);
  const retryFailed = hasFlag("retry-failed");

  if (!live)
    console.error(
      "DRY RUN — pass --live to actually copy to B2 and update backup_state. Nothing will be written this run."
    );

  const summary = await backupVqArtworkRevisions({ dryRun: !live, batchSize, retryFailed, retentionDays });

  if (hasFlag("json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[vq-b2-backup] host=${dbHost} candidates=${summary.candidates} copied=${summary.copied} ` +
        `skipped=${summary.skippedAlreadyInB2} mismatches=${summary.integrityMismatches} ` +
        `rejected=${summary.guardRejected} failed=${summary.failed} ` +
        `bytes=${(summary.bytesCopied / 1024 / 1024).toFixed(2)}MB${summary.dryRun ? " (DRY RUN)" : ""}`
    );
  }

  return summary.failed > 0 || summary.integrityMismatches > 0 || summary.guardRejected > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[vq-b2-backup] error:", e instanceof Error ? e.message : e);
    process.exit(3);
  });
