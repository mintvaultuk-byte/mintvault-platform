// @vitest-environment happy-dom
/**
 * DASHBOARD INITIAL-LOAD RECOVERY.
 *
 * Observed on staging: a `fly secrets set` triggers a rolling restart, the machine is unreachable
 * for a few seconds, and any dashboard load in that window got a failed first fetch. With the
 * Query Client globally `retry: false` there was no second attempt, and with one generic failure
 * card there was nothing telling the operator whether to wait, log in again, or ask for access.
 * The dashboard was, in effect, permanently stuck until a manual reload.
 *
 * Three properties are pinned here, each with a mutation that must turn it RED:
 *
 *   LOAD1  a transient failure recovers by itself (bounded retry on the essential queries)
 *   LOAD2  401 and 500 produce DIFFERENT operator copy
 *   LOAD3  a failed REFETCH keeps the already-loaded programme on screen
 *
 * These render the real page against a controlled fetch, not a fixture — the defect lived in the
 * page's own guard, so a fixture could not have caught it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectControlPage from "../client/src/pages/admin/project-control";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;

/** Minimal but structurally honest payloads — enough for the page to consider itself loaded. */
const OVERVIEW = {
  generatedAt: "2026-08-02T00:00:00Z",
  tree: [],
  packages: [],
  readiness: { percent: 0, categories: [], appliedCaps: [], gates: [] },
  nextActions: { highestPriority: null, all: [] },
  counts: { nodes: 0, packages: 0, packagesTotal: 0, openBlockers: 0 },
  deployments: { latest: {} },
  queues: [],
  drift: {},
  treeIntegrity: { orphanedPackages: [], orphanedNodes: [], nodeCycles: [] },
  pagination: { total: 0, returned: 0, truncated: false, limit: 50, offset: 0 },
};
const SHOP_LAUNCH = { generatedAt: "2026-08-02T00:00:00Z", readiness: { percent: 0 }, phases: [], blockers: [] };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return this;
    },
  } as unknown as Response;
}

/** Route by URL so the two essential queries can fail independently of the rest. */
function installFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as unknown as typeof fetch;
}

function ok(url: string): Response {
  if (url.includes("/overview")) return jsonResponse(OVERVIEW);
  if (url.includes("/views/shop-launch")) return jsonResponse(SHOP_LAUNCH);
  return jsonResponse(null);
}

/** A client that mirrors production defaults: no global retry. The page must supply its own. */
function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 } },
  });
}

async function render(client: QueryClient) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(ProjectControlPage)));
  });
  // Let bounded-backoff retries elapse.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LOAD1 — a restart-shaped failure recovers without operator action", () => {
  it("retries a transient failure and renders the programme", async () => {
    let attempts = 0;
    installFetch((url) => {
      if (url.includes("/overview") || url.includes("/views/shop-launch")) {
        attempts += 1;
        // Both essential queries fail once, as they would mid-restart.
        if (attempts <= 2) throw new Error("network down");
      }
      return ok(url);
    });

    await render(makeClient());

    expect(attempts, "the essential queries must be retried, not abandoned").toBeGreaterThan(2);
    expect(
      container.querySelector('[data-testid="pc-network-error"]'),
      "a transient restart must not leave a dead failure card"
    ).toBeNull();
  });

  it("does not retry a terminal status — no loop against an answer", async () => {
    let calls = 0;
    installFetch((url) => {
      if (url.includes("/overview") || url.includes("/views/shop-launch")) {
        calls += 1;
        return jsonResponse({ error: "Forbidden: Super Admin required" }, 403);
      }
      return ok(url);
    });

    await render(makeClient());

    // Two essential queries, one attempt each. A retry here would only delay the truth.
    expect(calls, "403 is an answer, not an outage").toBe(2);
  });
});

describe("LOAD2 — causes are distinguishable, and none leak a backend exception", () => {
  async function renderWithStatus(status: number) {
    installFetch((url) =>
      url.includes("/overview") || url.includes("/views/shop-launch")
        ? jsonResponse({ error: "boom" }, status)
        : ok(url)
    );
    await render(makeClient());
    return container.textContent ?? "";
  }

  it("401 says the session ended", async () => {
    const text = await renderWithStatus(401);
    expect(container.querySelector('[data-testid="pc-unauthenticated"]')).not.toBeNull();
    expect(text).toContain("session has ended");
  });

  it("403 says the account lacks Super Admin", async () => {
    const text = await renderWithStatus(403);
    expect(container.querySelector('[data-testid="pc-forbidden"]')).not.toBeNull();
    expect(text).toContain("not a Super Admin");
  });

  it("404 says the feature is switched off", async () => {
    const text = await renderWithStatus(404);
    expect(container.querySelector('[data-testid="pc-disabled"]')).not.toBeNull();
    expect(text).toContain("switched off");
  });

  it("500 says the server faulted", async () => {
    const text = await renderWithStatus(500);
    expect(container.querySelector('[data-testid="pc-server-error"]')).not.toBeNull();
    expect(text).toContain("failed on the server");
  });

  it("401 and 500 are NOT the same message", async () => {
    const unauth = await renderWithStatus(401);
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const server = await renderWithStatus(500);

    expect(unauth).not.toEqual(server);
  });

  it("offers a Try again control and never prints a raw exception", async () => {
    const text = await renderWithStatus(500);
    expect(container.querySelector('[data-testid="pc-retry"]')).not.toBeNull();
    expect(text).not.toContain("boom");
    expect(text).not.toMatch(/\.ts:\d+|at Object\.|Traceback/);
  });
});

describe("LOAD3 — a failed refetch keeps the last good programme on screen", () => {
  it("retains loaded data when a later fetch fails", async () => {
    let healthy = true;
    installFetch((url) => {
      if (!healthy && (url.includes("/overview") || url.includes("/views/shop-launch"))) {
        throw new Error("network down");
      }
      return ok(url);
    });

    const client = makeClient();
    await render(client);
    expect(
      container.querySelector('[data-testid="pc-network-error"]'),
      "precondition: the first load succeeded"
    ).toBeNull();
    const loaded = container.textContent ?? "";

    healthy = false;
    await act(async () => {
      await client.refetchQueries();
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(
      container.querySelector('[data-testid="pc-network-error"]'),
      "a failed refresh must not discard a good dashboard"
    ).toBeNull();
    expect(container.textContent, "the previously loaded programme is still rendered").toEqual(loaded);
  });
});
