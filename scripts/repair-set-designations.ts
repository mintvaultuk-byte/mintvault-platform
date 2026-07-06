/**
 * scripts/repair-set-designations.ts
 *
 * ONE-OFF prod data repair (owner-approved 2026-07-06, "option B"): set names
 * that carry a subset/promo designation ("Brilliant Stars Trainer Gallery",
 * "swsh black star promos") are split — the BASE set stays in set_name and the
 * designation moves to the variant column (rarity cleared: the two are
 * exactly-one-of per the front-label line-3 rule). Uses the SAME shared
 * splitSetDesignation() the live identify paths now use, so repaired data and
 * future data follow one rule.
 *
 * Also fixes the known MV237 typo: "swoed & shield" → "Sword & Shield".
 *
 * DRY-RUN BY DEFAULT — prints the full old→new table and writes NOTHING.
 * Run with --apply to perform the updates (single transaction + one audit_log
 * row per cert with before/after, per the bulk-operation audit rule).
 *
 * Build: included in `npm run build` (script/build.ts) -> dist/repair-set-designations.cjs
 * Run on prod:
 *   fly ssh console --app mintvault -C "node /app/dist/repair-set-designations.cjs"           # dry-run
 *   fly ssh console --app mintvault -C "node /app/dist/repair-set-designations.cjs --apply"   # write
 */
import { pool } from "../server/db";
import { splitSetDesignation } from "../shared/variant-derive";

/** Known data typos corrected before the split. Keyed lowercase. */
const TYPO_FIXES: ReadonlyArray<{ match: RegExp; replace: string }> = [
  { match: /\bswoed\b/gi, replace: "Sword" },
  { match: /\btraniner\b/gi, replace: "Trainer" },
];

/** Whole-value set-name fixes (compared lowercase/trimmed): set CODES stored
 *  where the set NAME belongs. Seen in the 2026-07-06 prod dry-run. */
const SET_NAME_FIXES: Record<string, string> = {
  paf: "Paldean Fates",
};

/** Capitalise the first letter of each word, leaving existing capitals intact
 *  ("brilliant stars" → "Brilliant Stars"; "GO", "XY", "151" unchanged).
 *  Repaired rows only — live TCGdex names arrive properly cased. */
function titleCaseWords(s: string): string {
  return s.replace(/(^|\s)(\p{Ll})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

interface CertRow {
  id: number;
  cert_id: string;
  card_name: string | null;
  set_name: string | null;
  variant: string | null;
  rarity: string | null;
}

interface Proposed {
  row: CertRow;
  newSetName: string;
  newVariant: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = process.env.MINTVAULT_DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "(unknown)";
  console.log(`[repair-set-designations] DB host: ${host} mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const res = await pool.query(
    `SELECT id, certificate_number AS cert_id, card_name, set_name, variant, rarity
     FROM certificates
     WHERE deleted_at IS NULL AND set_name IS NOT NULL AND set_name <> ''
     ORDER BY id`
  );

  const proposals: Proposed[] = [];
  for (const row of res.rows as CertRow[]) {
    let fixed = row.set_name as string;
    for (const { match, replace } of TYPO_FIXES) fixed = fixed.replace(match, replace);
    fixed = SET_NAME_FIXES[fixed.trim().toLowerCase()] || fixed;
    const split = splitSetDesignation(fixed);
    const newSetName = titleCaseWords(split.baseSet);
    // Only certs where a designation was found (or a typo/casing changed the name).
    if (!split.designation && newSetName === row.set_name) continue;
    // Empty when no designation: typo/casing-only rows must NOT touch
    // variant/rarity (the SQL CASE below is gated on this being non-empty).
    const newVariant = split.designation ?? "";
    proposals.push({ row, newSetName, newVariant });
  }

  console.log(`[repair-set-designations] ${res.rows.length} certs scanned, ${proposals.length} need repair\n`);
  for (const p of proposals) {
    console.log(
      `${p.row.cert_id}  "${p.row.card_name ?? ""}"\n` +
        `   set:     ${JSON.stringify(p.row.set_name)} -> ${JSON.stringify(p.newSetName)}\n` +
        `   variant: ${JSON.stringify(p.row.variant)} -> ${JSON.stringify(p.newVariant || p.row.variant)}\n` +
        `   rarity:  ${JSON.stringify(p.row.rarity)} -> ${p.newVariant ? "null" : JSON.stringify(p.row.rarity)}`
    );
  }

  if (!apply) {
    console.log(`\nDRY-RUN complete — nothing written. Re-run with --apply to perform these updates.`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of proposals) {
      await client.query(
        `UPDATE certificates SET
           set_name = $1,
           variant = CASE WHEN $2 <> '' THEN $2 ELSE variant END,
           rarity = CASE WHEN $2 <> '' THEN NULL ELSE rarity END,
           updated_at = NOW()
         WHERE id = $3`,
        [p.newSetName, p.newVariant, p.row.id]
      );
      await client.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
         VALUES ('certificate', $1, 'SET_DESIGNATION_REPAIR', 'repair-script', $2::jsonb)`,
        [
          String(p.row.id),
          JSON.stringify({
            certificate_number: p.row.cert_id,
            before: { set_name: p.row.set_name, variant: p.row.variant, rarity: p.row.rarity },
            after: { set_name: p.newSetName, variant: p.newVariant || p.row.variant, rarity: p.newVariant ? null : p.row.rarity },
          }),
        ]
      );
    }
    await client.query("COMMIT");
    console.log(`\nAPPLIED: ${proposals.length} certs updated (one audit_log row each).`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[repair-set-designations] FAILED:", err);
    process.exit(1);
  });
