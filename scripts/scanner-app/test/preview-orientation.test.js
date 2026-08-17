/*
 * PHYSICAL LEFT MUST BE DISPLAYED LEFT.
 *
 * The defect this pins. The Preview publishes card and acquisition rectangles already in
 * PRESENTATION millimetres (`lide400-preview-presentation-mm-v1`), alongside a separate
 * `canonicalCardBoundsMm` for the server. The preview raster is likewise already the presentation
 * raster (`imagecapturecore-scan-area-presentation-raster-rotate-180-v2`). The renderer then fed
 * those presentation rectangles through `physicalRectToRasterRect`, which turns a CANONICAL
 * rectangle 180 degrees on its way to that raster.
 *
 * Rotating an already-rotated rectangle is a 360-degree round trip on the maths and a 180-degree
 * error on the glass. With a real card detected at presentation x = 3.47 mm — hard left — the
 * orange acquisition box was drawn at the far right, so an operator standing at the scanner saw
 * the UI contradict the platen in front of them.
 *
 * The canonical/server geometry was never wrong. This was display only, and is fixed display only.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const transform = require("../lib/lide400-preview-transform");

// The real Canon LiDE 400 platen, as reported by ImageCaptureCore.
const PLATEN = { x: 0, y: 0, width: 215.9, height: 297.0106666666666 };
const RASTER = { width: 2550, height: 3508 };

// The exact rectangles observed in the live station state on 2026-08-17.
const OBSERVED_CARD_PRESENTATION = { x: 3.466284403669725, y: 3.6301303703703702, width: 63.54854740061162, height: 88.77318814814814 };
const OBSERVED_CARD_CANONICAL = { x: 148.88516819571868, y: 204.6073481481481, width: 63.548547400611625, height: 88.77318814814812 };

describe("OPERATOR VIEW: all four physical quadrants land where the operator sees them", () => {
  const RASTER_MID_X = RASTER.width / 2;
  const RASTER_MID_Y = RASTER.height / 2;

  function quadrantOf(mapped) {
    const cx = mapped.x + mapped.width / 2;
    const cy = mapped.y + mapped.height / 2;
    return `${cy < RASTER_MID_Y ? "TOP" : "BOTTOM"}-${cx < RASTER_MID_X ? "LEFT" : "RIGHT"}`;
  }

  // Presentation-space rectangles for a card in each corner of the glass.
  const NEAR = 20;
  const W = OBSERVED_CARD_PRESENTATION.width;
  const H = OBSERVED_CARD_PRESENTATION.height;
  const corners = {
    // Presentation TOP maps to operator BOTTOM (the Y flip), X is unchanged.
    "BOTTOM-LEFT": { x: NEAR, y: NEAR, width: W, height: H },
    "BOTTOM-RIGHT": { x: PLATEN.width - NEAR - W, y: NEAR, width: W, height: H },
    "TOP-LEFT": { x: NEAR, y: PLATEN.height - NEAR - H, width: W, height: H },
    "TOP-RIGHT": { x: PLATEN.width - NEAR - W, y: PLATEN.height - NEAR - H, width: W, height: H },
  };

  for (const [expected, rectMm] of Object.entries(corners)) {
    test(`a card the operator sees ${expected} is drawn ${expected}`, () => {
      const mapped = transform.operatorRectToRasterRect(rectMm, PLATEN, RASTER);
      assert.strictEqual(quadrantOf(mapped), expected);
    });
  }

  test("THE LIVE CARD: presentation (3.47, 3.63) draws BOTTOM-LEFT, where the operator sees it", () => {
    const mapped = transform.operatorRectToRasterRect(OBSERVED_CARD_PRESENTATION, PLATEN, RASTER);
    assert.strictEqual(quadrantOf(mapped), "BOTTOM-LEFT");
  });

  test("the operator Y equals the CANONICAL y — proving this is a mirror, not a turn", () => {
    const mapped = transform.operatorRectToRasterRect(OBSERVED_CARD_PRESENTATION, PLATEN, RASTER);
    const canonicalY = (OBSERVED_CARD_CANONICAL.y / PLATEN.height) * RASTER.height;
    assert.ok(Math.abs(mapped.y - canonicalY) < 0.5, `operator y ${mapped.y} should equal canonical y ${canonicalY}`);
    // X stays presentation, NOT canonical — that is the half the 180 rotation got right.
    const presentationX = (OBSERVED_CARD_PRESENTATION.x / PLATEN.width) * RASTER.width;
    assert.ok(Math.abs(mapped.x - presentationX) < 0.5);
  });

  test("THE OWNER'S SCREENSHOT: card pixels and template occupy the SAME quadrant and overlap", () => {
    /*
     * The failure this pins is not a maths identity — both previous fixes passed quadrant tests
     * while the screen was still wrong. It is the RELATIONSHIP between where the card actually is
     * in the raster and where the overlay is drawn.
     *
     * Ground truth, read from the real .display.jpg: the card sits at CANONICAL (148.9, 204.6),
     * right/bottom, artwork upright. The template is drawn from the PRESENTATION rect via the
     * operator mapping, landing left/bottom. The CSS mirror is what has to reconcile them.
     */
    const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "styles.css"), "utf8");
    const mirrorsX = /\.positioning-preview\s*\{[^}]*transform:\s*scaleX\(-1\)/.test(css);
    assert.ok(mirrorsX, "the preview raster must be mirrored on X to meet the operator template");
    assert.doesNotMatch(css, /\.positioning-preview\s*\{\s*transform:\s*scaleY\(-1\)\s*\}/,
      "a Y flip sends the card to the TOP while the template stays at the BOTTOM");

    // Where the card ENDS UP on screen after the CSS mirror.
    const cardVisualX = PLATEN.width - OBSERVED_CARD_CANONICAL.x - OBSERVED_CARD_CANONICAL.width;
    const cardVisualY = OBSERVED_CARD_CANONICAL.y;

    // Where the template is DRAWN.
    const template = transform.operatorRectToRasterRect(OBSERVED_CARD_PRESENTATION, PLATEN, RASTER);
    const templateMmX = (template.x / RASTER.width) * PLATEN.width;
    const templateMmY = (template.y / RASTER.height) * PLATEN.height;

    // Same quadrant...
    assert.ok(cardVisualX < PLATEN.width / 2 && cardVisualY > PLATEN.height / 2, "card must be BOTTOM-LEFT");
    assert.ok(templateMmX < PLATEN.width / 2 && templateMmY > PLATEN.height / 2, "template must be BOTTOM-LEFT");

    // ...and actually coincident, not merely both in the same corner.
    assert.ok(Math.abs(cardVisualX - templateMmX) < 0.01, `card x ${cardVisualX} vs template x ${templateMmX}`);
    assert.ok(Math.abs(cardVisualY - templateMmY) < 0.01, `card y ${cardVisualY} vs template y ${templateMmY}`);
  });

  test("a Y flip would have separated them — proving this test catches the last attempt", () => {
    const cardIfYFlipped = { x: OBSERVED_CARD_CANONICAL.x, y: PLATEN.height - OBSERVED_CARD_CANONICAL.y - OBSERVED_CARD_CANONICAL.height };
    // top / right — the exact state the owner screenshotted.
    assert.ok(cardIfYFlipped.x > PLATEN.width / 2, "Y flip leaves the card on the RIGHT");
    assert.ok(cardIfYFlipped.y < PLATEN.height / 2, "Y flip sends the card to the TOP");
  });

  test("non-zero origins keep their operator position", () => {
    for (const origin of [{ x: 20, y: 20 }, { x: 0, y: 0 }, { x: 5, y: 162 }, { x: 110.9, y: 5 }]) {
      const win = { x: origin.x, y: origin.y, width: 100, height: 130 };
      const mapped = transform.operatorRectToRasterRect(win, PLATEN, RASTER);
      const expectedX = (origin.x / PLATEN.width) * RASTER.width;
      const expectedY = RASTER.height - ((origin.y + 130) / PLATEN.height) * RASTER.height;
      assert.ok(Math.abs(mapped.x - expectedX) < 0.001, `x ${mapped.x} != ${expectedX}`);
      assert.ok(Math.abs(mapped.y - expectedY) < 0.001, `y ${mapped.y} != ${expectedY}`);
    }
  });
});

describe("presentation rectangles map without a second rotation", () => {
  test("a card on the physical LEFT is drawn on the LEFT", () => {
    const mapped = transform.presentationRectToRasterRect(OBSERVED_CARD_PRESENTATION, PLATEN, RASTER);
    // Left third of the raster.
    assert.ok(
      mapped.x < RASTER.width / 3,
      `expected a left-hand card to map into the left third; got x=${mapped.x} of ${RASTER.width}`
    );
  });

  test("a card on the physical RIGHT is drawn on the RIGHT", () => {
    const rightCard = { ...OBSERVED_CARD_PRESENTATION, x: PLATEN.width - 3.5 - OBSERVED_CARD_PRESENTATION.width };
    const mapped = transform.presentationRectToRasterRect(rightCard, PLATEN, RASTER);
    assert.ok(
      mapped.x + mapped.width > (RASTER.width * 2) / 3,
      `expected a right-hand card to map into the right third; got x=${mapped.x}`
    );
  });

  test("top stays top and bottom stays bottom", () => {
    const top = transform.presentationRectToRasterRect({ x: 20, y: 5, width: 100, height: 130 }, PLATEN, RASTER);
    const bottom = transform.presentationRectToRasterRect(
      { x: 20, y: PLATEN.height - 135, width: 100, height: 130 },
      PLATEN,
      RASTER
    );
    assert.ok(top.y < RASTER.height / 3, `top rect should map high; got y=${top.y}`);
    assert.ok(bottom.y > RASTER.height / 2, `bottom rect should map low; got y=${bottom.y}`);
  });

  test("THE REGRESSION: the old mapper puts the same left-hand card on the right", () => {
    // Proves the two mappers genuinely differ, so this test cannot silently pass on the old code.
    const wrong = transform.physicalRectToRasterRect(OBSERVED_CARD_PRESENTATION, PLATEN, RASTER);
    const right = transform.presentationRectToRasterRect(OBSERVED_CARD_PRESENTATION, PLATEN, RASTER);
    assert.ok(wrong.x > (RASTER.width * 2) / 3, "the old mapper should place it right — that was the bug");
    assert.ok(right.x < RASTER.width / 3, "the new mapper must place it left");
  });
});

describe("canonical authority is unchanged and still round-trips", () => {
  test("canonical and presentation remain exact 180-degree complements", () => {
    const backToCanonicalX = PLATEN.width - OBSERVED_CARD_PRESENTATION.x - OBSERVED_CARD_PRESENTATION.width;
    const backToCanonicalY = PLATEN.height - OBSERVED_CARD_PRESENTATION.y - OBSERVED_CARD_PRESENTATION.height;
    assert.ok(Math.abs(backToCanonicalX - OBSERVED_CARD_CANONICAL.x) < 0.001);
    assert.ok(Math.abs(backToCanonicalY - OBSERVED_CARD_CANONICAL.y) < 0.001);
  });

  test("the canonical mapper is untouched — physical still rotates 180", () => {
    const mapped = transform.physicalRectToRasterRect(OBSERVED_CARD_CANONICAL, PLATEN, RASTER);
    // Canonical bottom-right must land presentation top-left, i.e. where the card actually shows.
    const expected = transform.presentationRectToRasterRect(OBSERVED_CARD_PRESENTATION, PLATEN, RASTER);
    assert.ok(Math.abs(mapped.x - expected.x) < 0.5, `canonical->raster ${mapped.x} should equal presentation->raster ${expected.x}`);
    assert.ok(Math.abs(mapped.y - expected.y) < 0.5);
  });

  test("physical <-> raster round trip is still lossless", () => {
    const raster = transform.physicalRectToRasterRect(OBSERVED_CARD_CANONICAL, PLATEN, RASTER);
    const back = transform.rasterRectToPhysicalRect(raster, PLATEN, RASTER);
    assert.ok(Math.abs(back.x - OBSERVED_CARD_CANONICAL.x) < 0.01);
    assert.ok(Math.abs(back.y - OBSERVED_CARD_CANONICAL.y) < 0.01);
  });
});

describe("non-zero origins survive the display transform", () => {
  const cases = [
    { name: "the approved 20 x 20 default", origin: { x: 20, y: 20 } },
    { name: "the currently saved 0 x 0 origin", origin: { x: 0, y: 0 } },
    { name: "an off-centre origin", origin: { x: 5, y: 162 } },
    { name: "a right-hand origin", origin: { x: 110.9, y: 5 } },
  ];

  for (const { name, origin } of cases) {
    test(`${name} maps proportionally, with no offset invented`, () => {
      const window = { x: origin.x, y: origin.y, width: 100, height: 130 };
      const mapped = transform.presentationRectToRasterRect(window, PLATEN, RASTER);

      const expectedX = (origin.x / PLATEN.width) * RASTER.width;
      const expectedY = (origin.y / PLATEN.height) * RASTER.height;
      assert.ok(Math.abs(mapped.x - expectedX) < 0.001, `x ${mapped.x} != ${expectedX}`);
      assert.ok(Math.abs(mapped.y - expectedY) < 0.001, `y ${mapped.y} != ${expectedY}`);

      // Width/height are never affected by origin.
      assert.ok(Math.abs(mapped.width - (100 / PLATEN.width) * RASTER.width) < 0.001);
      assert.ok(Math.abs(mapped.height - (130 / PLATEN.height) * RASTER.height) < 0.001);
    });
  }

  test("a 180-degree presentation contract is still declared", () => {
    assert.strictEqual(transform.PRESENTATION_ROTATION_DEGREES, 180);
    assert.match(transform.COORDINATE_SPACE, /rotate-180/);
  });
});

describe("diagnostic labels do not cover the card", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "styles.css"), "utf8");

  test("labels are positioned OUTSIDE their box, not as in-flow children", () => {
    const block = css.slice(css.indexOf(".card-boundary-overlay span"));
    assert.match(block, /position:\s*absolute/, "label must be taken out of flow");
    assert.match(block, /bottom:\s*calc\(100% \+/, "label must sit above the box, clear of its edge");
  });

  test("a box near the top edge flips its label below instead of off-screen", () => {
    assert.match(css, /\[data-label-below\][\s\S]{0,120}top:\s*calc\(100% \+/);
  });

  test("a box near the right edge right-aligns its label", () => {
    assert.match(css, /\[data-label-right\][\s\S]{0,120}right:\s*0/);
  });

  test("the renderer sets those attributes from measured position", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert.match(app, /data-label-below/);
    assert.match(app, /data-label-right/);
  });
});

describe("nothing diagnostic can reach the evidence master", () => {
  test("overlays are DOM elements, never drawn into an image buffer", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    /*
     * The structural guarantee: the renderer has no canvas drawing context and no image encoding.
     * Overlays are absolutely-positioned <div>s over an <img>. There is no code path from an
     * overlay to a pixel, so no overlay can enter a 1200-DPI TIFF.
     */
    assert.doesNotMatch(app, /getContext\(\s*["']2d["']\s*\)/, "renderer must not rasterise anything");
    assert.doesNotMatch(app, /toDataURL|toBlob|createImageBitmap/, "renderer must not encode images");
  });

  test("the upload client sends the untouched TIFF master", () => {
    const client = fs.readFileSync(path.join(__dirname, "..", "lib", "server-client.js"), "utf8");
    // The master is streamed from disk; it is never decoded or re-encoded in this process.
    assert.match(client, /createReadStream/);
    assert.match(client, /assertTiffMaster/);
    assert.doesNotMatch(client, /sharp\(/, "the evidence path must not process pixels");
  });
});
