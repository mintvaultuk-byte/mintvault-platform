import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const SERVICE = read("server/partner/mfa-service.ts");
const ROUTES = read("server/partner/routes.ts");
const API = read("client/src/lib/partner-api.ts");

describe("Partner MFA pending-enrolment reconciliation", () => {
  it("keeps current-main's current-factor gate for authenticator replacement", () => {
    expect(SERVICE).toContain("verifySecondFactor(c, ctx.userId, secondFactor)");
    expect(SERVICE).toContain('return { ok: false, reason: "second_factor_required" }');
    expect(SERVICE).toContain("credential_version=credential_version+1");
    expect(SERVICE).toContain("id IS DISTINCT FROM $2");
    expect(ROUTES).toContain('recoveryCode: typeof recoveryCode === "string" ? recoveryCode : undefined');
  });

  it("binds each pending setup to its session, opaque id and expiry", () => {
    expect(SERVICE).toContain("MFA_PENDING_SETUP_MINUTES = 10");
    expect(SERVICE).toContain("enrolment_session_id, expires_at");
    expect(SERVICE).toContain("WHERE id=$1 AND user_id=$2 AND method='totp' AND status='PENDING' AND enrolment_session_id=$3");
    expect(SERVICE).toContain('reason: "stale_session"');
    expect(SERVICE).toContain("consumed_at=now()");
    expect(API).toContain("enrolmentId: string");
  });

  it("provides fail-closed restart/cancel and no-store one-time responses", () => {
    expect(SERVICE).toContain("Restart is a bootstrap convenience, never an alternate factor-replacement path");
    expect(SERVICE).toContain('if (await hasActiveMethod(c, ctx.userId)) return { ok: false, reason: "requires_current_factor" }');
    expect(SERVICE).toContain("partner_mfa_enrol_cancelled");
    expect(ROUTES).toContain('r.post("/mfa/restart"');
    expect(ROUTES).toContain('r.post("/mfa/cancel"');
    expect(ROUTES).toContain('res.setHeader("Cache-Control", "private, no-store")');
  });
});
