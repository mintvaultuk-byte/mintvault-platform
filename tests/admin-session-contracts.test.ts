// @vitest-environment happy-dom

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const routing = vi.hoisted(() => ({
  pathname: "/admin",
  navigate: vi.fn(),
}));

vi.mock("wouter", () => ({
  useLocation: () => [routing.pathname, routing.navigate],
}));
import {
  adminFetch,
  ApiError,
  apiRequest,
  getActiveAdminPrincipal,
  getQueryFn,
  isAdminPrincipalQuery,
  scopedQueryHash,
  subscribeAdminUnauthorized,
  transitionAdminPrincipal,
} from "../client/src/lib/queryClient";
import {
  AdminSessionProvider,
  adminSessionResultFromResponse,
  createAdminLogoutCommand,
  isProtectedAdminLocation,
  useAdminSession,
} from "../client/src/lib/admin-session";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, queryKeyHashFn: scopedQueryHash },
      mutations: { retry: false },
    },
  });
}

function adminPrincipal(email: string, isSuperAdmin = false) {
  return { email, isSuperAdmin };
}

afterEach(async () => {
  await transitionAdminPrincipal(makeClient(), null);
  routing.pathname = "/admin";
  window.history.replaceState(null, "", "/");
  routing.navigate.mockReset();
  vi.restoreAllMocks();
});

async function waitForElement(container: HTMLElement, testId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (element) return element;
    await act(async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    });
  }
  throw new Error(`Timed out waiting for ${testId}`);
}

function SessionProbe() {
  const session = useAdminSession();
  return createElement(
    "div",
    { "data-testid": "admin-session-probe" },
    createElement("span", { "data-testid": "admin-session-email" }, session.principal?.email ?? "none"),
    createElement(
      "button",
      { type: "button", "data-testid": "admin-session-logout", onClick: () => void session.logout() },
      "Log out"
    )
  );
}

function renderProvider(client: QueryClient, container: HTMLElement): Root {
  const root = createRoot(container);
  renderProviderInto(root, client);
  return root;
}

function renderProviderInto(root: Root, client: QueryClient) {
  root.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AdminSessionProvider, null, createElement(SessionProbe))
    )
  );
}

function filesUnder(root: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) result.push(...filesUnder(path));
    else result.push(path);
  }
  return result;
}

describe("Admin identity/session authority", () => {
  it("guards every Admin location except the login and intentional public certificate alias", () => {
    expect(isProtectedAdminLocation("/admin")).toBe(true);
    expect(isProtectedAdminLocation("/admin/growth")).toBe(true);
    expect(isProtectedAdminLocation("/admin/partners/shop-1")).toBe(true);
    expect(isProtectedAdminLocation("/admin/login")).toBe(false);
    expect(isProtectedAdminLocation("/admin/cert/MV123")).toBe(false);
    expect(isProtectedAdminLocation("/administrator")).toBe(false);
  });

  it("keeps authenticated, expired, wrong-portal, unavailable, and invalid payloads distinct", async () => {
    await expect(
      adminSessionResultFromResponse(
        new Response(JSON.stringify({ authenticated: true, email: " Owner@MintVault.example ", isSuperAdmin: true }), {
          status: 200,
        })
      )
    ).resolves.toEqual({
      kind: "authenticated",
      principal: { email: "owner@mintvault.example", isSuperAdmin: true },
    });
    await expect(
      adminSessionResultFromResponse(
        new Response(JSON.stringify({ authenticated: false, reason: "session_expired" }), { status: 401 })
      )
    ).resolves.toEqual({ kind: "unauthenticated", reason: "session_expired" });
    await expect(
      adminSessionResultFromResponse(
        new Response(JSON.stringify({ authenticated: false, reason: "wrong_portal" }), { status: 403 })
      )
    ).resolves.toEqual({ kind: "unauthenticated", reason: "wrong_portal" });
    await expect(
      adminSessionResultFromResponse(new Response("upstream unavailable", { status: 503 }))
    ).resolves.toEqual({ kind: "unavailable", status: 503 });
    await expect(
      adminSessionResultFromResponse(new Response(JSON.stringify({ authenticated: true }), { status: 200 }))
    ).resolves.toEqual({ kind: "unavailable", status: 200 });
  });

  it("partitions Admin queries by principal while preserving public cache entries", async () => {
    const client = makeClient();
    const publicKeys = [
      ["/api/capacity"],
      ["/api/catalogue/snapshot"],
      ["/api/config/public-flags"],
      ["/api/promotions/active"],
      ["/api/service-tiers"],
      ["public", "explicit-projection"],
    ];
    for (const publicKey of publicKeys) client.setQueryData(publicKey, { visible: true });

    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    client.setQueryData(["/api/admin/certificates"], [{ id: "A-only" }]);
    const aQuery = client.getQueryCache().find({ queryKey: ["/api/admin/certificates"] });
    expect(aQuery && isAdminPrincipalQuery(aQuery)).toBe(true);

    await transitionAdminPrincipal(client, adminPrincipal("admin-b@example.test"));

    expect(getActiveAdminPrincipal()).toEqual(adminPrincipal("admin-b@example.test"));
    expect(client.getQueryData(["/api/admin/certificates"])).toBeUndefined();
    for (const publicKey of publicKeys) {
      expect(client.getQueryData(publicKey), publicKey.join("/")).toEqual({ visible: true });
      const query = client.getQueryCache().find({ queryKey: publicKey });
      expect(query && isAdminPrincipalQuery(query), publicKey.join("/")).toBe(false);
    }
  });

  it("cancels in-flight principal work before changing identity", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    let aborted = false;
    const pending = client.fetchQuery({
      queryKey: ["/api/admin/certificates"],
      queryFn: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    await transitionAdminPrincipal(client, adminPrincipal("admin-b@example.test"));

    await expect(pending).rejects.toBeDefined();
    expect(aborted).toBe(true);
    expect(client.getQueryData(["/api/admin/certificates"])).toBeUndefined();
  });

  it("clears principal A data from mounted observers before publishing principal B", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    client.setQueryData(["/api/admin/certificates"], [{ id: "A-only" }]);
    const observer = new QueryObserver(client, {
      queryKey: ["/api/admin/certificates"],
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(observer.getCurrentResult().data).toEqual([{ id: "A-only" }]);

    await transitionAdminPrincipal(client, adminPrincipal("admin-b@example.test"));

    expect(observer.getCurrentResult().data).toBeUndefined();
    client.setQueryData(["/api/admin/certificates"], [{ id: "B-only" }]);
    expect(client.getQueryData(["/api/admin/certificates"])).toEqual([{ id: "B-only" }]);
    expect(observer.getCurrentResult().data).not.toEqual([{ id: "A-only" }]);
    unsubscribe();
  });

  it("does not let an older transition publish identity or delete a newer principal's cache", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    let releaseCancellation!: () => void;
    vi.spyOn(client, "cancelQueries")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolveCancellation) => {
            releaseCancellation = resolveCancellation;
          })
      )
      .mockResolvedValue(undefined);

    const staleAuthentication = transitionAdminPrincipal(client, adminPrincipal("admin-b@example.test"));
    await Promise.resolve();
    await transitionAdminPrincipal(client, adminPrincipal("admin-c@example.test"));
    client.setQueryData(["/api/admin/certificates"], [{ id: "C-only" }]);
    releaseCancellation();
    await staleAuthentication;

    expect(getActiveAdminPrincipal()).toEqual(adminPrincipal("admin-c@example.test"));
    expect(client.getQueryData(["/api/admin/certificates"])).toEqual([{ id: "C-only" }]);
  });

  it("purges Super Admin state when the same account is downgraded", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin@example.test", true));
    client.setQueryData(["/api/super-admin/partner-management"], [{ id: "super-only" }]);

    await transitionAdminPrincipal(client, adminPrincipal("admin@example.test", false));

    expect(getActiveAdminPrincipal()).toEqual(adminPrincipal("admin@example.test", false));
    expect(client.getQueryData(["/api/super-admin/partner-management"])).toBeUndefined();
    expect(client.getQueryCache().getAll().some(isAdminPrincipalQuery)).toBe(false);
  });

  it("does not let a same-principal verification cancel an in-flight logout purge", async () => {
    const client = makeClient();
    const principal = adminPrincipal("admin@example.test", true);
    await transitionAdminPrincipal(client, principal);
    client.setQueryData(["/api/super-admin/partner-management"], [{ id: "A-only" }]);
    let releaseCancellation!: () => void;
    vi.spyOn(client, "cancelQueries").mockImplementationOnce(
      () =>
        new Promise<void>((resolveCancellation) => {
          releaseCancellation = resolveCancellation;
        })
    );

    const logoutTransition = transitionAdminPrincipal(client, null);
    await Promise.resolve();
    await transitionAdminPrincipal(client, principal);
    releaseCancellation();
    await logoutTransition;

    expect(getActiveAdminPrincipal()).toBeNull();
    expect(client.getQueryData(["/api/super-admin/partner-management"])).toBeUndefined();
    expect(client.getQueryCache().getAll().some(isAdminPrincipalQuery)).toBe(false);
  });

  it("never maps a protected 401 to nullable domain data and emits typed revalidation", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    const observed: ApiError[] = [];
    const unsubscribe = subscribeAdminUnauthorized((error) => observed.push(error));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Session expired" }), {
          status: 401,
          statusText: "Unauthorized",
        })
      )
    );

    await expect(
      client.fetchQuery({
        queryKey: ["/api/admin/certificates"],
        queryFn: getQueryFn({ on401: "returnNull" }),
      })
    ).rejects.toMatchObject({ status: 401, body: { error: "Session expired" } });
    expect(observed).toHaveLength(1);
    unsubscribe();
  });

  it("turns a legacy protected fetch 401 into the same typed revalidation signal", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    window.history.replaceState(null, "", "/admin");
    const observed: ApiError[] = [];
    const unsubscribe = subscribeAdminUnauthorized((error) => observed.push(error));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Session expired" }), {
          status: 401,
          statusText: "Unauthorized",
        })
      )
    );

    await expect(adminFetch("/api/admin/community?filter=all", { credentials: "include" })).rejects.toMatchObject({
      status: 401,
      body: { error: "Session expired" },
      requestUrl: "/api/admin/community?filter=all",
    });
    expect(observed).toHaveLength(1);
    unsubscribe();
  });

  it("keeps credential-rejection 401s typed without revalidating the valid Admin session", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test", true));
    const observed: ApiError[] = [];
    const unsubscribe = subscribeAdminUnauthorized((error) => observed.push(error));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Invalid credentials", code: "admin_credential_rejected" }), {
          status: 401,
          statusText: "Unauthorized",
        })
      )
    );

    await expect(
      apiRequest(
        "POST",
        "/api/admin/step-up",
        { password: "wrong", pin: "000000" },
        { adminUnauthorizedPolicy: "credential-rejection-aware" }
      )
    ).rejects.toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(getActiveAdminPrincipal()).toEqual(adminPrincipal("admin-a@example.test", true));
    expect(observed).toHaveLength(0);
    unsubscribe();
  });

  it("lets native-response credential forms handle a 401 without expiring the Admin session", async () => {
    const client = makeClient();
    const principal = adminPrincipal("admin-a@example.test", true);
    await transitionAdminPrincipal(client, principal);
    window.history.replaceState(null, "", "/admin/security");
    const observed: ApiError[] = [];
    const unsubscribe = subscribeAdminUnauthorized((error) => observed.push(error));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "Invalid credentials", code: "admin_credential_rejected" }),
          { status: 401 }
        )
      )
    );

    const response = await adminFetch("/api/admin/credentials/pin", {
      method: "POST",
      adminUnauthorizedPolicy: "credential-rejection-aware",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "admin_credential_rejected" });
    expect(getActiveAdminPrincipal()).toEqual(principal);
    expect(observed).toHaveLength(0);
    unsubscribe();
  });

  it("still revalidates a real session-expiry 401 from a credential endpoint", async () => {
    const client = makeClient();
    const principal = adminPrincipal("admin-a@example.test", true);
    await transitionAdminPrincipal(client, principal);
    window.history.replaceState(null, "", "/admin/security");
    const observed: ApiError[] = [];
    const unsubscribe = subscribeAdminUnauthorized((error) => observed.push(error));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Session expired" }), {
          status: 401,
          statusText: "Unauthorized",
        })
      )
    );

    await expect(
      adminFetch("/api/admin/credentials/pin", {
        method: "POST",
        adminUnauthorizedPolicy: "credential-rejection-aware",
      })
    ).rejects.toMatchObject({ status: 401, body: { error: "Session expired" } });
    expect(observed).toHaveLength(1);
    unsubscribe();
  });

  it("uses one POST-only logout flight and purges principal state only after success", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    client.setQueryData(["/api/admin/certificates"], [{ id: "A-only" }]);
    let resolveLogout!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => {
        resolveLogout = resolve;
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const logout = createAdminLogoutCommand(client);

    const first = logout();
    const second = logout();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/logout",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(getActiveAdminPrincipal()).toEqual(adminPrincipal("admin-a@example.test"));

    resolveLogout(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await first;

    expect(getActiveAdminPrincipal()).toBeNull();
    expect(client.getQueryData(["/api/admin/certificates"])).toBeUndefined();
  });

  it("keeps the active principal and cache when logout fails", async () => {
    const client = makeClient();
    await transitionAdminPrincipal(client, adminPrincipal("admin-a@example.test"));
    client.setQueryData(["/api/admin/certificates"], [{ id: "A-only" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Logout failed" }), { status: 500 }))
    );

    await expect(createAdminLogoutCommand(client)()).rejects.toMatchObject({ status: 500 });
    expect(getActiveAdminPrincipal()).toEqual(adminPrincipal("admin-a@example.test"));
    expect(client.getQueryData(["/api/admin/certificates"])).toEqual([{ id: "A-only" }]);
  });

  it("fails closed on an unavailable identity authority and recovers only after explicit retry", async () => {
    const client = makeClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, email: "admin@example.test", isSuperAdmin: false }), {
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    let root!: Root;
    await act(async () => {
      root = renderProvider(client, container);
    });
    const unavailable = await waitForElement(container, "admin-session-unavailable");
    expect(container.querySelector('[data-testid="admin-session-probe"]')).toBeNull();

    await act(async () => {
      (unavailable.querySelector('[data-testid="button-admin-session-retry"]') as HTMLButtonElement).click();
    });
    await waitForElement(container, "admin-session-probe");
    expect(container.querySelector('[data-testid="admin-session-email"]')?.textContent).toBe("admin@example.test");

    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks protected children synchronously when navigating in from a public route", async () => {
    routing.pathname = "/admin/login";
    const client = makeClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    let root!: Root;
    await act(async () => {
      root = renderProvider(client, container);
    });
    expect(container.querySelector('[data-testid="admin-session-probe"]')).not.toBeNull();

    routing.pathname = "/admin";
    await act(async () => {
      renderProviderInto(root, client);
    });

    expect(container.querySelector('[data-testid="admin-session-probe"]')).toBeNull();
    expect(container.querySelector('[data-testid="admin-session-checking"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("purges principal data before the provider navigates after successful logout", async () => {
    const client = makeClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/admin/session") {
          return new Response(
            JSON.stringify({ authenticated: true, email: "admin-a@example.test", isSuperAdmin: true }),
            { status: 200 }
          );
        }
        if (url === "/api/admin/logout" && init?.method === "POST") {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 500 });
      })
    );

    let root!: Root;
    await act(async () => {
      root = renderProvider(client, container);
    });
    await waitForElement(container, "admin-session-probe");
    client.setQueryData(["/api/admin/certificates"], [{ id: "A-only" }]);
    client.setQueryData(["public", "service-tiers"], [{ id: "public" }]);
    let principalCachePresentAtNavigation = true;
    routing.navigate.mockImplementation(() => {
      principalCachePresentAtNavigation = client.getQueryCache().getAll().some(isAdminPrincipalQuery);
    });

    await act(async () => {
      (container.querySelector('[data-testid="admin-session-logout"]') as HTMLButtonElement).click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    });

    expect(principalCachePresentAtNavigation).toBe(false);
    expect(routing.navigate).toHaveBeenCalledWith("/admin/login", { replace: true });
    expect(client.getQueryData(["public", "service-tiers"])).toEqual([{ id: "public" }]);

    await act(async () => root.unmount());
    container.remove();
  });

  it("revalidates a protected 401 through the session authority before expiring the principal", async () => {
    const client = makeClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let sessionReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/admin/session") {
          sessionReads += 1;
          return sessionReads === 1
            ? new Response(
                JSON.stringify({ authenticated: true, email: "admin-a@example.test", isSuperAdmin: true }),
                { status: 200 }
              )
            : new Response(JSON.stringify({ authenticated: false, reason: "session_expired" }), { status: 401 });
        }
        return new Response(JSON.stringify({ error: "Session expired" }), { status: 401 });
      })
    );

    let root!: Root;
    await act(async () => {
      root = renderProvider(client, container);
    });
    await waitForElement(container, "admin-session-probe");

    await act(async () => {
      await expect(
        client.fetchQuery({
          queryKey: ["/api/admin/certificates"],
          queryFn: getQueryFn({ on401: "returnNull" }),
        })
      ).rejects.toMatchObject({ status: 401 });
    });
    for (let attempt = 0; attempt < 40 && routing.navigate.mock.calls.length === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      });
    }

    expect(sessionReads).toBe(2);
    expect(routing.navigate).toHaveBeenCalledWith(
      "/admin/login?next=%2Fadmin&reason=session_expired",
      { replace: true }
    );
    expect(getActiveAdminPrincipal()).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("revalidates and purges a peer tab after a session-transition storage event", async () => {
    const client = makeClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let sessionReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        sessionReads += 1;
        return sessionReads === 1
          ? new Response(
              JSON.stringify({ authenticated: true, email: "admin-a@example.test", isSuperAdmin: true }),
              { status: 200 }
            )
          : new Response(JSON.stringify({ authenticated: false, reason: "not_authenticated" }), { status: 200 });
      })
    );

    let root!: Root;
    await act(async () => {
      root = renderProvider(client, container);
    });
    await waitForElement(container, "admin-session-probe");
    client.setQueryData(["/api/admin/certificates"], [{ id: "A-only" }]);

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "mintvault.admin-session.transition",
          newValue: "peer-transition",
        })
      );
    });
    for (let attempt = 0; attempt < 40 && routing.navigate.mock.calls.length === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      });
    }

    expect(sessionReads).toBe(2);
    expect(client.getQueryCache().getAll().some(isAdminPrincipalQuery)).toBe(false);
    expect(routing.navigate).toHaveBeenCalledWith(
      "/admin/login?next=%2Fadmin&reason=not_authenticated",
      { replace: true }
    );

    await act(async () => root.unmount());
    container.remove();
  });

  it("rejects a stale in-flight verification when a peer transition arrives", async () => {
    const client = makeClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let resolveStaleVerification!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authenticated: true, email: "admin-a@example.test", isSuperAdmin: true }),
          { status: 200 }
        )
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolveVerification) => {
            resolveStaleVerification = resolveVerification;
          })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: false, reason: "not_authenticated" }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    let root!: Root;
    await act(async () => {
      root = renderProvider(client, container);
    });
    await waitForElement(container, "admin-session-probe");
    client.setQueryData(["/api/admin/certificates"], [{ id: "A-only" }]);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "mintvault.admin-session.transition",
          newValue: "peer-transition",
        })
      );
      await Promise.resolve();
    });
    expect(getActiveAdminPrincipal()).toBeNull();
    expect(container.querySelector('[data-testid="admin-session-probe"]')).toBeNull();

    resolveStaleVerification(
      new Response(
        JSON.stringify({ authenticated: true, email: "admin-a@example.test", isSuperAdmin: true }),
        { status: 200 }
      )
    );
    for (let attempt = 0; attempt < 40 && routing.navigate.mock.calls.length === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getActiveAdminPrincipal()).toBeNull();
    expect(routing.navigate).toHaveBeenCalledWith(
      "/admin/login?next=%2Fadmin&reason=not_authenticated",
      { replace: true }
    );

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps one session authority and one shell logout authority across the complete client tree", () => {
    const clientRoot = resolve(process.cwd(), "client/src");
    const sourceFiles = filesUnder(clientRoot).filter((path) => /\.(?:ts|tsx)$/.test(path));
    const rawSessionReaders = sourceFiles
      .filter((path) => readFileSync(path, "utf8").includes('fetch("/api/admin/session"'))
      .map((path) => path.slice(process.cwd().length + 1));
    expect(rawSessionReaders).toEqual(["client/src/lib/admin-session.tsx"]);

    const protectedRawFetchFiles = sourceFiles
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return /(?<![.\w])fetch\(/.test(source) && /\/api\/(?:admin|super-admin|staff)(?:\/|\b)/.test(source);
      })
      .map((path) => path.slice(process.cwd().length + 1))
      .filter(
        (path) =>
          path !== "client/src/lib/admin-session.tsx" &&
          path !== "client/src/pages/staff-login.tsx" &&
          path !== "client/src/pages/staff.tsx" &&
          path !== "client/src/pages/dev-admin-shell-geometry-harness.tsx" &&
          path !== "client/src/pages/dev-growth-command-visual-harness.tsx"
      );
    expect(protectedRawFetchFiles).toEqual([]);

    const shellConsumers = sourceFiles.filter((path) => readFileSync(path, "utf8").includes("<AdminShell"));
    expect(shellConsumers.length).toBeGreaterThan(0);
    for (const path of shellConsumers) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/\bonLogout\s*=/);
    }

    const app = readFileSync(resolve(clientRoot, "App.tsx"), "utf8");
    expect(app).toContain("<AdminSessionProvider>");
    expect(app).toMatch(/<QueryClientProvider[\s\S]*<AdminSessionProvider>[\s\S]*<Router\s*\/>/);

    const publicLogbook = readFileSync(resolve(clientRoot, "pages/logbook.tsx"), "utf8");
    expect(publicLogbook).toContain("const isAdminView = isProtectedAdminLocation(location);");
    expect(publicLogbook).not.toContain('location.startsWith("/admin/")');

    const adminStepUp = readFileSync(resolve(clientRoot, "components/admin/admin-step-up.tsx"), "utf8");
    expect(adminStepUp).toMatch(
      /apiRequest\("POST", "\/api\/admin\/step-up"[\s\S]*?adminUnauthorizedPolicy: "credential-rejection-aware"/
    );

    const adminSecurity = readFileSync(resolve(clientRoot, "pages/admin-security.tsx"), "utf8");
    for (const endpoint of ["passphrase", "pin", "revoke-sessions"]) {
      expect(adminSecurity, endpoint).toMatch(
        new RegExp(
          `adminFetch\\("/api/admin/credentials/${endpoint}"[\\s\\S]*?adminUnauthorizedPolicy: "credential-rejection-aware"`
        )
      );
    }

    for (const harness of ["pages/dev-admin-shell-geometry-harness.tsx", "pages/dev-growth-command-visual-harness.tsx"]) {
      const source = readFileSync(resolve(clientRoot, harness), "utf8");
      expect(source, harness).toMatch(/<QueryClientProvider[\s\S]*<AdminSessionProvider>/);
    }
  });
});
