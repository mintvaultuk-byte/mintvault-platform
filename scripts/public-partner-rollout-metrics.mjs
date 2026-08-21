#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((value) => !value.startsWith("--"));
const minutesFlag = args.find((value) => value.startsWith("--minutes="));
const minutes = Number(minutesFlag?.split("=")[1] ?? "15");
if (!file || !Number.isFinite(minutes) || minutes <= 0) {
  console.error("Usage: node scripts/public-partner-rollout-metrics.mjs <fly-log-file> [--minutes=15]");
  process.exit(64);
}

const cutoff = Date.now() - minutes * 60_000;
const routePattern = String.raw`(?:\/api\/public\/partners(?:\/[A-Za-z0-9_-]+)?|\/find-a-partner\/?|\/partners\/location\/[A-Za-z0-9_-]+|\/sitemap\.xml)`;
const requestPattern = new RegExp(String.raw`\b(?:GET|HEAD) (${routePattern}) (\d{3}) in (\d+)ms\b`);
const isoPattern = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/;
const samples = [];

for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  const timestamp = line.match(isoPattern)?.[1];
  const request = line.match(requestPattern);
  if (!timestamp || !request || Date.parse(timestamp) < cutoff) continue;
  samples.push({ path: request[1], status: Number(request[2]), durationMs: Number(request[3]) });
}

const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
const failures = samples.filter((sample) => sample.status >= 500).length;
const failureRate = samples.length === 0 ? null : failures / samples.length;
const p95Ms = durations.length === 0 ? null : durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)];
const breached = samples.length === 0 || failureRate > 0.01 || p95Ms > 500;

console.log(JSON.stringify({
  windowMinutes: minutes,
  requests: samples.length,
  serverErrors: failures,
  serverErrorRate: failureRate,
  p95Ms,
  thresholds: { serverErrorRate: 0.01, p95Ms: 500 },
  decision: breached ? "ROLL_BACK" : "CONTINUE",
}, null, 2));
process.exitCode = breached ? 2 : 0;
