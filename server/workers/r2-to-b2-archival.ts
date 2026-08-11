/**
 * R2 → B2 cold-archive worker.
 *
 * Copies image objects belonging to certs whose grade was approved more
 * than `ageDays` ago from R2 (hot, expensive) to B2 (cold-tier, with
 * Compliance Object Lock). Marks certificates.archived_to_b2_at on success.
 *
 * Idempotent at the object level: existsInB2(key) skips already-archived
 * objects, so concurrent invocations across Fly machines are safe.
 * Idempotent at the cert level: archived_to_b2_at filter excludes certs
 * already complete; a cert that partially failed last run will be retried
 * (any already-copied objects skipped via existsInB2).
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
import { sql } from "drizzle-orm";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getR2Client } from "../r2";
import { uploadToB2, existsInB2 } from "../b2";

export interface ArchivalSummary {
  certsProcessed: number;
  objectsCopied: number;
  objectsSkipped: number; // already in B2
  bytesCopied: number;
  errors: number;
  dryRun: boolean;
}

interface ArchivalOpts {
  dryRun: boolean;
  batchSize: number;
  ageDays: number;
}

/**
 * List every R2 object under a prefix. Returns key + size for each.
 * Shared helper across the worker; not exported from r2.ts because the
 * archival worker is its only consumer.
 */
async function listR2Prefix(prefix: string): Promise<{ key: string; size: number }[]> {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not set");
  const out: { key: string; size: number }[] = [];
  let token: string | undefined = undefined;
  do {
    const r: any = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const o of (r.Contents ?? [])) {
      if (!o.Key) continue;
      out.push({ key: o.Key, size: o.Size ?? 0 });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * Download an R2 object and return its bytes. Streams under the hood; the
 * full buffer is materialised before upload to B2 so we can pass it to
 * PutObjectCommand without keeping a stream alive across two SDK clients.
 * Typical card image is 1-3 MB; the buffering is fine.
 */
async function downloadR2(key: string): Promise<{ body: Buffer; contentType: string }> {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not set");
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of (r.Body as any)) chunks.push(Buffer.from(chunk));
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
    SELECT id, certificate_number, grade_approved_at,
           front_image_path, back_image_path,
           grading_front_original, grading_back_original
    FROM certificates
    WHERE grade_approved_at < NOW() - (${ageDaysInt}::int * INTERVAL '1 day')
      AND deleted_at IS NULL
      AND archived_to_b2_at IS NULL
    ORDER BY grade_approved_at ASC
    LIMIT ${batchSize}
  `);

  const certs = rows.rows as {
    id: number;
    certificate_number: string;
    grade_approved_at: Date;
    front_image_path: string | null;
    back_image_path: string | null;
    grading_front_original: string | null;
    grading_back_original: string | null;
  }[];
  if (certs.length === 0) {
    console.log(`[archival-b2] no candidates (ageDays=${ageDaysInt}, batchSize=${batchSize})`);
    return summary;
  }
  console.log(`[archival-b2] starting${dryRun ? " (DRY RUN)" : ""}: ${certs.length} certs to evaluate, ageDays=${ageDaysInt}`);

  for (const cert of certs) {
    summary.certsProcessed++;
    const certNumber = cert.certificate_number;
    const certId = cert.id;

    // Prefixes the cert's image artefacts could live under. Both ingest
    // paths still write to all three at various times — see audit
    // 2026-05-11 image pipeline notes.
    // The keys this certificate ITSELF says it depends on.
    //
    // The three prefixes below encode the pre-partner assumption that every certificate's images
    // live under images/{certNumber}/ or grading/{certNumber}/. Partner-origin certificates do not:
    // connector import writes the partner key `partner-submissions/{tenant}/{sub}/{card}/{side}-…`
    // into front_image_path, back_image_path, grading_front_original AND grading_back_original, and
    // that key is enumerated by none of the three. The worker therefore listed nothing, took the
    // "nothing to copy" branch, and stamped archived_to_b2_at on a certificate with ZERO B2 copies.
    //
    // All four columns are read, not just the *_image_path pair: the grading pipeline overwrites
    // front_image_path/back_image_path with derived HQ-namespace keys after a recrop, while
    // grading_*_original keeps pointing at the partner original. Reading only the first pair would
    // miss the original on any cropped certificate.
    const expectedKeys = Array.from(
      new Set(
        [cert.front_image_path, cert.back_image_path, cert.grading_front_original, cert.grading_back_original].filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0
        )
      )
    );

    const prefixes = [
      `images/${certNumber}/`,
      `grading/${certNumber}/`,
      `images/grading/${certId}/`,
      // Exact keys, used as prefixes: ListObjectsV2 returns that one object or nothing. Exact keys
      // rather than the card directory, so what is enumerated is exactly what is asserted below.
      ...expectedKeys,
    ];

    // Dedupe by key — an expected key already covered by a broad prefix would otherwise be listed
    // twice and double-counted in bytesCopied.
    const seenKeys = new Map<string, { key: string; size: number }>();
    try {
      for (const p of prefixes) {
        const objs = await listR2Prefix(p);
        for (const o of objs) if (!seenKeys.has(o.key)) seenKeys.set(o.key, o);
      }
    } catch (e: any) {
      console.warn(`[archival-b2] cert=${certNumber}: R2 list failed: ${e.message}`);
      summary.errors++;
      try {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES ('certificate', ${certNumber}, 'archive_failed', 'system',
            ${JSON.stringify({ stage: "r2_list", error: e.message })}::jsonb)
        `);
      } catch {}
      continue;
    }
    const objectsForThisCert = Array.from(seenKeys.values());

    if (objectsForThisCert.length === 0) {
      if (expectedKeys.length > 0) {
        // The certificate names image keys that do not exist in R2. "Found nothing" is NOT
        // "nothing to back up" here — it is "I could not find what this row says it depends on".
        // Refuse, leave archived_to_b2_at NULL, and let the next tick retry.
        console.warn(
          `[archival-b2] cert=${certNumber}: REFUSING — expected ${expectedKeys.length} object(s), found 0`
        );
        summary.errors++;
        if (!dryRun) {
          try {
            await db.execute(sql`
              INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
              VALUES ('certificate', ${certNumber}, 'archive_failed', 'system',
                ${JSON.stringify({ stage: "expected_keys_missing", expected_keys: expectedKeys, found: 0 })}::jsonb)
            `);
          } catch {}
        }
        continue;
      }
      // Genuinely imageless certificate — no image column is populated, so there is nothing to
      // copy and marking it archived is truthful.
      console.log(`[archival-b2] cert=${certNumber}: no images expected — marking archived`);
      if (!dryRun) {
        await db.execute(sql`
          UPDATE certificates SET archived_to_b2_at = NOW(), updated_at = NOW()
          WHERE id = ${certId}
        `);
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES ('certificate', ${certNumber}, 'archived_to_b2', 'system',
            ${JSON.stringify({ r2_keys_archived: [], total_bytes: 0, note: "no_images_expected" })}::jsonb)
        `);
      }
      continue;
    }

    if (dryRun) {
      const totalBytes = objectsForThisCert.reduce((a, o) => a + o.size, 0);
      const wouldMiss = expectedKeys.filter((k) => !objectsForThisCert.some((o) => o.key === k));
      if (wouldMiss.length > 0) {
        console.warn(`[archival-b2] cert=${certNumber}: WOULD REFUSE — ${wouldMiss.length} expected object(s) absent`);
      }
      console.log(`[archival-b2] cert=${certNumber}: WOULD copy ${objectsForThisCert.length} objects (${(totalBytes / 1024).toFixed(0)} KB)`);
      for (const o of objectsForThisCert) {
        console.log(`[archival-b2]   ${(o.size / 1024).toFixed(0).padStart(6)} KB  ${o.key}`);
      }
      summary.objectsCopied += objectsForThisCert.length;
      summary.bytesCopied += totalBytes;
      continue;
    }

    // Real copy path. Per-object: check existsInB2 first, copy if missing.
    // Any error aborts THIS cert (audit_log archive_failed; archived_to_b2_at
    // not set; cert reappears in next run's candidate set).
    const keysArchived: string[] = [];
    let certBytes = 0;
    let certError: string | null = null;

    for (const obj of objectsForThisCert) {
      try {
        const alreadyThere = await existsInB2(obj.key);
        if (alreadyThere) {
          summary.objectsSkipped++;
          keysArchived.push(obj.key);
          continue;
        }
        const { body, contentType } = await downloadR2(obj.key);
        await uploadToB2(obj.key, body, contentType, 90);
        // uploadToB2 returns its own key argument, so it carries no evidence. existsInB2 is the
        // checkable primitive: it returns false ONLY on a normalised 404 and rethrows auth/network
        // errors, so it cannot mistake a broken connection for "absent". A throw here lands in the
        // existing catch and routes to the existing failure path — no new control flow.
        if (!(await existsInB2(obj.key))) {
          throw new Error(`post-upload verification failed: ${obj.key} not present in B2`);
        }
        summary.objectsCopied++;
        summary.bytesCopied += body.length;
        certBytes += body.length;
        keysArchived.push(obj.key);
      } catch (e: any) {
        certError = `${obj.key}: ${e.message}`;
        console.warn(`[archival-b2] cert=${certNumber}: copy failed for ${obj.key}: ${e.message}`);
        break;
      }
    }

    if (certError) {
      summary.errors++;
      try {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES ('certificate', ${certNumber}, 'archive_failed', 'system',
            ${JSON.stringify({
              stage: "copy",
              error: certError,
              partial_keys_archived: keysArchived,
              partial_bytes: certBytes,
            })}::jsonb)
        `);
      } catch {}
      continue;
    }

    // Gate the success path too, not just the empty branch.
    //
    // Without this, a partner certificate that also has label or derivative objects under
    // images/{certNumber}/ takes THIS path — non-empty result set, everything found was copied —
    // and is marked archived while its partner-submissions/ originals were never touched. Half the
    // repair would leave that silent.
    const missing = expectedKeys.filter((k) => !keysArchived.includes(k));
    if (missing.length > 0) {
      console.warn(
        `[archival-b2] cert=${certNumber}: REFUSING — ${missing.length} expected object(s) not copied`
      );
      summary.errors++;
      try {
        await db.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES ('certificate', ${certNumber}, 'archive_failed', 'system',
            ${JSON.stringify({
              stage: "expected_keys_not_copied",
              expected_keys: expectedKeys,
              missing_keys: missing,
              partial_keys_archived: keysArchived,
            })}::jsonb)
        `);
      } catch {}
      continue;
    }

    // Every required object copied AND verified present in B2 — mark cert complete + audit log.
    await db.execute(sql`
      UPDATE certificates SET archived_to_b2_at = NOW(), updated_at = NOW()
      WHERE id = ${certId}
    `);
    await db.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
      VALUES ('certificate', ${certNumber}, 'archived_to_b2', 'system',
        ${JSON.stringify({
          r2_keys_archived: keysArchived,
          total_bytes: certBytes,
          object_count: keysArchived.length,
        })}::jsonb)
    `);
    console.log(`[archival-b2] cert=${certNumber}: archived ${keysArchived.length} objects (${(certBytes / 1024).toFixed(0)} KB)`);
  }

  console.log(
    `[archival-b2] done${dryRun ? " (DRY RUN)" : ""}: ` +
    `certs=${summary.certsProcessed} copied=${summary.objectsCopied} ` +
    `skipped=${summary.objectsSkipped} bytes=${(summary.bytesCopied / 1024 / 1024).toFixed(2)}MB ` +
    `errors=${summary.errors}`
  );
  return summary;
}
