/**
 * Group 3 (2026-07-19) — Grader entry-surface unification: AUTH / SESSION /
 * PERMISSION proof.
 *
 * The Group-3 pass is a VISUAL-ONLY unification of the two grader entry surfaces
 * (client/src/pages/grader.tsx dashboard + grader-login.tsx redirect) onto the
 * shared AdminHeaderRow + var(--admin-*) token system. This guard proves the
 * pass changed NOTHING about the security-relevant behaviour:
 *
 *   • the grader login endpoint + payload are unchanged (still the /staff/login
 *     redirect — grader has no bespoke credential form of its own);
 *   • the client session gate is unchanged (/api/grader/session → redirect to
 *     /grader/login when unauthenticated);
 *   • the server session gate is unchanged (isGrader && graderId && !isAdmin,
 *     absolute-expiry + credential-version revalidation);
 *   • grader data endpoints stay behind requireCapability("grade") which
 *     fail-closed with 401 (not staff) / 403 (missing cap);
 *   • the grader UI exposes NO Super Admin shell, NO Partner Network controls,
 *     and NO Certificate-Tools drawer — grader ≠ staff-superset;
 *   • logout is unchanged (POST /api/grader/logout).
 *
 * All assertions read the CURRENT source (client + server) so a future change
 * that weakens any of these boundaries fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const GRADER = read("client/src/pages/grader.tsx");
const GRADER_LOGIN = read("client/src/pages/grader-login.tsx");
const SERVER_GRADER = read("server/routes/grader.ts");
const STAFF_MW = read("server/staff.ts");

describe("Group 3 — grader login endpoint + payload unchanged (redirect into unified /staff/login)", () => {
  it("the client grader-login page is a pure redirect to /staff/login", () => {
    expect(GRADER_LOGIN).toContain('navigate("/staff/login"');
    // it does NOT introduce its own credential capture
    expect(GRADER_LOGIN).not.toMatch(/type="password"/);
    expect(GRADER_LOGIN).not.toMatch(/<form\b/);
    expect(GRADER_LOGIN).not.toMatch(/fetch\(/);
  });
  it("the server /api/grader/login alias still delegates to authenticateStaff with {email,password}", () => {
    // legacy working alias — unchanged by the visual pass
    expect(SERVER_GRADER).toContain('app.post("/api/grader/login"');
    expect(SERVER_GRADER).toContain("const { email, password } = req.body");
    expect(SERVER_GRADER).toContain("authenticateStaff(email, password)");
    // still rate-limited
    expect(SERVER_GRADER).toContain("graderLoginLimit");
  });
});

describe("Group 3 — client session gate unchanged", () => {
  it("grader dashboard checks /api/grader/session with credentials and redirects to /grader/login when unauthenticated", () => {
    expect(GRADER).toContain('fetch("/api/grader/session", { credentials: "include" })');
    expect(GRADER).toMatch(/authed === false\)\s*navigate\("\/grader\/login", \{ replace: true \}\)/);
  });
  it("logout posts /api/grader/logout and returns to /grader/login (unchanged)", () => {
    expect(GRADER).toContain('fetch("/api/grader/logout", { method: "POST", credentials: "include" })');
    expect(GRADER).toMatch(/navigate\("\/grader\/login", \{ replace: true \}\)/);
  });
});

describe("Group 3 — server session gate + revalidation unchanged (fail-closed)", () => {
  it("/api/grader/session requires isGrader && graderId && NOT isAdmin", () => {
    expect(SERVER_GRADER).toContain("s.isGrader && s.graderId && !s.isAdmin");
  });
  it("/api/grader/session enforces absolute-session expiry + live credential-version revalidation", () => {
    expect(SERVER_GRADER).toContain("isAbsoluteSessionExpired(req, STAFF_ABSOLUTE_SESSION_MS)");
    expect(SERVER_GRADER).toContain("credentialVersionOf(row)");
  });
});

describe("Group 3 — grader data endpoints stay capability-gated (grade) and fail-closed", () => {
  it("queue + earnings are guarded by requireCapability('grade')", () => {
    expect(SERVER_GRADER).toMatch(/app\.get\("\/api\/grader\/queue", requireCapability\("grade"\)/);
    expect(SERVER_GRADER).toMatch(/app\.get\("\/api\/grader\/earnings", requireCapability\("grade"\)/);
  });
  it("requireCapability rejects non-staff with 401 and missing-capability with 403, and fails closed on error", () => {
    expect(STAFF_MW).toContain("if (!(s && s.isStaff && s.staffId && !s.isAdmin)) return res.status(401)");
    expect(STAFF_MW).toMatch(/missing '\$\{cap\}' capability/);
    expect(STAFF_MW).toContain("res.status(403)");
    expect(STAFF_MW).toContain('res.status(500).json({ error: "Internal server error" }); // fail-closed');
  });
});

describe("Group 3 — grader UI exposes no elevated surface (grader ≠ staff-superset, no admin/partner)", () => {
  it("grader dashboard does NOT mount the full AdminShell (no admin sidebar / Super Admin nav)", () => {
    expect(GRADER).not.toMatch(/<AdminShell\b/);
    expect(GRADER).not.toContain('from "@/components/admin/admin-shell"');
  });
  it("grader dashboard exposes NO Partner Network controls", () => {
    expect(GRADER).not.toMatch(/partner/i);
  });
  it("grader dashboard exposes NO Certificate-Tools drawer", () => {
    expect(GRADER).not.toMatch(/CertificateToolsDrawer/);
  });
  it("grader dashboard is grade-only — it does not expose scan/print staff tabs", () => {
    expect(GRADER).not.toContain("/api/staff/scan");
    expect(GRADER).not.toContain("/api/staff/print");
  });
});

describe("Group 3 — the real MVGS panel is reused grader-scoped (protected engine untouched)", () => {
  it("grader mounts the canonical grading workstation with apiBase='/api/grader' + graderMode (never publishes)", () => {
    expect(GRADER).toContain("<GradingWorkstation");
    expect(GRADER).toContain('mode="grader"');
    expect(GRADER).toContain('apiBase="/api/grader"');
    expect(GRADER).toContain("graderMode");
    // it does NOT mount an admin-review / publishing surface
    expect(GRADER).not.toContain("adminReview");
    expect(GRADER).not.toContain('apiBase="/api/admin');
  });
});
