# MintVault CV Grading — Algorithm Design

Design decisions and algorithm notes across all CV modules. Read alongside
each module's inline documentation.

## Shared architecture

Every CV module follows the same contract:
- **Input**: aligned card scan from the V850 pipeline (post-crop, 0.716 aspect)
- **Output**: JSON structured result with a `confidence` field (0..1)
- **Method version**: string e.g. `centering.v1` — bump when algorithm changes
- **Notes**: human-readable warnings list

All modules use:
- Shared `utils.py` for outer-card detection + inner-frame detection
- Median/MAD-based estimators for robustness to noise
- Explicit saturation-channel thresholds for yellow-border detection

## Module algorithms

### centering.py — PSA centering measurement

**Approach**: find outer card (image bounds on scanner output), find inner
print frame (saturation transition from white cardboard → yellow border),
compute per-side border widths, return H/V ratios and PSA ceiling.

**Edge detection**: 21 parallel sample lines per side, median used as the
per-side estimate. Mean absolute deviation of samples → confidence.

**Scoring**: worse-side / (worse + better) → percentage. Worse of the two
axes (H, V) determines PSA ceiling via published thresholds.

Full details: see `centering.py` + `test_centering_robustness.py` for the 11
test fixtures covering noise, rotation, and border print variation.

### card_id.py — OCR card identification

**Approach**: extract bottom 7% of card (where card number + set + copyright
live), upscale + binarise, run Tesseract (psm 6 for multiline text, psm 10
single-character mode for the regulation-mark circle).

**Parsing**:
- Card number: regex `\d{1,3}\s*/\s*\d{1,3}` with O→0 cleanup
- Copyright: regex matching `©|(c)|Pokemon|Nintendo` followed by 4-digit year,
  falling back to isolated 4-digit year (1996-2035)
- Regulation mark: dedicated inverted-binary pass over left 20% of strip,
  single-character OCR with whitelist DEFGHIJ
- Set code: 2-5 char [a-zA-Z0-9], scored by proximity to card number +
  preference for digit-containing codes > 3+ letter codes > 2-letter codes

**DB lookup**: local JSON `data/pokemon_sets.json` with exact-match + alias
resolution. Seeded with 40+ sets; augment from pokemontcg.io on-prem.

**Confidence**: weighted average — card number (0.5), copyright (0.2),
set code (0.2), regulation mark (0.1).

### surface.py — art-region defect detection

**Approach**: extract the art region (inside the yellow print frame with 4%
inset), run two independent detectors, combine scores.

**Scratch detector**:
1. Grayscale + CLAHE local contrast
2. Bilateral filter (preserves edges, suppresses texture)
3. Canny edge detection (30/90 thresholds, calibrated for thin features)
4. Hough line transform (min length 5% of card diagonal, max gap 0.5%)
5. Reject near-border lines (inner-frame bleed)
6. Score = `clip(1 - density/0.08, 0, 1)` where density = scratches per 10k px²

**Print-line detector** (FFT):
1. Gaussian-blur detrend (removes natural art gradient)
2. FFT of row-means and column-means
3. Peak-to-mean ratio in mid-freq band (cycles 5-250)
4. Score = linear ramp from 1.0 (ratio ≤ 4) to 0.0 (ratio ≥ 15)

**Combination**: `0.65 * scratch_score + 0.35 * print_line_score`

Key design choice: works on white-mat scans because the art region is
coloured/high-saturation — defects create linear discontinuities in an
otherwise-continuous coloured area. Fundamentally different from measuring
the outer card edge (invisible on white mat).

### miscut.py — print-alignment variation

**Approach**: measure the white-border thickness at 41 positions along each
of the 4 sides. Compute coefficient of variation (std/mean) per side. Worst
CoV determines classification.

**Classification thresholds**:
- `≤ 0.05` — perfect
- `≤ 0.10` — slight (normal print variation)
- `≤ 0.20` — noticeable (possible miscut)
- `> 0.20` — miscut

**Slant detection**: linear regression over the thickness series; if the
slope across the full side exceeds 30% of the mean, a slant is flagged.

**Why this is orthogonal to centering**: centering measures MEDIAN thickness
per side. Miscut measures VARIATION of thickness ALONG the side. A miscut
card has uniform MEAN but varying ACTUAL thickness — the yellow border
slants across the card.

### holofoil.py — perceptual hash signature

**Approach**: extract art region, compute three perceptual hashes (phash,
dhash, whash at 16×16 each), combine into a 384-bit signature.

**Comparison**: Hamming distance, weighted
(`0.3*phash + 0.3*dhash + 0.4*whash`). Verdict thresholds:
- `< 0.05` — same card
- `< 0.15` — likely same card
- `< 0.30` — uncertain
- `≥ 0.30` — different cards

**Use cases**:
1. **Authentication**: compare scan to known-genuine reference hash
2. **Duplicate detection**: same hash across two MintVault submissions = same physical card

**Robustness**: tested against JPEG-75% compression and light scratches — no
verdict flip. Not robust to actual counterfeits that reproduce the art
faithfully; foil shimmer + print-dot patterns would need higher-resolution
techniques out of v1 scope.

### grade_synthesis.py — final PSA grade

**Approach**: PSA-style minimum of sub-grade ceilings. Each sub-grade has:
- `ceiling` — integer 1-10
- `source` — `cv` / `ai` / `missing`
- `confidence` — 0..1

Limiting factor = sub-grade with lowest ceiling.
Overall confidence = min of all involved confidences (most pessimistic).

**Missing sub-grades**: a missing sub-grade is treated as "unrestricted" (ceiling 10)
but flagged in notes. Production rule should require corners and edges from
either CV (future) or AI fallback before accepting a grade.

**Gem-mint bonus**: If all CV sub-grades are 10 and AI sub-grades ≥ 10, PSA 10
allowed. Otherwise the minimum sub-grade wins (no bonus).

**Reasoning**: human-readable trace of every sub-grade's source + confidence
so admin reviewer can audit the decision.

## White-mat limitation — why corners/edges are blocked

Physical reality: Pokémon cards have white cardboard outer borders. The V850
scanner mat is also white. After the scanner pipeline crops tight to the card,
the outer card edge has no background contrast — it's white against white.

Specific failures on white mat:
- **Corner rounding**: invisible (rounded corner = still white)
- **Corner whitening**: invisible (already white cardboard)
- **Corner chipping**: invisible (chip is white)
- **Edge chipping/whitening**: same — the cut edge is where damage shows, but
  it's not visually distinguishable from the mat

PSA and BGS physically use black velvet for the same reason — contrast at the
cut edge is required for CV (or even human eyes with a loupe).

**Mitigations considered**:
1. Dark mat for grading scans only — cleanest fix, hardware change
2. Scanner pipeline preserves mat border — works if mat is non-white
3. Controlled side-lighting to cast shadow at cut edge — requires lightbox
4. Post-grade certificate photograph with dark background — workflow change

For v1, corners and edges remain AI-dependent. The other modules ship and
deliver the bulk of the AI cost reduction.

## Confidence gating — recommended production thresholds

Per-module:
- `centering.confidence ≥ 0.85` — accept, else AI fallback for centering
- `surface.confidence ≥ 0.85` — accept, else AI fallback for surface
- `miscut.confidence ≥ 0.85` — accept, else AI fallback for miscut
- `card_id.confidence ≥ 0.70` — accept; card_id is more forgiving because
  the admin can confirm visually

Synthesis-level:
- Overall confidence < 0.65 → route to human reviewer regardless of grade
- Grade ≤ 7 → route to human reviewer (high-stakes for disputes)
- Any module error → route to human reviewer
