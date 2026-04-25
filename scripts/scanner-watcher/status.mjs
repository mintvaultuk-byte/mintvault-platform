#!/usr/bin/env node
/**
 * MintVault Scanner — live status display.
 *
 * Reads ~/mintvault-scans/watcher-state.json (written by watcher.mjs on every
 * state transition) and renders a fullscreen ANSI banner so Cornelius can see
 * at a glance whether it's safe to put the next card on the scanner.
 *
 * Zero external deps — pure Node + ANSI escape codes. Run standalone:
 *   node scripts/scanner-watcher/status.mjs
 *
 * Ctrl+C to quit (cursor is restored on exit).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_FILE = path.join(os.homedir(), "mintvault-scans", "watcher-state.json");
const REFRESH_MS = 250;
const BANNER_WIDTH = 38; // cells between the ║ borders

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  brightGreen: "\x1b[92m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Pad/truncate to fit inside the box — exactly BANNER_WIDTH cells. */
function fit(s) {
  if (s.length > BANNER_WIDTH) return s.slice(0, BANNER_WIDTH);
  const left = Math.floor((BANNER_WIDTH - s.length) / 2);
  const right = BANNER_WIDTH - s.length - left;
  return " ".repeat(left) + s + " ".repeat(right);
}

function secondsRemainingIso(isoDeadline) {
  if (!isoDeadline) return 0;
  const deadlineMs = new Date(isoDeadline).getTime();
  if (isNaN(deadlineMs)) return 0;
  return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
}

function buildBanner(status) {
  const top    = "╔" + "═".repeat(BANNER_WIDTH) + "╗";
  const bottom = "╚" + "═".repeat(BANNER_WIDTH) + "╝";

  if (!status) {
    return {
      color: ANSI.gray,
      lines: [top, `║${fit("waiting for watcher...")}║`, bottom],
      footer: [`${ANSI.gray}(${STATE_FILE} not found yet)${ANSI.reset}`],
    };
  }

  const { state, pairing_window_expires_at, last_cert, last_side,
          last_error, ingest_url, updated_at } = status;

  let color;
  const middle = [];

  switch (state) {
    case "idle":
      color = ANSI.brightGreen + ANSI.bold;
      middle.push(fit("READY"));
      middle.push(fit("Scan next card now"));
      break;
    case "front-received": {
      color = ANSI.yellow + ANSI.bold;
      const secs = secondsRemainingIso(pairing_window_expires_at);
      middle.push(fit("WAITING FOR BACK"));
      middle.push(fit(`${secs} seconds left`));
      break;
    }
    case "uploading":
      color = ANSI.cyan + ANSI.bold;
      middle.push(fit("UPLOADING…"));
      middle.push(fit(""));
      break;
    case "success":
      color = ANSI.brightGreen + ANSI.bold;
      middle.push(fit(`✓ UPLOADED ${last_cert || ""}`));
      middle.push(fit("Scan next card now"));
      break;
    case "error":
      color = ANSI.red + ANSI.bold;
      middle.push(fit("✗ ERROR"));
      middle.push(fit("See watcher.log"));
      break;
    default:
      color = ANSI.gray;
      middle.push(fit(`STATE: ${state}`));
      middle.push(fit(""));
  }

  const lines = [top, ...middle.map(l => `║${l}║`), bottom];

  const footer = [];
  if (last_side) footer.push(`${ANSI.bold}Last side:${ANSI.reset} ${last_side}`);
  if (state === "front-received") {
    footer.push("");
    footer.push(`${ANSI.yellow}⚠ Do not scan next card yet${ANSI.reset}`);
  }
  if (state !== "success" && last_cert) {
    footer.push("");
    footer.push(`${ANSI.gray}Last cert: ${last_cert}${ANSI.reset}`);
  }
  if (last_error) {
    footer.push("");
    footer.push(`${ANSI.red}${last_error}${ANSI.reset}`);
  }
  if (ingest_url) {
    footer.push("");
    const isStaging = ingest_url.includes("mintvault-v2");
    const label = isStaging ? `${ANSI.yellow}STAGING${ANSI.reset}` : `${ANSI.gray}prod${ANSI.reset}`;
    footer.push(`${ANSI.gray}Target: ${label} ${ANSI.gray}${ingest_url.replace(/^https:\/\//, "")}${ANSI.reset}`);
  }
  if (updated_at) {
    footer.push(`${ANSI.gray}Updated: ${new Date(updated_at).toLocaleTimeString()}${ANSI.reset}`);
  }

  return { color, lines, footer };
}

function render(status) {
  const { color, lines, footer } = buildBanner(status);
  let out = ANSI.clear + "\n";
  for (const line of lines) {
    out += `  ${color}${line}${ANSI.reset}\n`;
  }
  out += "\n";
  for (const f of footer) {
    out += `  ${f}\n`;
  }
  out += `\n  ${ANSI.dim}${ANSI.gray}Ctrl+C to exit${ANSI.reset}\n`;
  process.stdout.write(out);
}

// ── Setup ────────────────────────────────────────────────────────────────
process.stdout.write(ANSI.hideCursor);

function cleanExit(code = 0) {
  process.stdout.write(ANSI.showCursor + "\n");
  process.exit(code);
}
process.on("SIGINT",  () => cleanExit(0));
process.on("SIGTERM", () => cleanExit(0));
process.on("uncaughtException", (err) => {
  process.stdout.write(ANSI.showCursor + "\n");
  console.error("status.mjs crashed:", err.message);
  process.exit(1);
});

// Initial render immediately, then poll.
render(readState());
setInterval(() => render(readState()), REFRESH_MS);
