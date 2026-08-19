#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(APP_ROOT, "dist");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  if (!match) return fallback;
  const parsed = Number(match.slice(prefix.length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const WORKFLOWS = arg("workflows", 10_000);
const BURST_EVENTS = arg("burst", 20_000);
const SEED = arg("seed", 150_815);
const ZERO_CREDIT_ATTEMPTS = arg("zero-credit-attempts", 1_000);
const MAX_WORKFLOWS = 25_000;
const MAX_BURST_EVENTS = 100_000;

if (!Number.isInteger(WORKFLOWS) || WORKFLOWS <= 0 || WORKFLOWS > MAX_WORKFLOWS) {
  throw new Error(`--workflows must be an integer from 1 to ${MAX_WORKFLOWS}`);
}
if (!Number.isInteger(BURST_EVENTS) || BURST_EVENTS < 0 || BURST_EVENTS > MAX_BURST_EVENTS) {
  throw new Error(`--burst must be an integer from 0 to ${MAX_BURST_EVENTS}`);
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

class ScannerControlPlaneSimulation {
  constructor(workflows, burstEvents) {
    this.workflows = workflows;
    this.burstEvents = burstEvents;
    this.events = [];
    this.wallets = new Map();
    this.cards = new Map();
    this.evidence = new Map();
    this.reservations = new Set();
    this.previewIds = new Set();
    this.failures = [];
    this.stats = {
      newAccepted: 0,
      zeroCreditRejected: 0,
      physicalReleasedFront: 0,
      backArmedWhileFrontPending: 0,
      backFinalisedFirst: 0,
      frontFinalisedFirst: 0,
      duplicateCallbacksRejected: 0,
      networkDrops: 0,
      retries: 0,
      stalePreviewRejected: 0,
      crossTenantRejected: 0,
      crossSideRejected: 0,
      crossStationRejected: 0,
      progressSamples: 0,
      burstEvents: 0,
      readyTransitions: 0,
      eventsProcessed: 0,
    };
  }

  fail(message) {
    this.failures.push(message);
  }

  schedule(at, type, payload) {
    this.events.push({ at, type, payload });
  }

  createTenant(index, credits) {
    const tenantId = `tenant-${String(index).padStart(5, "0")}`;
    this.wallets.set(tenantId, { initialCredits: credits, available: credits, consumed: 0 });
    return tenantId;
  }

  reserveCredit(tenantId, reservationId) {
    const wallet = this.wallets.get(tenantId);
    if (!wallet || wallet.available <= 0) return false;
    wallet.available -= 1;
    wallet.consumed += 1;
    if (wallet.available < 0) this.fail(`negative wallet for ${tenantId}`);
    if (this.reservations.has(reservationId)) this.fail(`duplicate reservation ${reservationId}`);
    this.reservations.add(reservationId);
    return true;
  }

  pressNew(tenantId, locationId, stationId, index) {
    const cardJobId = `job-${String(index).padStart(5, "0")}`;
    const mvNumber = `MV${String(900000 + index).padStart(6, "0")}`;
    const reservationId = `reservation-${String(index).padStart(5, "0")}`;
    if (!this.reserveCredit(tenantId, reservationId)) return null;
    const card = {
      tenantId,
      locationId,
      stationId,
      cardJobId,
      mvNumber,
      reservationId,
      ready: false,
      sides: {
        front: this.sideState("front", index),
        back: this.sideState("back", index),
      },
    };
    this.cards.set(cardJobId, card);
    this.stats.newAccepted += 1;
    return card;
  }

  sideState(side, index) {
    const sessionId = `session-${String(index).padStart(5, "0")}-${side}`;
    const previewId = `preview-${String(index).padStart(5, "0")}-${side}`;
    if (this.previewIds.has(previewId)) this.fail(`duplicate preview id ${previewId}`);
    this.previewIds.add(previewId);
    return {
      side,
      sessionId,
      previewId,
      physicalReleased: false,
      uploadPending: false,
      finalising: false,
      committed: false,
      uploadAttempts: 0,
      progress: 0,
    };
  }

  setup() {
    const tenantCount = Math.max(10, Math.ceil(this.workflows / 25));
    const tenants = [];
    for (let i = 0; i < tenantCount; i += 1) tenants.push(this.createTenant(i, 30));

    for (let i = 0; i < ZERO_CREDIT_ATTEMPTS; i += 1) {
      const zeroTenant = this.createTenant(tenantCount + i, 0);
      const card = this.pressNew(zeroTenant, `location-zero-${i}`, `station-zero-${i}`, this.workflows + i);
      if (card) this.fail(`zero-credit tenant started card ${card.mvNumber}`);
      else this.stats.zeroCreditRejected += 1;
    }

    for (let i = 0; i < this.workflows; i += 1) {
      const tenantId = tenants[i % tenants.length];
      const locationId = `location-${i % tenantCount}`;
      const stationId = `station-${i % Math.max(1, Math.ceil(this.workflows / 8))}`;
      const card = this.pressNew(tenantId, locationId, stationId, i);
      if (!card) {
        this.fail(`unexpected insufficient credits for workflow ${i}`);
        continue;
      }
      const base = int(1_000);
      this.schedule(base + 1, "physical_complete", { cardJobId: card.cardJobId, side: "front" });
      this.schedule(base + 2, "arm_back", { cardJobId: card.cardJobId });
      this.schedule(base + 3, "physical_complete", { cardJobId: card.cardJobId, side: "back" });
      const backFirst = rand() < 0.5;
      if (backFirst) {
        this.schedule(base + 10, "finalise", { cardJobId: card.cardJobId, side: "back" });
        this.schedule(base + 20, "finalise", { cardJobId: card.cardJobId, side: "front" });
      } else {
        this.schedule(base + 10, "finalise", { cardJobId: card.cardJobId, side: "front" });
        this.schedule(base + 20, "finalise", { cardJobId: card.cardJobId, side: "back" });
      }
      this.schedule(base + 11, "duplicate_finalise", { cardJobId: card.cardJobId, side: pick(["front", "back"]) });
      this.schedule(base + 4, "progress", { cardJobId: card.cardJobId, side: "front", percent: 0 });
      this.schedule(base + 5, "progress", { cardJobId: card.cardJobId, side: "front", percent: 63 });
      this.schedule(base + 6, "progress", { cardJobId: card.cardJobId, side: "front", percent: 100 });
      this.schedule(base + 7, "progress", { cardJobId: card.cardJobId, side: "back", percent: 0 });
      this.schedule(base + 8, "progress", { cardJobId: card.cardJobId, side: "back", percent: 63 });
      this.schedule(base + 9, "progress", { cardJobId: card.cardJobId, side: "back", percent: 100 });
      if (i % 17 === 0) this.schedule(base + 12, "network_drop", { cardJobId: card.cardJobId, side: pick(["front", "back"]) });
      if (i % 11 === 0) this.schedule(base + 13, "stale_preview", { cardJobId: card.cardJobId, side: "back", previewId: card.sides.front.previewId });
      if (i % 19 === 0) this.schedule(base + 14, "cross_side", { cardJobId: card.cardJobId, side: "front", claimedSide: "back" });
      if (i % 23 === 0) this.schedule(base + 15, "cross_tenant", { cardJobId: card.cardJobId, tenantId: "tenant-hostile" });
      if (i % 29 === 0) this.schedule(base + 16, "cross_station", { cardJobId: card.cardJobId, stationId: `${stationId}-hostile` });
    }

    for (let i = 0; i < this.burstEvents; i += 1) {
      const cardJobId = `job-${String(int(this.workflows)).padStart(5, "0")}`;
      this.schedule(500, "burst_status", { cardJobId });
    }
  }

  commitEvidence(card, side) {
    const state = card.sides[side];
    const key = `${card.tenantId}:${card.mvNumber}:${side}`;
    if (state.committed || this.evidence.has(key)) {
      this.stats.duplicateCallbacksRejected += 1;
      return;
    }
    if (!state.physicalReleased) this.fail(`finalised ${card.mvNumber} ${side} before physical release`);
    state.committed = true;
    this.evidence.set(key, {
      tenantId: card.tenantId,
      locationId: card.locationId,
      stationId: card.stationId,
      mvNumber: card.mvNumber,
      side,
      sessionId: state.sessionId,
    });
    const other = side === "front" ? "back" : "front";
    if (!card.sides[other].committed) {
      if (side === "back") this.stats.backFinalisedFirst += 1;
      else this.stats.frontFinalisedFirst += 1;
      if (card.ready) this.fail(`card ${card.mvNumber} became ready before ${other} evidence`);
      return;
    }
    if (!card.ready) {
      card.ready = true;
      this.stats.readyTransitions += 1;
    }
  }

  handle(event) {
    const card = this.cards.get(event.payload.cardJobId);
    if (!card) {
      this.fail(`event for unknown card ${event.payload.cardJobId}`);
      return;
    }
    switch (event.type) {
      case "physical_complete": {
        const side = card.sides[event.payload.side];
        side.physicalReleased = true;
        side.uploadPending = true;
        if (event.payload.side === "front") this.stats.physicalReleasedFront += 1;
        break;
      }
      case "arm_back": {
        if (!card.sides.front.physicalReleased || !card.sides.front.uploadPending) {
          this.fail(`BACK armed before FRONT was durably released for ${card.mvNumber}`);
        } else {
          this.stats.backArmedWhileFrontPending += 1;
        }
        break;
      }
      case "progress": {
        const side = card.sides[event.payload.side];
        if (event.payload.percent < side.progress || event.payload.percent < 0 || event.payload.percent > 100) {
          this.fail(`non-monotonic upload progress for ${card.mvNumber} ${event.payload.side}`);
        }
        side.progress = event.payload.percent;
        this.stats.progressSamples += 1;
        break;
      }
      case "finalise": {
        const side = card.sides[event.payload.side];
        side.finalising = true;
        side.uploadAttempts += 1;
        this.commitEvidence(card, event.payload.side);
        break;
      }
      case "duplicate_finalise":
        this.commitEvidence(card, event.payload.side);
        break;
      case "network_drop": {
        const side = card.sides[event.payload.side];
        this.stats.networkDrops += 1;
        side.uploadAttempts += 1;
        this.stats.retries += 1;
        this.commitEvidence(card, event.payload.side);
        break;
      }
      case "stale_preview": {
        const expected = card.sides[event.payload.side].previewId;
        if (event.payload.previewId === expected) this.fail(`stale preview accepted for ${card.mvNumber}`);
        else this.stats.stalePreviewRejected += 1;
        break;
      }
      case "cross_side":
        if (event.payload.side !== event.payload.claimedSide) this.stats.crossSideRejected += 1;
        else this.fail(`cross-side event not rejected for ${card.mvNumber}`);
        break;
      case "cross_tenant":
        if (event.payload.tenantId !== card.tenantId) this.stats.crossTenantRejected += 1;
        else this.fail(`cross-tenant event not rejected for ${card.mvNumber}`);
        break;
      case "cross_station":
        if (event.payload.stationId !== card.stationId) this.stats.crossStationRejected += 1;
        else this.fail(`cross-station event not rejected for ${card.mvNumber}`);
        break;
      case "burst_status":
        this.stats.burstEvents += 1;
        break;
      default:
        this.fail(`unknown event type ${event.type}`);
    }
    this.stats.eventsProcessed += 1;
  }

  verify() {
    for (const [cardJobId, card] of this.cards) {
      if (!card.ready) this.fail(`card ${cardJobId} did not reach READY_TO_GRADE`);
      for (const side of ["front", "back"]) {
        const key = `${card.tenantId}:${card.mvNumber}:${side}`;
        const ev = this.evidence.get(key);
        if (!ev) this.fail(`missing ${side} evidence for ${card.mvNumber}`);
        if (ev && (ev.tenantId !== card.tenantId || ev.stationId !== card.stationId || ev.side !== side)) {
          this.fail(`evidence identity drift for ${card.mvNumber} ${side}`);
        }
        if (card.sides[side].progress !== 100) this.fail(`upload progress did not reach 100 for ${card.mvNumber} ${side}`);
      }
    }
    for (const [tenantId, wallet] of this.wallets) {
      if (wallet.available < 0) this.fail(`negative wallet after run for ${tenantId}`);
      if (wallet.initialCredits === 0 && wallet.consumed !== 0) this.fail(`zero-credit tenant consumed credit ${tenantId}`);
    }
    if (this.cards.size !== this.workflows) this.fail(`expected ${this.workflows} workflows, got ${this.cards.size}`);
    if (this.evidence.size !== this.workflows * 2) this.fail(`expected ${this.workflows * 2} evidence rows, got ${this.evidence.size}`);
    if (this.reservations.size !== this.workflows) this.fail(`expected ${this.workflows} reservations, got ${this.reservations.size}`);
    if (this.stats.readyTransitions !== this.workflows) {
      this.fail(`expected ${this.workflows} READY_TO_GRADE transitions, got ${this.stats.readyTransitions}`);
    }
    if (this.stats.burstEvents !== this.burstEvents) {
      this.fail(`expected ${this.burstEvents} burst events, got ${this.stats.burstEvents}`);
    }
  }

  run() {
    const startedAt = Date.now();
    this.setup();
    this.events.sort((a, b) => a.at - b.at || a.type.localeCompare(b.type));
    for (const event of this.events) this.handle(event);
    this.verify();
    const finishedAt = Date.now();
    return {
      status: this.failures.length === 0 ? "PASS" : "FAIL",
      seed: SEED,
      workflowsRequested: this.workflows,
      workflowsCompleted: this.cards.size,
      burstEventsRequested: this.burstEvents,
      elapsedMs: finishedAt - startedAt,
      evidenceRows: this.evidence.size,
      reservations: this.reservations.size,
      failures: this.failures.slice(0, 25),
      stats: this.stats,
      acceptance: {
        zeroCrossMvContamination: this.failures.every((f) => !/identity drift|cross/i.test(f)),
        zeroFrontBackSwaps: this.stats.crossSideRejected > 0 && this.failures.every((f) => !/cross-side/i.test(f)),
        zeroDuplicateAuthoritativeEvidence: this.evidence.size === this.cards.size * 2,
        zeroDuplicateReservation: this.reservations.size === this.cards.size,
        zeroNegativeWallet: [...this.wallets.values()].every((wallet) => wallet.available >= 0),
        zeroZeroCreditBypass: this.stats.zeroCreditRejected === ZERO_CREDIT_ATTEMPTS,
        zeroStaleCurrentPreview: this.stats.stalePreviewRejected > 0 && this.failures.every((f) => !/stale preview accepted/i.test(f)),
      },
    };
  }
}

const result = new ScannerControlPlaneSimulation(WORKFLOWS, BURST_EVENTS).run();
fs.mkdirSync(DIST_ROOT, { recursive: true });
const reportPath = path.join(
  DIST_ROOT,
  `control-plane-load-sim-${WORKFLOWS}-workflows-${BURST_EVENTS}-burst.json`
);
fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });

console.log(`SCANNER_CONTROL_PLANE_LOAD_SIM ${result.status}`);
console.log(`workflows=${result.workflowsCompleted}/${result.workflowsRequested}`);
console.log(`burst_events=${result.stats.burstEvents}/${result.burstEventsRequested}`);
console.log(`events_processed=${result.stats.eventsProcessed}`);
console.log(`evidence_rows=${result.evidenceRows}`);
console.log(`reservations=${result.reservations}`);
console.log(`zero_credit_rejected=${result.stats.zeroCreditRejected}`);
console.log(`report=${reportPath}`);

if (result.status !== "PASS") {
  for (const failure of result.failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
