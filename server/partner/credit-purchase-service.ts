/**
 * P5 — BUY MORE GRADING CREDITS.
 *
 * THE ONE RULE: the verified Stripe WEBHOOK is the only thing that can grant a Grading Credit. A
 * browser success page never grants, in any environment. A user who closes the tab, loses signal, or
 * never returns from Stripe still gets exactly the credits they paid for, and a user who reloads the
 * success page a hundred times still gets no extra.
 *
 * EXACTLY-ONCE IS NOT NEW CODE HERE. It is two INDEPENDENT pre-existing mechanisms, deliberately
 * reused rather than reinvented:
 *
 *   1. `stripe_webhook_events` — `INSERT ... ON CONFLICT DO NOTHING` claims the event id. Race-safe
 *      across concurrent deliveries: only one caller is told to process.
 *   2. `uq_partner_credit_ledger_idem (source, idempotency_key)` — the grant is written with
 *      source='stripe' and idempotency_key = the STRIPE EVENT ID, so even if the claim were somehow
 *      bypassed the database still refuses the second ledger row.
 *
 * Two layers matter because they fail differently: the claim protects against concurrent delivery,
 * the unique index protects against a claim table that was truncated, restored, or bypassed. Either
 * alone would be a single point of failure on the money path.
 *
 * NO SECOND WALLET. Credits are granted through `appendFoundationCredit()`, the existing and only
 * positive-credit write boundary, which the ledger's CHECK constraints already permit to carry
 * entry_type='purchase' and source='stripe' (migration 0016) — values nothing had ever written.
 */
import { appendFoundationCredit } from "./partner-wallet-service";
import { partnerAdminQuery } from "./db";

export class CreditPurchaseError extends Error {
  constructor(
    public code: "PACK_NOT_FOUND" | "PACK_NOT_PURCHASABLE" | "FORBIDDEN" | "NOT_PAID" | "TENANT_MISSING",
    message: string
  ) {
    super(message);
  }
}

export interface CreditPack {
  id: string;
  code: string;
  credits: number;
  stripePriceId: string | null;
  /** False when the owner has not yet configured a Stripe Price — catalogued but not buyable. */
  purchasable: boolean;
}

/**
 * The catalogue. Returned to the dashboard so a partner sees the real pack list even before pricing
 * is configured; `purchasable` is what the UI must gate the buy button on.
 */
export async function listCreditPacks(): Promise<CreditPack[]> {
  const { rows } = await partnerAdminQuery<{
    id: string;
    code: string;
    credits: number;
    stripe_price_id: string | null;
  }>(
    `SELECT id, code, credits, stripe_price_id
       FROM partner_credit_packs
      WHERE active
      ORDER BY sort_order, credits`
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    credits: Number(r.credits),
    stripePriceId: r.stripe_price_id,
    purchasable: r.stripe_price_id !== null,
  }));
}

/**
 * Who may spend the organisation's money.
 *
 * OWNER always. MANAGER only when `partner.credits.purchase` has been explicitly granted — billing
 * authority is granted, never assumed (plan OD-5 default). GRADER never, and no permission grant
 * changes that: a grading role has no business buying, so the role is refused before permissions are
 * consulted at all.
 */
export function canPurchaseCredits(role: string, permissions: ReadonlySet<string>): boolean {
  if (role === "GRADER" || role === "PARTNER_GRADER") return false;
  if (role === "OWNER" || role === "PARTNER_OWNER") return true;
  return permissions.has("partner.credits.purchase");
}

/** Metadata the checkout session must carry so the webhook can attribute the payment. */
export interface CheckoutAttribution {
  tenantId: string;
  packCode: string;
  initiatingUserId: string;
}

/**
 * Resolve a pack for checkout. Refuses a pack with no Stripe Price id — that is the state every pack
 * ships in until the owner configures pricing, and it must fail as an explicit, explainable refusal
 * rather than as a Stripe error about a missing price.
 */
export async function resolvePackForCheckout(packCode: string): Promise<CreditPack> {
  const packs = await listCreditPacks();
  const pack = packs.find((p) => p.code === packCode);
  if (!pack) throw new CreditPurchaseError("PACK_NOT_FOUND", "That Grading Credit pack is not available.");
  if (!pack.purchasable) {
    throw new CreditPurchaseError(
      "PACK_NOT_PURCHASABLE",
      "This pack has no price configured yet and cannot be purchased."
    );
  }
  return pack;
}

/** The Checkout Session fields the fulfilment path reads. Kept minimal on purpose. */
export interface PartnerCheckoutSession {
  id?: string;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
}

export interface GrantOutcome {
  granted: boolean;
  credits: number;
  reason?: string;
}

/**
 * Fulfil a paid partner credit purchase.
 *
 * MUST be called only after the webhook signature has been verified and the event id claimed — this
 * function is the grant, not the gate. `stripeEventId` becomes the ledger idempotency key, which is
 * what makes a replay a no-op at the database level rather than a matter of caller discipline.
 *
 * Returns `granted: false` with a reason rather than throwing for the ordinary "nothing to do" cases
 * (unpaid session, missing attribution): a webhook that raises gets retried by Stripe forever, so a
 * permanent non-condition must be reported as handled, not as a failure.
 */
export async function fulfilPartnerCreditPurchase(
  session: PartnerCheckoutSession,
  stripeEventId: string
): Promise<GrantOutcome> {
  // A session that is not paid grants nothing. `checkout.session.completed` can arrive for an
  // unpaid/expired session, and an expired or failed checkout must leave capacity untouched.
  if (session.payment_status !== "paid") {
    return { granted: false, credits: 0, reason: "session_not_paid" };
  }

  const tenantId = session.metadata?.partner_tenant_id;
  const packCode = session.metadata?.partner_pack_code;
  if (!tenantId || !packCode) {
    // Not a partner credit purchase — another product's checkout. Not an error.
    return { granted: false, credits: 0, reason: "not_a_partner_credit_purchase" };
  }

  // Credits come from the SERVER-side catalogue keyed by pack code, never from session metadata or
  // the amount paid. Metadata is client-influenced at creation time; trusting a `credits` field
  // there would let a tampered session mint arbitrary capacity.
  const { rows } = await partnerAdminQuery<{ credits: number }>(
    `SELECT credits FROM partner_credit_packs WHERE code=$1`,
    [packCode]
  );
  const credits = Number(rows[0]?.credits ?? 0);
  if (!credits || credits <= 0) {
    return { granted: false, credits: 0, reason: "pack_not_found" };
  }

  await appendFoundationCredit(
    { actorUserId: null, actorEmail: null },
    {
      tenantId,
      amount: credits,
      entryType: "purchase",
      source: "stripe",
      reason: `Purchased Grading Credit pack ${packCode}.`,
      // THE exactly-once key. A replayed event carries the same id, and the ledger's
      // uq_partner_credit_ledger_idem (source, idempotency_key) refuses the second row.
      idempotencyKey: stripeEventId,
      externalRef: session.id ?? null,
      actorType: "system",
      metadata: {
        stripe_event_id: stripeEventId,
        stripe_session_id: session.id ?? null,
        pack_code: packCode,
        initiating_user_id: session.metadata?.partner_initiating_user_id ?? null,
      },
    }
  );

  return { granted: true, credits };
}

/**
 * Record a refund or chargeback as an audited ACCOUNTING EXCEPTION rather than silently reducing
 * capacity.
 *
 * Deliberately does NOT debit the wallet. Capacity may already be reserved or consumed against
 * cards that are mid-grade or already printed; a silent negative adjustment would either strand
 * those cards or drive availability below committed reservations — and the ledger's
 * `partner_credit_ledger_preserve_active_reservations` trigger would refuse it anyway. A human
 * resolves it with an audited Super Admin adjustment, which is the documented workflow.
 */
export async function recordPurchaseException(
  stripeEventId: string,
  detail: { tenantId?: string | null; sessionId?: string | null; kind: string }
): Promise<void> {
  await partnerAdminQuery(
    `INSERT INTO partner_credit_accounting_exceptions
       (tenant_id, event_type, reason_code, idempotency_key, metadata)
     SELECT $1::uuid, 'settlement_exception', $2, $3, $4::jsonb
      WHERE $1 IS NOT NULL
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      detail.tenantId ?? null,
      detail.kind,
      `stripe-exception:${stripeEventId}`,
      JSON.stringify({ stripe_event_id: stripeEventId, stripe_session_id: detail.sessionId ?? null }),
    ]
  );
}
