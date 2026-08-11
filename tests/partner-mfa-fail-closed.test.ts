/**
 * OWNER-AUTHORISED REPAIR (2026-08-11) — PARTNER MFA MUST NOT FAIL OPEN.
 *
 * `partnerLogin` computes `mfaPending = u.mfa_required || u.has_active_mfa` and
 * mints the session with `mfa_passed = !mfaPending`. `has_active_mfa` exists only
 * in migration 0046's `partner_auth_lookup` signature — 0002's original stops at
 * `mfa_required`. Against a database still on the ten-column form the column is
 * simply ABSENT from the result row, so `has_active_mfa` is `undefined`,
 * `mfaPending` is `undefined`, and `!undefined === true` — every such login was
 * minted fully authenticated. An account holding an ACTIVE authenticator with
 * `mfa_required = false` therefore had its second factor silently disabled, with
 * no error, no log line and no failing request to notice it by.
 *
 * This is a live production risk, not a hypothetical: production's migration
 * journal does NOT contain 0044_partner_mfa_pending_lifecycle — its 0046 slot
 * holds a different scanner migration entirely.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const AUTH = readFileSync("server/partner/auth.ts", "utf8");
const PUBLIC_ROUTES = readFileSync("server/partner/public-routes.ts", "utf8");
const PORTAL_ROUTES = readFileSync("server/partner/routes.ts", "utf8");
const MIGRATION_0046 = readFileSync("migrations/0044_partner_mfa_pending_lifecycle.sql", "utf8");

describe("partner login fails CLOSED when the MFA projection is missing", () => {
  it("refuses rather than trusting an absent has_active_mfa", () => {
    expect(AUTH).toContain('if (typeof u.has_active_mfa !== "boolean")');
    expect(AUTH).toContain('return { ok: false, reason: "mfa_state_unavailable" };');
  });

  it("types the column as OPTIONAL so the check is a real narrowing, not a cast", () => {
    // Declaring it `has_active_mfa: boolean` was a claim TypeScript could not
    // verify — `SELECT *` returns whatever the DEPLOYED function declares.
    expect(AUTH).toMatch(/has_active_mfa\?: boolean;/);
    expect(AUTH).not.toMatch(/^\s*has_active_mfa: boolean;/m);
  });

  it("checks AFTER the constant-cost bcrypt compare, so the timing property is untouched", () => {
    const bcryptAt = AUTH.indexOf("const good = u.password_hash ? await bcrypt.compare");
    const guardAt = AUTH.indexOf('if (typeof u.has_active_mfa !== "boolean")');
    expect(bcryptAt).toBeGreaterThan(0);
    expect(guardAt).toBeGreaterThan(bcryptAt);
  });

  it("checks BEFORE any lockout counter is armed or any session is minted", () => {
    const guardAt = AUTH.indexOf('if (typeof u.has_active_mfa !== "boolean")');
    // Every state mutation on this path must come after the guard.
    for (const marker of ["recordFailure", "INSERT INTO partner_sessions"]) {
      const at = AUTH.indexOf(marker);
      if (at >= 0) {
        expect(at, `${marker} must not run before the fail-closed guard`).toBeGreaterThan(guardAt);
      }
    }
  });

  it("BOTH login routes surface it as a deployment fault (503), never as bad credentials", () => {
    // A legitimate user must never be told their password is wrong because of a
    // schema problem, and the 503 is indistinguishable from the other closed gates.
    for (const [name, src] of Object.entries({ PUBLIC_ROUTES, PORTAL_ROUTES })) {
      expect(src, `${name} must map mfa_state_unavailable to 503`).toContain(
        'if (result.reason === "mfa_state_unavailable")'
      );
      expect(src, `${name} must not leak the reason`).toContain(
        'res.status(503).json({ error: "partner login unavailable" })'
      );
    }
  });

  it("the projection the guard depends on is exactly what 0046 installs", () => {
    // If this drifts, the guard would refuse every login on a correctly-migrated
    // database — so the two must be pinned together.
    expect(MIGRATION_0046).toContain("has_active_mfa boolean");
    expect(MIGRATION_0046).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM partner_mfa_methods/);
    expect(MIGRATION_0046).toContain("status = 'ACTIVE'");
    expect(MIGRATION_0046).toContain("secret_ref IS NOT NULL");
  });

  it("the MFA-pending decision still consults BOTH signals once the projection is trusted", () => {
    // The `|| has_active_mfa` clause is what protects an enrolled account that
    // does not carry mfa_required. Losing it would reintroduce the bypass by a
    // different route.
    expect(AUTH).toContain("const mfaPending = u.mfa_required || u.has_active_mfa;");
  });
});

describe("partner MFA restart requires elevated verification", () => {
  const MFA_SERVICE = readFileSync("server/partner/mfa-service.ts", "utf8");

  it("takes a password and verifies it BEFORE any state change", () => {
    expect(MFA_SERVICE).toMatch(/export async function mfaEnrolRestart\([\s\S]{0,220}?password: string,/);
    const fnAt = MFA_SERVICE.indexOf("export async function mfaEnrolRestart(");
    const body = MFA_SERVICE.slice(fnAt, fnAt + 2600);
    const verifyAt = body.indexOf("if (!(await verifyPassword(c, ctx.userId, password)))");
    expect(verifyAt).toBeGreaterThan(0);
    // Nothing may be written before the password is proven.
    for (const marker of ["UPDATE partner_mfa_methods", "INSERT INTO partner_mfa_methods"]) {
      const at = body.indexOf(marker);
      expect(at, `${marker} must come after verifyPassword`).toBeGreaterThan(verifyAt);
    }
  });

  it("still refuses to become a factor-REPLACEMENT path even with a valid password", () => {
    const fnAt = MFA_SERVICE.indexOf("export async function mfaEnrolRestart(");
    const body = MFA_SERVICE.slice(fnAt, fnAt + 2600);
    expect(body).toContain(
      'if (await hasActiveMethod(c, ctx.userId)) return { ok: false, reason: "requires_current_factor" };'
    );
  });

  it("preserves session-bound pending enrolment and its expiry", () => {
    const fnAt = MFA_SERVICE.indexOf("export async function mfaEnrolRestart(");
    const body = MFA_SERVICE.slice(fnAt, fnAt + 2600);
    expect(body).toContain("enrolment_session_id");
    expect(body).toContain("expires_at");
  });

  it("the route rejects a body with no password before calling the service", () => {
    const routeAt = PORTAL_ROUTES.indexOf('r.post("/mfa/restart"');
    const route = PORTAL_ROUTES.slice(routeAt, routeAt + 1400);
    expect(route).toContain('if (typeof password !== "string")');
    const guardAt = route.indexOf('if (typeof password !== "string")');
    const callAt = route.indexOf("await mfaEnrolRestart(");
    expect(callAt).toBeGreaterThan(guardAt);
  });
});
