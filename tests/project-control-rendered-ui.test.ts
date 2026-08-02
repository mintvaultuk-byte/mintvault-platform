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

    /**
     * UI6, updated for the cutover. The warning used to be a sentence the BROWSER assembled from
     * three deployment booleans; it is now the server's stable contradiction code and summary,
     * plus the binding readiness cap. Asserting the code rather than the prose is also a stronger
     * check — the copy may change, the code may not.
     */
    await renderFixture("contradiction");
    const warning = q('[data-testid="pc-contradiction-warning"]')?.textContent ?? "";
    expect(warning).toContain("GITHUB_NEWER_THAN_DEPLOYMENT");
    expect(warning).toContain("Production is 33 commits behind GitHub main.");
    // The cap that held readiness down is disclosed alongside the contradiction that caused it.
    expect(q('[data-testid="pc-readiness-cap"]')?.textContent).toContain("Evidence sources disagree");

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

  /**
   * RESP1 — this test used to assert overflow, and could not fail.
   *
   * It read:
   *
   *   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   *
   * happy-dom has no layout engine. `scrollWidth` is a field initialised to 0 and never written by
   * layout, and `getBoundingClientRect()` returns a bare DOMRect. So the assertion evaluated
   * `0 <= 390` and passed for any content at any viewport — a 99,999px element passed it. vitest
   * also runs with `css: false` here, so the media queries under test were never even parsed.
   *
   * The overflow claim now lives where it can be measured: a real Chrome over the DevTools
   * Protocol, in `scripts/project-control/responsive-proof.mjs`, with a mandatory positive control
   * and a verified 390px layout viewport. Results:
   * docs/project-control/visual-acceptance/browser-proof/README.md
   *
   * What remains here is what happy-dom CAN honestly answer: that the components mount and render
   * their landmark content at every documented viewport. That is a real regression guard for
   * "the launch gates disappeared", and it is not dressed up as a layout proof.
   */
  it("renders the launch gates at every documented viewport (structure only — NOT a layout proof)", async () => {
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

      expect(q('[data-testid="pc-launch-gates"]')).toBeTruthy();
    }
  });

  /**
   * The guard that stops the vacuous assertion coming back.
   *
   * If someone reintroduces a scrollWidth-based overflow check in this environment, this test
   * documents — by demonstration — why it would be meaningless.
   */
  it("documents that happy-dom cannot measure layout, so scrollWidth here proves nothing", async () => {
    await renderFixture("current");
    const wide = document.createElement("div");
    wide.style.width = "99999px";
    wide.style.height = "10px";
    document.body.appendChild(wide);

    // A 99,999px element. Real layout would report a document far wider than any viewport.
    expect(document.documentElement.scrollWidth).toBe(0);
    expect(document.body.scrollWidth).toBe(0);
    expect(wide.getBoundingClientRect().width).toBe(0);

    wide.remove();
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

/**
 * Evidence-backed readiness must LEAD, and declared completion must be labelled as such.
 *
 * The headline card rendered `overview.readiness.overall` — the aggregate over operator-DECLARED
 * work-package completion — under the caption "Server-authoritative weighted readiness". It was
 * neither authoritative about evidence nor capped by it: hand-marking packages done pushed it to
 * 100% with every live evidence source UNKNOWN. The gate-and-contradiction-capped number that the
 * readiness caps exist to produce (`evidence.readiness.percent`) was rendered NOWHERE — only its
 * appliedCaps were read, further down the page.
 *
 * These assert the RENDERED cards, because both numbers were computed correctly all along; it was
 * the surface that misrepresented which one the founder was looking at.
 */
describe("readiness headline tells the truth about which number it is", () => {
  it("renders the evidence-backed figure as its own card", async () => {
    await renderFixture("current");
    const card = q('[data-testid="pc-evidence-readiness"]');
    expect(card, "the evidence-capped readiness must be rendered at all").toBeTruthy();
    expect(card!.textContent).toContain("Evidence-backed readiness");
  });

  it("still shows declared completion, named for what it is", async () => {
    await renderFixture("current");
    const declared = q('[data-testid="pc-overall-readiness"]');
    expect(declared).toBeTruthy();
    expect(declared!.textContent).toContain("Declared completion");
    // The old caption claimed an authority this number never had.
    expect(declared!.textContent).not.toContain("Server-authoritative");
  });

  it("never labels operator-entered progress as server-authoritative anywhere on the page", async () => {
    await renderFixture("current");
    expect(container.textContent).not.toContain("Server-authoritative weighted readiness");
  });

  it("puts the EVIDENCE figure on the evidence card and the DECLARED figure on the declared card", async () => {
    await renderFixture("current");
    const evidenceCard = q('[data-testid="pc-evidence-readiness"]');
    const declaredCard = q('[data-testid="pc-overall-readiness"]');
    expect(evidenceCard).toBeTruthy();
    expect(declaredCard).toBeTruthy();
    // The fixture's two figures differ (51 vs 78) precisely so this can bite. Comparing the NODES
    // rather than the values was tautological — two distinct data-testids can never be one node —
    // and it left the actual defect, the wrong number under the right label, undetectable.
    expect(evidenceCard!.textContent).toContain("51%");
    expect(evidenceCard!.textContent).not.toContain("78%");
    expect(declaredCard!.textContent).toContain("78%");
    expect(declaredCard!.textContent).not.toContain("51%");
  });

  it("explains what capped the evidence-backed figure, or how many gates it proved", async () => {
    await renderFixture("current");
    const card = q('[data-testid="pc-evidence-readiness"]');
    // Either a cap list or an N/M gate count — never a bare percentage with no provenance.
    expect(card!.textContent).toMatch(/Capped by|gates proven by live evidence/);
  });

  it("shows the CI badge with a real verdict, not Unknown, when the build is green", async () => {
    await renderFixture("current");
    const badge = q('[data-testid="pc-ci-badge"]');
    expect(badge, "the PR/CI badge must be rendered").toBeTruthy();
    // The fixture's `current` state carries ciConclusion "success". Before the shared-vocabulary
    // fix this read "Unknown" for a green build and a red one alike.
    expect(badge!.textContent).toContain("Succeeded");
    expect(badge!.textContent).not.toContain("Unknown");
  });
});
