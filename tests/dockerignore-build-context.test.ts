/**
 * The Docker build context must contain every file the Dockerfile's build actually needs.
 *
 * THE DEFECT THIS PINS (found during the PR #269 landing, 2026-07-29):
 * `.dockerignore` excludes almost all of `scripts/` — deliberately, it saves ~513 MB of build
 * context — and re-admits individual files with `!` entries. `scripts/db/migrate.ts` then gained
 * `import { toDirectEndpoint } from "./read-only-session"`, but no `!` entry was added for it.
 *
 * Nothing caught it. `npm run build` in CI runs against the WHOLE repository, so it resolved the
 * import fine and CI was green. The allowlist is only ever applied inside the Dockerfile, so the
 * failure appeared for the first time at DEPLOY time:
 *
 *   ✘ [ERROR] Could not resolve "./read-only-session"
 *     scripts/db/migrate.ts:33:33
 *
 * i.e. a green CI run did not mean a deployable commit. This test closes that gap statically: it
 * follows the relative imports of every allowlisted script and asserts each one is itself
 * allowlisted, so the omission fails in CI instead of on the Fly builder.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const DOCKERIGNORE = readFileSync(join(ROOT, ".dockerignore"), "utf8");
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const BUILD_SCRIPT = readFileSync(join(ROOT, "script/build.ts"), "utf8");
const CI_WORKFLOW = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

const REQUIRED_PRIVACY_RULES = [
  ".local",
  "**/.local",
  "mintvault-scans",
  "**/mintvault-scans",
  ".mintvault-scanner-tools",
  "**/.mintvault-scanner-tools",
  "scans",
  "**/scans",
  "scanner-data",
  "**/scanner-data",
  "scanner-output",
  "**/scanner-output",
  "scanner-runtime",
  "**/scanner-runtime",
  "evidence",
  "**/evidence",
  "runtime-evidence",
  "**/runtime-evidence",
  "backups",
  "**/backups",
  ".agents",
  ".codex",
  ".cursor",
  ".gemini",
  ".windsurf",
  "*.tif",
  "**/*.tif",
  "*.tiff",
  "**/*.tiff",
  "*.raw",
  "**/*.raw",
  "*.dng",
  "**/*.dng",
  "*.heic",
  "**/*.heic",
  "*.heif",
  "**/*.heif",
] as const;

const CI_PRIVACY_SENTINELS = [
  ".local/canon-lide-physical-proof/DO_NOT_SHIP.tiff",
  ".agents/DO_NOT_SHIP.txt",
  ".codex/DO_NOT_SHIP.txt",
  "mintvault-scans/DO_NOT_SHIP.tiff",
  ".mintvault-scanner-tools/DO_NOT_SHIP.pem",
  "evidence/masters/DO_NOT_SHIP.tiff",
  "server/.local/DO_NOT_SHIP.tiff",
  "server/DO_NOT_SHIP.tiff",
  ".env.context-sentinel",
] as const;

function dockerignoreRules(): Set<string> {
  return new Set(
    DOCKERIGNORE.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  );
}

/** Files under scripts/ explicitly re-admitted to the build context with a `!` entry. */
function allowlistedScripts(): string[] {
  return DOCKERIGNORE.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("!") && !l.startsWith("!#"))
    .map((l) => l.slice(1))
    .filter((p) => p.startsWith("scripts/") && p.endsWith(".ts"));
}

/** Relative imports/exports of a TypeScript file, resolved to repo-relative .ts paths. */
function relativeDeps(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  const dir = file.slice(0, file.lastIndexOf("/"));
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map((m) => m[1]);
  return specs.map((s) => {
    const parts = (dir + "/" + s).split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === "." || p === "") continue;
      if (p === "..") out.pop();
      else out.push(p);
    }
    const base = out.join("/");
    return base.endsWith(".ts") ? base : `${base}.ts`;
  });
}

describe("the Docker build context contains everything the build imports", () => {
  it("re-admits at least the known entrypoints", () => {
    const allow = allowlistedScripts();
    expect(allow).toContain("scripts/db/migrate.ts");
    expect(allow).toContain("scripts/db/lint-destructive-sql.ts");
  });

  it("every relative import of an allowlisted script is ALSO allowlisted", () => {
    const allow = new Set(allowlistedScripts());
    const seen = new Set<string>();
    const queue = [...allow];
    const missing: string[] = [];

    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!existsSync(join(ROOT, file))) continue;
      for (const dep of relativeDeps(file)) {
        if (!existsSync(join(ROOT, dep))) continue; // type-only / generated — not a context problem
        // Only scripts/ is filtered by the allowlist; other trees are copied wholesale.
        if (dep.startsWith("scripts/") && !allow.has(dep)) {
          missing.push(`${file} imports ${dep}, which .dockerignore does not re-admit`);
        }
        queue.push(dep);
      }
    }

    expect(
      missing,
      `Docker build context is missing files the build imports — this fails on the Fly builder, ` +
        `NOT in CI, because CI builds the whole repo:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });

  it("re-admits every scripts entrypoint bundled by the build", () => {
    const allow = new Set(allowlistedScripts());
    const entrypoints = [...BUILD_SCRIPT.matchAll(/entryPoints:\s*\[\s*["'](scripts\/[^"']+\.ts)["']/g)].map(
      (match) => match[1]
    );

    expect(entrypoints.length).toBeGreaterThan(0);
    expect(
      entrypoints.filter((entrypoint) => !allow.has(entrypoint)),
      "script/build.ts bundles a scripts entrypoint that .dockerignore does not re-admit"
    ).toEqual([]);
  });

  it("specifically re-admits read-only-session.ts, which migrate.ts needs", () => {
    // The exact omission that broke the first staging deploy of this landing.
    expect(readFileSync(join(ROOT, "scripts/db/migrate.ts"), "utf8")).toContain('from "./read-only-session"');
    expect(allowlistedScripts()).toContain("scripts/db/read-only-session.ts");
  });
});

describe("the Docker build context excludes local private and agent state", () => {
  it("explicitly denies every protected local artefact class", () => {
    const rules = dockerignoreRules();

    expect(
      REQUIRED_PRIVACY_RULES.filter((rule) => !rules.has(rule)),
      "A privacy-critical Docker exclusion disappeared"
    ).toEqual([]);
  });

  it("fails the real image build if a forbidden path survives COPY", () => {
    const copyIndex = DOCKERFILE.indexOf("COPY . .");
    const guardIndex = DOCKERFILE.indexOf("Forbidden Docker build-context path was copied");

    expect(copyIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(copyIndex);
    for (const path of [".local", ".agents", ".codex", "mintvault-scans", "evidence"]) {
      expect(DOCKERFILE).toContain(path);
    }
    expect(DOCKERFILE).toContain("Forbidden nested Docker build-context artifact was copied");
  });

  it("plants content-free privacy sentinels before CI's real Docker build", () => {
    const sentinelStepIndex = CI_WORKFLOW.indexOf("Plant forbidden build-context sentinels");
    const dockerBuildIndex = CI_WORKFLOW.indexOf("docker build --build-arg GIT_SHA");

    expect(sentinelStepIndex).toBeGreaterThan(-1);
    expect(dockerBuildIndex).toBeGreaterThan(sentinelStepIndex);
    for (const path of CI_PRIVACY_SENTINELS) {
      expect(CI_WORKFLOW).toContain(path);
    }
  });

  it("pins both image stages to the Node version exercised by release CI", () => {
    const amd64Job = CI_WORKFLOW.slice(CI_WORKFLOW.indexOf("  amd64-release-proof:"));

    expect(DOCKERFILE.match(/^FROM node:[^ ]+ AS \w+$/gm)).toEqual([
      "FROM node:20.20.2-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder",
      "FROM node:20.20.2-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS production",
    ]);
    expect(DOCKERFILE).toContain("RUN npm prune --omit=dev && npm cache clean --force");
    expect(DOCKERFILE).toMatch(/^FROM builder AS schema-tool$/m);
    expect(DOCKERFILE).toMatch(/^FROM builder AS production-dependencies$/m);
    expect(DOCKERFILE).toMatch(/^USER node$/m);
    expect(CI_WORKFLOW).toContain("production container runs as root");
    expect(CI_WORKFLOW).toContain("test ! -w /app && test -w /tmp");
    expect(CI_WORKFLOW).toContain('GIT_SHA="$(git rev-parse HEAD)"');
    expect(CI_WORKFLOW).not.toContain("git rev-parse --short HEAD");
    expect(CI_WORKFLOW).toContain("mintvault-${{ github.sha }}.cdx.json");
    expect(CI_WORKFLOW).toContain("Block fixable HIGH or CRITICAL production-image vulnerabilities");
    expect(amd64Job).toContain("timeout-minutes: 60");
    expect(CI_WORKFLOW).toContain("Converge the disposable database through real schema and migration authority");
    expect(CI_WORKFLOW).toContain("--target schema-tool");
    expect(CI_WORKFLOW).toContain("run db:push -- --force");
    expect(CI_WORKFLOW).toContain("/app/dist/migrate.cjs --apply --allow-destructive");
    expect(amd64Job).not.toContain("CREATE TABLE IF NOT EXISTS certificates");
    expect(amd64Job.match(/docker run -d --name mv-amd64-boot/g)?.length).toBe(2);
    expect(amd64Job.match(/PARTNER_DATABASE_URL=/g)?.length).toBe(2);
    expect(amd64Job.match(/PARTNER_MFA_ENC_KEY=/g)?.length).toBe(2);
    expect(amd64Job).toContain(
      "CREATE ROLE partner_ci_runtime LOGIN PASSWORD 'synthetic' INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
    );
    expect(amd64Job).toContain("GRANT partner_runtime TO partner_ci_runtime");
    expect(amd64Job).not.toContain('PARTNER_DATABASE_URL="postgres://postgres:postgres@');
    expect(amd64Job).toContain("Release order is migrate, then boot");
    expect(CI_WORKFLOW).toContain(
      "pgvector/pgvector:pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f"
    );
  });
});
