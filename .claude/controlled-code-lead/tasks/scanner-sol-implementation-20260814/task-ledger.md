# Task ledger — MintVault Scanner / Partner Mac Station SOL campaign

## Stage 0 — Baseline (recorded 2026-08-14T07:28:51Z)

- Governed repository: `/Users/cornelius/mintvault-scanner-sol-implementation-20260814`
- Branch: `codex/scanner-sol-implementation-20260814`
- Commit/base: `d44a2c5363e702bb5aeb54157d7ad6a2af30546c`
- Base relation: 30 commits ahead and 1 behind local `origin/main`; merge-base `864fadeda88e06e083bfa483a7fe33520a4570e2`
- Configured canonical origin: `git@github.com:mintvaultuk-byte/mintvault-platform.git`
- Initial `git status`: clean before branch/worktree creation; dirty only from this campaign's Engineering OS enrollment afterward
- Partner authority inspected read-only: `/Users/cornelius/mintvault-partner-pilot-pass2`, `codex/partner-pilot-pass2`, committed HEAD `d44a2c53`, plus active dirty P10-style work
- Production commit/environment: not queried; production access/mutation is outside WP0 and not authorised
- Engineering OS: 1.0.10, enrolled as `high-security`; preflight risk `CRITICAL`, required/selected mode `HOSTILE`
- Graphify: 0.9.39, code-only graph for base SHA, 11,275 nodes / 25,295 edges
- Baseline build/test status: historical P9 evidence only; fresh campaign tests begin after WP0 checkpoint
- Governance version: 1.2
- Governance snapshot hash after WP0 manifest finalisation: `2b282f5f0cd848da800b02ef8c630219c8af58da86785aefe9f40fbef9597d16`
- Protected systems: MVGS math/labels, Partner auth/RBAC/session, station authority, Card Jobs/credits, evidence/R2, migrations, native helpers, package/update trust
- Explicit scope: WP0-WP12 local implementation and proof; WP13/WP14 only after explicit owner approval and external prerequisites
- Explicit prohibitions: do not modify active Partner pass2; do not copy its dirty WIP; do not blind merge; do not change MVGS maths; do not apply migrations; do not deploy/mutate staging or production; do not access/alter secrets; do not perform legacy cutover; do not push

## Session recovery restatement

- Last completed phase: WP0 factual baseline, isolated seed, OS enrollment, preflight, Graphify build, reviewer verification
- Active task: full Scanner production implementation campaign
- Outstanding reviewers: none. A1 was interrupted after a factual headline; its incomplete report is not treated as a clean bill of health. A9 and tooling reports were received and Lead-verified.
- Next authorised action: complete WP0 governance checkpoint, then implement WP1 only on isolated Scanner-owned surfaces
- Not authorised: dependency installation beyond owner-specified requirements without the required notice/record; migration application; staging/production mutation; Apple credential use; signing/notarisation with owner credentials; push/deploy; Pilot/legacy cutover

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-14 | Exact source/Partner/tooling facts recorded |
| 1 — Review plan | done | 2026-08-14 | A9 Partner, A1 Scanner, tooling scopes isolated |
| 2 — Investigation | done through WP2 | 2026-08-14 | WP2 A3/A4 controlled reviews complete; Lead graph/source inspected local identity and committed authority |
| 3 — Lead verification | done through WP2 | 2026-08-14 | Cloneable v1 envelope/main signing, nonce ordering, portal bearer reuse and idempotency gaps verified |
| 4 — Implementation authorisation | done through safe-isolated WP2 | 2026-08-14 | Owner prompt authorises local native/client work; moving P14 forbids server authority/migration wiring until WP10 reconciliation |
| 5 — Implementation | done through safe-isolated WP2 | 2026-08-14 | WP1 capture helper; WP2 caller-authenticated SE/Keychain identity, migration, request serialization and durable operation foundations |
| 6 — Regression | local done through WP2 | 2026-08-14 | WP2 real test-namespace SE lifecycle/migration, hostile repair, Scanner/root/governance/type/lint/build green; signed package/cross-Mac/P14 proofs remain later gates |
| 7 — Final report | pending | | Only after WP12 or a legitimate external/owner gate |

## Reviewer assignments

| Reviewer | Scope | Result |
|---|---|---|
| A9 P14 | Partner pass2 Git/P14/authority surfaces, read-only | Complete; `reviewer-status.md` and `p14-reconciliation.md` |
| A1 Scanner | Existing Electron/native/package/queue/identity inventory, read-only | Interrupted after confirmed headline; Lead rechecked source, no broad clean claim accepted |
| Tooling | Engineering OS/Graphify availability and correct commands, read-only | Complete; `source-verification.md` |
| A1 WP1 helper | Native helper/controller/targeted tests, read-only | Complete; R-1 compiler and mutable executable reproduced from source; CLI contract preserved |
| A2 WP1 compatibility | Electron/package/install/signing metadata, read-only | Complete; Electron 42.2.0 arm64, macOS 12.0 candidate floor, no production package/identity |
| A3 WP2 identity | Scanner station identity/Keychain/helper contract, read-only | Complete; R-4/R-14/R-19/R-21 exact source evidence and migration order |
| A4 WP2 authority | Committed replay/session/idempotency authority, read-only | Complete; safe client work separated from final-P14 server/schema changes |
| A3 WP2 hostile | Current identity helper/Keychain/migration trust boundary, read-only | Initial 4 HIGH; all repaired; final re-review CLEAN |
| A4 WP2 hostile | Current request ordering/op durability/upload auth, read-only | Three review rounds; final 400 key-conflict response-loss edge repaired; final re-review CLEAN |

## Authoritative links

- Campaign issues: `../../../../../engineering/ISSUE_REGISTER.md`
- Campaign proof: `../../../../../engineering/PROOF_LEDGER.md`
- Task issue pointer: `issue-register.md`
- Source verification: `source-verification.md`
- P14 reconciliation: `p14-reconciliation.md`
- Invariants: `invariant-register.md`
- Frozen contracts: `scanner-contracts.md`
- Change manifest: `change-manifest.md`
- Architecture: `architecture-before.md`, `architecture-after.md`
- Rollout/rollback: `rollout.md`, `rollback.md`
- Deployment state: `deployment-state.md`

## WP0 regression evidence

- Governance self-test: 4 suites passed, 0 failed.
- Root TypeScript: pass. ESLint: 0 errors / 2,589 pre-existing warnings. Production build: pass.
- Full baseline Vitest: 4,184 passed, 1,150 skipped, 15 failed. Failures classified as environment/baseline: initially unbuilt locked `canvas`, concurrent/missing disposable PostgreSQL configuration, and five pre-existing certificate-preview runtime assertions. The full baseline is not claimed green.
- After rebuilding the already-locked `canvas`: protected MVGS/label targeted set reached 259 passed / 2 skipped; the one cold-start font timeout passed immediately on isolated rerun (11/11).
- Scanner/Partner source/unit matrix: 119 passed / 1 skipped.
- Serial real-PostgreSQL Partner NEW/FIX/per-card-credit suites: 76 passed / 0 failed.
- Scanner app baseline: 34 passed / 1 source-contract pin failed (`renderer-workflow` expects obsolete recovery button text); assigned to WP8 and not treated as a proved product HIGH.
- Scanner staging-service integration: 2 skipped because the required integration environment was absent; not claimed green.
- Existing lockfiles report root 5 high and Scanner 4 high dependency advisories; reachability/remediation is assigned to WP6 package/security verification and is not downgraded or auto-fixed.

## WP1 implementation and regression evidence

- Controlled A1/A2 reviews confirmed runtime compiler/mutable-helper trust and package/macOS gaps; Lead reproduced each source/metadata fact.
- Build-time-only `mv-capture-helper` is arm64, minOS 12.0, ad-hoc signed locally with identifier `com.mintvault.scanner.capture-helper`, and passes its generated sealed-manifest verifier.
- Direct helper and controller execution returned a versioned, structured `disconnected` result on the current Mac. No Canon hardware was attached, so physical 1200-DPI evidence remains unclaimed.
- Hostile helper matrix: 15 passed / 0 failed. Root packaged-helper/profile tests: 10 passed / 0 failed. Scanner suite: 50 passed / 0 failed.
- The one WP0 Scanner baseline failure was an obsolete source assertion. The test and misleading modal copy now pin the existing server-derived Card Job/missing-side FIX flow; no business-authority source changed.
- Governance 4/4, root TypeScript, lint (0 errors), production build and diff whitespace gates pass.

## WP2 implementation and regression evidence

- Real Secure Enclave test namespaces proved explicit create, duplicate-create
  refusal, bind, persistent nonce signing, resync signature, strict newer epoch,
  reload and exact retirement. A second real test preserved an imported legacy
  key/install ID/nonce and rejected key substitution. All temporary namespaces
  were retired; the production service was never touched.
- Production native source uses exact Team access group, actual permanent tagged
  SE `SecKey`, device-only/non-sync Keychain attributes and authenticated parent
  code. Ad-hoc helper production access is rejected. Final Developer-ID
  entitlement expansion and signed-parent execution are WP6/R-3 proof gates.
- Scanner suite is 67 passed / 3 opt-in skips in the normal 70-test run; the 3
  opt-in tests pass when enabled. Root Scanner/Partner contract matrix is 76/76.
  Governance 4/4, TypeScript, lint (0 errors / 2,655 baseline-plus-campaign
  warnings), production build and diff whitespace gates pass.
- A3 and A4 hostile re-reviews are CLEAN after repair. A4 local findings were repaired,
  including retaining enrolment on every non-success until P14 can prove a terminal result;
  final-P14 server enrolment/replay/session idempotency remains an external
  authority dependency rather than a hidden local claim.
