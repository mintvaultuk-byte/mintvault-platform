/**
 * scripts/cleanup-stuck-scan-certs.ts
 *
 * Triage + cleanup for the muddled/stuck scan certs from the scan-ingest incident
 * (default set: 270,273,285,286,291-297). Classifies each cert by what's actually
 * in the DB + R2, and proposes the right action. DRY-RUN by default — writes
 * NOTHING without --commit (bulk rule: review the dry-run first).
 *
 * Classification per cert:
 *   RECOVERABLE  — raw_front IS in R2 but images missing / scan_status≠clean.
 *                  The reconciler fix re-drives these automatically once deployed;
 *                  --commit can also re-drive now (processScanInBackground from raw).
 *   EMPTY        — no raw in R2 AND no image paths. Nothing to recover → soft-delete.
 *   CROSSED?     — BOTH image paths present (cert looks complete). Can't be auto-
 *                  verified here (front/back correctness is visual) → FLAG for a
 *                  human to eyeball on the cert page. NEVER auto-rewritten.
 *   COMPLETE     — both images present AND already graded/approved → leave alone.
 *
 * --commit actions:
 *   EMPTY      → soft-delete (deleted_at + status='voided') + audit row.
 *   RECOVERABLE→ re-drive via reconcileStuckScans-style processScanInBackground
 *                from retained R2 raw (idempotent) + audit row.
 *   CROSSED?/COMPLETE → reported only, never written (human decision).
 *
 * ⚠️ Refuses to run mutations against PROD (ep-wispy-morning) unless ALLOW_PROD=1.
 * Confirm the host printed at startup before --commit.
 *
 * Usage:
 *   tsx --env-file=.env scripts/cleanup-stuck-scan-certs.ts                 # dry-run, default set
 *   tsx --env-file=.env scripts/cleanup-stuck-scan-certs.ts 270,296,297     # dry-run, custom set
 *   tsx --env-file=.env scripts/cleanup-stuck-scan-certs.ts --commit        # write
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { listR2Keys, getR2Buffer } from "../server/r2";
import { processScanInBackground } from "../server/scan-ingest-service";

const COMMIT = process.argv.includes("--commit");
const DEFAULT_SET = [270, 273, 285, 286, 291, 292, 293, 294, 295, 296, 297];

function parseSet(): number[] {
  const arg = process.argv.slice(2).find((a) => /^[\d,]+$/.test(a));
  if (!arg) return DEFAULT_SET;
  return arg.split(",").map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));
}

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  if (COMMIT && url.includes("ep-wispy-morning") && process.env.ALLOW_PROD !== "1") {
    console.error("[cleanup] --commit against PROD (ep-wispy-morning) refused. Set ALLOW_PROD=1 to override.");
    return false;
  }
  return true;
}

type Klass = "RECOVERABLE" | "EMPTY" | "CROSSED?" | "COMPLETE";

interface Triage {
  certNum: string;
  id: number;
  scanStatus: string | null;
  rawUploaded: boolean;
  frontPath: string | null;
  backPath: string | null;
  approved: boolean;
  deleted: boolean;
  rawFrontInR2: boolean;
  klass: Klass;
}

async function triage(certNum: number): Promise<Triage | null> {
  const num = `MV${certNum}`;
  const row = (
    await db.execute(sql`
      SELECT id, certificate_number, scan_status, raw_uploaded, front_image_path, back_image_path,
             grade_approved_at, deleted_at
      FROM certificates WHERE certificate_number = ${num} LIMIT 1`)
  ).rows[0] as any;
  if (!row) {
    console.log(`  ${num}: NOT FOUND`);
    return null;
  }
  const rawFront = await listR2Keys(`images/grading/${row.id}/raw_front`);
  const frontPath = row.front_image_path ?? null;
  const backPath = row.back_image_path ?? null;
  const rawFrontInR2 = rawFront.length > 0;
  const approved = row.grade_approved_at != null;
  const deleted = row.deleted_at != null;

  let klass: Klass;
  if (frontPath && backPath) klass = approved ? "COMPLETE" : "CROSSED?";
  else if (rawFrontInR2) klass = "RECOVERABLE";
  else klass = "EMPTY";

  return {
    certNum: num,
    id: row.id,
    scanStatus: row.scan_status ?? null,
    rawUploaded: row.raw_uploaded === true,
    frontPath,
    backPath,
    approved,
    deleted,
    rawFrontInR2,
    klass,
  };
}

async function softDelete(t: Triage): Promise<void> {
  await db.execute(
    sql`UPDATE certificates SET deleted_at = NOW(), status = 'voided', updated_at = NOW()
        WHERE id = ${t.id} AND deleted_at IS NULL`
  );
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
    VALUES ('certificate', ${t.certNum}, 'scan_cleanup_soft_delete', 'system',
      ${JSON.stringify({ reason: "empty shell — no raw in R2, no images; scan-ingest incident cleanup", scan_status: t.scanStatus })}::jsonb,
      NOW())
  `);
}

async function redrive(t: Triage): Promise<void> {
  const fk = (await listR2Keys(`images/grading/${t.id}/raw_front`))[0];
  const bk = (await listR2Keys(`images/grading/${t.id}/raw_back`))[0];
  const frontBuf = fk ? await getR2Buffer(fk) : null;
  const backBuf = bk ? await getR2Buffer(bk) : null;
  if (!frontBuf) throw new Error("raw_front vanished from R2");
  await processScanInBackground({ id: t.id, certId: t.certNum }, frontBuf, backBuf, { skipAi: true });
  await db.execute(sql`
    INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details, created_at)
    VALUES ('certificate', ${t.certNum}, 'scan_cleanup_redrive', 'system',
      ${JSON.stringify({ reason: "re-drove interrupted pipeline from retained R2 raw; scan-ingest incident cleanup" })}::jsonb,
      NOW())
  `);
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);
  const set = parseSet();
  console.log(`[cleanup] mode: ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
  console.log(`[cleanup] DB: ${process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "unknown"}`);
  console.log(`[cleanup] certs: ${set.map((n) => "MV" + n).join(", ")}\n`);

  const triaged: Triage[] = [];
  for (const n of set) {
    const t = await triage(n);
    if (!t) continue;
    triaged.push(t);
    const action =
      t.deleted ? "already soft-deleted — skip"
      : t.klass === "EMPTY" ? "→ SOFT-DELETE"
      : t.klass === "RECOVERABLE" ? "→ RE-DRIVE from R2 raw"
      : t.klass === "CROSSED?" ? "→ FLAG for human visual check (front/back may be swapped)"
      : "→ leave (complete/approved)";
    console.log(
      `  ${t.certNum} [${t.klass}] scan_status=${t.scanStatus ?? "null"} raw_uploaded=${t.rawUploaded} ` +
        `front=${t.frontPath ? "set" : "NULL"} back=${t.backPath ? "set" : "NULL"} rawInR2=${t.rawFrontInR2}  ${action}`
    );
  }

  if (!COMMIT) {
    console.log(`\n[cleanup] DRY-RUN — nothing written. Re-run with --commit to apply SOFT-DELETE + RE-DRIVE actions.`);
    console.log(`[cleanup] CROSSED?/COMPLETE certs are never auto-written — review them on the cert page.`);
    process.exit(0);
  }

  let deleted = 0, redriven = 0, flagged = 0, errors = 0;
  for (const t of triaged) {
    if (t.deleted) continue;
    try {
      if (t.klass === "EMPTY") { await softDelete(t); deleted++; console.log(`  ✓ ${t.certNum} soft-deleted`); }
      else if (t.klass === "RECOVERABLE") { await redrive(t); redriven++; console.log(`  ✓ ${t.certNum} re-driven`); }
      else { flagged++; console.log(`  • ${t.certNum} flagged (no auto-write)`); }
    } catch (e: any) {
      errors++;
      console.error(`  ✗ ${t.certNum}: ${e?.message ?? e}`);
    }
  }
  console.log(`\n[cleanup] DONE — soft-deleted=${deleted} re-driven=${redriven} flagged=${flagged} errors=${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[cleanup] unhandled error:", err);
  process.exit(1);
});
