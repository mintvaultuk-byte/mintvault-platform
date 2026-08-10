// @vitest-environment happy-dom
/**
 * Partner Portal onboarding UX (WP-2) — REAL component rendering.
 *
 * Every assertion below mounts the actual component and would FAIL if its guard were removed —
 * following tests/partner-user-management-ui-render.test.ts rather than the source-text style of
 * tests/partner-login-invite-ui.test.ts (a string can exist in a file while the behaviour it
 * describes is attached to something else entirely).
 *
 * Written with `createElement` rather than JSX, matching the house convention (vitest `include`
 * is tests/**\/*.test.ts).
 *
 * The API is faked at the apiRequest seam only, so the REAL client (client/src/lib/partner-api.ts)
 * still does the status/body -> PartnerApiError translation under test — which is precisely the
 * 503-vs-401 distinction these tests exist to prove.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  queryClient: { invalidateQueries: vi.fn() },
}));

const navigate = vi.fn();
vi.mock("wouter", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Link: ({ href, children, ...props }: any) => createElement("a", { href, ...props }, children),
  useLocation: () => ["/partner/login", navigate],
}));

vi.mock("qrcode", () => ({
  toDataURL: () => Promise.resolve("data:image/png;base64,FAKEQR"),
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,FAKEQR") },
}));

// React 18 wants this flag before act() is used outside a testing-library harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);

/** Mirrors what client/src/lib/queryClient.ts throwIfResNotOk actually throws. */
function fail(status: number, error: unknown) {
  const err = new Error(typeof error === "string" ? error : "request failed") as Error & {
    status: number;
    body: unknown;
  };
  err.status = status;
  err.body = { error };
  return Promise.reject(err);
}

/**
 * A genuine network failure: fetch itself rejects, so the error carries NO status and NO body —
 * which is exactly how req() ends up reporting status 0 (`e.status ?? 0`).
 */
const netFail = () => Promise.reject(new TypeError("Failed to fetch"));

const q = (sel: string) => container.querySelector<HTMLElement>(`[data-testid="${sel}"]`);
const calls = (method: string, urlPart: string) =>
  apiRequest.mock.calls.filter((c) => c[0] === method && String(c[1]).includes(urlPart));

async function waitForTestId(id: string): Promise<HTMLElement> {
  for (let i = 0; i < 20; i += 1) {
    const el = q(id);
    if (el) return el;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`Timed out waiting for ${id}`);
}

function setValue(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitForm(testId: string) {
  const form = q(testId)!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function clickTestId(testId: string) {
  const el = q(testId)!;
  await act(async () => {
    el.click();
  });
}

async function render(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, node));
  });
  return qc;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiRequest.mockReset();
  navigate.mockReset();
  window.history.replaceState({}, "", "/partner/login");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetModules();
});

// ---------------------------------------------------------------- MFA enrolment

async function mountEnrolment(onComplete = vi.fn(), onBack = vi.fn()) {
  const { PartnerMfaEnrolment } = await import("../client/src/components/partner/partner-mfa-enrolment");
  await render(
    createElement(PartnerMfaEnrolment, {
      password: "correct-horse-battery",
      onComplete,
      onUseExistingAuthenticator: onBack,
    })
  );
  return { onComplete, onBack };
}

describe("Partner MFA enrolment (real render)", () => {
  it("happy path: enrols with the password, shows the secret + QR, confirms a code, then shows recovery codes", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/mfa/enrol")) return ok({ ok: true, secret: "JBSWY3DPEB", otpauthUri: "otpauth://totp/x" });
      if (url.endsWith("/mfa/confirm")) return ok({ ok: true, recoveryCodes: ["aaa-111", "bbb-222"] });
      return ok({ ok: true });
    });
    const { onComplete } = await mountEnrolment();

    await waitForTestId("text-mfa-secret");
    expect(calls("POST", "/mfa/enrol"), "enrolment is started exactly once").toHaveLength(1);
    expect(calls("POST", "/mfa/enrol")[0][2], "the password is sent as elevated verification").toEqual({
      password: "correct-horse-battery",
    });
    expect(q("text-mfa-secret")!.textContent, "the setup key is shown so a user who cannot scan can type it").toContain(
      "JBSWY3DPEB"
    );
    const img = await waitForTestId("img-mfa-qr");
    expect(img.getAttribute("src"), "a scannable QR is rendered").toContain("data:image/png");

    setValue(q("input-mfa-enrol-code")!, "123456");
    await submitForm("form-partner-mfa-enrol");

    expect(calls("POST", "/mfa/confirm")[0][2], "the typed code is confirmed server-side").toEqual({ code: "123456" });
    const list = await waitForTestId("list-mfa-recovery-codes");
    expect(list.textContent).toContain("aaa-111");
    expect(list.textContent).toContain("bbb-222");
    expect(q("text-mfa-secret"), "the TOTP secret is cleared once confirmed").toBeNull();
    expect(onComplete, "completion waits for the user to acknowledge the codes").not.toHaveBeenCalled();
  });

  it("a wrong code keeps the user on the setup step with a plain-English message and no completion", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/mfa/enrol")) return ok({ ok: true, secret: "JBSWY3DPEB", otpauthUri: "otpauth://totp/x" });
      if (url.endsWith("/mfa/confirm")) return fail(400, "invalid_code");
      return ok({ ok: true });
    });
    const { onComplete } = await mountEnrolment();
    await waitForTestId("text-mfa-secret");

    setValue(q("input-mfa-enrol-code")!, "000000");
    await submitForm("form-partner-mfa-enrol");

    const err = await waitForTestId("text-mfa-enrol-error");
    expect(err.textContent, "plain English, never the raw server reason").toContain("That code was not right");
    expect(err.textContent).not.toContain("invalid_code");
    expect(q("form-partner-mfa-enrol"), "the user stays on the setup step and can retry").toBeTruthy();
    expect(q("list-mfa-recovery-codes"), "no recovery codes are shown for a failed confirmation").toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("recovery codes gate completion: Continue is disabled until the user acknowledges them", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/mfa/enrol")) return ok({ ok: true, secret: "S", otpauthUri: "otpauth://totp/x" });
      if (url.endsWith("/mfa/confirm")) return ok({ ok: true, recoveryCodes: ["aaa-111"] });
      return ok({ ok: true });
    });
    const { onComplete } = await mountEnrolment();
    await waitForTestId("text-mfa-secret");
    setValue(q("input-mfa-enrol-code")!, "123456");
    await submitForm("form-partner-mfa-enrol");
    await waitForTestId("list-mfa-recovery-codes");

    const finish = q("button-mfa-enrol-finish") as HTMLButtonElement;
    expect(finish.disabled, "disabled before acknowledgement").toBe(true);
    await act(async () => finish.click());
    expect(onComplete, "clicking through without acknowledging does nothing").not.toHaveBeenCalled();

    await act(async () => q("checkbox-recovery-acknowledged")!.click());
    expect((q("button-mfa-enrol-finish") as HTMLButtonElement).disabled, "enabled once acknowledged").toBe(false);
    await act(async () => q("button-mfa-enrol-finish")!.click());
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a user who already has an authenticator is told so and sent back to the code step", async () => {
    apiRequest.mockImplementation((method: string, url: string) =>
      url.endsWith("/mfa/enrol") ? fail(403, "requires_current_factor") : ok({ ok: true })
    );
    const { onBack } = await mountEnrolment();

    const err = await waitForTestId("text-mfa-enrol-error");
    expect(err.textContent).toContain("already have an authenticator app");
    expect(err.textContent).not.toContain("requires_current_factor");
    await act(async () => q("button-mfa-enrol-back")!.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("an unavailable two-factor backend (503) says so instead of blaming the user's code", async () => {
    apiRequest.mockImplementation((method: string, url: string) =>
      url.endsWith("/mfa/enrol") ? fail(503, "encryption_unavailable") : ok({ ok: true })
    );
    await mountEnrolment();
    const err = await waitForTestId("text-mfa-enrol-error");
    expect(err.textContent).toContain("temporarily unavailable");
    expect(err.textContent).not.toContain("encryption_unavailable");
  });
});

describe("Partner invitation password visibility (real render)", () => {
  async function mountInvite() {
    window.history.replaceState({}, "", "/partner/invite?token=invite-token");
    apiRequest.mockImplementation((method: string, url: string) => {
      if (method === "GET" && String(url).includes("/api/partner/invitations/preview")) {
        return ok({
          email: "mintvaultuk@gmail.com",
          partnerName: "MintVault Pilot Partner One Ltd",
          roleCode: "PARTNER_OWNER",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      }
      if (method === "POST" && String(url).includes("/api/partner/invitations/accept")) {
        return ok({ ok: true, organisationStatus: "PENDING" });
      }
      return fail(404, "unexpected");
    });
    const { default: InvitePage } = await import("../client/src/pages/partner/invite");
    await render(createElement(InvitePage));
    await waitForTestId("partner-invite-preview");
  }

  it("reveals and masks each password field independently without submitting or losing typed values", async () => {
    await mountInvite();
    const password = q("input-partner-invite-password") as HTMLInputElement;
    const confirm = q("input-partner-invite-confirm") as HTMLInputElement;
    const passwordToggle = q("button-partner-invite-toggle-password") as HTMLButtonElement;
    const confirmToggle = q("button-partner-invite-toggle-confirm") as HTMLButtonElement;

    expect(password.type, "password starts masked").toBe("password");
    expect(confirm.type, "confirm password starts masked").toBe("password");
    expect(passwordToggle.type, "password toggle never submits the form").toBe("button");
    expect(confirmToggle.type, "confirm toggle never submits the form").toBe("button");
    expect(passwordToggle.className, "password toggle has a mobile touch target").toContain("min-h-11");
    expect(confirmToggle.className, "confirm toggle has a mobile touch target").toContain("min-w-11");
    expect(passwordToggle.className, "password toggle has a visible focus state").toContain("focus-visible:ring-2");
    expect(confirmToggle.className, "confirm toggle has a visible focus state").toContain("focus-visible:ring-2");
    expect(passwordToggle.getAttribute("aria-label")).toBe("Show password");
    expect(confirmToggle.getAttribute("aria-label")).toBe("Show confirm password");
    expect(passwordToggle.getAttribute("aria-pressed")).toBe("false");
    expect(confirmToggle.getAttribute("aria-pressed")).toBe("false");

    setValue(password, "owner-secret-123");
    setValue(confirm, "different-secret-123");
    await clickTestId("button-partner-invite-toggle-password");
    expect(password.type, "tapping show reveals password").toBe("text");
    expect(confirm.type, "confirm remains independently masked").toBe("password");
    expect(password.value).toBe("owner-secret-123");
    expect(confirm.value).toBe("different-secret-123");
    expect(passwordToggle.getAttribute("aria-label")).toBe("Hide password");
    expect(passwordToggle.getAttribute("aria-pressed")).toBe("true");
    expect(calls("POST", "/api/partner/invitations/accept"), "toggle did not submit").toHaveLength(0);

    await clickTestId("button-partner-invite-toggle-password");
    expect(password.type, "tapping hide masks password again").toBe("password");
    expect(password.value).toBe("owner-secret-123");
    expect(passwordToggle.getAttribute("aria-label")).toBe("Show password");
    expect(passwordToggle.getAttribute("aria-pressed")).toBe("false");

    await clickTestId("button-partner-invite-toggle-confirm");
    expect(confirm.type, "confirm show works independently").toBe("text");
    expect(password.type).toBe("password");
    expect(confirm.value).toBe("different-secret-123");
    expect(confirmToggle.getAttribute("aria-label")).toBe("Hide confirm password");
    expect(confirmToggle.getAttribute("aria-pressed")).toBe("true");
    expect(calls("POST", "/api/partner/invitations/accept"), "confirm toggle did not submit").toHaveLength(0);
  });

  it("updates mismatch validation as values match and never exposes the password in logs or responses", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mountInvite();
      const password = q("input-partner-invite-password") as HTMLInputElement;
      const confirm = q("input-partner-invite-confirm") as HTMLInputElement;

      setValue(password, "owner-secret-123");
      setValue(confirm, "different-secret-123");
      await submitForm("form-partner-invite");
      expect(q("text-partner-invite-error")!.textContent).toContain("Passwords do not match.");
      expect(calls("POST", "/api/partner/invitations/accept"), "mismatch blocks API submission").toHaveLength(0);

      setValue(confirm, "owner-secret-123");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(q("text-partner-invite-error"), "mismatch clears when both values match").toBeNull();

      await submitForm("form-partner-invite");
      await waitForTestId("partner-invite-done");
      expect(container.textContent).not.toContain("owner-secret-123");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("owner-secret-123");
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("owner-secret-123");
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("owner-secret-123");
      const acceptRequestBody = await calls("POST", "/api/partner/invitations/accept")[0][2];
      expect(JSON.stringify({ ok: true, organisationStatus: "PENDING" })).not.toContain("owner-secret-123");
      expect(acceptRequestBody).toEqual({ token: "invite-token", password: "owner-secret-123" });
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- login wiring

describe("Partner sign in — enrolment is reachable (real render)", () => {
  async function mountLogin(search = "") {
    window.history.replaceState({}, "", `/partner/login${search}`);
    const { PartnerSessionProvider } = await import("../client/src/hooks/use-partner-session");
    const { default: Login } = await import("../client/src/pages/partner/login");
    await render(createElement(PartnerSessionProvider, null, createElement(Login)));
  }

  it("offers a forgotten-password route from the credentials step", async () => {
    apiRequest.mockImplementation(() => fail(401, "authentication required"));
    await mountLogin();
    await waitForTestId("form-partner-login");
    expect(q("link-forgot-password")!.getAttribute("href")).toBe("/partner/forgot-password");
  });

  it("a user arriving from an accepted invitation (?setup=1) lands on enrolment, not an impossible code box", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/auth/login")) return ok({ ok: true, mfaRequired: true });
      if (url.endsWith("/mfa/enrol")) return ok({ ok: true, secret: "S", otpauthUri: "otpauth://totp/x" });
      if (url.endsWith("/session")) return fail(401, "authentication required");
      return ok({ ok: true });
    });
    await mountLogin("?setup=1");
    await waitForTestId("form-partner-login");
    setValue(q("input-email")!, "new@partner.test");
    setValue(q("input-password")!, "correct-horse-battery");
    await submitForm("form-partner-login");

    await waitForTestId("form-partner-mfa-enrol");
    expect(
      q("form-partner-mfa"),
      "the code step is not shown to a user with nothing to generate a code with"
    ).toBeNull();
  });

  it("an ordinary MFA sign-in still shows the code step, with enrolment available as a choice", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/auth/login")) return ok({ ok: true, mfaRequired: true });
      if (url.endsWith("/session")) return fail(401, "authentication required");
      return ok({ ok: true });
    });
    await mountLogin();
    await waitForTestId("form-partner-login");
    setValue(q("input-email")!, "user@partner.test");
    setValue(q("input-password")!, "correct-horse-battery");
    await submitForm("form-partner-login");

    await waitForTestId("form-partner-mfa");
    expect(q("button-start-mfa-enrolment"), "enrolment is reachable from the code step").toBeTruthy();
    expect(calls("POST", "/mfa/enrol"), "enrolment is never started behind the user's back").toHaveLength(0);
  });

  it("takes a non-MFA sign-in straight to the dashboard after refreshing the session", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/auth/login")) return ok({ ok: true, mfaRequired: false });
      if (url.endsWith("/session")) return ok({ mfaPassed: true, permissions: [] });
      return ok({ ok: true });
    });
    await mountLogin();
    await waitForTestId("form-partner-login");
    setValue(q("input-email")!, "user@partner.test");
    setValue(q("input-password")!, "correct-horse-battery");
    await submitForm("form-partner-login");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(window.location.pathname).toBe("/partner/dashboard");
  });
});

// ---------------------------------------------------------------- password reset

describe("Partner password reset (real render)", () => {
  it("the request page gives one identical answer whether or not the account exists", async () => {
    const { default: RequestPage } = await import("../client/src/pages/partner/password-reset-request");

    apiRequest.mockImplementation(() => ok({ ok: true }));
    await render(createElement(RequestPage));
    setValue(q("input-reset-email")!, "known@partner.test");
    await submitForm("form-partner-reset-request");
    const shown = (await waitForTestId("text-reset-request-sent")).textContent ?? "";
    expect(shown).toContain("If that email address has a Partner Portal account");
    expect(calls("POST", "/auth/password-reset/request")[0][2]).toEqual({ email: "known@partner.test" });

    // Same screen even when the call itself fails — a difference here would be an enumeration oracle.
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    apiRequest.mockReset();
    apiRequest.mockImplementation(() => fail(503, "partner login unavailable"));
    await render(createElement(RequestPage));
    setValue(q("input-reset-email")!, "unknown@nowhere.test");
    await submitForm("form-partner-reset-request");
    expect((await waitForTestId("text-reset-request-sent")).textContent).toBe(shown);
  });

  it("the consume page reads the token from the query string and sends only token + new password", async () => {
    window.history.replaceState({}, "", "/partner/reset?token=RESET-TOKEN-123");
    apiRequest.mockImplementation(() => ok({ ok: true }));
    const { default: ResetPage } = await import("../client/src/pages/partner/password-reset");
    await render(createElement(ResetPage));

    setValue(q("input-reset-password")!, "short");
    setValue(q("input-reset-confirm")!, "short");
    await submitForm("form-partner-reset");
    expect(calls("POST", "/password-reset/consume"), "too-short password never reaches the server").toHaveLength(0);
    expect(q("text-reset-error")!.textContent).toContain("at least 10 characters");

    setValue(q("input-reset-password")!, "a-long-enough-password");
    setValue(q("input-reset-confirm")!, "a-different-password");
    await submitForm("form-partner-reset");
    expect(calls("POST", "/password-reset/consume"), "mismatch never reaches the server").toHaveLength(0);
    expect(q("text-reset-error")!.textContent).toContain("do not match");

    setValue(q("input-reset-confirm")!, "a-long-enough-password");
    await submitForm("form-partner-reset");
    const sent = calls("POST", "/password-reset/consume");
    expect(sent).toHaveLength(1);
    expect(sent[0][2], "no email, user id or organisation is ever sent — the server derives it").toEqual({
      token: "RESET-TOKEN-123",
      newPassword: "a-long-enough-password",
    });
    await waitForTestId("partner-reset-done");
    expect(container.textContent).not.toContain("RESET-TOKEN-123");
  });

  it("a used or expired link is explained, not silently swallowed", async () => {
    window.history.replaceState({}, "", "/partner/reset?token=DEAD");
    apiRequest.mockImplementation(() => fail(400, "invalid request"));
    const { default: ResetPage } = await import("../client/src/pages/partner/password-reset");
    await render(createElement(ResetPage));
    setValue(q("input-reset-password")!, "a-long-enough-password");
    setValue(q("input-reset-confirm")!, "a-long-enough-password");
    await submitForm("form-partner-reset");
    expect((await waitForTestId("text-reset-error")).textContent).toContain("Reset links work once and expire quickly");
    expect(q("partner-reset-done")).toBeNull();
  });

  it("arriving with no token at all offers a new link instead of a dead form", async () => {
    window.history.replaceState({}, "", "/partner/reset");
    const { default: ResetPage } = await import("../client/src/pages/partner/password-reset");
    await render(createElement(ResetPage));
    expect(q("partner-reset-no-token")).toBeTruthy();
    expect(q("form-partner-reset")).toBeNull();
  });
});

// ---------------------------------------------------------------- honest error states

describe("Partner route guard — 503 and 401 are told apart (real render)", () => {
  async function mountGuard() {
    const { PartnerSessionProvider } = await import("../client/src/hooks/use-partner-session");
    const { PartnerRouteGuard } = await import("../client/src/components/partner/partner-route-guard");
    const child = createElement("div", { "data-testid": "protected-content" }, "secret");
    return render(createElement(PartnerSessionProvider, null, createElement(PartnerRouteGuard, null, child)));
  }

  it("a 503 renders the Portal-unavailable state and does NOT bounce to sign-in", async () => {
    apiRequest.mockImplementation(() => fail(503, "partner portal unavailable"));
    await mountGuard();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent, "the honest 'switched off' screen").toContain("Partner Portal unavailable");
    expect(navigate, "a disabled Portal is not a login problem, so no redirect").not.toHaveBeenCalled();
    expect(q("protected-content")).toBeNull();
  });

  it("a network failure (status 0) renders Unavailable, not a sign-in bounce", async () => {
    apiRequest.mockImplementation(() => netFail());
    await mountGuard();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent, "an offline client is not a signed-out user").toContain("Partner Portal unavailable");
    expect(container.textContent).not.toContain("Your session has ended");
    expect(navigate, "no bounce to a sign-in page that cannot work either").not.toHaveBeenCalled();
    expect(q("protected-content")).toBeNull();
  });

  it("a network failure mid-session does NOT falsely claim the session ended", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/session")) return ok({ userId: "u1", tenantId: "t1", mfaPassed: true, permissions: [] });
      return ok([]);
    });
    const qc = await mountGuard();
    await waitForTestId("protected-content");

    apiRequest.mockImplementation(() => netFail());
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["/api/partner/session"] });
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent).toContain("Partner Portal unavailable");
    expect(container.textContent, "the user was never signed out — the connection dropped").not.toContain(
      "Your session has ended"
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a bad gateway (502) while the backend restarts is unavailability, not sign-out", async () => {
    apiRequest.mockImplementation(() => fail(502, "bad gateway"));
    await mountGuard();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent).toContain("Partner Portal unavailable");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a first-load 401 is an ordinary signed-out visitor and still redirects to sign in", async () => {
    apiRequest.mockImplementation(() => fail(401, "authentication required"));
    await mountGuard();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(navigate).toHaveBeenCalledWith("/partner/login");
    expect(container.textContent).not.toContain("Your session has ended");
    expect(q("protected-content")).toBeNull();
  });

  it("a mid-session 401 renders the session-expired state instead of silently bouncing", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (url.endsWith("/session")) return ok({ userId: "u1", tenantId: "t1", mfaPassed: true, permissions: [] });
      return ok([]);
    });
    const qc = await mountGuard();
    await waitForTestId("protected-content");

    apiRequest.mockImplementation((method: string, url: string) =>
      url.endsWith("/session") ? fail(401, "authentication required") : ok([])
    );
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["/api/partner/session"] });
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent, "the user is told they were signed out").toContain("Your session has ended");
    expect(navigate, "no silent redirect — the expiry is explained").not.toHaveBeenCalled();
    expect(q("protected-content")).toBeNull();
  });
});

// ---------------------------------------------------------------- routing + dead code

describe("WP-2 route registration and dead-code removal", () => {
  it("both reset routes are registered in the partner block, outside the guard", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("client/src/App.tsx", "utf8");
    expect(app).toContain('path="/partner/forgot-password"');
    expect(app).toContain('path="/partner/reset"');
    // Public: they must sit before the guarded pages and never be wrapped in PartnerRouteGuard.
    expect(app.indexOf('path="/partner/reset"')).toBeLessThan(app.indexOf('path="/partner/dashboard"'));
    const resetBlock = app.slice(
      app.indexOf('path="/partner/forgot-password"'),
      app.indexOf('path="/partner/dashboard"')
    );
    expect(resetBlock).not.toContain("PartnerRouteGuard");
  });

  it("coming-soon.tsx no longer exports a dead default page that shadows the real Users page", async () => {
    const mod = await import("../client/src/pages/partner/coming-soon");
    expect(mod.PartnerComingSoon, "the shared placeholder is still exported").toBeTruthy();
    expect((mod as Record<string, unknown>).default, "the dead default export is gone").toBeUndefined();
  });
});
