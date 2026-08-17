/**
 * THE CANONICAL CANON LiDE 400 CAPTURE PROFILE.
 *
 * ONE definition of the capture geometry, shared by the Scanner's station setup, the placement
 * Preview gate and the server's immutable-evidence validation — the same reason
 * `lide400-card-geometry.cjs` exists, applied to the numbers rather than the algorithm. Dependency-
 * free CommonJS with a hand-written `.d.cts`, because the Scanner is untranspiled CJS running from a
 * repository checkout and the server is an esbuild bundle.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ONE FIXED CAPTURE AREA, AND ONE NUMBER.
 *
 * The capture area is 100 x 130 mm. Its SIZE is fixed and its ORIGIN is calibrated once, during
 * station setup. It does not move afterwards, and — this is the part that was wrong before — it
 * never chases the card. The detector's job is to find the card INSIDE the fixed area, not to
 * propose somewhere else to put the area.
 *
 * TWO NUMBERS, AND ONLY ONE OF THEM IS A RULE ABOUT EVIDENCE.
 *
 *   MASTER EVIDENCE FLOOR      4.0 mm  — THE requirement. Every detected card edge on the immutable
 *                                        1200-DPI master must clear it. Authoritative, server-side,
 *                                        and no preview verdict of any colour overrides it.
 *
 *   PREVIEW GREEN THRESHOLD    5.6 mm  — DERIVED, never independently chosen:
 *                                        MASTER FLOOR + PREVIEW-TO-MASTER UNCERTAINTY.
 *
 * WHY THE PREVIEW NEEDS ITS OWN THRESHOLD AT ALL. A 300-DPI placement preview and a 1200-DPI master
 * are two different acquisitions of a card that may have moved between them. Gating the preview on
 * the master's own 4.0 mm meant a card at 4.1 mm previewed GREEN and could still be refused after a
 * full 45-second capture. Green then meant "probably", which is not something a shop can work with:
 * the operator did everything the screen asked and the scan failed anyway.
 *
 * GREEN NOW MEANS ONE THING: this placement is expected to survive final master validation.
 *
 * THE UNCERTAINTY IS MEASURED, NOT PREFERRED. From the eight preserved 1200-DPI masters of
 * 2026-08-17 (docs/scanner/CAPTURE_GEOMETRY_DECISION_20260817.md, "Error budget"):
 *
 *   detector edge error vs true card             measured <= 0.37 mm    budget 0.40 mm
 *   placement preview -> evidence master          measured    0.05 mm    budget 0.10 mm
 *   scanner carriage repeatability               measured <= 0.07 mm    budget 0.10 mm
 *   card shift between Preview and Scan          NOT MEASURABLE          budget 1.00 mm (assumed)
 *   -------------------------------------------------------------------------------------
 *   linear worst case                                                          1.60 mm
 *
 * The card-shift term is an assumption and is the dominant one; the document says so and so does
 * this comment. Improve that measurement and the preview threshold moves on its own, because it is
 * DERIVED — `previewGreenMinMarginMm()` is the only place the sum exists, and 5.6 is written down
 * nowhere as a constant.
 *
 * THIS IS NOT THE 10 mm GATE COMING BACK. That was an 80 x 110 inner box and a preference: it
 * refused placements that produced perfectly valid evidence, including MV272's accepted FRONT at a
 * 4.62 mm master margin, and it offered no account of itself beyond "more room is nicer". 5.6 mm is
 * the smallest threshold at which GREEN can honestly promise the master will pass. If the budget
 * were proven to be 0, this would collapse back to 4.0 mm on its own.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PLACEMENT BOUNDARY IS CENTRED, AND THAT IS LOAD-BEARING.
 *
 * A centred rectangle is its own image under the 180-degree platen inversion:
 * (5.6, 5.6, 88.8, 118.8) inside 100 x 130 rotates to itself.
 *
 * So a containment verdict is identical whether it is computed in canonical evidence coordinates or
 * in the operator's rotated presentation view. `assertPlacementBoundaryIsRotationInvariant` proves
 * it at load time rather than leaving it as a comment someone can quietly break by making the inset
 * asymmetric. CARD bounds are still required in canonical coordinates — only the BOUNDARY is exempt.
 */

const { CANONICAL_COORDINATE_SPACE } = require("./lide400-card-geometry.cjs");

/** Driver-reported LiDE 400 flatbed, confirmed from a 2550 x 3508 px 300-DPI full-platen preview. */
const PLATEN_MM = Object.freeze({ width: 216, height: 297 });

/**
 * Minimum distance from any platen edge to the capture window. ZERO, by owner decision on
 * 2026-08-17: the capture area may sit directly against the usable platen edge.
 *
 * WHAT THIS WAS, AND WHY IT CHANGED. It was 5 mm, justified by a real measurement: non-card
 * foreground on the eight preserved masters is a band in the first ~1.23 mm of the platen's top edge
 * and ~0.72 mm of its left edge — the platen bezel. That measurement still stands. What did not
 * stand was making it a HARD BOUND on the origin, because of what it did to a station already
 * calibrated to (0, 0):
 *
 *   `lide400-controller.jigOrigin()` treats an out-of-bounds saved origin as UNPROVISIONED rather
 *   than clamping it (correctly — silently moving a station's physical capture area would rewrite
 *   what every previously captured coordinate refers to). So a 5 mm floor turned the live station's
 *   (0, 0) calibration into "STATION CONFIGURATION PERSISTENCE IS NOT ENABLED", while the capture
 *   window simultaneously could not be moved because MV272 was open. That is a deadlock built out of
 *   two individually correct rules, and it stranded a card mid-capture with a preserved FRONT.
 *
 * THE BEZEL IS STILL REAL — it is just not the origin's problem. It is handled where it actually
 * bites: the canonical detector finds the card as a connected component rather than a global
 * bounding box, so a bezel band no longer stretches the card bounds; and the 4 mm evidence floor is
 * applied to the master regardless of where the window sits. A window at (0, 0) simply loses a
 * millimetre or so of usable background on two edges, which the floor then measures honestly.
 *
 * `defaultOriginMm` remains (20, 20), well clear of the bezel, so the RECOMMENDED position is
 * unchanged. This constant governs only what an operator is FORBIDDEN to choose.
 */
const MIN_PLATEN_INSET_MM = 0;

/** Millimetres, from the acquisition rectangle's top-left. Identical to the detector's convention. */
const COORDINATE_SPACE = CANONICAL_COORDINATE_SPACE;

/**
 * STANDARD TCG — the first and, for this release, only production profile.
 *
 * Deliberately NOT a universal profile. A larger card gets its own entry with its own window, safe
 * zone and card range, so "does this card belong in this profile" stays a real question with a real
 * answer instead of being absorbed by an ever-widening set of bounds.
 */
const STANDARD_TCG = Object.freeze({
  id: "standard-tcg",
  label: "Standard TCG",
  /** Bumped whenever any geometry below changes. Persisted with every calibration. */
  version: "capture-geometry-v1",
  /** The locked hardware profile this geometry is valid for. */
  scannerProfileVersion: "mintvault-canon-lide-400-v3",
  coordinateSpace: COORDINATE_SPACE,

  cardMm: Object.freeze({
    nominalWidth: 63.5,
    nominalHeight: 88.9,
    minWidth: 62.5,
    maxWidth: 65.0,
    minHeight: 87.5,
    maxHeight: 90.5,
  }),

  /**
   * THE FIXED CAPTURE AREA — the hardware acquisition rectangle. Size is fixed; only its platen
   * origin is calibrated, once, at station setup. Never derived from a detected card.
   */
  outerWindowMm: Object.freeze({ width: 100, height: 130 }),
  /**
   * THE AUTHORITATIVE EVIDENCE FLOOR, applied to the immutable 1200-DPI master. This is the real
   * requirement and the only one that decides whether a capture becomes evidence. Never relaxed.
   */
  evidenceMinMarginMm: 4,
  /**
   * PROVEN PREVIEW-TO-MASTER UNCERTAINTY. Linear worst case: detector edge error 0.40 +
   * preview-to-master disagreement 0.10 + carriage repeatability 0.10 + assumed card shift 1.00.
   * The last term is an ASSUMPTION, not a measurement, and dominates the sum — see
   * docs/scanner/CAPTURE_GEOMETRY_DECISION_20260817.md, "Error budget".
   *
   * This is an input to `previewGreenMinMarginMm()`, not a diagnostic. Changing it moves the preview
   * threshold and nothing else; the master floor above is unaffected by construction.
   */
  previewToMasterBudgetMm: 1.6,

  defaultOriginMm: Object.freeze({ x: 20, y: 20 }),
  captureDpi: 1200,
  placementPreviewDpi: 300,
});

const PROFILES = Object.freeze({ [STANDARD_TCG.id]: STANDARD_TCG });
const DEFAULT_PROFILE_ID = STANDARD_TCG.id;

function profileById(id) {
  const profile = PROFILES[String(id || DEFAULT_PROFILE_ID)];
  if (!profile) throw new Error(`Unknown LiDE capture profile: ${id}`);
  return profile;
}

/**
 * THE PREVIEW GREEN THRESHOLD — the single authority for "how far in is far enough to press SCAN".
 *
 * Derived, never stored: the master evidence floor plus the proven preview-to-master uncertainty.
 * 5.6 appears nowhere as a literal, so improving the card-shift measurement moves this on its own
 * and cannot leave a stale constant behind somewhere else.
 *
 * NOT an evidence rule. The server re-derives geometry from the immutable master and applies
 * `evidenceMinMarginMm` itself; this only decides whether a 300-DPI preview may unlock a capture.
 */
function previewGreenMinMarginMm(profile = STANDARD_TCG) {
  return Number((profile.evidenceMinMarginMm + profile.previewToMasterBudgetMm).toFixed(3));
}

/**
 * The placement boundary, in canonical millimetres relative to the acquisition rectangle's top-left:
 * the capture area inset by the PREVIEW threshold.
 *
 * Inset by the preview threshold and not the master floor, deliberately: this rectangle is what the
 * operator overlay draws, and the line on screen must be the line the gate applies. Drawing the
 * 4.0 mm master floor here while gating at 5.6 mm would put a card visibly inside the box and still
 * refuse it, which is the exact confusion this whole change exists to remove.
 *
 * Derived from the threshold rather than stored as its own 88.8 x 118.8 constant, so the boundary
 * and the gate cannot drift apart — the failure a second stored rectangle invites.
 */
function placementBoundaryRectMm(profile = STANDARD_TCG) {
  const inset = previewGreenMinMarginMm(profile);
  return {
    x: inset,
    y: inset,
    width: profile.outerWindowMm.width - 2 * inset,
    height: profile.outerWindowMm.height - 2 * inset,
  };
}

/**
 * Load-time proof that the placement boundary is centred (and therefore 180-degree invariant), and
 * that the widest in-profile card actually fits inside it. A profile that fails this is a
 * programming error, not a runtime condition — it throws on require rather than shipping a gate that
 * silently means something different in the operator's view than in the evidence path.
 */
function assertPlacementBoundaryIsRotationInvariant(profile) {
  const derived = placementBoundaryRectMm(profile);
  const rotated = {
    x: profile.outerWindowMm.width - (derived.x + derived.width),
    y: profile.outerWindowMm.height - (derived.y + derived.height),
  };
  /*
   * Compared with an epsilon, not exactly. The inset is now a SUM of two decimals (4 + 1.6), so the
   * rotated edge lands at 5.6000000000000085 rather than 5.6 — a binary floating-point artefact, not
   * an asymmetry. An exact comparison here would refuse a perfectly centred rectangle. The epsilon is
   * many orders of magnitude below the ~0.05 mm the detector can actually resolve, so a genuinely
   * off-centre profile still throws.
   */
  const EPSILON_MM = 1e-9;
  if (Math.abs(rotated.x - derived.x) > EPSILON_MM || Math.abs(rotated.y - derived.y) > EPSILON_MM) {
    throw new Error(`Capture profile ${profile.id}: placement boundary is not centred, so it is not 180-degree invariant`);
  }
  const card = profile.cardMm;
  if (card.maxWidth > derived.width || card.maxHeight > derived.height) {
    throw new Error(
      `Capture profile ${profile.id}: the widest in-profile card (${card.maxWidth}x${card.maxHeight} mm) does not fit ` +
        `inside its own placement boundary (${derived.width}x${derived.height} mm)`
    );
  }
  return true;
}

for (const profile of Object.values(PROFILES)) assertPlacementBoundaryIsRotationInvariant(profile);

/**
 * Clamp a proposed capture-window origin onto the platen.
 *
 * Returns the clamped origin and whether clamping was needed, so the setup UI can refuse to move
 * further rather than silently accepting a drag that would push the window off the glass.
 */
function clampCaptureOriginMm(origin, profile = STANDARD_TCG, platen = PLATEN_MM) {
  const requestedX = Number(origin && origin.x);
  const requestedY = Number(origin && origin.y);
  if (!Number.isFinite(requestedX) || !Number.isFinite(requestedY)) {
    throw new Error("Capture window origin must be finite X/Y millimetres");
  }
  const inset = MIN_PLATEN_INSET_MM;
  const maxX = platen.width - profile.outerWindowMm.width - inset;
  const maxY = platen.height - profile.outerWindowMm.height - inset;
  if (maxX < inset || maxY < inset) {
    throw new Error(`Capture window ${profile.outerWindowMm.width}x${profile.outerWindowMm.height} mm does not fit this platen`);
  }
  const x = Math.min(maxX, Math.max(inset, requestedX));
  const y = Math.min(maxY, Math.max(inset, requestedY));
  return {
    originMm: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) },
    clamped: x !== requestedX || y !== requestedY,
    boundsMm: { minX: inset, maxX: Number(maxX.toFixed(2)), minY: inset, maxY: Number(maxY.toFixed(2)) },
  };
}

/** The full acquisition rectangle on the platen for a calibrated origin. */
function captureWindowRectMm(originMm, profile = STANDARD_TCG) {
  const { originMm: clamped } = clampCaptureOriginMm(originMm, profile);
  return { x: clamped.x, y: clamped.y, width: profile.outerWindowMm.width, height: profile.outerWindowMm.height };
}

/**
 * TWO PLACEMENT STATES. There is no middle any more, by owner decision on 2026-08-17.
 *
 *   GREEN  every detected card edge is at least 4 mm inside the fixed capture area. Scan.
 *   RED    an edge is within 4 mm of the capture boundary, the card crosses it, no card was
 *          detected, or the card is not a Standard TCG card at all.
 *
 * The previous AMBER band sat between the 4 mm floor and a 10 mm operator inset and unlocked
 * nothing, which meant the Scanner routinely refused a card that satisfied the only rule governing
 * evidence. Collapsing to one number removes a whole class of "why won't it let me" — the operator
 * is told to move the card only when moving it is genuinely required.
 */
const PLACEMENT = Object.freeze({
  READY: "GREEN",
  REPOSITION: "RED",
});

const PLACEMENT_MESSAGE = Object.freeze({
  ready: "CARD POSITION READY",
  reposition: "MOVE CARD AWAY FROM EDGE",
  notDetected: "PUT THE WHOLE CARD INSIDE THE CAPTURE AREA",
  /*
   * A distinct message, deliberately. The states above answer "is the card far enough in"; this
   * answers "will this card ever fit", which the operator cannot fix by moving it. Telling someone to
   * reposition an oversized card is an instruction that can never succeed.
   */
  wrongProfile: "THIS CARD IS NOT A STANDARD SIZE — USE A DIFFERENT CARD PROFILE",
});

/**
 * THE PLACEMENT GATE. Real detected card bounds in, RED/GREEN out.
 *
 * `cardBoundsMm` MUST be canonical acquisition-rect millimetres — the detector's own output, never a
 * nominal 63.5 x 88.9 assumption. The whole point of the gate is that it measures the card actually
 * on the glass, including its real size, its real position and the detector's real error.
 *
 * This function has NO authority over evidence. It returns a placement verdict only; the server
 * re-derives geometry from the immutable master and applies `evidenceMinMarginMm` itself.
 */
function evaluatePlacement(cardBoundsMm, profile = STANDARD_TCG) {
  const boundary = placementBoundaryRectMm(profile);
  const base = {
    profileId: profile.id,
    profileVersion: profile.version,
    coordinateSpace: profile.coordinateSpace,
    placementBoundaryMm: boundary,
    outerWindowMm: { x: 0, y: 0, ...profile.outerWindowMm },
    evidenceMinMarginMm: profile.evidenceMinMarginMm,
  };

  const finite = (value) => Number.isFinite(Number(value));
  if (!cardBoundsMm || !["x", "y", "width", "height"].every((key) => finite(cardBoundsMm[key]))) {
    return { ...base, state: PLACEMENT.REPOSITION, code: "card_not_detected", message: PLACEMENT_MESSAGE.notDetected, cardBoundsMm: null };
  }
  const card = {
    x: Number(cardBoundsMm.x),
    y: Number(cardBoundsMm.y),
    width: Number(cardBoundsMm.width),
    height: Number(cardBoundsMm.height),
  };

  /** Background visible on each side of the card inside the acquisition rectangle. */
  const marginMm = {
    left: card.x,
    top: card.y,
    right: profile.outerWindowMm.width - (card.x + card.width),
    bottom: profile.outerWindowMm.height - (card.y + card.height),
  };
  const minMarginMm = Math.min(marginMm.left, marginMm.top, marginMm.right, marginMm.bottom);
  const detail = { ...base, cardBoundsMm: card, marginMm, minMarginMm };

  const range = profile.cardMm;
  if (
    card.width < range.minWidth ||
    card.width > range.maxWidth ||
    card.height < range.minHeight ||
    card.height > range.maxHeight
  ) {
    return { ...detail, state: PLACEMENT.REPOSITION, code: "card_outside_profile_range", message: PLACEMENT_MESSAGE.wrongProfile };
  }

  /*
   * THE WHOLE GATE, IN ONE COMPARISON — against the PREVIEW threshold, not the master floor.
   *
   * `minMarginMm` is already measured from the card to each edge of the capture area above, so
   * 5.60 mm passes and 5.59 mm does not. Gating on the master's 4.0 mm here is what produced
   * false GREENs: it promised the operator a capture that the master could still refuse.
   *
   * `placementBoundaryRectMm` expresses the same threshold as a rectangle for the overlay to draw;
   * it is deliberately NOT used as the test, so one derivation governs both and the line on screen
   * cannot come apart from the rule.
   */
  const previewFloor = previewGreenMinMarginMm(profile);
  if (minMarginMm >= previewFloor) {
    return {
      ...detail,
      state: PLACEMENT.READY,
      code: "ready",
      message: PLACEMENT_MESSAGE.ready,
      previewGreenMinMarginMm: previewFloor,
    };
  }
  return {
    ...detail,
    state: PLACEMENT.REPOSITION,
    code: "card_inside_preview_margin",
    message: PLACEMENT_MESSAGE.reposition,
    previewGreenMinMarginMm: previewFloor,
    /** How much further in the card must move to reach GREEN. Diagnostics, and honest UI copy. */
    moveInwardMm: Number((previewFloor - minMarginMm).toFixed(2)),
    /*
     * A card between the master floor and the preview threshold would PROBABLY have produced valid
     * evidence — it is refused because "probably" cannot be what a green light means, not because
     * the placement is wrong. Surfaced in diagnostics so a marginal refusal is explainable.
     */
    wouldLikelyPassMaster: minMarginMm >= profile.evidenceMinMarginMm,
  };
}

/**
 * Placement latitude for a given real card, in millimetres. Diagnostics only — the gate itself
 * always measures, never predicts.
 */
function placementToleranceMm(cardSizeMm, profile = STANDARD_TCG) {
  const boundary = placementBoundaryRectMm(profile);
  return {
    horizontal: Number(((boundary.width - Number(cardSizeMm.width)) / 2).toFixed(2)),
    vertical: Number(((boundary.height - Number(cardSizeMm.height)) / 2).toFixed(2)),
  };
}

module.exports = {
  PLATEN_MM,
  MIN_PLATEN_INSET_MM,
  COORDINATE_SPACE,
  STANDARD_TCG,
  PROFILES,
  DEFAULT_PROFILE_ID,
  PLACEMENT,
  PLACEMENT_MESSAGE,
  profileById,
  previewGreenMinMarginMm,
  placementBoundaryRectMm,
  clampCaptureOriginMm,
  captureWindowRectMm,
  evaluatePlacement,
  placementToleranceMm,
  assertPlacementBoundaryIsRotationInvariant,
};
