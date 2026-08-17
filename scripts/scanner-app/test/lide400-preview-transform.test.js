const test = require("node:test");
const assert = require("node:assert/strict");
const transform = require("../lib/lide400-preview-transform");
const cardDetection = require("../lib/lide400-card-detection");
const { detectCardBounds } = cardDetection;
const captureProfile = require("../../../shared/lide400-capture-profile.cjs");

const fullPlaten = { x: 0, y: 0, width: 215.9, height: 297.0106666666666 };
const observedCard = { x: 4.6217125382263, y: 9.240331851851849, width: 64.20879204892967, height: 89.10319999999999 };
const latestObservedCard = { x: 13.535015290519876, y: 14.850533333333331, width: 64.20879204892967, height: 89.10319999999999 };

function close(actual, expected, tolerance = 0.01) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} within ${tolerance} of ${expected}`);
}

test("ImageCaptureCore physical millimetres round-trip through the upright 180-degree presentation raster", () => {
  const preview = { width: 2550, height: 3508 };
  const raster = transform.physicalRectToRasterRect(observedCard, fullPlaten, preview);
  close(raster.x, 1737.04, 0.2);
  close(raster.y, 2346.46, 0.2);
  const roundTrip = transform.rasterRectToPhysicalRect(raster, fullPlaten, preview);
  for (const key of ["x", "y", "width", "height"]) close(roundTrip[key], observedCard[key], 1e-9);
  assert.equal(transform.assertUprightOrientation(1), 1);
  assert.equal(transform.assertUprightOrientation(undefined), 1);
  assert.throws(() => transform.assertUprightOrientation(6), /upright/);
});

test("contained Preview overlay uses the real portrait image rectangle and 180-degree presentation mapping", () => {
  // The Scanner preview is 480 × 260 CSS pixels while the physical Preview is
  // portrait. object-fit: contain centres a 188.9 px-wide image at x=145.5.
  const mapped = transform.physicalRectToContainedViewportRect(
    observedCard,
    fullPlaten,
    { width: 1308, height: 1800 },
    { width: 480, height: 260 },
  );
  close(mapped.imageRect.x, 145.53, 0.1);
  close(mapped.imageRect.width, 188.93, 0.1);
  close(mapped.x, 274.23, 0.2);
  close(mapped.y, 173.91, 0.2);
  close(mapped.width, 56.22, 0.2);
  // The obsolete percentage mapping placed this by a raw physical edge. The
  // canonical contained presentation mapping retains the 180° transform.
  assert.ok(mapped.x > 250);
  assert.ok(mapped.y > 150);
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CARD-CHASING ARCHITECTURE IS GONE, AND THESE TESTS HOLD IT DOWN.
 *
 * Two tests here used to assert `derivePlacementProposal`: that an edge-adjacent card yielded a
 * proposed acquisition rectangle at NEGATIVE coordinates, and that a card further in "established a
 * generous 9 mm placement envelope". Both were faithful tests of a rejected design — the rectangle
 * moved to chase the card, so a card near the glass edge asked the hardware to scan off the platen.
 *
 * They are replaced, not deleted, and they keep the same real measurements from the physical
 * Previews of 2026-08-17 so the evidence outlives the design it was gathered under.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

test("the card-chasing proposal is gone and cannot be reintroduced by import", () => {
  assert.equal(
    cardDetection.derivePlacementProposal,
    undefined,
    "derivePlacementProposal derived acquisition geometry from card position; the capture area is fixed"
  );
  assert.equal(cardDetection.DEFAULT_PLACEMENT_TOLERANCE_MM, undefined, "the 9 mm envelope was part of the chasing solve");
  assert.equal(
    cardDetection.MIN_EVIDENCE_MARGIN_MM,
    captureProfile.STANDARD_TCG.evidenceMinMarginMm,
    "the detector's margin must be the profile's, not a second copy of 4"
  );
});

test("MV272's real FRONT placement is master-valid but preview-refused, and the two are different questions", () => {
  /*
   * THE MEASUREMENT THAT SETTLED THE ARGUMENT, and then settled the next one too.
   *
   * This is the card position that produced MV272's accepted FRONT master: a 4.62 mm minimum margin.
   * It cleared the 4 mm MASTER floor, so that evidence is valid and stays valid.
   *
   * It does NOT clear the 5.6 mm PREVIEW threshold, and that is correct rather than a return of the
   * 10 mm gate. 4.62 minus the proven 1.60 mm acquisition uncertainty is 3.02 mm — below the master
   * floor. That placement was a coin toss, and the sibling fixture `mv272-back-rejected` is what
   * losing it looks like: 3.752 mm, refused by the server after a full 45-second scan.
   */
  close(observedCard.x, 4.62, 0.02);
  const verdict = captureProfile.evaluatePlacement({
    x: observedCard.x,
    y: observedCard.y,
    width: 63.5,
    height: 88.9,
  });
  assert.equal(verdict.state, captureProfile.PLACEMENT.REPOSITION);
  assert.equal(verdict.code, "card_inside_preview_margin");
  close(verdict.minMarginMm, 4.62, 0.02);
  // Refused, but honest: this one would probably have survived the master.
  assert.equal(verdict.wouldLikelyPassMaster, true);
  // The master floor itself is untouched by the preview threshold.
  assert.equal(verdict.evidenceMinMarginMm, 4);
});

test("a card well inside the fixed capture area is GREEN with the full budget above the master floor", () => {
  const verdict = captureProfile.evaluatePlacement({
    x: latestObservedCard.x,
    y: latestObservedCard.y,
    width: 63.5,
    height: 88.9,
  });
  assert.equal(verdict.state, captureProfile.PLACEMENT.READY);
  close(verdict.minMarginMm, 13.54, 0.02);
  /*
   * NO FALSE GREEN: even in the linear worst case this placement reaches the master above 4 mm.
   * That is what GREEN is promising, expressed as the arithmetic rather than as a colour.
   */
  const worstCaseAtMaster = verdict.minMarginMm - captureProfile.STANDARD_TCG.previewToMasterBudgetMm;
  assert.ok(worstCaseAtMaster >= captureProfile.STANDARD_TCG.evidenceMinMarginMm);
  /*
   * THE POINT OF THE WHOLE CHANGE: the capture area did not move. Both cards above are judged
   * against the same fixed 100 x 130 rectangle at the same origin, and only the card moved.
   */
  assert.deepEqual(verdict.outerWindowMm, { x: 0, y: 0, width: 100, height: 130 });
});

test("positioning Preview detects an isolated card despite a full-width dark platen reflection", () => {
  const width = 1308;
  const height = 1800;
  const raw = Buffer.alloc(width * height * 3, 233);
  const pixel = (x, y, rgb) => raw.set(rgb, (y * width + x) * 3);
  // A card at the measured physical scale. Its dark border is connected and
  // fills its expected bounds, but its inner artwork has normal variation.
  // This is the 180-degree presentation raster. Its physical top-left card
  // therefore appears bottom-right in the image returned to the detector.
  for (let y = 1223; y < 1762; y++) {
    for (let x = 885; x < 1272; x++) {
      pixel(x, y, (x === 885 || x === 1271 || y === 1223 || y === 1761) ? [35, 35, 35] : [125, 80, 165]);
    }
  }
  // This is a separate reflection in a real full-platen Preview. Projection
  // occupancy now touches every column and would make the former detector
  // return null; it must not hide the physically visible card.
  for (let y = 169; y < 591; y++) {
    for (let x = 0; x < width; x++) pixel(x, y, [40, 40, 40]);
  }
  const candidate = detectCardBounds(raw, width, height, fullPlaten);
  assert.ok(candidate, "expected the card candidate despite unrelated full-width reflection");
  // Renamed with the canonical detector; the behaviour is identical — projection cannot separate
  // the card through a full-width reflection, so the card-sized component fallback answers.
  assert.equal(candidate.detectionMethod, "dominant_component");
  close(candidate.cardBoundsMm.x, 5.94, 0.05);
  close(candidate.cardBoundsMm.y, 6.27, 0.05);
  close(candidate.cardBoundsMm.width, 63.88, 0.05);
  close(candidate.cardBoundsMm.height, 88.94, 0.05);
});
