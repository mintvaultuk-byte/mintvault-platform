/**
 * scripts/backfill-cert-metadata.ts
 *
 * One-off backfill for the 4 approved certs that were published before
 * AI Identify ran on them. Per docs/corpus-capture-audit.md (2026-05-07),
 * these are MV20, MV21, MV41, MV44 — all with NULL card_name / set_name
 * / card_number_display / rarity / year_text but populated front images.
 *
 * Approach: fetch grading_front_original from R2 → call the existing
 * identifyCardFromBuffer (Claude Haiku + optional GPT reconciliation) →
 * cross-check via verifyAndEnrichCardData (TCG API) → write the result
 * IF confidence is high or medium. Skip on low confidence; never write
 * a guess. Each successful update is mirrored to audit_log with the full
 * before/after + identification payload for forensic review.
 *
 * Modes:
 *   DRY_RUN=true npx tsx --env-file=.env scripts/backfill-cert-metadata.ts
 *     Reports what each cert would be updated with. NO DB writes.
 *   npx tsx --env-file=.env scripts/backfill-cert-metadata.ts
 *     Live run. Updates each qualifying cert + audit_log row.
 *
 * Re-run safety: only writes columns that are currently NULL. A re-run
 * after a partial success won't clobber any field already populated.
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { certificates } from "../shared/schema";
import { identifyCardFromBuffer, verifyAndEnrichCardData } from "../server/ai-grading-service";
import { getR2Client } from "../server/r2";

const TARGETS = ["MV20", "MV21", "MV41", "MV44"];
const DRY_RUN = process.env.DRY_RUN === "true";

const DATABASE_URL = process.env.MINTVAULT_DATABASE_URL;
if (!DATABASE_URL) { console.error("MINTVAULT_DATABASE_URL not set"); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool);

async function fetchR2Buffer(key: string): Promise<Buffer> {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not set");
  const client = getR2Client();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`Empty body for R2 key: ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface BackfillResult {
  certId: string;
  status: "would-update" | "updated" | "skipped" | "failed";
  reason?: string;
  before: Record<string, string | null>;
  after?: Record<string, string | null>;
  identification?: {
    confidence: string;
    detected_name: string;
    detected_set: string;
    detected_number: string | null;
    detected_year: string | null;
    detected_rarity: string | null;
    verified: boolean;
    dbSource: string | null;
  };
}

function pickValue<T>(existing: T | null, suggested: T | null | undefined): T | null {
  // Only fill NULLs. Never overwrite existing non-null data — re-run safety.
  if (existing != null && existing !== "") return existing;
  if (suggested == null || suggested === "") return null;
  return suggested;
}

async function processCert(certId: string): Promise<BackfillResult> {
  const [cert] = await db.select().from(certificates).where(eq(certificates.certId, certId)).limit(1);
  if (!cert) {
    return { certId, status: "failed", reason: "cert not found", before: {} };
  }
  const before = {
    card_name:           cert.cardName,
    set_name:            cert.setName,
    card_number_display: cert.cardNumber,
    rarity:              cert.rarity,
    year_text:           cert.year,
  };

  const imageKey = cert.gradingFrontOriginal || cert.frontImagePath;
  if (!imageKey) {
    return { certId, status: "failed", reason: "no front image key on cert", before };
  }

  let buffer: Buffer;
  try {
    buffer = await fetchR2Buffer(imageKey);
  } catch (err: any) {
    return { certId, status: "failed", reason: `R2 fetch failed (${imageKey}): ${err.message}`, before };
  }

  let identified;
  try {
    identified = await identifyCardFromBuffer(buffer, "image/jpeg", certId);
  } catch (err: any) {
    return { certId, status: "failed", reason: `identify failed: ${err.message}`, before };
  }

  // Confidence gate — accept high or medium; skip low. The brief asked for
  // a numeric ">0.6" threshold but the underlying enum is high/medium/low,
  // so the obvious mapping is (high|medium) = pass.
  if (identified.confidence === "low") {
    return {
      certId,
      status: "skipped",
      reason: `confidence=low (Claude reasoning: ${(identified.reasoning || "").slice(0, 120)})`,
      before,
      identification: {
        confidence:        identified.confidence,
        detected_name:     identified.detected_name,
        detected_set:      identified.detected_set,
        detected_number:   identified.detected_number,
        detected_year:     identified.copyright_year || identified.detected_year,
        detected_rarity:   identified.detected_rarity,
        verified:          false,
        dbSource:          null,
      },
    };
  }

  // Cross-check via TCG API (verifyAndEnrichCardData). When verified: true,
  // the official* fields are authoritative; when false, falls back to the
  // raw AI strings.
  let enriched;
  try {
    enriched = await verifyAndEnrichCardData(identified);
  } catch {
    // Lookup failed — degrade to AI-only values (verifyAndEnrichCardData
    // already does this internally, but just in case it throws).
    enriched = {
      ...identified,
      verified: false,
      officialName:   identified.detected_name,
      officialSet:    identified.detected_set,
      officialNumber: identified.detected_number,
      referenceImageUrl: null,
      dbSource: null as string | null,
    };
  }

  const proposed = {
    card_name:           pickValue(cert.cardName,    enriched.officialName),
    set_name:            pickValue(cert.setName,     enriched.officialSet),
    card_number_display: pickValue(cert.cardNumber,  enriched.officialNumber),
    rarity:              pickValue(cert.rarity,      identified.detected_rarity),
    year_text:           pickValue(cert.year,        identified.copyright_year || identified.detected_year),
  };

  // If nothing actually changes (all proposed === existing), report as skip.
  const changed = (Object.keys(proposed) as (keyof typeof proposed)[])
    .filter(k => proposed[k] !== before[k as keyof typeof before]);
  if (changed.length === 0) {
    return {
      certId,
      status: "skipped",
      reason: "no field needs filling",
      before,
      identification: {
        confidence:      identified.confidence,
        detected_name:   identified.detected_name,
        detected_set:    identified.detected_set,
        detected_number: identified.detected_number,
        detected_year:   identified.copyright_year || identified.detected_year,
        detected_rarity: identified.detected_rarity,
        verified:        enriched.verified,
        dbSource:        enriched.dbSource,
      },
    };
  }

  if (DRY_RUN) {
    return {
      certId,
      status: "would-update",
      before,
      after: proposed,
      identification: {
        confidence:      identified.confidence,
        detected_name:   identified.detected_name,
        detected_set:    identified.detected_set,
        detected_number: identified.detected_number,
        detected_year:   identified.copyright_year || identified.detected_year,
        detected_rarity: identified.detected_rarity,
        verified:        enriched.verified,
        dbSource:        enriched.dbSource,
      },
    };
  }

  // Live write: update + audit_log row, both inside a single transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE certificates SET
         card_name = COALESCE(card_name, $2),
         set_name = COALESCE(set_name, $3),
         card_number_display = COALESCE(card_number_display, $4),
         rarity = COALESCE(rarity, $5),
         year_text = COALESCE(year_text, $6),
         updated_at = NOW()
       WHERE certificate_number = $1`,
      [certId, proposed.card_name, proposed.set_name, proposed.card_number_display, proposed.rarity, proposed.year_text],
    );
    await client.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
       VALUES ('certificate', $1, 'metadata_backfill', 'backfill-script', $2::jsonb)`,
      [certId, JSON.stringify({ before, after: proposed, identification: {
        confidence:      identified.confidence,
        detected_name:   identified.detected_name,
        detected_set:    identified.detected_set,
        detected_number: identified.detected_number,
        detected_year:   identified.copyright_year || identified.detected_year,
        detected_rarity: identified.detected_rarity,
        verified:        enriched.verified,
        dbSource:        enriched.dbSource,
        reasoning:       identified.reasoning,
      }, fields_changed: changed })],
    );
    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    return { certId, status: "failed", reason: `DB write failed: ${err.message}`, before };
  } finally {
    client.release();
  }

  return {
    certId,
    status: "updated",
    before,
    after: proposed,
    identification: {
      confidence:      identified.confidence,
      detected_name:   identified.detected_name,
      detected_set:    identified.detected_set,
      detected_number: identified.detected_number,
      detected_year:   identified.copyright_year || identified.detected_year,
      detected_rarity: identified.detected_rarity,
      verified:        enriched.verified,
      dbSource:        enriched.dbSource,
    },
  };
}

function fmtRow(label: string, v: string | null | undefined) {
  return `    ${label.padEnd(20)} ${v == null ? "NULL" : `"${v}"`}`;
}

(async () => {
  console.log(`\n=== Backfill cert metadata — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE RUN"} ===`);
  console.log(`Targets: ${TARGETS.join(", ")}\n`);
  const results: BackfillResult[] = [];
  for (const certId of TARGETS) {
    console.log(`--- ${certId} ---`);
    const r = await processCert(certId);
    results.push(r);
    console.log(`  status: ${r.status}${r.reason ? "  (" + r.reason + ")" : ""}`);
    if (r.identification) {
      const id = r.identification;
      console.log(`  identification:`);
      console.log(`    confidence    ${id.confidence}`);
      console.log(`    detected_name ${id.detected_name}`);
      console.log(`    detected_set  ${id.detected_set}${id.detected_number ? " #" + id.detected_number : ""}`);
      console.log(`    year          ${id.detected_year || "—"}`);
      console.log(`    rarity        ${id.detected_rarity || "—"}`);
      console.log(`    tcg verified  ${id.verified}${id.dbSource ? " (" + id.dbSource + ")" : ""}`);
    }
    if (r.after) {
      console.log(`  before → after:`);
      const fields = ["card_name", "set_name", "card_number_display", "rarity", "year_text"] as const;
      for (const f of fields) {
        const b = r.before[f];
        const a = r.after[f];
        const arrow = b === a ? "  =  " : "  →  ";
        console.log(`    ${f.padEnd(20)} ${b == null ? "NULL" : `"${b}"`}${arrow}${a == null ? "NULL" : `"${a}"`}`);
      }
    }
    console.log("");
  }

  console.log("=== Summary ===");
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  if (DRY_RUN) console.log("\n(DRY RUN — no DB writes performed. Re-run without DRY_RUN=true to apply.)");

  await pool.end();
})().catch(async (err) => {
  console.error("FAILED:", err);
  await pool.end();
  process.exit(1);
});
