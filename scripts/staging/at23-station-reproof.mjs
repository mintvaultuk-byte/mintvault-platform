#!/usr/bin/env node
/**
 * AT-23 CREDENTIAL-GATED STAGING RE-PROOF — run by the OWNER, not by the assistant.
 *
 * WHY THIS EXISTS. RC-F11 changed `server/partner/station-routes.ts`: the three signed-station hot
 * paths are now rate limited, and (after the staging measurement on 2026-08-15) those limiters go
 * through the SHARED PostgreSQL store rather than a per-process one. That makes the Scanner/station
 * sections of AT-23 runtime-relevant again, so they must be re-proven against the exact candidate on
 * two live Fly Machines.
 *
 * Every one of those sections needs a request signed by an APPROVED, ENROLLED station (Ed25519 over
 * the canonical envelope) plus an MFA-passed operator session. Those are the owner's credentials.
 * This script therefore reads them from the OWNER'S OWN ENVIRONMENT and never prints, logs or
 * persists them — the evidence file contains outcomes only.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT YOU MUST SET (staging values only — never production):
 *
 *   STAGING_BASE_URL          https://mintvault-v2.fly.dev
 *   STAGING_MACHINE_A         8d9349be072948
 *   STAGING_MACHINE_B         d8d14d0f34d378
 *   STAGING_STATION_CODE      the approved station's code
 *   STAGING_STATION_KEY_PEM   that station's Ed25519 PRIVATE key, PEM (or STAGING_STATION_KEY_FILE)
 *   STAGING_OPERATOR_SESSION  an MFA-passed partner session token holding partner.cards.scan
 *
 * Optional, only for the sections that need a second identity:
 *   STAGING_STATION_B_CODE / STAGING_STATION_B_KEY_PEM      other station, same tenant  (§7 D)
 *   STAGING_PARTNER_B_STATION_CODE / ..._KEY_PEM / ..._SESSION   other TENANT           (§7 E)
 *   STAGING_SUSPENDED_STATION_CODE / ..._KEY_PEM            suspended station           (§6)
 *   STAGING_REVOKED_STATION_CODE / ..._KEY_PEM              revoked station             (§6)
 *
 * RUN:
 *   node scripts/staging/at23-station-reproof.mjs --sections 3,6,7
 *   node scripts/staging/at23-station-reproof.mjs --all --out at23-evidence.json
 *
 * The script REFUSES to run against any host that is not the staging app, so it cannot be pointed
 * at production by editing one variable.
 */
import { createHash, randomUUID, sign as edSign, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "at23-evidence.json";
const secIdx = args.indexOf("--sections");
const SECTIONS = args.includes("--all")
  ? ["3", "4", "5", "6", "7", "8"]
  : secIdx >= 0
    ? String(args[secIdx + 1]).split(",")
    : ["3", "6", "7"];

const BASE = process.env.STAGING_BASE_URL || "https://mintvault-v2.fly.dev";
const A = process.env.STAGING_MACHINE_A;
const B = process.env.STAGING_MACHINE_B;

/**
 * HARD STOP: staging only. A production host is refused outright rather than warned about, so this
 * file can never become a way to drive signed traffic at the live estate.
 */
function assertStaging(url) {
  const host = new URL(url).hostname;
  if (!/^mintvault-v2\.fly\.dev$|^127\.0\.0\.1$|^localhost$/.test(host)) {
    throw new Error(`REFUSING to run against '${host}'. This harness is staging-only.`);
  }
}
assertStaging(BASE);

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} — see the header of this file for what to set`);
  return v;
}
function keyFor(pemVar, fileVar) {
  const pem = process.env[pemVar] || (process.env[fileVar] ? readFileSync(process.env[fileVar], "utf8") : "");
  if (!pem) throw new Error(`missing ${pemVar} (or ${fileVar})`);
  return createPrivateKey(pem);
}

/** The canonical envelope, byte-for-byte as server/partner/station-identity.ts builds it. */
function canonical({ stationCode, method, path, timestamp, nonce, contentSha256 }) {
  return [
    "mintvault-station-request-v1",
    stationCode,
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce,
    contentSha256,
  ].join("\n");
}

/**
 * One signed station request, pinned to a named Machine.
 *
 * `fly-force-instance-id` is what makes the cross-Machine claims real rather than hopeful: without
 * it Fly is free to serve both halves of a "cross-Machine" test from the same process, and the test
 * would pass while proving nothing.
 */
async function signedRequest({ machine, method, path, body, station, key, session }) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const contentSha256 = createHash("sha256").update(raw).digest("hex");
  const timestamp = Date.now();
  const nonce = randomUUID();
  const envelope = { stationCode: station.toUpperCase(), method, path, timestamp, nonce, contentSha256 };
  const signature = edSign(null, Buffer.from(canonical(envelope)), key).toString("base64url");

  const headers = {
    "x-mintvault-station-id": station.toUpperCase(),
    "x-mintvault-station-timestamp": String(timestamp),
    "x-mintvault-station-nonce": nonce,
    "x-mintvault-content-sha256": contentSha256,
    "x-mintvault-station-signature": signature,
    ...(session ? { "x-mintvault-operator-session": session } : {}),
    ...(machine ? { "fly-force-instance-id": machine } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body: raw }) });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body is itself evidence */
  }
  return { status: res.status, body: parsed, machine };
}

const evidence = { candidate: null, base: BASE, machines: { A, B }, sections: {} };
const record = (section, name, data) => {
  (evidence.sections[section] ??= []).push({ name, ...data });
  const flag = data.pass === true ? "PASS" : data.pass === false ? "FAIL" : "INFO";
  console.log(`  [${flag}] §${section} ${name}`);
};

/** Both Machines must be serving the same commit or nothing below means anything. */
async function preflight() {
  const seen = {};
  for (const [label, m] of [
    ["A", A],
    ["B", B],
  ]) {
    const r = await fetch(`${BASE}/api/version`, { headers: { "fly-force-instance-id": m } });
    seen[label] = (await r.json()).commit;
  }
  evidence.candidate = seen.A;
  const pass = seen.A === seen.B && !!seen.A;
  record("0", "both Machines serve the same commit", { pass, seen });
  if (!pass) throw new Error("Machines disagree on the served commit — fix that before proving anything");
}

// ── §3 Scanner NEW, alternating Machines ───────────────────────────────────────────────────────
async function section3(ctx) {
  const clientOpId = randomUUID();
  const started = await signedRequest({
    ...ctx,
    machine: A,
    method: "POST",
    path: "/api/partner/card-jobs",
    body: { clientOpId, cardLabel: `AT23 reproof ${new Date().toISOString()}` },
  });
  record("3", "NEW accepted on Machine A", {
    pass: started.status === 200,
    status: started.status,
    body: started.body,
  });

  // Replay the SAME clientOpId on the OTHER Machine: idempotency must be shared state, so this must
  // return the same job rather than mint a second one.
  const replay = await signedRequest({
    ...ctx,
    machine: B,
    method: "POST",
    path: "/api/partner/card-jobs",
    body: { clientOpId, cardLabel: "AT23 replay" },
  });
  const sameJob =
    replay.status === 200 &&
    started.status === 200 &&
    JSON.stringify(replay.body?.cardJob?.id ?? replay.body?.cardJobId) ===
      JSON.stringify(started.body?.cardJob?.id ?? started.body?.cardJobId);
  record("3", "same clientOpId on Machine B returns the SAME Card Job (one job, one MV, one cert)", {
    pass: sameJob,
    status: replay.status,
    body: replay.body,
  });
  return started.body;
}

// ── §6 Station authority, identical on both Machines ───────────────────────────────────────────
async function section6(ctx) {
  for (const [label, m] of [
    ["A", A],
    ["B", B],
  ]) {
    const ok = await signedRequest({ ...ctx, machine: m, method: "GET", path: "/api/partner/stations/fix-queue" });
    record("6", `approved station accepted on Machine ${label}`, {
      pass: ok.status === 200,
      status: ok.status,
    });

    // A forged signature must be refused identically on both Machines.
    const forged = await signedRequest({
      ...ctx,
      machine: m,
      method: "GET",
      path: "/api/partner/stations/fix-queue",
      key: ctx.forgedKey,
    });
    record("6", `forged station signature denied on Machine ${label}`, {
      pass: forged.status === 400 || forged.status === 401 || forged.status === 403,
      status: forged.status,
    });
  }

  for (const [name, codeVar, keyVar, expect] of [
    ["suspended station denied", "STAGING_SUSPENDED_STATION_CODE", "STAGING_SUSPENDED_STATION_KEY_PEM", [403]],
    ["revoked station denied", "STAGING_REVOKED_STATION_CODE", "STAGING_REVOKED_STATION_KEY_PEM", [403, 404]],
  ]) {
    if (!process.env[codeVar]) {
      record("6", `${name} — SKIPPED (${codeVar} not set)`, { pass: null });
      continue;
    }
    const r = await signedRequest({
      machine: A,
      method: "GET",
      path: "/api/partner/stations/fix-queue",
      station: process.env[codeVar],
      key: keyFor(keyVar, `${keyVar}_FILE`),
      session: ctx.session,
    });
    record("6", name, { pass: expect.includes(r.status), status: r.status });
  }
}

// ── §7 The shared limiter is FLEET-WIDE ────────────────────────────────────────────────────────
async function section7(ctx) {
  // fix-queue is a READ with a 120/min per-station budget — the safest route to exhaust, because it
  // creates nothing. Split the traffic across BOTH Machines: under the old per-process store each
  // Machine granted its own 120 and this never 429s.
  const MAX = 120;
  const half = Math.ceil(MAX * 0.6);
  const statuses = [];
  for (let i = 0; i < half; i++) {
    statuses.push(
      (await signedRequest({ ...ctx, machine: A, method: "GET", path: "/api/partner/stations/fix-queue" })).status
    );
  }
  const beforeAll200 = statuses.every((s) => s === 200);
  record("7", `${half} legitimate reads on Machine A all served (normal shop speed unimpeded)`, {
    pass: beforeAll200,
    counts: tally(statuses),
  });

  const onB = [];
  for (let i = 0; i < MAX; i++) {
    onB.push(
      (await signedRequest({ ...ctx, machine: B, method: "GET", path: "/api/partner/stations/fix-queue" })).status
    );
  }
  const served = onB.filter((s) => s === 200).length;
  const refused = onB.filter((s) => s === 429).length;
  // THE test: the fleet shares ONE budget. Per-process stores would serve all 120 on B.
  record("7", "Machine B does NOT get a fresh allowance — the fleet shares one budget", {
    pass: refused > 0 && half + served <= MAX + 2,
    machineA_served: half,
    machineB_served: served,
    machineB_429: refused,
    fleetBudget: MAX,
  });

  if (process.env.STAGING_STATION_B_CODE) {
    const other = await signedRequest({
      machine: A,
      method: "GET",
      path: "/api/partner/stations/fix-queue",
      station: process.env.STAGING_STATION_B_CODE,
      key: keyFor("STAGING_STATION_B_KEY_PEM", "STAGING_STATION_B_KEY_FILE"),
      session: ctx.session,
    });
    record("7", "a DIFFERENT station still has its own allowance", {
      pass: other.status === 200,
      status: other.status,
    });
  } else {
    record("7", "different-station allowance — SKIPPED (STAGING_STATION_B_CODE not set)", { pass: null });
  }

  if (process.env.STAGING_PARTNER_B_STATION_CODE) {
    const otherTenant = await signedRequest({
      machine: B,
      method: "GET",
      path: "/api/partner/stations/fix-queue",
      station: process.env.STAGING_PARTNER_B_STATION_CODE,
      key: keyFor("STAGING_PARTNER_B_STATION_KEY_PEM", "STAGING_PARTNER_B_STATION_KEY_FILE"),
      session: need("STAGING_PARTNER_B_SESSION"),
    });
    record("7", "a DIFFERENT partner still has its own allowance", {
      pass: otherTenant.status === 200,
      status: otherTenant.status,
    });
  } else {
    record("7", "different-partner allowance — SKIPPED (STAGING_PARTNER_B_STATION_CODE not set)", { pass: null });
  }
}

function tally(list) {
  return list.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const ctx = {
  station: need("STAGING_STATION_CODE"),
  key: keyFor("STAGING_STATION_KEY_PEM", "STAGING_STATION_KEY_FILE"),
  session: need("STAGING_OPERATOR_SESSION"),
  // A throwaway key that is NOT the station's, used only to prove a forged signature is refused.
  forgedKey: (await import("node:crypto")).generateKeyPairSync("ed25519").privateKey,
};
if (!A || !B) throw new Error("set STAGING_MACHINE_A and STAGING_MACHINE_B");

await preflight();
if (SECTIONS.includes("3")) await section3(ctx);
if (SECTIONS.includes("6")) await section6(ctx);
if (SECTIONS.includes("7")) await section7(ctx);
for (const s of ["4", "5", "8"]) {
  if (SECTIONS.includes(s)) {
    record(s, "NOT AUTOMATED — needs an admin session (credit adjustment / side invalidation / restart)", {
      pass: null,
    });
  }
}

writeFileSync(OUT, JSON.stringify(evidence, null, 2));
const all = Object.values(evidence.sections).flat();
const failed = all.filter((r) => r.pass === false);
const skipped = all.filter((r) => r.pass === null);
console.log(`\nevidence -> ${OUT}`);
console.log(
  `checks: ${all.length}  passed: ${all.filter((r) => r.pass === true).length}  failed: ${failed.length}  skipped: ${skipped.length}`
);
process.exit(failed.length ? 1 : 0);
