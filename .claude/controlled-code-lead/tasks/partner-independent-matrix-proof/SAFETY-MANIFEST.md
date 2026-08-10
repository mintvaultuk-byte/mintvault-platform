# Phase 0 — Freeze & Safety Manifest

**Task:** Independent Matrix A/B assurance for PR #288
**Branch:** `opus/partner-independent-matrix-proof`
**Worktree:** `/Users/cornelius/mintvault-independent-matrix-proof` (new, isolated; the PR #288
worktree at `/Users/cornelius/mintvault-partner-grading-bridge-current-main` is untouched)
**Date:** 2026-08-07

---

## Commit lineage

| Item | Value |
| --- | --- |
| Base SHA (PR #288 head) | `f6b840fe38e6cc9bde196993b1edec99fa491ec8` |
| PR #288 state | OPEN, `codex/partner-grading-bridge-current-main` → `main`, head = base SHA, MERGEABLE |
| Mutation-evidence commit | `5889d4109c5693a05473a9f55973f666faeb392c` — verified a DIRECT descendant of the base SHA, adding exactly one file (`.claude/.../partner-mutation-matrix-final/MUTATION-MATRIX.md`, +121 lines) and no code |
| Branch start point | `5889d410` — so the base SHA **and** the mutation evidence are both preserved by construction, with no cherry-pick and no possibility of divergence |
| Worktree at start | `git status --porcelain` empty |

## Protected systems — byte-identical freeze

Recorded at Stage 0; re-verified at Stage 7. `server/grader.ts` is **not to be modified** and MVGS
is **not to be altered** by directive.

| File | SHA-256 at freeze |
| --- | --- |
| `server/grader.ts` | `32b57f7e49de7f77fa1f9209b58c52c4fba34f7b81f594694b06e8c8adde439d` |
| `shared/mvgs-scoring.ts` | `2e59035285773c890a60fa159a34cbe2a7201e0cc10f255e425b5acaadfe25e6` |
| `shared/centering.ts` | `ee8c3b4f011a967b80b2b81fcf2c67df1da66fd8f29554f559c5a0bbe7384b1c` |
| `shared/pristine.ts` | `3b8251d57647fb0fb6b770c7d906f84e1a3b75877f3d83768f56606d15d798c8` |
| `shared/mvgs-input-builder.ts` | `23b999dfafd76c1123e0eac8c1bc5076d796c6700d02a3c98184c90771a26f3d` |
| `server/mvgs-scoring.ts` | `a5b5a580e467bc0d388af9815fff4c3caa09f076eb340ce7b4519f05eb8472f7` |

`server/grader.ts` matches the hash the previous mutation-matrix task froze and restored, so the
file has not moved between the two tasks.

## Migration state

| Item | Value |
| --- | --- |
| Migrations in `migrations/` at base | 84 `.sql` files |
| Migration 0045 | `0045_partner_grading_work_items.sql`, SHA-256 `a0f4ed4222d7fece726d7c50abc2ddade2647260b491e4feeda4aa67a71c5884` |
| 0045 rollback script present | `migrations/rollback-0045-partner-grading-work-items.sql` |

## Staging — read-only verification (no writes performed)

Queried through the local `.env` connection (`ep-purple-voice-…`, database `neondb`, role
`neondb_owner`) with plain `SELECT`s only. No `SET`, no DDL, no DML.

| Check | Result |
| --- | --- |
| Applied migrations on staging | 36 |
| Rows for `0045%` in `schema_migrations` | **none** — 0045 is NOT applied |
| `to_regclass('public.partner_grading_work_items')` | `null` — the table does not exist on staging |
| Latest journalled migration | `0046_partner_mfa_pending_lifecycle.sql` |

**0045 is unapplied to staging and will remain so — this task applies it only inside disposable
loopback containers.**

> **Observation carried forward (out of scope, not acted on):** staging has journalled
> `0046_partner_mfa_pending_lifecycle.sql`, while the primary working tree carries an *untracked*
> `migrations/0044_partner_mfa_pending_lifecycle.sql` and PR #288 uses `0044` for
> `partner_submission_lifecycle_and_location_snapshot`. That is a cross-branch migration-number
> collision on a different branch. It is recorded here, not fixed here.

## Production — read-only verification

`GET https://mintvaultuk.com/api/version` → `{"build":"MV-P5-20260225-nohalf","commit":"6f182624",…}`.
Unchanged. **No production action of any kind is performed by this task.**

## Concurrency

| Check | Result |
| --- | --- |
| Concurrent writer in this worktree | none — dedicated worktree created for this task |
| Running `vitest` / `run-partner-suite` processes at freeze | none |
| `node_modules` | APFS clone of the PR #288 worktree's tree (identical `package-lock.json`, SHA-256 `863088bb…`); a **private directory**, not a symlink into another checkout, so no other session can mutate it underneath a run |

### Pre-existing disposable containers stopped (recorded so they can be restored)

`mv-ci-pg16` (:55432), `mv-ci-pg17` (:55433) and `mv-minio-proof` (:9010) were left running by the
earlier mutation-matrix session. Port 55432 is **hard-pinned by 27 test files**, so Matrix A cannot
start while it is held. They were `docker stop`ped (not removed) after confirming no test process
was running and only this session's own probe was connected. They are restarted at the end of this
task.

`mv0045base` (:55500) and `mv0045audit` (:55499) were left running; neither port collides with
Matrix A (55443/9020) or Matrix B (55453/9030), so they were not touched.

## Scope

**In scope:** provisioning two independent disposable environments, running the critical Partner
assurance matrix twice, classifying the five surviving mutations, adding behavioural tests where a
genuine coverage gap is proven, and running the full local gates.

**Prohibited for this task, and not performed:**

- no deploy, no `fly` command of any kind
- no merge, no push to PR #288
- no application of migration 0045 (or any migration) to staging or production
- no production read beyond the public `/api/version`, no production write
- no modification of `server/grader.ts`
- no MVGS alteration
- no weakening of any guard
- no dependency install, no secret change

## Files changed outside tests/evidence (declared up front)

| File | Change | Why it cannot be avoided |
| --- | --- | --- |
| `scripts/ci/partner-suite-env-matrix.mjs` | `CLUSTERS` port/user/password and a database-name prefix become **optionally** overridable via `PARTNER_MATRIX_*`; defaults unchanged | The matrix runner hard-codes `127.0.0.1:55433` and `postgres:postgres`. Two runs cannot be independent while both are pinned to one cluster and one login role. The host is deliberately **not** overridable and `assertDisposable()` still validates the result, so the override can never move the target off loopback. With no override set, `urlFor()` returns byte-identical URLs to before. |
| `scripts/ci/run-partner-suite.mjs` | `recreateDatabase()` now drops/creates through `databaseName()` | Without it the runner would drop the *unprefixed* database while the suite connects to the prefixed one — a silent stale-state bug. |
