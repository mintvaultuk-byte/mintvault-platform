/**
 * Weekly-reel data query — graded certificates flagged by an admin for the
 * marketing pool.
 *
 * Selection is driven by certificates.marketing_featured, an admin-controlled
 * boolean. This is intentionally independent of
 * submissions.marketing_feature_consent (the user opt-in, kept as a legal
 * record): the admin curates the reel pool directly, so a featured cert is
 * eligible regardless of consent state.
 *
 * Sort key: overall_grade DESC then declared_value DESC. Both can be NULL
 * (NULLS LAST so ungraded / no-value rows don't surface ahead of real
 * ones if the filter ever misses).
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

export interface WeeklyReelCard {
  certId: number;             // certificates.id (numeric pk)
  certNumber: string;         // certificates.certificate_number ("MV139")
  grade: number | null;
  cardName: string | null;
  cardSet: string | null;
  cardNumber: string | null;  // card_number_display (e.g. "75/130")
  year: string | null;
  declaredValue: number | null;
  // R2 key for the live display PNG. Mirrors the scan-ingest convention
  // (`images/{certNumber}/front.png`). Constructed here so callers don't
  // have to know the convention.
  frontPngKey: string;
  backPngKey: string;
}

export interface WeeklyReelDataResult {
  cards: WeeklyReelCard[];
  totalFeatured: number;      // total featured graded certs (info)
}

const DEFAULT_LIMIT = 8;

export async function fetchWeeklyReelData(limit: number = DEFAULT_LIMIT): Promise<WeeklyReelDataResult> {
  const r = await db.execute(sql`
    SELECT
      c.id                       AS cert_id,
      c.certificate_number       AS cert_number,
      c.grade                    AS grade,
      c.card_name                AS card_name,
      c.set_name                 AS set_name,
      c.card_number_display      AS card_number,
      c.year_text                AS year_text,
      si.declared_value          AS declared_value
    FROM certificates c
    LEFT JOIN submission_items si ON si.id = c.submission_item_id
    WHERE c.marketing_featured = true
      AND c.deleted_at IS NULL
      AND c.grade_approved_at IS NOT NULL
    ORDER BY c.grade DESC NULLS LAST, si.declared_value DESC NULLS LAST
    LIMIT ${limit}
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
      frontPngKey: `images/${certNumber}/front.png`,
      backPngKey: `images/${certNumber}/back.png`,
    };
  });

  // Separately count featured certs (so the job can log how much of the
  // featured pool ended up in the top-N — useful telemetry).
  let totalFeatured = 0;
  try {
    const cnt = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM certificates c
      WHERE c.marketing_featured = true
        AND c.deleted_at IS NULL
        AND c.grade_approved_at IS NOT NULL
    `);
    totalFeatured = (cnt.rows[0] as any)?.n ?? cards.length;
  } catch {
    totalFeatured = cards.length;
  }

  return { cards, totalFeatured };
}
