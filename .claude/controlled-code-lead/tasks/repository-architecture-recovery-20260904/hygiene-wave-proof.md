# Hygiene launch / first repair wave evidence

Baseline: `80a20611ff5e8928fd6380961ca6bd420abe4727`; local WIP, not a release candidate.
No push, deployment, shared migration, existing worktree deletion or live configuration change.

## Dispatch and independent model use

All nine required lanes were actually assigned and their reports retained, including
HY-SECURITY's platform failure as UNKNOWN. `validate-hygiene-dispatch.py --dispatched
--self-test` passed at baseline with 13 tests; `validate-program.py` validates 101+34
nodes, ready=false. This is the initial dispatch receipt. After a checkpoint commit the
historical --dispatched baseline deliberately differs from HEAD: do not rewrite old proof
to that SHA or restart all nine investigations. Refresh invalidated evidence per manifest;
final repair/CI/release proof must still bind the actual candidate.

Luna handled Git/docs/contracts/structure/scanner inventories; Terra handled CI/DB/runtime.
Sol's security lane was platform-restricted and was not retried elsewhere. Astra/Lead
adjudicated findings, rejected unsupported closure/deletion claims and is sole writer.

## H1a local functional repair

- Baseline clean pinned Node20.20.2/npm10.8.2 Linux omit-dev install resolved tsx.
  npm explain: tailwindcss-animate -> Tailwind -> postcss-load-config -> optional tsx.
- Focused classification regression: before 2 FAIL / 1 PASS; after 3 PASS.
- Package version unchanged. Pinned-npm regeneration classified the closure development-
  only. Unrelated npm10 serialization/platform churn was rejected: original libc/private
  metadata and package-path inventory retained. No package versions/resolved URLs/integrity
  hashes changed. No blanket optional-dependency omission or deletion workaround.
- Candidate clean Linux omit-dev install: 618 packages; tsx/vitest/typescript/eslint/prettier
  absent, canvas/sharp resolve. Baseline installed 692. Diagnostic installs used
  --ignore-scripts: resolution is not proof that native binaries execute.
- Local existing build under scrubbed Node20 passes client (3,357 modules), server and
  existing one-off script bundles. It did not execute those scripts or deploy an image.
  Existing PostCSS warning remains; no clean-warning claim.
- `/root/h1_dependency_proof`, Terra medium, independently checked actual consumer,
  1,091 unchanged lock package paths, all version/resolved/integrity/libc data, exactly
  dependency classification changes and 3/3 regression. Dockerfile/CI are unchanged.
  Result PASS for this narrow WIP packet, not full image/CI/security/release certification.

H1 remains IN_PROGRESS: complete native image/readiness, unified disposable services,
managed workflow reconciliation, required security evidence and exact-SHA hosted CI are
not discharged by this repair. Existing Node20 engine warnings (file-type22 and tooling)
remain a compatibility item, not an invented reproduced runtime HIGH.

## H2a documentation

engineering/INDEX.md links existing plan/graph/authority/issue/proof records. Misleading
all-routes/all-IStorage and db:push-history prescriptions were corrected; stale nested
dependency approval was removed from current task index. No history, migration, generated
snapshot or scanner file was moved/deleted. Local link check and managed-block byte
comparison against HEAD pass. H2a is not full folder/worktree consolidation.
Independent `/root/h2_docs_proof` (Luna medium) returned PASS for scoped relative links,
existing-authority references, Golden Rules/managed-block byte preservation, bounded-
context wording and approval/exclusion reconciliation; no runtime certification.

## Other bounded checks and substrate

- Frozen MVGS: all ten protected hashes pass.
- Initial three focused suites: 25/25 pass on Node20. New classification suite: 3/3.
- Final combined Node20 rerun: four files / 28 assertions PASS.
- Architecture: 8,621 records pass after dependency/docs edits.
- New test ESLint: zero warnings/errors. git diff --check passes.
- Native PG17.10: actual startup/connect/query/stop/owned-dir-cleanup passed with LC_ALL=C.
- Dedicated Colima profile mintvault-remediation-20260905 created and running, separate
  from the previously stopped default. Prior Docker context restored; commands use exact
  dedicated context. Dependency-proof containers self-removed. No external DB/object store.
- Full broad suite, native AMD64 hosted image, current browser and final hostile review
  remain unproven. Physical V850/printer/NFC/clean-Mac proof remains external.

Engineering postflight (governance-only, commands=[]): FAIL on pre-existing managed
CLAUDE section drift, npm package-egress check, current dirty WIP and branch-wide protected
paths; Graphify reports REBUILD_REQUIRED. No acceptance override used. Scoped managed-
block preservation does not imply the original managed block matches the installed tool.
Full --run is not claimed: the broad suite's owned-service topology is still incomplete.

## Recovery / next boundary

Revert only the exact package/test/doc packet if its proof is invalidated; no data rollback.
Preserve the new local VM for approved service work, or stop that exact profile when the
session ends. Existing default VM, user worktrees, ignored data and credentials are untouched.
Security access restriction must be resolved through the platform before dependent review;
do not circumvent it with another model/provider or claim a clean security result.
