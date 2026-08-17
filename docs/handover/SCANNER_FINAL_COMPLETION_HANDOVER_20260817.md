# SCANNER — FINAL COMPLETION HANDOVER

**Date:** 2026-08-17 · **Branch:** `fix/canonical-card-detector-20260817`

| | |
|---|---|
| **HEAD (local + pushed)** | `3f8984f5` |
| **origin/main** | `f64e67fb` |
| **Staging** (`mintvault-v2`) | `1efaaf73` — **3 commits behind HEAD**, display fixes not deployed |
| **Production** (`mintvault`) | `36699531` — **UNTOUCHED** |
| **PR** | [#314](https://github.com/mintvaultuk-byte/mintvault-platform/pull/314) |

Scanner display fixes are **local + pushed but NOT on staging.** They run on the physical Mac from the working tree, which is what the owner is looking at.

---

## 1. The white preview — FIXED, and it was my regression

Not a Canon fault. The preview succeeded throughout: `status: reposition`, detector found the card at presentation `(7.10, 2.64)`, and the JPEG on disk was a normal scan.

`#positioningFullPreview` carries the operator mirror (`scaleX(-1)`); `#positioningCardPreview` is a **different `<img>` with no transform**. I switched the crop maths to the operator (Y-flipped) mapping along with the overlays, so the unmirrored crop was cropped in mirrored coordinates — landing on empty platen, which renders as blank white.

Fixed by reverting that **one call site** to `physicalRectToRasterRect`. Overlays keep the operator mapping; the full platen keeps its mirror.

**Rule now asserted by test:** a mapping belongs to a **raster**, not to a concept. Two `<img>` elements with different CSS transforms need different mappings, stated at the call site.

---

## 2. Display orientation — the full story (three passes, two of them mine)

Ground truth came from **opening the actual `.display.jpg`**, not from metadata. The raster carries the card at **canonical** `(148.9, 204.6)` — right/bottom, artwork upright — **despite being tagged `…presentation-raster-rotate-180-v2`.** The label and the pixels disagree; the pixels win.

| Pass | Change | Result |
|---|---|---|
| 1 | Removed a genuine double rotation (presentation rect fed to the canonical rotator) | Fixed **left/right** |
| 2 | Flipped the raster on **Y** | **Wrong** — card went to top-right while template stayed bottom-left; they moved *apart* |
| 3 | Flipped the raster on **X** instead | Card lands `x = 3.47` against a template at `x = 3.466` — **coincident to 3 dp** |

**Unavoidable consequence, owner's call:** a horizontal mirror mirrors the artwork. The sensor images the face against the glass; the operator looks at the opposite face. No rotation reconciles two views from opposite sides of a pane of glass. **"Card at bottom-left" and "artwork unmirrored" cannot both hold.** Coincidence with the template was chosen, because an outline that doesn't sit on the card is useless for placement.

**Canonical authority untouched throughout** — `physicalRectToRasterRect` still rotates canonical input and still round-trips losslessly.

---

## 3. SAVE CAPTURE WINDOW — did NOT persist, and that is CORRECT

**Server state is unchanged:** one calibration row only —
`5af9aa71… → {"x":0,"y":0,"width":100,"height":130}`, created 09:00:45. `current_calibration_id` unmoved, `calibration_status = VALID`.

**Why:** `scripts/scanner-app/lib/watcher.js:997`

> `if (this.activeTargetEntry())` → *"Finish or release the current card before moving the capture window"*

Moving the window mid-card would mean MV272's FRONT (already captured) and its BACK came from **two different physical rectangles**. The refusal is deliberate evidence-integrity architecture. MV272 is open, so SAVE was correctly refused.

⚠️ **Real UX defect (not fixed):** the refusal reason is not clearly surfaced — the owner pressed SAVE and reasonably believed it had worked. Worth a follow-up.

### "STATION CONFIGURATION PERSISTENCE IS NOT ENABLED"
Source: `lib/lide400-controller.js:256` emitting `profile_unprovisioned` — *"Canon is connected but the station capture window is not provisioned"*. Local state confirms `captureWindow.originMm = null`. It is **accurate, not misleading**: no local origin has ever been provisioned on this instance. It is not a persistence *failure*; it is a genuine not-yet-configured state, which cannot be cleared until MV272 closes.

---

## 4. 🚨 THE DEADLOCK — the single real blocker

Three facts that cannot currently coexist:

1. **Calibration window** is canonical `(0,0,100,130)`.
2. **The card** sits at presentation `(7.10, 2.64)` — canonical ≈ `(144.8, 205.1)`. **Outside the window.**
3. **The window cannot move** while MV272 is open (§3), and **MV272 cannot complete** while the card is outside the window.

Additionally the card is **2.64 mm from the platen edge**, below the hard **4 mm** evidence floor, so it would be refused where it is regardless.

**The escape is to move the CARD, not the window** — the window is fixed until the card job closes, and the card is movable now. This needs no owner decision and destroys nothing.

---

## 5. MV272 — preserved, read-only verified

| Field | Value |
|---|---|
| Card Job | `81320af2-e8d4-470a-a515-3f0b5ac8869e` |
| Status | `CAPTURING` |
| Certificate | **469** |
| Reservation | `edb73ab4…` active, 1 credit |
| FRONT | **`captured` — PRESERVED, untouched all session** |
| BACK | last session `expired`; must be re-armed |

**No new Card Job, no new MV, no new reservation, no FRONT rescan.**

---

## 6. Wallet & stranded jobs — READ ONLY, nothing cancelled

Wallet `dff9601e`: `ledger=10 · reserved=6 · available=4` — **identical to session start**.
Platform: **13 active reservations, 3 consumed.**

**13 open jobs:** MV262–MV268, MV270–MV275 (`NEEDS_SCAN` except MV268/MV272 `CAPTURING`).

**Nothing was cancelled.** Several are plausibly abandoned (MV262–MV268 date from 2026-08-14), but "no evidence yet" is not proof of abandonment, and each cancellation releases a real credit. **This needs owner approval per MV** — listed here rather than actioned.

---

## 7. Stripe / credits — unchanged this pass

Packs `PACK_5/10/25/50/100` seeded, **`stripe_price_id` NULL on all five → `purchasable=false`**. Commercially blocked on owner price/VAT, not engineering. Webhook exactly-once, zero-credit 402 block, `FOR UPDATE` wallet lock all verified in the previous pass (30/30 tests). Local Stripe keys are `sk_test_`/`pk_test_`; the environment guard requires coherence always and strict mode-matching when `STRIPE_ENV` is set (**still unset on both Fly apps — owner secrets change**).

---

## 8. Gates

| Gate | Result |
|---|---|
| scanner-app suite | **120/120** |
| orientation/label/crop tests | **31** (incl. 4 quadrants, card↔template coincidence, white-panel regression) |
| `tsc` | clean |
| `git diff --check` | clean |
| Electron runtime | 1 process, **0 renderer exceptions** |
| Full vitest (prev. pass) | 4957 passed, 0 failures |
| CI on `1efaaf73` | Lint/Type/Test/Build, image build, gitleaks, dep-review, CodeQL SAST — all pass |

**Not run this pass:** full vitest, staging deploy of `b83f9c31`. **CodeQL alert-gate** red = proven false positive (`station-routes.ts:575` *does* carry `partnerStationCardJobCancelRateLimit`).

---

## 9. Next session

1. Owner moves card into the orange box → PREVIEW → GREEN → SCAN BACK → MV272 `READY_TO_GRADE`.
2. Deploy `b83f9c31`+ to staging (currently 3 behind).
3. Surface the SAVE-refusal reason in the UI (§3).
4. Decide the mirrored-artwork trade (§2).
5. Owner: `STRIPE_ENV` secrets; pack prices + VAT.
6. Per-MV approval for stranded-job cancellation (§6).


---
---

# ADDENDUM — ACCEPTANCE PASS (HEAD `3f8984f5`)

## Delivered this pass

**FIX MISSING IMAGES promoted to a fourth primary action.** Was a plain `.btn` in collapsed Service & Diagnostics; now completes a 2×2 grid — `NEW CARD` / `PREVIEW` / `SCAN CARD` / `FIX MISSING IMAGES` — with the same `.capture-primary` sizing and no destructive styling. It destroys nothing: it re-arms a missing side on an existing card, keeping the MV number, costing no credit. Server still decides eligibility and which side is missing. Handler retargeted, not duplicated; technical detail stays in diagnostics.

**A refused capture-window save now looks refused.** The reason was already written to `#captureWindowStatus`, but in the same grey as "Saving…" and success — which is exactly how a refused save was mistaken for a successful one. `data-state` now drives three distinct appearances. The refusal logic is unchanged and correct.

**White preview** — fixed in `b83f9c31` and holding: 122/122 tests, 0 renderer exceptions across four relaunches.

## Verified read-only, immediately before handover

| | |
|---|---|
| MV272 | `CAPTURING`, cert **469**, reservation `edb73ab4…` |
| FRONT | `captured` @ 11:35:11 — **PRESERVED, untouched all session** |
| Wallet | `ledger=10 · reserved=6 · available=4` — **unchanged since session start** |
| Calibration | `{x:0, y:0, width:100, height:130}` — unchanged, single row |
| Staging | `1efaaf73` — **4 commits behind HEAD** |
| Production | `36699531` — **UNTOUCHED** |

## Parts 5–11 — NOT RUN, and not runnable by me

Parts 5 through 11 all sit downstream of one physical act: the owner moving the card and pressing PREVIEW. I cannot place a card on glass. Nothing in the grading, certificate, PDF, logbook, public-lookup, label or NFC chain can be exercised until MV272 BACK exists, because each needs real evidence to act on. **No part of that chain was simulated or asserted from metadata.**

Sequence once GREEN is reached: BACK capture → evidence pipeline proof (object storage, not just DB rows) → `READY_TO_GRADE` → grading queue → grader UI renders FRONT+BACK → **human grade decision (Cornelius)** → QA/approval → certificate → PDF → logbook → public lookup → label authority → NFC eligibility → credit close-out (`reserved 6→5`, `available` unchanged at 4, one consume, no extra debit).

**Part 11 (final 20×20 calibration) is blocked until MV272 closes** — by design, per `watcher.js:997`.

## Genuine outstanding gates

| Gate | Type |
|---|---|
| Physical BACK capture | **Owner action** |
| Human grade/approval decision | **Owner action** |
| GBP pack prices + VAT | Owner/accountant |
| `STRIPE_ENV` on both Fly apps | Owner secrets change |
| Stranded-job cancellation (13 open, MV262–275) | Owner approval, per MV |
| Deploy `3f8984f5` to staging | Release decision |
| Apple Developer ID / notarisation | Not assessed — credential availability unknown |
