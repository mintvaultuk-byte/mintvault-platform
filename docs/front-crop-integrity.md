# Front-crop integrity gate

Repair for the proven front-image content-loss defect (MV602 / MV608 / MV609).

## What was wrong

`tightenForDisplay()` runs a second card-edge detection pass using
`detectCardEdgesByCoverage()`, a saturation/coverage detector. It cannot
distinguish a **pale card border** or a **pale interior panel** from the white
scanner mat, so two independent failure modes destroyed real card content:

| Cert      | Mechanism                       | Damage                                                                                                                                                                                                                                   |
| --------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MV602** | **Crop** over-trimmed           | Lost the ex-Rule box, illustrator credit, set symbol and card number `154/190`. Front aspect 0.8181 vs back 0.7381; 17.3% of height gone.                                                                                                |
| **MV609** | **Whitewash** erased the border | Crop geometry was fine (aspect delta vs back only 0.0007) but the saturation walk painted the pale white/silver border white — 63.6% of the outer ring flattened to pure white. That border is the reference centering is measured from. |
| **MV608** | Whitewash, milder               | 69.1% of the outer ring flattened to pure white.                                                                                                                                                                                         |

Backs were never affected: Pokémon backs are saturated blue/gold to the edge, so
the detector and the walk both behave correctly on them.

The only pre-existing integrity control was `crop >= 50% of input on both axes`.
MV602 lost 17.3% and passed it.

## What the repair does

1. **Crop-integrity gate** (`evaluateCropIntegrity`, pure/testable) rejects a
   proposed crop on any of: card-aspect deviation, per-axis trim, single-edge
   trim, or **discarded-band content**. On rejection `tightenForDisplay` emits
   the **untightened centred input unchanged** — cosmetically looser, provably
   complete. It never emits a crop it cannot vouch for.
2. **Whitewash safety boundary**: the walk only runs when the card border is
   separable from mat (`borderSat >= satStop + WHITEWASH_MIN_BORDER_SAT_MARGIN`).
   A pale border means "do not paint". Saturated borders behave exactly as
   before, so ordinary mat cleanup is preserved.
3. **Cross-face consistency** (`evaluateCrossFaceConsistency`) compares the two
   faces of one physical card and rolls back **only** the offending face.
4. **Diagnostics** recorded in `certificates.crop_geometry` under a new
   `tighten` key (jsonb — **no migration**), including the second-stage geometry
   that was previously invisible.

### Thresholds and their justification

Every constant is placed between the measured healthy maximum and the measured
defect minimum, from real R2 assets (MV602/MV607–MV611, 2026-07-25):

| Constant                              | Value | Healthy max                     | Defect                       | Separation |
| ------------------------------------- | ----- | ------------------------------- | ---------------------------- | ---------- |
| `MAX_CARD_ASPECT_DEVIATION`           | 0.05  | 0.0314                          | 0.1022                       | both sides |
| `MAX_AXIS_TRIM_FRACTION`              | 0.13  | 9.4%                            | 17.3%                        | ~midway    |
| `MAX_SINGLE_EDGE_TRIM_FRACTION`       | 0.10  | —                               | bottom-edge concentrated     | per-edge   |
| `MAX_FRONT_BACK_ASPECT_DELTA`         | 0.02  | 0.0090                          | 0.0800                       | both sides |
| `MAX_FRONT_BACK_TRIM_DELTA_FRACTION`  | 0.06  | 0.7pt                           | 8.3pt                        | both sides |
| `MAX_DISCARDED_BAND_CONTENT_FRACTION` | 0.10  | 0.04                            | 0.42                         | both sides |
| `WHITEWASH_MIN_BORDER_SAT_MARGIN`     | 3     | pale 15.8–16.9 vs satStop 14–15 | saturated 49.9–57.8 vs 25–33 | both sides |

`tests/front-crop-integrity.test.ts` asserts this separation directly, so the
constants cannot silently drift away from the real data.

## Verified effect on the affected cards

| Cert  | Old front                              | Repaired front                    | Decision                                                                       |
| ----- | -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| MV602 | 1354×1655 (0.8181) — content destroyed | **1434×1942 (0.7384)** — complete | rejected → `untightened_input`; discarded bottom band measured **42% content** |
| MV608 | 1354×1812                              | 1354×1812 (unchanged)             | accepted; whitewash skipped (pale border)                                      |
| MV609 | 1361×1823                              | 1361×1823 (unchanged)             | accepted; whitewash skipped → border preserved (pure-white ring 63.6% → 0%)    |

Correct crops are preserved byte-for-byte in geometry; only the destructive
behaviours change.

## Original preservation

- `images/grading/{id}/raw_{front,back}.{ext}` — untouched scanner bytes, written
  once by `uploadRawScansToR2()` before the pipeline runs.
- `images/grading/{id}/{front,back}_original.jpg` — the resized working image
  (`ImageVariants.original` is the input buffer verbatim).
- `scripts/regenerate-card-derivatives.ts` deny-lists both patterns at the write
  boundary (`isProtectedKey`), so regeneration cannot overwrite an original even
  if the key list is later edited.

**Operational check (external to this repo):** R2 lifecycle/expiry rules are
managed in the Cloudflare dashboard, not in code. Before onboarding partner
shops, confirm no lifecycle rule expires `images/grading/*/raw_*` or
`*_original.jpg`. This repository cannot enforce that.

## Regeneration

Dry run by default; explicit targets only; never writes originals.

```bash
tsx scripts/regenerate-card-derivatives.ts MV602 MV608 MV609
```

Apply (requires owner approval — not run as part of the repair):

```bash
tsx scripts/regenerate-card-derivatives.ts MV602 MV608 MV609 --apply
```

## Fixtures

Production card scans are customer images and are **not committed**. The real
MV602/MV608/MV609 assets were read **read-only** from R2 during verification
(`front_original.jpg` / `front_cropped.jpg`, GET only) and the outcome recorded
above. `tests/helpers/card-fixtures.ts` generates deterministic synthetic cards
reproducing the optical properties that break the detector: pale lower panel,
pale white/silver border, saturated full-art, yellow, dark, borderless, and a
saturated back. Content that must survive is marked with pure-hue sentinel
blocks so "the card number survived" is machine-checkable.

## Scanner-pilot acceptance gate

Before a partner shop goes live: 20 cards spanning all five border classes; zero
cross-face aspect deviations > 0.02; zero certs where a sentinel-equivalent
(card number / illustrator line) is missing; manual contact-sheet sign-off.

---

# Sleeved-card physical isolation (first stage)

Everything above governs the SECOND stage (`tightenForDisplay`). It assumes the
buffer it receives is already card-relative. On sleeved and top-loadered scans
that assumption was false, and no amount of second-stage gating could recover.

## Failure mechanism

`detectCardBoundary()` takes the global MIN/MAX of every pixel whose colour
distance from the sampled mat median exceeds a threshold. That models a frame
containing exactly two things — one uniform mat and the card. A sleeved scan
contains at least four: white scanner bed, sleeve (near-mat, with glare), the
card, and scanner hardware at the frame border. **Every non-card pixel that
passes the threshold drags the bounding box outward, so one jig pixel per side
returns the whole frame.**

Reference failure — MV642 / front, `images/grading/1101/front_original.jpg`,
1474×2000, Korean 메가자리ex 076/063 SR (sv9a):

| stage            | measured                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| mat median       | `rgb(237,242,246)` — a near-WHITE scanner bed                          |
| primary bbox     | 1104×1483 of an 1106×1500 detector frame (99.8% × 98.9%)               |
| bbox aspect      | 0.744 — the FRAME aspect, not the card's 0.716                         |
| aspect-tighten   | trimmed 36 px, then `applySafetyPad(+22 px)` gave it all back          |
| first-stage crop | 1474×2000 → **1473×1999** — one pixel of "isolation"                   |
| secondary detect | `no edge met 90% threshold` → `detect_failed`                          |
| emitted          | 16 px uniform inset → **1441×1967**, bed + sleeve + lower jig retained |

The blur users saw was real out-of-focus scanner-bed and sleeve content, not
padding or upscaling.

## Coverage profile + longest contiguous run

A physical card is a solid rectangle: every row it spans is ~90% non-mat and
every row it does not span is ~0%. Scanner hardware is partial. Measured on
MV642 / front at detector scale:

```
colCoverage  x=0..10    0.44,0.35   jig strip
             x=20..60   ~0.005      bed / sleeve
             x=80..1040 0.89-0.92   CARD
             x=1080+    0.001       bed
rowCoverage  y=0..90    0.000       bed
             y=120..1440 0.88-0.91  CARD
             y=1470..1499 0.47,0.34,0.23   lower guide rail
```

Longest run → `x[75,1059] × y[96,1469]` = 985×1374, **aspect 0.7169** against
the 63×88 mm spec's 0.7159. Agreement to 0.0010 is an INDEPENDENT confirmation
that the run found the card and not the sleeve, the bed or the frame.

## Seven signals, four of them mandatory

`detectPhysicalCardRect()` requires agreement, never a single threshold:

| signal                          | what it proves                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `aspectOk` **(mandatory)**      | matches 63×88 mm within ±0.035                                                         |
| `areaOk` **(mandatory)**        | occupies 15–92% of the frame                                                           |
| `edgeStepOk` **(mandatory)**    | coverage STEPS at all four boundaries — a printed edge, not a sleeve ripple            |
| `matAchromatic` **(mandatory)** | the surround is a scanner background (mats are grey/white/black; card borders are not) |
| `notFrameAdjacent`              | clear of every frame edge — a flush card may continue outside the scan                 |
| `parallelOk`                    | opposing edges straight and parallel across five scanlines each                        |
| `coveragePeakOk`                | the plateau is solid enough to be a printed face                                       |

`trusted` = all four mandatory **and** ≥6 of 7. `confidence: "high"` = 7 of 7.

The content threshold is derived from the mat strip's own median absolute
distance (`4 × noise`, clamped 10–45) rather than fixed at 45. A fixed 45 reads
a pale white/silver border as mat and starts the plateau at the ARTWORK — which
would crop the printed border off. The low floor is safe only because every
decision is made on row/column coverage, where scattered noise contributes
~1/w and changes nothing.

## Near-full-frame guard

`assessNearFullFrame()` applies to ANY candidate, whichever detector produced
it. It fails closed when the rectangle retains ≥97% of both axes
(`near_full_frame_not_card_isolation`), removes <2% of the area
(`negligible_pixels_removed`), or touches ≥3 frame edges
(`frame_adjacent_edges`). MV642's primary result trips all three.

On fail-closed the pipeline keeps the protected original, suppresses the 16 px
inset (`fallbackInsetPx = 0` — a frame we could not isolate must not ship
looking like a crop), marks `cardDetectionState: "failed"`,
`outputSafeButDegraded: true`, `cropConfidence: "low"`, and records
`crop_geometry.isolation.requires_recapture`. `autoCrop()` is deliberately NOT
run: a blind trim of a frame we could not isolate produces exactly the
misleading image the guard exists to prevent.

## Safety margin

`planCardSafetyMargin()` adds **1.5 mm**, converted with the px/mm the detected
card itself implies (`w/63` and `h/88`, averaged) — no magic pixel constants.
It is added strictly OUTSIDE the card and clamped per edge to what the source
frame supplies, so reducing an edge removes mat, never card. Any edge below
0.5 mm sets `degraded` so the reduction is visible in forensics rather than
silent. Padding is never invented.

## Interaction with the strict bound

Card-relative isolation is what makes the strict 0.8 mm bound usable: the
second stage now receives a card-relative intermediate, so a rejected tightening
falls back to THAT — not to the scanner frame, not to a near-full-frame primary
result, and not to a blind uniform inset. MV642 goes from
`detect_failed / uniform_inset / cropConfidence low` to
`accepted / fallback none / cropConfidence high`.
