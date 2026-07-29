import { describe, expect, it } from "vitest";
import { redactSensitive } from "../server/lib/auth-security";

describe("partner invitation token redaction", () => {
  it("redacts raw invitation tokens and invite URLs before logging", () => {
    process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY = "true";
    const token = "raw-invitation-token-abcdefghijklmnopqrstuvwxyz";
    const url = `https://mintvaultuk.com/partner/invite?token=${token}`;
    const redacted = redactSensitive({
      invitationLink: url,
      nested: { message: `copy ${url}`, inviteToken: token },
    });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(token);
    expect(json).not.toContain(url);
    expect(json).toContain("[REDACTED]");
  });
});
