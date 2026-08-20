# Change manifest — Partner queue evidence and shop-floor workflow

**Date:** 2026-08-20
**Lead session:** `codex/partner-queue-workflow-staging-20260820` at `e057a67d`

## Findings this manifest addresses

- PQW-F1 — server-derived per-side evidence state must remain visible in the Partner queue — classification B/C.
- PQW-F2 — recover the prior canonical working-evidence-only admission contract — classification B/C.
- PQW-F3 — remove dead pages from launch navigation and retain live settings routes as secondary navigation — classification A/C.

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `client/src/components/grading-workflow/CardPreviewPanel.tsx` | Reconcile working-evidence-only display and unavailable states. | PQW-F2 | B |
| `client/src/components/grading/grading-panel.tsx` | Admit Card Tool by side only after working evidence admission. | PQW-F2 | B |
| `client/src/components/grading/image-viewer.tsx` | Use admitted `front_working`/`back_working` only for inspection. | PQW-F2 | B |
| `client/src/components/grading/manual-card-tool.tsx` | Bind Card Tool to admitted working evidence only. | PQW-F2 | B |
| `server/grader.ts`, `server/routes.ts`, `server/scan-ingest-service.ts` | Reconcile canonical LiDE working-evidence admission and signing contract. | PQW-F2 | B |
| `server/partner/grading-routes.ts` | Return queue side status and safe thumbnails from the same admitted evidence evaluator. | PQW-F1 | B |
| `client/src/pages/partner/grading.tsx` | Render side-specific queue evidence and make readiness server-derived. | PQW-F1 | B |
| `client/src/components/partner/partner-shell.tsx` | Replace the large primary list with role-gated primary and secondary navigation. | PQW-F3 | A |
| `client/src/pages/partner/dashboard.tsx` | Focus the operational dashboard on credit and card lifecycle actions. | PQW-F3 | A |
| `client/src/pages/partner/submission-wizard.tsx` | Make existing customer selection optional only if the server already accepts a null customer. | PQW-F3 | A |
| `tests/partner-grading-queue-evidence.test.ts`, `tests/partner-shop-workflow-source.test.ts`, `tests/partner-submission-wizard-ui.test.ts`, evidence tests | Add behavioural, cross-card, cross-side and navigation regressions. | PQW-F1–3 | A/B |
| task governance records | Record scope, proof and rollback. | governance | A |

## Files explicitly NOT touched

- `shared/mvgs-*`, `shared/centering.ts`, `shared/pristine.ts` — MVGS maths/gates.
- Stripe routes/services and wallet/reservation authority — no money changes.
- Partner/staff authentication and session code — no auth changes.
- Scanner capture/placement authority — separate 3 mm qualification remains untouched.
- Database schema/migrations — none required; no migration will be run.

## Protected actions required

- [x] None for local implementation and read-only staging classification.
- [ ] Staging deployment — requires a later explicit owner instruction.

## Order of operations

1. Verify current queue, evidence and customer dependencies against source and staging read-only data.
2. Reconcile the previously owner-authorised working-evidence contract with current main.
3. Add shared, server-derived queue status and side-bound thumbnail fields, then render them.
4. Simplify navigation and dashboard only after route/capability/dead-page audit.
5. Run regression, mutation and visual gates without a deploy.

## Regression gates required

- [x] `npm run check`
- [x] `npm test` — isolated disposable loopback database only: 346 files passed, 5,463 tests passed, 29 explicitly skipped.
- [x] Changed-file lint — 0 errors. The repository reports pre-existing warning-only debt in broad legacy files; no warning is promoted to an error.
- [x] `npm run build`
- [x] Focused queue/evidence/navigation tests plus MVGS protected regressions
- [x] `git diff --check` at implementation checkpoint; staged final check remains.

**Approved to proceed to Stage 5:** Owner request explicitly authorises the listed non-maths evidence and Partner workflow changes; deployment remains separately unapproved.
