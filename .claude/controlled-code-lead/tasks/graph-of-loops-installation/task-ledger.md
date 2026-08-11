# Task Ledger — Graph of Loops controller installation

## Stage 0 — Baseline

- Starting SHA: `3092d02b5a7df89610e073e7d70734a412a24ae8`
- Branch: `psp/partner-rbac-hybrid`
- Worktree: clean before this task.
- Scope: local governance installation only; no protected runtime systems.
- Owner authority: attached owner instruction authorises the installation and
  local commit. Push, deployment, migration, and all external mutation remain
  prohibited.

## Stage 4 — Implementation authorisation

The attached owner instruction specifies the canonical file, required root
entry-point references, governance test, local commit, and no push. The
change manifest in this directory is the authoritative edit scope.

## Stage 6 — Verification

- Governance self-test: PASS — 4 suites passed, 0 failed.
- Shell syntax check for the controller-integrity test: PASS.
- Mutation proof: in an isolated temporary root, removing the Graph-controller
  reference from AGENTS.md made the integrity test exit 1 with the expected
  missing-entry-point failure.
- TypeScript check: PASS.
- Diff whitespace check: PASS.

## Stage 7 — Result

The canonical controller and both root load paths are installed. No runtime
application, database, migration, grading, authentication, payment,
environment, dependency, or deployment surface changed.
