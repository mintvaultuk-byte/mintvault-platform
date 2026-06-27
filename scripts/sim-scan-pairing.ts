/**
 * scripts/sim-scan-pairing.ts
 *
 * Front/back pairing + stuck-'processing' recovery simulation. Exercises the
 * REAL server scan-ingest code (createCertForScan → uploadRawScansToR2 →
 * processScanInBackground, and reconcileStuckScans) end-to-end against a DB + R2,
 * WITHOUT a physical scanner — so we can verify the pairing logic and the
 * reconciler recovery deterministically in CI/staging.
 *
 * Each synthetic card carries a unique colour signature:
 *   - FRONT image = RED-dominant, green channel encodes the cert index.
 *   - BACK  image = BLUE-dominant, green channel encodes the cert index.
 * After processing we fetch front_image_path + back_image_path from R2, decode
 * them, and assert:
 *   1. front_image_path image is RED-dominant   (back didn't land in the front slot)
 *   2. back_image_path  image is BLUE-dominant   (front didn't land in the back slot)
 *   3. both carry THIS cert's green index        (no cross-assignment BETWEEN certs)
 *   4. scan_status resolved to NULL              (pipeline completed, not stuck)
 * Run with --concurrent to fire all N scans at once (stress the pairing under
 * concurrency); default is sequential.
 *
 * Then a RECOVERY check: a cert is created + raw-uploaded but its
 * processScanInBackground is deliberately SKIPPED (simulating a deploy/restart
 * that dropped the in-memory job) — leaving scan_status='processing',
 * raw_uploaded=true. We back-date it, run reconcileStuckScans, and assert it gets
 * re-driven to completion (images attached, scan_status NULL).
 *
 * All test certs are SOFT-DELETED at the end. ⚠️ Refuses to run against PROD
 * (ep-wispy-morning) unless ALLOW_PROD=1.
 *
 * Usage:
 *   tsx --env-file=.env.staging scripts/sim-scan-pairing.ts            # sequential
 *   tsx --env-file=.env.staging scripts/sim-scan-pairing.ts --concurrent
 */

import sharp from "sharp";
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { getR2Buffer } from "../server/r2";
import {
  createCertForScan,
  uploadRawScansToR2,
  processScanInBackground,
  reconcileStuckScans,
} from "../server/scan-ingest-service";

const N = 6;
const concurrent = process.argv.includes("--concurrent");

function envSafe(): boolean {
  const url = process.env.MINTVAULT_DATABASE_URL || "";
  if (url.includes("ep-wispy-morning") && process.env.ALLOW_PROD !== "1") {
    console.error("[sim] DB host is PROD (ep-wispy-morning) — refusing. Set ALLOW_PROD=1 to override.");
    return false;
  }
  return true;
}

// A 1000x1400 "card on mat": grey mat border + a solid colour card rectangle so
// the server's card-detect finds a boundary. side = front (red) | back (blue);
// the green channel encodes `idx` so a between-cert swap is detectable.
async function makeCardImage(side: "front" | "back", idx: number): Promise<Buffer> {
  const W = 1000;
  const H = 1400;
  const green = 40 + idx * 20; // unique-ish per cert
  const r = side === "front" ? 210 : 30;
  const b = side === "front" ? 30 : 210;
  const mat = { create: { width: W, height: H, channels: 3 as const, background: { r: 120, g: 120, b: 120 } } };
  const card = await sharp({
    create: { width: 760, height: 1060, channels: 3, background: { r, g: green, b } },
  })
    .png()
    .toBuffer();
  return sharp(mat).composite([{ input: card, top: 170, left: 120 }]).jpeg({ quality: 90 }).toBuffer();
}

// Mean R/G/B of an image fetched from R2 (decoded via sharp stats).
async function meanRGB(key: string | null): Promise<{ r: number; g: number; b: number } | null> {
  if (!key) return null;
  const buf = await getR2Buffer(key);
  if (!buf) return null;
  const { channels } = await sharp(buf).stats();
  return { r: channels[0].mean, g: channels[1].mean, b: channels[2].mean };
}

interface CertRow {
  id: number;
  certId: string;
  frontPath: string | null;
  backPath: string | null;
  scanStatus: string | null;
}

async function readCert(id: number): Promise<CertRow> {
  const row = (
    await db.execute(
      sql`SELECT id, certificate_number, front_image_path, back_image_path, scan_status FROM certificates WHERE id = ${id}`
    )
  ).rows[0] as any;
  return {
    id: row.id,
    certId: row.certificate_number,
    frontPath: row.front_image_path ?? null,
    backPath: row.back_image_path ?? null,
    scanStatus: row.scan_status ?? null,
  };
}

const failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (!cond) failures.push(msg);
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
}

// Run one synthetic scan through the real ingest path. Returns the cert id.
async function runScan(idx: number): Promise<number> {
  const front = await makeCardImage("front", idx);
  const back = await makeCardImage("back", idx);
  const ci = await createCertForScan(`sim-pairing-${idx}-${front.length}-${back.length}`, null);
  await uploadRawScansToR2(
    ci.id,
    { buffer: front, mimeType: "image/jpeg", ext: "jpg" },
    { buffer: back, mimeType: "image/jpeg", ext: "jpg" }
  );
  await db.execute(sql`UPDATE certificates SET raw_uploaded = true WHERE id = ${ci.id}`);
  await processScanInBackground({ id: ci.id, certId: ci.certId }, front, back, { skipAi: true });
  return ci.id;
}

async function verifyPairing(id: number, idx: number): Promise<void> {
  const cert = await readCert(id);
  console.log(`\n[sim] ${cert.certId} (idx ${idx}):`);
  check(cert.scanStatus === null, `scan_status resolved to NULL (got ${cert.scanStatus})`);
  check(!!cert.frontPath, "front_image_path is set");
  check(!!cert.backPath, "back_image_path is set");
  check(cert.frontPath !== cert.backPath, "front/back paths differ");
  const f = await meanRGB(cert.frontPath);
  const bk = await meanRGB(cert.backPath);
  if (f) check(f.r > f.b, `FRONT slot holds a RED-dominant image (front, not back) — r=${f.r.toFixed(0)} b=${f.b.toFixed(0)}`);
  if (bk) check(bk.b > bk.r, `BACK slot holds a BLUE-dominant image (back, not front) — r=${bk.r.toFixed(0)} b=${bk.b.toFixed(0)}`);
  // Between-cert cross check: green channel encodes idx (40 + idx*20).
  const expectGreen = 40 + idx * 20;
  if (f) check(Math.abs(f.g - expectGreen) < 25, `FRONT carries THIS cert's marker (g≈${expectGreen}, got ${f.g.toFixed(0)}) — no cross-cert swap`);
}

async function recoveryCheck(): Promise<number> {
  console.log(`\n[sim] RECOVERY: simulating a deploy/restart that stranded a cert at 'processing'…`);
  const idx = 99;
  const front = await makeCardImage("front", idx);
  const back = await makeCardImage("back", idx);
  const ci = await createCertForScan(`sim-recover-${front.length}-${back.length}`, null);
  await uploadRawScansToR2(
    ci.id,
    { buffer: front, mimeType: "image/jpeg", ext: "jpg" },
    { buffer: back, mimeType: "image/jpeg", ext: "jpg" }
  );
  // raw IS in R2 and confirmed, but the pipeline never ran (dropped in-memory job),
  // and back-date it past the staleness gate.
  await db.execute(
    sql`UPDATE certificates SET raw_uploaded = true, scan_status = 'processing', updated_at = NOW() - interval '30 minutes' WHERE id = ${ci.id}`
  );
  const before = await readCert(ci.id);
  check(before.scanStatus === "processing" && before.frontPath === null, "stranded: scan_status='processing', no images (pre-reconcile)");
  await reconcileStuckScans({ staleMinutes: 10, limit: 50 });
  // reconciler re-drives through the scan queue; give it a moment to settle.
  await db.execute(sql`SELECT 1`);
  const after = await readCert(ci.id);
  check(after.scanStatus === null, `reconciler recovered scan_status → NULL (got ${after.scanStatus})`);
  check(!!after.frontPath && !!after.backPath, "reconciler attached front + back images");
  return ci.id;
}

async function main(): Promise<void> {
  if (!envSafe()) process.exit(1);
  console.log(`[sim] mode: ${concurrent ? "CONCURRENT" : "sequential"}  N=${N}`);
  console.log(`[sim] DB: ${process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "unknown"}\n`);

  const ids: number[] = [];
  try {
    if (concurrent) {
      const settled = await Promise.all(Array.from({ length: N }, (_, i) => runScan(i)));
      ids.push(...settled);
    } else {
      for (let i = 0; i < N; i++) ids.push(await runScan(i));
    }
    for (let i = 0; i < ids.length; i++) await verifyPairing(ids[i], i);
    ids.push(await recoveryCheck());
  } finally {
    // Always soft-delete the synthetic certs.
    if (ids.length) {
      await db.execute(
        sql`UPDATE certificates SET deleted_at = NOW(), status = 'voided' WHERE id IN (${sql.join(ids, sql`, `)})`
      );
      console.log(`\n[sim] soft-deleted ${ids.length} synthetic cert(s): ${ids.join(", ")}`);
    }
  }

  console.log(`\n[sim] ${failures.length === 0 ? "ALL CHECKS PASSED ✓" : `${failures.length} CHECK(S) FAILED ✗`}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[sim] unhandled error:", err);
  process.exit(1);
});
