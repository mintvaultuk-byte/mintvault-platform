import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requireSuperAdmin } from "../auth";
import { partnerAdminDbConfigured, partnerAdminQuery } from "../partner/db";
import {
  isEligibleOperationsSearchQuery,
  maskEmail,
  normaliseOperationsSearchQuery,
  operationsSearchPattern,
  OPERATIONS_RESULTS_PER_TYPE,
} from "../services/admin-operations";

type AttentionSeverity = "urgent" | "attention";

type AttentionItem = {
  id: string;
  title: string;
  description: string;
  count: number;
  severity: AttentionSeverity;
  href: string;
};

type SearchResult = {
  id: string;
  type: "certificate" | "submission" | "staff" | "partner";
  title: string;
  subtitle: string;
  href: string;
};

function asCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resultGroups(results: SearchResult[]): Record<SearchResult["type"], SearchResult[]> {
  return {
    certificate: results.filter((result) => result.type === "certificate"),
    submission: results.filter((result) => result.type === "submission"),
    staff: results.filter((result) => result.type === "staff"),
    partner: results.filter((result) => result.type === "partner"),
  };
}

async function partnerFeatureAvailability(): Promise<{ partnerManagement: boolean; partnerConnectors: boolean }> {
  if (!partnerAdminDbConfigured()) return { partnerManagement: false, partnerConnectors: false };
  try {
    const { rows } = await partnerAdminQuery<{ enabled: boolean }>(
      `SELECT enabled
         FROM partner_feature_flags
        WHERE tenant_id IS NULL AND location_id IS NULL AND flag = 'partner_connector_enabled'
        LIMIT 1`
    );
    return { partnerManagement: true, partnerConnectors: rows[0]?.enabled === true };
  } catch (error) {
    // A partially configured partner schema is unavailable, rather than a
    // reason to present a link that will immediately fail for the operator.
    console.warn("[admin-operations] partner actions unavailable", error instanceof Error ? error.message : error);
    return { partnerManagement: false, partnerConnectors: false };
  }
}

/**
 * Super Admin-only operational reads. These endpoints deliberately contain no
 * mutation handlers and project only the fields needed to identify a record.
 */
export function registerAdminOperationsRoutes(app: Express): void {
  app.get("/api/admin/operations/attention", requireSuperAdmin, async (_req, res) => {
    try {
      const [certCounts, submissionCounts, partnerFeatures] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE c.grader_status = 'pending_review')::int AS staff_review,
            COUNT(*) FILTER (WHERE c.grader_status = 'assigned' AND c.redo_count > 0)::int AS grader_rework,
            COUNT(*) FILTER (
              WHERE c.card_name IS NOT NULL
                AND (c.front_image_path IS NULL OR c.front_image_path = ''
                  OR c.back_image_path IS NULL OR c.back_image_path = '')
            )::int AS missing_images,
            COUNT(*) FILTER (
              WHERE c.grade_approved_at IS NOT NULL AND lp.cert_id IS NULL
            )::int AS labels_waiting
          FROM certificates c
          LEFT JOIN label_prints lp ON lp.cert_id = c.certificate_number
          WHERE c.deleted_at IS NULL AND c.status <> 'voided'
        `),
        db.execute(sql`
          SELECT COUNT(*) FILTER (WHERE LOWER(status) = 'paid')::int AS paid_waiting_intake
          FROM submissions
          WHERE deleted_at IS NULL
        `),
        partnerFeatureAvailability(),
      ]);

      const cert = (certCounts.rows[0] ?? {}) as Record<string, unknown>;
      const submission = (submissionCounts.rows[0] ?? {}) as Record<string, unknown>;
      const items: AttentionItem[] = [
        {
          id: "staff-review",
          title: "Staff gradings awaiting review",
          description: "Grader-submitted cards awaiting a Super Admin decision.",
          count: asCount(cert.staff_review),
          severity: "urgent",
          href: "/admin/staff?queue=pending_review",
        },
        {
          id: "grader-rework",
          title: "Grader rework in progress",
          description: "Previously rejected cards assigned back to a grader.",
          count: asCount(cert.grader_rework),
          severity: "attention",
          href: "/admin/staff?queue=rejected",
        },
        {
          id: "paid-intake",
          title: "Paid submissions awaiting intake",
          description: "Paid submissions not yet marked received.",
          count: asCount(submission.paid_waiting_intake),
          severity: "attention",
          href: "/admin?tab=submissions&status=paid",
        },
        {
          id: "missing-images",
          title: "Certificates missing images",
          description: "Certificate records with a card name but no front or back image.",
          count: asCount(cert.missing_images),
          severity: "attention",
          href: "/admin?tab=certs&attention=missing-images",
        },
        {
          id: "labels-waiting",
          title: "Labels waiting to print",
          description: "Approved certificates not yet recorded as printed.",
          count: asCount(cert.labels_waiting),
          severity: "attention",
          href: "/admin?tab=printing&print=unprinted",
        },
      ];

      res.json({
        items,
        features: partnerFeatures,
      });
    } catch (error) {
      console.error("[admin-operations] attention query failed", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Unable to load operational attention items" });
    }
  });

  app.get("/api/admin/operations/search", requireSuperAdmin, async (req, res) => {
    const query = normaliseOperationsSearchQuery(req.query.q);
    if (!isEligibleOperationsSearchQuery(query)) {
      return res.status(400).json({ error: "Enter at least two characters, or an exact numeric identifier." });
    }

    try {
      const pattern = operationsSearchPattern(query);
      const [certificateRows, submissionRows, staffRows, partnerRows] = await Promise.all([
        db.execute(sql`
          SELECT
            c.certificate_number,
            c.reference_number,
            c.card_name,
            c.set_name,
            c.card_number_display,
            c.nfc_uid,
            grader.display_name AS grader_name
          FROM certificates c
          LEFT JOIN users grader ON grader.id = c.assigned_grader_id
          WHERE c.deleted_at IS NULL
            AND (
              c.certificate_number ILIKE ${pattern} ESCAPE '\\'
              OR c.reference_number ILIKE ${pattern} ESCAPE '\\'
              OR c.card_name ILIKE ${pattern} ESCAPE '\\'
              OR c.set_name ILIKE ${pattern} ESCAPE '\\'
              OR c.card_number_display ILIKE ${pattern} ESCAPE '\\'
              OR c.nfc_uid ILIKE ${pattern} ESCAPE '\\'
              OR grader.display_name ILIKE ${pattern} ESCAPE '\\'
              OR grader.email ILIKE ${pattern} ESCAPE '\\'
            )
          ORDER BY c.updated_at DESC NULLS LAST
          LIMIT ${OPERATIONS_RESULTS_PER_TYPE}
        `),
        db.execute(sql`
          SELECT tracking_number, status, customer_first_name, customer_last_name, customer_email
          FROM submissions
          WHERE deleted_at IS NULL
            AND (
              tracking_number ILIKE ${pattern} ESCAPE '\\'
              OR payment_intent_id ILIKE ${pattern} ESCAPE '\\'
              OR checkout_session_id ILIKE ${pattern} ESCAPE '\\'
              OR customer_first_name ILIKE ${pattern} ESCAPE '\\'
              OR customer_last_name ILIKE ${pattern} ESCAPE '\\'
              OR customer_email ILIKE ${pattern} ESCAPE '\\'
            )
          ORDER BY updated_at DESC NULLS LAST
          LIMIT ${OPERATIONS_RESULTS_PER_TYPE}
        `),
        db.execute(sql`
          SELECT id, display_name, email, role
          FROM users
          WHERE deleted_at IS NULL
            AND role IN ('staff', 'grader', 'senior_grader')
            AND (display_name ILIKE ${pattern} ESCAPE '\\' OR email ILIKE ${pattern} ESCAPE '\\')
          ORDER BY display_name NULLS LAST, email NULLS LAST
          LIMIT ${OPERATIONS_RESULTS_PER_TYPE}
        `),
        partnerAdminDbConfigured()
          ? partnerAdminQuery<{
              id: string;
              legal_name: string;
              trading_name: string | null;
              status: string;
            }>(
              `SELECT o.id, o.legal_name, p.trading_name, o.status
                 FROM partner_organisations o
                 LEFT JOIN partner_profiles p ON p.tenant_id = o.id
                WHERE o.legal_name ILIKE $1 ESCAPE '\\' OR p.trading_name ILIKE $1 ESCAPE '\\'
                ORDER BY o.created_at DESC
                LIMIT $2`,
              [pattern, OPERATIONS_RESULTS_PER_TYPE]
            ).catch((error) => {
              console.warn(
                "[admin-operations] partner search unavailable",
                error instanceof Error ? error.message : error
              );
              return { rows: [] };
            })
          : Promise.resolve({ rows: [] }),
      ]);

      const results: SearchResult[] = [
        ...(certificateRows.rows as Array<Record<string, string | null>>).map((row) => {
          const certId = row.certificate_number ?? "";
          const details = [row.set_name, row.card_number_display ? `#${row.card_number_display}` : null]
            .filter(Boolean)
            .join(" · ");
          return {
            id: certId,
            type: "certificate" as const,
            title: row.card_name || certId,
            subtitle: [certId, details, row.grader_name ? `Grader: ${row.grader_name}` : null]
              .filter(Boolean)
              .join(" · "),
            href: `/admin?tab=certs&search=${encodeURIComponent(certId)}`,
          };
        }),
        ...(submissionRows.rows as Array<Record<string, string | null>>).map((row) => {
          const customerName = [row.customer_first_name, row.customer_last_name].filter(Boolean).join(" ");
          return {
            id: row.tracking_number ?? "",
            type: "submission" as const,
            title: row.tracking_number ?? "Submission",
            subtitle: [row.status, customerName || maskEmail(row.customer_email)].filter(Boolean).join(" · "),
            href: `/admin?tab=submissions&search=${encodeURIComponent(row.tracking_number ?? "")}`,
          };
        }),
        ...(staffRows.rows as Array<Record<string, string | null>>).map((row) => ({
          id: row.id ?? "",
          type: "staff" as const,
          title: row.display_name || "Staff member",
          subtitle: [row.role, maskEmail(row.email)].filter(Boolean).join(" · "),
          href: "/admin/staff",
        })),
        ...partnerRows.rows.map((row) => ({
          id: row.id,
          type: "partner" as const,
          title: row.trading_name || row.legal_name,
          subtitle: [row.legal_name, row.status].filter(Boolean).join(" · "),
          href: `/admin/partner-network/partners/${encodeURIComponent(row.id)}`,
        })),
      ];

      res.json({ query, groups: resultGroups(results) });
    } catch (error) {
      console.error("[admin-operations] search failed", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Unable to search operational records" });
    }
  });
}
