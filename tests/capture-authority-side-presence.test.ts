/**
 * A STALE SESSION MUST NOT FINISH A CARD.
 *
 * Pins the MV837 false completion, staging 2026-08-22. The Scanner showed
 * "READY TO GRADE — Front OK / Back OK / Both sides are saved" for a card with ZERO rows in
 * `certificate_image_evidence` and no object in R2. Nothing had ever been captured.
 *
 * Two independent defects combined:
 *
 *   1. `pendingPhysical` counted sessions in state claimed/capturing with physical_released = true
 *      and NO expiry bound. MV837 carried session 9f89dbb1 — side BACK, claimed, released, created
 *      2026-08-21T14:57, expired 15:18, captured_at NULL, never uploaded. Twenty-four hours later it
 *      still marked BACK "present". `renewScannerCapture` deliberately exempts released sessions from
 *      expiry so a slow upload is not reaped mid-flight, which is correct — and which is exactly why
 *      such a row is immortal and why the expiry bound has to live HERE instead.
 *
 *   2. Any full `present` set threw NOTHING_TO_CAPTURE, whose message says "already has both
 *      images". A live hold and a finished card were indistinguishable to the caller.
 *
 * The rule under test is pure, so every case below is provable without a database.
 */
import { describe, expect, it } from "vitest";
import { classifySidePresence, type CaptureSide } from "../server/partner/capture-authority";
import fs from "node:fs";
import path from "node:path";

const NONE: CaptureSide[] = [];

describe("side presence — evidence finishes a card, a live hold does not", () => {
  it("no evidence and no live hold arms FRONT", () => {
    const v = classifySidePresence(NONE, NONE);
    expect(v.missing).toEqual(["front", "back"]);
    expect(v.blocked).toBeNull();
  });

  it("MV837: stale sessions contribute nothing, so FRONT is required", () => {
    // The expired BACK session is filtered out by the query before it reaches this rule, so the
    // classifier sees exactly what it should see for MV837 on 2026-08-22: nothing at all.
    const v = classifySidePresence(NONE, NONE);
    expect(v.missing[0]).toBe("front");
    expect(v.blocked).toBeNull();
  });

  it("accepted FRONT with no BACK evidence requires BACK", () => {
    const v = classifySidePresence(["front"], NONE);
    expect(v.missing).toEqual(["back"]);
    expect(v.blocked).toBeNull();
  });

  it("an expired/failed/cancelled BACK cannot suppress BACK", () => {
    // Terminal and expired sessions never reach the classifier; if one ever did, FRONT evidence
    // alone must still leave BACK outstanding.
    const v = classifySidePresence(["front"], NONE);
    expect(v.missing).toContain("back");
  });

  it("a LIVE in-flight BACK still prevents arming BACK twice", () => {
    const v = classifySidePresence(["front"], ["back"]);
    expect(v.missing).toEqual([]);
    expect(v.blocked?.code).toBe("CAPTURE_IN_FLIGHT");
  });

  it("a live hold is NOT completion — the card is busy, not finished", () => {
    const v = classifySidePresence(["front"], ["back"]);
    expect(v.blocked?.complete).toBe(false);
    expect(v.blocked?.code).not.toBe("NOTHING_TO_CAPTURE");
  });

  it("a live hold on BOTH sides with zero evidence is still not completion", () => {
    // This is the MV837 shape at the moment the false completion fired: a fresh FRONT hold plus the
    // immortal BACK hold, and no evidence anywhere.
    const v = classifySidePresence(NONE, ["front", "back"]);
    expect(v.blocked?.code).toBe("CAPTURE_IN_FLIGHT");
    expect(v.blocked?.complete).toBe(false);
  });

  it("only two accepted evidence sides produce NOTHING_TO_CAPTURE", () => {
    const v = classifySidePresence(["front", "back"], NONE);
    expect(v.blocked?.code).toBe("NOTHING_TO_CAPTURE");
    expect(v.blocked?.complete).toBe(true);
  });

  it("evidence remains authoritative even while a hold lingers on the same side", () => {
    const v = classifySidePresence(["front", "back"], ["back"]);
    expect(v.blocked?.complete).toBe(true);
  });
});

describe("the expiry bound is in the query that feeds the rule", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server", "partner", "capture-authority.ts"), "utf8");

  it("pendingPhysical only counts sessions that have not expired", () => {
    const query = source.slice(source.indexOf("const pendingPhysical"), source.indexOf("const otherStation"));
    expect(query).toMatch(/state IN \('claimed','capturing'\)/);
    expect(query).toMatch(/physical_released = true/);
    expect(query).toMatch(/expires_at > NOW\(\)/);
  });

  it("completion is never derived from pendingPhysical", () => {
    // classifySidePresence receives evidence and holds as SEPARATE arguments; if someone merges them
    // again, `complete` stops meaning "there is evidence for both sides".
    expect(source).toMatch(/classifySidePresence\(\[\.\.\.evidencePresent\], \[\.\.\.present\]\)/);
  });
});
