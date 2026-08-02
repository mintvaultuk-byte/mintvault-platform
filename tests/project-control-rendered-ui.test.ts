// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectControlVisualFixture,
  projectControlFixtureShopLaunch,
} from "../client/src/test-harness/project-control-visual-fixture";
import { LAUNCH_GATE_KEYS } from "../shared/project-control-launch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const q = (selector: string) => container.querySelector<HTMLElement>(selector);
const qa = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));

async function renderFixture(state: Parameters<typeof ProjectControlVisualFixture>[0]["state"] = "current") {
  await act(async () => {
    root.render(createElement(ProjectControlVisualFixture, { state }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("Project Control rendered dashboard proof", () => {
  it("renders the executive control centre signals with honest next milestone wording", async () => {
    await renderFixture("current");

    expect(q('[data-testid="pc-overall-readiness"]')?.textContent).toContain("78%");
    expect(q('[data-testid="pc-pilot-readiness"]')?.textContent).toContain("Pilot readiness");
    expect(q('[data-testid="pc-current-phase"]')?.textContent).toContain("Next milestone");
    expect(q('[data-testid="pc-current-phase"]')?.textContent).toContain("Pilot with one or two shops");
    expect(container.textContent).toContain("The active phase is not returned by this contract");
    expect(q('[data-testid="pc-highest-blocker"]')?.textContent).toContain("Pilot with one or two shops");
    expect(q('[data-testid="pc-next-action"]')?.textContent).toContain("Resolve pilot evidence drift");
    expect(q('[data-testid="pc-staging-status"]')?.textContent).toContain("Aligned");
    expect(q('[data-testid="pc-production-status"]')?.textContent).toContain("Aligned");
    expect(q('[data-testid="pc-evidence-freshness"]')?.textContent).toContain("Current");
  });

  it("renders the ten Partner Shop Launch gates in exact declared order and keeps backlog separate", async () => {
    await renderFixture("current");
    const gates = qa(".pc-launch-gate .pc-gate-name").map((item) =>
      item.textContent?.replace("Next milestone", "").trim()
    );

    expect(gates).toEqual(
      LAUNCH_GATE_KEYS.map((key) => projectControlFixtureShopLaunch.phases.find((phase) => phase.key === key)?.name)
    );
    expect(q('[data-testid="pc-permanent-backlog"]')?.textContent).toContain("Permanent backlog");
    expect(q('[data-testid="pc-permanent-backlog"]')?.textContent).toContain("Separate from pilot readiness");
    expect(gates).not.toContain("Permanent G7-G20 backlog");
  });

  it("uses accessible launch gate disclosures and toggles aria-expanded", async () => {
    await renderFixture("current");
    const pilot = qa(".pc-gate-toggle").find((item) => item.textContent?.includes("Pilot with one or two shops"));

    expect(pilot).toBeTruthy();
    expect(pilot?.getAttribute("aria-controls")).toBe("pc-gate-pn-pilot");
    expect(pilot?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => pilot?.click());

    expect(pilot?.getAttribute("aria-expanded")).toBe("false");
  });

  it("distinguishes stale, unavailable, contradiction and failed refresh states", async () => {
    await renderFixture("stale");
    expect(q('[data-testid="pc-live-evidence"]')?.textContent).toContain("Last known good");
    expect(q('[data-testid="pc-evidence-freshness"]')?.textContent).toContain("Stale");

    await renderFixture("unavailable");
    expect(q('[data-testid="pc-live-evidence"]')?.textContent).toContain("Unavailable");
    expect(q('[data-testid="pc-evidence-freshness"]')?.textContent).toContain("Unavailable");
    expect(q('[data-testid="pc-live-evidence"]')?.textContent).not.toContain("0%");

    await renderFixture("contradiction");
    expect(q('[data-testid="pc-contradiction-warning"]')?.textContent).toContain("Contradictory deployment evidence");

    await renderFixture("failed-refresh");
    expect(q('[data-testid="pc-live-evidence"]')?.textContent).toContain("FAILED");
    const detail = qa("button").find((button) => button.textContent?.includes("Show technical detail"));
    await act(async () => detail?.click());
    expect(container.textContent).toContain("Refresh result: failed. Retry is available.");
  });

  it("retains previous evidence while GitHub refresh is running and disables only GitHub refresh controls", async () => {
    await renderFixture("refreshing");
    const refreshButtons = qa("button").filter((button) => button.textContent?.includes("Refreshing"));

    expect(q('[data-testid="pc-live-evidence"]')?.textContent).toContain("74b6be7b1bd1");
    expect(q('[data-testid="pc-live-evidence"]')?.textContent).toContain("RUNNING");
    expect(refreshButtons.length).toBeGreaterThanOrEqual(1);
    expect(refreshButtons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    const gateDisclosure = qa(".pc-gate-toggle").find((button) =>
      button.textContent?.includes("Pilot with one or two shops")
    );
    expect(gateDisclosure?.hasAttribute("disabled")).toBe(false);
  });

  it("renders empty and loading states without treating unknown as zero", async () => {
    await renderFixture("empty");
    expect(q('[data-testid="pc-empty-state"]')?.textContent).toContain("empty programme state");
    expect(q('[data-testid="pc-empty-state"]')?.textContent).not.toContain("0%");

    await renderFixture("loading");
    expect(q('[data-testid="pc-loading"]')?.getAttribute("aria-live")).toBe("polite");
    expect(q('[data-testid="pc-loading"]')?.textContent).toContain("retained evidence");
    expect(q('[data-testid="pc-live-evidence"]')?.textContent).toContain("74b6be7b1bd1");
  });

  it("keeps the rendered fixture within the documented viewport widths", async () => {
    const viewports = [
      [1440, 900],
      [1280, 800],
      [1024, 768],
      [768, 1024],
      [390, 844],
    ] as const;

    for (const [width, height] of viewports) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });

      await renderFixture("current");

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
      expect(q('[data-testid="pc-launch-gates"]')).toBeTruthy();
    }
  });

  it("renders workflow tree focus, expansion, blockers and integrity warnings", async () => {
    await renderFixture("integrity");

    expect(q('[data-testid="pc-workflow-tree"]')?.textContent).toContain("Partner Network");
    expect(q('[data-testid="pc-workflow-tree"]')?.textContent).toContain("Pilot with one or two shops");
    expect(q('[data-testid="pc-tree-integrity-warning"]')?.textContent).toContain("orphaned package");
    expect(q('[data-testid="pc-orphan-warning"]')?.textContent).toContain("pc-orphan-shop-csv");
    expect(q('[data-testid="pc-cycle-warning"]')?.textContent).toContain("pn-cycle-a");

    const expand = qa("button").find((button) => button.textContent?.includes("Expand full tree"));
    await act(async () => expand?.click());

    expect(q('[data-testid="pc-workflow-tree"]')?.textContent).toContain("Credit purchase (Stripe)");
  });

  it("renders package detail above the fold and package history evidence", async () => {
    await renderFixture("package-history");

    expect(container.textContent).toContain("Operational summary");
    expect(container.textContent).toContain("Remaining work:");
    expect(container.textContent).toContain("What to do next");
    expect(q('[data-testid="pcp-evidence-history"]')?.textContent).toContain("Superseded package retained");
    expect(q('[data-testid="pcp-evidence-history"]')?.textContent).toContain("Replacement relationship");
  });

  it("meets basic rendered accessibility invariants", async () => {
    await renderFixture("current");
    const h1s = qa("h1");
    const launchList = q('[data-testid="pc-launch-gates"]');
    const namelessButtons = qa("button").filter(
      (button) => !button.textContent?.trim() && !button.getAttribute("aria-label")
    );

    expect(h1s).toHaveLength(1);
    expect(launchList?.tagName).toBe("OL");
    expect(qa("[aria-expanded]").length).toBeGreaterThan(0);
    expect(q('[aria-live="polite"]')).toBeTruthy();
    expect(namelessButtons).toEqual([]);
  });
});
