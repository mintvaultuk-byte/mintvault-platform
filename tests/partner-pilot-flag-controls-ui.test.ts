// @vitest-environment happy-dom
/**
 * Minimal Partner pilot flag controls — REAL component rendering.
 *
 * The production write path is still the canonical Super Admin API:
 * /api/super-admin/partner-flags/:flag. These tests fake only the client
 * apiRequest seam, so they prove the UI cannot address unsupported flags,
 * confirms before one-flag mutations, fails closed when reads fail, and never
 * renders secret/session material.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequest = vi.fn();
const invalidateQueries = vi.fn();
const navigate = vi.fn();

vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  queryClient: { invalidateQueries },
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children?: ReactNode; [key: string]: unknown }) =>
    createElement("a", { href, ...props }, children),
  useLocation: () => ["/admin/partner-network/partners", navigate],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

type FlagRow = { flag: string; enabled: boolean; configured: boolean; updatedAt: string | null };

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);

function fail(status: number, message: string) {
  const err = new Error(message) as Error & { status: number; body: unknown };
  err.status = status;
  err.body = { error: { message } };
  return Promise.reject(err);
}

const flagRows = (overrides: Partial<Record<string, boolean>> = {}): FlagRow[] => [
  {
    flag: "partner_portal_enabled",
    enabled: overrides.partner_portal_enabled ?? true,
    configured: true,
    updatedAt: null,
  },
  {
    flag: "partner_onboarding_enabled",
    enabled: overrides.partner_onboarding_enabled ?? false,
    configured: true,
    updatedAt: null,
  },
  {
    flag: "partner_login_enabled",
    enabled: overrides.partner_login_enabled ?? false,
    configured: true,
    updatedAt: null,
  },
  {
    flag: "public_partner_directory_enabled",
    enabled: overrides.public_partner_directory_enabled ?? false,
    configured: true,
    updatedAt: null,
  },
  {
    flag: "partner_connector_enabled",
    enabled: true,
    configured: true,
    updatedAt: null,
  },
];

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const requests = () => apiRequest.mock.calls.map((call) => ({ method: call[0], url: call[1], body: call[2] }));
const putRequests = () => requests().filter((call) => call.method === "PUT");

async function waitForTestId(id: string): Promise<HTMLElement> {
  for (let i = 0; i < 30; i += 1) {
    const el = q(id);
    if (el) return el;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`Timed out waiting for ${id}`);
}

async function mount(flags: FlagRow[] | "flag-read-fails" = flagRows(), authenticated = true) {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "GET" && url === "/api/super-admin/partner-flags") {
      if (flags === "flag-read-fails") return fail(503, "flags unavailable");
      return ok({ flags });
    }
    if (method === "GET" && String(url).startsWith("/api/super-admin/partner-management/partners")) {
      return ok({ partners: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
    }
    if (method === "PUT" && String(url).startsWith("/api/super-admin/partner-flags/")) {
      return ok({ ok: true });
    }
    return ok({});
  });
  (globalThis as { fetch?: unknown }).fetch = vi.fn(() =>
    ok({ authenticated, email: "admin@mintvault.test", isSuperAdmin: true })
  );
  const { AdminSessionProvider } = await import("../client/src/lib/admin-session");
  const { default: Page } = await import("../client/src/pages/admin/partner-management");
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => apiRequest("GET", String(queryKey[0])).then((r) => r.json()),
      },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(AdminSessionProvider, { children: createElement(Page) })
      )
    );
  });
  return qc;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiRequest.mockReset();
  invalidateQueries.mockReset();
  navigate.mockReset();
  window.confirm = vi.fn();
  window.prompt = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "prompt").mockReturnValue("Release validation complete");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Partner pilot flag controls", () => {
  it("does not read or mutate Partner controls when the real session authority rejects access", async () => {
    await mount(flagRows(), false);
    await waitForTestId("admin-session-checking");
    expect(navigate).toHaveBeenCalledWith(
      expect.stringContaining("/admin/login?next=%2Fadmin%2Fpartner-network%2Fpartners"),
      { replace: true }
    );
    expect(apiRequest).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid^="partner-flag-"]')).toBeNull();
  });

  it("loads current state through the canonical API and keeps the portal flag read-only", async () => {
    await mount(flagRows({ partner_onboarding_enabled: true, partner_login_enabled: false }));
    await waitForTestId("pm-pilot-flag-status-partner_portal_enabled");

    expect(requests().some((r) => r.method === "GET" && r.url === "/api/super-admin/partner-flags")).toBe(true);
    expect(q("pm-pilot-flag-status-partner_portal_enabled")?.textContent).toContain("Enabled");
    expect(q("pm-pilot-flag-status-partner_onboarding_enabled")?.textContent).toContain("Enabled");
    expect(q("pm-pilot-flag-status-partner_login_enabled")?.textContent).toContain("Disabled");
    expect(q("pm-pilot-portal-readonly")?.textContent).toContain("Read-only");
    expect(q("pm-pilot-flag-toggle-partner_portal_enabled")).toBeNull();
  });

  it("fails closed when flag state cannot be read", async () => {
    await mount("flag-read-fails");
    await waitForTestId("pm-pilot-flags-error");

    expect(q("pm-pilot-flags-error")?.textContent).toContain("disabled");
    expect(q("pm-pilot-flag-toggle-partner_onboarding_enabled")).toBeNull();
    expect(q("pm-pilot-flag-toggle-partner_login_enabled")).toBeNull();
  });

  it("confirmation enables exactly the selected supported flag and refreshes state", async () => {
    await mount(flagRows({ partner_onboarding_enabled: false, partner_login_enabled: false }));
    const button = await waitForTestId("pm-pilot-flag-toggle-partner_onboarding_enabled");

    await act(async () => button.click());

    expect(window.confirm).toHaveBeenCalledTimes(1);
    const puts = putRequests();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      method: "PUT",
      url: "/api/super-admin/partner-flags/partner_onboarding_enabled",
      body: {
        enabled: true,
        reason: "Pilot setup: Partner Onboarding enabled",
      },
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/super-admin/partner-flags"] });
    expect(q("pm-banner")?.textContent).toContain("Partner Onboarding enabled.");
  });

  it("cancelling confirmation sends no mutation", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await mount(flagRows());
    const button = await waitForTestId("pm-pilot-flag-toggle-partner_login_enabled");

    await act(async () => button.click());

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(putRequests()).toHaveLength(0);
  });

  it("requires a typed release reason before changing the public directory switch", async () => {
    await mount(flagRows({ public_partner_directory_enabled: false }));
    const button = await waitForTestId("pm-pilot-flag-toggle-public_partner_directory_enabled");

    await act(async () => button.click());

    expect(window.prompt).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(putRequests()).toEqual([
      {
        method: "PUT",
        url: "/api/super-admin/partner-flags/public_partner_directory_enabled",
        body: { enabled: true, reason: "Release validation complete" },
      },
    ]);
  });

  it("does not mutate the public directory when its reason prompt is cancelled or blank", async () => {
    vi.mocked(window.prompt).mockReturnValueOnce(null).mockReturnValueOnce("   ");
    await mount(flagRows({ public_partner_directory_enabled: false }));
    const button = await waitForTestId("pm-pilot-flag-toggle-public_partner_directory_enabled");

    await act(async () => button.click());
    await act(async () => button.click());

    expect(putRequests()).toHaveLength(0);
    expect(q("pm-banner")?.textContent).toContain("reason");
  });

  it("failed mutations show an error and do not report success", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (method === "GET" && url === "/api/super-admin/partner-flags") return ok({ flags: flagRows() });
      if (method === "GET" && String(url).startsWith("/api/super-admin/partner-management/partners")) {
        return ok({ partners: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
      }
      if (method === "PUT" && url === "/api/super-admin/partner-flags/partner_login_enabled") {
        return fail(409, "runtime flag disagreement");
      }
      return ok({});
    });
    (globalThis as { fetch?: unknown }).fetch = vi.fn(() =>
      ok({ authenticated: true, email: "admin@mintvault.test", isSuperAdmin: true })
    );
    const { AdminSessionProvider } = await import("../client/src/lib/admin-session");
    const { default: Page } = await import("../client/src/pages/admin/partner-management");
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: ({ queryKey }) => apiRequest("GET", String(queryKey[0])).then((r) => r.json()),
        },
        mutations: { retry: false },
      },
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(AdminSessionProvider, { children: createElement(Page) })
        )
      );
    });
    const button = await waitForTestId("pm-pilot-flag-toggle-partner_login_enabled");

    await act(async () => button.click());

    expect(q("pm-banner")?.textContent).toContain("runtime flag disagreement");
    expect(q("pm-banner")?.textContent).not.toContain("enabled.");
  });

  it("unsupported Partner flags cannot be submitted through the rendered UI", async () => {
    await mount(flagRows());
    await waitForTestId("pm-pilot-flags");
    await waitForTestId("pm-pilot-flag-public_partner_directory_enabled");

    expect(q("pm-pilot-flag-partner_connector_enabled")).toBeNull();
    expect(q("pm-pilot-flag-toggle-partner_connector_enabled")).toBeNull();
    expect(container.textContent).not.toContain("partner_connector_enabled");
    expect(container.textContent).not.toContain("partner_grading_enabled");
    expect(container.textContent).not.toContain("partner_payments_enabled");
    expect(q("pm-pilot-flag-public_partner_directory_enabled")).not.toBeNull();
  });

  it("renders no secret, session, credential or token material and logs none", async () => {
    await mount(flagRows());
    await waitForTestId("pm-pilot-flags");

    const html = container.innerHTML;
    expect(html).not.toMatch(/cookie|session|passphrase|password|pin|token|secret|mv\.sid/i);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
