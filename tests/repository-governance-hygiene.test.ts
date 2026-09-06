import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("repository PR and CI governance", () => {
  it("uses the product package identity and cannot be published accidentally", () => {
    const manifest = JSON.parse(read("package.json"));
    const lockfile = JSON.parse(read("package-lock.json"));

    expect(manifest.private).toBe(true);
    expect(lockfile.packages[""].private).toBe(true);
    expect(manifest.name).toBe("mintvault-platform");
    expect(lockfile.name).toBe("mintvault-platform");
    expect(lockfile.packages[""].name).toBe("mintvault-platform");
    expect(manifest.engines?.node).toBe("20.20.2");
    expect(lockfile.packages[""].engines?.node).toBe("20.20.2");
    expect(read(".nvmrc").trim()).toBe("20.20.2");
  });

  it("pins every third-party GitHub Action to an immutable commit", () => {
    const workflowDirectory = join(ROOT, ".github/workflows");
    const workflows = readdirSync(workflowDirectory)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      // This file is generated and hash-controlled by Cornelius Engineering OS
      // 1.0.13. Direct edits are correctly rejected as managed drift; its Action
      // pins must land in the upstream generator and a new immutable OS release.
      .filter((file) => file !== "engineering-governance.yml")
      .map((file) => ({ file, source: readFileSync(join(workflowDirectory, file), "utf8") }));

    const mutable: string[] = [];
    for (const workflow of workflows) {
      for (const match of workflow.source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
        const action = match[1];
        if (action.startsWith("./")) continue;
        if (!/@[0-9a-f]{40}$/i.test(action)) mutable.push(`${workflow.file}: ${action}`);
      }
    }

    expect(mutable, "Actions referenced by a tag or branch can be changed upstream").toEqual([]);
  });

  it("keeps CI least-privilege, supersession-safe, and HIGH findings blocking", () => {
    const ci = read(".github/workflows/ci.yml");
    const engineering = read(".github/workflows/engineering-governance.yml");

    expect(ci).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(ci).toMatch(/^concurrency:\n[\s\S]*?cancel-in-progress: true$/m);
    expect(engineering).toContain("# cornelius-engineering-os:begin id=ci-governance v=1");
    expect(ci).toContain("npm audit --audit-level=high");
    expect(ci).not.toMatch(/Audit \(high severity\)[\s\S]{0,160}continue-on-error:\s*true/);
    expect(ci).toContain("fail-on-severity: high");
    expect(ci).toContain("timeout-minutes: 90");
    expect(ci).toContain("node-version: 20.20.2");
    expect(ci).not.toContain("matrix.language");
    expect(ci).not.toContain("- server/scripts/**");
    expect(ci.match(/persist-credentials: false/g)?.length).toBe(5);

    for (const node24Action of [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1 (Node 24)",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0 (Node 24)",
      "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0 (Node 24)",
      "gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0 (Node 24)",
      "github/codeql-action/init@cdf488f595d80d6e07e03d4674febd5ab45fa938 # v4.37.9 (Node 24)",
      "github/codeql-action/analyze@cdf488f595d80d6e07e03d4674febd5ab45fa938 # v4.37.9 (Node 24)",
      "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0 (Trivy 0.70.0)",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1 (Node 24)",
    ]) {
      expect(ci).toContain(node24Action);
    }

    const workflowSource = ci;
    const serviceImages = [...workflowSource.matchAll(/^\s*image:\s*(\S+)$/gm)].map((match) => match[1]);
    expect(serviceImages.length).toBeGreaterThan(0);
    expect(serviceImages.every((image) => /@sha256:[0-9a-f]{64}$/i.test(image))).toBe(true);

    const publicCliImages = workflowSource
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(?:postgres|node|pgvector\/pgvector):[A-Za-z0-9]/.test(line))
      .map((line) => line.replace(/\s*\\$/, ""));
    expect(publicCliImages.every((image) => /@sha256:[0-9a-f]{64}$/i.test(image))).toBe(true);
  });

  it("routes both production and staging traffic only to release-ready machines", () => {
    for (const config of ["fly.toml", "fly.v2.toml"]) {
      const source = read(config);
      expect(source).toMatch(/\[\[http_service\.checks\]\][\s\S]*?path = "\/ready"/);
      expect(source).not.toMatch(/\[\[http_service\.checks\]\][\s\S]*?path = "\/health"/);
      expect(source).toContain('grace_period = "60s"');
      expect(source).toContain('wait_timeout = "5m"');
    }
  });

  it("requires accountable ownership and consequence-bearing review evidence", () => {
    const owners = read(".github/CODEOWNERS");
    const template = read(".github/pull_request_template.md");
    const controls = read("docs/runbooks/github-repository-controls.md");
    const ci = read(".github/workflows/ci.yml");

    expect(owners).toMatch(/^\*\s+@mintvaultuk-byte$/m);
    for (const protectedPath of [
      "/.github/",
      "/.engineering/",
      "/migrations/",
      "/server/webhookHandlers.ts",
      "/server/partner/",
      "/server/scan-ingest-service.ts",
      "/shared/mvgs/",
    ]) {
      expect(owners).toContain(protectedPath);
    }

    for (const evidence of ["Independent hostile review", "exact commit SHA", "does not authorize deployment"]) {
      expect(template).toContain(evidence);
    }
    expect(template).not.toMatch(/dragon[ -]?coil/i);
    for (const requiredCheck of [
      "Lint, Type Check, Test & Build",
      "PR dependency review",
      "Secret scan (gitleaks)",
      "CodeQL (SAST)",
      "linux/amd64 image build & boot",
      "engineering-check",
    ]) {
      expect(controls).toContain(`\`${requiredCheck}\``);
    }
    expect(controls).toContain("Repository settings are external state");
    expect(controls).toContain("Do not enable a merge queue until");
    expect(controls).toContain("Observed live state — 2026-08-30");
    expect(controls).toContain("do not provide independent, consequence-bearing review");
    expect(controls).toContain("old matrix-suffixed CodeQL context will not match");
    expect(ci).toContain("format: cyclonedx");
    expect(ci).toContain("severity: HIGH,CRITICAL");
    expect(ci).toContain("ignore-unfixed: true");
    expect(ci).toContain("exit-code: 1");
    expect(controls).toContain("Build-once registry promotion and signed provenance remain owner-controlled");
  });

  it("only configures Dependabot for npm manifests that exist", () => {
    const dependabot = read(".github/dependabot.yml");

    expect(dependabot).not.toContain('directory: "/scripts/cricut-app"');
    for (const directory of [
      "/",
      "/scripts/scanner-app",
      "/scripts/scanner-watcher",
      "/scripts/scanner-watcher/guide-window",
    ]) {
      expect(dependabot).toContain(`directory: "${directory}"`);
    }
  });

  it("contains no identifiers from the unrelated product namespace", () => {
    const roots = [".github", "client", "docs", "migrations", "scripts", "server", "shared", "tests"];
    const textExtensions = new Set([
      ".cjs",
      ".css",
      ".html",
      ".js",
      ".json",
      ".md",
      ".mjs",
      ".sql",
      ".ts",
      ".tsx",
      ".yaml",
      ".yml",
    ]);
    const unrelatedName = ["dragon", "coil"].join("[ _-]?");
    const forbidden = new RegExp(unrelatedName, "i");
    const ignoredDirectories = new Set([".cache", ".git", "coverage", "dist", "node_modules"]);
    const offenders: string[] = [];

    const visit = (relativePath: string) => {
      for (const entry of readdirSync(join(ROOT, relativePath), { withFileTypes: true })) {
        const child = join(relativePath, entry.name);
        if (entry.isDirectory()) {
          if (ignoredDirectories.has(entry.name)) continue;
          visit(child);
          continue;
        }
        const extension = entry.name.slice(entry.name.lastIndexOf("."));
        if (textExtensions.has(extension) && forbidden.test(read(child))) offenders.push(child);
      }
    };

    for (const root of roots) visit(root);
    expect(offenders, "unrelated product identifiers must not re-enter MintVault").toEqual([]);
  }, 15_000);
});
