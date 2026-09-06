// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminPricing from "../client/src/pages/admin-pricing";
import { fetchPricingProjection, usePricingProjection } from "../client/src/lib/pricing-projection";

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;
const row = {
  id: 41,
  serviceType: "grading",
  tierId: "standard",
  name: "Current grading tier",
  pricePerCard: 3729,
  turnaroundDays: 17,
  turnaroundLabel: null,
  maxValueGbp: 4500,
  features: ["Current feature"],
  isActive: true,
  sortOrder: 1,
};
async function renderAdmin(rows: unknown[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("No external requests in UI proof")))
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => rows } },
  });
  client.setQueryData(["/api/admin/service-tiers"], rows);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(QueryClientProvider, { client }, createElement(AdminPricing))));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Database-shaped commercial pricing contract", () => {
  it("renders camel-case grading records and opens their exact pence/days/value editor", async () => {
    await renderAdmin([row, { ...row, id: 42, serviceType: "reholder", name: "Other service" }]);
    expect(container.textContent).toContain("Current grading tier");
    expect(container.textContent).toContain("£37.29 per card");
    expect(container.textContent).toContain("17 working days");
    expect(container.textContent).not.toContain("Other service");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="button-edit-tier-standard"]')!.click()
    );
    expect(container.querySelector<HTMLInputElement>('[data-testid="input-edit-price"]')!.value).toBe("3729");
    expect(container.querySelector<HTMLInputElement>('[data-testid="input-edit-turnaround"]')!.value).toBe("17");
    expect(container.querySelector<HTMLInputElement>('[data-testid="input-edit-maxvalue"]')!.value).toBe("4500");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("saves exact pence and invalidates Admin, live tiers and active promotion caches", async () => {
    await renderAdmin([row]);
    const invalidation = vi.spyOn(client, "invalidateQueries");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(row), { status: 200 }))
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="button-edit-tier-standard"]')!.click()
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-save-tier"]')!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/service-tiers/41",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ pricePerCard: 3729, turnaroundDays: 17, maxValueGbp: 4500, isActive: true }),
      })
    );
    for (const key of ["/api/admin/service-tiers", "/api/service-tiers", "/api/promotions/active"])
      expect(invalidation).toHaveBeenCalledWith({ queryKey: [key] });
    expect(container.querySelector('[data-testid="input-edit-price"]')).toBeNull();
  });
});

const live = {
  id: "standard",
  serviceType: "grading",
  name: "Live grading",
  price: "£37.29 per card",
  pricePerCard: 3729,
  turnaroundDays: 17,
  turnaround: "17 working days",
  recommendedCardValue: "Up to £4,500",
  features: ["Live feature"],
  capacityStatus: "open",
  capacityPausedUntil: null,
  capacityMessage: null,
};
describe("Live display transport fails closed without static price authority", () => {
  it("fetches an explicit service without HTTP caching and accepts only that live contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([live]), { status: 200 }))
    );
    expect(await fetchPricingProjection("grading")).toEqual([live]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/service-tiers?serviceType=grading",
      expect.objectContaining({ cache: "no-store" })
    );
  });
  it("rejects HTTP failure, wrong service, malformed amounts and missing capacity instead of seed prices", async () => {
    for (const payload of [
      null,
      {},
      [{ ...live, price: "£19 per card" }],
      [{ ...live, serviceType: "reholder" }],
      [{ ...live, pricePerCard: 37.29 }],
      [{ ...live, capacityStatus: undefined }],
      [{ ...live, capacityPausedUntil: 42 }],
      [{ ...live, capacityMessage: { bad: true } }],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
      );
      await expect(fetchPricingProjection("grading")).rejects.toThrow("Invalid current pricing response");
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unavailable", { status: 503 }))
    );
    await expect(fetchPricingProjection("grading")).rejects.toThrow("Current pricing is unavailable");
  });
  it("removes previously cached live tiers on refetch failure and never substitutes £19/£25/£45", async () => {
    await renderAdmin([]);
    client.setQueryData(["/api/service-tiers", "grading"], [live]);
    let refresh: (() => Promise<unknown>) | undefined;
    function Consumer() {
      const pricing = usePricingProjection();
      refresh = () => pricing.refetch();
      return createElement("div", null, pricing.tiers.map((tier) => tier.price).join(",") || "Pricing unavailable");
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([live]), { status: 200 }))
    );
    await act(async () => root!.render(createElement(QueryClientProvider, { client }, createElement(Consumer))));
    expect(container.textContent).toBe("£37.29 per card");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unavailable", { status: 503 }))
    );
    await act(async () => {
      await refresh!();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(container.textContent).toBe("Pricing unavailable");
  });
});
