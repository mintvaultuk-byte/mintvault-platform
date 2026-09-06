/**
 * Partner Portal — submission service (Phase 2).
 *
 * Most queries run inside withTenant() so RLS scopes every statement to the caller's tenant (the
 * floor). Submit/cancel use a deliberately narrow privileged transaction because G6B's immutable
 * accounting writes need the wallet row lock and lifecycle-event permissions denied to the Partner
 * runtime. Those paths carry explicit tenant predicates and cross-table tenant invariants; their
 * app.tenant_id context is observability/defence in depth, never a substitute for RLS. Location
 * scoping — reception/technician see only their assigned location(s); org-wide
 * roles (owner/manager/finance-viewer) see the whole organisation — is enforced HERE in application
 * SQL, exactly as documented in migration 0001: "the DB tenant boundary is the floor."
 *
 * State machine (Phase 2 spec §3):
 *   draft --(edit)--> draft
 *   draft --(submit, validated)--> submitted_to_mintvault   [creates a handoff row]
 *   draft --(cancel)--> cancelled
 *   submitted_to_mintvault --(cancel)--> cancelled           [rare, always audited]
 * No other transition is permitted. Every transition writes a partner_submission_events row.
 */
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { withPartnerAdminTenantTransaction, withTenant } from "./db";
import { writePartnerAudit } from "./audit";
import type { PartnerPrincipal } from "./session";
import { getR2SignedUrl } from "../r2";
import {
  ObjectWriteCoordinator,
  ObjectWriteAbandonError,
  ObjectWriteConflictError,
  ObjectWriteInProgressError,
  ObjectWriteTerminalError,
  readObjectWriteSnapshot,
  sha256Hex,
  type ObjectWriteFinalizeContext,
  type ObjectWriteSnapshot,
  type ObjectWriteTransactionRunner,
} from "../lib/object-write-coordinator";
import { objectWriteStore } from "../lib/object-write-store";
import { CreditReservationError, reserveCreditInTransaction } from "./partner-credit-reservation-service";
import { resolveFlag } from "./flags";
import {
  PartnerSubmissionCreditLifecycleError,
  releasePartnerReservationForPartnerCancellation,
} from "./partner-submission-credit-lifecycle";

export class SubmissionError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

const NOT_FOUND = () => new SubmissionError("not_found", "Submission not found.");
const FORBIDDEN = () => new SubmissionError("forbidden", "You do not have access to this submission.");
const STALE = () =>
  new SubmissionError("stale_version", "This submission was updated elsewhere. Refresh before saving again.");
const NOT_DRAFT = () => new SubmissionError("not_draft", "This submission can no longer be edited.");
const VALIDATION = (msg: string) => new SubmissionError("validation", msg);
const INVALID_SERVICE_TIER = () => new SubmissionError("invalid_service_tier", "Select an available service.");
const SERVICE_TIER_UNAVAILABLE = () =>
  new SubmissionError(
    "service_tier_unavailable",
    "This service is no longer available. Choose an available service before submitting."
  );

/** Kept deliberately longer than MintVault's published grading turnaround; expiry remains the
 * G6B safety backstop, while normal settlement is driven by the grading lifecycle below. */
const PARTNER_SUBMISSION_CREDIT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * THE SINGLE OWNER OF "may this operation run against a submission in this state?".
 *
 * This replaces SEVEN independently written guard clauses that had drifted into two different
 * spellings of the same idea — five sites tested `status !== "draft"` and two tested
 * `status === "cancelled"` — with the legal graph existing only as the doc comment at the top of
 * this file. Seven copies of a rule is seven places for the eighth caller to forget it, and nothing
 * made the two spellings agree.
 *
 * Expressing it as an ALLOWLIST per operation rather than a denylist is the point: a new lifecycle
 * state added by a future migration is refused by default and must be consciously admitted here,
 * instead of silently becoming permitted everywhere the denylist did not happen to mention it.
 *
 * BEHAVIOUR TODAY IS IDENTICAL. The live status domain is exactly
 * ('draft','submitted_to_mintvault','cancelled') — migration 0007's CHECK — so "not cancelled" and
 * "draft or submitted_to_mintvault" describe the same set. Migration 0074 widens that domain to
 * eight values, and when it lands this allowlist becomes STRICTER rather than looser: cancelling or
 * uploading against a submission already in `grading` or `completed` will be refused, which is what
 * the documented state machine says should happen and what the old denylist would have allowed.
 *
 * This is the APPLICATION half of lifecycle enforcement. It does not replace database enforcement
 * and must never be treated as sufficient on its own: `partner_card_jobs` carries its own
 * ENABLE ALWAYS transition trigger (migration 0080), and `partner_runtime` holds UPDATE on
 * `partner_submissions.status`, so the DB remains the floor.
 */
export type SubmissionOperation =
  | "EDIT_SUBMISSION"
  | "ADD_CARD"
  | "EDIT_CARD"
  | "REMOVE_CARD"
  | "SUBMIT"
  | "CANCEL"
  | "UPLOAD_CARD_IMAGE";

const SUBMISSION_OPERATION_ALLOWED_FROM: Readonly<Record<SubmissionOperation, readonly string[]>> = {
  // Content edits require an unsubmitted submission — once handed to MintVault the contents are
  // part of an accepted, credit-reserved handoff and may not change underneath it.
  EDIT_SUBMISSION: ["draft"],
  ADD_CARD: ["draft"],
  EDIT_CARD: ["draft"],
  REMOVE_CARD: ["draft"],
  SUBMIT: ["draft"],
  // Cancellation is legal from draft AND after handoff (the doc'd "rare, always audited" path).
  CANCEL: ["draft", "submitted_to_mintvault"],
  // Evidence may still be attached after handoff; it adds to the record rather than altering the
  // agreed contents.
  UPLOAD_CARD_IMAGE: ["draft", "submitted_to_mintvault"],
};

/**
 * Throws the SAME error the seven inline guards threw, so no caller's contract changes.
 * `NOT_DRAFT` is retained as the error identity deliberately: it is what the API surface and the
 * existing tests assert on, and renaming it would be a breaking change dressed up as a cleanup.
 */
function assertSubmissionOperationAllowed(status: string, operation: SubmissionOperation): void {
  if (!SUBMISSION_OPERATION_ALLOWED_FROM[operation].includes(status)) throw NOT_DRAFT();
}

/** Location-scope predicate, appended to every submission query. Org-wide roles see everything;
 *  everyone else is restricted to their assigned locations via partner_user_locations.
 *  `paramOffset` is the count of placeholders already used earlier in the caller's query, so the
 *  generated placeholder index is always correct regardless of where this predicate is spliced in
 *  (a hardcoded $1 here previously collided with an earlier $1 in getSubmissionDetail — fixed). */
async function locationScopeSql(
  c: PoolClient,
  principal: PartnerPrincipal,
  paramOffset: number
): Promise<{ sql: string; params: unknown[] }> {
  if (principal.orgWide) return { sql: "TRUE", params: [] };
  const { rows } = await c.query<{ location_id: string }>(
    `SELECT pul.location_id
       FROM partner_user_locations pul
       JOIN partner_users u ON u.id=pul.user_id AND u.tenant_id=pul.tenant_id
       JOIN partner_locations l ON l.id=pul.location_id AND l.tenant_id=pul.tenant_id
      WHERE pul.user_id=$1 AND pul.tenant_id=$2`,
    [principal.userId, principal.tenantId]
  );
  const ids = rows.map((r) => r.location_id);
  if (ids.length === 0) return { sql: "FALSE", params: [] }; // no assignment = no visibility, fail closed
  return { sql: `location_id = ANY($${paramOffset + 1}::uuid[])`, params: [ids] };
}

export interface SubmissionSummary {
  id: string;
  publicRef: string;
  locationId: string;
  customerId: string | null;
  internalReference: string | null;
  serviceTierCode: string | null;
  estimatedPricePence: number | null;
  cardCount: number;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export async function listSubmissions(
  principal: PartnerPrincipal,
  opts: { status?: string; page?: number; pageSize?: number } = {}
): Promise<{ items: SubmissionSummary[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25)); // guards oversized/malformed pagination
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const scope = await locationScopeSql(c, principal, 0); // scope predicate is first in this query
    const params: unknown[] = [...scope.params];
    const whereParts = [scope.sql];
    if (opts.status) {
      whereParts.push(`status = $${params.length + 1}`);
      params.push(opts.status);
    }
    const where = whereParts.join(" AND ");
    const countRes = await c.query<{ n: string }>(
      `SELECT count(*)::text n FROM partner_submissions WHERE ${where}`,
      params
    );
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const { rows } = await c.query(
      `SELECT id, public_ref, location_id, customer_id, internal_reference, service_tier_code,
              estimated_price_pence, card_count, status, version, created_at, updated_at, submitted_at
         FROM partner_submissions WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    return {
      items: rows.map(toSummary),
      total: Number(countRes.rows[0]?.n ?? 0),
    };
  });
}

function toSummary(r: any): SubmissionSummary {
  return {
    id: r.id,
    publicRef: r.public_ref,
    locationId: r.location_id,
    customerId: r.customer_id,
    internalReference: r.internal_reference,
    serviceTierCode: r.service_tier_code,
    estimatedPricePence: r.estimated_price_pence,
    cardCount: r.card_count,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    submittedAt: r.submitted_at,
  };
}

export interface CreateSubmissionInput {
  locationId: string;
  customerId?: string | null;
  internalReference?: string | null;
  serviceTierCode?: string | null;
  intakeNotes?: string | null;
}

export async function createSubmissionDraft(
  principal: PartnerPrincipal,
  input: CreateSubmissionInput
): Promise<SubmissionSummary> {
  if (!input.locationId) throw VALIDATION("A location is required.");
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    // Never trust a client-supplied location — it must be one this user is actually assigned to,
    // UNLESS the user is org-wide (owner/manager may create on behalf of any org location).
    const assigned = await c.query<{ name: string }>(
      "SELECT name FROM partner_locations WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",
      [input.locationId, principal.tenantId]
    );
    if (assigned.rowCount !== 1) throw VALIDATION("Selected location is not available.");
    const locationNameSnapshot = assigned.rows[0].name;
    if (!principal.orgWide) {
      const own = await c.query(
        `SELECT 1
           FROM partner_user_locations pul
           JOIN partner_users u ON u.id=pul.user_id AND u.tenant_id=pul.tenant_id
           JOIN partner_locations l ON l.id=pul.location_id AND l.tenant_id=pul.tenant_id
          WHERE pul.user_id=$1 AND pul.location_id=$2 AND pul.tenant_id=$3`,
        [principal.userId, input.locationId, principal.tenantId]
      );
      if (own.rowCount !== 1) throw FORBIDDEN();
    }
    await verifyCustomerOwnership(c, principal.tenantId, input.customerId ?? null);
    // serviceTierCode is optional at draft creation (null = no tier chosen yet); if a code IS
    // supplied (including an empty string) it must resolve to an approved, currently-active tier —
    // never accepted as arbitrary text.
    const estimatedPrice =
      input.serviceTierCode != null
        ? (await resolveServiceTier(c, principal.tenantId, input.serviceTierCode)).pricePerCardPence
        : null;
    const hasLocationSnapshot = await partnerSubmissionsHasLocationSnapshot(c);
    const { rows } = hasLocationSnapshot
      ? await c.query(
          `INSERT INTO partner_submissions
             (tenant_id, location_id, location_name_snapshot, created_by, customer_id, internal_reference, service_tier_code, estimated_price_pence, intake_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, public_ref, location_id, customer_id, internal_reference, service_tier_code,
                     estimated_price_pence, card_count, status, version, created_at, updated_at, submitted_at`,
          [
            principal.tenantId,
            input.locationId,
            locationNameSnapshot,
            principal.userId,
            input.customerId ?? null,
            input.internalReference ?? null,
            input.serviceTierCode ?? null,
            estimatedPrice,
            input.intakeNotes ?? null,
          ]
        )
      : await c.query(
          `INSERT INTO partner_submissions
             (tenant_id, location_id, created_by, customer_id, internal_reference, service_tier_code, estimated_price_pence, intake_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, public_ref, location_id, customer_id, internal_reference, service_tier_code,
                     estimated_price_pence, card_count, status, version, created_at, updated_at, submitted_at`,
          [
            principal.tenantId,
            input.locationId,
            principal.userId,
            input.customerId ?? null,
            input.internalReference ?? null,
            input.serviceTierCode ?? null,
            estimatedPrice,
            input.intakeNotes ?? null,
          ]
        );
    const row = rows[0];
    await writeEvent(c, principal, row.id, "created", null, "draft", null);
    return toSummary(row);
  });
}

async function partnerSubmissionsHasLocationSnapshot(c: PoolClient): Promise<boolean> {
  const { rows } = await c.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'partner_submissions'
          AND column_name = 'location_name_snapshot'
     )`
  );
  return rows[0]?.exists === true;
}

/**
 * A `customer_id` FK check alone is NOT tenant-safe: PostgreSQL foreign-key/unique-constraint
 * checks always bypass row-level security, so an INSERT/UPDATE referencing another tenant's
 * partner_customers row would otherwise succeed silently (cross-tenant data contamination).
 * Explicitly re-verify ownership here, mirroring the locationId check above.
 */
async function verifyCustomerOwnership(c: PoolClient, tenantId: string, customerId: string | null): Promise<void> {
  if (!customerId) return;
  const owned = await c.query("SELECT 1 FROM partner_customers WHERE id=$1 AND tenant_id=$2", [customerId, tenantId]);
  if (owned.rowCount !== 1) throw VALIDATION("Selected customer is not available.");
}

/**
 * Resolve + VALIDATE a service-tier code against the approved Partner tier configuration. Returns
 * the price to store, or throws INVALID_SERVICE_TIER if the code does not match any active tier
 * visible to this tenant. serviceTierCode is optional throughout (a draft may have none), so `null`
 * is a valid non-error input — this is called only when a non-null code is actually supplied.
 *
 * Cross-tenant safety: the query runs on `c`, whose transaction already has app.tenant_id set (by
 * withTenant), so partner_service_tiers' RLS policy (`tenant_id IS NULL OR tenant_id =
 * partner_current_tenant()`) makes another tenant's PRIVATE tier row simply invisible here — no
 * additional tenant filter is needed beyond what RLS already enforces; `tenant_id=$2` in the WHERE
 * clause is redundant-but-explicit defense in depth, not the actual security boundary. A
 * tenant-specific active tier takes priority over a global one with the same code (ORDER BY
 * tenant_id NULLS LAST). Unknown code, disabled tier, or (should it ever occur) a code that only
 * exists as another tenant's private tier all resolve identically to zero rows -> one uniform
 * rejection, so existence of another tenant's private tier is never revealed.
 */
async function resolveServiceTier(
  c: PoolClient,
  tenantId: string,
  tierCode: string
): Promise<{ pricePerCardPence: number }> {
  const { rows } = await c.query<{ price_per_card_pence: number }>(
    `SELECT price_per_card_pence FROM partner_service_tiers
      WHERE tier_code=$1 AND is_active AND (tenant_id=$2 OR tenant_id IS NULL)
      ORDER BY tenant_id NULLS LAST LIMIT 1`,
    [tierCode, tenantId]
  );
  if (rows.length !== 1) throw INVALID_SERVICE_TIER();
  return { pricePerCardPence: rows[0].price_per_card_pence };
}

async function activeCardQuantityTotal(c: PoolClient, submissionId: string, tenantId: string): Promise<number> {
  const { rows } = await c.query<{ total: number }>(
    `SELECT COALESCE(SUM(quantity), 0)::int AS total
       FROM partner_submission_cards
      WHERE submission_id=$1 AND tenant_id=$2 AND removed_at IS NULL`,
    [submissionId, tenantId]
  );
  return Number(rows[0]?.total ?? 0);
}

async function recomputeSubmissionTotals(c: PoolClient, tenantId: string, submissionId: string): Promise<void> {
  const totalQuantity = await activeCardQuantityTotal(c, submissionId, tenantId);
  const { rows } = await c.query<{ service_tier_code: string | null }>(
    `SELECT service_tier_code FROM partner_submissions WHERE id=$1 AND tenant_id=$2`,
    [submissionId, tenantId]
  );
  const tierCode = rows[0]?.service_tier_code ?? null;
  const estimatedPrice =
    tierCode === null ? null : (await resolveServiceTier(c, tenantId, tierCode)).pricePerCardPence * totalQuantity;
  await c.query(
    `UPDATE partner_submissions
        SET card_count=$3, estimated_price_pence=$4, updated_at=now()
      WHERE id=$1 AND tenant_id=$2`,
    [submissionId, tenantId, totalQuantity, estimatedPrice]
  );
}

async function writeEvent(
  c: PoolClient,
  principal: Pick<PartnerPrincipal, "tenantId" | "userId">,
  submissionId: string,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  reason: string | null,
  metadata?: Record<string, unknown> | null
): Promise<void> {
  await c.query(
    `INSERT INTO partner_submission_events
       (tenant_id, submission_id, actor_user_id, event_type, from_status, to_status, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [principal.tenantId, submissionId, principal.userId, eventType, fromStatus, toStatus, reason, metadata ?? null]
  );
}

async function loadSubmissionForUpdate(
  c: PoolClient,
  principal: PartnerPrincipal,
  submissionId: string
): Promise<{
  id: string;
  location_id: string;
  status: string;
  version: number;
  idempotency_key: string | null;
} | null> {
  const { rows } = await c.query(
    `SELECT s.id, s.location_id, s.status, s.version, s.idempotency_key
       FROM partner_submissions s
       JOIN partner_locations l ON l.id=s.location_id AND l.tenant_id=s.tenant_id
      WHERE s.id=$1 AND s.tenant_id=$2
      FOR UPDATE OF s`,
    [submissionId, principal.tenantId]
  );
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!principal.orgWide) {
    const own = await c.query(
      `SELECT 1
         FROM partner_user_locations pul
         JOIN partner_users u ON u.id=pul.user_id AND u.tenant_id=pul.tenant_id
         JOIN partner_locations l ON l.id=pul.location_id AND l.tenant_id=pul.tenant_id
        WHERE pul.user_id=$1 AND pul.location_id=$2 AND pul.tenant_id=$3`,
      [principal.userId, row.location_id, principal.tenantId]
    );
    if (own.rowCount !== 1) return null; // fail closed as not-found, not forbidden (no existence leak)
  }
  return row;
}

export interface EditSubmissionInput {
  version: number;
  customerId?: string | null;
  internalReference?: string | null;
  serviceTierCode?: string | null;
  intakeNotes?: string | null;
}

export async function editSubmissionDraft(
  principal: PartnerPrincipal,
  submissionId: string,
  input: EditSubmissionInput
): Promise<SubmissionSummary> {
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const row = await loadSubmissionForUpdate(c, principal, submissionId);
    if (!row) throw NOT_FOUND();
    assertSubmissionOperationAllowed(row.status, "EDIT_SUBMISSION");
    if (row.version !== input.version) throw STALE();
    if (input.customerId !== undefined) await verifyCustomerOwnership(c, principal.tenantId, input.customerId);
    // Same rule as create: undefined = not changing the tier; null = explicitly clearing it;
    // any other string (including "") must resolve to an approved, currently-active tier.
    let tierChanged = false;
    let newTierCode: string | null | undefined;
    let newEstimatedPrice: number | null | undefined;
    if (input.serviceTierCode !== undefined) {
      tierChanged = true;
      if (input.serviceTierCode === null) {
        newTierCode = null;
        newEstimatedPrice = null;
      } else {
        const totalQuantity = await activeCardQuantityTotal(c, submissionId, principal.tenantId);
        newEstimatedPrice =
          (await resolveServiceTier(c, principal.tenantId, input.serviceTierCode)).pricePerCardPence * totalQuantity;
        newTierCode = input.serviceTierCode;
      }
    }
    const { rows } = await c.query(
      `UPDATE partner_submissions SET
         customer_id = COALESCE($3, customer_id),
         internal_reference = COALESCE($4, internal_reference),
         service_tier_code = CASE WHEN $8 THEN $5 ELSE service_tier_code END,
         estimated_price_pence = CASE WHEN $8 THEN $6 ELSE estimated_price_pence END,
         intake_notes = COALESCE($7, intake_notes),
         version = version + 1,
         updated_at = now()
       WHERE id=$1 AND version=$2
       RETURNING id, public_ref, location_id, customer_id, internal_reference, service_tier_code,
                 estimated_price_pence, card_count, status, version, created_at, updated_at, submitted_at`,
      [
        submissionId,
        input.version,
        input.customerId ?? null,
        input.internalReference ?? null,
        newTierCode ?? null,
        newEstimatedPrice ?? null,
        input.intakeNotes ?? null,
        tierChanged,
      ]
    );
    if (rows.length !== 1) throw STALE(); // lost the race between load and update
    await writeEvent(c, principal, submissionId, "updated", "draft", "draft", null);
    return toSummary(rows[0]);
  });
}

export async function cancelSubmission(
  principal: PartnerPrincipal,
  submissionId: string,
  reason: string
): Promise<SubmissionSummary> {
  if (!reason || !reason.trim()) throw VALIDATION("A cancellation reason is required.");
  try {
    return await withPartnerAdminTenantTransaction({ tenantId: principal.tenantId }, async (c) => {
      const row = await loadSubmissionForUpdate(c, principal, submissionId);
      if (!row) throw NOT_FOUND();
      assertSubmissionOperationAllowed(row.status, "CANCEL");

      const actor = await c.query<{ email: string; status: string }>(
        `SELECT email, status FROM partner_users WHERE id=$1 AND tenant_id=$2 FOR KEY SHARE`,
        [principal.userId, principal.tenantId]
      );
      if (actor.rowCount !== 1 || actor.rows[0].status !== "ACTIVE") throw FORBIDDEN();

      const release = await releasePartnerReservationForPartnerCancellation(c, {
        tenantId: principal.tenantId,
        partnerSubmissionId: submissionId,
        actorUserId: principal.userId,
        actorEmail: actor.rows[0].email,
      });
      const { rows } = await c.query(
        `UPDATE partner_submissions
            SET status='cancelled', cancelled_reason=$2, cancelled_at=now(), version=version+1, updated_at=now()
          WHERE id=$1 AND tenant_id=$3
          RETURNING id, public_ref, location_id, customer_id, internal_reference, service_tier_code,
                    estimated_price_pence, card_count, status, version, created_at, updated_at, submitted_at`,
        [submissionId, reason, principal.tenantId]
      );
      await writeEvent(c, principal, submissionId, "cancelled", row.status, "cancelled", reason);
      await writePartnerAudit(c, {
        tenantId: principal.tenantId,
        locationId: row.location_id,
        actorUserId: principal.userId,
        action: "submission.cancelled",
        recordType: "partner_submission",
        recordId: submissionId,
        before: { status: row.status },
        after: { status: "cancelled", reservationReleased: release.released },
        reason,
        correlationId: release.reservationId,
      });
      return toSummary(rows[0]);
    });
  } catch (err) {
    if (err instanceof PartnerSubmissionCreditLifecycleError) {
      throw new SubmissionError("credit_settlement_required", err.message);
    }
    throw err;
  }
}

export interface CardInput {
  cardName: string;
  game?: string | null;
  cardSet?: string | null;
  cardNumber?: string | null;
  year?: number | null;
  variant?: string | null;
  language?: string | null;
  declaredValuePence?: number | null;
  quantity?: number;
  customerNotes?: string | null;
  intakeNotes?: string | null;
}

export interface CardImage {
  side: "front" | "back";
  key: string | null;
  url: string | null;
}

const ALLOWED_CARD_IMAGE_MIMES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/tiff", "tiff"],
]);

function cardImageKey(
  tenantId: string,
  submissionId: string,
  cardId: string,
  side: "front" | "back",
  revision: string,
  ext: string
) {
  return `partner-submissions/${tenantId}/${submissionId}/${cardId}/revisions/${revision}/${side}.${ext}`;
}

interface PartnerCardImageIntent {
  tenantId: string;
  submissionId: string;
  cardId: string;
  side: "front" | "back";
  beforeKey: string | null;
  locationId: string;
  actorUserId: string;
  sessionId: string;
  mime: string;
  size: number;
}

interface PartnerCardImageDescriptor extends Record<string, unknown> {
  operationId: string;
  submissionId: string;
  cardId: string;
  side: "front" | "back";
  logicalSlot: string;
  key: string;
  sha256: string;
  byteLength: number;
  contentType: string;
}

function partnerObjectWriteError(error: unknown): never {
  if (error instanceof ObjectWriteConflictError) {
    throw new SubmissionError(
      "idempotency_conflict",
      "This upload key is already bound to a different image. Choose the image again to start a new upload."
    );
  }
  if (error instanceof ObjectWriteInProgressError) {
    throw new SubmissionError("upload_in_progress", "This image upload is still being verified. Retry shortly.");
  }
  if (error instanceof ObjectWriteTerminalError) {
    throw new SubmissionError("upload_terminal", "This image upload cannot be resumed. Choose the image again.");
  }
  throw error;
}

function assertPartnerCardImageReplay(
  snapshot: ObjectWriteSnapshot,
  principal: PartnerPrincipal,
  submissionId: string,
  cardId: string,
  side: "front" | "back"
): void {
  const payload = snapshot.intentPayload;
  if (
    snapshot.tenantId !== principal.tenantId ||
    snapshot.operationKind !== "PARTNER_CARD_IMAGE" ||
    snapshot.aggregateType !== "partner_submission_card" ||
    snapshot.aggregateId !== cardId ||
    snapshot.actorId !== principal.userId ||
    payload.tenantId !== principal.tenantId ||
    payload.submissionId !== submissionId ||
    payload.cardId !== cardId ||
    payload.side !== side ||
    payload.actorUserId !== principal.userId ||
    snapshot.items.length !== 1
  ) {
    throw new ObjectWriteConflictError("Idempotency key is already bound to another card image request");
  }
}

function parsePartnerCardImageIntent(context: ObjectWriteFinalizeContext): PartnerCardImageIntent {
  const payload = context.intentPayload;
  const side = payload.side;
  if (
    context.operationKind !== "PARTNER_CARD_IMAGE" ||
    context.aggregateType !== "partner_submission_card" ||
    typeof context.tenantId !== "string" ||
    typeof payload.tenantId !== "string" ||
    payload.tenantId !== context.tenantId ||
    typeof payload.submissionId !== "string" ||
    typeof payload.cardId !== "string" ||
    (side !== "front" && side !== "back") ||
    !(payload.beforeKey === null || typeof payload.beforeKey === "string") ||
    typeof payload.locationId !== "string" ||
    typeof payload.actorUserId !== "string" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.mime !== "string" ||
    typeof payload.size !== "number" ||
    !Number.isSafeInteger(payload.size) ||
    payload.size <= 0
  ) {
    throw new Error("PARTNER_CARD_IMAGE intent is malformed");
  }
  return {
    tenantId: payload.tenantId,
    submissionId: payload.submissionId,
    cardId: payload.cardId,
    side,
    beforeKey: payload.beforeKey,
    locationId: payload.locationId,
    actorUserId: payload.actorUserId,
    sessionId: payload.sessionId,
    mime: payload.mime,
    size: payload.size,
  };
}

export async function finalizePartnerCardImageObjectWrite(
  client: PoolClient,
  context: ObjectWriteFinalizeContext
): Promise<PartnerCardImageDescriptor> {
  const intent = parsePartnerCardImageIntent(context);
  if (
    context.aggregateId !== intent.cardId ||
    context.actorId !== intent.actorUserId ||
    context.expectedState.beforeKey !== intent.beforeKey ||
    context.items.length !== 1
  ) {
    throw new Error("PARTNER_CARD_IMAGE manifest does not identify exactly one card image");
  }
  const item = context.items[0];
  if (
    item.store !== "R2" ||
    item.logicalSlot !== intent.side ||
    item.verificationState !== "VERIFIED" ||
    item.required !== true ||
    item.objectClass !== "CANONICAL" ||
    item.priorObjectKey !== intent.beforeKey ||
    item.contentType !== intent.mime ||
    item.byteLength !== intent.size
  ) {
    throw new Error("PARTNER_CARD_IMAGE object is not verified for the intended side");
  }
  const descriptor: PartnerCardImageDescriptor = {
    operationId: context.operationId,
    submissionId: intent.submissionId,
    cardId: intent.cardId,
    side: intent.side,
    logicalSlot: item.logicalSlot,
    key: item.objectKey,
    sha256: item.contentSha256,
    byteLength: item.byteLength,
    contentType: item.contentType,
  };
  const submission = await client.query<{ status: string; location_id: string }>(
    `SELECT status,location_id FROM partner_submissions
      WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
    [intent.submissionId, intent.tenantId]
  );
  if (submission.rowCount !== 1 || submission.rows[0].location_id !== intent.locationId) {
    throw new ObjectWriteAbandonError("Partner submission is unavailable for card-image publication");
  }
  try {
    assertSubmissionOperationAllowed(submission.rows[0].status, "UPLOAD_CARD_IMAGE");
  } catch {
    throw new ObjectWriteAbandonError("Partner submission state no longer permits card-image publication");
  }
  const column = intent.side === "front" ? "front_image_key" : "back_image_key";
  const current = await client.query<{ image_key: string | null }>(
    `SELECT ${column} AS image_key FROM partner_submission_cards
      WHERE id=$1 AND submission_id=$2 AND tenant_id=$3 AND removed_at IS NULL
      FOR UPDATE`,
    [intent.cardId, intent.submissionId, intent.tenantId]
  );
  if (current.rowCount !== 1) {
    throw new ObjectWriteAbandonError("Partner card is unavailable for card-image publication");
  }
  if (current.rows[0].image_key !== intent.beforeKey) {
    throw new ObjectWriteAbandonError("Partner card image changed before publication");
  }
  const updated = await client.query(
    `UPDATE partner_submission_cards SET ${column}=$4,updated_at=now()
      WHERE id=$1 AND submission_id=$2 AND tenant_id=$3
        AND ${column} IS NOT DISTINCT FROM $5
      RETURNING id`,
    [intent.cardId, intent.submissionId, intent.tenantId, item.objectKey, intent.beforeKey]
  );
  if (updated.rowCount !== 1) {
    throw new ObjectWriteAbandonError("Partner card image update lost its compare-and-swap");
  }
  await writeEvent(client, {
    tenantId: intent.tenantId,
    userId: intent.actorUserId,
  }, intent.submissionId, "card_image_uploaded", null, null, null, {
    cardId: intent.cardId,
    side: intent.side,
    replaced: !!intent.beforeKey,
    object: descriptor,
  });
  await writePartnerAudit(client, {
    tenantId: intent.tenantId,
    locationId: intent.locationId,
    actorUserId: intent.actorUserId,
    action: "submission.card_image_uploaded",
    recordType: "partner_submission_card",
    recordId: intent.cardId,
    before: intent.beforeKey ? { [intent.side]: "present" } : null,
    after: { side: intent.side, object: descriptor },
    sessionId: intent.sessionId,
    correlationId: context.operationId,
  });
  return descriptor;
}

export async function uploadCardImage(
  principal: PartnerPrincipal,
  submissionId: string,
  cardId: string,
  side: "front" | "back",
  file: { buffer: Buffer; mimetype?: string | null; originalname?: string | null; size?: number | null },
  requestIdempotencyKey?: string | null
): Promise<CardImage> {
  if (!file?.buffer?.length) throw VALIDATION("Choose an image to upload.");
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected?.mime) throw VALIDATION("Upload a JPEG, PNG, WebP or TIFF image.");
  const mime = detected.mime;
  const ext = ALLOWED_CARD_IMAGE_MIMES.get(mime);
  if (!ext) throw VALIDATION("Upload a JPEG, PNG, WebP or TIFF image.");
  const suppliedKey = requestIdempotencyKey?.trim() ?? "";
  if (!suppliedKey) throw VALIDATION("An Idempotency-Key header is required for image uploads.");
  if (suppliedKey.length > 200) throw VALIDATION("Idempotency key is too long.");
  const ledgerKey = `partner-card-image:${sha256Hex(suppliedKey)}`;
  const prepared = await withTenant({ tenantId: principal.tenantId }, async (c) => {
    const row = await loadSubmissionForUpdate(c, principal, submissionId);
    if (!row) throw NOT_FOUND();
    const current = await c.query<{ id: string; front_image_key: string | null; back_image_key: string | null }>(
      `SELECT id, front_image_key, back_image_key
         FROM partner_submission_cards
        WHERE id=$1 AND submission_id=$2 AND tenant_id=$3 AND removed_at IS NULL`,
      [cardId, submissionId, principal.tenantId]
    );
    if (current.rows.length !== 1) throw NOT_FOUND();
    const snapshot = await readObjectWriteSnapshot(c, principal.tenantId, ledgerKey);
    if (snapshot) {
      assertPartnerCardImageReplay(snapshot, principal, submissionId, cardId, side);
      return { row, beforeKey: null, snapshot };
    }
    assertSubmissionOperationAllowed(row.status, "UPLOAD_CARD_IMAGE");
    const beforeKey = side === "front" ? current.rows[0].front_image_key : current.rows[0].back_image_key;
    return { row, beforeKey, snapshot: null };
  });
  const revision = sha256Hex(`${principal.tenantId}:${submissionId}:${cardId}:${side}:${suppliedKey}`).slice(0, 32);
  const key = cardImageKey(principal.tenantId, submissionId, cardId, side, revision, ext);
  const tenantRunner: ObjectWriteTransactionRunner = {
    transaction: (operation) => withTenant({ tenantId: principal.tenantId }, operation),
  };
  const coordinator = new ObjectWriteCoordinator(tenantRunner, objectWriteStore, `partner-card-image:${principal.userId}`);
  const snapshot = prepared.snapshot;
  const writeInput = snapshot
    ? {
        tenantId: snapshot.tenantId,
        idempotencyKey: snapshot.idempotencyKey,
        operationKind: snapshot.operationKind,
        aggregateType: snapshot.aggregateType,
        aggregateId: snapshot.aggregateId,
        actorId: snapshot.actorId,
        expectedState: snapshot.expectedState,
        intentPayload: snapshot.intentPayload,
        items: snapshot.items.map((item) => ({
          store: item.store,
          logicalSlot: item.logicalSlot,
          objectKey: item.objectKey,
          priorObjectKey: item.priorObjectKey,
          body: file.buffer,
          contentType: item.contentType,
          objectClass: item.objectClass,
          required: item.required,
          retentionDays: item.retentionDays ?? undefined,
        })),
      }
    : {
        tenantId: principal.tenantId,
        idempotencyKey: ledgerKey,
        operationKind: "PARTNER_CARD_IMAGE",
        aggregateType: "partner_submission_card",
        aggregateId: cardId,
        actorId: principal.userId,
        expectedState: { beforeKey: prepared.beforeKey, submissionStatus: prepared.row.status },
        intentPayload: {
          tenantId: principal.tenantId,
          submissionId,
          cardId,
          side,
          beforeKey: prepared.beforeKey,
          locationId: prepared.row.location_id,
          actorUserId: principal.userId,
          sessionId: principal.sessionId,
          mime,
          size: file.buffer.length,
        },
        items: [
          {
            store: "R2" as const,
            logicalSlot: side,
            objectKey: key,
            priorObjectKey: prepared.beforeKey,
            body: file.buffer,
            contentType: mime,
            objectClass: "CANONICAL" as const,
          },
        ],
      };
  let result;
  try {
    result = await coordinator.execute(writeInput, finalizePartnerCardImageObjectWrite);
  } catch (error) {
    partnerObjectWriteError(error);
  }
  const resultSide = result.result.side;
  const resultKey = result.result.key;
  if ((resultSide !== "front" && resultSide !== "back") || typeof resultKey !== "string") {
    throw new Error("Stored PARTNER_CARD_IMAGE result is malformed");
  }
  return { side: resultSide, key: resultKey, url: await getR2SignedUrl(resultKey) };
}

export async function addCard(principal: PartnerPrincipal, submissionId: string, input: CardInput) {
  if (!input.cardName || !input.cardName.trim()) throw VALIDATION("Card name is required.");
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const row = await loadSubmissionForUpdate(c, principal, submissionId);
    if (!row) throw NOT_FOUND();
    assertSubmissionOperationAllowed(row.status, "ADD_CARD");
    const seq = await c.query<{ next: number }>(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM partner_submission_cards
        WHERE submission_id=$1 AND removed_at IS NULL`,
      [submissionId]
    );
    const nextSeq = seq.rows[0].next;
    const { rows } = await c.query(
      `INSERT INTO partner_submission_cards
         (tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year,
          variant, language, declared_value_pence, quantity, customer_notes, intake_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
                 declared_value_pence, quantity, customer_notes, intake_notes, front_image_key, back_image_key, created_at`,
      [
        principal.tenantId,
        submissionId,
        nextSeq,
        input.cardName.trim(),
        input.game ?? null,
        input.cardSet ?? null,
        input.cardNumber ?? null,
        input.year ?? null,
        input.variant ?? null,
        input.language ?? null,
        input.declaredValuePence ?? null,
        input.quantity ?? 1,
        input.customerNotes ?? null,
        input.intakeNotes ?? null,
      ]
    );
    await recomputeSubmissionTotals(c, principal.tenantId, submissionId);
    await writeEvent(c, principal, submissionId, "card_added", null, null, null);
    return withSignedCardImages(rows[0]);
  });
}

export interface EditCardInput {
  cardName?: string;
  game?: string | null;
  cardSet?: string | null;
  cardNumber?: string | null;
  year?: number | null;
  variant?: string | null;
  language?: string | null;
  declaredValuePence?: number | null;
  quantity?: number;
  customerNotes?: string | null;
  intakeNotes?: string | null;
}

/** In-place card edit — draft-only (same guard as addCard/removeCard), never touches sequence_number
 *  (edits must not silently reorder cards) or any grade/cert field (the table has no such columns). */
export async function editCard(
  principal: PartnerPrincipal,
  submissionId: string,
  cardId: string,
  input: EditCardInput
) {
  if (input.cardName !== undefined && !input.cardName.trim()) throw VALIDATION("Card name is required.");
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const row = await loadSubmissionForUpdate(c, principal, submissionId);
    if (!row) throw NOT_FOUND();
    assertSubmissionOperationAllowed(row.status, "EDIT_CARD");
    const { rows } = await c.query(
      `UPDATE partner_submission_cards SET
         card_name = COALESCE($3, card_name),
         game = COALESCE($4, game),
         card_set = COALESCE($5, card_set),
         card_number = COALESCE($6, card_number),
         year = COALESCE($7, year),
         variant = COALESCE($8, variant),
         language = COALESCE($9, language),
         declared_value_pence = COALESCE($10, declared_value_pence),
         quantity = COALESCE($11, quantity),
         customer_notes = COALESCE($12, customer_notes),
         intake_notes = COALESCE($13, intake_notes),
         updated_at = now()
       WHERE id=$1 AND submission_id=$2 AND removed_at IS NULL
       RETURNING id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
                 declared_value_pence, quantity, customer_notes, intake_notes, front_image_key, back_image_key, created_at`,
      [
        cardId,
        submissionId,
        input.cardName?.trim() ?? null,
        input.game ?? null,
        input.cardSet ?? null,
        input.cardNumber ?? null,
        input.year ?? null,
        input.variant ?? null,
        input.language ?? null,
        input.declaredValuePence ?? null,
        input.quantity ?? null,
        input.customerNotes ?? null,
        input.intakeNotes ?? null,
      ]
    );
    if (rows.length !== 1) throw NOT_FOUND();
    await recomputeSubmissionTotals(c, principal.tenantId, submissionId);
    await writeEvent(c, principal, submissionId, "card_updated", null, null, null);
    return withSignedCardImages(rows[0]);
  });
}

export async function removeCard(principal: PartnerPrincipal, submissionId: string, cardId: string, reason?: string) {
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const row = await loadSubmissionForUpdate(c, principal, submissionId);
    if (!row) throw NOT_FOUND();
    assertSubmissionOperationAllowed(row.status, "REMOVE_CARD");
    const res = await c.query(
      `UPDATE partner_submission_cards SET removed_at=now(), removed_reason=$3
        WHERE id=$1 AND submission_id=$2 AND removed_at IS NULL`,
      [cardId, submissionId, reason ?? null]
    );
    if (res.rowCount !== 1) throw NOT_FOUND();
    await recomputeSubmissionTotals(c, principal.tenantId, submissionId);
    await writeEvent(c, principal, submissionId, "card_removed", null, null, reason ?? null);
  });
}

export async function listCards(principal: PartnerPrincipal, submissionId: string) {
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    // Read-only: use the non-locking scope check (matching buildDetail), not loadSubmissionForUpdate
    // — a FOR UPDATE lock here would needlessly block concurrent edits to this submission.
    const scope = await locationScopeSql(c, principal, 1);
    const exists = await c.query(`SELECT 1 FROM partner_submissions WHERE id=$1 AND ${scope.sql}`, [
      submissionId,
      ...scope.params,
    ]);
    if (exists.rowCount !== 1) throw NOT_FOUND();
    const { rows } = await c.query(
      `SELECT id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
              declared_value_pence, quantity, customer_notes, intake_notes, front_image_key, back_image_key, created_at
         FROM partner_submission_cards WHERE submission_id=$1 AND removed_at IS NULL ORDER BY sequence_number`,
      [submissionId]
    );
    return Promise.all(rows.map(withSignedCardImages));
  });
}

export async function getSubmissionDetail(principal: PartnerPrincipal, submissionId: string) {
  return withTenant({ tenantId: principal.tenantId }, (c) => buildDetail(c, principal, submissionId));
}

/**
 * Builds the submission detail response using the GIVEN client/transaction. Callers already inside
 * a transaction (e.g. submitSubmission, mid-lock) MUST use this with their own `c`, never open a
 * separate connection for it — a fresh connection under READ COMMITTED cannot see the current
 * transaction's own uncommitted writes, which previously caused a winning submit's own response to
 * read back its pre-commit 'draft' status instead of the 'submitted_to_mintvault' it just wrote.
 */
async function buildDetail(c: PoolClient, principal: PartnerPrincipal, submissionId: string) {
  const scope = await locationScopeSql(c, principal, 2); // $1 is submissionId; $2 is tenantId
  const { rows } = await c.query(
    `SELECT id, public_ref, location_id, customer_id, internal_reference, service_tier_code,
            estimated_price_pence, card_count, status, version, created_at, updated_at, submitted_at,
            cancelled_reason, cancelled_at
       FROM partner_submissions WHERE id=$1 AND tenant_id=$2 AND ${scope.sql}`,
    [submissionId, principal.tenantId, ...scope.params]
  );
  if (rows.length !== 1) throw NOT_FOUND();
  const cards = await c.query(
    `SELECT id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
            declared_value_pence, quantity, customer_notes, intake_notes, front_image_key, back_image_key, created_at
       FROM partner_submission_cards WHERE submission_id=$1 AND tenant_id=$2 AND removed_at IS NULL ORDER BY sequence_number`,
    [submissionId, principal.tenantId]
  );
  const events = await c.query(
    `SELECT id, event_type, from_status, to_status, reason, created_at, actor_user_id
       FROM partner_submission_events WHERE submission_id=$1 AND tenant_id=$2 ORDER BY created_at`,
    [submissionId, principal.tenantId]
  );
  return {
    submission: toSummary(rows[0]),
    cards: await Promise.all(cards.rows.map(withSignedCardImages)),
    events: events.rows,
  };
}

async function withSignedCardImages(row: any) {
  const front = row.front_image_key ? await getR2SignedUrl(row.front_image_key) : null;
  const back = row.back_image_key ? await getR2SignedUrl(row.back_image_key) : null;
  return { ...row, front_image_url: front, back_image_url: back };
}

/**
 * Submit a draft: validate, lock, snapshot, create an idempotent handoff, update status. All in one
 * transaction. Idempotency key is checked FIRST so a retried submit with the same key returns the
 * existing result without erroring or creating a second handoff (Phase 2 §6).
 */
export async function submitSubmission(principal: PartnerPrincipal, submissionId: string, idempotencyKey: string) {
  if (!idempotencyKey || !idempotencyKey.trim()) throw VALIDATION("An idempotency key is required.");
  try {
    return await withPartnerAdminTenantTransaction({ tenantId: principal.tenantId }, async (c) => {
      // Idempotency short-circuit: same key already used for a submission → return that result as-is,
      // never re-execute the handoff logic.
      const already = await c.query(
        `SELECT id, status FROM partner_submissions WHERE tenant_id=$1 AND idempotency_key=$2`,
        [principal.tenantId, idempotencyKey]
      );
      if (already.rowCount === 1) {
        if (already.rows[0].id !== submissionId) {
          throw new SubmissionError(
            "idempotency_conflict",
            "This idempotency key was already used for a different submission."
          );
        }
        return buildDetail(c, principal, submissionId);
      }

      /**
       * B2 — THE CREDIT TRAP IS CLOSED HERE, AT THE AUTHORITY, NOT IN THE BROWSER.
       *
       * Everything below this line reserves one Grading Credit per card and creates each Card Job
       * in CREDIT_RESERVED. Nothing in the server can move a job out of CREDIT_RESERVED: the
       * CREDIT_RESERVED → NEEDS_SCAN edge is declared legal (migration 0080's transition trigger and
       * LEGAL_TRANSITIONS in card-job-lifecycle.ts) but has no caller, and the capture advancer
       * ignores the state entirely. A submitted portal card therefore holds a credit for ever.
       *
       * WHY A SERVER GATE AND NOT A HIDDEN BUTTON. Hiding the wizard would leave the route reachable
       * by anyone who kept a tab open, bookmarked it or replayed the call — and the requirement is
       * that NO Partner path can reserve a credit into an unreachable state, not that the usual one
       * is inconvenient. This is the only place every submit passes through.
       *
       * DELIBERATELY PLACED AFTER THE IDEMPOTENCY SHORT-CIRCUIT. A retry of a submit that already
       * succeeded still returns its original result, so no shop is left unable to re-read work it
       * completed before this gate existed. Only a genuinely NEW reservation is refused.
       *
       * FAIL-CLOSED BY CONSTRUCTION: `resolveFlag` returns false when no row matches, so this is off
       * on every host until somebody deliberately enables it — which should happen only once a real
       * continuation path exists (see the flag's note in flags.ts).
       */
      const intakeEnabled = await resolveFlag(c, "partner_submission_intake_enabled", {
        tenantId: principal.tenantId,
        locationId: principal.locationId ?? null,
      });
      if (!intakeEnabled) {
        throw new SubmissionError(
          "submission_intake_disabled",
          "Submitting cards from the website is temporarily unavailable. Start cards on your MintVault Scanner instead — your draft and any Grading Credits are untouched."
        );
      }

      const row = await loadSubmissionForUpdate(c, principal, submissionId);
      if (!row) throw NOT_FOUND();
      if (!["draft"].includes(row.status)) {
        // RACE FIX: two concurrent submits with the SAME key can both reach here — the first commits
        // (setting idempotency_key + status) before this transaction's FOR UPDATE lock is granted, so
        // the pre-lock "already" check above can miss it. Re-check the NOW-committed row's own
        // idempotency_key (inside the lock, so it reflects the committed truth) before concluding
        // this is a genuine not-draft error — that is what makes concurrent identical-key submits
        // both return the same success rather than one erroring.
        if (row.idempotency_key === idempotencyKey) {
          return buildDetail(c, principal, submissionId);
        }
        throw NOT_DRAFT();
      }

      /**
       * PER-CARD credit accounting (owner directive, 2026-08-03).
       *
       * Partner credits are sold and consumed PER CARD: 1 card = 1 grading credit, so a
       * 20-card submission reserves 20 credits. Previously this path reserved exactly ONE
       * credit per SUBMISSION using the synthetic reference `partner-submission:{id}`, while
       * connector-import-service priced the same submission at `pricePerCardPence * cardCount`
       * — so a partner was invoiced for N cards and debited 1 credit.
       *
       * The synthetic per-submission key also silently defeated
       * `uq_partner_credit_reserve_card_live (tenant_id, card_reference)` (migration 0017),
       * which exists precisely to be the per-card double-reserve guard. Reserving per card
       * restores that index to its designed purpose rather than weakening it.
       *
       * A card row carries its own `quantity` (>= 1, migration 0007), and connector-import
       * expands rows by quantity when pricing. Credits must expand identically, so the unit of
       * account here is (card row, ordinal) — not the card row.
       */
      const cards = await c.query<{ id: string; quantity: number }>(
        `SELECT id, quantity FROM partner_submission_cards
          WHERE submission_id=$1 AND tenant_id=$2 AND removed_at IS NULL
          ORDER BY sequence_number, id`,
        [submissionId, principal.tenantId]
      );
      if (cards.rowCount === 0) throw VALIDATION("Add at least one card before submitting.");

      // Deterministic expansion: same cards -> same units -> same idempotency keys on every
      // retry, which is what makes a repeated submit a no-op rather than a double reservation.
      const creditUnits: { cardId: string; ordinal: number }[] = [];
      for (const card of cards.rows) {
        const quantity = Number(card.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 1) {
          throw VALIDATION("A card has an invalid quantity and cannot be submitted.");
        }
        for (let ordinal = 1; ordinal <= quantity; ordinal += 1) {
          creditUnits.push({ cardId: String(card.id), ordinal });
        }
      }

      const full = await c.query(
        `SELECT s.*, (SELECT json_agg(row_to_json(sc)) FROM (
          SELECT id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
                 declared_value_pence, quantity, customer_notes, intake_notes
            FROM partner_submission_cards
           WHERE submission_id=s.id AND tenant_id=s.tenant_id AND removed_at IS NULL
           ORDER BY sequence_number
        ) sc) AS cards
       FROM partner_submissions s WHERE s.id=$1 AND s.tenant_id=$2`,
        [submissionId, principal.tenantId]
      );
      const snapshot = full.rows[0];

      // Submission-time revalidation: a tier chosen at draft time may have been disabled since (e.g.
      // a super-admin turned it off). Re-check it is STILL active right before creating the handoff —
      // a stored tier code is never trusted as still-valid just because it passed validation earlier.
      if (snapshot.service_tier_code) {
        const stillActive = await c.query<{ n: number }>(
          `SELECT count(*)::int n FROM partner_service_tiers WHERE tier_code=$1 AND is_active AND (tenant_id=$2 OR tenant_id IS NULL)`,
          [snapshot.service_tier_code, principal.tenantId]
        );
        if (stillActive.rows[0].n < 1) throw SERVICE_TIER_UNAVAILABLE();
      }
      await recomputeSubmissionTotals(c, principal.tenantId, submissionId);
      const refreshed = await c.query(
        `SELECT s.*, (SELECT json_agg(row_to_json(sc)) FROM (
          SELECT id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
                 declared_value_pence, quantity, customer_notes, intake_notes
            FROM partner_submission_cards
           WHERE submission_id=s.id AND tenant_id=s.tenant_id AND removed_at IS NULL
           ORDER BY sequence_number
        ) sc) AS cards
       FROM partner_submissions s WHERE s.id=$1 AND s.tenant_id=$2`,
        [submissionId, principal.tenantId]
      );
      const handoffSnapshot = refreshed.rows[0];

      // Resolve the actor again from the trusted database inside this transaction. The HTTP middleware
      // has already authenticated the session, and this check makes the financial write fail closed if
      // that user or organisation has changed between request authentication and submission acceptance.
      const actor = await c.query<{ email: string; status: string }>(
        `SELECT email, status FROM partner_users WHERE id=$1 AND tenant_id=$2 FOR KEY SHARE`,
        [principal.userId, principal.tenantId]
      );
      if (actor.rowCount !== 1 || actor.rows[0].status !== "ACTIVE") throw FORBIDDEN();

      // Reserve one credit PER CARD before the handoff/status transition becomes visible. All
      // reservations share the same database transaction as every acceptance write below, so a
      // wallet that runs out partway through rolls back the ENTIRE acceptance — there is no
      // partial reservation state, and the submission stays in draft. That all-or-nothing
      // behaviour is deliberate: a partially-reserved submission would be handed to MintVault
      // with fewer credits than cards, which is the defect this change exists to remove.
      const reservations: Awaited<ReturnType<typeof reserveCreditInTransaction>>[] = [];
      for (const unit of creditUnits) {
        const cardReference = `partner-submission-card:${unit.cardId}:${unit.ordinal}`;
        reservations.push(
          await reserveCreditInTransaction(
            c,
            { actorUserId: principal.userId, actorEmail: actor.rows[0].email },
            {
              tenantId: principal.tenantId,
              locationId: row.location_id,
              // Unique per submission card + ordinal, so uq_partner_credit_reserve_card_live
              // enforces "one live entitlement per card" as designed.
              cardReference,
              submissionReference: submissionId,
              expiresAt: new Date(Date.now() + PARTNER_SUBMISSION_CREDIT_TTL_MS),
              idempotencyKey: `partner-submission-credit:${submissionId}:${unit.cardId}:${unit.ordinal}`,
              source: "portal",
              reason: "Reserved one grading credit for a Partner submission card.",
              actorType: "partner_user",
              externalRef: snapshot.public_ref ?? null,
              metadata: {
                partner_submission_id: submissionId,
                partner_submission_card_id: unit.cardId,
                card_ordinal: unit.ordinal,
                partner_public_ref: snapshot.public_ref ?? null,
              },
            }
          )
        );

        /*
         * THE CANONICAL CARD JOB — created in the SAME transaction as the credit reservation that
         * pays for it (migration 0080).
         *
         * This is what makes "1 Grading Credit = exactly 1 NEW Card Job" a database fact rather than
         * a convention. Before this, a spent credit was joined to a card only by a nullable TEXT
         * `card_reference` with no foreign key, compared elsewhere by string matching, so nothing
         * prevented a reservation without a job, a job without a reservation, or two jobs sharing
         * one paid credit.
         *
         * ATOMICITY: `c` is the same transaction as the reservation above and as every acceptance
         * write below, so the pair either both commit or neither does. A wallet that runs out
         * partway rolls the whole acceptance back — including these jobs — exactly as the existing
         * all-or-nothing reservation behaviour already guarantees.
         *
         * IDEMPOTENCY: `reserveCreditInTransaction` returns the EXISTING reservation on a repeated
         * idempotency key rather than minting a second one, so a retried submit must not mint a
         * second Card Job either. `uq_partner_card_jobs_unit (card_id, ordinal)` makes that
         * impossible at the database level and ON CONFLICT DO NOTHING makes the retry a no-op
         * instead of an error.
         *
         * NO MV IS ALLOCATED HERE. certificate_id and mv_number stay NULL until the connector
         * allocates a real certificate. A Card Job therefore exists in CREDIT_RESERVED with paid
         * authority and no identity yet, which is precisely the state the lifecycle expects.
         */
        let inserted;
        try {
          inserted = await c.query<{ id: string }>(
            `INSERT INTO partner_card_jobs
             (tenant_id, submission_id, card_id, ordinal, card_reference, reservation_id,
              location_id, created_by, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREDIT_RESERVED')
           ON CONFLICT (card_id, ordinal) DO NOTHING
           RETURNING id`,
            [
              principal.tenantId,
              submissionId,
              unit.cardId,
              unit.ordinal,
              cardReference,
              reservations[reservations.length - 1].reservation.id,
              row.location_id,
              principal.userId,
            ]
          );
        } catch (err) {
          /*
           * 42P01 = undefined_table. This is the ONE failure mode that would otherwise be genuinely
           * misleading (invariant I18): the acceptance rolls back and the partner sees a bare 500,
           * with nothing anywhere naming the missing migration. Everything else — a constraint
           * violation, a tenant mismatch — is a real defect and must keep propagating untouched.
           */
          if ((err as { code?: string })?.code === "42P01") {
            throw new Error(
              "Submission cannot be accepted: the canonical Card Job table is missing. " +
                "Apply migrations/0080_partner_card_jobs.sql, then retry."
            );
          }
          throw err;
        }

        if (inserted.rowCount === 0) {
          /*
           * The job already existed — the expected path for an idempotent retry. Verify it is
           * funded by the SAME reservation rather than assuming it. A mismatch would mean one card
           * unit is associated with two different paid credits, which is the exact double-spend this
           * table exists to prevent, so it fails loudly and rolls the acceptance back rather than
           * quietly proceeding.
           */
          const existing = await c.query<{ reservation_id: string | null }>(
            `SELECT reservation_id FROM partner_card_jobs
              WHERE card_id=$1 AND ordinal=$2 AND tenant_id=$3`,
            [unit.cardId, unit.ordinal, principal.tenantId]
          );
          const existingReservation = existing.rows[0]?.reservation_id ?? null;
          if (existingReservation !== reservations[reservations.length - 1].reservation.id) {
            throw new Error(
              "Card Job reservation mismatch: this card unit is already funded by a different credit reservation."
            );
          }
        }
      }
      // Retained for the audit/event payload below, which records the acceptance as a whole.
      const reservation = reservations[0];

      // Locking the row (loadSubmissionForUpdate did FOR UPDATE) + the unique index on submission_id
      // in partner_submission_handoffs together make this INSERT impossible to duplicate under
      // concurrent retries: a second concurrent submit blocks on the row lock, then sees status is no
      // longer 'draft' and throws NOT_DRAFT() instead of inserting a second handoff.
      await c.query(
        `INSERT INTO partner_submission_handoffs (tenant_id, submission_id, status, snapshot) VALUES ($1,$2,'pending',$3)`,
        [principal.tenantId, submissionId, JSON.stringify(handoffSnapshot)]
      );
      let updated;
      try {
        updated = await c.query(
          `UPDATE partner_submissions SET status='submitted_to_mintvault', submitted_at=now(), idempotency_key=$2, version=version+1, updated_at=now()
         WHERE id=$1 AND tenant_id=$3 RETURNING id`,
          [submissionId, idempotencyKey, principal.tenantId]
        );
      } catch (err) {
        // RACE: the SAME idempotency key was concurrently attached to a DIFFERENT submission (the
        // pre-lock "already used?" check above can miss an in-flight sibling transaction, since
        // FOR UPDATE locks are per-submission-row, not per-key). uq_partner_submissions_idem
        // (tenant_id, idempotency_key) is the backstop; translate its violation into the same clean
        // 409 the sequential (non-racing) case already returns, instead of a raw 500.
        if ((err as { code?: string }).code === "23505") {
          throw new SubmissionError(
            "idempotency_conflict",
            "This idempotency key was already used for a different submission."
          );
        }
        throw err;
      }
      if (updated.rowCount !== 1) throw STALE();
      await writeEvent(c, principal, submissionId, "submitted", "draft", "submitted_to_mintvault", null);
      await writePartnerAudit(c, {
        tenantId: principal.tenantId,
        locationId: row.location_id,
        actorUserId: principal.userId,
        action: "submission.submitted",
        recordType: "partner_submission",
        recordId: submissionId,
        // Record the credit/card reconciliation on the acceptance itself so an auditor can see
        // that credits_reserved == card_units without replaying the reservation table.
        after: {
          status: "submitted_to_mintvault",
          card_units: creditUnits.length,
          credits_reserved: reservations.length,
        },
        correlationId: reservation.reservation.id,
      });
      return buildDetail(c, principal, submissionId);
    });
  } catch (err) {
    if (err instanceof CreditReservationError) {
      if (err.code === "INSUFFICIENT_CREDITS" || err.code === "WALLET_INACTIVE" || err.code === "WALLET_NOT_FOUND") {
        throw new SubmissionError(
          "credit_unavailable",
          "A grading credit is not currently available for this submission."
        );
      }
      if (err.code === "IDEMPOTENCY_CONFLICT") {
        throw new SubmissionError(
          "idempotency_conflict",
          "This submission credit reservation conflicts with an earlier request."
        );
      }
    }
    throw err;
  }
}

export interface AvailableServiceTier {
  tierCode: string;
  label: string;
  pricePerCardPence: number;
  turnaroundDays: number;
}

/**
 * List CURRENTLY ACTIVE service tiers visible to this tenant (its own tiers + global defaults),
 * for the wizard's "Select an available service" step. Read-only; RLS is the actual isolation
 * boundary (another tenant's private tier is invisible), same as resolveServiceTier(). Never
 * returns a disabled tier — the Portal must never let a partner pick something unavailable.
 */
export async function listAvailableServiceTiers(principal: PartnerPrincipal): Promise<AvailableServiceTier[]> {
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const { rows } = await c.query(
      `SELECT DISTINCT ON (tier_code) tier_code, label, price_per_card_pence, turnaround_days
         FROM partner_service_tiers
        WHERE is_active AND (tenant_id = $1 OR tenant_id IS NULL)
        ORDER BY tier_code, tenant_id NULLS LAST`,
      [principal.tenantId]
    );
    return rows.map((r: any) => ({
      tierCode: r.tier_code,
      label: r.label,
      pricePerCardPence: r.price_per_card_pence,
      turnaroundDays: r.turnaround_days,
    }));
  });
}

export async function dashboardSummary(principal: PartnerPrincipal) {
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const scope = await locationScopeSql(c, principal, 0); // scope predicate is first in this query
    const { rows } = await c.query(
      `SELECT status, count(*)::int n FROM partner_submissions WHERE ${scope.sql} GROUP BY status`,
      scope.params
    );
    const counts: Record<string, number> = { draft: 0, submitted_to_mintvault: 0, cancelled: 0 };
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  });
}
