/**
 * CI EXECUTION FLOOR — the guard that makes every other gated suite's evidence real.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Most DB-backed and storage-backed suites in this repo gate themselves on an environment
 * variable: `(isLocal ? describe : describe.skip)`, `describe.skipIf(!isLocal)`. That is correct
 * — they cannot run without a disposable cluster. The failure mode is that a MISSING variable is
 * indistinguishable from a PASSING suite: vitest reports "skipped", the job is green, and the
 * evidence silently disappears. This repo has already been bitten by it twice — ~250 connector
 * tests reported green for months, and a missing LC_ALL made 17 files vanish from a local run.
 *
 * The established remedy is a per-file "CI wiring guard" placed OUTSIDE the gate, so an absent
 * dependency fails loudly instead of skipping quietly (see the guard in
 * tests/partner-rls-isolation.test.ts, and the MinIO guard in
 * tests/partner-grading-http-routes.test.ts which is deliberately outside the storage gate). Only
 * 18 of the 74 gated files carry one, and nothing forced the 19th to.
 *
 * This file is that forcing function, and it is deliberately NOT gated on anything: it needs no
 * database, no storage and no network, so it cannot itself be skipped.
 *
 *   1. It rediscovers, from source, every test file that gates a describe, and which environment
 *      variables that gate depends on.
 *   2. It asserts the discovered map equals GATED_SUITES below, in BOTH directions. A new gated
 *      suite fails until it is declared here; a suite that stops gating, or changes which variable
 *      it gates on, also fails. That is the ratchet.
 *   3. In CI it asserts every declared variable is actually set, and that anything shaped like a
 *      Postgres URL is loopback. That is the floor: a workflow edit that drops a variable turns a
 *      silent mass-skip into a red build.
 *
 * MAINTENANCE: when you add a gated suite, add its entry here AND its variable to
 * .github/workflows/ci.yml. Deleting the entry to make this file green re-opens the exact hole it
 * exists to close.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every test file that gates a `describe` on a runtime condition, and the env vars that gate reads. */
const GATED_SUITES: Record<string, string[]> = {
  "partner-admin-capability.test.ts": ["PARTNER_CAPABILITY_RT_ADMIN"],
  "partner-admin-control-shell-integration.test.ts": ["PARTNER_ADMIN_TEST", "PARTNER_ADMIN_TEST_RUNTIME"],
  "partner-certificate-origin.test.ts": ["PARTNER_CERT_ORIGIN_ADMIN"],
  "partner-connector-admin-integration.test.ts": [
    "PARTNER_CONNECTOR_ADMIN_TEST",
    "PARTNER_CONNECTOR_ADMIN_TEST_RUNTIME",
  ],
  "partner-connector-admin-migration.test.ts": ["PARTNER_CONNECTOR_ADMIN_MIGRATION_ADMIN"],
  "partner-connector-fault-injection.test.ts": ["PARTNER_CONNECTOR_FAULT_RT_ADMIN", "PARTNER_CONNECTOR_FAULT_RT_URL"],
  "partner-connector-g3f-blockers.test.ts": ["PARTNER_CONNECTOR_BLOCKER_RT_ADMIN", "PARTNER_CONNECTOR_BLOCKER_RT_URL"],
  "partner-connector-import-migration.test.ts": ["PARTNER_CONNECTOR_IMPORT_MIGRATION_ADMIN"],
  "partner-connector-import-service.test.ts": ["PARTNER_CONNECTOR_IMPORT_RT_ADMIN", "PARTNER_CONNECTOR_IMPORT_RT_URL"],
  "partner-connector-migration.test.ts": ["PARTNER_CONNECTOR_MIGRATION_ADMIN"],
  "partner-connector-query-plan.test.ts": ["PARTNER_CONNECTOR_PLAN_ADMIN"],
  "partner-connector-reconciliation-concurrency.test.ts": [
    "PARTNER_CONNECTOR_RECON_LOAD_RT_ADMIN",
    "PARTNER_CONNECTOR_RECON_LOAD_RT_URL",
  ],
  "partner-connector-reconciliation-service.test.ts": [
    "PARTNER_CONNECTOR_RECON_RT_ADMIN",
    "PARTNER_CONNECTOR_RECON_RT_URL",
  ],
  "partner-connector-runtime.test.ts": ["PARTNER_CONNECTOR_RUNTIME_ADMIN", "PARTNER_CONNECTOR_RUNTIME_URL"],
  "partner-connector-scale.test.ts": ["PARTNER_CONNECTOR_SCALE_RT_ADMIN", "PARTNER_CONNECTOR_SCALE_RT_URL"],
  "partner-connector-service.test.ts": ["PARTNER_CONNECTOR_RT_ADMIN", "PARTNER_CONNECTOR_RT_URL"],
  "partner-connector-validation-migration.test.ts": ["PARTNER_CONNECTOR_VALIDATION_MIGRATION_ADMIN"],
  "partner-connector-validation-service.test.ts": [
    "PARTNER_CONNECTOR_VALIDATION_RT_ADMIN",
    "PARTNER_CONNECTOR_VALIDATION_RT_URL",
  ],
  "partner-dashboard-integration.test.ts": ["PARTNER_MANAGEMENT_RT_ADMIN"],
  "partner-dashboard-risk-equivalence.test.ts": ["PARTNER_MANAGEMENT_RT_ADMIN"],
  "partner-definer-ownership.test.ts": ["PARTNER_DEFINER_ADMIN"],
  "partner-final-owner-invariant.test.ts": ["PARTNER_FINAL_OWNER_ADMIN"],
  "partner-grading-bridge-migration.test.ts": ["PARTNER_GRADING_BRIDGE_MIGRATION_ADMIN"],
  "partner-grading-get-readonly.test.ts": [],
  "partner-grading-http-routes.test.ts": [],
  "partner-integration-seams.test.ts": ["PARTNER_MOUNT_RT_ADMIN", "PARTNER_MOUNT_RT_RUNTIME"],
  "partner-lockout-decay.test.ts": ["PARTNER_LOCKOUT_DECAY_RT_ADMIN", "PARTNER_LOCKOUT_DECAY_RT_RUNTIME"],
  "partner-lockout-recovery.test.ts": ["PARTNER_LOCKOUT_RT_ADMIN", "PARTNER_LOCKOUT_RT_RUNTIME"],
  "partner-login-rate-limit-integration.test.ts": ["PARTNER_PUBLIC_RT_ADMIN", "PARTNER_PUBLIC_RT_RUNTIME"],
  "partner-management-integration.test.ts": ["PARTNER_MANAGEMENT_RT_ADMIN"],
  "partner-management-migration.test.ts": ["PARTNER_MANAGEMENT_MIGRATION_ADMIN"],
  "partner-management-ux-runtime.test.ts": ["PARTNER_UX_RT_ADMIN"],
  "partner-mfa-bruteforce-hardening.test.ts": ["PARTNER_MFA_BF_RT_ADMIN", "PARTNER_MFA_BF_RT_RUNTIME"],
  "partner-mfa-enrolment-mandatory.test.ts": ["PARTNER_MFA_ENROL_RT_ADMIN", "PARTNER_MFA_ENROL_RT_RUNTIME"],
  "partner-mfa-factor-hardening.test.ts": ["PARTNER_MFA_HARDENING_RT_ADMIN", "PARTNER_MFA_HARDENING_RT_RUNTIME"],
  "partner-onboarding-matrix.test.ts": ["PARTNER_MOUNT_RT_ADMIN", "PARTNER_MOUNT_RT_RUNTIME"],
  "partner-portal-mount-integration.test.ts": ["PARTNER_MOUNT_RT_ADMIN", "PARTNER_MOUNT_RT_RUNTIME"],
  "partner-public-routes-integration.test.ts": ["PARTNER_PUBLIC_RT_ADMIN", "PARTNER_PUBLIC_RT_RUNTIME"],
  "partner-rbac-bootstrap.test.ts": ["PARTNER_RBAC_RT_ADMIN"],
  "partner-rbac-migration.test.ts": ["PARTNER_RBAC_MIG_ADMIN"],
  "partner-real-r2-storage.test.ts": ["PARTNER_REAL_R2_PROOF"],
  "partner-reset-delivery-integration.test.ts": ["PARTNER_PUBLIC_RT_ADMIN", "PARTNER_PUBLIC_RT_RUNTIME"],
  "partner-rls-isolation.test.ts": ["PARTNER_RLS_DB"],
  "partner-runtime-integration.test.ts": ["PARTNER_RT_ADMIN", "PARTNER_RT_RUNTIME"],
  "partner-security-repairs-0047-0048.test.ts": ["PARTNER_SECURITY_REPAIRS_ADMIN"],
  "partner-submission-workflow.test.ts": ["PARTNER_RT_ADMIN", "PARTNER_RT_RUNTIME"],
  "partner-user-management-migration.test.ts": ["PARTNER_USER_MGMT_MIGRATION_ADMIN"],
  "partner-workflow-apis.test.ts": ["PARTNER_RT_ADMIN", "PARTNER_RT_RUNTIME"],
  "pokemon-knowledge-migration.test.ts": ["TEST_DATABASE_URL"],
  "printable-grade-safety.test.ts": [],
  "super-admin-correction-mode-behaviour.test.ts": ["CORRECTION_TEST_DATABASE_URL"],
  "vq-action-reference-background-gate.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-action-replacement-gate.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-artwork-revisions-route.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-artwork-revisions-store.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-b2-backup.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-creature-designer.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-double-pay-route-spy.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-evolution-gate.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-export-concurrency.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-export-store.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-feature-flags-route-spy.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-feature-flags-store.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-generation-guard.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-generation-idempotency-store.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-identity-drift-gate.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-legacy-first-generation-route-proof.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-locked-character-replace.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-ops-route-spy.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-ops-status.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-pose-diversity-gate.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-spend-gate-route-spy.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-spend-guard-phase2.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-spend-guard-phase3a.integration.test.ts": ["TEST_DATABASE_URL"],
  "vq-spend-guard-phase3b-model-policy.integration.test.ts": ["TEST_DATABASE_URL"],
};

/**
 * MEASURED, not estimated. Both are asserted EXACTLY below — see the anti-vacuity test for why a
 * `toBeGreaterThan` threshold was not enough. Re-measure with:
 *   node -e '…GATED_SUITES…' (or simply read the failure message, which prints both numbers)
 */
const EXPECTED_GATED_FILES = 74;
const EXPECTED_GATE_VARIABLES = 57;

/**
 * The entries above with an empty list are gated on something that is NOT an environment
 * variable, and are recorded here so "empty" can never be mistaken for "the parser lost it".
 */
const NON_ENV_GATES: Record<string, string> = {
  "partner-grading-get-readonly.test.ts":
    "gated on `storageReady` (a live MinIO/S3 endpoint), same as its sibling below. Its own CI wiring guard sits OUTSIDE that gate, so an absent MinIO cannot turn the only behavioural evidence for H2 into a silent skip on a green build.",
  "partner-grading-http-routes.test.ts":
    "gated on `storageReady` (a live MinIO/S3 endpoint). Its own CI wiring guard already sits OUTSIDE that gate.",
  "printable-grade-safety.test.ts": "gated on process.platform/process.arch — the linux/amd64 golden-render arm.",
};

/**
 * Every gate form a suite can hide behind.
 *
 * WHY ALL FIVE, AND WHY THE `if` FORM IS FOUND STRUCTURALLY
 * --------------------------------------------------------
 * This regex used to be `describe.skipIf(|? describe : describe.skip` and nothing else. A file
 * matching NEITHER was skipped by `continue` before it ever entered `found` — so the both-directions
 * equality below passed while the suite was completely ungoverned. Extracting the discovery function
 * verbatim and feeding it synthetic sources proved THREE forms produced no output line at all:
 *
 *     describe.runIf(isLocal)(...)                                   // INVISIBLE
 *     describe("...", () => { it.skipIf(!isLocal)(...) })            // INVISIBLE
 *     if (isLocal) { describe(...) }                                 // INVISIBLE
 *
 * None was in the tree at the time — this was latent, not active. But the entire purpose of this
 * file is to make the 19th gated suite impossible to add SILENTLY, and a gate form the parser
 * cannot see is exactly a silent one. Two other forms were discovered-but-unresolved, which fails
 * loudly and is acceptable; invisibility is not.
 *
 * The first four forms are line-shaped and live in GATE. The `if (cond) { … describe(…) … }` form
 * is not: the condition and the `describe` are on different lines, so it is found by balancing
 * parentheses and braces in `conditionalDescribeGates()` instead of by a line regex.
 */
const GATE =
  /describe\.skipIf\(|describe\.runIf\(|\?\s*describe\s*:\s*describe\.skip|\?\s*describe\.skip\s*:\s*describe|\b(?:it|test)\.(?:skipIf|runIf)\(/;

/** Lines that merely QUOTE a gate (source-pinning assertions in other suites) are not gates. */
function isQuotingLine(l: string): boolean {
  return l.includes("toContain(") || l.includes("expect(");
}

/**
 * Find `if (<cond>) { … describe(…) … }` gates and return each condition's source text.
 *
 * Deliberately syntactic, like the rest of this parser: balance the condition's parentheses, then
 * balance the block's braces, then ask whether a `describe(` call appears inside. Over-detection is
 * harmless (the identifiers simply resolve to no environment variable); the failure that matters is
 * seeing nothing at all.
 */
function conditionalDescribeGates(src: string): string[] {
  const conds: string[] = [];
  const re = /(?:^|\n)([ \t]*)if\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const lineEnd = src.indexOf("\n", m.index + 1);
    const line = src.slice(m.index, lineEnd === -1 ? src.length : lineEnd);
    if (isQuotingLine(line)) continue;
    const parenStart = src.indexOf("(", m.index + m[0].length - 1);
    if (parenStart === -1) continue;
    let depth = 0;
    let i = parenStart;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    if (i >= src.length) continue;
    const cond = src.slice(parenStart + 1, i);
    const braceStart = src.indexOf("{", i);
    if (braceStart === -1) continue;
    if (src.slice(i + 1, braceStart).trim() !== "") continue; // not an `if (…) {` block
    let braces = 0;
    let j = braceStart;
    for (; j < src.length; j++) {
      if (src[j] === "{") braces++;
      else if (src[j] === "}" && --braces === 0) break;
    }
    if (/\bdescribe\s*\(/.test(src.slice(braceStart, j))) conds.push(cond);
  }
  return conds;
}

/**
 * Resolve one file's gate condition(s) to the environment variables they read.
 *
 * Returns `null` when the file gates nothing — which is what makes an invisible gate detectable at
 * all, and what the mutation tests below assert per form.
 *
 * Extracted from discoverGatedSuites() so it can be exercised against synthetic sources. When it
 * lived inline, the only way to test a new gate form was to add a real file to the tree.
 */
export function gateEnvVarsFromSource(src: string): string[] | null {
  const gateLines = src.split("\n").filter((l) => GATE.test(l) && !isQuotingLine(l));
  const ifConds = conditionalDescribeGates(src);
  if (gateLines.length === 0 && ifConds.length === 0) return null;

  /**
   * Which environment variables each declared identifier reads.
   *
   * The previous expression was `/^const\s+(\w+)\s*=\s*process\.env\.(\w+)/gm` — anchored at
   * column 0, `const` only, and requiring `process.env` to be the FIRST token after `=`. So an
   * indented declaration, `Boolean(process.env.Y)`, `(process.env.Y ?? "")`, `let`, or a second
   * variable in the same initialiser all resolved to nothing. That failed LOUDLY (an empty array
   * against a populated pin) rather than silently, but it named the wrong problem. It now accepts
   * any indentation, any declarator keyword, and every `process.env.NAME` in the initialiser.
   */
  const envOf = new Map<string, string[]>();
  for (const m of src.matchAll(/(?:^|\n)[ \t]*(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*([^;\n]*)/g)) {
    const names = [...m[2].matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((e) => e[1]);
    if (names.length > 0) envOf.set(m[1], [...(envOf.get(m[1]) ?? []), ...names]);
  }

  const frontier0 = new Set<string>();
  for (const line of gateLines) {
    for (const m of line.matchAll(/(?:describe|it|test)\.(?:skipIf|runIf)\(([^)]*)\)/g)) {
      for (const id of m[1].match(/[A-Za-z_]\w*/g) ?? []) frontier0.add(id);
    }
    for (const m of line.matchAll(/([A-Za-z_]\w*)\s*\?\s*describe(?:\.skip)?\s*:\s*describe(?:\.skip)?/g)) {
      frontier0.add(m[1]);
    }
  }
  for (const cond of ifConds) for (const id of cond.match(/[A-Za-z_]\w*/g) ?? []) frontier0.add(id);

  let frontier = frontier0;
  const seen = new Set<string>();
  for (let depth = 0; depth < 5; depth++) {
    const next = new Set<string>();
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const decl = new RegExp(`(?:^|\\n)[ \\t]*(?:const|let|var)\\s+${id}\\s*(?::[^=\\n]+)?=\\s*([\\s\\S]+?);\\s*(?:\\n|$)`).exec(src);
      /**
       * `process.env.X` is stripped before identifiers are harvested. Tokenising it whole yields
       * the words `process` and `env`, which then get chased as if they were aliases — and with the
       * loosened envOf below, `env` collides with any ordinary `const env = { … process.env.Y … }`
       * further down the file and imports unrelated variables into the gate's dependency set.
       * The env names themselves are already captured by envOf; only true aliases belong here.
       */
      const body = (decl?.[1] ?? "").replace(/process\.env(?:\.[A-Z0-9_]+)?/g, " ");
      for (const ref of body.match(/[A-Za-z_]\w*/g) ?? []) next.add(ref);
    }
    frontier = next;
  }

  return [...new Set([...seen].flatMap((id) => envOf.get(id) ?? []))].sort();
}

/** Rediscover the gated-suite map from source, one entry per file that gates a describe. */
function discoverGatedSuites(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const name of readdirSync(TESTS_DIR).sort()) {
    if (!name.endsWith(".ts") || name === "ci-execution-floor.test.ts") continue;
    const vars = gateEnvVarsFromSource(readFileSync(join(TESTS_DIR, name), "utf8"));
    if (vars !== null) found[name] = vars;
  }
  return found;
}

describe("CI execution floor", () => {
  it("the gated-suite inventory matches source, in both directions", () => {
    // Left-to-right catches a new gated suite nobody declared. Right-to-left catches an entry that
    // has gone stale — a renamed file, a suite that stopped gating, or a gate that changed which
    // variable it reads. Compared as one object so the diff names the offending file.
    expect(discoverGatedSuites()).toEqual(GATED_SUITES);
  });

  it("every gated suite is env-gated, or is declared as gated on something else", () => {
    const envless = Object.entries(GATED_SUITES)
      .filter(([, vars]) => vars.length === 0)
      .map(([file]) => file)
      .sort();
    expect(envless).toEqual(Object.keys(NON_ENV_GATES).sort());
  });

  it("the floor is not vacuous: it covers the whole gated surface, not a sample", () => {
    /**
     * EXACT counts, not `toBeGreaterThan`.
     *
     * These were `> 60` files and `> 40` distinct variables against 74 and 57 actual — 13 files and
     * 16 variables of slack. That slack is not theoretical: deleting THIRTEEN gated test files AND
     * their entries here still reported this file 4/4 green, because a consistent deletion from both
     * sides keeps the two directions of the inventory equality agreeing with each other. The
     * threshold was the only thing standing between that and a green build, and it was too loose to
     * notice.
     *
     * Pinned exactly instead. Adding or removing a gated suite is now a THIRD deliberate edit
     * (source, GATED_SUITES, and these constants) rather than something a bulk deletion can slip
     * past — and the counts are cheap to update precisely because updating them is conscious.
     */
    const files = Object.keys(GATED_SUITES);
    expect(files.length, "gated-suite count changed: update EXPECTED_GATED_FILES deliberately, and say why").toBe(
      EXPECTED_GATED_FILES
    );
    expect(
      new Set(Object.values(GATED_SUITES).flat()).size,
      "distinct gate-variable count changed: update EXPECTED_GATE_VARIABLES deliberately, and say why"
    ).toBe(EXPECTED_GATE_VARIABLES);
    // Named anchors: the three suites whose disappearance has actually cost this project evidence.
    expect(files).toContain("partner-rls-isolation.test.ts");
    expect(files).toContain("partner-connector-service.test.ts");
    expect(files).toContain("partner-grading-http-routes.test.ts");
  });

  /**
   * MUTATION TESTS — one per gate form, run against synthetic sources.
   *
   * Every one of the three `INVISIBLE` cases below returned `null` (no output line at all) from the
   * old parser, which meant the file never entered `found` and the inventory equality above passed
   * while the suite was ungoverned. They now return the gate's environment variables.
   *
   * These are mutations in the strict sense: revert `GATE`/`conditionalDescribeGates()` to the old
   * two-form version and each corresponding case goes red, which is the proof that the coverage is
   * real and not merely asserted.
   */
  describe("gate-form coverage (mutation)", () => {
    const decl = 'const ADMIN = process.env.SYNTHETIC_GATE_URL;\nconst isLocal = Boolean(ADMIN);\n';

    it("negative control: a file with no gate at all is not discovered", () => {
      expect(gateEnvVarsFromSource(`${decl}describe("ungated", () => { it("x", () => {}); });\n`)).toBeNull();
    });

    it("already covered: describe.skipIf", () => {
      expect(gateEnvVarsFromSource(`${decl}describe.skipIf(!isLocal)("s", () => {});\n`)).toEqual(["SYNTHETIC_GATE_URL"]);
    });

    it("already covered: the ternary form", () => {
      expect(gateEnvVarsFromSource(`${decl}(isLocal ? describe : describe.skip)("s", () => {});\n`)).toEqual([
        "SYNTHETIC_GATE_URL",
      ]);
    });

    it("WAS INVISIBLE: describe.runIf", () => {
      expect(gateEnvVarsFromSource(`${decl}describe.runIf(isLocal)("s", () => {});\n`)).toEqual(["SYNTHETIC_GATE_URL"]);
    });

    it("WAS INVISIBLE: an inner it.skipIf inside an ungated describe", () => {
      const src = `${decl}describe("s", () => {\n  it.skipIf(!isLocal)("t", () => {});\n});\n`;
      expect(gateEnvVarsFromSource(src)).toEqual(["SYNTHETIC_GATE_URL"]);
    });

    it("WAS INVISIBLE: a describe wrapped in a bare if block", () => {
      const src = `${decl}if (isLocal) {\n  describe("s", () => {\n    it("t", () => {});\n  });\n}\n`;
      expect(gateEnvVarsFromSource(src)).toEqual(["SYNTHETIC_GATE_URL"]);
    });

    /**
     * The secondary defect on the env resolver. Each of these forms previously resolved to `[]` —
     * a LOUD failure (an empty array against a populated pin) rather than a silent one, but one
     * that named the wrong problem: it read as "this suite stopped gating on that variable".
     */
    it.each([
      ["indented declaration", '  const ADMIN = process.env.SYNTHETIC_GATE_URL;\n  const isLocal = Boolean(ADMIN);\n'],
      ["Boolean(process.env.X)", 'const isLocal = Boolean(process.env.SYNTHETIC_GATE_URL);\n'],
      ["(process.env.X ?? \"\")", 'const ADMIN = (process.env.SYNTHETIC_GATE_URL ?? "");\nconst isLocal = ADMIN !== "";\n'],
      ["let, not const", 'let ADMIN = process.env.SYNTHETIC_GATE_URL;\nconst isLocal = Boolean(ADMIN);\n'],
    ])("env resolver handles %s", (_label, prelude) => {
      expect(gateEnvVarsFromSource(`${prelude}describe.skipIf(!isLocal)("s", () => {});\n`)).toEqual([
        "SYNTHETIC_GATE_URL",
      ]);
    });

    it("resolves every variable in a multi-variable gate, not just the first", () => {
      const src =
        'const A = process.env.SYNTHETIC_GATE_ADMIN;\nconst B = process.env.SYNTHETIC_GATE_RUNTIME;\n' +
        'const isLocal = Boolean(A) && Boolean(B);\ndescribe.skipIf(!isLocal)("s", () => {});\n';
      expect(gateEnvVarsFromSource(src)).toEqual(["SYNTHETIC_GATE_ADMIN", "SYNTHETIC_GATE_RUNTIME"]);
    });
  });

  it("CI wires every gated suite it claims to run", () => {
    if (!process.env.CI && !process.env.GITHUB_ACTIONS) {
      console.warn("[execution-floor] env assertions skipped: not CI");
      return;
    }
    const missing: string[] = [];
    const nonLoopback: string[] = [];
    for (const [file, vars] of Object.entries(GATED_SUITES)) {
      for (const v of vars) {
        const value = process.env[v];
        if (!value) {
          missing.push(`${v} (${file})`);
          continue;
        }
        if (/^postgres(ql)?:\/\//.test(value) && !/@(127\.0\.0\.1|localhost)[:/]/.test(value)) {
          // A non-loopback URL here would mean CI is pointed at a real database — and every gate
          // that checks for loopback would skip anyway, silently, which is the whole problem.
          nonLoopback.push(`${v} (${file})`);
        }
      }
    }
    expect({ missing, nonLoopback }).toEqual({ missing: [], nonLoopback: [] });
  });
});
