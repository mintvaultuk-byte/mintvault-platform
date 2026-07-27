/**
 * certificate-image-persistence.ts — the durable half of
 * `POST /api/admin/certificates/:id/upload-images`.
 *
 * WHY THIS MODULE EXISTS (M-2, hostile review of PR #260)
 * That route is the one the real grading UI uploads through. It wrote
 * `front_image_path`, `back_image_path`, every `grading_*` capture column,
 * `image_quality_checks` and `crop_geometry` through a series of INDEPENDENT
 * auto-committing raw UPDATEs and wrote ZERO audit rows: a customer's card
 * images could be replaced with no record of who did it, and a failure partway
 * through left the row half-updated.
 *
 * The persistence step is separated from the image PIPELINE (deskew, crop,
 * mask, variants, quality) so it can be driven against a real PostgreSQL
 * cluster in tests without running sharp — the pipeline is untouched by this
 * change, and the transaction/audit/compensation behaviour is what needs proof.
 *
 * WHAT IS AND IS NOT ATOMIC — stated plainly, because the honest model matters:
 *   • Postgres side: the column UPDATE and its audit row commit in ONE
 *     transaction. Both or neither. An audit failure rolls the write back.
 *   • Object storage: R2 CANNOT join that transaction. Objects are written
 *     first, the database commits second. A database failure therefore triggers
 *     best-effort compensation, NOT a rollback.
 *   • An object whose key was already the committed value has already had its
 *     BYTES overwritten by the time we get here. No rollback can undo that.
 *     This module never deletes such an object (the last committed row still
 *     points at it) and reports the situation truthfully rather than claiming
 *     an atomicity that does not exist.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { deleteFromR2 } from "../r2";

/**
 * The EXHAUSTIVE set of certificate columns this route may commit.
 *
 * Hard-coded and never derived from request input: these names are interpolated
 * as SQL IDENTIFIERS, so anything reaching that position must be a literal from
 * this list. A value outside it is a programming error, not user input.
 */
export const IMAGE_UPLOAD_OWNED_COLUMNS = [
  "grading_front_original",
  "grading_front_cropped",
  "grading_front_display",
  "grading_back_original",
  "grading_back_cropped",
  "grading_back_display",
  "grading_angled_original",
  "grading_angled_cropped",
  "grading_closeup_original",
  "grading_closeup_cropped",
  "front_image_path",
  "back_image_path",
  // Display variants generated after the response (greyscale / high-contrast /
  // edge-enhanced / inverted). Written by the same route's background pass, so
  // they go through the same allowlist + audit rather than a bare UPDATE.
  "grading_front_greyscale",
  "grading_front_highcontrast",
  "grading_front_edgeenhanced",
  "grading_front_inverted",
  "grading_back_greyscale",
  "grading_back_highcontrast",
  "grading_back_edgeenhanced",
  "grading_back_inverted",
  "image_quality_checks",
  "crop_geometry",
] as const;

export const IMAGE_UPLOAD_COLUMN_SET: ReadonlySet<string> = new Set(IMAGE_UPLOAD_OWNED_COLUMNS);
/** Columns holding JSON documents — need a ::jsonb cast and structural compare. */
export const IMAGE_UPLOAD_JSONB_COLUMNS: ReadonlySet<string> = new Set(["image_quality_checks", "crop_geometry"]);

/** The audit action every successful image upload writes. */
export const IMAGE_UPLOAD_AUDIT_ACTION = "certificate_images_uploaded";
/** Background variant pass — distinguished so it cannot be mistaken for the
 *  operator-facing upload event above. */
export const IMAGE_VARIANTS_AUDIT_ACTION = "certificate_image_variants_generated";

/**
 * Column → Drizzle row property, for the columns shared/schema.ts actually
 * declares. Used only to decide whether an uploaded key was ALREADY the
 * committed value (compensation safety). A column absent here is treated as NOT
 * pre-existing, which fails SAFE for cleanup: `grading_*` capture keys are
 * per-certificate and are only ever written by this route, so deleting one after
 * a failed transaction cannot orphan a reference from the last committed row.
 * The two columns that the metadata route ALSO writes — front/back image path —
 * are both mapped, so a shared object is never mistaken for an orphan.
 */
export const COLUMN_TO_CERT_KEY: Record<string, string> = {
  front_image_path: "frontImagePath",
  back_image_path: "backImagePath",
};

export interface UploadedObject {
  key: string;
  column: string;
  sha256: string;
  bytes: number;
  contentType: string;
  /** True when this key was ALREADY the committed value for its column. */
  preexisting: boolean;
}

export interface ImageUploadPersistResult {
  committed: boolean;
  /** Columns whose stored value actually moved. Empty on a same-key replacement. */
  changedFields: string[];
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  /** Orphaned objects removed after a failed transaction. */
  orphansRemoved: string[];
  /** Orphans we tried and FAILED to remove — reported, never hidden. */
  orphanCleanupFailed: string[];
  /**
   * Objects whose bytes were overwritten in place and which we deliberately did
   * NOT delete during compensation, because the last committed row points at
   * them. Their previous CONTENT is unrecoverable — surfaced, not swallowed.
   */
  overwrittenCommittedObjects: string[];
}

const normVal = (v: unknown): string | null =>
  v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);

/**
 * Commit an image upload's column changes together with a truthful audit row.
 *
 * @param id        numeric certificates.id
 * @param certId    CANONICAL certificate id ("MV1"). Used as the audit
 *                  `entity_id`, matching the metadata route — this route used to
 *                  write nothing at all, and the grading route used to write the
 *                  numeric row id, so querying the trail by certificate ID
 *                  missed events. One convention now.
 * @param updates   column → value, filtered against the allowlist here.
 * @param uploadedObjects content identity for every object written to R2.
 * @param actor     admin/staff email recorded as `admin_user`.
 */
export async function persistImageUploadAudited(args: {
  id: number;
  certId: string;
  updates: Record<string, string>;
  uploadedObjects: UploadedObject[];
  actor: string;
  /** Defaults to the operator-facing upload event. */
  action?: string;
}): Promise<ImageUploadPersistResult> {
  const { id, certId, updates, uploadedObjects, actor, action = IMAGE_UPLOAD_AUDIT_ACTION } = args;

  const committed: Array<[string, string]> = [];
  for (const [col, val] of Object.entries(updates)) {
    if (!IMAGE_UPLOAD_COLUMN_SET.has(col)) {
      // A column outside the allowlist is a construction bug. Dropped loudly
      // rather than interpolated into an identifier position.
      console.warn(`[upload-images] ignoring non-allowlisted column '${col}'`);
      continue;
    }
    committed.push([col, val]);
  }

  if (committed.length === 0) {
    return {
      committed: true,
      changedFields: [],
      changes: [],
      orphansRemoved: [],
      orphanCleanupFailed: [],
      overwrittenCommittedObjects: [],
    };
  }

  let changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  // The row as it stood BEFORE this transaction, captured for compensation.
  // Read inside the transaction (below) but needed in the catch, so it is held
  // here. Null means we never got far enough to know what was committed — in
  // which case compensation deletes NOTHING, which is the safe direction.
  let priorCommitted: Record<string, unknown> | null = null;

  try {
    await db.transaction(async (tx) => {
      // Lock the row and read the PRE-state of exactly the columns about to be
      // written. Read INSIDE the transaction rather than from a caller-supplied
      // Drizzle row, because several of these columns are real but undeclared in
      // shared/schema.ts — a Drizzle-selected row has no property for them, so a
      // diff built from it would be fabricated.
      const priorRes: any = await tx.execute(
        sql`SELECT ${sql.join(
          IMAGE_UPLOAD_OWNED_COLUMNS.map((c) => sql.raw(`"${c}"`)),
          sql`, `
        )} FROM certificates WHERE id = ${id} FOR UPDATE`
      );
      const prior = (priorRes.rows?.[0] ?? {}) as Record<string, unknown>;
      priorCommitted = prior;
      // A missing row must not produce an audit row claiming an upload landed.
      if (!priorRes.rows?.length) {
        throw new Error(`persistImageUploadAudited: certificate ${id} not found`);
      }

      changes = committed
        .filter(([col, val]) => normVal(prior[col]) !== normVal(val))
        .map(([col, val]) => ({ field: col, from: prior[col] ?? null, to: val }));

      await tx.execute(
        sql`UPDATE certificates SET ${sql.join(
          committed.map(([col, val]) =>
            IMAGE_UPLOAD_JSONB_COLUMNS.has(col)
              ? sql`${sql.raw(`"${col}"`)} = ${val}::jsonb`
              : sql`${sql.raw(`"${col}"`)} = ${val}`
          ),
          sql`, `
        )}, updated_at = NOW() WHERE id = ${id}`
      );

      // Audited whenever an object was uploaded, EVEN IF no column value moved:
      // these R2 keys are deterministic, so a re-upload replaces the object
      // while the stored path string stays identical. A path-only audit would
      // report "nothing happened" for a request that swapped a customer's card
      // image. Content identity below is what makes that provable.
      //
      // A request that uploaded nothing AND changed nothing writes no row.
      if (uploadedObjects.length === 0 && changes.length === 0) return;

      await tx.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES (
          'certificate',
          ${certId},
          ${action},
          ${actor},
          ${JSON.stringify({
            certificateId: id,
            certId,
            scope: "grading_image_upload",
            changes,
            changedFields: changes.map((c) => c.field),
            // Object KEYS only — never a signed URL, never a credential. The
            // keys are already stored in these columns.
            uploadedObjects: uploadedObjects.map((o) => ({
              key: o.key,
              column: o.column,
              sha256: o.sha256,
              bytes: o.bytes,
              contentType: o.contentType,
              // Stated explicitly rather than implied: when false the stored
              // path did NOT move and the object itself was overwritten.
              pathChanged: normVal(prior[o.column]) !== normVal(o.key),
            })),
            outcome: "committed",
          })}::jsonb,
          NOW()
        )
      `);
    });
  } catch (persistErr: any) {
    // ── COMPENSATION ────────────────────────────────────────────────────────
    // Nothing committed. Remove the objects this request CREATED; never remove
    // one the last committed row still points at.
    // HOSTILE SELF-REVIEW (HIGH, found and fixed before this PR was opened).
    // An earlier revision decided orphan-eligibility from the caller's
    // `preexisting` flag alone. That flag is derived from COLUMN_TO_CERT_KEY,
    // which only maps front/back image path — so EVERY deterministic
    // `grading/{certId}/{angle}_cropped.jpg` key came through as
    // preexisting:false. On the very common case of an operator RE-uploading an
    // angle, a failed transaction would then have deleted the grading object the
    // last committed row still points at, turning a recoverable failure into a
    // certificate with broken grading images.
    //
    // The authoritative test is the row we actually read under FOR UPDATE: an
    // object is an orphan ONLY if no committed column value equals its key. The
    // caller's flag is still honoured as an additional veto, never as the sole
    // permission.
    const committedKeys = new Set(
      priorCommitted
        ? Object.values(priorCommitted).filter((v): v is string => typeof v === "string" && v.length > 0)
        : []
    );
    // If we never read the prior row, we cannot prove anything is an orphan.
    const canProveOrphans = priorCommitted !== null;
    const isOrphan = (o: UploadedObject) => canProveOrphans && !o.preexisting && !committedKeys.has(o.key);
    const orphans = uploadedObjects.filter(isOrphan);
    const overwritten = uploadedObjects.filter((o) => !isOrphan(o)).map((o) => o.key);
    const orphansRemoved: string[] = [];
    const orphanCleanupFailed: string[] = [];
    for (const o of orphans) {
      try {
        await deleteFromR2(o.key);
        orphansRemoved.push(o.key);
      } catch (cleanupErr: any) {
        orphanCleanupFailed.push(o.key);
        console.error(`[upload-images] orphan cleanup FAILED for ${o.key}: ${cleanupErr?.message}`);
      }
    }
    console.error(
      `[upload-images] persist failed for cert=${id} (${persistErr?.message}); ` +
        `orphans_removed=${orphansRemoved.length} orphans_left=${orphanCleanupFailed.length} ` +
        `overwritten_committed_objects=${overwritten.length}`
    );
    return {
      committed: false,
      changedFields: [],
      changes: [],
      orphansRemoved,
      orphanCleanupFailed,
      overwrittenCommittedObjects: overwritten,
    };
  }

  return {
    committed: true,
    changedFields: changes.map((c) => c.field),
    changes,
    orphansRemoved: [],
    orphanCleanupFailed: [],
    overwrittenCommittedObjects: [],
  };
}
