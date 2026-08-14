# Task: partner-final-rc-reconciliation

**Date:** 2026-08-14. **Worktree:** /Users/cornelius/mintvault-partner-pilot-pass2
**Branch:** codex/partner-pilot-pass2. **Baseline HEAD:** e6fd6c5f985243e59a2ee2435672414048c1a095 (clean)
**origin/main:** 839edd9c — VERIFIED contained in HEAD (`git merge-base --is-ancestor origin/main HEAD` = true). 41 commits ahead. No divergence.

## Scope (owner prompt)
ONLY: reconcile Terra MEDIUM M-1, rerun final release gates, freeze FINAL RC.
NOT authorised: production anything, feature development, architecture redesign, protected MVGS maths changes.

## Terra M-1
`tests/migration-scope-contract.test.ts` fails: 0088_nfc_binding_integrity and
0090_lineage_convergence_scanner are absent from the deliberate scope classification in
`tests/helpers/partner-realistic-db.ts`.

REPRODUCED at baseline: 1 failed / 16 passed. Failure lists exactly those two migrations.

## Stage 3 — Lead verification of Terra's recommendation (application-scope)
Terra recommended application-scope for both. VERIFIED AGAINST SOURCE:
- 0088 SELF-DECLARES its scope at migrations/0088_nfc_binding_integrity.sql:36 —
  `-- SCOPE: APPLICATION (requires ` + "`certificates`" + `)`. Its entire payload is a partial unique
  index on core `certificates (lower(nfc_uid))`. On a partner-only database it is a pure no-op
  (to_regclass guard -> RAISE NOTICE -> RETURN); it contributes NOTHING to partner schema.
- 0090 fails CLOSED without core schema: `RAISE EXCEPTION '0090 precondition failed: certificates
  table is missing'`, plus preconditions on partner_stations and role partner_runtime. Its inlined
  body does `ALTER TABLE certificates ADD COLUMN ...` and FKs `REFERENCES certificates(id)`.
  Classifying it PARTNER-scope would reproduce the exact 0073 failure mode this contract exists to
  prevent.
CONCLUSION: Terra's recommendation is CORRECT for both. Accepted.

## Behavioural impact analysis (pre-change)
`partnerScopeOnly()` is an ALLOWLIST over PARTNER_SCHEMA_MIGRATIONS, so both files are ALREADY
excluded from partner-only harness runs while unclassified. The only functional delta of adding
them to APPLICATION_SCOPE_MIGRATIONS is `requiresCoreSchema()` flipping true for lists that NAME them:
- 0090: named by NO suite migration list. Zero behavioural change.
- 0088: named by tests/partner-pilot-concurrency.test.ts:367 and
  tests/partner-card-job-output.test.ts:354. Both already seed their own core `certificates`
  fixture, so `seedCoreSchemaForApplicationMigrations()` will newly run for them.
  MUST BE PROVEN EMPIRICALLY by running both suites — not by reasoning.

## Authorised next action
Stage 5: classify both as APPLICATION scope; strengthen (never weaken) the contract test; add a real
PostgreSQL proof for 0090; rerun gates; freeze FINAL RC. NO production actions.

## Stage 5 — Implementation COMPLETE
3 files: tests/helpers/partner-realistic-db.ts (+24), tests/migration-scope-contract.test.ts (+36),
tests/lineage-convergence-0090.test.ts (NEW). Additive only, 0 deletions. See change-manifest.md.
Budget: estimated 3 files / ~250 lines / 1 commit / 2 test surfaces. ACTUAL 3 files / 60 insertions
+ 1 new 340-line test. Within budget.

## Stage 6 — Regression results (local, this worktree, e6fd6c5f + changes)
| Gate | Result |
| --- | --- |
| tests/migration-scope-contract.test.ts | 20/20 PASS (was 17 with 1 FAIL at baseline) |
| tests/lineage-convergence-0090.test.ts (NEW) | 11/11 PASS, real PG17, real runner, real exclusions |
| migration identity/parity/lineage family (7 files) | 124/124 PASS |
| protected MVGS/grading set (7 files) | 243/243 PASS — identical to RC baseline |
| scanner/direct-route boundary (8 files) | 62/62 PASS — the 3 env-gated skips ELIMINATED by provisioning disposable DBs, not waived |
| 0088-affected suites (pilot-concurrency, card-job-output) | 21/21 PASS — core seeding now runs, no regression |
| tsc (npm run check) | exit 0, clean |
| eslint | 0 errors / 2593 pre-existing warnings; my 3 files produce ZERO warnings |
| npm run build | green, incl. dist/migrate.cjs (205.3kb) |
| git diff --check | clean |
| drift check | exactly the 3 manifest files; no prod code, no migration bytes, no package.json/lockfile |

Skip elimination detail: tests/scanner-production-migration.test.ts and
tests/scanner-evidence-staging-service.integration.test.ts are gated on
SCANNER_MIGRATION_TEST_DATABASE_URL / SCANNER_STAGING_TEST_DATABASE_URL. Rather than record them as
skipped, disposable local databases were provisioned (mintvault_dgn_release_rcfinal on :5432,
mintvault_dgn_stagingsvc_rcfinal on :55432) and both suites RUN GREEN. Zero skipped critical assertions.

## Stage 6 — Terra's other findings, independently re-verified
| Item | Verdict | Evidence |
| --- | --- | --- |
| HEAD ancestry | PASS | HEAD=e6fd6c5f, worktree clean |
| origin/main divergence | PASS — NONE | `git ls-remote origin refs/heads/main` = 839edd9c, UNMOVED; contained in HEAD; `HEAD..origin/main` empty; 41 ahead |
| duplicate migration numbers | PASS | 54 NNNN_*.sql, 54 unique prefixes, `uniq -d` empty (flat + recursive) |
| migration high-water | PASS | 0090 |
| lineage-exclusions.json in release image | PASS (static) | Dockerfile:54 literal COPY (fails build loudly if absent); script/build.ts:117-129 emits dist/migrate.cjs; runtime path resolves to /app/migrations |
| staging healthy, both Machines | PASS | d8d14d0f34d378 + 8d9349be072948, both started 1/1, release v481, same image digest |
| both Machines serve candidate SHA | PASS | per-machine `fly-force-instance-id` pin: BOTH return commit e6fd6c5f (bogus-ID control returns 400, so the pin is real) |
| production untouched | **RECORD WAS WRONG — see FINDING RC-F1** | prod is v1082 / 839edd9c, NOT v1075 / 1dec8dbf |

### FINDING RC-F1 (HIGH, governance/Class G) — the production release record is 23 commits stale
Independently confirmed by me: `curl https://mintvaultuk.com/api/version` -> `{"commit":"839edd9c"}`.
Prod moved v1076-v1082 across 2026-08-12 and 2026-08-14 (latest ~14:16 UTC today) via CONCURRENT
SESSIONS, while this task's records stayed frozen at v1075/1dec8dbf. `git rev-list --count
1dec8dbf..839edd9c` = 23.
NOT a divergence and NOT a clobber risk: `git merge-base --is-ancestor 839edd9c HEAD` = 0, so the RC
STRICTLY CONTAINS live production. Live prod == origin/main exactly.
Production was NOT touched by this task. The defect is in the RECORD, not the estate.
Consequence: the RC-RECORD/deployment-state/rollback docs naming 1dec8dbf (and b0de0880) must be
corrected before any production plan is written against them.

### FINDING RC-F2 (HIGH, governance/Class G) — the RC exists only on local disk
`git ls-remote origin 'refs/heads/codex/partner-pilot-pass2'` is EMPTY; `git branch -r --contains
HEAD` is EMPTY. The frozen RC has never been pushed, so it has no CI run, no PR, and no off-disk copy.
safe-deploy's GUARD 1/1L/1M all compare against origin/main and the LIVE commit — both ancestors of
HEAD — so an unpushed RC would pass every existing guard. Pushing is a PROTECTED ACTION and is NOT
authorised by this task's prompt; surfaced for the owner, not performed.

### FINDING RC-F3 (MEDIUM, Class G) — rollback.md target is 22 commits behind live prod
rollback.md pins b0de0880 as the known-good target; `git rev-list --count b0de0880..839edd9c` = 22.
Deploying it today would remove server-authoritative grading (77b075a5), rate-limit hardening
(bffed7a2), the 0074 reconciliation (9cd9804d) and the canonical-grading absorb (662d9511) from
production. safe-deploy GUARD 1L would correctly BLOCK it — the hazard is an operator then reaching
for `--allow-behind`. Correct rollback target is now 839edd9c / v1082.

### FINDING RC-F4 (MEDIUM, Class G/C) — 6 of 12 new migrations have no rollback script
0080/0081/0082/0083/0088/0089 have none (0090 is deliberately forward-only and says so in its header;
0084-0087 have scripts). All are additive, so the defensible position is to state in rollback.md that
0079-0090 are NOT reverted on rollback and the previous code release must tolerate the new
columns/tables — but that tolerance is the claim that actually needs proving.

### FINDING RC-F5 (MEDIUM, Class G) — /api/partner is mounted on PRODUCTION today
`curl https://mintvaultuk.com/api/partner/me` -> 401 (a fake partner path also 401; a fake non-partner
path 404), so the partner router IS mounted on prod at 839edd9c with a pre-routing auth gate. Memory
note project_partner_network_g5_live records prod returning 404 (surface absent) — that is now stale.
401 proves MOUNTING, not ENABLEMENT; the flag state needs an owner-gated config read.

### FINDING RC-F6 (LOW, Class H) — exclusions-file presence proven statically, not in the running image
Dockerfile/build/path-resolution all check out, but nobody has observed
/app/migrations/lineage-exclusions.json inside the deployed staging container. One command closes it:
`fly ssh console --app mintvault-v2 -C "ls -l /app/migrations/lineage-exclusions.json"`.

### RC-F6 CLOSED (2026-08-14) — runtime proof obtained
`fly ssh console` (read-only `ls`/`sha256sum`) on BOTH staging Machines:
- d8d14d0f34d378: /app/migrations/lineage-exclusions.json (1360 bytes) and /app/dist/migrate.cjs
  (210229 bytes) both PRESENT.
- 8d9349be072948: lineage-exclusions.json sha256 = f2a1c051ff397e0b5898c5e5418e327f9b1cd5e97ca66eaa3dce0f84bd3fa920
  — BYTE-IDENTICAL to the repo file at the RC (`shasum -a 256 migrations/lineage-exclusions.json`).
Proof level for "exclusions ship in the release image" is now STAGING VERIFIED, not static inference.
