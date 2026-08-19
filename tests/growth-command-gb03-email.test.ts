import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: sendMock };
  },
}));

const ENV_KEYS = ["RESEND_API_KEY", "RESEND_DOMAIN_VERIFIED", "CONTACT_INBOX_EMAIL"] as const;
let saved: Record<string, string | undefined>;

async function loadEmail() {
  vi.resetModules();
  return import("../server/email");
}

describe("GB-03 Partner notification transport", () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: "synthetic-partner-message" }, error: null });
    process.env.RESEND_API_KEY = "re_synthetic_partner_test";
    process.env.CONTACT_INBOX_EMAIL = "partner-inbox@example.test";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });

  it("uses a fixed subject, configured internal recipient, reply-to and escaped applicant content", async () => {
    const { sendPartnerApplicationNotification } = await loadEmail();
    await expect(
      sendPartnerApplicationNotification({
        leadId: "11111111-1111-4111-8111-111111111111",
        businessName: "<img src=x onerror=alert(1)>",
        contactName: "Applicant\r\nBcc: injected@example.test",
        email: "applicant@example.test",
        city: "Rochester",
        postcode: "ME2 2NG",
        businessType: "tcg_card_shop",
        webPresence: "https://shop.example",
        interestReason: "<script>alert('no')</script>",
        categories: ["Pokemon"],
      })
    ).resolves.toEqual({ id: "synthetic-partner-message" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as { to: string; replyTo: string; subject: string; html: string };
    expect(payload.to).toBe("partner-inbox@example.test");
    expect(payload.replyTo).toBe("applicant@example.test");
    expect(payload.subject).toBe("MintVault Partner Application 11111111-1111-4111-8111-111111111111");
    expect(payload.subject).not.toContain("Applicant");
    expect(payload.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(payload.html).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;");
    expect(payload.html).not.toContain("<script>alert");
  });

  it("does not manufacture a notification when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendPartnerApplicationNotification } = await loadEmail();
    await expect(
      sendPartnerApplicationNotification({
        leadId: "11111111-1111-4111-8111-111111111111",
        businessName: "Synthetic Shop",
        contactName: "Synthetic Applicant",
        email: "applicant@example.test",
        city: "Rochester",
        postcode: "ME2 2NG",
        businessType: "tcg_card_shop",
        webPresence: "https://shop.example",
        interestReason: "A sufficient synthetic interest reason for a notification test.",
        categories: [],
      })
    ).resolves.toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
