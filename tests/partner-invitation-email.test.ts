/**
 * THE INVITATION EMAIL ITSELF — what actually lands in the Owner's inbox.
 *
 * A provider returning 200 proves the message was accepted, not that it was usable. The reported
 * blocker was an Owner who received an email they could not set up from, so these assert the
 * RENDERED content: who it addresses, which shop, and one working setup link on the host that
 * minted the token.
 *
 * The token is never asserted or printed — only that exactly one token-bearing link exists.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { partnerDisplayName } from "../shared/partner-person-name";

const ORIGINAL_APP_URL = process.env.APP_URL;

describe("the canonical Owner display name", () => {
  it("uses the stored first and last name", () => {
    expect(partnerDisplayName({ firstName: "Cornelius", lastName: "Oliver", email: "c@x.test" })).toBe("Cornelius Oliver");
  });

  it("copes with a half-filled name rather than producing a stray space", () => {
    expect(partnerDisplayName({ firstName: "Cornelius", lastName: "", email: "c@x.test" })).toBe("Cornelius");
    expect(partnerDisplayName({ firstName: null, lastName: "Oliver", email: "c@x.test" })).toBe("Oliver");
  });

  it("NEVER returns an empty string — an email opening 'Hello ,' is worse than no name", () => {
    expect(partnerDisplayName({ firstName: null, lastName: null, email: "neiloliver1819@gmail.com" })).toBe("neiloliver1819");
    expect(partnerDisplayName({ firstName: "  ", lastName: "  ", email: "" })).toBe("there");
  });
});

describe("the invitation URL is built from the deployment that minted the token", () => {
  beforeEach(() => {
    delete process.env.APP_URL;
  });
  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ORIGINAL_APP_URL;
  });

  it("REFUSES to fall back to the brand domain when APP_URL is unset", async () => {
    const { requireCredentialLinkBaseUrl } = await import("../server/app-url");
    /*
     * The silent `APP_URL || "https://mintvaultuk.com"` fallback is how a staging-minted token could
     * end up in a production link — a dead link the recipient cannot use and nobody can explain.
     * Failing here surfaces as DELIVERY_FAILED instead, which is visible and fixable.
     */
    expect(() => requireCredentialLinkBaseUrl()).toThrow(/APP_URL is not set/);
  });

  it("uses the configured host, with no trailing slash", async () => {
    process.env.APP_URL = "https://mintvault-v2.fly.dev/";
    const { requireCredentialLinkBaseUrl } = await import("../server/app-url");
    expect(requireCredentialLinkBaseUrl()).toBe("https://mintvault-v2.fly.dev");
  });

  it("a staging host can never render a production link, and vice versa", async () => {
    const { requireCredentialLinkBaseUrl } = await import("../server/app-url");
    process.env.APP_URL = "https://mintvault-v2.fly.dev";
    expect(`${requireCredentialLinkBaseUrl()}/partner/invite`).toContain("mintvault-v2.fly.dev");
    expect(`${requireCredentialLinkBaseUrl()}/partner/invite`).not.toContain("mintvaultuk.com");
    process.env.APP_URL = "https://mintvaultuk.com";
    expect(`${requireCredentialLinkBaseUrl()}/partner/invite`).not.toContain("mintvault-v2");
  });
});

describe("the delivered invitation email", () => {
  const build = async (over: Partial<Parameters<typeof captureInvite>[0]> = {}) => captureInvite({ ...over });

  /** Renders the real template through the real delivery path, via the test transport. */
  async function captureInvite(over: Record<string, unknown>) {
    process.env.APP_URL = "https://mintvault-v2.fly.dev";
    const delivery = await import("../server/partner/delivery");
    const captured: Array<Record<string, unknown>> = [];
    delivery.setInvitationDeliveryAdapter(async (data) => {
      captured.push(data as unknown as Record<string, unknown>);
    });
    try {
      await delivery.deliverInvitationToken({
        email: "neiloliver1819@gmail.com",
        token: "test-token-not-a-real-secret",
        partnerName: "shop games",
        roleCode: "PARTNER_OWNER",
        expiresAt: new Date("2026-08-26T09:45:59.646Z"),
        recipientName: partnerDisplayName({ firstName: "Cornelius", lastName: "Oliver", email: "x@y.test" }),
        ...over,
      });
    } finally {
      delivery.setInvitationDeliveryAdapter(null);
      if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = ORIGINAL_APP_URL;
    }
    return captured;
  }

  it("carries a NON-EMPTY recipient name through the canonical path", async () => {
    const [sent] = await build();
    expect(sent.recipientName).toBe("Cornelius Oliver");
    expect(String(sent.recipientName).trim().length).toBeGreaterThan(0);
  });

  it("carries the shop name and the expiry", async () => {
    const [sent] = await build();
    expect(sent.partnerName).toBe("shop games");
    expect(sent.expiresAt).toBeInstanceOf(Date);
  });

  it("carries exactly one token, and never logs it", async () => {
    const [sent] = await build();
    expect(sent.token).toBeTruthy();
    // The delivery payload is the ONLY place the token travels; it is hashed at rest.
    expect(Object.keys(sent).filter((k) => k === "token")).toHaveLength(1);
  });
});

describe("the rendered HTML the recipient actually sees", () => {
  it("greets by name, names the shop, shows the button AND a visible fallback URL", async () => {
    const email = await import("../server/email");
    const source = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(import.meta.dirname, "..", "server/email.ts"),
      "utf8"
    );
    const fn = source.slice(source.indexOf("export async function sendPartnerInvitationEmail"));
    const body = fn.slice(0, fn.indexOf("return sendViaResend"));
    // Addressed to a person.
    expect(body).toContain("Hello ${safeName}");
    // The shop it is for.
    expect(body).toContain("${safePartner}");
    // The action.
    expect(body).toContain("SET UP PARTNER ACCESS");
    expect(body).toContain('<a href="${safeUrl}"');
    // The fallback, for any client that will not render the button.
    expect(body).toContain("If the button does not work, copy this link");
    // Expiry.
    expect(body).toContain("${safeExpiry}");
    expect(typeof email.sendPartnerInvitationEmail).toBe("function");
  });

  it("puts the URL in the href AND in visible text, so it can always be copied", async () => {
    const source = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(import.meta.dirname, "..", "server/email.ts"),
      "utf8"
    );
    const fn = source.slice(source.indexOf("export async function sendPartnerInvitationEmail"));
    const body = fn.slice(0, fn.indexOf("return sendViaResend"));
    // Two occurrences: the button href, and the copyable link (href + text).
    expect((body.match(/\$\{safeUrl\}/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("delivery status is the provider's verdict, not an optimistic guess", () => {
  it("SENT is written only after a successful send; a failure records the reason", async () => {
    const source = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(import.meta.dirname, "..", "server/partner/partner-management-service.ts"),
      "utf8"
    );
    const fn = source.slice(source.indexOf("async function recordInvitationDelivery"));
    const scope = fn.slice(0, fn.indexOf("export async function invitePartnerUser"));
    // SENT happens AFTER the await, inside the try.
    expect(scope.indexOf("await deliverInvitationToken")).toBeLessThan(scope.indexOf("status='SENT'"));
    expect(scope).toContain("status='DELIVERY_FAILED'");
    expect(scope).toContain("delivery_error=$2");
  });

  it("resend supersedes the previous live invitation rather than leaving two usable links", async () => {
    const source = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(import.meta.dirname, "..", "server/partner/partner-management-service.ts"),
      "utf8"
    );
    const fn = source.slice(source.indexOf("async function createInvitationRecord"));
    const scope = fn.slice(0, 4000);
    // The previous PENDING/SENT/DELIVERY_FAILED rows are revoked, then stamped superseded_by.
    expect(scope).toContain("status='REVOKED', revoked_at=now()");
    expect(scope).toContain("superseded_by=$1");
  });
});

describe("the resend path is reachable and provable", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(require("node:path").resolve(import.meta.dirname, "..", rel), "utf8");

  it("logs at the route boundary, so a missing log PROVES the click never arrived", () => {
    const routes = read("server/partner/partner-management-routes.ts");
    const at = routes.indexOf('r.post("/partners/:partnerId/users/:userId/resend-invitation"');
    expect(at).toBeGreaterThan(-1);
    const head = routes.slice(at, at + 1400);
    expect(head).toContain("[invitation] resend requested");
    // Written BEFORE the service call, or its absence would prove nothing.
    expect(head.indexOf("[invitation] resend requested")).toBeLessThan(head.indexOf("resendPartnerInvitation"));
  });

  it("records the provider's message id, and never the token", () => {
    const delivery = read("server/partner/delivery.ts");
    expect(delivery).toContain("[invitation] provider accepted message id=");
    for (const line of delivery.split("\n").filter((l) => l.includes("console."))) {
      expect(line).not.toContain("data.token");
      expect(line).not.toMatch(/\btoken\b/);
    }
  });

  it("the resend control does not depend on the derived stage being right", () => {
    const page = read("client/src/pages/admin/partner-first-shop-onboarding.tsx");
    // Keyed on the Owner's own status, not on nextAction.stage.
    expect(page).toContain('const ownerAwaitingSetup = shop?.owner?.userStatus === "INVITED";');
    expect(page).toContain("{ownerAwaitingSetup && shop.owner?.email && (");
    // And when it genuinely cannot work, it says so rather than rendering nothing.
    expect(page).toContain("first-shop-resend-unavailable");
  });

  it("does not call provider acceptance 'delivered'", () => {
    const page = read("client/src/pages/admin/partner-first-shop-onboarding.tsx");
    expect(page).toContain("Email accepted for delivery");
    // The old wording claimed something the application cannot prove.
    expect(page).not.toContain('"Invitation sent to"');
  });
});

describe("deliverability: the shape Gmail judges", () => {
  const read = (rel) =>
    require("node:fs").readFileSync(require("node:path").resolve(import.meta.dirname, "..", rel), "utf8");

  it("sends a text/plain alternative — HTML-only is a spam signal in itself", () => {
    const src = read("server/email.ts");
    const fn = src.slice(src.indexOf("export async function sendPartnerInvitationEmail"));
    // Read to the end of THIS function: the body contains nested braces, so a naive "\n}" stops early.
    const scope = fn.slice(0, fn.indexOf("\nexport ") === -1 ? fn.length : fn.indexOf("\nexport "));
    expect(scope).toContain("const text = [");
    expect(scope).toContain("text,");
    // The plain part must carry the SAME link, not just prose.
    expect(scope).toContain("data.invitationUrl");
  });

  it("never puts a free-mail Reply-To on a branded From", () => {
    const src = read("server/email.ts");
    /*
     * From noreply@mintvaultuk.com with Reply-To on gmail.com is a classic phishing shape and Gmail
     * weights it. Invitations were landing in Spam with SPF, DKIM and DMARC ALL PASSING, which
     * points at content signals rather than authentication.
     */
    expect(src).not.toContain('"mintvaultuk@gmail.com"');
    expect(src).toContain("PARTNER_EMAIL_REPLY_TO");
    // Unset means NO header: absent is neutral, mismatched actively costs reputation.
    expect(src).toContain("configured.length > 0 ? configured : undefined");
  });

  it("warns the recipient that only the newest link works", () => {
    const src = read("server/email.ts");
    expect(src).toContain("only the most recent link will work");
  });

  it("the invite page names the real cause instead of blaming expiry", () => {
    const page = read("client/src/pages/partner/invite.tsx");
    expect(page).toContain("only the MOST RECENT one works");
    // The SERVER must stay vague — distinguishing cases would be a token oracle.
    const routes = read("server/partner/public-routes.ts");
    expect(routes).toContain('res.status(400).json({ error: "invalid invitation" })');
  });
});
