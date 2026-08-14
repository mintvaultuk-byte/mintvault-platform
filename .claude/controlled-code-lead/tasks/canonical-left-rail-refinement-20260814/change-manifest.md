# Change manifest — Canonical grading left-rail refinement

**Date:** 2026-08-14
**Lead session:** `codex/canonical-left-rail-refinement-20260814` at `470699f47b2ae6e2f908367a84f2f91da630c1ef`

## Finding addressed

- CLR-01 — shared preview chrome wastes the card viewer's vertical space — classification A.

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `client/src/components/grading-workflow/CertificatePreviewPanel.tsx` | Retain the existing request/revision/error state machine but render a bare, 266px maximum, aspect-correct PNG; render only compact loading/error text with a retry control. | CLR-01 |
| `tests/certificate-preview-compact-layout.test.ts` | Replace CSS-string checks with mounted structural/semantic checks for bare loaded image, compact states, retry and rail/card allocation. | CLR-01 |
| `tests/{certificate-preview-revision-runtime,label-preview-security}.test.ts` | Re-pin the retained fail-closed revision/error assertions to the compact retry presentation and its explicit retry effect dependency. | CLR-01 |
| `client/src/pages/dev-canonical-workstation-harness.tsx` | Point the existing measurement helper at the bare image rather than the removed decorative frame. This route stays development-only. | CLR-01 |
| `.claude/controlled-code-lead/{INDEX.md,tasks/canonical-left-rail-refinement-20260814/*}` | Record the bounded repair, evidence, rollout and rollback. | CLR-01 |

## Files explicitly not touched

- `client/src/components/grading-workflow/GradingWorkstation.tsx` and `WorkstationPreviewAside.tsx` — their single mount and normal flex-flow contract already return released height to the card.
- `client/src/components/grading/**`, `shared/mvgs-scoring.ts`, `shared/centering.ts`, `shared/pristine.ts` — protected grading behaviour and maths.
- `server/**`, `migrations/**`, `shared/schema.ts` — no renderer/API/schema change.
- Scanner/station controls, auth, payments, configuration and secrets.

## Protected actions required

- [x] MVGS-adjacent presentation edit — expressly authorised by the owner's supplied left-rail micro-repair brief, 2026-08-14; it prohibits logic changes.
- [x] Push, protected PR/merge and conditional production deploy — the brief authorises these exact release phases only after its listed local/CI/lineage guards pass.
- [ ] Migration/application — not authorised and not required.

## Order of operations

1. Capture baseline browser geometry from the existing real five-role, development-only harness.
2. Make the one component/test presentation repair without changing request or review-state code.
3. Repeat both viewport measurements and all functional/architecture gates.
4. Commit, push and open a protected PR; merge/deploy only when its exact SHA and current lineage are green.

## Regression gates required

- [x] Mounted preview compact-layout and revision/runtime tests.
- [x] Five-role harness and canonical architecture tests.
- [x] `npm run check`, serial `npm test` (4,554 passed; CI-gated Partner files recorded separately), `npm run lint`, `npm run build`, `git diff --check`.
- [x] Browser geometry at 1280×800 and 1024×768, with the requested scroll/overflow checks.
- [ ] Exact PR CI and post-deploy health/artifact proof if released.

---
**Approved to proceed to Stage 5:** Cornelius Oliver — explicit targeted owner directive in the supplied brief, 2026-08-14.
