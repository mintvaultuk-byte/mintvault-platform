---
name: mvgs-grading-protected
description: Use this skill BEFORE touching ANYTHING in the MintVault grading system — the MVGS scoring engine, the card tool (8-dot centering + defect marking), sub-grades, the weighted overall formula, grade brackets/labels, the Pristine/black-label gate, the grading/review screen, or the draft→submit→approve→lock state machine. Fires whenever a task, prompt, or agent would read-to-modify, refactor, "improve", optimise, restyle, or fix any file under client/src/components/grading/, shared/mvgs-scoring.ts, shared/centering.ts, shared/pristine.ts, shared/mvgs-input-builder.ts, server/grader.ts, server/routes/grader.ts, server/grading-prompt.ts, server/mvgs-scoring.ts, server/lib/cert-pristine.ts, or the grade/subgrade/label rendering in server/labels.ts + server/certificate-document.ts. The owner has stated this system WORKS, took enormous effort, must stay in the exact same pipeline, and MUST NOT be changed or broken in ANY way. This skill enforces: STOP, do not modify grading logic; surface the intent and get explicit per-change founder approval first. Without it, a "helpful" refactor or bug-fix silently changes deduction weights, the centering chart, the overall formula, the Pristine gate, or the approve-lock — invalidating every historical grade and every printed slab. Fire on ANY grading-adjacent change; over-firing costs one sentence, under-firing corrupts the core product.
---

# MVGS grading system — PROTECTED, do not touch

**Owner directive (2026-07-01):** *"Nothing must be changed with the grading system at all, as it works fine and that's our system that cannot be broken in any way."* MVGS (MintVault Grading Standard) is the core product. It is a **frozen, working production pipeline**. Treat every file listed below as read-only unless the founder explicitly approves that specific change, in this conversation, after you've explained exactly what would change and why.

This is not "be careful" — it is **do not modify**. If a task would touch grading, the correct first move is to STOP and surface it, even if the task looks like a bug-fix or a trivial cleanup. Grading changes invalidate historical grades and physically-printed slabs, which cannot be recalled.

## What the system does (so you recognise it, not so you change it)

**The pipeline (client live-preview, server approval, and every display surface all run the SAME code):**
1. **Card tool** (`manual-card-tool.tsx`) — full-screen 8-dot measurement per side (OUTER edge + INNER art-frame boundary, clockwise T→R→B→L), axis-locked inner dots, rotation-aware screen→image% mapping, auto-deskew from the top→bottom outer line. Then a defect-marking phase (pins classified D1/D2/D3 by mvgsCode + zone; whitening/crease lines in MVGS v2). "Outer-only" mode skips centering for borderless/full-art cards.
2. **Sub-grades** — centering (PSA chart, worst of 4 axes), corners, edges, surface, each derived from a 25-pt deduction budget.
3. **Overall** — weighted `centering×10% + corners×25% + edges×25% + surface×40%`, rounded, then **capped at lowest-subgrade + 1** (+0.5 on high variance), then structural ceilings (crease/wrinkle/tear).
4. **Pristine / 10P (black label)** — gate is `overall == 10 AND all four sub-grades == 10 AND zero deduction`. Nothing else is Pristine. Display derives this from the gate via `certIsPristine()` — never trust a stored `label_type` for display.
5. **Approve → publish → lock** — approve sets `grade_approved_at = NOW()` + `status='active'` in ONE atomic UPDATE. After that the cert is **locked**: the grader draft-save `applyCertGradeDraft()` only writes `WHERE grade_approved_at IS NULL`, so an approved cert cannot be edited until it's explicitly re-opened for edit. `operator_grade`/`operator_subgrades` are an immutable snapshot of what the operator submitted; `graded_by` permanently attributes the work.

## Protected files (do NOT modify without explicit per-change approval)

**Scoring core (the maths — a change here invalidates ALL past grades):**
- `shared/mvgs-scoring.ts` — `computeMvgsScore()`, deduction tables, brackets. Pure function, no side effects — keep it that way.
- `shared/centering.ts` — PSA centering chart (FRONT_BANDS/BACK_BANDS). Published on the public `/standard` page and baked into printed slabs.
- `shared/pristine.ts` + `server/lib/cert-pristine.ts` — the Pristine/black-label gate.
- `shared/mvgs-input-builder.ts`, `server/mvgs-scoring.ts`, `server/grading-prompt.ts`.

**Card tool + grading screen (the workstation):**
- `client/src/components/grading/manual-card-tool.tsx`, `card-tool-geometry.ts`, `centering-from-rects.ts`, `measurement-math.ts`, `crop-tools.ts`, `crop-geometry.ts`, `image-viewer.tsx`, `defect-type-picker.tsx`, `defect-annotation.tsx`.
- `client/src/components/grading/grading-panel.tsx` and its siblings: `ai-panel.tsx`, `centering-input.tsx`, `manual-centering.tsx`, `corner-grading.tsx`, `edge-grading.tsx`, `surface-grading.tsx`, `quick-grade.tsx`, `grade-display.tsx`, `grade-logic.ts`, `grading-notes.tsx`, `authentication.tsx`, `capture-wizard.tsx`, `cross-grade-display.tsx`, `session-summary.tsx`, `grading-queue.tsx`.

**State machine + grade/label rendering:**
- `server/grader.ts` (applyCertGradeDraft lock, approveCertGrade, rejectCertGrade, approveGraderCert), `server/routes/grader.ts` (submit / edit-submission / admin-review-save / approve / reject).
- The grade/subgrade/Pristine reconstruction in `server/labels.ts` and `server/certificate-document.ts`, and the grade-constants section of `shared/schema.ts`.

## Invariants that must never change
- Centering chart bands + deductions; corner/edge/surface D1/D2/D3 weights; the 25-pt sub-grade budgets.
- The weighted overall formula (10/25/25/40) and the lowest-subgrade+1 cap.
- The score→grade-label brackets (1–100 → 1–10 + special grades).
- The Pristine 10P gate (overall 10 + all subs 10 + zero deduction).
- The approve-lock (`WHERE grade_approved_at IS NULL`), the atomic CAS on every state transition (`WHERE grader_status='...'` + `RETURNING`), and the immutable `operator_grade`/`operator_subgrades` snapshot.
- Card-tool geometry: dot placement / axis-lock / deskew math (kept byte-identical to `manual-crop.tsx`) / coordinate mapping / the tuned `CROP_MARGIN_PCT`, `TAP_MOVE_PX`, `GRAB_PX` thresholds.

## What to do instead when a task points here
1. STOP. Do not edit. Say plainly that the change would touch the protected MVGS grading system.
2. Describe the exact behaviour that would change, in the founder's terms, and the blast radius (historical grades / printed slabs / the public /standard page).
3. Ask for explicit approval for that one change. Only proceed after a clear yes — and even then, stay minimal, keep the pipeline identical, and verify against real grades.

## Known, deliberately-UNFIXED items (do not "fix" without approval)
- **NULL sub-grades on some numbered certs** (Bucket C: ~18 prod certs, e.g. MV26/51/59/…). A numbered grade *can* currently publish with blank sub-grades (the client omits 0/blank values). This is a KNOWN gap, left as-is by owner directive — the grading system is not to be changed. Do not add a force-review guard or promotion without explicit approval. See memory `[[project_pristine_gate_display]]`.
- **variant/rarity share one label line** — held by convention, not enforced. Do not add a write-time guard without approval. See `[[project_variant_rarity_shared_line]]`.

Related: `[[project_pristine_gate_display]]`, `[[project_variant_rarity_shared_line]]`, `[[project_staff_capabilities]]`, `[[feedback_logbook_quality]]`.
