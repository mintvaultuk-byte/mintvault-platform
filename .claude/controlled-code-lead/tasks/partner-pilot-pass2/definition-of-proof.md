# Definition of proof — Partner Pilot Pass 2

## Passed local proof

- Server-owned grading boundary / MVGS / canonical-origin suites: **204 tests**.
- 0074 provenance hardening migration regression: **17 tests**, including the
  pg_temp forged-table attack.
- Package B authority/flag/QA suite: **94 tests**.
- Package C scanner boundary/schema subset: **21 tests**.
- Package D paired completion/Next Card: **35 scanner-app tests** plus the
  **22-test** focused scanner boundary/schema suite.
- Package E fleet approval/rejection boundary: **3 tests**.
- Package F allocation/physical-evidence/QA/print/history boundary: **50
  focused tests**; print workflow + credit lifecycle: **107 tests**; Pass 1
  authority/preview bundle boundary: **120 tests**.
- Migration/station convergence: **61 passed, 1 intentionally skipped** (no
  optional external disposable runtime configured).
- `npm run check`, `npm run build`, and `npm run lint` completed successfully.
  Lint reports the repository's existing warnings but no errors.
- `.claude/governance-tests/run-all.sh` passed all four governance suites.

## Full-suite limitation

The root `npm test` cannot establish a full green result from the supplied reusable
dependency tree: its `canvas` package lacks the native `build/Release/canvas.node`
binding, which prevents label/font raster proofs. The same run also exposes
pre-existing environment-sensitive workstation and mock contracts outside the
Pass 2 file set. No dependency installation, native rebuild or lockfile change
was performed for the root application. The isolated scanner-app package was
installed locally from its existing lockfile only to run its declared suite; its
native dependency used the workspace's known-good cache and no manifest or
lockfile changed.

The optional Engineering OS `preflight`/`postflight` command cannot run in
this checkout because it has no `.engineering/project.yaml`; this is recorded
as an environment configuration limitation, not treated as a release pass.

## Not proven locally or in production

- No authenticated production Partner lifecycle exists while the restricted
  runtime URL remains a placeholder/mismatched topology.
- Neither 0074, 0075 nor 0076 was applied; production migration journal
  inventory is unknown and must be read in a redacted `BEGIN READ ONLY`
  transaction first. No disposable application-shaped PostgreSQL URL was
  configured locally to execute 0076.
- No authenticated Partner output gate, real credit settlement, scanner physical
  capture, Canon TIFF/R2 verification, printer output, Stripe charge, signed
  Scanner package install or owner physical acceptance was executed.
