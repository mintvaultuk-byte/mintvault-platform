/**
 * protected-grader-authority.test.ts
 *
 * ADDITIVE protected-system guard coverage for two blind spots proven by hostile review on
 * 2026-08-07. Nothing here weakens an existing guard: tests/helpers/strip-non-code.ts is
 * untouched, the `calcEngine` / `engine` regexes in the two sibling guards are untouched, and
 * all four founder-authorised server/grader.ts signatures (A, B, C, D) remain exactly as they
 * were. This file only ADDS checks the existing guards structurally could not perform.
 *
 * ── BLIND SPOT 1: the protected-file matcher misses server/routes/grader.ts ─────────────────
 *   /server\/grader/.test("server/routes/grader.ts") === false
 * PR #288 rewrote server/routes/grader.ts — five handlers re-gated requireAdmin →
 * requireSuperAdmin, a new /api/admin/graders/assign-partner endpoint, and partner mirroring
 * wired into approve/reject — and no changed file in that PR matched `calcEngine` at all.
 *
 * The fix is deliberately NOT to add the path to `calcEngine`. That would put a 1,200-line HTTP
 * layer behind a founder signature for every edit — a blanket lock the founder ruled out, and
 * the shape of guard the next engineer disables. What is protected instead is what is actually
 * authority-bearing in that file:
 *   • which middleware gates which route (auth gating),
 *   • that grade AUTHORSHIP stays in the engine rather than being open-coded in a route,
 *   • that approval / rejection run the engine gate and do not swallow a partner mirror
 *     conflict (approval & mirroring),
 *   • that partner assignment is gated and delegated.
 * Everything else in the file — logging, error copy, rate limits, TCGdex lookup, custom sets,
 * the card-tool proxy list — is free to change. That narrowness is PROVEN below, behaviourally,
 * against the real file.
 *
 * ── BLIND SPOT 2: module specifiers are stripped before the token scan ──────────────────────
 * strip-non-code.ts blanks StringLiteral interiors in BOTH modes, so
 *     const seg = ["@shared", "cent" + "ering"].join("/");
 *     const eng = await import(seg);
 * survives both guards with no protected token anywhere. Detection needs the specifier
 * RESOLVED, not merely preserved — see the rationale in tests/helpers/protected-module-refs.ts
 * for why a dedicated pass was chosen over un-blanking string literals (un-blanking would feed
 * attacker-controlled text straight into the signature regexes and re-open N5, and would still
 * miss the concatenated form).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { join } from "path";
import { protectedChangedFiles, protectedDiffFor } from "./helpers/protected-diff";
import { stripNonCode } from "./helpers/strip-non-code";
import { describeProtectedEngineReach, diffProtectedEngineReach } from "./helpers/protected-module-refs";
import { routeRegistrations, authorityOperationsOf, routeKey, type RouteRegistration } from "./helpers/route-auth-map";
import { visibilityOnlyExportChange } from "./helpers/visibility-only-change";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const GRADER_ROUTES = "server/routes/grader.ts";

// ───────────────────────────────────────────────────────────────────────────────────────────
// The authority model for server/routes/grader.ts
// ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Namespaces that are authority-bearing by POSITION as well as by what they call: the
 * super-admin grade-review surface, approval/rejection, and grader/partner assignment. The
 * grade-review GETs and the card-tool proxy carry no authority OPERATION but expose and act on
 * pending_review cards under a super-admin gate, so their gate is pinned too.
 */
const AUTHORITY_PATH =
  /^\/api\/admin\/(grade-review\/|certificates\/:id\/(approve-grader-grade|reject-grade)|graders\/(assign|assign-partner|reassign|unassign)$)/;

/** Gates this codebase recognises as real authorisation (as opposed to a rate limiter). */
const RECOGNISED_GATES = new Set(["requireAdmin", "requireSuperAdmin", 'requireCapability("grade")']);

const isAuthorityRoute = (r: RouteRegistration): boolean =>
  authorityOperationsOf(r).length > 0 || (r.path !== null && AUTHORITY_PATH.test(r.path));

/**
 * The PINNED gate for every authority-bearing route, as reviewed at PR #288.
 *
 * A downgrade (requireSuperAdmin → requireAdmin), a removal, or a new authority route that
 * nobody pinned all fail. This is the only hard-coded list in the guard, and it covers ONLY
 * authority routes — 13 of the file's 34 registrations at the time of writing.
 */
const EXPECTED_GATE: Record<string, string> = {
  // Grader self-service authorship: capability-gated, grader-locked in the handler.
  "PUT /api/grader/certificates/:id/grade": 'requireCapability("grade")',
  "POST /api/grader/certificates/:id/submit": 'requireCapability("grade")',
  "POST /api/grader/certificates/:id/edit-submission": 'requireCapability("grade")',
  // Grader administration.
  "POST /api/admin/graders": "requireAdmin",
  "POST /api/admin/grader-rate": "requireAdmin",
  // Assignment — including the PR #288 partner assignment endpoint.
  "POST /api/admin/graders/assign": "requireAdmin",
  "POST /api/admin/graders/assign-partner": "requireAdmin",
  "POST /api/admin/graders/reassign": "requireAdmin",
  "POST /api/admin/graders/unassign": "requireAdmin",
  // Approval / rejection and the whole super-admin review namespace — PR #288 raised these
  // from requireAdmin to requireSuperAdmin. Pinned so they can never silently drop back.
  "POST /api/admin/certificates/:id/approve-grader-grade": "requireSuperAdmin",
  "POST /api/admin/certificates/:id/reject-grade": "requireSuperAdmin",
  "GET /api/admin/grade-review/certificates/:id/grading": "requireSuperAdmin",
  "GET /api/admin/grade-review/certificates/:id/images": "requireSuperAdmin",
  "PUT /api/admin/grade-review/certificates/:id/grade": "requireSuperAdmin",
  "POST /api/admin/grade-review/certificates/:id/:action": "requireSuperAdmin",
};

/** Columns whose direct mutation IS a grade-authorship decision. */
const GRADE_AUTHORSHIP_WRITE =
  /\b(grade|grade_type|overall_grade|centering_score|corners_score|edges_score|surface_score|grading_status|grader_status|grade_approved_by|grade_approved_at|review_required)\b\s*=/i;

/**
 * The complete authority guard, as a pure function of the file's source, so the tests below can
 * run the SAME predicate against the real file and against deliberately mutated copies. Returns
 * one string per violation; empty means green.
 */
export function authorityViolations(source: string): string[] {
  const problems: string[] = [];
  const routes = routeRegistrations(source);

  if (routes.length === 0) {
    // Fail-closed: a parse that yields no routes must never read as "nothing to check".
    return ["no route registrations found — the guard could not analyse the file"];
  }

  const seen = new Set<string>();
  for (const r of routes) {
    if (!isAuthorityRoute(r)) continue;
    const key = routeKey(r);
    seen.add(key);

    // 1. Every authority route carries a recognised authorisation gate.
    const gates = r.guards.filter((g) => RECOGNISED_GATES.has(g));
    if (gates.length === 0) {
      problems.push(`${key} (line ${r.line}) is authority-bearing but carries no recognised auth gate`);
      continue;
    }
    // 2. …and it is the exact gate that was reviewed.
    const expected = EXPECTED_GATE[key];
    if (expected === undefined) {
      problems.push(`${key} (line ${r.line}) is a NEW authority route — its gate must be reviewed and pinned`);
    } else if (!gates.includes(expected)) {
      problems.push(`${key} (line ${r.line}) gate changed: expected ${expected}, found [${gates.join(", ")}]`);
    }

    // 3. Grade AUTHORSHIP stays in the engine. An admin-namespace authority route must not
    //    open-code a write to a grade / approval column — it must delegate to the imported
    //    grader module, which is where the B3, printability and publish gates live. (The
    //    grader's own /api/grader/* authorship routes legitimately write, via the engine's
    //    applyCertGradeDraft path, so this applies to the admin namespace only.)
    //    The GUARDED representation is used, so tagged SQL text is visible: the JS-only form
    //    deliberately blanks template text, which is exactly where a raw UPDATE would hide.
    if (r.path?.startsWith("/api/admin/") && GRADE_AUTHORSHIP_WRITE.test(r.handlerGuarded)) {
      problems.push(`${key} (line ${r.line}) writes a grade/approval column directly instead of delegating`);
    }
  }

  // 4. Every pinned authority route still exists. Deleting a route to escape its pin fails.
  for (const key of Object.keys(EXPECTED_GATE)) {
    if (!seen.has(key)) problems.push(`pinned authority route ${key} is missing or is no longer recognised`);
  }

  // 5. Approval and rejection run the engine gate and do not swallow a partner mirror conflict.
  //    Reporting a clean approval over a partner work item that did not move is the exact
  //    silent-failure shape this codebase guards against elsewhere.
  for (const [key, engineCall, mirrorCall] of [
    ["POST /api/admin/certificates/:id/approve-grader-grade", "approveGraderCert", "mirrorPartnerApproval"],
    ["POST /api/admin/certificates/:id/reject-grade", "rejectCertGrade", "mirrorPartnerRejection"],
  ] as const) {
    const r = routes.find((x) => routeKey(x) === key);
    if (!r) continue; // already reported by rule 4
    if (!new RegExp(`\\b${engineCall}\\s*\\(`).test(r.handlerCode)) {
      problems.push(`${key} no longer delegates to ${engineCall}() — the engine gate would be bypassed`);
    }
    if (!/\br\.ok\b/.test(r.handlerCode)) {
      problems.push(`${key} no longer short-circuits on the engine's rejection`);
    }
    if (new RegExp(`\\b${mirrorCall}\\s*\\(`).test(r.handlerCode)) {
      // Mirroring is present — its outcome must be INSPECTED and a conflict surfaced, not
      // discarded. Tested against the JS representation and on the discriminant + status CODE,
      // never on the string literal "conflict" (which strip-non-code blanks, by design).
      if (!/\bmirror\s*\.\s*kind\b/.test(r.handlerCode) || !/\b409\b/.test(r.handlerCode)) {
        problems.push(`${key} calls ${mirrorCall}() but does not surface a mirror conflict`);
      }
    }
  }

  // 6. Partner assignment is delegated to partner-owned code, not open-coded here.
  const assign = routes.find((x) => routeKey(x) === "POST /api/admin/graders/assign-partner");
  if (assign && !/\bassignPartnerCerts\s*\(/.test(assign.handlerCode)) {
    problems.push("POST /api/admin/graders/assign-partner no longer delegates to assignPartnerCerts()");
  }

  return problems;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// REQUIRED TEST 1 — server/grader.ts remains protected (existing behaviour, unchanged)
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("server/grader.ts remains protected (existing behaviour, unchanged)", () => {
  it("is still INSIDE the calcEngine matcher of both sibling guards, and routes/grader.ts is not", () => {
    // Pins the exact regex both guards use, so a future edit cannot quietly drop server/grader.ts
    // out of the protected set — and documents, executably, the blind spot this file closes.
    const calcEngine =
      /mvgs-scoring|shared\/pristine|shared\/centering|mvgs-input-builder|server\/grader|grading-prompt|shared\/mvgs-scoring/;
    expect(calcEngine.test("server/grader.ts")).toBe(true);
    expect(calcEngine.test("shared/centering.ts")).toBe(true);
    expect(calcEngine.test("shared/mvgs-scoring.ts")).toBe(true);
    // The proven gap, asserted rather than described.
    expect(calcEngine.test("server/routes/grader.ts")).toBe(false);

    // Both sibling guards still carry all four founder-authorised signatures, unweakened.
    for (const f of ["tests/variant-line-consolidation.test.ts", "tests/structured-variant-persistence.test.ts"]) {
      const src = read(f);
      expect(src, `${f} lost calcEngine coverage of server/grader.ts`).toContain("server\\/grader");
      for (const sig of ["signatureA", "signatureB", "signatureC", "signatureD"]) {
        expect(src, `${f} lost ${sig}`).toContain(sig);
      }
      expect(src).toContain("server/grader.ts changed but matches no founder-authorised signature");
    }
  });

  it("any change to server/grader.ts on this branch still carries no protected-engine module reach", () => {
    const changed = protectedChangedFiles();
    if (!changed.includes("server/grader.ts")) return; // untouched on this branch
    const reach = diffProtectedEngineReach(protectedDiffFor("server/grader.ts"), "+");
    expect(reach, `server/grader.ts reaches the protected calculation engine: ${reach}`).toBe("");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// REQUIRED TEST 2 — authority-sensitive changes to server/routes/grader.ts are protected
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("server/routes/grader.ts — grading AUTHORITY is protected (not the whole file)", () => {
  it("every authority-bearing route carries its reviewed gate, and authorship stays in the engine", () => {
    expect(authorityViolations(read(GRADER_ROUTES))).toEqual([]);
  });

  it("the guard is scoped: it inspects authority routes only, and leaves the rest of the file alone", () => {
    const routes = routeRegistrations(read(GRADER_ROUTES));
    const authority = routes.filter(isAuthorityRoute);
    // Sanity: the file really does have a large non-authority majority, so "narrow" is a fact.
    expect(routes.length).toBeGreaterThan(20);
    expect(authority.length).toBeGreaterThan(8);
    expect(authority.length).toBeLessThan(routes.length);
    // These carry no grading authority and are deliberately NOT governed by this guard.
    for (const p of [
      "/api/staff/tcgdex-lookup",
      "/api/staff/card-search",
      "/api/staff/custom-sets",
      "/api/grader/login",
      "/api/grader/queue",
    ]) {
      const r = routes.find((x) => x.path === p);
      expect(r, `expected to find ${p}`).toBeDefined();
      expect(isAuthorityRoute(r as RouteRegistration), `${p} must not be treated as authority-bearing`).toBe(false);
    }
  });

  it("PR #288's specific authority changes are pinned", () => {
    const routes = routeRegistrations(read(GRADER_ROUTES));
    const gate = (k: string) => routes.find((r) => routeKey(r) === k)?.guards ?? [];
    // the five re-gated handlers
    for (const k of [
      "POST /api/admin/certificates/:id/approve-grader-grade",
      "POST /api/admin/certificates/:id/reject-grade",
      "GET /api/admin/grade-review/certificates/:id/grading",
      "GET /api/admin/grade-review/certificates/:id/images",
      "PUT /api/admin/grade-review/certificates/:id/grade",
      "POST /api/admin/grade-review/certificates/:id/:action",
    ]) {
      expect(gate(k), `${k} must be super-admin gated`).toContain("requireSuperAdmin");
      expect(gate(k), `${k} must not be plain-admin gated`).not.toContain("requireAdmin");
    }
    // the new endpoint, and that it delegates rather than open-coding assignment
    expect(gate("POST /api/admin/graders/assign-partner")).toContain("requireAdmin");
    // mirroring is wired into approve/reject
    const approve = routes.find((r) => routeKey(r) === "POST /api/admin/certificates/:id/approve-grader-grade");
    expect(approve?.handlerCode).toMatch(/\bmirrorPartnerApproval\s*\(/);
    const reject = routes.find((r) => routeKey(r) === "POST /api/admin/certificates/:id/reject-grade");
    expect(reject?.handlerCode).toMatch(/\bmirrorPartnerRejection\s*\(/);
  });

  // ── MUTATION EVIDENCE: the guard goes RED for each thing it claims to protect ────────────
  describe("mutation evidence — the guard fails when authority is violated", () => {
    const SRC = read(GRADER_ROUTES);
    const mutate = (from: string, to: string): string[] => {
      expect(SRC.includes(from), `mutation anchor not found: ${from}`).toBe(true);
      return authorityViolations(SRC.replace(from, to));
    };

    it("RED: approval is downgraded from super-admin to admin", () => {
      const v = mutate(
        '"/api/admin/certificates/:id/approve-grader-grade",\n    requireSuperAdmin,',
        '"/api/admin/certificates/:id/approve-grader-grade",\n    requireAdmin,'
      );
      expect(v.join(" | ")).toMatch(/approve-grader-grade.*expected requireSuperAdmin, found \[requireAdmin\]/);
    });

    it("RED: the review-save gate is removed entirely", () => {
      const v = mutate(
        'app.put("/api/admin/grade-review/certificates/:id/grade", requireSuperAdmin,',
        'app.put("/api/admin/grade-review/certificates/:id/grade",'
      );
      expect(v.join(" | ")).toMatch(/grade-review\/certificates\/:id\/grade.*no recognised auth gate/);
    });

    it("RED: rejection is downgraded", () => {
      const v = mutate(
        'app.post("/api/admin/certificates/:id/reject-grade", requireSuperAdmin,',
        'app.post("/api/admin/certificates/:id/reject-grade", requireAdmin,'
      );
      expect(v.join(" | ")).toMatch(/reject-grade.*expected requireSuperAdmin/);
    });

    it("RED: partner assignment loses its gate", () => {
      const v = mutate(
        'app.post("/api/admin/graders/assign-partner", requireAdmin,',
        'app.post("/api/admin/graders/assign-partner",'
      );
      expect(v.join(" | ")).toMatch(/assign-partner.*no recognised auth gate/);
    });

    it("RED: partner assignment stops delegating to partner-owned code", () => {
      const v = mutate("await assignPartnerCerts(", "await (async () => ({ ok: true, count: 0 }))(");
      expect(v.join(" | ")).toMatch(/assign-partner no longer delegates/);
    });

    it("RED: approval stops delegating to the engine (publish gates bypassed)", () => {
      const v = mutate("const r = await approveGraderCert(certId, adminUser);", "const r = { ok: true } as const;");
      expect(v.join(" | ")).toMatch(/no longer delegates to approveGraderCert/);
    });

    it("RED: a partner mirror conflict is swallowed", () => {
      const v = mutate(
        'if (mirror.kind === "conflict") {\n        return res.status(409).json({ error: "Partner work item changed; refresh and try again" });\n      }',
        "void mirror;"
      );
      expect(v.join(" | ")).toMatch(/does not surface a mirror conflict/);
    });

    it("RED: an authority route open-codes a grade write instead of delegating", () => {
      const v = mutate(
        "const r = await approveGraderCert(certId, adminUser);",
        "await db.execute(sql`UPDATE certificates SET grading_status = 'approved' WHERE id = ${certId}`);\n      const r = await approveGraderCert(certId, adminUser);"
      );
      expect(v.join(" | ")).toMatch(/writes a grade\/approval column directly/);
    });

    it("RED: a NEW ungated authority endpoint is added", () => {
      const v = mutate(
        'app.post("/api/admin/graders/unassign", requireAdmin,',
        'app.post("/api/admin/graders/backdoor-approve", async (req: Request, res: Response) => {\n    return res.json(await approveGraderCert(1, "x"));\n  });\n  app.post("/api/admin/graders/unassign", requireAdmin,'
      );
      expect(v.join(" | ")).toMatch(/backdoor-approve.*no recognised auth gate/);
    });

    it("RED: a pinned authority route is deleted to escape its pin", () => {
      const v = mutate(
        'app.post("/api/admin/certificates/:id/reject-grade", requireSuperAdmin,',
        'app.post("/api/admin/certificates/:id/reject-grade-v2", requireAdmin,'
      );
      expect(v.join(" | ")).toMatch(
        /pinned authority route POST \/api\/admin\/certificates\/:id\/reject-grade is missing/
      );
    });

    it("RED: a comment or error string cannot fake a gate (gates are read as CODE)", () => {
      const v = mutate(
        'app.post("/api/admin/certificates/:id/reject-grade", requireSuperAdmin,',
        'app.post("/api/admin/certificates/:id/reject-grade", requireAdmin, /* requireSuperAdmin */'
      );
      expect(v.join(" | ")).toMatch(/reject-grade.*expected requireSuperAdmin/);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// REQUIRED TEST 3 — dynamic imports cannot evade detection via stripped string literals
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("dynamic imports of protected grading modules cannot evade the guards", () => {
  it("the blind spot is real: strip-non-code blanks a module specifier in BOTH modes", () => {
    // Documented executably so nobody 'fixes' this file without understanding why it exists.
    const src = 'const eng = await import("@shared/centering");';
    expect(stripNonCode(src)).not.toMatch(/centering/);
    // …and the demonstrated concatenation form leaves no protected token at all.
    const joined = 'const seg = ["@shared", "cent" + "ering"].join("/");\nconst eng = await import(seg);';
    expect(stripNonCode(joined)).not.toMatch(/centering/);
  });

  it("the new resolver catches the demonstrated bypass, in every form", () => {
    const caught = (src: string) => describeProtectedEngineReach(src);
    // the exact form from the hostile review
    expect(caught('const seg = ["@shared", "cent" + "ering"].join("/");\nconst eng = await import(seg);')).toMatch(
      /@shared\/centering/
    );
    // plain dynamic import
    expect(caught('const m = await import("@shared/mvgs-scoring");')).toMatch(/mvgs-scoring/);
    // concatenation
    expect(caught('const m = await import("@shared/" + "pristine");')).toMatch(/@shared\/pristine/);
    // template literal
    expect(caught("const p = `@shared`;\nconst m = await import(`${p}/mvgs-input-builder`);")).toMatch(
      /mvgs-input-builder/
    );
    // .concat
    expect(caught('const m = await import("@shared/".concat("centering"));')).toMatch(/@shared\/centering/);
    // require, including a chained binding
    expect(caught('const a = "@shared"; const b = a + "/pristine"; const m = require(b);')).toMatch(
      /@shared\/pristine/
    );
    // static declaration and re-export
    expect(caught('import { x } from "@shared/centering";')).toMatch(/@shared\/centering/);
    expect(caught('export { x } from "../lib/cert-pristine";')).toMatch(/cert-pristine/);
    // import equals
    expect(caught('import m = require("@shared/mvgs-scoring");')).toMatch(/mvgs-scoring/);
    // a query-suffix dodge
    expect(caught('const m = await import("@shared/centering?raw");')).toMatch(/centering/);
  });

  it("FAIL-CLOSED: a dynamic specifier the resolver cannot fold is a failure, not a pass", () => {
    expect(describeProtectedEngineReach("const m = await import(pickModule(req.body.name));")).toMatch(/unresolvable/);
    expect(describeProtectedEngineReach("const m = require(process.env.MOD as string);")).toMatch(/unresolvable/);
    // a name assigned twice is ambiguous — refused rather than guessed
    expect(describeProtectedEngineReach('let s = "./a"; s = "@shared/centering"; await import(s);')).toMatch(
      /unresolvable/
    );
  });

  it("it does NOT fire on the ordinary imports these files legitimately make", () => {
    // Every real module reference in the PROTECTED files must be clean, or the guard over-fires
    // on shipped code — the disqualifying failure mode.
    //
    // Scope note: server/partner/grading-routes.ts is deliberately NOT asserted here. It is not
    // a protected file, and a server-authority adapter moving MVGS scoring server-side would
    // legitimately import @shared/mvgs-scoring — asserting on it would make this guard block
    // exactly the work it is not entitled to govern.
    for (const f of ["server/grader.ts", GRADER_ROUTES]) {
      expect(describeProtectedEngineReach(read(f)), `${f} tripped the module-reach guard`).toBe("");
    }
    // and on representative benign references
    for (const src of [
      'import { db } from "../db";',
      'const { lookupCard } = await import("../card-database");',
      'const { repairEmptyIdentityFromSnapshot } = await import("../scan-ingest-service");',
      'import { checkPrintableGrade } from "@shared/printable-grade";',
      'import { storage } from "./storage";',
      // names that merely CONTAIN a protected word but are not the engine module
      'import { x } from "./grading-panel";',
      'import { y } from "./centering-ui-helpers";',
    ]) {
      expect(describeProtectedEngineReach(src), `false positive on: ${src}`).toBe("");
    }
  });

  it("the check is WIRED to the protected files on this branch, not merely available", () => {
    // The guard must actually run against the real diffs — an unused helper protects nothing.
    for (const f of ["server/grader.ts", GRADER_ROUTES]) {
      if (!protectedChangedFiles().includes(f)) continue;
      const reach = diffProtectedEngineReach(protectedDiffFor(f), "+");
      expect(reach, `${f} added a protected-engine module reach: ${reach}`).toBe("");
    }
    // …and the whole current file, not just its diff, stays clean.
    expect(describeProtectedEngineReach(read(GRADER_ROUTES))).toBe("");
  });

  it("MUTATION: injecting the bypass into the real route file turns the check RED", () => {
    const injected = read(GRADER_ROUTES).replace(
      'import { db } from "../db";',
      'import { db } from "../db";\nconst seg = ["@shared", "cent" + "ering"].join("/");\nconst eng = await import(seg);'
    );
    expect(describeProtectedEngineReach(injected)).toMatch(/@shared\/centering/);
    // and the pre-existing token scanners genuinely do NOT catch it — the gap being closed
    expect(stripNonCode(injected)).not.toMatch(/@shared\/centering/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// REQUIRED TEST 4 — unrelated route edits do NOT trip the guard
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("NARROWNESS — benign edits to server/routes/grader.ts pass", () => {
  const SRC = read(GRADER_ROUTES);
  /** A benign edit passes both halves of the new coverage. */
  const green = (src: string) => ({
    authority: authorityViolations(src),
    moduleReach: describeProtectedEngineReach(src),
  });

  it("baseline: the file as shipped is green on both halves", () => {
    expect(green(SRC)).toEqual({ authority: [], moduleReach: "" });
  });

  const benign: Array<[string, (s: string) => string]> = [
    [
      "adding a comment",
      (s) => s.replace("export function registerGraderRoutes", "// housekeeping\nexport function registerGraderRoutes"),
    ],
    [
      "rewording an operator-facing error message",
      (s) => s.replace('{ error: "Certificate not found" }', '{ error: "That certificate could not be found" }'),
    ],
    [
      "adding a NON-authority read endpoint",
      (s) =>
        s.replace(
          'app.get("/api/admin/graders", requireAdmin,',
          'app.get("/api/admin/grader-help", async (_req: Request, res: Response) => res.json({ ok: true }));\n  app.get("/api/admin/graders", requireAdmin,'
        ),
    ],
    [
      "adding a rate limiter to an authority route (an extra, not a replacement)",
      (s) =>
        s.replace(
          'app.post("/api/admin/certificates/:id/reject-grade", requireSuperAdmin,',
          'app.post("/api/admin/certificates/:id/reject-grade", requireSuperAdmin, rejectGradeRateLimit,'
        ),
    ],
    [
      "adding a benign dynamic import",
      (s) =>
        s.replace(
          'import { db } from "../db";',
          'import { db } from "../db";\nconst u = await import("../lib/format-utils");'
        ),
    ],
    ["changing a card-tool proxy action name", (s) => s.replace("GRADER_PROXY_ACTIONS", "GRADER_PROXY_ACTIONS_V2")],
    [
      "adding logging inside an authority handler",
      (s) =>
        s.replace(
          "const r = await approveGraderCert(certId, adminUser);",
          'console.info("approve requested", certId);\n      const r = await approveGraderCert(certId, adminUser);'
        ),
    ],
    [
      "reindenting an authority handler (PR #288 did exactly this)",
      (s) =>
        s.replace(
          'app.post("/api/admin/certificates/:id/reject-grade", requireSuperAdmin, async (req: Request, res: Response) => {',
          'app.post(\n    "/api/admin/certificates/:id/reject-grade",\n    requireSuperAdmin,\n    async (req: Request, res: Response) => {'
        ),
    ],
  ];

  for (const [name, edit] of benign) {
    it(`benign edit passes: ${name}`, () => {
      const result = green(edit(SRC));
      expect(result.authority, `${name} should not trip the authority guard`).toEqual([]);
      expect(result.moduleReach, `${name} should not trip the module-reach guard`).toBe("");
    });
  }

  it("NEGATIVE PROOF: bundling a real scoring change alongside a benign edit is still REJECTED", () => {
    // The narrowness above must not become permission. A guard-shaped edit plus real grading
    // mathematics must still fail — proven against the SAME predicates the sibling guards use,
    // so this is the actual production rule, not a restatement of it.
    const identifiers =
      /computeMvgsScore|scoreMvgsV2|mvgsTierName|gradeFromMvgsScore|loadMvgsCalibration|isPristine|mvgs|calibration|WEIGHT|weight\s*[:=]|deduction\s*[:=]|penalt/i;
    const gradeIdent = /(grade|overall|centering|corners|edges|surface|subgrade|score)/i;
    const arithmetic = /[+\-*/]\s*-?\d|\d\s*[+\-*/]|Math\.(min|max|round|floor|ceil|abs|pow)/;
    const judge = (line: string): boolean => {
      const code = stripNonCode(line).trim();
      if (!code) return true;
      if (identifiers.test(code)) return false;
      if (gradeIdent.test(code) && arithmetic.test(code)) return false;
      return true;
    };
    // real scoring changes — rejected
    expect(judge("const overall = Math.min(10, c * 0.35 + co * 0.25 + e * 0.2 + s * 0.2);")).toBe(false);
    expect(judge("const penalty = defects.length * 0.5; grade -= penalty;")).toBe(false);
    expect(judge("const w = { centering: 0.4 * base, corners: 0.2 * base };")).toBe(false);
    // and the module-reach half rejects the stripped-literal route into the engine
    expect(
      describeProtectedEngineReach('const s = ["mvgs", "scoring"].join("-");\nawait import("@shared/" + s);')
    ).toMatch(/@shared\/mvgs-scoring/);

    // Bundling: benign edit + scoring change → the scoring line is still caught.
    const bundled = benign[0][1](SRC) + "\nconst overall = c * 0.35 + co * 0.25;\n";
    const offending = bundled.split("\n").filter((l) => !judge(l));
    expect(offending.length, "the bundled scoring change must still be caught").toBeGreaterThan(0);
  });

  it("NEGATIVE PROOF: the new coverage does not fail any previously-passing legitimate change", () => {
    // Every PROTECTED file this branch legitimately changed is green under the new checks. If
    // the additions made a legitimate change fail, this is where it would show.
    for (const f of ["server/grader.ts", GRADER_ROUTES]) {
      expect(describeProtectedEngineReach(read(f)), `${f}`).toBe("");
    }
    expect(authorityViolations(read(GRADER_ROUTES))).toEqual([]);
    // …and PR #288's real diff — the change that motivated this file — passes it.
    if (protectedChangedFiles().includes(GRADER_ROUTES)) {
      expect(diffProtectedEngineReach(protectedDiffFor(GRADER_ROUTES), "both")).toBe("");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// The shared/mvgs-scoring.ts visibility-only exemption (owner-approved 2026-08-07)
//
// The exemption admits ONE shape of change — an `export` keyword being added — and nothing
// else. These are the permanent self-tests that stop it silently widening, in the same idiom
// as the signature-D self-test in tests/variant-line-consolidation.test.ts.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("shared/mvgs-scoring.ts — the visibility-only export exemption is genuinely narrow", () => {
  /** Build a unified diff body from paired removed/added lines. */
  const asDiff = (removed: string[], added: string[]) =>
    ["--- a/shared/mvgs-scoring.ts", "+++ b/shared/mvgs-scoring.ts", "@@ -315,7 +315,7 @@"]
      .concat(removed.map((l) => `-${l}`))
      .concat(added.map((l) => `+${l}`))
      .join("\n");

  /** The REAL authorised change, verbatim from rep/server-authority (commit 5bedfd2f). */
  const REAL = asDiff(
    ["function remainingToGrade(remaining: number): number {"],
    ["export function remainingToGrade(remaining: number): number {"]
  );

  // ── PROOF 1 ───────────────────────────────────────────────────────────────────────────
  it("PROOF 1: the actual remainingToGrade export change is ACCEPTED", () => {
    const v = visibilityOnlyExportChange(REAL);
    expect(v.reason).toBe("pure visibility-only export change");
    expect(v.ok).toBe(true);
    expect(v.hasNumericLiteral).toBe(false);
    expect(v.imageIdentical).toBe(true);
    expect(v.exportWidened).toBe(true);
  });

  // ── PROOF 2 — numeric changes stay REJECTED ───────────────────────────────────────────
  it("PROOF 2: a bucket THRESHOLD change is still REJECTED", () => {
    const v = visibilityOnlyExportChange(
      asDiff(["  if (remaining >= 23) return 10;"], ["  if (remaining >= 22) return 10;"])
    );
    expect(v.ok).toBe(false);
    expect(v.hasNumericLiteral).toBe(true);
    expect(v.reason).toMatch(/numeric literal/);
  });

  it("PROOF 2: a DEDUCTION constant change is still REJECTED", () => {
    const v = visibilityOnlyExportChange(
      asDiff(["const SURFACE_MAJOR_DEDUCTION = 3.5;"], ["const SURFACE_MAJOR_DEDUCTION = 2.5;"])
    );
    expect(v.ok).toBe(false);
    expect(v.hasNumericLiteral).toBe(true);
  });

  it("PROOF 2: a threshold change RIDING ALONGSIDE the authorised export is still REJECTED", () => {
    // The realistic attack: bundle the maths change with the approved one.
    const v = visibilityOnlyExportChange(
      asDiff(
        ["function remainingToGrade(remaining: number): number {", "  if (remaining >= 23) return 10;"],
        ["export function remainingToGrade(remaining: number): number {", "  if (remaining >= 22) return 10;"]
      )
    );
    expect(v.ok).toBe(false);
  });

  it("PROOF 2: a number smuggled as a string, template, hex or unicode escape is still REJECTED", () => {
    // Raw-text digit scanning (rather than an AST NumericLiteral scan) is what closes these.
    for (const line of [
      '  if (remaining >= parseInt("23")) return 10;',
      "  if (remaining >= Number(`23`)) return 10;",
      "  if (remaining >= 0x17) return 10;",
      '  if (remaining >= Number("\\u0032\\u0033")) return 10;',
    ]) {
      const v = visibilityOnlyExportChange(asDiff(["  if (remaining >= LIMIT) return TEN;"], [line]));
      expect(v.ok, `should have been rejected: ${line}`).toBe(false);
      expect(v.hasNumericLiteral, `digit not seen in: ${line}`).toBe(true);
    }
  });

  // ── PROOF 3 — non-numeric but dangerous changes stay REJECTED ─────────────────────────
  it("PROOF 3: a COMPARISON-OPERATOR flip is still REJECTED", () => {
    const v = visibilityOnlyExportChange(
      asDiff(["  if (remaining >= LIMIT) return TOP;"], ["  if (remaining > LIMIT) return TOP;"])
    );
    expect(v.ok).toBe(false);
    expect(v.imageIdentical).toBe(false);
  });

  it("PROOF 3: REORDERING the bucket returns is still REJECTED", () => {
    // Digit-free reordering. Order matters because the buckets are evaluated top-down. Note the
    // multiset predicate says TRUE here — it is image identity that rejects it.
    const v = visibilityOnlyExportChange(
      asDiff(
        ["  if (remaining >= HIGH) return TOP;", "  if (remaining >= MID) return MIDGRADE;"],
        ["  if (remaining >= MID) return MIDGRADE;", "  if (remaining >= HIGH) return TOP;"]
      )
    );
    expect(v.ok).toBe(false);
    expect(v.bodyUnchanged, "the defeated multiset predicate is blind to a reorder").toBe(true);
    expect(v.imageIdentical, "image identity is what rejects a reorder").toBe(false);
  });

  it("PROOF 3: a digit-free ARITHMETIC change is still REJECTED", () => {
    const v = visibilityOnlyExportChange(asDiff(["  const g = base;"], ["  const g = base - penalty;"]));
    expect(v.ok).toBe(false);
    expect(v.hasNumericLiteral).toBe(false); // the owner's condition alone would MISS this…
    expect(v.imageIdentical).toBe(false); // …image identity catches it
  });

  it("PROOF 3: a dynamic import into a protected module is still caught by the specifier resolver", () => {
    // The exemption is conjunctive with the module-reach check at both call sites, so a
    // digit-free, export-shaped diff that ALSO reaches into another engine still fails.
    const sneaky = asDiff(
      ["function remainingToGrade(remaining: number): number {"],
      [
        "export function remainingToGrade(remaining: number): number {",
        '  const seg = ["@shared", "cent" + "ering"].join("/");',
        "  void import(seg);",
      ]
    );
    // …the visibility check alone rejects it (the body changed)…
    expect(visibilityOnlyExportChange(sneaky).ok).toBe(false);
    // …and independently, the specifier resolver bites.
    expect(diffProtectedEngineReach(sneaky, "both")).toMatch(/@shared\/centering/);
  });

  it("PROOF 3: REMOVING an export (narrowing) or swapping another keyword is REJECTED", () => {
    expect(
      visibilityOnlyExportChange(
        asDiff(
          ["export function remainingToGrade(r: number): number {"],
          ["function remainingToGrade(r: number): number {"]
        )
      ).ok
    ).toBe(false);
    expect(visibilityOnlyExportChange(asDiff(["const bucket = table;"], ["let bucket = table;"])).ok).toBe(false);
    // an empty diff is not an exemption
    expect(visibilityOnlyExportChange("").ok).toBe(false);
  });

  // ── PROOF 4 — every condition is individually load-bearing ────────────────────────────
  it("PROOF 4: each condition is load-bearing — dropping it lets something through", () => {
    // The signature-D idiom: prove the conjunction is real by removing one term at a time.

    // (a) NUMERIC-LITERAL condition. Without it, a digit-bearing line rides in on the
    //     export shape. `export const BUCKET_TOP = 23;` is body-identical and export-widening,
    //     so ONLY condition 1 stops it — and a line that carries a threshold constant is
    //     exactly where a threshold gets edited.
    const digitBearing = visibilityOnlyExportChange(
      asDiff(["const BUCKET_TOP = 23;"], ["export const BUCKET_TOP = 23;"])
    );
    expect(digitBearing.ok, "condition 1 must reject a digit-bearing line").toBe(false);
    expect(digitBearing.bodyUnchanged && digitBearing.exportWidened, "…and only condition 1 rejects it").toBe(true);

    // (b) BODY-IDENTITY condition. Without it, the owner's numeric condition ALONE admits a
    //     real, digit-free mathematics change. This is why the implementation is stricter than
    //     the stated minimum, and it is declared rather than assumed.
    const mathsNoDigits = visibilityOnlyExportChange(
      asDiff(["  const g = base;"], ["export const noop = 0;", "  const g = base - penalty;"].slice(1))
    );
    expect(mathsNoDigits.hasNumericLiteral, "owner's condition alone sees nothing here").toBe(false);
    expect(mathsNoDigits.ok, "the full conjunction still rejects it").toBe(false);

    // (c) IMAGE-IDENTITY condition. This is the one the hostile reviewer defeated when it was
    //     a sorted multiset comparison. A pure reordering is digit-free AND multiset-identical,
    //     so ONLY image identity rejects it — and bucket order is evaluation order.
    const reorder = visibilityOnlyExportChange(asDiff(["  a();", "  b();"], ["  b();", "  a();"]));
    expect(reorder.hasNumericLiteral, "condition 1 sees nothing in a reorder").toBe(false);
    expect(reorder.bodyUnchanged, "the OLD multiset predicate is blind to a reorder").toBe(true);
    expect(reorder.imageIdentical, "…image identity is what rejects it").toBe(false);
    expect(reorder.ok).toBe(false);
  });

  it("PROOF 4: the exemption is wired to shared/mvgs-scoring.ts ONLY", () => {
    // The other protected engine files are NOT exempted. Both guards must still block them by
    // path, with no exemption branch of their own.
    for (const f of ["tests/variant-line-consolidation.test.ts", "tests/structured-variant-persistence.test.ts"]) {
      const src = read(f);
      expect(src, `${f} is missing the mvgs-scoring exemption`).toContain('f === "shared/mvgs-scoring.ts"');
      for (const other of ["shared/centering.ts", "shared/pristine.ts", "shared/mvgs-input-builder.ts"]) {
        expect(src, `${f} must NOT exempt ${other}`).not.toContain(`f === "${other}"`);
      }
      // the path block itself is untouched — the exemption is conditional, not a removal
      expect(src).toContain("mvgs-scoring");
      expect(src).toContain("visibilityOnlyExportChange");
    }
    // …and the exemption helper is generic, so this is the only thing keeping scope narrow.
    expect(read("tests/helpers/visibility-only-change.ts")).toContain("WIRED to `shared/mvgs-scoring.ts` alone");
  });

  it("PROOF 4: the exemption did not disturb founder signatures A-D", () => {
    for (const f of ["tests/variant-line-consolidation.test.ts", "tests/structured-variant-persistence.test.ts"]) {
      const src = read(f);
      for (const sig of ["signatureA", "signatureB", "signatureC", "signatureD"]) {
        expect(src, `${f} lost ${sig}`).toContain(sig);
      }
      expect(src).toContain("server/grader.ts changed but matches no founder-authorised signature");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// REGRESSION — the hostile reviewer's reorder bypass (HIGH, 2026-08-07)
//
// The first exemption compared added/removed line bodies as SORTED multisets, so a pure
// REORDERING was "body-identical". Bundled with the authorised `export` addition it satisfied
// every condition and the guard returned ok:true on a payload that removes the structural
// ceiling from the final grade. These tests pin the closure permanently, using REAL git diffs
// against the REAL engine file rather than synthetic strings.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("REGRESSION: the reorder bypass of the mvgs-scoring exemption is closed", () => {
  const ENGINE = "shared/mvgs-scoring.ts";

  /** A genuine `git diff` between the real engine file and a mutated copy of it. */
  const realDiff = (mutate: (src: string) => string): string => {
    const original = read(ENGINE);
    const mutated = mutate(original);
    expect(mutated, "the mutation did not apply — the anchor text has moved").not.toBe(original);
    const dir = mkdtempSync(join(tmpdir(), "mv-guard-"));
    const a = join(dir, "before.ts");
    const b = join(dir, "after.ts");
    try {
      writeFileSync(a, original);
      writeFileSync(b, mutated);
      try {
        // --no-index always exits 1 when files differ, so the diff arrives via the error.
        execFileSync("git", ["diff", "--no-index", "--unified=3", a, b], { encoding: "utf8" });
        return "";
      } catch (e: any) {
        return String(e.stdout ?? "");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** The reviewer's exact payload: export worstCeiling AND move the ceiling cap below finalGrade. */
  const CEILING_LINE = "  if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);";
  const reviewerPayload = (src: string): string =>
    src
      .replace(
        "function worstCeiling(...ceilings: Array<MvgsCeiling | null>): MvgsCeiling | null {",
        "export function worstCeiling(...ceilings: Array<MvgsCeiling | null>): MvgsCeiling | null {"
      )
      .replace(
        [
          CEILING_LINE,
          "",
          "  const scoreGrade = gradeFromMvgsScore(score);",
          "  const finalGrade = Math.min(scoreGrade, maxGrade);",
        ].join("\n"),
        [
          "",
          "  const scoreGrade = gradeFromMvgsScore(score);",
          "  const finalGrade = Math.min(scoreGrade, maxGrade);",
          CEILING_LINE,
        ].join("\n")
      );

  it("PROOF 1: the reviewer's exact reorder payload is REJECTED", () => {
    const diff = realDiff(reviewerPayload);
    // The payload really is what the reviewer described: the ceiling line moves below finalGrade.
    expect(diff).toContain("-  if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);");
    expect(diff).toContain("+  if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);");
    expect(diff).toContain("+export function worstCeiling(");

    const v = visibilityOnlyExportChange(diff);
    expect(v.ok, `the reorder payload must be rejected — got: ${v.reason}`).toBe(false);
    expect(v.imageIdentical, "image identity must be what rejects it").toBe(false);
    expect(v.reason).toMatch(/moved or changed/);
  });

  it("PROOF 4: order sensitivity is LOAD-BEARING — without it the payload slips through", () => {
    // Evaluate the exemption with the ordering condition removed, i.e. exactly the pre-fix
    // predicate (digit-free AND multiset-identical AND export-widened). It passes — which is
    // precisely the bypass the reviewer exploited.
    const v = visibilityOnlyExportChange(realDiff(reviewerPayload));
    const preFixVerdict = !v.hasNumericLiteral && v.bodyUnchanged && v.exportWidened;
    expect(preFixVerdict, "the PRE-FIX conjunction must demonstrably admit the payload").toBe(true);
    // …and the shipped conjunction, which adds image identity, rejects it.
    expect(v.ok).toBe(false);
  });

  it("the reviewer's two SUGGESTED fixes would NOT have closed this, which is why context is used", () => {
    // "compare added/removed as ORDERED sequences" and "strict line-for-line pairing" both fail
    // here: the moved line is TEXTUALLY IDENTICAL on both sides, so removed[0] === added[0].
    // Only comparing against the unchanged CONTEXT reveals that its position changed.
    const diff = realDiff(reviewerPayload);
    const added = diff
      .split("\n")
      .filter((l) => l[0] === "+" && !l.startsWith("+++"))
      .map((l) => l.slice(1));
    const removed = diff
      .split("\n")
      .filter((l) => l[0] === "-" && !l.startsWith("---"))
      .map((l) => l.slice(1));
    const norm = (s: string) => s.replace(/\bexport\s+/g, "").replace(/\s+$/, "");
    const orderedPairingPasses = added.length === removed.length && added.every((v, i) => norm(v) === norm(removed[i]));
    expect(orderedPairingPasses, "ordered pairing alone would have PASSED the payload").toBe(true);
    // The shipped check, which reads context, rejects it.
    expect(visibilityOnlyExportChange(diff).ok).toBe(false);
  });

  it("PROOF 2: adding `export` to a function is ACCEPTED as a real git diff with context", () => {
    // A faithful reproduction of commit 5bedfd2f's diff against the REAL engine file, with real
    // context lines: the file as it stands has no export on remainingToGrade, and the authorised
    // change adds one. Over-tightening would show up here as a false rejection.
    const diff = realDiff((src) =>
      src.replace(
        "function remainingToGrade(remaining: number): number {",
        "export function remainingToGrade(remaining: number): number {"
      )
    );
    expect(diff).toContain("-function remainingToGrade(remaining: number): number {");
    expect(diff).toContain("+export function remainingToGrade(remaining: number): number {");
    // real context lines are present, so this exercises the image comparison properly
    expect(diff).toContain("  if (remaining >= 23) return 10;");
    const v = visibilityOnlyExportChange(diff);
    expect(v.ok, `the authorised export must still be accepted - got: ${v.reason}`).toBe(true);
    expect(v.imageIdentical).toBe(true);
    expect(v.hasNumericLiteral, "context lines carry digits but are NOT changed lines").toBe(false);
  });

  it("a reorder that does NOT ride alongside an export is rejected too (context, not luck)", () => {
    const diff = realDiff((src) =>
      src.replace(
        [CEILING_LINE, "", "  const scoreGrade = gradeFromMvgsScore(score);"].join("\n"),
        ["", "  const scoreGrade = gradeFromMvgsScore(score);", CEILING_LINE].join("\n")
      )
    );
    const v = visibilityOnlyExportChange(diff);
    expect(v.ok).toBe(false);
    expect(v.imageIdentical).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// REGRESSION — the SECOND reviewer's reorder payloads, and the `++` content blind spot
//
// A second independent reviewer confirmed the same ordering hole with two more payloads. Their
// literal symbol names (`applyFloorRule`, `clampToCeiling`, and PRISTINE/BLACK return branches)
// do NOT exist in this engine — they describe a different vintage of the file. Reproduced here
// in KIND against the real source: two adjacent, DIGIT-FREE, order-dependent statements swapped
// and bundled with the authorised export. Digit-free is what makes them genuine bypasses of the
// pre-fix guard rather than things condition 1 would have caught anyway.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("REGRESSION: the second reviewer's reorder payloads are rejected", () => {
  const ENGINE = "shared/mvgs-scoring.ts";
  const EXPORT_WORST = [
    "function worstCeiling(...ceilings: Array<MvgsCeiling | null>): MvgsCeiling | null {",
    "export function worstCeiling(...ceilings: Array<MvgsCeiling | null>): MvgsCeiling | null {",
  ] as const;

  const realDiff = (mutate: (src: string) => string): string => {
    const original = read(ENGINE);
    const mutated = mutate(original);
    expect(mutated, "the mutation did not apply — the anchor text has moved").not.toBe(original);
    const dir = mkdtempSync(join(tmpdir(), "mv-guard-"));
    const a = join(dir, "before.ts");
    const b = join(dir, "after.ts");
    try {
      writeFileSync(a, original);
      writeFileSync(b, mutated);
      try {
        execFileSync("git", ["diff", "--no-index", "--unified=3", a, b], { encoding: "utf8" });
        return "";
      } catch (e: any) {
        return String(e.stdout ?? "");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** ATTACK1 — floor/ceiling APPLICATION ORDER. Swapping these two makes the clamp read
   *  `ceiling` before it is assigned, i.e. the structural ceiling stops constraining maxGrade. */
  const CEILING_DECL = "  const ceiling = worstCeiling(cCrease, cWrinkle, tearResult.ceiling);";
  const CEILING_CLAMP = "  if (ceiling) maxGrade = Math.min(maxGrade, ceiling.grade);";
  const attack1 = (src: string) =>
    src
      .replace(EXPORT_WORST[0], EXPORT_WORST[1])
      .replace([CEILING_DECL, CEILING_CLAMP].join("\n"), [CEILING_CLAMP, CEILING_DECL].join("\n"));

  /** ATTACK2 — swap a RETURN branch above the loop that computes it, so worstCeiling() always
   *  returns null and every crease / wrinkle / tear ceiling disappears. */
  const WORST_BODY = [
    "  let worst: MvgsCeiling | null = null;",
    "  for (const c of ceilings) {",
    "    if (c && (!worst || c.grade < worst.grade)) worst = c;",
    "  }",
    "  return worst;",
  ];
  const attack2 = (src: string) =>
    src
      .replace(EXPORT_WORST[0], EXPORT_WORST[1])
      .replace(
        WORST_BODY.join("\n"),
        [WORST_BODY[0], WORST_BODY[4], WORST_BODY[1], WORST_BODY[2], WORST_BODY[3]].join("\n")
      );

  for (const [name, payload] of [
    ["ATTACK1 (floor/ceiling application order)", attack1],
    ["ATTACK2 (return branch hoisted above its loop)", attack2],
  ] as const) {
    it(`${name} is REJECTED, and image identity is what rejects it`, () => {
      const diff = realDiff(payload);
      expect(diff).toContain("+export function worstCeiling(");
      const v = visibilityOnlyExportChange(diff);
      expect(v.ok, `${name} must be rejected — got: ${v.reason}`).toBe(false);
      expect(v.imageIdentical, `${name}: image identity must be the rejecting condition`).toBe(false);
      expect(v.reason).toMatch(/moved or changed/);
    });

    it(`${name} DEFEATED the pre-fix guard — proving order sensitivity is load-bearing`, () => {
      const v = visibilityOnlyExportChange(realDiff(payload));
      // The pre-fix conjunction: digit-free AND multiset-identical AND export-widened.
      expect(v.hasNumericLiteral, `${name} is digit-free, so condition 1 never saw it`).toBe(false);
      expect(v.bodyUnchanged, `${name} is multiset-identical, so the OLD condition 2 passed it`).toBe(true);
      expect(v.exportWidened, `${name} rides alongside the authorised export`).toBe(true);
      const preFix = !v.hasNumericLiteral && v.bodyUnchanged && v.exportWidened;
      expect(preFix, "the PRE-FIX guard must demonstrably have returned ok:true").toBe(true);
      // …and the shipped guard rejects it.
      expect(v.ok).toBe(false);
    });
  }

  it("the authorised export is STILL accepted alongside these negatives (no over-tightening)", () => {
    const v = visibilityOnlyExportChange(
      realDiff((src) =>
        src.replace(
          "function remainingToGrade(remaining: number): number {",
          "export function remainingToGrade(remaining: number): number {"
        )
      )
    );
    expect(v.ok, `the owner-approved change must still pass — got: ${v.reason}`).toBe(true);
  });
});

describe("REGRESSION: a changed line whose CONTENT starts with ++ or -- is not mistaken for a header", () => {
  // Second reviewer, LOW. The old parser stripped `+++`/`---` by TEXT on every line, so a
  // column-0 `++someObj.field;` arrived as `+++someObj.field;` and was discarded as a file
  // header — invisible to BOTH the digit scan and the body check. Header detection is now
  // POSITIONAL: only the preamble before the first `@@` can hold metadata.
  const withPreamble = (hunkBody: string[]) =>
    [
      "diff --git a/shared/mvgs-scoring.ts b/shared/mvgs-scoring.ts",
      "index 1111111..2222222 100644",
      "--- a/shared/mvgs-scoring.ts",
      "+++ b/shared/mvgs-scoring.ts",
      "@@ -1,3 +1,3 @@",
    ]
      .concat(hunkBody)
      .join("\n");

  it("an added `++…` line IS seen by the digit scan", () => {
    const diff = withPreamble([" context();", "+++maxGrade = 9;", "-  const x = y;"]);
    const v = visibilityOnlyExportChange(diff);
    expect(v.hasNumericLiteral, "the ++ line carries a digit and must be seen").toBe(true);
    expect(v.ok).toBe(false);
  });

  it("an added `++…` line IS seen by the image comparison", () => {
    // Digit-free, so ONLY the image check can catch it.
    const diff = withPreamble([" context();", "++maxGrade;"]);
    const v = visibilityOnlyExportChange(diff);
    expect(v.hasNumericLiteral).toBe(false);
    expect(v.imageIdentical, "an inserted line changes the hunk image").toBe(false);
    expect(v.ok).toBe(false);
  });

  it("a removed `--…` line is likewise seen", () => {
    const diff = withPreamble([" context();", "---maxGrade;"]);
    const v = visibilityOnlyExportChange(diff);
    expect(v.imageIdentical).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("the real `+++`/`---` file headers are still treated as metadata, not content", () => {
    // The authorised change carries a full git preamble and must still be accepted.
    const diff = withPreamble([
      " /** doc */",
      "-function remainingToGrade(remaining: number): number {",
      "+export function remainingToGrade(remaining: number): number {",
      " }",
    ]);
    const v = visibilityOnlyExportChange(diff);
    expect(v.ok, `preamble must not be read as content — got: ${v.reason}`).toBe(true);
  });
});
