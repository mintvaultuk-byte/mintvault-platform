/**
 * R2 → B2 cold-archive worker.
 *
 * Copies every object named by the append-only scanner evidence ledger for
 * certs whose grade was approved more than `ageDays` ago from R2 (hot) to B2
 * (cold-tier, with Compliance Object Lock). `archived_to_b2_at` means this
 * ledger snapshot is complete in B2; mutable/reproducible display and grading
 * derivatives are deliberately outside that marker.
 *
 * Idempotent at the object level: an existing B2 key is skipped only after its
 * stored bytes match the R2/ledger size and SHA-256, so concurrent invocations
 * across Fly machines are safe without trusting key existence alone.
 * Idempotent at the cert level: archived_to_b2_at filter excludes certs
 * already complete; a cert that partially failed last run will be retried
 * (any already-copied objects are reverified and skipped).
 *
 * Phase 1: copy only. R2 originals are NOT deleted. Phase 2 (separate PR)
 * will handle R2 tier-down or deletion after a verified-copy window.
 *
 * Age signal: grade_approved_at. The submission-level dispatched_at column
 * lives on a different table and isn't reliably populated yet.
 * TODO: when submissions.shipped_at write path is wired, switch the age
 * column to JOIN submissions.shipped_at for more precise signal.
 */
import { db } from "../db";
import { sql, type SQL } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { getR2Client } from "../r2";
import { extendB2ComplianceRetention, inspectB2ObjectIntegrity, uploadToB2 } from "../b2";

export interface ArchivalSummary {
  certsProcessed: number;
  objectsCopied: number;
  objectsSkipped: number; // already in B2 with verified bytes
  bytesCopied: number;
  errors: number;
  dryRun: boolean;
}

interface ArchivalOpts {
  dryRun: boolean;
  batchSize: number;
  ageDays: number;
}

interface EvidenceLedgerRow {
  id: number;
  side: "front" | "back";
  evidence_class: "NEW_IMMUTABLE_MASTER" | "LEGACY_DERIVED_ONLY";
  object_key: string;
  sha256: string;
  byte_length: string | number;
  working_object_key: string | null;
  working_sha256: string | null;
}

interface ArchiveObject {
  key: string;
  source: "evidence" | "working";
  expectedByteLength: number | null;
  expectedSha256: string | null;
}

interface ArchiveSqlExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

interface ArchiveTransactionExecutor {
  transaction<T>(
    callback: (tx: ArchiveSqlExecutor) => Promise<T>,
    config?: { isolationLevel: "read committed" }
  ): Promise<T>;
}

export interface FinaliseArchiveInput {
  certId: number;
  certNumber: string;
  ledgerFingerprint: Array<
    [
      number,
      EvidenceLedgerRow["side"],
      EvidenceLedgerRow["evidence_class"],
      string,
      string,
      string,
      string | null,
      string | null,
    ]
  >;
  auditDetails: {
    r2_keys_archived: string[];
    total_bytes_verified: number;
    object_count: number;
    evidence_row_count: number;
    verified_objects: Array<{
      key: string;
      byteLength: number;
      sha256: string;
      source: ArchiveObject["source"];
      objectLockMode: "COMPLIANCE";
      objectLockRetainUntil: string;
    }>;
  };
}

const B2_RETENTION_DAYS = 90;
const MILLIS_PER_DAY = 86_400_000;
const NEW_UPLOAD_RETENTION_CLOCK_TOLERANCE_MS = 5 * 60_000;

function requireComplianceRetention(
  key: string,
  object: {
    objectLockMode: string | undefined;
    objectLockRetainUntil: Date | undefined;
  },
  minimumRetainUntilMs: number
): { objectLockMode: "COMPLIANCE"; objectLockRetainUntil: string } {
  if (object.objectLockMode !== "COMPLIANCE") {
    throw new Error(`B2 object ${key} is not protected by observed COMPLIANCE Object Lock`);
  }
  const retainUntilMs = object.objectLockRetainUntil?.getTime();
  if (retainUntilMs === undefined || !Number.isFinite(retainUntilMs) || retainUntilMs <= minimumRetainUntilMs) {
    throw new Error(`B2 object ${key} has missing, expired, or insufficient COMPLIANCE retention`);
  }
  return {
    objectLockMode: "COMPLIANCE",
    objectLockRetainUntil: object.objectLockRetainUntil!.toISOString(),
  };
}

/**
 * Lock the certificate before taking the evidence snapshot used to finalise an
 * archive. Scanner recapture updates the same certificate row in its evidence
 * transaction, so this lock establishes a happens-before edge: after waiting,
 * the fingerprint query runs in a fresh READ COMMITTED statement snapshot.
 * The mark and audit then remain one atomic statement inside this transaction.
 */
export async function finaliseArchiveIfEvidenceUnchanged(
  executor: ArchiveTransactionExecutor,
  input: FinaliseArchiveInput
): Promise<boolean> {
  return executor.transaction(
    async (tx) => {
      const locked = await tx.execute(sql`
      SELECT id
        FROM certificates
       WHERE id = ${input.certId}
         AND deleted_at IS NULL
       FOR UPDATE
    `);
      if (locked.rows.length === 0) return false;

      const completion = await tx.execute(sql`
      WITH current_evidence AS (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_array(
              id, side, evidence_class, object_key, sha256, byte_length::text,
              working_object_key, working_sha256
            )
            ORDER BY id
          ),
          '[]'::jsonb
        ) AS fingerprint
        FROM certificate_image_evidence
        WHERE certificate_id = ${input.certId}
      ), marked AS (
        UPDATE certificates c
           SET archived_to_b2_at = NOW(), updated_at = NOW()
          FROM current_evidence e
         WHERE c.id = ${input.certId}
           AND c.deleted_at IS NULL
           AND c.archived_to_b2_at IS NULL
           AND e.fingerprint = ${JSON.stringify(input.ledgerFingerprint)}::jsonb
        RETURNING c.id
      )
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      SELECT 'certificate', ${input.certNumber}, 'archived_to_b2', 'system',
        ${JSON.stringify(input.auditDetails)}::jsonb
      FROM marked
      RETURNING entity_id
    `);
      return completion.rows.length > 0;
    },
    { isolationLevel: "read committed" }
  );
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function validateEvidenceRow(certId: number, row: EvidenceLedgerRow): ArchiveObject[] {
  const expectedByteLength = Number(row.byte_length);
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0) {
    throw new Error(`evidence row ${row.id} has invalid byte_length`);
  }
  if (!/^[0-9a-f]{64}$/.test(row.sha256)) {
    throw new Error(`evidence row ${row.id} has invalid sha256`);
  }
  if (row.evidence_class === "NEW_IMMUTABLE_MASTER") {
    const expectedKey = `evidence/masters/${certId}/${row.side}/${row.sha256}.tif`;
    if (row.object_key !== expectedKey) {
      throw new Error(`immutable evidence row ${row.id} has non-canonical object_key`);
    }
  } else if (row.evidence_class === "LEGACY_DERIVED_ONLY") {
    const expectedKey = `evidence/legacy/${certId}/${row.side}/${row.sha256}.jpg`;
    if (row.object_key !== expectedKey) {
      throw new Error(`legacy evidence row ${row.id} has non-canonical object_key`);
    }
  } else {
    throw new Error(`evidence row ${row.id} has unsupported evidence_class`);
  }

  const objects: ArchiveObject[] = [
    {
      key: row.object_key,
      source: "evidence",
      expectedByteLength,
      expectedSha256: row.sha256,
    },
  ];
  if (row.working_object_key || row.working_sha256) {
    if (!row.working_object_key || !row.working_sha256 || !/^[0-9a-f]{64}$/.test(row.working_sha256)) {
      throw new Error(`evidence row ${row.id} has incomplete working-object integrity metadata`);
    }
    const expectedWorkingKey = `evidence/working/${certId}/${row.side}/${row.working_sha256}.v1.jpg`;
    if (row.working_object_key !== expectedWorkingKey) {
      throw new Error(`evidence row ${row.id} has non-canonical working_object_key`);
    }
    objects.push({
      key: row.working_object_key,
      source: "working",
      expectedByteLength: null,
      expectedSha256: row.working_sha256,
    });
  }
  return objects;
}

async function recordArchiveFailure(certNumber: string, stage: string, error: string, details = {}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      VALUES ('certificate', ${certNumber}, 'archive_failed', 'system',
        ${JSON.stringify({ stage, error, ...details })}::jsonb)
    `);
  } catch {
    // Archival remains failed even if its diagnostic audit write is unavailable.
  }
}

/**
 * Download an R2 object and return its bytes. Streams under the hood; the
 * full buffer is materialised before upload to B2 so we can pass it to
 * PutObjectCommand without keeping a stream alive across two SDK clients.
 * Immutable scanner TIFFs may approach the 128 MB intake ceiling, so the
 * worker processes one object at a time and releases each buffer before the
 * next certificate.
 */
async function downloadR2(key: string): Promise<{ body: Buffer; contentType: string }> {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not set");
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!r.Body) throw new Error(`R2 object ${key} returned no body`);
  const chunks: Buffer[] = [];
  for await (const chunk of r.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return {
    body: Buffer.concat(chunks),
    contentType: r.ContentType ?? guessContentType(key),
  };
}

/** Fallback content-type when the R2 object lacks one. Keyed off extension. */
function guessContentType(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

/**
 * Archive image objects for certificates older than `ageDays` since grade
 * approval. Idempotent + partial-batch resumable.
 */
export async function archiveStaleImages(opts: ArchivalOpts): Promise<ArchivalSummary> {
  const { dryRun, batchSize, ageDays } = opts;
  const summary: ArchivalSummary = {
    certsProcessed: 0,
    objectsCopied: 0,
    objectsSkipped: 0,
    bytesCopied: 0,
    errors: 0,
    dryRun,
  };

  // Query candidates. Inline the integer literal — Postgres won't take a
  // parameterised INTERVAL. Bounded at batchSize per run; the cron loop
  // catches up over multiple ticks if the backlog grows.
  const ageDaysInt = Math.max(0, Math.floor(ageDays));
  const rows = await db.execute(sql`
    SELECT id, certificate_number, grade_approved_at
    FROM certificates
    WHERE grade_approved_at < NOW() - (${ageDaysInt}::int * INTERVAL '1 day')
      AND deleted_at IS NULL
      AND archived_to_b2_at IS NULL
    ORDER BY grade_approved_at ASC
    LIMIT ${batchSize}
  `);

  const certs = rows.rows as { id: number; certificate_number: string; grade_approved_at: Date }[];
  if (certs.length === 0) {
    console.log(`[archival-b2] no candidates (ageDays=${ageDaysInt}, batchSize=${batchSize})`);
    return summary;
  }
  console.log(
    `[archival-b2] starting${dryRun ? " (DRY RUN)" : ""}: ${certs.length} certs to evaluate, ageDays=${ageDaysInt}`
  );

  for (const cert of certs) {
    summary.certsProcessed++;
    const certNumber = cert.certificate_number;
    const certId = cert.id;

    // The evidence ledger is the authority for scanner evidence. Enumerate
    // every revision (not only current rows), including immutable TIFF masters
    // and their recorded working derivatives. Mutable image/grading prefixes
    // are not evidence authority and are intentionally not part of this marker.
    let ledgerRows: EvidenceLedgerRow[];
    try {
      const evidence = await db.execute(sql`
        SELECT id, side, evidence_class, object_key, sha256, byte_length,
               working_object_key, working_sha256
          FROM certificate_image_evidence
         WHERE certificate_id = ${certId}
         ORDER BY id ASC
      `);
      ledgerRows = evidence.rows as unknown as EvidenceLedgerRow[];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[archival-b2] cert=${certNumber}: evidence ledger query failed: ${message}`);
      summary.errors++;
      if (!dryRun) await recordArchiveFailure(certNumber, "evidence_ledger", message);
      continue;
    }

    if (ledgerRows.length === 0) {
      const message = "required certificate evidence ledger is empty";
      console.warn(`[archival-b2] cert=${certNumber}: ${message} — refusing archived state`);
      summary.errors++;
      if (!dryRun) await recordArchiveFailure(certNumber, "evidence_required", message);
      continue;
    }

    const objectsByKey = new Map<string, ArchiveObject>();
    try {
      for (const row of ledgerRows) {
        for (const object of validateEvidenceRow(certId, row)) objectsByKey.set(object.key, object);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[archival-b2] cert=${certNumber}: evidence ledger invalid: ${message}`);
      summary.errors++;
      if (!dryRun) await recordArchiveFailure(certNumber, "evidence_ledger", message);
      continue;
    }

    const objectsForThisCert = [...objectsByKey.values()];

    if (dryRun) {
      const totalBytes = objectsForThisCert.reduce((total, object) => total + (object.expectedByteLength ?? 0), 0);
      console.log(
        `[archival-b2] cert=${certNumber}: WOULD verify/copy ${objectsForThisCert.length} objects (${(totalBytes / 1024).toFixed(0)} KB known)`
      );
      for (const o of objectsForThisCert) {
        const size = o.expectedByteLength;
        console.log(
          `[archival-b2]   ${size === null ? "     ?" : (size / 1024).toFixed(0).padStart(6)} KB  ${o.key} (${o.source})`
        );
      }
      summary.objectsCopied += objectsForThisCert.length;
      summary.bytesCopied += totalBytes;
      continue;
    }

    // Real copy path. Every R2 source is read and hashed. An existing B2 key is
    // skipped only after its stored bytes match the authoritative source size
    // and SHA-256. A mismatch is never overwritten because B2 Compliance Object
    // Lock makes the existing discrepancy an operator-visible integrity event.
    const keysArchived: string[] = [];
    const verifiedObjects: Array<{
      key: string;
      byteLength: number;
      sha256: string;
      source: ArchiveObject["source"];
      objectLockMode: "COMPLIANCE";
      objectLockRetainUntil: string;
    }> = [];
    let certBytesVerified = 0;
    let certError: string | null = null;

    for (const obj of objectsForThisCert) {
      try {
        const { body, contentType } = await downloadR2(obj.key);
        const actualSha256 = sha256Hex(body);
        if (body.length === 0) throw new Error("R2 object is empty");
        if (obj.expectedByteLength !== null && body.length !== obj.expectedByteLength) {
          throw new Error(`R2 byte length mismatch (ledger=${obj.expectedByteLength}, actual=${body.length})`);
        }
        if (obj.expectedSha256 !== null && actualSha256 !== obj.expectedSha256) {
          throw new Error(`R2 SHA-256 mismatch (ledger=${obj.expectedSha256}, actual=${actualSha256})`);
        }

        const existing = await inspectB2ObjectIntegrity(obj.key);
        let retention: { objectLockMode: "COMPLIANCE"; objectLockRetainUntil: string };
        if (existing.exists) {
          if (existing.byteLength !== body.length || existing.sha256 !== actualSha256) {
            throw new Error(
              `B2 integrity mismatch (expected bytes=${body.length} sha256=${actualSha256}; ` +
                `actual bytes=${existing.byteLength} sha256=${existing.sha256}); refusing locked-object replacement`
            );
          }
          const minimumRetainUntil =
            Date.now() + B2_RETENTION_DAYS * MILLIS_PER_DAY - NEW_UPLOAD_RETENTION_CLOCK_TOLERANCE_MS;
          if (existing.objectLockMode !== "COMPLIANCE") {
            throw new Error(`B2 object ${obj.key} is not protected by observed COMPLIANCE Object Lock`);
          }
          const observedRetainUntil = existing.objectLockRetainUntil?.getTime();
          if (
            observedRetainUntil === undefined ||
            !Number.isFinite(observedRetainUntil) ||
            observedRetainUntil <= minimumRetainUntil
          ) {
            const requestedRetainUntil = new Date(Date.now() + B2_RETENTION_DAYS * MILLIS_PER_DAY);
            await extendB2ComplianceRetention(obj.key, requestedRetainUntil);
            const renewed = await inspectB2ObjectIntegrity(obj.key);
            if (!renewed.exists || renewed.byteLength !== body.length || renewed.sha256 !== actualSha256) {
              throw new Error(`B2 post-retention-renewal integrity verification failed`);
            }
            retention = requireComplianceRetention(obj.key, renewed, minimumRetainUntil);
          } else {
            retention = requireComplianceRetention(obj.key, existing, minimumRetainUntil);
          }
          summary.objectsSkipped++;
        } else {
          const minimumNewRetainUntil =
            Date.now() + B2_RETENTION_DAYS * MILLIS_PER_DAY - NEW_UPLOAD_RETENTION_CLOCK_TOLERANCE_MS;
          await uploadToB2(obj.key, body, contentType, B2_RETENTION_DAYS);
          const uploaded = await inspectB2ObjectIntegrity(obj.key);
          if (!uploaded.exists || uploaded.byteLength !== body.length || uploaded.sha256 !== actualSha256) {
            throw new Error(`B2 post-upload integrity verification failed`);
          }
          retention = requireComplianceRetention(obj.key, uploaded, minimumNewRetainUntil);
          summary.objectsCopied++;
          summary.bytesCopied += body.length;
        }
        certBytesVerified += body.length;
        keysArchived.push(obj.key);
        verifiedObjects.push({
          key: obj.key,
          byteLength: body.length,
          sha256: actualSha256,
          source: obj.source,
          ...retention,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        certError = `${obj.key}: ${message}`;
        console.warn(`[archival-b2] cert=${certNumber}: copy failed for ${obj.key}: ${message}`);
        break;
      }
    }

    if (certError) {
      summary.errors++;
      await recordArchiveFailure(certNumber, "copy", certError, {
        partial_keys_verified: keysArchived,
        partial_bytes_verified: certBytesVerified,
        partial_object_integrity: verifiedObjects,
      });
      continue;
    }

    const ledgerFingerprint: FinaliseArchiveInput["ledgerFingerprint"] = ledgerRows.map((row) => [
      row.id,
      row.side,
      row.evidence_class,
      row.object_key,
      row.sha256,
      String(row.byte_length),
      row.working_object_key,
      row.working_sha256,
    ]);
    try {
      const completed = await finaliseArchiveIfEvidenceUnchanged(db, {
        certId,
        certNumber,
        ledgerFingerprint,
        auditDetails: {
          r2_keys_archived: keysArchived,
          total_bytes_verified: certBytesVerified,
          object_count: keysArchived.length,
          evidence_row_count: ledgerRows.length,
          verified_objects: verifiedObjects,
        },
      });
      if (!completed) {
        throw new Error("evidence ledger changed while archival was in flight");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors++;
      await recordArchiveFailure(certNumber, "finalise", message, {
        keys_verified: keysArchived,
        bytes_verified: certBytesVerified,
        verified_objects: verifiedObjects,
      });
      continue;
    }
    console.log(
      `[archival-b2] cert=${certNumber}: archived ${keysArchived.length} verified objects (${(certBytesVerified / 1024).toFixed(0)} KB)`
    );
  }

  console.log(
    `[archival-b2] done${dryRun ? " (DRY RUN)" : ""}: ` +
      `certs=${summary.certsProcessed} copied=${summary.objectsCopied} ` +
      `skipped=${summary.objectsSkipped} bytes=${(summary.bytesCopied / 1024 / 1024).toFixed(2)}MB ` +
      `errors=${summary.errors}`
  );
  return summary;
}
