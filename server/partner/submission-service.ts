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
import { withPartnerAdminTenantTransaction, withPartnerAdminTransaction, withTenant } from "./db";
import { writePartnerAudit } from "./audit";
import type { PartnerPrincipal } from "./session";
import { uploadToR2, getR2SignedUrl, headR2 } from "../r2";
import { CreditReservationError, reserveCreditInTransaction } from "./partner-credit-reservation-service";
import {
  assertCancellationLeavesNoGradingEvidence,
  PartnerGradingEvidenceLockError,
} from "./grading-assignment";
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

export interface SubmissionCustomerSummary {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  reference: string | null;
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
  principal: PartnerPrincipal,
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
    if (row.status !== "draft") throw NOT_DRAFT();
    if (row.version !== input.version) throw STALE();
    /**
     * Tri-state on the VALUE, not on key presence.
     *
     * hasOwnProperty was defeated by the route, which always materialises the key:
     * submission-routes.ts builds `customerId: asStringOrExplicitNull(body.customerId)`
     * unconditionally, so the property exists on EVERY edit — and when the client omits customerId
     * that coercion yields `undefined`. hasOwnProperty was therefore always true, the CASE WHEN
     * guard below always fired, and $3 bound to undefined, i.e. NULL.
     *
     * Effect in production: any PATCH that did not mention the customer silently UNLINKED it.
     * Editing only the intake notes wiped the customer, and the submission then failed at submit
     * with "Select a customer before submitting." — with nothing pointing at the edit that caused
     * it. Reproduced: create a draft with a customer, PATCH {version, serviceTierCode}, submit → 400.
     *
     * Checking the value keeps all three intended states and matches how tierChanged is derived
     * ten lines below:
     *   omitted       -> undefined -> leave customer_id untouched
     *   explicit null -> null      -> clear it
     *   string        -> validate ownership and set it
     */
    const customerChanged = input.customerId !== undefined;
    if (customerChanged) await verifyCustomerOwnership(c, principal.tenantId, input.customerId ?? null);
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
         customer_id = CASE WHEN $9 THEN $3 ELSE customer_id END,
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
        customerChanged,
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
      if (row.status === "cancelled") throw NOT_DRAFT();

      // Ordinary cancellation is a PRE-GRADING action. Once any card has left the intake queue it
      // carries durable grading/review history, and cancelling would both erase that quality
      // evidence and — via 0041's credit-hold trigger — leave the certificate unapprovable. Held
      // inside this transaction, under FOR UPDATE, so a concurrent submit-for-review cannot slip
      // between the check and the write. See assertCancellationLeavesNoGradingEvidence.
      await assertCancellationLeavesNoGradingEvidence(c, submissionId);

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
    if (err instanceof PartnerGradingEvidenceLockError) {
      // A named domain refusal, not an internal error: the partner needs to understand that the
      // card is mid-grading and that withdrawal is now an HQ exception, not a self-service action.
      throw new SubmissionError(err.code, err.message);
    }
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

function cardImageKey(tenantId: string, submissionId: string, cardId: string, side: "front" | "back", ext: string) {
  return `partner-submissions/${tenantId}/${submissionId}/${cardId}/${side}-${Date.now()}-${randomUUID()}.${ext}`;
}

function cardImageKeyAllowed(
  tenantId: string,
  submissionId: string,
  cardId: string,
  side: "front" | "back",
  key: string
) {
  return key.startsWith(`partner-submissions/${tenantId}/${submissionId}/${cardId}/${side}-`);
}

export async function uploadCardImage(
  principal: PartnerPrincipal,
  submissionId: string,
  cardId: string,
  side: "front" | "back",
  file: { buffer: Buffer; mimetype?: string | null; originalname?: string | null; size?: number | null }
): Promise<CardImage> {
  if (!file?.buffer?.length) throw VALIDATION("Choose an image to upload.");
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected?.mime) throw VALIDATION("Upload a JPEG, PNG, WebP or TIFF image.");
  const mime = detected.mime;
  const ext = ALLOWED_CARD_IMAGE_MIMES.get(mime);
  if (!ext) throw VALIDATION("Upload a JPEG, PNG, WebP or TIFF image.");
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const row = await loadSubmissionForUpdate(c, principal, submissionId);
    if (!row) throw NOT_FOUND();
    if (row.status !== "draft") throw NOT_DRAFT();
    const current = await c.query<{ id: string; front_image_key: string | null; back_image_key: string | null }>(
      `SELECT id, front_image_key, back_image_key
         FROM partner_submission_cards
        WHERE id=$1 AND submission_id=$2 AND tenant_id=$3 AND removed_at IS NULL`,
      [cardId, submissionId, principal.tenantId]
    );
    if (current.rows.length !== 1) throw NOT_FOUND();

    const beforeKey = side === "front" ? current.rows[0].front_image_key : current.rows[0].back_image_key;
    const key = cardImageKey(principal.tenantId, submissionId, cardId, side, ext);
    await uploadToR2(key, file.buffer, mime);
    await c.query(
      `UPDATE partner_submission_cards
          SET ${side === "front" ? "front_image_key" : "back_image_key"}=$4, updated_at=now()
        WHERE id=$1 AND submission_id=$2 AND tenant_id=$3`,
      [cardId, submissionId, principal.tenantId, key]
    );
    await writeEvent(c, principal, submissionId, "card_image_uploaded", null, null, null, {
      cardId,
      side,
      replaced: !!beforeKey,
      size: file.size ?? file.buffer.length,
      mime,
    });
    await writePartnerAudit(c, {
      tenantId: principal.tenantId,
      locationId: row.location_id,
      actorUserId: principal.userId,
      action: "submission.card_image_uploaded",
      recordType: "partner_submission_card",
      recordId: cardId,
      before: beforeKey ? { [side]: "present" } : null,
      after: { side, key, mime, size: file.size ?? file.buffer.length },
      sessionId: principal.sessionId,
      correlationId: submissionId,
    });
    return { side, key, url: await getR2SignedUrl(key) };
  });
}

export async function addCard(principal: PartnerPrincipal, submissionId: string, input: CardInput) {
  if (!input.cardName || !input.cardName.trim()) throw VALIDATION("Card name is required.");
  return withTenant({ tenantId: principal.tenantId }, async (c) => {
    const row = await loadSubmissionForUpdate(c, principal, submissionId);
    if (!row) throw NOT_FOUND();
    if (row.status !== "draft") throw NOT_DRAFT();
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
       RETURNING id, tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
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
    if (row.status !== "draft") throw NOT_DRAFT();
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
       RETURNING id, tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
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
    if (row.status !== "draft") throw NOT_DRAFT();
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
      `SELECT id, tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
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
  const customer =
    rows[0].customer_id == null
      ? null
      : ((
          await c.query<{
            id: string;
            full_name: string;
            email: string | null;
            phone: string | null;
            reference: string | null;
          }>(
            `SELECT id, full_name, email, phone, reference
               FROM partner_customers
              WHERE id=$1 AND tenant_id=$2`,
            [rows[0].customer_id, principal.tenantId]
          )
        ).rows[0] ?? null);
  const cards = await c.query(
    `SELECT id, tenant_id, submission_id, sequence_number, card_name, game, card_set, card_number, year, variant, language,
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
    customer: customer
      ? {
          id: customer.id,
          fullName: customer.full_name,
          email: customer.email,
          phone: customer.phone,
          reference: customer.reference,
        }
      : null,
    cards: await Promise.all(cards.rows.map(withSignedCardImages)),
    events: events.rows,
  };
}

async function withSignedCardImages(row: any) {
  const tenantId = String(row.tenant_id ?? "");
  const submissionId = String(row.submission_id ?? "");
  const cardId = String(row.id ?? "");
  const front =
    row.front_image_key && cardImageKeyAllowed(tenantId, submissionId, cardId, "front", row.front_image_key)
      ? await getR2SignedUrl(row.front_image_key)
      : null;
  const back =
    row.back_image_key && cardImageKeyAllowed(tenantId, submissionId, cardId, "back", row.back_image_key)
      ? await getR2SignedUrl(row.back_image_key)
      : null;
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

      const row = await loadSubmissionForUpdate(c, principal, submissionId);
      if (!row) throw NOT_FOUND();
      if (row.status !== "draft") {
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
      const cards = await c.query<{
        id: string;
        quantity: number;
        front_image_key: string | null;
        back_image_key: string | null;
      }>(
        `SELECT id, quantity, front_image_key, back_image_key FROM partner_submission_cards
          WHERE submission_id=$1 AND tenant_id=$2 AND removed_at IS NULL
          ORDER BY sequence_number, id`,
        [submissionId, principal.tenantId]
      );
      if (cards.rowCount === 0) throw VALIDATION("Add at least one card before submitting.");

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
      if (!snapshot.customer_id) throw VALIDATION("Select a customer before submitting.");
      if (!snapshot.service_tier_code) throw VALIDATION("Select a service before submitting.");

      for (const card of cards.rows) {
        const front = card.front_image_key;
        const back = card.back_image_key;
        if (!front || !cardImageKeyAllowed(principal.tenantId, submissionId, String(card.id), "front", front)) {
          throw VALIDATION("Upload a front image for every card before submitting.");
        }
        if (!back || !cardImageKeyAllowed(principal.tenantId, submissionId, String(card.id), "back", back)) {
          throw VALIDATION("Upload a back image for every card before submitting.");
        }
        const [frontHead, backHead] = await Promise.all([headR2(front), headR2(back)]);
        if (!frontHead || !backHead) {
          throw VALIDATION(
            "One or more card images could not be verified. Re-upload the missing image before submitting."
          );
        }
      }

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
        reservations.push(
          await reserveCreditInTransaction(
            c,
            { actorUserId: principal.userId, actorEmail: actor.rows[0].email },
            {
              tenantId: principal.tenantId,
              locationId: row.location_id,
              // Unique per submission card + ordinal, so uq_partner_credit_reserve_card_live
              // enforces "one live entitlement per card" as designed.
              cardReference: `partner-submission-card:${unit.cardId}:${unit.ordinal}`,
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

const DEFAULT_GLOBAL_SERVICE_TIERS: AvailableServiceTier[] = [
  { tierCode: "standard", label: "Standard Grading", pricePerCardPence: 1500, turnaroundDays: 20 },
];

async function ensureDefaultGlobalServiceTiers(): Promise<void> {
  await withPartnerAdminTransaction(async (c) => {
    const before = await c.query<{ n: number }>(
      "SELECT count(*)::int n FROM partner_service_tiers WHERE tenant_id IS NULL AND is_active"
    );
    if (Number(before.rows[0]?.n ?? 0) > 0) return;
    for (const tier of DEFAULT_GLOBAL_SERVICE_TIERS) {
      await c.query(
        `INSERT INTO partner_service_tiers
         (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active)
       VALUES (NULL,$1,$2,$3,$4,true)
         ON CONFLICT (tier_code) WHERE tenant_id IS NULL DO NOTHING`,
        [tier.tierCode, tier.label, tier.pricePerCardPence, tier.turnaroundDays]
      );
    }
    const auditTable = await c.query<{ exists: boolean }>(
      "SELECT to_regclass('public.audit_log') IS NOT NULL AS exists"
    );
    if (auditTable.rows[0]?.exists) {
      await c.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
         VALUES ('partner_service_tiers', 'global', 'partner_service_tiers_default_provisioned', 'system',
                 $1::jsonb)`,
        [
          JSON.stringify({
            source: "partner_submission_wizard",
            tiers: DEFAULT_GLOBAL_SERVICE_TIERS.map((t) => t.tierCode),
          }),
        ]
      );
    }
  });
}

/**
 * List CURRENTLY ACTIVE service tiers visible to this tenant (its own tiers + global defaults),
 * for the wizard's "Select an available service" step. Read-only; RLS is the actual isolation
 * boundary (another tenant's private tier is invisible), same as resolveServiceTier(). Never
 * returns a disabled tier — the Portal must never let a partner pick something unavailable.
 */
export async function listAvailableServiceTiers(principal: PartnerPrincipal): Promise<AvailableServiceTier[]> {
  await ensureDefaultGlobalServiceTiers();
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
