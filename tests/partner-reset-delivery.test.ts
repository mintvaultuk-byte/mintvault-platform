/**
 * WP-1.5 P2 — partner password-reset delivery adapter.
 *
 * Transport-boundary tests: the `resend` SDK is mocked, so NO real email is ever sent. These cover
 * the production default adapter (URL/template contract), the fail-closed path when nothing is
 * configured, adapter precedence, and the secrecy contract (no token / no recipient in any thrown
 * error or console output on delivery failure).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor(_key: string) {}
  },
}));

// A token containing characters that MUST be percent-encoded, to prove encodeURIComponent is
// applied. (Real tokens are base64url, but the contract must hold regardless.)
const TOKEN = "tok+en/with=chars&and?more";
const ENCODED = encodeURIComponent(TOKEN);
const EMAIL = "reset-target@example.test";

const ENV_KEYS = ["RESEND_API_KEY", "RESEND_DOMAIN_VERIFIED", "APP_URL"] as const;
let saved: Record<string, string | undefined>;

async function loadDelivery() {
  vi.resetModules();
  return import("../server/partner/delivery");
}

describe("partner reset delivery adapter", () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    delete process.env.RESEND_DOMAIN_VERIFIED;
    process.env.APP_URL = "https://partner.example.test";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("stays fail-closed when no adapter is registered and Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const d = await loadDelivery();
    expect(d.resetDeliveryConfigured()).toBe(false);
    await expect(d.deliverResetToken(EMAIL, TOKEN)).rejects.toThrow(/failing closed/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("reports configured and delivers via Resend when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const d = await loadDelivery();
    expect(d.resetDeliveryConfigured()).toBe(true);

    await d.deliverResetToken(EMAIL, TOKEN);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toBe(EMAIL);
    expect(payload.subject).toBe("MintVault Partner — password reset");

    // Exact link shape, token percent-encoded.
    const expectedUrl = `https://partner.example.test/partner/reset?token=${ENCODED}`;
    expect(payload.html).toContain(`href="${expectedUrl}"`);

    // Exactly one link to the reset consume page, and no tracking/analytics assets.
    const hrefs: string[] = [...payload.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.filter((h) => h.includes("/partner/reset?token="))).toEqual([expectedUrl]);
    expect(payload.html).not.toMatch(/<img|utm_|analytics|pixel|track/i);

    // Expiry communicated to the recipient matches the service-layer constant.
    const { RESET_TOKEN_MINUTES } = await import("../server/partner/auth");
    expect(payload.html).toContain(`${RESET_TOKEN_MINUTES} minutes`);
  });

  it("REFUSES to send when APP_URL is unset, rather than addressing production", async () => {
    /*
     * This test previously asserted the opposite: that an unset APP_URL fell back to
     * https://mintvaultuk.com. That fallback is fine for a public verify link and wrong for a
     * CREDENTIAL link. Staging minting a token and emailing a PRODUCTION URL sends a partner a
     * credential-bearing link for a system that cannot redeem it — the token is useless there, and
     * we have pointed them at the wrong MintVault to type a new password into.
     *
     * There is no safe default for this, so there is no default. Delivery fails, loudly.
     */
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.APP_URL;
    const d = await loadDelivery();

    // Fails through the module's existing REDACTED signal, so the caller still returns the generic
    // "if an account exists…" response and no email is attempted.
    await expect(d.deliverResetToken(EMAIL, TOKEN)).rejects.toThrow(/partner reset delivery failed/);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("addresses the reset link at the deployment that minted the token", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.APP_URL = "https://mintvault-v2.fly.dev";
    const d = await loadDelivery();
    await d.deliverResetToken(EMAIL, TOKEN);

    const html = sendMock.mock.calls[0][0].html;
    expect(html).toContain(`href="https://mintvault-v2.fly.dev/partner/reset?token=${ENCODED}"`);
    // A staging deployment must never emit a production link.
    expect(html).not.toContain("https://mintvaultuk.com/partner/reset");
  });

  it("gives an explicitly registered adapter precedence over the Resend default", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const d = await loadDelivery();
    const captured: Array<[string, string]> = [];
    d.setResetDeliveryAdapter(async (e, t) => {
      captured.push([e, t]);
    });
    await d.deliverResetToken(EMAIL, TOKEN);
    expect(captured).toEqual([[EMAIL, TOKEN]]);
    expect(sendMock).not.toHaveBeenCalled();
    d.setResetDeliveryAdapter(null);
  });

  it("throws on provider failure without leaking the token or the recipient to errors or logs", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    // Provider error text deliberately echoes the secret back, worst case.
    sendMock.mockResolvedValue({
      data: null,
      error: { message: `rejected recipient ${EMAIL} for link token=${TOKEN}` },
    });
    const d = await loadDelivery();

    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      })
    );

    let thrown: unknown;
    try {
      await d.deliverResetToken(EMAIL, TOKEN);
    } catch (e) {
      thrown = e;
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect(thrown).toBeInstanceOf(Error);
    // R3: a redacted operational signal MUST fire — the failure is never silent.
    expect(logged).toContain(d.RESET_DELIVERY_FAILED_SIGNAL);
    const errText = `${(thrown as Error).message}\n${(thrown as Error).stack ?? ""}`;
    const logText = logged.join("\n");

    for (const haystack of [errText, logText]) {
      expect(haystack).not.toContain(TOKEN);
      expect(haystack).not.toContain(ENCODED);
      expect(haystack).not.toContain(EMAIL);
    }
    // ...and it must not disclose that the address belongs to a partner account.
    expect((thrown as Error).message).toBe("partner reset delivery failed");
  });

  it("throws without leaking when the transport itself throws", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    sendMock.mockRejectedValue(new Error(`network failure sending to ${EMAIL} token=${TOKEN}`));
    const d = await loadDelivery();
    let thrown: unknown;
    try {
      await d.deliverResetToken(EMAIL, TOKEN);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe("partner reset delivery failed");
    expect(`${(thrown as Error).message}${(thrown as Error).stack ?? ""}`).not.toContain(TOKEN);
  });
});
