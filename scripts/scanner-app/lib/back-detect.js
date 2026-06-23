/**
 * Content-based front/back detection for a scanned card pair.
 *
 * WHY: front/back used to be decided by ARRIVAL ORDER (first file = front).
 * That breaks under fast/out-of-order/multi-operator scanning and under the
 * confirmation-gate drain — a back can land first and get mislabelled as the
 * front, corrupting both the cert's stored front AND the confirmation popup
 * (see the MV219 swap, 2026-06-23).
 *
 * HOW: Pokémon card BACKS are identical, so they're template-matchable; fronts
 * are all different, so they are NOT. We therefore identify the BACK by
 * similarity to a bundled reference back, and the OTHER file is the front —
 * never the reverse. This is order-independent everywhere it's used.
 *
 * SIGNATURE: trim the scanner mat → squash to 32×32 → grayscale → raw bytes.
 * Distance = mean absolute difference (MAE) to the reference back's signature.
 * Validated on 9 real prod certs (2026-06-23): genuine backs scored 3.3–14.5,
 * fronts 38.7–56.4 — a ~24-point gap. The BACK_MAX/FRONT_MIN band (22/30) sits
 * inside that gap with margin on both sides, and correctly flagged MV219's swap.
 *
 * SAFETY: this NEVER throws to the caller and NEVER silently guesses. If a file
 * can't be read or the two scores don't land cleanly as "one back + one front",
 * it returns confident:false so the caller falls back to arrival/mtime order and
 * flags the card for a human to verify.
 */

const path = require("node:path");

// Reference back template, bundled with the app. Generated from a real raw back
// scan (MV217) — see assets/. The signature is recomputed from this image at
// first use so the algorithm and the asset stay in sync.
const REF_IMAGE = path.join(__dirname, "..", "assets", "pokemon-back-reference.jpg");

const SIG_DIM   = 32; // signature grid (32×32 grayscale = 1024 bytes)
const BACK_MAX  = 22; // MAE ≤ this → looks like a back  (gap floor was 14.5)
const FRONT_MIN = 30; // MAE ≥ this → clearly NOT a back (gap ceiling was 38.7)

let _refSig = null;

/** trim mat → 32×32 grayscale → raw bytes. Throws on unreadable input. */
async function signature(src) {
  const sharp = require("sharp");
  const raw = await sharp(src, { limitInputPixels: false })
    .trim()
    .resize(SIG_DIM, SIG_DIM, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  return new Uint8Array(raw);
}

async function refSig() {
  if (!_refSig) _refSig = await signature(REF_IMAGE);
  return _refSig;
}

function mae(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** MAE of a file to the reference back. Lower = more back-like. Infinity if the
 *  file (or the reference) can't be decoded — treated as "not classifiable". */
async function backScore(filePath) {
  try {
    const [ref, s] = await Promise.all([refSig(), signature(filePath)]);
    return mae(ref, s);
  } catch {
    return Infinity;
  }
}

/**
 * Decide which of two paired files is the front and which is the back, by
 * content. Returns { front, back, confident, reason, scoreA, scoreB }.
 *
 * confident is true ONLY when exactly one file is clearly a back (≤ BACK_MAX)
 * and the other clearly is not (≥ FRONT_MIN). Every other case — both look like
 * backs, neither does, scores fall in the borderline band, or a file failed to
 * decode — returns confident:false with front/back null, and the caller MUST
 * fall back to arrival/mtime order and flag the card.
 */
async function identifyFrontBack(fileA, fileB) {
  const [scoreA, scoreB] = await Promise.all([backScore(fileA), backScore(fileB)]);
  const base = { scoreA, scoreB };
  if (scoreA <= BACK_MAX && scoreB >= FRONT_MIN) {
    return { ...base, front: fileB, back: fileA, confident: true,
      reason: `A is the back (${scoreA.toFixed(1)}≤${BACK_MAX}), B the front (${scoreB.toFixed(1)}≥${FRONT_MIN})` };
  }
  if (scoreB <= BACK_MAX && scoreA >= FRONT_MIN) {
    return { ...base, front: fileA, back: fileB, confident: true,
      reason: `B is the back (${scoreB.toFixed(1)}≤${BACK_MAX}), A the front (${scoreA.toFixed(1)}≥${FRONT_MIN})` };
  }
  return { ...base, front: null, back: null, confident: false,
    reason: `no confident back: A=${scoreA.toFixed(1)} B=${scoreB.toFixed(1)} (band ${BACK_MAX}/${FRONT_MIN})` };
}

module.exports = { identifyFrontBack, backScore, signature, mae, SIG_DIM, BACK_MAX, FRONT_MIN };
