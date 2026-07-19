/**
 * Repository-wide legacy-shell guard for operator-facing (admin/staff) routes.
 *
 * Built from a real, evidence-based repo-wide audit (2026-07-19) of every
 * /admin/* and /staff/* route in client/src/App.tsx: which page component it
 * resolves to, whether that component uses the shared AdminShell /
 * AdminHeaderRow / `.admin-root` token-scope, or is its own standalone shell
 * (raw hex colors, its own header, its own background).
 *
 * This is NOT a "does the string AdminHeaderRow appear anywhere" check — it:
 *  1. Parses the ACTUAL route table out of App.tsx (route path → component →
 *     source file), so a newly-added route is automatically covered.
 *  2. Classifies each resolved file as Unified / Legacy (allowlisted, with a
 *     reason) — an unrecognised, unclassified route fails closed, forcing
 *     whoever adds it to make a deliberate decision instead of silently
 *     shipping a new bespoke shell.
 *  3. Structurally re-verifies the one screenshot-proven regression fixed in
 *     this pass — admin-staff.tsx's "Review {certIdStr}" overlay + Manual
 *     Card Identity Override — so it can't silently regress back to raw hex.
 *
 * The LEGACY_EXCEPTIONS list is a live inventory, not a rubber stamp: every
 * entry needs a one-line reason, and this file is the single place future
 * unification work should update as pages get corrected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const APP = read("client/src/App.tsx");

// ── Step 1: parse the real route table out of App.tsx ──────────────────────
// `const X = lazy(() => import("@/pages/y"));` → { componentName: "X", file: "y" }
const IMPORT_RE = /const\s+(\w+)\s*=\s*lazy\(\(\)\s*=>\s*import\("@\/pages\/([^"]+)"\)\)/g;
const componentToFile = new Map<string, string>();
for (const m of APP.matchAll(IMPORT_RE)) {
  componentToFile.set(m[1], `client/src/pages/${m[2]}.tsx`);
}
// eagerly-imported pages (not lazy()) — grep the plain import statements too.
const EAGER_IMPORT_RE = /import\s+(\w+)\s+from\s+"@\/pages\/([^"]+)"/g;
for (const m of APP.matchAll(EAGER_IMPORT_RE)) {
  if (!componentToFile.has(m[1])) componentToFile.set(m[1], `client/src/pages/${m[2]}.tsx`);
}

// `<Route path="/admin/x" component={Y} />` → { path: "/admin/x", component: "Y" }
const ROUTE_RE = /<Route\s+path="(\/(?:admin|staff|grader)[^"]*)"\s+component=\{(\w+)\}/g;
type RouteEntry = { path: string; component: string; file: string | null };
const routes: RouteEntry[] = [];
for (const m of APP.matchAll(ROUTE_RE)) {
  const [, path, component] = m;
  routes.push({ path, component, file: componentToFile.get(component) ?? null });
}

describe("route table extraction sanity", () => {
  it("found a non-trivial number of admin/staff/grader routes (parser didn't silently break)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
  });
  it("every extracted route resolved to a known component file (no dangling reference)", () => {
    const unresolved = routes.filter((r) => !r.file);
    expect(unresolved, JSON.stringify(unresolved)).toEqual([]);
  });
});

// ── Step 2: classify every resolved file ────────────────────────────────────
// Unified: imports AdminShell, OR imports+renders AdminHeaderRow, OR wraps
// itself in the `.admin-root` token scope (the same three patterns confirmed
// project-wide by the 2026-07-19 audit — see tests/production-regression-
// correction-2026-07-19.test.ts and the admin-staff.tsx fix in this same pass).
function isUnifiedSelf(src: string): boolean {
  return (
    /<AdminShell\b/.test(src) ||
    (src.includes('from "@/components/admin/AdminHeaderRow"') && /<AdminHeaderRow\b/.test(src)) ||
    /className="[^"]*\badmin-root\b/.test(src)
  );
}

// One level of delegation: a thin auth-gate page (e.g. admin.tsx → AdminDashboard)
// inherits its child's classification instead of needing its own shell markup.
const DELEGATE_RE = /import\s+(\w+)\s+from\s+"(\.\/[^"]+|@\/pages\/[^"]+)"/g;
function isUnified(src: string): boolean {
  if (isUnifiedSelf(src)) return true;
  for (const m of src.matchAll(DELEGATE_RE)) {
    const [, name, spec] = m;
    if (!new RegExp(`<${name}\\b`).test(src)) continue;
    const childFile = spec.startsWith("@/pages/")
      ? `client/src/pages/${spec.slice("@/pages/".length)}.tsx`
      : join("client/src/pages", spec.replace(/^\.\//, "") + ".tsx");
    try {
      if (isUnifiedSelf(read(childFile))) return true;
    } catch {
      /* not a page-local file, or extension guess wrong — not a delegate match */
    }
  }
  return false;
}

// Known-legacy routes NOT touched by this pass — each needs a reason. This is
// the "complete list of legacy shells found" inventory from the 2026-07-19
// audit. A route resolving to a file NOT in this list and NOT unified fails
// the test below — i.e. new routes must be unified or explicitly logged here.
const LEGACY_EXCEPTIONS: Record<string, string> = {
  "client/src/pages/admin-legacy-review.tsx": "pre-existing legacy tool, not covered by this pass — audited 2026-07-19",
  "client/src/pages/admin-pokemon-knowledge.tsx":
    "own slate-theme reference hub, not covered by this pass — audited 2026-07-19",
  "client/src/pages/admin-operator-stats.tsx": "raw-hex stats page, not covered by this pass — audited 2026-07-19",
  "client/src/pages/vault-quest-studio.tsx":
    "separate Vault Quest product surface, own design language — audited 2026-07-19",
  "client/src/pages/admin-vault-quest-card-factory.tsx":
    "separate Vault Quest product surface, own design language — audited 2026-07-19",
  "client/src/pages/admin-vault-quest.tsx":
    "separate Vault Quest product surface, own design language — audited 2026-07-19",
  "client/src/pages/admin/community.tsx": "raw-hex community tool, not covered by this pass — audited 2026-07-19",
  "client/src/pages/grader.tsx": "legacy pre-Staff-portal grader UI, not covered by this pass — audited 2026-07-19",
  "client/src/pages/logbook.tsx":
    "public cert-lookup page reused at /admin/cert/:id, intentionally the public light theme",
  "client/src/pages/admin-mvgs-calibration.tsx":
    "uses var(--admin-*) tokens but is missing the .admin-root scoping class (partial gap) — audited 2026-07-19",
};

describe("every admin/staff/grader route is either unified or an explicitly-logged exception", () => {
  it.each(routes)("$path → $component ($file)", ({ file }) => {
    if (!file) throw new Error("unresolved route — should have failed the sanity check above");
    const src = read(file);
    if (isUnified(src)) return; // unified — pass
    expect(LEGACY_EXCEPTIONS, `${file} is neither unified nor a logged exception — classify it`).toHaveProperty(file);
  });
});

// ── Step 3: the fixed regression stays fixed (admin-staff.tsx review overlay) ──
const ADMIN_STAFF = read("client/src/pages/admin-staff.tsx");
const overlay = ADMIN_STAFF.slice(
  ADMIN_STAFF.indexOf('data-testid="grade-review-overlay"') - 200,
  ADMIN_STAFF.indexOf("Manual card identity override")
);

describe("admin-staff.tsx review overlay — the screenshot-proven regression stays fixed", () => {
  it("the overlay is inside the admin-root token scope", () => {
    expect(overlay).toMatch(/className="admin-root fixed inset-0/);
  });
  it("the overlay header uses the shared AdminHeaderRow primitive", () => {
    expect(ADMIN_STAFF).toContain('import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow"');
    expect(overlay).toContain("<AdminHeaderRow");
    expect(overlay).toContain('testId="grade-review-header"');
  });
  it("the overlay header + identity-override panel no longer hardcode raw admin-gold/ink hex", () => {
    const overlayToIdentityEnd = ADMIN_STAFF.slice(
      ADMIN_STAFF.indexOf('data-testid="grade-review-overlay"'),
      ADMIN_STAFF.indexOf("Overwrites card name / set / number / year / variant")
    );
    expect(overlayToIdentityEnd).not.toMatch(/#D4AF37|#E8E4DC/);
  });
  it("Reject / Close / Manual Identity Override / Re-run TCGdex / Save identity all still present (nothing removed)", () => {
    expect(ADMIN_STAFF).toContain('data-testid="button-reject-grade"');
    expect(ADMIN_STAFF).toContain('aria-label="Close review"');
    expect(ADMIN_STAFF).toContain("Manual card identity override");
    expect(ADMIN_STAFF).toContain('data-testid="button-override-rerun"');
    expect(ADMIN_STAFF).toContain('data-testid="button-save-identity"');
    expect(ADMIN_STAFF).toContain('data-testid="input-reject-note"');
  });
  it("the review-failure/save-failure banners (msg/err) now render INSIDE the z-50 overlay, not only underneath it", () => {
    expect(overlay).toMatch(/\{msg && \(/);
  });
  it("GradingPanel's adminReview props are untouched (protected-adjacent — visual fix only)", () => {
    const panelBlock = ADMIN_STAFF.slice(
      ADMIN_STAFF.indexOf("<GradingPanel"),
      ADMIN_STAFF.indexOf("<GradingPanel") + 500
    );
    expect(panelBlock).toContain("adminReview");
    expect(panelBlock).toContain('apiBase="/api/admin/grade-review"');
  });
});
