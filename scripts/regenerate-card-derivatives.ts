/**
 * Explicit, auditable regeneration of card DISPLAY DERIVATIVES from the intact
 * *_original assets. Built for the front-crop content-loss repair (MV602/MV608/
 * MV609) and safe to reuse for any certificate whose derivatives were produced
 * before the crop-integrity gate existed.
 *
 * Hard safety properties:
 *   - Targets EXPLICIT certificate numbers only. No scan, no "all", no globs.
 *   - DRY RUN by default. Writes require --apply.
 *   - Never writes a raw_* or *_original key (deny-listed at the PUT boundary,
 *     so a future edit cannot accidentally overwrite an original).
 *   - Aborts on a missing asset or on any certificate-identity mismatch.
 *   - Idempotent: derivative keys are deterministic, so a second apply run
 *     rewrites byte-equivalent content for unchanged inputs.
 *   - Bounded: one certificate at a time, sequential, no parallel fan-out.
 *
 * Usage:
 *   tsx scripts/regenerate-card-derivatives.ts MV602 MV608 MV609
 *   tsx scripts/regenerate-card-derivatives.ts MV602 --apply
 */
import { createHash } from "node:crypto";
import type { CropIntegrityReport } from "../server/image-processing";

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Keys that must NEVER be written by this script. Covers every image
 *  extension present or plausible in production, not just the JPEG path. */
export const PROTECTED_KEY_PATTERNS = [
  /(^|\/)raw_(front|back)\.[a-z0-9]+$/i,
  /_original\.(jpg|jpeg|png|webp|tif|tiff)$/i,
];

export function isProtectedKey(key: string): boolean {
  return PROTECTED_KEY_PATTERNS.some((re) => re.test(key));
}

export interface CertRow {
  id: number;
  certificate_number: string;
  grading_front_original: string | null;
  grading_back_original: string | null;
  /** DESTINATION keys — the keys the application actually serves. */
  grading_front_cropped: string | null;
  grading_front_display: string | null;
  front_image_path: string | null;
  grading_back_cropped: string | null;
  grading_back_display: string | null;
  back_image_path: string | null;
}

/**
 * Production contains at least two storage-key schemes:
 *   A  images/grading/{id}/front_cropped.jpg   +  images/{CERT}/front.png
 *   B  grading/{CERT}/front_cropped.jpg        +  images/{CERT}/front.jpg
 * In a 500-certificate read-only sample, scheme B accounted for 77%. The first
 * implementation hardcoded scheme A, so `--apply` wrote orphan objects nobody
 * reads and still reported success.
 *
 * Destination keys are therefore taken from the DATABASE COLUMNS — never
 * constructed — and each is validated as belonging to this certificate.
 */
export function keyBelongsToCert(key: string, certId: number, certNumber: string): boolean {
  const idSeg = `/${certId}/`;
  const certSeg = `/${certNumber}/`;
  return key.includes(idSeg) || key.includes(certSeg) || key.startsWith(`grading/${certNumber}/`);
}

export interface ResolvedTarget {
  label: string;
  key: string;
  kind: "cropped" | "viewer" | "public";
  side: "front" | "back";
}

/** Resolve every destination key from the row. Fails closed on anything odd. */
export function resolveTargets(row: CertRow): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  const add = (label: string, key: string | null, kind: ResolvedTarget["kind"], side: ResolvedTarget["side"]) => {
    if (!key) return;
    if (!keyBelongsToCert(key, row.id, row.certificate_number)) {
      throw new RegenerationError(
        `Unrecognised key scheme for ${row.certificate_number}: "${key}" does not reference this certificate — refusing (fail closed)`
      );
    }
    if (isProtectedKey(key)) {
      throw new RegenerationError(`Destination "${key}" is a protected original/raw asset — refusing`);
    }
    out.push({ label, key, kind, side });
  };
  add("front_cropped", row.grading_front_cropped, "cropped", "front");
  add("front_viewer", row.grading_front_display, "viewer", "front");
  add("front_public", row.front_image_path, "public", "front");
  if (row.grading_back_original) {
    add("back_cropped", row.grading_back_cropped, "cropped", "back");
    add("back_viewer", row.grading_back_display, "viewer", "back");
    add("back_public", row.back_image_path, "public", "back");
  }
  if (!out.some((t) => t.side === "front")) {
    throw new RegenerationError(`${row.certificate_number}: no front destination keys in the database — refusing`);
  }
  return out;
}

/** Choose the encoding for a destination key from its OWN extension, so a
 *  scheme-B `.jpg` public path is not silently replaced with a PNG. */
export function encodingForKey(key: string): { body: "png" | "jpeg"; contentType: string } {
  return /\.png$/i.test(key) ? { body: "png", contentType: "image/png" } : { body: "jpeg", contentType: "image/jpeg" };
}

export interface RegenDeps {
  /** Look up ONE certificate by its exact number. */
  loadCert(certNumber: string): Promise<CertRow | null>;
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Persist crop_geometry diagnostics for a cert. */
  saveDiagnostics(certId: number, diagnostics: unknown): Promise<void>;
  /** Append an audit row describing what was regenerated. */
  audit(certId: number, certNumber: string, details: unknown): Promise<void>;
  /** Full display pipeline for one face. */
  buildFace(
    originalJpeg: Buffer,
    certNumber: string,
    side: "front" | "back"
  ): Promise<{
    tightened: Buffer;
    displayPng: Buffer;
    displayJpeg: Buffer;
    viewerJpeg: Buffer;
    report: CropIntegrityReport;
    before: { w: number; h: number };
    after: { w: number; h: number };
  }>;
  crossFace(
    front: CropIntegrityReport,
    back: CropIntegrityReport | null
  ): { consistent: boolean; aspectDelta: number; reasons: string[]; rollback: "front" | "back" | null };
  log(line: string): void;
}

export interface RegenResult {
  certNumber: string;
  certId: number;
  applied: boolean;
  faces: Record<string, { before: { w: number; h: number }; after: { w: number; h: number }; decision: string; reasons: string[]; fallback: string }>;
  writtenKeys: string[];
  crossFace: { consistent: boolean; aspectDelta: number; reasons: string[]; rollback: "front" | "back" | null };
  /** Keys read back and byte-verified after writing. */
  verified: string[];
  /** The destination keys resolved from the DB, shown in dry run. */
  resolvedKeys: string[];
}

export class RegenerationError extends Error {}

export async function regenerateCertificate(
  certNumber: string,
  deps: RegenDeps,
  opts: { apply: boolean }
): Promise<RegenResult> {
  const normalised = certNumber.trim().toUpperCase();
  if (!/^MV\d+$/.test(normalised)) {
    throw new RegenerationError(`Refusing non-normalised certificate number "${certNumber}" (expected MV<digits>)`);
  }
  const row = await deps.loadCert(normalised);
  if (!row) throw new RegenerationError(`Certificate ${normalised} not found`);
  // Identity guard: the row we mutate must be the row we asked for.
  if (row.certificate_number.trim().toUpperCase() !== normalised) {
    throw new RegenerationError(
      `Certificate identity mismatch: asked for ${normalised}, loaded ${row.certificate_number}`
    );
  }
  if (!row.grading_front_original) {
    throw new RegenerationError(`${normalised}: grading_front_original is missing — cannot regenerate safely`);
  }

  const faces: RegenResult["faces"] = {};
  const writtenKeys: string[] = [];

  // Sources must belong to this certificate too, not just the destinations.
  for (const src of [row.grading_front_original, row.grading_back_original]) {
    if (src && !keyBelongsToCert(src, row.id, row.certificate_number)) {
      throw new RegenerationError(`Source "${src}" does not reference ${normalised} — refusing`);
    }
  }
  // Resolve destinations from the DATABASE, never from a naming convention.
  const targets = resolveTargets(row);

  const frontOriginal = await deps.getObject(row.grading_front_original);
  const front = await deps.buildFace(frontOriginal, normalised, "front");
  faces.front = {
    before: front.before,
    after: front.after,
    decision: front.report.decision,
    reasons: front.report.reasons,
    fallback: front.report.fallback,
  };

  let back: Awaited<ReturnType<RegenDeps["buildFace"]>> | null = null;
  if (row.grading_back_original) {
    const backOriginal = await deps.getObject(row.grading_back_original);
    back = await deps.buildFace(backOriginal, normalised, "back");
    faces.back = {
      before: back.before,
      after: back.after,
      decision: back.report.decision,
      reasons: back.report.reasons,
      fallback: back.report.fallback,
    };
  }

  const cross = deps.crossFace(front.report, back ? back.report : null);

  deps.log(
    `${normalised} (id ${row.id})  front ${front.before.w}x${front.before.h} -> ${front.after.w}x${front.after.h}` +
      ` [${front.report.decision}${front.report.reasons.length ? " " + front.report.reasons.join(",") : ""}]` +
      (back ? `  back ${back.before.w}x${back.before.h} -> ${back.after.w}x${back.after.h} [${back.report.decision}]` : "  back: none") +
      `  cross-face ${cross.consistent ? "ok" : "INCONSISTENT " + cross.reasons.join(",")}`
  );

  // Body for a destination is chosen by the destination's OWN extension.
  const bodyFor = (t: ResolvedTarget): { body: Buffer; contentType: string } => {
    const face = t.side === "front" ? front : back;
    if (!face) throw new RegenerationError(`No built face for ${t.label}`);
    const enc = encodingForKey(t.key);
    if (t.kind === "viewer") return { body: face.viewerJpeg, contentType: "image/jpeg" };
    if (enc.body === "png") return { body: face.displayPng, contentType: "image/png" };
    return { body: face.displayJpeg, contentType: "image/jpeg" };
  };

  const planned = targets.map((t) => ({ target: t, ...bodyFor(t) }));
  for (const p of planned) {
    if (isProtectedKey(p.target.key)) throw new RegenerationError(`Refusing to write protected key ${p.target.key}`);
  }

  // Old hashes for the audit trail (best-effort; a missing object is fine).
  const oldHashes: Record<string, string> = {};
  for (const p of planned) {
    try {
      oldHashes[p.target.key] = sha256(await deps.getObject(p.target.key));
    } catch {
      oldHashes[p.target.key] = "(absent)";
    }
  }

  if (!opts.apply) {
    for (const p of planned) {
      deps.log(`  DRY RUN would write ${p.target.label} -> ${p.target.key} (${p.body.length} bytes, ${p.contentType})`);
    }
    return {
      certNumber: normalised, certId: row.id, applied: false, faces, writtenKeys: [], crossFace: cross,
      verified: [], resolvedKeys: targets.map((t) => `${t.label}=${t.key}`),
    };
  }

  for (const p of planned) {
    await deps.putObject(p.target.key, p.body, p.contentType);
    writtenKeys.push(p.target.key);
    deps.log(`  wrote ${p.target.label} -> ${p.target.key} (${p.body.length} bytes)`);
  }

  // POST-WRITE VERIFICATION: read every served key back and prove the bytes are
  // the ones we generated. Without this the previous implementation could write
  // orphan objects and still report success.
  const verified: string[] = [];
  for (const p of planned) {
    const readBack = await deps.getObject(p.target.key);
    const want = sha256(p.body);
    const got = sha256(readBack);
    if (want !== got) {
      throw new RegenerationError(
        `Post-write verification FAILED for ${p.target.key}: expected sha ${want.slice(0, 12)}, read ${got.slice(0, 12)}`
      );
    }
    verified.push(p.target.key);
  }
  if (verified.length !== planned.length) {
    throw new RegenerationError(`Only ${verified.length}/${planned.length} destinations verified — refusing to report success`);
  }

  await deps.saveDiagnostics(row.id, {
    tighten: { front: front.report, back: back ? back.report : null, cross_face: cross },
    regenerated_at: new Date().toISOString(),
    regenerated_keys: verified,
  });
  await deps.audit(row.id, normalised, {
    mode: "apply",
    certificate: { id: row.id, number: normalised },
    sources: { front: row.grading_front_original, back: row.grading_back_original },
    destinations: planned.map((p) => ({
      label: p.target.label, key: p.target.key,
      oldHash: oldHashes[p.target.key], newHash: sha256(p.body), bytes: p.body.length,
    })),
    verified, faces, crossFace: cross,
  });

  return { certNumber: normalised, certId: row.id, applied: true, faces, writtenKeys, crossFace: cross, verified,
           resolvedKeys: targets.map((t) => `${t.label}=${t.key}`) };
}

/** Parse argv into explicit targets + apply flag. Refuses an empty target set. */
export function parseRegenArgs(argv: string[]): { targets: string[]; apply: boolean } {
  const apply = argv.includes("--apply");
  const targets = argv.filter((a) => !a.startsWith("--"));
  if (targets.length === 0) {
    throw new RegenerationError(
      "No certificate numbers given. This tool never operates on an implicit set — pass them explicitly."
    );
  }
  return { targets, apply };
}

/** Production dependency wiring. Kept out of the pure logic above so the logic
 *  is testable with in-memory fakes and no network. */
async function buildLiveDeps(): Promise<RegenDeps> {
  const sharpMod = (await import("sharp")).default;
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");
  const { uploadToR2, getR2Client } = await import("../server/r2");
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { generateImageVariants } = await import("../server/ai-grading-service");
  const {
    tightenForDisplay,
    maskRoundedCorners,
    makeDisplayDerivative,
    emptyCropIntegrityReport,
    evaluateCrossFaceConsistency,
  } = await import("../server/image-processing");

  const dimsOf = async (b: Buffer) => {
    const m = await sharpMod(b).metadata();
    return { w: m.width ?? 0, h: m.height ?? 0 };
  };

  return {
    async loadCert(certNumber) {
      const rows = (
        await db.execute(sql`
          SELECT id, certificate_number, grading_front_original, grading_back_original,
                 grading_front_cropped, grading_front_display, front_image_path,
                 grading_back_cropped, grading_back_display, back_image_path
          FROM certificates WHERE certificate_number = ${certNumber} AND deleted_at IS NULL LIMIT 2`)
      ).rows as unknown as CertRow[];
      if (rows.length > 1) throw new RegenerationError(`${certNumber} matched ${rows.length} rows — refusing`);
      return rows[0] ?? null;
    },
    async getObject(key) {
      const s3 = getR2Client();
      const res = await s3.send(
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME as string, Key: key })
      );
      const chunks: Buffer[] = [];
      for await (const c of res.Body as AsyncIterable<Buffer>) chunks.push(c);
      return Buffer.concat(chunks);
    },
    async putObject(key, body, contentType) {
      if (isProtectedKey(key)) throw new RegenerationError(`blocked protected key ${key}`);
      await uploadToR2(key, body, contentType);
    },
    async saveDiagnostics(certId, diagnostics) {
      await db.execute(
        sql`UPDATE certificates SET crop_geometry = COALESCE(crop_geometry, '{}'::jsonb) || ${JSON.stringify(
          diagnostics
        )}::jsonb, updated_at = NOW() WHERE id = ${certId} AND deleted_at IS NULL`
      );
    },
    async audit(certId, certNumber, details) {
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
        VALUES ('certificate', ${String(certId)}, 'derivative_regenerated', 'regenerate-card-derivatives',
                ${JSON.stringify({ certNumber, ...(details as Record<string, unknown>) })}::jsonb)`);
    },
    async buildFace(originalJpeg, certNumber, side) {
      const before = await dimsOf(originalJpeg);
      const variants = await generateImageVariants(originalJpeg, `${certNumber}-${side}`);
      const safeSource = variants.centredUnpadded ?? variants.cropped;
      const report = emptyCropIntegrityReport(side);
      const tightened = await tightenForDisplay(safeSource, certNumber, undefined, side, report);
      const masked = await maskRoundedCorners(tightened);
      const displayPng = await sharpMod(masked).png({ compressionLevel: 9 }).toBuffer();
      const displayJpeg = await sharpMod(masked)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
        .toBuffer();
      const viewerJpeg = await makeDisplayDerivative(displayJpeg);
      return { tightened, displayPng, displayJpeg, viewerJpeg, report, before, after: await dimsOf(tightened) };
    },
    crossFace(front, back) {
      const v = evaluateCrossFaceConsistency(
        front.accepted && front.trimFraction ? { aspect: front.accepted.aspect, trimFraction: front.trimFraction } : null,
        back && back.accepted && back.trimFraction
          ? { aspect: back.accepted.aspect, trimFraction: back.trimFraction }
          : null
      );
      return { consistent: v.consistent, aspectDelta: v.aspectDelta, reasons: v.reasons, rollback: v.rollback };
    },
    log(line) {
      console.log(line);
    },
  };
}

async function main(): Promise<void> {
  const { targets, apply } = parseRegenArgs(process.argv.slice(2));
  console.log(
    `regenerate-card-derivatives: ${targets.length} target(s) [${targets.join(", ")}] mode=${apply ? "APPLY" : "DRY RUN"}`
  );
  if (!apply) console.log("(dry run — no object or database writes. Re-run with --apply to execute.)");
  const deps = await buildLiveDeps();
  for (const t of targets) {
    const r = await regenerateCertificate(t, deps, { apply });
    console.log(`  → ${r.certNumber}: applied=${r.applied} keys=${r.writtenKeys.length}`);
  }
  console.log("done.");
}

// Only run when invoked directly — importing this module must never execute it.
const invokedDirectly = process.argv[1] ? /regenerate-card-derivatives\.(ts|cjs|js)$/.test(process.argv[1]) : false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err).replace(/postgres(ql)?:\/\/\S+/gi, "[redacted]"));
    process.exit(1);
  });
}
