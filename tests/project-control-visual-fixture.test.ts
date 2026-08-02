import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

  it("keeps the checked-in responsive proof tied to the mobile launch-gate overflow fix", () => {
    const css = readFileSync("client/src/styles/project-control.css", "utf8");
    const report = readFileSync("docs/project-control/visual-acceptance/visual-parity-report.md", "utf8");

    expect(css).toContain("grid-template-columns: 22px minmax(0, 1fr) 22px;");
    expect(css).toContain(".pc-gate-toggle > .admin-badge:first-of-type");
    expect(report).toContain("390x844");
    expect(report).toContain("document.scrollWidth");
  });
});
