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
      grade numeric,
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

  it("rejects a numeric approval whose overall grade is missing or unreadable", () => {
    expect(approveHandler()).toMatch(/if \(!isNonNum && gradeNum == null\) \{\s*return res\.status\(400\)/);
  });

  it("no longer writes `grade` from a bare parameter", () => {
    const h = approveHandler();
    expect(h).not.toMatch(/^\s*grade\s+= \$\{gradeNum\},$/m);
    expect(h).toMatch(/grade\s+= \$\{isNonNum \? sql`NULL` : sql`COALESCE\(\$\{gradeNum\}::numeric, grade\)`\}/);
  });

  it("preserves auth_status on omission instead of resetting it to 'genuine'", () => {
    const h = approveHandler();
    expect(h).not.toContain('auth_status         = ${b.auth_status || "genuine"}');
    expect(h).toContain("auth_status         = COALESCE(${txt(b.auth_status)}, auth_status, 'genuine')");
  });

  it("keeps the pre-existing B3 sub-grade completeness gate", () => {
    expect(approveHandler()).toMatch(/finalCentering == null \|\| finalCorners == null/);
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

  it("rejects a numeric approval whose overall grade is not a finite number (NaN hazard)", () => {
    expect(approveGradeHandler()).toMatch(
      /if \(!isNonNum && !Number\.isFinite\(finalOverall\)\) \{\s*return res\.status\(400\)/
    );
  });

  it("no longer writes `grade` from a bare parameter", () => {
    const h = approveGradeHandler();
    expect(h).not.toContain("grade             = ${isNonNum ? null : finalOverall}");
    expect(h).toMatch(/grade\s+= \$\{isNonNum \? sql`NULL` : sql`COALESCE\(\$\{finalOverall\}::numeric, grade\)`\}/);
  });

  it("does not alter certificate numbering", () => {
    expect(approveGradeHandler()).not.toMatch(/certificate_number\s*=/);
  });
});

describe("grading engine and MVGS remain untouched by this fix", () => {
  it("the fix adds no scoring, weighting or formula logic", () => {
    // Slice ONLY the gate block that this fix introduced (not the surrounding handler,
    // which legitimately runs MVGS to derive label_type).
    const at = ROUTES.indexOf("if (!isNonNum && gradeNum == null)");
    expect(at).toBeGreaterThan(0);
    const gate = ROUTES.slice(at, ROUTES.indexOf("}", ROUTES.indexOf("});", at)) + 1);
    // The gate is a presence check only — it must not compute or adjust a grade.
    expect(gate).not.toMatch(/scoreMvgs|gradeFromMvgsScore|weight|deduct/i);
    expect(gate).not.toMatch(/grade\s*=[^=]/); // performs no assignment to a grade
    expect(gate).toContain("res.status(400)");
  });
});
