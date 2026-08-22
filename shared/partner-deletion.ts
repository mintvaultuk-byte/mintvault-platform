/**
 * PERMANENTLY DELETING A SETUP-ONLY PARTNER — the shared contract shape.
 *
 * WHY THIS EXISTS AS A CONTRACT RATHER THAN A TRY-IT-AND-SEE. Deletion in this schema is decided by
 * roughly sixty foreign keys, most of them ON DELETE RESTRICT by deliberate design. Simply issuing
 * the DELETE and showing the operator whatever PostgreSQL said produces messages like
 * `update or delete on table "partner_organisations" violates foreign key constraint
 * "partner_wallets_tenant_id_fkey"` — which tells a non-technical operator nothing, names one
 * arbitrary blocker out of possibly several, and offers a destructive button that was never going to
 * work. So the server ASSESSES first and returns a decision plus every reason, and the UI only ever
 * offers the button when the assessment says yes.
 *
 * These are TYPES ONLY. Every value, including the human-readable copy, is produced by
 * `assessPartnerDeletion` on the server.
 */

/**
 * Why a Partner cannot be permanently deleted.
 *
 * Grouped by what the rows MEAN to the business rather than by which table they live in, because
 * "this shop has taken payments" is actionable and "partner_credit_ledger has 3 rows" is not.
 *
 * OPERATIONAL_HISTORY_EXISTS is the FAIL-CLOSED default. Any dependency the classification does not
 * recognise — a table added by a future migration, most obviously — lands there and BLOCKS. A new
 * table therefore cannot become silently deletable by being forgotten; the worst case is a deletion
 * refused with an honest, if generic, reason.
 */
export type PartnerDeletionBlockerCode =
  | "FINANCIAL_HISTORY_EXISTS"
  | "CHECKOUT_HISTORY_EXISTS"
  | "GRADING_HISTORY_EXISTS"
  | "CERTIFICATE_HISTORY_EXISTS"
  | "ORDER_HISTORY_EXISTS"
  | "STATION_HISTORY_RETAINED"
  | "CONNECTOR_HISTORY_EXISTS"
  | "CUSTOMER_HISTORY_EXISTS"
  | "PUBLIC_PRESENCE_EXISTS"
  | "INTERNAL_NOTES_EXIST"
  | "OPERATIONAL_HISTORY_EXISTS"
  | "DEPENDENCY_GRAPH_UNREADABLE";

export interface PartnerDeletionBlocker {
  code: PartnerDeletionBlockerCode;
  /** One sentence of operator-facing plain English. */
  message: string;
  /**
   * The dependency that produced this blocker, for an engineer reading a support ticket. Safe to
   * show: a table name is schema, not customer data, and no row content is ever included.
   */
  dependency: string;
}

export interface PartnerDeletionAssessment {
  partnerId: string;
  legalName: string;
  /**
   * True ONLY when every dependency was positively established as safe. Never true alongside a
   * blocker, and never true when the dependency graph could not be read — an unreadable catalogue
   * produces DEPENDENCY_GRAPH_UNREADABLE rather than an empty blocker list.
   */
  canDelete: boolean;
  blockers: PartnerDeletionBlocker[];
  /**
   * What the operator must type to confirm. The Partner's exact legal name — chosen over a fixed
   * phrase like DELETE because it proves the operator is deleting the shop they think they are,
   * which is the mistake that actually happens.
   */
  confirmationPhrase: string;
  /**
   * Setup-only records the deletion will remove along with the organisation, so the confirmation
   * screen can state plainly what disappears. Human labels, not table names.
   */
  removes: string[];
  /**
   * Records that SURVIVE the deletion, attributed to it by `deleted_tenant_id` and the tombstone
   * (migration 0108). Shown for the same reason: an operator authorising a permanent deletion should
   * see what is kept as clearly as what is destroyed.
   */
  retains: string[];
}

export interface PartnerDeletionResult {
  partnerId: string;
  legalName: string;
  deletedAt: string;
  /** Retained audit/security rows re-attributed to the deleted Partner. */
  retainedAuditRows: number;
  retainedSecurityRows: number;
  retainedManagementAuditRows: number;
}
