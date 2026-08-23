// @vitest-environment happy-dom
/**
 * AG-3 STEP-UP — REAL component rendering of the Partner Portal prompt (RC-F9).
 *
 * WHY THIS FILE EXISTS. The server half of step-up shipped complete and was proven by
 * tests/partner-step-up-auth.test.ts and tests/partner-runtime-integration.test.ts. The CLIENT half
 * did not exist at all: a partner met "Confirm your password to continue." with nowhere to confirm
 * it, and a shop could be blocked from BUYING GRADING CREDITS — the revenue path. Source-text
 * assertions cannot prove that is fixed; a `data-testid` string can sit in a file attached to a
 * different dialog. Every assertion below mounts the real provider and the real billing page and
 * would FAIL if the behaviour were removed.
 *
 * House convention, matching tests/partner-user-management-ui-render.test.ts:
 * `createElement` rather than JSX, because vitest's include is tests/**\/*.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: any) => createElement("a", { href, ...props }, children),
  useLocation: () => ["/partner/billing", vi.fn()],
  useRoute: () => [true, {}],
}));
vi.mock("@/hooks/use-partner-session", () => ({
  usePartnerSession: () => ({
    session: { mfaPassed: true, permissions: ["partner.credits.purchase"], role: "OWNER" },
    ready: true,
    isLoading: false,
    unavailable: false,
    expired: false,
    hasPermission: () => true,
  }),
}));

let container: HTMLDivElement;
let root: Root;
// The dialog renders through a portal onto document.body, not inside the mount container, so
// queries are rooted at the document. Anything scoped to `container` would silently find nothing
// and every "prompt appeared" assertion would fail for the wrong reason.
const q = (sel: string) => document.querySelector<HTMLElement>(`[data-testid="${sel}"]`);

/**
 * The raw shape `apiRequest` throws. Used for MOCKED apiRequest rejections, which partner-api's
 * `req()` then converts into a PartnerApiError exactly as it does in the browser.
 */
function httpError(status: number, code: string, message = "x") {
  const err: any = new Error(message);
  err.status = status;
  err.body = { error: { code, message } };
  return err;
}

/**
 * What a real protected call rejects with, i.e. what `req()` produces.
 *
 * The probe below stands in for a partner-api call, so it must reject with the SAME class the real
 * ones do — `isStepUpRequired` is an `instanceof` check, and a look-alike plain object would sail
 * past it and prove nothing.
 */
async function apiError(status: number, code: string, message = "x") {
  const { PartnerApiError } = await import("@/lib/partner-api");
  return new PartnerApiError(status, code, message);
}

beforeEach(() => {
  apiRequest.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  sessionStorage.clear();
});

async function mount(node: any) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, node));
  });
}

async function click(testid: string) {
  await act(async () => {
    q(testid)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(testid: string, value: string) {
  const el = q(testid) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Partner step-up prompt (real rendering)", () => {
  /** A minimal consumer of the canonical runner, standing in for any protected surface. */
  async function mountProbe(action: () => Promise<unknown>) {
    const { PartnerStepUpProvider, usePartnerStepUp, isStepUpCancelled } =
      await import("@/components/partner/partner-step-up");
    const outcomes: string[] = [];
    function Probe() {
      const { runProtected } = usePartnerStepUp();
      const [, force] = useState(0);
      return createElement(
        "button",
        {
          "data-testid": "probe-run",
          onClick: () => {
            runProtected(action)
              .then(() => outcomes.push("ok"))
              .catch((e) => outcomes.push(isStepUpCancelled(e) ? "cancelled" : "error"))
              .finally(() => force((n) => n + 1));
          },
        },
        "run"
      );
    }
    await mount(createElement(PartnerStepUpProvider, null, createElement(Probe)));
    return outcomes;
  }

  it("does not prompt at all when the action succeeds", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    const outcomes = await mountProbe(action);
    await click("probe-run");
    expect(q("dialog-partner-step-up")).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["ok"]);
  });

  it("does not prompt for an ordinary refusal — only for step_up_required", async () => {
    // A capability denial must NOT ask for a password: the server places requireRecentAuth AFTER the
    // capability guards precisely so a user who may never act is told that instead.
    const action = vi.fn().mockRejectedValue(await apiError(403, "forbidden"));
    const outcomes = await mountProbe(action);
    await click("probe-run");
    expect(q("dialog-partner-step-up")).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["error"]);
  });

  it("challenges on step_up_required, proves, and retries the ORIGINAL action exactly once", async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(await apiError(403, "step_up_required"))
      .mockResolvedValueOnce({ ok: true });
    apiRequest.mockResolvedValue({ status: 200, json: () => Promise.resolve({ ok: true, windowMinutes: 15 }) });

    const outcomes = await mountProbe(action);
    await click("probe-run");

    // Challenged, and the action has run ONCE and failed — nothing was performed.
    expect(q("dialog-partner-step-up")).not.toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([]);

    await type("input-step-up-password", "correct-horse-battery");
    await click("button-step-up-confirm");

    // Proof went to the canonical endpoint, and ONLY the password.
    const stepUpCalls = apiRequest.mock.calls.filter((c) => c[1] === "/api/partner/auth/step-up");
    expect(stepUpCalls).toHaveLength(1);
    expect(stepUpCalls[0][0]).toBe("POST");
    expect(stepUpCalls[0][2]).toEqual({ password: "correct-horse-battery" });

    // Retried exactly once, prompt closed, caller resolved.
    expect(action).toHaveBeenCalledTimes(2);
    expect(q("dialog-partner-step-up")).toBeNull();
    expect(outcomes).toEqual(["ok"]);
  });

  it("cancelling performs nothing and never retries", async () => {
    const action = vi.fn().mockRejectedValue(await apiError(403, "step_up_required"));
    const outcomes = await mountProbe(action);
    await click("probe-run");
    expect(q("dialog-partner-step-up")).not.toBeNull();

    await click("button-step-up-cancel");

    expect(action).toHaveBeenCalledTimes(1); // never retried
    expect(apiRequest.mock.calls.filter((c) => c[1] === "/api/partner/auth/step-up")).toHaveLength(0);
    expect(q("dialog-partner-step-up")).toBeNull();
    expect(outcomes).toEqual(["cancelled"]);
  });

  it("a wrong password is reported, the action is NOT performed, and the secret is not retained", async () => {
    const action = vi.fn().mockRejectedValue(await apiError(403, "step_up_required"));
    apiRequest.mockRejectedValue(httpError(403, "unauthorised", "That password was not correct."));

    await mountProbe(action);
    await click("probe-run");
    await type("input-step-up-password", "wrong-password");
    await click("button-step-up-confirm");

    expect(q("text-step-up-error")?.textContent).toContain("was not correct");
    expect(action).toHaveBeenCalledTimes(1); // still not retried
    expect(q("dialog-partner-step-up")).not.toBeNull(); // stays open to try again
    expect((q("input-step-up-password") as HTMLInputElement).value).toBe(""); // rejected secret wiped
  });

  it("asks for the second factor when the server says one is required", async () => {
    const action = vi.fn().mockRejectedValue(await apiError(403, "step_up_required"));
    apiRequest.mockRejectedValueOnce(httpError(400, "second_factor_required"));

    await mountProbe(action);
    await click("probe-run");
    await type("input-step-up-password", "correct-horse-battery");
    await click("button-step-up-confirm");

    expect(q("input-step-up-code")).not.toBeNull();
    expect(q("text-step-up-error")?.textContent).toContain("authenticator");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("a rate-limited proof preserves the lockout signal rather than inviting another attempt", async () => {
    const action = vi.fn().mockRejectedValue(await apiError(403, "step_up_required"));
    apiRequest.mockRejectedValue(httpError(429, "rate_limited"));

    await mountProbe(action);
    await click("probe-run");
    await type("input-step-up-password", "correct-horse-battery");
    await click("button-step-up-confirm");

    expect(q("text-step-up-error")?.textContent).toContain("Too many attempts");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("never writes the password to localStorage, sessionStorage or the URL", async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(await apiError(403, "step_up_required"))
      .mockResolvedValueOnce({ ok: true });
    apiRequest.mockResolvedValue({ status: 200, json: () => Promise.resolve({ ok: true, windowMinutes: 15 }) });

    await mountProbe(action);
    await click("probe-run");
    await type("input-step-up-password", "correct-horse-battery");
    await click("button-step-up-confirm");

    const haystack = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + window.location.href;
    expect(haystack).not.toContain("correct-horse-battery");
    // And nothing is left in the field after a successful proof.
    expect(q("input-step-up-password")).toBeNull();
  });
});

describe("Buy Grading Credits goes straight to Stripe (the revenue path)", () => {
  /*
   * REWRITTEN, not deleted. This case used to prove the opposite: that checkout was refused once
   * with 403 step_up_required, prompted for the password, and retried exactly once. Owner decision
   * 2026-08-22 removed requireRecentAuth() from checkout creation — the act grants nothing, and the
   * payment itself is authenticated by Stripe on Stripe's page — so the behaviour this asserted no
   * longer exists and asserting it would pin a prompt the operator is not supposed to see.
   *
   * The step-up MECHANISM is unchanged and still covered by every case above, and
   * tests/partner-credit-checkout-no-step-up.test.ts proves server-side that the routes which change
   * who can act still demand a fresh password.
   */
  it("hands off to Stripe on the first click, with no password dialog", async () => {
    const { PartnerStepUpProvider } = await import("@/components/partner/partner-step-up");
    const PartnerBillingPage = (await import("@/pages/partner/billing")).default;

    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign, href: "http://localhost/partner/billing" },
      writable: true,
    });

    let checkoutAttempts = 0;
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url === "/api/partner/credits")
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              summary: {
                configured: true,
                walletStatus: "ACTIVE",
                availableCredits: 3,
                reservedCredits: 0,
                consumedThisMonth: 0,
                consumedLifetime: 0,
                postedBalance: 3,
                balanceStatus: "low",
              },
              ledger: [],
              purchaseHistory: [],
            }),
        });
      if (url === "/api/partner/credits/packs")
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              packs: [
                { id: "p1", code: "PACK10", label: "10 credits", credits: 10, pricePence: 5000, purchasable: true },
              ],
            }),
        });
      if (url === "/api/partner/credits/checkout") {
        checkoutAttempts += 1;
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ url: "https://stripe.test/session" }) });
      }
      return Promise.resolve({ status: 200, json: () => Promise.resolve({}) });
    });

    await mount(createElement(PartnerStepUpProvider, null, createElement(PartnerBillingPage)));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    const buy = q("button-buy-pack-PACK10");
    expect(buy, "the billing page must render a Buy control").toBeTruthy();

    await act(async () => {
      buy!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    // ONE attempt, NO dialog, and the operator is already on their way to Stripe.
    expect(checkoutAttempts).toBe(1);
    expect(q("dialog-partner-step-up")).toBeNull();
    expect(apiRequest.mock.calls.filter((c) => c[1] === "/api/partner/auth/step-up")).toHaveLength(0);
    expect(assign).toHaveBeenCalledWith("https://stripe.test/session");
  });
});
