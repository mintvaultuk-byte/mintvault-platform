#!/usr/bin/env node
/*
 * Shop-1 unsigned-pilot persistence acceptance.
 *
 * Proves the one property the pilot turns on: the station identity issued at enrolment
 * survives app quits, native-service restarts and Mac reboots, and no second station is ever
 * created. It does NOT touch the server — the decisive "exactly one station" check is a Super
 * Admin screen, deliberately, because a local script asserting its own correctness proves
 * nothing about the fleet.
 *
 * SAFETY: refuses to run unless a station identity already exists (enrol first), and refuses
 * to run at all if the identity ever changes mid-run — that is the failure it exists to catch,
 * so it stops rather than papering over it.
 *
 * Usage:
 *   node shop1-pilot-acceptance.js --launches 20 --service-restarts 10
 *   node shop1-pilot-acceptance.js --verify-only [--label reboot-1]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SUPPORT = process.env.MINTVAULT_SCANS_DIR
  ? path.join(process.env.MINTVAULT_SCANS_DIR, "app-state")
  : path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const IDENTITY_FILE = path.join(SUPPORT, "station-identity.enc.json");
const REPORT_FILE = path.join(SUPPORT, "shop1-pilot-acceptance-report.json");
const APP = process.env.MINTVAULT_SCANNER_APP || "/Applications/MintVault Scanner.app";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const VERIFY_ONLY = process.argv.includes("--verify-only");
const LABEL = arg("--label", VERIFY_ONLY ? "verify" : "cycles");
const LAUNCHES = Number(arg("--launches", "20"));
const SERVICE_RESTARTS = Number(arg("--service-restarts", "10"));

/*
 * The envelope is Keychain-encrypted, so this script cannot read the station code itself —
 * and should not: doing so would need the app's own decryption authority. Fingerprinting the
 * SEALED bytes is enough for the property under test. The envelope is rewritten on every nonce
 * advance, so the ciphertext legitimately changes; what must NOT change is the file's identity
 * lineage, which the app itself asserts. We therefore track BOTH: the sealed digest (expected
 * to move) and the inode + creation time (must not move — a new file means a new identity).
 */
function identitySnapshot() {
  if (!fs.existsSync(IDENTITY_FILE)) return null;
  const stat = fs.statSync(IDENTITY_FILE);
  const bytes = fs.readFileSync(IDENTITY_FILE);
  return {
    inode: stat.ino,
    birthtimeMs: Math.round(stat.birthtimeMs),
    sizeBytes: stat.size,
    sealedDigest: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  };
}

function appRunning() {
  const r = spawnSync("pgrep", ["-f", "MintVault Scanner.app/Contents/MacOS"], { encoding: "utf8" });
  return r.status === 0 && Boolean(r.stdout.trim());
}
function quitApp() {
  spawnSync("osascript", ["-e", 'tell application "MintVault Scanner" to quit'], { encoding: "utf8" });
  for (let i = 0; i < 30; i += 1) {
    if (!appRunning()) return true;
    spawnSync("sleep", ["0.5"]);
  }
  spawnSync("pkill", ["-f", "MintVault Scanner.app/Contents/MacOS"]);
  return !appRunning();
}
function launchApp() {
  const r = spawnSync("open", ["-a", APP], { encoding: "utf8" });
  if (r.status !== 0) return false;
  for (let i = 0; i < 60; i += 1) {
    if (appRunning()) return true;
    spawnSync("sleep", ["0.5"]);
  }
  return false;
}
function restartBridge() {
  // The native bridge is a child of the app; killing it must be recovered by the app itself.
  const r = spawnSync("pkill", ["-f", "mintvault-lide-bridge"], { encoding: "utf8" });
  spawnSync("sleep", ["2"]);
  return r.status === 0 || r.status === 1; // 1 == no match, which is also a valid state
}

function readReport() {
  if (!fs.existsSync(REPORT_FILE)) return { baseline: null, startedAt: null, entries: [] };
  try { return JSON.parse(fs.readFileSync(REPORT_FILE, "utf8")); }
  catch { return { baseline: null, startedAt: null, entries: [] }; }
}

function writeReport(report) {
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}

function appendReport(entry, baseline) {
  const report = readReport();
  report.startedAt = report.startedAt || new Date().toISOString();
  /*
   * The baseline is PERSISTED on first run and never rewritten.
   *
   * An earlier version recomputed it from the current file on every invocation, which made
   * --verify-only vacuous: after a reboot that replaced the identity, it compared the new file
   * against itself and reported PASS. A check that cannot fail proves nothing. The whole point
   * across five reboots is comparison against the identity issued at ENROLMENT, so it is
   * recorded once and treated as immutable.
   */
  if (!report.baseline) report.baseline = baseline;
  report.entries.push(entry);
  writeReport(report);
}

function main() {
  const current = identitySnapshot();
  const stored = readReport().baseline;
  // Compare against the ENROLMENT baseline whenever one exists; only seed it on the very first run.
  const baseline = stored || current;
  if (!current) {
    console.error(
      "REFUSING: no station identity at " + IDENTITY_FILE + "\n" +
      "Complete first launch, Partner sign-in, MFA, station enrolment and Super Admin approval first."
    );
    process.exit(2);
  }
  console.log("station identity baseline: inode=%s born=%s%s",
    baseline.inode, new Date(baseline.birthtimeMs).toISOString(),
    stored ? " (from recorded enrolment baseline)" : " (recording as enrolment baseline)");

  const results = [];
  const assertSame = (stage) => {
    const now = identitySnapshot();
    if (!now) { console.error(`FAIL [${stage}]: station identity DISAPPEARED`); process.exit(1); }
    if (now.inode !== baseline.inode || now.birthtimeMs !== baseline.birthtimeMs) {
      console.error(
        `FAIL [${stage}]: station identity was REPLACED — inode ${baseline.inode}->${now.inode}, ` +
        `born ${baseline.birthtimeMs}->${now.birthtimeMs}. A new identity means a duplicate station.`
      );
      process.exit(1);
    }
    return now;
  };

  if (VERIFY_ONLY) {
    const now = assertSame(LABEL);
    appendReport({ at: new Date().toISOString(), stage: LABEL, result: "PASS", identity: now }, baseline);
    console.log("PASS [%s]: station identity preserved", LABEL);
    console.log("report: %s", REPORT_FILE);
    return;
  }

  for (let i = 1; i <= LAUNCHES; i += 1) {
    if (!quitApp()) { console.error(`FAIL: app did not quit on cycle ${i}`); process.exit(1); }
    if (!launchApp()) { console.error(`FAIL: app did not relaunch on cycle ${i}`); process.exit(1); }
    assertSame(`launch-${i}`);
    results.push({ stage: `launch-${i}`, result: "PASS" });
    console.log("  launch %d/%d OK", i, LAUNCHES);
  }

  for (let i = 1; i <= SERVICE_RESTARTS; i += 1) {
    restartBridge();
    assertSame(`service-restart-${i}`);
    results.push({ stage: `service-restart-${i}`, result: "PASS" });
    console.log("  service restart %d/%d OK", i, SERVICE_RESTARTS);
  }

  const final = assertSame("final");
  appendReport({
    at: new Date().toISOString(),
    stage: LABEL,
    launches: LAUNCHES,
    serviceRestarts: SERVICE_RESTARTS,
    result: "PASS",
    identity: final,
    results,
  }, baseline);
  console.log("\nPASS: %d launches, %d service restarts, station identity preserved throughout.",
    LAUNCHES, SERVICE_RESTARTS);
  console.log("Now do the 5 Mac reboots, running --verify-only --label reboot-N after each.");
  console.log("report: %s", REPORT_FILE);
}

main();
