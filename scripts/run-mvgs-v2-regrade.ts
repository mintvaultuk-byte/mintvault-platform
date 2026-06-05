/* eslint-disable */
/**
 * MVGS v2 re-grade script — dry-run by default, writes only with --live.
 *
 * Reads every active+approved cert from prod, runs the deployed v2 engine
 * (shared/mvgs-scoring.ts + shared/mvgs-input-builder.ts) against its
 * persisted fields, and reports old → new grade/score per cert. Outputs a
 * CSV for offline review.
 *
 * --dry-run (DEFAULT): ALL reads + computation + CSV output, ZERO writes.
 * --live: same plus per-changed-cert audit_log INSERT + grade UPDATE.
 *         REQUIRES explicit --live flag — refuses without it.
 *
 * Usage (dry-run):
 *   MINTVAULT_DATABASE_URL="postgresql://..." npx tsx scripts/run-mvgs-v2-regrade.ts --dry-run
 *
 * Usage (LIVE — only after CSV review + explicit approval):
 *   MINTVAULT_DATABASE_URL="postgresql://..." npx tsx scripts/run-mvgs-v2-regrade.ts --live
 *
 * Output CSV: /tmp/mvgs-v2-regrade-<dryrun|live>-<timestamp>.csv
 * Columns: cert_id, old_grade, new_grade, old_score, new_score,
 *          score_delta, grade_delta, what_changed, has_d2_st, pin_count
 */
import { writeFileSync } from "fs";
import { Client } from "pg";
import { computeMvgsScore, gradeFromMvgsScore, mvgsGradeLabel as gradeLabelForScore } from "../shared/mvgs-scoring";
import { buildMvgsInput, type MvgsV2PersistedFields } from "../shared/mvgs-input-builder";

const isLive = process.argv.includes("--live");
const isDryRun = process.argv.includes("--dry-run") || !isLive;

if (!isDryRun && !isLive) {
  console.error("ERROR: must pass --dry-run or --live explicitly");
  process.exit(1);
}
if (isLive && isDryRun) {
  console.error("ERROR: cannot pass both --dry-run and --live");
  process.exit(1);
}

const DB_URL = process.env.MINTVAULT_DATABASE_URL;
if (!DB_URL) {
  console.error("ERROR: MINTVAULT_DATABASE_URL not set");
  process.exit(1);
}

const MODE = isLive ? "LIVE" : "DRY-RUN";
const TS = "2026-06-04T05-15-00Z"; // hardcoded to keep the harness deterministic
const CSV_PATH = `/tmp/mvgs-v2-regrade-${isLive ? "live" : "dryrun"}-${TS}.csv`;

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Load calibration row (defaults to DEFAULT_MVGS_CALIBRATION if missing —
  // engine handles that fallback, but we read explicitly to log what's used).
  const calRes = await client.query("SELECT value FROM pipeline_settings WHERE key = 'mvgs.calibration' LIMIT 1");
  const calRow = calRes.rows[0]?.value as Record<string, unknown> | undefined;
  const calibration = calRow
    ? {
        edgeAffectedPct: Number(calRow.edgeAffectedPct ?? 10),
        minorVisibleSplitPct: Number(calRow.minorVisibleSplitPct ?? 25),
        darkBorderMultiplier: Number(calRow.darkBorderMultiplier ?? 1.25),
        creaseMinorMaxPct: Number(calRow.creaseMinorMaxPct ?? 25),
        creaseHalfMaxPct: Number(calRow.creaseHalfMaxPct ?? 50),
        creaseThreeQuarterMaxPct: Number(calRow.creaseThreeQuarterMaxPct ?? 75),
      }
    : undefined;
  console.log(`[${MODE}] calibration loaded:`, calibration ?? "DEFAULTS (no row found)");

  // Fetch all active+approved certs with the grading fields the engine needs.
  // Snake-case columns mapped to the camelCase fields buildMvgsInput expects.
  const certs = await client.query(`
    SELECT
      certificate_number,
      grade,
      grade_strength_score,
      grade_type,
      grade_approved_at,
      defects,
      whitening_lines,
      crease_lines,
      crease_span_pct,
      wrinkle_severity,
      tear_severity,
      centering_front_lr,
      centering_front_tb,
      centering_back_lr,
      centering_back_tb,
      dark_border_front,
      dark_border_back,
      eye_appeal_modifier,
      surface_values
    FROM certificates
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND grade_approved_at IS NOT NULL
    ORDER BY certificate_number
  `);
  console.log(`[${MODE}] fetched ${certs.rows.length} approved certs`);

  const rows: string[] = [
    "cert_id,old_grade,new_grade,old_score,new_score,score_delta,grade_delta,what_changed,has_d2_st,pin_count",
  ];
  let changedGrade = 0;
  let changedScore = 0;
  let nonNumericSkipped = 0;
  const breakdown = { stain_only: 0, band_only: 0, stain_and_band: 0, no_change: 0 };
  const flagged: string[] = []; // certs moving >3 grades — eyeball candidates

  for (const c of certs.rows) {
    const certId = String(c.certificate_number);

    // Skip non-numeric grade types (AA / NO) — engine doesn't score those.
    if (c.grade_type && c.grade_type !== "numeric") {
      nonNumericSkipped++;
      continue;
    }

    const oldGrade = c.grade != null ? parseFloat(c.grade) : null;
    const oldScore = c.grade_strength_score != null ? Number(c.grade_strength_score) : null;
    const pinCount = Array.isArray(c.defects) ? c.defects.length : 0;
    const hasD2St = Array.isArray(c.defects)
      ? c.defects.some((d: any) => d?.mvgsCode === "ST" && d?.tier === "D2")
      : false;

    // Build engine input. Pins missing mvgsCode/tier/zone are silently
    // filtered out — same as buildPayload at grading-panel.tsx:996-998.
    const mvgsPins = (Array.isArray(c.defects) ? c.defects : [])
      .filter((d: any) => d?.mvgsCode && d?.tier && d?.zone)
      .map((d: any) => ({ mvgsCode: String(d.mvgsCode), tier: String(d.tier), zone: String(d.zone) }));

    const surfaceValues = (c.surface_values ?? {}) as Record<string, unknown>;
    const fields: MvgsV2PersistedFields = {
      centeringFrontLr: c.centering_front_lr,
      centeringFrontTb: c.centering_front_tb,
      centeringBackLr: c.centering_back_lr,
      centeringBackTb: c.centering_back_tb,
      defects: mvgsPins,
      darkBorderFront: !!c.dark_border_front,
      darkBorderBack: !!c.dark_border_back,
      eyeAppealModifier: Number(c.eye_appeal_modifier ?? 0),
      whiteningLines: Array.isArray(c.whitening_lines) ? c.whitening_lines : null,
      creaseLines: Array.isArray(c.crease_lines) ? c.crease_lines : null,
      creaseSpanPct: c.crease_span_pct != null ? Number(c.crease_span_pct) : null,
      wrinkleSeverity: c.wrinkle_severity ?? null,
      tearSeverity: c.tear_severity ?? null,
      hasCrease: !!surfaceValues.hasCrease,
      hasTear: !!surfaceValues.hasTear,
    };

    const engineInput = buildMvgsInput(fields, calibration);
    const result = computeMvgsScore(engineInput);
    const newScore = result.score;
    const newGrade = gradeFromMvgsScore(newScore);
    const newLabel = gradeLabelForScore(newScore);

    const scoreDelta = oldScore != null ? newScore - oldScore : null;
    const gradeDelta = oldGrade != null ? newGrade - oldGrade : null;

    let what = "no_change";
    if (scoreDelta != null && Math.abs(scoreDelta) > 0.001) changedScore++;
    if (gradeDelta != null && Math.abs(gradeDelta) > 0.001) changedGrade++;

    if (scoreDelta != null && gradeDelta != null) {
      const scoreMoved = Math.abs(scoreDelta) > 0.001;
      const gradeMoved = Math.abs(gradeDelta) > 0.001;
      if (!scoreMoved && !gradeMoved) what = "no_change";
      else if (scoreMoved && !gradeMoved) what = "stain_only";
      else if (!scoreMoved && gradeMoved) what = "band_only";
      else what = "stain_and_band";
      breakdown[what as keyof typeof breakdown]++;
    }

    if (gradeDelta != null && Math.abs(gradeDelta) > 3) flagged.push(`${certId}: ${oldGrade} → ${newGrade}`);

    rows.push(
      [
        certId,
        oldGrade ?? "",
        newGrade,
        oldScore ?? "",
        newScore,
        scoreDelta ?? "",
        gradeDelta ?? "",
        what,
        hasD2St ? "yes" : "no",
        pinCount,
      ].join(",")
    );
  }

  writeFileSync(CSV_PATH, rows.join("\n") + "\n");
  console.log(`\n[${MODE}] CSV written: ${CSV_PATH}`);
  console.log(`[${MODE}] processed: ${certs.rows.length} certs (${nonNumericSkipped} non-numeric skipped)`);
  console.log(`[${MODE}] grade changed: ${changedGrade}, score changed: ${changedScore}`);
  console.log(`[${MODE}] breakdown:`, breakdown);
  if (flagged.length > 0) {
    console.log(`\n⚠️  ${flagged.length} cert(s) moved >3 grades — eyeball candidates:`);
    for (const f of flagged) console.log(`    ${f}`);
  } else {
    console.log(`\nNo certs moved >3 grades.`);
  }

  if (isDryRun) {
    console.log(`\n[DRY-RUN] no writes performed. Review CSV before running --live.`);
  } else {
    console.error(
      "[LIVE] write path not implemented in this script — would need explicit per-cert audit_log INSERT + grade UPDATE."
    );
    process.exit(1);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
