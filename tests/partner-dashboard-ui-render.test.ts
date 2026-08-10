// @vitest-environment happy-dom
/**
 * Partner Master Dashboard — REAL component rendering.
 *
 * tests/partner-dashboard-admin-ui.test.ts asserts on SOURCE TEXT (readFileSync + toContain).
 * That has genuine governance value — it pins the route wiring and nav registration a shell
 * guard depends on — but it is not proof that anything renders. A component that throws on
 * mount would sail straight through it.
 *
 * This suite mounts the ACTUAL exported components and asserts on the resulting DOM:
 *   - loading / error / empty states
 *   - the unavailable-metric primitive (the anti-fake-metric rule), including that a genuine
 *     zero still renders as a zero
 *   - the whole-surface visibility-unavailable panel (the D1 remediation, client side)
 *   - drill-down LAZY loading: only the visible tab issues a request
 *
 * Written with `createElement` rather than JSX, matching the house convention in
 * tests/grading-workflow-runtime.test.ts (vitest `include` is tests/**\/*.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Loading,
  Empty,
  ErrorBanner,
  Unavailable,
  MetricValue,
  NoDataSection,
  VisibilityUnavailable,
  PartnerDrilldown,
} from "../client/src/pages/admin/partner-dashboard";
import { unavailable, metric } from "@shared/partner-dashboard";

const render = (el: ReactElement) => renderToStaticMarkup(el);

describe("static rendering of dashboard primitives", () => {
  it("renders the loading state with an accessible live region", () => {
    const html = render(createElement(Loading, { label: "Loading network summary…", testId: "pd-summary-loading" }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading network summary…");
    expect(html).toContain('data-testid="pd-summary-loading"');
  });

  it("renders the empty state", () => {
    const html = render(createElement(Empty, { label: "No partners match these filters.", testId: "pd-empty" }));
    expect(html).toContain("No partners match these filters.");
    expect(html).toContain('data-testid="pd-empty"');
  });

  it("renders the error state as an alert, with a retry affordance", () => {
    const html = render(createElement(ErrorBanner, { message: "Something went wrong.", onRetry: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong.");
    expect(html).toContain('data-testid="pd-retry"');
  });

  it("omits the retry control when there is nothing to retry", () => {
    const html = render(createElement(ErrorBanner, { message: "Fatal." }));
    expect(html).not.toContain('data-testid="pd-retry"');
  });

  it("renders an unavailable metric as a REASON, never as a number", () => {
    const m = unavailable("NO_DATA_SOURCE", "No partner quality data exists in the schema.");
    const html = render(createElement(Unavailable, { metric: m }));
    expect(html).toContain("Not available");
    expect(html).toContain("No partner quality data exists in the schema.");
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it("renders an available metric as its value", () => {
    const html = render(createElement(MetricValue, { metric: metric(1234) }));
    expect(html).toContain("1,234");
  });

  it("renders a genuine zero as a zero — available:0 must not read as unavailable", () => {
    const html = render(createElement(MetricValue, { metric: metric(0) }));
    expect(html).toContain("0");
    expect(html).not.toContain("Not available");
  });

  it("renders an unavailable KPI without inventing a figure", () => {
    const m = unavailable("REQUIRES_BACKEND_WORK", "No Stripe credit-purchase path exists for partners.");
    const html = render(createElement(MetricValue, { metric: m }));
    expect(html).toContain("Not available");
    expect(html).toContain("No Stripe credit-purchase path exists for partners.");
  });

  it("renders a whole no-data section with its explanation", () => {
    const html = render(
      createElement(NoDataSection, {
        title: "Partner quality rating",
        explanation: "Not yet implemented.",
        testId: "pd-quality-nodata",
      })
    );
    expect(html).toContain("Partner quality rating");
    expect(html).toContain("Not yet implemented.");
  });

  describe("visibility-unavailable panel (D1, client side)", () => {
    const MESSAGE =
      "Partner data is unavailable: the configured admin database role cannot perform cross-tenant reads.";

    it("states that data is unavailable and explains why zeros are not shown", () => {
      const html = render(createElement(VisibilityUnavailable, { message: MESSAGE }));
      expect(html).toContain('role="alert"');
      expect(html).toContain('data-testid="pd-visibility-unavailable"');
      expect(html).toContain("Partner data is unavailable");
      expect(html).toContain(MESSAGE);
      expect(html).toContain("deployment configuration issue");
    });

    it("renders no zeros or tables that could read as a healthy empty network", () => {
      const html = render(createElement(VisibilityUnavailable, { message: MESSAGE }));
      expect(html).not.toContain("<table");
      expect(html).not.toMatch(/>\s*0\s*</);
    });
  });
});

describe("drill-down lazy loading (real mount, real queries)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  const PARTNER = "aaaa0001-0000-0000-0000-00000000000a";

  const mount = async (el: ReactElement) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, el));
    });
    // React Query resolves on a later task than the render itself; without this the assertions
    // race the fetch and every section reads as still-loading. A request that never settles
    // (the loading-state case below) is unaffected — it simply stays loading.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("fetches ONLY the visible tab — not every section's dataset", async () => {
    fetchMock.mockImplementation(() =>
      ok({
        partnerId: PARTNER,
        publicRef: "ref",
        shopName: "Synthetic Shop",
        status: "ACTIVE",
        createdAt: "2026-01-01T00:00:00.000Z",
        profile: null,
        counts: { locations: 1, users: 2, submissions: 3, connectorRecords: 4 },
        gradingOrigin: unavailable("REQUIRES_BACKEND_WORK", "not implemented"),
        certificatesGraded: unavailable("NOT_LINKED", "no tenant column"),
      })
    );

    await mount(createElement(PartnerDrilldown, { partnerId: PARTNER, tab: "overview" }));

    const requested = urls();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain(`/partners/${PARTNER}/overview`);
    for (const other of ["staff", "wallet", "submissions", "quality", "devices", "corrections", "security", "audit"]) {
      expect(requested.join("|"), `must not prefetch ${other}`).not.toContain(`/${other}`);
    }
    expect(container.textContent).toContain("Synthetic Shop");
  });

  it("requests a different section only once that tab becomes visible", async () => {
    fetchMock.mockImplementation(() => ok({ staff: [] }));
    await mount(createElement(PartnerDrilldown, { partnerId: PARTNER, tab: "staff" }));
    expect(urls()).toHaveLength(1);
    expect(urls()[0]).toContain(`/partners/${PARTNER}/staff`);
  });

  it("keys the request by partner id, so switching partners cannot show stale data", async () => {
    const OTHER = "bbbb0002-0000-0000-0000-00000000000b";
    fetchMock.mockImplementation(() => ok({ staff: [] }));
    await mount(createElement(PartnerDrilldown, { partnerId: PARTNER, tab: "staff" }));
    await mount(createElement(PartnerDrilldown, { partnerId: OTHER, tab: "staff" }));
    const requested = urls();
    expect(requested.some((u) => u.includes(PARTNER))).toBe(true);
    expect(requested.some((u) => u.includes(OTHER))).toBe(true);
  });

  it("renders the error state when a section request fails", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve(JSON.stringify({ error: { message: "Something went wrong." } })),
      })
    );

    await mount(createElement(PartnerDrilldown, { partnerId: PARTNER, tab: "staff" }));

    expect(container.querySelector('[data-testid="pd-error"]')).not.toBeNull();
    expect(container.textContent).toContain("Something went wrong.");
  });

  it("renders the loading state while a section request is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((r) => (release = r)));

    await mount(createElement(PartnerDrilldown, { partnerId: PARTNER, tab: "staff" }));
    expect(container.querySelector('[data-testid="pd-section-loading"]')).not.toBeNull();

    await act(async () => {
      release({ ok: true, status: 200, json: () => Promise.resolve({ staff: [] }), text: () => Promise.resolve("") });
    });
  });

  it("renders an unavailable section as its reason, not as zeros", async () => {
    const reason = "Partner Quality Rating is not yet implemented.";
    fetchMock.mockImplementation(() =>
      ok({
        metrics: { adminApprovalRate: unavailable("NO_DATA_SOURCE", reason) },
        overallRating: unavailable("NO_DATA_SOURCE", reason),
        trend: unavailable("NO_DATA_SOURCE", reason),
        graderPerformance: unavailable("NO_DATA_SOURCE", reason),
        explanation: reason,
      })
    );

    await mount(createElement(PartnerDrilldown, { partnerId: PARTNER, tab: "quality" }));

    expect(container.textContent).toContain(reason);
    expect(container.textContent).not.toMatch(/\b0%\b/);
  });

  it("renders ledger-backed purchase history with its immutable reference", async () => {
    fetchMock.mockImplementation(() =>
      ok({
        configured: true,
        walletId: "wallet-1",
        status: "active",
        availableCredits: 25,
        reservedCredits: 0,
        ledgerBalance: 25,
        consumedReservations: 0,
        note: "Balances are ledger-derived.",
        manualAdjustmentEnabled: false,
        recentLedger: [
          {
            id: "ledger-1",
            amount: 25,
            entryType: "purchase",
            source: "stripe",
            reason: "Synthetic purchase",
            actorType: "service",
            actorEmail: null,
            reference: "pi_dashboard_history",
            createdAt: "2026-08-10T12:00:00.000Z",
          },
        ],
        purchases: metric([
          {
            ledgerEntryId: "ledger-1",
            credits: 25,
            packageId: "credits-25",
            amountPaidPence: 25_000,
            currency: "gbp",
            checkoutSessionId: "cs_dashboard_history",
            paymentIntentId: "pi_dashboard_history",
            source: "stripe",
            reference: "pi_dashboard_history",
            purchasedAt: "2026-08-10T12:00:00.000Z",
          },
        ]),
      })
    );

    await mount(createElement(PartnerDrilldown, { partnerId: PARTNER, tab: "wallet" }));

    expect(container.querySelector('[data-testid="pd-purchase-history-table"]')).not.toBeNull();
    expect(container.textContent).toContain("Credit purchase history");
    expect(container.textContent).toContain("credits-25");
    expect(container.textContent).toContain("£250.00");
    expect(container.textContent).toContain("pi_dashboard_history");
  });
});
