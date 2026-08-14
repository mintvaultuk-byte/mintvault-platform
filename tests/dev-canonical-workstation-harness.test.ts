// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DevCanonicalWorkstationHarness, {
  createCanonicalHarnessFetchFixture,
  type CanonicalHarnessRoleKey,
} from "../client/src/pages/dev-canonical-workstation-harness";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:harness-label") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("canonical workstation dev harness", () => {
  it("uses only the production workstation/stages for all five roles", () => {
    const source = read("client/src/pages/dev-canonical-workstation-harness.tsx");
    expect(source).toContain("GradingWorkstation");
    expect(source).not.toContain("HarnessCardDetails");
    expect(source).not.toContain("WorkstationEditorContext");
    expect(source).not.toContain("editor={");
    expect(source).toContain('"1280x800"');
    expect(source).toContain('"1024x768"');
    expect(source).toContain("geometry: () =>");
    for (const role of ["super-admin", "staff", "grader", "partner", "admin-review"]) {
      expect(source).toContain(`key: "${role}"`);
    }
  });

  it("keeps the route development-only", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain('{import.meta.env.DEV && (\n            <Route path="/dev/canonical-workstation"');
    expect(app).toMatch(
      /const DevCanonicalWorkstationHarness = import\.meta\.env\.DEV[\s\S]*?lazy\(\(\) => import\("@\/pages\/dev-canonical-workstation-harness"\)\)[\s\S]*?: \(null as unknown as ReturnType<typeof lazy>\)/
    );
    expect(app).not.toMatch(
      /const DevCanonicalWorkstationHarness = lazy\(\(\) => import\("@\/pages\/dev-canonical-workstation-harness"\)\)/
    );
  });

  it("persists an authoritative per-role record and renders a grade-visible 826x236 label", async () => {
    const fixture = createCanonicalHarnessFetchFixture(vi.fn() as unknown as typeof fetch);
    const cases: Array<{ role: CanonicalHarnessRoleKey; base: string; certId: number }> = [
      { role: "super-admin", base: "/api/admin", certId: 101 },
      { role: "staff", base: "/api/grader", certId: 102 },
      { role: "grader", base: "/api/grader", certId: 103 },
      { role: "partner", base: "/api/partner/grading", certId: 104 },
      { role: "admin-review", base: "/api/admin/grade-review", certId: 105 },
    ];
    for (const [index, testCase] of cases.entries()) {
      const grade = index % 2 === 0 ? "9.5" : "8";
      const saved = await fixture.fetch(`${testCase.base}/certificates/${testCase.certId}/grade`, {
        method: "PUT",
        body: JSON.stringify({ overall_grade: grade, eye_appeal_modifier: index }),
      });
      expect(saved.status).toBe(200);
      const { reviewRevision } = (await saved.json()) as { reviewRevision: number };
      expect(reviewRevision).toBeGreaterThan(1);
      const preview = await fixture.fetch(`${testCase.base}/certificates/label/preview`, {
        method: "POST",
        body: JSON.stringify({
          certificateId: testCase.certId,
          gradeOverall: "hostile-stale-client-value",
          expectedRevision: reviewRevision,
        }),
      });
      const label = new DataView(await preview.arrayBuffer());
      expect(preview.headers.get("content-type")).toBe("image/png");
      expect(preview.headers.get("x-mv-harness-grade")).toBe(grade);
      expect(preview.headers.get("x-mintvault-review-revision")).toBe(String(reviewRevision));
      expect(label.getUint32(16)).toBe(826);
      expect(label.getUint32(20)).toBe(236);
      expect(fixture.state.records[testCase.role].gradeOverall).toBe(grade);
      expect(fixture.state.records[testCase.role].eyeAppealModifier).toBe(index);
    }
  });

  it("serves the exact authoritative 8 then 7 label sequence, never the client-posted grade", async () => {
    const fixture = createCanonicalHarnessFetchFixture(vi.fn() as unknown as typeof fetch);
    const save = (grade: string) =>
      fixture.fetch("/api/grader/certificates/102/grade", {
        method: "PUT",
        body: JSON.stringify({ overall_grade: grade }),
      });
    let reviewRevision = 1;
    const preview = () =>
      fixture.fetch("/api/grader/certificates/label/preview", {
        method: "POST",
        body: JSON.stringify({
          certificateId: 102,
          gradeOverall: "hostile-client-override",
          expectedRevision: reviewRevision,
        }),
      });

    reviewRevision = ((await (await save("8")).json()) as { reviewRevision: number }).reviewRevision;
    const label8 = await preview();
    expect(label8.headers.get("x-mv-harness-grade")).toBe("8");
    const png8 = new Uint8Array(await label8.arrayBuffer());

    reviewRevision = ((await (await save("7")).json()) as { reviewRevision: number }).reviewRevision;
    const label7 = await preview();
    expect(label7.headers.get("x-mv-harness-grade")).toBe("7");
    const png7 = new Uint8Array(await label7.arrayBuffer());
    expect(png7).not.toEqual(png8);
    expect(fixture.state.records.staff.gradeOverall).toBe("7");
    expect(fixture.state.snapshot().map(({ operation, outcome }) => [operation, outcome])).toEqual([
      ["save", "fixture"],
      ["preview", "fixture"],
      ["save", "fixture"],
      ["preview", "fixture"],
    ]);
  });

  it("fails closed and exposes deterministic fail, delay, stale-order, and immutable audit controls", async () => {
    const fixture = createCanonicalHarnessFetchFixture(vi.fn() as unknown as typeof fetch);
    fixture.state.failNext("save", 409);
    expect((await fixture.fetch("/api/grader/certificates/103/grade", { method: "PUT", body: "{}" })).status).toBe(409);

    fixture.state.staleNextPreview(30);
    const first = fixture.fetch("/api/grader/certificates/label/preview", {
      method: "POST",
      body: JSON.stringify({ certificateId: 103, expectedRevision: 1 }),
    });
    const second = fixture.fetch("/api/grader/certificates/label/preview", {
      method: "POST",
      body: JSON.stringify({ certificateId: 103, expectedRevision: 1 }),
    });
    await Promise.all([first, second]);
    const previews = fixture.state.snapshot().filter((request) => request.operation === "preview");
    expect(previews[0].outcome).toBe("stale");
    expect(previews[0].completionSequence).toBeGreaterThan(previews[1].completionSequence!);

    const crossRole = await fixture.fetch("/api/partner/grading/certificates/label/preview", {
      method: "POST",
      body: JSON.stringify({ certificateId: 103, expectedRevision: 1 }),
    });
    expect(crossRole.status).toBe(403);
    const snapshot = fixture.state.snapshot();
    snapshot[0].outcome = "blocked";
    expect(fixture.state.requests[0].outcome).toBe("failed");
  });

  it("mounts the actual five-role workstation and installs a browser-controllable, console-clean hook", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      root.render(React.createElement(DevCanonicalWorkstationHarness));
    });
    for (
      let attempt = 0;
      attempt < 20 && !host.querySelector('[data-testid="canonical-grading-panel"]');
      attempt += 1
    ) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    for (const role of ["super-admin", "staff", "grader", "partner", "admin-review"]) {
      expect(host.querySelector(`[data-harness-mode="${role}"] [data-testid="grading-workstation"]`)).not.toBeNull();
      expect(
        host.querySelector(`[data-harness-mode="${role}"] [data-testid="canonical-grading-panel"]`)
      ).not.toBeNull();
    }
    const hook = (window as typeof window & { __mvHarness?: Record<string, unknown> }).__mvHarness;
    expect(hook).toBeDefined();
    expect(typeof hook?.audit).toBe("function");
    expect(typeof hook?.delayNext).toBe("function");
    expect(typeof hook?.failNext).toBe("function");
    expect(typeof hook?.staleNextPreview).toBe("function");
    expect(typeof hook?.dragInspection).toBe("function");
    expect(typeof hook?.geometry).toBe("function");
    const geometry = (
      hook?.geometry as (() => Record<string, Record<string, { width: number; height: number }>>) | undefined
    )?.();
    expect(Object.keys(geometry ?? {})).toEqual(["super-admin", "staff", "grader", "partner", "admin-review"]);
    for (const role of Object.values(geometry ?? {})) {
      expect(Object.keys(role)).toEqual([
        "workspace",
        "leftRail",
        "largeCard",
        "compactPreview",
        "stageHeader",
        "rightPane",
      ]);
    }
    expect(consoleError).not.toHaveBeenCalled();
  });
});
