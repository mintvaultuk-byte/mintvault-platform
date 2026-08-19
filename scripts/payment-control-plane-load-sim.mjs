#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function numericArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number(found.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const WORKFLOWS = numericArg("workflows", 5_000);
const BURST_EVENTS = numericArg("burst", 20_000);
const SEED = numericArg("seed", 190_826);
const MAX_WORKFLOWS = 25_000;
const MAX_BURST = 100_000;

if (!Number.isInteger(WORKFLOWS) || WORKFLOWS <= 0 || WORKFLOWS > MAX_WORKFLOWS) {
  throw new Error(`--workflows must be an integer from 1 to ${MAX_WORKFLOWS}`);
}
if (!Number.isInteger(BURST_EVENTS) || BURST_EVENTS < 0 || BURST_EVENTS > MAX_BURST) {
  throw new Error(`--burst must be an integer from 0 to ${MAX_BURST}`);
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
const int = (max) => Math.floor(rand() * max);
const pick = (items) => items[int(items.length)];

const PACKS = [
  { code: "PACK_5", credits: 5, priceId: "price_test_pack_5", currency: "gbp", env: "test", active: true },
  { code: "PACK_10", credits: 10, priceId: "price_test_pack_10", currency: "gbp", env: "test", active: true },
  { code: "PACK_25", credits: 25, priceId: "price_test_pack_25", currency: "gbp", env: "test", active: true },
  { code: "PACK_50", credits: 50, priceId: "price_test_pack_50", currency: "gbp", env: "test", active: true },
  { code: "PACK_100", credits: 100, priceId: "price_test_pack_100", currency: "gbp", env: "test", active: true },
];

class PaymentControlPlaneSimulation {
  constructor(workflows, burstEvents) {
    this.workflows = workflows;
    this.burstEvents = burstEvents;
    this.wallets = new Map();
    this.checkoutIntents = new Map();
    this.ledgerEventIds = new Set();
    this.reservations = new Set();
    this.cardJobs = new Map();
    this.modalClosedTenants = new Set();
    this.newEnabledTenants = new Set();
    this.events = [];
    this.failures = [];
    this.stats = {
      zeroCreditRejected: 0,
      checkoutCreated: 0,
      webhookGranted: 0,
      duplicateWebhookRejected: 0,
      wrongSignatureRejected: 0,
      wrongPriceRejected: 0,
      wrongCurrencyRejected: 0,
      wrongEnvironmentRejected: 0,
      unpaidRejected: 0,
      disabledPackRejected: 0,
      missingIntentRejected: 0,
      wrongPartnerRejected: 0,
      stripeApiTransientFailures: 0,
      dbTransientFailures: 0,
      retriesConverged: 0,
      sameSessionReplayRejected: 0,
      walletRefreshes: 0,
      modalAutoClosed: 0,
      newCardEnabled: 0,
      reservations: 0,
      insufficientAfterSpend: 0,
      burstEvents: 0,
    };
  }

  fail(message) {
    this.failures.push(message);
  }

  wallet(tenantId) {
    if (!this.wallets.has(tenantId)) this.wallets.set(tenantId, { ledger: 0, reserved: 0 });
    return this.wallets.get(tenantId);
  }

  available(tenantId) {
    const wallet = this.wallet(tenantId);
    return wallet.ledger - wallet.reserved;
  }

  schedule(at, type, payload) {
    this.events.push({ at, type, payload });
  }

  createCheckout(tenantId, pack, sessionId) {
    if (this.available(tenantId) !== 0) this.fail(`checkout started for non-zero wallet ${tenantId}`);
    this.checkoutIntents.set(sessionId, {
      tenantId,
      packCode: pack.code,
      priceId: pack.priceId,
      currency: pack.currency,
      env: pack.env,
      status: "created",
    });
    this.stats.checkoutCreated += 1;
  }

  deliverWebhook(event) {
    const { sessionId, eventId, signed, paid, priceId, currency, env, tenantId, packCode, disabled, transient } =
      event.payload;
    if (!signed) {
      this.stats.wrongSignatureRejected += 1;
      return;
    }
    if (transient === "stripe_api") {
      this.stats.stripeApiTransientFailures += 1;
      this.schedule(event.at + 10, "webhook", { ...event.payload, transient: null });
      return;
    }
    const intent = this.checkoutIntents.get(sessionId);
    if (!intent) {
      this.stats.missingIntentRejected += 1;
      return;
    }
    const pack = PACKS.find((candidate) => candidate.code === packCode);
    if (!pack || disabled) {
      this.stats.disabledPackRejected += 1;
      return;
    }
    if (!paid) {
      this.stats.unpaidRejected += 1;
      return;
    }
    if (tenantId !== intent.tenantId) {
      this.stats.wrongPartnerRejected += 1;
      return;
    }
    if (priceId !== intent.priceId || priceId !== pack.priceId) {
      this.stats.wrongPriceRejected += 1;
      return;
    }
    if (currency !== intent.currency || currency !== pack.currency) {
      this.stats.wrongCurrencyRejected += 1;
      return;
    }
    if (env !== intent.env || env !== pack.env) {
      this.stats.wrongEnvironmentRejected += 1;
      return;
    }
    if (intent.status === "granted") {
      this.stats.sameSessionReplayRejected += 1;
      this.stats.duplicateWebhookRejected += 1;
      return;
    }
    if (this.ledgerEventIds.has(eventId)) {
      this.stats.duplicateWebhookRejected += 1;
      return;
    }
    if (transient === "db") {
      this.stats.dbTransientFailures += 1;
      this.schedule(event.at + 10, "webhook", { ...event.payload, transient: null });
      return;
    }
    const wallet = this.wallet(tenantId);
    wallet.ledger += pack.credits;
    this.ledgerEventIds.add(eventId);
    intent.status = "granted";
    this.stats.webhookGranted += 1;
    if (this.available(tenantId) <= 0) this.fail(`grant did not make wallet available for ${tenantId}`);
  }

  refreshWallet(tenantId) {
    this.stats.walletRefreshes += 1;
    if (this.available(tenantId) > 0) {
      if (!this.modalClosedTenants.has(tenantId)) {
        this.modalClosedTenants.add(tenantId);
        this.stats.modalAutoClosed += 1;
      }
      if (!this.newEnabledTenants.has(tenantId)) {
        this.newEnabledTenants.add(tenantId);
        this.stats.newCardEnabled += 1;
      }
    }
  }

  pressNew(tenantId, cardIndex) {
    const wallet = this.wallet(tenantId);
    if (this.available(tenantId) < 1) {
      this.stats.zeroCreditRejected += 1;
      return false;
    }
    const reservationId = `reservation-${tenantId}-${cardIndex}`;
    const mvNumber = `MV${String(800000 + cardIndex).padStart(6, "0")}`;
    if (this.reservations.has(reservationId)) this.fail(`duplicate reservation ${reservationId}`);
    if ([...this.cardJobs.values()].some((job) => job.mvNumber === mvNumber)) this.fail(`duplicate MV ${mvNumber}`);
    wallet.reserved += 1;
    this.reservations.add(reservationId);
    this.cardJobs.set(`job-${tenantId}-${cardIndex}`, { tenantId, reservationId, mvNumber });
    this.stats.reservations += 1;
    return true;
  }

  setup() {
    for (let i = 0; i < this.workflows; i += 1) {
      const tenantId = `tenant-${String(i).padStart(6, "0")}`;
      const pack = pick(PACKS);
      const sessionId = `cs_test_${String(i).padStart(6, "0")}`;
      const eventId = `evt_test_${String(i).padStart(6, "0")}`;

      this.pressNew(tenantId, i);
      this.createCheckout(tenantId, pack, sessionId);

      const transient = i % 97 === 0 ? "stripe_api" : i % 131 === 0 ? "db" : null;
      this.schedule(10 + int(1_000), "webhook", {
        sessionId,
        eventId,
        signed: true,
        paid: true,
        priceId: pack.priceId,
        currency: pack.currency,
        env: pack.env,
        tenantId,
        packCode: pack.code,
        disabled: false,
        transient,
      });
      this.schedule(11 + int(1_000), "webhook", {
        sessionId,
        eventId,
        signed: true,
        paid: true,
        priceId: pack.priceId,
        currency: pack.currency,
        env: pack.env,
        tenantId,
        packCode: pack.code,
        disabled: false,
        transient: null,
      });
      this.schedule(12 + int(1_000), "webhook", {
        sessionId,
        eventId: `${eventId}_wrong_sig`,
        signed: false,
        paid: true,
        priceId: pack.priceId,
        currency: pack.currency,
        env: pack.env,
        tenantId,
        packCode: pack.code,
      });
      if (i % 5 === 0) this.schedule(20 + int(1_000), "webhook", { sessionId, eventId: `${eventId}_price`, signed: true, paid: true, priceId: "price_test_other", currency: pack.currency, env: pack.env, tenantId, packCode: pack.code });
      if (i % 7 === 0) this.schedule(21 + int(1_000), "webhook", { sessionId, eventId: `${eventId}_currency`, signed: true, paid: true, priceId: pack.priceId, currency: "usd", env: pack.env, tenantId, packCode: pack.code });
      if (i % 11 === 0) this.schedule(22 + int(1_000), "webhook", { sessionId, eventId: `${eventId}_env`, signed: true, paid: true, priceId: pack.priceId, currency: pack.currency, env: "live", tenantId, packCode: pack.code });
      if (i % 13 === 0) this.schedule(23 + int(1_000), "webhook", { sessionId, eventId: `${eventId}_unpaid`, signed: true, paid: false, priceId: pack.priceId, currency: pack.currency, env: pack.env, tenantId, packCode: pack.code });
      if (i % 17 === 0) this.schedule(24 + int(1_000), "webhook", { sessionId, eventId: `${eventId}_disabled`, signed: true, paid: true, priceId: pack.priceId, currency: pack.currency, env: pack.env, tenantId, packCode: pack.code, disabled: true });
      if (i % 19 === 0) this.schedule(25 + int(1_000), "webhook", { sessionId: `${sessionId}_missing`, eventId: `${eventId}_missing`, signed: true, paid: true, priceId: pack.priceId, currency: pack.currency, env: pack.env, tenantId, packCode: pack.code });
      if (i % 23 === 0) this.schedule(26 + int(1_000), "webhook", { sessionId, eventId: `${eventId}_wrong_partner`, signed: true, paid: true, priceId: pack.priceId, currency: pack.currency, env: pack.env, tenantId: `${tenantId}_other`, packCode: pack.code });
      this.schedule(1_050 + int(25), "webhook", { sessionId, eventId: `${eventId}_same_session_new_event`, signed: true, paid: true, priceId: pack.priceId, currency: pack.currency, env: pack.env, tenantId, packCode: pack.code });

      this.schedule(1_100 + int(1_000), "refresh", { tenantId });
      this.schedule(1_200 + int(1_000), "new", { tenantId, cardIndex: i });
    }

    for (let i = 0; i < this.burstEvents; i += 1) {
      const workflow = int(this.workflows);
      const tenantId = `tenant-${String(workflow).padStart(6, "0")}`;
      this.schedule(1_500 + int(500), "refresh", { tenantId, burst: true });
    }
  }

  run() {
    this.setup();
    this.events.sort((a, b) => a.at - b.at);
    for (const event of this.events) {
      if (event.type === "webhook") this.deliverWebhook(event);
      if (event.type === "refresh") {
        if (event.payload.burst) this.stats.burstEvents += 1;
        this.refreshWallet(event.payload.tenantId);
      }
      if (event.type === "new") {
        const started = this.pressNew(event.payload.tenantId, event.payload.cardIndex);
        if (!started) this.stats.insufficientAfterSpend += 1;
      }
    }
    for (const [tenantId, wallet] of this.wallets.entries()) {
      if (wallet.ledger < 0 || wallet.reserved < 0 || this.available(tenantId) < 0) {
        this.fail(`negative wallet projection for ${tenantId}`);
      }
    }
    const expectedGrants = this.workflows;
    if (this.stats.webhookGranted !== expectedGrants) {
      this.fail(`expected ${expectedGrants} grants, got ${this.stats.webhookGranted}`);
    }
    if (this.stats.reservations !== this.workflows) {
      this.fail(`expected one reservation per workflow, got ${this.stats.reservations}`);
    }
    if (this.stats.modalAutoClosed !== this.workflows) {
      this.fail(`expected modal auto-close per workflow, got ${this.stats.modalAutoClosed}`);
    }
    if (this.stats.newCardEnabled !== this.workflows) {
      this.fail(`expected NEW enable per workflow, got ${this.stats.newCardEnabled}`);
    }
    if (this.stats.sameSessionReplayRejected < this.workflows) {
      this.fail(`expected at least ${this.workflows} same-session replay rejections, got ${this.stats.sameSessionReplayRejected}`);
    }
    this.stats.retriesConverged = this.stats.stripeApiTransientFailures + this.stats.dbTransientFailures;
    return {
      ok: this.failures.length === 0,
      workflows: this.workflows,
      burstEvents: this.burstEvents,
      seed: SEED,
      stats: this.stats,
      failures: this.failures.slice(0, 20),
    };
  }
}

const report = new PaymentControlPlaneSimulation(WORKFLOWS, BURST_EVENTS).run();
const outDir = path.join(process.cwd(), "dist", "payment-control-plane");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `payment-control-plane-${WORKFLOWS}-${BURST_EVENTS}-${SEED}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
if (!report.ok) process.exit(1);
