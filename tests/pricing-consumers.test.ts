// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Decorative animation/layout and the external payment SDK are not price authority.
vi.mock("../client/src/components/v2/header-v2", () => ({ default: () => null }));
vi.mock("../client/src/components/v2/footer-v2", () => ({ default: () => null }));
vi.mock("../client/src/components/v2/ambient-layer", () => ({ default: () => null }));
vi.mock("../client/src/components/v2/dark-section-glow", () => ({ default: () => null }));
vi.mock("../client/src/components/v2/card-population-chart", () => ({ default: () => null }));
vi.mock("../client/src/components/ui/timeline-animation", () => ({
  TimelineContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("@number-flow/react", () => ({
  default: ({ value }: { value: number }) => createElement("span", null, value),
}));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: () => Promise.resolve(null) }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CardElement: () => null,
  useStripe: () => null,
  useElements: () => null,
}));
import Home from "../client/src/pages/home";
import Pricing from "../client/src/pages/pricing";
import Submit from "../client/src/pages/submit";
import { TierPriceWithPromo } from "../client/src/components/v2/promo-display";

const live = {
  id: "standard",
  serviceType: "grading",
  name: "Current DB grading",
  price: "£37.29 per card",
  pricePerCard: 3729,
  turnaroundDays: 17,
  turnaround: "17 working days",
  recommendedCardValue: "Up to £4,500",
  features: ["Current DB feature"],
  capacityStatus: "open",
  capacityPausedUntil: null,
  capacityMessage: null,
};
let root: Root | undefined;
let client: QueryClient;
let container: HTMLDivElement;
async function render(component: ComponentType, tiers: unknown = [live], fail = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/service-tiers"))
        return new Response(JSON.stringify(tiers), { status: fail ? 503 : 200 });
      if (url === "/api/promotions/active") return new Response(JSON.stringify({ promo: null }));
      if (url === "/api/capacity") return new Response("{}");
      if (url === "/api/vault-club/check-discount")
        return new Response(JSON.stringify({ discount_percent: 0, tier: null }));
      if (url === "/api/grading/quote")
        return new Response(
          JSON.stringify({
            subtotalPence: 3729,
            discountType: null,
            effectiveDiscountAmount: 0,
            effectiveDiscountPercent: 0,
            discountedSubtotal: 3729,
            shipping: 799,
            shippingLabel: "Test shipping",
            totalInsuranceFee: 0,
            insuranceSurchargeLabel: "Included",
            total: 4528,
            promoApplied: false,
            promoCodeValid: false,
            promoCodeReason: null,
            promoCodeApplied: false,
            promoCodePercent: 0,
          })
        );
      if (url === "/api/v2/homepage-stats") return new Response(JSON.stringify({ unique_sets: 1 }));
      if (url.startsWith("/api/public/recent-graded")) return new Response("[]");
      throw new Error(`Unapproved fixture request: ${url}`);
    })
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({}) } },
  });
  client.setQueryData(["/api/stripe/publishable-key"], { publishableKey: "pk_test_owned_ui_fixture" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(QueryClientProvider, { client }, createElement(component))));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  client?.clear();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});
describe("Actual current-price consumers", () => {
  for (const [label, component] of [
    ["Home", Home],
    ["Pricing", Pricing],
  ] as const) {
    it(`${label} renders only database-backed tier amounts and no static bulk amounts`, async () => {
      await render(component);
      expect(container.textContent).toContain("Current DB grading");
      expect(container.textContent).toContain("37.29");
      expect(container.textContent).toContain("17 working days");
      expect(container.textContent).toContain("Current DB feature");
      expect(container.textContent).not.toContain("£18.05");
      expect(container.textContent).not.toContain("From £19");
    });
    it(`${label} fails closed when current tiers cannot load`, async () => {
      await render(component, [], true);
      expect(container.textContent).toContain("Current pricing is unavailable");
      expect(container.textContent).not.toContain("/ card");
      expect(container.textContent).not.toContain("£18.05");
    });
  }
  it("submission cannot advance a URL-selected tier when the live catalogue is unavailable", async () => {
    window.history.replaceState({}, "", "/submit?type=grading&tier=standard");
    await render(Submit, [], true);
    expect(container.textContent).toContain("Current pricing is unavailable");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-next"]')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid="button-tier-standard"]')).toBeNull();
  });
  it("does not apply an old promotion amount to a newly priced tier", async () => {
    function Price() {
      return createElement(TierPriceWithPromo, {
        tierId: "standard",
        fullPricePounds: 37.29,
        promo: {
          bannerText: "Old promo",
          tiers: { standard: { pct: 10, originalPrice: 1900, discountedPrice: 1710 } },
        },
      });
    }
    await render(Price);
    expect(container.textContent).toContain("37.29");
    expect(container.textContent).not.toContain("17.1");
    expect(container.textContent).not.toContain("10% off");
  });
  it("renders a valid current promotion using the server's integer-pence discount", async () => {
    function Price() {
      return createElement(TierPriceWithPromo, {
        tierId: "standard",
        fullPricePounds: 37.29,
        promo: {
          bannerText: "Current promo",
          tiers: { standard: { pct: 10, originalPrice: 3729, discountedPrice: 3356 } },
        },
      });
    }
    await render(Price);
    expect(container.textContent).toContain("33.56");
    expect(container.textContent).toContain("10% off");
  });
  for (const [label, component] of [
    ["Home", Home],
    ["Pricing", Pricing],
  ] as const) {
    it(`${label} renders newly configured tier IDs without relying on the static three-tier lookup`, async () => {
      await render(component, [{ ...live, id: "new-tier", name: "New DB tier" }]);
      expect(container.textContent).toContain("New DB tier");
      expect(container.querySelector('a[href="/submit?type=grading&tier=new-tier"]')).not.toBeNull();
      expect(container.textContent).not.toContain("only three tiers");
      expect(container.textContent).not.toContain("Vault Queue, Standard, and Express");
    });
  }
  it("does not offer a paused live tier for purchase on public cards or submission", async () => {
    window.history.replaceState({}, "", "/submit?type=grading&tier=standard");
    await render(Submit, [{ ...live, capacityStatus: "paused", capacityMessage: "Current capacity pause" }]);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-tier-standard"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-next"]')!.disabled).toBe(true);
    await act(async () => root!.render(createElement(QueryClientProvider, { client }, createElement(Home))));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
    expect(container.textContent).toContain("Current capacity pause");
    expect(container.querySelector('a[href="/submit?type=grading&tier=standard"]')).toBeNull();
  });
  it("keeps valid payment reachable, then hides its previous quote during refresh and failure", async () => {
    window.history.replaceState({}, "", "/submit?type=grading&tier=standard");
    localStorage.setItem(
      "mv-submit-wizard",
      JSON.stringify({
        v: "mv-wizard-v4",
        savedAt: Date.now(),
        step: 5,
        state: {
          type: "grading",
          tier: "standard",
          quantity: 1,
          declaredValue: 100,
          email: "synthetic@example.test",
          firstName: "Test",
          lastName: "Only",
          addressLine1: "1 Synthetic Street",
          city: "Test",
          postcode: "TE1 1ST",
        },
      })
    );
    await render(Submit);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
    expect(container.querySelector('[data-testid="button-pay"]')!.textContent).toContain("Pay £45.28");
    const originalFetch = fetch;
    let complete: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/grading/quote" ? pending : originalFetch(input, init)
      )
    );
    let refresh: Promise<unknown>;
    await act(async () => {
      refresh = client.invalidateQueries({ queryKey: ["/api/grading/quote"] });
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(container.querySelector('[data-testid="button-pay"]')!.textContent).toContain("Calculating");
    expect(container.textContent).not.toContain("Pay £45.28");
    await act(async () => {
      complete(new Response("Unavailable", { status: 503 }));
      await refresh;
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(container.querySelector<HTMLButtonElement>('[data-testid="button-pay"]')!.disabled).toBe(true);
    expect(container.textContent).not.toContain("Pay £45.28");
  });
  for (const service of ["reholder", "crossover", "authentication"]) {
    it(`switches to explicit ${service} pricing without retaining the grading tier`, async () => {
      window.history.replaceState({}, "", "/submit?type=grading&tier=standard");
      await render(Submit);
      const originalFetch = fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
          String(input) === `/api/service-tiers?serviceType=${service}`
            ? Promise.resolve(
                new Response(
                  JSON.stringify([
                    {
                      ...live,
                      id: service,
                      serviceType: service,
                      name: `DB ${service}`,
                      pricePerCard: 4101,
                      price: "£41.01 per card",
                    },
                  ])
                )
              )
            : originalFetch(input, init)
        )
      );
      await act(async () =>
        container.querySelector<HTMLButtonElement>(`[data-testid="button-other-service-${service}"]`)!.click()
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      expect(fetch).toHaveBeenCalledWith(
        `/api/service-tiers?serviceType=${service}`,
        expect.objectContaining({ cache: "no-store" })
      );
      expect(container.textContent).toContain(`DB ${service}`);
      expect(container.textContent).toContain("£41.01 per card");
      expect(container.querySelector('[data-testid="button-tier-standard"]')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="button-next"]')!.disabled).toBe(true);
      await act(async () =>
        container.querySelector<HTMLButtonElement>(`[data-testid="button-tier-${service}"]`)!.click()
      );
      expect(container.querySelector<HTMLButtonElement>('[data-testid="button-next"]')!.disabled).toBe(false);
    });
  }
});
