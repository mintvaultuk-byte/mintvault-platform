# GB-04E implementation budget

Status: FROZEN.

- Product/test files: target 5; hard maximum 7.
- New production modules: 1.
- Production code delta: target <= 500 added/changed lines.
- Migrations/schema/dependencies: 0.
- Commits before release: target 1 candidate commit plus narrowly scoped repair commits only if a gate proves an in-scope defect.
- Focused tests: Fly adapter, infrastructure/capacity, MCP async contract if affected.
- Required completion: typecheck, focused tests, full tests, build, engineering governance, security scans, independent hostile review, exact-SHA remote CI, then guarded production activation/live proof.
- Stop condition: zero actionable in-scope BLOCKER/HIGH; any remaining provider gaps must be owner-action boundaries with truthful live UI state.

## Reconciliation before candidate freeze

- Product/test files: 6; within hard maximum 7.
- New production modules: 1.
- Production additions/changes: approximately 588 added lines across the complete adapter and two narrow integrations. This exceeds the 500-line target (not hard maximum) by approximately 88 lines because response validation, per-machine sanitization, missing-sample handling, stale exclusion and deterministic fixture proof were retained rather than compressed away.
- Migrations/schema/dependencies: 0.
- Local focused/full/typecheck/build/lint gates: green; exact-SHA hostile/remote/security gates pending candidate commit.
