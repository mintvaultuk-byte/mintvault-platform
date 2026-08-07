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
  "partner-grading-http-routes.test.ts": [],
  "partner-integration-seams.test.ts": ["PARTNER_MOUNT_RT_ADMIN", "PARTNER_MOUNT_RT_RUNTIME"],
  "partner-lockout-decay.test.ts": ["PARTNER_LOCKOUT_DECAY_RT_ADMIN", "PARTNER_LOCKOUT_DECAY_RT_RUNTIME"],
  "partner-lockout-recovery.test.ts": ["PARTNER_LOCKOUT_RT_ADMIN", "PARTNER_LOCKOUT_RT_RUNTIME"],
  "partner-login-rate-limit-integration.test.ts": ["PARTNER_PUBLIC_RT_ADMIN", "PARTNER_PUBLIC_RT_RUNTIME"],
  "partner-management-integration.test.ts": ["PARTNER_MANAGEMENT_RT_ADMIN"],
  "partner-management-migration.test.ts": ["PARTNER_MANAGEMENT_MIGRATION_ADMIN"],
  "partner-management-ux-runtime.test.ts": ["PARTNER_UX_RT_ADMIN"],
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
 * The two entries above with an empty list are gated on something that is NOT an environment
 * variable, and are recorded here so "empty" can never be mistaken for "the parser lost it".
 */
const NON_ENV_GATES: Record<string, string> = {
  "partner-grading-http-routes.test.ts":
    "gated on `storageReady` (a live MinIO/S3 endpoint). Its own CI wiring guard already sits OUTSIDE that gate.",
  "printable-grade-safety.test.ts": "gated on process.platform/process.arch — the linux/amd64 golden-render arm.",
};

const GATE = /describe\.skipIf\(|\?\s*describe\s*:\s*describe\.skip/;

/**
 * Rediscover the gated-suite map from source. Kept deliberately simple and syntactic: it follows
 * the two gate forms this repo actually uses, resolves the condition identifier through up to five
 * levels of `const x = <expr>` aliasing, and collects any `process.env.NAME` it reaches. Lines that
 * merely QUOTE a gate (source-pinning assertions in other tests) are excluded.
 */
function discoverGatedSuites(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const name of readdirSync(TESTS_DIR).sort()) {
    if (!name.endsWith(".ts") || name === "ci-execution-floor.test.ts") continue;
    const src = readFileSync(join(TESTS_DIR, name), "utf8");
    const gateLines = src
      .split("\n")
      .filter((l) => GATE.test(l) && !l.includes("toContain(") && !l.includes("expect("));
    if (gateLines.length === 0) continue;

    const envOf = new Map<string, string>();
    for (const m of src.matchAll(/^const\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*process\.env\.([A-Z0-9_]+)/gm)) {
      envOf.set(m[1], m[2]);
    }

    let frontier = new Set<string>();
    for (const line of gateLines) {
      for (const m of line.matchAll(/describe\.skipIf\(([^)]*)\)/g)) {
        for (const id of m[1].match(/[A-Za-z_]\w*/g) ?? []) frontier.add(id);
      }
      for (const m of line.matchAll(/([A-Za-z_]\w*)\s*\?\s*describe\s*:\s*describe\.skip/g)) frontier.add(m[1]);
    }

    const seen = new Set<string>();
    for (let depth = 0; depth < 5; depth++) {
      const next = new Set<string>();
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const decl = new RegExp(`^(?:const|let)\\s+${id}\\s*(?::[^=]+)?=\\s*([\\s\\S]+?);\\s*$`, "m").exec(src);
        for (const ref of decl?.[1].match(/[A-Za-z_]\w*/g) ?? []) next.add(ref);
      }
      frontier = next;
    }

    found[name] = [...new Set([...seen].filter((id) => envOf.has(id)).map((id) => envOf.get(id) as string))].sort();
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
    // A regex regression that stopped matching would otherwise turn this file into a green no-op —
    // the same silent-skip failure it exists to prevent, one level up.
    const files = Object.keys(GATED_SUITES);
    expect(files.length).toBeGreaterThan(60);
    expect(new Set(Object.values(GATED_SUITES).flat()).size).toBeGreaterThan(40);
    // Named anchors: the three suites whose disappearance has actually cost this project evidence.
    expect(files).toContain("partner-rls-isolation.test.ts");
    expect(files).toContain("partner-connector-service.test.ts");
    expect(files).toContain("partner-grading-http-routes.test.ts");
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
