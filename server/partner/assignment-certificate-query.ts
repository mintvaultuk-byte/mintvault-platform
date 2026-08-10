/**
 * Read-only certificate picker projection for Partner-imported submissions.
 *
 * Partner intake uses `submission_items`, while older MintVault submissions use
 * `cards`. This adapter deliberately stays outside the protected MVGS grader
 * module: it only locates certificate records for Super Admin assignment and
 * contains no scoring, grade-state transition, or label behaviour.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";

interface AssignmentCertificateRow {
  cert_id: number | string;
  cert_id_str: string | null;
  card_name: string | null;
  set_name: string | null;
  card_number: string | null;
  year: string | null;
  language: string | null;
  variant: string | null;
  assigned_grader_id: string | null;
  grader_status: string | null;
  redo_count: number | string | null;
  grader_email: string | null;
}

export interface AssignmentCertificateProjection {
  certId: number;
  certIdStr: string | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  year: string | null;
  language: string | null;
  variant: string | null;
  assignedGraderId: string | null;
  graderEmail: string | null;
  gradingStatus: string;
  redoCount: number;
}

/**
 * Returns the assignment-safe fields for a destination MintVault submission.
 * The submission id is server-owned from the route parameter and is bound by
 * Drizzle, so this query cannot choose an authority, grade, price, or tenant.
 */
export async function getAssignmentCertificatesForSubmission(
  submissionId: number
): Promise<AssignmentCertificateProjection[]> {
  const result = await db.execute(sql`
    SELECT cert.id AS cert_id, cert.certificate_number AS cert_id_str, cert.card_name, cert.set_name,
           cert.card_number_display AS card_number, cert.year_text AS year, cert.language, cert.variant,
           cert.assigned_grader_id, cert.grader_status, cert.redo_count, u.email AS grader_email
      FROM certificates cert
      LEFT JOIN cards c ON c.id = cert.card_id
      LEFT JOIN submission_items si ON si.id = cert.submission_item_id
      LEFT JOIN users u ON u.id = cert.assigned_grader_id
     WHERE (c.submission_id = ${submissionId} OR si.submission_id = ${submissionId})
       AND cert.deleted_at IS NULL
     ORDER BY cert.id ASC
  `);
  return (result.rows as unknown as AssignmentCertificateRow[]).map((row) => ({
    certId: Number(row.cert_id),
    certIdStr: row.cert_id_str,
    cardName: row.card_name,
    setName: row.set_name,
    cardNumber: row.card_number,
    year: row.year,
    language: row.language,
    variant: row.variant,
    assignedGraderId: row.assigned_grader_id,
    graderEmail: row.grader_email,
    gradingStatus: row.grader_status ?? "unassigned",
    redoCount: Number(row.redo_count ?? 0),
  }));
}
