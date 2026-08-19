// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { COMMAND_CENTRE_REGISTRY, type CommandCentreDashboardResponse } from "@shared/command-centre";

const apiRequest = vi.fn();
const navigate = vi.fn();
vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("../client/src/lib/queryClient")>("../client/src/lib/queryClient");
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequest(...args) };
});
vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children?: unknown; [key: string]: unknown }) => createElement("a", { href, ...props }, children),
  useLocation: () => ["/admin/command", navigate],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const kpiIds = ["partner-network-state", "partner-onboarding-blocked", "partner-credit-projection", "station-lifecycle-state", "connector-exception-count", "non-terminal-submissions", "scan-queue-backlog", "grading-queue-backlog", "grade-review-awaiting-decision", "print-batch-exceptions", "ownership-transfer-exceptions", "paid-submissions-recorded"] as const;
const sourceByKpi = Object.fromEntries(COMMAND_CENTRE_REGISTRY.flatMap((item) => item.kpiIds.map((id) => [id, item.canonicalSourceRefs[0]])));
const dashboard = (): CommandCentreDashboardResponse => ({
  contractVersion: "1.0.0",
  asOf: "2026-08-19T00:00:00.000Z",
  period: "today",
  kpis: Object.fromEntries(kpiIds.map((id) => [id, {
    status: id === "station-lifecycle-state" ? "ZERO" : "VALUE",
    value: id === "station-lifecycle-state" ? 0 : 2,
    ...(id === "station-lifecycle-state" ? { authoritativeZero: true } : {}),
    asOf: "2026-08-19T00:00:00.000Z",
    source: sourceByKpi[id],
    deepLink: id === "station-lifecycle-state" ? "/admin/partners/stations" : "/admin?tab=submissions",
    freshnessSeconds: 60,
  }])) as CommandCentreDashboardResponse["kpis"],
  attention: [{ ruleId: "ATT-STATION-PENDING", itemId: "station-lifecycle-pending", title: "Station lifecycle pending", reason: "Station lifecycle work requires attention.", severity: "MEDIUM", source: "partner-station-service", asOf: "2026-08-19T00:00:00.000Z", freshnessSeconds: 300, deepLink: "/admin/partners/stations" }],
  registry: COMMAND_CENTRE_REGISTRY,
  partialSourceIds: [],
});

let container: HTMLDivElement;
let root: Root;
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function waitFor(id: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const item = q(id);
    if (item) return item;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error("Timed out for " + id);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiRequest.mockReset();
  apiRequest.mockImplementation((method: string, url: string) => method === "GET" && url.startsWith("/api/admin/command/dashboard") ? ok(dashboard()) : ok({}));
  globalThis.fetch = vi.fn(() => ok({ env: "development", neon_host: "", db_name: "", card_master_active_count: 0, card_sets_active_count: 0, certificates_count: 0, command_centre_available: true }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.resetModules(); });

describe("Command Centre rendered controls", () => {
  it("uses the dashboard GET and makes the V1 explorer, KPI and attention controls change visible runtime state", async () => {
    const { default: Page } = await import("../client/src/pages/admin-command-centre");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ env: "development", neon_host: "", db_name: "", card_master_active_count: 0, card_sets_active_count: 0, certificates_count: 0, command_centre_available: true }) }, mutations: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Page))));
    const stationKpi = await waitFor("command-centre-kpi-station-lifecycle-state");
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/admin/command/dashboard?period=today");
    expect(stationKpi.classList.contains("command-centre-surface")).toBe(true);
    expect(stationKpi.getAttribute("href")).toBe("/admin/partners/stations");
    expect(q("command-centre-attention-ATT-STATION-PENDING")?.getAttribute("href")).toBe("/admin/partners/stations");
    await act(async () => q("command-centre-period")?.dispatchEvent(new Event("change", { bubbles: true })));
    const period = q("command-centre-period") as HTMLSelectElement;
    await act(async () => { period.value = "month_to_date"; period.dispatchEvent(new Event("change", { bubbles: true })); });
    await waitFor("command-centre-kpi-station-lifecycle-state");
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/admin/command/dashboard?period=month_to_date");
    const search = q("command-centre-search") as HTMLInputElement;
    await act(async () => { setInputValue(search, "station lifecycle"); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(q("command-centre-explorer-count")?.textContent).toContain("1 registry items");
    const detail = q("command-centre-detail-partners.station-lifecycle-review") as HTMLButtonElement;
    await act(async () => detail.click());
    expect(q("command-centre-link-partners.station-lifecycle-review")?.getAttribute("href")).toBe("/admin/partners/stations");
    await act(async () => { setInputValue(search, ""); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const onboardingDetail = q("command-centre-detail-partners.onboarding-readiness-review");
    await act(async () => onboardingDetail?.click());
    expect(q("command-centre-link-partners.onboarding-readiness-review")).toBeNull();
    const toggle = q("command-centre-explorer-toggle") as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(q("command-centre-search")).toBeNull();
    await act(async () => toggle.click());
    expect(q("command-centre-search")).not.toBeNull();
    await act(async () => (q("command-centre-refresh") as HTMLButtonElement).click());
    expect(apiRequest.mock.calls.filter((call) => call[0] === "GET" && String(call[1]).startsWith("/api/admin/command/dashboard")).length).toBeGreaterThanOrEqual(3);
  });

  it("renders STALE KPI envelopes as stale, not as fresh source values", async () => {
    const staleDashboard = dashboard();
    staleDashboard.kpis["scan-queue-backlog"] = {
      status: "STALE",
      lastValue: 7,
      asOf: "2026-08-19T00:00:00.000Z",
      source: "submissions-scan-queue",
      deepLink: "/admin?tab=scans",
      staleAfterSeconds: 60,
    };
    staleDashboard.partialSourceIds = ["submissions-scan-queue"];
    apiRequest.mockImplementation((method: string, url: string) => method === "GET" && url.startsWith("/api/admin/command/dashboard") ? ok(staleDashboard) : ok({}));
    const { default: Page } = await import("../client/src/pages/admin-command-centre");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ env: "development", neon_host: "", db_name: "", card_master_active_count: 0, card_sets_active_count: 0, certificates_count: 0, command_centre_available: true }) }, mutations: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Page))));
    const scanKpi = await waitFor("command-centre-kpi-scan-queue-backlog");

    expect(scanKpi.textContent).toContain("STALE");
    expect(scanKpi.textContent).toContain("7");
    expect(scanKpi.textContent).toContain("Last known source value; refresh is required");
    expect(q("command-centre-partial")?.textContent).toContain("Some canonical sources are unavailable or need review");
  });
});
