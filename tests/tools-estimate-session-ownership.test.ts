// @vitest-environment happy-dom
/**
 * REM-ESTIMATE-001 client contract — real mounted page behaviour.
 *
 * The tests exercise the production page rather than matching source strings:
 * anonymous users cannot start paid checkout, session owners never submit an
 * email identity, and old email-bearing return URLs are ignored and sanitised.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Link: ({ href, children, ...props }: any) => createElement("a", { href, ...props }, children),
}));

vi.mock("@/components/v2/header-v2", () => ({
  default: () => createElement("header", { "data-testid": "header" }),
}));

vi.mock("@/components/v2/footer-v2", () => ({
  default: () => createElement("footer", { "data-testid": "footer" }),
}));

vi.mock("@/components/ui/gradient-button", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ as, children, height: _height, ...props }: any) =>
    createElement(as === "button" ? "button" : "span", props, children),
}));

import ToolsEstimateV2 from "../client/src/pages/tools-estimate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(createElement(ToolsEstimateV2));
  });
  await flush();
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) throw new Error(`Button containing ${JSON.stringify(text)} was not rendered`);
  return button;
}

async function openPaywall(): Promise<FormData> {
  const input = container.querySelector<HTMLInputElement>("#mv-file-input");
  if (!input) throw new Error("Upload input was not rendered");
  const file = new File(["card"], "card.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () => buttonContaining("Get estimate").click());
  await flush();

  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url) === "/api/tools/estimate" && init?.method === "POST"
  );
  if (!call) throw new Error("Estimate request was not made");
  return call[1].body as FormData;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:card-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  window.history.replaceState({}, "", "/tools/estimate");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("estimate credit session ownership", () => {
  it("keeps the free anonymous estimate but replaces paid checkout and email restore with account actions", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/tools/estimate/credits") {
        return Promise.resolve(jsonResponse(401, { error: "Sign in to view purchased credits." }));
      }
      if (url === "/api/tools/estimate" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(402, { error: "Free estimate used for today." }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderPage();
    const form = await openPaywall();

    expect(form.has("email"), "the anonymous free request carries no caller-selected owner identity").toBe(false);
    expect(container.querySelector('[data-testid="estimate-account-required"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="estimate-checkout"]')).toBeNull();
    expect(container.querySelector('input[type="email"]'), "there is no enumerating restore field").toBeNull();
    expect(buttonContaining("5 estimates").disabled, "pack selection is inert while logged out").toBe(true);

    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.some((link) => link.getAttribute("href") === "/login")).toBe(true);
    expect(links.some((link) => link.getAttribute("href") === "/signup")).toBe(true);
    expect(links.every((link) => !link.href.includes("email="))).toBe(true);
  });

  it("submits checkout from the authenticated session without an email and keeps verification failures in context", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/tools/estimate/credits") {
        return Promise.resolve(jsonResponse(200, { credits: 0, email: "owner@example.com" }));
      }
      if (url === "/api/tools/estimate" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(402, { error: "Free estimate used for today." }));
      }
      if (url === "/api/tools/estimate/checkout" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(403, { error: "Verify your account email before buying credits." }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await renderPage();
    const form = await openPaywall();
    expect(form.has("email"), "even signed-in estimate spending is session-owned").toBe(false);

    await act(async () => buttonContaining("5 estimates").click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="estimate-checkout"]')!.click());
    await flush();

    const checkoutCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/tools/estimate/checkout" && init?.method === "POST"
    );
    expect(checkoutCall).toBeTruthy();
    expect(JSON.parse(String(checkoutCall![1].body))).toEqual({
      package: "5",
      return_path: "/tools/estimate",
    });
    expect(checkoutCall![1].credentials).toBe("include");
    expect(container.textContent).toContain("Verify your account email before buying credits.");
    expect(container.textContent, "checkout errors do not throw the user out of the pack UI").toContain(
      "Buy a credit pack to continue."
    );
  });

  it("loads a successful Stripe return from the session and discards legacy email-bearing URL identity", async () => {
    window.history.replaceState(
      {},
      "",
      "/tools/estimate?payment=success&email=victim%40example.com&estimate_credits=other%40example.com&campaign=test#top"
    );
    fetchMock.mockResolvedValue(jsonResponse(200, { credits: 15, email: "owner@example.com" }));

    await renderPage();

    const creditCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/tools/estimate/credits"));
    expect(creditCalls.length).toBeGreaterThan(0);
    expect(creditCalls.every(([url]) => String(url) === "/api/tools/estimate/credits")).toBe(true);
    expect(creditCalls[0][1].credentials).toBe("include");
    expect(window.location.search).toBe("?payment=success&campaign=test");
    expect(window.location.hash).toBe("#top");
    expect(window.location.href).not.toContain("victim%40example.com");
    expect(window.location.href).not.toContain("other%40example.com");
    expect(container.querySelector('[data-testid="estimate-payment-status"]')?.textContent).toContain(
      "Your account now shows 15 credits"
    );
  });
});
