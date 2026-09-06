# Engineering proof ledger

## 2026-09-06 authorised production-image dependency correction

Owner approved dependency/runtime-npm extension at baseline16052f1b. Exact scope
and rollback are in change-manifest.md. Independent Terra reviewed final lock and
PDF assertions: ACCEPT/no gate weakening (source review, not independent execution).
Production npm11.19.1 supports pinned Node20.20.2 and preserves existing npm-ls CI;
latest npm12 was rejected because its Node floor is incompatible. Local exact npm
version command returned11.19.1 using a fresh task cache after existing user cache
EACCES; no existing cache was deleted or force-overwritten.

Application runtime observed in the isolated clean-lock workspace:
Node20.20.2, sharp0.35.4, libvips8.18.6, express-rate-limit's ip-address10.3.1.
Lock SHA2567ac3346473f61c40cf9d718cb40710414a0048d50083d3772f0effb28882eba0
matches root and clean workspace. Source: official sharp0.35.4 changelog and
[upstream advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj),
plus `npm view npm@11 version engines dependencies.tar dependencies.pacote --json`.

Pinned Node20 / clean-lock Vitest4.1.7 command:
`node node_modules/vitest/vitest.mjs run tests/dockerignore-build-context.test.ts tests/label-font-integrity.test.ts tests/certificate-label-snapshot-authority.test.ts tests/print-artifact-capacity.test.ts tests/printable-grade-safety.test.ts tests/image-evidence.test.ts tests/lide400-profile.test.ts`
PASS107, existing Linux/x64-only golden tests skipped2 on macOS (not new skips).
New real PDF cases exercise numeric/auth labels front/back/both: PDF header/EOF,
one page, historical physical boxes and embedded images. First new assertions
failed because 72/25.4 differed from established2.83465 conversion; corrected
fixtures to exact historical points, no renderer or golden change.

Clean production build PASS3366 modules; this is WIP source with baseline GIT_SHA
supplied, not an exact-candidate image. Initial tsc found four TS2503 diagnostics
after sharp's export-type change; three files now use explicit type imports.
Type-erased CommonJS/ES2022 output is byte-identical before/after in all three:
image-processing6adf9bef611aef9f036a9791504a8552d904cfdc11f8d3ae50a1b72fe62c62a3;
image-evidence d85633777723f16d76e4b2bd2d0e6bd2957c86ed444b6d6839d94e7a8e888b1f;
VQ image-integrity ad397cfeab7e67b87dc71dafc5b540ad93d784e8ffd3adacc46ba5d75871903c.
Final main tsc PASS; scoped ESLint0 errors/5 pre-existing any warnings. After the
type imports, image-evidence3/LiDE8/VQ image-integrity27/label52 re-run:88 PASS,
two existing platform skips. Typecheck debt ratchet and exact-SHA hosted image
proof pending; no runtime source behavior changed by the type repair.

Postflight remains red for existing managed-CLAUDE/package-egress/dirty/protected
branch acceptance; no accept-protected bypass or restricted whole-suite execution.
Local amd64 image/Trivy proof still not run: host available1.5GiB. Hosted native
image must supply separate build/scan/readiness proof; no local Total0 is claimed.
No deploy/Fly/shared migration/secrets/MVGS edit or merge. Parked J2 untouched.

## 2026-09-06 owner-directed Docker OS vulnerability WIP

Hosted result for pushed `a60605f1b2e859e2fe9457278483d9674ac94ada`:
[CI run 34024809130, image job 101463817570](https://github.com/mintvaultuk-byte/mintvault-platform/actions/runs/34024809130/job/101463817570).
Checkout was GitHub's PR merge `547b36b0b9d9d758a7c19dbd4e886ed9051a8f3e`
(feature a60605f1 into main 01d5e4da); not a feature-only local image proof.
Both apt upgrade commands executed and native production image build succeeded.
Exact log retrieval: `gh api repos/mintvaultuk-byte/mintvault-platform/actions/jobs/101463817570/logs`.
Trivy0.70.0 output: `mv-amd64-proof:ci (debian 12.15) | debian | 0`;
`Node.js (node-pkg)` / `Total: 22 (HIGH: 21, CRITICAL: 1)`; step exit1.
Root cause in one sentence: the apt upgrade clears the reported Debian findings,
but the image gate still fails on 22 fixable Node-package findings outside that
OS-only correction, including two application dependencies and bundled npm.
Application paths: ip-address10.2.0 (fixed10.3.1), sharp0.34.5 (fixed0.35.0).
Bundled npm paths: brace-expansion3 findings, cross-spawn1, glob1, ip-address1,
minimatch3, pacote1, sigstore1 and tar9; these account for the other20 findings.
No dependency change, npm removal/update, ignore or scan weakening was made.
The vulnerability step is NOT green; subsequent readiness probes were skipped.
Further dependency/runtime-tool changes require scope adjudication beyond the
owner's explicit two-line apt/digest correction. Local capacity remains blocked
as below. Unfinished J2 and restricted claim work remain untouched.

Baseline391ab5211d03a75b0bf05e7bff6489fda0a131a1; REM-SUPPLY-001 stays OPEN for
this exact-image proof. Independent Terra confirms exactly two apt-line changes:
upgrade base packages before installing the unchanged lists, unchanged cleanup,
Node20.20.2 and digest. Dockerfile SHA256:
19f3a2e8385621749987b5c99cadc026f3c2726474137ead277c963c5847699a.
Old/new digest and exact scope are in the existing change-manifest.md current
Docker section. No workflow/Trivy severity/ignore changes. Unfinished J2 remains
uncommitted and excluded from this scoped WIP commit/image context.

Clean-lock pinned Node20 supporting tests (not rebuilt-image proof):
`node node_modules/vitest/vitest.mjs run tests/dockerignore-build-context.test.ts tests/label-font-integrity.test.ts tests/certificate-label-snapshot-authority.test.ts tests/print-artifact-capacity.test.ts`
Output: four files/46 tests PASS, zero skips (Docker9/fonts11/label19/capacity7).

Local linux/amd64 build/Trivy/native-runtime proof BLOCKED before image build by
host storage. Read-only `df -h /private/tmp` output: host1.6GiB available (100%
rounded capacity). Dedicated Docker `system df`: images10.62GB/build cache5.303GB;
retained schema image2.72GB and production1.27GB. VM `df -h /var/lib/docker` shows
8.6G virtual free, but that sparse disk is backed by the nearly-full host volume.
No safe space for an additional amd64 builder/runtime plus Trivy DB was established.
No build or scan was launched and NO `Total: 0` result is claimed. No cache/image/
worktree/data deletion. Dedicated VM was restarted for read-only capacity checks
then gracefully stopped; all data retained, no running containers/volumes created.

Required deferred local commands (NOT executed):
`docker --context colima-mintvault-remediation-20260905 build --platform linux/amd64 --target production --build-arg GIT_SHA=<exact-candidate> -t mintvault-osfix:<exact-candidate> <isolated-exact-source-context>`
`trivy image --scanners vuln --vuln-type os,library --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format table --timeout 10m mintvault-osfix:<exact-candidate>`
Required Trivy version0.70.0 matches pinned hosted action. Exact hosted build/scan
is next via owner-authorised WIP push; local and hosted claims stay distinct.
Owner excluded migration application: no local positive readiness schema prepared.
No redeploy/Fly, shared migration, secret/MVGS change or main merge.

The separately requested claim-ownership investigation/full-suite/stress proof
remains platform-restricted/UNKNOWN. It was not inspected, run or rerouted through
another model/tool. No product correctness or test-isolation root cause is claimed.

## 2026-09-06 unused job registry foundation

[Existing phased plan J1](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/phased-repair-plan.md)
binds607c3518 plus exact hashes. Terra29/29 and held-out actual lifecycle checks;
clean-lock92/92, build, main tsc, scoped lint pass. Shutdown-during-install RED28/29
fixed before activation. Tests344/architecture3 type diagnostics unchanged; only
new file inventory count/hash updated. No app caller, DB/provider/migration/action.
Graph104 valid/not ready; broad recovery and candidate/Opus/restricted gates OPEN.

## 2026-09-06 VQ durable-only export checkpoint

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
binds49c10d2e plus exact source hashes: memory/TTL/file fallback removed, real
durable unavailable503 before render/upload, existing durable/R2 semantics kept.
Independent Terra22 facade and10 actualPG17 router/ops; clean-lock82+10, build,
lint and unchanged344 type debt pass. Real HTTP uses existing auth stub and mocked
R2, not auth/provider proof. Initial UUID/text fixture failure corrected; optional
native db:push/vector failure excluded. No migration/provider/deploy action.
Schema implementation FIXED_WIP; candidate/CI/restricted/finalOpus remain OPEN.

## 2026-09-06 VQ required runtime observation

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
binds e77ede827d68a824db105943c4490fdf185684fa plus exact source hashes. Required
VQ observation uses runtime authority only; fresh/historical lineage, catalog and
ACL drift fail closed. Two independently identified grant-delegation false greens
reproduced and repaired. Root52/clean79; independent Sol12+2 targeted. The PG16-labelled
Vitest run actually used17 due helper fallback and is not16 evidence. Corrective
explicit16.13 launch verified server_version_num160013: both low-privilege lineages,
six delegation/checksum mutation refusals and recovery pass. No suite-count claim.
Clean architecture/CI/Docker60 and build3366 pass. Unit
observer is mocked only for orchestration; real PG proves unmocked VQ chain and
global composition with main SQL alone stubbed. Type debt344, no baseline waiver.
Terra3 focused+2 held-out import cases pass. Main SQL and legacy ownership unchanged.
Graph valid101/not ready; postflight/hosted/restricted/Opus and fallback vetoes OPEN.

## 2026-09-06 VQ unused runtime-evidence foundation

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
binds pushed53e5088a plus two exact source hashes. Root52/clean52 and independent
Sol28 held-out attacks/17 exact source hashes pass. Frozen expectations do not
claim execution; pure predicate admits only full fresh or exact attested history
with explicit catalog/authority evidence. No runtime wiring/role/SQL change.
Tests typecheck345 debt unchanged/lint0; clean architecture/CI/Docker58/58 pass
after freeing verified-idle VM RAM, resolving the old timeout without weakening
its30s limit. Clean production build3366 PASS. All whole-release/restricted/Opus/hosted vetoes retained.

## 2026-09-06 VQ production-image shipping continuation

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
binds a0e25b16 WIP source/image hashes. Root actual isolated PG/image proof applies
main86/VQ17 and replay0, exact checksums/full unchanged journal/zero history receipts.
Independent Terra actual repeat passes on separately owned isolated PG17; offline
image inventory and context/topology proof independent. Reproduced missing guarded schema-tool inputs and one Drizzle
timezone mismatch with immutable0118 fixed without SQL/behavior/shared DB changes.
Clean-lock50/50, rootNFC22, typecheck/build pass. Architecture29/30 with unchanged
30s wrapper timeout is a failed aggregate, not green. Arm64 WIP images are not an
exact release candidate or amd64 proof. Runtime admission/fallback/Opus/HY-SECURITY
and terminal-failed hosted CI remain OPEN. Owned synthetic databases cleaned only.

## 2026-09-06 VQ namespaced readiness foundation

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
binds ecdac325 + final source hashes. Root30/independentSol30/clean-lock47 tests
PASS, zero skips; build3366/typecheck/scoped lint PASS, existing debt unchanged.
Closed main/VQ identities preserve main-only readiness and lineage; unshipped VQ
cannot borrow a main migration's identity. Foundation only: no VQ runtime admission,
schema/image activation or candidate closure. Next image wave includes independently
reproduced missing Docker context module admission; security/Opus/CI vetoes retained.

## 2026-09-06 VQ honest historical recovery

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
binds baseline97a88450 plus exact final hashes: independentSol64/64 and held-out
DDL/state races, subsequent CI-helper preflight Terra15/15; clean-lock168/168 and
production build PASS. Owned PG16.13/17.10 prove fresh17 executed vs historical
one executed/16 attested, no fabricated old rows, exact grants and preserved data.
All reproduced changed-surface recovery defects fixed in the same wave. Historical
admission quiesces writers; actual rollout also requires exclusive operator DDL.
No live/shared DB, deployment, seed-content or real future-export migration claim.
Shipping/readiness/fallback/final Opus and hosted CI remain OPEN; latest hosted
97a88450 checks failed and restricted causes remain UNKNOWN.

## 2026-09-06 VQ metadata compatibility

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
records the reproduced immutable0121/public VQ journal conflict and closed existing
drizzle namespace correction from5e8140bb. Actual0121 after16VQ SQL preserves rows
and fingerprint; public journal/receipt/sequence residue refuses without writes.
Root97, independentSol30, final clean-lock127/127, zero skips, build/type/lint/architecture pass.
Independent lock-interleaving exposed a scoped stale-preflight defect, reproduced
and fixed in the same wave; final held-out proof refuses without SQL/journal effects.
One exact legacy-query identity transfer, no wider registry or diagnostic waiver.
Historical adoption, metadata grants, image/readiness and final hostile/CI remain OPEN.

## 2026-09-06 VQ catalog foundation

[Existing VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
pins a pure current-relation/owned-sequence structural fingerprint to unchanged
0000–0015 SQL. Owned PostgreSQL16.13 and17.10 produce identical fingerprint for26
business tables; independent Terra16/16, clean-lock68/68 across four affected
suites, zero skips. Mutation tests distinguish structural change from row updates.
TypeScript/lint/architecture PASS; two file-count/hash inventory updates only.
This unused helper does not yet attest historical data, authorize migrations,
grant permissions, ship VQ SQL or change readiness. Those gates remain OPEN.

## 2026-09-05 VQ S2a — fresh journalled estate and disposable CI

[VQ packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
records real TS CLI dry-run/apply16/replay0 against newly owned PostgreSQL17.10,
exact checksums and durable constraints/row retention. Independent Sol25/25;
final clean-lock52/52, zero skips. Both existing CI preparation paths now use the
same namespaced runner with dedicated child-only test URL. Topology mutation test
was red before wiring and is green; syntax67/reference127/architecture8310/lint
and unchanged345 test diagnostic ratchet pass. No full helper/hosted PG16/image/
historical/readiness claim. S2b/S3 and candidate/hostile/security vetoes remain OPEN.

## 2026-09-05 VQ S1 — isolated migration runner namespaces

[VQ recovery packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/vq-schema-recovery.md)
records the closed main/vault-quest directory/journal/lock choice and preserved
main defaults. Root78/78; independent Sol31/31; final clean exact-lock105/105,
zero skips; clean build3366 modules and bundled invalid-estate refusal PASS.
TypeScript/scoped lint PASS; test345/script11 diagnostic ratchets unchanged.
Architecture8310 with exact legacy-query transfers, no owner-rule/extractor waiver.
Synthetic namespace proof is NOT historical VQ convergence, image application or
runtime readiness. Required/enabled owner choice preserves the mounted feature;
S2/S3 and exact candidate/Opus/security/hosted release vetoes remain OPEN.

## 2026-09-05 pricing/legacy integration carry-forward

[Existing legacy packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/grading-legacy-recovery.md)
now binds the previously implemented retirement to current source hashes and
independent proof. Three stale pricing expectations in the architecture test were
corrected to the actual reviewed currency/camelCase records; no production change
or gate weakening. Clean and independent Sol32/32 (architecture27/tombstone5), zero
skips. Actual-source plus synthetic Express proof is not full-app authentication
or final candidate proof. Already-fixed legacy work was not reimplemented.

## 2026-09-05 pricing P3 — real HTTP-to-receipt proof

[Pricing packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/pricing-recovery.md)
records two reproduced turnaround defects and the independent invalid-zero case,
all repaired in the same pass. Actual Admin password/PIN→tier update/audit→public/
promotion→quote→synthetic Stripe charge→durable receipt/success/replay passes.
Purchased amounts/days survive later tier edits; invalid days retain paid state
and require reconciliation, while missing legacy snapshots retain their fallback.
Independent Sol18/18, final clean six-suite106/106, zero skips, final build PASS.
No live provider or shared database/migration/deployment. Exact source hashes and
rollback retained; immutable candidate/hosted/hostile/release gates are not closed.

## 2026-09-05 pricing P2d — editorial catalogue convergence

[Pricing packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/pricing-recovery.md)
records13 real SEO component/FAQ/schema trees, guides/server metadata and current
pricing links: initial15red, root/independentSol/clean50green, zero skips. Held-out
fixed tier-name copy reproduced and repaired. Final clean build/TypeScript pass,
scoped lint0errors/1existing warning, ratchet345 unchanged. Independent architecture
8313 PASS with147 obsolete legacy retirements/+16 exact transfers; no new files,
owner rules, adoption or diagnostic waiver. SSR proof is not full-browser/crawler
proof. P3/integration/exact-SHA/security/final hostile/release gates remain OPEN.

## 2026-09-05 pricing P2c — service copy and ancillary authority

[Pricing packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/pricing-recovery.md)
records root/independentSol/clean34/34 after held-out insurance-cap repair, clean
separate regressions53/53, final build/TypeScript pass, scoped lint0errors and
Terra architecture8444. No invented calculator fee/net or fixed membership break-even;
service links preserve server prices; shared insurance/bulk inputs drive both pages.
Certificate option IDs/history retained. Full P2d/P3/CI/hostile/release remain OPEN.

## 2026-09-05 pricing P2b — duplicated preview catalogues retired

[Pricing packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/pricing-recovery.md)
records exact c26 baseline, five-file manifest, parent6/6red, root/independentSol/
clean25/25green, clean build and final source hashes. Six real preview component
trees now link to canonical pricing without static grading catalogue/turnaround
claims; non-price content and independent membership retained. SSR proof excludes
decorative hydration. TypeScript and lint0errors pass;72 exact legacy keys retired,
no adoption or gate relaxation. Full pricing/P3/hosted/security/hostile vetoes OPEN.

## 2026-09-05 pricing P2a — canonical consumers, not full pricing closure

[Same pricing packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/pricing-recovery.md):
Home/Pricing/Submit use live tiers; two static bulk-money tables consolidated into
one shared policy-band component. Root/independent Sol/final clean19/19 prove current
and unavailable/paused/new tier cases, explicit three-service switching, promo basis
and pending/failed quote behavior. Clean69 regression tests and final build pass;
Terra architecture8498 passes without broader ownership/gate relaxation. P2b public
variants/SEO/guides and P3 Admin/API/payment/receipt propagation remain open.

## 2026-09-05 pricing P1 — foundation verified; full pricing finding remains open

[Pricing recovery packet](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/pricing-recovery.md)
binds baseline c228af1998fb770e12c93758d3737fc92c5a9009, approval, scope and rollback.
Admin render1 + owned PostgreSQL/HTTP3 reproduced red. Root and independent Sol8/8
now pass, including camel rows, current turnaround, active service selection,
no-store, cache failure and two held-out malformed-price/capacity cases. Independent
Terra verifies normal architecture gate8520 records with exact enrollment only.
P2 all price-bearing consumers and P3 Admin→quote→charge→receipt are NOT proven;
ARCH-PRICING-001/hosted CI/security/final hostile gates remain open. No live credentials,
shared database/migration, external payment or deployment used.

## 2026-09-05 Partner contracts — local repair proof, not release closure

[Exact recovery, runs, hashes and limits](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/partner-contract-recovery.md):
mounted real HTTP red→green; both tenant histories retained; shared Scanner role
transport; root/independent Sol/clean exact-lock actual Chrome22/22. Root integrated
145/145 and clean exact-lock178/178, zero skips; existing money/grants/SQL unchanged.
ARCH-SUPPLY-001 and ARCH-ROLE-001 locally FIXED_WIP; exact candidate/hosted/final
hostile proof remains open. No staging/production/provider mutation.

## 2026-09-05 H1h local Super Admin browser wiring

[Exact runs, commands, hashes and recovery evidence](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/hygiene-wave-proof.md):
owned real Chrome/app/PG flow7/7 on root, independent Sol and clean exact-lock copy;
clean four-suite101/101, zero skips. Actual cancellation closes app/browser and leaves
zero owned containers without a success report. Independent shutdown findings repaired,
delayed-close regression added; scoped lint0/0 and unchanged type ratchets pass.
Existing CSS proof retained; CI command now required after Build/preNode22 with negative
topology controls. Admin-only synthetic proof: Partner/browser/full-schema and hosted
candidate gates remain open. No production/staging/shared database/provider access.

## 2026-09-05 WAA-IMAGE-001/002 local repair

[Image packet, exact hashes and recovery limitations](../.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/task-ledger.md):
manual canonical original pointers preserved with both source CAS guards; audit tuple
identifies its exact stored PNG/JPEG body. Root route185/185, clean exact-lock and
independent owned-PG17/synthetic-R2 matrix235/235, zero skips. Four independent mutations
fail; exact restoration passes. Typecheck/build/unchanged345 ratchet/scoped lint pass;
8455-record architecture delta is source-coordinate-only. FIXED_WIP, not final candidate
or phone/full-writer proof. Forward recovery is proven; same-key direct-service replay
is not claimed. No deployment, shared migration, live credentials or real object deletion.

## 2026-09-05 WAA-CREDIT-001 UTC-day repair

[Exact packet, red/green commands, hashes and limitations](../.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/task-ledger.md):
approved single-service/single-test repair passes45/45 on root and clean exact-lock
Node20/owned PG17. Independent held-out proof caught an intermediate midnight defect;
final day marker, monotonic admission, refund CTE result and UTC compensation fixes
are re-proven locally. Typecheck, unchanged345-test ratchet/8455-architecture snapshot,
build and diff check pass; no new lint warning. Independent Sol final45/45, three
mutation groups red, exact restoration7/7 and hashes verified. Local proof CLEAN;
immutable-candidate integration remains open. This is not a deployed/release-ready claim.

## 2026-09-05 H1c durable owned object-store proof

Existing runner now owns pinned loopback MinIO and a direct real server/r2.ts proof
child; CI topology requires the enabled failure-blocking command. Eleven named
transport/integrity/signed-GET/conditional-race/immutable-replay/delete checks pass
on root, independent Sol, and a clean exact-lock Node20 copy. Exact-ID cleanup is
observed after each passing run. First premature-zero-exit attempt was NOT accepted;
entrypoint and independently reproduced termination bugs were fixed and re-proven.
Lifecycle/topology/architecture72/72 and unchanged345-diagnostic test ratchet pass on
both dependency trees; shared PG lifecycle regression22/22 passes. See existing
[hygiene-wave proof](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/hygiene-wave-proof.md)
for WIP hashes, run identities and limitations. Hosted H1c proof remains UNKNOWN.
At baseline a6670fc4 CI now reaches tests (5 failed /7378 passed /5 skipped), but
the image vulnerability gate and both governance runs remain red. No release gate,
Cloudflare IAM/retention proof, browser proof or restricted security evidence is closed.

## 2026-09-05 H1e–g clean-install fixture/type parity

See existing hygiene-wave proof: seven repaired Admin tests plus session contract
suite pass 126/126 independently and against a clean exact-lock Node20 install.
Only @types/pdfkit lock entry changes 0.17.5 -> 0.17.6; isolated old/new declaration
compiler proof is red/green and artifact integrity matches. No PDF runtime edit.
Operational test's ignored local input removal is reproduced ENOENT -> 6/6 PASS;
all tracked script/assertion coverage remains. Clean application typecheck, unchanged
345-diagnostic test ratchet and 8442-record architecture check pass. No release
closure: exact CI, image vulnerability veto, product defects and restricted evidence
remain open. H1d is already pushed at b6fccb07; its architecture CI gate passes.

## 2026-09-05 H1d clean-checkout parity / terminal CI evidence

At pushed2a532416, CI33963442054 failed architecture drift and its image vulnerability
gate; governance33963442029 failed typecheck and31 assertions across12 test files.
Native hosted AMD64 image build/dependency/dev-tool/runtime-user checks passed, but
startup proof was skipped. Security evidence remains restricted/UNKNOWN; no waiver.
H1d WIP: Git-aware inventory, 180 removed ignored/untracked metadata records and no
changed retained allowance;27/27 architecture assertions pass under Node20.20.2.
Tracked-files-only copy independently yields8442 records, zero violations and exact
snapshot equality. Luna verifies inventory semantics under Node24 (not pinned-runtime
proof); root supplies Node20 proof. See the existing hygiene-wave proof for details.
This is a functional parity repair, not full CI or release closure.

## 2026-09-05 continuous H1 local integration checkpoint

[Retained commands, hashes and limitations](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/hygiene-wave-proof.md):
actual ARM64 production image/native libraries/dev-toolchain absence independently
PASS; owned CI-pinned PostgreSQL16/vector+17 preparation and all 70 Partner suites
PASS (1328 assertions, no skips); final runner failure-path fixes independently
PASS (13 lifecycle tests) and real preparation+22 migration assertions re-proven.
Real local MinIO adapter/stream/conditional/replay/signed-download diagnostic PASS.
Starting application HEAD1ae1a7c5 plus the H1b WIP hashes are retained there; the
70-suite run predates final runner corrections and is not exact-final CI proof.
No release node closed; browser, durable object-store CI, managed workflow,
restricted security evidence and hosted exact-SHA proof remain open. No deploy.

## 2026-09-05 authorized hygiene launch

See [first-wave evidence](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/hygiene-wave-proof.md).
Nine dispatch dispositions retained; gate/self-tests pass at80a20611 (13). Local first
dependency repair has red/green regression and independent Terra verification, clean
Linux omit-dev proof and Node20 build. H2a canonical index preserves histories and managed
blocks. Security worker platform failure remains UNKNOWN; no release/security closure.
Full program remains NOT READY; no external deployment or shared migration occurred.

## 2026-09-05 read-only hygiene baseline (not repair/release proof)

At local `80a20611ff5e8928fd6380961ca6bd420abe4727`, live `git ls-remote` and authenticated
GitHub reads confirm main `01d5e4da`, remote recovery `2913bcb1`, draft PR #336 and red
terminal checks. Local HEAD is two unpushed commits beyond that branch. Branch protection
requires five status contexts but zero approvals, no code-owner review and no admin
enforcement; rulesets list is empty. This is a time-bound control-plane observation, not
an exploit or release test. Changes to remote refs/settings invalidate it.

Local metadata/read-only inventory: 97 worktrees, 30 dirty, seven detached, none missing
or prunable. Main-to-HEAD two-tree diff: 491 files, +238,558/-11,899; generated architecture
snapshot accounts for 164,197 insertions. Root ESLint (JSON reporter, no fix) exits 0 with
zero errors and 2,876 warnings across 1,589 files under local Node 24.14.1, not the pinned
20.20.2 application runtime. Scope/method and the exact dispatch plan are recorded in the
existing recovery plan addendum. No worktree is thereby certified safe to delete.

Lead observer: Codex; independent read-only CI/DB planning lane: `ci_db_plan`. No full
integration result was obtained. No provider/hardware proof, migration, push, merge or
deployment was performed. Planning/dispatch validation is not candidate readiness evidence.

Planning controls: dispatch schema/coverage check and 13 in-memory positive/negative
self-tests pass; independent `ci_db_plan` recheck confirms known-but-wrong issue mappings
and nonexistent report artifacts are rejected in all nine lanes. Undispatched mode refuses
advancement as expected. Both root instruction links resolve; `git diff --check` passes.
Existing parent/nested graph validation passes structurally (101 + 34 nodes), remains
not ready and has no candidate SHA. `engineering postflight --run` was attempted but
interrupted rather than treating an unprovisioned broad suite as a useful planning gate;
no full-suite result is claimed. This does not waive postflight for the repair candidate.
The subsequent governance-only postflight returns red: existing managed `CLAUDE.md`
drift, npm package-egress check failure, this uncommitted planning diff, and protected
paths across the pre-existing branch delta; Graphify also needs refresh. No protection
override was used and no gate commands ran in that governance-only invocation.

## 2026-09-04 repository architecture recovery evidence

These are assessment and graph-structure records bound to committed baseline
`09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`; they are not repair or release proof.

| Claim                                                                                     | Source of truth                                                                                                      | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | SHA                                                     | Dependencies                                                                                    | Status     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| The earlier White Ace bounded/concentrated conclusion was not an architecture-wide result | Prior White Ace assessment/graph; independent server, client, and data/runtime source reviews                        | The previous graph contained 34 nodes focused on four new protected product defects, existing release issues, and external gates. Architecture lanes then verified additional live contract breaks, split authorities, migration/readiness drift, runtime cycles, dead implementations, client variants, and job/CI topology outside that graph. The earlier graph is now explicitly nested and its boundedness inference withdrawn.                                                                                                                                                            | `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`              | Invalidated by correction-record or architecture-evidence change                                | PROVEN     |
| The repository-wide architecture recovery program is structurally valid but not ready     | Parent and nested `repair-graph.json`; `validate-program.py`; hostile wrapper mutations; Graph Loop Repair validator | Combined structural validation passes over the 97-node/8-phase parent and required 34-node/7-phase White Ace subgraph (131 total nodes). The wrapper pins the required nested path/program, rejects self-reference/escape/substitution/identity drift, parses actual issue-register rows, and prevents parent readiness unless the nested graph is ready on the identical baseline/candidate. Nine hostile graph/register mutations pass by being rejected. Readiness fails because candidates, findings, owner/recovery gates, proofs, rollback, integration, and external vetoes remain open. | `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb` + WIP graphs | Both graphs, wrapper, hostile test, skill validator, registers, and unchanged baseline/topology | PROVEN_WIP |
| Confirmed repository architecture HIGHs remain open                                       | Current source and architecture task issue register                                                                  | Partner order shadowing, pricing authority split, Scanner role mismatch, live obsolete AI route, VQ schema/readiness split, external-publication lifecycle ambiguity, and the nested White Ace blockers remain open. CI topology, Admin identity/session, and Admin print/reprint are fixed in local WIP only; all retain immutable-candidate or external proof vetoes.                                                                                                                                                                                                                                             | `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb` + local WIP | Corresponding owner gates and independent behavioral proof                                      | FAIL       |

## 2026-09-04 architecture recovery Phase 2 evidence

These records describe an uncommitted local control-plane candidate. They are not
immutable release proof and are invalidated by any relevant source, policy, snapshot,
workflow, test inventory, dependency, lockfile, or runtime change.

| Claim                                                                               | Source of truth                                                                                                                                                | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                | SHA                      | Dependencies                                                                                                  | Status                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Executable architecture authority fails closed over the current repository topology | `scripts/architecture/check-architecture.mjs`, exact policy/legacy ledger, generated snapshot, component manifests, readiness compiler, hostile mutation suite | Local regeneration passes with 8,608 records and 3,673 exact legacy keys covering server routes and route-local middleware, client leaf/guard dominance, components, table/SQL access, object writers, provider origins/callsites, jobs/timers, migrations/lineage, roles, sessions and pricing. Focused architecture/CI mutations pass 36/36; test/script/architecture diagnostic inventories remain at exact ceilings 345/11/5. Three independent lanes returned CLEAN after the final changed-surface recheck. | checkpoint `2913bcb1092ea8f43ee1294b711a8df653a06a3d` + code-diff SHA-256 `62b222ac5dcab62050d2a782df9d7176e5e3029e609f9eefed094229bb22daa1` | Source topology, exact legacy keys, policy, generated snapshot, manifests, compiler, test/runtime versions; an immutable candidate SHA and rerun remain required for release proof | FIXED_WIP / PROOF_PENDING |
| CI topology is locally repaired; immutable hosted proof remains open                 | `.github/workflows/ci.yml`, `scripts/ci`, nested Scanner manifest/lock, package commands, focused CI topology mutations                                         | Local topology, migration references, 65-module JavaScript syntax inventory and TypeScript ratchets pass. The Scanner package directly declares `happy-dom ^20.11.1`, locks exact 20.11.1 as development-only, resolves inside the nested package, and its critical gate passes 14 files / 175 assertions with zero failure or skip. Independent review confirms the test dependency is genuine and isolated but finds the existing macOS packager copies development modules; therefore this is not bundle or release proof. The prior full serial engineering-suite attempt produced 4,716 passes, 2,401 skips, 147 failures and 38 errors across 486 files, dominated by unavailable PostgreSQL/services and sandbox-denied loopback listeners. | checkpoint `2913bcb1` + local WIP `776721df…c8f6` | Exact hosted Node runtimes, PostgreSQL/loopback service topology, full Partner services, immutable candidate; Phase 5 package/sign/notary/install proof | PROVEN_WIP / PROOF_PENDING |

## 2026-09-04 Admin identity/session repair evidence

These records describe the owner-authorized `REPAIR-ADMIN-CONTRACTS` local WIP. They
do not close `ARCH-SESSION-001`: `PROOF-ADMIN-CONTRACTS` remains open until the exact
matrix is rerun against one immutable candidate.

| Claim | Source of truth | Proof | SHA | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| One route-dominant Admin authority owns identity, logout, expiry, navigation, and cache isolation | `client/src/lib/admin-session.tsx`, `client/src/lib/queryClient.ts`, `client/src/App.tsx`, AdminShell consumers, `server/routes/auth.ts`, architecture cache policy/snapshot | One POST-only idempotent logout; discriminated unavailable/unauthenticated/authenticated states; full return path; focus and cross-tab revalidation; exact public Admin route exceptions; protected-by-default cache classification; normalized-email plus Super-Admin-role hash; cancellation, mounted-observer reset, former-principal purge, and stale-transition rejection. Wrong-secret 401s carry `admin_credential_rejected` and stay local while untagged real expiry revalidates centrally. Focused client/architecture proof passes 56/56; mocked server auth passes 18/18. | checkpoint `2913bcb1092ea8f43ee1294b711a8df653a06a3d` + `admin-session-file-manifest.md` local WIP | Any session/credential response, route classification, public key set, principal hash, logout, architecture snapshot, test/runtime, or candidate change invalidates this evidence | FIXED_WIP / PROOF_PENDING |
| The latest Admin repair surface has no reproduced in-scope BLOCKER/HIGH after hostile review | Independent server, client, and data/runtime lanes recorded in `reviewer-status.md` | Reviewers specifically exercised role downgrade, A→logout→B isolation, same-principal verification/logout sequencing, stale transition ordering, public certificate mounting, shared `/api/staff` routing, credential rejection versus real expiry, preserved native response bodies, and session response cache semantics. All three lanes returned CLEAN; the pre-route allowlist 403 was classified non-HIGH because it contains no session representation and no freshness permission. | dirty WIP only; no immutable candidate | Candidate-bound rerun remains mandatory; CLEAN does not authorize release | PROVEN_WIP / PROOF_PENDING |
| Admin local compilation and control gates are green while release controls stay fail-closed | Build, TypeScript, ratchets, architecture/CI scripts, focused UI/auth suites, graph validators, file manifest, lint, Engineering OS postflight | Production build passes outside the sandbox IPC restriction; TypeScript and all three diagnostic ratchets pass; architecture holds at 8,608 records; script syntax covers 65 modules; 121 migration references are classified; CI topology, 158/158 broader Admin UI assertions, exact manifest integrity, graph validation and nine hostile mutations pass; lint reports zero errors and 2,897 existing warnings. Graphify rebuilt to 15,119 nodes / 33,813 edges / 714 communities and standalone drift check exits zero. Postflight remains red on managed governance drift, npm egress, dirty WIP and branch-wide protected paths, and still emits `REBUILD_REQUIRED`; no acceptance override was used. | checkpoint `2913bcb1` + local WIP | Exact immutable candidate, hosted environment, postflight reconciliation, and owner release decision | PARTIAL / PROOF_PENDING |

## 2026-09-04 Admin print/reprint repair evidence

These records describe the owner-authorized `REPAIR-ADMIN-PRINT` local candidate. They do
not close the five associated HIGHs: `PROOF-ADMIN-PRINT` remains IN_PROGRESS and must be
independently bound to an immutable candidate SHA.

| Claim | Source of truth | Proof | SHA | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| Browser, direct-artifact, and workflow reprint commands now share explicit reachable contracts | Three Admin print pages; direct/workflow routes and services; `admin-print-change-manifest.md` | Produced-state Browser gating; reason-first canonical JSON; bounded per-intent keys; exact replay/conflict; interleaved unknown retries; known-terminal rotation; response validation; all-rejected failure semantics; removed endpoint remains absent. | functional aggregate `87d755e7…38535c` | Any client route/body/header/error/modal or server command change invalidates this evidence | FIXED_WIP / PROOF_PENDING |
| Print evidence, replay, and artifact output fail closed at the correct temporal boundaries | Print workflow/finalizer/output eligibility, object-write coordinator, artifact GET handlers | Advertised per-cert compliance rows commit transactionally; insertion failure rolls back and safely resumes. A COMMITTED command replays before fresh mutable checks with no new effects. Downloads recheck every immutable batch member; revoked members and the legacy mutable-pointer subset-bypass return 422 before object access. | functional aggregate `87d755e7…38535c` | Object-write state, evidence schema, eligibility, membership, Partner policy, artifact route or R2 boundary changes invalidate proof | FIXED_WIP / PROOF_PENDING |
| Required print readiness now covers reachable write and runtime authority | Required print component, `PRINT_WORKFLOW_CONTRACT_PREDICATE`, production-role readiness, migration 0022 | Both standalone and full release queries reject missing relations/columns/indexes/defaults, generated IDs, PKs, detached/retargeted sequences, and table/sequence privilege drift. The runtime login executes the append-only receipt SELECT+INSERT contract. | functional aggregate `87d755e7…38535c` | Schema, migration, role, grant, sequence, component or readiness-query change invalidates proof | FIXED_WIP / PROOF_PENDING |
| Local integration and hostile review are green without creating a release claim | Unified Vitest matrix, architecture authority, compiler ratchets, production build, Graphify, three read-only lanes | 9 files / 155 assertions pass with 2 intentional skips; architecture has 8,627 records and 25/25 hostile tests; root/test/script/architecture TypeScript, migration references, CI topology, Graphify freshness, whitespace, and build pass. Three final lane rechecks are CLEAN. | owner-directed wave-end checkpoint commit (self) | Candidate-bound independent rerun, broader repository/external vetoes, and owner release decision remain required | PROVEN_WIP / PROOF_PENDING |

## 2026-09-04 White Ace assurance evidence

These records describe the uncommitted local candidate derived from starting SHA `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`. They are assessment evidence, not a release claim. `WIP` evidence is invalidated by any relevant source, test, workflow, runtime, migration, provider, or environment change.

| Claim                                                                                                   | Source of truth                                                                                               | Proof                                                                                                                                                                                                                                                                                                                                                                      | SHA                        | Dependencies                                                                                           | Status     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| The repository has been assessed under White Ace without collapsing unknowns into passes                | White Ace v0.2.0, project governance, Graphify code-only graph, current source, canonical issue/proof ledgers | Skill package hash `e8f549d3d7f5d15e1d2098ec119c7ef7dc21649a7942cebf85058b2142060a21`; skill self-tests 6/6; Engineering OS preflight `CRITICAL/HOSTILE`; final Graphify 0.9.39 rebuild produced 14,846 nodes, 33,334 edges and 731 communities; graph freshness passed; important conclusions were verified in source/tests. White Ace verdict remains `NOT_ESTABLISHED`. | starting SHA + WIP         | Local graph/toolchain only; no provider or live-environment observation                                | PROVEN     |
| Full Git history has no unallowlisted secret-scanner finding in this WIP                                | `.gitleaksignore`, Gitleaks default rules, complete reachable Git history                                     | Initial redacted scan found 147 findings across 24 commits. Rule/path/context review classified them as synthetic redaction fixtures, idempotency/object keys, schema identifiers, or non-secret hashes; the working tree added one SQL false positive. Only exact commit/path/rule/line fingerprints were allowed. Fresh scan: 2,890 commits, 71.86 MB, no leaks found.   | starting SHA + WIP         | Gitleaks local rule set/version; changes to history, scanner rules or ignore file invalidate proof     | PROVEN_WIP |
| The central 0122 object-write coordinator paths remain executable                                       | Migration 0122, object-write coordinator/reconciler, seven integration suites                                 | Serial disposable-PostgreSQL run passed 7 files and 33/33 assertions: coordinator, migration, reconciliation, manual certificate, Partner card image, scanner evidence and submission receipt. A parallel attempt produced an infrastructure timeout; the isolated reconciliation suite passed 5/5 and the serial topology passed cleanly.                                 | starting SHA + WIP         | Loopback PostgreSQL 17; in-memory/fake object-store boundaries; live provider proof excluded           | PROVEN_WIP |
| The current certificate metadata image route has two protected HIGH integrity defects                   | Production route/service/persistence code and production-shaped `certificate-update-route` fixture            | 178/180 assertions pass. One deterministic failure proves a dual front+back request returns 500 after the first side changes the second side's expected pointer (`WAA-IMAGE-001`). One deterministic failure proves the audit SHA does not hash the object named by its `r2Key` (`WAA-IMAGE-002`).                                                                         | starting SHA + WIP         | Owner approval required before certificate/storage/evidence behavior changes                           | FAIL       |
| The public phone-upload completion path is not durably attached                                         | `server/routes.ts`, migration 0122 publication contract                                                       | Source verification shows direct deterministic-key `uploadToR2` calls, an unused column map, an update of `updated_at` only, and a success response. The target image pointer/audit is not finalised through 0122 (`WAA-IMAGE-003`).                                                                                                                                       | starting SHA               | Owner approval and behavioral integration proof required                                               | FAIL       |
| Anonymous estimate admission/refund is not stable across UTC/session-timezone boundaries                | `server/estimate-credit-consumption.ts`, focused PostgreSQL test                                              | A controlled database session whose local date differs from UTC fails 2/24 assertions deterministically: the second anonymous reservation is admitted and refund is refused because `NOW()` is cast in session local time while the input day is UTC (`WAA-CREDIT-001`).                                                                                                   | starting SHA + WIP fixture | Owner approval required before payment/entitlement code changes                                        | FAIL       |
| Ignored local environment material is not least-readable                                                | File metadata and key-name/non-empty inspection only                                                          | Eight ignored `.env`/backup files are `0644` beneath `/Users/cornelius` mode `0750`; each contains 13–15 non-empty variables whose names indicate passwords, PINs, tokens, API/access keys, secrets, or database URLs. `.env.save` is `0600`. No credential value was emitted or preserved in evidence.                                                                    | local workspace state      | Owner approval for permission change; provider rotation/deletion decisions remain external/destructive | FAIL       |
| Five apparent full-gate database boot failures are configuration-dependent rather than product failures | Full `test:engineering` output; five named integration suites; disposable PostgreSQL rerun                    | Captured full default run: 421 files passed, 54 skipped, 9 failed; 6,200 assertions passed, 1,014 skipped, 12 failed. The five suites that lacked database variables separately pass 5 files/62 assertions against guarded loopback PostgreSQL 17. Final focused fixtures make the image and credit failure clusters deterministic.                                        | starting SHA + WIP         | Default local gate still does not self-provision all declared test authorities                         | PARTIAL    |
| Existing release blockers remain unresolved                                                             | Current auth token source/schema, managed governance workflow, GitHub/provider/staging/production boundaries  | Six plaintext bearer families remain; managed governance Actions/services and Node major remain mutable; exact-SHA hosted CI, GitHub enforcement, provider capability/restore, staging and production were not observed.                                                                                                                                                   | starting SHA               | Owner, upstream Engineering OS, GitHub and provider action                                             | NOT_PROVEN |

## 2026-08-30 frozen remediation checkpoint

These entries describe the frozen local candidate. `checkpoint commit (self)` refers to the immutable commit containing this ledger; its full SHA is reported by the checkpoint operation. Nothing marked `DEFERRED` or `EXTERNAL_BLOCKED` is release proof.

| Claim                                                                      | Source of truth                                                                                                      | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | SHA                      | Dependencies                                                                                           | Status           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------- |
| The integrated repository test manifest is locally executable              | `.engineering/project.yaml` unit-test command                                                                        | `npm run test:engineering` completed with 474 files: 445 passed, 29 intentionally conditional/skipped, 0 failed; 6,439 assertions passed, 780 skipped, 0 failed. The five suites previously blocked on missing shared DB configuration separately passed 62/62 after the declared disposable database preparation.                                                                                                                                                                                                                                                                                                                                                       | checkpoint commit (self) | Local loopback PostgreSQL/pgvector services; native CI matrix remains separate                         | PROVEN           |
| The critical Partner matrix is non-vacuous and boot-race free              | `scripts/ci/run-partner-suite.mjs --all`, canonical public router, shared PostgreSQL limiter boot barrier            | The serial topology-aware matrix completed 70/70 critical suites with 1,327 observed assertions, 0 failed and 0 skipped. It exercised restricted runtime/RLS, login/MFA/reset/invitation, the first-request limiter barrier, RBAC, management, submissions, credits, scanner/Card Jobs, connectors, concurrency and the 5,000-way last-credit race against disposable PostgreSQL.                                                                                                                                                                                                                                                                                        | checkpoint commit (self) | Loopback PostgreSQL 17/pgvector clusters; no staging or production mutation                            | PROVEN           |
| Protected MVGS v1.4 behaviour did not move                                 | Freeze manifest, golden vectors, scoring, and input-builder suites                                                   | Four protected suites pass 297/297. No freeze reseal, scoring formula, threshold, centering, Pristine, or input-builder change was made. The only `server/grader.ts` delta removes three runtime DDL helpers into migration 0115; deletion-only guards admit those exact helpers and continue to reject calculation changes.                                                                                                                                                                                                                                                                                                                                             | checkpoint commit (self) | Frozen MVGS manifest, golden corpus, and protected-diff base                                           | PROVEN           |
| The frozen candidate type-checks, lints without errors, and builds         | `npm run check`, `npm run lint`, `npm run build`                                                                     | TypeScript, ESLint with zero errors, and the governed production build passed before final checkpoint creation; exact terminal counts are recorded in the final checkpoint report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | checkpoint commit (self) | Installed lockfile dependencies; local arm64 build                                                     | PROVEN           |
| Migrations 0114–0121 are classified and behaviourally exercised            | Numbered SQL, migration registry/scope contracts, dedicated PostgreSQL suites, SQL safety gate                       | All eight migrations are classified application-scope and inventory-pinned. Legacy Partner/production-journal fixtures explicitly refuse to falsely journal them. Dedicated allocator, schema convergence, NFC, payment, session, notification and role suites execute the authoritative SQL against disposable PostgreSQL; 0115–0121 pass the destructive-SQL heuristic and 0114's reviewed convergence operations remain explicit.                                                                                                                                                                                                                                     | checkpoint commit (self) | Dedicated disposable PostgreSQL; no staging/production application                                     | PROVEN           |
| Admin/customer PIN setup preserves the second-factor state machine         | `server/routes/auth.ts`, live session authority, `tests/admin-auth-reliability.test.ts`                              | Password-only pending admin state cannot replace an existing PIN. First setup requires the route-established setup flag and live absence of an existing PIN; customer setup requires current live customer authority. Focused auth/session/public-boundary result: 30/30.                                                                                                                                                                                                                                                                                                                                                                                                | checkpoint commit (self) | Live credential-version/session rows                                                                   | PROVEN           |
| Paid grading credit cannot back more than one payable order                | `server/routes/submissions.ts`, migration 0115, payment/credit PostgreSQL suites                                     | A credit is permanently bound to one server-generated canonical tracking number; elapsed `reserved_until` cannot make it reusable; both immediate and durable fulfilment require the same binding. Focused result: 26/26, including the mutation that makes the old 30-minute reuse path fail.                                                                                                                                                                                                                                                                                                                                                                           | checkpoint commit (self) | Stripe PaymentIntent metadata/receipt authority; external delivery is REL-ENV-001                      | PROVEN           |
| Customer security/ownership notifications retry inside capability lifetime | Migration 0120, `server/customer-notification-outbox.ts`, mutation call sites, outbox tests                          | Encrypted payload plus mutation intent commit atomically. Workers lease with `SKIP LOCKED`, retain stable provider idempotency, and schedule retries within half of the remaining capability lifetime. Real PostgreSQL proves a transient failure receives a second attempt before a 60-second capability expires; focused outbox result: 6/6.                                                                                                                                                                                                                                                                                                                           | checkpoint commit (self) | Production encryption keyring, Resend delivery/reconciliation; external under REL-ENV-001              | PROVEN           |
| Evidence recapture can regain a verified compliance archive marker         | `server/b2.ts`, archival worker, scan ingest, object-store and finalisation-race tests                               | Existing B2 bytes must match R2/ledger hash and length and already be COMPLIANCE. Insufficient retention is extended through `PutObjectRetention`, then bytes/hash/mode/date are re-observed before completion. Wrong mode, corruption, provider refusal, unobserved renewal, or concurrent ledger change remains closed. Focused integrity/renewal/PostgreSQL race result: 19/19.                                                                                                                                                                                                                                                                                       | checkpoint commit (self) | Live B2 `writeFileRetentions` capability, Object Lock policy and restore exercise                      | PROVEN           |
| Restricted main-runtime and Partner operational authorities compose safely | Migration 0121, `server/partner/operational-authority.ts`, readiness, distinct-role PostgreSQL proof, hostile review | All 11 denied main-pool statements delegate bounded typed facts to the explicit Partner-admin credential. Readiness unconditionally proves production configuration, BYPASSRLS, every read grant and every row-lock grant. Main writes retain immutable origin/destination CAS; Partner provenance locks use record→import→submission→handoff order. A main login denied Partner SELECT (`42501`) successfully composes print/QA/grading through the distinct credential, and a two-connection reconciliation race completes without deadlock. Deterministic focused result: 16 files, 179 passed, 0 failed; 5 pre-existing environment-opt-in capability tests skipped. | checkpoint commit (self) | Provisioned same-database main-runtime and Partner-admin credentials remain external under REL-ENV-001 | PROVEN           |
| Repository supply-chain enforcement is not fully established               | Main CI workflow, checksum-managed Engineering OS workflow, Dockerfile, governance tests                             | Main remediation workflow/image references are pinned and the production image is pruned/non-root. The managed Engineering OS workflow still uses mutable tags and is excluded from the immutable-reference regression; no local Docker daemon exists for native linux/amd64 image evidence.                                                                                                                                                                                                                                                                                                                                                                             | checkpoint commit (self) | Upstream Engineering OS update, authenticated exact-SHA CI and native Docker evidence                  | EXTERNAL_BLOCKER |
| Customer-facing release is not established by this checkpoint              | REL-IMAGE-001, REL-TOKEN-001, REL-ENV-001 and REM-GH/REM-SUPPLY                                                      | Object/database atomicity, specified plaintext bearer capabilities, GitHub enforcement, managed-workflow mutability, and provider/control-plane/physical evidence remain deferred or external.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | checkpoint commit (self) | Remaining authorised remediation plus exact owner/provider actions                                     | NOT_PROVEN       |

## Historical proof ledger

| Claim                                                                                                                              | Source of truth                                                                                                                                                                                          | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | SHA                                      | Dependencies                                                                                                                                                                                                            | Status |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Graphify uses a local code-only corpus                                                                                             | `.graphifyignore`, `package.json`, `graphify-out/graph.json`                                                                                                                                             | `npm run graph:build` reported 1,168 code files, 0 documents, and the graph contained 0 document nodes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 70307beda542c71b1d067230096ac7bd3878bb53 | Privacy ignores and Graphify 0.9.39                                                                                                                                                                                     | PROVEN |
| Graph navigation is source-authoritative                                                                                           | Graphify queries and their cited source                                                                                                                                                                  | Queries located scanner evidence finalisation, MVGS input/scoring/draft persistence, and Partner session/credit services; source was read afterwards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 70307beda542c71b1d067230096ac7bd3878bb53 | Source and graph rebuild                                                                                                                                                                                                | PROVEN |
| Engineering OS managed blocks remain intact                                                                                        | `engineering check`                                                                                                                                                                                      | The checker passed after supported `engineering upgrade` restoration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | c51e3de0                                 | Managed markers and formatter behaviour                                                                                                                                                                                 | PROVEN |
| Latest committed scanner baseline is lint-clean without weakening policy                                                           | `scripts/scanner-app/lib/watcher.js`, current lint configuration, and `npm run lint`                                                                                                                     | The prior six `no-unreachable` findings belong to the older enrolment line. The reconciled `f024f938` scanner baseline reports 0 lint errors (2,666 permitted warnings); no lint configuration or scanner behavior was changed in this pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | reconciliation candidate                 | Scanner control flow and ESLint configuration                                                                                                                                                                           | PROVEN |
| Scanner safety boundaries remain executable after reconciliation                                                                   | Scanner app and server scanner/evidence suites                                                                                                                                                           | Scanner app: 132 pass, 0 fail. Focused server scanner/evidence suite: 40 pass, 0 fail. These cover LiDE detection, target binding, front/back flow, idempotent retry, placement/frame gates, and evidence admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | reconciliation candidate                 | Scanner fixtures, Electron test binary, Node test runtime                                                                                                                                                               | PROVEN |
| Card Job void audit vocabulary is a strict database contract                                                                       | `migrations/0096_partner_card_job_void_management_audit.sql` and isolated PostgreSQL                                                                                                                     | 0096 atomically preserves all 27 0084 values and seeded rows, accepts `partner_card_job_voided`, and rejects `partner_card_job_totally_invalid_test_event` with CHECK violation 23514. The real super-admin wrapper writes exactly attempted and succeeded `partner_card_job_voided` rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | canonical lineage candidate              | PostgreSQL 17.10 disposable cluster; Card Job migration harness                                                                                                                                                         | PROVEN |
| Partner credit price is displayed and charged as VAT-inclusive                                                                     | `server/partner/credit-purchase-service.ts`, verified Stripe Price and Checkout Session                                                                                                                  | The server rejects Price and line-item totals that differ from the fixed owner-approved pack amount, rejects every tax behavior other than explicit `inclusive`, and reads no price or quantity from the browser. A strict-tax mutation made the real PostgreSQL credit suite fail, then passed once restored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 12c9a641ec3c76770c10e18f21a66bcfe6bce67f | Locked pack map, Stripe Price configuration, Checkout webhook and credit ledger                                                                                                                                         | PROVEN |
| Partner refunds and disputes produce an audited exception, never an automatic debit                                                | `server/partner/routes.ts`, `server/webhookHandlers.ts`, `recordPurchaseException`                                                                                                                       | Checkout writes the same server-built attribution to both Checkout Session and PaymentIntent. Refunds read the resulting Charge metadata; disputes re-read their referenced Charge. Mutations removing either the PaymentIntent copy or Charge retrieval made the credit regression fail; no refund path writes the wallet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 12c9a641ec3c76770c10e18f21a66bcfe6bce67f | Stripe object metadata semantics, verified webhook and exception table                                                                                                                                                  | PROVEN |
| Production-shaped candidate migration plan includes scanner credit view                                                            | `tests/canonical-lineage-production-rehearsal.test.ts`, `migrations/0098_scanner_operator_credit_view.sql`                                                                                               | A disposable replica of the 41-row production journal plans exactly 21 pending canonical files, applies through 0098 with destructive approval, and ends at 62 consistent identities. It proves the Scanner operator receives only `partner.credits.view` and no prohibited authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 12c9a641ec3c76770c10e18f21a66bcfe6bce67f | Production journal topology, migration runner and PostgreSQL 17 disposable cluster                                                                                                                                      | PROVEN |
| Final refs did not move during the canonical freeze                                                                                | `git fetch origin`, active worktree HEAD, `/api/version`, release ancestry checker                                                                                                                       | Final read-only check retained `origin/main=5a45ff9e`, active Partner/Scanner=`72f57963`, production=`158dbf53`; `check-live-ancestry` accepted the documented semantic reconciliation acknowledgement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 1bbbcd3cfdabb9c087e6164f6f120dad5ed25a8f | Frozen active line and production SHA; invalidated by any later ref/live change                                                                                                                                         | PROVEN |
| Growth commercial money is canonical GBP and revenue velocity is exact/tiny-sample-safe                                            | `growth.tsx`, `growth-intelligence-service.ts`, `growth-infrastructure-control.test.ts`                                                                                                                  | Server query requires paid state, PaymentIntent, payment timestamp and GBP inside the rolling 60-minute window; all three velocity measures withhold below three paid submissions. MintVault money renders `£`; native provider currency is preserved only for future authoritative costs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | fe0588da5b92131998d88b79779e8a9b6b468e96 | Verified paid-submission authority and server aggregate                                                                                                                                                                 | PROVEN |
| Infrastructure intelligence is truthful and cannot mutate or spend                                                                 | `growth-infrastructure-intelligence.ts`, `growth-mcp.ts`, `growth.tsx`, infrastructure design                                                                                                            | Fly, Neon provider telemetry and Fly/Neon/R2/Resend costs return `NOT_CONNECTED` with no invented values when authority is absent. Current mode is manual monitor/detect/recommend; MCP annotations are read-only; no provider client, credential lookup, mutation, autoscale or spend action exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | fe0588da5b92131998d88b79779e8a9b6b468e96 | Separate future provider-read authority; guarded auto is unavailable                                                                                                                                                    | PROVEN |
| Infrastructure/GBP addendum satisfies executable and rendered acceptance                                                           | Focused Growth suite, TypeScript, ESLint, production build, Graphify, browser harness and hostile review                                                                                                 | 81/81 Growth assertions, TypeScript, lint with zero errors, build and graph freshness passed. Live Growth rendered at 1440px and 390px without horizontal overflow; canonical `£`, truthful empty provider/cost panels and manual recommendation-only control were observed. Independent hostile review found no actionable in-scope BLOCKER/HIGH.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | f4285b71a5fd0cad578e845d9aaed43768309541 | Optional least-privilege provider reads remain absent-safe                                                                                                                                                              | PROVEN |
| Commercial targets are owner-authored, auditable and pace-truthful                                                                 | `growth-scoreboard-service.ts`, migration 0101, Super Admin/MCP routes, Growth UI and focused tests                                                                                                      | Targets are append-only Super Admin monthly revisions with transaction-level serialization and audit; actuals use exact paid/PaymentIntent/timestamp/GBP authority; status compares actual progress with elapsed London month; genuine reviews remain unavailable. PostgreSQL proves changed-only revisions/null clear; live production shows five `NO TARGET SET` cards and no seeded rows.                                                                                                                                                                                                                                                                                                                                                                                                                                           | f4285b71a5fd0cad578e845d9aaed43768309541 | Owner enters approved targets; published-review count needs optional authority                                                                                                                                          | PROVEN |
| Growth Completion Night release is canonical, migrated, live and rollback-ready                                                    | PR #320, GitHub checks, migration journal/schema proof, safe-deploy output, Fly status and live acceptance                                                                                               | Exact candidate `d7dddadd` passed PR checks and merged normally; exact main `f4285b71` passed CI/Engineering OS; canonical runner applied 0101 to 64/64 clean; Fly v1111 serves the SHA on two passing LHR machines; public/core/shared-boundary/authenticated Growth proof passed; rollback image `deployment-01M0DYQHT8R6V6QV265H918CED` is recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | f4285b71a5fd0cad578e845d9aaed43768309541 | Optional external MCP/review/Search Console/provider connections are owner actions                                                                                                                                      | PROVEN |
| Two Scanner profiles on one Mac retain distinct station identities under the shared Keychain wrapping namespace                    | `scripts/scanner-app/lib/station-identity.js`, `MINTVAULT_SCANS_DIR`, the two read-only live identity files, and `scripts/scanner-app/test/station-identity.test.js`                                     | The live default and Shop Games ciphertext files decrypt to their expected distinct station, installation and public-key fingerprints. Executable tests use one shared Safe Storage wrapping key while proving distinct encrypted files, independent restart/sign-out/MFA behaviour, no cross-profile placement fallback and no automatic re-home.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 5d776380b478b1cee919d3381635822937982ce8 | Electron application/Keychain namespace, `MINTVAULT_SCANS_DIR` path selection, encrypted identity format and placement-config path                                                                                      | PROVEN |
| A Scanner station is unusable until the exact current operator session validates that exact station                                | `scripts/scanner-app/main.js`, `scripts/scanner-app/lib/station-client.js`, `scripts/scanner-app/lib/station-identity.js`, `server/partner/station-routes.ts`, and focused Scanner tests                 | Wrong-tenant 403 and inconsistent-station 200 responses reach identity mismatch before heartbeat, credit commit, tenant reconciliation or geometry adoption. Session changes before/after HTTP and immediately before enrolment persistence fail closed; signed requests require the process-local validated pairing. Focused identity/auth runtime passed 24/24, Scanner 175/175, the clean full suite 6,950 tests, and the protected Partner matrix 1,320 assertions.                                                                                                                                                                                                                                                                                                                                                                | 5d776380b478b1cee919d3381635822937982ce8 | Partner session cookie semantics, tenant-scoped enrolment-status response, setup/auth IPC, station signing and enrolment persistence                                                                                    | PROVEN |
| The incident-specific STAGING Canon geometry repair preserves evidence policy and cannot silently reinterpret an in-flight capture | `server/partner/staging-canon-geometry-repair.ts`, `server/scanner-capture-service.ts`, `.dockerignore`, `script/build.ts`, the shared LiDE 400 profile, physical diagnostic artifacts and focused tests | The plan derives `{0,0,100,130}`, working region `{5.6,5.6,88.8,118.8}`, preview margin 5.6 mm and unchanged master minimum 4 mm. Exact STAGING/database/station/tenant/operator/MFA/hardware/calibration identity and quiescence are required; the old row is preserved; station plus current calibration are locked; capture arming shares that lock; apply/rollback are exact and append-audited; rollback closes after any corrected capture. Real PostgreSQL proves dry-run/apply/idempotency/rollback with the old row byte-equivalent; focused tests pass 74/74 and the protected bridge 45/45. The first remote image build failed before release because the entrypoint was Docker-ignored; the corrected allowlist admits only that file and a 4/4 regression now requires every `scripts/` build entrypoint to be admitted. | 72757f47228609d275a127c659647478e2f88aa7 | Invalidated by changes to the repair service, capture-arm calibration lock, Docker build context, shared geometry profile, exact STAGING station/calibration identity, database-environment guard or station quiescence | PROVEN |
