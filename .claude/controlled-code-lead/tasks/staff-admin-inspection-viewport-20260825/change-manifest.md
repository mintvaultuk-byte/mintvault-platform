# Change manifest — Staff Admin grading inspection viewport

**Date:** 2026-08-25
**Lead session:** `codex/staff-admin-inspection-viewport-20260825` at `01d5e4daab30d58ad53943585ebecc972befaa8a`

## Findings addressed

- SIV-001 — zoom-sensitive breakpoint/rail-sizing feedback — Class C.
- SIV-002 — undersized authoritative main card — Class C.
- SIV-003 — inadequate independent MARK DEFECTS inspection viewport — Class C.

## Explicitly deferred

- SIV-004 — pre-existing post-crop Card Tool provenance seam. Owner explicitly excluded Card Tool/Manual Crop math and historical data rewriting.

## Runtime files to change

| File | Change | Why | Class |
|---|---|---|---|
| `client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx` | Use the measured minimum viable two-pane breakpoint instead of the zoom-sensitive `md` cliff | SIV-001 | C |
| `client/src/components/grading-workflow/WorkstationPreviewAside.tsx` | Remove adaptive self-width/max-width and `55vh`; give row/stack modes stable flex geometry | SIV-001 | C |
| `client/src/components/grading-workflow/GradingWorkstation.tsx` | Remove the obsolete rail-width feedback provider from the canonical workstation | SIV-001 | C |
| `client/src/components/grading-workflow/card-inspection-state.ts` | Clamp presentation zoom to 50–500% while retaining per-side normalized focus | SIV-003 | C |
| `client/src/components/grading-workflow/CardPreviewPanel.tsx` | Keep the secondary shared-state consumer inside the same 50–500% bounds | SIV-003 | C |
| `client/src/components/grading/inspection-viewport-geometry.ts` | Add pure FIT, placement, pan and cursor-zoom geometry over normalized focus | SIV-001..003 | C |
| `client/src/components/grading/image-viewer.tsx` | Replace rail ratchet + separate MARK path with one explicit image/overlay plane; add FIT, 50–500%, anchored zoom, pan, non-hijacking wheel and safe shortcuts | SIV-001..003 | C |
| `client/src/components/grading/grading-panel.tsx` | Remove the portaled duplicate side row; let the viewer own the single side/zoom utility row | SIV-002 | C |
| `client/src/pages/dev-admin-shell-geometry-harness.tsx` | Keep the shell stub aligned and expose runtime geometry needed for browser acceptance | SIV-001 | C |
| `client/src/pages/dev-canonical-workstation-harness.tsx` | Supply admitted test evidence so the canonical five-role harness can render the authoritative viewer | SIV-001..003 | C |

## Regression files expected to change

- `tests/grading-rail-card-safe-fit.test.ts`
- `tests/grading-rail-fit-stability.test.ts`
- `tests/grading-rail-visible-viewport-authority.test.ts`
- `tests/adaptive-rail-width.test.ts`
- `tests/grading-rail-control-containment.test.ts`
- `tests/card-inspection-state.test.ts`
- `tests/card-inspection-mounted.test.ts`
- Source-contract workstation tests that fail only because they pin the obsolete `md`/adaptive/ratchet implementation.
- New `tests/grading-inspection-viewport-geometry.test.ts` for behavioural geometry and mutation-sensitive invariants.

## Files explicitly not touched

- `manual-card-tool.tsx`, `card-tool-geometry.ts`, `manual-crop.tsx`, crop/server evidence code — unchanged authority and math.
- `shared/mvgs/**`, `shared/mvgs-scoring.ts`, `shared/centering.ts`, `shared/pristine.ts`, `shared/mvgs-input-builder.ts`, `server/grader.ts`, schema/migrations — frozen semantics/data.
- Auth, Stripe, certificate issuance, claims, NFC and Partner business logic — outside scope.

## Owner approval record

- The attached 2026-08-25 authorization explicitly approves local edits to the named grading presentation files for this implementation phase and explicitly withholds deployment.
- No migration, provider call, dependency change, push, staging mutation or production mutation is authorised.

## Order

1. Add pure geometry and teeth-bearing RED tests.
2. Stabilise shell/aside geometry and remove duplicated/wrapping control costs.
3. Wire the shared image/overlay viewport into main and MARK DEFECTS.
4. Run focused tests after each logical change and inspect drift.
5. Run full gates, real-browser zoom/annotation/cross-role acceptance and final hostile review.
6. Freeze/report the local candidate; stop before deployment.

## Result

- The presentation-only runtime manifest above is implemented. No API, schema,
  migration, grading, crop, authentication, certificate, claim, NFC, payment or
  Partner-business file changed.
- The image, stored defect pins, whitening/crease segments and centering frames
  now render in one image-relative percentage plane in both the main viewer and
  MARK DEFECTS.
- Local automated verification is green. Real Chrome acceptance and the final
  independent hostile diff review remain release gates, so staging is not yet safe.

## Required Stage 6 gates

- `npm run check`, `npm test`, `npm run lint`, `npm run build`, `npm run dev` boot.
- Engineering graph update/check and `engineering postflight --run`.
- Protected MVGS, Card Tool and Manual Crop regression suites with unchanged snapshots/outputs.
- Real Chrome/browser matrix and normalized annotation anchoring across five roles.
- Changed-file allowlist, secret scan, governance snapshot comparison, hostile final-diff review.

**Approved to proceed to Stage 5:** Cornelius Oliver, attached authorization dated 2026-08-25.
