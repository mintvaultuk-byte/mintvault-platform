/**
 * PUBLIC/SERVER BOUNDARY — the MVGS engine and the database schema must never
 * reach a browser bundle.
 *
 * WHAT WENT WRONG
 * ==========================================================================
 * `shared/schema.ts` is a barrel holding ~40 `pgTable(...)` calls. Those are
 * side-effectful module-scope expressions, so no bundler can tree-shake them:
 * importing ONE value from that file pulls the WHOLE file. `client/src/App.tsx`
 * loads `pages/home.tsx` EAGERLY (not lazily), and home.tsx did
 * `import { pricingTiers } from "@shared/schema"`. That single line put every
 * internal database column name — `eye_appeal_modifier`, `centering_front_lr`,
 * `grade_approved_at`, `cert_counter`, `pipeline_settings` — into the entry
 * chunk served to every unauthenticated visitor. The barrel also did
 * `import { mvgsTierName } from "./mvgs-scoring"`, which dragged the scoring
 * engine's module boundary into that same public chunk.
 *
 * THE FIX IS STRUCTURAL, NOT COSMETIC
 * ==========================================================================
 * Client-safe values were split into LEAF modules that import nothing
 * proprietary — shared/grade-presentation.ts, shared/commerce.ts,
 * shared/vocabulary.ts — and the barrel re-exports them so no server call site
 * changed. The browser is told WHAT a grade is; it is never told HOW.
 *
 * These tests fail if any of that is undone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every .ts/.tsx file under client/src. */
function clientFiles(): string[] {
  return execFileSync("git", ["ls-files", "client/src"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f));
}

/**
 * Modules a browser bundle must never take a VALUE from. A `import type` is
 * erased at compile time and is therefore allowed — it is only value imports
 * that create a runtime edge and pull the module in.
 */
const SERVER_ONLY_MODULES = [
  "@shared/schema", // the un-tree-shakeable Drizzle barrel
  "@shared/mvgs-scoring", // the proprietary scoring engine
  "@shared/centering", // the centering band tables
  "@shared/pristine", // the Pristine / Black Label gate
  "@shared/mvgs-input-builder", // the engine's input assembler
];

/** Value specifiers a file imports from `module`, ignoring `type` specifiers. */
function valueImportsOf(src: string, module: string): string[] {
  const re = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${module.replace("/", "\\/")}["']`, "gs");
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) continue; // `import type { ... }` — erased
    for (const spec of m[2].split(",")) {
      const s = spec.trim();
      if (s && !s.startsWith("type ")) found.push(s);
    }
  }
  // A bare side-effect or namespace import is also a runtime edge.
  if (new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s*["']${module.replace("/", "\\/")}["']`).test(src))
    found.push("* namespace import");
  if (new RegExp(`import\\s+["']${module.replace("/", "\\/")}["']`).test(src)) found.push("side-effect import");
  return found;
}

describe("client may not take a runtime dependency on the schema barrel or the engine", () => {
  for (const module of SERVER_ONLY_MODULES) {
    it(`no file under client/src imports a VALUE from ${module}`, () => {
      const offenders: string[] = [];
      for (const f of clientFiles()) {
        const hits = valueImportsOf(read(f), module);
        if (hits.length) offenders.push(`${f} → { ${hits.join(", ")} }`);
      }
      expect(
        offenders,
        `These value imports pull ${module} into a browser bundle. Import the client-safe leaf instead:\n` +
          "  grade constants  → @shared/grade-presentation\n" +
          "  pricing/status   → @shared/commerce\n" +
          "  vocabularies     → @shared/vocabulary\n" +
          "A `import type { … }` is fine — it is erased.\n" +
          offenders.join("\n")
      ).toEqual([]);
    });
  }

  it("the eagerly-loaded public pages are clean — this is the path that leaked", () => {
    const app = read("client/src/App.tsx");
    // Pages imported WITHOUT lazy() land in the entry chunk every visitor downloads.
    const eager = [...app.matchAll(/^import\s+(\w+)\s+from\s+"@\/pages\/([\w-]+)"/gm)].map((m) => m[2]);
    expect(eager.length, "expected App.tsx to still import some pages eagerly").toBeGreaterThan(0);
    for (const page of eager) {
      for (const ext of [".tsx", ".ts"]) {
        const p = `client/src/pages/${page}${ext}`;
        if (!existsSync(join(ROOT, p))) continue;
        for (const module of SERVER_ONLY_MODULES) {
          expect(valueImportsOf(read(p), module), `${p} is EAGER and imports a value from ${module}`).toEqual([]);
        }
      }
    }
  });
});

describe("the leaf modules are genuinely leaves", () => {
  const LEAVES = ["shared/grade-presentation.ts", "shared/commerce.ts", "shared/vocabulary.ts"];

  for (const leaf of LEAVES) {
    it(`${leaf} imports nothing proprietary and no database machinery`, () => {
      const raw = read(leaf);
      // Strip comments first: these files' headers explain the pgTable bundling
      // problem in prose, and a doc comment is not a table declaration.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const imports = [...src.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
      const forbidden = imports.filter((i) =>
        /drizzle|mvgs-scoring|centering|pristine|mvgs-input-builder|\.\/schema|@shared\/schema/.test(i)
      );
      expect(forbidden, `${leaf} must not import: ${forbidden.join(", ")}`).toEqual([]);
      // And it must not declare a table.
      expect(src).not.toMatch(/pgTable\s*\(/);
    });
  }

  it("the schema barrel no longer imports the scoring engine", () => {
    const schema = read("shared/schema.ts");
    expect(schema).not.toMatch(/from\s*["']\.\/mvgs-scoring["']/);
    expect(schema).not.toMatch(/from\s*["']\.\/centering["']/);
    expect(schema).not.toMatch(/from\s*["']\.\/pristine["']/);
  });

  it("mvgsTierName still has exactly ONE definition — no ladder duplication", () => {
    // `git grep` skips untracked files, which would silently pass on a branch
    // where the new leaf has not been added yet. Scan the working tree instead.
    const defs = execFileSync(
      "sh",
      ["-c", "grep -rl 'export function mvgsTierName' shared server client/src || true"],
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(defs, `mvgsTierName defined in more than one place: ${defs.join(", ")}`).toEqual([
      "shared/grade-presentation.ts",
    ]);
    // The engine re-exports it, so every existing server call site is unchanged.
    expect(read("shared/mvgs-scoring.ts")).toContain('export { mvgsTierName } from "./grade-presentation";');
  });
});

describe("built bundle contains no proprietary grading implementation", () => {
  const ASSETS = join(ROOT, "dist/public/assets");
  const built = existsSync(ASSETS);
  const chunks = built ? readdirSync(ASSETS).filter((f) => f.endsWith(".js")) : [];

  /** Identifiers that only ever appear IN the scoring engine. */
  const ENGINE_ONLY = [
    "forceCap74", // CR crease hard cap
    "maxBigger", // centering band table entries
    "varianceThreshold", // the v1.4 floor rule
    "HIGH_VARIANCE_GAP",
    "MAX_SUBGRADE_GAP_PER_CATEGORY",
    "backMultiplier", // back-surface x0.5
    "tearForceNotGraded",
    "computeMvgsScore",
    "scoreMvgsV2",
    "gradeFromMvgsScore",
    "remainingToGrade",
    "centeringAxisGrade",
    "centeringSubgrade",
    "isPristine",
  ];

  /** Internal database identifiers that must not be published. */
  const SCHEMA_ONLY = ["cert_counter", "pipeline_settings", "admin_audit_log", "mvgs_rules_version"];

  it.skipIf(!built)("no chunk contains the scoring engine", () => {
    const leaks: string[] = [];
    for (const c of chunks) {
      const src = readFileSync(join(ASSETS, c), "utf8");
      for (const id of ENGINE_ONLY) if (src.includes(id)) leaks.push(`${c} contains ${id}`);
    }
    expect(leaks, `proprietary scoring implementation reached a browser bundle:\n${leaks.join("\n")}`).toEqual([]);
  });

  it.skipIf(!built)("no chunk contains internal database schema identifiers", () => {
    const leaks: string[] = [];
    for (const c of chunks) {
      const src = readFileSync(join(ASSETS, c), "utf8");
      for (const id of SCHEMA_ONLY) if (src.includes(id)) leaks.push(`${c} contains ${id}`);
    }
    expect(leaks, `internal database schema reached a browser bundle:\n${leaks.join("\n")}`).toEqual([]);
  });

  it.skipIf(!built)("the UNAUTHENTICATED entry chunk carries no grading vocabulary at all", () => {
    const html = readFileSync(join(ROOT, "dist/public/index.html"), "utf8");
    const entry = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
    expect(entry, "could not locate the entry chunk in index.html").toBeTruthy();
    const src = readFileSync(join(ASSETS, entry!), "utf8");
    for (const id of ["eye_appeal", "centering_front", "NM-Mint+", "EX-Mint+", "grade_approved_at"]) {
      expect(src.includes(id), `entry chunk (${entry}) still contains ${id}`).toBe(false);
    }
  });

  it.skipIf(!built)("no source maps are published alongside the chunks", () => {
    const maps = readdirSync(ASSETS).filter((f) => f.endsWith(".map"));
    expect(maps, `source maps would re-expose everything this test just proved absent: ${maps.join(", ")}`).toEqual([]);
  });
});

describe("the published /standard tables still agree with the engine", () => {
  it("54/46 = Centering 10 remains published, and the table mirrors the live bands", async () => {
    const { centeringAxisGrade } = await import("../shared/centering");
    const std = read("client/src/pages/standard.tsx");
    // The published front table is the ONLY grading data that legitimately ships
    // in a public chunk. Prove it still matches what the engine actually scores.
    const rows = [...std.matchAll(/\{\s*ratio:\s*"([^"]+)",\s*grade:\s*"(\d+)"/g)];
    expect(rows.length, "could not parse the published centering tables").toBeGreaterThan(10);
    expect(std).toContain('{ ratio: "≤ 55/45", grade: "10", deduction: "0" }');
    expect(centeringAxisGrade("54/46", "front")).toBe(10);
    expect(centeringAxisGrade("55/45", "front")).toBe(10);
    expect(centeringAxisGrade("56/44", "front")).toBe(9);
  });
});
