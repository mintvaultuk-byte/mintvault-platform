/**
 * grading-persistence-lifecycle.test.ts — BEHAVIOURAL proof for hostile-review M-1.
 *
 * The previous coverage asserted that grading-panel.tsx CONTAINED the string
 * `if (!active) return;`. That proves the text exists, not that the rule is
 * right: it would still pass if the guard were unreachable, mis-ordered or
 * negated. The decision now lives in a pure function, so it is exercised
 * directly — no jsdom, no new test dependency.
 *
 * Every scenario the review asked for is driven as STATE, not source text:
 * inactive, hydration, stale certificate response, cert switch, Strict-Mode-like
 * repeated execution, active explicit edit, leaving Grade before the debounce,
 * and a failed/aborted GET.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideGradingPersistence, type GradingPersistenceState } from "../shared/grading-persistence-lifecycle";

/** A fully-hydrated, active, unapproved panel — the ONLY state that may save. */
const ARMED: GradingPersistenceState = {
  active: true,
  certId: 42,
  hydratedForCertId: 42,
  workflowLocked: false,
  gradeApprovedAt: null,
  settledAfterHydration: true,
};

const at = (o: Partial<GradingPersistenceState>) => decideGradingPersistence({ ...ARMED, ...o });

describe("M-1 · the grading panel may persist ONLY from an active, hydrated, user edit", () => {
  it("arms on a genuine active edit", () => {
    const d = at({});
    expect(d.arm).toBe(true);
    expect(d.reason).toBe("user-edit");
  });

  it("an INACTIVE (hidden-not-unmounted) Grade panel never arms", () => {
    const d = at({ active: false });
    expect(d.arm).toBe(false);
    expect(d.reason).toBe("inactive");
    // and it drops anything already scheduled
    expect(d.cancelPending).toBe(true);
  });

  it("inactive beats every other signal — no combination re-opens it", () => {
    for (const extra of [
      {},
      { workflowLocked: true },
      { settledAfterHydration: false },
      { gradeApprovedAt: "2026-01-01T00:00:00Z" },
      { hydratedForCertId: 999 },
    ]) {
      expect(at({ active: false, ...extra }).arm, JSON.stringify(extra)).toBe(false);
    }
  });

  it("no certificate → nothing to save", () => {
    expect(at({ certId: null }).reason).toBe("no-cert");
    expect(at({ certId: undefined }).reason).toBe("no-cert");
    expect(at({ certId: 0 }).reason).toBe("no-cert");
  });

  // ── HYDRATION ─────────────────────────────────────────────────────────────
  it("cannot arm before the grading payload has landed", () => {
    const d = at({ hydratedForCertId: null, settledAfterHydration: false });
    expect(d.arm).toBe(false);
    expect(d.reason).toBe("awaiting-hydration");
    // crucially it must NOT consume the settle run while un-hydrated, or the
    // very first real edit would be swallowed instead of the hydration echo
    expect(d.markSettled).toBe(false);
  });

  it("the run caused by hydration itself is swallowed exactly once", () => {
    const first = at({ settledAfterHydration: false });
    expect(first.arm).toBe(false);
    expect(first.reason).toBe("hydration-settle");
    expect(first.markSettled).toBe(true);
    // the NEXT run, with the flag now consumed, is a real edit
    expect(at({ settledAfterHydration: true }).arm).toBe(true);
  });

  it("absence of grading evidence is never persisted as a perfect card (MV900007)", () => {
    // A certificate with no stored grading data: the GET has not resolved, so
    // local state is all-zero UI defaults, which MVGS scores as a 10.
    const d = at({ hydratedForCertId: null, settledAfterHydration: false, active: true });
    expect(d.arm).toBe(false);
  });

  // ── CERTIFICATE SWITCHING / STALE RESPONSES ───────────────────────────────
  it("a card switch cannot inherit the previous card's hydration", () => {
    // Panel now shows cert 43; the marker still records cert 42.
    const d = at({ certId: 43, hydratedForCertId: 42 });
    expect(d.arm).toBe(false);
    expect(d.reason).toBe("awaiting-hydration");
  });

  it("a STALE GET completing for the old card after a switch cannot save", () => {
    // The in-flight GET for 42 resolves while 43 is mounted. The marker is only
    // ever set to the certId it resolved for, so it can never equal 43 here.
    const d = at({ certId: 43, hydratedForCertId: 42, settledAfterHydration: true });
    expect(d.arm).toBe(false);
  });

  it("after the NEW card hydrates, the first run is still a settle run", () => {
    const settle = at({ certId: 43, hydratedForCertId: 43, settledAfterHydration: false });
    expect(settle.arm).toBe(false);
    expect(settle.markSettled).toBe(true);
    expect(at({ certId: 43, hydratedForCertId: 43, settledAfterHydration: true }).arm).toBe(true);
  });

  // ── FAILED / ABORTED GET ──────────────────────────────────────────────────
  it("a failed or aborted GET locks persistence (workflowLocked)", () => {
    const d = at({ workflowLocked: true });
    expect(d.arm).toBe(false);
    expect(d.reason).toBe("workflow-locked");
    expect(d.cancelPending).toBe(true);
  });

  it("a GET that failed BEFORE hydrating cannot arm even once it stops loading", () => {
    expect(at({ workflowLocked: false, hydratedForCertId: null }).arm).toBe(false);
  });

  // ── APPROVAL ──────────────────────────────────────────────────────────────
  it("auto-save is pre-approval only, and approval cancels pending work", () => {
    const d = at({ gradeApprovedAt: "2026-07-20T10:00:00Z" });
    expect(d.arm).toBe(false);
    expect(d.reason).toBe("approved");
    expect(d.cancelPending).toBe(true);
  });

  // ── STRICT MODE ───────────────────────────────────────────────────────────
  it("React Strict Mode's repeated execution is idempotent", () => {
    // Strict Mode runs the effect twice with identical inputs. Because the
    // decision is a pure function of state, the second run yields the SAME
    // answer — it can neither consume a settle run twice nor arm twice.
    const s: GradingPersistenceState = { ...ARMED, settledAfterHydration: false };
    const a = decideGradingPersistence(s);
    const b = decideGradingPersistence(s);
    expect(b).toEqual(a);
    // and once the component applied markSettled, both further runs arm alike
    const settled = { ...s, settledAfterHydration: true };
    expect(decideGradingPersistence(settled)).toEqual(decideGradingPersistence(settled));
  });

  // ── LEAVING THE GRADE STAGE BEFORE THE DEBOUNCE FIRES ─────────────────────
  it("leaving Grade before the debounce cancels the pending save", () => {
    const armed = at({});
    expect(armed.arm).toBe(true);
    // user switches to Review before the 500ms timer fires
    const left = at({ active: false });
    expect(left.arm).toBe(false);
    expect(left.cancelPending).toBe(true);
  });

  it("EVERY non-arming decision cancels pending work — no path leaks a timer", () => {
    const nonArming: Array<Partial<GradingPersistenceState>> = [
      { certId: null },
      { active: false },
      { workflowLocked: true },
      { gradeApprovedAt: "x" },
      { hydratedForCertId: null },
      { settledAfterHydration: false },
    ];
    for (const s of nonArming) {
      const d = at(s);
      expect(d.arm, JSON.stringify(s)).toBe(false);
      expect(d.cancelPending, JSON.stringify(s)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every mount site supplies the flag. This IS a source check, but it is a
// COVERAGE check (are there call sites we forgot?), not a behavioural one — the
// behaviour above is proven by state. TypeScript already makes `active`
// mandatory; this catches a new mount site that silences it with a wrong value.
// ─────────────────────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("M-1 · every GradingPanel mount site states its lifecycle", () => {
  it("`active` is a REQUIRED prop — there is no fail-open default", () => {
    const panel = read("client/src/components/grading/grading-panel.tsx");
    expect(panel).toContain("active: boolean;");
    expect(panel, "a default of true silently re-enables hidden autosave").not.toContain("active = true");
  });

  it("GradingWorkstation derives it from its OWN stage, and pages cannot override it", () => {
    const ws = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
    // the adapter's public props exclude `active` …
    // (written multi-line so the source does not contain the literal
    //  "<GradingPanel", which a protected architecture suite uses to locate the
    //  single real GradingPanel render site.)
    // M-2: BOTH stage flags are excluded now — Ctrl+S belongs to Grade and
    // Ctrl+Enter to Review, and neither may be supplied by a page.
    expect(ws).toMatch(/Omit<\s*GradingPanelProps,\s*"active"\s*\|\s*"approvalStageActive"\s*>/);
    // … and it passes both stage-derived values explicitly
    expect(ws).toContain("active={stage === GRADE_STAGE}");
    expect(ws).toContain("approvalStageActive={stage === REVIEW_STAGE}");
  });

  it("the three standalone surfaces mount through that adapter", () => {
    for (const page of [
      "client/src/pages/grader.tsx",
      "client/src/pages/staff.tsx",
      "client/src/pages/admin-staff.tsx",
    ]) {
      const src = read(page);
      expect(src, `${page} must mount the workstation adapter`).toContain("<GradingWorkstation");
      expect(src, `${page} must not mount GradingPanel directly`).not.toContain("<GradingPanel");
    }
  });

  it("CertificateForm no longer owns or injects grading lifecycle state", () => {
    const form = read("client/src/components/certificate-form.tsx");
    expect(form).not.toContain("<GradingPanel");
    expect(form).not.toContain("workstationSlot");
    const ws = read("client/src/components/grading-workflow/GradingWorkstation.tsx");
    expect(ws).toContain("active={stage === GRADE_STAGE}");
    expect(ws).toContain("approvalStageActive={stage === REVIEW_STAGE}");
  });

  it("every direct GradingPanel mount site in the repository is accounted for", () => {
    const { execSync } = require("node:child_process");
    const hits = execSync("grep -rl '<GradingPanel' client/src || true", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
    // ONE canonical render site owns lifecycle for every role. A new direct
    // mount would be a role-specific shell and must fail this guard.
    expect(hits).toEqual(["client/src/components/grading-workflow/GradingWorkstation.tsx"]);
  });

  it("admin and dev surfaces use the canonical adapter instead of a direct slot", () => {
    for (const page of ["client/src/pages/admin-dashboard.tsx", "client/src/pages/dev-card-details-harness.tsx"]) {
      const src = read(page);
      expect(src).toContain("<GradingWorkstation");
      expect(src).not.toContain("<GradingPanel");
    }
  });
});
