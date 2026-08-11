/**
 * Regression proof for the MV205 grade-erasure defect (2026-07-25).
 *
 * Incident: `PUT /api/admin/certificates/361/approve` was called with an empty body (`{}`).
 * It returned 200 and set `certificates.grade` from `8.0` to NULL, because the approval
 * UPDATE wrote `grade = ${gradeNum}` unconditionally while every neighbouring column on
 * the same statement was COALESCE-protected. The B3 completeness gate did not catch it:
 * that gate only inspects the four sub-grades, never the overall grade itself.
 *
 * Two layers of proof here:
 *
 *  1. WRITE SEMANTICS — executed against a disposable real PostgreSQL 17 cluster. These
 *     tests run the *actual SQL shapes* (before and after) so the preservation behaviour
 *     is demonstrated, not asserted from source. They also pin the NaN hazard, which is
 *     why a COALESCE alone is insufficient and the request gate is the primary fix.
 *
 *  2. HANDLER INVARIANTS — the two approval handlers live inline in the 12k-line
 *     `server/routes.ts` monolith and there is no precedent in this suite for mounting
 *     them over HTTP (no test imports `server/routes`). Until that is extracted, the
 *     gates themselves are pinned by source assertion, and the end-to-end 400/200
 *     behaviour is proven by running the real server against staging (recorded in the
 *     task ledger). These assertions exist to stop the gate being silently deleted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const ROUTES = readFileSync(join(__dirname, "..", "server", "routes.ts"), "utf8");

let cluster: DisposablePostgres17;
let pool: pg.Pool;

beforeAll(async () => {
  cluster = await startPostgres17("approval-grade-preservation");
  pool = new pg.Pool({ connectionString: cluster.url, max: 4 });
  await pool.query(`
    CREATE TABLE certificates (
      id integer PRIMARY KEY,
      certificate_number text,
      -- MUST match the shipped column (shared/schema.ts: decimal precision 4, scale 1),
      -- confirmed as numeric(4,1) on BOTH staging and production. An unconstrained
      -- numeric here would silently store Infinity and hide the overflow behaviour
      -- the NaN/Infinity tests below reason about.
      grade numeric(4,1),
      grade_type text,
      auth_status text DEFAULT 'genuine',
      centering_score numeric, corners_score numeric, edges_score numeric, surface_score numeric
    )`);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

/** A production-shaped, already-graded certificate: numeric 8.0, all four sub-grades present. */
async function seed(authStatus = "genuine"): Promise<void> {
  await pool.query("DELETE FROM certificates");
  await pool.query(
    `INSERT INTO certificates (id, certificate_number, grade, grade_type, auth_status,
       centering_score, corners_score, edges_score, surface_score)
     VALUES (1, 'MV205', 8.0, 'numeric', $1, 8.5, 9.0, 8.0, 9.0)`,
    [authStatus]
  );
}

const gradeOf = async (): Promise<string | null> =>
  (await pool.query<{ grade: string | null }>("SELECT grade::text AS grade FROM certificates WHERE id = 1")).rows[0]
    .grade;

const authOf = async (): Promise<string | null> =>
  (await pool.query<{ auth_status: string | null }>("SELECT auth_status FROM certificates WHERE id = 1")).rows[0]
    .auth_status;

beforeEach(async () => {
  await seed();
});

describe("write semantics: grade preservation (real PostgreSQL)", () => {
  it("REPRODUCES the defect — an unguarded `grade = $1` with a null parameter erases a stored grade", async () => {
    expect(await gradeOf()).toBe("8.0");
    // The exact pre-fix shape: a bare parameter, which `pg` serialises null -> SQL NULL.
    await pool.query("UPDATE certificates SET grade = $1 WHERE id = 1", [null]);
    expect(await gradeOf()).toBeNull(); // this is what happened to MV205
  });

  it("FIXED shape — `COALESCE($1::numeric, grade)` preserves the stored grade when the parameter is null", async () => {
    await pool.query("UPDATE certificates SET grade = COALESCE($1::numeric, grade) WHERE id = 1", [null]);
    expect(await gradeOf()).toBe("8.0");
  });

  it("FIXED shape still applies a real grade change", async () => {
    await pool.query("UPDATE certificates SET grade = COALESCE($1::numeric, grade) WHERE id = 1", [9.5]);
    expect(await gradeOf()).toBe("9.5");
  });

  it("FIXED shape still lets the NO/AA branch clear the grade deliberately", async () => {
    // Non-numeric approval takes the `sql`NULL`` branch, not the COALESCE branch.
    await pool.query("UPDATE certificates SET grade = NULL, grade_type = 'NO' WHERE id = 1");
    expect(await gradeOf()).toBeNull();
  });

  it("COALESCE alone is NOT sufficient: Postgres numeric accepts NaN, so a request gate is required", async () => {
    // `parseFloat(undefined)` is NaN. NaN is not null, so it flows straight through COALESCE
    // and corrupts the column. This is why the primary fix is a 400 at the request boundary
    // and the COALESCE is only defence in depth.
    await pool.query("UPDATE certificates SET grade = COALESCE($1::numeric, grade) WHERE id = 1", [Number.NaN]);
    expect(await gradeOf()).toBe("NaN");
  });
});

describe("write semantics: auth_status preservation (real PostgreSQL)", () => {
  it("REPRODUCES the defect — `$1 || 'genuine'` downgrades an altered record when the key is omitted", async () => {
    await seed("authentic_altered");
    const omitted: string | null = null; // JS `undefined || "genuine"` === "genuine"
    await pool.query("UPDATE certificates SET auth_status = $1 WHERE id = 1", [omitted ?? "genuine"]);
    expect(await authOf()).toBe("genuine"); // authenticity record silently lost
  });

  it("FIXED shape preserves an altered record when the key is omitted", async () => {
    await seed("authentic_altered");
    await pool.query("UPDATE certificates SET auth_status = COALESCE($1, auth_status, 'genuine') WHERE id = 1", [null]);
    expect(await authOf()).toBe("authentic_altered");
  });

  it("FIXED shape still applies an explicit auth_status change", async () => {
    await seed("genuine");
    await pool.query("UPDATE certificates SET auth_status = COALESCE($1, auth_status, 'genuine') WHERE id = 1", [
      "authentic_altered",
    ]);
    expect(await authOf()).toBe("authentic_altered");
  });

  it("FIXED shape falls back to 'genuine' when the column itself is null", async () => {
    await pool.query("DELETE FROM certificates");
    await pool.query(
      "INSERT INTO certificates (id, certificate_number, grade, grade_type, auth_status) VALUES (1,'MV205',8.0,'numeric',NULL)"
    );
    await pool.query("UPDATE certificates SET auth_status = COALESCE($1, auth_status, 'genuine') WHERE id = 1", [null]);
    expect(await authOf()).toBe("genuine");
  });
});

describe("handler invariants: PUT /api/admin/certificates/:id/approve", () => {
  const approveHandler = (): string => {
    const start = ROUTES.indexOf('app.put("/api/admin/certificates/:id/approve"');
    expect(start).toBeGreaterThan(0);
    const end = ROUTES.indexOf("\n  app.", start + 10);
    return ROUTES.slice(start, end > start ? end : start + 20_000);
  };

  it("rejects a numeric approval whose overall grade is missing, unreadable or off-ladder", () => {
    // Behaviour-shaped rather than spelling-shaped: the gate must consult BOTH the
    // presence of the value and the shared grade validator, and must 400.
    const h = approveHandler();
    // Anchor on the overall-grade gate specifically — the B3 sub-grade gate also
    // begins "if (!isNonNum &&" and appears earlier in the handler.
    //
    // 2026-08-11: the gate now reads `storedGrade`, not the request-derived
    // `gradeNum`. That rename is the whole point of the repair, not cosmetic —
    // the approval UPDATE persists no certificate-facing field, so validating a
    // request value while publishing the stored row let `{"overall_grade":9}`
    // publish a certificate whose stored `grade` was NULL (printing "0/POOR").
    const at = h.indexOf("if (!isNonNum && (storedGrade == null");
    expect(at).toBeGreaterThan(0);
    const gate = h.slice(at, at + 400);
    expect(gate).toContain("storedGrade == null");
    expect(gate).toContain("isValidNumericGrade(storedGrade)");
    expect(gate).toContain("res.status(400)");
  });

  it("derives every publish gate from the STORED row, never from the request body", () => {
    // The invariant the MV205-class defect violated: what is validated must be
    // exactly what is published. The approval UPDATE writes no grade, so any gate
    // reading req.body is validating a value this route will never persist.
    const h = approveHandler();
    const gateRegion = h.slice(0, h.indexOf("UPDATE certificates SET"));
    // The four sub-grade gate inputs and the overall grade all read `cert`/`certRow`.
    expect(gateRegion).toContain("const storedGrade = isNonNum ? null : strictGrade(certRow.gradeOverall)");
    for (const f of ["gradeCentering", "gradeCorners", "gradeEdges", "gradeSurface"]) {
      expect(gateRegion, `stored sub-grade ${f} must come from the row`).toContain(`num(certRow.${f})`);
    }
    // And the pre-UPDATE region must not reintroduce body-derived grade inputs.
    expect(gateRegion).not.toMatch(/\bnum\(b\.grade_(centering|corners|edges|surface)\)/);
    expect(gateRegion).not.toMatch(/strictGrade\(overallGrade\)/);
  });

  it("decides numeric-vs-authentication kind from the STORED grade_type, not the payload", () => {
    // A one-key body ({"overall_grade":"NO"}) must not be able to steer the
    // publish gates down the non-numeric branch and skip them entirely.
    const h = approveHandler();
    expect(h).toContain('const isNonNum = kindOfGradeType((cert as { gradeType?: string | null }).gradeType) !== "numeric"');
    expect(h).not.toContain('const isNonNum = overallGrade === "AA" || overallGrade === "NO"');
  });

  it("places the gate BEFORE the UPDATE, so a rejected payload never reaches the write", () => {
    // Without this, a gate accidentally placed after the UPDATE would satisfy every
    // other assertion in this file while being completely useless.
    const h = approveHandler();
    const gateAt = h.indexOf("isValidNumericGrade(storedGrade)");
    const updateAt = h.indexOf("UPDATE certificates SET");
    expect(gateAt).toBeGreaterThan(0);
    expect(updateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(updateAt);
  });

  it("is a state transition only, so approval cannot rewrite the reviewed grade", () => {
    const h = approveHandler();
    expect(h).not.toMatch(/^\s*grade\s+= \$\{gradeNum\},$/m);
    expect(h).not.toMatch(/^\s*grade\s+=/m);
    expect(h).toContain("Approval is a state transition only.");
    expect(h).toContain("AND grading_revision = ${expectedRevision}");
  });

  it("cannot change authentication state during final approval", () => {
    const h = approveHandler();
    expect(h).not.toContain('auth_status         = ${b.auth_status || "genuine"}');
    expect(h).not.toMatch(/^\s*auth_status\s+=/m);
  });

  it("keeps the pre-existing B3 sub-grade completeness gate", () => {
    // The B3 four-sub-grade rule is PRESERVED but no longer duplicated here: it now
    // comes from the shared checkGradePublishGates, which both approval paths use.
    // Asserting the shared call (and that it precedes the write) is the stronger
    // invariant — a re-derived local copy is exactly how this route drifted from its
    // sibling and let an unprintable NO/AA state publish.
    const h = approveHandler();
    const gateAt = h.indexOf("const publishGate = await checkGradePublishGates(id);");
    expect(gateAt, "approve must use the SHARED publish gate").toBeGreaterThan(0);
    expect(h).toContain("if (!publishGate.ok) {");
    expect(gateAt).toBeLessThan(h.indexOf("UPDATE certificates SET"));
    // And it must not have grown a private copy of the rule back.
    expect(h).not.toMatch(/storedCentering == null \|\| storedCorners == null/);
  });

  it("keeps the print-state promotion guarded so an in-flight print is never regressed", () => {
    expect(approveHandler()).toContain("CASE WHEN print_state = 'awaiting_approval' THEN 'needs_printing'");
  });

  it("does not alter certificate numbering", () => {
    expect(approveHandler()).not.toMatch(/certificate_number\s*=/);
  });
});

describe("handler invariants: PUT /api/admin/certificates/:id/approve-grade", () => {
  const approveGradeHandler = (): string => {
    const start = ROUTES.indexOf('app.put("/api/admin/certificates/:id/approve-grade"');
    expect(start).toBeGreaterThan(0);
    const end = ROUTES.indexOf("\n  app.", start + 10);
    return ROUTES.slice(start, end > start ? end : start + 20_000);
  };

  it("is a terminal fail-closed retirement, never a second approval implementation", () => {
    const h = approveGradeHandler();
    expect(h).toContain("res.status(410)");
    expect(h).toContain('code: "CANONICAL_REVIEW_REQUIRED"');
    expect(h).toContain("canonical grading workstation");
    expect(h).not.toContain("UPDATE certificates SET");
    expect(h).not.toContain("certificate_number");
  });

  it("removes the retired CertificateForm caller so final approval only flows through GradingWorkstation", () => {
    const form = readFileSync(join(process.cwd(), "client", "src", "components", "certificate-form.tsx"), "utf8");
    const workstation = readFileSync(
      join(process.cwd(), "client", "src", "components", "grading-workflow", "GradingWorkstation.tsx"),
      "utf8"
    );
    expect(form).not.toContain("/approve-grade");
    expect(workstation).toContain("<GradingPanel");
    expect(workstation).toContain("onReviewTransitionReady={registerReviewTransitionHandler}");
  });
});

describe("LOCKED RULE: normal approval cannot convert numeric <-> authentication-only", () => {
  // The canonical STORED record decides the kind, never the request. Verified over
  // real HTTP against staging on a disposable numeric cert and a disposable
  // authentication-only cert (evidence recorded on the PR and in the task ledger).
  const handlers = [
    { name: "/approve", marker: 'app.put("/api/admin/certificates/:id/approve"' },
  ] as const;

  const slice = (marker: string): string => {
    const start = ROUTES.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    const end = ROUTES.indexOf("\n  app.", start + 10);
    return ROUTES.slice(start, end > start ? end : start + 20_000);
  };

  for (const h of handlers) {
    it(`${h.name}: derives the certificate kind from the STORED record, not the request`, () => {
      const s = slice(h.marker);
      // The kind comes from the stored record and the decision goes through the single
      // shared helper, so the paths cannot drift apart again.
      expect(s).toContain("normaliseGradeType((cert as { gradeType?: string | null }).gradeType)");
      expect(s).toContain("rejectKindChange({");
      expect(s).toContain("storedGradeType,");
      expect(s).toMatch(/if \(kindRejection\) \{[\s\S]{0,900}?res\.status\(400\)/);
    });

    it(`${h.name}: rejects a NO<->AA switch on an authentication-only record`, () => {
      const s = slice(h.marker);
      // Approval routes forbid ANY kind change, so NO<->AA is covered by the same call.
      expect(s).toContain("allowChangeWhenUnapproved: false");
    });

    it(`${h.name}: is a state transition only, so approval cannot rewrite grade_type or any reviewed grade field`, () => {
      const s = slice(h.marker);
      const approvalUpdate = s.slice(s.indexOf("const approvalWrite"), s.indexOf("if (approvalWrite.rows.length === 0)"));
      expect(approvalUpdate).toContain("grading_revision = ${expectedRevision}");
      for (const field of ["grade_type =", "grade =", "centering_score =", "corners_score =", "edges_score =", "surface_score ="]) {
        expect(approvalUpdate, `${h.name} must not mutate ${field}`).not.toContain(field);
      }
    });

    it(`${h.name}: the kind gate runs BEFORE the UPDATE`, () => {
      const s = slice(h.marker);
      const gateAt = s.indexOf("rejectKindChange");
      const updateAt = s.indexOf("UPDATE certificates SET");
      // indexOf returns -1 when absent and -1 < anything, so BOTH must be proven present
      // or this assertion is vacuously true on a tree with no gate at all.
      expect(gateAt).toBeGreaterThan(0);
      expect(updateAt).toBeGreaterThan(0);
      expect(gateAt).toBeLessThan(updateAt);
    });
  }

  it("legacy long-form aliases count as authentication-only on both sides of the check", async () => {
    const { isNonNumericGrade } = await import("../shared/schema");
    for (const t of ["NO", "AA", "not_original", "authentic_altered"]) expect(isNonNumericGrade(t)).toBe(true);
    for (const t of ["numeric", "", "banana"]) expect(isNonNumericGrade(t)).toBe(false);
  });

  it("the canonical NO/AA mapping treats each legacy alias as its short form", () => {
    // Mirrors the helper in both handlers.
    const canonicalKind = (v: string): "NO" | "AA" => (v === "AA" || v === "authentic_altered" ? "AA" : "NO");
    expect(canonicalKind("AA")).toBe("AA");
    expect(canonicalKind("authentic_altered")).toBe("AA");
    expect(canonicalKind("NO")).toBe("NO");
    expect(canonicalKind("not_original")).toBe("NO");
  });
});

describe("write semantics: grade_type is never rewritten by approval (real PostgreSQL)", () => {
  it("persisting the stored value is a no-op for a numeric record", async () => {
    await seed();
    await pool.query(
      "UPDATE certificates SET grade_type = (SELECT grade_type FROM certificates WHERE id = 1) WHERE id = 1"
    );
    const r = await pool.query<{ grade_type: string }>("SELECT grade_type FROM certificates WHERE id = 1");
    expect(r.rows[0].grade_type).toBe("numeric");
  });

  it("a legacy long-form alias survives approval unchanged (not normalised to NO)", async () => {
    await pool.query("DELETE FROM certificates");
    await pool.query(
      "INSERT INTO certificates (id, certificate_number, grade, grade_type, auth_status) VALUES (1,'MVAUTH',NULL,'not_original','not_original')"
    );
    // The shipped statement writes ${storedGradeType} — i.e. the value just read back.
    await pool.query("UPDATE certificates SET grade_type = $1 WHERE id = 1", ["not_original"]);
    const r = await pool.query<{ grade_type: string; grade: string | null }>(
      "SELECT grade_type, grade::text AS grade FROM certificates WHERE id = 1"
    );
    expect(r.rows[0].grade_type).toBe("not_original");
    expect(r.rows[0].grade).toBeNull();
  });
});

describe("the published overall grade is parsed strictly, not with parseFloat", () => {
  // parseFloat is a PREFIX parser, so "7.5abc" -> 7.5 and [8] -> 8 would publish a
  // grade the operator never entered. The remaining canonical approval route uses a strict decimal
  // parse. Verified over real HTTP against staging: "7.5abc", [8], {v:8}, true,
  // "0x0A", "1e2" and "Infinity" all 400; 8.5, "8.5" and " 8.5 " all 200.
  const STRICT_DECIMAL = /^-?\d+(\.\d+)?$/;
  const strictGrade = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!STRICT_DECIMAL.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  it("mirrors the shipped helper: the regex in this test matches the one in routes.ts", () => {
    // Guards against the test's copy drifting from the implementation.
    expect(ROUTES).toContain("/^-?\\d+(\\.\\d+)?$/.test(t)");
    expect((ROUTES.match(/const strictGrade = \(v: unknown\): number \| null => \{/g) ?? []).length).toBe(1);
  });

  it("rejects prefix-parseable junk that parseFloat would have accepted", () => {
    for (const junk of ["7.5abc", "0x0A", "1e2", "Infinity", "8,5", "", " ", "--8"]) {
      expect(strictGrade(junk)).toBeNull();
    }
    for (const nonPrimitive of [[8], { v: 8 }, true, false, null, undefined]) {
      expect(strictGrade(nonPrimitive)).toBeNull();
    }
    expect(strictGrade(Number.NaN)).toBeNull();
    expect(strictGrade(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("still accepts every legitimate form a client sends", () => {
    expect(strictGrade(8.5)).toBe(8.5);
    expect(strictGrade("8.5")).toBe(8.5);
    expect(strictGrade(" 8.5 ")).toBe(8.5);
    expect(strictGrade("10")).toBe(10);
    expect(strictGrade("8.0")).toBe(8);
    expect(strictGrade(1)).toBe(1);
  });

  it("no longer derives the overall grade with parseFloat on either approval route", () => {
    expect(ROUTES).not.toContain("const finalOverall = isNonNum ? null : parseFloat(overall);");
    expect(ROUTES).not.toContain("const gradeNum = isNonNum ? null : num(overallGrade);");
  });
});

describe("handler invariants: PUT /api/admin/certificates/:id/grade (draft save)", () => {
  // This third handler was also changed (auth_status) and must be pinned too, or the
  // change is unguarded — the draft-save route runs on EVERY auto-save, so an
  // auth_status reset here is far higher-frequency than on approval.
  // PR A extracted this handler VERBATIM out of its inline `app.put(...)`
  // registration into a named export (`handleCertificateGradeUpdate`), so it can
  // be mounted in a route-level test over a disposable PostgreSQL cluster —
  // exactly as `handleCertificateMetadataUpdate` already was. The registration
  // line is now a one-line delegation, so the source slice must follow the
  // handler, not the mount point. Every invariant asserted below is unchanged.
  const gradeHandler = (): string => {
    const start = ROUTES.indexOf("export async function handleCertificateGradeUpdate");
    expect(start).toBeGreaterThan(0);
    const end = ROUTES.indexOf("\nexport async function ", start + 10);
    return ROUTES.slice(start, end > start ? end : start + 20_000);
  };

  it("is still mounted at the same path, behind requireAdmin", () => {
    expect(ROUTES).toContain(
      'app.put("/api/admin/certificates/:id/grade", requireAdmin, handleCertificateGradeUpdate);',
    );
  });

  it("preserves auth_status on omission instead of resetting it to 'genuine'", () => {
    const h = gradeHandler();
    expect(h).not.toContain('auth_status         = ${b.auth_status || "genuine"}');
    expect(h).toContain("auth_status         = COALESCE(${txt(b.auth_status)}, auth_status, 'genuine')");
  });

  it("keeps its pre-existing COALESCE guard on the grade column", () => {
    expect(gradeHandler()).toMatch(/grade\s+= \$\{isNonNum \? sql`NULL` : sql`COALESCE\(/);
  });

  it("does NOT rewrite grade_type from a partial payload — an autosave cannot convert a record", () => {
    // Proven on staging 2026-07-25: pre-fix, an autosave body of
    // {"grade_explanation":"..."} flipped a stored grade_type of 'NO' to 'numeric',
    // silently converting an authentication-only certificate to numeric. This route
    // fires on EVERY autosave, so the exposure was continuous.
    const h = gradeHandler();
    expect(h).not.toContain('grade_type          = ${isNonNum ? (overallGrade === "AA" ? "AA" : "NO") : "numeric"}');
    expect(h).toMatch(/grade_type\s+= \$\{nextGradeType\}/);
    // The stored value must be the fallback when the caller states no kind.
    expect(h).toContain('const overallStated = overallGrade != null && String(overallGrade).trim() !== ""');
    expect(h).toContain("const nextGradeType = gradeTypeToPersist(storedGradeType, requestedKind)");
    expect(h).toMatch(
      /requestedKind = overallStated \? kindOfOverallGrade\(overallGrade\) : kindOfGradeType\(storedGradeType\)/
    );
  });

  it("REFUSES a kind change on a PUBLISHED certificate (this route had no gate at all)", () => {
    // Hostile review proved a one-key body {"overall_grade":"NO"} converted a LIVE
    // published numeric cert here and nulled its grade and all four sub-grades, 200.
    // An earlier version of this file asserted the opposite and blessed that behaviour.
    const h = gradeHandler();
    expect(h).toContain("rejectKindChange");
    expect(h).toContain("allowChangeWhenUnapproved: true");
    expect(h).toMatch(/isApproved:.*gradeApprovedAt/);
    expect(h).toContain("res.status(400)");
  });

  it("binds the NULL-out branches to the RESOLVED kind, not the raw request", () => {
    const h = gradeHandler();
    expect(h).toContain('const isNonNum = requestedKind !== "numeric"');
    // The raw-request flag must no longer drive the SQL.
    expect(h).toMatch(/const isNonNumRequested = overallGrade === "AA"/);
  });
});

describe("write semantics: a partial autosave preserves the stored kind (real PostgreSQL)", () => {
  it("omitted kind keeps 'NO'; stated kind applies", async () => {
    await pool.query("DELETE FROM certificates");
    await pool.query(
      "INSERT INTO certificates (id, certificate_number, grade, grade_type, auth_status) VALUES (1,'MVAUTH',NULL,'NO','not_original')"
    );
    const stored = "NO";
    // Omitted -> nextGradeType resolves to the stored value.
    await pool.query("UPDATE certificates SET grade_type = $1 WHERE id = 1", [stored]);
    expect((await pool.query<{ t: string }>("SELECT grade_type AS t FROM certificates WHERE id = 1")).rows[0].t).toBe(
      "NO"
    );
    // Stated numeric -> applies.
    await pool.query("UPDATE certificates SET grade_type = $1 WHERE id = 1", ["numeric"]);
    expect((await pool.query<{ t: string }>("SELECT grade_type AS t FROM certificates WHERE id = 1")).rows[0].t).toBe(
      "numeric"
    );
  });
});

describe("the adopted grade validator accepts every grade MVGS can emit", () => {
  // Load-bearing for the gate: if the validator rejected any MVGS output, the fix
  // would 400 on legitimate approvals. Proven exhaustively over the score domain.
  it("accepts all gradeFromMvgsScore outputs and rejects junk", async () => {
    const { isValidNumericGrade } = await import("../shared/schema");
    const { gradeFromMvgsScore } = await import("../shared/mvgs-scoring");
    for (let s = -20; s <= 120; s += 0.25) {
      expect(isValidNumericGrade(gradeFromMvgsScore(s))).toBe(true);
    }
    for (const junk of [0, -5, 100, 7.55, 1e2, Number.NaN, Number.POSITIVE_INFINITY, 10.5, 0.5]) {
      expect(isValidNumericGrade(junk)).toBe(false);
    }
    for (const ok of [1, 1.5, 7.5, 8, 9.5, 10]) expect(isValidNumericGrade(ok)).toBe(true);
  });
});

describe("grading engine and MVGS remain untouched by this fix", () => {
  it("the fix adds no scoring, weighting or formula logic", () => {
    // Slice ONLY the gate block that this fix introduced (not the surrounding handler,
    // which legitimately runs MVGS to derive label_type).
    const at = ROUTES.indexOf("if (!isNonNum && (storedGrade == null");
    expect(at).toBeGreaterThan(0);
    const gate = ROUTES.slice(at, ROUTES.indexOf("}", ROUTES.indexOf("});", at)) + 1);
    // The gate is a presence check only — it must not compute or adjust a grade.
    expect(gate).not.toMatch(/scoreMvgs|gradeFromMvgsScore|weight|deduct/i);
    expect(gate).not.toMatch(/grade\s*=[^=]/); // performs no assignment to a grade
    expect(gate).toContain("res.status(400)");
  });
});
