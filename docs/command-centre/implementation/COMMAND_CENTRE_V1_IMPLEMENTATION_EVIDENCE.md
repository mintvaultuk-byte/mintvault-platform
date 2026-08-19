# MintVault Command Centre V1 — implementation evidence

**Release decision date:** 2026-08-19
**Staging artifact SHA:** `60b9e2683c6866a385496d14de1a780615858468`
**Current-main parent:** `facfd36f4ec8f164d017aba7a4386bab04a4aa6d` (`origin/main` at reconciliation)
**Branch:** `codex/command-centre-v1-reconciliation-20260819`
**Deployment authority:** owner-authorised staging-only deployment and Pilot Flag ON → OFF → ON acceptance. Production was expressly excluded.

## 1. Candidate strategy and scope boundary

The prior Command Centre candidate was not carried forward wholesale. The reconciled implementation was rebuilt selectively from current `origin/main`, then rebased onto `facfd36f`; its deployable code was committed as `35660236`, with `60b9e268` containing only the checked manifest whitespace repair. The deployed artifact is therefore `60b9e268` and is a descendant of the current-main parent above.

`git diff --stat facfd36...60b9e268` records **50 files, 3,392 insertions and 29 deletions**. The diff contains the Command Centre surface, bounded Partner/Pilot-Flag read seams, tests and task governance only. It contains no files under `migrations/`, no package/lockfile or environment/secret changes, no Scanner implementation, no payment/credit purchase service, no webhook handler, no Partner write route, and no auth-core or grading implementation change.

This is a read-only operational composition: the only deliberate persistence interaction is the existing Super Admin Pilot Flag authority. The dashboard route is GET-only and feature-disabled/unauthorised access fails closed.

## 2. Hostile-review reconciliation

| Finding | Correction | Evidence | Result |
|---|---|---|---|
| CC-HIR-001 — foreign protected history | Rebuilt the candidate from present mainline and cherry-selected only scoped Command Centre work. | Clean 50-file diff inventory above; protected paths are absent. | Resolved |
| CC-HIR-002 — stale/no exact evidence | This exact artifact and its validation are recorded here and in the two companion evidence files. | Exact SHA, command results, staging identity and rollback are recorded. | Resolved |
| CC-HIR-003 — unsupported 52-control claim | Performed a live rendered-control inventory rather than reusing the unsupported number. | `COMMAND_CENTRE_V1_CONTROL_AUDIT.md`: 68 actual rendered controls (40 page-specific, 27 inherited navigation, 1 session control). | Resolved |
| CC-HIR-004 — obsolete environment-toggle harness | Harness seeds the persisted `partner_feature_flags` authority `super_admin_command_centre_enabled`; no legacy environment guard controls the live route. | Enabled local harness: authenticated two-step Super Admin dashboard `200`; disabled harness: dashboard `404`. | Resolved |
| CC-HIR-005 — incomplete submission vocabulary | Canonical `new`, `received`, `in_grading`, `ready_to_return`, `shipped`, `completed` plus legacy terminal `cancelled` are handled; deleted and unknown values are bounded. | Core-adapter unit/integration tests; actual composed dashboard fixture proves `new + ready_to_return = 5`. | Resolved |
| CC-HIR-006 — unsafe timestamp coercion/order | `Date` and valid timestamp strings are normalised to ISO; invalid timestamps are rejected before attention composition. | Cross-rule integration fixture proves emitted ISO `asOf` values and oldest-first ordering. | Resolved |

## 3. Runtime contract

- `/admin/command` is a Super Admin-only, read-only page. `/api/admin/command/dashboard` is guarded by the same persisted global Pilot Flag and returns generic `404` when disabled or unavailable.
- `server/command-centre/flag.ts` derives availability from `super_admin_command_centre_enabled`; `SUPER_ADMIN_COMMAND_CENTRE_ENABLED` is not the live authority.
- The typed static registry validates 13 approved V1 capabilities, canonical source IDs, allowed internal destinations and descriptor kinds at startup. It does not create a second Partner, station, finance or grading truth source.
- The dashboard has 12 source-labelled KPI cards, deterministic attention items and a 13-item capability registry. `UNKNOWN`, `UNAVAILABLE`, `STALE`, `ERROR` and `NOT_AUTHORISED` remain explicit states: missing source data is never displayed as a zero.
- Partner/station reads are aggregate-only and use the existing visibility/RLS seams. The live staging Station Lifecycle card showed aggregate lifecycle counts only; it did not expose station IDs, credentials or raw Partner data.
- The ordinary Admin shell owns polling and navigation. Command Centre uses snapshot/explicit refresh behaviour and its own scoped `admin-tokens.css` adjustments; no broad style or shell replacement was introduced.

## 4. Data correctness proofs

The core adapter excludes deleted submissions, treats `completed`, `shipped` and legacy `cancelled` as terminal, and uses the canonical schema vocabulary for all non-terminal counting. The actual composed-dashboard integration test injects database-style `Date` values and asserts:

- canonical `new` plus `ready_to_return` produces a non-terminal count of `5`;
- unknown status vocabulary produces an `UNKNOWN`/`SUBMISSION_STATUS_VOCABULARY_UNKNOWN` envelope rather than a deceptive numeric value;
- emitted attention timestamps are ISO strings; and
- print, review and transfer attention candidates are ordered deterministically oldest-first.

Controlled red/restore checks were also performed before final validation:

- temporarily classifying `ready_to_return` as terminal made the focused count assertion fail, then the exact source was restored;
- temporarily using `Date#toString()` made the timestamp/order assertions fail, then the exact source was restored.

## 5. Validation record

| Gate | Result |
|---|---|
| Command Centre + Partner focused suite after current-main rebase | 18 files, 122 passed |
| Cross-domain protected regression matrix (Partner/RLS/station, finance/credit, Scanner boundary, grading/immutability and MVGS) | 18 files, 508 passed; 41 skipped |
| Scanner application suite | 152 passed, 0 failed |
| Required Partner matrix re-run after CI-topology repair | 8 suites, 159 assertions passed (certificate origin, five connector migration/query suites, Partner management integration and migration) |
| Typecheck | `npm run check` passed |
| Lint | `npm run lint` exited 0; repository warnings only, no lint errors |
| Production build | `npm run build` passed after rebase |
| Diff hygiene | final working-tree `git diff --check` passed |
| Runtime harness, enabled | persisted flag true; synthetic two-step Super Admin dashboard `200` |
| Runtime harness, disabled | persisted flag false; dashboard `404` |
| Harness cleanup | each disposable database was absent after clean shutdown (`0` matching databases) |

The broad root suite was exercised twice to distinguish candidate failures from test-topology conditions. Without its disposable CI URLs it recorded 5,205 passed and 1,013 skipped, but five database-provisioned tests required `TEST_DATABASE_URL` or `MINTVAULT_DATABASE_URL`. The prescribed `scripts/ci/prepare-engineering-governance-db.mjs` then passed against fresh UTF-8 loopback PostgreSQL 17 services on the required ports. A flattened full `npm test` run under that topology demonstrated why the repository ships `scripts/ci/run-partner-suite.mjs`: migration/RLS suites share process-global environment and cluster-global roles, and must run one suite per process. Its initial 32 failures were all caused by the temporary clusters having been initialized as `SQL_ASCII`; recreating them as UTF-8 and provisioning the documented provider-style definer role cleared the exact suites through the prescribed runner (159 assertions passed).

`engineering postflight --run --accept-protected` then passed typecheck, lint and build and formally recorded the reviewed Partner paths, but its generic `unit_test: npm run test` remained non-zero. The postflight command does not invoke the repository's required isolated Partner matrix and therefore is not a valid replacement for that matrix. This is an existing project test-orchestration limitation, not a Command Centre failure; affected suites, controlled mutations, runtime checks and live staging acceptance are green. It is recorded rather than represented as a green monolithic gate.

## 6. Staging acceptance

The authorised command `scripts/safe-deploy.sh staging --yes --reconciled-from ad71baf6` deployed only staging. Fly status subsequently showed app `mintvault-v2`, deployment version `532`, both LHR machines started with `1/1` health checks passing. Read-only staging identity checks returned:

```text
GET /health       -> {"status":"ok"}
GET /api/version  -> commit "60b9e268"
```

An existing Super Admin staging session then confirmed the live page has 12 canonical KPI cards, eight rendered attention links and 13 registry items. It exercised period selection, refresh, search, department and KPI-status filters, explorer collapse/expand, every one of the 13 details controls, and every unique currently rendered destination. The live feature showed `UNAVAILABLE — PARTNER_WALLET_UNAVAILABLE` and `UNKNOWN — SUBMISSION_STATUS_VOCABULARY_UNKNOWN` honestly, rather than presenting false zeroes.

The persisted Pilot Flag was exercised **ON → OFF → ON** in Super Admin Partner Pilot Controls. With it OFF, Command Centre navigation disappeared and `/admin/command` rendered the fail-closed unavailable state. It was restored ON; navigation and the full dashboard returned. No production environment, production flag or production deployment was queried or modified.

## 7. Residual risk and rollback

No release-blocking in-scope defect remains. The only non-green broad gate is the project postflight's flattened `npm test`, which conflicts with the repository's documented isolated Partner-suite topology. It is outside this candidate and does not reduce the green affected suite, explicit Partner matrix or staging acceptance.

Rollback is reversible and staging-only: use the established Super Admin Pilot Controls to disable `super_admin_command_centre_enabled`, confirm navigation removal and generic dashboard `404`, and—if code rollback is necessary—use the recorded safe staging deployment path to restore the previous staging artifact. The release adds no migration, domain mutation, data backfill or production state to undo.

## 8. Production gate

Production rollout remains **owner-gated**. This task grants no authority to deploy, activate the flag, alter data or change configuration in production. Any future production decision must use a fresh explicit production approval and re-check the then-current mainline, staging identity, evidence and rollback owner.
