/**
 * scripts/rarity-legacy-audit.ts — READ-ONLY legacy variant audit.
 *
 * Reports how the historical flat `certificates.variant` values map onto the
 * structured Pokémon catalogue, and which ones need a human to confirm. It runs
 * ONLY SELECT statements — it never writes, updates, deletes, backfills, or
 * touches any certificate. There is no --apply mode by design.
 *
 * Two sections:
 *   1. LIVE DB   — distinct certificates.variant values + record counts in the
 *                  target database (defaults to the local disposable DB).
 *   2. CATALOGUE — every known legacy code from VARIANT_OPTIONS, classified, so
 *                  the founder sees the complete high/medium/low breakdown even
 *                  when the target DB has no certificate rows.
 *
 * Usage:
 *   npx tsx scripts/rarity-legacy-audit.ts
 *   AUDIT_DATABASE_URL=postgres://... npx tsx scripts/rarity-legacy-audit.ts   (read-only)
 */
import { Pool } from "pg";
import { VARIANT_OPTIONS } from "@/lib/variantOptions";
import { buildAuditRows, summariseAudit, type LegacyAuditRow } from "@shared/rarity-legacy-audit";
import { securePostgresPoolConnection } from "../server/lib/postgres-transport-security";

const LOCAL_DEFAULT = "postgresql://postgres@127.0.0.1:55432/mintvault_vq_phase10_local";
const url = process.env.AUDIT_DATABASE_URL || process.env.TEST_DATABASE_URL || LOCAL_DEFAULT;

function printTable(rows: LegacyAuditRow[]): void {
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log(
    "  " +
      pad("LEGACY VALUE", 26) +
      pad("COUNT", 7) +
      pad("CLASS", 11) +
      pad("PROPOSED", 30) +
      pad("CONF", 8) +
      "REVIEW?"
  );
  console.log("  " + "-".repeat(90));
  for (const r of rows) {
    console.log(
      "  " +
        pad(r.legacyValue, 26) +
        pad(String(r.recordCount), 7) +
        pad(r.classification, 11) +
        pad(r.proposedValue ?? "—", 30) +
        pad(r.confidence, 8) +
        (r.reviewRequired ? "YES" : "no")
    );
  }
}

async function liveDbAudit(pool: Pool): Promise<LegacyAuditRow[]> {
  try {
    const res = await pool.query<{ value: string | null; count: string }>(
      "SELECT variant AS value, COUNT(*)::text AS count FROM certificates GROUP BY variant"
    );
    const counts = res.rows.map((row) => ({ value: row.value ?? "", count: Number(row.count) }));
    return buildAuditRows(counts);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "42P01") {
      console.log("  ⚠️  No `certificates` table in this database (expected for the disposable local DB).");
      return [];
    }
    throw err;
  }
}

function catalogueAudit(): LegacyAuditRow[] {
  // Classify every known legacy code (count 0 — this is the value space, not live data).
  return buildAuditRows(VARIANT_OPTIONS.map((v) => ({ value: v.code, count: 0 })));
}

async function main(): Promise<void> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "(unparseable)";
    }
  })();
  console.log(`\n=== Rarity legacy audit (READ-ONLY) ===`);
  const local = ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname.toLowerCase());
  console.log(`Target DB: ${host}${local ? " [local]" : " [remote — read-only]"}\n`);

  const pool = new Pool({ ...securePostgresPoolConnection(url, "AUDIT_DATABASE_URL"), max: 2 });
  try {
    console.log("── 1 · LIVE DB (certificates.variant) ─────────────────────────────");
    const live = await liveDbAudit(pool);
    printTable(live);
    const liveSummary = summariseAudit(live);
    console.log(
      `\n  Summary: ${liveSummary.distinctValues} distinct value(s), ${liveSummary.totalRecords} record(s) — ` +
        `high ${liveSummary.high}, medium ${liveSummary.medium}, low ${liveSummary.low}, review-required ${liveSummary.reviewRequired}\n`
    );

    console.log("── 2 · CATALOGUE (all known VARIANT_OPTIONS codes) ────────────────");
    const cat = catalogueAudit();
    printTable(cat);
    const catSummary = summariseAudit(cat);
    console.log(
      `\n  Summary: ${catSummary.distinctValues} known code(s) — ` +
        `high ${catSummary.high}, medium ${catSummary.medium}, low ${catSummary.low}, review-required ${catSummary.reviewRequired}`
    );
    console.log(`\n(No data was written. This audit is read-only.)\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[rarity-legacy-audit] failed:", err);
  process.exit(1);
});
