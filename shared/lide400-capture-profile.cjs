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
 * TWO NUMBERS THAT MUST NEVER BE CONFUSED.
 *
 *   OPERATOR INSET  10 mm  — the normal SAFE OPERATOR ZONE. A card inside the safe window is
 *                            comfortably placed. This is a placement guide, evaluated on a fast
 *                            300-DPI preview, and it has NO authority over evidence.
 *
 *   EVIDENCE FLOOR   4 mm  — the ABSOLUTE server rejection floor, applied to the immutable
 *                            1200-DPI master. A green preview NEVER overrides it.
 *
 * The 10 mm zone exists so staff have real placement tolerance; the 4 mm floor exists so a card
 * whose edge or corner is missing can never become grading evidence. Lowering the floor to buy
 * tolerance would trade an evidence guarantee for a UX problem that the inset already solves.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY 10 mm, EMPIRICALLY. Measured on the eight preserved 1200-DPI masters of 2026-08-17
 * (docs/scanner/CAPTURE_GEOMETRY_DECISION_20260817.md):
 *
 *   detector edge error vs true card                      <= 0.37 mm
 *   placement preview -> evidence master disagreement        0.05 mm
 *   scanner carriage repeatability                        <= 0.07 mm
 *   card shift between Preview and Scan                      1.00 mm  (ASSUMED, not measured)
 *   ----------------------------------------------------------------
 *   linear worst case                                        1.60 mm
 *
 * A card detected inside the safe window therefore reaches the master with at least
 * 10 - 1.60 = 8.40 mm of background, against a 4 mm requirement: 4.40 mm of headroom.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SAFE WINDOW IS CENTRED, AND THAT IS LOAD-BEARING.
 *
 * A centred rectangle is its own image under the 180-degree platen inversion:
 * (10, 10, 80, 110) inside 100 x 130 rotates to (100-10-80, 130-10-110, 80, 110) = (10, 10, 80, 110).
 *
 * So a containment verdict is identical whether it is computed in canonical evidence coordinates or
 * in the operator's rotated presentation view. `assertSafeWindowIsRotationInvariant` proves it at
 * load time rather than leaving it as a comment someone can quietly break by making the insets
 * asymmetric. CARD bounds are still required in canonical coordinates — only the WINDOW is exempt.
 */

const { CANONICAL_COORDINATE_SPACE } = require("./lide400-card-geometry.cjs");

/** Driver-reported LiDE 400 flatbed, confirmed from a 2550 x 3508 px 300-DPI full-platen preview. */
const PLATEN_MM = Object.freeze({ width: 216, height: 297 });

/**
 * Minimum distance from any platen edge to the capture window.
 *
 * NOT arbitrary. Non-card foreground on the real masters is a band in the first ~1.23 mm of the
 * platen's top edge and ~0.72 mm of its left edge, and nowhere else — it is the platen bezel, and it
 * is the reason a window anchored at (0,0) sees contamination at all. 5 mm clears the worst measured
 * band four times over.
 */
const MIN_PLATEN_INSET_MM = 5;

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

  /** The hardware acquisition rectangle. Size is fixed; only its platen origin is calibrated. */
  outerWindowMm: Object.freeze({ width: 100, height: 130 }),
  /** The operator-facing placement guide, centred inside the outer window. */
  safeWindowMm: Object.freeze({ width: 80, height: 110 }),
  /** Normal safe operator zone. NOT an evidence rule. */
  operatorInsetMm: 10,
  /** Absolute server evidence floor. Never relaxed by any preview verdict. */
  evidenceMinMarginMm: 4,
  /**
   * Measured linear worst case between a preview verdict and the evidence master: detector edge
   * error 0.40 + preview-to-master disagreement 0.10 + carriage repeatability 0.10 + assumed
   * card shift 1.00. See docs/scanner/CAPTURE_GEOMETRY_DECISION_20260817.md.
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
 * The safe placement window, in canonical millimetres relative to the acquisition rectangle's
 * top-left. Derived from the inset rather than stored twice, so 80 x 110 and "10 mm on all sides"
 * cannot drift apart.
 */
function safeWindowRectMm(profile = STANDARD_TCG) {
  const inset = profile.operatorInsetMm;
  return {
    x: inset,
    y: inset,
    width: profile.outerWindowMm.width - 2 * inset,
    height: profile.outerWindowMm.height - 2 * inset,
  };
}

/**
 * Load-time proof that the declared safe window, the declared inset and the outer window agree, and
 * that the result is centred (and therefore rotation-invariant). A profile that fails this is a
 * programming error, not a runtime condition — it throws on require rather than shipping a gate that
 * silently means something different in the operator's view than in the evidence path.
 */
function assertSafeWindowIsRotationInvariant(profile) {
  const derived = safeWindowRectMm(profile);
  if (derived.width !== profile.safeWindowMm.width || derived.height !== profile.safeWindowMm.height) {
    throw new Error(
      `Capture profile ${profile.id}: safeWindowMm ${profile.safeWindowMm.width}x${profile.safeWindowMm.height} ` +
        `disagrees with operatorInsetMm ${profile.operatorInsetMm} inside ${profile.outerWindowMm.width}x${profile.outerWindowMm.height} ` +
        `(derived ${derived.width}x${derived.height})`
    );
  }
  const rotated = {
    x: profile.outerWindowMm.width - (derived.x + derived.width),
    y: profile.outerWindowMm.height - (derived.y + derived.height),
  };
  if (rotated.x !== derived.x || rotated.y !== derived.y) {
    throw new Error(`Capture profile ${profile.id}: safe window is not centred, so it is not 180-degree invariant`);
  }
  const card = profile.cardMm;
  if (card.maxWidth > derived.width || card.maxHeight > derived.height) {
    throw new Error(`Capture profile ${profile.id}: the widest in-profile card does not fit its own safe window`);
  }
  return true;
}

for (const profile of Object.values(PROFILES)) assertSafeWindowIsRotationInvariant(profile);

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
 * THREE PLACEMENT STATES, and the middle one is the honest one.
 *
 *   GREEN  card is inside the 80 x 110 safe zone. Scan.
 *   AMBER  card has left the safe zone but still clears the 4 mm evidence floor with room to spare.
 *          It would probably survive the capture — and "probably" is not a standard, so SCAN stays
 *          locked. Amber exists so an operator who is 2 mm out is told they are nearly there rather
 *          than being shown the same red as someone whose card is half off the glass.
 *   RED    card is at or below the region where the 4 mm floor is genuinely at risk, or is not a
 *          Standard TCG card at all.
 *
 * AMBER NEVER AUTHORISES A CAPTURE. Only GREEN does. The band is feedback, not a second gate — the
 * moment amber could unlock SCAN, the operator zone would silently become 4 mm again.
 */
const PLACEMENT = Object.freeze({
  READY: "GREEN",
  MARGINAL: "AMBER",
  REPOSITION: "RED",
});

const PLACEMENT_MESSAGE = Object.freeze({
  ready: "CARD POSITION READY",
  marginal: "ALMOST — MOVE THE CARD INSIDE THE GREEN BOX",
  reposition: "PLACE THE WHOLE CARD INSIDE THE GREEN BOX",
  /*
   * A third message, deliberately. The two states the owner specified answer "is the card in the
   * box"; this answers "will this card ever fit", which the operator cannot fix by moving it. Telling
   * someone to reposition an oversized card is an instruction that can never succeed.
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
  const safe = safeWindowRectMm(profile);
  const base = {
    profileId: profile.id,
    profileVersion: profile.version,
    coordinateSpace: profile.coordinateSpace,
    safeWindowMm: safe,
    outerWindowMm: { x: 0, y: 0, ...profile.outerWindowMm },
    operatorInsetMm: profile.operatorInsetMm,
    evidenceMinMarginMm: profile.evidenceMinMarginMm,
  };

  const finite = (value) => Number.isFinite(Number(value));
  if (!cardBoundsMm || !["x", "y", "width", "height"].every((key) => finite(cardBoundsMm[key]))) {
    return { ...base, state: PLACEMENT.REPOSITION, code: "card_not_detected", message: PLACEMENT_MESSAGE.reposition, cardBoundsMm: null };
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

  const contained =
    card.x >= safe.x &&
    card.y >= safe.y &&
    card.x + card.width <= safe.x + safe.width &&
    card.y + card.height <= safe.y + safe.height;
  if (contained) {
    return { ...detail, state: PLACEMENT.READY, code: "ready", message: PLACEMENT_MESSAGE.ready };
  }
  /*
   * OUT OF THE SAFE ZONE, BUT HOW BADLY? Above the floor plus the measured preview-to-master budget,
   * the capture would probably still pass — so the operator is told they are close rather than being
   * shown the same signal as a card hanging off the platen. SCAN stays locked either way: amber is
   * feedback, and the only state that unlocks a capture is GREEN.
   */
  const amberFloor = profile.evidenceMinMarginMm + profile.previewToMasterBudgetMm;
  if (minMarginMm >= amberFloor) {
    return { ...detail, state: PLACEMENT.MARGINAL, code: "card_outside_safe_window_marginal", message: PLACEMENT_MESSAGE.marginal, amberFloorMm: amberFloor };
  }
  return { ...detail, state: PLACEMENT.REPOSITION, code: "card_outside_safe_window", message: PLACEMENT_MESSAGE.reposition, amberFloorMm: amberFloor };
}

/**
 * Placement latitude for a given real card, in millimetres. Diagnostics only — the gate itself
 * always measures, never predicts.
 */
function placementToleranceMm(cardSizeMm, profile = STANDARD_TCG) {
  const safe = safeWindowRectMm(profile);
  return {
    horizontal: Number(((safe.width - Number(cardSizeMm.width)) / 2).toFixed(2)),
    vertical: Number(((safe.height - Number(cardSizeMm.height)) / 2).toFixed(2)),
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
  safeWindowRectMm,
  clampCaptureOriginMm,
  captureWindowRectMm,
  evaluatePlacement,
  placementToleranceMm,
  assertSafeWindowIsRotationInvariant,
};
