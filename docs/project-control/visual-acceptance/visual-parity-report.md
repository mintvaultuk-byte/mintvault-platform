# Project Control visual parity report

Date: 2026-08-02
Branch: `codex/project-control-live-ui`
Starting proof HEAD: `74b6be7b`
Scope: Project Control frontend, test-only fixture harness, frontend-only tests, and visual-acceptance documentation.

Scope note: this report proves no new dirty backend/shared/migration files were introduced during the continuation UI
proof pass. It does not claim the branch has no historical backend/shared/migration differences versus `origin/main`.

## Gate result

**CORRECTED 2026-08-02.** The original gate result claimed SCREENSHOT and RESPONSIVE proof that
did not exist. The responsive assertion ran in happy-dom, which has no layout engine, so it read
`0 <= width` and could not fail; and the screenshots below are JPEG data with a `.png` extension,
captured from a fixture that was missing `.admin-root` and therefore rendered with the wrong ink
colour and base font size.

Responsive proof has since been produced properly, in real Chrome over the DevTools Protocol, with
a mandatory positive control and a verified 390px layout viewport — see
[`browser-proof/README.md`](browser-proof/README.md). All five viewports are clean.

**Current standing: HARNESS, RENDERED TEST, UI1-UI12 MUTATION and REAL-BROWSER RESPONSIVE evidence
complete. SCREENSHOT evidence in `final/` remains fixture-derived and is NOT production-faithful.**

The approved Terra layout direction remains preserved: 80% Executive Control Centre, 20% Workflow Tree First, compact Live Evidence. The UI still says “Next milestone” because the API does not provide a proven active phase.

## Visual fixture harness

Added a test-only fixture at `client/src/test-harness/project-control-visual-fixture.tsx` with typed DTO-shaped Project Control content, real Project Control components, and the approved Project Control CSS. It covers:

- current evidence;
- stale last-known-good evidence;
- unavailable evidence;
- contradictory evidence;
- GitHub refresh running with retained evidence;
- failed refresh with retry;
- empty state;
- loading with retained evidence;
- expanded workflow tree;
- package detail;
- ten launch gates;
- permanent backlog separate;
- superseded/replacement package history;
- orphan warning;
- cycle warning.

The served screenshot entry is `client/project-control-visual-fixture.html`. It is not a production app route and does not bypass authentication.

## Production-bundle exclusion proof

Guard tests pass in `tests/project-control-visual-fixture.test.ts`:

- the production Admin shell keeps `{ href: "/admin/project-control", label: "Project Control" }`;
- no production client import edge to `project-control-visual-fixture`;
- no fixture route in `client/src/App.tsx`;
- `script/build.ts` and `vite.config.ts` do not register the fixture entry.

Positive control: temporarily importing `@/test-harness/project-control-visual-fixture` from `client/src/App.tsx`
made `tests/project-control-visual-fixture.test.ts` fail on both production-root import and App route/string
guards. The import was removed and the suite returned green.

Built asset scan after production build returned no matches for fixture-only text:

- `Project Control visual fixture`;
- `project-control-visual-fixture`;
- `pc-g7-g20-backlog`;
- `pc-superseded-legacy-flags`;
- `pc-orphan-shop-csv`.

## Screenshot index

- `docs/project-control/visual-acceptance/final/1440x900-dashboard-current.png`
- `docs/project-control/visual-acceptance/final/1440x900-launch-gates-current.png`
- `docs/project-control/visual-acceptance/final/1440x900-permanent-backlog-current.png`
- `docs/project-control/visual-acceptance/final/1440x900-priority-blockers-current.png`
- `docs/project-control/visual-acceptance/final/1440x900-workflow-tree-collapsed-current.png`
- `docs/project-control/visual-acceptance/final/1440x900-workflow-tree-expanded-expanded-tree.png`
- `docs/project-control/visual-acceptance/final/1440x900-workflow-tree-blockers-integrity.png`
- `docs/project-control/visual-acceptance/final/1440x900-package-detail-package.png`
- `docs/project-control/visual-acceptance/final/1440x900-package-evidence-history-package-history.png`
- `docs/project-control/visual-acceptance/final/1440x900-evidence-stale.png`
- `docs/project-control/visual-acceptance/final/1440x900-evidence-unavailable.png`
- `docs/project-control/visual-acceptance/final/1440x900-evidence-contradiction.png`
- `docs/project-control/visual-acceptance/final/1440x900-github-refresh-running-retained-evidence.png`
- `docs/project-control/visual-acceptance/final/1440x900-github-refresh-failed-retry.png`
- `docs/project-control/visual-acceptance/final/1440x900-dashboard-empty.png`
- `docs/project-control/visual-acceptance/final/1440x900-dashboard-loading-retained-evidence.png`
- `docs/project-control/visual-acceptance/final/1280x800-dashboard-tablet-landscape.png`
- `docs/project-control/visual-acceptance/final/768x1024-dashboard-tablet-portrait.png`
- `docs/project-control/visual-acceptance/final/390x844-dashboard-mobile.png`
- `docs/project-control/visual-acceptance/final/1024x768-package-superseded-replacement.png`
- `docs/project-control/visual-acceptance/final/1024x768-integrity-orphan-warning.png`
- `docs/project-control/visual-acceptance/final/1024x768-integrity-cycle-warning.png`

## Five-second test

Passed by rendered DOM proof and visual inspection at 1440x900. A new operator can immediately locate:

- pilot readiness;
- next milestone;
- biggest blocker;
- next action;
- staging state;
- production state;
- evidence freshness.

## Responsive results

**RETRACTED AND REPLACED.** The claim below was originally supported by a happy-dom loop that
could not fail: `scrollWidth` is a field initialised to 0 that layout never writes, so the
assertion evaluated `0 <= 390`. vitest also runs with `css: false`, so the media queries under test
were never parsed.

Real measurements, Chrome 151 over CDP with `Emulation.setDeviceMetricsOverride` (needed because
`--window-size` clamps to ~500px on macOS, which would silently invalidate any 390px claim):

| Viewport | innerWidth | docScrollWidth | bodyScrollWidth | horizontally scrollable | offenders |
|---|---|---|---|---|---|
| 1440x900 | 1440 | 1440 | 1440 | no | 0 |
| 1280x800 | 1280 | 1280 | 1280 | no | 0 |
| 1024x768 | 1024 | 1024 | 1024 | no | 0 |
| 768x1024 | 768 | 768 | 768 | no | 0 |
| 390x844 | 390 | 390 | 390 | no | 0 |

Each run injects a 5000px element and fails unless the probe detects it, so a future regression to
a vacuous measurement is caught. Full method, limits and re-run instructions:
[`browser-proof/README.md`](browser-proof/README.md).

The 390px capture there is full-page and shows all ten launch gates. The older
`390x844-dashboard-mobile.png` was cropped at the viewport and ended part-way through the
pilot-readiness card, showing none of the gate list it was cited as evidence for.

## Accessibility result

Rendered tests verify:

- one H1 in the fixture page;
- ordered launch-gate list;
- named disclosure controls;
- `aria-expanded` toggles;
- `aria-controls` targets exist;
- polite live status for refresh state;
- no nameless buttons in the rendered Project Control fixture;
- colour is paired with text-bearing evidence/status chips.

## Rendered-component tests

Added rendered tests in `tests/project-control-rendered-ui.test.ts` for:

- executive summary signals;
- honest “Next milestone” wording;
- ten launch gates in exact order;
- permanent backlog separation;
- launch disclosure accessibility;
- stale/unavailable/contradiction/failed-refresh states;
- retained evidence during GitHub refresh;
- empty and loading states;
- workflow tree focus, expansion, blockers, orphan warning and cycle warning;
- unavailable evidence does not render unknown values as `0%`;
- GitHub refresh running disables only GitHub refresh controls, not launch-gate disclosures;
- package detail and superseded/replacement history;
- basic accessibility invariants.

Added rendered package-detail mutation-failure tests in `tests/project-control-package-rendered.test.ts` for:

- operator-entered package values remain mounted and retained after failed save;
- retry remains available after failed save;
- raw backend error text is not rendered;
- distinct safe 409 copy for version conflicts, illegal transitions, override-required saves, and generic conflicts.

## Polling lifecycle

Added `tests/project-control-github-sync-rendered.test.ts` covering:

- polling stops on `SUCCEEDED`;
- polling stops on `PARTIAL`;
- polling stops on `FAILED`;
- polling stops on `RATE_LIMITED`;
- polling stops on `UNAVAILABLE`;
- polling stops on `CANCELLED`;
- polling stops on `EXPIRED`;
- polling cadence every five seconds while non-terminal;
- 90-second client expiry;
- unmount cleanup;
- stale response cannot overwrite a newer generation;
- failed refresh request keeps retry available and does not render raw backend error text.

## UI1-UI12 mutation battery

Completed on 2026-08-02. Each mutation was applied temporarily with `apply_patch`, TypeScript was run where relevant,
the expected RED detector was captured, the mutation was restored, mutation-marker scans were clean, and the focused
baseline returned green before the next mutation.

Detailed proof artefact: `docs/project-control/visual-acceptance/ui-mutation-proof.md`.

| ID   | Temporary mutation                                    | RED detector                                                                                                                                                                                                             | Restore proof                                          |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| UI1  | Unknown evidence rendered as `0%`                     | `tests/project-control-rendered-ui.test.ts` → `distinguishes stale, unavailable, contradiction and failed refresh states`                                                                                                | `compact-live-evidence.tsx` hash restored              |
| UI2  | Previous evidence cleared while refresh was running   | `tests/project-control-rendered-ui.test.ts` → `retains previous evidence while GitHub refresh is running and disables only GitHub refresh controls`; `renders empty and loading states without treating unknown as zero` | `project-control-dashboard.tsx` restored               |
| UI3  | Terminal GitHub sync states kept polling              | `tests/project-control-github-sync-rendered.test.ts` → terminal stop cases for `SUCCEEDED`, `PARTIAL`, `FAILED`, `RATE_LIMITED`, `UNAVAILABLE`, `CANCELLED`, `EXPIRED`                                                   | `use-github-sync.ts` restored                          |
| UI4  | Launch-gate disclosure disabled like refresh controls | `tests/project-control-rendered-ui.test.ts` → launch-gate disclosure aria toggle and refresh-running scoped-disable checks                                                                                               | `partner-shop-launch-progression.tsx` restored         |
| UI5  | Stale evidence mapped to current                      | `tests/project-control-rendered-ui.test.ts` → stale last-known-good proof; `tests/project-control-ui-live.test.ts` → stale vocabulary                                                                                    | `evidence-state.tsx` hash `d8ad1182...`                |
| UI6  | Contradiction warning removed                         | `tests/project-control-rendered-ui.test.ts` → contradiction warning missing                                                                                                                                              | `compact-live-evidence.tsx` hash `c96858...`           |
| UI7  | Permanent backlog included as an 11th launch gate     | `tests/project-control-rendered-ui.test.ts` → exact ten Partner Shop Launch gate order                                                                                                                                   | `partner-shop-launch-progression.tsx` hash `39863e...` |
| UI8  | Admin shell Project Control nav label changed         | `tests/project-control-visual-fixture.test.ts` → production Admin shell navigation entry contract                                                                                                                        | `admin-shell.tsx` returned to no diff                  |
| UI9  | Package editor unmounted after failed save            | `tests/project-control-package-rendered.test.ts` → retained controls remain mounted after failed mutation                                                                                                                | `project-control-package.tsx` restored                 |
| UI10 | Failed save cleared package editor values             | `tests/project-control-package-rendered.test.ts` → operator-entered values retained after failed mutation                                                                                                                | `project-control-package.tsx` restored                 |
| UI11 | All 409 errors used the version-conflict copy         | `tests/project-control-package-rendered.test.ts` → distinct safe 409 copy for illegal transition, override-required, and generic conflict                                                                                | `project-control-package.tsx` restored                 |
| UI12 | Raw backend error message rendered                    | `tests/project-control-package-rendered.test.ts` → raw `postgres://raw-secret` text suppressed and safe fallback shown                                                                                                   | `project-control-package.tsx` restored                 |

## Quality evidence

- Final double gate, pass 1: focused rendered/proof suites passed (4 files, 31 tests); `npm test -- tests/project-control-*.test.ts` passed (33 files, 748 tests); `npm run check` passed; targeted ESLint passed; `npm run build` passed with the pre-existing PostCSS `from` warning.
- Final double gate, pass 2: focused rendered/proof suites passed (4 files, 31 tests); `npm test -- tests/project-control-*.test.ts` passed (33 files, 748 tests); `npm run check` passed; targeted ESLint passed; `npm run build` passed with the pre-existing PostCSS `from` warning.
- After adding the checked-in viewport loop and mutation proof artefact: focused rendered/proof suites passed (4 files, 32 tests); `npm test -- tests/project-control-*.test.ts` passed (33 files, 749 tests); `npm run check` passed.
- Production asset fixture scan after final build: clean.
- Wider `npm test`: blocked outside Project Control scope by missing environment variables (`TEST_DATABASE_URL` for auth/rarity migration suites and `MINTVAULT_DATABASE_URL` for Vault Quest suites). Other discovered suites completed to 218 passed / 53 skipped before the env-gated failure summary.
- Responsive overflow: measured in real Chrome at five viewports, all clean, with a positive
  control on every run (`browser-proof/README.md`). The former happy-dom "DOM probe" is withdrawn.
- Screenshot integrity: the 22 files originally indexed contained only 18 distinct images (one
  capture re-saved under four names, another under two). The four duplicates have been removed.
  All remaining files in `final/` are JPEG data named `.png`.

## Backend contract limitations

The API provides “Next milestone”, not a proven active phase. The UI does not fabricate an active phase.

## Remaining work before Opus integration

None from the Project Control UI proof scope after the final double gate and commit.

## Integration recommendation

The Project Control UI proof branch is ready for owner/Opus integration review after the final double gate. Run the
environment-gated wider repository suites again with the required database variables before treating `npm test` as a
repository-wide green signal.
