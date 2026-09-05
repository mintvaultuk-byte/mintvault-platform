// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
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
import HomeV2 from "../client/src/pages/home-v2-integrated";
import HomeV3 from "../client/src/pages/home-v3";
import HomeV4 from "../client/src/pages/home-v4";
import PricingV2 from "../client/src/pages/pricing-v2";
import PricingDemo from "../client/src/pages/pricing-demo";
import PricingAnimated from "../client/src/components/ui/pricing-animated";
import FAQ from "../client/src/pages/help/faq";
import VaultClub from "../client/src/pages/vault-club";
import { ValueCalculator } from "../client/src/pages/pre-grade";
import CertificateForm from "../client/src/components/certificate-form";
import HowItWorksV2 from "../client/src/pages/how-it-works-v2";
import { insuranceTiers, insuranceSurchargeBands, bulkDiscountTiers } from "../shared/commerce";
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

describe("price-free preview routes", () => {
  for (const [label, component] of [
    ["Home V2", HomeV2],
    ["Home V3", HomeV3],
    ["Home V4", HomeV4],
    ["Pricing V2", PricingV2],
    ["Pricing demo", PricingDemo],
    ["Animated pricing", PricingAnimated],
  ] as const) {
    it(`${label} sends visitors to current pricing without a duplicate grading catalogue`, () => {
      // Preview content has no live quote state. Render the real component tree
      // without running its continuous decorative scroll/animation effects.
      container = document.createElement("div");
      container.innerHTML = renderToStaticMarkup(createElement(component));
      const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href="/pricing"]')];
      expect(links.some((link) => /current grading prices/i.test(link.textContent ?? ""))).toBe(true);
      const text = (container.textContent ?? "").replace(/\s+/g, " ");
      expect(text).not.toMatch(/£\s*(?:19|25|45)(?![\d,.])|(?:40|45|21|15|5)[- ](?:working )?day|three tiers/i);
      expect(text).not.toContain("Most chosen");
      if (label.startsWith("Home") || label === "Pricing V2") {
        expect(text).toContain("centering, corners, edges, surface");
        expect(text).toContain("9.99");
      }
    });
  }
});

describe("remaining service price displays", () => {
  it("certificate tier identifiers are preserved without advertising static prices", () => {
    client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          enabled: false,
          queryFn: async () => {
            throw new Error("No certificate network requests in SSR label proof");
          },
        },
      },
    });
    container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CertificateForm, { certificate: null, onSuccess: () => {} })
      )
    );
    const select = container.querySelector<HTMLSelectElement>('[data-testid="select-service-tier"]')!;
    expect([...select.options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ["", "Standard (default)"],
      ["vault-queue", "Vault Queue"],
      ["standard", "Standard"],
      ["express", "Express"],
    ]);
  });
  it("how-it-works preview does not promise fixed return coverage", () => {
    container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(createElement(HowItWorksV2));
    expect(container.textContent).toContain("Based on declared value");
    expect(container.textContent).not.toContain("£2,500");
  });
  it("FAQ opens price and turnaround guidance without stale catalogue values", async () => {
    await render(FAQ);
    for (const question of ["What's the turnaround time?", "How much does grading cost?"]) {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes(question)
      )!;
      await act(async () => button.click());
      expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
      expect(container.textContent).not.toMatch(/£(?:19|25|45)|(?:40|15|5) working days/);
    }
  });
  it("membership savings do not promise a fixed grading fee or break-even", async () => {
    await render(VaultClub);
    expect(container.textContent).toContain("£9.99");
    expect(container.textContent).toContain("£99");
    expect(container.textContent).not.toMatch(/£25|£2\.50|four cards|4 cards|bulk wins|overtakes Silver/i);
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
  });
  it("MintVault calculator does not invent a current fee or net-gain recommendation", async () => {
    await render(() => createElement(ValueCalculator, { initialGrade: 10 }));
    const input = container.querySelector<HTMLInputElement>('[data-testid="input-raw-value"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="text-expected"]')!.textContent).toContain("300.00");
    expect(container.querySelector('[data-testid="text-fee"]')!.textContent).not.toContain("£");
    expect(container.querySelector('[data-testid="text-net"]')!.textContent).toBe("—");
    expect(container.querySelector('[data-testid="text-verdict"]')).toBeNull();
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
    const service = container.querySelector<HTMLSelectElement>('[data-testid="select-service"]')!;
    await act(async () => {
      service.value = "psa";
      service.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="text-fee"]')!.textContent).toBe("£22.00");
    expect(container.querySelector('[data-testid="text-net"]')!.textContent).toBe("+£178.00");
    expect(container.textContent).toContain("illustrative £22 estimate");
    await act(async () => {
      service.value = "mintvault";
      service.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="text-net"]')!.textContent).toBe("—");
    expect(container.querySelector('[data-testid="text-verdict"]')).toBeNull();
  });
  for (const [label, component] of [
    ["Pricing", Pricing],
    ["Pricing V2", PricingV2],
  ] as const) {
    it(`${label} links each other service to explicit current selection`, async () => {
      if (label === "Pricing") await render(component);
      else {
        container = document.createElement("div");
        container.innerHTML = renderToStaticMarkup(createElement(component));
      }
      for (const type of ["reholder", "crossover", "authentication"]) {
        expect(container.querySelector(`a[href="/submit?type=${type}"]`)?.textContent).toContain("Current prices");
      }
      expect(container.textContent).not.toMatch(/£(?:15|35)(?![\d,.])/);
      expect(container.textContent).not.toMatch(/No percentage discount|Subscriptions temporarily paused|Tier only changes/);
    });
  }
  for (const [label, component] of [
    ["Pricing", Pricing],
    ["Pricing V2", PricingV2],
  ] as const) {
    it(`${label} insurance, shipping and bulk cards follow shared policy inputs`, async () => {
      const shipping = insuranceTiers[0].shippingPence;
      const surcharge = insuranceSurchargeBands[1].surchargePence;
      const percent = bulkDiscountTiers[1].percent;
      const shippingMax = insuranceTiers[3].maxValue;
      const surchargeMax = insuranceSurchargeBands[3].maxValue;
      try {
        insuranceTiers[0].shippingPence = 643;
        insuranceSurchargeBands[1].surchargePence = 357;
        bulkDiscountTiers[1].percent = 6.25;
        insuranceTiers[3].maxValue = 8123;
        insuranceSurchargeBands[3].maxValue = 8123;
        if (label === "Pricing") await render(component);
        else {
          container = document.createElement("div");
          container.innerHTML = renderToStaticMarkup(createElement(component));
        }
        expect(container.textContent).toContain("£6.43");
        expect(container.textContent).toContain("£3.57");
        expect(container.textContent).toContain("6.25%");
        expect(container.textContent).toContain("8,123");
        expect(container.textContent).not.toMatch(/7,500|7\.5k/);
      } finally {
        insuranceTiers[0].shippingPence = shipping;
        insuranceSurchargeBands[1].surchargePence = surcharge;
        bulkDiscountTiers[1].percent = percent;
        insuranceTiers[3].maxValue = shippingMax;
        insuranceSurchargeBands[3].maxValue = surchargeMax;
      }
    });
  }
});
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
