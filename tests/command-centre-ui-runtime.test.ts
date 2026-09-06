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
  Link: ({ href, children, ...props }: { href: string; children?: unknown; [key: string]: unknown }) =>
    createElement("a", { href, ...props }, children),
  useLocation: () => ["/admin/command", navigate],
  useSearch: () => window.location.search,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const kpiIds = [
  "partner-network-state",
  "partner-onboarding-blocked",
  "partner-credit-projection",
  "station-lifecycle-state",
  "connector-exception-count",
  "non-terminal-submissions",
  "scan-queue-backlog",
  "grading-queue-backlog",
  "grade-review-awaiting-decision",
  "print-batch-exceptions",
  "ownership-transfer-exceptions",
  "paid-submissions-recorded",
] as const;
const sourceByKpi = Object.fromEntries(
  COMMAND_CENTRE_REGISTRY.flatMap((item) => item.kpiIds.map((id) => [id, item.canonicalSourceRefs[0]]))
);
const dashboard = (): CommandCentreDashboardResponse => ({
  contractVersion: "1.0.0",
  asOf: "2026-08-19T00:00:00.000Z",
  period: "today",
  kpis: Object.fromEntries(
    kpiIds.map((id) => [
      id,
      {
        status: id === "station-lifecycle-state" ? "ZERO" : "VALUE",
        value: id === "station-lifecycle-state" ? 0 : 2,
        ...(id === "station-lifecycle-state" ? { authoritativeZero: true } : {}),
        asOf: "2026-08-19T00:00:00.000Z",
        source: sourceByKpi[id],
        deepLink: id === "station-lifecycle-state" ? "/admin/partners/stations" : "/admin?tab=submissions",
        freshnessSeconds: 60,
      },
    ])
  ) as CommandCentreDashboardResponse["kpis"],
  attention: [
    {
      ruleId: "ATT-STATION-PENDING",
      itemId: "station-lifecycle-pending",
      title: "Station lifecycle pending",
      reason: "Station lifecycle work requires attention.",
      severity: "MEDIUM",
      source: "partner-station-service",
      asOf: "2026-08-19T00:00:00.000Z",
      freshnessSeconds: 300,
      deepLink: "/admin/partners/stations",
    },
  ],
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("Timed out for " + id);
}
async function renderPage(client: QueryClient, Page: React.ComponentType) {
  const { AdminSessionProvider } = await import("../client/src/lib/admin-session");
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AdminSessionProvider, null, createElement(Page))
      )
    )
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/admin/command");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiRequest.mockReset();
  navigate.mockReset();
  apiRequest.mockImplementation((method: string, url: string) =>
    method === "GET" && url.startsWith("/api/admin/command/dashboard") ? ok(dashboard()) : ok({})
  );
  globalThis.fetch = vi.fn((input: RequestInfo | URL) =>
    String(input) === "/api/admin/session"
      ? ok({ authenticated: true, email: "admin@example.test", isSuperAdmin: true })
      : ok({
          env: "development",
          neon_host: "",
          db_name: "",
          card_master_active_count: 0,
          card_sets_active_count: 0,
          certificates_count: 0,
          command_centre_available: true,
        })
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Command Centre rendered controls", () => {
  it("preserves distinct 403 copy and a 401 login return path without rendering dashboard data", async () => {
    const { default: Page } = await import("../client/src/pages/admin-command-centre");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    apiRequest.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await renderPage(client, Page);
    const forbidden = await waitFor("command-centre-forbidden");
    expect(forbidden.textContent).toContain("Super Admin access required");
    expect(q("command-centre-kpi-station-lifecycle-state")).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    apiRequest.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await renderPage(client, Page);
    for (let attempt = 0; attempt < 30 && navigate.mock.calls.length === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(navigate).toHaveBeenCalledWith("/admin/login?next=%2Fadmin%2Fcommand", { replace: true });
    expect(q("command-centre-kpi-station-lifecycle-state")).toBeNull();
  });

  it("never reuses an infinitely-fresh privileged payload after unmount when the guarded API becomes 404", async () => {
    const { default: Page } = await import("../client/src/pages/admin-command-centre");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    await renderPage(client, Page);
    await waitFor("command-centre-kpi-station-lifecycle-state");
    expect(apiRequest.mock.calls.filter((call) => call[0] === "GET")).toHaveLength(1);

    await act(async () => root.unmount());
    expect(client.getQueriesData({ queryKey: ["protected", "command-centre"] })).toEqual([]);
    root = createRoot(container);
    apiRequest.mockImplementation((method: string) =>
      method === "GET" ? Promise.reject(Object.assign(new Error("Not found"), { status: 404 })) : ok({})
    );
    await renderPage(client, Page);
    await waitFor("command-centre-unavailable");
    expect(q("command-centre-kpi-station-lifecycle-state")).toBeNull();
    expect(q("nav-command-centre-group")).toBeNull();
    expect(apiRequest.mock.calls.filter((call) => call[0] === "GET")).toHaveLength(2);
  });

  it.each([
    [403, "command-centre-forbidden"],
    [404, "command-centre-unavailable"],
  ] as const)("evicts every privileged period after an in-place %i denial", async (status, denialTestId) => {
    const { default: Page } = await import("../client/src/pages/admin-command-centre");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(["protected", "command-centre", "dashboard", "month"], dashboard());
    await renderPage(client, Page);
    await waitFor("command-centre-kpi-station-lifecycle-state");

    apiRequest.mockRejectedValue(Object.assign(new Error("Denied"), { status }));
    await act(async () => {
      (q("command-centre-refresh") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await waitFor(denialTestId);

    expect(q("command-centre-kpi-station-lifecycle-state")).toBeNull();
    expect(client.getQueriesData({ queryKey: ["protected", "command-centre"] })).toEqual([]);
  });

  it("uses the dashboard GET and makes the V1 explorer, KPI and attention controls change visible runtime state", async () => {
    const { default: Page } = await import("../client/src/pages/admin-command-centre");
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: async () => ({
            env: "development",
            neon_host: "",
            db_name: "",
            card_master_active_count: 0,
            card_sets_active_count: 0,
            certificates_count: 0,
            command_centre_available: true,
          }),
        },
        mutations: { retry: false },
      },
    });
    await renderPage(client, Page);
    const stationKpi = await waitFor("command-centre-kpi-station-lifecycle-state");
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/admin/command/dashboard?period=today");
    expect(stationKpi.classList.contains("command-centre-surface")).toBe(true);
    expect(stationKpi.classList.contains("min-w-0")).toBe(true);
    expect(stationKpi.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(stationKpi.getAttribute("href")).toBe("/admin/partners/stations");
    expect(q("command-centre-attention-ATT-STATION-PENDING")?.getAttribute("href")).toBe("/admin/partners/stations");
    expect(q("nav-command-centre")?.getAttribute("href")).toBe("/admin/command");
    expect(q("command-centre-search")).not.toBeNull();
    expect(q("nav-command-centre-work-tree")?.getAttribute("href")).toBe("/admin/command?view=tree");
    const navToggle = q("nav-command-centre-toggle") as HTMLButtonElement;
    await act(async () => navToggle.click());
    expect(q("nav-command-centre-work-tree")).toBeNull();
    await act(async () => navToggle.click());
    expect(q("nav-command-centre-skills")?.getAttribute("href")).toBe("/admin/command?view=skills");
    window.history.replaceState({}, "", "/admin/command?view=tree");
    await act(async () => q("command-centre-period")?.dispatchEvent(new Event("change", { bubbles: true })));
    const period = q("command-centre-period") as HTMLSelectElement;
    await act(async () => {
      period.value = "month_to_date";
      period.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/admin/command/dashboard?period=month_to_date");
    const search = (await waitFor("command-centre-search")) as HTMLInputElement;
    await act(async () => {
      setInputValue(search, "x".repeat(100));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(search.value).toHaveLength(80);
    await act(async () => {
      setInputValue(search, "station lifecycle");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q("command-centre-explorer-count")?.textContent).toContain("1 registry items");
    const kpiStatus = q("command-centre-kpi-status-filter") as HTMLSelectElement;
    await act(async () => {
      kpiStatus.value = "ZERO";
      kpiStatus.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q("command-centre-explorer-count")?.textContent).toContain("1 registry items");
    await act(async () => {
      kpiStatus.value = "VALUE";
      kpiStatus.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q("command-centre-explorer-count")?.textContent).toContain("0 registry items");
    await act(async () => {
      kpiStatus.value = "all";
      kpiStatus.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const detail = q("command-centre-detail-partners.station-lifecycle-review") as HTMLButtonElement;
    await act(async () => detail.click());
    expect(q("command-centre-detail-dialog")?.getAttribute("role")).toBe("dialog");
    const close = q("command-centre-detail-close") as HTMLButtonElement;
    const workspaceLink = q("command-centre-link-partners.station-lifecycle-review") as HTMLAnchorElement;
    expect(workspaceLink.getAttribute("href")).toBe("/admin/partners/stations");
    expect(document.activeElement).toBe(close);
    await act(async () =>
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }))
    );
    expect(document.activeElement).toBe(workspaceLink);
    await act(async () => workspaceLink.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(close);
    await act(async () => (q("command-centre-detail-close") as HTMLButtonElement).click());
    expect(document.activeElement).toBe(detail);
    await act(async () => {
      setInputValue(search, "");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const department = q("command-centre-department-filter") as HTMLSelectElement;
    await act(async () => {
      department.value = "finance";
      department.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q("command-centre-explorer-count")?.textContent).toContain("1 registry items");
    await act(async () => {
      department.value = "all";
      department.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const registryStatus = q("command-centre-registry-status-filter") as HTMLSelectElement;
    await act(async () => {
      registryStatus.value = "DEFERRED";
      registryStatus.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q("command-centre-explorer-count")?.textContent).toContain("0 registry items");
    await act(async () => {
      registryStatus.value = "all";
      registryStatus.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const onboardingDetail = q("command-centre-detail-partners.onboarding-readiness-review");
    await act(async () => onboardingDetail?.click());
    expect(q("command-centre-link-partners.onboarding-readiness-review")).toBeNull();
    await act(async () =>
      q("command-centre-detail-dialog")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    );
    expect(q("command-centre-detail-dialog")).toBeNull();
    await act(async () => (q("command-centre-refresh") as HTMLButtonElement).click());
    expect(
      apiRequest.mock.calls.filter(
        (call) => call[0] === "GET" && String(call[1]).startsWith("/api/admin/command/dashboard")
      ).length
    ).toBeGreaterThanOrEqual(3);
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
    apiRequest.mockImplementation((method: string, url: string) =>
      method === "GET" && url.startsWith("/api/admin/command/dashboard") ? ok(staleDashboard) : ok({})
    );
    const { default: Page } = await import("../client/src/pages/admin-command-centre");
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: async () => ({
            env: "development",
            neon_host: "",
            db_name: "",
            card_master_active_count: 0,
            card_sets_active_count: 0,
            certificates_count: 0,
            command_centre_available: true,
          }),
        },
        mutations: { retry: false },
      },
    });
    await renderPage(client, Page);
    const scanKpi = await waitFor("command-centre-kpi-scan-queue-backlog");

    expect(scanKpi.textContent).toContain("STALE");
    expect(scanKpi.textContent).toContain("7");
    expect(scanKpi.textContent).toContain("Last known source value; refresh is required");
    expect(q("command-centre-partial")?.textContent).toContain("Affected canonical sources: submissions-scan-queue");
    expect(scanKpi.textContent).toContain("stale after 60s");
    const detail = await waitFor("command-centre-detail-grading.scan-queue-triage");
    await act(async () => detail.click());
    expect(q("command-centre-detail-dialog")?.textContent).toContain("stale after 60s");
    expect(q("command-centre-page")?.textContent).toContain("Grading Operations");
  });
});
