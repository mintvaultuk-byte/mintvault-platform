// @vitest-environment happy-dom
/**
 * SUPER ADMIN STATION APPROVAL — REAL rendered UI regression (defect UX-1).
 *
 * THE DEFECT THIS PINS. Found in a live staging walkthrough, on the production onboarding path:
 * Partner Network → Partners → Station Fleet → Pending → Approve → enter reason → Confirm did
 * nothing usable. Every high-risk Super Admin route sits behind `requireAdminStepUp()`, which answers
 * `403 { code: "admin_step_up_required" }`. The server half was complete — the guard AND
 * `POST /api/admin/step-up { password, pin }` both shipped. The CLIENT half did not exist: no prompt,
 * no retry. The page showed a banner reading "Confirm your admin password and PIN to continue." with
 * nowhere in the product to do that, so a station could not be approved through the website at all.
 *
 * That is the same defect class as RC-F9 on the Partner side, and it is fixed the same way: build the
 * missing half. `requireAdminStepUp` is not relaxed, no route is ungated, the mandatory reason is
 * unchanged, and the audit trail is untouched.
 *
 * These tests mount the REAL page and drive the REAL controls. Source-text assertions would not have
 * caught this — every string involved already existed; what was missing was behaviour.
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
  useLocation: () => ["/admin/partner-network/partners", vi.fn()],
  Link: ({ href, children, ...p }: any) => createElement("a", { href, ...p }, children),
}));

let container: HTMLDivElement;
let root: Root;
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The shape apiRequest throws — status + parsed body — exactly as queryClient builds it. */
function httpError(status: number, body: unknown) {
  const e: any = new Error("http");
  e.status = status;
  e.body = body;
  return e;
}
const ok = (body: unknown) =>
  Promise.resolve({ status: 200, json: () => Promise.resolve(body) } as unknown as Response);

/** A FleetStation exactly as the server returns it — every field the row renderer touches. */
const PENDING_STATION = {
  stationCode: "MV-STN-TESTPENDING",
  status: "PENDING",
  tenantId: "t1",
  partnerName: "MintVault Pilot Partner One Ltd",
  locationId: "loc1",
  locationName: "Main location",
  appVersion: "at23-reproof",
  scannerConnected: false,
  calibrationStatus: "UNKNOWN",
  pendingUploadCount: 0,
  captureState: "IDLE",
  lastSeenAt: null,
  lastFailureCode: null,
};

/** Fleet rows the list endpoint returns; flipped to ACTIVE after a successful approval. */
let fleetRows: unknown[] = [PENDING_STATION];
/** Every approval attempt, so "retried exactly once" is countable rather than assumed. */
let approvals: Array<{ url: string; body: unknown }> = [];
/** Queue of results for the approval endpoint, consumed in order. */
let approvalResults: Array<() => Promise<Response>> = [];

function installDefaultApi() {
  apiRequest.mockImplementation((method: string, url: string, body?: unknown) => {
    if (url.startsWith("/api/super-admin/fleet/stations?"))
      return ok({ stations: fleetRows, total: fleetRows.length, page: 1, pageSize: 50 });
    if (/\/api\/super-admin\/fleet\/stations\/[^/]+\/(active|suspended|revoked|reject)$/.test(url)) {
      approvals.push({ url, body });
      const next = approvalResults.shift();
      if (!next) throw new Error(`unexpected extra approval call: ${url}`);
      return next();
    }
    if (url === "/api/admin/step-up") return ok({ ok: true, windowMinutes: 10 });
    // Everything else the page loads (auth probe, partner lists, pilot flags) — shape-tolerant.
    return ok({ partners: [], total: 0, page: 1, pageSize: 50, ok: true, flags: [] });
  });
}

beforeEach(() => {
  // The page gates every query on an auth probe made with the GLOBAL fetch, not apiRequest.
  // Without this the fleet never loads and the tests fail for a reason unrelated to step-up.
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
  fleetRows = [PENDING_STATION];
  approvals = [];
  approvalResults = [];
  installDefaultApi();
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

async function settle(n = 6) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Mount the REAL page plus the REAL step-up host, exactly as App.tsx composes them. */
async function mountFleet() {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AdminStepUpHost } = await import("@/components/admin/admin-step-up");
  const Page = (await import("@/pages/admin/partner-management")).default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(AdminStepUpHost), createElement(Page)));
  });
  await settle();
}

async function click(testid: string) {
  await act(async () => {
    q(testid)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
async function type(testid: string, value: string) {
  const el = q(testid) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Open the Approve modal for the pending station. */
async function openApprove() {
  const row = q(`pm-fleet-row-${PENDING_STATION.stationCode}`);
  expect(row, "the pending station must be listed in Station Fleet").toBeTruthy();
  const approve = Array.from(row!.querySelectorAll("button")).find((b) => /approve/i.test(b.textContent ?? ""));
  expect(approve, "the pending station must offer an Approve control").toBeTruthy();
  await act(async () => {
    approve!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Super Admin station approval — the real UI path", () => {
  it("1. a reason is REQUIRED: Confirm stays disabled until one is entered", async () => {
    await mountFleet();
    await openApprove();
    expect(q("pm-fleet-action-modal")).toBeTruthy();
    expect((q("pm-fleet-action-submit") as HTMLButtonElement).disabled).toBe(true);

    await type("pm-fleet-action-reason", "ab"); // below the 3-char floor
    expect((q("pm-fleet-action-submit") as HTMLButtonElement).disabled).toBe(true);

    await type("pm-fleet-action-reason", "AT-23 re-proof disposable station");
    expect((q("pm-fleet-action-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("2. Confirm actually invokes the approval endpoint with the reason", async () => {
    approvalResults = [() => ok({ ok: true, status: "ACTIVE" })];
    await mountFleet();
    await openApprove();
    await type("pm-fleet-action-reason", "AT-23 re-proof disposable station");
    await click("pm-fleet-action-submit");
    await settle();

    expect(approvals).toHaveLength(1);
    expect(approvals[0].url).toBe(`/api/super-admin/fleet/stations/${PENDING_STATION.stationCode}/active`);
    expect(approvals[0].body).toMatchObject({ reason: "AT-23 re-proof disposable station" });
  });

  it("3. a 403 admin_step_up_required OPENS the step-up prompt (the defect: it did not)", async () => {
    approvalResults = [
      () =>
        Promise.reject(
          httpError(403, {
            error: "Confirm your admin password and PIN to continue.",
            code: "admin_step_up_required",
            windowMinutes: 10,
          })
        ),
    ];
    await mountFleet();
    await openApprove();
    await type("pm-fleet-action-reason", "AT-23 re-proof disposable station");
    await click("pm-fleet-action-submit");
    await settle();

    expect(q("dialog-admin-step-up"), "the step-up prompt must appear").toBeTruthy();
    expect(q("input-admin-step-up-password")).toBeTruthy();
    expect(q("input-admin-step-up-pin")).toBeTruthy();
    // and the station has NOT been approved by the refused attempt
    expect(approvals).toHaveLength(1);
  });

  it("4. a successful step-up retries the approval EXACTLY ONCE", async () => {
    approvalResults = [
      () => Promise.reject(httpError(403, { code: "admin_step_up_required" })),
      () => ok({ ok: true, status: "ACTIVE" }),
    ];
    await mountFleet();
    await openApprove();
    await type("pm-fleet-action-reason", "AT-23 re-proof disposable station");
    await click("pm-fleet-action-submit");
    await settle();

    await type("input-admin-step-up-password", "admin-password");
    await type("input-admin-step-up-pin", "123456");
    await click("button-admin-step-up-confirm");
    await settle();

    const stepUps = apiRequest.mock.calls.filter((c) => c[1] === "/api/admin/step-up");
    expect(stepUps).toHaveLength(1);
    expect(stepUps[0][2]).toEqual({ password: "admin-password", pin: "123456" });
    expect(approvals).toHaveLength(2); // original + exactly one retry
    expect(q("dialog-admin-step-up")).toBeNull(); // prompt closed
  });

  it("5. a failed step-up is VISIBLY shown and never silently swallowed", async () => {
    approvalResults = [() => Promise.reject(httpError(403, { code: "admin_step_up_required" }))];
    await mountFleet();
    await openApprove();
    await type("pm-fleet-action-reason", "AT-23 re-proof disposable station");
    await click("pm-fleet-action-submit");
    await settle();

    apiRequest.mockImplementationOnce(() => Promise.reject(httpError(401, { error: "Invalid credentials" })));
    await type("input-admin-step-up-password", "wrong");
    await type("input-admin-step-up-pin", "000000");
    await click("button-admin-step-up-confirm");
    await settle();

    expect(q("text-admin-step-up-error")?.textContent).toMatch(/not correct/i);
    expect(q("dialog-admin-step-up")).toBeTruthy(); // stays open so it can be retried
    expect(approvals).toHaveLength(1); // never retried on a failed proof
    // the rejected secret is not retained
    expect((q("input-admin-step-up-password") as HTMLInputElement).value).toBe("");
  });

  it("6. a successful approval refreshes Station Fleet, showing the station ACTIVE", async () => {
    approvalResults = [
      () => Promise.reject(httpError(403, { code: "admin_step_up_required" })),
      () => {
        // The server has approved it, so the list endpoint now reports ACTIVE.
        fleetRows = [{ ...PENDING_STATION, status: "ACTIVE" }];
        return ok({ ok: true, status: "ACTIVE" });
      },
    ];
    await mountFleet();
    await openApprove();
    await type("pm-fleet-action-reason", "AT-23 re-proof disposable station");
    await click("pm-fleet-action-submit");
    await settle();
    await type("input-admin-step-up-password", "admin-password");
    await type("input-admin-step-up-pin", "123456");
    await click("button-admin-step-up-confirm");
    await settle();

    // The fleet list is invalidated, so the operator sees the new state without a manual refresh.
    expect(invalidateQueries).toHaveBeenCalled();
    const keys = invalidateQueries.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(keys.some((k) => k.includes("/api/super-admin/fleet"))).toBe(true);
    // and the modal is closed rather than left hanging over the list
    expect(q("pm-fleet-action-modal")).toBeNull();
  });

  it("cancelling the prompt performs nothing and is not reported as a failure", async () => {
    approvalResults = [() => Promise.reject(httpError(403, { code: "admin_step_up_required" }))];
    await mountFleet();
    await openApprove();
    await type("pm-fleet-action-reason", "AT-23 re-proof disposable station");
    await click("pm-fleet-action-submit");
    await settle();

    await click("button-admin-step-up-cancel");
    await settle();

    expect(approvals).toHaveLength(1); // never retried
    expect(q("dialog-admin-step-up")).toBeNull();
    expect(apiRequest.mock.calls.filter((c) => c[1] === "/api/admin/step-up")).toHaveLength(0);
  });
});
