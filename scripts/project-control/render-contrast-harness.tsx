/**
 * Renders the REAL Project Control early-state components to static HTML for the contrast proof.
 *
 * WHY THIS FILE EXISTS
 *
 * The first version of the contrast harness hand-typed its HTML. It drifted from the product in
 * four ways at once, and hostile review caught all four:
 *
 *   - it wrote the panel sub as `<p class="admin-panel__sub">`, but `Panel` renders it as a `<div>`
 *     — so the harness's `… p` selector matched the SUB, and the "failure explanation" row measured
 *     the same node as the "failure panel sub" row. The sentence the whole fix was named after was
 *     never sampled at all;
 *   - it used `data-testid="pc-failure"`, which `diagnoseLoadFailure` never emits;
 *   - it invented a class, `admin-panel__body`, that exists nowhere in the repo;
 *   - it composed an impossible state: the disabled-flag headline together with a retry button,
 *     which that branch never renders because `canRetry` is false for it.
 *
 * A harness that types its own markup proves only that the markup it typed is readable. So this
 * file imports the actual `Panel` and `adminButtonClass` and the actual `diagnoseLoadFailure`
 * copy, and emits exactly what the product emits. If `Panel`'s DOM changes, this changes with it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { Panel, adminButtonClass } from "../../client/src/components/admin";
import { diagnoseLoadFailure } from "../../client/src/pages/admin/project-control-helpers";

/** The loading branch, exactly as client/src/pages/admin/project-control.tsx returns it. */
function LoadingBranch() {
  return h(
    "div",
    { className: "admin-root" },
    h("div", { className: "p-8", "data-testid": "pc-loading", role: "status", "aria-live": "polite" }, "Loading Project Control…")
  );
}

/**
 * The failure branch, exactly as the page returns it.
 *
 * Driven through the real `diagnoseLoadFailure` so the testId, headline and detail are the
 * product's, not invented. A 500 is used because it is the branch that DOES render a retry button
 * (`canRetry: true`) — the disabled-flag branch does not, and pairing them was the impossible
 * state the old harness sampled.
 */
function FailureBranch({ retrying }: { retrying: boolean }) {
  const error = Object.assign(new Error("boom"), { status: 500 });
  const diagnosis = diagnoseLoadFailure(error);
  return h(
    "div",
    { className: "admin-root" },
    h(
      "div",
      { className: "p-8", "data-testid": diagnosis.testId, role: "status", "aria-live": "polite" },
      h(
        Panel,
        { title: diagnosis.headline, sub: diagnosis.detail },
        h(
          "p",
          { "data-testid": "pc-failure-explanation" },
          retrying
            ? "Retrying automatically…"
            : "This message does not diagnose a migration and does not expose a backend error."
        ),
        diagnosis.canRetry
          ? h(
              "button",
              {
                type: "button",
                className: adminButtonClass({ variant: "gold" }),
                "data-testid": retrying ? "pc-retry-disabled" : "pc-retry",
                disabled: retrying,
              },
              "Try again"
            )
          : null
      )
    )
  );
}

export function renderHarnessBody(): string {
  return [
    renderToStaticMarkup(h(LoadingBranch)),
    renderToStaticMarkup(h(FailureBranch, { retrying: false })),
    // The retrying variant is sampled too: `.admin-btn:disabled { opacity: .5 }` composites the
    // whole button, and ESSENTIAL_RETRY makes this state common on a cold load during a Fly restart.
    renderToStaticMarkup(h(FailureBranch, { retrying: true })),
  ].join("\n");
}

/**
 * The product testIds this harness must find, with an optional explicit threshold.
 *
 * Kept in the SAME module as the markup so the proof script cannot invent a selector that nothing
 * renders — the failure mode that made the first harness measure the panel sub twice and never
 * sample the explanatory sentence at all. A selector that matches nothing is reported as a failure,
 * not skipped.
 */
export const CONTRAST_TARGETS: [string, string, number?][] = [
  ["loading text", "[data-testid='pc-loading']"],
  ["failure explanation", "[data-testid='pc-failure-explanation']"],
  ["failure panel title", "[data-testid='pc-server-error'] .admin-panel__title"],
  ["failure panel sub", "[data-testid='pc-server-error'] .admin-panel__sub"],
  ["retry button", "[data-testid='pc-retry']"],
  /**
   * Measured and reported, but held to a lower bar — deliberately, and stated rather than hidden.
   *
   * `.admin-btn:disabled { opacity: .5 }` is a REPO-WIDE admin rule that composites the label AND
   * its gold gradient together, which drops this to ~2.2:1. WCAG 2.1 SC 1.4.3 exempts inactive
   * controls, so it is not a conformance failure, and it is pre-existing behaviour that this repair
   * did not introduce. It is sampled anyway because ESSENTIAL_RETRY makes the retrying state common
   * on a cold load during a Fly restart, so a founder will genuinely see it.
   *
   * Raising the disabled opacity would fix it, but that restyles every disabled button in the admin
   * and is an owner decision, not a release-blocker repair. The threshold records the real number
   * instead of quietly excluding the sample.
   */
  ["retry button (disabled)", "[data-testid='pc-retry-disabled']", 2],
];
