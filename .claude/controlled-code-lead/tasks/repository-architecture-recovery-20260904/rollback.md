# Phase 2 and Admin identity/session rollback and recovery contract

**Rollback baseline:** `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`  
**Owner-directed WIP checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`

**Boundary authority:** `phase-2-file-manifest.md`  
**External-state reversal:** none; Phase 2 did not deploy, migrate, publish, call a paid
provider, mutate durable objects, package, sign, notarize, or distribute an artifact. The
nested Scanner development manifest/lockfile changed locally only.

## Preconditions

1. Verify the repository path, branch, committed baseline, and every digest in the Phase
   2 manifest.
2. Compare the current dirty tree to `baseline-dirty-state.md`. The five pre-existing
   White Ace tests, `.gitleaksignore`, and unrelated task artifacts are excluded from
   rollback and must remain byte-for-byte untouched.
3. Stop if a listed Phase 2 path has changed since the manifest was produced; the packet
   is then invalid and must be regenerated before reversal.

## Exact inverse

For only the post-checkpoint hostile-review corrections, reverse the reviewed hunks in
these six paths to checkpoint `2913bcb1092ea8f43ee1294b711a8df653a06a3d`:
`scripts/architecture/check-architecture.mjs`,
`scripts/architecture/generated/architecture-authority.json`,
`scripts/architecture/legacy-authority.json`,
`scripts/ci/verify-ci-topology.mjs`, `tests/architecture-authority.test.ts`, and
`tests/ci-proof-topology.test.ts`. The exact reviewed code-diff SHA-256 is
`62b222ac5dcab62050d2a782df9d7176e5e3029e609f9eefed094229bb22daa1`.
Do not reverse the checkpoint's other files as part of that narrow correction rollback.

For only the Scanner test-isolation repair, reverse the `happy-dom` development edge and
its lockfile closure in `scripts/scanner-app/package.json` and
`scripts/scanner-app/package-lock.json` to checkpoint `2913bcb1092ea8f43ee1294b711a8df653a06a3d`.
Do not remove or rewrite the whole nested package tree; reinstall from the restored lock
only if a later authorised proof needs materialized dependencies.

For a full Phase 2 rollback to the original baseline:

1. Reverse only the Phase 2 hunks in the tracked files that existed at the committed
   baseline: `.github/workflows/ci.yml`, `CLAUDE.md`, `package.json`,
   `scripts/ci/partner-suite-env-matrix.mjs`, `scripts/ci/partner-suite-verdict.mjs`,
   `scripts/ci/run-partner-suite.mjs`, `scripts/scanner-app/package.json`,
   `scripts/scanner-app/package-lock.json`, and `server/readiness.ts`.
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

## Admin identity/session wave

The Admin wave begins from owner checkpoint
`2913bcb1092ea8f43ee1294b711a8df653a06a3d` plus the preserved pre-wave dirty-diff
SHA-256 `e612faf38358956b1a0b485d365f545293359cbd440c9c631a28a7d7cc613633`.
Its current byte boundary is `admin-session-file-manifest.md`; its behavioral boundary
and compatibility contract are `admin-session-change-manifest.md` and
`admin-session-recovery.md`. It did not deploy, migrate, publish, call a provider, alter
cookies or schema, add a dependency, or mutate external state.

To reverse only this wave, first verify every current digest in the Admin file manifest.
Then reverse only the Admin identity/session hunks described by its grouped inverse:

1. Remove the new central provider module and focused Admin session contract test, and
   unwrap only the provider integration added to `client/src/App.tsx`.
2. Restore AdminShell and its consumers to their pre-wave logout/session call shapes,
   including the three development harnesses, without changing unrelated component or
   route behavior.
3. Reverse only the route-aware fetch, typed 401, principal cache classification/hash,
   cancellation/reset/purge, public-certificate, and shared-staff callsite hunks.
4. Reverse only the server credential-rejection code and Admin session cache-header
   hunks. Do not change cookie/session schema, lifetime, role, allowlist, or persistence.
5. Reverse only the Admin cache-authority policy/extractor/snapshot/legacy-ledger and
   focused proof changes. Preserve all earlier Phase 2 authority and CI corrections.
6. Reconcile the issue/proof/task/reviewer records to `ROLLED_BACK`; retain the recovery
   packet and manifests as historical evidence rather than deleting them.

Stop if any current digest differs, if an Admin hunk cannot be separated from preserved
Phase 2 or owner WIP, or if the owner-authorized failed-logout semantics have changed.
Do not use a broad reset or whole-file restore. Forward recovery remains retry-only:
restore connectivity, retry identity verification, or retry POST logout.

## Admin print/reprint wave

The print wave begins from owner checkpoint
`2913bcb1092ea8f43ee1294b711a8df653a06a3d`, tracked dirty-diff SHA-256
`12dda2cf31173444a33347dcf5a763788084e530381e11dfe042e5c2ee45c04c`, and untracked
aggregate `6a4c86f18e3e23551d6ba6c65b728349ccd7de9b84de74cf4db11972d4d869e2`.
Its behavioral boundary is `admin-print-change-manifest.md`; its exact byte boundary is
`admin-print-file-manifest.md`; recovery authority is `admin-print-recovery.md`.

To reverse only this wave, verify every current print manifest digest, then apply one reviewed
inverse patch that:

1. Removes the new direct-command client coordinator and restores only the three print pages'
   pre-wave call shapes. If the old Browser shortcut is unsafe, hide it; do not restore the
   removed blob route.
2. Reverses only the workflow receipt/idempotency, canonical eligibility, verified compliance,
   committed-replay, artifact-membership, and typed-error hunks in the print services/routes.
3. Removes the required print component and only its registry/policy/snapshot/legacy-ledger
   ownership changes. Do not roll back unrelated Phase 2 or Admin identity/session authority.
4. Reverses only the print schema/default/PK/sequence/runtime-ACL readiness predicate additions.
   No migration object or durable history may be dropped or rewritten.
5. Removes only the focused print proof additions and restores the exact test/architecture
   inventory fingerprints. Preserve unrelated tests and diagnostic debt reductions.
6. Reconcile graph/register/task/reviewer/proof records to `ROLLED_BACK`, retaining the recovery
   packet and manifests as historical evidence.

Stop if a digest differs, a shared-file hunk cannot be separated, an object-write operation is
nonterminal, or the current print/evidence contract has changed. Never delete an artifact,
receipt, event, audit row, batch, cache row, or migration. For a safe degraded rollback, disable
only the affected mutation/download while retaining queue reads and durable history.

## Recovery verification

- Re-run `git diff --check` and confirm every excluded WIP digest still matches the
  pre-rollback capture.
- Confirm the Phase 2 package scripts and CI steps are absent together; a half-removed
  workflow must not be accepted.
- Run the baseline root typecheck and the pre-existing focused White Ace tests that are
  executable in the local environment.
- For an Admin-wave reversal, rerun the focused Admin session, step-up, architecture,
  client runtime, and mocked server-auth tests and confirm the pre-wave dirty-diff digest
  is restored apart from explicitly retained governance history.
- For a print-wave reversal, rerun the print UI/service/route/readiness/runtime-role/full-HTTP
  matrix and prove the removed Browser endpoint remains absent; never accept a fallback that
  serves bytes without authoritative immutable batch membership.
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
