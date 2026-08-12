/**
 * Scan-ingest service — shared business logic for creating certs from scanner uploads.
 *
 * Extracted from routes.ts handlers so both the existing admin endpoints
 * and the new scan-ingest endpoint can reuse the same code paths.
 */

import { db, pool } from "./db";
import { createHash } from "node:crypto";
import { hashLockKey } from "./lib/advisory-lock";
import { orientLide400Presentation } from "./lib/lide400-presentation";
import { CANON_LIDE_400_PROFILE } from "./lib/lide400-profile";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { uploadToR2, uploadImmutableEvidenceToR2, getR2Buffer, listR2Keys } from "./r2";
import {
  assertCompatibleEvidencePair,
  inspectScannerEvidence,
  type ScannerEvidenceInspection,
} from "./lib/image-evidence";
export { assertCompatibleEvidencePair, inspectScannerEvidence } from "./lib/image-evidence";
import {
  generateImageVariants,
  identifyCardFromBuffer,
  verifyAndEnrichCardData,
  verifyPokemonCardWithTcgApi,
  gradeCardFromBuffer,
  type EnrichedCardData,
  type AiGrading,
} from "./ai-grading-service";
import { CERTIFICATE_ORIGIN_SNAPSHOT_VERSION } from "@shared/schema";

/**
 * Build a server-log suffix exposing the Postgres SQLSTATE + detail behind a
 * failed query. Drizzle wraps the pg error, so its message is only
 * "Failed query: <sql>"; the code/detail live on the error or its `.cause`.
 * SERVER LOGS ONLY — never returned to clients. This is why tonight's exact
 * cause was unreadable: the catches logged only err.message.
 */
export function pgErrorDetail(err: any): string {
  const code = err?.code ?? err?.cause?.code;
  const detail = err?.detail ?? err?.cause?.detail;
  const routine = err?.routine ?? err?.cause?.routine;
  const parts: string[] = [];
  if (code) parts.push(`SQLSTATE=${code}`);
  if (detail) parts.push(`detail=${detail}`);
  if (routine) parts.push(`routine=${routine}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

/** Elapsed ms since a process.hrtime.bigint() mark. */
function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * Boot migration — scanner durability columns on `certificates`. Additive +
 * idempotent (safe on every startup; cert_counter idiom).
 *   raw_uploaded: false until the raw scans are CONFIRMED in R2 — the scanner's
 *     precondition for moving the inbox file (the core invariant).
 *   ingest_idempotency_key: content-derived, stable-across-retries key. Its
 *     UNIQUE index is the atomic gate that makes a re-driven/raced ingest
 *     resolve to the SAME cert instead of allocating a duplicate.
 */
export async function ensureCertDurabilitySchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE certificates
    ADD COLUMN IF NOT EXISTS raw_uploaded BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS ingest_idempotency_key TEXT`);
  // The unique index IS the concurrency gate (a check-then-insert would race —
  // the cert_counter lesson). NULLs are non-distinct in a Postgres unique index,
  // so legacy / non-idempotent rows (null key) never collide. Swallow the
  // catalog-race SQLSTATEs so two machines booting at once are safe.
  try {
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_ingest_idem ON certificates (ingest_idempotency_key)`
    );
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code !== "23505" && code !== "42710" && code !== "42P07") throw err;
  }
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
      SELECT 'schema', 'certificates', 'cert_durability_migrate', 'system_migration',
             ${JSON.stringify({ columns: ["raw_uploaded", "ingest_idempotency_key"], index: "uq_certificates_ingest_idem" })}::jsonb, NOW()
      WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'cert_durability_migrate')`);
  } catch (auditErr: any) {
    console.error("[cert-durability-migrate] audit insert failed:", auditErr?.message);
  }
  console.log("[cert-durability-migrate] certificates.raw_uploaded + ingest_idempotency_key + unique index ensured");
}

/**
 * Phase 58A additive evidence ledger. This deliberately has no numbered
 * migration: the active migration sequence is owned by the release lead and
 * must be reconciled before a numbered file is allocated. It mirrors the
 * project's existing idempotent boot-schema pattern and is safe on an empty or
 * live database; it never mutates historical certificate rows.
 */
export async function ensureImageEvidenceSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS certificate_image_evidence (
      id SERIAL PRIMARY KEY,
      certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
      side VARCHAR(5) NOT NULL CHECK (side IN ('front', 'back')),
      evidence_class VARCHAR(32) NOT NULL CHECK (evidence_class IN ('NEW_IMMUTABLE_MASTER', 'LEGACY_DERIVED_ONLY')),
      evidence_version VARCHAR(32) NOT NULL DEFAULT 'v1',
      object_key TEXT NOT NULL UNIQUE,
      sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      byte_length BIGINT NOT NULL CHECK (byte_length > 0),
      pixel_width INTEGER NOT NULL CHECK (pixel_width > 0),
      pixel_height INTEGER NOT NULL CHECK (pixel_height > 0),
      bit_depth INTEGER,
      dpi INTEGER,
      format VARCHAR(16) NOT NULL,
      capture_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      working_object_key TEXT,
      working_sha256 VARCHAR(64),
      working_width INTEGER,
      working_height INTEGER,
      working_format VARCHAR(16),
      working_settings JSONB,
      is_current BOOLEAN NOT NULL DEFAULT true,
      superseded_at TIMESTAMPTZ,
      superseded_by_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_certificate_image_evidence_superseded_by
        FOREIGN KEY (superseded_by_id) REFERENCES certificate_image_evidence(id) ON DELETE RESTRICT
    )
  `);
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS working_object_key TEXT`);
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS working_sha256 VARCHAR(64)`);
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS working_width INTEGER`);
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS working_height INTEGER`);
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS working_format VARCHAR(16)`);
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS working_settings JSONB`);
  await db.execute(
    sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true`
  );
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE certificate_image_evidence ADD COLUMN IF NOT EXISTS superseded_by_id INTEGER`);
  // v2 turns the prior single-master-side ledger into immutable revisions.
  // No rows are removed: the old uniqueness rule is replaced by a partial
  // uniqueness rule that permits history while retaining one current source.
  await db.execute(
    sql`ALTER TABLE certificate_image_evidence DROP CONSTRAINT IF EXISTS uq_certificate_image_evidence_side`
  );
  await db.execute(sql`DROP INDEX IF EXISTS uq_certificate_image_evidence_side`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_certificate_image_evidence_current_side
        ON certificate_image_evidence (certificate_id, side) WHERE is_current`
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_certificate_image_evidence_sha ON certificate_image_evidence (sha256)`
  );
}

/**
 * Idempotent, concurrency-safe cert creation for an admin scan.
 *
 * `idempotencyKey` is derived by the scanner from the scan CONTENT (front+back
 * SHA) and is STABLE across retries + process restarts — so a re-driven ingest
 * (crash recovery, or a retry racing the original) resolves to the SAME cert,
 * never a duplicate:
 *   1. fast path — a committed cert for this key exists → return it (no alloc).
 *   2. else, in ONE transaction, allocate a number + INSERT gated by the UNIQUE
 *      index (ON CONFLICT DO NOTHING). The index, not a check-then-insert, is
 *      the atomic primitive against concurrent same-key POSTs.
 *   3. lost the concurrent race (a sibling POST with the same key inserted
 *      first) → roll the transaction back, which RETURNS the allocated number
 *      to the sequence, then re-select the winner. NO second cert is created
 *      and NO integer is consumed. (This step previously left the number behind
 *      as a permanent gap in the MV sequence.)
 * A null key (interactive admin_ui ingest) skips the gate and always allocates —
 * NULLs don't collide in the unique index.
 */
/**
 * Phase 1 — resolve the scanning operator from the X-Scanner-Operator header.
 * The header carries the operator's EMAIL (configured per-Mac in the scanner env).
 * We validate it server-side against the users table and return the operator's
 * user id ONLY if they are a known, non-deleted operator (admin, or a staffer who
 * can scan/grade).
 *
 * SECURITY: never trust a client-supplied id. An absent / unknown / ineligible
 * header resolves to null (legacy fallback) — scanned_by stays NULL and the scan
 * ingests normally; we never write an unvalidated value and never throw. The email
 * (PII) is NOT logged — only the resolved user id (a UUID) on success.
 */
export async function resolveScanOperatorId(operatorHeader?: string | null): Promise<string | null> {
  const email = (operatorHeader || "").trim().toLowerCase();
  if (!email) return null; // legacy shared-token scan — no operator identity
  try {
    const user = await storage.getUserByEmail(email);
    if (!user || (user as { deletedAt?: unknown }).deletedAt) {
      console.log("[scan-ingest] operator header did not resolve to an active user → scanned_by NULL");
      return null;
    }
    const eligible = user.role === "admin" || user.canScan === true || user.canGrade === true;
    if (!eligible) {
      console.log("[scan-ingest] operator resolved but lacks scan/grade capability → scanned_by NULL");
      return null;
    }
    console.log(`[scan-ingest] operator resolved → scanned_by=${user.id}`);
    return user.id;
  } catch (err: any) {
    console.warn(`[scan-ingest] operator resolution failed (${err?.message}) → scanned_by NULL`);
    return null;
  }
}

/**
 * Internal sentinel: a concurrent same-key ingest committed first, so this
 * transaction must roll back — which returns its MV number to the sequence —
 * and then resolve to the winning row. This is a normal, expected outcome of
 * the idempotency race, not a failure; it never escapes createCertForScan().
 */
class IdempotencyRaceLost extends Error {
  constructor() {
    super("concurrent same-key ingest committed first");
    this.name = "IdempotencyRaceLost";
  }
}

export async function createCertForScan(
  idempotencyKey?: string | null,
  scannedBy?: string | null
): Promise<{
  id: number;
  certId: string;
  referenceNumber: string;
  rawUploaded: boolean;
  scanStatus: string | null;
  reused: boolean;
}> {
  // Normalise: empty / whitespace-only → no key (null), so a blank never lands
  // in the unique index (where a 2nd blank would 500 on a duplicate-key clash).
  idempotencyKey = typeof idempotencyKey === "string" && idempotencyKey.trim() ? idempotencyKey.trim() : null;
  // Phase 1: operator id is pre-validated by resolveScanOperatorId (a real user id
  // or null). Normalise blanks to null. Written only on first creation — an
  // idempotent replay returns the existing row without overwriting scanned_by.
  scannedBy = typeof scannedBy === "string" && scannedBy.trim() ? scannedBy.trim() : null;
  const norm = (n: string) => String(n).replace(/^MV-?0+/, "MV");
  const mapRow = (r: any, reused: boolean) => ({
    id: r.id as number,
    certId: norm(r.certificate_number),
    referenceNumber: r.reference_number as string,
    rawUploaded: r.raw_uploaded === true,
    scanStatus: (r.scan_status as string) ?? null,
    reused,
  });

  // 1. Idempotent replay — the original ingest already committed this cert.
  if (idempotencyKey) {
    const existing = await db.execute(sql`
      SELECT id, certificate_number, reference_number, raw_uploaded, scan_status
      FROM certificates WHERE ingest_idempotency_key = ${idempotencyKey} LIMIT 1`);
    if (existing.rows.length) {
      const row = mapRow(existing.rows[0], true);
      console.log(`[scan-ingest] idempotent replay → existing ${row.certId} (raw_uploaded=${row.rawUploaded})`);
      return row;
    }
  }

  // Phase 2 — auto-assign: if the scanning operator can grade, the new cert is
  // assigned to them so it lands straight in their /staff queue. A scan-only
  // operator (can_grade=false), a non-operator, or a shared-token scan (scannedBy
  // NULL) leaves it unassigned for the manual /admin/graders pool. The eligibility
  // check never throws — on failure the scan still ingests, just unassigned.
  // Runs only for a fresh cert (after the idempotent-replay early return above).
  let autoAssign = false;
  if (scannedBy) {
    try {
      const g = await db.execute(
        sql`SELECT can_grade FROM users WHERE id = ${scannedBy} AND deleted_at IS NULL LIMIT 1`
      );
      autoAssign = g.rows[0]?.can_grade === true;
    } catch (err: any) {
      console.warn(`[scan-ingest] auto-assign eligibility check failed (${err?.message}) → leaving unassigned`);
    }
  }

  // 2. Allocate + insert ATOMICALLY, gated by the unique index on
  //    ingest_idempotency_key. The counter increment and the INSERT share ONE
  //    transaction. If a sibling POST with the same key committed first, the
  //    ON CONFLICT returns no row and we roll the whole transaction back, which
  //    RETURNS the MV integer to the sequence. Previously the allocation
  //    autocommitted separately and the loser's number became a permanent gap in
  //    the physical-card identity sequence. The unique index — not a
  //    check-then-insert — remains the atomic primitive against concurrent
  //    same-key POSTs. Nothing but these two statements is inside the
  //    transaction: the cert_counter row lock is held until it commits.
  const { generateReferenceNumber } = await import("./reference-number");
  const refNum = generateReferenceNumber();
  // Stamp the grading-origin snapshot explicitly as HQ.
  //
  // This path bypasses storage.createCertificate (and therefore buildOriginSnapshot), so before
  // this it left every origin_* column NULL. NULL is the LEGACY marker — "created before 0035
  // existed" — and getCertOrigin treats legacy as HQ policy. Since scanner ingest is how
  // essentially every certificate is actually born, that meant the origin columns 0035 added were
  // never populated by the dominant path: 262 of 262 staging certificates read origin_type NULL.
  //
  // Writing 'HQ' here restores the distinction the schema was designed around: NULL means "predates
  // the feature", 'HQ' means "we affirmatively recorded that MintVault graded this". Partner
  // provenance is NOT set here — a partner-originated card must carry its shop identity, and that
  // is supplied by the partner intake path, never inferred at the scanner.
  //
  // captured_at and snapshot_version are mandatory whenever origin_type is non-null
  // (chk_certificates_origin_capture_pairing); all partner fields stay NULL
  // (chk_certificates_origin_non_partner_clean). 0035's trigger is set-once, so this value is
  // frozen the moment it lands — which is exactly why it must not be guessed.
  //
  // The origin stamp is INSIDE the allocator transaction, deliberately: the origin snapshot and
  // the identity it describes must commit or roll back together. A rolled-back insert must leave
  // neither an MV integer consumed nor a half-recorded provenance claim.
  let created: Record<string, unknown> | null = null;
  try {
    created = await db.transaction(async (tx) => {
      const certNumber = await storage.getNextCertId(tx);
      const ins = await tx.execute(sql`
        INSERT INTO certificates (certificate_number, status, label_type, grade_type, language, card_name, created_by, issued_at, updated_at, reference_number, source, raw_uploaded, scan_status, scanned_by, assigned_grader_id, grader_status, assigned_at, ingest_idempotency_key, origin_type, origin_captured_at, origin_snapshot_version)
        VALUES (${certNumber}, 'active', 'Standard', 'numeric', 'English', NULL, 'admin_scan', NOW(), NOW(), ${refNum}, 'admin_scan', false, 'processing', ${scannedBy}, ${autoAssign ? scannedBy : null}, ${autoAssign ? "assigned" : "unassigned"}, ${autoAssign ? sql`NOW()` : sql`NULL`}, ${idempotencyKey ?? null}, 'HQ', NOW(), ${CERTIFICATE_ORIGIN_SNAPSHOT_VERSION})
        ON CONFLICT (ingest_idempotency_key) DO NOTHING
        RETURNING id, certificate_number, reference_number, raw_uploaded, scan_status
      `);
      if (!ins.rows.length) throw new IdempotencyRaceLost();
      return ins.rows[0] as Record<string, unknown>;
    });
  } catch (err) {
    // Only the race sentinel is swallowed; a real failure still propagates (and
    // its rollback has already returned the MV integer to the sequence).
    if (!(err instanceof IdempotencyRaceLost)) throw err;
    created = null;
  }
  if (created) {
    const row = mapRow(created, false);
    console.log(`[scan-ingest] created cert ${row.certId} (id=${row.id}) ref=${refNum}`);
    return row;
  }

  // 3. Lost a concurrent same-key race — a sibling POST inserted first. Our
  //    allocation was rolled back with the transaction, so NO number was
  //    consumed; resolve to the winner.
  const winner = await db.execute(sql`
    SELECT id, certificate_number, reference_number, raw_uploaded, scan_status
    FROM certificates WHERE ingest_idempotency_key = ${idempotencyKey} LIMIT 1`);
  if (!winner.rows.length) throw new Error(`idempotency conflict but no winning row for key`);
  const row = mapRow(winner.rows[0], true);
  console.log(`[scan-ingest] concurrent same-key race resolved → ${row.certId} (no counter tick consumed)`);
  return row;
}

/**
 * Mark raw scans confirmed in R2 — set ONLY after uploadRawScansToR2 resolves.
 * This flag is the scanner's precondition for moving the inbox file to processed/.
 */
export async function markRawUploaded(certId: number): Promise<void> {
  // deleted_at guard (two-scanner safety): a concurrent DELETE from the other
  // scanner must not have this in-flight ingest confirm raws onto a dead cert.
  await db.execute(
    sql`UPDATE certificates SET raw_uploaded = true, updated_at = NOW() WHERE id = ${certId} AND deleted_at IS NULL`
  );
}

/**
 * Reconciler — boot + interval sweep for incomplete scan ingests. Idempotent
 * and dedup-safe (deterministic R2 keys, no rescan).
 *
 *  (A) scan_status='failed' AND raw_uploaded=true: the raw scans ARE in R2, but
 *      the heavy pipeline failed. Re-enqueue processing from the retained raw.
 *  (B) raw_uploaded=false older than N min: the server has NO bytes (they live
 *      only in the scanner's retained inbox file) — it CANNOT fix this itself.
 *      Surface LOUD; recovery is the scanner re-driving the idempotent ingest.
 *  Both classes are queryable for the admin Capture Health view.
 */
export async function reconcileStuckScans(opts: { staleMinutes?: number; limit?: number } = {}): Promise<void> {
  const stale = opts.staleMinutes ?? 10;
  const limit = opts.limit ?? 20;

  // (A) Re-enqueue interrupted pipelines from retained immutable evidence — raw
  // is durably in R2 but the heavy pipeline never finished. Two ways in:
  //   - scan_status='failed'         → the pipeline threw; re-drive immediately.
  //   - scan_status='processing' AND stale → the pipeline was INTERRUPTED after
  //     markRawUploaded but before completion. The commonest cause is a SERVER
  //     RESTART (a deploy) dropping the in-memory scan-job queue, leaving the cert
  //     a permanent empty shell — NEITHER case (B) (raw_uploaded=false) nor the old
  //     failed-only query caught it, so it stranded forever (MV291-297). A staleness
  //     gate (>${stale}min, well beyond the ~10-30s a real pipeline takes) ensures we
  //     never yank a cert that's legitimately mid-processing right now.
  // Queue insertion is idempotent: one active durable job exists per certificate.
  // This reconciler must not read TIFFs or run Sharp itself; otherwise it would
  // bypass the lease/capacity boundary and race the durable worker on another
  // replica.
  let failed: { rows: any[] };
  try {
    failed = (await db.execute(sql`
      SELECT id, certificate_number FROM certificates
      WHERE raw_uploaded = true
        AND deleted_at IS NULL
        AND (
          scan_status = 'failed'
          OR (scan_status = 'processing'
              AND updated_at < NOW() - ((${stale})::text || ' minutes')::interval)
        )
      ORDER BY updated_at ASC LIMIT ${limit}`)) as any;
  } catch (e: any) {
    console.error(`[reconciler] query (failed/stalled) error: ${e?.message}${pgErrorDetail(e)}`);
    failed = { rows: [] };
  }
  for (const row of failed.rows) {
    const certId = row.id as number;
    const certNum = String(row.certificate_number);
    try {
      const { enqueueScannerProcessing } = await import("./scanner-processing-queue");
      await enqueueScannerProcessing(certId, null);
      console.log(`[reconciler] re-enqueued interrupted scanner pipeline for ${certNum}`);
    } catch (e: any) {
      console.error(`[reconciler] re-enqueue failed ${certNum}: ${e?.message ?? e}${pgErrorDetail(e)}`);
    }
  }

  // (B) Raw never confirmed — surface for scanner re-supply (server can't fix).
  let noRaw: { rows: any[] };
  try {
    noRaw = (await db.execute(sql`
      SELECT certificate_number FROM certificates
      WHERE raw_uploaded = false AND scan_status = 'processing'
        AND issued_at < NOW() - ((${stale})::text || ' minutes')::interval
      ORDER BY issued_at ASC LIMIT 50`)) as any;
  } catch (e: any) {
    console.error(`[reconciler] query (no-raw) error: ${e?.message}${pgErrorDetail(e)}`);
    noRaw = { rows: [] };
  }
  const stuck = noRaw.rows.map((r) => r.certificate_number);
  if (stuck.length) {
    console.warn(
      `[reconciler] ${stuck.length} cert(s) raw_uploaded=false >${stale}min — awaiting scanner re-supply: ${stuck.join(", ")}`
    );
  }
}

/**
 * Persist the raw scanner buffers to R2 as a durability backup BEFORE
 * the full processing pipeline runs. Stored under deterministic paths
 * (raw_front.{ext}, raw_back.{ext}) keyed off the cert ID so a recovery
 * path can locate them.
 *
 * Kept separate from uploadImagesToCert because raw upload happens
 * synchronously inside POST /api/admin/scan-ingest (durability before
 * returning to the watcher), while the heavy pipeline runs async.
 */
export async function uploadRawScansToR2(
  certId: number,
  front: { buffer: Buffer; mimeType: string; ext: string; inspection?: ScannerEvidenceInspection },
  back: { buffer: Buffer; mimeType: string; ext: string; inspection?: ScannerEvidenceInspection } | null,
  options: { allowRecapture?: boolean; captureMetadata?: Record<string, unknown>; primarySide?: "front" | "back" } = {}
): Promise<{ frontKey: string; backKey: string | null }> {
  const frontInspection = front.inspection ?? (await inspectScannerEvidence(front.buffer));
  const backInspection = back ? (back.inspection ?? (await inspectScannerEvidence(back.buffer))) : null;
  assertCompatibleEvidencePair(frontInspection, backInspection);

  const persist = async (
    side: "front" | "back",
    input: { buffer: Buffer },
    inspection: ScannerEvidenceInspection
  ): Promise<string> => {
    // TIFF is content-addressed and immutable. A JPEG is retained only to keep
    // existing scanner clients operational, under an explicit legacy prefix.
    const key =
      inspection.evidenceClass === "NEW_IMMUTABLE_MASTER"
        ? `evidence/masters/${certId}/${side}/${inspection.sha256}.tif`
        : `evidence/legacy/${certId}/${side}/${inspection.sha256}.jpg`;
    if (inspection.evidenceClass === "NEW_IMMUTABLE_MASTER") {
      await uploadImmutableEvidenceToR2(key, input.buffer, {
        sha256: inspection.sha256,
        evidenceclass: inspection.evidenceClass,
        evidenceversion: "v1",
        side,
        certificateid: String(certId),
      });
    } else {
      await uploadToR2(key, input.buffer, inspection.mimeType);
    }

    // Object storage is content-addressed and immutable.  The database pointer
    // switch below is serialized separately, so a retry can never replace an
    // earlier master and concurrent recaptures cannot both become current.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [hashLockKey(`evidence:${certId}:${side}`)]);
      const existing = await client.query(
        `SELECT id, object_key, sha256, byte_length, evidence_class
           FROM certificate_image_evidence
          WHERE certificate_id = $1 AND side = $2 AND is_current = true
          FOR UPDATE`,
        [certId, side]
      );
      const current = existing.rows[0] as
        | { id: number; object_key: string; sha256: string; byte_length: string | number; evidence_class: string }
        | undefined;
      if (
        current?.sha256 === inspection.sha256 &&
        Number(current.byte_length) === inspection.byteLength &&
        current.evidence_class === inspection.evidenceClass
      ) {
        await client.query("COMMIT");
        return String(current.object_key); // exact replay; no duplicate revision
      }
      if (current && !options.allowRecapture) {
        throw new Error(`Refusing to replace existing ${side} scanner evidence for certificate ${certId}`);
      }
      if (current) {
        await client.query(
          `UPDATE certificate_image_evidence
              SET is_current = false, superseded_at = NOW()
            WHERE id = $1`,
          [current.id]
        );
      }
      const metadata = JSON.stringify({
        channels: inspection.channels,
        colourSpace: inspection.colourSpace,
        hasIccProfile: inspection.hasIccProfile,
        ...(options.captureMetadata ?? {}),
      });
      const inserted = await client.query(
        `INSERT INTO certificate_image_evidence
          (certificate_id, side, evidence_class, evidence_version, object_key, sha256, byte_length,
           pixel_width, pixel_height, bit_depth, dpi, format, capture_metadata, is_current)
         VALUES ($1, $2, $3, 'v2', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, true)
         RETURNING id, object_key`,
        [
          certId,
          side,
          inspection.evidenceClass,
          key,
          inspection.sha256,
          inspection.byteLength,
          inspection.width,
          inspection.height,
          inspection.bitDepth,
          inspection.dpi,
          inspection.format,
          metadata,
        ]
      );
      const next = inserted.rows[0] as { id: number; object_key: string };
      if (current) {
        await client.query("UPDATE certificate_image_evidence SET superseded_by_id = $1 WHERE id = $2", [
          next.id,
          current.id,
        ]);
      }
      await client.query("COMMIT");
      return next.object_key;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const primarySide = options.primarySide ?? "front";
  const [frontKey, backKey] = await Promise.all([
    persist(primarySide, front, frontInspection),
    back && backInspection ? persist("back", back, backInspection) : Promise.resolve(null),
  ]);
  return { frontKey, backKey };
}

/** Persist exactly one pre-bound scanner side without creating a second ingest path. */
export async function uploadRawScannerSide(
  certId: number,
  side: "front" | "back",
  input: { buffer: Buffer; mimeType: string; ext: string; inspection?: ScannerEvidenceInspection },
  options: { allowRecapture: boolean; captureMetadata: Record<string, unknown> }
): Promise<string> {
  const persisted = await uploadRawScansToR2(certId, input, null, { ...options, primarySide: side });
  return persisted.frontKey;
}

/**
 * Write the cert's scan_status column. null = ready (no special state).
 * Defensive: missing column (pre-migration) → no-op, swallowed.
 */
export async function setScanStatus(certId: number, status: "processing" | "failed" | null): Promise<void> {
  try {
    await db.execute(sql`UPDATE certificates SET scan_status = ${status}, updated_at = NOW() WHERE id = ${certId}`);
  } catch (err: any) {
    console.warn(`[scan-status] write failed for cert ${certId}: ${err?.message ?? err}`);
  }
}

/**
 * Run the heavy image processing + AI pipeline as a background job.
 * Called from inside setImmediate by the scan-ingest endpoint AFTER the
 * synchronous reply has been sent. Buffers are passed by reference from
 * the multipart upload — no re-fetch from R2 in the success path.
 *
 * Failure handling: scan_status flips to "failed" and an audit_log row
 * is written so admin can see the cert needs reprocessing. The raw R2
 * keys persisted by uploadRawScansToR2 stay around for recovery.
 */
export async function processScanInBackground(
  certInfo: { id: number; certId: string },
  frontBuf: Buffer,
  backBuf: Buffer | null,
  opts: { skipAi?: boolean; throwOnFailure?: boolean } = {}
): Promise<void> {
  const t0 = process.hrtime.bigint();
  try {
    console.log(`[process-scan] start cert=${certInfo.certId} (id=${certInfo.id})`);
    // Two-scanner safety: the other scanner may have deleted this cert between
    // ingest and this background job. Skip the whole pipeline — the UPDATE
    // guards downstream would no-op anyway, this just avoids the wasted work.
    const live = await db.execute(sql`SELECT 1 FROM certificates WHERE id = ${certInfo.id} AND deleted_at IS NULL`);
    if (live.rows.length === 0) {
      console.log(`[process-scan] cert=${certInfo.certId} soft-deleted mid-ingest — skipping pipeline`);
      return;
    }
    // Heartbeat (multi-scanner safety): updated_at is the reconciler's
    // staleness marker. Bumping it when the job actually STARTS means
    // "stale processing" measures started-but-died pipelines, not certs
    // that merely sat in a busy queue behind 3-4 scanners' worth of cards.
    await db.execute(sql`UPDATE certificates SET updated_at = NOW() WHERE id = ${certInfo.id} AND deleted_at IS NULL`);
    const { frontVariants, backVariants, timing } = await uploadImagesToCert(certInfo.id, frontBuf, backBuf);
    console.log(`[process-scan] images processed cert=${certInfo.certId}`);

    let aiMs = 0;
    if (!opts.skipAi) {
      const tAi = process.hrtime.bigint();
      try {
        const aiResult = await runAiOnCert(certInfo.id, frontVariants.cropped, backVariants?.cropped || null);
        aiMs = elapsedMs(tAi);
        console.log(`[process-scan] AI done cert=${certInfo.certId} grade=${aiResult.grade}`);
      } catch (aiErr: any) {
        aiMs = elapsedMs(tAi);
        // AI failure doesn't fail the whole job — images are processed,
        // admin can manually trigger AI from the grading panel.
        console.error(
          `[process-scan] AI failed cert=${certInfo.certId}: ${aiErr?.message ?? aiErr}\n${aiErr?.stack ?? "(no stack)"}`
        );
      }
    }

    await setScanStatus(certInfo.id, null);
    // Per-step timing for capacity sizing (server log ONLY, never client-exposed).
    // sharp + r2 come from uploadImagesToCert's internal split; ai = both Haiku
    // calls + TCG verify; total = the whole background pipeline (processing → done).
    // One scan in isolation gives clean, uncontended numbers for sizing 2 scanners.
    console.log(
      `[scan-timing] cert=${certInfo.certId} sharp=${timing.sharpMs.toFixed(0)}ms ai=${aiMs.toFixed(0)}ms r2=${timing.r2Ms.toFixed(0)}ms total=${elapsedMs(t0).toFixed(0)}ms`
    );
    console.log(`[process-scan] ready cert=${certInfo.certId}`);
  } catch (err: any) {
    console.error(
      `[process-scan] failed cert=${certInfo.certId}: ${err?.message ?? err}${pgErrorDetail(err)}\n${err?.stack ?? "(no stack)"}`
    );
    await setScanStatus(certInfo.id, "failed");
    try {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES (
          'certificate',
          ${String(certInfo.id)},
          'scan_processing_failed',
          'system',
          ${JSON.stringify({ certId: certInfo.certId, error: String(err?.message ?? err) })}::jsonb,
          NOW()
        )
      `);
    } catch {
      /* audit write best-effort */
    }
    if (opts.throwOnFailure) throw err;
  }
}

/**
 * Resolve the immutable evidence selection only when the bounded processing
 * worker begins.  The receive/finalisation HTTP request must not download one
 * or two 1200-DPI masters back into heap merely to enqueue derivative work.
 *
 * The evidence ledger is the authority here, not a request payload or an R2
 * key supplied by a station. A later accepted recapture intentionally wins
 * the current pointer before derivative work begins.
 */
export async function processCurrentScannerEvidenceInBackground(
  certInfo: { id: number; certId: string },
  opts: { skipAi?: boolean; throwOnFailure?: boolean } = {}
): Promise<void> {
  const current = await db.execute(sql`
    SELECT side, object_key FROM certificate_image_evidence
    WHERE certificate_id = ${certInfo.id} AND is_current = true`);
  const rows = current.rows as Array<{ side: "front" | "back"; object_key: string }>;
  const frontKey = rows.find((row) => row.side === "front")?.object_key;
  const backKey = rows.find((row) => row.side === "back")?.object_key;
  if (!frontKey) throw new Error("Current immutable front master is unavailable for scan processing");
  const [frontBuffer, backBuffer] = await Promise.all([
    getR2Buffer(frontKey),
    backKey ? getR2Buffer(backKey) : Promise.resolve(null),
  ]);
  if (!frontBuffer || (backKey && !backBuffer)) {
    throw new Error("Current immutable master could not be re-read from evidence storage");
  }
  return processScanInBackground(certInfo, frontBuffer, backBuffer, opts);
}

/**
 * Upload front + back images to R2 and save paths to the certificate.
 * Runs the unified image-processing pipeline (deskew, tight crop,
 * deterministic re-centre, rounded-corner mask) — Phase Y convergence
 * with the admin CaptureWizard path.
 *
 * Writes per side:
 *   grading/{id}/{side}_original.jpg     — raw scan (AI "before" reference)
 *   grading/{id}/{side}_cropped.jpg      — flat cropped (AI consumption)
 *   grading/{id}/{side}_cropped.jpg      — flattened display (rounded corners
 *                                           baked into white; was PNG-with-alpha
 *                                           pre-2026-05-11 audit fix)
 *   grading/{id}/{side}_{variant}.jpg    — greyscale/highcontrast/etc
 *   images/{certId}/{side}.jpg           — canonical display key (front_image_path)
 */
export async function uploadImagesToCert(
  certId: number,
  frontBuffer: Buffer,
  backBuffer: Buffer | null
): Promise<{ frontVariants: any; backVariants: any | null; timing: { sharpMs: number; r2Ms: number } }> {
  // Per-cert cross-machine serialization (two-scanner safety): the scan
  // background job and the manual image-attach endpoint can both regenerate
  // this cert's variants at the same instant from DIFFERENT Fly machines —
  // R2 is last-write-wins, so unserialized runs can leave the DB pointing at
  // one run's keys while R2 holds the other's pixels. A Postgres advisory
  // lock (waiting, max 60s) makes runs take turns; on timeout we throw, the
  // caller's existing failure path marks scan_status='failed' and the
  // reconciler re-drives — visible failure over silent corruption.
  const lockKey = hashLockKey(`img-pipeline:${certId}`);
  const client = await pool.connect();
  let acquired = false;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const r = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
      if (r.rows[0]?.locked === true) {
        acquired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!acquired) {
      throw new Error(`image pipeline for cert ${certId} is locked by another run (waited 60s)`);
    }
    return await uploadImagesToCertUnlocked(certId, frontBuffer, backBuffer);
  } finally {
    if (acquired) await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    client.release();
  }
}

async function uploadImagesToCertUnlocked(
  certId: number,
  frontBuffer: Buffer,
  backBuffer: Buffer | null
): Promise<{ frontVariants: any; backVariants: any | null; timing: { sharpMs: number; r2Ms: number } }> {
  const tImg = process.hrtime.bigint();
  const { maskRoundedCorners, tightenForDisplay } = await import("./image-processing");
  const sharp = (await import("sharp")).default;

  // Resolve cert number for display-key path (images/{CERT}/…). The stored
  // certificate_number is already normalised ("MV145", not "MV-0000000145").
  //
  // There is deliberately NO fallback. This previously synthesised `MV${certId}`
  // from the numeric PRIMARY KEY, which is not a certificate number at all: it
  // would mint a plausible-looking but fake MV identity and write this card's
  // images under a key belonging to a DIFFERENT real certificate. A missing row
  // (the cert was hard-deleted mid-pipeline) must abort the image write, never
  // invent an identity.
  const certRow = (await db.execute(sql`SELECT certificate_number FROM certificates WHERE id = ${certId}`)).rows[0] as
    | { certificate_number?: string }
    | undefined;
  const certNumber = certRow?.certificate_number;
  if (!certNumber) {
    throw new Error(
      `cannot resolve certificate_number for certificate id=${certId} — refusing to write images under a synthesised key`
    );
  }

  // A NEW_IMMUTABLE_MASTER working derivative may only be built from the exact
  // master bytes bound in the evidence ledger. This deliberately makes legacy
  // bulk-reprocess paths fail for new evidence rather than laundering a q85
  // derivative back into an authoritative working pointer.
  let masterRows: Array<{ side: string; sha256: string; scannerProfileVersion: string | null }> = [];
  try {
    masterRows = (
      await db.execute(sql`
        SELECT side, sha256,
          COALESCE(
            capture_metadata->>'scannerProfileVersion',
            capture_metadata->>'profileVersion'
          ) AS "scannerProfileVersion"
          FROM certificate_image_evidence
        WHERE certificate_id = ${certId} AND evidence_class = 'NEW_IMMUTABLE_MASTER' AND is_current = true
      `)
    ).rows as Array<{ side: string; sha256: string; scannerProfileVersion: string | null }>;
  } catch {
    // Table is additive during a rolling deployment; legacy processing remains
    // available until it exists. New ingestion creates the ledger before this
    // function is queued, so it never takes this fallback.
  }
  if (masterRows.length) {
    const verify = async (side: "front" | "back", input: Buffer | null) => {
      const row = masterRows.find((r) => r.side === side);
      if (!row) return;
      if (!input) throw new Error(`Missing ${side} master bytes for evidence-bound working derivative`);
      const inspected = await inspectScannerEvidence(input);
      if (inspected.evidenceClass !== "NEW_IMMUTABLE_MASTER" || inspected.sha256 !== row.sha256) {
        throw new Error(`Refusing ${side} working derivative: source does not match immutable TIFF master`);
      }
    };
    await verify("front", frontBuffer);
    await verify("back", backBuffer);
  }

  // Phase 58A authoritative working asset. It is a browser-safe JPEG derived
  // once from the master with deterministic orientation only: no crop, resize,
  // denoise, sharpening, or perspective correction. The old 2000px output
  // remains a non-authoritative analysis/display branch below.
  const isLide400Master = (side: "front" | "back") =>
    masterRows.find((row) => row.side === side)?.scannerProfileVersion === CANON_LIDE_400_PROFILE.version;

  const makeNativeWorkingAsset = async (buf: Buffer, isLide400: boolean) => {
    const source = sharp(buf, { limitInputPixels: 30_000_000, failOn: "error" });
    // Scanner evidence preserves its source TIFF untouched. Its working and
    // display derivatives, however, are always upright for the operator.
    const oriented = isLide400 ? orientLide400Presentation(source) : source.rotate();
    const result = await oriented
      .jpeg({ quality: 95, chromaSubsampling: "4:4:4", progressive: false })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: result.data,
      width: result.info.width,
      height: result.info.height,
      sha256: createHash("sha256").update(result.data).digest("hex"),
    };
  };
  const [frontWorking, backWorking] = await Promise.all([
    makeNativeWorkingAsset(frontBuffer, isLide400Master("front")),
    backBuffer ? makeNativeWorkingAsset(backBuffer, isLide400Master("back")) : Promise.resolve(null),
  ]);

  // WORKING resolution for the legacy variant pipeline. This is deliberately
  // downstream of the authoritative native working asset, never the TIFF
  // master. It must not be used for new manual measurements.
  // 900dpi TIFF (a card ≈ 2250×3150 px, the whole bed far more); the client
  // uploads it full-res. We downscale to this working size ONCE here, then EVERY
  // downstream step (deskew, card-detect, re-centre, the 5 analysis variants, the
  // display PNG/JPEG) runs at this size. The raw full-res is preserved separately
  // in R2 (images/grading/{id}/raw_front.*) — nothing is lost.
  //
  // 2000px (long edge) ≈ 570dpi for a 3.5" card — preserves centering lines and
  // surface defects for grading, and gives zoom headroom over the 1600px grading
  // viewer (makeDisplayDerivative). The previous 3000px did ~2.25× the pixel +
  // encode work per card with no grading benefit; on the shared-1x Fly CPU that
  // was a big chunk of the ~13-min-per-card sharp time under sustained scanning.
  const WORKING_MAX_PX = 2000;

  // Resize raw scans (scanner output can be very large). Front + back run in
  // parallel — Sharp releases the JS thread during the native encode so a
  // single-core Fly box still benefits despite both calls being CPU-bound.
  //
  // Encoder is plain libjpeg-turbo baseline (no mozjpeg, no progressive).
  // This output is INTERMEDIATE — it's decoded immediately by
  // generateImageVariants, so the mozjpeg encode work was wasted. Baseline
  // saves ~30-40% per encode at no visual cost (the bytes are never served).
  const resizeBuf = async (buf: Buffer) =>
    sharp(buf)
      .rotate()
      .resize(WORKING_MAX_PX, WORKING_MAX_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

  const [frontResized, backResized] = await Promise.all([
    resizeBuf(frontWorking.buffer),
    backWorking ? resizeBuf(backWorking.buffer) : Promise.resolve(null),
  ]);

  // Generate variants via the unified pipeline (deskew + autoCrop + reCentre).
  // Pass certNumber so card-detect logs are traceable per cert (Fix 0).
  // Parallelised across sides — same rationale as the resize step above.
  const [frontVariants, backVariants] = await Promise.all([
    generateImageVariants(frontResized, certNumber),
    backResized ? generateImageVariants(backResized, certNumber) : Promise.resolve(null),
  ]);

  // Derive display-ready artefacts. The pipeline is:
  //   centredUnpadded → tightenForDisplay (second card-detect, no safety pad)
  //                   → maskRoundedCorners
  //                   → {toDisplayPng, toDisplayJpeg}
  //
  // Two encodings from a single masked buffer:
  //   - PNG with alpha-transparent rounded corners → canonical display key
  //     (front_image_path). Renders cleanly on both light and dark page bg.
  //   - JPEG with flatten-to-white rounded corners → front_cropped.jpg key
  //     (compatibility — DGR PDF and other consumers that expect a JPEG).
  //
  // Why tightenForDisplay instead of the earlier 10 px uniform inset (which
  // was the v592 trimForDisplay):
  //   - centredUnpadded carries an 8 px safety-pad strip from the FIRST
  //     card-detect pass (cropToCardBoundary). At full-res that scales to
  //     ~16–26 px of mat-coloured pixels on every side.
  //   - A uniform 10 px inset left a ~10 px visible strip of mat colour
  //     on the straight sides of the rounded mask — Cornelius's "thin
  //     frame around the card" report (v593 backfill).
  //   - tightenForDisplay re-runs detectCardBoundary with safetyPadPx=0 on
  //     this clean centred buffer. Card-edge contrast against the safety
  //     strip is strong and uniform, so zero-pad detection is safe here
  //     (unlike the first pass, which needs the pad against tilted scans).
  //   - Falls back to a 16 px uniform inset if detection fails.
  //
  // NOTE (rev 3b29948 → reverted): a previous attempt collapsed mask+flatten
  // into a single inline sharp() pipeline. That clipped the right edge of
  // cards on prod (v587). Keep the two-stage split — materialising between
  // mask and encode sidesteps a libvips pipeline-reordering bug. Don't
  // re-collapse without a visual diff harness.
  async function toDisplayPng(buf: Buffer): Promise<Buffer> {
    // No flatten — maskRoundedCorners already produced alpha=0 at the
    // rounded corners (image-processing.ts:38-50). Encode as PNG to keep
    // transparency.
    return sharp(buf).png({ compressionLevel: 9 }).toBuffer();
  }
  async function toDisplayJpeg(buf: Buffer): Promise<Buffer> {
    return sharp(buf)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer();
  }

  const frontUnpadded = (frontVariants as any).centredUnpadded as Buffer | undefined;
  const frontTight = await tightenForDisplay(frontUnpadded ?? frontVariants.cropped, certNumber, undefined, "front");
  const frontMaskedPng = await maskRoundedCorners(frontTight);
  const frontDisplayPng = await toDisplayPng(frontMaskedPng);
  const frontDisplayJpeg = await toDisplayJpeg(frontMaskedPng);

  const backUnpadded = backVariants ? ((backVariants as any).centredUnpadded as Buffer | undefined) : undefined;
  const backTight = backVariants
    ? await tightenForDisplay(backUnpadded ?? backVariants.cropped, certNumber, undefined, "back")
    : null;
  const backMaskedPng = backTight ? await maskRoundedCorners(backTight) : null;
  const backDisplayPng = backMaskedPng ? await toDisplayPng(backMaskedPng) : null;
  const backDisplayJpeg = backMaskedPng ? await toDisplayJpeg(backMaskedPng) : null;

  // All sharp/variant generation (resize + variants + display derivatives) is
  // done above; the R2 PUTs are kicked off + awaited below. This split is the
  // basis for the [scan-timing] sharp vs r2 numbers (small overlap: a couple of
  // PUTs start during the build, and makeDisplayDerivative does a tiny resize
  // inside the upload — counted under r2; negligible for sizing).
  const sharpMs = elapsedMs(tImg);

  // Upload all to R2 — explicit extension map per variant kind
  const prefix = `images/grading/${certId}`;
  const uploadKeys: Record<string, string> = {};
  const uploads: Promise<void>[] = [];

  // Persist native working assets under content-addressed keys. The ledger
  // ties each output to its source master hash and settings before the
  // workstation is allowed to consume it.
  const evidenceRows = (
    await db.execute(sql`
    SELECT side, sha256 FROM certificate_image_evidence WHERE certificate_id = ${certId} AND is_current = true`)
  ).rows as any[];
  const frontSource = evidenceRows.find((r) => r.side === "front");
  const backSource = evidenceRows.find((r) => r.side === "back");
  const frontWorkingKey = `evidence/working/${certId}/front/${frontWorking.sha256}.v1.jpg`;
  uploads.push(uploadToR2(frontWorkingKey, frontWorking.buffer, "image/jpeg").then(() => {}));
  const backWorkingKey = backWorking ? `evidence/working/${certId}/back/${backWorking.sha256}.v1.jpg` : null;
  if (backWorking && backWorkingKey)
    uploads.push(uploadToR2(backWorkingKey, backWorking.buffer, "image/jpeg").then(() => {}));

  // Flat JPG variants. Phase 2 — "cropped" REMOVED from this loop: it wrote the
  // SAME R2 key (front_cropped.jpg / back_cropped.jpg) as the canonical display
  // JPEG below, racing it in Promise.all with a different buffer. The display JPEG
  // is the intended owner of that key (grading_front_cropped resolves to
  // front_cropped_display FIRST), so the loop's cropped write was a dead fallback
  // AND the collision source. Dropping it makes the key deterministic.
  const jpgVariants = ["original", "greyscale", "highcontrast", "edgeenhanced", "inverted"] as const;
  for (const vName of jpgVariants) {
    const buf = (frontVariants as any)[vName] as Buffer | undefined;
    if (!buf) continue;
    const k = `${prefix}/front_${vName}.jpg`;
    uploadKeys[`front_${vName}`] = k;
    uploads.push(uploadToR2(k, buf, "image/jpeg").then(() => {}));
  }
  if (backVariants) {
    for (const vName of jpgVariants) {
      const buf = (backVariants as any)[vName] as Buffer | undefined;
      if (!buf) continue;
      const k = `${prefix}/back_${vName}.jpg`;
      uploadKeys[`back_${vName}`] = k;
      uploads.push(uploadToR2(k, buf, "image/jpeg").then(() => {}));
    }
  }

  // Canonical display key → PNG with alpha-transparent rounded corners.
  // front_cropped.jpg → flatten-white JPEG (kept for DGR PDF + any other
  // consumer that expects a JPEG; same mask + trim as the PNG, just a
  // different encoding). DB column front_image_path / back_image_path are
  // extension-agnostic text — consumers derive media-type from the key.
  const frontJpegKey = `${prefix}/front_cropped.jpg`;
  const frontDisplayKey = `images/${certNumber}/front.png`;
  uploadKeys["front_cropped_display"] = frontJpegKey;
  uploadKeys["front_display"] = frontDisplayKey;
  uploads.push(uploadToR2(frontJpegKey, frontDisplayJpeg, "image/jpeg").then(() => {}));
  uploads.push(uploadToR2(frontDisplayKey, frontDisplayPng, "image/png").then(() => {}));
  if (backDisplayJpeg && backDisplayPng) {
    const backJpegKey = `${prefix}/back_cropped.jpg`;
    const backDisplayKey = `images/${certNumber}/back.png`;
    uploadKeys["back_cropped_display"] = backJpegKey;
    uploadKeys["back_display"] = backDisplayKey;
    uploads.push(uploadToR2(backJpegKey, backDisplayJpeg, "image/jpeg").then(() => {}));
    uploads.push(uploadToR2(backDisplayKey, backDisplayPng, "image/png").then(() => {}));
  }

  // 1600px q80 viewer derivatives — the grading panel loads these instead of
  // the full-res cropped JPEGs (which stay as the zoom/manual-tool source).
  const { makeDisplayDerivative } = await import("./image-processing");
  const frontViewerKey = `${prefix}/front_display.jpg`;
  uploadKeys["front_viewer_display"] = frontViewerKey;
  uploads.push(
    makeDisplayDerivative(frontDisplayJpeg)
      .then((buf) => uploadToR2(frontViewerKey, buf, "image/jpeg"))
      .then(() => {})
  );
  if (backDisplayJpeg) {
    const backViewerKey = `${prefix}/back_display.jpg`;
    uploadKeys["back_viewer_display"] = backViewerKey;
    uploads.push(
      makeDisplayDerivative(backDisplayJpeg)
        .then((buf) => uploadToR2(backViewerKey, buf, "image/jpeg"))
        .then(() => {})
    );
  }

  const tR2 = process.hrtime.bigint();
  await Promise.all(uploads);
  const r2Ms = elapsedMs(tR2);
  console.log(`[scan-ingest] cert=${certId}: uploaded ${uploads.length} image artefacts to R2 (incl. display PNG)`);

  const workingSettings = JSON.stringify({
    version: "v1",
    format: "jpeg",
    quality: 95,
    chromaSubsampling: "4:4:4",
    orientation: "rotate",
    resize: null,
  });
  if (frontSource) {
    await db.execute(sql`
      UPDATE certificate_image_evidence SET
        working_object_key = ${frontWorkingKey}, working_sha256 = ${frontWorking.sha256},
        working_width = ${frontWorking.width}, working_height = ${frontWorking.height},
        working_format = 'jpeg', working_settings = ${workingSettings}::jsonb
      WHERE certificate_id = ${certId} AND side = 'front' AND is_current = true AND sha256 = ${frontSource.sha256}`);
  }
  if (backSource && backWorking && backWorkingKey) {
    await db.execute(sql`
      UPDATE certificate_image_evidence SET
        working_object_key = ${backWorkingKey}, working_sha256 = ${backWorking.sha256},
        working_width = ${backWorking.width}, working_height = ${backWorking.height},
        working_format = 'jpeg', working_settings = ${workingSettings}::jsonb
      WHERE certificate_id = ${certId} AND side = 'back' AND is_current = true AND sha256 = ${backSource.sha256}`);
  }

  // Persist R2 keys + crop_geometry forensics
  const cropGeometry = {
    front: (frontVariants as any).cropGeometry ?? null,
    back: backVariants ? ((backVariants as any).cropGeometry ?? null) : null,
    pipeline_version: "converged_v1",
    recorded_at: new Date().toISOString(),
  };

  await db.execute(sql`
    UPDATE certificates SET
      grading_front_original    = ${uploadKeys.front_original || null},
      grading_front_cropped     = ${uploadKeys.front_cropped_display || uploadKeys.front_cropped_png || uploadKeys.front_cropped || null},
      grading_front_greyscale   = ${uploadKeys.front_greyscale || null},
      grading_front_highcontrast = ${uploadKeys.front_highcontrast || null},
      grading_front_edgeenhanced = ${uploadKeys.front_edgeenhanced || null},
      grading_front_inverted    = ${uploadKeys.front_inverted || null},
      grading_back_original     = ${uploadKeys.back_original || null},
      grading_back_cropped      = ${uploadKeys.back_cropped_display || uploadKeys.back_cropped_png || uploadKeys.back_cropped || null},
      grading_back_greyscale    = ${uploadKeys.back_greyscale || null},
      grading_back_highcontrast  = ${uploadKeys.back_highcontrast || null},
      grading_back_edgeenhanced  = ${uploadKeys.back_edgeenhanced || null},
      grading_back_inverted     = ${uploadKeys.back_inverted || null},
      grading_front_display     = ${uploadKeys.front_viewer_display || null},
      grading_back_display      = ${uploadKeys.back_viewer_display || null},
      front_image_path          = ${uploadKeys.front_display || uploadKeys.front_cropped_display || uploadKeys.front_cropped_png || uploadKeys.front_cropped || uploadKeys.front_original || null},
      back_image_path           = ${uploadKeys.back_display || uploadKeys.back_cropped_display || uploadKeys.back_cropped_png || uploadKeys.back_cropped || uploadKeys.back_original || null},
      crop_geometry             = ${JSON.stringify(cropGeometry)}::jsonb,
      updated_at                = NOW()
    WHERE id = ${certId} AND deleted_at IS NULL
  `);

  return { frontVariants, backVariants, timing: { sharpMs, r2Ms } };
}

/**
 * Option A (minimum fast path): scan-time AI runs two Haiku 4.5 calls in
 * parallel — identification and centering measurement. The Haiku grade
 * call (gradeCardFromBuffer) is the only fast Haiku route that returns
 * centering data, so we still invoke it; but we only persist the
 * centering portion of its response on ingest. Corners/edges/surface/
 * overall are deferred to the admin's manual triggers from the grading
 * panel ("Detect Defects" / "Run All" / "Analyze with AI (Full)").
 *
 * Defect candidates are not generated automatically here either.
 *
 * Returns identification fields for the response payload; grade is null
 * on the fast path (admin's manual grade trigger fills it in).
 */
export async function runAiOnCert(
  certId: number,
  frontCropped: Buffer,
  backCropped: Buffer | null,
  opts: { dryRun?: boolean } = {}
): Promise<{ cardName: string | null; grade: number | string | null; strengthScore: number | null }> {
  // dryRun (sweep preview ONLY): run the full identify + TCGdex resolution and
  // RETURN the would-be card name, but persist NOTHING (no cert UPDATE, no audit,
  // no centering write). Lets the blank-card sweep show resolved names without
  // writing, reusing this exact resolution path rather than forking it.
  const dryRun = opts.dryRun === true;
  // Master kill-switch (admin-facing) — DB-backed pipeline setting that
  // admins flip from /admin/weekly-reel. Defaults to true so default
  // deploy behaviour is "auto-AI on", matching the pre-flag era. Setting
  // it false in the UI skips all auto-AI work; admin triggers AI manually
  // from the grading panel.
  const { getSetting } = await import("./lib/pipeline-settings");
  const autoOn = await getSetting("ai_auto_ingest_enabled", true);
  if (!autoOn) {
    console.log(`[ai] skip auto-trigger: ai_auto_ingest_enabled is off for cert ${certId}`);
    return { cardName: null, grade: null, strengthScore: null };
  }
  // ID-ONLY mode (default). The deferred/auto AI does card IDENTIFICATION +
  // TCGdex prefill ONLY — no grade or subgrades (centering). Humans grade
  // everything. This wires the previously documentation-only ai_ingest_identify_only
  // toggle so the admin switch finally controls real behaviour.
  const identifyOnly = await getSetting("ai_ingest_identify_only", true);

  // Resolve the MV-number for diagnostic context (retry logs, error traces).
  let certTag: string | number = certId;
  try {
    const r = await db.execute(sql`SELECT certificate_number FROM certificates WHERE id = ${certId}`);
    const row = r.rows[0] as any;
    if (row?.certificate_number) certTag = row.certificate_number;
  } catch {
    /* best-effort — fall back to numeric id */
  }

  // Identify (always) + the grade call (centering only — SKIPPED in identify-only
  // mode, which is the default). gradeCardFromBuffer is a second Haiku call whose
  // only use here is centering, a subgrade; with identifyOnly we never make it, so
  // no grading AI runs on the auto path. The aiGrading===null branches below then
  // skip every centering write.
  const [identification, aiGrading] = await Promise.all([
    identifyCardFromBuffer(frontCropped, "image/jpeg", certTag),
    identifyOnly ? Promise.resolve(null) : gradeCardFromBuffer(frontCropped, backCropped, certTag),
  ]);

  const game = identification.detected_game?.toLowerCase() || "other";
  let enrichedId = await verifyAndEnrichCardData(identification);
  let tcgVerified = false;

  if (game === "pokemon") {
    const tcgResult = await verifyPokemonCardWithTcgApi(
      identification.detected_name,
      identification.detected_number,
      identification.detected_rarity,
      identification.set_code,
      identification.copyright_year
    );
    if (tcgResult.verified) {
      enrichedId = {
        ...enrichedId,
        verified: true,
        officialName: tcgResult.officialCardName || enrichedId.officialName,
        officialSet: tcgResult.officialSetName || enrichedId.officialSet,
        officialNumber: identification.detected_number,
        referenceImageUrl: tcgResult.referenceImageUrl || enrichedId.referenceImageUrl,
        dbSource: "pokemon-tcg-api",
        detected_set: tcgResult.officialSetName || enrichedId.detected_set,
        detected_rarity: tcgResult.officialRarity || enrichedId.detected_rarity,
        detected_year: tcgResult.officialYear || enrichedId.detected_year,
      };
      tcgVerified = true;
    }
  }

  // Step 3: Determine which identification fields are confident enough to
  // write through to the DB. Most fields gate on (tcgVerified || high
  // confidence). card_game is special — it's a closed enum derived from the
  // AI's view of the card type, and even at "medium" confidence it's
  // overwhelmingly correct ("is this a Pokémon card?" is much easier than
  // "exact set / number"). Always write card_game when the AI returned a
  // known slug, so the form's Card Game dropdown auto-populates and "Search
  // TCG" gates unblock — even when set/number weren't confident.
  const aiConfidence = identification.confidence || "low";
  const shouldWriteDetails = tcgVerified || aiConfidence === "high";
  // TCGdex is AUTHORITATIVE for name / set / number. Haiku's raw text is the
  // source of wrong names (the original problem), so we write these ONLY from a
  // verified TCGdex match — NEVER from Haiku's guess, even at "high" confidence.
  // An unverified guess is surfaced as a flagged suggestion for the grader instead
  // (needs_identification_review, below). card_game / rarity / year keep the
  // medium-confidence write — card_game is a closed enum that unblocks the form's
  // TCG search, and these aren't the card-identity fields.
  const cardName = tcgVerified ? enrichedId.officialName || null : null;
  const setName = tcgVerified ? enrichedId.officialSet || enrichedId.detected_set || null : null;
  const cardNumber = tcgVerified ? enrichedId.officialNumber || enrichedId.detected_number || null : null;
  const cardGame =
    enrichedId.detected_game && enrichedId.detected_game !== "other"
      ? enrichedId.detected_game
      : shouldWriteDetails
        ? enrichedId.detected_game || null
        : null;
  const rarity = shouldWriteDetails ? enrichedId.detected_rarity || null : null;

  // Year derivation — kept consistent with routes.ts identify-and-analyze.
  // Prefer Claude's copyright_year, fall back to TCG-verified detected_year.
  // Reject AI-only years > 5y from current year unless TCG confirmed.
  let yearText: string | null = null;
  if (shouldWriteDetails) {
    const rawYear = identification.copyright_year || enrichedId.detected_year || null;
    const match = rawYear ? String(rawYear).match(/\d{4}/) : null;
    yearText = match ? match[0] : null;
    if (yearText && !tcgVerified) {
      const y = parseInt(yearText, 10);
      const currentYear = new Date().getFullYear();
      if (isNaN(y) || Math.abs(y - currentYear) > 5) {
        console.warn(`[scan-ingest] year guard: AI guessed ${yearText} but TCG didn't verify — clearing`);
        yearText = null;
      }
    }
  }

  // Step 4: Save identification (always safe to overwrite — non-graded
  // metadata). ai_analysis carries the identification snapshot and, when
  // available, just the centering portion of the Haiku grade response.
  // The rest of the grade payload (corners/edges/surface/overall) is
  // discarded here so ai_analysis honestly reflects what got persisted.
  const aiAnalysisPayload: Record<string, unknown> = {
    identification: enrichedId,
    model: "claude-haiku-4-5-20251001",
    pipeline: identifyOnly ? "identify_only" : "option_a_fast",
  };
  if (aiGrading) {
    aiAnalysisPayload.centering = aiGrading.centering;
  }
  // TCGdex couldn't confirm the card → name/set/number were left null above
  // (never trusted from Haiku). Surface Haiku's guess as a SUGGESTION the grader
  // must verify, with a flag the panel shows so it isn't silently missing.
  if (!tcgVerified) {
    aiAnalysisPayload.needs_identification_review = true;
    aiAnalysisPayload.suggested_name = identification.detected_name || null;
    aiAnalysisPayload.suggested_set = enrichedId.detected_set || identification.set_code || null;
    aiAnalysisPayload.suggested_number = identification.detected_number || null;
    aiAnalysisPayload.suggested_confidence = aiConfidence;
  }

  // ai_defect_candidates intentionally NOT written here — the manual
  // "Detect Defects" endpoint owns that column on first user trigger.
  if (dryRun) {
    console.log(`[ai] cert=${certId}: DRY-RUN — resolved card="${cardName}" set="${setName}" (no write)`);
    return { cardName, grade: null, strengthScore: null };
  }
  await db.execute(sql`
    UPDATE certificates SET
      ai_analysis = ${JSON.stringify(aiAnalysisPayload)}::jsonb,
      card_name = CASE WHEN card_name IS NULL OR card_name = '' THEN ${cardName} ELSE card_name END,
      set_name = CASE WHEN set_name IS NULL OR set_name = '' THEN ${setName} ELSE set_name END,
      card_number_display = CASE WHEN card_number_display IS NULL OR card_number_display = '' THEN ${cardNumber} ELSE card_number_display END,
      card_game = CASE WHEN card_game IS NULL OR card_game = '' THEN ${cardGame} ELSE card_game END,
      rarity = CASE WHEN rarity IS NULL OR rarity = '' THEN ${rarity} ELSE rarity END,
      year_text = CASE WHEN year_text IS NULL OR year_text = '' THEN ${yearText} ELSE year_text END,
      updated_at = NOW()
    WHERE id = ${certId}
  `);

  // Step 5: Persist ONLY centering on the fast path. Per-zone grading
  // (corners/edges/surface) and ai_draft_grade are deliberately not written
  // on ingest — the admin triggers those manually via the grading panel
  // (Detect Defects / Run All / Analyze with AI (Full)).
  //
  // Gated on `grade_approved_at IS NULL` — re-scanning an already-approved
  // cert must NEVER overwrite the published grade. centering_score column
  // is also CASE-guarded so we don't clobber a value the admin already
  // chose during their first review pass.
  let centeringWritten = false;
  if (aiGrading) {
    const result = await db.execute(sql`
      UPDATE certificates SET
        centering_score    = CASE WHEN centering_score IS NULL THEN ${aiGrading.centering.subgrade}::numeric ELSE centering_score END,
        centering_front_lr = COALESCE(${aiGrading.centering.front_left_right}, centering_front_lr),
        centering_front_tb = COALESCE(${aiGrading.centering.front_top_bottom}, centering_front_tb),
        centering_back_lr  = COALESCE(${aiGrading.centering.back_left_right},  centering_back_lr),
        centering_back_tb  = COALESCE(${aiGrading.centering.back_top_bottom},  centering_back_tb),
        updated_at         = NOW()
      WHERE id = ${certId} AND grade_approved_at IS NULL
    `);
    centeringWritten = (result.rowCount ?? 0) > 0;
    if (!centeringWritten) {
      console.log(`[scan-ingest] cert=${certId}: cert already approved — centering skipped, ai_analysis snapshot only`);
    }
  }

  // Audit row — model + per-call decision context. Keeps a paper trail of
  // what the cheaper Haiku pipeline actually wrote.
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
    VALUES (
      'certificate',
      ${String(certId)},
      'ai_scan_ingest',
      'system',
      ${JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        pipeline: "option_a_fast",
        operations: aiGrading ? ["identify", "centering"] : ["identify"],
        identification_confidence: aiConfidence,
        tcg_verified: tcgVerified,
        card_game: cardGame,
        card_name: cardName,
        centering_subgrade: aiGrading?.centering?.subgrade ?? null,
        centering_persisted: centeringWritten,
      })}::jsonb,
      NOW()
    )
  `);

  const centeringSubgrade = aiGrading?.centering?.subgrade ?? null;
  console.log(
    `[scan-ingest] cert=${certId}: ${identifyOnly ? "IDENTIFY-ONLY" : "identify + centering"} complete — card="${cardName}" game=${cardGame} tcg_verified=${tcgVerified}` +
      `${tcgVerified ? "" : " (NEEDS REVIEW — name unconfirmed, left for grader)"}` +
      `${identifyOnly ? "" : ` centering=${centeringSubgrade} persisted=${centeringWritten}`}`
  );
  return { cardName, grade: null, strengthScore: null };
}

// ── Auto-trigger gate ──────────────────────────────────────────────────────
// In-process map of AI calls fired automatically (e.g. by the upload-images
// handler on first full upload). Only the automatic trigger registers here;
// manual endpoints (measure-centering, detect-defects, grade-card) deliberately
// don't participate — user-initiated races are their choice. The map prevents
// duplicate auto-fires from racing each other (e.g. front + back uploaded as
// separate requests that each see empty ai_analysis). Cleared on process exit.

const inFlightAutoAi = new Map<number, Promise<unknown>>();

// Lazy-AI failure backoff — certId → last attempt epoch-ms. A pre-grade that
// ERRORS leaves ai_analysis empty; without this, ensureAiDraft would re-fire the
// full blocking AI on every reopen of that cert. Cleared on process restart
// (so a transient failure is retried after the cooldown / next boot).
const lazyAiAttempt = new Map<number, number>();
const LAZY_AI_COOLDOWN_MS = 90_000;

/**
 * Fire runAiOnCert only if no auto-triggered AI call is currently in flight
 * for this cert. The DB-backed `ai_auto_ingest_enabled` kill-switch is
 * checked inside runAiOnCert itself (returns an empty result when off),
 * so this wrapper stays synchronous and the caller's `if (promise) {…}`
 * pattern doesn't need to change.
 */
export function runAiOnCertIfIdle(
  certId: number,
  frontCropped: Buffer,
  backCropped: Buffer | null
): Promise<{ cardName: string | null; grade: number | string | null; strengthScore: number | null }> | null {
  if (inFlightAutoAi.has(certId)) {
    console.log(`[ai] skip auto-trigger: already in-flight for cert ${certId}`);
    return null;
  }
  const p = runAiOnCert(certId, frontCropped, backCropped).finally(() => {
    inFlightAutoAi.delete(certId);
  });
  inFlightAutoAi.set(certId, p);
  return p;
}

/**
 * Lazy AI pre-grade, BLOCKING. The pre-grade (runAiOnCert: identification +
 * centering) is DEFERRED off the scan path — the scan job runs sharp+r2 only.
 * Call this when a cert is OPENED for grading and AWAIT it: if its pre-grade
 * hasn't run yet, it computes it now from the stored cropped R2 images and
 * RESOLVES once the result is persisted, so the caller can re-read the cert and
 * return the draft on first paint (no later refresh needed).
 *
 * Bounded + safe to await on every open:
 *   - no-op if ai_analysis is already populated (pre-grade already ran),
 *   - no-op if the ai_auto_ingest_enabled master switch is off (manual-only mode),
 *   - no-op if the sharp pipeline hasn't produced a cropped front yet,
 *   - reuses an in-flight run if a concurrent open already started one,
 *   - bounded by timeoutMs (default 20s): on timeout it RETURNS while the AI
 *     keeps running in the background (it'll be present on the next load) — so a
 *     slow/hung AI never wedges the grading panel open.
 * Never throws — on any failure the caller still serves the cert, gradeable
 * without the draft.
 */
export async function ensureAiDraft(certId: number, opts: { timeoutMs?: number } = {}): Promise<void> {
  try {
    const row = (await db.execute(sql`SELECT ai_analysis, scan_status FROM certificates WHERE id = ${certId}`))
      .rows[0] as any;
    if (!row) return;
    // Don't fire the heavy (~20s) on-open AI while the scan is still INGESTING.
    // Phase 2 auto-assign routes a freshly-scanned cert straight into the grader
    // queue, so it can be opened while processScanInBackground is still running;
    // letting the AI pile onto the in-flight pipeline contends for the single vCPU
    // + the max:8 DB pool and can stall the ingest (stuck 'processing'). The AI
    // runs on the NEXT open, once scan_status has cleared.
    if (row.scan_status === "processing") return;
    const ai = row.ai_analysis;
    const aiEmpty = !ai || (typeof ai === "object" && Object.keys(ai).length === 0);
    if (!aiEmpty) return; // pre-grade already computed for this cert

    const { getSetting } = await import("./lib/pipeline-settings");
    if (!(await getSetting("ai_auto_ingest_enabled", true))) return; // master switch off → manual only

    // Prefer AWAITING an in-flight run — a concurrent open is already computing
    // this cert, so both opens get the draft from one Anthropic call (no dup fire).
    let p = inFlightAutoAi.get(certId) ?? null;
    if (!p) {
      // No live run. Back off if we attempted recently: a prior run that ERRORED
      // leaves ai_analysis empty, and without this guard every reopen would re-fire
      // the full blocking ~20s AI (and re-charge Haiku) forever.
      const last = lazyAiAttempt.get(certId);
      if (last && Date.now() - last < LAZY_AI_COOLDOWN_MS) return;
      const fk = (await listR2Keys(`images/grading/${certId}/front_cropped`))[0];
      if (!fk) return; // sharp pipeline not finished → nothing to grade yet
      const bk = (await listR2Keys(`images/grading/${certId}/back_cropped`))[0];
      const [fb, bb] = await Promise.all([getR2Buffer(fk), bk ? getR2Buffer(bk) : Promise.resolve(null)]);
      if (!fb) return;
      lazyAiAttempt.set(certId, Date.now());
      // runAiOnCertIfIdle returns null if it raced and a sibling won — grab that
      // sibling's promise from the map so we still await the live run.
      p = runAiOnCertIfIdle(certId, fb, bb) ?? inFlightAutoAi.get(certId) ?? null;
    }
    if (!p) return;

    // Bounded wait: settle when the AI finishes OR the cap elapses (then it keeps
    // running in the background and lands on the next load). Clear the loser timer.
    const timeoutMs = opts.timeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race<"done" | "error" | "timeout">([
      p.then(
        () => "done",
        () => "error"
      ),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      console.warn(
        `[ensure-ai] cert=${certId} still computing after ${timeoutMs}ms — returning; draft lands on next load`
      );
    } else if (outcome === "error") {
      console.error(
        `[ensure-ai] cert=${certId} pre-grade FAILED on open — cert still served, draft absent (backed off ${LAZY_AI_COOLDOWN_MS}ms)`
      );
    } else {
      console.log(`[ensure-ai] cert=${certId} pre-grade computed on open`);
    }
  } catch (e: any) {
    console.error(`[ensure-ai] cert=${certId} failed: ${e?.message ?? e}`);
  }
}

/**
 * Self-heal: restore an EMPTY/"" card_name (+ set_name) from a cert's own
 * CONFIRMED identification snapshot. The on-open identify already wrote the real
 * name to ai_analysis.identification (dbSource "pokemon-tcg-api"); a downstream
 * clobber could have left the card_name COLUMN empty while the snapshot stayed
 * intact. This repairs the column from that snapshot WITHOUT re-running the
 * ~20s AI — deterministic and free. Only fires when:
 *   - the column is genuinely empty (NULL or ""), and
 *   - the snapshot is a CONFIRMED TCG match with a non-empty official name.
 * Never overwrites a non-empty name (MV45-era cards untouched). Never throws.
 * Returns true if it wrote a repair.
 */
export async function repairEmptyIdentityFromSnapshot(certId: number): Promise<boolean> {
  try {
    const row = (await db.execute(sql`SELECT card_name, set_name, ai_analysis FROM certificates WHERE id = ${certId}`))
      .rows[0] as any;
    if (!row) return false;
    const nameEmpty = row.card_name == null || String(row.card_name).trim() === "";
    if (!nameEmpty) return false; // only repair a genuinely missing name

    const ident = row.ai_analysis?.identification;
    if (!ident || ident.dbSource !== "pokemon-tcg-api") return false; // CONFIRMED snapshots only
    const snapName = typeof ident.officialName === "string" ? ident.officialName.trim() : "";
    if (!snapName) return false;
    const snapSet =
      (typeof ident.officialSet === "string" && ident.officialSet.trim()) ||
      (typeof ident.detected_set === "string" && ident.detected_set.trim()) ||
      null;

    const res = await db.execute(sql`
      UPDATE certificates SET
        card_name = CASE WHEN card_name IS NULL OR card_name = '' THEN ${snapName} ELSE card_name END,
        set_name  = CASE WHEN (set_name IS NULL OR set_name = '') AND ${snapSet}::text IS NOT NULL
                         THEN ${snapSet} ELSE set_name END,
        updated_at = NOW()
      WHERE id = ${certId} AND (card_name IS NULL OR card_name = '')
    `);
    const repaired = (res.rowCount ?? 0) > 0;
    if (repaired) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
        VALUES ('certificate', ${String(certId)}, 'identity_repair_from_snapshot', 'system',
          ${JSON.stringify({ card_name: snapName, set_name: snapSet, source: ident.dbSource })}::jsonb, NOW())
      `);
      console.log(`[identity-repair] cert=${certId}: restored card_name="${snapName}" from confirmed snapshot`);
    }
    return repaired;
  } catch (e: any) {
    console.warn(`[identity-repair] cert=${certId} failed: ${e?.message ?? e}`);
    return false;
  }
}
