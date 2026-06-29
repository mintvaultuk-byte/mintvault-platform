import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Guard (Phase 4 follow-up): every static file the server reads from disk at
 * RUNTIME via process.cwd() must be packaged into the production Docker image.
 *
 * The bug this prevents: content/legal/*.md (read by the legal routes) and
 * server/brand-logo.png (packing-slip logo) were read at runtime but never
 * COPYied into the prod image — legal pages 500'd and the slip logo silently
 * dropped. A new runtime-read asset under an un-copied root now fails here
 * instead of in production.
 *
 * Out of scope (correct by construction): reads built from import.meta.dirname /
 * __dirname — the dev-only Vite middleware reading client/, and static.ts
 * reading dist/public/index.html (dist/ is always the build output, copied).
 */
const ROOT = process.cwd();

function serverTsFiles(dir = path.join(ROOT, "server")): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...serverTsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// cwd-relative top-level roots read from disk at runtime, e.g.
// path.join(process.cwd(), "content", "legal", ...) -> "content".
function runtimeAssetRoots(): Map<string, string[]> {
  const re = /process\.cwd\(\)\s*,\s*["'`]([^"'`]+)["'`]/g;
  const roots = new Map<string, string[]>();
  for (const file of serverTsFiles()) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      const root = m[1];
      const rel = path.relative(ROOT, file);
      const sites = roots.get(root) ?? [];
      if (!sites.includes(rel)) sites.push(rel);
      roots.set(root, sites);
    }
  }
  return roots;
}

// Top-level paths COPYied into the PRODUCTION stage of the Dockerfile.
function prodImageCopiedRoots(): Set<string> {
  const df = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const prod = df.slice(df.indexOf("AS production"));
  const roots = new Set<string>();
  for (const m of prod.matchAll(/COPY --from=builder \/app\/(\S+)/g)) {
    roots.add(m[1].split("/")[0]);
  }
  return roots;
}

describe("prod Docker image packages all runtime-read disk assets", () => {
  it("copies every cwd-relative asset root the server reads at runtime", () => {
    const copied = prodImageCopiedRoots();
    const missing: string[] = [];
    for (const [root, sites] of runtimeAssetRoots()) {
      if (!copied.has(root)) missing.push(`${root} (read by ${sites.join(", ")})`);
    }
    expect(missing, `runtime-read asset roots not COPYied into the prod image: ${missing.join("; ")}`).toEqual([]);
  });

  it("explicitly packages content/ and server/brand-logo.png (Phase 4 follow-up)", () => {
    const df = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    expect(df).toMatch(/COPY --from=builder \/app\/content \.\/content\b/);
    expect(df).toMatch(/COPY --from=builder \/app\/server\/brand-logo\.png \.\/server\/brand-logo\.png\b/);
  });

  it("the assets those COPY lines rely on exist in the repo", () => {
    expect(fs.existsSync(path.join(ROOT, "content", "legal"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "server", "brand-logo.png"))).toBe(true);
  });
});
