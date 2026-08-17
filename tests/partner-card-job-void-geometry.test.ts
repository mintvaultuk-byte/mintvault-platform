/*
 * VOIDING A CARD WHOSE CAPTURE GEOMETRY CANNOT BE RECOVERED.
 *
 * The state this exists for, observed on staging 2026-08-17 (MV272):
 *
 *   - FRONT is real, accepted evidence   -> station cancellation refuses (JOB_HAS_EVIDENCE)
 *   - every session has acquisition_region NULL, predating migration 0091
 *                                        -> BACK cannot be paired: the two sides would come from
 *                                           unknown, possibly different physical rectangles
 *   - the station cannot recalibrate while a card is open
 *                                        -> the card blocks its own station indefinitely
 *
 * Four correct refusals and no exit between them. These tests pin the ONE route out, and pin the
 * properties that make it safe to have: super-admin only, credit back exactly once, MV number kept,
 * evidence left alone.
 */
import { describe, it, expect } from "vitest";
import * as cancellation from "../server/partner/card-job-cancellation";

describe("void authority — shape and refusals that need no database", () => {
  it("refuses a void with no stated reason", async () => {
    await expect(
      cancellation.voidCardJobUnrecoverableGeometry({
        tenantId: "t", locationId: null, cardJobId: "j", actorUserId: "admin", reason: "   ",
      })
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("refuses outright if a station id is ever threaded through", async () => {
    /*
     * Defence in depth. The route is behind admin step-up, but a future route wired carelessly
     * must not be able to hand a Mac the power to close a photographed card.
     */
    await expect(
      cancellation.voidCardJobUnrecoverableGeometry({
        tenantId: "t", locationId: null, cardJobId: "j", actorUserId: "admin",
        reason: "geometry unrecoverable",
        // deliberately smuggled in
        ...( { stationId: "station-1" } as Record<string, unknown> ),
      } as Parameters<typeof cancellation.voidCardJobUnrecoverableGeometry>[0])
    ).rejects.toMatchObject({ code: "STATION_MAY_NOT_VOID" });
  });

  it("is exported alongside station cancellation, not in place of it", () => {
    // Both must exist. The void must never become the way ordinary cancellation is done.
    expect(typeof cancellation.cancelCardJob).toBe("function");
    expect(typeof cancellation.voidCardJobUnrecoverableGeometry).toBe("function");
  });
});

describe("the two routes keep different refusal sets — read from source", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").resolve(__dirname, "../server/partner/card-job-cancellation.ts"), "utf8"
  ) as string;

  it("station cancellation still refuses a card holding evidence", () => {
    // The guard that made MV272 unclosable must remain, untouched, for the station path.
    expect(source).toMatch(/assertNothingCaptured\(client, \{ certificateId: job\.certificateId/);
    expect(source).toContain("JOB_HAS_EVIDENCE");
  });

  it("the void path deliberately does NOT assert nothing was captured", () => {
    const voidFn = source.slice(source.indexOf("export async function voidCardJobUnrecoverableGeometry"));
    expect(voidFn).not.toMatch(/await assertNothingCaptured\(/);
    // and says so, so nobody "fixes" it later
    expect(voidFn).toMatch(/deliberately NOT called/i);
  });

  it("the void path releases the reservation through the same once-only helper", () => {
    const voidFn = source.slice(source.indexOf("export async function voidCardJobUnrecoverableGeometry"));
    expect(voidFn).toMatch(/releaseReservationOnce\(client, \{/);
  });

  it("the void path preserves the MV number and records that it did", () => {
    const voidFn = source.slice(source.indexOf("export async function voidCardJobUnrecoverableGeometry"));
    expect(voidFn).toMatch(/mvNumberPreserved: job\.mvNumber/);
  });

  it("the void path never deletes evidence", () => {
    const voidFn = source.slice(source.indexOf("export async function voidCardJobUnrecoverableGeometry"));
    expect(voidFn).not.toMatch(/DELETE\s+FROM\s+certificate_image_evidence/i);
    expect(voidFn).toMatch(/evidenceRetained: true/);
  });

  it("a void is audited under its own action name, distinct from a cancellation", () => {
    const voidFn = source.slice(source.indexOf("export async function voidCardJobUnrecoverableGeometry"));
    expect(voidFn).toMatch(/action: "partner_card_job_voided_unrecoverable_geometry"/);
    expect(source).toMatch(/action: "partner_card_job_cancelled"/);
  });

  it("only a non-terminal, unfinished card is voidable", () => {
    expect(source).toMatch(/const VOIDABLE_STATUSES[\s\S]{0,220}CAPTURING/);
    // A graded/approved/completed card is NOT a candidate.
    const voidable = source.slice(source.indexOf("const VOIDABLE_STATUSES"), source.indexOf("export async function voidCardJobUnrecoverableGeometry"));
    for (const forbidden of ["READY_TO_GRADE", "GRADING", "APPROVED", "COMPLETED"]) {
      expect(voidable).not.toContain(forbidden);
    }
  });
});

describe("the route is super-admin gated", () => {
  const routes = require("node:fs").readFileSync(
    require("node:path").resolve(__dirname, "../server/partner/partner-management-routes.ts"), "utf8"
  ) as string;

  it("sits behind requireAdminStepUp with a mandatory reason", () => {
    const line = routes.slice(routes.indexOf('/card-jobs/:cardJobId/void'));
    const handler = line.slice(0, line.indexOf("});"));
    expect(handler).toContain("requireAdminStepUp()");
    expect(handler).toContain("requireReason(req.body?.reason)");
  });

  it("is not reachable from any station route", () => {
    const stationRoutes = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../server/partner/station-routes.ts"), "utf8"
    ) as string;
    expect(stationRoutes).not.toContain("voidCardJobUnrecoverableGeometry");
    expect(stationRoutes).not.toContain("/void");
  });
});
