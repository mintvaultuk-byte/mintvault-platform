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

### H1d — exact hosted failure and clean-checkout parity

The owner-authorized non-force push placed2a532416fc33a1dc0ef05722502a142cacec7f0f
on the existing feature branch and draft PR336. CI33963442054 is terminal FAILURE.
Job101299246896 stopped at architecture drift: the filesystem inventory admitted
local Git-ignored sources missing from a clean checkout. Missing subsequent suite
reports are cascading, not separate product failures.

Changed Git inventory includes tracked and non-ignored new files, retains forced
tracked ignored files, and fails on Git inventory errors. No-Git source archives and
synthetic fixtures retain the existing filesystem path. Existing guards/categories
are unchanged. Metadata-only comparison proves legacy3380->3200, exactly180 removed,
zero added/changed retained records; all40 paths independently confirmed both ignored
and untracked. Their local files remain untouched and prior records remain in Git.
Generated graph8622->8442; no runtime/product/schema edit.

Root Node20.20.2 full architecture suite:27/27 PASS. The regression fixtures compare
a positive real AST provider edge under the old filesystem boundary with its absence
when Git excludes the local file, and preserve tracked/new files. An initial fixture
draft used an inapplicable table declaration and was corrected; those draft failures
are not claimed as product red proof. Actual CI failure and the AST positive control
establish the invariant. Independent Luna recheck passed both new fixtures and
metadata/guard inspection under Node24.14.1, explicitly not pinned-runtime evidence.

Tracked-files-only archive at /private/tmp/mintvault-h1d-clean.QoSfAj (no ignored
sources or Git metadata) was built from current tracked working files. New analyzer
returns8442 records, zero violations; compareSnapshot reports ok:true with no added,
removed, changed or count drift. This independently proves local/clean-source parity.

Image job101299246939 passed native linux/amd64 production build, exact Node20.20.2,
native/ESM imports, dev-tool absence, UID/read-only application checks and SBOM retention.
It failed the existing fixable HIGH/CRITICAL vulnerability gate; all subsequent
readiness/schema/shutdown proof steps were skipped. The Node-package section reports
21HIGH/1CRITICAL; OS findings are also present, not counted here. No vulnerability
ignore, threshold downgrade, security certification or restricted-lane reroute.
Secret scan, dependency review and CodeQL jobs passed but do not override this veto.

Governance33963442029/job101299246537 is terminal FAILURE: TS2339 PDFDocument.destroy
in server/routes.ts:3230 and31 failed/7349 passed/5 skipped assertions across492 files
(12 failed/480 passed). Failures include architecture, known certificate image/UTC/
claim invariants, legacy Admin source/fixture contracts and an ignored operational
script referenced by a test. Existing graph owns these; no broad audit is relaunched.
Narrow read-only workers classify PDF type/runtime contract and Admin fixtures while
root continues H1. Full exact-candidate CI and required hostile/security gates remain open.

Final H1d local controls: scoped ESLint zero errors/warnings; test TypeScript ratchet
passes with the unchanged345 diagnostics; architecture check8442 records PASS;
git diff --check PASS. Governance-only postflight remains fail-closed on existing
managed CLAUDE drift, npm egress, preserved dirty work and branch-wide protected
paths, with Graphify REBUILD_REQUIRED. No acceptance override or full --run claim.

### H1e/H1f/H1g — clean dependency and test-wiring parity

H1d checkpoint `b6fccb07146478a91e10a5932c95c348651e25dc` was non-force pushed.
CI33964372417/job101301729032 now passes architecture and fails the test typecheck
ratchet on exactly one fingerprint: PDFDocument.destroy TS2339. Image vulnerability
gate remains red. The missing downstream reports again follow the early type gate.

H1e: Terra independently reproduced 24 failed / 79 passed assertions in seven Admin
test files. These retained obsolete raw-fetch/page-local auth strings or rendered
pages outside the real AdminSessionProvider. Root changed only those test files:
same endpoints/POST/revision/UUID/step-up/flag/destructive-action assertions remain;
partial request mocks preserve actual session/cache helpers; real provider mounts
inside QueryClientProvider with a deterministic complete synthetic principal.
The new rejection test proves redirect and zero Partner API calls. Root's first
pass left two missed fixture/string cases; both corrected. Root and independent
Terra each pass eight suites / 126 assertions / zero skips under Node20.20.2,
including the existing 22 session-contract cases. Existing React act warnings in
that unchanged session test are retained, not hidden by an assertion downgrade.

H1f: installed @types/pdfkit was 0.17.6 while the lock pinned 0.17.5. The earlier
worker statement that local declarations matched the lock was incorrect and was
corrected before accepting proof. Exact downloaded 0.17.5 extends NodeJS.ReadableStream;
0.17.6 extends the actual Node Readable. Independent virtual compiler fixture
reproduces TS2339 on 0.17.5 and zero diagnostics on 0.17.6. Lock-only repair changes
the version/resolved/integrity of that single package within the existing ^0.17.5
range; no package.json, runtime PDFKit, route or other lock entry changed.
Retained new artifact `/private/tmp/mintvault-pdfkit-types-06-QsNhzV/types-pdfkit-0.17.6.tgz`
has SHA512 exactly equal to the new lock integrity. Old declaration retained at
`/private/tmp/mintvault-pdfkit-types-n1omQV/pdfkit/index.d.ts`.

Clean proof copy: `/private/tmp/mintvault-h1ef-clean.x3NRtE`, only tracked working
files plus `npm ci --ignore-scripts --no-audit --no-fund` under scrubbed Node20.20.2.
Installed 923 packages; engine/deprecation warnings remain, not compatibility or
security clearance. This install deliberately does not prove native install hooks.
Local source history was fetched read-only into the disposable copy because the
historical grading-scope check correctly rejected a history-free archive; no guard
was removed. Exact clean dependencies use Vitest4.1.7 (root had4.1.11).
Application tsc --noEmit PASS; unchanged 345-diagnostic test ratchet PASS;
eight affected/session suites 126/126 PASS; architecture8442/zero violations PASS.
Root/clean copies of seven H1e tests plus lock are byte-equal; aggregate sorted
filename-NUL/content SHA256 `2f2a0b35a5b25278e8d781f2aee718258fbfcd6bc857efdcbb0bf6180e1084b6`.

H1g: the clean copy independently reproduced the operational-script test's ENOENT
for ignored/untracked scripts/_pr75-schema-diff.ts (1 failed / 5 passed). Removing
only that workstation path from the test list yields all six existing assertions
PASS against clean dependencies. No ignored contents read/published, tracked script
coverage removed, transport behavior changed or security investigation reopened.

Scoped H1e lint: zero errors, one pre-existing explicit-any warning in the user UI
fixture; no new warning. Root test ratchet and application typecheck pass. No HIGH
product node or release gate is closed by these fixture/declaration corrections.
Known image/UTC/claim defects, durable object-store/browser, exact candidate CI,
managed workflow and restricted security/hostile evidence remain open.

Independent Terra H1g recheck confirms the exact one-line deletion, ignored/untracked
metadata without reading contents, all remaining assertions/paths intact, and6/6
PASS in the clean copy under pinned Node20. Final governance-only postflight remains
fail-closed on the same managed CLAUDE/npm-egress/dirty/protected-path conditions
and Graphify warning. No acceptance override, no --run or final release claim.

### H1c — durable owned local object-store proof

Baseline a6670fc4456e6b4185d3a735b189ef9f86f667b2; sole shared writer root.
Existing runner gains exclusive --r2-proof mode; direct child uses actual server/r2.ts.
Same exact-ID/run-label lifecycle, explicit Docker context, no mounts, random loopback
port, synthetic credentials only by child/process environment, unique bucket and private
report directory. MinIO pin:
minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e.
No product storage changes or historical PARTNER_REAL_R2_PROOF_* configuration restored.

Parent requires matching run/bucket/endpoint/image and all eleven ordered passing
checks, zero failures/skips; absent/empty/malformed/mismatched reports fail. A sixty-second
proof deadline and bounded TERM/KILL/close wait retain identified services/report directory
when child closure is unknown. Startup has a referenced twenty-second abort deadline.
No automatic cleanup of unowned resources. Enabled root Node20 CI step invokes the
same command with explicit hosted default context. Existing topology mutations reject
removed, disabled, continue-on-error or commented proof steps.

First real invocation returned zero without report and left owned container
c43e419878ec8f7d2e1cef6e34a7345d71c74315a778e2c5c640041a3e5a1b54,
run a293c67a-59f9-42cc-abf0-6c34b74d24c3. NOT accepted as success. Root verified exact
ownership then removed only that container and synthetic volume. Entrypoint now awaits
main at top level and exits with its actual result. Independent Sol then reproduced
unbounded post-SIGKILL closure and a redundant KILL scheduled after synchronous TERM
closure. Root fixed both, added fake-clock assertions, and independently re-proved them.

Actual invocation under scrubbed Node20.20.2 environment (no .env/live credentials):
node scripts/ci/run-disposable-integration.mjs --docker-context colima-mintvault-remediation-20260905 --r2-proof

Real passing runs (all11 passed,0 failed,0 skipped; exact-label post-run inventory empty):
- Root intermediate final-entrypoint run17ebbb45-ecdd-4f5f-a624-45d7083bdc21, port32777.
- Independent Sol final-lifecycle run354b6c61-aabd-432f-9c71-6d214b6eae39, port32778.
- Root clean exact-lock copy runb67b4ee2-c1cb-460d-b08d-6b16acb32e72, port32779.

Named checks: upload-roundtrip, stream-integrity, head-readability, listing, stream,
signed-download, conditional-collision, conditional-race, immutable-replay,
immutable-mismatch, delete-missing. Assertions include actual byte/hash/length equality,
real signed HTTP GET, exact412 collision, one concurrent winner, preserved original
immutable bytes and verified deletion. This proves local S3 adapter behavior, NOT
Cloudflare IAM/retention, staging Stripe, full browser, physical hardware or release.

Root and clean exact-lock copy /private/tmp/mintvault-h1ef-clean.x3NRtE both pass
tests/disposable-integration-runner.test.ts32/32, tests/ci-proof-topology.test.ts13/13,
tests/architecture-authority.test.ts27/27:72/72 total, no skips. Clean copy retains
Vitest4.1.7 from exact lock; root has4.1.11. Test typecheck ratchet unchanged345 PASS
on both after a proper optional-AbortSignal JSDoc repair, not a baseline increase.
Script syntax67 PASS (one new module). Architecture8455 records, zero violations;
exact new child owner added, no legacy/diagnostic/no-check allowance increased.
Scoped ESLint zero errors/warnings. git diff --check PASS.

Shared PostgreSQL lifecycle regression on final runner:
node scripts/ci/run-disposable-integration.mjs --docker-context colima-mintvault-remediation-20260905 tests/partner-rbac-migration.test.ts
Owned runfbfe3da4-d204-42dd-86c5-3e927b67bbf0, PG16/vector32780 and PG17 port32781:
22/22 PASS, zero skips, exact-label post-cleanup inventory empty. Expected missing-role
catalogue warnings are deliberate mutation proof. The full70-suite matrix was not rerun.

Final executable SHA256s:
- scripts/ci/run-disposable-integration.mjs:09b678a6a5b66cbd84bec391be6fa079e7364f6317592a54069016a8a5abd144
- scripts/ci/run-r2-object-store-proof.mjs:8f8a0118e46a3fd4c0be275ff8da6c1ed45469f0c244f57667000e59567389d7
- tests/disposable-integration-runner.test.ts:a16302e41932f8947b58809bb78882965f37fd317a36141b4a53c33afd34a7e9

Independent Sol changed-surface review CLEAN after fixes: no further reproduced
lifecycle/ownership/configuration/non-vacuity/CI-wiring defect; required final hostile
review and hosted exact-candidate evidence remain open. No restricted security reroute.
Structural program validation valid:true, ready:false over101 parent +34 nested nodes.
Governance-only postflight remains red on existing managed CLAUDE drift, npm egress,
preserved dirty tree and branch-wide protected paths; Graphify REBUILD_REQUIRED warning.
No --accept-protected or --run claim. No release/product proof node closed.

Baseline CI33965041567 terminal FAILURE: application job101303561813 passes repaired
architecture/lint/type gates, then Test fails5 assertions /7378 passes /5 skips across
492 files (3 failed /489 passed). Two certificate-update assertions (front-byte audit
hash, two-side500), two UTC credit assertions and one already-claimed ownership assertion
remain for existing repair packets. Image job101303561992 fails the existing fixable
HIGH/CRITICAL vulnerability gate; downstream readiness/migration/shutdown are skipped.
CodeQL, gitleaks and dependency-review jobs pass but cannot waive that veto.
Governance33965041568 and33965039903 also terminal FAILURE on exacta6670fc4. Their
terminal status alone is not a new diagnosis. All exact-candidate release gates stay open.
