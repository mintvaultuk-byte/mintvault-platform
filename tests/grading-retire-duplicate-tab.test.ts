/**
 * Retire the duplicate "Grading" tab (Phase 2 of the unified-admin-shell
 * architecture work).
 *
 * READ-ONLY AUDIT FINDING (confirmed before any edit): admin-dashboard.tsx's
 * `activeTab === "grading"` branch rendered a SECOND, independently-built
 * grading UI — GradingQueue + a bare GradingPanel — reachable via a real,
 * unconditional sidebar nav click (admin-shell.tsx's NAV array, key
 * "grading", no role/capability gate). It bypassed CertificateForm entirely:
 * no AI-identify pipeline (`pendingAnalysis`/`onManualIdentification`/
 * `onCertUpdated`), no card-metadata form, no shared workstation shell. Its
 * one genuinely unique, load-bearing capability was a PRIORITISED QUEUE
 * ENTRY POINT — the oldest not-yet-approved certificate, matching the
 * server's `ORDER BY issued_at ASC` grading-queue route (server/routes.ts,
 * commented "legacy in-app grading queue (dashboard Grading tab)"). Its
 * session-timer/completed-count UI is already covered live by the shared
 * WorkstationHeaderStrip's SessionHud.
 *
 * DECISION (rule C — migrate the unique capability, retire the competing
 * shell): the "grading" nav key and its onTabChange wiring are UNCHANGED
 * (so no stale bookmark/nav link breaks), but the destination is now
 * `startGradingSession()` — it seeds the SAME gradeQueue/CertificateForm
 * mechanism `handleEdit` already uses with the oldest-unapproved-first
 * ordering, opening the canonical AI-identify-enabled workstation instead
 * of the retired standalone shell.
 *
 * client/src/components/grading/grading-queue.tsx and
 * client/src/components/grading/session-summary.tsx are now unreferenced by
 * any render path (confirmed: grep shows zero other importers) but were
 * DELIBERATELY NOT DELETED — they live inside the protected
 * client/src/components/grading/ directory, and removing/modifying files
 * under that directory was treated as requiring explicit owner sign-off
 * rather than being guessed at, per the protected-boundary "stop and
 * report" instruction.
 *
 * Source-assertion style (matches the sibling grading test files — the
 * admin surfaces are auth-gated). Zero provider calls, zero DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { unifiedAdminShellChangedFiles } from "./helpers/grading-release-scope";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const DASH = read("client/src/pages/admin-dashboard.tsx");
const SHELL = read("client/src/components/admin/admin-shell.tsx");
const FORM = read("client/src/components/certificate-form.tsx");
const REVIEW_SUMMARY = read("client/src/components/grading-workflow/ReviewSummary.tsx");

describe("1. the old grading tab was reachable before this change (audit finding, not an assumption)", () => {
  it("the 'grading' nav key is still a real, unconditional sidebar entry (same reachability, new destination)", () => {
    // Proves the audit's reachability claim (a live, ungated NAV item) by
    // confirming the SAME key still exists in the NAV array today — the
    // destination changed, the entry point's mechanics did not. Whitespace-
    // tolerant: a purely cosmetic reformat of the NAV entry (single-line ↔
    // multi-line, e.g. once a sibling nav entry pushed prettier to wrap it)
    // must not false-fail this — the key + label + icon semantics are the
    // contract, not the line layout.
    expect(SHELL).toMatch(/key:\s*"grading",\s*label:\s*"Grading",\s*icon:\s*BarChart3\b/);
    expect(SHELL).not.toMatch(/grading["'][^}]*role|role[^}]*grading/i); // never role-gated
  });
});

describe("2. the final canonical grading entry point is CertificateForm", () => {
  it("admin-dashboard's grading workstation view renders CertificateForm with the AI-identify-capable workstationSlot", () => {
    expect(DASH).toContain("<CertificateForm");
    expect(DASH).toContain("workstationSlot={");
    expect(DASH).toContain("pendingAnalysis");
    expect(DASH).toContain("onManualIdentification");
    expect(DASH).toContain("onCertUpdated");
  });
  it("CertificateForm itself still drives all four stages through the shared workstation primitives", () => {
    expect(FORM).toContain("<WorkstationHeaderStrip");
    expect(FORM).toContain("<WorkstationPreviewAside");
    expect(FORM).toContain("<ReviewSummary");
  });
});

describe("3. no duplicate GradingQueue + bare-GradingPanel shell remains", () => {
  it("admin-dashboard.tsx no longer imports or renders GradingQueue", () => {
    // Checked as CODE only — explanatory comments legitimately name the
    // retired component for context/history.
    const stripComments = (s: string) =>
      s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const code = stripComments(DASH);
    expect(code).not.toContain("GradingQueue");
    expect(code).not.toMatch(/from\s+"@\/components\/grading\/grading-queue"/);
  });
  it("the old activeTab === \"grading\" render branch (standalone shell) is gone", () => {
    expect(DASH).not.toMatch(/lg:grid-cols-\[320px_1fr\]/); // the old tab's queue+panel grid
    expect(DASH).not.toContain("Select a certificate from the queue to begin grading");
  });
  it("the retired-but-unreferenced components were left in place, not deleted (protected-directory caution)", () => {
    // grading-queue.tsx / session-summary.tsx live under the protected
    // client/src/components/grading/ directory — confirmed unreferenced by
    // any render path, but NOT deleted without explicit owner sign-off.
    const gq = read("client/src/components/grading/grading-queue.tsx");
    expect(gq.length).toBeGreaterThan(0);
    const ss = read("client/src/components/grading/session-summary.tsx");
    expect(ss.length).toBeGreaterThan(0);
  });
});

describe("4. stale activeTab=\"grading\" state safely redirects, never renders a blank page", () => {
  it("a useEffect redirects activeTab===\"grading\" into startGradingSession(), then resets the tab", () => {
    const effectIdx = DASH.indexOf('if (activeTab === "grading")');
    expect(effectIdx).toBeGreaterThan(-1);
    const effectBlock = DASH.slice(effectIdx, effectIdx + 200);
    expect(effectBlock).toContain("startGradingSession()");
    expect(effectBlock).toContain('setActiveTab("dashboard")');
  });
  it("startGradingSession() has a graceful empty-queue fallback (no crash, no blank page)", () => {
    const fnIdx = DASH.indexOf("const startGradingSession");
    expect(fnIdx).toBeGreaterThan(-1);
    const fn = DASH.slice(fnIdx, fnIdx + 900);
    expect(fn).toContain("queue.length === 0");
    expect(fn).toContain("toast(");
    expect(fn).toContain("return;");
  });
});

describe("5. the migrated unique capability: oldest-not-yet-approved-first queue ordering", () => {
  it("startGradingSession() filters unapproved/non-voided certs and sorts oldest-first (matches the retired queue's ORDER BY issued_at ASC)", () => {
    const fnIdx = DASH.indexOf("const startGradingSession");
    const fn = DASH.slice(fnIdx, fnIdx + 900);
    expect(fn).toContain("gradeApprovedAt");
    expect(fn).toContain('status !== "voided"');
    expect(fn).toMatch(/\.sort\(/);
    expect(fn).toContain("createdAt");
  });
  it("the session opens directly in the canonical workstation (setShowForm + setEditingCert + gradeQueue), not a separate shell", () => {
    const fnIdx = DASH.indexOf("const startGradingSession");
    const fn = DASH.slice(fnIdx, fnIdx + 900);
    expect(fn).toContain("setEditingCert(queue[0])");
    expect(fn).toContain("setShowForm(true)");
    expect(fn).toContain("setGradeQueue(");
  });
});

describe("6. session-timer/completed-count are already covered by the shared SessionHud (no separate summary modal needed)", () => {
  it("WorkstationHeaderStrip renders SessionHud (session timer, completed, cards/hr) for every stage", () => {
    const strip = read("client/src/components/grading-workflow/WorkstationHeaderStrip.tsx");
    expect(strip).toContain("<SessionHud embedded");
  });
});

describe("7. Staff and Super Admin permissions remain unchanged", () => {
  it("Staff still never imports AdminShell/CertificateForm/CertificateToolsDrawer/GradingQueue", () => {
    const staff = read("client/src/pages/staff.tsx");
    expect(staff).not.toMatch(/AdminShell|CertificateForm|CertificateToolsDrawer|GradingQueue/);
    expect(staff).toContain("caps.grade");
  });
  it("Super Admin still uses AdminShell with its own sidebar/nav (structurally unchanged)", () => {
    expect(DASH).toContain("<AdminShell");
    expect(SHELL).toContain("admin-side");
  });
});

describe("8. shared primitives + all four grading stages still canonical (regression guard)", () => {
  it("AdminHeaderRow is still used by both Super Admin and Staff", () => {
    expect(DASH).toContain("<AdminHeaderRow");
    const staff = read("client/src/pages/staff.tsx");
    expect(staff).toContain("<AdminHeaderRow");
  });
  it("the preview aside gate still covers Card, Rarity and Review (wfStage 0, 1, 3) — Grade's protected exception is untouched", () => {
    expect(FORM).toMatch(/\{\(wfStage <= 1 \|\| wfStage === 3\) && \(/);
  });
});

// unified-shell scope check — pinned to the pass's IMMUTABLE historical range
// (UNIFIED_ADMIN_SHELL 0825544a..a7cac275) via the shared helper, NOT a moving
// `${base}...HEAD` window. The old moving window drifted once origin/main
// advanced past the base (Partner Network G2–G4: server/partner/*, migrations
// 0009–0014, partner pages, and .claude task docs), pulling all that unrelated
// later work into the diff and false-tripping the protected-path matcher. The
// fixed range contains ONLY this pass's own files, so the guard again measures
// exactly "did THIS pass touch protected files?" — and still fails closed if it
// ever did (the PROTECTED regex is unchanged and still applied to that set).
function changedSinceScopeBase(): string[] {
  return unifiedAdminShellChangedFiles();
}

describe("9. Stage 3 protected component source remains untouched", () => {
  const changed = changedSinceScopeBase();
  it("no file under client/src/components/grading/ was modified (including grading-queue.tsx / session-summary.tsx — left in place, untouched)", () => {
    if (changed.length === 0) return;
    for (const f of changed) expect(f).not.toMatch(/^client\/src\/components\/grading\//);
  });
  it("no MVGS/centering/defect/grade-cap/rounding/cert-numbering/schema/migration/Partner-Network file changed", () => {
    if (changed.length === 0) return;
    const PROTECTED = /mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^migrations\/|partner/i;
    for (const f of changed) expect(f, f).not.toMatch(PROTECTED);
  });
});

describe("10. save payload and rarity picker remain unchanged", () => {
  it("ReviewSummary still receives every field; the save button is untouched", () => {
    expect(FORM).toContain('data-testid="button-save-cert"');
    expect(FORM).toContain('type="submit"');
    expect(REVIEW_SUMMARY).toContain("v.gradeOverall");
  });
  it("no rarity-picker source file appears in this pass's diff", () => {
    const changed = changedSinceScopeBase();
    if (changed.length === 0) return;
    for (const f of changed) expect(f).not.toMatch(/^client\/src\/components\/rarity-picker\//);
  });
});
