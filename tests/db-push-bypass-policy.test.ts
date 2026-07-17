/**
 * Phase 0.5 — Official-command bypass policy.
 *
 * Guards against a `drizzle-kit push` (or db:push) route that skips the host guard in any
 * MAINTAINED project script or CI config. A determined developer can always invoke a
 * dependency binary by hand; this test ensures no OFFICIAL workflow does.
 *
 * Rules:
 *  - package.json: the `db:push` script must route through the guard (tsx guard-db-push.ts).
 *    No other npm script may contain a raw `drizzle-kit push`.
 *  - .github/workflows and scripts/*.sh: any `drizzle-kit push` occurrence is allowed ONLY
 *    in a file that also asserts a disposable local database (contains the disposable port
 *    55432 or the word "disposable"). Otherwise it is a prohibited unguarded route.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

describe("db:push bypass policy", () => {
  it("package.json db:push routes through the guard and no script uses raw drizzle-kit push", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:push"]).toMatch(/guard-db-push\.ts/);
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name === "db:push") continue;
      expect(cmd, `script "${name}" must not invoke drizzle-kit push directly`).not.toMatch(/drizzle-kit\s+push/);
    }
  });

  it("no CI workflow or shell script pushes schema to a non-disposable database", () => {
    const files = [
      ...walk(join(ROOT, ".github", "workflows"), [".yml", ".yaml"]),
      ...walk(join(ROOT, "scripts"), [".sh"]),
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      if (/drizzle-kit\s+push/.test(content)) {
        const disposableContext = /55432|disposable/i.test(content);
        if (!disposableContext) offenders.push(f);
      }
    }
    expect(offenders, `these files invoke drizzle-kit push without a disposable-DB context: ${offenders.join(", ")}`).toEqual([]);
  });
});
