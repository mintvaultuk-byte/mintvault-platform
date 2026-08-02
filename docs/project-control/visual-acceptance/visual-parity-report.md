# Project Control visual parity report

Date: 2026-08-02  
Baseline: `a8e49f6d` on `codex/project-control-live-ui`  
Scope: Project Control frontend and visual-acceptance documentation only.

## Gate result

**PROJECT CONTROL VISUAL REVIEW BLOCKED — AUTHENTICATION, BACKEND CONTRACT OR OWNER DECISION REQUIRED**

The implementation and its frontend tests/build are green, and the verified presentation defects below have been corrected. Final visual acceptance cannot be claimed because the safe local application command requires `.env`, which is absent in this worktree. No authentication was bypassed, no fixture data was invented, and no production or staging service was contacted.

## Screenshot index

No screenshots were captured. `npm run dev` stopped before starting the local server with `node: .env: not found`. Consequently the required rendered captures at 1440×900, 1280×800, 1024×768, 768×1024 and 390×844—including evidence, refresh, tree, package and empty/loading states—remain outstanding. Store them in this directory once an authorised local runtime or existing frontend fixture harness is supplied.

## Five-second test

Not render-verified. Code review and component composition now place pilot readiness and the dominant next-action panel first; they expose the next milestone honestly, the highest blocker, comparable staging/production verdicts, and evidence freshness. A real 1440×900 authenticated capture remains required before passing this test.

## Implementation inventory

| Area                   | Result                            | Notes                                                                                               |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Executive summary      | Implemented, render proof pending | Next action is placed beside readiness; next milestone is not mislabelled as active phase.          |
| Partner Shop Launch    | Implemented, render proof pending | Ten declared gate slots, ordered list, next-milestone highlight, separate G7–G20 backlog.           |
| Priority blockers      | Implemented, render proof pending | Server-derived list and package links retained.                                                     |
| Workflow tree          | Implemented, render proof pending | Default focuses the neighbouring launch path; full tree remains explicit.                           |
| Compact live evidence  | Implemented, render proof pending | Current/stale/unknown/unavailable/contradiction presentation is explicit.                           |
| Refresh state          | Implemented, render proof pending | First request failure is visible and retry control remains available.                               |
| Package detail         | Implemented, render proof pending | Remaining work is now above the fold with operational summary.                                      |
| Search and pagination  | Intentionally excluded            | Not part of the approved Gate 2 executive dashboard scope.                                          |
| Error and empty states | Implemented, render proof pending | Safe copy retained; live-evidence transport failure is unavailable, not unknown.                    |
| Responsive layout      | Implemented, render proof pending | Desktop/laptop/tablet/mobile grids and 40px disclosure targets were adjusted.                       |
| Accessibility          | Partially verified                | Semantic H1/list/disclosure and live region are present; keyboard and contrast need rendered proof. |
| Admin shell            | Implemented                       | Uses the existing AdminShell without changing shared shell code.                                    |

## Verified fixes

- Corrected the executive label from “Current phase” to “Next milestone”; the existing contract does not expose an active phase.
- Raised next recommended action to the top desktop/laptop visual group and preserved its priority on smaller screens.
- Replaced static deployment copy with contract-backed aligned/drift/unverified/unavailable values and abbreviated commit evidence.
- Made stale GitHub evidence state “Last known good” with its snapshot timestamp.
- Detect deployment contradiction from `stagingMatchesMain`, `productionMatchesMain`, and `stagingMatchesProduction`, which are the actual contract fields.
- Made live-evidence transport failure explicit as unavailable.
- Made the first refresh-request failure visible rather than leaving a false “No refresh run” state.
- Ensured gate disclosure `aria-controls` always points to an existing details region.
- Reduced the default workflow tree to the focused launch path and changed recursive full-tree key collection to iterative traversal.
- Added above-fold remaining work to package detail and practical disclosure touch targets.

## Responsive results

Desktop, laptop, tablet landscape, tablet portrait and mobile are **code-reviewed but not screenshot-accepted**. The CSS has explicit breakpoints at 1279px, 1023px and 767px; actual overflow, wrapping, focus visibility and priority order must be checked with the required captures.

## Accessibility result

Partial static acceptance only: one H1, ordered launch gates, named controls, persistent `aria-controls` targets, `aria-expanded`, polite refresh status, text-bearing state chips, and 40px disclosure controls are present. Screen-reader, keyboard-focus, contrast and refetch-focus verification require a running authorised application.

## Remaining visual blockers

1. Provide an authorised local runtime configuration or an existing safe frontend fixture harness. The expected `.env` is absent, and this review must not construct or weaken it.
2. Capture and inspect all 18 required states/viewports, including authenticated package detail and retained-evidence refresh behaviour.
3. Confirm the API’s lack of `activePhase` is acceptable. The UI accurately says “Next milestone”; showing a true active phase requires a backend-contract/owner decision and is intentionally not inferred.

## Exact Codex test tasks

1. Render a five-second executive summary test asserting pilot readiness, next milestone, highest blocker, next action, staging, production and freshness are all visible above the fold.
2. Add rendered stale, unavailable and deployment-contradiction state tests, including stale snapshot timestamp copy.
3. Test retained evidence during refresh; only the invoked refresh control disables; first-request failure remains visible and retryable.
4. Exercise polling timeout, terminal states and unmount cleanup with fake timers.
5. Test default and full workflow tree views, neighbouring gate path, backlog separation, blockers and keyboard gate disclosures.
6. Render package above-fold content including remaining work, status, confidence, risk, blocker and next action.
7. Add viewport overflow assertions for 1440×900, 1280×800, 1024×768, 768×1024 and 390×844; include focus-visible checks and raw-error suppression.

## Quality evidence

- `npm test -- tests/project-control-*.test.ts`: 29 files, 717 tests passed.
- `npm run check`: passed.
- Targeted ESLint over the Project Control frontend scope: passed.
- `npm run build`: passed (pre-existing PostCSS `from` warning only).
- `git diff --check`: passed.

## Integration recommendation

Do not declare visual parity complete yet. Resume with an authorised local environment or approved fixture route, capture the listed evidence, then hand the final screenshot-backed result to Codex for UI1–UI12 mutation proof and to Opus for integration review.
