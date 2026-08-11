#!/usr/bin/env node
/**
 * CodeQL DELTA GATE — block what this branch INTRODUCES, grandfather what it inherited.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 * Branch protection on `main` requires five contexts, and the CodeQL one among them is
 * `CodeQL (SAST) (javascript-typescript)` — the ANALYSIS JOB. That check proves the analysis RAN.
 * It says nothing about what the analysis FOUND. So before this gate existed, a branch that
 * introduced a brand-new high-severity finding would have gone green on every required check.
 *
 * The separate aggregate `CodeQL` check (GitHub Advanced Security) does look at findings, but it
 * flags any alert in code the pull request touches — so on a 125-file PR it reports long-standing
 * repository debt as "new alerts in code changed by this pull request". It is not in the required
 * set, and it cannot distinguish inherited from introduced. Neither check enforces the actual
 * policy, from opposite directions.
 *
 * ── THE POLICY THIS ENFORCES (owner decision, 2026-08-10) ───────────────────────────────────
 * A branch is release-blocking when, and only when, it:
 *   1. introduces a NEW HIGH/CRITICAL (rule, path) pair not present in the baseline, OR
 *   2. causes the CodeQL analysis itself not to execute successfully.
 *
 * HIGH/CRITICAL findings already present on `main` are FOLLOW_UP security debt. Grandfathering
 * them is a deliberate decision to stop unrelated inherited debt holding a release hostage — it is
 * NOT a decision to tolerate new debt, and this gate is what makes that distinction real rather
 * than a sentence in a document.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────
 * It does not dismiss alerts, suppress rules, disable CodeQL, lower a severity threshold, or touch
 * branch protection. Every baselined finding stays open and visible in the Security tab. The only
 * thing that changes is which findings fail a build.
 *
 * ── WHY (rule, path) AND NOT LINE NUMBERS ───────────────────────────────────────────────────
 * Line numbers move whenever an unrelated edit shifts code — the very same finding reported at
 * :1782 on main appeared at :1784 on this branch purely from edits elsewhere in the file. Keying
 * on lines would expire the baseline constantly for no security reason, and would train people to
 * re-baseline reflexively, which is how a real finding gets waved through.
 *
 * The cost of (rule, path) is stated honestly: a SECOND instance of the same rule in an
 * already-baselined file is not distinguished from the first. That is a deliberate trade — the
 * alternative is a fingerprint that churns on every refactor. A new rule, or a known rule in a new
 * file, is always caught.
 *
 * Usage:
 *   node scripts/ci/assert-codeql-delta.mjs --pr 288
 *   node scripts/ci/assert-codeql-delta.mjs --ref refs/heads/some-branch
 *   node scripts/ci/assert-codeql-delta.mjs --alerts alerts.json     # offline, for tests
 */
import { readFileSync } from "node:fs";

export const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/** Stable identity of a finding for baseline purposes. See the header for why line is excluded. */
export function pairKey(entry) {
  return `${entry.rule}|${entry.path}`;
}

/**
 * Reduce a raw code-scanning alert list to the blocking (rule, path) pairs.
 *
 * Tolerant of both the REST shape and the flattened shape the baseline file uses, so a test can
 * feed either without a second adapter.
 */
export function extractBlockingPairs(alerts) {
  const out = new Map();
  for (const a of alerts ?? []) {
    const severity = a?.rule?.security_severity_level ?? a?.severity ?? null;
    if (!severity || !BLOCKING_SEVERITIES.has(String(severity).toLowerCase())) continue;
    const rule = a?.rule?.id ?? a?.rule ?? null;
    const path = a?.most_recent_instance?.location?.path ?? a?.path ?? null;
    if (!rule || !path) continue;
    const entry = { rule, path, severity: String(severity).toLowerCase() };
    out.set(pairKey(entry), entry);
  }
  return [...out.values()].sort((x, y) => pairKey(x).localeCompare(pairKey(y)));
}

/**
 * The whole decision, as a pure function so it is unit-testable without GitHub.
 *
 * `analysisRan` is a REQUIRED input and not inferred from an empty alert list. An analysis that
 * silently failed to execute also produces zero alerts, and "no findings" must never be reachable
 * by the analysis not running — that is the exact shape of a vacuous green.
 */
export function evaluateDelta({ baselinePairs, currentAlerts, analysisRan }) {
  if (analysisRan !== true) {
    return {
      ok: false,
      reason: "analysis_did_not_run",
      introduced: [],
      inherited: [],
      resolved: [],
      message:
        "CodeQL analysis did not execute successfully. Zero findings from an analysis that did not " +
        "run is not zero findings — refusing to pass the gate.",
    };
  }
  const baseline = new Set((baselinePairs ?? []).map(pairKey));
  const current = extractBlockingPairs(currentAlerts);
  const introduced = current.filter((c) => !baseline.has(pairKey(c)));
  const inherited = current.filter((c) => baseline.has(pairKey(c)));
  const currentKeys = new Set(current.map(pairKey));
  const resolved = [...baseline].filter((k) => !currentKeys.has(k));
  return {
    ok: introduced.length === 0,
    reason: introduced.length === 0 ? null : "new_high_or_critical",
    introduced,
    inherited,
    resolved,
    message:
      introduced.length === 0
        ? `No new HIGH/CRITICAL. ${inherited.length} inherited (baselined), ${resolved.length} baselined finding(s) no longer reported.`
        : `${introduced.length} NEW HIGH/CRITICAL finding(s) introduced by this branch.`,
  };
}

/* c8 ignore start — CLI shell; every decision above is unit-tested without a network. */
async function ghJson(path) {
  const { execFileSync } = await import("node:child_process");
  const raw = execFileSync("gh", ["api", path, "--paginate"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // --paginate concatenates JSON arrays; normalise to one array.
  const chunks = raw.replace(/\]\s*\[/g, ",").trim();
  return JSON.parse(chunks || "[]");
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baselineFile = arg("--baseline") ?? "security/codeql-baseline.json";
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));

  let currentAlerts;
  let analysisRan = true;
  const offline = arg("--alerts");
  if (offline) {
    currentAlerts = JSON.parse(readFileSync(offline, "utf8"));
  } else {
    const pr = arg("--pr");
    const ref = arg("--ref");
    const q = pr ? `pr=${encodeURIComponent(pr)}` : `ref=${encodeURIComponent(ref ?? "refs/heads/main")}`;
    try {
      currentAlerts = await ghJson(
        `repos/${process.env.GITHUB_REPOSITORY ?? "mintvaultuk-byte/mintvault-platform"}/code-scanning/alerts?${q}&state=open&per_page=100`,
      );
    } catch (e) {
      // A 403/404 here means code scanning is unavailable to this token — which is NOT the same as
      // "no findings", and must not pass. Reported distinctly from a genuine analysis failure.
      console.error(`[codeql-delta] could not read code-scanning alerts: ${(e && e.message) || e}`);
      analysisRan = false;
      currentAlerts = [];
    }
  }

  const verdict = evaluateDelta({ baselinePairs: baseline.pairs, currentAlerts, analysisRan });
  console.log(`[codeql-delta] ${verdict.message}`);
  if (verdict.resolved.length > 0) {
    // Not a failure, but worth saying: the baseline is now wider than reality and can be trimmed.
    console.log(`[codeql-delta] baselined findings no longer reported (safe to remove): ${verdict.resolved.join(", ")}`);
  }
  if (!verdict.ok) {
    console.error("\n🚫 RELEASE BLOCKED — this branch introduces HIGH/CRITICAL CodeQL findings:\n");
    for (const i of verdict.introduced) console.error(`   ${i.severity.toUpperCase()}  ${i.rule}  ${i.path}`);
    console.error(
      "\nFix the finding. Do NOT add it to security/codeql-baseline.json to make this green — that file\n" +
        "records what was already on main when the baseline was taken, and widening it to pass a build is\n" +
        "the one use it must never have.\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly = typeof process.argv[1] === "string" && /assert-codeql-delta\.mjs$/.test(process.argv[1]);
if (invokedDirectly) await main();
/* c8 ignore stop */
