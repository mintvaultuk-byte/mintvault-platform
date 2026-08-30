// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("wouter", () => ({
  useLocation: () => [window.location.pathname, navigate],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Link: ({ href, children, ...props }: any) => createElement("a", { href, ...props }, children),
}));

vi.mock("@/lib/queryClient", () => ({ apiRequest }));
vi.mock("@/components/seo-head", () => ({ default: () => null }));
vi.mock("@/components/ui/gradient-button", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ as, children, height: _height, ...props }: any) =>
    createElement(as === "button" ? "button" : "span", props, children),
}));

import LoginPage from "../client/src/pages/login";
import SignupPage from "../client/src/pages/signup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function okResponse(body: unknown = { ok: true }): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function setInput(selector: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Input not found: ${selector}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
}

async function render(page: React.ReactNode): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient }, page)));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  navigate.mockReset();
  apiRequest.mockReset();
  apiRequest.mockResolvedValue(okResponse());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("customer account authentication UI", () => {
  it("offers an accessible password mode that calls the real password-login contract", async () => {
    await render(createElement(LoginPage));

    expect(container.querySelector("#customer-login-password")).toBeNull();
    expect(container.querySelector('a[href="/forgot-password"]')).toBeNull();
    await act(async () => button("Password").click());

    const passwordInput = container.querySelector<HTMLInputElement>("#customer-login-password");
    expect(passwordInput?.type).toBe("password");
    expect(passwordInput?.autocomplete).toBe("current-password");
    expect(container.querySelector('a[href="/forgot-password"]')?.textContent).toContain("Forgot your password?");
    expect(button("Password").getAttribute("aria-pressed")).toBe("true");

    await setInput("#customer-login-email", "owner@example.test");
    await setInput("#customer-login-password", "correct-horse-1");
    const form = container.querySelector("form");
    if (!form) throw new Error("Password form did not render");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();

    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/auth/login", {
      email: "owner@example.test",
      password: "correct-horse-1",
    });
    expect(navigate).toHaveBeenCalledWith("/dashboard");
  });

  it("keeps magic-link login as the default and states the actual 15-minute lifetime", async () => {
    await render(createElement(LoginPage));
    expect(container.textContent).toContain("valid for 15 minutes");

    await setInput("#customer-login-email", "magic@example.test");
    const form = container.querySelector("form");
    if (!form) throw new Error("Magic-link form did not render");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();

    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/auth/magic-link", { email: "magic@example.test" });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Link sent!");
  });

  it("requires verification after signup and provides resend without sending the user into protected records", async () => {
    apiRequest.mockResolvedValue(okResponse({ id: "u-1", email: "new@example.test", email_verified: false }));
    await render(createElement(SignupPage));

    await setInput('input[type="email"]', "new@example.test");
    await setInput('input[type="password"]', "new-password-1");
    const terms = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!terms) throw new Error("Terms checkbox did not render");
    await act(async () => terms.click());
    const form = container.querySelector("form");
    if (!form) throw new Error("Signup form did not render");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();

    expect(container.textContent).toContain("before accessing customer records or paid account features");
    expect(container.textContent).not.toContain("You can still use your account in the meantime");
    expect(container.querySelector('a[href="/dashboard"]')).toBeNull();

    apiRequest.mockResolvedValueOnce(okResponse());
    await act(async () => button("Resend Verification Email").click());
    await flush();
    expect(apiRequest).toHaveBeenLastCalledWith("POST", "/api/auth/resend-verification", {});
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Verification email sent");
  });
});
