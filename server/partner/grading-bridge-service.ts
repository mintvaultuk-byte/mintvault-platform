/**
 * Partner -> HQ grading bridge.
 *
 * The HQ MVGS workstation grades canonical certificates. This service creates
 * certificate-backed work items from an already-submitted Partner intake, then
 * stops: no approval, label rendering, credit settlement, or submission
 * completion happens here.
 */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { withPartnerAdminTenantTransaction } from "./db";
import { writePartnerAudit } from "./audit";
import type { PartnerPrincipal } from "./session";

export class PartnerGradingBridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface CreatePartnerGradingWorkItemsInput {
  graderId: string;
}

export interface PartnerGradingWorkItem {
  certId: number;
  certNumber: string;
  partnerSubmissionCardId: string;
  cardOrdinal: number;
  gradingUrl: string;
}

export interface PartnerGradingBridgeResult {
  submissionId: string;
  created: number;
  existing: boolean;
  workItems: PartnerGradingWorkItem[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALIDATION = (message: string) => new PartnerGradingBridgeError("validation", message);
const FORBIDDEN = () => new PartnerGradingBridgeError("forbidden", "You do not have access to this submission.", 403);
const NOT_FOUND = () => new PartnerGradingBridgeError("not_found", "Submission not found.", 404);

interface SubmissionBridgeRow {
  id: string;
  public_ref: string;
  tenant_id: string;
  location_id: string;
  location_name: string;
  location_public_ref: string | null;
  location_address: string | null;
  org_public_ref: string | null;
  legal_name: string;
  org_status: string;
  location_status: string;
  trading_name: string | null;
  status: string;
}

interface CardBridgeRow {
  id: string;
  sequence_number: number;
  card_name: string;
  game: string | null;
  card_set: string | null;
  card_number: string | null;
  year: number | null;
  variant: string | null;
  language: string | null;
  declared_value_pence: number | null;
  quantity: number;
  front_image_key: string | null;
  back_image_key: string | null;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw VALIDATION(`${label} is invalid.`);
}

async function assertLocationScope(c: PoolClient, principal: PartnerPrincipal, locationId: string): Promise<void> {
  if (principal.orgWide) return;
  const own = await c.query(
    `SELECT 1 FROM partner_user_locations WHERE tenant_id=$1 AND user_id=$2 AND location_id=$3`,
    [principal.tenantId, principal.userId, locationId]
  );
  if (own.rowCount !== 1) throw FORBIDDEN();
}

async function assertGrader(c: PoolClient, graderId: string): Promise<void> {
  if (!graderId || typeof graderId !== "string") throw VALIDATION("Select a grader.");
  const grader = await c.query(
    `SELECT 1 FROM users
      WHERE id=$1 AND deleted_at IS NULL
        AND (role='grader' OR can_grade IS TRUE)
      LIMIT 1`,
    [graderId]
  );
  if (grader.rowCount !== 1) throw VALIDATION("Selected grader is not available.");
}

async function nextCertNumber(c: PoolClient): Promise<string> {
  await c.query(
    `CREATE TABLE IF NOT EXISTS cert_counter (
      id integer PRIMARY KEY DEFAULT 1,
      last_issued integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  );
  await c.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");
  const next = await c.query<{ last_issued: string }>(
    "UPDATE cert_counter SET last_issued=last_issued+1, updated_at=now() WHERE id=1 RETURNING last_issued"
  );
  const n = Number(next.rows[0]?.last_issued);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("certificate number allocation failed");
  return `MV${n}`;
}

async function loadExisting(c: PoolClient, submissionId: string): Promise<PartnerGradingWorkItem[]> {
  const { rows } = await c.query<{
    entity_id: string;
    details: {
      cert_number?: unknown;
      partner_submission_card_id?: unknown;
      card_ordinal?: unknown;
    };
  }>(
    `SELECT entity_id, details
       FROM audit_log
      WHERE entity_type='certificate'
        AND action='partner_grading_work_item_created'
        AND details->>'partner_submission_id'=$1
      ORDER BY (details->>'partner_submission_card_sequence')::int NULLS LAST,
               (details->>'card_ordinal')::int NULLS LAST,
               entity_id::int`,
    [submissionId]
  );
  return rows.map((r) => ({
    certId: Number(r.entity_id),
    certNumber: String(r.details?.cert_number ?? ""),
    partnerSubmissionCardId: String(r.details?.partner_submission_card_id ?? ""),
    cardOrdinal: Number(r.details?.card_ordinal ?? 1),
    gradingUrl: `/grader?certId=${Number(r.entity_id)}`,
  }));
}

function expectedWorkItemCount(cards: CardBridgeRow[]): number {
  return cards.reduce((sum, card) => sum + Number(card.quantity), 0);
}

function validateCards(cards: CardBridgeRow[]): void {
  if (cards.length === 0) throw VALIDATION("Add at least one card before creating grading work.");
  for (const card of cards) {
    if (!String(card.card_name ?? "").trim()) throw VALIDATION("Every card needs a name before grading.");
    if (!Number.isSafeInteger(Number(card.quantity)) || Number(card.quantity) < 1) {
      throw VALIDATION("Every card needs a valid quantity before grading.");
    }
    if (!card.front_image_key || !card.back_image_key) {
      throw new PartnerGradingBridgeError(
        "missing_images",
        "Every card needs front and back images before grading work can be created.",
        409
      );
    }
  }
}

export async function createPartnerGradingWorkItems(
  principal: PartnerPrincipal,
  submissionId: string,
  input: CreatePartnerGradingWorkItemsInput
): Promise<PartnerGradingBridgeResult> {
  assertUuid(submissionId, "Submission");
  assertUuid(input.graderId, "Grader");

  return withPartnerAdminTenantTransaction(
    { tenantId: principal.tenantId, locationId: principal.locationId },
    async (c) => {
      const submission = await c.query<SubmissionBridgeRow>(
        `SELECT s.id, s.public_ref, s.tenant_id, s.location_id, s.status,
              l.name AS location_name, l.public_ref AS location_public_ref, l.address AS location_address,
              l.status AS location_status,
              o.public_ref AS org_public_ref, o.legal_name, o.status AS org_status,
              p.trading_name
         FROM partner_submissions s
         JOIN partner_organisations o ON o.id=s.tenant_id
         JOIN partner_locations l ON l.id=s.location_id AND l.tenant_id=s.tenant_id
         LEFT JOIN partner_profiles p ON p.tenant_id=s.tenant_id
        WHERE s.id=$1 AND s.tenant_id=$2
        FOR UPDATE OF s`,
        [submissionId, principal.tenantId]
      );
      const row = submission.rows[0];
      if (!row) throw NOT_FOUND();
      await assertLocationScope(c, principal, row.location_id);
      if (row.org_status !== "ACTIVE" || row.location_status !== "ACTIVE") throw FORBIDDEN();
      if (row.status !== "submitted_to_mintvault") {
        throw new PartnerGradingBridgeError(
          "invalid_state",
          "Submit the Partner intake before creating grading work.",
          409
        );
      }
      await assertGrader(c, input.graderId);

      const cards = (
        await c.query<CardBridgeRow>(
          `SELECT id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
                declared_value_pence, quantity, front_image_key, back_image_key
           FROM partner_submission_cards
          WHERE submission_id=$1 AND tenant_id=$2 AND removed_at IS NULL
          ORDER BY sequence_number, id`,
          [submissionId, principal.tenantId]
        )
      ).rows;
      validateCards(cards);

      const expected = expectedWorkItemCount(cards);
      const existing = await loadExisting(c, submissionId);
      if (existing.length > 0) {
        if (existing.length !== expected) {
          throw new PartnerGradingBridgeError(
            "work_item_mismatch",
            "Existing grading work does not match this Partner submission.",
            409
          );
        }
        return { submissionId, created: 0, existing: true, workItems: existing };
      }

      const workItems: PartnerGradingWorkItem[] = [];
      for (const card of cards) {
        for (let ordinal = 1; ordinal <= Number(card.quantity); ordinal += 1) {
          const certNumber = await nextCertNumber(c);
          const ref = `PGB-${certNumber}-${crypto.randomBytes(4).toString("hex")}`;
          const hash = crypto
            .createHash("sha256")
            .update(`${certNumber}:${submissionId}:${card.id}:${ordinal}`)
            .digest("hex");
          const inserted = await c.query<{ id: number }>(
            `INSERT INTO certificates (
             certificate_number, status, label_type, grade_type, language,
             card_game, set_name, card_name, card_number_display, year_text, variant,
             front_image_path, back_image_path,
             created_by, issued_at, updated_at, reference_number, integrity_hash,
             print_state, assigned_grader_id, grader_status, assigned_at,
             origin_type, origin_partner_id, origin_partner_public_ref, origin_partner_legal_name,
             origin_partner_trading_name, origin_location_id, origin_location_public_ref,
             origin_location_name, origin_location_address, origin_captured_at, origin_snapshot_version
           ) VALUES (
             $1, 'draft', 'Standard', 'numeric', $2,
             $3, $4, $5, $6, $7, $8,
             $9, $10,
             $11, now(), now(), $12, $13,
             'awaiting_approval', $14, 'assigned', now(),
             'PARTNER', $15, $16, $17,
             $18, $19, $20,
             $21, $22, now(), 1
           )
           RETURNING id`,
            [
              certNumber,
              card.language || "English",
              card.game,
              card.card_set,
              card.card_name,
              card.card_number,
              card.year == null ? null : String(card.year),
              card.variant,
              card.front_image_key,
              card.back_image_key,
              `partner:${principal.userId}`,
              ref,
              hash,
              input.graderId,
              row.tenant_id,
              row.org_public_ref,
              row.legal_name,
              row.trading_name,
              row.location_id,
              row.location_public_ref,
              row.location_name,
              row.location_address,
            ]
          );
          const certId = Number(inserted.rows[0].id);
          const details = {
            partner_submission_id: submissionId,
            partner_submission_public_ref: row.public_ref,
            partner_submission_card_id: card.id,
            partner_submission_card_sequence: card.sequence_number,
            card_ordinal: ordinal,
            cert_number: certNumber,
            assigned_grader_id: input.graderId,
            origin_type: "PARTNER",
            no_approval: true,
            no_label: true,
            no_credit_settlement: true,
            no_submission_completion: true,
          };
          await c.query(
            `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
           VALUES ('certificate', $1, 'partner_grading_work_item_created', $2, $3::jsonb)`,
            [String(certId), `partner:${principal.userId}`, JSON.stringify(details)]
          );
          await writePartnerAudit(c, {
            tenantId: principal.tenantId,
            locationId: row.location_id,
            actorUserId: principal.userId,
            sessionId: principal.sessionId,
            action: "submission_card.grading_work_item_created",
            recordType: "partner_submission_card",
            recordId: card.id,
            after: details,
          });
          workItems.push({
            certId,
            certNumber,
            partnerSubmissionCardId: card.id,
            cardOrdinal: ordinal,
            gradingUrl: `/grader?certId=${certId}`,
          });
        }
      }

      return { submissionId, created: workItems.length, existing: false, workItems };
    }
  );
}
