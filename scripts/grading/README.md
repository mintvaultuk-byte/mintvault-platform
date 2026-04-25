# MintVault CV Grading — Centering module

**Purpose:** deterministic centering measurement to replace the AI pre-grade
call for the centering sub-grade. Zero per-submission API cost; fixed
per-machine compute cost.

**Status:** `centering.v1` — algorithm validated on 11 synthetic fixtures
(perfect, noisy, rotated, combined degradations). Needs calibration against
a sample of ≥ 20 hand-graded MintVault cards before production use.

---

## Files

```
scripts/grading/
├── centering.py                     # the CLI
├── test_centering.py                # synthetic ground-truth tests (run on CI)
├── test_centering_robustness.py     # noise/rotation robustness tests
├── algorithm-notes.md               # algorithm design reference
└── README.md                        # this file
```

---

## CLI contract

```bash
python3 centering.py --image path/to/card.jpg [--json-out out.json] [--debug-viz debug.png]
```

- Exit code `0` on success — JSON on stdout (or `--json-out` file).
- Exit code `1` on failure — JSON error on stderr.
- `--debug-viz` optionally writes an annotated image (green = outer card, red = inner print frame, labels for H/V/ceiling/confidence).

### Example output

```json
{
  "card_size_px": {"w": 2402, "h": 3355},
  "borders_px": {"top": 130, "bottom": 70, "left": 130, "right": 70},
  "ratios": {"horizontal": 65.0, "vertical": 65.0},
  "display": {"horizontal": "65/35", "vertical": "65/35"},
  "psa_ceiling": 8,
  "confidence": 1.0,
  "method_version": "centering.v1",
  "notes": []
}
```

**`psa_ceiling`** — the highest PSA grade this centering supports.
Computed from the worse of the two axis ratios against standard PSA thresholds.

**`confidence`** — product of inter-sample agreement on all 4 edges.
Values:
- `≥ 0.85` — high confidence, use the measurement
- `0.60–0.85` — medium, usable but flag for reviewer glance
- `< 0.60` — low, fall back to AI or human

Confidence correctly drops when the card has residual rotation (because
sample positions disagree), which is exactly what you want as a gating
signal — the scanner pipeline aspect-tightening is tight, so low confidence
almost always means a bad input.

---

## Node integration

### Option A: subprocess (recommended — simplest, no extra service)

```typescript
// server/grading/centering.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CenteringResult {
  card_size_px: { w: number; h: number };
  borders_px: { top: number; bottom: number; left: number; right: number };
  ratios: { horizontal: number; vertical: number };
  display: { horizontal: string; vertical: string };
  psa_ceiling: number;
  confidence: number;
  method_version: string;
  notes: string[];
}

export async function measureCentering(imagePath: string): Promise<CenteringResult> {
  const { stdout } = await execFileAsync(
    "python3",
    ["scripts/grading/centering.py", "--image", imagePath],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

export function isCenteringHighConfidence(r: CenteringResult): boolean {
  return r.confidence >= 0.85;
}
```

### Option B: HTTP microservice (if subprocess latency is a problem)

Run `centering.py` behind a tiny Flask/FastAPI service. Marginal throughput
gain — only worth it if you're doing hundreds of measurements per minute.

---

## Wiring into the grading pipeline

Current flow per memory:
```
scan → AI pre-grade (Anthropic)  →  admin review → finalise
```

New flow:
```
scan → measureCentering()
       ↓
       if confidence ≥ 0.85:
           record centering sub-grade + PSA ceiling
       else:
           fall back to AI for centering only
       ↓
       AI still used for corners/edges/surface until those modules land
       ↓
       admin review → finalise
```

Each CV module we add shrinks AI's envelope. When all four sub-grade modules
land (centering, corners, edges, surface), AI becomes fallback-only.

---

## Calibration plan (before production)

1. Pick 20 hand-graded MintVault cards spanning PSA 6–10 centering outcomes.
2. Run `centering.py` on each aligned scan.
3. Compare `psa_ceiling` to the hand-grade for centering.
4. Expected: ceiling matches or is one grade stricter than hand-grade (algorithm errs on the side of caution because it uses the worse-axis ratio).
5. If the ceiling is *lower* than the hand-grade on multiple cards, investigate — likely a scanner rotation issue or a non-yellow-bordered card. Raise `sat_threshold` or add border-colour detection.

---

## Known limitations (v1)

- **Non-yellow borders.** Full-art cards, promos with black/silver borders, Pokémon GO series — these need per-card-set border-colour profiles. For now, cards with non-yellow borders will either fail to detect inner frame (explicit error) or detect the wrong boundary (confidence will be low — gate on that).
- **Modern card frames.** Sword & Shield+ have a thinner inner border; the saturation transition is still detectable but the "perfect" border px will differ from classic Base Set. Algorithm is resolution-agnostic, so this isn't a blocker — but thresholds for PSA ceiling are same for all eras (per PSA published standards).
- **Damaged cards.** If the card is chipped/creased at a corner, one sample series will show a shifted edge. Median-based aggregation handles small damage; large damage will lower confidence.

---

## Cost model (vs AI)

At Anthropic API with Sonnet 4 on an image pre-grade call:
- ~8k input tokens (image) + ~500 output = ~$0.04 per call
- 1,000 cards/month = $40/month
- 10,000 cards/month = $400/month

`centering.py` runs in ~100ms per card on a Fly.io shared-cpu-1x machine.
No API cost. Centering alone replaces ~25% of the AI grade reasoning
(since it's one of 4 sub-grades). When all 4 modules land, the AI call
becomes fallback-only — projected cost reduction **70–90%**.

---

## Next modules to build

1. **corners.py** — corner sharpness scoring via edge detection at the 4 corners.
2. **edges.py** — edge condition (chips, whitening) along all 4 sides.
3. **surface.py** — surface defect detection (scratches, print lines) vs reference image.
4. **grade_synthesis.py** — combine sub-grade ceilings into a final grade proposal with reasoning.

Each follows the same pattern: Python CLI, JSON output, confidence score, falls back to AI when confidence is low.
