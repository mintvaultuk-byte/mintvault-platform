/**
 * Post-MFA session race — the LOGIN → MFA → LOGIN loop.
 *
 * The server side of this transition is proven over real HTTP against real PostgreSQL by
 * tests/partner-mfa-enrolment-mandatory.test.ts ("grants normal access only after enrolment, and
 * reports honest MFA state"). What that suite cannot see is the client half: the Portal renders no
 * page of its own accord, so an authenticated server session is worth nothing if the route guard
 * evaluates a STALE pre-MFA value in the moment between MFA succeeding and the dashboard mounting.
 *
 * That is exactly what happened on staging: POST /auth/mfa 200, GET /session 200, and then the
 * browser issued no further request at all — the signature of a client-side redirect back to
 * /partner/login, which fetches nothing.
 *
 * There is no React render harness in this repository (@testing-library/react is not a dependency),
 * so these are source invariants, in the same style as
 * tests/partner-mfa-pending-reconciliation.test.ts. They pin the ORDERING that makes the race
 * impossible; they are not a substitute for the server proof above.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const SESSION_HOOK = read("client/src/hooks/use-partner-session.tsx");
const GUARD = read("client/src/components/partner/partner-route-guard.tsx");
const LOGIN = read("client/src/pages/partner/login.tsx");

describe("post-MFA session state reaches the route guard before navigation", () => {
  it("refresh() WRITES the canonical session through, rather than only invalidating", () => {
    // invalidateQueries marks the query stale and starts a refetch. It does not guarantee the new
    // value is observable to a component that mounts immediately afterwards. setQueryData does.
    expect(SESSION_HOOK).toContain("qc.setQueryData<SessionResult>");
    expect(SESSION_HOOK).toContain("await fetchSessionResult()");
    const refresh = SESSION_HOOK.slice(
      SESSION_HOOK.indexOf("const refresh = useCallback"),
      SESSION_HOOK.indexOf("const hasPermission")
    );
    expect(refresh).not.toContain("invalidateQueries");
  });

  it("uses ONE canonical fetch→SessionResult mapping for both the query and refresh()", () => {
    // Two copies of the 401-vs-503 mapping would drift, and a drifted refresh() could classify an
    // authenticated response as signed-out — the loop again, by a different route.
    expect(SESSION_HOOK).toContain("async function fetchSessionResult(): Promise<SessionResult>");
    expect(SESSION_HOOK).toContain("queryFn: fetchSessionResult,");
    expect(SESSION_HOOK.match(/return \{ kind: "unavailable" \}/g)?.length).toBe(1);
  });

  it("keeps 503/502/status-0 distinct from signed-out, so an outage never reads as a login problem", () => {
    expect(SESSION_HOOK).toContain("err.status === 0 || err.status >= 502");
    expect(SESSION_HOOK).toContain('return { kind: "signed-out" }');
  });

  it("awaits the refresh before navigating away from the MFA step", () => {
    const handleMfa = LOGIN.slice(LOGIN.indexOf("async function handleMfa"), LOGIN.indexOf("/** Enrolment finished"));
    expect(handleMfa).toContain("await partnerAuth.mfa(");
    expect(handleMfa).toContain("await refresh();");
    // Ordering is the whole invariant: refresh must be awaited BEFORE navigate, never after.
    expect(handleMfa.indexOf("await refresh();")).toBeLessThan(handleMfa.indexOf('navigate("/partner/dashboard")'));
    expect(handleMfa.indexOf("await partnerAuth.mfa(")).toBeLessThan(handleMfa.indexOf("await refresh();"));
  });

  it("awaits the refresh before navigating away from enrolment completion", () => {
    const done = LOGIN.slice(LOGIN.indexOf("/** Enrolment finished"));
    expect(done.indexOf("await refresh();")).toBeLessThan(done.indexOf('navigate("/partner/dashboard")'));
  });

  it("redirects to sign-in ONLY for a genuinely signed-out visitor, never on 503 or mid-session 401", () => {
    // A mid-session 401 gets the explicit "your session has ended" screen; a 503 gets the
    // unavailable screen. Redirecting on either is what turns one bad response into a loop.
    expect(GUARD).toContain("if (ready && !isLoading && !unavailable && !expired && (!session || !session.mfaPassed))");
    expect(GUARD).toContain('navigate("/partner/login")');
    expect(GUARD).toContain("if (expired) {");
    expect(GUARD).toContain("<PartnerSessionExpiredState />");
    expect(GUARD).toContain("if (unavailable) {");
  });

  it("does not weaken MFA: the guard still demands mfaPassed to render any protected page", () => {
    expect(GUARD).toContain("if (!session || !session.mfaPassed)");
    expect(GUARD).not.toMatch(/mfaPassed\s*\|\|\s*true/);
    // The guard must never treat "we have a session object" as sufficient.
    expect(GUARD).not.toMatch(/if\s*\(\s*!session\s*\)\s*\{\s*return null/);
  });
});
