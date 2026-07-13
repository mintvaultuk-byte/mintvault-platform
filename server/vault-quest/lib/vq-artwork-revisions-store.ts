/**
 * Durable, atomic artwork-revision lifecycle (Phase 10A-6, R5-F1/F2). Wires the
 * already-built, already-unit-tested Phase 7D substrate (key builder + integrity
 * verify in ./vq-artwork-versioning.ts, the `vq_artwork_revisions` ledger with its
 * partial-unique "at most one active row per entity/slot" index) into real
 * approve/promote sites.
 *
 * Replaces overwrite-in-place (`uploadToR2(deterministicKey, ...)`, which
 * destroys the prior image irrecoverably the instant a re-approval happens) with:
 *   1. Upload the new bytes to an IMMUTABLE, never-reused key (uuid-suffixed).
 *      If this throws, NOTHING below runs — the previous active artwork and its
 *      DB pointer are completely untouched.
 *   2. ONE database transaction: deactivate the current active revision (if any),
 *      insert the new revision as active, flip the entity's own pointer column to
 *      the new key, and append audit events — all four together or none of them.
 *      A concurrent promotion racing on the same (entityType, entityId, slot) can
 *      only have one winner: the DB's partial-unique index on `is_active=true`
 *      makes the loser's INSERT fail (23505), which rolls back its ENTIRE
 *      transaction (including its own pointer-column update), so the loser's
 *      attempt leaves no trace beyond an orphaned R2 object (harmless — the
 *      reconciler (10A-7) already detects unreferenced `vq/` objects).
 *
 * Legacy fallback: an entity created before revision support simply has no row
 * in `vq_artwork_revisions` yet; its pointer column already holds the old flat
 * deterministic key exactly as before, and every reader here (and the fixed
 * fetchArt in render-saved.ts) reads that column's CURRENT VALUE regardless of
 * whether it's a legacy flat key or a new immutable revisioned key. No special
 * casing needed — "read whatever the pointer column says" is correct for both.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { uploadToR2, getR2Buffer } from "../../r2";
import { vqArtworkRevisions, vqArtworkRevisionEvents, type VqArtworkRevision } from "@shared/vq-artwork-schema";
import { vqCards, vqCharacters, vqCharacterRevisions, type VqCharacter } from "@shared/vq-schema";
import { referencePackMergeJson } from "./write-sanitize";
import { buildApprovedRevisionKey, sha256Hex, verifyIntegrity, type VqRevisionEntityType } from "./vq-artwork-versioning";

// The callback parameter type db.transaction() actually passes — narrower than
// `typeof db` (lacks $client), so a plain `typeof db` annotation on a shared
// helper that must work both as `db` and as `tx` doesn't typecheck. This is the
// standard drizzle-orm node-postgres transaction-argument shape.
type VqTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const isUniqueViolation = (err: unknown): boolean => {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && e; i++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
};

/**
 * Shared ledger-swap step, run INSIDE the caller's transaction: deactivate
 * whatever is currently active for (entityType, entityId, slot), insert the new
 * row as active, and log both transitions. Throws (aborting the whole tx) on a
 * lost concurrent race — the partial-unique index is the real guarantor.
 */
async function swapActiveRevision(
  tx: VqTx,
  input: {
    entityType: VqRevisionEntityType;
    entityId: string;
    slot: string;
    r2Key: string;
    sha256: string;
    byteSize: number;
    mime: string;
    width: number | null;
    height: number | null;
    sourceCandidateId: number | null;
    createdBy: string | null;
  },
): Promise<{ revision: VqArtworkRevision; previous: VqArtworkRevision | null }> {
  const [previous] = await tx
    .select()
    .from(vqArtworkRevisions)
    .where(and(eq(vqArtworkRevisions.entityType, input.entityType), eq(vqArtworkRevisions.entityId, input.entityId), eq(vqArtworkRevisions.slot, input.slot), eq(vqArtworkRevisions.isActive, true)))
    .limit(1);

  if (previous) {
    await tx.update(vqArtworkRevisions).set({ isActive: false, archivedAt: new Date() }).where(eq(vqArtworkRevisions.id, previous.id));
    await tx.insert(vqArtworkRevisionEvents).values({
      revisionId: previous.id, entityType: input.entityType, entityId: input.entityId, slot: input.slot,
      action: "deactivated", actor: input.createdBy, note: "superseded by a new revision",
    });
  }

  let revision: VqArtworkRevision;
  try {
    [revision] = await tx
      .insert(vqArtworkRevisions)
      .values({
        entityType: input.entityType, entityId: input.entityId, slot: input.slot, r2Key: input.r2Key,
        sha256: input.sha256, byteSize: input.byteSize, mime: input.mime, width: input.width, height: input.height,
        sourceCandidateId: input.sourceCandidateId, createdBy: input.createdBy, isActive: true,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error("a concurrent promotion just activated a different revision for this slot — refresh and retry");
    }
    throw err;
  }
  await tx.insert(vqArtworkRevisionEvents).values({
    revisionId: revision.id, entityType: input.entityType, entityId: input.entityId, slot: input.slot,
    action: "created", actor: input.createdBy,
  });
  await tx.insert(vqArtworkRevisionEvents).values({
    revisionId: revision.id, entityType: input.entityType, entityId: input.entityId, slot: input.slot,
    action: "activated", actor: input.createdBy,
  });
  return { revision, previous: previous ?? null };
}

export interface PromoteResult {
  revision: VqArtworkRevision;
  previousKey: string | null;
  r2Key: string;
}

/** Promote a new card-art revision for `slot` (main/prev) — atomic upload+ledger+pointer. */
export async function promoteCardArtRevision(input: {
  cardId: string;
  slot: "main" | "prev";
  buffer: Buffer;
  width?: number | null;
  height?: number | null;
  sourceCandidateId?: number | null;
  createdBy?: string | null;
}): Promise<PromoteResult> {
  const revisionUuid = randomUUID();
  const r2Key = buildApprovedRevisionKey("card", input.cardId, input.slot, revisionUuid);
  const sha256 = sha256Hex(input.buffer);
  await uploadToR2(r2Key, input.buffer, "image/png"); // throws → nothing below runs; prior art untouched

  return db.transaction(async (tx) => {
    const { revision, previous } = await swapActiveRevision(tx, {
      entityType: "card", entityId: input.cardId, slot: input.slot, r2Key, sha256, byteSize: input.buffer.length,
      mime: "image/png", width: input.width ?? null, height: input.height ?? null,
      sourceCandidateId: input.sourceCandidateId ?? null, createdBy: input.createdBy ?? null,
    });
    await tx
      .update(vqCards)
      .set(input.slot === "main" ? { artR2Key: r2Key } : { prevArtR2Key: r2Key })
      .where(eq(vqCards.cardId, input.cardId));
    return { revision, previousKey: previous?.r2Key ?? null, r2Key };
  });
}

export interface PromoteCharacterResult extends PromoteResult {
  character: VqCharacter;
}

/**
 * Promote a new character-reference revision for `referenceType` — atomic
 * upload+ledger+pointer, replicating setCharacterReferencePack's exact side
 * effects (character-revision audit row + JSONB pack merge + the master_portrait
 * legacy mirror) inside the SAME transaction so the ledger and the entity's own
 * pointer can never diverge.
 */
export async function promoteCharacterReferenceRevision(input: {
  characterId: string;
  referenceType: string;
  buffer: Buffer;
  width?: number | null;
  height?: number | null;
  sourceCandidateId?: number | null;
  identityScore?: number | null;
  createdBy?: string | null;
}): Promise<PromoteCharacterResult> {
  const revisionUuid = randomUUID();
  const r2Key = buildApprovedRevisionKey("character", input.characterId, input.referenceType, revisionUuid);
  const sha256 = sha256Hex(input.buffer);
  await uploadToR2(r2Key, input.buffer, "image/png"); // throws → nothing below runs; prior art untouched

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(vqCharacters).where(eq(vqCharacters.characterId, input.characterId)).limit(1);
    if (!existing) throw new Error("character not found");

    const { revision, previous } = await swapActiveRevision(tx, {
      entityType: "character", entityId: input.characterId, slot: input.referenceType, r2Key, sha256,
      byteSize: input.buffer.length, mime: "image/png", width: input.width ?? null, height: input.height ?? null,
      sourceCandidateId: input.sourceCandidateId ?? null, createdBy: input.createdBy ?? null,
    });

    await tx.insert(vqCharacterRevisions).values({
      characterId: input.characterId,
      revisionJson: existing as unknown as Record<string, unknown>,
      editedBy: input.createdBy ?? undefined,
      reason: `reference pack: ${input.referenceType} approved (revision ${revision.id})`,
    });
    // ATOMIC top-level jsonb merge (same expression as vqStorage.setCharacterReferencePack)
    // — approve only ever sets ONE reference-type key, so a concurrent approval of a
    // DIFFERENT type can't clobber this slot; sibling keys survive the `||` shallow merge.
    const slotJson = referencePackMergeJson(input.referenceType, r2Key, input.sourceCandidateId ?? null, input.identityScore, new Date().toISOString());
    const mergeExpr = sql`coalesce(${vqCharacters.referencePack}, '{}'::jsonb) || ${slotJson}::jsonb`;
    const [updated] = await tx
      .update(vqCharacters)
      .set(
        input.referenceType === "master_portrait"
          ? { referencePack: mergeExpr, referenceArtworkR2Key: r2Key, approvedArtworkR2Key: r2Key, approvalStatus: "artwork_approved", updatedAt: new Date() }
          : { referencePack: mergeExpr, updatedAt: new Date() },
      )
      .where(eq(vqCharacters.characterId, input.characterId))
      .returning();
    if (!updated) throw new Error("reference pack update failed");
    return { revision, previousKey: previous?.r2Key ?? null, r2Key, character: updated };
  });
}

/** Full revision history for an entity/slot, newest first — for a founder-facing history view. */
export async function listRevisionHistory(entityType: VqRevisionEntityType, entityId: string, slot: string): Promise<VqArtworkRevision[]> {
  return db
    .select()
    .from(vqArtworkRevisions)
    .where(and(eq(vqArtworkRevisions.entityType, entityType), eq(vqArtworkRevisions.entityId, entityId), eq(vqArtworkRevisions.slot, slot)))
    .orderBy(desc(vqArtworkRevisions.createdAt));
}

/**
 * The ledger's own idea of the active key for (entity, slot) — a fallback source
 * of truth for the rare window where a direct-upload route created a revision
 * before the entity's own row existed yet (a brand-new card uploading art before
 * its first Save). `null` when there is no revision (legacy record, or nothing
 * uploaded yet) — callers fall back further to the entity's own column.
 */
export async function getActiveRevisionKey(entityType: VqRevisionEntityType, entityId: string, slot: string): Promise<string | null> {
  const [row] = await db
    .select({ r2Key: vqArtworkRevisions.r2Key })
    .from(vqArtworkRevisions)
    .where(and(eq(vqArtworkRevisions.entityType, entityType), eq(vqArtworkRevisions.entityId, entityId), eq(vqArtworkRevisions.slot, slot), eq(vqArtworkRevisions.isActive, true)))
    .limit(1);
  return row?.r2Key ?? null;
}

export type RestoreOutcome =
  | { ok: true; revision: VqArtworkRevision; previousKey: string | null }
  | { ok: false; reason: "not_found" | "asset_missing" | "integrity_mismatch" };

/**
 * Roll back to a previous (currently inactive) revision — a RECOVERY action, not
 * a new upload. Fetches the target's bytes from R2 and hash-verifies them BEFORE
 * touching anything; a missing or corrupted asset fails safely (current active
 * pointer untouched, ok:false). On success, the swap + entity-pointer update run
 * in the SAME transaction as the create path, so the same atomicity/concurrency
 * guarantees apply.
 */
export async function restoreArtworkRevision(revisionId: number, restoredBy?: string | null): Promise<RestoreOutcome> {
  const [target] = await db.select().from(vqArtworkRevisions).where(eq(vqArtworkRevisions.id, revisionId)).limit(1);
  if (!target) return { ok: false, reason: "not_found" };

  const buf = await getR2Buffer(target.r2Key);
  if (!buf) return { ok: false, reason: "asset_missing" };
  const verify = verifyIntegrity(buf, { sha256: target.sha256, byteSize: target.byteSize });
  if (!verify.ok) return { ok: false, reason: "integrity_mismatch" };

  if (target.isActive) return { ok: true, revision: target, previousKey: target.r2Key }; // already active — no-op success

  const result = await db.transaction(async (tx) => {
    const [currentActive] = await tx
      .select()
      .from(vqArtworkRevisions)
      .where(and(eq(vqArtworkRevisions.entityType, target.entityType), eq(vqArtworkRevisions.entityId, target.entityId), eq(vqArtworkRevisions.slot, target.slot), eq(vqArtworkRevisions.isActive, true)))
      .limit(1);
    if (currentActive) {
      await tx.update(vqArtworkRevisions).set({ isActive: false, archivedAt: new Date() }).where(eq(vqArtworkRevisions.id, currentActive.id));
      await tx.insert(vqArtworkRevisionEvents).values({
        revisionId: currentActive.id, entityType: target.entityType, entityId: target.entityId, slot: target.slot,
        action: "deactivated", actor: restoredBy, note: `superseded by restoring revision ${target.id}`,
      });
    }
    let reactivated: VqArtworkRevision;
    try {
      [reactivated] = await tx.update(vqArtworkRevisions).set({ isActive: true, archivedAt: null }).where(eq(vqArtworkRevisions.id, target.id)).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error("a concurrent promotion just activated a different revision — refresh and retry");
      throw err;
    }
    await tx.insert(vqArtworkRevisionEvents).values({
      revisionId: target.id, entityType: target.entityType, entityId: target.entityId, slot: target.slot,
      action: "restored", actor: restoredBy, note: `rolled back from revision ${currentActive?.id ?? "none"}`,
    });

    if (target.entityType === "card") {
      await tx.update(vqCards).set(target.slot === "main" ? { artR2Key: target.r2Key } : { prevArtR2Key: target.r2Key }).where(eq(vqCards.cardId, target.entityId));
    } else {
      const slotJson = referencePackMergeJson(target.slot, target.r2Key, null, null, new Date().toISOString());
      const mergeExpr = sql`coalesce(${vqCharacters.referencePack}, '{}'::jsonb) || ${slotJson}::jsonb`;
      await tx
        .update(vqCharacters)
        .set(
          target.slot === "master_portrait"
            ? { referencePack: mergeExpr, referenceArtworkR2Key: target.r2Key, approvedArtworkR2Key: target.r2Key, updatedAt: new Date() }
            : { referencePack: mergeExpr, updatedAt: new Date() },
        )
        .where(eq(vqCharacters.characterId, target.entityId));
    }
    return reactivated;
  });
  return { ok: true, revision: result, previousKey: target.r2Key };
}
