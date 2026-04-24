# Centering Measurement — Algorithm Design

## Input
- Aligned card scan from V850 pipeline (0.716±0.005 aspect, white-mat background)
- Image is the isolated card (mat already cropped out by scanner pipeline)

## Goal
Measure centering of the printed image inside the white cardboard border.
Output: horizontal centering (e.g. 55/45) and vertical centering (e.g. 60/40).

## The two boundaries we need
1. **Outer boundary** (cardboard edge) — the physical edge of the card
2. **Inner boundary** (print frame) — where the yellow Pokémon border starts, or the inner edge of the white border

On a Pokémon card:
- Outer: white cardboard edge against scan background
- Inner: yellow Pokémon border starts after ~2-3mm of white border
  (or red/blue/black for other TCG variants — but MintVault is Pokémon-first)

## Algorithm

### Step 1 — Detect outer card boundary
Scanner has already aspect-tightened. Card edge is at image edge or ~1-2px in.
- Convert to grayscale
- Otsu threshold to separate card from any remaining background
- Find largest contour → bounding rectangle = outer card boundary
- (If scanner output is perfectly cropped, outer boundary = image boundary)

### Step 2 — Detect inner print frame
Key insight: inner boundary is where white border stops and coloured art/border begins.
- Working in HSV colour space
- For each of 4 edges (top/bottom/left/right), scan pixel rows/columns inward
- Detect transition: low-saturation white → high-saturation colour
- Use gradient-threshold approach: find first row/col where saturation exceeds threshold
- Repeat for several parallel sample lines, take median to handle noise

### Step 3 — Measure borders
- top_border_px   = inner_frame_top    - outer_card_top
- bottom_border_px = outer_card_bottom - inner_frame_bottom
- left_border_px  = inner_frame_left   - outer_card_left
- right_border_px = outer_card_right   - inner_frame_right

### Step 4 — Compute ratios
- horizontal_ratio = left_border / (left_border + right_border) × 100
- vertical_ratio   = top_border / (top_border + bottom_border) × 100

PSA grades centering as e.g. 55/45 (left/right ratio 55% left, 45% right).
Perfect = 50/50. Industry thresholds:
  GEM MT 10: 55/45 or better
  MT 9:      60/40 or better
  NM-MT 8:   65/35 or better
  NM 7:      70/30 or better
  EX-MT 6:   75/25 or better

### Step 5 — Grade contribution
Output both raw % AND the implied grade ceiling based on PSA thresholds.
Also output a confidence score (based on edge detection stability across samples).

## Edge cases to handle
- Card rotated slightly (scanner pipeline handles rotation but small residual)
- Yellow border has slight print variation (median/robust estimation)
- Cards with no yellow border (some promos, some full-art) — flag low confidence
- Damaged cards where border is chipped — use opposite side + mirror as sanity check

## Output contract
```json
{
  "card_size_px": {"w": 2400, "h": 3355},
  "borders_px": {"top": 42, "bottom": 38, "left": 51, "right": 49},
  "ratios": {"horizontal": 51.0, "vertical": 52.5},
  "display": {"horizontal": "51/49", "vertical": "52/48"},
  "psa_ceiling": 10,           // highest PSA grade this centering supports
  "confidence": 0.94,          // 0-1, based on stability of edge detection
  "method_version": "v1",
  "notes": []                  // warnings/flags, e.g. "yellow border not detected cleanly"
}
```
