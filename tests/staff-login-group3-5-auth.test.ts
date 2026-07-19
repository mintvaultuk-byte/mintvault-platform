/**
 * Group 3.5 (2026-07-19) — canonical Staff/Grader login surface (/staff/login):
 * AUTH-FLOW proof.
 *
 * The Group-3.5 pass is a VISUAL-ONLY unification of client/src/pages/staff-login.tsx
 * onto the shared var(--admin-*) design system. This guard proves the pass changed
 * NOTHING about the authentication flow, and that /staff/login is the ONE canonical
 * operator login that both Staff and Grader reach:
 *
 *   • same endpoint + method + payload (POST /api/staff/login, {email,password});
 *   • same success redirect (→ /staff); role/capability routing stays server-side;
 *   • safe generic errors (invalid vs 429), no technical/stack leakage;
 *   • correct password semantics + autocomplete; in-flight submit guard (busy);
 *   • /grader/login still redirects to /staff/login and cannot loop;
 *   • the server route (server/routes/staff.ts) is UNCHANGED: rate-limited,
 *     authenticateStaff, explicit isAdmin=false (no Super Admin privilege bleed),
 *     capabilities loaded into the session — proving no privilege expansion.
 *
 * The project has no jsdom/RTL harness (see tests/partner-submission-wizard-ui.test.ts),
 * so — like every other UI guard here — these assertions read the CURRENT committed
 * source. The real route is additionally rendered end-to-end with mocked auth
 * responses during the Group-3.5 visual-verification pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const STAFF_LOGIN = read("client/src/pages/staff-login.tsx");
const GRADER_LOGIN = read("client/src/pages/grader-login.tsx");
const SERVER_STAFF = read("server/routes/staff.ts");

describe("Group 3.5 — /staff/login endpoint + payload + method unchanged", () => {
  it("POSTs {email,password} as JSON to /api/staff/login with credentials", () => {
    expect(STAFF_LOGIN).toContain('fetch("/api/staff/login"');
    expect(STAFF_LOGIN).toContain('method: "POST"');
    expect(STAFF_LOGIN).toContain('credentials: "include"');
    expect(STAFF_LOGIN).toContain('headers: { "Content-Type": "application/json" }');
    expect(STAFF_LOGIN).toContain("JSON.stringify({ email, password })");
  });
  it("redirects to /staff on success (role/capability routing resolved server-side)", () => {
    expect(STAFF_LOGIN).toContain('navigate("/staff", { replace: true })');
  });
});

describe("Group 3.5 — safe error + submit-guard + field semantics unchanged", () => {
  it("shows generic, non-technical errors (429 rate-limit vs invalid) with role=alert", () => {
    expect(STAFF_LOGIN).toContain("res.status === 429");
    expect(STAFF_LOGIN).toContain("Too many attempts");
    expect(STAFF_LOGIN).toContain("Invalid email or password.");
    expect(STAFF_LOGIN).toContain('role="alert"');
    // no raw status/stack/JSON leaked into the UI
    expect(STAFF_LOGIN).not.toMatch(/\{JSON\.stringify\(err/);
  });
  it("guards against repeated submit while in flight (busy → disabled)", () => {
    expect(STAFF_LOGIN).toContain("setBusy(true)");
    expect(STAFF_LOGIN).toContain("disabled={busy}");
    expect(STAFF_LOGIN).toMatch(/busy \? "Signing in/);
  });
  it("password field is masked with correct autocomplete; email uses username autocomplete", () => {
    expect(STAFF_LOGIN).toContain('type="password"');
    expect(STAFF_LOGIN).toContain('autoComplete="current-password"');
    expect(STAFF_LOGIN).toContain('autoComplete="username"');
    // real <form> + submit button → Enter-to-submit keyboard flow preserved
    expect(STAFF_LOGIN).toMatch(/<form\b[^>]*onSubmit=\{onSubmit\}/);
    expect(STAFF_LOGIN).toContain('type="submit"');
  });
});

describe("Group 3.5 — one canonical operator login (Staff + Grader), no privilege expansion", () => {
  it("/grader/login still redirects to /staff/login and cannot loop (targets a different path, replace)", () => {
    expect(GRADER_LOGIN).toContain('navigate("/staff/login", { replace: true })');
    // the login page itself does NOT redirect back to /grader/login (no loop)
    expect(STAFF_LOGIN).not.toContain('navigate("/grader/login"');
  });
  it("the shared login makes no Super Admin claim and mounts no authenticated shell", () => {
    expect(STAFF_LOGIN).not.toMatch(/super\s*admin/i);
    expect(STAFF_LOGIN).not.toMatch(/<AdminShell\b/);
    expect(STAFF_LOGIN).not.toMatch(/<AdminHeaderRow\b/);
  });
});

describe("Group 3.5 — server login route is UNCHANGED (proof only; not edited by this pass)", () => {
  it("/api/staff/login is rate-limited and authenticates via authenticateStaff", () => {
    expect(SERVER_STAFF).toContain('app.post("/api/staff/login", staffLoginLimit');
    expect(SERVER_STAFF).toContain("authenticateStaff(email, password)");
    expect(SERVER_STAFF).toMatch(/const staffLoginLimit = rateLimit\(/);
  });
  it("loads capabilities into the session and explicitly clears admin (no Super Admin bleed)", () => {
    expect(SERVER_STAFF).toContain("s.capGrade = r.caps.grade");
    expect(SERVER_STAFF).toContain("s.capScan = r.caps.scan");
    expect(SERVER_STAFF).toContain("s.capPrint = r.caps.print");
    expect(SERVER_STAFF).toContain("s.isGrader = r.caps.grade");
    expect(SERVER_STAFF).toContain("s.isAdmin = false");
  });
  it("fails closed with a generic 401 on bad credentials (no user enumeration)", () => {
    expect(SERVER_STAFF).toContain('res.status(401).json({ error: "invalid_credentials" })');
  });
});
