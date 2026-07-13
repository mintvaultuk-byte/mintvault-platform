/**
 * VQ orphan reconciliation — READ-ONLY, DRY-RUN ONLY (R3-CON-01, Phase 7E).
 *
 * Lists vq/ R2 objects + selects VQ DB rows (all read-only), diffs them via the
 * pure reconcile() logic, and prints counts + safe identifiers + JSON. It NEVER
 * writes or deletes anything. Deletion is a separate, owner-gated, unbuilt step.
 *
 *   npx tsx --env-file=.env scripts/vq-reconcile-orphans.ts [--set=GNV] \
 *     [--ttl=30d] [--min-age=7d] [--json] [--prod]
 *
 * Exit: 0 clean · 1 integrity failures · 2 usage/refusal · 3 runtime error.
 */
import { db } from "../server/db";
import { listR2Objects } from "../server/r2";
import { vqArtworkCandidates, vqCharacters, vqCards, vqArtworkRevisions } from "../shared/vq-schema";
import {
  reconcile,
  type ReconcilePackRef,
  type ReconcileCandidateRow,
  type ReconcileR2Object,
  type ReconcileRevisionRow,
} from "../server/vault-quest/lib/reconcile-logic";
import { checkR2Identity, r2IdentityMessage } from "../server/vault-quest/lib/r2-identity";
import { isUndefinedTableOrColumn } from "../server/vault-quest/production-storage";

function parseDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = /^(\d+)(d|h|m)$/.exec(s.trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  return n * (m[2] === "d" ? 86400000 : m[2] === "h" ? 3600000 : 60000);
}
function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  if (hasFlag("delete")) {
    console.error("REFUSED: deletion is not implemented in this tool. Detection only.");
    return 2;
  }
  const dbHost = (() => {
    try {
      return new URL(process.env.MINTVAULT_DATABASE_URL || "").hostname;
    } catch {
      return "unknown";
    }
  })();
  const isProd = /wispy-morning/.test(dbHost); // prod branch host fragment
  if (isProd && !hasFlag("prod")) {
    console.error(`REFUSED: target looks like PRODUCTION (${dbHost}). Re-run with --prod to inspect (read-only).`);
    return 2;
  }

  const setFilter = arg("set") || null;
  const ttlMs = parseDuration(arg("ttl"), 30 * 86400000);
  const minAgeMs = parseDuration(arg("min-age"), 0);
  const nowMs = Date.now();

  // R2 IDENTITY GUARD (Phase 10A): a staging DB does NOT imply staging R2. Refuse to
  // list R2 unless the operator names the expected bucket via --r2=<bucket> and it
  // matches R2_BUCKET_NAME. Fail-closed; never prints credentials/signed URLs.
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

  // R2: every vq/ object (read-only, paged, with metadata).
  const rawObjects = await listR2Objects("vq/");
  const objects: ReconcileR2Object[] = rawObjects.map((o) => ({
    key: o.key,
    sizeBytes: o.sizeBytes,
    lastModifiedMs: o.lastModified ? o.lastModified.getTime() : null,
  }));

  // DB: candidates, characters (pack + approved keys), cards (art keys) — all read.
  const candRows = await db.select().from(vqArtworkCandidates);
  const charRows = await db.select().from(vqCharacters);
  const cardRows = await db.select().from(vqCards);

  const candidates: ReconcileCandidateRow[] = candRows
    .filter((c) => !setFilter || (c.cardId ?? c.characterId ?? "").startsWith(setFilter))
    .map((c) => ({
      id: c.id,
      r2Key: c.r2Key,
      status: c.status,
      characterId: c.characterId ?? null,
      cardId: c.cardId ?? null,
      referenceType: c.referenceType ?? null,
      updatedAtMs: c.updatedAt ? new Date(c.updatedAt).getTime() : nowMs,
    }));

  const referencedKeys = new Set<string>();
  const packRefs: ReconcilePackRef[] = [];
  for (const ch of charRows) {
    if (ch.approvedArtworkR2Key) referencedKeys.add(ch.approvedArtworkR2Key);
    if (ch.referenceArtworkR2Key) referencedKeys.add(ch.referenceArtworkR2Key);
    const pack = (ch.referencePack ?? {}) as Record<string, { r2Key?: string; candidateId?: number | null } | null>;
    for (const [referenceType, slot] of Object.entries(pack)) {
      if (!slot) continue;
      if (slot.r2Key) referencedKeys.add(slot.r2Key);
      packRefs.push({
        characterId: ch.characterId,
        referenceType,
        candidateId: slot.candidateId ?? null,
        r2Key: slot.r2Key ?? null,
      });
    }
  }
  for (const cd of cardRows) {
    for (const k of [cd.artR2Key, cd.prevArtR2Key, cd.renderR2Key]) if (k) referencedKeys.add(k);
  }

  // vq_artwork_revisions (Phase 10A-6) — degrades to undefined on an unmigrated DB
  // (42P01), in which case reconcile() simply skips the backup/active-object checks
  // and every other check still runs.
  let revisions: ReconcileRevisionRow[] | undefined;
  try {
    const revRows = await db.select().from(vqArtworkRevisions);
    revisions = revRows
      .filter((r) => !setFilter || r.entityId.startsWith(setFilter))
      .map((r) => ({
        id: r.id,
        entityType: r.entityType,
        entityId: r.entityId,
        slot: r.slot,
        r2Key: r.r2Key,
        isActive: r.isActive,
        backupState: r.backupState,
      }));
  } catch (err) {
    if (!isUndefinedTableOrColumn(err)) throw err;
    revisions = undefined;
  }

  const report = reconcile({
    candidates,
    objects,
    referencedKeys,
    packRefs,
    revisions,
    nowMs,
    retentionTtlMs: ttlMs,
    minAgeMs,
  });

  const out = {
    mode: "dry-run",
    db: { hostRedacted: dbHost },
    filters: { setCode: setFilter, ttlMs, minAgeMs },
    counts: report.counts,
    classCounts: report.classCounts,
    integrityFailures: report.integrityFailures,
    safeOrphanCount: report.safeOrphanCount,
    notes: report.notes,
    findings: report.findings,
  };

  if (hasFlag("json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`[vq-reconcile] host=${dbHost} objects=${objects.length} candidates=${candidates.length}`);
    console.log(`  classes: ${JSON.stringify(report.classCounts)}`);
    console.log(`  safe-orphans=${report.safeOrphanCount}  integrity-failures=${report.integrityFailures}`);
    for (const n of report.notes) console.log(`  note: ${n}`);
  }

  return report.integrityFailures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[vq-reconcile] error:", e instanceof Error ? e.message : e);
    process.exit(3);
  });
