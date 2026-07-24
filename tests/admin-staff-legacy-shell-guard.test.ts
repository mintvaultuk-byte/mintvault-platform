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

// Known-legacy routes NOT yet unified — each needs a reason. This is the live
// backlog inventory from the 2026-07-19 audit, MINUS Group 1 (admin-sets was
// already AdminShell-wrapped; admin-operator-stats, admin-mvgs-calibration and
// admin-legacy-review were unified in the 2026-07-19 Group-1 pass and are now
// ENFORCED as unified below — they are deliberately absent here so a regression
// back to a standalone shell fails the test instead of being silently excused).
// A route resolving to a file NOT in this list and NOT unified fails the test —
// i.e. new routes must be unified or explicitly logged here.
// Group 2 (admin-pokemon-knowledge, admin/community) was unified in the
// 2026-07-19 Group-2 pass and is now ENFORCED below — deliberately absent here
// so a regression back to a standalone shell fails the test instead of being
// silently excused.
const LEGACY_EXCEPTIONS: Record<string, string> = {
  "client/src/pages/vault-quest-studio.tsx":
    "separate Vault Quest product surface, own design language — audited 2026-07-19",
  "client/src/pages/admin-vault-quest-card-factory.tsx":
    "separate Vault Quest product surface, own design language — audited 2026-07-19",
  "client/src/pages/admin-vault-quest.tsx":
    "separate Vault Quest product surface, own design language — audited 2026-07-19",
  "client/src/pages/logbook.tsx":
    "public cert-lookup page reused at /admin/cert/:id, intentionally the public light theme",
};

// Group 1 (2026-07-19): the four core admin routes brought onto the shared
// design system in this pass. ENFORCED coverage — each must render inside the
// .admin-root token scope AND (for the three re-shelled pages) use the shared
// AdminHeaderRow, and must NOT reintroduce a standalone raw page shell. If any
// regresses, this block fails; it is intentionally stricter than isUnified().
const GROUP_1 = {
  sets: "client/src/pages/admin-sets.tsx",
  operatorStats: "client/src/pages/admin-operator-stats.tsx",
  mvgsCalibration: "client/src/pages/admin-mvgs-calibration.tsx",
  legacyReview: "client/src/pages/admin-legacy-review.tsx",
} as const;

describe("Group 1 routes are enforced onto the shared admin shell (no longer exceptions)", () => {
  it("none of the 4 Group-1 files is still listed as a legacy exception", () => {
    for (const f of Object.values(GROUP_1)) {
      expect(LEGACY_EXCEPTIONS, `${f} must be enforced-unified, not excused`).not.toHaveProperty(f);
    }
  });
  it("admin-sets keeps the full shared AdminShell (its pre-existing shell) and no raw brand hex", () => {
    const src = read(GROUP_1.sets);
    expect(src).toMatch(/<AdminShell\b/);
    expect(src).not.toMatch(/#D4AF37|#E8E4DC/); // brand hex converted to var(--admin-*) tokens
  });
  it.each([
    ["operator-stats", GROUP_1.operatorStats, "operator-stats-header"],
    ["mvgs-calibration", GROUP_1.mvgsCalibration, "mvgs-calibration-header"],
    ["legacy-review", GROUP_1.legacyReview, "legacy-review-header"],
  ])("%s renders in .admin-root with a shared AdminHeaderRow and no standalone/legacy shell", (_name, file, testId) => {
    const src = read(file);
    // shared token scope + shared header primitive
    expect(src).toMatch(/className="admin-root/);
    expect(src).toContain('from "@/components/admin/AdminHeaderRow"');
    expect(src).toContain("<AdminHeaderRow");
    expect(src).toContain(`testId="${testId}"`);
    // no reintroduced standalone application shell / raw legacy page markup.
    // A full-page raw black GROUND (min-h-screen … bg-black, solid) is the exact
    // legacy pattern these pages had; a `bg-black/NN` modal scrim is fine and
    // allowed (the `(?!\/)` negative-lookahead excludes the slash-opacity form).
    expect(src).not.toMatch(/min-h-screen[^"]*\bbg-black\b(?!\/)/); // no raw black page ground
    expect(src).not.toMatch(/text-slate-\d|bg-slate-\d|border-slate-\d/); // no slate legacy theme
    expect(src).not.toMatch(/#D4AF37|#E8E4DC/); // no raw brand hex — converted to var(--admin-*) tokens
  });
});

// Group 2 (2026-07-19): the two knowledge/community admin routes brought onto
// the shared design system in this pass. ENFORCED coverage — same standard as
// Group 1, stricter than isUnified(): each must render in the .admin-root token
// scope, use the shared AdminHeaderRow with its stable testId, and NOT
// reintroduce a raw page ground, slate legacy theme, or raw brand hex.
const GROUP_2 = {
  pokemonKnowledge: "client/src/pages/admin-pokemon-knowledge.tsx",
  community: "client/src/pages/admin/community.tsx",
} as const;

describe("Group 2 routes are enforced onto the shared admin shell (no longer exceptions)", () => {
  it("neither Group-2 file is still listed as a legacy exception", () => {
    for (const f of Object.values(GROUP_2)) {
      expect(LEGACY_EXCEPTIONS, `${f} must be enforced-unified, not excused`).not.toHaveProperty(f);
    }
  });
  it.each([
    ["pokemon-knowledge", GROUP_2.pokemonKnowledge, "pokemon-knowledge-header"],
    ["community", GROUP_2.community, "community-header"],
  ])("%s renders in .admin-root with a shared AdminHeaderRow and no standalone/legacy shell", (_name, file, testId) => {
    const src = read(file);
    expect(src).toMatch(/className="admin-root/);
    expect(src).toContain('from "@/components/admin/AdminHeaderRow"');
    expect(src).toContain("<AdminHeaderRow");
    expect(src).toContain(`testId="${testId}"`);
    // no reintroduced standalone application shell / raw legacy page markup
    expect(src).not.toMatch(/min-h-screen[^"]*\bbg-black\b(?!\/)/); // no raw black page ground
    expect(src).not.toMatch(/text-slate-\d|bg-slate-\d|border-slate-\d/); // no slate legacy theme (pokemon-knowledge)
    expect(src).not.toMatch(/bg-amber-\d|text-amber-\d|border-amber-\d/); // no raw amber gold-substitute
    expect(src).not.toMatch(/#D4AF37|#E8E4DC|#0A0A0A/); // no raw brand/page hex — tokens only
  });
  it("both Group-2 pages preserve their exact API endpoint strings (visual-only pass)", () => {
    const pk = read(GROUP_2.pokemonKnowledge);
    expect(pk).toContain("/api/admin/pokemon-knowledge/overview");
    expect(pk).toContain("/api/admin/pokemon-knowledge/sets");
    expect(pk).toContain("/api/admin/pokemon-knowledge/review-queue");
    expect(pk).toContain("/decision"); // import + review-queue decision POSTs
    const cm = read(GROUP_2.community);
    expect(cm).toContain("/api/admin/community");
    expect(cm).toContain("/api/admin/share/prewarm");
    // moderation actions preserved (approve/reject soft-status + feature toggle)
    expect(cm).toContain('status: "approved"');
    expect(cm).toContain('status: "rejected"');
    expect(cm).toContain("featured: !p.featured");
  });
});

// Group 3 (2026-07-19): the Grader entry surfaces brought onto the shared
// design system in this pass. ENFORCED coverage. The grader dashboard uses the
// SAME token-on-root approach as staff.tsx (bg-[var(--admin-bg)] +
// AdminHeaderRow) rather than the .admin-root wrapper, so this block asserts the
// AdminHeaderRow primitive + design tokens + absence of a raw legacy shell,
// matching how staff.tsx is (correctly) classified as unified. The grader login
// is a pure redirect into the already-unified /staff/login — it must NOT
// reintroduce a bespoke standalone login shell.
const GROUP_3 = {
  grader: "client/src/pages/grader.tsx",
  graderLogin: "client/src/pages/grader-login.tsx",
} as const;

describe("Group 3 grader surfaces are enforced onto the shared admin shell (no longer exceptions)", () => {
  it("neither Group-3 file is still listed as a legacy exception", () => {
    for (const f of Object.values(GROUP_3)) {
      expect(LEGACY_EXCEPTIONS, `${f} must be enforced-unified, not excused`).not.toHaveProperty(f);
    }
  });
  it("grader dashboard renders with the shared AdminHeaderRow and no standalone/legacy shell", () => {
    const src = read(GROUP_3.grader);
    expect(src).toContain('from "@/components/admin/AdminHeaderRow"');
    expect(src).toContain("<AdminHeaderRow");
    expect(src).toContain('testId="grader-header"'); // dashboard header
    expect(src).toContain('testId="grader-grading-breadcrumb"'); // active-card breadcrumb
    // shared design tokens, not raw brand hex or a raw black page ground
    expect(src).toMatch(/bg-\[var\(--admin-bg\)\]/);
    expect(src).not.toMatch(/min-h-screen[^"]*\bbg-black\b(?!\/)/); // no raw black page ground
    expect(src).not.toMatch(/text-slate-\d|bg-slate-\d|border-slate-\d/); // no slate legacy theme
    expect(src).not.toMatch(/#D4AF37|#E8E4DC/); // brand hex converted to var(--admin-*) tokens
  });
  it("grader dashboard preserves its exact /api/grader/* endpoints + PII-free MVGS mount (visual-only pass)", () => {
    const src = read(GROUP_3.grader);
    expect(src).toContain("/api/grader/session");
    expect(src).toContain("/api/grader/queue");
    expect(src).toContain("/api/grader/earnings");
    expect(src).toContain("/api/grader/logout");
    // the real MVGS panel, grader-scoped — apiBase + graderMode untouched
    expect(src).toContain('apiBase="/api/grader"');
    expect(src).toContain("graderMode");
  });
  it("grader login is a pure redirect into the already-unified /staff/login (no bespoke login shell)", () => {
    const src = read(GROUP_3.graderLogin);
    expect(src).toContain('navigate("/staff/login"');
    // no standalone login form re-introduced, no raw brand hex
    expect(src).not.toMatch(/<form\b/);
    expect(src).not.toMatch(/type="password"/);
    expect(src).not.toMatch(/#D4AF37|#E8E4DC/);
  });
});

// Group 3.5 (2026-07-19): the canonical Staff/Grader login surface
// (/staff/login) brought onto the shared design system. This is the ONE
// operator login — /grader/login redirects into it (Group 3), so unifying it
// closes the visual gap the Group-3 report left open. It is a FOCUSED
// unauthenticated page: it must use var(--admin-*) tokens + a raised panel and
// must NOT mount the authenticated AdminShell / AdminHeaderRow / sidebar. Routes
// in the children-form (`<Route path="/staff/login"><StaffLoginPage/></Route>`)
// are not captured by the ROUTE_RE table above, so this block enforces the
// auth-surface directly rather than via isUnified().
const GROUP_3_5 = {
  staffLogin: "client/src/pages/staff-login.tsx",
} as const;

describe("Group 3.5 — canonical Staff/Grader login is on the shared design system (auth-surface enforced)", () => {
  it("staff-login is not silently a legacy exception", () => {
    expect(LEGACY_EXCEPTIONS).not.toHaveProperty(GROUP_3_5.staffLogin);
  });
  it("renders on the shared var(--admin-*) tokens with no raw black ground / brand hex / slate theme", () => {
    const src = read(GROUP_3_5.staffLogin);
    expect(src).toMatch(/bg-\[var\(--admin-bg\)\]/); // shared ground token
    expect(src).toMatch(/bg-\[var\(--admin-panel\)\]/); // raised panel token
    expect(src).toMatch(/text-\[var\(--admin-gold\)\]/); // brand-gold heading token
    expect(src).not.toMatch(/min-h-screen[^"]*\bbg-black\b(?!\/)/); // no raw black page ground
    expect(src).not.toMatch(/text-slate-\d|bg-slate-\d|border-slate-\d/); // no slate legacy theme
    expect(src).not.toMatch(/#D4AF37|#E8E4DC|#0c0c0c/); // brand/panel hex → tokens
  });
  it("stays a FOCUSED login: no authenticated AdminShell / AdminHeaderRow / sidebar", () => {
    const src = read(GROUP_3_5.staffLogin);
    expect(src).not.toMatch(/<AdminShell\b/);
    expect(src).not.toMatch(/<AdminHeaderRow\b/);
    expect(src).not.toMatch(/admin-side\b/); // no sidebar markup
  });
  it("preserves the exact auth contract (endpoint / method / payload / redirect) — visual-only pass", () => {
    const src = read(GROUP_3_5.staffLogin);
    expect(src).toContain('fetch("/api/staff/login"');
    expect(src).toContain('method: "POST"');
    expect(src).toContain('credentials: "include"');
    expect(src).toContain("JSON.stringify({ email, password })");
    expect(src).toContain('navigate("/staff", { replace: true })');
  });
  it("keeps correct password-field semantics + autocomplete + safe generic errors", () => {
    const src = read(GROUP_3_5.staffLogin);
    expect(src).toContain('type="password"');
    expect(src).toContain('autoComplete="current-password"');
    expect(src).toContain('autoComplete="username"');
    // safe, non-technical error copy (no stack/status leakage) + rate-limit branch
    expect(src).toContain("Invalid email or password.");
    expect(src).toContain("res.status === 429");
    expect(src).toContain('role="alert"');
    // no Super Admin claim on the shared operator login
    expect(src).not.toMatch(/super\s*admin/i);
  });
});

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
  // identity editor moved into the workstation (identityEditor slot); bound the
  // overlay slice at the workstation mount instead of the old inline section.
  ADMIN_STAFF.indexOf("<GradingWorkstation")
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
      ADMIN_STAFF.indexOf("<GradingWorkstation")
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
  it("the canonical grading workstation preserves adminReview props (protected-adjacent — visual fix only)", () => {
    const panelBlock = ADMIN_STAFF.slice(
      ADMIN_STAFF.indexOf("<GradingWorkstation"),
      ADMIN_STAFF.indexOf("<GradingWorkstation") + 600
    );
    expect(panelBlock).toContain('mode="admin-review"');
    expect(panelBlock).toContain("adminReview");
    expect(panelBlock).toContain('apiBase="/api/admin/grade-review"');
  });
});
