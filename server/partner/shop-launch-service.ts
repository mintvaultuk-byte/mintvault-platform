/**
 * Partner Shop Launch service.
 *
 * This layer is deliberately thin: it reads existing wallet/reservation/submission truth, creates
 * Stripe-bound purchase records from server-owned package rows, fulfils successful payments through
 * the existing immutable wallet ledger, and stores additive origin/correction/readiness evidence.
 * It does not duplicate G6D's final submission credit-settlement state machine.
 */
import crypto from "node:crypto";
import type Stripe from "stripe";
import type { PoolClient } from "pg";
import { APP_BASE_URL } from "../app-url";
import { getUncachableStripeClient } from "../stripeClient";
import { partnerAdminQuery, withPartnerAdminTransaction, withTenant } from "./db";
import type { PartnerPrincipal } from "./session";
import { resolveFlag } from "./flags";
import { appendFoundationCredit } from "./partner-wallet-service";
import { getCreditPosition } from "./partner-credit-reservation-service";
import { PARTNER_ROLE_LABELS } from "./permissions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ShopLaunchError extends Error {
  constructor(
    readonly code:
      | "bad_request"
      | "feature_disabled"
      | "pilot_not_authorised"
      | "not_found"
      | "forbidden"
      | "payment_unavailable"
      | "stripe_unavailable"
      | "idempotency_conflict"
      | "invalid_state"
      | "reconciliation_required",
    message: string
  ) {
    super(message);
  }
}

export interface SuperAdminLaunchActor {
  userId: string;
  email: string;
  correlationId: string;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_RE.test(value))
    throw new ShopLaunchError("bad_request", `${label} is invalid: ${String(value).slice(0, 80)}`);
  return value;
}

function requireReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason || reason.length > 2000) throw new ShopLaunchError("bad_request", "A reason is required.");
  return reason;
}

function safeText(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function emailHash(email: string | null): string | null {
  if (!email) return null;
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function auditLaunch(
  client: PoolClient,
  input: {
    tenantId?: string | null;
    actorType: "partner_user" | "super_admin" | "stripe" | "system";
    actorUserId?: string | null;
    actorEmail?: string | null;
    targetType: string;
    targetId?: string | null;
    action: string;
    reason?: string | null;
    correlationId?: string | null;
    before?: unknown;
    after?: unknown;
    metadata?: unknown;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO partner_launch_audit_events
       (tenant_id, actor_type, actor_user_id, actor_email, target_type, target_id, action,
        reason, correlation_id, before_value, after_value, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.tenantId ?? null,
      input.actorType,
      input.actorUserId ?? null,
      input.actorEmail ?? null,
      input.targetType,
      input.targetId ?? null,
      input.action,
      input.reason ?? null,
      input.correlationId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

async function requirePilotAndFlag(
  client: PoolClient,
  principal: PartnerPrincipal,
  flag: "partner_payments_enabled" | "partner_grading_enabled" | "partner_corrections_enabled" | "partner_pilot_enabled"
): Promise<void> {
  if (!(await resolveFlag(client, flag, { tenantId: principal.tenantId, locationId: principal.locationId }))) {
    throw new ShopLaunchError("feature_disabled", "This Partner feature is not enabled.");
  }
  const pilot = await client.query<{ status: string }>(
    `SELECT status FROM partner_pilot_authorisations
      WHERE tenant_id=$1 AND (location_id IS NOT DISTINCT FROM $2::uuid OR location_id IS NULL)
      ORDER BY location_id NULLS LAST, updated_at DESC LIMIT 1`,
    [principal.tenantId, principal.locationId]
  );
  if (pilot.rowCount !== 1 || pilot.rows[0].status !== "authorised") {
    throw new ShopLaunchError("pilot_not_authorised", "This Partner location is not launch-authorised yet.");
  }
}

export async function getPartnerLaunchDashboard(principal: PartnerPrincipal) {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const org = await client.query<{ id: string; legal_name: string; status: string; accreditation_level: string }>(
      "SELECT id, legal_name, status, accreditation_level FROM partner_organisations LIMIT 1"
    );
    const location = principal.locationId
      ? await client.query<{ id: string; name: string; status: string }>(
          "SELECT id, name, status FROM partner_locations WHERE id=$1",
          [principal.locationId]
        )
      : { rows: [] as { id: string; name: string; status: string }[] };
    const roles = await client.query<{ code: keyof typeof PARTNER_ROLE_LABELS }>(
      `SELECT r.code FROM partner_user_roles ur JOIN partner_roles r ON r.id=ur.role_id WHERE ur.user_id=$1`,
      [principal.userId]
    );
    const submissions = await client.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int n FROM partner_submissions GROUP BY status"
    );
    const handoffs = await client.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int n FROM partner_submission_handoffs GROUP BY status"
    );
    const corrections = await client.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int n FROM partner_correction_requests GROUP BY status"
    );
    const readiness = await client.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int n FROM partner_readiness_checks
        WHERE location_id IS NOT DISTINCT FROM $1::uuid OR location_id IS NULL GROUP BY status`,
      [principal.locationId]
    );
    const recentLedger = await client.query(
      `SELECT id, amount, entry_type, source, reason, external_ref, created_at
         FROM partner_credit_ledger ORDER BY created_at DESC, id DESC LIMIT 8`
    );
    const position = await client.query(
      "SELECT ledger_balance, active_reserved, available_balance, consumed_reservations FROM partner_credit_availability LIMIT 1"
    );
    const pilot = await client.query<{ status: string; reason: string | null; blockers: unknown }>(
      `SELECT status, reason, blockers FROM partner_pilot_authorisations
        WHERE location_id IS NOT DISTINCT FROM $1::uuid OR location_id IS NULL
        ORDER BY location_id NULLS LAST, updated_at DESC LIMIT 1`,
      [principal.locationId]
    );

    return {
      partner: org.rows[0] ?? null,
      location: location.rows[0] ?? null,
      roleLabels: roles.rows.map((row) => PARTNER_ROLE_LABELS[row.code] ?? row.code),
      credit: position.rows[0]
        ? {
            postedLedgerBalance: Number(position.rows[0].ledger_balance),
            activeReservedCredits: Number(position.rows[0].active_reserved),
            availableCredits: Number(position.rows[0].available_balance),
            consumedCredits: Number(position.rows[0].consumed_reservations),
          }
        : null,
      recentCreditActivity: recentLedger.rows.map((row: any) => ({ ...row, created_at: toIso(row.created_at) })),
      submissions: Object.fromEntries(submissions.rows.map((row) => [row.status, row.n])),
      handoffs: Object.fromEntries(handoffs.rows.map((row) => [row.status, row.n])),
      corrections: Object.fromEntries(corrections.rows.map((row) => [row.status, row.n])),
      readiness: Object.fromEntries(readiness.rows.map((row) => [row.status, row.n])),
      pilot: pilot.rows[0] ?? { status: "not_authorised", reason: null, blockers: [] },
    };
  });
}

export async function getPartnerWalletView(principal: PartnerPrincipal, limit = 50) {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const position = await client.query(
      "SELECT wallet_id, ledger_balance, active_reserved, available_balance, consumed_reservations FROM partner_credit_availability LIMIT 1"
    );
    const ledger = await client.query(
      `SELECT id, amount, entry_type, source, reason, external_ref, created_at
         FROM partner_credit_ledger ORDER BY created_at DESC, id DESC LIMIT $1`,
      [Math.max(1, Math.min(100, limit))]
    );
    const purchases = await client.query(
      `SELECT p.id, p.status, p.credits, p.amount_pence, p.currency, p.created_at, p.fulfilled_at,
              pkg.name AS package_name
         FROM partner_credit_purchases p
         JOIN partner_credit_packages pkg ON pkg.id=p.package_id
        ORDER BY p.created_at DESC, p.id DESC LIMIT 50`
    );
    return {
      credit: position.rows[0] ?? null,
      ledger: ledger.rows.map((row: any) => ({ ...row, created_at: toIso(row.created_at) })),
      purchases: purchases.rows.map((row: any) => ({
        ...row,
        created_at: toIso(row.created_at),
        fulfilled_at: toIso(row.fulfilled_at),
      })),
    };
  });
}

export async function listEligibleCreditPackages(principal: PartnerPrincipal) {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    await requirePilotAndFlag(client, principal, "partner_payments_enabled");
    const { rows } = await client.query(
      `SELECT p.id, p.name, p.description, p.credits, p.price_pence, p.currency, p.display_order
         FROM partner_credit_packages p
         LEFT JOIN partner_credit_package_eligibility e
           ON e.package_id=p.id AND e.tenant_id=$1
        WHERE p.status='active'
          AND (p.effective_from IS NULL OR p.effective_from <= now())
          AND (p.effective_until IS NULL OR p.effective_until > now())
          AND COALESCE(e.eligible, true) = true
        ORDER BY p.display_order, p.credits, p.id`,
      [principal.tenantId]
    );
    return rows;
  });
}

export async function createPartnerCreditPurchase(
  principal: PartnerPrincipal,
  input: { packageId: string; idempotencyKey: string }
) {
  const packageId = requireUuid(input.packageId, "packageId");
  const idempotencyKey = safeText(input.idempotencyKey, 200);
  if (!idempotencyKey) throw new ShopLaunchError("bad_request", "An idempotency key is required.");
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    await requirePilotAndFlag(client, principal, "partner_payments_enabled");
    const existing = await client.query("SELECT * FROM partner_credit_purchases WHERE idempotency_key=$1", [
      idempotencyKey,
    ]);
    if (existing.rowCount === 1) return existing.rows[0];

    const pkg = await client.query<{
      id: string;
      name: string;
      credits: number;
      price_pence: number;
      currency: string;
      stripe_price_id: string | null;
    }>(
      `SELECT p.id, p.name, p.credits, p.price_pence, p.currency, p.stripe_price_id
         FROM partner_credit_packages p
         LEFT JOIN partner_credit_package_eligibility e
           ON e.package_id=p.id AND e.tenant_id=$2
        WHERE p.id=$1 AND p.status='active'
          AND (p.effective_from IS NULL OR p.effective_from <= now())
          AND (p.effective_until IS NULL OR p.effective_until > now())
          AND COALESCE(e.eligible, true)=true
        LIMIT 1`,
      [packageId, principal.tenantId]
    );
    if (pkg.rowCount !== 1) throw new ShopLaunchError("not_found", "Credit package not found.");
    const row = pkg.rows[0];
    const inserted = await client.query(
      `INSERT INTO partner_credit_purchases
         (tenant_id, package_id, created_by_user_id, credits, amount_pence, currency, idempotency_key, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING *`,
      [
        principal.tenantId,
        row.id,
        principal.userId,
        row.credits,
        row.price_pence,
        row.currency,
        idempotencyKey,
        JSON.stringify({ packageName: row.name, serverPriced: true }),
      ]
    );
    await auditLaunch(client, {
      tenantId: principal.tenantId,
      actorType: "partner_user",
      actorUserId: principal.userId,
      targetType: "partner_credit_purchase",
      targetId: inserted.rows[0].id,
      action: "purchase_created",
      metadata: { packageId: row.id, credits: row.credits, amountPence: row.price_pence },
    });
    return inserted.rows[0];
  });
}

export async function startPartnerCreditCheckout(
  principal: PartnerPrincipal,
  input: { purchaseId: string; idempotencyKey?: string | null }
) {
  const purchaseId = requireUuid(input.purchaseId, "purchaseId");
  const purchase = await withTenant(
    { tenantId: principal.tenantId, locationId: principal.locationId },
    async (client) => {
      await requirePilotAndFlag(client, principal, "partner_payments_enabled");
      const result = await client.query(
        `SELECT p.*, pkg.name AS package_name, pkg.stripe_price_id
         FROM partner_credit_purchases p JOIN partner_credit_packages pkg ON pkg.id=p.package_id
        WHERE p.id=$1 FOR UPDATE`,
        [purchaseId]
      );
      if (result.rowCount !== 1) throw new ShopLaunchError("not_found", "Purchase not found.");
      if (!["pending_payment", "checkout_created"].includes(result.rows[0].status)) {
        throw new ShopLaunchError("invalid_state", "This purchase can no longer be checked out.");
      }
      return result.rows[0];
    }
  );

  let stripe;
  try {
    stripe = await getUncachableStripeClient();
  } catch {
    throw new ShopLaunchError("stripe_unavailable", "Stripe checkout is not configured in this environment.");
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      success_url: `${APP_BASE_URL}/partner/credits?purchase=${purchaseId}&status=success`,
      cancel_url: `${APP_BASE_URL}/partner/credits?purchase=${purchaseId}&status=cancelled`,
      metadata: {
        type: "partner_credit_purchase",
        purchase_id: purchaseId,
        tenant_id: principal.tenantId,
        package_id: purchase.package_id,
      },
      line_items: [
        purchase.stripe_price_id
          ? { price: purchase.stripe_price_id, quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: String(purchase.currency).toLowerCase(),
                unit_amount: Number(purchase.amount_pence),
                product_data: { name: purchase.package_name },
              },
            },
      ],
    },
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined
  );

  await withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    await client.query(
      `UPDATE partner_credit_purchases
          SET status='checkout_created', stripe_checkout_session_id=$2, updated_at=now()
        WHERE id=$1`,
      [purchaseId, session.id]
    );
    await auditLaunch(client, {
      tenantId: principal.tenantId,
      actorType: "partner_user",
      actorUserId: principal.userId,
      targetType: "partner_credit_purchase",
      targetId: purchaseId,
      action: "stripe_checkout_created",
      metadata: { checkoutSessionId: session.id },
    });
  });

  return { purchaseId, checkoutSessionId: session.id, url: session.url };
}

async function openReconciliationCase(
  client: PoolClient,
  input: {
    tenantId: string;
    purchaseId: string | null;
    caseType: string;
    severity?: "low" | "medium" | "high" | "critical";
    reason: string;
    evidence?: unknown;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO partner_payment_reconciliation_cases
       (tenant_id, purchase_id, case_type, severity, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      input.tenantId,
      input.purchaseId,
      input.caseType,
      input.severity ?? "medium",
      input.reason,
      JSON.stringify(input.evidence ?? {}),
    ]
  );
}

export async function handlePartnerStripeEvent(event: Stripe.Event): Promise<boolean> {
  const object: any = event.data.object;
  const metadata = object?.metadata ?? {};
  if (metadata.type !== "partner_credit_purchase") return false;

  await withPartnerAdminTransaction(async (client) => {
    const claim = await client.query(
      `INSERT INTO partner_stripe_events (stripe_event_id, event_type, safe_summary)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id`,
      [
        event.id,
        event.type,
        JSON.stringify({
          objectId: object?.id ?? null,
          purchaseId: metadata.purchase_id ?? null,
          paymentIntent: object?.payment_intent ?? object?.id ?? null,
        }),
      ]
    );
    if (claim.rowCount !== 1) return;

    const purchaseId = typeof metadata.purchase_id === "string" ? metadata.purchase_id : "";
    const tenantId = typeof metadata.tenant_id === "string" ? metadata.tenant_id : "";
    const purchase = await client.query(
      `SELECT p.*, w.id AS wallet_id
         FROM partner_credit_purchases p
         JOIN partner_wallets w ON w.tenant_id=p.tenant_id
        WHERE p.id=$1 AND p.tenant_id=$2 FOR UPDATE OF p`,
      [purchaseId, tenantId]
    );
    if (purchase.rowCount !== 1) {
      await client.query(
        "UPDATE partner_stripe_events SET processing_status='reconciliation_required', processed_at=now() WHERE stripe_event_id=$1",
        [event.id]
      );
      return;
    }
    const row = purchase.rows[0];
    await client.query("UPDATE partner_stripe_events SET purchase_id=$2, tenant_id=$3 WHERE stripe_event_id=$1", [
      event.id,
      row.id,
      row.tenant_id,
    ]);

    const paymentIntentId =
      typeof object.payment_intent === "string"
        ? object.payment_intent
        : typeof object.id === "string"
          ? object.id
          : null;

    if (event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded") {
      if (row.fulfilled_at) {
        await client.query(
          "UPDATE partner_stripe_events SET processing_status='processed', processed_at=now() WHERE stripe_event_id=$1",
          [event.id]
        );
        return;
      }
      const amountTotal = Number(object.amount_total ?? object.amount_received ?? row.amount_pence);
      const currency = String(object.currency ?? row.currency).toUpperCase();
      if (amountTotal !== Number(row.amount_pence) || currency !== String(row.currency).toUpperCase()) {
        await client.query(
          `UPDATE partner_credit_purchases
              SET status='reconciliation_required', reconciliation_required=true,
                  reconciliation_reason='Stripe amount/currency mismatch', updated_at=now()
            WHERE id=$1`,
          [row.id]
        );
        await openReconciliationCase(client, {
          tenantId: row.tenant_id,
          purchaseId: row.id,
          caseType: "stripe_amount_mismatch",
          severity: "critical",
          reason: "Stripe reported a different amount or currency than the server-priced purchase.",
          evidence: { expectedAmount: row.amount_pence, amountTotal, expectedCurrency: row.currency, currency },
        });
        await client.query(
          "UPDATE partner_stripe_events SET processing_status='reconciliation_required', processed_at=now() WHERE stripe_event_id=$1",
          [event.id]
        );
        return;
      }

      const fulfilmentKey = `stripe:${row.id}:${paymentIntentId ?? object.id}`;
      try {
        const fulfilled = await appendFoundationCredit(
          { actorUserId: null, actorEmail: null },
          {
            tenantId: row.tenant_id,
            amount: Number(row.credits),
            entryType: "purchase",
            source: "stripe",
            reason: `Stripe credit package purchase ${row.id}`,
            idempotencyKey: fulfilmentKey,
            actorType: "system",
            correlationId: row.id,
            externalRef: paymentIntentId ?? object.id,
            metadata: { purchaseId: row.id, packageId: row.package_id, stripeEventId: event.id },
          }
        );
        await client.query(
          `UPDATE partner_credit_purchases
              SET status='fulfilled', stripe_payment_intent_id=COALESCE($2, stripe_payment_intent_id),
                  fulfilment_idempotency_key=$3, fulfilled_ledger_entry_id=$4, fulfilled_at=COALESCE(fulfilled_at, now()),
                  updated_at=now()
            WHERE id=$1`,
          [row.id, paymentIntentId, fulfilmentKey, fulfilled.entry.id]
        );
        await auditLaunch(client, {
          tenantId: row.tenant_id,
          actorType: "stripe",
          targetType: "partner_credit_purchase",
          targetId: row.id,
          action: fulfilled.alreadyApplied ? "stripe_purchase_fulfilment_replayed" : "stripe_purchase_fulfilled",
          correlationId: event.id,
          metadata: { ledgerEntryId: fulfilled.entry.id, credits: row.credits },
        });
        await client.query(
          "UPDATE partner_stripe_events SET processing_status='processed', processed_at=now() WHERE stripe_event_id=$1",
          [event.id]
        );
      } catch (error) {
        await client.query(
          `UPDATE partner_credit_purchases
              SET status='reconciliation_required', reconciliation_required=true,
                  reconciliation_reason='Wallet fulfilment failed after Stripe success', updated_at=now()
            WHERE id=$1`,
          [row.id]
        );
        await openReconciliationCase(client, {
          tenantId: row.tenant_id,
          purchaseId: row.id,
          caseType: "wallet_fulfilment_failed",
          severity: "critical",
          reason: "Stripe payment succeeded but wallet fulfilment failed.",
          evidence: { stripeEventId: event.id, error: error instanceof Error ? error.message : "unknown" },
        });
        await client.query(
          "UPDATE partner_stripe_events SET processing_status='failed', processed_at=now() WHERE stripe_event_id=$1",
          [event.id]
        );
      }
      return;
    }

    if (event.type === "checkout.session.expired" || event.type === "payment_intent.payment_failed") {
      await client.query(
        `UPDATE partner_credit_purchases
            SET status=$2, failed_at=CASE WHEN $2='failed' THEN now() ELSE failed_at END,
                cancelled_at=CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END, updated_at=now()
          WHERE id=$1 AND fulfilled_at IS NULL`,
        [row.id, event.type === "payment_intent.payment_failed" ? "failed" : "cancelled"]
      );
      await client.query(
        "UPDATE partner_stripe_events SET processing_status='processed', processed_at=now() WHERE stripe_event_id=$1",
        [event.id]
      );
      return;
    }

    if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
      const nextStatus = event.type === "charge.dispute.created" ? "disputed" : "refunded";
      await client.query(
        `UPDATE partner_credit_purchases
            SET status=$2, reconciliation_required=fulfilled_at IS NOT NULL,
                reconciliation_reason=CASE WHEN fulfilled_at IS NOT NULL THEN 'Payment reversal after fulfilment' ELSE reconciliation_reason END,
                refunded_at=CASE WHEN $2='refunded' THEN now() ELSE refunded_at END,
                disputed_at=CASE WHEN $2='disputed' THEN now() ELSE disputed_at END,
                updated_at=now()
          WHERE id=$1`,
        [row.id, nextStatus]
      );
      if (row.fulfilled_at) {
        await openReconciliationCase(client, {
          tenantId: row.tenant_id,
          purchaseId: row.id,
          caseType: nextStatus,
          severity: "high",
          reason: "Payment reversed after credits were fulfilled. Manual reconciliation required.",
          evidence: { stripeEventId: event.id, stripeObjectId: object?.id ?? null },
        });
      }
      await client.query(
        "UPDATE partner_stripe_events SET processing_status='processed', processed_at=now() WHERE stripe_event_id=$1",
        [event.id]
      );
    }
  });
  return true;
}

export async function listPartnerCertificates(principal: PartnerPrincipal) {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const { rows } = await client.query(
      `SELECT certificate_number, origin_type, partner_display_name, location_display_name,
              grading_address, completed_at
         FROM partner_grading_origin_snapshots
        WHERE origin_type='partner'
        ORDER BY completed_at DESC, certificate_number DESC LIMIT 100`
    );
    return rows.map((row: any) => ({ ...row, completed_at: toIso(row.completed_at) }));
  });
}

export async function publicCertificateOrigin(certificateNumber: string) {
  const cert = certificateNumber.trim().slice(0, 80);
  if (!cert) throw new ShopLaunchError("bad_request", "Certificate number is required.");
  const { rows } = await partnerAdminQuery(
    `SELECT origin_type, partner_display_name, location_display_name, grading_address, completed_at
       FROM partner_grading_origin_snapshots
      WHERE certificate_number=$1`,
    [cert]
  );
  if (rows.length === 0) return { originType: "mintvault_hq", gradedBy: "MintVault Headquarters" };
  const row: any = rows[0];
  return {
    originType: row.origin_type,
    gradedBy:
      row.origin_type === "partner" ? `Graded by ${row.partner_display_name}` : "Graded by MintVault Headquarters",
    locationName: row.origin_type === "partner" ? row.location_display_name : null,
    gradingAddress: row.origin_type === "partner" ? row.grading_address : null,
    completedAt: toIso(row.completed_at),
  };
}

export async function listPartnerCorrections(principal: PartnerPrincipal) {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    await requirePilotAndFlag(client, principal, "partner_corrections_enabled");
    const locationPredicate = principal.orgWide ? "TRUE" : "location_id IS NOT DISTINCT FROM $1::uuid";
    const params = principal.orgWide ? [] : [principal.locationId];
    const { rows } = await client.query(
      `SELECT id, certificate_number, status, customer_reference, request_reason, partner_response,
              assigned_to, due_at, created_at, updated_at
         FROM partner_correction_requests
        WHERE ${locationPredicate}
        ORDER BY created_at DESC, id DESC LIMIT 100`,
      params
    );
    return rows.map((row: any) => ({
      ...row,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      due_at: toIso(row.due_at),
    }));
  });
}

export async function respondToPartnerCorrection(
  principal: PartnerPrincipal,
  correctionId: string,
  input: { response: string; idempotencyKey?: string | null }
) {
  const id = requireUuid(correctionId, "correctionId");
  const response = safeText(input.response, 5000);
  if (!response) throw new ShopLaunchError("bad_request", "A response is required.");
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    await requirePilotAndFlag(client, principal, "partner_corrections_enabled");
    const existing = await client.query(
      `SELECT id, location_id, status FROM partner_correction_requests WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (existing.rowCount !== 1) throw new ShopLaunchError("not_found", "Correction request not found.");
    if (!principal.orgWide && existing.rows[0].location_id !== principal.locationId) {
      throw new ShopLaunchError("forbidden", "You cannot respond for this location.");
    }
    if (!["open", "escalated"].includes(existing.rows[0].status)) {
      throw new ShopLaunchError("invalid_state", "This correction request is not awaiting a Partner response.");
    }
    const updated = await client.query(
      `UPDATE partner_correction_requests
          SET status='partner_responded', partner_response=$2, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, response]
    );
    await client.query(
      `INSERT INTO partner_correction_events
        (correction_id, tenant_id, actor_type, actor_user_id, event_type, reason, metadata)
       VALUES ($1,$2,'partner_user',$3,'partner_responded',$4,$5::jsonb)`,
      [
        id,
        principal.tenantId,
        principal.userId,
        response.slice(0, 500),
        JSON.stringify({ idempotencyKey: input.idempotencyKey ?? null }),
      ]
    );
    return updated.rows[0];
  });
}

export async function createCustomerCorrectionRequest(input: {
  certificateNumber: string;
  customerEmail?: string | null;
  customerReference?: string | null;
  reason: string;
}) {
  const cert = safeText(input.certificateNumber, 80);
  const reason = safeText(input.reason, 5000);
  if (!cert || !reason) throw new ShopLaunchError("bad_request", "Certificate number and reason are required.");
  const email = safeText(input.customerEmail, 320);
  if (email && !EMAIL_RE.test(email)) throw new ShopLaunchError("bad_request", "Email address is invalid.");
  return withPartnerAdminTransaction(async (client) => {
    const origin = await client.query("SELECT * FROM partner_grading_origin_snapshots WHERE certificate_number=$1", [
      cert,
    ]);
    const row = origin.rows[0] as any | undefined;
    const partnerActive =
      row?.tenant_id &&
      (await client.query<{ status: string }>("SELECT status FROM partner_organisations WHERE id=$1", [row.tenant_id]));
    const routeToPartner = row?.origin_type === "partner" && partnerActive?.rows[0]?.status === "ACTIVE";
    const inserted = await client.query(
      `INSERT INTO partner_correction_requests
         (certificate_number, origin_snapshot_id, tenant_id, location_id, status, customer_email_hash,
          customer_reference, request_reason, assigned_to, escalation_reason, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '7 days')
       RETURNING *`,
      [
        cert,
        row?.id ?? null,
        routeToPartner ? row.tenant_id : null,
        routeToPartner ? row.location_id : null,
        routeToPartner ? "open" : "escalated",
        emailHash(email),
        safeText(input.customerReference, 200),
        reason,
        routeToPartner ? "origin" : "mintvault_hq",
        routeToPartner ? null : "No active Partner origin is available; routed to MintVault HQ.",
      ]
    );
    await client.query(
      `INSERT INTO partner_correction_events
        (correction_id, tenant_id, actor_type, event_type, reason, metadata)
       VALUES ($1,$2,'customer','created',$3,$4::jsonb)`,
      [
        inserted.rows[0].id,
        routeToPartner ? row.tenant_id : null,
        reason.slice(0, 500),
        JSON.stringify({ certificateNumber: cert, routedToPartner: routeToPartner }),
      ]
    );
    return inserted.rows[0];
  });
}

export async function listReadiness(principal: PartnerPrincipal) {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const { rows } = await client.query(
      `SELECT check_key, status, evidence_type, evidence, reason, updated_at
         FROM partner_readiness_checks
        WHERE location_id IS NOT DISTINCT FROM $1::uuid OR location_id IS NULL
        ORDER BY check_key`,
      [principal.locationId]
    );
    return rows.map((row: any) => ({ ...row, updated_at: toIso(row.updated_at) }));
  });
}

export async function adminUpsertCreditPackage(
  actor: SuperAdminLaunchActor,
  input: {
    packageId?: string | null;
    name: string;
    description?: string | null;
    credits: number;
    pricePence: number;
    currency?: string | null;
    stripePriceId?: string | null;
    stripeProductId?: string | null;
    status?: string | null;
    displayOrder?: number | null;
  }
) {
  const name = safeText(input.name, 200);
  if (!name) throw new ShopLaunchError("bad_request", "Package name is required.");
  if (!Number.isInteger(input.credits) || input.credits <= 0)
    throw new ShopLaunchError("bad_request", "Credits are invalid.");
  if (!Number.isInteger(input.pricePence) || input.pricePence < 0)
    throw new ShopLaunchError("bad_request", "Price is invalid.");
  const status = input.status === "active" ? "active" : input.status === "archived" ? "archived" : "inactive";
  return withPartnerAdminTransaction(async (client) => {
    const result = input.packageId
      ? await client.query(
          `UPDATE partner_credit_packages
              SET name=$2, description=$3, credits=$4, price_pence=$5, currency=$6,
                  stripe_price_id=$7, stripe_product_id=$8, status=$9, display_order=$10,
                  updated_by_user_id=$11, updated_at=now()
            WHERE id=$1 RETURNING *`,
          [
            requireUuid(input.packageId, "packageId"),
            name,
            safeText(input.description, 1000),
            input.credits,
            (input.currency ?? "GBP").toUpperCase(),
            safeText(input.stripePriceId, 200),
            safeText(input.stripeProductId, 200),
            status,
            input.displayOrder ?? 100,
            actor.userId,
          ]
        )
      : await client.query(
          `INSERT INTO partner_credit_packages
             (name, description, credits, price_pence, currency, stripe_price_id, stripe_product_id,
              status, display_order, created_by_user_id, updated_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
           RETURNING *`,
          [
            name,
            safeText(input.description, 1000),
            input.credits,
            input.pricePence,
            (input.currency ?? "GBP").toUpperCase(),
            safeText(input.stripePriceId, 200),
            safeText(input.stripeProductId, 200),
            status,
            input.displayOrder ?? 100,
            actor.userId,
          ]
        );
    if (result.rowCount !== 1) throw new ShopLaunchError("not_found", "Package not found.");
    await auditLaunch(client, {
      actorType: "super_admin",
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: "partner_credit_package",
      targetId: result.rows[0].id,
      action: input.packageId ? "credit_package_updated" : "credit_package_created",
      correlationId: actor.correlationId,
      after: result.rows[0],
    });
    return result.rows[0];
  });
}

export async function adminSetPackageEligibility(
  actor: SuperAdminLaunchActor,
  tenantId: string,
  packageId: string,
  eligible: boolean,
  reason: string
) {
  requireUuid(tenantId, "tenantId");
  requireUuid(packageId, "packageId");
  const why = requireReason(reason);
  return withPartnerAdminTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO partner_credit_package_eligibility (tenant_id, package_id, eligible, reason)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, package_id) DO UPDATE
          SET eligible=EXCLUDED.eligible, reason=EXCLUDED.reason, updated_at=now()
       RETURNING *`,
      [tenantId, packageId, eligible, why]
    );
    await auditLaunch(client, {
      tenantId,
      actorType: "super_admin",
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: "partner_credit_package_eligibility",
      targetId: packageId,
      action: "package_eligibility_set",
      reason: why,
      correlationId: actor.correlationId,
      after: { packageId, eligible },
    });
    return result.rows[0];
  });
}

export async function adminListLaunchState(tenantId: string) {
  requireUuid(tenantId, "tenantId");
  const [packages, purchases, reconciliation, readiness, pilot, corrections] = await Promise.all([
    partnerAdminQuery("SELECT * FROM partner_credit_packages ORDER BY display_order, credits, id"),
    partnerAdminQuery("SELECT * FROM partner_credit_purchases WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", [
      tenantId,
    ]),
    partnerAdminQuery(
      "SELECT * FROM partner_payment_reconciliation_cases WHERE tenant_id=$1 ORDER BY opened_at DESC LIMIT 100",
      [tenantId]
    ),
    partnerAdminQuery(
      "SELECT * FROM partner_readiness_checks WHERE tenant_id=$1 ORDER BY location_id NULLS FIRST, check_key",
      [tenantId]
    ),
    partnerAdminQuery(
      "SELECT * FROM partner_pilot_authorisations WHERE tenant_id=$1 ORDER BY location_id NULLS FIRST",
      [tenantId]
    ),
    partnerAdminQuery(
      "SELECT * FROM partner_correction_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
      [tenantId]
    ),
  ]);
  const credit = await getCreditPosition(tenantId).catch(() => null);
  return {
    packages: packages.rows,
    purchases: purchases.rows,
    reconciliation: reconciliation.rows,
    readiness: readiness.rows,
    pilot: pilot.rows,
    corrections: corrections.rows,
    credit,
  };
}

export async function adminSetReadinessCheck(
  actor: SuperAdminLaunchActor,
  tenantId: string,
  input: {
    locationId?: string | null;
    checkKey: string;
    status: string;
    evidenceType?: string | null;
    evidence?: unknown;
    reason: string;
  }
) {
  requireUuid(tenantId, "tenantId");
  const locationId = input.locationId ? requireUuid(input.locationId, "locationId") : null;
  const checkKey = safeText(input.checkKey, 120);
  if (!checkKey) throw new ShopLaunchError("bad_request", "Readiness check key is required.");
  const status = ["missing", "passed", "failed", "waived", "blocked"].includes(input.status) ? input.status : "missing";
  const evidenceType = input.evidenceType === "automatic" ? "automatic" : "manual";
  const reason = requireReason(input.reason);
  return withPartnerAdminTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO partner_readiness_checks
         (tenant_id, location_id, check_key, status, evidence_type, evidence, confirmed_by_user_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (tenant_id, location_id, check_key) DO UPDATE
          SET status=EXCLUDED.status, evidence_type=EXCLUDED.evidence_type, evidence=EXCLUDED.evidence,
              confirmed_by_user_id=EXCLUDED.confirmed_by_user_id, reason=EXCLUDED.reason, updated_at=now()
       RETURNING *`,
      [tenantId, locationId, checkKey, status, evidenceType, JSON.stringify(input.evidence ?? {}), actor.userId, reason]
    );
    await auditLaunch(client, {
      tenantId,
      actorType: "super_admin",
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: "partner_readiness_check",
      targetId: checkKey,
      action: "readiness_check_set",
      reason,
      correlationId: actor.correlationId,
      after: result.rows[0],
    });
    return result.rows[0];
  });
}

export async function adminSetPilotAuthorisation(
  actor: SuperAdminLaunchActor,
  tenantId: string,
  input: { locationId?: string | null; status: string; reason: string; blockers?: unknown }
) {
  requireUuid(tenantId, "tenantId");
  const locationId = input.locationId ? requireUuid(input.locationId, "locationId") : null;
  const status = ["not_authorised", "authorised", "suspended", "revoked"].includes(input.status)
    ? input.status
    : "not_authorised";
  const reason = requireReason(input.reason);
  return withPartnerAdminTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO partner_pilot_authorisations
         (tenant_id, location_id, status, authorised_by_user_id, reason, blockers, authorised_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,CASE WHEN $3='authorised' THEN now() ELSE NULL END,
               CASE WHEN $3='revoked' THEN now() ELSE NULL END)
       ON CONFLICT (tenant_id, location_id) DO UPDATE
          SET status=EXCLUDED.status, authorised_by_user_id=EXCLUDED.authorised_by_user_id,
              reason=EXCLUDED.reason, blockers=EXCLUDED.blockers,
              authorised_at=CASE WHEN EXCLUDED.status='authorised' THEN now() ELSE partner_pilot_authorisations.authorised_at END,
              revoked_at=CASE WHEN EXCLUDED.status='revoked' THEN now() ELSE partner_pilot_authorisations.revoked_at END,
              updated_at=now()
       RETURNING *`,
      [tenantId, locationId, status, actor.userId, reason, JSON.stringify(input.blockers ?? [])]
    );
    await auditLaunch(client, {
      tenantId,
      actorType: "super_admin",
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: "partner_pilot_authorisation",
      targetId: locationId ?? tenantId,
      action: "pilot_authorisation_set",
      reason,
      correlationId: actor.correlationId,
      after: result.rows[0],
    });
    return result.rows[0];
  });
}

export async function adminResolveReconciliationCase(
  actor: SuperAdminLaunchActor,
  caseId: string,
  input: { status: "resolved" | "dismissed"; reason: string }
) {
  const id = requireUuid(caseId, "caseId");
  const reason = requireReason(input.reason);
  return withPartnerAdminTransaction(async (client) => {
    const result = await client.query(
      `UPDATE partner_payment_reconciliation_cases
          SET status=$2, resolved_by_user_id=$3, resolution_reason=$4, resolved_at=now()
        WHERE id=$1 AND status <> 'resolved'
        RETURNING *`,
      [id, input.status === "dismissed" ? "dismissed" : "resolved", actor.userId, reason]
    );
    if (result.rowCount !== 1) throw new ShopLaunchError("not_found", "Reconciliation case not found.");
    await auditLaunch(client, {
      tenantId: result.rows[0].tenant_id,
      actorType: "super_admin",
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: "partner_payment_reconciliation_case",
      targetId: id,
      action: "reconciliation_case_resolved",
      reason,
      correlationId: actor.correlationId,
      after: result.rows[0],
    });
    return result.rows[0];
  });
}
