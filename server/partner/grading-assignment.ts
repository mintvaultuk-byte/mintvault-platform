/**
 * Partner grading assignment — partner-owned, deliberately OUTSIDE server/grader.ts.
 *
 * This logic is entirely tenant/permission plumbing: it decides WHICH partner user may be handed
 * WHICH partner-origin certificate, and mirrors that decision onto partner_grading_work_items. It
 * contains no scoring, no sub-grade arithmetic, no centering maths, no Pristine rules and no
 * certificate numbering — nothing that belongs to the protected MVGS engine.
 *
 * It lives here rather than in server/grader.ts because server/grader.ts is a protected file. An
 * earlier revision of this work placed the function there and widened the two MVGS tripwire tests
 * to accept it; that is the wrong direction of travel. Partner-specific code belongs in
 * server/partner/, and the protected engine stays byte-identical to main.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";

/**
 * Bind an int[] as ONE parameter.
 *
 * Local copy of the same helper server/grader.ts uses privately. Duplicated rather than exported
 * from there so this module creates no new coupling to the protected file — it is four lines of
 * parameter binding with no engine semantics.
 */
const intArray = (ids: number[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::int[]`;

/** Assign partner-origin work items to a partner user with MVGS assessment permission. */
export async function assignPartnerCerts(partnerUserId: string, certIds: number[], adminUser: string) {
  const clean = certIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { ok: false as const, status: 400, error: "No certificate ids" };
  const eligible = await db.execute(sql`
    SELECT u.id, u.tenant_id
      FROM partner_users u
     WHERE u.id = ${partnerUserId}
       AND u.status = 'ACTIVE'
       AND EXISTS (
         SELECT 1
           FROM partner_user_roles ur
           JOIN partner_role_permissions rp ON rp.role_id = ur.role_id
           JOIN partner_permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = u.id
            AND ur.tenant_id = u.tenant_id
            AND p.code = 'partner.cards.assess'
       )
     LIMIT 1
  `);
  const partner = eligible.rows[0] as { id: string; tenant_id: string } | undefined;
  if (!partner) return { ok: false as const, status: 400, error: "Not a valid partner grader" };

  const r = await db.execute(sql`
    WITH assigned AS (
      UPDATE certificates cert
         SET assigned_grader_id = ${partnerUserId},
             grader_status = 'assigned',
             assigned_at = NOW(),
             rejection_reason = NULL,
             updated_at = NOW()
        FROM partner_grading_work_items pgwi
        JOIN partner_connector_imports pci ON pci.id = pgwi.connector_import_id
       WHERE cert.id = ANY(${intArray(clean)})
         AND cert.submission_item_id = pgwi.submission_item_id
         AND cert.submission_id = pgwi.destination_submission_id
         AND pgwi.tenant_id = ${partner.tenant_id}
         AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = cert.id)
         AND pgwi.status IN ('ready_for_assignment','assigned','returned_for_change')
         AND pci.state = 'completed'
         AND pci.deleted_at IS NULL
         AND cert.deleted_at IS NULL
         AND cert.grader_status IN ('unassigned','assigned','rejected')
         AND (
           EXISTS (
             SELECT 1
               FROM partner_user_roles ur
               JOIN partner_roles r ON r.id = ur.role_id
              WHERE ur.user_id = ${partnerUserId}
                AND ur.tenant_id = ${partner.tenant_id}
                AND r.code IN ('PARTNER_OWNER','PARTNER_MANAGER')
           )
           OR EXISTS (
             SELECT 1
               FROM partner_user_locations pul
              WHERE pul.user_id = ${partnerUserId}
                AND pul.tenant_id = ${partner.tenant_id}
                AND pul.location_id = pgwi.partner_location_id
           )
         )
       RETURNING cert.id, cert.submission_item_id
    )
    UPDATE partner_grading_work_items pgwi
       SET certificate_id = assigned.id,
           certificate_linked_at = COALESCE(pgwi.certificate_linked_at, NOW()),
           assigned_partner_grader_id = ${partnerUserId},
           assigned_at = COALESCE(pgwi.assigned_at, NOW()),
           status = 'assigned',
           updated_at = NOW()
      FROM assigned
     WHERE assigned.submission_item_id = pgwi.submission_item_id
       AND pgwi.tenant_id = ${partner.tenant_id}
       AND (pgwi.certificate_id IS NULL OR pgwi.certificate_id = assigned.id)
       AND pgwi.status IN ('ready_for_assignment','assigned','returned_for_change')
    RETURNING assigned.id
  `);
  await storage.writeAuditLog("certificate", clean.join(","), "partner_grader_assign", adminUser, {
    partner_user_id: partnerUserId,
    partner_tenant_id: partner.tenant_id,
    cert_ids: clean,
    count: r.rows.length,
  });
  return { ok: true as const, count: r.rows.length };
}
