/**
 * Weekly-reel data query — graded certificates flagged by an admin for the
 * marketing pool.
 *
 * Selection is driven by certificates.marketing_featured / marketing_pinned /
 * marketing_blacklisted, all admin-controlled. Independent of
 * submissions.marketing_feature_consent (kept as a legal record).
 *
 * Rules applied (in order):
 *   1. Always exclude marketing_blacklisted certs and soft-deleted certs.
 *   2. Always exclude certs that have not yet been grade-approved.
 *   3. Apply min_grade floor from pipeline_settings.
 *   4. Eligible pool = pinned OR featured. Pinned always sort first.
 *   5. Within each group, sort by sort_order setting.
 *   6. Take top `limit` (default = max_cards setting).
 */

import { db } from "../db";
import { sql } from "drizzle-orm";
import { getAllSettings } from "../lib/pipeline-settings";

export interface WeeklyReelCard {
  certId: number;             // certificates.id (numeric pk)
  certNumber: string;         // certificates.certificate_number ("MV139")
  grade: number | null;
  cardName: string | null;
  cardSet: string | null;
  cardNumber: string | null;  // card_number_display (e.g. "75/130")
  year: string | null;
  declaredValue: number | null;
  pinned: boolean;
  // R2 keys for the live display PNGs.
  frontPngKey: string;
  backPngKey: string;
}

export interface WeeklyReelDataResult {
  cards: WeeklyReelCard[];
  totalFeatured: number;       // total featured (or pinned) eligible certs
}

export async function fetchWeeklyReelData(limit?: number): Promise<WeeklyReelDataResult> {
  const settings = await getAllSettings();
  const effectiveLimit = Math.max(1, Math.min(8, limit ?? settings.max_cards));
  const minGrade = Math.max(0, Math.min(10, settings.min_grade));

  // Sort fragment lives in SQL — the three options map cleanly. Pinned
  // always sorts first regardless of choice.
  const sortFragment =
    settings.sort_order === "value_desc" ? sql`si.declared_value DESC NULLS LAST, c.grade DESC NULLS LAST`
    : settings.sort_order === "newest_first" ? sql`c.grade_approved_at DESC NULLS LAST`
    : sql`c.grade DESC NULLS LAST, si.declared_value DESC NULLS LAST`;

  const r = await db.execute(sql`
    SELECT
      c.id                       AS cert_id,
      c.certificate_number       AS cert_number,
      c.grade                    AS grade,
      c.card_name                AS card_name,
      c.set_name                 AS set_name,
      c.card_number_display      AS card_number,
      c.year_text                AS year_text,
      si.declared_value          AS declared_value,
      c.marketing_pinned         AS pinned
    FROM certificates c
    LEFT JOIN submission_items si ON si.id = c.submission_item_id
    WHERE (c.marketing_featured = true OR c.marketing_pinned = true)
      AND c.marketing_blacklisted = false
      AND c.deleted_at IS NULL
      AND c.grade_approved_at IS NOT NULL
      AND (${minGrade} = 0 OR c.grade IS NOT NULL AND c.grade >= ${minGrade})
    ORDER BY c.marketing_pinned DESC, ${sortFragment}
    LIMIT ${effectiveLimit}
  `);
  const cards: WeeklyReelCard[] = r.rows.map((row: any) => {
    const certNumber: string = String(row.cert_number);
    return {
      certId: Number(row.cert_id),
      certNumber,
      grade: row.grade != null ? Number(row.grade) : null,
      cardName: row.card_name ?? null,
      cardSet: row.set_name ?? null,
      cardNumber: row.card_number ?? null,
      year: row.year_text ?? null,
      declaredValue: row.declared_value != null ? Number(row.declared_value) : null,
      pinned: row.pinned === true,
      frontPngKey: `images/${certNumber}/front.png`,
      backPngKey: `images/${certNumber}/back.png`,
    };
  });

  let totalFeatured = 0;
  try {
    const cnt = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM certificates c
      WHERE (c.marketing_featured = true OR c.marketing_pinned = true)
        AND c.marketing_blacklisted = false
        AND c.deleted_at IS NULL
        AND c.grade_approved_at IS NOT NULL
    `);
    totalFeatured = (cnt.rows[0] as any)?.n ?? cards.length;
  } catch {
    totalFeatured = cards.length;
  }

  return { cards, totalFeatured };
}
