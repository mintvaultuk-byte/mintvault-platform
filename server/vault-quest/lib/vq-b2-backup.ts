/**
 * Vault Quest — R2→B2 cold-backup worker for approved artwork revisions
 * (Phase 10A-8, R5-F4).
 *
 * NET-NEW, hard-isolated from server/workers/r2-to-b2-archival.ts (the
 * grading/certificate cold-archive worker). Shares nothing with it beyond the
 * generic S3-compatible clients (server/r2.ts, server/b2.ts) — no shared
 * business logic, no shared query, no shared prefix. Every key this worker
 * ever reads from R2 or writes to B2 is asserted via assertVqBackupKey
 * (server/vault-quest/lib/vq-artwork-versioning.ts), which accepts ONLY
 * `vq/characters/{id}/approved/...` and `vq/art/{cardId}/...` keys and rejects
 * candidates, grading/cert prefixes, and traversal — so this worker can never
 * read or copy a customer certificate image, by construction, not convention.
 *
 * Scope: backs up `vq_artwork_revisions` rows whose backup_state is 'pending'
 * (or 'failed', when retryFailed is set — a manual retry, not automatic) to
 * the B2 cold-archive bucket, matching the cert worker's Object Lock
 * Compliance retention. Idempotent at the object level (existsInB2
 * short-circuits a re-run). Copy-only — the R2 original is never touched or
 * deleted. A row's backup_state is the only thing this worker ever mutates;
 * it never touches is_active, r2_key, or any entity pointer column.
 *
 * Integrity: before upload, the downloaded bytes are hash-verified against the
 * revision's own recorded sha256/byte_size (the same verifyIntegrity used by
 * restoreArtworkRevision). A mismatch marks backup_state='failed' and refuses
 * to upload — better to have no backup than to silently archive corrupt bytes
 * under a good-looking 'archived' state.
 *
 * NOT wired into any automatic cron/sweep (unlike the cert worker, which runs
 * on a live timer in server/index.ts) — this stays a manually-invoked CLI tool
 * (scripts/vq-backup-artwork-to-b2.ts) until the owner approves scheduling it.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { getR2Buffer } from "../../r2";
import { uploadToB2, existsInB2 } from "../../b2";
import { vqArtworkRevisions } from "@shared/vq-artwork-schema";
import { assertVqBackupKey, verifyIntegrity } from "./vq-artwork-versioning";

export interface VqBackupOpts {
  dryRun: boolean;
  batchSize: number;
  retryFailed?: boolean;
  retentionDays?: number;
}

export interface VqBackupSummary {
  candidates: number;
  copied: number;
  skippedAlreadyInB2: number;
  integrityMismatches: number;
  guardRejected: number;
  failed: number;
  bytesCopied: number;
  dryRun: boolean;
}

/**
 * Back up pending (and optionally failed) revisions from R2 to B2. Each row is
 * handled independently — one row's failure never blocks the rest of the
 * batch, and never touches any other row's backup_state.
 */
export async function backupVqArtworkRevisions(opts: VqBackupOpts): Promise<VqBackupSummary> {
  const { dryRun, batchSize, retryFailed = false, retentionDays = 90 } = opts;
  const summary: VqBackupSummary = {
    candidates: 0,
    copied: 0,
    skippedAlreadyInB2: 0,
    integrityMismatches: 0,
    guardRejected: 0,
    failed: 0,
    bytesCopied: 0,
    dryRun,
  };

  const states: string[] = retryFailed ? ["pending", "failed"] : ["pending"];
  const rows = await db
    .select()
    .from(vqArtworkRevisions)
    .where(inArray(vqArtworkRevisions.backupState, states))
    .limit(batchSize);
  summary.candidates = rows.length;

  for (const row of rows) {
    try {
      assertVqBackupKey(row.r2Key); // hard isolation boundary — throws on anything not VQ approved-artwork
    } catch (err) {
      summary.guardRejected++;
      console.warn(
        `[vq-b2-backup] revision=${row.id}: REJECTED by assertVqBackupKey — refusing to touch this key: ${(err as Error).message}`
      );
      continue; // never write backup_state for a key that fails the guard — this is a bug to fix, not a state to persist
    }

    if (dryRun) {
      summary.copied++; // "would evaluate/copy"
      summary.bytesCopied += row.byteSize;
      console.log(
        `[vq-b2-backup] WOULD evaluate revision=${row.id} key=${row.r2Key} (${(row.byteSize / 1024).toFixed(0)} KB)`
      );
      continue;
    }

    try {
      const alreadyThere = await existsInB2(row.r2Key);
      if (alreadyThere) {
        summary.skippedAlreadyInB2++;
        if (row.backupState !== "archived") {
          await db.update(vqArtworkRevisions).set({ backupState: "archived" }).where(eq(vqArtworkRevisions.id, row.id));
        }
        continue;
      }

      const buf = await getR2Buffer(row.r2Key);
      if (!buf) throw new Error("R2 object missing");
      const verify = verifyIntegrity(buf, { sha256: row.sha256, byteSize: row.byteSize });
      if (!verify.ok) {
        summary.integrityMismatches++;
        await db.update(vqArtworkRevisions).set({ backupState: "failed" }).where(eq(vqArtworkRevisions.id, row.id));
        console.warn(
          `[vq-b2-backup] revision=${row.id}: integrity mismatch (expected sha256 ${row.sha256.slice(0, 12)}…, got ${verify.actualSha.slice(0, 12)}…) — refusing to back up possibly-corrupt bytes`
        );
        continue;
      }

      await uploadToB2(row.r2Key, buf, row.mime, retentionDays);
      await db.update(vqArtworkRevisions).set({ backupState: "archived" }).where(eq(vqArtworkRevisions.id, row.id));
      summary.copied++;
      summary.bytesCopied += buf.length;
    } catch (err) {
      summary.failed++;
      await db
        .update(vqArtworkRevisions)
        .set({ backupState: "failed" })
        .where(eq(vqArtworkRevisions.id, row.id))
        .catch(() => {});
      console.warn(`[vq-b2-backup] revision=${row.id}: backup failed: ${(err as Error).message}`);
    }
  }

  return summary;
}
