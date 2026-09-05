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

## Continuous H1 continuation — 2026-09-05 daytime

Starting HEAD `1ae1a7c5e54f4220a8bd1a0fd3a30166a6e2b561`; unrelated untracked
`docs/planning/vault-worlds/` preserved. Owner rejected the half-hour cadence:
the heartbeat is PAUSED and the continuous Goal is active. No new release authority.

Preflight remains CRITICAL/HOSTILE; existing graph validates 101+34 nodes and
correctly remains not ready. Graphify navigation used before source verification.
H1b exact manifest added; isolated Terra writer `/root/h1b_runner` owns only its
two specified new test-runner files at `/private/tmp/mintvault-h1b-worktree.dIGqBw`,
branch `codex/h1b-disposable-ci-20260905`. Root remains sole shared-checkout writer.

Dedicated Colima profile restarted, prior global Docker context `colima` restored.
Primary CI's digest-pinned PostgreSQL16/vector and PostgreSQL17 images fetched
successfully into that profile. No pre-existing service/database was adopted.

Scrubbed Node20.20.2 checks on starting HEAD:

- `vitest run tests/dockerignore-build-context.test.ts tests/production-dependency-boundary.test.ts`:
  2 files / 11 assertions PASS, including the existing build-context privacy boundary.
- `vitest run tests/partner-card-image-object-write.integration.test.ts` with
  `POSTGRES17_BIN=/opt/homebrew/opt/postgresql@17/bin`, `LC_ALL=C`, `LANG=C`:
  1 file / 3 assertions PASS. Real owned PostgreSQL17.10, existing migration runner,
  **memory** object store. This does not prove real S3/R2 or close image repair nodes.

Actual local production Dockerfile build started with GIT_SHA=1ae1a7c5... after
context checks, no push/deployment. Native host architecture is ARM64; it cannot
discharge hosted native AMD64 or exact-candidate CI evidence.

Actual image result: PASS on Linux ARM64. Image tag `mintvault-h1a-proof:1ae1a7c5`,
local manifest `sha256:b5fdf51f939b9364fa71d7666cb861bc9fe8b427067ed4279767e9a875f71f18`.
The unmodified Dockerfile completed real npm ci, native compilation, application
build and production prune. Network-disabled runtime proof returned Node20.20.2,
PNG sniff/decode success, canvas 188 bytes, PDFKit 1256 bytes, all five development
tools absent, UID1000. `/app` is not writable and `/tmp` is writable. This extends
H1a beyond the earlier ignore-scripts diagnostic; hosted AMD64 remains open.
The install emitted existing engine warnings and an aggregate npm advisory count;
this is not a clean dependency-security certification or authority to bypass the
platform-restricted security lane.

Independent `/root/h1_storage_contract` (Luna medium) repeated network-disabled
image checks: Node20.20.2, UID/GID1000, non-writable app, sharp actual 2x2 PNG
generation/decode, canvas PNG render, valid PDF header/1225 bytes and five dev tools
absent. PASS for local ARM64 only; application startup remains unproven.

### H1b actual PostgreSQL and HTTP proof

Root integrated the Terra two-file packet, rejected/corrected missing context,
initialization, success-exit and failure/cancellation handling, then wired the
exact new module/test inventories and one owned architecture timer. No existing
test was skipped, diagnostic allowance increased or legacy ownership exemption added.

- Initial owned PG16/vector + PG17 run: `partner-rbac-migration.test.ts`, 22/22.
- Full run: `node scripts/ci/run-disposable-integration.mjs --docker-context
  colima-mintvault-remediation-20260905 --prepare --all --json
  /private/tmp/mintvault-h1b-reports.R2SWni`. Real PG16.15/vector and PG17.10,
  existing shared-schema preparation and all 16 VQ SQL files succeeded. 70 suites,
  1328 passed assertions, 0 failed, 0 skipped, all suite floors satisfied. Includes
  real Partner HTTP and migration/role/transaction suites, not browser evidence.
- Retained 70 JSON files aggregate filename/content SHA-256:
  `1f0b632e4d72378818eb40cd64063b1dd90ce504a3b123a9ed3c78bfded603fc`.
  Run `9956b48b-db0c-470e-ac03-1df65068f346`; post-run container query empty.
- Independent `/root/h1b_lifecycle_proof` (Sol high) reproduced two runner defects:
  arbitrary preparation keys could override process configuration; EPERM while
  signalling a child could tear down databases before child closure. Both repaired.
  The latter now exits nonzero and explicitly retains identified services when
  termination cannot be confirmed, rather than destroying a possibly active DB.
- Final independent recheck CLEAN: 13/13 lifecycle assertions; 15/15 existing
  Partner fail-closed runner tests; 70-suite/59-key topology probe, no mismatches.
  Final runner SHA-256 `d864d3cba2aca610365425920c64aede7e30f14bc3c97c255b288ddca93a4153`;
  test SHA-256 `b8ea07ca6ef9c5f22687019f4b96eea09b73ce9cb5b12dfb515f24b25b1e4686`.
- The full 70-suite run predates those two final failure-path corrections; it is
  retained historical evidence, not exact-final-runner certification. Root reran
  final `--prepare tests/partner-rbac-migration.test.ts`: preparation and 22/22
  pass, run `129dc542-ec8d-486d-9a09-7eaa87970750`. Exact-candidate full CI remains open.
- Existing supply-order suite separately passed 5/5 on owned native PG17.10 with
  deterministic Stripe boundary double. This is not a Stripe TEST provider proof.
- Node20 test typecheck ratchet passes with unchanged 345-diagnostic allowance;
  500 tracked tests, no added ts-nocheck. Script syntax inventory: 66 modules.
  Architecture: 8622 records; new cancellation timer explicitly test-owned.
  Scoped ESLint: 0 errors/warnings. No product source or migrations changed.

### H1c local real object-store diagnostic

Retained script: `/private/tmp/mintvault-r2-proof.hGKPpd/proof.mts`, run under
scrubbed Node20 + existing tsx loader. Pinned MinIO image is in H1c manifest.
First launcher exited13 after clearing its loader environment; its sole owned
container `790dbefd571f153b6537e7d2fd7360429fffa6f2b11edaa918c51a77c4420526`
was explicitly ownership-verified and removed with synthetic data. No live object
was touched. Keeping the env-i launch and preserving loader-added variables fixed
the fixture. This was a test-launcher failure, not an application defect.

Successful run `4640b784-664b-4135-b0c7-34974d4be7cd` used loopback port32773,
generated synthetic credentials and a unique bucket. Existing server/r2.ts passed
upload/read, actual stream SHA256/length, HEAD/readability, list, streaming,
signed HTTP GET, create-only collision/no overwrite, immutable identical replay,
mismatch refusal, delete/missing checks. Exact owned container cleanup completed.
This proves local S3-compatible behavior, not Cloudflare R2, signed Stripe,
staging, physical hardware or browser. No product or scanner redesign.
Durable checked-in object-store orchestration remains next H1 work.

Postflight remains fail-closed (governance-only): existing managed CLAUDE drift,
npm package-egress check, dirty checkout and branch-wide protected paths; Graphify
REBUILD_REQUIRED. No override, no full postflight --run claim, no deployment.
