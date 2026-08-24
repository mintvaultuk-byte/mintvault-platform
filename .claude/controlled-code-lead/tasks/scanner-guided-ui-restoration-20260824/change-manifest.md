# Change manifest — Scanner guided UI restoration (2026-08-24)

**Date:** 2026-08-24
**Lead session:** `codex/partner-scanner-onboarding-20260824` / `8b117946c411a544f38cf551a091bfb949cb8f43`

## Findings this manifest addresses

- SCN-UX-002 — non-ACTIVE Scanner state exposes the legacy capture and top-up workflow — classification C.

## Findings explicitly deferred (not in this manifest)

- None. A real approval retry is explicitly deferred until this repaired package is visibly accepted.

## Files to change

| File                                                     | Change                                                                                                                                                                                                                      | Why                                                                                                                           | Classification |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `scripts/scanner-app/renderer/index.html`                | Wrap operational content in a hidden-by-default container; start the setup overlay in a neutral checking state.                                                                                                             | Prevent legacy capture controls from flashing or appearing before station authority is known.                                 | C              |
| `scripts/scanner-app/renderer/app.js`                    | Render the operational container only for authoritative `active` setup; initialise the guided checking state; retain station recovery controls; require a VALID calibration before zero-credit billing can block card work. | Enforce the station workflow as the only operator path before calibration.                                                    | C              |
| `scripts/scanner-app/test/renderer-workflow.test.js`     | Add regression checks for non-ACTIVE UI/billing gating, startup checking state, recovery controls, and calibration handoff.                                                                                                 | Make the visual workflow regression executable.                                                                               | C              |
| `scripts/scanner-app/test/station-active-card.test.js`   | Re-pin the zero-credit UI assertion to the stronger non-ACTIVE exclusion invariant.                                                                                                                                         | Preserve the ACTIVE credit gate while proving it cannot leak into setup.                                                      | C              |
| `scripts/scanner-app/test/billing-ux.test.js`            | Make the existing billing fixture explicit that it represents an ACTIVE, VALID-calibration station.                                                                                                                         | Keep established billing proof focused on the card-work state and prevent a fixture from bypassing the new calibration guard. | C              |
| `scripts/scanner-app/package.json` / `package-lock.json` | Bump the Scanner application version to the next patch release.                                                                                                                                                             | Ensure the acceptance artifact cannot be confused with 1.5.1.                                                                 | C              |
| `tests/partner-connect-autoenrol-credits.test.ts`        | Update the compiled package version expectation.                                                                                                                                                                            | Keep cross-surface release identity proof current.                                                                            | C              |

## Files explicitly NOT touched (but might look related)

- `server/partner/**`, `shared/schema.ts`, `migrations/**` — no backend, station, schema, approval, wallet, or credit mutation is necessary for this renderer defect.
- `scripts/scanner-app/lib/watcher.js`, native LiDE bridge, card/evidence code — no scan/capture behavior changes are authorised.
- Production configuration and Fly manifests — not part of a packaged Scanner UI correction.

## Protected actions required

- [x] None for the local source/package repair.
- [ ] The later staging owner approval action is not part of this manifest.

## Order of operations

1. Hide all operational Scanner controls until authoritative setup returns `active`.
2. Prevent the billing layer from rendering or polling on every non-ACTIVE state.
3. Add workflow regression proof and bump the packaged version.
4. Build/inspect the macOS arm64 package and launch only the corrected local Scanner instance for read-only visual acceptance.

## Regression gates required (Stage 6)

- [x] `npm --prefix scripts/scanner-app test` — 165/165 passed.
- [x] Focused Scanner renderer workflow tests — covered in the Scanner suite and compiled proof.
- [x] `npm run check` — passed.
- [x] `npm run lint -- --quiet` — passed.
- [x] `npm run build` — passed.
- [x] Fresh arm64 package plus package verifier — 1.5.4 passed.
- [x] Read-only local process/runtime-manifest inspection — exact 1.5.4 package declared STAGING and exited cleanly with no active Scanner work.

---

**Approved to proceed to Stage 5:** owner-authorised Scanner workflow repair; no protected action required — 2026-08-24
