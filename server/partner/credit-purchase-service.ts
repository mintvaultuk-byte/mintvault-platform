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
import type pg from "pg";
import { appendFoundationCreditWithClient } from "./partner-wallet-service";
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import { declaredStripeEnvironment, type StripeEnvironment } from "../stripeClient";

export class CreditPurchaseError extends Error {
  constructor(
    public code:
      | "PACK_NOT_FOUND"
      | "PACK_NOT_PURCHASABLE"
      | "STRIPE_ENV_UNDECLARED"
      | "STRIPE_ENV_MISMATCH"
      | "STRIPE_PRICE_MISMATCH"
      | "STRIPE_CURRENCY_MISMATCH"
      | "STRIPE_AMOUNT_MISMATCH"
      | "STRIPE_TAX_BEHAVIOR_MISMATCH"
      | "STRIPE_PRICE_INACTIVE"
      | "CHECKOUT_INTENT_CONFLICT"
      | "FORBIDDEN"
      | "NOT_PAID"
      | "TENANT_MISSING",
    message: string
  ) {
    super(message);
  }
}

export type CheckoutUnavailableReason =
  "pricing_not_configured" | "stripe_environment_undeclared" | "stripe_environment_mismatch";

export interface CreditPack {
  id: string;
  code: string;
  credits: number;
  pricePence: number;
  displayPrice: string;
  vatIncluded: true;
  stripePriceId: string | null;
  stripeCurrency: string | null;
  /** False when the owner has not yet configured a Stripe Price — catalogued but not buyable. */
  purchasable: boolean;
  unavailableReason: CheckoutUnavailableReason | null;
}

export const PARTNER_CREDIT_PRICE_PENCE = 1_000;
export const PARTNER_CREDIT_CURRENCY = "gbp";
export const PARTNER_CREDIT_VAT_INCLUDED = true as const;

export const CANONICAL_PARTNER_CREDIT_PACKS: Readonly<Record<string, { credits: number; pricePence: number }>> = {
  PACK_5: { credits: 5, pricePence: 5_000 },
  PACK_10: { credits: 10, pricePence: 10_000 },
  PACK_25: { credits: 25, pricePence: 25_000 },
  PACK_50: { credits: 50, pricePence: 50_000 },
  PACK_100: { credits: 100, pricePence: 100_000 },
};

function canonicalPackPricing(code: string, credits: number): { pricePence: number; displayPrice: string } | null {
  const configured = CANONICAL_PARTNER_CREDIT_PACKS[code];
  if (!configured || configured.credits !== credits) return null;
  const pricePence = configured.pricePence;
  return {
    pricePence,
    displayPrice: new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: "GBP",
      maximumFractionDigits: 0,
    }).format(pricePence / 100),
  };
}

export interface CheckoutStripeEnvironmentStatus {
  ok: boolean;
  environment: StripeEnvironment | null;
  code: "STRIPE_ENV_UNDECLARED" | "STRIPE_ENV_MISMATCH" | null;
  reason: Exclude<CheckoutUnavailableReason, "pricing_not_configured"> | null;
  message: string | null;
}

function deploymentKind(): "staging" | "production" | "other" {
  const appName = (process.env.FLY_APP_NAME || "").trim().toLowerCase();
  const appUrl = (process.env.APP_URL || "").trim().toLowerCase();
  if (appName === "mintvault-v2" || appUrl.includes("mintvault-v2.fly.dev")) return "staging";
  if (appName === "mintvault" || appUrl.includes("mintvaultuk.com") || appUrl.includes("mintvault.fly.dev")) {
    return "production";
  }
  return "other";
}

/**
 * Checkout is not allowed to create a Stripe Session until this process has declared which Stripe
 * mode it belongs to. A test key on staging is not enough: the webhook grant also compares the
 * re-read Session's `livemode`, and an undeclared deployment would create sessions that can never
 * safely grant credits.
 */
export function checkoutStripeEnvironmentStatus(): CheckoutStripeEnvironmentStatus {
  const environment = declaredStripeEnvironment();
  if (environment === null) {
    return {
      ok: false,
      environment: null,
      code: "STRIPE_ENV_UNDECLARED",
      reason: "stripe_environment_undeclared",
      message: "Stripe TEST/LIVE mode is not configured for this deployment.",
    };
  }

  const kind = deploymentKind();
  if (kind === "staging" && environment !== "test") {
    return {
      ok: false,
      environment,
      code: "STRIPE_ENV_MISMATCH",
      reason: "stripe_environment_mismatch",
      message: "Staging is configured for live Stripe mode. Refusing to start checkout.",
    };
  }
  if (kind === "production" && environment !== "live") {
    return {
      ok: false,
      environment,
      code: "STRIPE_ENV_MISMATCH",
      reason: "stripe_environment_mismatch",
      message: "Production is configured for test Stripe mode. Refusing to start checkout.",
    };
  }

  return { ok: true, environment, code: null, reason: null, message: null };
}

/**
 * The catalogue. Returned to the dashboard so a partner sees the real pack list even before pricing
 * is configured; `purchasable` is what the UI must gate the buy button on.
 */
export async function listCreditPacks(): Promise<CreditPack[]> {
  const checkoutEnvironment = checkoutStripeEnvironmentStatus();
  const { rows } = await partnerAdminQuery<{
    id: string;
    code: string;
    credits: number;
    stripe_price_id: string | null;
    stripe_currency: string | null;
  }>(
    `SELECT id, code, credits, stripe_price_id, stripe_currency
       FROM partner_credit_packs
      WHERE active
      ORDER BY sort_order, credits`
  );
  return rows.flatMap((r) => {
    const credits = Number(r.credits);
    const pricing = canonicalPackPricing(r.code, credits);
    if (!pricing) return [];
    const hasConfiguredPrice = r.stripe_price_id !== null && r.stripe_currency !== null;
    const unavailableReason: CheckoutUnavailableReason | null = !hasConfiguredPrice
      ? "pricing_not_configured"
      : checkoutEnvironment.reason;
    return [
      {
        id: r.id,
        code: r.code,
        credits,
        pricePence: pricing.pricePence,
        displayPrice: pricing.displayPrice,
        vatIncluded: PARTNER_CREDIT_VAT_INCLUDED,
        stripePriceId: r.stripe_price_id,
        stripeCurrency: r.stripe_currency,
        // A Price without its canonical currency is intentionally not a buyable pack. Do not guess a
        // currency from deployment convention: staging and production can only sell what the owner
        // explicitly configured for that exact Stripe Price. A declared Stripe mode is equally
        // required, otherwise Checkout could succeed while the verified webhook remains fail-closed.
        purchasable: hasConfiguredPrice && checkoutEnvironment.ok,
        unavailableReason,
      },
    ];
  });
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
  if (role === "GRADER" || role === "PARTNER_GRADER" || role === "MVGS_ASSESSMENT_TECHNICIAN") return false;
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
    if (pack.unavailableReason === "stripe_environment_undeclared") {
      throw new CreditPurchaseError(
        "STRIPE_ENV_UNDECLARED",
        "Stripe TEST/LIVE mode is not configured for this deployment."
      );
    }
    if (pack.unavailableReason === "stripe_environment_mismatch") {
      throw new CreditPurchaseError(
        "STRIPE_ENV_MISMATCH",
        checkoutStripeEnvironmentStatus().message || "Stripe mode does not match this deployment."
      );
    }
    throw new CreditPurchaseError(
      "PACK_NOT_PURCHASABLE",
      "This pack has no price configured yet and cannot be purchased."
    );
  }
  return pack;
}

export interface StripePriceForCheckout {
  id?: string | null;
  currency?: string | null;
  unitAmount?: number | null;
  taxBehavior?: string | null;
  livemode?: boolean | null;
  active?: boolean | null;
}

/**
 * Refuse a Checkout before the buyer reaches Stripe when the configured Price does not match the
 * local canonical pack. The webhook repeats the protected checks after payment; this prevents a bad
 * Price/currency/environment configuration from taking money and then correctly granting nothing.
 */
export function validateStripePriceForCheckout(pack: CreditPack, price: StripePriceForCheckout): StripeEnvironment {
  const status = checkoutStripeEnvironmentStatus();
  if (!status.ok || status.environment === null) {
    throw new CreditPurchaseError(status.code || "STRIPE_ENV_UNDECLARED", status.message || "Stripe mode is not set.");
  }
  if (price.active !== true) {
    throw new CreditPurchaseError("STRIPE_PRICE_INACTIVE", "This Stripe Price is not active.");
  }
  if (price.id !== pack.stripePriceId) {
    throw new CreditPurchaseError("STRIPE_PRICE_MISMATCH", "The configured Stripe Price does not match this pack.");
  }
  const expectedCurrency = pack.stripeCurrency?.trim().toLowerCase();
  const observedCurrency = price.currency?.trim().toLowerCase();
  if (!expectedCurrency || !observedCurrency || expectedCurrency !== observedCurrency) {
    throw new CreditPurchaseError(
      "STRIPE_CURRENCY_MISMATCH",
      "The configured Stripe Price currency does not match this pack."
    );
  }
  if (price.unitAmount !== pack.pricePence) {
    throw new CreditPurchaseError(
      "STRIPE_AMOUNT_MISMATCH",
      "The configured Stripe Price amount does not match this pack."
    );
  }
  // The commercial policy is a VAT-inclusive amount. Stripe's `unspecified` defers to the account
  // default, which may be exclusive, so only the explicit inclusive setting proves the displayed
  // amount is the charged amount. Rejecting only "exclusive" would let an `unspecified` Price add
  // VAT on top of the advertised pack price.
  if (price.taxBehavior !== "inclusive") {
    throw new CreditPurchaseError("STRIPE_TAX_BEHAVIOR_MISMATCH", "The configured Stripe Price must be VAT-inclusive.");
  }
  if (price.livemode !== (status.environment === "live")) {
    throw new CreditPurchaseError(
      "STRIPE_ENV_MISMATCH",
      "The configured Stripe Price belongs to the wrong Stripe environment."
    );
  }
  return status.environment;
}

export interface PartnerCreditCheckoutIntentInput {
  stripeSessionId: string;
  tenantId: string;
  packCode: string;
  initiatingUserId: string;
  stripePriceId: string;
  stripeCurrency: string;
  stripeEnvironment: StripeEnvironment;
}

interface PartnerCreditCheckoutIntent {
  stripeSessionId: string;
  tenantId: string;
  packCode: string;
  initiatingUserId: string;
  stripePriceId: string;
  stripeCurrency: string;
  stripeEnvironment: StripeEnvironment;
  checkoutOperationKey: string | null;
  checkoutUrl: string | null;
  checkoutExpiresAt: Date | null;
  credits: number | null;
  pricePence: number | null;
  taxBehavior: string | null;
  status: string;
}

export interface PartnerCreditCheckoutOperation {
  checkoutOperationKey: string;
  stripeSessionId: string | null;
  checkoutUrl: string | null;
  checkoutExpiresAt: Date;
  tenantId: string;
  packCode: string;
  initiatingUserId: string;
  stripePriceId: string;
  stripeCurrency: string;
  stripeEnvironment: StripeEnvironment;
  credits: number;
  pricePence: number;
  taxBehavior: "inclusive";
  status: "creating" | "created";
}

export interface PartnerCreditCheckoutOperationInput {
  tenantId: string;
  packCode: string;
  initiatingUserId: string;
  stripePriceId: string;
  stripeCurrency: string;
  stripeEnvironment: StripeEnvironment;
  credits: number;
  pricePence: number;
  /** The server only sells VAT-inclusive packs. Kept in the intent snapshot for fulfilment. */
  taxBehavior: "inclusive";
  checkoutExpiresAt: Date;
}

type PartnerCreditCheckoutQueryable = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
};

const partnerCreditCheckoutAdminQueryable: PartnerCreditCheckoutQueryable = {
  query: (sql: string, params?: unknown[]) => partnerAdminQuery(sql, params ?? []),
};

function normalizeCurrency(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalCheckoutSnapshot(
  packCode: string
): { credits: number; pricePence: number; taxBehavior: "inclusive" } | null {
  const pack = CANONICAL_PARTNER_CREDIT_PACKS[packCode];
  if (!pack) return null;
  return { credits: pack.credits, pricePence: pack.pricePence, taxBehavior: "inclusive" };
}

function presentCheckoutOperation(intent: { packCode: string; credits: number; pricePence: number }): {
  packCode: string;
  credits: number;
  pricePence: number;
  displayPrice: string;
  vatIncluded: true;
} {
  const pricing = canonicalPackPricing(intent.packCode, intent.credits);
  if (!pricing || pricing.pricePence !== intent.pricePence) {
    throw new CreditPurchaseError(
      "CHECKOUT_INTENT_CONFLICT",
      "Checkout intent does not match a canonical credit pack."
    );
  }
  return {
    packCode: intent.packCode,
    credits: intent.credits,
    pricePence: intent.pricePence,
    displayPrice: pricing.displayPrice,
    vatIncluded: PARTNER_CREDIT_VAT_INCLUDED,
  };
}

export function presentPartnerCreditCheckoutOperation(operation: PartnerCreditCheckoutOperation): {
  packCode: string;
  credits: number;
  pricePence: number;
  displayPrice: string;
  vatIncluded: true;
} {
  return presentCheckoutOperation(operation);
}

function checkoutIntentMatches(
  existing: PartnerCreditCheckoutIntent,
  input: PartnerCreditCheckoutIntentInput
): boolean {
  return (
    existing.stripeSessionId === input.stripeSessionId &&
    existing.tenantId === input.tenantId &&
    existing.packCode === input.packCode &&
    existing.initiatingUserId === input.initiatingUserId &&
    existing.stripePriceId === input.stripePriceId &&
    existing.stripeCurrency === normalizeCurrency(input.stripeCurrency) &&
    existing.stripeEnvironment === input.stripeEnvironment
  );
}

/** Record the exact server-created Checkout Session that a future webhook is allowed to fulfil. */
export async function recordPartnerCreditCheckoutIntent(input: PartnerCreditCheckoutIntentInput): Promise<void> {
  const stripeCurrency = normalizeCurrency(input.stripeCurrency);
  const snapshot = canonicalCheckoutSnapshot(input.packCode);
  if (!snapshot) {
    throw new CreditPurchaseError("PACK_NOT_FOUND", "That Grading Credit pack is not available.");
  }
  const inserted = await partnerAdminQuery<{ id: string }>(
    `INSERT INTO partner_credit_checkout_sessions
       (tenant_id, stripe_session_id, pack_code, initiating_user_id, stripe_price_id, stripe_currency,
        stripe_environment, checkout_operation_key, checkout_expires_at, credits, price_pence, tax_behavior)
     VALUES ($1,$2,$3,$4,$5,$6,$7,gen_random_uuid(),now() + interval '24 hours',$8,$9,$10)
     ON CONFLICT (stripe_session_id) DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.stripeSessionId,
      input.packCode,
      input.initiatingUserId,
      input.stripePriceId,
      stripeCurrency,
      input.stripeEnvironment,
      snapshot.credits,
      snapshot.pricePence,
      snapshot.taxBehavior,
    ]
  );
  if (inserted.rowCount && inserted.rowCount > 0) return;

  const existing = await loadPartnerCreditCheckoutIntent(input.stripeSessionId);
  if (existing && checkoutIntentMatches(existing, { ...input, stripeCurrency })) return;

  throw new CreditPurchaseError(
    "CHECKOUT_INTENT_CONFLICT",
    "This Stripe Checkout Session is already bound to different purchase details."
  );
}

async function loadPartnerCreditCheckoutIntent(
  stripeSessionId: string,
  client: PartnerCreditCheckoutQueryable = partnerCreditCheckoutAdminQueryable,
  lockForGrant = false
): Promise<PartnerCreditCheckoutIntent | null> {
  const lockClause = lockForGrant ? " FOR UPDATE" : "";
  const { rows } = await client.query<{
    stripe_session_id: string | null;
    tenant_id: string;
    pack_code: string;
    initiating_user_id: string;
    stripe_price_id: string;
    stripe_currency: string;
    stripe_environment: StripeEnvironment;
    checkout_operation_key: string | null;
    checkout_url: string | null;
    checkout_expires_at: Date | null;
    credits: number | null;
    price_pence: number | null;
    tax_behavior: string | null;
    status: string;
  }>(
    `SELECT stripe_session_id, tenant_id, pack_code, initiating_user_id, stripe_price_id,
            stripe_currency, stripe_environment, checkout_operation_key, checkout_url,
            checkout_expires_at, credits, price_pence, tax_behavior, status
       FROM partner_credit_checkout_sessions
      WHERE stripe_session_id=$1${lockClause}`,
    [stripeSessionId]
  );
  const row = rows[0];
  if (!row || !row.stripe_session_id) return null;
  return {
    stripeSessionId: row.stripe_session_id,
    tenantId: row.tenant_id,
    packCode: row.pack_code,
    initiatingUserId: row.initiating_user_id,
    stripePriceId: row.stripe_price_id,
    stripeCurrency: normalizeCurrency(row.stripe_currency),
    stripeEnvironment: row.stripe_environment,
    checkoutOperationKey: row.checkout_operation_key,
    checkoutUrl: row.checkout_url,
    checkoutExpiresAt: row.checkout_expires_at,
    credits: row.credits === null ? null : Number(row.credits),
    pricePence: row.price_pence === null ? null : Number(row.price_pence),
    taxBehavior: row.tax_behavior,
    status: row.status,
  };
}

async function markPartnerCreditCheckoutGranted(
  stripeSessionId: string,
  tenantId: string,
  stripeEventId: string,
  client: PartnerCreditCheckoutQueryable = partnerCreditCheckoutAdminQueryable
): Promise<void> {
  const updated = await client.query(
    `UPDATE partner_credit_checkout_sessions
        SET status='granted', granted_event_id=$3, granted_at=COALESCE(granted_at, now()), updated_at=now()
      WHERE stripe_session_id=$1 AND tenant_id=$2 AND status IN ('created', 'expired')`,
    [stripeSessionId, tenantId, stripeEventId]
  );
  if (updated.rowCount !== 1) {
    throw new CreditPurchaseError(
      "CHECKOUT_INTENT_CONFLICT",
      "Checkout Session grant state changed before the ledger commit."
    );
  }
}

function checkoutOperationFromRow(row: {
  checkout_operation_key: string;
  stripe_session_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: Date;
  tenant_id: string;
  pack_code: string;
  initiating_user_id: string;
  stripe_price_id: string;
  stripe_currency: string;
  stripe_environment: StripeEnvironment;
  credits: number;
  price_pence: number;
  tax_behavior: string;
  status: "creating" | "created";
}): PartnerCreditCheckoutOperation {
  if (row.tax_behavior !== "inclusive") {
    throw new CreditPurchaseError("CHECKOUT_INTENT_CONFLICT", "Checkout intent tax behaviour is not supported.");
  }
  return {
    checkoutOperationKey: row.checkout_operation_key,
    stripeSessionId: row.stripe_session_id,
    checkoutUrl: row.checkout_url,
    checkoutExpiresAt: new Date(row.checkout_expires_at),
    tenantId: row.tenant_id,
    packCode: row.pack_code,
    initiatingUserId: row.initiating_user_id,
    stripePriceId: row.stripe_price_id,
    stripeCurrency: normalizeCurrency(row.stripe_currency),
    stripeEnvironment: row.stripe_environment,
    credits: Number(row.credits),
    pricePence: Number(row.price_pence),
    taxBehavior: "inclusive",
    status: row.status,
  };
}

type CheckoutOperationRow = {
  checkout_operation_key: string;
  stripe_session_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: Date;
  tenant_id: string;
  pack_code: string;
  initiating_user_id: string;
  stripe_price_id: string;
  stripe_currency: string;
  stripe_environment: StripeEnvironment;
  credits: number;
  price_pence: number;
  tax_behavior: string;
  status: "creating" | "created";
};

async function expireElapsedCheckoutOperations(input: {
  tenantId: string;
  initiatingUserId: string;
  packCode: string;
  stripeEnvironment: StripeEnvironment;
}): Promise<void> {
  await partnerAdminQuery(
    `UPDATE partner_credit_checkout_sessions
        SET status='expired', updated_at=now()
      WHERE tenant_id=$1
        AND initiating_user_id=$2
        AND pack_code=$3
        AND stripe_environment=$4
        AND status IN ('creating', 'created')
        AND checkout_expires_at <= now()`,
    [input.tenantId, input.initiatingUserId, input.packCode, input.stripeEnvironment]
  );
}

async function loadActiveCheckoutOperation(input: {
  tenantId: string;
  initiatingUserId: string;
  packCode: string;
  stripeEnvironment: StripeEnvironment;
}): Promise<PartnerCreditCheckoutOperation | null> {
  const { rows } = await partnerAdminQuery<CheckoutOperationRow>(
    `SELECT checkout_operation_key, stripe_session_id, checkout_url, checkout_expires_at,
            tenant_id, pack_code, initiating_user_id, stripe_price_id, stripe_currency,
            stripe_environment, credits, price_pence, tax_behavior, status
       FROM partner_credit_checkout_sessions
      WHERE tenant_id=$1
        AND initiating_user_id=$2
        AND pack_code=$3
        AND stripe_environment=$4
        AND status IN ('creating', 'created')
        AND checkout_expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.tenantId, input.initiatingUserId, input.packCode, input.stripeEnvironment]
  );
  return rows[0] ? checkoutOperationFromRow(rows[0]) : null;
}

/** Return a still-live operation before consulting mutable pack configuration. */
export async function findActivePartnerCreditCheckoutOperation(input: {
  tenantId: string;
  initiatingUserId: string;
  packCode: string;
  stripeEnvironment: StripeEnvironment;
}): Promise<PartnerCreditCheckoutOperation | null> {
  await expireElapsedCheckoutOperations(input);
  return loadActiveCheckoutOperation(input);
}

/**
 * Claim one outstanding Checkout operation before calling Stripe. A second Scanner/browser window
 * receives this same row and therefore uses the same Stripe idempotency key rather than creating a
 * second payable Session. The database partial unique index is the concurrency authority.
 */
export async function reservePartnerCreditCheckoutOperation(
  input: PartnerCreditCheckoutOperationInput
): Promise<PartnerCreditCheckoutOperation> {
  const existing = await findActivePartnerCreditCheckoutOperation(input);
  if (existing) return existing;

  const inserted = await partnerAdminQuery<CheckoutOperationRow>(
    `INSERT INTO partner_credit_checkout_sessions
       (tenant_id, stripe_session_id, pack_code, initiating_user_id, stripe_price_id, stripe_currency,
        stripe_environment, checkout_operation_key, checkout_expires_at, credits, price_pence, tax_behavior,
        status)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,gen_random_uuid(),$7,$8,$9,$10,'creating')
     ON CONFLICT DO NOTHING
     RETURNING checkout_operation_key, stripe_session_id, checkout_url, checkout_expires_at,
               tenant_id, pack_code, initiating_user_id, stripe_price_id, stripe_currency,
               stripe_environment, credits, price_pence, tax_behavior, status`,
    [
      input.tenantId,
      input.packCode,
      input.initiatingUserId,
      input.stripePriceId,
      normalizeCurrency(input.stripeCurrency),
      input.stripeEnvironment,
      input.checkoutExpiresAt,
      input.credits,
      input.pricePence,
      input.taxBehavior,
    ]
  );
  if (inserted.rows[0]) return checkoutOperationFromRow(inserted.rows[0]);

  const concurrent = await loadActiveCheckoutOperation(input);
  if (concurrent) return concurrent;
  throw new CreditPurchaseError("CHECKOUT_INTENT_CONFLICT", "Could not reserve a Checkout operation.");
}

/** Publish the one Stripe Session returned for a previously claimed operation. */
export async function completePartnerCreditCheckoutOperation(input: {
  checkoutOperationKey: string;
  stripeSessionId: string;
  checkoutUrl: string;
  checkoutExpiresAt: Date;
}): Promise<PartnerCreditCheckoutOperation> {
  const updated = await partnerAdminQuery<CheckoutOperationRow>(
    `UPDATE partner_credit_checkout_sessions
        SET stripe_session_id=COALESCE(stripe_session_id, $2),
            checkout_url=$3,
            checkout_expires_at=CASE WHEN stripe_session_id IS NULL THEN $4 ELSE checkout_expires_at END,
            status='created',
            updated_at=now()
      WHERE checkout_operation_key=$1
        AND (
          (status='creating' AND stripe_session_id IS NULL)
          OR (status='created' AND stripe_session_id=$2 AND checkout_url IS NULL)
        )
      RETURNING checkout_operation_key, stripe_session_id, checkout_url, checkout_expires_at,
                tenant_id, pack_code, initiating_user_id, stripe_price_id, stripe_currency,
                stripe_environment, credits, price_pence, tax_behavior, status`,
    [input.checkoutOperationKey, input.stripeSessionId, input.checkoutUrl, input.checkoutExpiresAt]
  );
  if (updated.rows[0]) return checkoutOperationFromRow(updated.rows[0]);

  const { rows } = await partnerAdminQuery<CheckoutOperationRow>(
    `SELECT checkout_operation_key, stripe_session_id, checkout_url, checkout_expires_at,
            tenant_id, pack_code, initiating_user_id, stripe_price_id, stripe_currency,
            stripe_environment, credits, price_pence, tax_behavior, status
       FROM partner_credit_checkout_sessions
      WHERE checkout_operation_key=$1
      LIMIT 1`,
    [input.checkoutOperationKey]
  );
  const existing = rows[0];
  if (
    existing &&
    existing.status === "created" &&
    existing.stripe_session_id === input.stripeSessionId &&
    existing.checkout_url === input.checkoutUrl
  ) {
    return checkoutOperationFromRow(existing);
  }
  throw new CreditPurchaseError("CHECKOUT_INTENT_CONFLICT", "Checkout Session did not match its reserved operation.");
}

/** The Checkout Session fields the fulfilment path reads. Kept minimal on purpose. */
export interface PartnerCheckoutSession {
  id?: string;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
  /** Set only after the signed event's Checkout Session has been re-read from Stripe's API. */
  verifiedCheckout?: true;
  /** Stripe's actual account mode for the re-read Checkout Session. */
  livemode?: boolean | null;
  /** Stripe's Checkout Session currency, normalized by Stripe to lowercase ISO-4217. */
  currency?: string | null;
  /** Stripe's final charged total, in minor units. Must equal the canonical VAT-inclusive pack price. */
  amountTotal?: number | null;
  /** The server-observed Checkout line items, expanded from the re-read Stripe Session. */
  lineItems?: ReadonlyArray<{
    priceId?: string | null;
    currency?: string | null;
    unitAmount?: number | null;
    taxBehavior?: string | null;
  }>;
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

  // A browser redirect or the raw event payload is never enough. The webhook handler must
  // re-read this exact Checkout Session through Stripe's authenticated API and mark the constrained
  // record below as verified before the append-only ledger boundary is even reachable.
  if (!session.verifiedCheckout || !session.id) {
    return { granted: false, credits: 0, reason: "checkout_not_verified" };
  }

  // Preserve the explicit refusal for a non-canonical pack before provenance lookup. A local
  // operation can never legitimately exist for it, and metadata must not turn it into capacity.
  if (!canonicalCheckoutSnapshot(packCode)) {
    return { granted: false, credits: 0, reason: "pack_not_found" };
  }

  // Every condition below is permanent for this Checkout Session, so return a handled no-grant
  // rather than throwing and making Stripe retry a payment that cannot ever become attributable.
  // A transient database error still throws naturally, leaving the ledger untouched so a later
  // signed delivery can retry safely.
  const expectedEnvironment = declaredStripeEnvironment();
  if (expectedEnvironment === null) {
    return { granted: false, credits: 0, reason: "stripe_environment_undeclared" };
  }
  if (session.livemode !== (expectedEnvironment === "live")) {
    return { granted: false, credits: 0, reason: "checkout_environment_mismatch" };
  }

  return withPartnerAdminTransaction(async (client) => {
    const intent = await loadPartnerCreditCheckoutIntent(session.id!, client, true);
    if (!intent) {
      return { granted: false, credits: 0, reason: "checkout_intent_not_found" };
    }
    const canonical = canonicalCheckoutSnapshot(intent.packCode);
    if (!canonical) {
      return { granted: false, credits: 0, reason: "pack_not_found" };
    }
    const credits = intent.credits;
    const pricePence = intent.pricePence;
    const taxBehavior = intent.taxBehavior;
    if (
      typeof credits !== "number" ||
      !Number.isInteger(credits) ||
      credits <= 0 ||
      typeof pricePence !== "number" ||
      !Number.isInteger(pricePence) ||
      pricePence <= 0 ||
      taxBehavior !== "inclusive" ||
      canonical.credits !== credits ||
      canonical.pricePence !== pricePence
    ) {
      return { granted: false, credits: 0, reason: "checkout_intent_snapshot_invalid" };
    }
    if (intent.status === "granted") {
      return { granted: false, credits, reason: "already_granted" };
    }
    if (intent.tenantId !== tenantId) {
      return { granted: false, credits: 0, reason: "checkout_partner_mismatch" };
    }
    if (intent.packCode !== packCode) {
      return { granted: false, credits: 0, reason: "checkout_pack_mismatch" };
    }
    if (intent.stripeEnvironment !== expectedEnvironment) {
      return { granted: false, credits: 0, reason: "checkout_environment_mismatch" };
    }
    if (session.amountTotal !== pricePence) {
      return { granted: false, credits: 0, reason: "checkout_amount_mismatch" };
    }

    const lineItems = session.lineItems ?? [];
    if (lineItems.length !== 1) {
      return { granted: false, credits: 0, reason: "checkout_line_items_invalid" };
    }
    const lineItem = lineItems[0];
    const observedCurrency = lineItem.currency?.trim().toLowerCase();
    const checkoutCurrency = session.currency?.trim().toLowerCase();
    if (lineItem.priceId !== intent.stripePriceId) {
      return { granted: false, credits: 0, reason: "checkout_price_mismatch" };
    }
    if (
      !observedCurrency ||
      !checkoutCurrency ||
      observedCurrency !== intent.stripeCurrency ||
      checkoutCurrency !== intent.stripeCurrency
    ) {
      return { granted: false, credits: 0, reason: "checkout_currency_mismatch" };
    }
    if (lineItem.unitAmount !== pricePence) {
      return { granted: false, credits: 0, reason: "checkout_amount_mismatch" };
    }
    if (lineItem.taxBehavior !== taxBehavior) {
      return { granted: false, credits: 0, reason: "checkout_tax_behavior_mismatch" };
    }

    const { alreadyApplied } = await appendFoundationCreditWithClient(
      client,
      { actorUserId: null, actorEmail: null },
      {
        tenantId,
        amount: credits,
        entryType: "purchase",
        source: "stripe",
        reason: `Purchased Grading Credit pack ${packCode}.`,
        // THE exactly-once key for one Stripe Event delivery. The locked Checkout-intent row above
        // is the second authority: it prevents a second distinct event id for the same Checkout
        // Session from minting a second pack.
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

    /*
     * REPORT A REPLAY AS A REPLAY.
     *
     * Same-event replay is handled by the ledger idempotency key; same-session/different-event
     * replay is handled by the locked Checkout-intent state. Both return a handled no-grant so
     * Stripe does not retry forever, and both preserve `credits` as the value of the purchase.
     */
    await markPartnerCreditCheckoutGranted(session.id!, tenantId, stripeEventId, client);
    if (alreadyApplied) {
      return { granted: false, credits, reason: "already_granted" };
    }

    return { granted: true, credits };
  });
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
