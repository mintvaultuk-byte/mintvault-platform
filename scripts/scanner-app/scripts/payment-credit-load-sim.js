#!/usr/bin/env node
"use strict";

/*
 * Owner-independent payment/top-up load simulator.
 *
 * This deliberately does not call Stripe and does not mutate a database. The real grant boundary is
 * proven in Vitest against PostgreSQL; this simulator pounds the workflow invariants at 5k/10k/20k
 * scale: zero-credit scanner lock, server-created Checkout intent, verified paid webhook, canonical
 * Price/currency/environment checks, duplicate/replayed events, incomplete/unverified/wrong sessions
 * and a retryable transaction failure.
 */
const fs = require("node:fs");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(APP_ROOT, "dist");

function numericArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  if (!match) return fallback;
  const parsed = Number(match.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const WORKFLOWS = numericArg("workflows", 10_000);
const BURST_EVENTS = numericArg("burst", 20_000);
const SEED = numericArg("seed", 250_819);
const ZERO_CREDIT_ATTEMPTS = numericArg("zero-credit-attempts", 1_000);
const MAX_WORKFLOWS = 25_000;
const MAX_BURST_EVENTS = 150_000;

if (!Number.isInteger(WORKFLOWS) || WORKFLOWS <= 0 || WORKFLOWS > MAX_WORKFLOWS) {
  throw new Error(`--workflows must be an integer from 1 to ${MAX_WORKFLOWS}`);
}
if (!Number.isInteger(BURST_EVENTS) || BURST_EVENTS < 0 || BURST_EVENTS > MAX_BURST_EVENTS) {
  throw new Error(`--burst must be an integer from 0 to ${MAX_BURST_EVENTS}`);
}
if (!Number.isInteger(ZERO_CREDIT_ATTEMPTS) || ZERO_CREDIT_ATTEMPTS < 0) {
  throw new Error("--zero-credit-attempts must be a non-negative integer");
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const pick = (items) => items[Math.floor(rand() * items.length)];
const int = (max) => Math.floor(rand() * max);

const DECLARED_STRIPE_ENV = "test";
const PACKS = [
  {
    code: "PACK_5",
    credits: 5,
    amountPence: 5_000,
    stripePriceId: "price_test_pack_5",
    stripeCurrency: "gbp",
    active: true,
  },
  {
    code: "PACK_10",
    credits: 10,
    amountPence: 10_000,
    stripePriceId: "price_test_pack_10",
    stripeCurrency: "gbp",
    active: true,
  },
  {
    code: "PACK_25",
    credits: 25,
    amountPence: 25_000,
    stripePriceId: "price_test_pack_25",
    stripeCurrency: "gbp",
    active: true,
  },
  {
    code: "PACK_50",
    credits: 50,
    amountPence: 50_000,
    stripePriceId: "price_test_pack_50",
    stripeCurrency: "gbp",
    active: true,
  },
  {
    code: "PACK_100",
    credits: 100,
    amountPence: 100_000,
    stripePriceId: "price_test_pack_100",
    stripeCurrency: "gbp",
    active: true,
  },
];
const packByCode = new Map(PACKS.map((pack) => [pack.code, pack]));

class PaymentCreditLoadSimulation {
  constructor(workflows, burstEvents) {
    this.workflows = workflows;
    this.burstEvents = burstEvents;
    this.events = [];
    this.tenants = new Map();
    this.checkoutIntents = new Map();
    this.ledger = new Map();
    this.reservations = new Set();
    this.sessions = [];
    this.failures = [];
    this.stats = {
      checkoutIntents: 0,
      browserRedirectsIgnored: 0,
      paidWebhooksObserved: 0,
      canonicalGrants: 0,
      replayedEventsIgnored: 0,
      duplicateDeliveries: 0,
      incompleteRejected: 0,
      unverifiedRejected: 0,
      wrongPriceRejected: 0,
      wrongCurrencyRejected: 0,
      wrongAmountRejected: 0,
      wrongTaxBehaviorRejected: 0,
      wrongEnvironmentRejected: 0,
      wrongTenantRejected: 0,
      missingIntentRejected: 0,
      transactionFailures: 0,
      retryGrants: 0,
      zeroCreditRejected: 0,
      newBeforeTopupRejected: 0,
      newAfterTopupAccepted: 0,
      burstEvents: 0,
      eventsProcessed: 0,
      appendOnlyLedgerWrites: 0,
    };
  }

  fail(message) {
    this.failures.push(message);
  }

  schedule(at, type, payload) {
    this.events.push({ at, type, payload });
  }

  createTenant(index, initialCredits = 0) {
    const tenantId = `tenant-${String(index).padStart(5, "0")}`;
    this.tenants.set(tenantId, {
      ledgerTotal: initialCredits,
      available: initialCredits,
      reserved: 0,
      grants: 0,
      directWalletEdits: 0,
    });
    return tenantId;
  }

  startNewCard(tenantId, reservationId, phase) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      this.fail(`missing tenant ${tenantId}`);
      return false;
    }
    if (tenant.available <= 0) {
      if (phase === "before-topup") this.stats.newBeforeTopupRejected += 1;
      else this.stats.zeroCreditRejected += 1;
      return false;
    }
    if (this.reservations.has(reservationId)) {
      this.fail(`duplicate reservation ${reservationId}`);
      return false;
    }
    tenant.available -= 1;
    tenant.reserved += 1;
    this.reservations.add(reservationId);
    if (tenant.available < 0) this.fail(`negative wallet for ${tenantId}`);
    if (phase === "after-topup") this.stats.newAfterTopupAccepted += 1;
    return true;
  }

  createCheckoutIntent(tenantId, pack, sessionId) {
    const existing = this.checkoutIntents.get(sessionId);
    const intent = {
      sessionId,
      tenantId,
      packCode: pack.code,
      stripePriceId: pack.stripePriceId,
      stripeCurrency: pack.stripeCurrency,
      amountPence: pack.amountPence,
      stripeEnvironment: DECLARED_STRIPE_ENV,
      status: "created",
    };
    if (existing) {
      const same =
        existing.tenantId === intent.tenantId &&
        existing.packCode === intent.packCode &&
        existing.stripePriceId === intent.stripePriceId &&
        existing.stripeCurrency === intent.stripeCurrency &&
        existing.stripeEnvironment === intent.stripeEnvironment;
      if (!same) this.fail(`checkout intent conflict ${sessionId}`);
      return existing;
    }
    this.checkoutIntents.set(sessionId, intent);
    this.stats.checkoutIntents += 1;
    return intent;
  }

  browserRedirectGrantAttempt() {
    this.stats.browserRedirectsIgnored += 1;
    return { granted: false, reason: "browser_redirect_grants_nothing" };
  }

  appendLedgerCredit(tenantId, credits, source, idempotencyKey, sessionId) {
    if (source !== "stripe") {
      this.fail(`non-stripe ledger source ${source}`);
      return { alreadyApplied: false };
    }
    if (this.ledger.has(idempotencyKey)) return { alreadyApplied: true };
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      this.fail(`missing ledger tenant ${tenantId}`);
      return { alreadyApplied: false };
    }
    this.ledger.set(idempotencyKey, { tenantId, credits, source, idempotencyKey, sessionId });
    tenant.ledgerTotal += credits;
    tenant.available += credits;
    tenant.grants += 1;
    this.stats.appendOnlyLedgerWrites += 1;
    return { alreadyApplied: false };
  }

  fulfilWebhook(session, eventId, options = {}) {
    this.stats.paidWebhooksObserved += session.paymentStatus === "paid" ? 1 : 0;
    if (session.paymentStatus !== "paid") {
      this.stats.incompleteRejected += 1;
      return { granted: false, reason: "session_not_paid" };
    }
    if (!session.verifiedCheckout) {
      this.stats.unverifiedRejected += 1;
      return { granted: false, reason: "checkout_not_verified" };
    }
    const pack = packByCode.get(session.packCode);
    if (!pack || !pack.active) return { granted: false, reason: "pack_not_found_or_disabled" };
    if (session.livemode !== (DECLARED_STRIPE_ENV === "live")) {
      this.stats.wrongEnvironmentRejected += 1;
      return { granted: false, reason: "checkout_environment_mismatch" };
    }
    const intent = this.checkoutIntents.get(session.sessionId);
    if (!intent) {
      this.stats.missingIntentRejected += 1;
      return { granted: false, reason: "checkout_intent_not_found" };
    }
    if (intent.status === "granted") {
      this.stats.replayedEventsIgnored += 1;
      return { granted: false, credits: pack.credits, reason: "already_granted" };
    }
    if (intent.tenantId !== session.tenantId) {
      this.stats.wrongTenantRejected += 1;
      return { granted: false, reason: "checkout_partner_mismatch" };
    }
    if (
      intent.packCode !== session.packCode ||
      intent.stripePriceId !== pack.stripePriceId ||
      session.lineItemPriceId !== pack.stripePriceId
    ) {
      this.stats.wrongPriceRejected += 1;
      return { granted: false, reason: "checkout_price_mismatch" };
    }
    if (
      intent.stripeCurrency !== pack.stripeCurrency ||
      session.sessionCurrency !== pack.stripeCurrency ||
      session.lineItemCurrency !== pack.stripeCurrency
    ) {
      this.stats.wrongCurrencyRejected += 1;
      return { granted: false, reason: "checkout_currency_mismatch" };
    }
    if (
      intent.amountPence !== pack.amountPence ||
      session.amountTotal !== pack.amountPence ||
      session.lineItemAmount !== pack.amountPence
    ) {
      this.stats.wrongAmountRejected += 1;
      return { granted: false, reason: "checkout_amount_mismatch" };
    }
    if (session.taxBehavior === "exclusive") {
      this.stats.wrongTaxBehaviorRejected += 1;
      return { granted: false, reason: "checkout_tax_behavior_mismatch" };
    }
    if (options.transientTransactionFailure) {
      this.stats.transactionFailures += 1;
      throw new Error("simulated transaction failure before ledger append");
    }
    const { alreadyApplied } = this.appendLedgerCredit(
      session.tenantId,
      pack.credits,
      "stripe",
      eventId,
      session.sessionId
    );
    if (alreadyApplied) {
      this.stats.replayedEventsIgnored += 1;
      return { granted: false, credits: pack.credits, reason: "already_granted" };
    }
    intent.status = "granted";
    this.stats.canonicalGrants += 1;
    return { granted: true, credits: pack.credits };
  }

  canonicalSession(tenantId, pack, sessionId) {
    return {
      sessionId,
      tenantId,
      packCode: pack.code,
      paymentStatus: "paid",
      verifiedCheckout: true,
      livemode: false,
      sessionCurrency: "gbp",
      amountTotal: pack.amountPence,
      lineItemPriceId: pack.stripePriceId,
      lineItemCurrency: "gbp",
      lineItemAmount: pack.amountPence,
      taxBehavior: "inclusive",
    };
  }

  setup() {
    for (let i = 0; i < ZERO_CREDIT_ATTEMPTS; i += 1) {
      const tenantId = this.createTenant(this.workflows + i, 0);
      const accepted = this.startNewCard(tenantId, `zero-reservation-${i}`, "zero-only");
      if (accepted) this.fail(`zero-credit tenant ${tenantId} started without a top-up`);
    }

    for (let i = 0; i < this.workflows; i += 1) {
      const tenantId = this.createTenant(i, 0);
      const beforeTopupAccepted = this.startNewCard(tenantId, `before-topup-${i}`, "before-topup");
      if (beforeTopupAccepted) this.fail(`tenant ${tenantId} started before verified top-up`);

      const pack = PACKS[i % PACKS.length];
      const sessionId = `cs_test_${String(i).padStart(6, "0")}`;
      const eventId = `evt_test_${String(i).padStart(6, "0")}`;
      this.createCheckoutIntent(tenantId, pack, sessionId);
      const session = this.canonicalSession(tenantId, pack, sessionId);
      this.sessions.push({ session, eventId, pack });
      this.schedule(i % 997, "browser_redirect", { session });

      if (i % 13 === 0) {
        this.schedule(i % 991, "attack_webhook", {
          session: { ...session, sessionId: `${sessionId}_wrong_price`, lineItemPriceId: "price_test_pack_999" },
          eventId: `${eventId}_wrong_price`,
          reason: "wrong_price",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_wrong_price`);
      }
      if (i % 17 === 0) {
        this.schedule(i % 983, "attack_webhook", {
          session: {
            ...session,
            sessionId: `${sessionId}_wrong_currency`,
            sessionCurrency: "usd",
            lineItemCurrency: "usd",
          },
          eventId: `${eventId}_wrong_currency`,
          reason: "wrong_currency",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_wrong_currency`);
      }
      if (i % 41 === 0) {
        this.schedule(i % 979, "attack_webhook", {
          session: { ...session, sessionId: `${sessionId}_wrong_amount`, amountTotal: pack.amountPence - 1000 },
          eventId: `${eventId}_wrong_amount`,
          reason: "wrong_amount",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_wrong_amount`);
      }
      if (i % 43 === 0) {
        this.schedule(i % 977, "attack_webhook", {
          session: { ...session, sessionId: `${sessionId}_wrong_tax`, taxBehavior: "exclusive" },
          eventId: `${eventId}_wrong_tax`,
          reason: "wrong_tax",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_wrong_tax`);
      }
      if (i % 19 === 0) {
        this.schedule(i % 971, "attack_webhook", {
          session: { ...session, sessionId: `${sessionId}_wrong_environment`, livemode: true },
          eventId: `${eventId}_wrong_environment`,
          reason: "wrong_environment",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_wrong_environment`);
      }
      if (i % 23 === 0) {
        this.schedule(i % 971, "attack_webhook", {
          session: { ...session, sessionId: `${sessionId}_unverified`, verifiedCheckout: false },
          eventId: `${eventId}_unverified`,
          reason: "unverified",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_unverified`);
      }
      if (i % 29 === 0) {
        this.schedule(i % 967, "attack_webhook", {
          session: { ...session, sessionId: `${sessionId}_incomplete`, paymentStatus: "unpaid" },
          eventId: `${eventId}_incomplete`,
          reason: "incomplete",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_incomplete`);
      }
      if (i % 37 === 0) {
        this.schedule(i % 961, "attack_webhook", {
          session: { ...session, sessionId: `${sessionId}_wrong_tenant`, tenantId: `${tenantId}_other` },
          eventId: `${eventId}_wrong_tenant`,
          reason: "wrong_tenant",
        });
        this.createCheckoutIntent(tenantId, pack, `${sessionId}_wrong_tenant`);
      }
      if (i % 31 === 0) {
        this.schedule((i % 953) + 1, "canonical_webhook_transient_failure", { session, eventId });
        this.schedule((i % 953) + 2, "canonical_webhook_retry", { session, eventId });
      } else {
        this.schedule((i % 953) + 2, "canonical_webhook", { session, eventId });
      }
      this.schedule((i % 953) + 3, "canonical_webhook_duplicate", { session, eventId });
      this.schedule((i % 953) + 4, "new_after_topup", { tenantId, reservationId: `after-topup-${i}` });
      this.schedule(1_000 + (i % 97), "canonical_webhook_same_session_new_event", {
        session,
        eventId: `${eventId}_same_session_new_event`,
      });
    }

    for (let i = 0; i < this.burstEvents; i += 1) {
      const target = this.sessions[int(this.sessions.length)];
      const mode = int(7);
      if (mode === 0) {
        this.schedule(1_200 + (i % 101), "burst_missing_intent", {
          session: { ...target.session, sessionId: `cs_missing_${i}` },
          eventId: `evt_missing_${i}`,
        });
      } else if (mode === 1) {
        let other = this.sessions[int(this.sessions.length)];
        if (other.session.tenantId === target.session.tenantId && this.sessions.length > 1) {
          const targetIndex = Number(target.session.sessionId.match(/(\d+)$/)?.[1] || 0);
          other = this.sessions[(targetIndex + 1) % this.sessions.length];
        }
        this.schedule(1_200 + (i % 101), "burst_wrong_tenant", {
          session: { ...target.session, tenantId: other.session.tenantId },
          eventId: `evt_wrong_tenant_${i}`,
        });
      } else {
        this.schedule(1_200 + (i % 101), "burst_duplicate", {
          session: target.session,
          eventId: target.eventId,
        });
      }
    }
  }

  handle(event) {
    this.stats.eventsProcessed += 1;
    try {
      if (event.type === "browser_redirect") {
        this.browserRedirectGrantAttempt(event.payload.session);
        return;
      }
      if (event.type === "attack_webhook") {
        this.fulfilWebhook(event.payload.session, event.payload.eventId);
        return;
      }
      if (event.type === "canonical_webhook") {
        const result = this.fulfilWebhook(event.payload.session, event.payload.eventId);
        if (!result.granted) this.fail(`canonical webhook did not grant ${event.payload.eventId}`);
        return;
      }
      if (event.type === "canonical_webhook_transient_failure") {
        try {
          this.fulfilWebhook(event.payload.session, event.payload.eventId, { transientTransactionFailure: true });
          this.fail(`transient failure unexpectedly committed ${event.payload.eventId}`);
        } catch (_err) {
          if (this.ledger.has(event.payload.eventId)) {
            this.fail(`failed transaction left a ledger row ${event.payload.eventId}`);
          }
        }
        return;
      }
      if (event.type === "canonical_webhook_retry") {
        const result = this.fulfilWebhook(event.payload.session, event.payload.eventId);
        if (!result.granted) this.fail(`retry did not grant ${event.payload.eventId}`);
        else this.stats.retryGrants += 1;
        return;
      }
      if (event.type === "canonical_webhook_duplicate") {
        const result = this.fulfilWebhook(event.payload.session, event.payload.eventId);
        this.stats.duplicateDeliveries += 1;
        if (result.granted) this.fail(`duplicate delivery granted ${event.payload.eventId}`);
        return;
      }
      if (event.type === "canonical_webhook_same_session_new_event") {
        const result = this.fulfilWebhook(event.payload.session, event.payload.eventId);
        this.stats.duplicateDeliveries += 1;
        if (result.granted) this.fail(`same Checkout Session granted twice ${event.payload.eventId}`);
        if (result.reason !== "already_granted") {
          this.fail(`same Checkout Session did not converge as already_granted ${event.payload.eventId}`);
        }
        return;
      }
      if (event.type === "new_after_topup") {
        const accepted = this.startNewCard(event.payload.tenantId, event.payload.reservationId, "after-topup");
        if (!accepted) this.fail(`verified top-up did not unlock NEW for ${event.payload.tenantId}`);
        return;
      }
      if (event.type === "burst_duplicate") {
        this.stats.burstEvents += 1;
        this.fulfilWebhook(event.payload.session, event.payload.eventId);
        return;
      }
      if (event.type === "burst_missing_intent") {
        this.stats.burstEvents += 1;
        this.fulfilWebhook(event.payload.session, event.payload.eventId);
        return;
      }
      if (event.type === "burst_wrong_tenant") {
        this.stats.burstEvents += 1;
        this.fulfilWebhook(event.payload.session, event.payload.eventId);
        return;
      }
      this.fail(`unknown event type ${event.type}`);
    } catch (err) {
      this.fail(`${event.type} raised ${(err && err.message) || err}`);
    }
  }

  verify() {
    if (this.checkoutIntents.size < this.workflows) this.fail("canonical Checkout intents missing");
    if (this.ledger.size !== this.workflows) {
      this.fail(`expected ${this.workflows} unique Stripe ledger rows, saw ${this.ledger.size}`);
    }
    if (this.stats.canonicalGrants !== this.workflows) {
      this.fail(`expected ${this.workflows} canonical grants, saw ${this.stats.canonicalGrants}`);
    }
    if (this.stats.newBeforeTopupRejected !== this.workflows) {
      this.fail(`expected every pre-top-up NEW to reject, saw ${this.stats.newBeforeTopupRejected}`);
    }
    if (this.stats.newAfterTopupAccepted !== this.workflows) {
      this.fail(`expected every verified top-up to unlock NEW, saw ${this.stats.newAfterTopupAccepted}`);
    }
    if (this.stats.zeroCreditRejected !== ZERO_CREDIT_ATTEMPTS) {
      this.fail(`expected ${ZERO_CREDIT_ATTEMPTS} pure zero-credit rejects, saw ${this.stats.zeroCreditRejected}`);
    }
    for (const [tenantId, tenant] of this.tenants.entries()) {
      if (tenant.available < 0) this.fail(`negative available credits for ${tenantId}`);
      if (tenant.directWalletEdits !== 0) this.fail(`direct wallet edit for ${tenantId}`);
      if (tenant.grants > 1) this.fail(`tenant ${tenantId} was granted more than once`);
    }
    if (this.stats.browserRedirectsIgnored !== this.workflows) this.fail("browser redirects were not all ignored");
    if (this.stats.replayedEventsIgnored < this.workflows) this.fail("duplicate/replayed events were not ignored");
    if (this.stats.wrongPriceRejected === 0) this.fail("wrong Price path was not exercised");
    if (this.stats.wrongCurrencyRejected === 0) this.fail("wrong currency path was not exercised");
    if (this.stats.wrongEnvironmentRejected === 0) this.fail("wrong environment path was not exercised");
    if (this.stats.incompleteRejected === 0) this.fail("incomplete payment path was not exercised");
    if (this.stats.unverifiedRejected === 0) this.fail("unverified Checkout path was not exercised");
    if (this.stats.missingIntentRejected === 0) this.fail("missing Checkout intent path was not exercised");
    if (this.stats.wrongTenantRejected === 0) this.fail("wrong tenant binding path was not exercised");
    if (this.stats.transactionFailures === 0 || this.stats.retryGrants === 0) {
      this.fail("retryable transaction failure path was not exercised");
    }
    if (this.stats.burstEvents !== this.burstEvents) {
      this.fail(`expected ${this.burstEvents} burst events, saw ${this.stats.burstEvents}`);
    }
  }

  run() {
    const startedAt = Date.now();
    this.setup();
    this.events.sort((a, b) => a.at - b.at || a.type.localeCompare(b.type));
    for (const event of this.events) this.handle(event);
    this.verify();
    const elapsedMs = Date.now() - startedAt;
    return {
      status: this.failures.length === 0 ? "PASS" : "FAIL",
      seed: SEED,
      workflowsRequested: this.workflows,
      workflowsCompleted: this.stats.newAfterTopupAccepted,
      burstEventsRequested: this.burstEvents,
      elapsedMs,
      ledgerRows: this.ledger.size,
      reservations: this.reservations.size,
      checkoutIntents: this.checkoutIntents.size,
      failures: this.failures.slice(0, 25),
      stats: this.stats,
      acceptance: {
        zeroBrowserRedirectGrant: this.stats.browserRedirectsIgnored === this.workflows,
        zeroUnverifiedGrant: this.stats.unverifiedRejected > 0,
        zeroWrongPriceGrant: this.stats.wrongPriceRejected > 0,
        zeroWrongCurrencyGrant: this.stats.wrongCurrencyRejected > 0,
        zeroWrongEnvironmentGrant: this.stats.wrongEnvironmentRejected > 0,
        zeroIncompletePaymentGrant: this.stats.incompleteRejected > 0,
        duplicateEventExactlyOnce: this.ledger.size === this.workflows && this.stats.replayedEventsIgnored > 0,
        transactionFailureRetryable: this.stats.transactionFailures > 0 && this.stats.retryGrants > 0,
        appendOnlyLedgerAuthority: this.stats.appendOnlyLedgerWrites === this.workflows,
        zeroCreditTopupUnlock:
          this.stats.newBeforeTopupRejected === this.workflows && this.stats.newAfterTopupAccepted === this.workflows,
        zeroNegativeWallet: [...this.tenants.values()].every((tenant) => tenant.available >= 0),
      },
    };
  }
}

const result = new PaymentCreditLoadSimulation(WORKFLOWS, BURST_EVENTS).run();
fs.mkdirSync(DIST_ROOT, { recursive: true });
const reportPath = path.join(DIST_ROOT, `payment-credit-load-sim-${WORKFLOWS}-workflows-${BURST_EVENTS}-burst.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });

console.log(`PAYMENT_CREDIT_LOAD_SIM ${result.status}`);
console.log(`workflows=${result.workflowsCompleted}/${result.workflowsRequested}`);
console.log(`burst_events=${result.stats.burstEvents}/${result.burstEventsRequested}`);
console.log(`ledger_rows=${result.ledgerRows}`);
console.log(`checkout_intents=${result.checkoutIntents}`);
console.log(`zero_credit_rejected=${result.stats.zeroCreditRejected}`);
console.log(`new_before_topup_rejected=${result.stats.newBeforeTopupRejected}`);
console.log(`new_after_topup_accepted=${result.stats.newAfterTopupAccepted}`);
console.log(`replayed_events_ignored=${result.stats.replayedEventsIgnored}`);
console.log(`transaction_failures=${result.stats.transactionFailures}`);
console.log(`retry_grants=${result.stats.retryGrants}`);
console.log(`report=${reportPath}`);

if (result.status !== "PASS") {
  for (const failure of result.failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
