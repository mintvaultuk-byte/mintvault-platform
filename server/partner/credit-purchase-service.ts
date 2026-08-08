/**
 * Partner grading-credit purchase — Stripe Checkout in, append-only ledger row out.
 *
 * This is the ONLY path by which a Partner can gain credits without a Super Admin adjustment, and
 * it is built so that the browser can influence exactly one thing: WHICH package is bought. Never
 * the price, never the quantity, never the tenant.
 *
 * ── Where the money truth lives ────────────────────────────────────────────────────────────────
 * The package is resolved from shared/partner-credit-packages.ts TWICE:
 *   1. at checkout creation, to set Stripe's `unit_amount`;
 *   2. again at fulfilment, to decide how many credits to append.
 * Fulfilment deliberately does NOT trust the `credits` value carried in the Stripe metadata. That
 * metadata is written by us and returned inside a signature-verified payload, so tampering is
 * already implausible — but re-deriving from the catalogue means the number of credits granted is a
 * pure function of the package id under every circumstance, including a future bug that lets some
 * other writer stamp metadata.
 *
 * ── Why fulfilment is idempotent without a webhook-events claim ────────────────────────────────
 * The estimate-credits flow claims `stripe_webhook_events` inside the same `db.transaction` as the
 * grant, which is correct there because both live on the main pool. It cannot be copied here:
 * `appendFoundationCredit` writes through `partnerAdminQuery`, a SEPARATE pg.Pool with separate
 * credentials, so a claim on the main pool would not be in the same transaction as the ledger
 * insert. Claiming first and then failing to append would mark the event permanently processed and
 * lose a credit the shop had already paid for — the worst available outcome.
 *
 * Instead the guarantee is the ledger's own DB-enforced dedupe:
 *   uq_partner_credit_ledger_idem UNIQUE (source, idempotency_key)
 * keyed on `stripe-evt:<event.id>`. That index is not tenant-scoped, which is exactly what we want:
 * one Stripe event can produce one ledger row across the entire estate, forever. A redelivered or
 * concurrently-delivered duplicate collides on the unique index, and appendFoundationCredit resolves
 * it to the original row and reports alreadyApplied — so a replay grants nothing and still returns
 * success to Stripe. A single INSERT with a unique constraint is atomic by construction; there is no
 * window between "claimed" and "granted" in which credits can be lost.
 */
import Stripe from "stripe";
import { getUncachableStripeClient } from "../stripeClient";
import {
  PARTNER_CREDIT_CURRENCY,
  findCreditPackage,
  stripeCreditLedgerIdempotencyKey,
  type PartnerCreditPackage,
} from "@shared/partner-credit-packages";
import { appendFoundationCredit, getWallet } from "./partner-wallet-service";
import type { PartnerPrincipal } from "./session";

/** Discriminates our sessions inside the shared webhook. Must match the branch in webhookHandlers. */
export const PARTNER_CREDITS_CHECKOUT_TYPE = "partner_credits";

export class PartnerCreditPurchaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface PartnerCreditCheckout {
  checkoutUrl: string;
  packageId: string;
  credits: number;
  pricePence: number;
}

/**
 * Create a Stripe Checkout Session for a credit package.
 *
 * `returnPath` lets the portal send the shop back to where it started — specifically to a
 * half-built submission that ran short of credits — so the draft, its customer, its cards and its
 * uploaded images are never lost to a top-up. It is validated as a same-site absolute path so it
 * cannot be turned into an open redirect.
 */
export async function createPartnerCreditCheckout(
  principal: PartnerPrincipal,
  packageId: unknown,
  opts: { origin: string; returnPath?: unknown }
): Promise<PartnerCreditCheckout> {
  const pkg = findCreditPackage(packageId);
  if (!pkg) {
    // No fallback package, ever. An unknown or forged id is refused outright.
    throw new PartnerCreditPurchaseError(400, "unknown_package", "That credit package is not available.");
  }

  // A payment must never succeed against a wallet that cannot receive the credits — otherwise we
  // take the money and appendFoundationCredit throws at fulfilment. Check before charging.
  const wallet = await getWallet(principal.tenantId);
  if (wallet.status !== "active") {
    throw new PartnerCreditPurchaseError(
      409,
      "wallet_not_active",
      "This shop's credit wallet is not active. Contact MintVault support."
    );
  }

  const returnPath = safeReturnPath(opts.returnPath);
  const stripe = await getUncachableStripeClient();
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: PARTNER_CREDIT_CURRENCY,
          product_data: {
            name: `MintVault Partner grading credits — ${pkg.label}`,
            description: `${pkg.credits} prepaid grading credits for your MintVault Partner shop`,
          },
          // Server-derived. The browser never sends an amount.
          unit_amount: pkg.pricePence,
        },
        quantity: 1,
      },
    ],
    // Everything here is stamped from the AUTHENTICATED SESSION, never from the request body.
    // tenant_id in particular is the shop we will credit, so accepting it from a client would be a
    // straightforward "pay for my own shop, credit someone else's" — or the reverse.
    metadata: {
      type: PARTNER_CREDITS_CHECKOUT_TYPE,
      tenant_id: principal.tenantId,
      partner_user_id: principal.userId,
      package_id: pkg.id,
      // Recorded for reconciliation only. Fulfilment re-derives from package_id and ignores this.
      credits: String(pkg.credits),
    },
    success_url: `${opts.origin}${returnPath}?credit_purchase=success`,
    cancel_url: `${opts.origin}${returnPath}?credit_purchase=cancelled`,
  });

  if (!session.url) {
    throw new PartnerCreditPurchaseError(502, "checkout_unavailable", "Could not start checkout. Try again.");
  }
  return { checkoutUrl: session.url, packageId: pkg.id, credits: pkg.credits, pricePence: pkg.pricePence };
}

/**
 * Only a same-site absolute path is allowed back from Stripe.
 *
 * Rejects anything protocol-relative ("//evil.com") or absolute-URL shaped, both of which would
 * otherwise make success_url an open redirect carrying a MintVault-branded payment journey.
 */
function safeReturnPath(raw: unknown): string {
  const fallback = "/partner/billing";
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\") || raw.includes("://")) return fallback;
  return raw;
}

export interface PartnerCreditFulfilmentResult {
  granted: boolean;
  reason?: string;
  credits?: number;
}

/**
 * Fulfil a paid partner-credits Checkout Session. Called from the shared Stripe webhook, i.e. only
 * ever after Stripe's signature has been verified against the raw body.
 *
 * Returns rather than throws for PERMANENT conditions (not paid, malformed, duplicate) so Stripe
 * receives a 2xx and stops retrying something a retry cannot fix. Genuine transient faults are left
 * to throw, so the webhook returns non-2xx and Stripe retries.
 */
export async function fulfilPartnerCreditPurchase(
  eventId: string,
  session: Pick<Stripe.Checkout.Session, "id" | "metadata" | "payment_status" | "payment_intent">
): Promise<PartnerCreditFulfilmentResult> {
  const meta = session.metadata || {};

  // checkout.session.completed also fires for delayed/async payment methods before funds settle.
  // Fail closed on anything that is not explicitly paid.
  if (session.payment_status && session.payment_status !== "paid") {
    console.log(`[webhook] partner_credits session ${session.id} payment_status=${session.payment_status} — not fulfilling`);
    return { granted: false, reason: "not_paid" };
  }

  const tenantId = (meta.tenant_id || "").trim();
  const pkg: PartnerCreditPackage | undefined = findCreditPackage(meta.package_id);
  if (!tenantId || !pkg) {
    // Permanent: nothing safe to grant. Loud, because it means a session was created with metadata
    // we did not write, or a package was retired between checkout and payment.
    console.error(
      `[webhook] partner_credits malformed metadata event=${eventId} session=${session.id} tenant=${tenantId || "?"} package=${meta.package_id || "?"} — skipping`
    );
    return { granted: false, reason: "malformed_metadata" };
  }

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;

  // The append is the idempotency point — see the file header. Keyed on the Stripe EVENT id, so a
  // redelivery collapses onto the original row rather than minting a second grant.
  const { entry, alreadyApplied } = await appendFoundationCredit(
    { actorUserId: null, actorEmail: null },
    {
      tenantId,
      // Re-derived from the catalogue, NOT read from metadata.credits.
      amount: pkg.credits,
      entryType: "purchase",
      source: "stripe",
      actorType: "service",
      reason: `Stripe credit package purchase (${pkg.label})`,
      idempotencyKey: stripeCreditLedgerIdempotencyKey(eventId),
      correlationId: session.id,
      externalRef: paymentIntentId ?? session.id,
      metadata: {
        package_id: pkg.id,
        credits: pkg.credits,
        amount_paid_pence: pkg.pricePence,
        currency: PARTNER_CREDIT_CURRENCY,
        stripe_session_id: session.id,
        stripe_payment_intent: paymentIntentId,
        stripe_event_id: eventId,
      },
    }
  );

  if (alreadyApplied) {
    console.log(`[webhook] partner_credits event ${eventId} already applied (ledger ${entry.id}) — no second grant`);
    return { granted: false, reason: "duplicate_event", credits: pkg.credits };
  }
  console.log(`[webhook] partner_credits: +${pkg.credits} credits to tenant ${tenantId} (event ${eventId})`);
  return { granted: true, credits: pkg.credits };
}
