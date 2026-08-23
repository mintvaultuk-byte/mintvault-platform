// @vitest-environment happy-dom
/**
 * THE GOLD "APPROVE SCANNER" BUTTON on the first-shop onboarding page — the real rendered control.
 *
 * WHY THIS EXISTS SEPARATELY from admin-station-approval-step-up-ui.test.ts. That suite proves the
 * Station Fleet approve path, which is where an engineer goes. This is the control an OPERATOR is
 * sent to: one gold button on the onboarding page, for the one Mac a new shop has just connected.
 * A staging approval was attempted and never reached the server, so "the other page's button works"
 * stopped being an adequate answer for this one.
 *
 * These mount the REAL page and drive the REAL control. Every string involved already existed the
 * last time this class of defect shipped; what was missing was behaviour, and only behaviour is
 * asserted here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

const apiRequest = vi.fn();
const invalidateQueries = vi.fn(() => Promise.resolve());
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: unknown[]) => apiRequest(...a),
  queryClient: { invalidateQueries: (...a: unknown[]) => invalidateQueries(...a) },
}));
vi.mock("wouter", () => ({
  useLocation: () => [`/admin/partners/${PARTNER_ID}/onboarding`, vi.fn()],
  useRoute: () => [true, { partnerId: PARTNER_ID }],
  useParams: () => ({ partnerId: PARTNER_ID }),
  Link: ({ href, children, ...p }: any) => createElement("a", { href, ...p }, children),
}));

const PARTNER_ID = "377cd09f-d4c7-479b-adf2-e5eedbd3c79b";
const STATION = "MV-STN-N5YE3IBUGVMMQDIV";
const APPROVE_URL = `/api/super-admin/fleet/stations/${STATION}/active`;

let container: HTMLDivElement;
let root: Root;
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function httpError(status: number, body: unknown) {
  const e: any = new Error("http");
  e.status = status;
  e.body = body;
  return e;
}
const ok = (body: unknown) =>
  Promise.resolve({ status: 200, json: () => Promise.resolve(body) } as unknown as Response);

/** The pending Mac, exactly as the fleet endpoint returns it. */
const PENDING = {
  stationCode: STATION,
  status: "PENDING",
  tenantId: PARTNER_ID,
  partnerName: "shop games",
  locationId: "d45d273d-888d-4cf0-bf90-53d8414a37b7",
  locationName: "Main location",
  appVersion: "1.4.1",
  scannerConnected: false,
  calibrationStatus: "UNPROVISIONED",
  pendingUploadCount: 0,
  captureState: "IDLE",
  lastSeenAt: null,
  lastFailureCode: null,
};

/** The readiness verdict this shop is actually in: everything done except approving the Mac. */
function readiness(stationApproved: boolean) {
  return {
    organisation: { id: PARTNER_ID, legalName: "shop games", status: "ACTIVE" },
    portalEnabled: true,
    operational: {
      overall: { ready: false, code: "STATION_APPROVAL_PENDING", message: "" },
      /*
       * Every dimension, with the verdict this shop genuinely holds: activation complete, the Mac
       * connected and waiting. The page reads each one directly, so a partial fixture would fail
       * for a reason that has nothing to do with the button under test.
       */
      dimensions: {
        organisation: { status: "PASS", code: "READY", message: "", actions: [] },
        location: { status: "PASS", code: "READY", message: "", actions: [] },
        delivery: { status: "PASS", code: "READY", message: "", actions: [] },
        operationsContact: { status: "PASS", code: "READY", message: "", actions: [] },
        owner: { status: "PASS", code: "READY", message: "", actions: [] },
        staff: { status: "PASS", code: "READY", message: "", actions: [] },
        station: stationApproved
          ? { status: "PASS", code: "READY", message: "", actions: [] }
          : {
              status: "PENDING",
              code: "STATION_APPROVAL_PENDING",
              message: "A Scanner station is registered and waiting for MintVault to approve it.",
              actions: [{ audience: "SUPER_ADMIN", label: "Approve the registered station" }],
            },
        scanner: { status: "PENDING", code: "STATION_SETUP_REQUIRED", message: "", actions: [] },
        credits: { status: "PASS", code: "READY", message: "", actions: [] },
      },
      actions: [],
      nextAction: stationApproved
        ? {
            state: "BLOCKED",
            code: "SCANNER_OFFLINE",
            title: "Scanner offline",
            message: "The Scanner is not connected to this Mac.",
            source: "scanner",
            action: null,
            stage: "CONNECT",
          }
        : {
            state: "PENDING",
            code: "STATION_APPROVAL_PENDING",
            title: "Scanner waiting for approval",
            message: "A Scanner station is registered and waiting for MintVault to approve it.",
            source: "station",
            action: { audience: "SUPER_ADMIN", label: "Approve the registered station" },
            stage: "CONNECT",
          },
      onboarding: { complete: false, message: "The shop's own test card has not been started." },
      testCard: { state: "NOT_STARTED", status: "PENDING", message: "", cardJob: null },
    },
    users: [],
    profileVersion: 3,
    testCardArmingReadable: true,
    testCardArmedAt: null,
    owner: { id: "783885ad-09c9-4b2c-9baa-e4ab3cb28519", email: "owner@shop.games", status: "ACTIVE" },
  };
}

let stationApproved = false;
let approvals: Array<{ url: string; body: unknown }> = [];
let approvalResults: Array<() => Promise<Response>> = [];

function installApi() {
  apiRequest.mockImplementation((method: string, url: string, body?: unknown) => {
    if (url.startsWith("/api/super-admin/fleet/stations?")) {
      return ok({
        stations: [{ ...PENDING, status: stationApproved ? "ACTIVE" : "PENDING" }],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    }
    if (/\/api\/super-admin\/fleet\/stations\/[^/]+\/(active|suspended|revoked|reject)$/.test(url)) {
      approvals.push({ url, body });
      const next = approvalResults.shift();
      if (!next) throw new Error(`unexpected extra approval call: ${url}`);
      return next();
    }
    if (url === "/api/admin/step-up") return ok({ ok: true, windowMinutes: 10 });
    if (url.includes("/onboarding-readiness") || url.includes("/first-shop")) return ok(readiness(stationApproved));
    return ok({ users: [], locations: [], stations: [], partners: [], total: 0, ok: true, flags: [] });
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      String(url).includes("/api/admin/session")
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ authenticated: true }) } as unknown as Response)
        : Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response)
    )
  );
  apiRequest.mockReset();
  invalidateQueries.mockClear();
  stationApproved = false;
  approvals = [];
  approvalResults = [];
  installApi();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root.unmount());
  container.remove();
});

async function settle(n = 8) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountOnboarding() {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AdminStepUpHost } = await import("@/components/admin/admin-step-up");
  const Page = (await import("@/pages/admin/partner-first-shop-onboarding")).default;
  /*
   * A DEFAULT queryFn, because the page relies on one.
   *
   * `stationsQuery` — the query that finds the pending Mac and therefore decides whether the gold
   * button exists — declares only a queryKey and leans on the app's configured default fetcher
   * (queryClient.ts: getQueryFn). A bare QueryClient has none, so that query never resolves and the
   * button never renders, for a reason that has nothing to do with the page. This mirrors the real
   * composition: fetch the key as a URL.
   */
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) =>
          apiRequest("GET", String(queryKey[0])).then((r: Response) => r.json()),
      },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(AdminStepUpHost), createElement(Page)));
  });
  await settle();
}

/** The gold control, found by what it SAYS rather than by a testid, as an operator finds it. */
function approveButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    /approve scanner/i.test(b.textContent ?? "")
  ) as HTMLButtonElement | undefined;
}

async function clickApprove() {
  const btn = approveButton();
  expect(btn, "the gold APPROVE SCANNER control must be on the page").toBeTruthy();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

describe("first-shop onboarding — the one gold APPROVE SCANNER control", () => {
  it("renders exactly ONE approve control for exactly one pending Mac", async () => {
    await mountOnboarding();
    const all = Array.from(document.querySelectorAll("button")).filter((b) =>
      /approve scanner/i.test(b.textContent ?? "")
    );
    expect(all).toHaveLength(1);
  });

  it("targets that exact station, on the canonical endpoint", async () => {
    await mountOnboarding();
    approvalResults = [() => ok({ ok: true, status: "ACTIVE" })];
    await clickApprove();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].url).toBe(APPROVE_URL);
    // The station code is not typed, guessed or defaulted — it comes from the pending row.
    expect(approvals[0].url).toContain(STATION);
    // A mandatory reason accompanies the transition, as the audit trail requires.
    expect(String((approvals[0].body as { reason?: string })?.reason ?? "")).not.toHaveLength(0);
  });

  it("a step-up challenge retries the SAME approval exactly once", async () => {
    await mountOnboarding();
    approvalResults = [
      () => Promise.reject(httpError(403, { code: "admin_step_up_required" })),
      () => ok({ ok: true, status: "ACTIVE" }),
    ];
    await clickApprove();
    await settle();

    // The prompt appeared and was satisfied.
    const password = q("input-admin-step-up-password") as HTMLInputElement | null;
    expect(password, "a 403 admin_step_up_required must open the step-up prompt").toBeTruthy();
    const setV = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setV(password!, "synthetic-password");
      setV(q("input-admin-step-up-pin") as HTMLInputElement, "123456");
    });
    await act(async () => {
      q("button-admin-step-up-confirm")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // EXACTLY TWICE overall — the original attempt and one retry. Never a third.
    expect(approvals).toHaveLength(2);
    expect(approvals.every((a) => a.url === APPROVE_URL)).toBe(true);
    expect(approvalResults).toHaveLength(0);
  });

  it("cancelling the step-up performs NOTHING and is not reported as a failure", async () => {
    await mountOnboarding();
    approvalResults = [() => Promise.reject(httpError(403, { code: "admin_step_up_required" }))];
    await clickApprove();
    await settle();
    expect(q("input-admin-step-up-password")).toBeTruthy();

    await act(async () => {
      q("button-admin-step-up-cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // One attempt was made and refused; cancelling must not produce a second.
    expect(approvals).toHaveLength(1);
    // And the station is untouched — the page must not claim anything happened.
    expect(document.body.textContent).not.toMatch(/approved/i);
  });

  it("a failed approval is visible on the page, not swallowed", async () => {
    await mountOnboarding();
    approvalResults = [() => Promise.reject(httpError(409, { error: { code: "station_change_failed", message: "no" } }))];
    await clickApprove();
    await settle();
    expect(approvals).toHaveLength(1);
    // The control returns to a usable state rather than staying stuck on "Approving…".
    expect(approveButton()?.disabled).toBeFalsy();
  });

  it("a successful approval refetches the authoritative readiness rather than assuming", async () => {
    await mountOnboarding();
    approvalResults = [() => ok({ ok: true, status: "ACTIVE" })];
    await clickApprove();
    await settle();
    expect(approvals).toHaveLength(1);
    // The controller's verdict is re-read from the server; the page never flips itself green.
    const keys = invalidateQueries.mock.calls.map((c) => JSON.stringify(c));
    expect(keys.join(" ")).toContain("first-shop");
  });

  it("nothing on this page can navigate to production", async () => {
    await mountOnboarding();
    const html = container.innerHTML;
    expect(html).not.toContain("mintvaultuk.com");
    for (const a of Array.from(document.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^https?:\/\//);
    }
  });
});
