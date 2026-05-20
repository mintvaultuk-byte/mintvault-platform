/**
 * Weekly-reel data query — top-N graded certificates from the last 7 days
 * that have marketing-feature consent.
 *
 * Joins:
 *   certificates ↔ submission_items.id = certificates.submission_item_id
 *   submission_items.submission_id ↔ submissions.id
 *
 * Consent filter is on the SUBMISSION row (consent is per-submission, not
 * per-cert — one consent decision covers all cards in a submission).
 * Deletion filter is belt-and-braces on both tables.
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
  totalWithConsent: number;   // total consenting graded certs in the window (info)
  windowDays: number;
}

const DEFAULT_LIMIT = 8;
const WINDOW_DAYS = 7;

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
    JOIN submission_items si ON si.id = c.submission_item_id
    JOIN submissions     s  ON s.id  = si.submission_id
    WHERE s.marketing_feature_consent = true
      AND s.deleted_at IS NULL
      AND c.deleted_at IS NULL
      AND c.grade_approved_at IS NOT NULL
      AND c.grade_approved_at >= NOW() - INTERVAL '${sql.raw(String(WINDOW_DAYS))} days'
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

  // Separately count consenting certs in window (so the job can log how
  // much of the consenting pool ended up in the top-N, useful telemetry).
  let totalWithConsent = 0;
  try {
    const cnt = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM certificates c
      JOIN submission_items si ON si.id = c.submission_item_id
      JOIN submissions     s  ON s.id  = si.submission_id
      WHERE s.marketing_feature_consent = true
        AND s.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND c.grade_approved_at IS NOT NULL
        AND c.grade_approved_at >= NOW() - INTERVAL '${sql.raw(String(WINDOW_DAYS))} days'
    `);
    totalWithConsent = (cnt.rows[0] as any)?.n ?? cards.length;
  } catch {
    totalWithConsent = cards.length;
  }

  return { cards, totalWithConsent, windowDays: WINDOW_DAYS };
}
