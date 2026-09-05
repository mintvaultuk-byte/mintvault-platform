import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CRITICAL_SUITES,
  MANAGED_DATABASE_ENVIRONMENT_KEYS,
  isolatedSuiteEnvironment,
} from "../scripts/ci/partner-suite-env-matrix.mjs";
import {
  classifyReport,
  meetsPartnerAggregateFloor,
  MINIMUM_PARTNER_CRITICAL_ASSERTIONS,
  validatePartnerSuiteFloors,
} from "../scripts/ci/partner-suite-verdict.mjs";
import { buildMigrationReferenceReport } from "../scripts/ci/check-migration-references.mjs";
import { trackedJavaScriptFiles, validateScriptSyntaxInventory } from "../scripts/ci/check-script-syntax.mjs";
import {
  EXPECTED_SCANNER_FILES,
  MINIMUM_SCANNER_ASSERTIONS,
  SCANNER_SUITE_FLOORS,
  parseTapSummary,
  validateScannerDependencyIsolation,
  validateScannerResults,
} from "../scripts/ci/run-scanner-suite.mjs";
import {
  compareDiagnosticBaseline,
  compareTypecheckContract,
  parseDiagnostics,
  validateTypecheckConfiguration,
} from "../scripts/ci/run-typecheck-ratchet.mjs";
import { validateCiTopology } from "../scripts/ci/verify-ci-topology.mjs";

const realCiInput = () => ({
  workflow: readFileSync(".github/workflows/ci.yml", "utf8"),
  packageJson: JSON.parse(readFileSync("package.json", "utf8")),
  rootConfig: JSON.parse(readFileSync("tsconfig.json", "utf8")),
  testsConfig: JSON.parse(readFileSync("tsconfig.tests.json", "utf8")),
  scriptsConfig: JSON.parse(readFileSync("tsconfig.scripts.json", "utf8")),
  architectureConfig: JSON.parse(readFileSync("tsconfig.architecture.json", "utf8")),
});

describe("hosted CI proof topology", () => {
  it("requires the disposable main runtime prerequisite before VQ", () => {
    const command = "node --import tsx scripts/ci/prepare-vq-test-db.mjs";
    for (const replacement of ["echo removed", `# ${command}`, `if false; then ${command}; fi`]) {
      const input = realCiInput();
      input.workflow = input.workflow.replace(command, replacement);
      expect(validateCiTopology(input)).toContain(`workflow does not execute ${command}`);
    }
    const helper = readFileSync("scripts/ci/prepare-engineering-governance-db.mjs", "utf8");
    expect(helper.indexOf("scripts/ci/prepare-vq-test-db.mjs")).toBeGreaterThan(
      helper.indexOf('"drizzle-kit", "push", "--force"')
    );
    expect(helper.indexOf("scripts/ci/prepare-vq-test-db.mjs")).toBeLessThan(
      helper.indexOf('"--estate", "vault-quest", "--apply"')
    );
  });
  it("requires the disposable VQ preparation to use the namespaced journalled runner", () => {
    const command =
      'MINTVAULT_MIGRATION_DATABASE_URL="$TEST_DATABASE_URL" node node_modules/tsx/dist/cli.mjs scripts/db/migrate.ts --estate vault-quest --apply';
    for (const replacement of ["echo removed", `# ${command}`, `if false; then ${command}; fi`]) {
      const input = realCiInput();
      input.workflow = input.workflow.replace(command, replacement);
      expect(validateCiTopology(input)).toContain(`workflow does not execute ${command}`);
    }
    const helper = readFileSync("scripts/ci/prepare-engineering-governance-db.mjs", "utf8");
    expect(helper).not.toContain('readdirSync("migrations-vq")');
    expect(helper).toContain('"--estate", "vault-quest", "--apply"');
    expect(helper).toContain("MINTVAULT_MIGRATION_DATABASE_URL: sharedTestUrl");
    expect(realCiInput().workflow).not.toContain("for migration in migrations-vq/*.sql");
  });
  it.each([
    { kind: "Admin", target: "admin", title: "Super Admin" },
    { kind: "Partner", target: "partner", title: "Partner" },
  ])("requires enabled failure-blocking $kind browser proof after Build on Node20", ({ kind, target, title }) => {
    const command = `node scripts/ci/run-disposable-integration.mjs --docker-context default --${target}-browser-proof`;
    for (const replacement of [
      "run: echo omitted",
      `if: false\n        run: ${command}`,
      `continue-on-error: true\n        run: ${command}`,
    ]) {
      const input = realCiInput();
      input.workflow = input.workflow.replace(`run: ${command}`, replacement);
      expect(validateCiTopology(input)).toContain(`workflow does not execute ${command}`);
    }
    const input = realCiInput();
    const block = `      - name: Owned ${title} browser proof\n        run: ${command}\n`;
    input.workflow = input.workflow.replace(block, "").replace("      - name: Build", `${block}\n      - name: Build`);
    expect(validateCiTopology(input)).toContain(`${kind} browser proof must run after Build and before Node 22`);
  });
  it("requires real object-store proof to remain enabled and failure-blocking", () => {
    const command = "node scripts/ci/run-disposable-integration.mjs --docker-context default --r2-proof";
    for (const replacement of [
      "run: echo removed",
      `if: false\n        run: ${command}`,
      `continue-on-error: true\n        run: ${command}`,
      `run: echo omitted # ${command}`,
    ]) {
      const input = realCiInput();
      input.workflow = input.workflow.replace(`run: ${command}`, replacement);
      expect(validateCiTopology(input)).toContain(`workflow does not execute ${command}`);
    }
  });

  it("wires every authority gate into the real workflow", () => {
    expect(validateCiTopology(realCiInput())).toEqual([]);
    const result = spawnSync(process.execPath, ["scripts/ci/verify-ci-topology.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails when a required command or Scanner dependency edge is removed", () => {
    const missingPartner = realCiInput();
    missingPartner.workflow = missingPartner.workflow.replace("npm run test:partner:critical", "echo removed");
    expect(validateCiTopology(missingPartner)).toContain("workflow does not execute npm run test:partner:critical");

    const detachedScanner = realCiInput();
    detachedScanner.workflow = detachedScanner.workflow.replace("node-version: 22.12.0", "node-version: 20.20.2");
    expect(validateCiTopology(detachedScanner).join(" ")).toMatch(/Scanner proof must run after/);

    const weakenedTypes = realCiInput();
    weakenedTypes.rootConfig.compilerOptions.strict = false;
    expect(validateCiTopology(weakenedTypes)).toContain("root strict must be true");

    const commentedOnly = realCiInput();
    commentedOnly.workflow = commentedOnly.workflow.replace(
      "run: npm run test:partner:critical",
      "run: echo omitted # npm run test:partner:critical"
    );
    expect(validateCiTopology(commentedOnly)).toContain("workflow does not execute npm run test:partner:critical");

    const disabled = realCiInput();
    disabled.workflow = disabled.workflow.replace(
      "- name: Isolated Partner critical matrix",
      "- name: Isolated Partner critical matrix\n        if: false"
    );
    expect(validateCiTopology(disabled)).toContain("workflow does not execute npm run test:partner:critical");

    const disabledJob = realCiInput();
    disabledJob.workflow = disabledJob.workflow.replace(
      "name: Lint, Type Check, Test & Build",
      "name: Lint, Type Check, Test & Build\n    if: false"
    );
    expect(validateCiTopology(disabledJob)).toContain("jobs.check must be enabled and failure-blocking");

    const nonBlockingStep = realCiInput();
    nonBlockingStep.workflow = nonBlockingStep.workflow.replace(
      "run: npm run test:partner:critical",
      "continue-on-error: true\n        run: npm run test:partner:critical"
    );
    expect(validateCiTopology(nonBlockingStep)).toContain("workflow does not execute npm run test:partner:critical");

    const falseExpression = realCiInput();
    falseExpression.workflow = falseExpression.workflow.replace(
      "run: npm run test:partner:critical",
      "if: ${{ false && success() }}\n        run: npm run test:partner:critical"
    );
    expect(validateCiTopology(falseExpression)).toContain("workflow does not execute npm run test:partner:critical");

    const hiddenInShellBranch = realCiInput();
    hiddenInShellBranch.workflow = hiddenInShellBranch.workflow.replace(
      "run: npm run test:partner:critical",
      "run: |\n          if false; then\n            npm run test:partner:critical\n          fi"
    );
    expect(validateCiTopology(hiddenInShellBranch)).toContain(
      "workflow does not execute npm run test:partner:critical"
    );

    const jobShellOverride = realCiInput();
    jobShellOverride.workflow = jobShellOverride.workflow.replace(
      "    steps:",
      "    defaults:\n      run:\n        shell: echo {0}\n    steps:"
    );
    expect(validateCiTopology(jobShellOverride)).toContain("jobs.check may not override run defaults");

    const flowJobShellOverride = realCiInput();
    flowJobShellOverride.workflow = flowJobShellOverride.workflow.replace(
      "    steps:",
      '    defaults: { run: { shell: "echo {0}" } }\n    steps:'
    );
    expect(validateCiTopology(flowJobShellOverride)).toContain("jobs.check may not override run defaults");

    const stepShellOverride = realCiInput();
    stepShellOverride.workflow = stepShellOverride.workflow.replace(
      "run: npm run test:partner:critical",
      "shell: echo {0}\n        run: npm run test:partner:critical"
    );
    expect(validateCiTopology(stepShellOverride)).toContain("workflow does not execute npm run test:partner:critical");

    const expressionContinue = realCiInput();
    expressionContinue.workflow = expressionContinue.workflow.replace(
      "run: npm run test:partner:critical",
      "continue-on-error: ${{ true || false }}\n        run: npm run test:partner:critical"
    );
    expect(validateCiTopology(expressionContinue)).toContain("workflow does not execute npm run test:partner:critical");

    for (const firstProperty of ["shell: echo {0}", "if: false", "continue-on-error: true"]) {
      const firstKeyVariant = realCiInput();
      firstKeyVariant.workflow = firstKeyVariant.workflow.replace(
        "- name: Isolated Partner critical matrix\n        run: npm run test:partner:critical",
        `- ${firstProperty}\n        name: Isolated Partner critical matrix\n        run: npm run test:partner:critical`
      );
      expect(validateCiTopology(firstKeyVariant)).toContain("workflow does not execute npm run test:partner:critical");
    }

    const quotedDisabledJob = realCiInput();
    quotedDisabledJob.workflow = quotedDisabledJob.workflow.replace(
      "name: Lint, Type Check, Test & Build",
      'name: Lint, Type Check, Test & Build\n    "if": false'
    );
    expect(validateCiTopology(quotedDisabledJob)).toContain("jobs.check must be enabled and failure-blocking");

    const quotedDefaults = realCiInput();
    quotedDefaults.workflow = quotedDefaults.workflow.replace(
      "    steps:",
      '    "defaults": { run: { shell: "echo {0}" } }\n    steps:'
    );
    expect(validateCiTopology(quotedDefaults)).toContain("jobs.check may not override run defaults");

    for (const firstProperty of ['"shell": echo {0}', '"if": false', '"continue-on-error": true']) {
      const quotedFirstKey = realCiInput();
      quotedFirstKey.workflow = quotedFirstKey.workflow.replace(
        "- name: Isolated Partner critical matrix\n        run: npm run test:partner:critical",
        `- ${firstProperty}\n        name: Isolated Partner critical matrix\n        run: npm run test:partner:critical`
      );
      expect(validateCiTopology(quotedFirstKey)).toContain("workflow does not execute npm run test:partner:critical");
    }

    const lateRootRuntime = realCiInput();
    const node20Block = lateRootRuntime.workflow.match(
      / {6}- uses: actions\/setup-node@[^\n]+\n {8}with:\n(?: {10}#[^\n]*\n)* {10}node-version: 20\.20\.2\n {10}cache: npm\n/
    )?.[0];
    expect(node20Block).toBeTruthy();
    lateRootRuntime.workflow = lateRootRuntime.workflow
      .replace(node20Block!, "")
      .replace("      - name: Build", `${node20Block}      - name: Build`);
    expect(validateCiTopology(lateRootRuntime).join(" ")).toMatch(/phase order changed|Scanner proof/);
  });

  it("pins all 70 Partner suites to isolated, unique critical execution", () => {
    expect(CRITICAL_SUITES).toHaveLength(70);
    expect(new Set(CRITICAL_SUITES.map((suite) => suite.file))).toHaveProperty("size", 70);
    expect(CRITICAL_SUITES.every((suite) => suite.critical && suite.isolate)).toBe(true);
    for (const key of [
      "TEST_DATABASE_URL",
      "MINTVAULT_DATABASE_URL",
      "PARTNER_ADMIN_DATABASE_URL",
      "PARTNER_DATABASE_URL",
    ]) {
      expect(MANAGED_DATABASE_ENVIRONMENT_KEYS).toContain(key);
    }
    for (const suite of CRITICAL_SUITES) {
      for (const key of [...(suite.adminVars ?? []), ...(suite.runtimeVars ?? [])]) {
        expect(MANAGED_DATABASE_ENVIRONMENT_KEYS).toContain(key);
      }
    }
    const selfProvisioned = CRITICAL_SUITES.find((suite) => suite.topology === "self_provisioned")!;
    const isolated = isolatedSuiteEnvironment(
      { PATH: "/synthetic", TEST_DATABASE_URL: "postgres://leak", PARTNER_RLS_DB: "postgres://leak" },
      selfProvisioned
    );
    expect(isolated.PATH).toBe("/synthetic");
    expect(isolated.TEST_DATABASE_URL).toBeUndefined();
    expect(isolated.PARTNER_RLS_DB).toBeUndefined();
  });
});

describe("Partner and Scanner non-vacuity verdicts", () => {
  const partnerReport = (status: string) => ({
    testResults: [{ name: "/repo/tests/partner-x.test.ts", assertionResults: [{ status }] }],
  });

  it("rejects missing, zero, skipped, failed, and below-floor Partner evidence", () => {
    expect(classifyReport(null, "tests/partner-x.test.ts", 0).verdict).toBe("environment_abort");
    expect(classifyReport({ testResults: [] }, "tests/partner-x.test.ts", 0).verdict).toBe("environment_abort");
    expect(classifyReport(partnerReport("skipped"), "tests/partner-x.test.ts", 0).verdict).toBe("environment_abort");
    expect(classifyReport(partnerReport("failed"), "tests/partner-x.test.ts", 1).verdict).toBe("failed");
    expect(meetsPartnerAggregateFloor(MINIMUM_PARTNER_CRITICAL_ASSERTIONS - 1)).toBe(false);
    expect(meetsPartnerAggregateFloor(MINIMUM_PARTNER_CRITICAL_ASSERTIONS)).toBe(true);
  });

  function passingScannerResults() {
    return Object.entries(SCANNER_SUITE_FLOORS).map(([file, passed]) => ({
      file,
      status: 0,
      tests: passed,
      passed,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    }));
  }

  it("parses TAP and rejects Scanner truncation, skips, failures, and floor loss", () => {
    expect(passingScannerResults()).toHaveLength(EXPECTED_SCANNER_FILES);
    expect(parseTapSummary("# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n")).toEqual({
      tests: 4,
      passed: 4,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    });
    expect(validateScannerResults(passingScannerResults())).toMatchObject({
      ok: true,
      passed: MINIMUM_SCANNER_ASSERTIONS,
    });
    expect(validateScannerResults(passingScannerResults().slice(1)).ok).toBe(false);
    const skipped = passingScannerResults();
    skipped[2].skipped = 1;
    expect(validateScannerResults(skipped).errors.join(" ")).toMatch(/skipped/);
    const belowFloor = passingScannerResults();
    belowFloor[0].passed -= 1;
    belowFloor[0].tests -= 1;
    expect(validateScannerResults(belowFloor).errors.join(" ")).toMatch(/per-file floor/);
    const duplicate = passingScannerResults();
    duplicate[1].file = duplicate[0].file;
    expect(validateScannerResults(duplicate).errors.join(" ")).toMatch(/duplicate|missing/);
    const cancelled = passingScannerResults();
    cancelled[2].cancelled = 1;
    cancelled[2].passed -= 1;
    expect(validateScannerResults(cancelled).errors.join(" ")).toMatch(/cancelled/);
  });

  it("rejects Scanner dependencies leaked from the root workspace", () => {
    const appPath = "/repo/scripts/scanner-app";
    const direct = {
      appPath,
      manifest: { devDependencies: { "happy-dom": "^20.11.1" } },
      lockfile: { packages: { "": { devDependencies: { "happy-dom": "^20.11.1" } } } },
      resolvedHappyDomPath: `${appPath}/node_modules/happy-dom/lib/index.js`,
    };
    expect(validateScannerDependencyIsolation(direct)).toEqual([]);
    expect(
      validateScannerDependencyIsolation({
        ...direct,
        manifest: { devDependencies: {} },
        lockfile: { packages: { "": { devDependencies: {} } } },
        resolvedHappyDomPath: "/repo/node_modules/happy-dom/lib/index.js",
      }).join(" ")
    ).toMatch(/declare happy-dom|lockfile|must resolve/);
  });

  it("binds Partner evidence to the exact per-suite floor instead of a distributable aggregate", () => {
    const floors = { "tests/a.test.ts": 10, "tests/b.test.ts": 20 };
    expect(
      validatePartnerSuiteFloors(
        [
          { file: "tests/a.test.ts", passed: 10 },
          { file: "tests/b.test.ts", passed: 20 },
        ],
        floors
      ).ok
    ).toBe(true);
    expect(
      validatePartnerSuiteFloors(
        [
          { file: "tests/a.test.ts", passed: 1 },
          { file: "tests/b.test.ts", passed: 29 },
        ],
        floors
      ).errors.join(" ")
    ).toMatch(/tests\/a\.test\.ts: per-suite floor/);
  });
});

describe("migration and TypeScript debt classification", () => {
  it("classifies every real SQL reference without calling VQ shipped", () => {
    const policy = JSON.parse(readFileSync("scripts/ci/migration-reference-policy.json", "utf8"));
    const report = buildMigrationReferenceReport(process.cwd(), policy);
    expect(report.violations).toEqual([]);
    expect(report.inventory).toMatchObject({ shippedMain: 86, vqUnshippedOwnerDecision: 17 });
    expect(
      report.classifications.filter((entry) => entry.disposition === "unshipped-owner-decision-required").length
    ).toBeGreaterThan(0);
    expect(report.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "0111_partner_supply_commerce.sql", disposition: "historical-unshipped" }),
        expect.objectContaining({ name: "0001_x.sql", disposition: "synthetic-test-reference" }),
        expect.objectContaining({ name: "add-mvgs-v2-columns-prod.sql", disposition: "legacy-operator-unshipped" }),
      ])
    );
  });

  it("rejects a newly invented unshipped migration reference", () => {
    const root = mkdtempSync(join(tmpdir(), "mintvault-migration-policy-"));
    const unknownName = "9999" + "_unclassified.sql";
    for (const path of [
      `migrations/${"0001" + "_real.sql"}`,
      `migrations-vq/${"0000" + "_fixture.sql"}`,
      "tests/proof.test.ts",
    ]) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, path.endsWith(".ts") ? `const name = "${unknownName}";\n` : "SELECT 1;\n");
    }
    const report = buildMigrationReferenceReport(root, {
      legacyForwardFixtures: {},
      legacyOperatorReferences: {},
      syntheticReferences: {},
      historicalUnshippedReferences: {},
      vqDirectoryDisposition: "unshipped-owner-decision-required",
    });
    expect(report.violations).toEqual([
      expect.objectContaining({ code: "UNCLASSIFIED_MIGRATION_REFERENCE", name: unknownName }),
    ]);
  });

  it("uses the canonical migration suffix predicate and a non-vacuous script inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "mintvault-migration-suffix-"));
    const dottedMigration = "10000" + "_foo.bar.sql";
    const vqFixture = "0000" + "_fixture.sql";
    for (const path of [`migrations/${dottedMigration}`, `migrations-vq/${vqFixture}`, "tests/proof.test.ts"]) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, path.endsWith(".ts") ? `const migration="${dottedMigration}";\n` : "SELECT 1;\n");
    }
    expect(
      buildMigrationReferenceReport(root, {
        legacyForwardFixtures: {},
        legacyOperatorReferences: {},
        syntheticReferences: {},
        historicalUnshippedReferences: {},
        vqDirectoryDisposition: "unshipped-owner-decision-required",
      }).classifications
    ).toEqual([expect.objectContaining({ name: dottedMigration, disposition: "shipped-main" })]);

    const files = ["scripts/a.mjs"];
    const hash = createHash("sha256").update(files.join("\n")).digest("hex");
    expect(validateScriptSyntaxInventory(files, { schemaVersion: 1, fileCount: 1, filesSha256: hash, files })).toEqual({
      ok: true,
      filesSha256: hash,
    });
    expect(validateScriptSyntaxInventory([], { schemaVersion: 1, fileCount: 0, filesSha256: hash, files: [] }).ok).toBe(
      false
    );
    expect(trackedJavaScriptFiles()).toEqual(
      expect.arrayContaining([
        "scripts/hot-folder-watcher.js",
        "scripts/seed-vq-character-bible.mjs",
        "scripts/scanner-app/main.js",
      ])
    );
  });

  it("accepts diagnostic reductions but rejects any new TypeScript fingerprint", () => {
    const baseline = {
      fingerprints: [{ fingerprint: "tests/a.ts|TS2322|Type 'x' is not assignable", count: 2 }],
    };
    expect(parseDiagnostics("tests/a.ts(1,2): error TS2322: Type 'x' is not assignable\n")).toEqual([
      { fingerprint: "tests/a.ts|TS2322|Type 'x' is not assignable", count: 1 },
    ]);
    expect(
      compareDiagnosticBaseline(baseline, parseDiagnostics("tests/a.ts(1,2): error TS2322: Type 'x' is not assignable"))
        .ok
    ).toBe(true);
    expect(
      compareDiagnosticBaseline(baseline, parseDiagnostics("tests/b.ts(1,2): error TS7006: implicit any")).ok
    ).toBe(false);
  });

  it("rejects noCheck, covered-root exclusions, compiler/config drift, and no-check growth", () => {
    const root = { compilerOptions: { strict: true } };
    const child = { include: ["tests/**/*.ts", "tests/**/*.tsx"], exclude: [] as string[], compilerOptions: {} };
    expect(validateTypecheckConfiguration(root, child, "tests")).toEqual([]);
    expect(
      validateTypecheckConfiguration(root, { ...child, compilerOptions: { noCheck: true } }, "tests").join(" ")
    ).toMatch(/noCheck/);
    expect(validateTypecheckConfiguration(root, { ...child, exclude: ["tests/**/*"] }, "tests").join(" ")).toMatch(
      /exclude/
    );
    const contract = {
      compilerVersion: "5.6.3",
      configSha256: "a",
      trackedFileCount: 2,
      trackedFilesSha256: "b",
      noCheckFileCount: 0,
      noCheckFiles: [],
      noCheckFilesSha256: "c",
    };
    expect(compareTypecheckContract(contract, contract).ok).toBe(true);
    expect(compareTypecheckContract(contract, { ...contract, trackedFileCount: 0 }).ok).toBe(false);
    expect(compareTypecheckContract(contract, { ...contract, noCheckFileCount: 1 }).ok).toBe(false);
    expect(
      compareTypecheckContract(
        { ...contract, noCheckFileCount: 5, noCheckFiles: ["a", "b", "c", "d", "e"] },
        { ...contract, noCheckFileCount: 1, noCheckFiles: ["critical-new.ts"] }
      ).ok
    ).toBe(false);
  });
});
