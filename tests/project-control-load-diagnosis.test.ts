/**
 * Project Control — load-failure diagnosis (defect F-3).
 *
 * THE DEFECT
 *
 * Every failure to load the dashboard fell into one of two branches, chosen by sniffing the error
 * MESSAGE for the substring "not enabled". Everything that did not match rendered:
 *
 *     "The most likely cause is that migration 0030 has not been applied to this environment."
 *
 * That is a confident, specific and usually WRONG diagnosis. The most common real cause is an
 * evicted session — a staff or grader login in the same browser replaces the shared `mv.sid`
 * admin session, which is a documented behaviour of this codebase. The operator was being sent to
 * inspect a database when the actual fix was to log in again.
 *
 * A wrong diagnosis is worse than no diagnosis, because it is acted upon. These tests pin each
 * cause to its own distinct screen, and specifically pin that the migration explanation is only
 * ever given when the schema really is missing.
 */
import { describe, it, expect } from "vitest";
import { diagnoseLoadFailure } from "../client/src/pages/admin/project-control-helpers";

function httpError(status: number, message = "boom"): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("each cause gets its own diagnosis", () => {
  it("404 is the activation flag being off — a normal state, not a fault", () => {
    const d = diagnoseLoadFailure(httpError(404, "Project Control is not enabled in this environment."));
    expect(d.kind).toBe("disabled");
    expect(d.testId).toBe("pc-disabled");
    expect(d.tone).toBe("neutral");
    expect(d.detail).toContain("SUPER_ADMIN_PROJECT_CONTROL_ENABLED");
  });

  it("401 is an ended session, and says how to fix it", () => {
    const d = diagnoseLoadFailure(httpError(401));
    expect(d.kind).toBe("unauthenticated");
    expect(d.detail).toMatch(/sign in again/i);
    expect(d.canRetry).toBe(true);
  });

  it("a null error with no data is also an ended session", () => {
    // The shared query function is configured `on401: "returnNull"`, so an evicted session yields
    // data === null with NO error object at all. This is the single most likely real-world case.
    expect(diagnoseLoadFailure(undefined).kind).toBe("unauthenticated");
    expect(diagnoseLoadFailure(null).kind).toBe("unauthenticated");
  });

  it("403 is a valid session without the privilege — distinct from a missing session", () => {
    const d = diagnoseLoadFailure(httpError(403, "Forbidden: Super Admin required"));
    expect(d.kind).toBe("forbidden");
    expect(d.detail).toMatch(/does not carry that privilege/i);
    expect(d.canRetry).toBe(false);
  });

  it("a missing relation IS the migration case", () => {
    const d = diagnoseLoadFailure(httpError(500, 'relation "pc_work_packages" does not exist'));
    expect(d.kind).toBe("schema_missing");
    expect(d.detail).toContain("Migration 0030");
  });

  it("a plain 500 is a server fault, NOT a configuration problem", () => {
    const d = diagnoseLoadFailure(httpError(500, "Internal Server Error"));
    expect(d.kind).toBe("server");
    expect(d.detail).not.toContain("0030");
  });

  it("a status-less error is a network failure", () => {
    const d = diagnoseLoadFailure(new Error("Failed to fetch"));
    expect(d.kind).toBe("network");
  });

  it("an unrecognised status admits it is unrecognised rather than inventing a cause", () => {
    const d = diagnoseLoadFailure(httpError(418, "teapot"));
    expect(d.kind).toBe("unknown");
    expect(d.detail).toMatch(/not one this screen recognises/i);
  });
});

describe("the migration explanation is never given for an unrelated failure", () => {
  it("is absent from 401, 403, 404, plain 500 and network failures", () => {
    const cases = [
      diagnoseLoadFailure(httpError(401)),
      diagnoseLoadFailure(undefined),
      diagnoseLoadFailure(httpError(403)),
      diagnoseLoadFailure(httpError(404)),
      diagnoseLoadFailure(httpError(500, "Internal Server Error")),
      diagnoseLoadFailure(new Error("Failed to fetch")),
    ];
    for (const d of cases) {
      expect(d.detail, `"${d.kind}" must not blame migration 0030`).not.toContain("0030");
      expect(d.kind).not.toBe("schema_missing");
    }
  });

  it("gives every diagnosis a distinct test id, so screens cannot be confused in a test", () => {
    const ids = [
      diagnoseLoadFailure(httpError(404)).testId,
      diagnoseLoadFailure(httpError(401)).testId,
      diagnoseLoadFailure(httpError(403)).testId,
      diagnoseLoadFailure(httpError(500, 'relation "pc_x" does not exist')).testId,
      diagnoseLoadFailure(httpError(500)).testId,
      diagnoseLoadFailure(new Error("x")).testId,
      diagnoseLoadFailure(httpError(418)).testId,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("always produces a headline and detail that stand alone when rendered", () => {
    for (const error of [httpError(404), httpError(401), httpError(403), httpError(500), new Error("x"), undefined]) {
      const d = diagnoseLoadFailure(error);
      expect(d.headline.length).toBeGreaterThan(10);
      expect(d.detail.length).toBeGreaterThan(20);
    }
  });
});
