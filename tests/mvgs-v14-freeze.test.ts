/**
 * MVGS v1.4 FREEZE — semantic, structural and dependency guards.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A HASH MANIFEST IS NOT ENOUGH ON ITS OWN
 * ══════════════════════════════════════════════════════════════════════════
 * Hashes catch edits to files someone thought to protect. They do not catch:
 *   • a NEW behaviour-affecting dependency added to the closure
 *   • the engine reading a mutable database row (it used to — see below)
 *   • the published standard drifting away from what the engine computes
 *   • Staff and Partner quietly resolving through different code
 *
 * So the freeze is defended at four levels: hashes (scripts/mvgs/verify-freeze),
 * golden vectors (tests/mvgs-v14-golden-vectors.test.ts), the dependency closure
 * (here), and the public-bundle boundary (mvgs-public-bundle-boundary.test.ts).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE MUTABLE-INPUT HOLE THIS SUITE EXISTS TO KEEP CLOSED
 * ══════════════════════════════════════════════════════════════════════════
 * Before the freeze the engine called `loadMvgsCalibration()`, which reads six
 * scoring thresholds from `pipeline_settings` — a row that was `locked: false`
 * in production. The whitening ladder, the dark-border multiplier and the crease
 * ceilings could all be retuned from an admin screen, changing how a v1.4 card
 * grades without touching one protected byte. v1.4 now carries frozen constants.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

import { FROZEN_FILES, MANIFEST_PATH, computeHashes, readManifest } from "../scripts/mvgs/freeze-manifest";
import { MVGS_V1_4_CALIBRATION, MVGS_V1_4_VERSION } from "../shared/mvgs/v1_4";
import { DEFAULT_MVGS_CALIBRATION } from "../shared/mvgs-scoring";
import {
  calibrationForRulesVersion,
  isKnownRulesVersion,
  UnknownMvgsRulesVersion,
  CURRENT_MVGS_RULES_VERSION,
} from "../shared/mvgs/registry";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Read a file with comments removed.
 *
 * These structural checks ask "does this file DO X", and every frozen file
 * documents at length what it must not do — so a raw regex matches the warning
 * rather than the behaviour. Judge code, not prose.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("hash freeze", () => {
  it("every protected file matches the sealed manifest", () => {
    const manifest = readManifest(ROOT);
    const actual = computeHashes(ROOT);
    const drifted = FROZEN_FILES.filter((f) => manifest.files[f] !== actual[f]);
    expect(
      drifted,
      `MVGS v1.4 is an immutable grading ruleset. Create a new rules version rather than modifying v1.4.\n` +
        `Drifted: ${drifted.join(", ")}`
    ).toEqual([]);
  });

  it("the manifest covers exactly the protected-file list", () => {
    const manifest = readManifest(ROOT);
    expect(Object.keys(manifest.files).sort()).toEqual([...FROZEN_FILES].sort());
  });

  it("the manifest records the ruleset, the seal commit and the release it was proven on", () => {
    const m = readManifest(ROOT);
    expect(m.rulesVersion).toBe("v1.4");
    expect(m.sealedAtCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.provenOnRelease).not.toMatch(/UNVERIFIED/);
  });

  it("the verifier cannot re-seal — it has no write path", () => {
    const verifier = readCode("scripts/mvgs/verify-freeze.ts");
    // A verifier that can update its own expectations verifies nothing, and an
    // agent told to "make CI green" would find the lever. What matters is that
    // it has no WRITE capability — it names the re-seal script in its error
    // message on purpose, so a human knows the sanctioned way to proceed.
    expect(verifier, "the verifier must not be able to write anything").not.toMatch(
      /writeFileSync|appendFileSync|createWriteStream|writeSync|fs\.write|mkdirSync|rmSync|unlinkSync/
    );
    expect(verifier, "the verifier must not import a filesystem write API").not.toMatch(
      /import\s*\{[^}]*write[^}]*\}\s*from\s*["']node:fs["']/
    );
    expect(verifier).toContain("process.exit(1)");
  });

  it("re-sealing demands an explicit flag and is wired into no ordinary command", () => {
    const reseal = read("scripts/mvgs/reseal-freeze.ts");
    expect(reseal).toContain("--i-am-changing-a-frozen-ruleset");
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      expect(cmd, `npm script "${name}" must not invoke the re-seal tool`).not.toMatch(/reseal-freeze/);
      expect(cmd, `npm script "${name}" must not regenerate golden expectations`).not.toMatch(
        /generate-golden-vectors/
      );
    }
  });
});

describe("the frozen ruleset has no mutable inputs", () => {
  it("v1.4 calibration is a frozen constant, not a database read", () => {
    expect(Object.isFrozen(MVGS_V1_4_CALIBRATION)).toBe(true);
    const cal = readCode("shared/mvgs/v1_4/calibration.ts");
    expect(cal).not.toMatch(/loadMvgsCalibration|pipeline_settings|db\.|sql`/);
  });

  it("the frozen calibration equals what production was running — pinning changed nothing", () => {
    // Read from the production database (ep-wispy-morning, release v1120) on
    // 2026-08-22; the stored row was written by "mvgs-v2-launch" on 2026-06-04.
    expect({ ...MVGS_V1_4_CALIBRATION }).toEqual({ ...DEFAULT_MVGS_CALIBRATION });
    expect(MVGS_V1_4_CALIBRATION).toEqual({
      edgeAffectedPct: 10,
      minorVisibleSplitPct: 25,
      darkBorderMultiplier: 1.25,
      creaseMinorMaxPct: 25,
      creaseHalfMaxPct: 50,
      creaseThreeQuarterMaxPct: 75,
    });
  });

  it("no grading path reads calibration from the database any more", () => {
    // The admin CRUD routes may still read the row — it is the historical record
    // and where a future v1.5 will be tuned — but nothing that SCORES may.
    for (const f of ["server/lib/draft-grade-authority.ts", "server/labels.ts", "server/lib/cert-pristine.ts"]) {
      expect(readCode(f), `${f} must not read the mutable calibration row`).not.toMatch(/loadMvgsCalibration/);
    }
  });

  it("the authority invokes the versioned entrypoint, not the raw engine", () => {
    const auth = readCode("server/lib/draft-grade-authority.ts");
    expect(auth).toContain("scoreMvgsV1_4");
    expect(auth).not.toMatch(/scoreMvgsV2\s*\(/);
  });
});

describe("dependency closure — a frozen file cannot be bypassed via its imports", () => {
  /**
   * Walk static + dynamic imports out from the authority entrypoints. Anything
   * reachable that can influence a score must be protected. This is what stops
   * "leave the frozen file untouched, change its dependency instead".
   */
  function closure(): string[] {
    const ENTRIES = ["shared/mvgs/v1_4/index.ts", "server/lib/draft-grade-authority.ts", "shared/mvgs/registry.ts"];
    const seen = new Set<string>();
    const resolveSpec = (spec: string, from: string): string | null => {
      let base: string;
      if (spec.startsWith("@shared/")) base = join(ROOT, "shared", spec.slice(8));
      else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, from)), spec);
      else return null;
      // A bare directory specifier (`./v1_4`) resolves to the directory itself,
      // so require an actual FILE — otherwise the walker tries to read a folder.
      for (const ext of [".ts", "/index.ts", ""]) {
        const p = base + ext;
        if (existsSync(p) && statSync(p).isFile()) return relative(ROOT, p);
      }
      return null;
    };
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(join(ROOT, f), "utf8");
      const specs = [
        ...[...src.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ...[...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
      ];
      for (const s of specs) {
        const r = resolveSpec(s, f);
        if (r) walk(r);
      }
    };
    for (const e of ENTRIES) walk(e);
    return [...seen].sort();
  }

  it("every behaviour-affecting module in the closure is protected", () => {
    // Infrastructure the closure legitimately touches but which cannot change a
    // SCORE — database plumbing and the schema barrel, reached only for types
    // and connection handling.
    const NON_SCORING = new Set([
      "server/config.ts",
      "server/db.ts",
      "server/lib/database-environment-guard.ts",
      "shared/schema.ts",
      "shared/commerce.ts",
      "shared/vocabulary.ts",
      "shared/print-lifecycle.ts",
    ]);
    const unprotected = closure().filter(
      (f) => !(FROZEN_FILES as readonly string[]).includes(f) && !NON_SCORING.has(f)
    );
    expect(
      unprotected,
      `New module(s) reachable from the MVGS authority are NOT frozen. Either add them to ` +
        `FROZEN_FILES in scripts/mvgs/freeze-manifest.ts and re-seal, or keep them out of the ` +
        `grading closure:\n${unprotected.join("\n")}`
    ).toEqual([]);
  });

  it("the frozen engine does not reach into mutable application state", () => {
    for (const f of FROZEN_FILES) {
      if (f.startsWith("server/")) continue; // the server authority legitimately touches request state
      const src = readCode(f);
      expect(src, `${f} (shared, frozen) must not read from the database`).not.toMatch(
        /from\s*["'].*\/db["']|pipeline_settings/
      );
      expect(src, `${f} (shared, frozen) must not read environment configuration`).not.toMatch(/process\.env/);
    }
  });
});

describe("version routing — a future ruleset cannot restate an issued grade", () => {
  it("stamps v1.4 on new grades", () => {
    expect(CURRENT_MVGS_RULES_VERSION).toBe("v1.4");
    expect(MVGS_V1_4_VERSION).toBe("v1.4");
  });

  it("resolves the versions issued to date", () => {
    expect(calibrationForRulesVersion("v1.4")).toEqual(MVGS_V1_4_CALIBRATION);
    expect(calibrationForRulesVersion("v1.3")).toEqual(MVGS_V1_4_CALIBRATION);
    expect(calibrationForRulesVersion(null)).toEqual(MVGS_V1_4_CALIBRATION);
    expect(isKnownRulesVersion("v1.3")).toBe(true);
  });

  it("FAILS CLOSED on a version it cannot interpret rather than guessing", () => {
    expect(() => calibrationForRulesVersion("v1.5")).toThrow(UnknownMvgsRulesVersion);
    expect(() => calibrationForRulesVersion("v2.0")).toThrow(/Refusing to grade or re-render/);
    expect(isKnownRulesVersion("v1.5")).toBe(false);
  });

  it("re-render paths route by the certificate's STORED version, not the current one", () => {
    for (const f of ["server/labels.ts", "server/lib/cert-pristine.ts"]) {
      expect(read(f), `${f} must route calibration by stored rules version`).toContain("calibrationForRulesVersion");
    }
  });

  it("the grade write paths still stamp the version", () => {
    expect(read("server/lib/draft-grade-authority.ts")).toContain("rulesVersion");
    expect(read("server/grader.ts")).toContain("mvgs_rules_version = ${authority.rulesVersion}");
    expect(read("server/routes.ts")).toContain("mvgs_rules_version");
  });
});

describe("agent + governance instructions are discoverable", () => {
  it("the immutability rule is stated in the canonical governance location", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toMatch(/MVGS v1\.4 is (an )?immutable/i);
    expect(claude).toContain("shared/mvgs/v1_5");
  });

  it("CODEOWNERS protects the frozen paths", () => {
    const owners = existsSync(join(ROOT, ".github/CODEOWNERS")) ? read(".github/CODEOWNERS") : "";
    expect(owners, "CODEOWNERS must cover the frozen MVGS paths").toContain("shared/mvgs/");
    expect(owners).toContain(MANIFEST_PATH);
  });

  it("CI runs the freeze verifier", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("verify-freeze");
  });
});

describe("published standard cannot drift from the frozen rules", () => {
  /**
   * The /standard page restates the centering tables for customers. It is a
   * separate literal from the engine's bands — necessarily, because the browser
   * must not receive the engine — so the two CAN diverge. This is the guard that
   * makes that divergence a CI failure rather than a customer discovering it.
   *
   * It compares published PROSE against computed grades. No implementation
   * crosses into the client: the assertion runs in Node against the engine, and
   * only the already-published table is read from the page source.
   */
  const std = read("client/src/pages/standard.tsx");

  function publishedRows(constName: string): Array<{ ratio: string; grade: number }> {
    const block = std.slice(std.indexOf(`const ${constName}`));
    const end = block.indexOf("];");
    return [...block.slice(0, end).matchAll(/\{\s*ratio:\s*"([^"]+)",\s*grade:\s*"(\d+)"/g)].map((m) => ({
      ratio: m[1],
      grade: Number(m[2]),
    }));
  }

  /** "≤ 55/45" → 55 · "56-60 / 40-44" → 56 · "> 95/5" → 96 (first value IN the band). */
  function firstBiggerPctOf(ratio: string): number {
    const cleaned = ratio.replace(/\s/g, "");
    if (cleaned.startsWith("≤")) return Number(cleaned.slice(1).split("/")[0]);
    if (cleaned.startsWith(">")) return Number(cleaned.slice(1).split("/")[0]) + 1;
    return Number(cleaned.split("-")[0]);
  }

  for (const [constName, side] of [
    ["CENTERING_FRONT", "front"],
    ["CENTERING_BACK", "back"],
  ] as const) {
    it(`every published ${side} centering row matches what the engine actually scores`, async () => {
      const { centeringAxisGrade } = await import("../shared/centering");
      const rows = publishedRows(constName);
      expect(rows.length, `could not parse ${constName} from the published page`).toBeGreaterThan(3);
      const contradictions: string[] = [];
      for (const row of rows) {
        const bigger = firstBiggerPctOf(row.ratio);
        const engine = centeringAxisGrade(`${bigger}/${100 - bigger}`, side);
        if (engine !== row.grade) {
          contradictions.push(
            `published "${row.ratio}" = ${row.grade}, but the engine grades ${bigger}/${100 - bigger} as ${engine}`
          );
        }
      }
      expect(
        contradictions,
        `The published MVGS standard contradicts the frozen engine:\n${contradictions.join("\n")}`
      ).toEqual([]);
    });
  }

  it("54/46 is published AND computed as Centering 10", async () => {
    const { centeringAxisGrade } = await import("../shared/centering");
    expect(centeringAxisGrade("54/46", "front")).toBe(10);
    expect(std).toContain('{ ratio: "≤ 55/45", grade: "10", deduction: "0" }');
  });

  it("the published version lock names the frozen ruleset", () => {
    expect(std.replace(/\s+/g, " ")).toContain("MVGS v1.4");
  });

  it("every published score band maps to the grade the engine derives from that score", async () => {
    const { gradeFromMvgsScore } = await import("../shared/mvgs-scoring");
    // Rows look like ["86-90", "Mint+ 9.5"].
    const rows = [...std.matchAll(/\["(\d+)-(\d+)",\s*"([A-Za-z+\- ]+?)\s*([\d.]+)"\]/g)];
    expect(rows.length, "could not parse the published score-band table").toBeGreaterThan(10);
    const contradictions: string[] = [];
    for (const [, lo, hi, , gradeText] of rows) {
      const published = Number(gradeText);
      for (const score of [Number(lo), Number(hi)]) {
        const engine = gradeFromMvgsScore(score);
        if (engine !== published) contradictions.push(`published score ${score} = ${published}, engine = ${engine}`);
      }
    }
    expect(contradictions, `published score bands contradict the engine:\n${contradictions.join("\n")}`).toEqual([]);
  });
});

describe("approved grades cannot be casually mutated", () => {
  /**
   * These pin guarantees that ALREADY EXIST. The freeze is worthless if the code
   * that protects issued certificates can quietly regress while the engine stays
   * byte-identical, so each one is asserted rather than assumed.
   *
   * Deliberately NOT changed here: the Super Admin correction path. Tightening
   * the admin grade route further would risk breaking the live correction /
   * void / reholder workflows MintVault genuinely needs, which the freeze must
   * not do. The residual gap is reported to the owner instead of patched blind.
   */
  it("the grader draft path is fail-closed — it cannot write an approved row", () => {
    const grader = readCode("server/grader.ts");
    expect(grader).toContain("grade_approved_at IS NULL");
    // The rules-version stamp rides the same guarded statement, so an issued
    // certificate's provenance cannot be rewritten either.
    expect(grader).toContain("mvgs_rules_version = ${authority.rulesVersion}");
  });

  it("converting a PUBLISHED certificate's kind is refused, not silently applied", () => {
    const routes = readCode("server/routes.ts");
    // A one-key body {"overall_grade":"NO"} once converted a live numeric
    // certificate to authentication-only and nulled all four subgrades with a 200.
    expect(routes).toContain("rejectKindChange");
    expect(routes).toMatch(/isApproved:\s*\(cert as \{ gradeApprovedAt\?: unknown \}\)\.gradeApprovedAt != null/);
  });

  it("a grade change and its audit record commit together or not at all", () => {
    const routes = readCode("server/routes.ts");
    expect(routes).toContain("db.transaction");
    expect(routes).toContain("writeAuditLog");
  });

  it("an edit to an already-approved certificate is audited as its own action", () => {
    expect(readCode("server/routes.ts")).toMatch(/wasApproved/);
  });

  it("the rules-version stamp is preserved when a request writes no grade", () => {
    const routes = read("server/routes.ts");
    // Preserve-on-omission: a metadata-only autosave must not restamp a
    // certificate with a ruleset that did not produce its grade.
    expect(routes).toMatch(/mvgs_rules_version\s*=\s*\$\{\s*\n?\s*isNonNum \|\| effOverallGrade == null/);
  });

  it("migration 0111 never recalculated a grade", () => {
    const sql = read("migrations/0111_mvgs_rules_version.sql")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/SET\s+(grade|centering_score|corners_score|edges_score|surface_score|label_type)\b/i);
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });
});
