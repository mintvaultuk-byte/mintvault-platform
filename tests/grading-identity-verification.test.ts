import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import {
  GradingIdentityVerification,
  type GradingIdentityVerificationProps,
} from "@/components/grading/GradingIdentityVerification";

const noop = () => {};

function baseProps(over: Partial<GradingIdentityVerificationProps> = {}): GradingIdentityVerificationProps {
  return {
    certId: 9001,
    certIdStr: "MV351",
    mode: "edit",
    locked: false,
    game: "pokemon",
    name: "ASHLEY TEST CHARIZARD",
    set: "Base Set",
    setCode: "",
    number: "4/102",
    year: "1999",
    variant: "Holo",
    onName: noop,
    onSet: noop,
    onNumber: noop,
    onYear: noop,
    onVariant: noop,
    onAutofill: noop,
    autofilling: false,
    autofillDisabled: false,
    onSearchAgain: noop,
    searchBusy: false,
    onCardPick: noop,
    onAccept: noop,
    statusLabel: "TCGdex confirmed",
    statusTone: "confirmed",
    resetKey: 9001,
    ...over,
  };
}

function render(over: Partial<GradingIdentityVerificationProps> = {}): string {
  return renderToStaticMarkup(React.createElement(GradingIdentityVerification, baseProps(over)));
}

describe("GradingIdentityVerification — guided AI-first identity (Staff / Grader / Admin Review)", () => {
  it("default Staff/Grader view is guided (detected summary), NOT the long manual form", () => {
    const html = render({ mode: "edit" });
    expect(html).toContain('data-testid="identity-summary"');
    expect(html).toContain('data-identity-guided="true"');
    // detected values are shown as a read-only summary
    expect(html).toContain("ASHLEY TEST CHARIZARD");
    expect(html).toContain("Base Set");
    // manual editable fields are NOT rendered by default (collapsed)
    expect(html).not.toContain('data-testid="identity-card-fields"');
    expect(html).not.toContain('data-testid="input-identity-card-name"');
    expect(html).toContain('data-manual-open="false"');
  });

  it("Staff sees Accept, Search Again and Card Fields", () => {
    const html = render({ mode: "edit" });
    expect(html).toContain('data-testid="btn-identity-accept"');
    expect(html).toContain('data-testid="button-rerun-identify"'); // Search again
    expect(html).toContain('data-testid="btn-identity-card-fields"');
    expect(html).toContain("Accept identity");
    expect(html).toContain("Search again");
    expect(html).toContain("Card fields");
  });

  it("shows the identification status/source", () => {
    expect(render({ statusLabel: "TCGdex confirmed", statusTone: "confirmed" })).toContain("TCGdex confirmed");
    expect(render({ statusLabel: "AI suggested", statusTone: "suggested" })).toContain("AI suggested");
  });

  it("Admin Review shows a read-only guided summary (no Accept / edit / Card Fields)", () => {
    const html = render({ mode: "review" });
    expect(html).toContain('data-testid="identity-summary"');
    expect(html).toContain("ASHLEY TEST CHARIZARD");
    expect(html).toContain('data-editable="false"');
    expect(html).not.toContain('data-testid="btn-identity-accept"');
    expect(html).not.toContain('data-testid="button-rerun-identify"');
    expect(html).not.toContain('data-testid="btn-identity-card-fields"');
  });

  it("approved / read-only (locked) forces the read-only summary even in edit mode", () => {
    const html = render({ mode: "edit", locked: true });
    expect(html).toContain('data-testid="identity-summary"');
    expect(html).toContain('data-editable="false"');
    expect(html).not.toContain('data-testid="btn-identity-accept"');
    expect(html).not.toContain('data-testid="identity-card-fields"');
  });

  it("never renders publish/approve controls (identity component is presentation only)", () => {
    for (const mode of ["edit", "review"] as const) {
      const html = render({ mode });
      expect(html).not.toContain("Approve & Publish");
      expect(html).not.toContain("Approve staff grade");
      expect(html).not.toContain("Publish");
    }
  });
});

describe("Route mounts — shared workstation shell, role-safe, /admin unchanged", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const STAFF = read("client/src/pages/staff.tsx");
  const GRADER = read("client/src/pages/grader.tsx");
  const ADMIN_STAFF = read("client/src/pages/admin-staff.tsx");
  const ADMIN_DASH = read("client/src/pages/admin-dashboard.tsx");

  it("Staff mounts the shared GradingWorkstation in staff mode against /api/grader (never publishes)", () => {
    expect(STAFF).toContain("<GradingWorkstation");
    expect(STAFF).toContain('mode="staff"');
    expect(STAFF).toContain('apiBase="/api/grader"');
    expect(STAFF).toContain("graderMode");
  });

  it("Grader uses the same shell in grader mode against /api/grader", () => {
    expect(GRADER).toContain("<GradingWorkstation");
    expect(GRADER).toContain('mode="grader"');
    expect(GRADER).toContain('apiBase="/api/grader"');
  });

  it("Admin Review uses the same shell in admin-review mode against /api/admin/grade-review, keeps review actions", () => {
    expect(ADMIN_STAFF).toContain("<GradingWorkstation");
    expect(ADMIN_STAFF).toContain('mode="admin-review"');
    expect(ADMIN_STAFF).toContain("adminReview");
    expect(ADMIN_STAFF).toContain('apiBase="/api/admin/grade-review"');
    // Reject action remains on the review surface
    expect(ADMIN_STAFF).toMatch(/reject-grade/);
  });

  it("/admin is unchanged — mounts the bare GradingPanel via CertificateForm, no workstation wrapper", () => {
    expect(ADMIN_DASH).toContain("<GradingPanel");
    expect(ADMIN_DASH).not.toContain("GradingWorkstation");
  });

  it("no route mounts the retired CanonicalGradingPanelMount", () => {
    for (const src of [STAFF, GRADER, ADMIN_STAFF, ADMIN_DASH]) {
      expect(src).not.toContain("CanonicalGradingPanelMount");
    }
  });
});
