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
| 2 — Investigation | done for WP0 | 2026-08-14 | A9/tooling complete; A1 headline only; Lead inspected authoritative Scanner source |
| 3 — Lead verification | done for WP0 | 2026-08-14 | Base, ancestry, dirty state, gaps, tool versions and graph verified |
| 4 — Implementation authorisation | done for WP0 | 2026-08-14 | Owner master prompt authorises isolated WP0 artifacts; no protected external action |
| 5 — Implementation | done for WP0 | 2026-08-14 | OS enrollment plus 36-file WP0 control checkpoint |
| 6 — Regression | done for WP0 except post-commit graph check | 2026-08-14 | Governance 4/4; typecheck/lint/build green; targeted Scanner/Partner/protected tests non-vacuous |
| 7 — Final report | pending | | Only after WP12 or a legitimate external/owner gate |

## Reviewer assignments

| Reviewer | Scope | Result |
|---|---|---|
| A9 P14 | Partner pass2 Git/P14/authority surfaces, read-only | Complete; `reviewer-status.md` and `p14-reconciliation.md` |
| A1 Scanner | Existing Electron/native/package/queue/identity inventory, read-only | Interrupted after confirmed headline; Lead rechecked source, no broad clean claim accepted |
| Tooling | Engineering OS/Graphify availability and correct commands, read-only | Complete; `source-verification.md` |

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
