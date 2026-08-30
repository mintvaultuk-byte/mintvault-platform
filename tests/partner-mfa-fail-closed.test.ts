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
 * journal does NOT contain the MFA pending-lifecycle migration under the number
 * the canonical lineage used — production's 0046 slot holds a different scanner
 * migration entirely.
 *
 * SIBLING MERGE (2026-08-11): that lineage split is now RESOLVED in the tree. The
 * canonical lineage shipped this migration as 0046 and the scanner lineage shipped
 * the byte-identical file as 0044. Keeping both put TWO files on number 0046 (the
 * other being 0046_scanner_processing_jobs), which the runner rejects at file
 * collection, before it opens a database at all. Production's 0044 identity was
 * kept because production is this release's target, so this test reads the 0044
 * filename. The migration CONTENT asserted below is unchanged — the two files
 * were byte-identical (sha256 6243d1d8…).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const AUTH = readFileSync("server/partner/auth.ts", "utf8");
const PUBLIC_ROUTES = readFileSync("server/partner/public-routes.ts", "utf8");
const PORTAL_ROUTES = readFileSync("server/partner/routes.ts", "utf8");
const MIGRATION_MFA_PENDING = readFileSync("migrations/0044_partner_mfa_pending_lifecycle.sql", "utf8");

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

  it("the one canonical public login route returns 503 and the authenticated router cannot shadow it", () => {
    // A legitimate user must never be told their password is wrong because of a
    // schema problem. Login now has one authority; the authenticated portal
    // router deliberately carries no duplicate route whose ordering could drift.
    expect(PUBLIC_ROUTES).toContain('if (result.reason === "mfa_state_unavailable")');
    expect(PUBLIC_ROUTES).toContain('res.status(503).json({ error: "partner login unavailable" })');
    expect(PORTAL_ROUTES).not.toContain('"/auth/login"');
  });

  it("the projection the guard depends on is exactly what 0046 installs", () => {
    // If this drifts, the guard would refuse every login on a correctly-migrated
    // database — so the two must be pinned together.
    expect(MIGRATION_MFA_PENDING).toContain("has_active_mfa boolean");
    expect(MIGRATION_MFA_PENDING).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM partner_mfa_methods/);
    expect(MIGRATION_MFA_PENDING).toContain("status = 'ACTIVE'");
    expect(MIGRATION_MFA_PENDING).toContain("secret_ref IS NOT NULL");
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
    /*
     * `password: string` may be the LAST parameter, in which case Prettier removes the trailing
     * comma — so requiring one asserted a formatting accident rather than the signature. The
     * substantive checks below (verifyPassword runs, and runs BEFORE any write) are unchanged and
     * are what actually guard this path; this line only confirms the parameter is still taken.
     */
    expect(MFA_SERVICE).toMatch(/export async function mfaEnrolRestart\([\s\S]{0,220}?password: string\s*[,)]/);
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
    const route = PORTAL_ROUTES.slice(routeAt, routeAt + 1800);
    // SIBLING MERGE (2026-08-11): this asserted the guard's exact source text,
    // `if (typeof password !== "string")`. The merged route keeps that check and
    // ADDS the v1069 lineage's empty-string rejection, so the literal no longer
    // matches even though the guard is strictly stronger. Pinning syntax would
    // mean this test blocks its own hardening, so it now pins the two properties
    // that actually matter — the type check exists, and it runs BEFORE the
    // service call — plus the empty-string rejection as a floor that cannot be
    // silently dropped later.
    const guardAt = route.indexOf('typeof password !== "string"');
    expect(guardAt, "the restart route must type-check the password").toBeGreaterThan(-1);
    expect(route, "an empty password must be refused at the route, not handed to bcrypt").toContain(
      "password.length === 0"
    );
    const callAt = route.indexOf("await mfaEnrolRestart(");
    expect(callAt).toBeGreaterThan(guardAt);
  });
});
