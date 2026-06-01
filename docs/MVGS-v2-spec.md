# MVGS v2 — Measurement-Based Defect Scoring

**Status:** DRAFT for sign-off. Numbers marked `[HARD-CODE]` are derived from TAG's
published rubric and are ready to implement. The single value marked `[CALIBRATE]`
is not published by anyone and must be set by you, tuned against your own cards,
then locked.

**Build rule:** staging only, phased. Do NOT merge to main / deploy prod until you
have run the calibration pass and had the standard change reviewed. This is the
published, legally-live grading standard on a regulated product.

---

## 0. What changes and what doesn't

**Stays exactly as-is (already spec-faithful, do not touch):**

- The 0–100 score → 1–10 grade band table (already matches TAG's structure).
- Centering measurement + deduction tables (objective, already built).
- The four categories + the floor rule engine.
- Defect type codes, dark-border ×1.25 rule and its definition.

**Changes in v2:**

1. **Whitening becomes a line measurement** feeding the Edges subgrade (not a pile of pins).
2. **Creases / wrinkles / tears become severity ceilings** (caps), TAG-aligned.
3. **A new admin measurement tool** (draw-a-line marker) alongside the existing pin.
4. **The resolution logic is made explicit as DINGS / floor rule** — worst single
   limiting factor sets the grade; lesser flaws underneath do not compound.
5. **One adjustable threshold** (the whitening-length-to-edge-affected value),
   tunable in an admin panel, lockable + publishable.

---

## 1. The grading flow (how a card resolves)

For each card, in order:

1. **Authentication / dimensions pre-check.** Genuine? Correct size (63×88mm ±0.5)?
   Fail → existing **NO ("Not Graded")** outcome, returned unslabbed, no grade.
2. **Centering** → centering subgrade (existing, unchanged).
3. **Corners** → corners subgrade (pins; a corner ding/whitening is a point defect).
4. **Edges** → edges subgrade, set by the **whitening/wear line measurement** (§3).
5. **Surface** → surface subgrade (pins/codes, existing).
6. **Structural ceilings** — crease / wrinkle / tear apply a grade CAP (§4).
7. **Resolution (DINGS / floor rule, §5)** — the worst single limiting factor sets
   the grade. No compounding of lesser defects.
8. **Eye-appeal nudge** — grader applies ±2 points max (existing rule).
9. **Score → grade** via the band table (§2). Prints to slab + cert.

---

## 2. Score → grade bands `[HARD-CODE]`

TAG's 50-point bands scaled to the MVGS 0–100 scale (÷10). Confirm against the
existing MVGS table — they should already match; adjust only if they differ.

| Grade       | Name         | TAG (1000) | MVGS (0–100) |
| ----------- | ------------ | ---------- | ------------ |
| 10 Pristine | Pristine 10P | 990–1000   | 99–100       |
| 10          | Gem Mint     | 950–989    | 95–98.9      |
| 9           | Mint         | 900–949    | 90–94.9      |
| 8.5         | NM-Mint+     | 850–899    | 85–89.9      |
| 8           | NM-Mint      | 800–849    | 80–84.9      |
| 7.5         | NM+          | 750–799    | 75–79.9      |
| 7           | Near Mint    | 700–749    | 70–74.9      |
| 6.5         | EX-Mint+     | 650–699    | 65–69.9      |
| 6           | EX-Mint      | 600–649    | 60–64.9      |
| 5.5         | Excellent+   | 550–599    | 55–59.9      |
| 5           | Excellent    | 500–549    | 50–54.9      |
| 4.5         | VG-EX+       | 450–499    | 45–49.9      |
| 4           | VG-EX        | 400–449    | 40–44.9      |
| 3.5         | VG+          | 350–399    | 35–39.9      |
| 3           | Very Good    | 300–349    | 30–34.9      |
| 2.5         | Good+        | 250–299    | 25–29.9      |
| 2           | Good         | 200–249    | 20–24.9      |
| 1.5         | Fair         | 150–199    | 15–19.9      |
| 1           | Poor         | 100–149    | 10–14.9      |

---

## 3. Edges subgrade — the whitening line measurement

### How it's marked

Whitening / edge wear is marked as a **LINE** (draw start → end along the edge),
not a pin. The tool returns the line's length. A pin remains available for genuine
point defects (a single nick).

### How it scores `[HARD-CODE the ladder] [CALIBRATE the threshold]`

The engine assesses **how many of the four edges are "affected" and how badly**,
then reads the Edges subgrade off this TAG-derived ladder:

| Edge condition                      | Edges subgrade |
| ----------------------------------- | -------------- |
| Clean / hi-res artifacts only       | 10             |
| Minor whitening, **1–2 edges**      | 9              |
| Visible, **multiple edges (front)** | 8.5            |
| **All four edges** affected         | 8              |
| Worsening + minor lifting           | 7.5            |
| Notch appears / wear on all edges   | 7              |
| Notches on 2 edges                  | 6.5            |
| Notches on 3+ edges, or 1 severe    | 6              |
| Chipping into surface, multiple     | 5–5.5          |
| Severe, image worn at edges         | ≤4             |

**`[CALIBRATE]` — the one value not published anywhere:** what length (mm) or what
% of an edge's length counts that edge as "affected." Proposed STARTING value (tune
against your own cards, then lock):

- An edge counts as **affected** if whitening covers **≥ 10%** of that edge's length.
- "Minor" vs "visible" split at **~25%** of the edge.
- Dark-border ×1.25: on a dark-bordered edge, multiply the measured coverage by 1.25
  before reading the ladder (whitening shows worse, scores harder).

These three numbers (10%, 25%, ×1.25) live in the **Grading Calibration panel** (§6)
as adjustable values. Everything else in this table is hard-coded.

---

## 4. Structural ceilings — creases, wrinkles, tears `[HARD-CODE]`

These are CAPS on the overall grade, not subgrade deductions — a structural defect
limits the whole card regardless of how good the categories are. TAG's published
ladder:

### Wrinkle (surface ripple, doesn't break stock)

| Severity                | Grade ceiling |
| ----------------------- | ------------- |
| Tiny, back, hi-res only | 6.5           |
| Longer, visible, back   | 6             |
| Small, front            | 5.5           |
| Multiple, front         | 5             |

### Crease (breaks the stock) — by % of card span `[CALIBRATE — starting values]`

| Severity (length as % of card's span) | Grade ceiling |
| ------------------------------------- | ------------- |
| Minor crease, **< 25%**               | 4.5           |
| **~25–50%** (≈ half across)           | 4             |
| **~50–75%** (≈ three-quarters)        | 3.5           |
| Full-length, **> 75%**                | ≤3            |

### Tear — by extent

| Severity                                           | Outcome                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Minor tear, one edge                               | cap 2                                                       |
| Significant tear / multiple                        | cap ≤1.5                                                    |
| Major tear / missing material (corner, back layer) | **NO (existing "Not Graded" code) — returned, not slabbed** |

**NQ = the existing NO / "Not Graded" code. Do NOT create a new code.** A major
tear / missing material routes to the existing non-numeric NO outcome.

Crease/wrinkle severity uses **% of the card's span** (not absolute mm) — a crease
scores by how far it runs proportionally, which matches TAG's own language ("~half
across," "~three-quarters across") and stays correct whichever axis it runs. Set
from the line-tool measurement. The % cutoffs above are STARTING values, adjustable
in the calibration panel and locked after the calibration pass.

---

## 5. Resolution — DINGS / floor rule `[HARD-CODE — already exists]`

This is TAG's stated method and your existing floor rule. **The grade is set by the
single worst limiting factor, not the sum of defects.**

- Take the four subgrades + any structural ceiling.
- The overall grade **cannot exceed the lowest subgrade + 0.5** (existing floor rule).
- A structural ceiling (crease/tear) applies if it is stricter than the floor.
- Lesser defects that sit below the limiting factor **do not compound** — exactly
  TAG's DINGS principle: a flaw that wouldn't change the grade if removed doesn't
  count.

**Worked example (the anti-overkill proof):**

> Centering 10, Corners 10, **Edges 6** (heavy whitening, 3 edges), Surface 10.
> Overall ≈ **6**. The weak edges cap the card; the strong categories don't rescue
> it; the whitening counts **once**, through Edges. It is not also subtracted
> elsewhere. This is why measured whitening does not over-kill grades.

### Single source of truth (REQUIRED)

Crease/tear caps currently exist in **four** places with **two different values**
(engine ≈74; `client/grade-logic.ts` & `client/grade-display.tsx` min 5/3; the AI
`server/grading-prompt.ts` max 5/3). The engine (`computeMvgsScore`) is the ONLY
authority. In Phase 1, the client logic + display read their caps from the engine
result, and the AI prompt text is aligned to the engine's ceilings. No path may
carry its own crease/tear numbers. Shipping the engine while the other three keep
stale values = the same card grading differently per view; that is the bug being
closed, not deferred.

---

## 6. The Grading Calibration panel `[CALIBRATE → then LOCK]`

A new admin panel holding the un-publishable threshold values as adjustable
settings (NOT hardcoded in source):

- Whitening: edge-affected threshold (start 10%), minor/visible split (start 25%).
- Dark-border multiplier (start ×1.25).
- Crease/wrinkle length→severity cutoffs.

**Two states:**

1. **Calibration mode** — values adjustable. You grade your own cards, watch the
   grades, nudge until they land where your eye agrees.
2. **Locked + published** — when you're satisfied, lock the values. The locked
   values become the published MVGS standard. After locking, changing them is a
   deliberate "standard v2.x" decision, not a casual nudge — this keeps the public
   standard stable and trustworthy.

The `/standard` page reads the **currently locked values** so the published standard
always matches what the engine actually computes (no claim-without-code drift).

---

## 7. Build phases (staging only, do not merge/deploy prod)

**Phase 1 — Engine + calibration values.**

- Implement the whitening→Edges ladder, the crease/wrinkle/tear ceilings, and the
  DINGS/floor-rule resolution in the scoring engine.
- Store the `[CALIBRATE]` thresholds as adjustable settings (calibration panel),
  not hardcoded constants.
- No UI marker change yet — wire it to accept a line measurement input.
- Type-check, build, deploy STAGING. Verify with seeded test certs.

**Phase 2 — The line-marker tool.**

- Add the draw-a-line measurement marker to the grading workstation, alongside the
  existing pin. Outputs length / % of edge → feeds the Phase 1 engine.
- Keep the pin for genuine point defects.
- Staging, verify on seeded certs.

**Phase 3 — Standard, page, legal, slab, panels.**

- Update the MVGS standard doc, `/standard` page, legal grading-standards doc to
  describe the v2 methodology (reading locked calibration values).
- Slab + cert + PDF render the v2 grade (already consistent post-halfgrade fix).
- Staff panels describe the v2 derivation.
- Staging.

**Then:** calibration pass (you, against your own cards) → lock the values →
qualified/legal review of the standard change → promote to prod deliberately.

---

## 8. What's hard-coded vs what you set

| Item                                      | Source                             |
| ----------------------------------------- | ---------------------------------- |
| Score→grade bands                         | `[HARD-CODE]` TAG                  |
| Edge ladder (1–2 edges→9, etc.)           | `[HARD-CODE]` TAG                  |
| Crease/wrinkle/tear ceilings              | `[HARD-CODE]` TAG                  |
| DINGS / floor-rule resolution             | `[HARD-CODE]` existing             |
| Dark-border ×1.25                         | `[HARD-CODE]` existing, adjustable |
| **Whitening edge-affected threshold (%)** | **`[CALIBRATE]` — you, then lock** |
| **Minor/visible split (%)**               | **`[CALIBRATE]` — you, then lock** |
| **Crease length→severity cutoffs**        | **`[CALIBRATE]` — you, then lock** |

Everything is grounded in TAG's published rubric (PSA-aligned by TAG's own design)
except the three calibration values, which are not published by anyone and are set
by you against your own cards — the same way every grading company derived theirs.
