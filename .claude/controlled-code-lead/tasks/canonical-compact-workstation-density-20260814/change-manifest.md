# Change manifest — Canonical compact grading workstation density

**Date:** 2026-08-14

**Lead session:** `codex/canonical-compact-workstation-density-20260814` at `839edd9c45215bfba157b930b9ec5690d47ceac0`

## Findings this manifest addresses

- CWD-01 — The current shared rail is 40% wide, its normal image-variant filter row is 25px high, and the card starts at 170px at both 1280×800 and 1024×768. The card should recover that space while retaining its persistent inspection state. — classification A.
- CWD-02 — The header is 75px tall and the Grade surface has oversized grade, MVGS, centering-reference, and repeated padded containers. The right pane is 359px scrollable at 1280×800 and 427px at 1024×768. — classification A.

## Findings explicitly deferred

- Any scoring, threshold, centering calculation, Pristine/black-label, label-renderer, certificate-number, approval/CAS, scanner-service, auth/RBAC, database, or migration issue. These are prohibited by this task's presentation-only scope.

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx` | Tighten shared visual gaps only. | CWD-02; one canonical shell remains. | A |
| `client/src/components/grading-workflow/WorkstationPreviewAside.tsx` | Move desktop rail to 35%, tighten vertical rail gap. | CWD-01; make the right workspace wider and card rail more useful. | A |
| `client/src/components/grading-workflow/CertificatePreviewPanel.tsx` | Render the existing real preview as a 230px bare, ratio-correct reference. | CWD-01; certificate stays subordinate. | A |
| `client/src/components/grading-workflow/GradingWorkflowBar.tsx` | Compact visual stage controls without changing labels, click handlers, or stage state. | CWD-02. | A |
| `client/src/components/grading/image-viewer.tsx` | Remove only the normal operator variant-filter button row; retain original-image presentation, Front/Back, zoom/pan, defect, crop, and existing image-processing data paths. | CWD-01; eliminate the named unused filter controls and dead space. | A |
| `client/src/components/grading/grade-display.tsx` | Compact display-only overall-grade, subgrade, strength, and explanatory geometry. | CWD-02; no values or formulas change. | A |
| `client/src/components/grading/centering-input.tsx` | Compact the read-only centering presentation only. | CWD-02; no ratios or grading calculation change. | A |
| `client/src/components/grading/grading-panel.tsx` | Tighten shared Grade-stage spacing/padding and place the existing threshold reference in a closed-by-default details control. | CWD-02; authority, controls, callbacks, payload, and review/CAS paths remain byte-for-byte outside presentation markup. | A |
| `client/src/pages/dev-canonical-workstation-harness.tsx` | Extend the dev-only real-workstation harness with required viewport and geometry evidence hooks. | Verifiable owner acceptance. | A |
| `tests/certificate-preview-compact-layout.test.ts` | Update visual-contract dimensions. | Regression proof. | A |
| `tests/canonical-compact-workstation-density.test.ts` | Add owner-acceptance source/negative proof for density and protected boundaries. | Regression proof. | A |
| Existing grading layout/architecture/stage tests and `tests/label-preview-security.test.ts` | Update source-contract assertions for the compact presentation and make the existing preview dependency assertion whitespace-tolerant. | Regression proof only; no preview behaviour changes. | A |

## Files explicitly NOT touched

- `shared/mvgs-scoring.ts`, `shared/centering.ts`, `shared/pristine.ts`, `shared/schema.ts`, `server/grader.ts`, `server/routes/grader.ts`, `server/mvgs-scoring.ts`, `server/labels.ts`, `server/certificate-document.ts`, migrations, Partner route/service/RBAC code, and scanner/station services — protected logic and data are out of scope.
- Role entry pages and `GradingWorkstation.tsx` — all five roles already consume the one canonical shell; a presentation change there would be needless fork risk.

## Protected actions required

- [x] Narrow MVGS-protected presentation-component change — owner approval obtained directly in the attached “FINAL COMPACT PROFESSIONAL GRADING WORKSTATION DENSITY PASS OWNER VISUAL ACCEPTANCE” request on 2026-08-14. Approval is limited to the exact presentation changes above and explicitly excludes grading behaviour and maths.
- [x] Push, protected PR, merge, and conditional controlled deployment — owner authorisation is explicit in the same request, subject to every listed acceptance and release gate.

## Order of operations

1. Apply only shared presentation constants/classes and remove the named filter control row.
2. Add deterministic source and dev-harness regression proof.
3. Run focused behavioural and protected-MVGS proof, then browser/hostile review.
4. Reconcile, PR, protected CI, merge, live-lineage/deploy checks only after local acceptance is complete.

## Regression gates required

- [x] `npm run check`
- [x] `npm run lint` (repository warnings only; zero lint errors)
- [x] focused Vitest suites; local unconfigured full suite is documented, CI remains required
- [x] `npm run build`
- [x] scoped `npm run db:lint-sql` for 0075–0078; no migration file changed
- [x] browser geometry/screenshots and five-role behavioural matrix
- [x] MVGS guard mutation red/restore green
- [ ] protected PR exact-head CI and live verification if deployed

---

**Approved to proceed to Stage 5:** Cornelius Oliver, by the explicit attached owner acceptance request — 2026-08-14.
