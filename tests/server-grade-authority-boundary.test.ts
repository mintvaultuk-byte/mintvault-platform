import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function sourceFiles(path: string): string[] {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const relative = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(relative) : /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

describe("server-owned grading boundary", () => {
  it("keeps scoring engines out of every browser source module", () => {
    const forbiddenEngineImport = /from\s+["']@shared\/(?:mvgs-scoring|mvgs-input-builder|centering|pristine)["']/;
    for (const file of sourceFiles("client/src")) {
      expect(read(file), file).not.toMatch(forbiddenEngineImport);
    }
  });

  it("removes obsolete browser grade calculators", () => {
    expect(existsSync(join(root, "client/src/components/grading/grade-logic.ts"))).toBe(false);
    expect(existsSync(join(root, "client/src/components/grading/quick-grade.tsx"))).toBe(false);
  });

  it("persists resolver output on both draft-write paths", () => {
    const grader = read("server/grader.ts");
    const admin = read("server/routes.ts");

    expect(grader).toContain('from "./lib/draft-grade-authority"');
    expect(grader).toContain("const authority = await resolveDraftGradeAuthority(cert, body);");
    expect(grader).toContain("const overall = authority.overall;");
    expect(grader).toContain("authority.subgrades.centering");
    expect(admin).toContain("const authoritativeGrade = await resolveDraftGradeAuthority(cert as any, rawBody);");
    expect(admin).toContain("overall_grade: authoritativeGrade.overall");
  });

  it("sends observations without browser-grade fields and consumes server results", () => {
    const panel = read("client/src/components/grading/grading-panel.tsx");
    const payloadStart = panel.indexOf("function buildPayload");
    const payloadEnd = panel.indexOf("const currentPayloadFingerprint", payloadStart);
    const payload = panel.slice(payloadStart, payloadEnd);

    expect(payload).toContain("payload contains observations");
    expect(payload).not.toMatch(/overall_grade|grade_centering|grade_corners|grade_edges|grade_surface/);
    expect(panel).toContain("const acceptServerGradeAuthority");
    expect(panel).toContain("authoritativeGrade?.pristine === true");
  });
});
