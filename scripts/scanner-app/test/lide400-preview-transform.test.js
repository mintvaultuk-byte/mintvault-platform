const test = require("node:test");
const assert = require("node:assert/strict");
const transform = require("../lib/lide400-preview-transform");
const { detectCardBounds, derivePlacementProposal } = require("../lib/lide400-card-detection");

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

test("edge-adjacent broad Preview produces an unsaveable, visibly clipped final-area proposal", () => {
  const placement = derivePlacementProposal({
    cardBoundsMm: observedCard,
    surroundingBackgroundMm: { left: observedCard.x, top: observedCard.y, right: 147.07, bottom: 198.67 },
  }, fullPlaten, { width: 100, height: 130 });
  assert.equal(placement.ready, false);
  assert.equal(placement.evidenceMarginSatisfied, true, "the broad Preview proves all four current card edges remain visible");
  close(placement.observedEvidenceMarginMm, 4.62, 0.02);
  assert.ok(placement.proposedHardwareRectMm.x < 0);
  assert.ok(placement.proposedHardwareRectMm.y < 0);
  close(placement.minimumMoveInwardMm.x, 8.38, 0.02);
  close(placement.minimumMoveInwardMm.y, 3.76, 0.02);
});

test("latest physical Preview establishes a generous 9 mm placement envelope without a 1 mm operator shuffle", () => {
  const placement = derivePlacementProposal({
    cardBoundsMm: latestObservedCard,
    surroundingBackgroundMm: { left: latestObservedCard.x, top: latestObservedCard.y, right: 138.16, bottom: 193.06 },
  }, fullPlaten, { width: 100, height: 130 });
  assert.equal(placement.ready, true);
  assert.ok(placement.placementToleranceMm >= 9);
  close(placement.originMm.x, 0, 0.02);
  close(placement.originMm.y, 0, 0.02);
  assert.ok(placement.hardwareMarginMm.left >= 13);
  assert.ok(placement.hardwareMarginMm.top >= 13);
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
  assert.equal(candidate.detectionMethod, "connected_component");
  close(candidate.cardBoundsMm.x, 5.94, 0.05);
  close(candidate.cardBoundsMm.y, 6.27, 0.05);
  close(candidate.cardBoundsMm.width, 63.88, 0.05);
  close(candidate.cardBoundsMm.height, 88.94, 0.05);
});
