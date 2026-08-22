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
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CLIENT_SOURCE_ROOT = join(process.cwd(), "client/src");

function productionClientSources(directory = CLIENT_SOURCE_ROOT): Array<{ path: string; source: string }> {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) return productionClientSources(absolute);
    if (!/\.(?:ts|tsx)$/.test(entry) || entry.startsWith("dev-")) return [];
    return [{ path: relative(process.cwd(), absolute), source: readFileSync(absolute, "utf8") }];
  });
}

const PRODUCTION_CLIENT_SOURCES = productionClientSources();
const directJsxMounts = (component: string) =>
  PRODUCTION_CLIENT_SOURCES.filter(({ source }) => new RegExp(`<${component}(?=[\\s/>])`).test(source)).map(
    ({ path }) => path
  );

const SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
const WORKSTATION = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
const CERT_FORM = read("client/src/components/certificate-form.tsx");
const ADMIN_DASH = read("client/src/pages/admin-dashboard.tsx");
const FOCUS_SURFACE = read("client/src/components/admin/admin-focus-surface.ts");
const STAFF = read("client/src/pages/staff.tsx");
const GRADER = read("client/src/pages/grader.tsx");
const ADMIN_STAFF = read("client/src/pages/admin-staff.tsx");
const PARTNER = read("client/src/pages/partner/grading.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");
const PREVIEW_PANEL = read("client/src/components/grading-workflow/CertificatePreviewPanel.tsx");
const IDENTITY = read("client/src/components/grading/GradingIdentityVerification.tsx");
const ROLE_REVIEW = read("client/src/components/grading-workflow/RoleReviewSummary.tsx");

// Every file that could own a grading workstation surface. Only the shell may
// contain the canonical outer-geometry class strings.
const ROUTE_MOUNTS = { STAFF, GRADER, ADMIN_STAFF, PARTNER, ADMIN_DASH, CERT_FORM, WORKSTATION };

// HEIGHT CONTRACT: the shell FILLS its parent (h-full); it never sets a
// viewport-relative height of its own. Exactly ONE bounded viewport-height
// wrapper is sanctioned — CertificateForm's /admin wrapper. Role focused views
// (staff/grader) and the admin-review overlay establish their bounded height via
// a `fixed inset-0 flex flex-col` container. This is what removed the "black bar
// below the shell" regression (a fixed-calc shell shorter than a taller parent).
const SHELL_FILL = "flex min-h-0 flex-col h-full";
const GEOMETRY_ROW = "flex min-h-0 flex-1 flex-col gap-2 md:flex-row";
const GEOMETRY_COL = 'className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="grading-control-panel"';

describe("Canonical grading workstation — one shell, capability-only role differences", () => {
  it("1. Super Admin grading mounts GradingWorkstation without a full-form stage injection", () => {
    expect(ADMIN_DASH).toContain("<GradingWorkstation");
    expect(ADMIN_DASH).toContain('mode="super-admin"');
    expect(ADMIN_DASH).toMatch(/editingCert\s*\?\s*\(\s*<GradingWorkstation/);
    expect(ADMIN_DASH).not.toMatch(/<GradingWorkstation[\s\S]*?editor=/);
    expect(WORKSTATION).not.toMatch(/\beditor\??\s*:/);
    expect(WORKSTATION).not.toContain("WorkstationEditorContext");
    expect(CERT_FORM).not.toContain("<CanonicalGradingWorkstationShell");
    expect(CERT_FORM).not.toContain("<GradingPanel");
    expect(CERT_FORM).not.toContain("workstationSlot");
  });

  it("2-4. Staff, Grader, Partner and Admin Review all render through the SAME canonical shell (via GradingWorkstation)", () => {
    expect(STAFF).toContain("<GradingWorkstation");
    expect(STAFF).toContain('mode="staff"');
    expect(GRADER).toContain("<GradingWorkstation");
    expect(GRADER).toContain('mode="grader"');
    expect(ADMIN_STAFF).toContain("<GradingWorkstation");
    expect(ADMIN_STAFF).toContain('mode="admin-review"');
    expect(PARTNER).toContain("<GradingWorkstation");
    expect(PARTNER).toContain('mode="partner"');
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
    // certificate-form must not own workstation GEOMETRY (the two-column row and
    // the control column) — asserted by the ROUTE_MOUNTS loop above.
    //
    // It deliberately does NOT assert the absence of a bounded height. A previous
    // revision of this test asserted `CERT_FORM` carried no `md:h-[calc(100dvh…)]`,
    // which encoded the WRONG invariant: it locked in the removal of the only
    // bound on the /admin surface and made the PR #234 regression permanent and
    // test-approved. "Who owns the geometry" and "who supplies the height bound"
    // are separate questions. The shell fills its parent; the ROUTE supplies the
    // bound. Test 7 below asserts every route, /admin included, actually does.
  });

  it("6. no max-w-6xl grading wrapper remains anywhere in the grading shell/adapter", () => {
    expect(SHELL).not.toContain("max-w-6xl");
    expect(WORKSTATION).not.toContain("max-w-6xl");
  });

  it("7. canonical fill (h-full) / min-h-0 structure exists in the shell", () => {
    expect(SHELL).toContain(SHELL_FILL);
    expect(SHELL).toContain('data-testid="grading-workspace"');
    expect(SHELL).toContain('data-canonical-shell="true"');
    // Every route, including /admin, provides a bounded flex-height parent.
    //
    // /admin is the ONLY surface that is not a `fixed inset-0` overlay, so it must
    // supply the bound explicitly. The previous assertion here was `toContain(
    // 'className="min-h-0 flex-1"')`, which proved nothing: `flex-1` is a flex-ITEM
    // property on a BLOCK box, so the workstation's own `flex-1` stayed inert, the
    // shell's `h-full` resolved against an auto-height ancestor, and the internal
    // `overflow-y-auto` never engaged. Both halves are now required — the box must
    // be a flex COLUMN (so the child can claim height) and must carry a real
    // desktop viewport bound (so there is a height to claim).
    expect(ADMIN_DASH, "/admin workstation wrapper must be a flex column").toMatch(
      // The desktop bound is REAL, not guessed. `md:h-[calc(100dvh-4.5rem)]` was
      // right that a bound is needed and wrong about the number: 4.5rem assumed
      // 72px of chrome above, the browser measures 43px, and the difference was
      // unreachable dead space (the owner's black band). The subtraction is now
      // deleted rather than re-tuned — the surface owns the definite desktop
      // height, the header is shrink-0, the workstation is md:flex-1 md:min-h-0,
      // and the BROWSER subtracts the header's real height.
      //
      // `flex-1` is safe here ONLY because the parent is definite now. Against
      // the old AUTO-height parent it genuinely did inflate the workspace to
      // 2568px with the Live Certificate Preview at y=2552 (the PR #234
      // regression), which is why the surface height and the workstation flex
      // are asserted as a PAIR and must never be separated.
      /className=\{ADMIN_FOCUS_WORKSTATION_CLASS\}/
    );
    expect(FOCUS_SURFACE).toContain(
      'ADMIN_FOCUS_SURFACE_CLASS = "flex min-h-[100dvh] flex-col p-2.5 md:h-[100dvh] md:min-h-0"'
    );
    expect(FOCUS_SURFACE).toContain(
      'ADMIN_FOCUS_WORKSTATION_CLASS = "flex min-h-0 flex-col md:min-h-0 md:flex-1"'
    );
    expect(STAFF).toMatch(/fixed inset-0 z-40 flex flex-col/);
    expect(GRADER).toMatch(/fixed inset-0 z-40 flex flex-col/);
    expect(ADMIN_STAFF).toMatch(/fixed inset-0 z-50 flex flex-col/);
    expect(PARTNER).toMatch(/fixed inset-0 z-50 flex flex-col/);
  });

  it("8. GradingPanel is mounted inside the shell's bounded canonical scroll body", () => {
    // The shell exposes the ONE canonical body scroll class; the adapter wraps
    // the one GradingPanel in exactly that.
    expect(SHELL).toContain(
      'export const WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1"'
    );
    expect(WORKSTATION).toContain("WORKSTATION_BODY_SCROLL_CLASS");
    expect(WORKSTATION).toContain("<GradingPanel");
    expect(CERT_FORM).toContain('className="space-y-2.5"');
    expect(CERT_FORM).not.toContain("WORKSTATION_BODY_SCROLL_CLASS");
  });

  it("11. API bases stay role-correct", () => {
    expect(STAFF).toContain('apiBase="/api/grader"');
    expect(GRADER).toContain('apiBase="/api/grader"');
    expect(ADMIN_STAFF).toContain('apiBase="/api/admin/grade-review"');
    expect(PARTNER).toContain('apiBase="/api/partner/grading"');
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

  it("14. Super Admin keeps create + bounded metadata/correction capabilities outside grading stages", () => {
    expect(ADMIN_DASH).toContain("<CertificateForm");
    expect(ADMIN_DASH).not.toContain("<GradingPanel");
    expect(ADMIN_DASH).toContain("<GradingWorkstation");
    expect(ADMIN_DASH).toContain('data-testid="certificate-create-surface"');
    expect(ADMIN_DASH).toContain('data-testid="certificate-metadata-surface"');
    expect(CERT_FORM).toContain('data-metadata-section="card-details"');
    expect(CERT_FORM).not.toContain("data-workflow-stage");
    expect(CERT_FORM).not.toContain("Continue to Review");
    expect(CERT_FORM).not.toContain("button-review-card");
    expect(CERT_FORM).not.toContain("legacy-review");
    expect(ADMIN_DASH).toContain("correctionMode");
    expect(ADMIN_DASH).toContain("onCorrectionMetadataReady");
    expect(ADMIN_DASH).toContain("onCorrectionGradingReady");
  });

  it("15+16. approved/read-only + card-switch state safety is preserved by GradingPanel remount + reset", () => {
    const PANEL = read("client/src/components/grading/grading-panel.tsx");
    // Per-card remount key (no cross-record leakage) in the adapter.
    expect(WORKSTATION).toContain("key={`${apiBase}:${certId}`}");
    // GradingPanel resets card-specific state on certId change (no editable flash).
    expect(PANEL).toMatch(/useEffect\(\(\) => \{[\s\S]*setApproved\(false\)[\s\S]*\}, \[certId\]\)/);
  });

  it("static drift guard: only GradingWorkstation mounts the shell and panel", () => {
    expect(WORKSTATION).toContain("<CanonicalGradingWorkstationShell");
    expect(WORKSTATION).toContain("<GradingPanel");
    for (const [name, src] of Object.entries(ROUTE_MOUNTS)) {
      if (name === "WORKSTATION") continue;
      expect(src, `${name} shell bypass`).not.toContain("<CanonicalGradingWorkstationShell");
      expect(src, `${name} bare-panel bypass`).not.toContain("<GradingPanel");
    }
  });

  it("repository-wide production guard: one shell, panel, preview implementation and stage owner", () => {
    expect(directJsxMounts("CanonicalGradingWorkstationShell")).toEqual([
      "client/src/components/grading-workflow/GradingWorkstation.tsx",
    ]);
    expect(directJsxMounts("GradingPanel")).toEqual(["client/src/components/grading-workflow/GradingWorkstation.tsx"]);
    expect(directJsxMounts("CertificatePreviewPanel")).toEqual([
      "client/src/components/grading-workflow/GradingWorkstation.tsx",
    ]);
    expect(directJsxMounts("CardPreviewPanel")).toEqual([
      "client/src/components/grading-workflow/WorkstationPreviewAside.tsx",
    ]);
    expect(directJsxMounts("RoleReviewSummary")).toEqual(["client/src/components/grading/grading-panel.tsx"]);
    expect(directJsxMounts("ReviewSummary")).toEqual([]);
    expect(
      PRODUCTION_CLIENT_SOURCES.filter(({ source }) =>
        /(?:export\s+)?(?:function|const)\s+CertificatePreviewPanel\b/.test(source)
      ).map(({ path }) => path)
    ).toEqual(["client/src/components/grading-workflow/CertificatePreviewPanel.tsx"]);
    expect(
      PRODUCTION_CLIENT_SOURCES.filter(({ source }) =>
        /const\s+\[\s*(?:stage|wfStage)\s*,\s*set\w+\s*\]\s*=\s*useState/.test(source)
      ).map(({ path }) => path)
    ).toEqual(["client/src/components/grading-workflow/GradingWorkstation.tsx"]);
    expect(
      PRODUCTION_CLIENT_SOURCES.filter(({ source }) => /useState\(createCardInspectionState\)/.test(source)).map(
        ({ path }) => path
      )
    ).toEqual(["client/src/components/grading-workflow/GradingWorkstation.tsx"]);
  });

  it("static stage-injection guard: no route can inject a full form or own the canonical stage controller", () => {
    expect(WORKSTATION).not.toMatch(/editor\s*\??:/);
    expect(WORKSTATION).not.toMatch(/\{editor\??\.\(/);
    expect(ADMIN_DASH).not.toMatch(/editor=\{/);
    expect(ADMIN_DASH).not.toMatch(/workflowStage=|onStageRequest=|onPresentationChange=/);
    expect(CERT_FORM).not.toContain("CanonicalGradingWorkstationShell");
    expect(CERT_FORM).not.toContain("grading-workstation-slot");
    expect(ADMIN_DASH).toMatch(
      /editingCert\s*\?\s*\(\s*<GradingWorkstation[\s\S]*?:\s*\([\s\S]*?certificate-create-surface/
    );
  });

  it("keeps scanner/station controls inside the canonical Card Details body", () => {
    expect(WORKSTATION).toContain("scannerControls?: ReactNode");
    expect(WORKSTATION).toContain('data-canonical-section="scanner-controls"');
    expect(WORKSTATION).toContain('data-testid="workstation-scanner-controls"');
    expect(PARTNER).toMatch(/<GradingWorkstation[\s\S]*?scannerControls=\{<PartnerCaptureControls/);
    expect(ADMIN_DASH).toMatch(/<GradingWorkstation[\s\S]*?scannerControls=\{/);
    expect(ADMIN_DASH).toContain("<CaptureWizard");
    expect(CERT_FORM).not.toContain("CaptureWizard");
    expect(CERT_FORM).not.toContain("scannerCaptureRequired");
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
    const overlay = ADMIN_STAFF.slice(
      ADMIN_STAFF.indexOf("grade-review-overlay"),
      ADMIN_STAFF.indexOf("</GradingWorkstation")
    );
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
    expect(overlay).not.toContain("bg-[var(--admin-gold)]/[0.03] px-4 py-2.5");
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

  it("ID4. the preview aside is persistent, including Admin Review identity editing", () => {
    expect(WORKSTATION).toMatch(/previewAside=\{[\s\S]*resolvedPreviewCertificateId/);
    expect(WORKSTATION).toContain("identityEditor");
  });
});

describe("Canonical persistent preview rail", () => {
  it("keeps one card + live label rail mounted through Card Details, Grade and Review", () => {
    expect(WORKSTATION).toContain("<WorkstationPreviewAside");
    expect(WORKSTATION).toContain("<CertificatePreviewPanel");
    expect(WORKSTATION).toContain("interactiveCardHostRef={gradingEnabled ? interactiveCardHostRef");
    expect(WORKSTATION).toContain("previewHost={gradingEnabled ? interactiveCardHost");
    expect(WORKSTATION).toContain("inspectionState={inspectionState}");
    expect(CERT_FORM).not.toMatch(/workflowStage|onStageRequest|onPresentationChange/);
    expect(PANEL).toContain("createPortal(children, host)");
  });

  it("uses each role's server-authorised preview endpoint and in-memory draft", () => {
    expect(WORKSTATION).toContain("`${apiBase}/certificates/label/preview`");
    expect(WORKSTATION).toContain("onPreviewChange={handleDraftPreviewChange}");
    expect(WORKSTATION).toContain("authoritativePreview ?? panelPreviewFields");
    expect(WORKSTATION).toContain("fields={previewFields}");
    expect(PREVIEW_PANEL).toContain("fetch(endpoint");
    expect(PREVIEW_PANEL).toContain("const body = expectedRevision == null ? fields : { ...fields, expectedRevision }");
    expect(PREVIEW_PANEL).toContain('res.headers.get("X-MintVault-Review-Revision")');
    expect(PREVIEW_PANEL).toContain('credentials: "include"');
  });

  it("locks Review to the exact authoritative preview fingerprint", () => {
    expect(WORKSTATION).toContain("setAuthoritativePreview(snapshot.preview)");
    expect(WORKSTATION).toContain("expectedFingerprint = JSON.stringify(snapshot.preview)");
    expect(WORKSTATION).toContain("fingerprint === waiter.expectedFingerprint");
    expect(WORKSTATION).toContain("if (previewWaitersRef.current.size === 0) setDraftPreview(preview)");
    expect(PREVIEW_PANEL).toContain("onRevisionComplete?.(revision, ok, requestFingerprint)");
    expect(PREVIEW_PANEL).toContain("authoritativeRevision !== expectedRevision");
    expect(WORKSTATION).toContain("onReviewValidityChange={handleReviewValidityChange}");
    expect(WORKSTATION).toMatch(
      /if \(!ready \|\| ready\.revision !== revision\) return ready;[\s\S]*setAuthoritativePreview\(null\)[\s\S]*return null/
    );
  });

  it("starts operators at Card Details and Pending Review at Review", () => {
    expect(WORKSTATION).toContain('mode === "admin-review" ? REVIEW_STAGE : 0');
  });

  it("keeps the canonical right body as the desktop scroll owner", () => {
    expect(SHELL).toContain('WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1"');
    expect(PANEL).toContain('className={previewHost ? "block"');
  });

  it("keeps Partner in the shared shell with capability-configured controls", () => {
    expect(WORKSTATION).toContain('mode === "partner"');
    expect(WORKSTATION).toContain('catalogueEndpoint: "/api/partner/catalogue/snapshot"');
    expect(WORKSTATION).toContain("customSetMutations: false");
    expect(WORKSTATION).toContain("identify: false");
    expect(WORKSTATION).toContain("imageMutations: false");
    expect(PANEL).toContain("workstationCapabilities.imageMutations");
    expect(IDENTITY).toContain("props.allowIdentify !== false");
  });

  it("provides language editing and a shared read-only role Review summary", () => {
    expect(IDENTITY).toContain('data-testid="input-identity-language"');
    expect(PANEL).toContain("onLanguage={setIdLanguage}");
    expect(PANEL).toContain("<RoleReviewSummary");
    for (const field of ["Authentication", "Defects", "Public grade explanation", "Private notes"]) {
      expect(ROLE_REVIEW).toContain(field);
    }
  });
});

describe("Hotfix: stage bar gates content (Card Details / Grade / Review)", () => {
  const ADMIN_TOKENS = read("client/src/styles/admin-tokens.css");

  it("SG1. the role workstation body applies the stage-gate wrapper + current stage", () => {
    expect(WORKSTATION).toContain("grading-stage-gate");
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    // The stage bar drives `stage`, and clicking a stage calls goToStage(setStage).
    expect(WORKSTATION).toMatch(/onStageClick=\{\(i\) => goToStage\(i\)\}/);
    expect(WORKSTATION).toContain("if (gradingEnabled && index === REVIEW_STAGE");
    expect(WORKSTATION).toContain("void establishReview()");
    expect(WORKSTATION).toContain("setStage(index)");
  });

  it("SG2. the stage-gate CSS exists for all three stages (hidden-not-unmounted)", () => {
    for (const n of [0, 1, 2]) {
      expect(ADMIN_TOKENS, `stage ${n} gate rule`).toContain(`.grading-stage-gate[data-ws-stage="${n}"]`);
    }
    // display:none (hidden), never unmounts → GradingPanel state/scoring preserved.
    expect(ADMIN_TOKENS).toMatch(/grading-stage-gate[\s\S]*display: none/);
  });

  it("SG3. NESTING-SAFE: grade-result + footer-actions (submit) are SIBLINGS inside grading-controls, so the gate never cascade-hides the submit button", () => {
    // Slice each stage's rule block (each ends at its `display: none`).
    const stage = (n: number) => {
      const start = ADMIN_TOKENS.indexOf(`.grading-stage-gate[data-ws-stage="${n}"]`);
      return ADMIN_TOKENS.slice(start, ADMIN_TOKENS.indexOf("display: none", start));
    };
    const sec = (name: string) => `[data-canonical-section="${name}"]`;
    // Stage 0 (Card Details): hide the whole grade column via grading-controls
    // (nothing inside it is needed on this stage, so the cascade is intended).
    expect(stage(0)).toContain(sec("grading-controls"));
    // CONSOLIDATION: the variant picker is now part of Card Details, so stage 0
    // must NOT hide it any more.
    expect(stage(0)).not.toContain(sec("rarity"));
    // Stage 1 (Grade): hide identity + variant + submit ONLY. It must NEVER hide
    // grading-controls (that would cascade-hide grade-result + the submit button).
    expect(stage(1)).toContain(sec("identity-fields"));
    expect(stage(1)).toContain(sec("rarity"));
    expect(stage(1)).toContain(sec("footer-actions"));
    expect(stage(1)).not.toContain(sec("grading-controls"));
    expect(stage(1)).not.toContain(sec("grade-result"));
    // Stage 2 uses the shared read-only review summary, while the authorised
    // footer remains reachable.
    expect(stage(2)).not.toContain(sec("grading-controls"));
    expect(stage(2)).toContain(sec("grade-result"));
    expect(stage(2)).not.toContain(sec("footer-actions"));
    expect(stage(2)).not.toContain(sec("review-summary"));
    // Review hides the detailed sub-grade control siblings.
    expect(stage(2)).toContain(sec("mvgs-score"));
    expect(stage(2)).toContain(sec("notes"));
  });

  it("SG4. role Review summary is visible only on Review", () => {
    const block = (n: number) => {
      const start = ADMIN_TOKENS.indexOf(`.grading-stage-gate[data-ws-stage="${n}"]`);
      return ADMIN_TOKENS.slice(start, ADMIN_TOKENS.indexOf("display: none", start));
    };
    expect(block(0)).toContain('[data-canonical-section="review-summary"]');
    expect(block(1)).toContain('[data-canonical-section="review-summary"]');
    expect(block(2)).not.toContain('[data-canonical-section="review-summary"]');
  });

  it("SG5. no grading section is hidden on ALL three stages (submit + every section reachable somewhere)", () => {
    const sections = [
      "workflow-banners",
      "identification",
      "identity-fields",
      "rarity",
      "workstation-header",
      "preflight",
      "ai-tools",
      "card-images",
      "defect-marking",
      "grading-controls",
      "mvgs-score",
      "grade-result",
      "d1-d2-d3",
      "centering",
      "surface",
      "authentication",
      "notes",
      "footer-actions",
    ];
    // grade-result + footer-actions are children of grading-controls; a section is
    // "effectively hidden" on a stage if it OR grading-controls is in that stage's
    // hide-rule. Model that and assert every section is shown on ≥1 stage.
    const childrenOfGradingControls = new Set([
      "defect-marking",
      "mvgs-score",
      "grade-result",
      "d1-d2-d3",
      "centering",
      "surface",
      "authentication",
      "notes",
      "footer-actions",
    ]);
    // Each stage now has its OWN rule block (the old 0/1 shared-block hack is
    // gone with the Rarity stage). Slice each block through its display:none.
    const stageRule = (n: number) => {
      const start = ADMIN_TOKENS.indexOf(`.grading-stage-gate[data-ws-stage="${n}"]`);
      expect(start, `stage ${n} rule block`).toBeGreaterThan(-1);
      return ADMIN_TOKENS.slice(start, ADMIN_TOKENS.indexOf("display: none", start));
    };
    const hiddenOn = (section: string, n: number) => {
      const nBlock = stageRule(n);
      const direct = nBlock.includes(`[data-canonical-section="${section}"]`);
      const viaParent =
        childrenOfGradingControls.has(section) && nBlock.includes('[data-canonical-section="grading-controls"]');
      return direct || viaParent;
    };
    for (const s of sections) {
      const shownSomewhere = [0, 1, 2].some((n) => !hiddenOn(s, n));
      expect(shownSomewhere, `section "${s}" is hidden on every stage (unreachable)`).toBe(true);
    }
    // Explicit: the Approve/Submit button is reachable on Review (stage 2).
    expect(hiddenOn("footer-actions", 2), "submit hidden on Review").toBe(false);
    // CONSOLIDATION: identity AND variant are both visible on Card Details.
    expect(hiddenOn("identity-fields", 0), "identity hidden on Card Details").toBe(false);
    expect(hiddenOn("rarity", 0), "variant hidden on Card Details").toBe(false);
  });

  it("SG4. gating is canonical (GWS + CSS only); CertificateForm is metadata-only on /admin", () => {
    // The role gate class never appears in CertForm; /admin keeps CertForm wfStage.
    expect(CERT_FORM).not.toContain("grading-stage-gate");
    expect(ADMIN_DASH).not.toMatch(/workflowStage=|onStageRequest=/);
    expect(CERT_FORM).not.toMatch(/workflowStage|onStageRequest|onPresentationChange/);
    expect(WORKSTATION).toContain("data-ws-stage={stage}");
    // GradingPanel itself is untouched (no stage prop / no gating logic added).
    const PANEL = read("client/src/components/grading/grading-panel.tsx");
    expect(PANEL).not.toContain("grading-stage-gate");
    expect(PANEL).not.toContain("data-ws-stage");
  });
});

describe("Three-stage workflow: Variant lives in Card Details + one shared picker/catalogue", () => {
  const ADMIN_TOKENS = read("client/src/styles/admin-tokens.css");
  const PANEL = read("client/src/components/grading/grading-panel.tsx");
  const GRADER_SERVER = read("server/grader.ts");
  const CATALOGUE = "shared/pokemon-rarity-catalogue.ts";
  const stageHides = (n: number, section: string) => {
    const start = ADMIN_TOKENS.indexOf(`.grading-stage-gate[data-ws-stage="${n}"]`);
    const block = ADMIN_TOKENS.slice(start, ADMIN_TOKENS.indexOf("display: none", start));
    return block.includes(`[data-canonical-section="${section}"]`);
  };

  it("R1. CONSOLIDATED: Card Details renders identity AND the variant picker together", () => {
    // Card Details (stage 0) shows BOTH — that is the whole point of the merge.
    expect(stageHides(0, "identity-fields")).toBe(false);
    expect(stageHides(0, "rarity")).toBe(false);
    // Grade (stage 1) hides both — it is the protected workstation only.
    expect(stageHides(1, "identity-fields")).toBe(true);
    expect(stageHides(1, "rarity")).toBe(true);
  });

  it("R2-R4. Rarity mounts the canonical structured picker; /admin + role routes use the SAME component + catalogue", () => {
    const IMPORT = 'import { RarityVariantPicker } from "@/components/rarity-picker/RarityVariantPicker"';
    const CERT = read("client/src/components/certificate-form.tsx");
    expect(PANEL).toContain(IMPORT); // role workstation
    expect(CERT).toContain(IMPORT); // /admin — SAME component
    expect(PANEL).toContain("<RarityVariantPicker");
    expect(PANEL).toContain('data-canonical-section="rarity"');
    // one shared catalogue (single source of truth), imported by the picker.
    const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
    expect(PICKER).toContain("@shared/pokemon-rarity-catalogue");
  });

  it("R5. the shared catalogue exposes the full rarity range (IR / SIR / Ultra / Hyper / ACE SPEC)", () => {
    const cat = read(CATALOGUE);
    for (const label of ["Illustration Rare", "Special Illustration Rare", "Ultra Rare", "Hyper Rare", "ACE SPEC"]) {
      expect(cat, `catalogue exposes ${label}`).toContain(label);
    }
  });

  it("R6-R7. finish + promo are independent structured fields (StructuredCardVariant), rarity single-select", () => {
    // The picker emits {rarity, finish, promo, ...} — separate fields, and the
    // role panel maps them to separate columns (rarity_code/finish_variant/promo_type).
    expect(PANEL).toMatch(/setRarityCode\((v\.rarity|nextRarity)/);
    expect(PANEL).toContain("isLowerInformationRarityChange");
    expect(PANEL).toMatch(/setFinishVariant\(v\.finish/);
    expect(PANEL).toMatch(/setPromoType\(v\.promo/);
  });

  it("R8. role save/read persist rarity ADDITIVELY (existing columns; validator preserves)", () => {
    // Read path exposes the fields; write path persists them via applyCertGradeDraft.
    expect(GRADER_SERVER).toContain("rarityCode: c.rarityCode");
    expect(GRADER_SERVER).toContain("finishVariant: c.finishVariant");
    expect(GRADER_SERVER).toContain("promoType: c.promoType");
    expect(GRADER_SERVER).toContain("validateGradeDraftIdentityAndVariant");
    expect(GRADER_SERVER).toMatch(/rarity_code\s*=\s*\$\{nextRarityCode\}/);
    expect(GRADER_SERVER).toMatch(/finish_variant\s*=\s*\$\{nextFinishVariant\}/);
    expect(GRADER_SERVER).toMatch(/promo_type\s*=\s*\$\{nextPromoType\}/);
    // GradingPanel sends them in its save payload.
    expect(PANEL).toContain("out.rarity_code = rarityCode.trim()");
    // Rarity hydrates AND persists for BOTH graderMode and adminReview (so
    // /admin/staff's Rarity stage is functional, not inert).
    expect(PANEL).toMatch(/if \(!canonicalIdentityVisible \|\| !gradingData\) return;[\s\S]*setRarityCode/);
    expect(PANEL).toMatch(/if \(graderMode \|\| adminReview\) \{[\s\S]*out\.rarity_code/);
    // Non-empty guard — an empty/unhydrated picker never wipes a stored value.
    expect(PANEL).toContain("if (rarityCode.trim()) out.rarity_code = rarityCode.trim()");
  });

  it("R9. every role sees the same classification tree; Admin mutates it only in the bounded metadata surface", () => {
    expect(PANEL).toMatch(/\{canonicalIdentityVisible && \([\s\S]*data-canonical-section="rarity"/);
    expect(PANEL).toContain("disabled={!canonicalClassificationEditable}");
    expect(PANEL).toContain("const canonicalClassificationEditable = graderMode || adminReview");
  });

  it("R10-R12. Grade has no submit; Review keeps submit reachable; Review shows the card+variant summary", () => {
    expect(stageHides(1, "footer-actions")).toBe(true); // no submit on Grade
    expect(stageHides(2, "footer-actions")).toBe(false); // submit reachable on Review
    expect(stageHides(2, "identity-fields")).toBe(true); // consolidated into shared Review summary
    expect(stageHides(2, "rarity")).toBe(true); // consolidated into shared Review summary
    expect(stageHides(2, "review-summary")).toBe(false);
  });

  it("R13-R15. one canonical picker only — no route-specific rarity component or role catalogue array", () => {
    // No alternative/reduced rarity picker for staff.
    const roots = ["client/src/pages/staff.tsx", "client/src/pages/grader.tsx", "client/src/pages/admin-staff.tsx"];
    for (const p of roots) {
      const src = read(p);
      expect(src, `${p} must not build its own rarity picker`).not.toMatch(
        /RarityVariantPicker|RARITY_CATALOG|rarityCatalogue/
      );
    }
    // Density parity: role stages use the shared components; no role-specific
    // density override class introduced for the rarity/identity surfaces.
    expect(PANEL).not.toContain("staff-density");
    expect(PANEL).not.toContain("grader-density");
  });
});

describe("Rarity clear: explicit 'No rarity' persists an empty selection (optional, single-select)", () => {
  const PANEL = read("client/src/components/grading/grading-panel.tsx");
  const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");

  it("C1. the canonical picker has an explicit 'No rarity — clear' action (deselects rarity)", () => {
    expect(PICKER).toContain('data-testid="rarity-clear"');
    expect(PICKER).toContain("No rarity — clear");
    expect(PICKER).toMatch(/const clearRarity = \(\) => \{\s*setRarity\(null\)/);
  });

  it("C2. rarity is optional + single-select + toggle-off (clicking the selected rarity clears it)", () => {
    // pickRarity: selecting the same catalogue rarity toggles it off (null).
    expect(PICKER).toMatch(
      /if \(nextCatalogueRarity\(rarity, v, !!selectedCustomId\) === null\) \{\s*setRarity\(null\)/
    );
    // finish + promo are independent controls (separate setters), not tied to rarity.
    expect(PICKER).toContain("setFinish(");
    expect(PICKER).toContain("setPromoOrSubset(");
  });

  it("C3. an INTENTIONAL clear persists (rarityTouched) while an untouched/unhydrated picker never wipes", () => {
    // Touch flag set on any picker interaction (incl. clear).
    expect(PANEL).toMatch(/function handleRarityChange\(v: StructuredCardVariant\) \{\s*setRarityTouched\(true\)/);
    // Touched → send the exact current selection, where a CLEARED field is sent
    // as explicit NULL (applyCertGradeDraft's pick() persists an explicit null as
    // SQL NULL, matching the admin certificate route; "" would have been stored
    // verbatim as an empty string). Untouched → non-empty guard only (preserve).
    expect(PANEL).toContain("out.rarity_code = rarityCode.trim() || null;");
    expect(PANEL).toContain("out.finish_variant = finishVariant.trim() || null;");
    expect(PANEL).toContain("out.promo_type = promoType.trim() || null;");
    expect(PANEL).toMatch(/\} else \{\s*if \(rarityCode\.trim\(\)\) out\.rarity_code = rarityCode\.trim\(\);/);
    // Touch flag is reset per card (no cross-record clear leakage).
    expect(PANEL).toContain("setRarityTouched(false)");
  });

  it("C4. one consolidated Variant value — the picker emits a single StructuredCardVariant (finish/promo independent fields within it)", () => {
    // The picker builds ONE structured variant and emits it through an explicit
    // interaction helper. Controlled prop echoes only hydrate state; they do not
    // replay onChange or suppress the next click.
    expect(PICKER).toContain("buildStructuredVariant({");
    expect(PICKER).toMatch(/const emitSelection = \(next:/);
    expect(PICKER).toMatch(/onChangeRef\.current\?\.\(\s*buildStructuredVariant\(/);
    expect(PICKER).not.toContain("syncingFromValueRef");
  });

  it("C5. picker does NOT emit onChange on mount — only on genuine interaction (no spurious rarityTouched / stored-rarity wipe)", () => {
    // There is no effect-driven onChange at all: mount/refetch/parent echo only
    // synchronise controlled state, while user handlers call emitSelection.
    const effectBodies = Array.from(PICKER.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\},/g)).map((m) => m[1]);
    expect(effectBodies.some((body) => body.includes("onChangeRef.current?.("))).toBe(false);
    expect(PICKER).toMatch(/const pickRarity = \(v: string\) => \{/);
    expect(PICKER).toMatch(/const pickFinish = \(value: string \| null\) => \{/);
    expect(PICKER).toMatch(/const pickPromoOrSubset = \(value: string \| null\) => \{/);
    // GradingPanel mounts the picker only once gradingData is present and keys it by
    // certId, seeding from the stored value — both derived straight from the query, so
    // no effect-ordering race (hydration vs per-card reset) can strand it on "Loading".
    expect(PANEL).toMatch(/gradingData \? \([\s\S]{0,250}<RarityVariantPicker/);
    expect(PANEL).toMatch(/key=\{certId \?\? "none"\}/);
    // Seed strictly from the per-cert query — no `?? localState` fallback (which would
    // leak a previous cert's rarity onto a cached null-rarity cert).
    expect(PANEL).toMatch(/rarity: \(gradingData as any\)\.rarityCode \|\| null/);
    expect(PANEL).not.toMatch(/rarityCode\) \|\| null/);
    // The stompable rarityHydrated latch is gone entirely.
    expect(PANEL).not.toContain("rarityHydrated");
  });
});
