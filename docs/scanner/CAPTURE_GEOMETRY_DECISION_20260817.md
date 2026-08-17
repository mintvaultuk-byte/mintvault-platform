# LiDE 400 capture geometry — architecture decision

**Date:** 2026-08-17
**Branch:** `fix/canonical-card-detector-20260817`
**Status:** PROPOSED — awaiting owner approval. No code changed, no scan performed.

---

## The headline

The 4 mm evidence rule is not what is breaking placement. **Corner registration is.**

The capture window is anchored at the platen origin `(0,0)` and the card is registered into that
window's top-left corner. The operator therefore has to hit a 4 mm target on two edges at once, by
hand, with no visual aid — while 33 mm of unused window sits to the right and 37 mm below.

The last MV272 BACK attempt missed by **0.2 mm** (3.8 mm achieved, 4.0 mm required) after a
45-second scan.

Centring the card in the same 100 × 130 mm window turns that 0.2 mm miss into **±11 mm of slack**,
with the 4 mm rule completely untouched.

---

## Evidence base

Eight preserved 1200-DPI masters from today's physical session, all 4724 × 6136 px @ 1200 DPI
(= 99.99 × 129.88 mm), RGB + alpha:

| File | Bucket | Time | Card detected | Margins L/T/R/B (mm) | Min |
|---|---|---|---|---|---|
| `5816D355` | capture-staging (MV272 BACK) | 13:31 | 63.27 × 88.82 | 3.90 / 3.75 / 32.83 / 37.30 | **3.75** |
| `2C4F919D` | discarded | 13:30 | 63.63 × 88.89 | 3.90 / 3.61 / 32.46 / 37.38 | **3.61** |
| `2DAB51B0` | discarded | 13:28 | 63.85 × 88.75 | 3.03 / 3.68 / 33.11 / 37.45 | **3.03** |
| `89836D9D` | discarded | 13:26 | 63.49 × 88.75 | 3.68 / 3.68 / 32.83 / 37.45 | **3.68** |
| `D5B907B4` | discarded | 11:35 | 63.78 × 89.18 | 4.98 / 4.62 / 31.24 / 36.08 | 4.62 |
| `452AE042` | failed | 12:10 | 63.49 × 88.97 | 6.28 / 4.62 / 30.23 / 36.29 | 4.62 |
| `71CF9449` | failed | 12:25 | 63.49 × 88.97 | 6.28 / 4.69 / 30.23 / 36.22 | 4.69 |
| `15EB9C6D` | processed | 13:08 | 63.49 × 88.97 | 6.28 / 4.62 / 30.23 / 36.29 | 4.62 |

Four of eight fell below 4 mm. Every one of them had ≥ 30 mm spare on the right and ≥ 36 mm spare
at the bottom. The failure is entirely one of registration strategy.

### The canonical detector is proven on real bytes

Running `shared/lide400-card-geometry.cjs` on all eight masters through **both** production
downscale ladders (server `≤1800`, scanner `1400×1800`) and with `.rotate()` on and off produced
**byte-identical geometry in all 32 runs**. Phases A and B of the handoff — one canonical detector,
one coordinate convention — are already implemented and are now empirically confirmed.

### Mutation proof — 8/8

Restoring the old reduction (`boundingBox(allForegroundPixels)`) reproduces the defect on every
real master:

| File | Old reduction | Verdict | Canonical reduction |
|---|---|---|---|
| `5816D355` | 99.99 × 110.61 mm | REJECTED | 63.27 × 88.82 mm |
| `2C4F919D` | 99.99 × 110.61 mm | REJECTED | 63.63 × 88.89 mm |
| `2DAB51B0` | 99.99 × 110.61 mm | REJECTED | 63.85 × 88.75 mm |
| `89836D9D` | 99.99 × 110.61 mm | REJECTED | 63.49 × 88.75 mm |
| `D5B907B4` | 99.13 × 113.79 mm | REJECTED | 63.78 × 89.18 mm |
| `452AE042` | 99.99 × 113.93 mm | REJECTED | 63.49 × 88.97 mm |
| `71CF9449` | 99.99 × 113.93 mm | REJECTED | 63.49 × 88.97 mm |
| `15EB9C6D` | 99.99 × 113.93 mm | REJECTED | 63.49 × 88.97 mm |

`71CF9449` reports 1,052,294 foreground pixels — exactly the figure cited in commit `50e6ad80`,
confirming this is the MV272 file from that investigation.

### The contamination is a band at the platen edge, not scattered noise

Non-card foreground outside the card rect is 0.20 %–0.46 % of foreground, and it is **not random**:

| File | Top band depth | Left band | Bottom | Right | % of contamination in top 1 mm |
|---|---|---|---|---|---|
| `5816D355` | 0.51 mm | 0.36 mm | none | none | 97.9 % |
| `2C4F919D` | 0.72 mm | 0.43 mm | none | none | 92.8 % |
| `2DAB51B0` | 1.08 mm | 0.72 mm | none | none | 59.3 % |
| `89836D9D` | **1.23 mm** | 0.72 mm | none | none | 43.8 % |
| `D5B907B4` | 0.14 mm | none | none | none | 94.2 % |
| `452AE042` | 1.01 mm | 0.65 mm | none | none | 45.1 % |
| `71CF9449` | 1.01 mm | 0.65 mm | none | none | 54.6 % |
| `15EB9C6D` | 0.94 mm | 0.58 mm | none | none | 55.0 % |

It lives in the first ~1.2 mm of the **top** edge and the first ~0.7 mm of the **left** edge, and
nowhere else. Those are precisely the two edges touching the platen origin, because
`MINTVAULT_LIDE_SCAN_X_MM=0` and `MINTVAULT_LIDE_SCAN_Y_MM=0`.

**This directly contradicts the premise that the capture area should sit closer to the scanner
edge.** The scanner edge is where the noise is. Moving the window *inward* removes the cause.

---

## Evidence-margin sweep

Method: for each master, locate the card at full resolution, then **re-window the acquisition
rectangle** to the card plus exactly _N_ mm of real background on all four sides, cropped from the
1200-DPI master. Every pixel — card edge, platen texture, sensor noise — is real. The canonical
detector then runs on that re-windowed frame through the production ladder.

Reliable = card dimensions within 0.6 mm of truth AND all four margins recovered within 0.5 mm AND
resolved by `dominant_run`.

| Margin | Result | Worst dimension error | Worst margin error |
|---|---|---|---|
| 0.5 mm | **7/8** — `5816D355` clipped to 0.00 margins | 0.93 mm | 0.50 mm |
| 1 mm | 8/8 | 0.31 mm | 0.06 mm |
| 2 mm | 8/8 | 0.31 mm | 0.04 mm |
| 3 mm | 8/8 | 0.37 mm | 0.10 mm |
| 4 mm | 4/4 (only four masters had ≥ 4 mm real background) | 0.29 mm | 0.07 mm |

**Detection does not break down until below 1 mm.** But detection reliability is only one of the
things the margin protects, and it is not the binding one.

### Error budget — what the margin must actually absorb

| Term | Measured | Budget |
|---|---|---|
| Detector edge error vs true card | ≤ 0.37 mm across 40 sweep runs | 0.40 mm |
| Placement preview → evidence master disagreement | 0.05 mm on min margin, 0.04 mm on dimension | 0.10 mm |
| Scanner carriage repeatability | ≤ 0.07 mm across three captures 58 min apart | 0.10 mm |
| Card shift between Preview and Scan (lid, vibration) | **NOT measurable from these artifacts** | 1.00 mm (assumed) |
| **Linear worst case** | | **1.60 mm** |
| **RSS** | | **1.09 mm** |

The card-shift term is an assumption, not a measurement. It is the one number in this document that
physical acceptance must validate — see Phase I.

A 1 mm or 2 mm floor is smaller than the error budget that sits on top of it. It would pass frames
whose true margin is zero or negative — a clipped card edge presented as valid grading evidence.
That is a silent evidence-integrity failure, which is exactly the class of defect this programme
exists to remove.

**4 mm is the only tested value with headroom over the full budget, and nothing is gained by
lowering it once the card is centred.**

---

## Coordinate hazard found during this investigation

The placement preview JPEG and the evidence master are **180° apart in their stored bytes**:

| Source | Card position | Margins L/T/R/B |
|---|---|---|
| `97aeee9b….preview.jpg` (1078 × 1400) | 32.84, 37.33 | 32.84 / 37.33 / 3.90 / 3.81 |
| `5816D355….tiff` (4724 × 6136) | 3.90, 3.76 | 3.90 / 3.76 / 32.83 / 37.34 |

Size agrees to 0.01 mm and the *set* of margins is identical — but left↔right and top↔bottom are
swapped. Width, height and the margin set are invariant under 180° rotation, which is why nothing
has broken so far and why commit `50e6ad80`'s reasoning holds.

**That invariance ends the moment the window has a non-zero origin and the safe box is not
centred.** An asymmetric safe box defined in presentation space lands on the wrong side in canonical
space. The safe window must therefore be defined in **canonical space** and transformed *for
display only*, never the reverse.

---

## Server authority — current status

`assessLide400CardFrame(buffer, inspection, provenance.scanAreaMm)` takes the acquisition rectangle
from client-supplied provenance. That is safe **today** only because `assertLide400Evidence` pins
`scanAreaMm.width/height` against a server-side constant (100 × 130) and pins the decoded pixel
dimensions. A lying station is rejected.

`scanAreaMm.x/y` are **not** checked. That does not affect the margin verdict (margins are relative
to the acquisition rect, not the platen), but it does mean provenance cannot currently prove *where
on the platen* a scan was taken.

Once the window is movable this must change: the server must take the acquisition rectangle from
the station's stored calibration record, not from a global constant, and must pin x/y as well.

---

## Decisions

### Outer capture window — 100 × 130 mm, UNCHANGED, but movable

Keep the size:

- It is hard-coded in the native bridge (`bridge.scanWidthMm = profileScan ? 100.0 : …`), so
  changing it forces a native recompile, a `mintvault-canon-lide-400-v3` profile version bump, and
  recalibration of every station.
- It does not need to change. A centred card leaves 18.25 mm horizontally and 20.55 mm vertically —
  4.5× the evidence minimum on the tighter axis.
- Scan time scales with area. The measured 1200-DPI capture is 45.3 s (12:31:12.602 → 12:31:57.915).
  Enlarging the window makes every scan slower for no benefit.

Make the position movable. The bridge already parameterises origin X/Y (`argv[3]`, `argv[4]`) and
already enforces the platen bound, so this is configuration, not new capability.

- Default origin **(20, 20) mm** — 16× clear of the worst measured contamination band.
- Constrained to a **5 mm minimum inset** on all sides: x ∈ [5, 111], y ∈ [5, 162].
- Persisted per station and per profile, versioned and audited.
- Settable only from one-time station setup, never during live capture.

### Safe inner placement window — 88 × 118 mm

Window inset by 6.0 mm on all sides: 4.0 mm evidence floor + 1.6 mm linear error budget + 0.4 mm
headroom.

Guaranteed worst-case margin when the *detected* card sits inside the safe box: **4.40 mm** ≥ 4.0 mm.

| Card | Horizontal slack | Vertical slack |
|---|---|---|
| Nominal 63.5 × 88.9 | ±12.25 mm | ±14.55 mm |
| Profile-widest 65.0 × 90.5 | ±11.50 mm | ±13.75 mm |

**Operator placement tolerance: ±11 mm horizontal, ±13 mm vertical** (rounded down).

The gate is `detected card bounds ⊆ safe box`, evaluated on a fresh preview — measured, not assumed,
so it is self-correcting for detector error.

### Card-size profile architecture

| Field | Standard TCG (v1) |
|---|---|
| Card nominal | 63.5 × 88.9 mm |
| Card design range | 62.5–65.0 × 87.5–90.5 mm |
| Outer capture window | 100 × 130 mm |
| Safe inner window | 88 × 118 mm |
| Evidence hard minimum | 4.0 mm |
| Orientation | Portrait |
| Detector/profile version | `mintvault-canon-lide-400-v3` / `capture-geometry-v1` |

A LARGE/OVERSIZED profile needs the native bridge to accept width/height for profile scans (today
they are literals). That is a native change and belongs in a later pass, not this one.

Note: the current evidence plausibility window is 55–78 × 80–105 mm — far wider than Standard TCG.
A card wider than ~65 mm will not fit the safe box, which correctly routes it to a different profile
rather than silently accepting it.

---

## Implementation phases

| Phase | Work | Status |
|---|---|---|
| A | Canonical detector extracted and shared | **DONE** (`50e6ad80`), confirmed on 8 real masters |
| B | Coordinate unification | **DONE** (`50e6ad80`); preview-path rotation hazard documented above |
| C | Movable capture window — setup UI, constraint, persistence, audit | TODO |
| D | Safe inner placement window — red/green operator gate | TODO |
| E | Mandatory per-side Preview gate (fresh preview before FRONT and before BACK) | TODO — does not exist today |
| F | Profile/version handling + server reads acquisition rect from calibration | TODO |
| G | Regression corpus | TODO |
| H | Staging-only deploy | TODO |
| I | MV272 BACK physical acceptance | TODO |

### Phase E is the biggest operator win

Today the flow is: SCAN (45 s at 1200 DPI) → *then* discover the placement was wrong → rescan.
Every misplacement costs 45 seconds. That is what produced four discarded masters today.

The gate must preview **the capture window only** at 300 DPI — not the full platen, which is the
existing setup-only preview. Expected cost is roughly a quarter of the evidence scan; the exact
figure is not in any log and must be measured in Phase E.

Preview approval must expire on capture, so FRONT's approval can never authorise BACK.

### Phase G corpus

Real artifacts (all eight preserved masters, plus the preview/master pair) cover: valid FRONT,
preserved failed BACK geometry, sparse corner noise, sub-minimum margin, clean card, RGB+alpha Canon
TIFF, 180° orientation consistency, and the mutation proof.

Synthetic fixtures still needed: clipped edge, oversized/non-card object, multiple disconnected
foreground regions, dense contamination touching the acquisition boundary, greyscale, CMYK,
non-sRGB.

The eight masters are 43–47 MB each and must **not** enter git. Phase G should reduce them to
committed derived fixtures (downscaled rasters plus expected geometry) with the full-size originals
referenced by path and checksum.

---

## Addendum — owner review, 2026-08-17

Approved with the safe inner window at **80 × 110 mm (10 mm inset)** rather than the proposed 88 × 118.
More conservative; tolerance becomes ±8.25 / ±10.55 mm for a nominal card and ±7.5 / ±9.75 mm for the
widest in-profile card. Both verified in `lide400-capture-profile.test.ts`.

### Server capture-geometry authority (required before staging)

`provenance.scanAreaMm` is no longer the acquisition rectangle. The chain is now:

```
partner_stations.current_calibration_id
  → partner_station_calibrations (VALID, same station, matching profile)
    → acquisition_region
      → SNAPSHOT onto scanner_capture_sessions when the side is ARMED   (migration 0091)
        → evidence validation uses the snapshot; the upload must merely AGREE
```

Snapshot rather than late lookup, so **calibration history is immutable for work in flight**: a
capture is judged against the geometry it was armed under, and a recalibration applies to later
sessions instead of re-interpreting a scan that already physically happened. It also costs the
evidence hot path nothing — the region rides on the session row that path already loads.

A station with no VALID calibration **cannot arm a card at all**. That is the intended failure
direction: it has no verified idea where on the platen it is scanning.

### Amber band

Three states, not two. GREEN inside the 80 × 110 safe zone; AMBER outside it but above
4 mm + 1.6 mm measured budget = **5.6 mm**; RED below that or outside the profile card range.
**Only GREEN unlocks SCAN** — the moment amber could authorise a capture, the 10 mm operator zone
would silently collapse back to the evidence floor.

The safe box is drawn **always green**, because "put the whole card inside the green box" has to mean
the same thing in every state. The detected-card outline carries the colour.

### Preview-only overlays

Every box exists solely in the operator preview. The 1200-DPI master is never composited, cropped or
re-encoded — proved by hashing the master before and after the full preview pipeline
(`lide400-capture-corpus.test.ts`).

## What this does not change

- No production deploy.
- No MVGS or grading change.
- No Partner dashboard change.
- No weakening of server authority, and no client-trusted bounds.
- No MV number deleted or reused; no new Card Job.
- MV272 FRONT evidence preserved and not rescanned.
- The 4 mm evidence floor stands.
