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
const BUILD_SCRIPT = readFileSync(join(ROOT, "script/build.ts"), "utf8");

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
