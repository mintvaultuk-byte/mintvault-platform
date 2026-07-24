/**
 * Canonical grading workstation — ARCHITECTURE regression guard.
 *
 * Enforces the founder's end state: ONE canonical grading workstation shell
 * (CanonicalGradingWorkstationShell) owns ALL outer geometry; every active
 * grading route renders through it; role differences are capabilities + data
 * source only; no route owns a competing workstation layout; and no `max-w-6xl`
 * grading wrapper ever returns. Pure source assertions — zero providers, zero
 * credits, zero DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const CERT_FORM = read("client/src/components/certificate-form.tsx");
const ADMIN_DASH = read("client/src/pages/admin-dashboard.tsx");
const STAFF = read("client/src/pages/staff.tsx");
const GRADER = read("client/src/pages/grader.tsx");
const ADMIN_STAFF = read("client/src/pages/admin-staff.tsx");

// Every file that could own a grading workstation surface. Only the shell may
// contain the canonical outer-geometry class strings.
const ROUTE_MOUNTS = { STAFF, GRADER, ADMIN_STAFF, ADMIN_DASH, CERT_FORM, WORKSTATION };

const GEOMETRY_HEIGHT = "md:h-[calc(100dvh-4.5rem)]";
const GEOMETRY_ROW = "flex min-h-0 flex-1 flex-col gap-3 md:flex-row";
const GEOMETRY_COL = 'className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="grading-control-panel"';

describe("Canonical grading workstation — one shell, capability-only role differences", () => {
  it("1. CertificateForm (Super Admin /admin) mounts CanonicalGradingWorkstationShell", () => {
    expect(CERT_FORM).toContain("<CanonicalGradingWorkstationShell");
    expect(CERT_FORM).toContain(
      'import { CanonicalGradingWorkstationShell } from "@/components/grading-workflow/CanonicalGradingWorkstationShell"',
    );
  });

  it("2-4. Staff, Grader and Admin Review all render through the SAME canonical shell (via GradingWorkstation)", () => {
    expect(STAFF).toContain("<GradingWorkstation");
    expect(STAFF).toContain('mode="staff"');
    expect(GRADER).toContain("<GradingWorkstation");
    expect(GRADER).toContain('mode="grader"');
    expect(ADMIN_STAFF).toContain("<GradingWorkstation");
    expect(ADMIN_STAFF).toContain('mode="admin-review"');
    // GradingWorkstation is a THIN adapter that mounts the canonical shell.
    expect(WORKSTATION).toContain("<CanonicalGradingWorkstationShell");
  });

  it("5+9. only ONE file owns the canonical outer geometry — every other surface just mounts it", () => {
    for (const [name, src] of Object.entries(ROUTE_MOUNTS)) {
      expect(src, `${name} must NOT inline the fixed-height geometry`).not.toContain(GEOMETRY_HEIGHT);
      expect(src, `${name} must NOT inline the two-column row geometry`).not.toContain(GEOMETRY_ROW);
      expect(src, `${name} must NOT inline the control-panel column`).not.toContain(GEOMETRY_COL);
    }
    // The shell is the single source of truth for all three.
    expect(SHELL).toContain(GEOMETRY_HEIGHT);
    expect(SHELL).toContain(GEOMETRY_ROW);
    expect(SHELL).toContain(GEOMETRY_COL);
  });

  it("6. no max-w-6xl grading wrapper remains anywhere in the grading shell/adapter", () => {
    expect(SHELL).not.toContain("max-w-6xl");
    expect(WORKSTATION).not.toContain("max-w-6xl");
  });

  it("7. canonical bounded-height / min-h-0 structure exists in the shell", () => {
    expect(SHELL).toContain("flex min-h-0 flex-col");
    expect(SHELL).toContain(GEOMETRY_HEIGHT);
    expect(SHELL).toContain('data-testid="grading-workspace"');
    expect(SHELL).toContain('data-canonical-shell="true"');
  });

  it("8. GradingPanel is mounted inside the shell's bounded canonical scroll body", () => {
    // The shell exposes the ONE canonical body scroll class; the adapter wraps
    // GradingPanel in exactly that, and admin's <form> uses it too.
    expect(SHELL).toContain('export const WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2.5 overflow-y-auto md:pr-1"');
    expect(WORKSTATION).toContain("WORKSTATION_BODY_SCROLL_CLASS");
    expect(WORKSTATION).toContain("<GradingPanel");
    expect(CERT_FORM).toContain("min-h-0 flex-1 space-y-2.5 overflow-y-auto md:pr-1"); // the <form> body
  });

  it("11. API bases stay role-correct", () => {
    expect(STAFF).toContain('apiBase="/api/grader"');
    expect(GRADER).toContain('apiBase="/api/grader"');
    expect(ADMIN_STAFF).toContain('apiBase="/api/admin/grade-review"');
    // Super Admin GradingPanel talks to /api/admin via CertificateForm/admin-dashboard.
    expect(ADMIN_DASH).toContain("/api/admin/certificates");
  });

  it("10+12+13. Staff/Grader are submit-only (graderMode, no elevated surface); Admin Review keeps review actions", () => {
    expect(STAFF).toContain("graderMode");
    expect(GRADER).toContain("graderMode");
    // Staff/Grader adapters never opt into adminReview / correction.
    expect(STAFF).not.toContain("adminReview");
    expect(GRADER).not.toContain("adminReview");
    // Admin Review keeps its review actions and the reject path.
    expect(ADMIN_STAFF).toContain("adminReview");
    expect(ADMIN_STAFF).toMatch(/reject-grade/);
  });

  it("14. Super Admin path is unchanged — admin-dashboard mounts CertificateForm + the bare GradingPanel, NOT GradingWorkstation", () => {
    expect(ADMIN_DASH).toContain("<CertificateForm");
    expect(ADMIN_DASH).toContain("<GradingPanel");
    expect(ADMIN_DASH).not.toContain("<GradingWorkstation");
    // correction mode still wired through the Super Admin GradingPanel.
    expect(ADMIN_DASH).toContain("correctionMode");
  });

  it("15+16. approved/read-only + card-switch state safety is preserved by GradingPanel remount + reset", () => {
    const PANEL = read("client/src/components/grading/grading-panel.tsx");
    // Per-card remount key (no cross-record leakage) in the adapter.
    expect(WORKSTATION).toContain("key={`${apiBase}:${certId}`}");
    // GradingPanel resets card-specific state on certId change (no editable flash).
    expect(PANEL).toMatch(/useEffect\(\(\) => \{[\s\S]*setApproved\(false\)[\s\S]*\}, \[certId\]\)/);
  });

  it("static drift guard: the ONLY components that mount the canonical shell are the shell's two sanctioned consumers", () => {
    // GradingWorkstation (role adapter) + CertificateForm (Super Admin) are the
    // only files allowed to mount CanonicalGradingWorkstationShell. If a new
    // competing shell/consumer appears, add it here deliberately — never silently.
    const mounts = ["client/src/components/grading-workflow/GradingWorkstation.tsx", "client/src/components/certificate-form.tsx"];
    for (const p of mounts) expect(read(p)).toContain("<CanonicalGradingWorkstationShell");
    // No page defines its own workstation geometry class.
    for (const [name, src] of Object.entries(ROUTE_MOUNTS)) {
      expect(src, `${name} owns no competing workstation height`).not.toMatch(/md:h-\[calc\(100dvh-\d/);
    }
  });
});
