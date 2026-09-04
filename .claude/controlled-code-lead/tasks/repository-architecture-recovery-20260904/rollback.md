# Phase 2 rollback and recovery contract

**Rollback baseline:** `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`  
**Boundary authority:** `phase-2-file-manifest.md`  
**External-state reversal:** none; Phase 2 did not deploy, migrate, publish, call a paid
provider, mutate durable objects, or alter dependency/lockfile state.

## Preconditions

1. Verify the repository path, branch, committed baseline, and every digest in the Phase
   2 manifest.
2. Compare the current dirty tree to `baseline-dirty-state.md`. The five pre-existing
   White Ace tests, `.gitleaksignore`, and unrelated task artifacts are excluded from
   rollback and must remain byte-for-byte untouched.
3. Stop if a listed Phase 2 path has changed since the manifest was produced; the packet
   is then invalid and must be regenerated before reversal.

## Exact inverse

1. Reverse only the Phase 2 hunks in the tracked files that existed at the committed
   baseline: `.github/workflows/ci.yml`, `CLAUDE.md`, `package.json`,
   `scripts/ci/partner-suite-env-matrix.mjs`, `scripts/ci/partner-suite-verdict.mjs`,
   `scripts/ci/run-partner-suite.mjs`, and `server/readiness.ts`.
2. Remove only the newly added implementation/proof paths enumerated as `new` in the
   Phase 2 manifest: `config/components/`, `docs/engineering/ARCHITECTURE_AUTHORITY.md`,
   `scripts/architecture/`, the named new `scripts/ci` controls/baselines, the three
   Phase 2 `tsconfig` files, `server/lib/component-readiness-registry.ts`, and the two
   Phase 2 authority tests.
3. Reverse only the Phase 2 append/reconciliation hunks in the overlapping governance
   files `.claude/controlled-code-lead/INDEX.md`, `engineering/ISSUE_REGISTER.md`, and
   `engineering/PROOF_LEDGER.md`. Do not restore those files wholesale because they
   contained pre-existing White Ace WIP.
4. Retain the architecture-recovery intake/assessment/graph records, but mark Phase 2
   implementation and proof as rolled back and remove claims that its gates are active.

No recursive reset, broad checkout, or directory deletion is an authorised rollback
mechanism. The reverse patch must be reviewed against the manifest so unrelated dirty
work cannot be erased.

## Recovery verification

- Re-run `git diff --check` and confirm every excluded WIP digest still matches the
  pre-rollback capture.
- Confirm the Phase 2 package scripts and CI steps are absent together; a half-removed
  workflow must not be accepted.
- Run the baseline root typecheck and the pre-existing focused White Ace tests that are
  executable in the local environment.
- Re-run `engineering preflight`; record postflight truth without an acceptance override.

## Evidence invalidation

Any change to a manifest path/digest, component manifest/index, readiness projection,
architecture generator/policy/snapshot/legacy ledger, workflow, CI runner or baseline,
test inventory, TypeScript config/compiler version, migration inventory/lineage,
package manifest/lockfile, or source topology invalidates the relevant Phase 2 evidence.
Hosted evidence is additionally invalidated by a different commit SHA, runtime version,
service topology, skip/floor result, or Scanner package dependency graph.

Later repairs that alter principal/cache, schema, object/provider, route precedence, or
durable lifecycle state require their own forward-recovery packet. This Phase 2 packet
does not grant authority to reverse external state or delete product data.
