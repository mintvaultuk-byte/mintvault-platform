// @vitest-environment happy-dom
/**
 * Public verifier revocation presentation — mounted client behaviour.
 *
 * The server response is a discriminated revocation result: `verified: false`
 * with `reason: "voided"` and no historical grade/owner fields. The mounted
 * customer-facing verifier must preserve that fail-closed contract.
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

vi.mock("@/components/v2/section-eyebrow", () => ({
  default: () => createElement("div"),
}));

vi.mock("@/components/ui/gradient-button", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ as, children, height: _height, ...props }: any) =>
    createElement(as === "button" ? "button" : "span", props, children),
}));

vi.mock("@/components/cert-id-input", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ value, onChange, disabled }: any) =>
    createElement("input", {
      "data-testid": "verify-cert-input",
      value,
      disabled,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
}));

import VerifyPage from "../client/src/pages/verify";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

function response(body: unknown, status = 200): Response {
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

async function submit(certId: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('[data-testid="verify-cert-input"]');
  if (!input) throw new Error("Certificate input did not render");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, certId);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
  const form = container.querySelector("form");
  if (!form) throw new Error("Verify form did not render");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(createElement(VerifyPage)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("public certificate verification revocation state", () => {
  it("renders a voided API record as invalid and suppresses stale validity claims", async () => {
    fetchMock.mockResolvedValue(
      response({
        verified: false,
        reason: "voided",
        certId: "MV123",
        status: "voided",
      })
    );

    await submit("MV123");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/verify/MV123");
    const result = container.querySelector<HTMLElement>('[data-testid="verify-result-voided"]');
    expect(result).not.toBeNull();
    expect(result!.getAttribute("role")).toBe("alert");
    expect(result!.textContent).toContain("Certificate voided · Not valid");
    expect(result!.textContent).toContain("no longer valid");
    expect(result!.textContent).not.toContain("Verified");
    expect(result!.textContent).not.toContain("GEM MINT");
    expect(result!.textContent).not.toContain("Claimed");
    expect(result!.querySelector("a")).toBeNull();
  });

  it("keeps an active record on the ordinary valid-certificate path", async () => {
    fetchMock.mockResolvedValue(
      response({
        verified: true,
        certId: "MV124",
        status: "active",
        cardGame: "Pokemon",
        cardName: "Active card",
        cardSet: "Test Set",
        cardYear: "2026",
        cardNumber: "2",
        language: "English",
        grade: "GEM MINT",
        gradeNumeric: 10,
        gradedDate: "2026-08-01",
        ownershipStatus: "claimed",
        verifyUrl: "https://mintvault.test/cert/MV124",
      })
    );

    await submit("MV124");

    const result = container.querySelector<HTMLElement>('[data-testid="verify-result-valid"]');
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain("Verified · active");
    expect(result!.textContent).toContain("GEM MINT");
    expect(result!.querySelector('a[href="/cert/MV124"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="verify-result-voided"]')).toBeNull();
  });

  it("keeps an unknown certificate on the not-found path", async () => {
    fetchMock.mockResolvedValue(response({ verified: false, error: "Certificate not found" }, 404));

    await submit("MV999");

    expect(container.textContent).toContain("Certificate MV999 not recognised");
    expect(container.querySelector('[data-testid="verify-result-valid"]')).toBeNull();
    expect(container.querySelector('[data-testid="verify-result-voided"]')).toBeNull();
  });
});
