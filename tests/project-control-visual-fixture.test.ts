import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const productionRoots = [
  "client/src/App.tsx",
  "client/src/pages",
  "client/src/components",
  "client/src/hooks",
  "client/src/lib",
].filter((path) => path !== "client/src/test-harness");

function filesUnder(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)));
}

describe("Project Control visual fixture production exclusion", () => {
  it("keeps the production Admin shell navigation entry wired to Project Control", () => {
    const shell = readFileSync("client/src/components/admin/admin-shell.tsx", "utf8");
    const app = readFileSync("client/src/App.tsx", "utf8");

    expect(shell).toContain('{ href: "/admin/project-control", label: "Project Control"');
    expect(app).toContain('<Route path="/admin/project-control" component={AdminProjectControlPage} />');
  });

  it("has no import edge from production client code", () => {
    const offenders = productionRoots
      .flatMap((root) => filesUnder(root))
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => readFileSync(file, "utf8").includes("project-control-visual-fixture"));

    expect(offenders).toEqual([]);
  });

  it("is not registered as a production router path", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");

    expect(app).not.toContain("project-control-visual-fixture");
    expect(app).not.toContain("visual-fixture");
  });

  it("is a deterministic screenshot-only HTML entry outside the production build entry", () => {
    const build = readFileSync("script/build.ts", "utf8");
    const vite = readFileSync("vite.config.ts", "utf8");

    expect(build).not.toContain("project-control-visual-fixture");
    expect(vite).not.toContain("project-control-visual-fixture");
    expect(readFileSync("client/project-control-visual-fixture.html", "utf8")).toContain(
      "/src/test-harness/project-control-visual-fixture.tsx"
    );
  });

  /**
   * This assertion used to require the parity report to contain the string
   * `document.scrollWidth` — i.e. it graded the report's PROSE, and specifically required it to
   * keep citing a happy-dom measurement that could not fail. It has been repointed at the evidence
   * that actually exists.
   *
   * It still cannot verify layout (that is what the browser harness is for). What it CAN honestly
   * pin is that the mobile CSS fix is still present and that the report has not quietly dropped its
   * link to the real proof.
   */
  it("keeps the mobile launch-gate CSS fix and the report's link to the real browser proof", () => {
    const css = readFileSync("client/src/styles/project-control.css", "utf8");
    const report = readFileSync("docs/project-control/visual-acceptance/visual-parity-report.md", "utf8");

    expect(css).toContain("grid-template-columns: 22px minmax(0, 1fr) 22px;");
    expect(css).toContain(".pc-gate-toggle > .admin-badge:first-of-type");
    expect(report).toContain("390x844");
    // The report must point at measurements taken in a real browser, not at a happy-dom number.
    expect(report).toContain("browser-proof/README.md");
  });

  /**
   * The harness must render inside `.admin-root`.
   *
   * Without it, `color: var(--admin-ink)`, `--admin-ui` and the 14px base never apply — the
   * captured screenshots showed dark text on the dark ground and were unreadable, and every text
   * metric (and therefore every wrap point) differed from production.
   */
  it("renders the fixture inside .admin-root so captures share production's typography", () => {
    const fixture = readFileSync("client/src/test-harness/project-control-visual-fixture.tsx", "utf8");
    expect(fixture).toContain("admin-root pc-fixture-shell");
    expect(fixture).not.toMatch(/className="pc-fixture-shell"/);
  });

  /**
   * Screenshot integrity: no two acceptance artefacts may be byte-identical.
   *
   * The directory previously held 22 files containing 18 distinct images — one capture re-saved
   * under four section names and another under two, indexed as if they were six independent pieces
   * of evidence.
   */
  it("has no byte-identical duplicate screenshots presented as separate evidence", () => {
    const dir = "docs/project-control/visual-acceptance/final";
    const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
    const byHash = new Map<string, string[]>();
    for (const f of files) {
      const hash = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
      byHash.set(hash, [...(byHash.get(hash) ?? []), f]);
    }
    const dupes = [...byHash.values()].filter((names) => names.length > 1);
    expect(dupes, `duplicate screenshots: ${JSON.stringify(dupes)}`).toEqual([]);
  });
});
