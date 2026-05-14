/**
 * scripts/_backfill-display-images-snapshot.ts
 *
 * Pre-flight snapshot for the display-image backfill. Captures the
 * pre-backfill state of every column the backfill touches, for every cert
 * in the target range, as a runnable .sql file containing UPDATE
 * statements that restore the columns row-by-row.
 *
 * Output path: scripts/_snapshots/backfill-display-images_<ts>_<range>.sql
 *
 * Columns captured (matches the SET clause in uploadImagesToCert at
 * scan-ingest-service.ts L207-226, MINUS the two *_original columns which
 * the backfill explicitly preserves):
 *   - front_image_path
 *   - back_image_path
 *   - grading_front_cropped
 *   - grading_back_cropped
 *   - grading_front_greyscale
 *   - grading_back_greyscale
 *   - grading_front_highcontrast
 *   - grading_back_highcontrast
 *   - grading_front_edgeenhanced
 *   - grading_back_edgeenhanced
 *   - grading_front_inverted
 *   - grading_back_inverted
 *   - crop_geometry
 *
 * Run standalone with:
 *   npx tsx --env-file=.env scripts/_backfill-display-images-snapshot.ts \
 *     --from=MV100 --to=MV110
 *
 * Or imported and called by the main backfill script as its first real-run
 * step (see scripts/_backfill-display-images.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

export interface SnapshotOptions {
  fromNum?: number;        // inclusive lower bound, e.g. 100 for MV100
  toNum?: number;          // inclusive upper bound
}

interface SnapshotRow {
  id: number;
  certificate_number: string;
  front_image_path: string | null;
  back_image_path: string | null;
  grading_front_cropped: string | null;
  grading_back_cropped: string | null;
  grading_front_greyscale: string | null;
  grading_back_greyscale: string | null;
  grading_front_highcontrast: string | null;
  grading_back_highcontrast: string | null;
  grading_front_edgeenhanced: string | null;
  grading_back_edgeenhanced: string | null;
  grading_front_inverted: string | null;
  grading_back_inverted: string | null;
  crop_geometry: unknown | null;
}

function quoteOrNull(v: string | null): string {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function quoteJsonbOrNull(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const json = typeof v === "string" ? v : JSON.stringify(v);
  return `'${json.replace(/'/g, "''")}'::jsonb`;
}

function tsStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Take a snapshot of the columns the backfill touches, for certs in the
 * given range. Writes an .sql file with row-by-row UPDATE statements.
 * Returns the absolute path of the .sql file.
 */
export async function takeSnapshot(opts: SnapshotOptions): Promise<string> {
  const fromNum = opts.fromNum ?? 0;
  const toNum   = opts.toNum   ?? Number.MAX_SAFE_INTEGER;

  const rows = (await db.execute(sql`
    SELECT id,
           certificate_number,
           front_image_path,
           back_image_path,
           grading_front_cropped,
           grading_back_cropped,
           grading_front_greyscale,
           grading_back_greyscale,
           grading_front_highcontrast,
           grading_back_highcontrast,
           grading_front_edgeenhanced,
           grading_back_edgeenhanced,
           grading_front_inverted,
           grading_back_inverted,
           crop_geometry
    FROM certificates
    WHERE certificate_number ~ '^MV[0-9]+$'
      AND (regexp_replace(certificate_number, '^MV', ''))::int >= ${fromNum}
      AND (regexp_replace(certificate_number, '^MV', ''))::int <= ${toNum}
    ORDER BY id ASC
  `)).rows as unknown as SnapshotRow[];

  const snapshotDir = path.join(process.cwd(), "scripts", "_snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });

  const rangeLabel = (opts.fromNum !== undefined || opts.toNum !== undefined)
    ? `MV${fromNum}-MV${toNum === Number.MAX_SAFE_INTEGER ? "end" : toNum}`
    : "all";
  const fname = `backfill-display-images_${tsStamp()}_${rangeLabel}.sql`;
  const outPath = path.join(snapshotDir, fname);

  const lines: string[] = [];
  lines.push(`-- Pre-flight snapshot for display-image backfill`);
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push(`-- Range: ${rangeLabel}  (rows=${rows.length})`);
  lines.push(`-- Restore by running these UPDATE statements against MINTVAULT_DATABASE_URL.`);
  lines.push(`-- Does NOT touch grading_front_original / grading_back_original (those`);
  lines.push(`-- columns are preserved by the backfill itself; nothing to restore).`);
  lines.push(``);
  lines.push(`BEGIN;`);
  lines.push(``);

  for (const r of rows) {
    lines.push(`-- ${r.certificate_number} (id=${r.id})`);
    lines.push(`UPDATE certificates SET`);
    lines.push(`  front_image_path           = ${quoteOrNull(r.front_image_path)},`);
    lines.push(`  back_image_path            = ${quoteOrNull(r.back_image_path)},`);
    lines.push(`  grading_front_cropped      = ${quoteOrNull(r.grading_front_cropped)},`);
    lines.push(`  grading_back_cropped       = ${quoteOrNull(r.grading_back_cropped)},`);
    lines.push(`  grading_front_greyscale    = ${quoteOrNull(r.grading_front_greyscale)},`);
    lines.push(`  grading_back_greyscale     = ${quoteOrNull(r.grading_back_greyscale)},`);
    lines.push(`  grading_front_highcontrast = ${quoteOrNull(r.grading_front_highcontrast)},`);
    lines.push(`  grading_back_highcontrast  = ${quoteOrNull(r.grading_back_highcontrast)},`);
    lines.push(`  grading_front_edgeenhanced = ${quoteOrNull(r.grading_front_edgeenhanced)},`);
    lines.push(`  grading_back_edgeenhanced  = ${quoteOrNull(r.grading_back_edgeenhanced)},`);
    lines.push(`  grading_front_inverted     = ${quoteOrNull(r.grading_front_inverted)},`);
    lines.push(`  grading_back_inverted      = ${quoteOrNull(r.grading_back_inverted)},`);
    lines.push(`  crop_geometry              = ${quoteJsonbOrNull(r.crop_geometry)},`);
    lines.push(`  updated_at                 = NOW()`);
    lines.push(`WHERE id = ${r.id};`);
    lines.push(``);
  }

  lines.push(`COMMIT;`);

  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`[snapshot] wrote ${rows.length} row(s) to ${outPath}`);
  return outPath;
}

// ── CLI entry point ────────────────────────────────────────────────────────
function parseArgs(): SnapshotOptions {
  const opts: SnapshotOptions = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(from|to)=MV(\d+)$/);
    if (m) {
      const n = parseInt(m[2], 10);
      if (m[1] === "from") opts.fromNum = n;
      else                 opts.toNum = n;
    } else if (arg === "--help") {
      console.log("Usage: tsx _backfill-display-images-snapshot.ts [--from=MV100] [--to=MV110]");
      process.exit(0);
    }
  }
  return opts;
}

const isMain = process.argv[1] && process.argv[1].endsWith("_backfill-display-images-snapshot.ts");
if (isMain) {
  takeSnapshot(parseArgs())
    .then((p) => { console.log(`Snapshot path: ${p}`); process.exit(0); })
    .catch((e) => { console.error("[snapshot] FAILED:", e); process.exit(1); });
}
