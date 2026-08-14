# FINAL RELEASE CANDIDATE — Partner Shop Grading (frozen 2026-08-14)

Supersedes the interim RC record for `e6fd6c5f`. Scope of this pass: reconcile the one genuine
Terra MEDIUM (M-1), rerun the release gates, freeze. No feature work, no architecture change, no
production action, no change to protected MVGS maths.

## Identity

|                          |                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CODE FREEZE**          | **`524a79fc`** — the last commit touching anything outside `.claude/`. This is the artifact.                                                                                                                                                                  |
| **Deployable tip**       | the current branch tip. Every commit after the code freeze is `.claude/`-only, so tip and freeze build byte-identically — deliberately NOT pinned here, because each governance commit would move it and make this line lie. Verify with the one-liner below. |
| Commits in this pass     | `504891dd` M-1 fix (3 files, +564/−0) · `eea7c28b` RC record · `7919edab` merge of `origin/main` · `524a79fc` density-guard de-drift · everything after: documentation only                                                                                   |
| Predecessor RC           | `e6fd6c5f985243e59a2ee2435672414048c1a095`                                                                                                                                                                                                                    |
| Branch / worktree        | `codex/partner-pilot-pass2` @ `/Users/cornelius/mintvault-partner-pilot-pass2`                                                                                                                                                                                |
| **Migration high-water** | **0090** (unchanged — no migration authored or edited this pass)                                                                                                                                                                                              |
| `origin/main`            | **`067ed0c6d3f5abfae275f8cd272bef87c99e20b4`** — it **MOVED during this pass** (was `839edd9c`)                                                                                                                                                               |
| Ancestry                 | `origin/main` @ `067ed0c6` fully contained in HEAD after the reconciliation merge. **No divergence.**                                                                                                                                                         |

**Prove the tip is artifact-identical to the code freeze before deploying** (must print nothing):

```bash
git diff --name-only 524a79fc..HEAD | grep -v '^\.claude/'
```

### origin/main moved mid-pass — reconciled, not skipped

At Stage 0 and throughout the work `origin/main` was `839edd9c` and production served `839edd9c`.
The **closing** verification sweep caught both moving: PR #299 (`067ed0c6` merge of
`144fffa8 ui: compact canonical grading workstation`) landed on main and shipped to production.

Delta inspected before any action, per the "do not blindly merge" instruction:

- **Touches:** `client/src/components/grading/{centering-input,grade-display,grading-panel,image-viewer}.tsx`,
  `client/src/components/grading-workflow/*`, one dev harness page, 11 test files, governance docs.
- **Does NOT touch the protected MVGS engine.** `shared/mvgs-scoring.ts`, `shared/centering.ts`,
  `shared/pristine.ts`, `shared/mvgs-input-builder.ts`, `server/grader.ts`, `server/routes/grader.ts`,
  `server/mvgs-scoring.ts`, `server/grading-prompt.ts`, `server/lib/cert-pristine.ts` are all absent
  from the diff. No server route, no migration, no shared logic.

**Decision: reconcile.** An RC that does not contain live production cannot be deployed without
clobbering it — that is the v1070-over-v1069 incident pattern, and `safe-deploy` GUARD 1L would
correctly block the deploy. Containing live prod is a precondition for being a release candidate at
all, not a scope expansion. Merged clean as `7919edab`; MVGS 243/243 re-verified after.

**⚠️ Production was deployed TWICE by concurrent sessions during this single pass** (`839edd9c`
~14:16 UTC, then `067ed0c6` ~15:5x). Any production plan written against this RC must re-read
`fly releases` and `/api/version` immediately before deploying — the RC's containment of live prod
is true as of ~16:1x UTC and the next concurrent deploy can invalidate it.

### What the AT-23 evidence does and does not cover — read this before deploying

**My own M-1 work cannot change the runtime artifact.** It touches only `tests/`, and no
build-reachable file imports from `tests/` (verified by grep across `server/ client/src/ shared/
script/ scripts/`; the four build entrypoints are `server/index.ts`,
`scripts/run-mvgs-v2-migration.ts`, `scripts/repair-set-designations.ts`, `scripts/db/migrate.ts`).

**But the reconciliation merge DOES change it.** Absorbing PR #299 brings in real client changes to
the grading workstation UI. So:

- AT-1…AT-23 were validated against **`e6fd6c5f`**, and staging still serves `e6fd6c5f`.
- The final RC = `e6fd6c5f` + my test-only M-1 work + **PR #299's UI changes**.
- PR #299 was separately reviewed, merged to main, and is **live on production** under its own task
  (`canonical-compact-workstation-density-20260814`), with its own acceptance guard — now de-drifted
  and green.

**Therefore: the AT-23 matrix does NOT cover the final RC's client bundle.** The delta is exactly
PR #299, which carries its own production-proven evidence. If you want AT-23 to hold end-to-end on
the exact final RC, redeploy staging to it and re-run the UI-touching sections. That is a judgement
call, not a defect — but do not claim "AT-23 green on the final RC" without it.

## Terra M-1 — RESOLVED

`0088_nfc_binding_integrity` and `0090_lineage_convergence_scanner` were unclassified, so
`tests/migration-scope-contract.test.ts` was RED at the frozen RC (reproduced: 1 failed / 16 passed).

Terra recommended application-scope. **Verified against source before changing anything:**

- **0088 declares its own scope.** `migrations/0088_nfc_binding_integrity.sql:36` reads
  `SCOPE: APPLICATION (requires certificates)`. Its entire payload is one partial unique index on
  the core certificates table, keyed on `lower(nfc_uid)`. It is `to_regclass`-guarded, so it would
  **not** fail on a partner-only database — it would **no-op**, which is precisely why it must be
  classified application-scope: a no-op recorded as "applied" claims coverage that does not exist.
- **0090 fails closed** — `RAISE EXCEPTION '0090 precondition failed: certificates table is missing'`,
  plus preconditions on `partner_stations` and role `partner_runtime`; its inlined 0047 body
  `ALTER TABLE certificates ADD COLUMN …` and FKs `REFERENCES certificates(id)`.

**The guard was strengthened, never weakened.** The generic classification test is untouched; four
assertions were added — each migration pinned to its scope _and_ to the source property that
justifies it, `requiresCoreSchema()` pinned true for both, and a negative test asserting on
`partnerScopeOnly()` itself so a refactor reading a different source cannot pass the list
assertions while still feeding these files to a partner harness. **20 tests, was 17-with-1-failing.**

### Real PostgreSQL proof for 0090 — `tests/lineage-convergence-0090.test.ts` (NEW, 13 tests)

Drives the **real** runner (`applyMigrations` / `applyScopedMigration` / `listMigrationFiles` /
`loadLineageExclusions` from `scripts/db/migrate.ts`) over the **real** migration bytes with the
**real** `migrations/lineage-exclusions.json`, on a disposable PostgreSQL 17 cluster
(`startPostgres17`, which throws rather than skipping). No parallel migration engine; no assertion
on source strings — every check reads PostgreSQL's own catalogue after the runner finishes.

Every point Terra required, plus two hazards found during the pass:

| Required                                          | Covered by                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| pre-0090 lineage state creatable on disposable PG | staging-lineage fixture + `assertConvergenceAbsent()` anti-vacuity guard                         |
| 0090 applies successfully                         | runner returns exactly `["0090_lineage_convergence_scanner.sql"]`                                |
| intended convergence state exists afterward       | all 4 tables + 2 unique indexes + both `certificates` columns, **plus structural FK assertion**  |
| declared exclusions behave as intended            | 3 declared collisions neither executed nor journalled; staging occupants byte-identical          |
| undeclared identity conflicts still fail closed   | run aborts, journal byte-identical, no half-convergence                                          |
| rerun/idempotent safety                           | journal level (re-applies nothing) **and** SQL level (real bytes replayed with journal bypassed) |

Additional, beyond the brief:

- **Structural FK assertion** — 0090 uses `CREATE TABLE IF NOT EXISTS` and verifies only
  `to_regclass`, so a host carrying the legacy application-boot shape of `scanner_capture_sessions`
  (`server/scanner-capture-service.ts`, `station_id uuid` with no FK) would silently keep a table
  with no `station_id` foreign key and 0090 would still report success. The proof now asserts the
  constraint, not the table name.
- **Apply-order constraint pinned** — `0075_partner_station_single_active_capture` indexes
  `scanner_capture_sessions` with **no `to_regclass` guard**, and sorts ~15 files before 0090. On a
  lineage where 0090 is what delivers that table, an unscoped run dies at 0075 and never reaches 0090. Both the failure and the scoped `--only … --convergence-mode` mitigation are pinned.
- The real declarations are proven **void without their `supersededBy`** migration (run aborts).

Neither hazard is live on staging — verified read-only, see below.

## Gate results (all local, on the final RC)

| Gate                                                                                             | Result                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `tests/migration-scope-contract.test.ts`                                                         | **20 / 20 PASS** (was 17 with 1 FAIL)                                                                             |
| `tests/lineage-convergence-0090.test.ts` (new real-PG proof)                                     | **13 / 13 PASS**                                                                                                  |
| Migration identity / schema-parity / lineage family (9 files incl. the two 0088-affected suites) | **147 / 147 PASS**                                                                                                |
| **Pinned Partner critical gate**                                                                 | **36 / 36 suites — 691 passed / 0 failed / 0 skipped** (identical to the RC baseline)                             |
| **Protected MVGS / grading guards** (7 files)                                                    | **243 / 243 PASS** — identical to baseline; no grading logic touched                                              |
| Scanner / direct-route boundary suites (8 files)                                                 | **62 / 62 PASS, 0 skipped**                                                                                       |
| `npm run check` (tsc)                                                                            | clean, exit 0                                                                                                     |
| `npm run lint` (eslint)                                                                          | **0 errors** (2593 pre-existing warnings, unchanged); the 3 changed files produce **zero** warnings               |
| `npm run build`                                                                                  | green, incl. `dist/migrate.cjs` (205.3 kB)                                                                        |
| `git diff --check`                                                                               | clean                                                                                                             |
| Prettier                                                                                         | all 3 changed files conform; pre-commit hook altered nothing                                                      |
| **Fresh-state PostgreSQL migration proof**                                                       | the critical gate itself — 35 self-provisioning suites each stand up their own PG17 and apply migrations in order |

### Re-gated AFTER the origin/main reconciliation merge

| Gate                                         | Result                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `origin/main` @ `067ed0c6` contained in HEAD | YES                                                                                           |
| `npm run check` (tsc)                        | clean                                                                                         |
| **Protected MVGS / grading guards**          | **243 / 243** — unchanged; engine intact                                                      |
| Migration identity / parity / lineage family | **126 / 126**                                                                                 |
| **Partner critical gate**                    | **36 / 36 suites — 691 passed / 0 failed / 0 skipped** (identical before and after the merge) |
| `npm run lint`                               | **0 errors**                                                                                  |
| `npm run build`                              | green incl. `dist/migrate.cjs`                                                                |
| `git diff --check`                           | clean                                                                                         |
| Density-pass scope guard (de-drifted)        | **8 / 8**                                                                                     |

| Scanner / direct-route boundary (8 files, post-merge) | **62 / 62, 0 skipped** |

### A note on bare `vitest run` in this environment — it is NOT a usable signal here

`docs/partner/RELEASE_MATRIX_AT1_AT23.md` already states bare `npx vitest run` is not trusted for
judging this gate. That held emphatically. Three full-suite runs during this pass produced **three
different failure sets**:

| Run            | Machine load           | Failing files                                   |
| -------------- | ---------------------- | ----------------------------------------------- |
| A (pre-merge)  | moderate               | **7** — exactly the documented pre-existing set |
| B (post-merge) | 60–93                  | 29                                              |
| C (post-merge) | 10 at start, 87 during | 31 — **a different set again**                  |

Three different sets from the same tree is the definition of non-determinism, not regression. Every
failure sampled from B and C **passed on re-run in isolation**: protected MVGS 243/243, a five-file
sample 41/41, a seven-file sample 160/163 (the one straggler,
`scanner-station-capture-boundary`, then passed **12/12 completely alone**).

Root cause is documented in the partner matrix header: vitest shares `process.env` between files in
one worker, and several partner suites assign `MINTVAULT_/PARTNER_*_DATABASE_URL` in their own
`beforeAll`, so two in one worker race each other. That is precisely why every `isolate: true` suite
must be launched as its own vitest invocation — which is what `scripts/ci/run-partner-suite.mjs`
does, and it returned **36/36, 691/0/0** both before and after the merge.

**The authoritative gates are the serialized, isolated ones in the table above.**

### Strict regression comparison (full `vitest run`, both directions)

Bare `npx vitest run` is documented as untrusted for this repo (`docs/partner/RELEASE_MATRIX_AT1_AT23.md`),
so the comparison was run **twice**: once at pristine `e6fd6c5f` (changes stashed) and once on the
final RC.

|               | Pristine `e6fd6c5f`                  | Final RC                                 |
| ------------- | ------------------------------------ | ---------------------------------------- |
| Failing files | **8**                                | **7**                                    |
| Tests         | 4590 passed / 3 failed / 989 pending | **4607 passed / 2 failed / 989 pending** |

- **NEW failures vs baseline: NONE.**
- **FIXED vs baseline: `tests/migration-scope-contract.test.ts`** — exactly the Terra M-1 defect.
- The 7 remaining failures are the identical pre-existing set, untouched by this programme:
  `auth-security-migration`, `rarity-structured-migration`, `release-route-rate-limits`,
  `structured-variant-persistence`, `vq-backend`, `vq-fetch-art-stored-pointer`,
  `vq-higgsfield-observability`.

## Staging

|                                 |                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App                             | `mintvault-v2`, release **v481**, region lhr                                                                                                                                                                                               |
| **Machine 1**                   | **`d8d14d0f34d378`** — started, 1/1 passing                                                                                                                                                                                                |
| **Machine 2**                   | **`8d9349be072948`** — started, 1/1 passing                                                                                                                                                                                                |
| Serving                         | **both machines return `commit: e6fd6c5f`**, pinned per-machine via `fly-force-instance-id` (a bogus instance ID returns 400, so the pin is real)                                                                                          |
| Migration state                 | **54 total / 51 applied / 3 pending** — the 3 pending are exactly the declared exclusions (0044, 0046, 0047), which the runner reports it will EXCLUDE. Steady state, as designed.                                                         |
| Exclusions in the running image | **runtime-verified on both machines**: `/app/migrations/lineage-exclusions.json` present, sha256 `f2a1c051ff397e0b5898c5e5418e327f9b1cd5e97ca66eaa3dce0f84bd3fa920` — **byte-identical to the repo file**; `/app/dist/migrate.cjs` present |
| F3/F4 hazards                   | **neither is live here**: 0075 is already applied (not in pending), and `scanner_capture_sessions_station_id_fkey` **exists**                                                                                                              |
| **Rollback image**              | `mintvault-v2:deployment-01KZS6T26VCWE51V0VP7VFV765` (`c788fa68`, single-machine era — **scale to 1 machine first**)                                                                                                                       |

Staging serves `e6fd6c5f`, not the final RC SHA. Since this pass changed only `tests/`, the runtime
artifact is identical and the AT-23 evidence stands. Redeploying staging is optional, not required.

## Production — **THE PRIOR RECORD WAS WRONG**

|                     |                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------- |
| **Actual**          | **v1082 / `839edd9c`**, both machines (`683720eb5127d8`, `83d479c745d0d8`) started 1/1 |
| Previously recorded | v1075 / `1dec8dbf` — **stale by 7 releases / 23 commits**                              |
| Verified by         | `curl https://mintvaultuk.com/api/version` → `{"commit":"839edd9c"}`                   |

Production was **not touched** by this task or by this RC. It moved v1076–v1082 across 2026-08-12
and 2026-08-14 (latest ~14:16 UTC, ~90 minutes before this freeze) via **concurrent sessions**,
while this task's records stayed frozen. The defect is in the record, not the estate.

**This is safe in the important direction:** `git merge-base --is-ancestor 839edd9c HEAD` = 0, so the
RC **strictly contains live production**. Live prod is byte-identical to `origin/main`. There is no
divergence and no clobber risk.

## Remaining MEDIUM / LOW

| ID        | Sev                                          | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AT23S-F1  | MEDIUM                                       | Staging `STRIPE_SECRET_KEY` is an EXPIRED test key. Webhook flows are unaffected (local signature verify, no Stripe API callback). Rotate at leisure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| RC-F1     | **HIGH (record)**                            | Prod release record was 23 commits stale. Corrected here; `deployment-state.md`, `rollback.md` and the `project_prod_release_1dec8dbf` memory note still need updating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| RC-F2     | **HIGH (process)**                           | **The RC exists only on local disk.** `git ls-remote origin 'refs/heads/codex/partner-pilot-pass2'` is empty — never pushed, so no CI run, no PR, no off-disk copy. Note `safe-deploy` GUARD 1/1L/1M all compare against `origin/main` and the live commit, both ancestors of HEAD, so **an unpushed RC would pass every existing guard**. Pushing is owner-gated and was NOT performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RC-F3     | MEDIUM                                       | `rollback.md` pins `b0de0880`, now 22 commits behind live prod; following it literally would remove server-authoritative grading, rate-limit hardening and the 0074 reconciliation from production. Correct target is now `839edd9c` / v1082.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RC-F4     | MEDIUM                                       | 6 of 12 new migrations have no rollback script (0080–0083, 0088, 0089). All additive; 0090 is deliberately forward-only. Either author them or state explicitly that 0079–0090 are not reverted and the previous release must tolerate the new schema — that tolerance is the claim needing proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| RC-F5     | MEDIUM                                       | `/api/partner` is **mounted on production today** (`/api/partner/me` → 401; a fake non-partner path → 404). The memory note recording prod 404 / surface-absent is stale. 401 proves mounting, not enablement — the flag state needs an owner-gated config read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DB-F3     | MEDIUM                                       | 0075 apply-order hazard (pinned by test). Not live on staging. Matters for a rebuilt or newly-forked staging-lineage estate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| DB-F4     | LOW                                          | 0090's `IF NOT EXISTS` + `to_regclass`-only verification could silently no-op over a legacy table shape (pinned by the new FK assertion). Not present on staging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DB-F5     | LOW                                          | 0090's MFA verification matches `pg_proc.proname` only — any `partner_auth_lookup` signature satisfies it, unlike 0073 which checks the projection. Cannot be fixed without editing applied migration bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **RC-F7** | **MEDIUM (protected grading, PRE-EXISTING)** | `tests/structured-variant-persistence.test.ts` test 22 is RED, and was RED at pristine `e6fd6c5f`. **Root cause found, and it is a one-line omission — not an unauthorised grading change.** There are two copies of the same `server/grader.ts` founder-signature guard: `variant-line-consolidation.test.ts` carries signatures **A–G** and passes; `structured-variant-persistence.test.ts` carries **A–F** and fails. Commit `90fc4290 test(mvgs): register founder-authorised signature G for the Card Job QA hooks` registered G in **one file only**. The RC's grader delta (+57/−4, from `73b2072e` Card Job → canonical grading bridge and `f35d8456`) matches G. **The founder authorisation exists; it was applied to one of two identical guards.** Deliberately NOT fixed here — propagating a founder signature on a protected grading guard is owner territory, not something I may self-grant. |
| RC-F8     | LOW (fixed)                                  | PR #299 shipped a scope guard using `git diff --name-only origin/main` — vacuous on main (empty diff → loop never runs) and false-tripping on any branch with unrelated work. Identical to the defect `tests/helpers/grading-release-scope.ts` documents for PR #214. De-drifted to the pass's own immutable range `839edd9c..144fffa8` (`524a79fc`), made fail-closed; the seven current-code geometry assertions untouched. 8/8 green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Zero BLOCKER. Zero HIGH in code.** The two HIGHs are process/record defects, not defects in the
software.

## Owner-gated actions (NOT performed)

1. `git push` of `codex/partner-pilot-pass2` + PR at the exact RC SHA (closes RC-F2)
2. Production migration plan — 12 migrations over prod's 0078 high-water. **Migrations must precede
   the deploy** (PR #258 precedent). Production's journal must be diffed **by number** independently:
   staging's successful run is _not_ proof for production, because the exclusion declarations name
   _staging's_ occupants and will correctly not match prod's journal.
3. Production deploy of the RC
4. Production `STRIPE_WEBHOOK_SECRET`
5. Staging Stripe test-key rotation (AT23S-F1)
6. Correcting `deployment-state.md` / `rollback.md` / memory to v1082 / `839edd9c`
7. Scanner packaging; physical Pilot Shop 0 certification

## 5,000-shop scale

**NOT RUN.** No load test was executed in this pass or the previous one. `scripts/load/` exists in the
sibling worktree but has not been exercised against this RC. Concurrency correctness is proven
(P13 suite: 12 simultaneous presses, same-op-id idempotency, 8 graders racing one card, cross-tenant
isolation under load) — that is _correctness_ under concurrency, not _throughput_ at 5,000 shops.
