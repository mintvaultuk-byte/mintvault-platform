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

// HEIGHT CONTRACT: the shell FILLS its parent (h-full); it never sets a
// viewport-relative height of its own. Exactly ONE bounded viewport-height
// wrapper is sanctioned — CertificateForm's /admin wrapper. Role focused views
// (staff/grader) and the admin-review overlay establish their bounded height via
// a `fixed inset-0 flex flex-col` container. This is what removed the "black bar
// below the shell" regression (a fixed-calc shell shorter than a taller parent).
const SHELL_FILL = "flex min-h-0 flex-col h-full";
const ADMIN_HEIGHT_WRAPPER = "md:h-[calc(100dvh-4.5rem)]";
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

  it("5+9. only ONE file owns the canonical two-column geometry; the shell FILLS its parent (no fixed height)", () => {
    for (const [name, src] of Object.entries(ROUTE_MOUNTS)) {
      // No route/adapter inlines the shell's two-column row or control-panel col.
      expect(src, `${name} must NOT inline the two-column row geometry`).not.toContain(GEOMETRY_ROW);
      expect(src, `${name} must NOT inline the control-panel column`).not.toContain(GEOMETRY_COL);
    }
    // The shell is the single source of truth for the row + column, and it FILLS
    // its parent rather than setting a viewport-relative height.
    expect(SHELL).toContain(SHELL_FILL);
    expect(SHELL).toContain(GEOMETRY_ROW);
    expect(SHELL).toContain(GEOMETRY_COL);
    // The shell must NEVER own a viewport-height calc (that was the black-bar bug).
    expect(SHELL).not.toMatch(/h-\[calc\(100dvh/);
    // Exactly ONE sanctioned bounded viewport-height wrapper exists: CertForm's.
    expect(CERT_FORM).toContain(ADMIN_HEIGHT_WRAPPER);
    expect((CERT_FORM.match(/md:h-\[calc\(100dvh/g) ?? []).length).toBe(1);
  });

  it("6. no max-w-6xl grading wrapper remains anywhere in the grading shell/adapter", () => {
    expect(SHELL).not.toContain("max-w-6xl");
    expect(WORKSTATION).not.toContain("max-w-6xl");
  });

  it("7. canonical fill (h-full) / min-h-0 structure exists in the shell", () => {
    expect(SHELL).toContain(SHELL_FILL);
    expect(SHELL).toContain('data-testid="grading-workspace"');
    expect(SHELL).toContain('data-canonical-shell="true"');
    // Focused role views + the admin-review overlay provide the bounded height.
    expect(STAFF).toMatch(/fixed inset-0 z-40 flex flex-col/);
    expect(GRADER).toMatch(/fixed inset-0 z-40 flex flex-col/);
    expect(ADMIN_STAFF).toMatch(/fixed inset-0 z-50 flex flex-col/);
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
    // Exactly ONE viewport-height wrapper is sanctioned across ALL grading
    // surfaces — CertForm's /admin wrapper. No other file may introduce a
    // competing `md:h-[calc(100dvh-…)]` (that reintroduces the black-bar class).
    for (const [name, src] of Object.entries(ROUTE_MOUNTS)) {
      const count = (src.match(/md:h-\[calc\(100dvh/g) ?? []).length;
      const allowed = name === "CERT_FORM" ? 1 : 0;
      expect(count, `${name} owns ${count} viewport-height wrappers (allowed ${allowed})`).toBe(allowed);
    }
  });
});

describe("Hotfix: bottom black bar + Admin Review identity-editor placement", () => {
  it("BB1. the shell fills its parent and never sets a fixed/min viewport height (no obscuring bottom layer)", () => {
    expect(SHELL).toContain(SHELL_FILL); // flex min-h-0 flex-col h-full
    expect(SHELL).not.toMatch(/h-\[calc\(100dvh|min-h-\[100|min-h-screen/);
  });

  it("BB2. the role adapter cannot re-inflate/mask the shell — no admin-root min-height wrapper, no fixed height, no bg-black", () => {
    // The adapter's own root fills its flex slot; it does NOT wrap the shell in
    // admin-root (min-height:100vh) or a fixed viewport height or a black layer.
    expect(WORKSTATION).toContain("flex min-h-0 min-w-0 flex-1 flex-col");
    expect(WORKSTATION).not.toContain('className="admin-root"');
    expect(WORKSTATION).not.toMatch(/h-\[calc\(100dvh|min-h-screen|bg-black/);
  });

  it("BB3. each active grading view provides ONE bounded flex-column height context (focused/overlay)", () => {
    expect(STAFF).toMatch(/fixed inset-0 z-40 flex flex-col/);
    expect(GRADER).toMatch(/fixed inset-0 z-40 flex flex-col/);
    expect(ADMIN_STAFF).toMatch(/fixed inset-0 z-50 flex flex-col/);
    // admin-review overlay no longer caps the workstation with max-w-6xl.
    const overlay = ADMIN_STAFF.slice(ADMIN_STAFF.indexOf("grade-review-overlay"), ADMIN_STAFF.indexOf("</GradingWorkstation"));
    expect(overlay).not.toContain("max-w-6xl");
    expect(overlay).not.toContain("min-h-screen");
  });

  it("ID1. Admin Review passes its identity editor to the workstation identityEditor slot (rendered inside the body)", () => {
    expect(ADMIN_STAFF).toContain("identityEditor={reviewIdentityEditor}");
    // The adapter renders the slot INSIDE the scroll body (right column).
    expect(WORKSTATION).toContain("identityEditor");
    expect(WORKSTATION).toContain('data-testid="workstation-identity-editor"');
    const slotIdx = WORKSTATION.indexOf('data-testid="workstation-identity-editor"');
    const bodyIdx = WORKSTATION.indexOf("WORKSTATION_BODY_SCROLL_CLASS");
    const panelIdx = WORKSTATION.indexOf("<GradingPanel");
    expect(slotIdx).toBeGreaterThan(bodyIdx); // inside the body
    expect(slotIdx).toBeLessThan(panelIdx); // above the grading panel
  });

  it("ID2. the identity editor is NOT a detached full-width section above the workstation", () => {
    // The old inline section (border-b bg-gold, between the header and the
    // workstation) is gone from admin-staff's overlay JSX.
    const overlay = ADMIN_STAFF.slice(ADMIN_STAFF.indexOf("grade-review-overlay"));
    expect(overlay).not.toContain('bg-[var(--admin-gold)]/[0.03] px-4 py-2.5');
  });

  it("ID3. the identity save / cancel / search / re-run handlers stay connected in the moved editor", () => {
    // reviewIdentityEditor is defined in the component body and wires the same handlers.
    expect(ADMIN_STAFF).toContain("const reviewIdentityEditor");
    for (const t of [
      "button-edit-identity",
      "button-save-identity",
      "button-override-rerun",
      "input-override-card-search",
      "input-override-name",
      "input-override-set",
      "input-override-variant",
    ]) {
      expect(ADMIN_STAFF, `identity control ${t} preserved`).toContain(t);
    }
    for (const h of ["saveIdentityOverride", "rerunIdentityOverride", "applyIdoCardPick", "setIdoOpen"]) {
      expect(ADMIN_STAFF, `handler ${h} still wired`).toContain(h);
    }
  });

  it("ID4. when the identity editor is open the preview aside is forced on (card left / editor right)", () => {
    expect(WORKSTATION).toMatch(/mode === "admin-review" && !!identityEditor/);
  });
});
