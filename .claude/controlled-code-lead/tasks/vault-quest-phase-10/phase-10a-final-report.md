# Phase 10A — Final verification report

**Program:** Vault Quest production integration & hardening (10A local wiring → 10B staging → 10C prod).
**Branch:** `vault-quest-phase-10`. **Date:** 2026-07-13. **Prepared by:** Lead session, controlled-code-lead v1.1.
**Status:** 10A-0 through 10A-8 complete, committed locally. `main` untouched. Nothing pushed or deployed.

---

## 1. Scope & purpose

This report closes out Phase 10A — wiring the previously-unwired Vault Quest Phase 1–8 substrate
(durable exports, spend controls, provider-status honesty, feature kill switches, observability,
immutable artwork revisions, reconciliation tooling, and a B2 backup framework) into real, tested,
locally-verified code, entirely on an isolated local branch and an isolated local Postgres instance.
It supersedes the interim [verification-10A-0-to-2.md](verification-10A-0-to-2.md) report, which
covered only the first three subsystems.

## 2. Branch & commit inventory

| Commit    | Date       | Subject                                                                      |
| --------- | ---------- | ---------------------------------------------------------------------------- |
| `169366a` | 2026-07-11 | Phase 10A-0 — VQ integration prerequisites and schema safety                 |
| `fb89bb7` | 2026-07-11 | Phase 10A-1 — Durable Vault Quest exports (state in Postgres, bytes in R2)   |
| `4cd8fb4` | 2026-07-11 | Phase 10A-2 — Spend controls on paid Vault Quest generation (PROV-07)        |
| `8bdaffd` | 2026-07-11 | Phase 10A verification — corrective fixes for 4 verified review findings     |
| `3224188` | 2026-07-13 | Phase 10A D10 — Double-pay / idempotency protection for paid VQ generation   |
| `41873a7` | 2026-07-13 | Phase 10A-3 — Honest Higgsfield provider status                              |
| `7c83ea2` | 2026-07-13 | Phase 10A-4 — Emergency feature kill switches wired live                     |
| `7f58a92` | 2026-07-13 | Phase 10A-5 — Bounded ops status + the owner's feature-flag toggle           |
| `5b2e3b4` | 2026-07-13 | Phase 10A-6 — Immutable artwork revisions + stored-pointer readers           |
| `fff857c` | 2026-07-13 | Phase 10A-7 — Reconciler backup-failure detection + R2-identity confirmation |
| `11b308b` | 2026-07-13 | Phase 10A-8 — Isolated VQ B2 backup worker + deploy-time DB runbook          |

11 commits, all local-only, all on `vault-quest-phase-10`. Branch point: `main` = `a35ee46`
(unrelated commits landed on `main` between sessions — label-fix work, not touched by this program).

## 3. Program timeline

Started 2026-07-11 with a 3-reviewer investigation (exports, idempotency/spend, provider/feature-
controls/observability, revisions-backup, reconciliation-migration-rollout — 6 read-only reviewers
total across the two investigation rounds). Findings recorded in [issue-register.md](issue-register.md).
Implementation proceeded subsystem-by-subsystem per [proof-map.md](proof-map.md), one commit each,
full gate suite after every commit. A session-boundary pause mid-10A-6 for an owner-requested,
strictly read-only reconciliation review of a concurrent branch (`fix/vq-higgsfield-cloud-key`) is
covered in §15 below; all other work resumed exactly where it left off with zero rework.

## 4. Governance compliance statement

Every subsystem in this phase was implemented under controlled-code-lead v1.1: investigation before
edits for anything touching readers/writers of existing data (10A-6 explicitly); a durable proof-map
entry per subsystem naming its evidence; `.claude/governance-tests/run-all.sh` green (4/4) after every
commit; no protected action (push, deploy, staging/prod migration, secret rotation, destructive SQL)
taken without being either explicitly out-of-scope-and-refused or explicitly owner-authorised in the
task ledger. The advisory protected-action hook remained warn-only throughout, as documented; nothing
in this phase required overriding it.

## 5. Subsystem — 10A-0: integration prerequisites

Migrations 0012 (export job `ids`/`attempt_count`)/0013 (`vq_config`) authored and applied to the
**local throwaway Postgres only**. `resolveVqCeilings`, `checkR2Identity` (first version), the 7-state
provider-status enum, and a `tablesFilter` on the grading `drizzle.config.ts` (so a stray `db:push`
can no longer drop `vq_` tables) all landed here. 35 targeted + 437 full tests green at the time.

## 6. Subsystem — 10A-1: durable exports

`export-job-store.ts` (DB + R2 adapter, safe/42P01 degrade) replaces process-local export state.
Idempotent create, atomic single-winner claim, cross-"machine" visibility, counts-derived
partial/failed classification, cancel. Deferred to 10B (needs real 2-machine staging): multi-machine
routing for real, streaming-multipart upload, an active lease-reclaim scheduler (columns exist, no
cron wired).

## 7. Subsystem — 10A-2 + verification corrective: spend controls

`generation-guard.ts` — pre-provider spend gate (config ceilings + live hourly/daily windows) wired
into all 4 paid routes before any Higgsfield call. The 2026-07-11 3-reviewer pass caught and a same-
day corrective commit fixed 4 real defects before they could ship: a 42703 partial-migration crash
(R2-F1), a 6.67× spend undercount on the identity-lock upgrade path (R1-F2), uncounted master-retry
provider calls (R1-F1), and a stray `db:push` blast-radius gap closed by the grading `tablesFilter`
(R3-F1). Deferred at the time: double-pay/idempotency protection — closed two days later by D10 (§8).

## 8. Subsystem — D10: double-pay / idempotency protection

Wired the already-built Phase 7B `generation-idempotency.ts` + `vq_generation_requests` table (no
new migration — existing schema had every needed column) into all 4 paid routes: reserve after the
spend gate, before any provider call; finalize on every exit path. Client mints a per-action key
persisted in `localStorage`, survives reload, shared across tabs, cleared on any terminal response.
6-concurrent-identical-POST test proved the provider is called exactly once; distinct keys charge
independently; replay after completion makes zero new calls. Documented residual: the client→server
hop itself dropping (not the provider hop) can still double-charge on a manual retry after a lost
response — explicitly out of the owner's stated scope, noted for completeness.

## 9. Subsystem — 10A-3: honest Higgsfield provider status

`recordHiggsfieldOutcome`/`getLastHiggsfieldOutcome` wired into every real network-outcome branch of
`generateHiggsfieldArtwork`. `imageProviders()` now derives status from an **observed** outcome
instead of env-presence — an expired token can no longer show green. Found and fixed, mid-phase, that
the local throwaway Postgres had been wiped by a system restart; recreated and re-verified schema-
identical before continuing. Documented a test-infra finding (not a product defect): the full suite
under vitest's default parallel-file execution intermittently false-fails 1–2 integration files on a
shared-table race; `--no-file-parallelism` is the confirmed, reproducible fix, used for every gate run
since.

## 10. Subsystem — 10A-4: emergency feature kill switches

`vq-feature-flags-store.ts` (env hard-off > DB toggle > default-on) + one global `vqWritesGate`
covering every mutating VQ route, plus narrower `generation`/`exports` gates on the paid/export
routes specifically (an operator can freeze just spend, or just exports, without freezing card
edits). Composed into 10A-3's status derivation (`disabledByOwner`).

## 11. Subsystem — 10A-5: bounded observability + the owner's toggle

`GET /ops/status` composes feature flags, provider status, spend snapshot, and export-job counts into
one bounded aggregate (GROUP BY counts, never a row dump). Added the missing `POST
/ops/feature-flags/:feature` toggle route — deliberately exempted from the 10A-4 writes-gate so an
emergency freeze can never trap the owner out of un-freezing it. A route-level test caught a **real
bug before it shipped**: Express strips the mount prefix from `req.path` inside a prefix-mounted
middleware, so the exemption's path comparison silently never matched; fixed and proven with a
freeze→confirm-blocked→un-freeze→confirm-unblocked test.

## 12. Subsystem — 10A-6: immutable artwork revisions + stored-pointer readers

The highest-risk subsystem this phase — it changes how existing artwork is resolved and displayed,
so it ran investigation-first per explicit instruction. Mapped every write path (card
`promoteArtworkCandidate`, the direct-upload route, all 3 character approve routes) and every reader
(`fetchArt`/`renderSavedFromStudio` — covers single/batch/family/export/proxy in one seam; the
admin-preview thumbnail route, a second reader the initial pass would have missed) before editing
anything. New append-only `vq_artwork_revision_events` audit table (migration 0014) plus
`vq-artwork-revisions-store.ts`: upload-then-one-transaction promotion (deactivate old, insert new
active, flip the entity's own pointer column, log audit events — all four together or none), with the
existing partial-unique `is_active` index as the sole concurrency guarantor (proven via a 6-way
concurrent-promotion test: exactly one winner, no split-brain). Rollback (`restoreArtworkRevision`)
hash-verifies the target's bytes before touching anything and fails safely on a missing or corrupted
asset. Fixed a real client-trust gap discovered mid-implementation: the `/cards` save route was
falling back to the raw client-echoed `artR2Key` when no new candidate was promoted that save — fixed
to a server-authoritative 3-way fallback (fresh promotion → existing DB row → the ledger's own active
key) that closes both a trust-boundary concern and a correctness bug (a real revisioned pointer being
silently discarded on the next save). 24 new tests across 3 files, including an explicit before/after-
migration proof that a legacy card serves identical bytes unchanged.

## 13. Subsystem — 10A-7: reconciliation tooling hardening

R6-F1 (R2-identity guard on the orphan-reconciliation CLI) was confirmed **already wired** from
10A-0 — no code change needed, verified by reading the call site. R6-F3 (backup-failure detection,
previously invisible to the reconciler): `reconcile-logic.ts` gained a `revisions` input and two new
categories — `backup_failed` (a new `BACKUP_FAILURE` class, deliberately kept separate from
`INTEGRITY_FAILURE` because a failed off-site backup does not mean the live artwork pointer is
broken) and `active_revision_missing_object` (`INTEGRITY_FAILURE` — an active pointer resolving to
nothing IS broken live artwork; historical/inactive revisions missing their object are expected and
not alarmed on). The CLI degrades cleanly via the established 42P01/42703 pattern when the ledger
table isn't migrated yet. Still strictly detection-only; deletion remains a separate, unbuilt, owner-
gated step, unchanged since Phase 7E.

## 14. Subsystem — 10A-8: isolated B2 backup framework

R5-F4: a net-new `vq-b2-backup.ts` + CLI, sharing zero code with the grading/cert cold-archive worker
beyond the generic S3-compatible clients. Every key is asserted via the pre-existing (Phase 7D)
`assertVqBackupKey`, which accepts only approved VQ artwork keys and rejects candidates/grading/
traversal by construction — proven with a test that seeds a grading-shaped key directly into the
ledger and confirms B2 is never called. Idempotent (existsInB2 short-circuits), integrity-verified
before upload (a hash mismatch marks the row failed rather than archiving corrupt bytes), copy-only
(no deletion). The CLI is dry-run **by default** (the opposite default from the read-only 10A-7
reconciler, because this one writes) and is not wired into any automatic cron — a deliberate scope
boundary pending owner approval to schedule it. R5-F5 (UNPOOLED Neon host + `search_path=public` at
deploy time) is now written into [deployment-state.md](deployment-state.md) as a concrete pre-deploy
checklist tied explicitly to this worker's writes — carried over from prior session memory, not
re-provable locally, flagged as a 10B/staging-deploy gate rather than silently assumed.

## 15. Concurrent-branch reconciliation outcome

Mid-10A-6, the owner paused all work for a strictly read-only reconciliation review of
`fix/vq-higgsfield-cloud-key` (commits `eee735e`/`4683fa8`/`7972a38`, unrelated provider work). Using
a pre-existing worktree (never creating a new one), the review found exactly ONE shared file
(`server/vault-quest/ai/higgsfield.ts`), proved via `git merge-tree` to merge with zero conflicts, and
concluded both commits **safely complement** all 4 named Phase 10A commits at the time (D10, 10A-3,
10A-4, 10A-5). Two reconciliation notes were raised (duplicate `AdapterStatus`/`HiggsfieldStatus` type
unions, duplicate `GenerationState`/`VqGenerationState`, two different kill-switch env var names) and
carried forward as the 12-item provider-integration requirements list (§16). Independently reran tests
on both trees at the time (this branch: 537/537 with DB; theirs: 478/502, tsc clean, build clean). Per
the owner's explicit resume instructions, `eee735e`/`4683fa8`/`7972a38` remain isolated and untouched
throughout 10A-6/7/8; no merge, cherry-pick, or reconciliation branch was created; `@higgsfield/client`
was not added; Higgsfield Cloud was not contacted, activated, or funded.

## 16. Provider-integration requirements carryover (still pending, tracked)

Recorded in full in [provider-integration-requirements.md](provider-integration-requirements.md) for
whichever future task actually integrates the two branches. Unchanged by this report — none of these
12 items were in scope for 10A-6/7/8 and none were touched:

1. One canonical shared provider-status type (not both `AdapterStatus` and `HiggsfieldStatus`).
2. One canonical shared generation-state type (not both `GenerationState` and `VqGenerationState`).
3. Keep `VQ_GENERATION_DISABLED`; do not introduce `VQ_DISABLE_PAID_GENERATION`.
4. Every future Cloud provider call threads through the existing D10 idempotency reservation.
5. Every future Cloud provider call threads through the existing spend ceilings + actual-call accounting.
6. Legacy remains the default provider.
7. Cloud must never auto-activate or operate as a hidden fallback.
8. Cloud must remain blocked at zero balance.
9. Cloud activation requires explicit founder approval.
10. Runtime balances must never be hardcoded.
11. Identity-lock/reference-image capability requires staging proof before Cloud is production-capable.
12. (Reconciliation notes) resolve the duplicate type/env-var pairs named above before wiring proceeds.

## 17. Consolidated test / build / lint / governance evidence

- **tsc:** clean across every subsystem, re-confirmed after 10A-8's final commit.
- **Full Vitest with local DB (sequential, `--no-file-parallelism`):** **574/574 passed**, 42 test
  files, 0 failures. Breakdown by subsystem is in [proof-map.md](proof-map.md).
- **Full Vitest without DB:** 492 passed, 82 correctly skipped (DB-gated), 0 failures.
- **ESLint (full repo):** 4454 problems (1633 errors, 2821 warnings) — stable since 10A-6; the +2
  over the pre-10A-6 baseline of 4452 are sanctioned `require()`-in-mock-factory patterns (identical
  across every integration test file that mocks `server/db`), not new defects. 0 new errors introduced
  by 10A-7 or 10A-8.
- **Build:** clean (`npm run build`) after every commit, most recently post-10A-8.
- **Governance self-tests:** `.claude/governance-tests/run-all.sh` — 4/4 suites passed after every
  commit this phase.
- **Secret scan:** 0 hits across every commit's diff (checked for `sk_live_`, `oat_` tokens, PEM
  blocks).

## 18. Security & isolation guarantees

- **Grading/certification isolation:** every VQ table, key prefix, and route this phase is additive
  and `vq_`/`vq/`-scoped; the grading `drizzle.config.ts` `tablesFilter` (10A-0/R3-F1) makes a stray
  `db:push` non-destructive to `vq_` tables. No grading, certification, payment, or production grading
  code was touched by any 10A commit.
- **Key-space guards:** `assertVqReadKey`/`assertVqWriteKey` (all VQ R2 access) and `assertVqBackupKey`
  (10A-8's B2 worker) all reject traversal, control characters, and any non-`vq/`-approved-artwork
  shape by construction — proven with dedicated tests in each subsystem, not asserted by convention.
- **Client-trust boundary:** 10A-6 closed a real gap where a save route could fall back to a raw
  client-echoed R2 key; every artwork pointer now resolves from server-authoritative sources only.
- **Concurrency:** the DB's own partial-unique index (`vq_artwork_revisions_active_uq`), not
  application-level locking, is the sole guarantor against split-brain active-revision state — proven
  with 6-way concurrent-promotion tests.
- **Provider spend:** every paid route is gated by ceilings + idempotency reservation **before** any
  Higgsfield call; the 10A-4 writes/generation/exports kill switches sit in front of all of it.

## 19. Migration inventory & idempotency proofs

`migrations-vq/` now holds 0000–0014. This phase authored and **local-only** applied 0012
(export job `ids`/`attempt_count`), 0013 (`vq_config`), and 0014 (`vq_artwork_revision_events`) —
0008–0011 were already applied to the local throwaway DB and to STAGING (`ep-purple-voice`) from
Phase 8A, per [deployment-state.md](deployment-state.md). Every migration this phase is additive,
FK-free, and reapply-idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`);
migration 0014 was explicitly reapplied 3× locally with identical resulting schema. Relevant CHECK
and partial-unique constraints (`vq_artwork_revisions_active_uq`, `entity_type`/`action`/
`backup_state` CHECKs) were proven firing, not merely present. **None of 0012/0013/0014 have been
applied to staging or production** — that is explicitly 10B/10C scope.

## 20. Known deferred items / residual risk register

Carried forward, unchanged, from the interim report and subsequent subphases:

- Real 2-machine staging proof for durable exports (INFRA-01 end-to-end) — needs a deployed
  multi-machine environment, not provable locally.
- An active lease-reclaim scheduler for stuck `processing` export jobs (columns exist, no cron).
- The client→server-hop-drop double-charge residual noted in D10 (§8) — explicitly out of the
  owner's stated idempotency scope.
- Legacy flat-key artwork has no revision row/hash (10A-6, P10-R5-F3) — reads keep working via the
  stored-pointer fix; a staging backfill plan for retroactive revision rows remains unbuilt.
- Deletion in the orphan reconciler (10A-7) remains unbuilt and owner-gated, unchanged since Phase 7E.
- The 10A-8 B2 worker is not scheduled on any cron — manual invocation only until the owner approves
  automation.
- R2/B2 staging-vs-prod bucket identity remains UNCONFIRMED (a 10B gate, not something this phase
  could resolve without touching real infrastructure).
- The 12-item provider-integration requirements list (§16) is fully open — no code in this phase
  touches the Higgsfield Cloud path.

## 21. Deploy-time gates (do not skip before 10B/10C)

1. **UNPOOLED Neon host + `search_path=public`** for any process that writes `vq_` tables (R5-F5,
   §14) — the deployed app currently reads the SAME `MINTVAULT_DATABASE_URL` as grading; there is no
   separate `VAULT_QUEST_DATABASE_URL` wired outside the still-unmerged `vq-infrastructure-separation`
   branch.
2. **R2/B2 bucket identity** must be explicitly confirmed against the target environment before any
   reconciler or backup-worker run — both CLIs fail closed without an explicit `--r2=<bucket>` match.
3. **Migrations 0012/0013/0014** must be applied to staging, then production, before any of D10,
   10A-3/4/5's DB-backed pieces, or 10A-6/7/8 can activate there — none are applied outside local yet.
4. **Multi-machine export routing and lease-reclaim** need a real 2-machine deploy to prove — cannot
   be closed by any local or single-process test.
5. The B2 worker and the orphan reconciler both require the operator to pass explicit flags
   (`--live`, `--r2=`, `--prod`) — there is no implicit "safe" default that lets either run
   unattended against a real environment yet.

## 22. What was explicitly NOT done this phase

- `main` was not touched, merged into, or rebased. Currently `main` = `a35ee46`.
- Nothing was pushed to any remote.
- No deploy (staging or production) was performed or attempted.
- No migration was applied to staging or production — local throwaway Postgres only.
- No secret, credential, or environment variable was rotated, displayed, or logged.
- `fix/vq-higgsfield-cloud-key` (`eee735e`/`4683fa8`/`7972a38`) was not merged, cherry-picked, or
  manually ported from; it remains isolated and untouched.
- `@higgsfield/client` was not added to this branch.
- Higgsfield Cloud was not activated, funded, test-called, or contacted in any way.
- No reconciliation branch was created.
- No grading, certification, payment, or production grading-data code was modified.

## 23. Recommended next steps (10B)

1. Provision (or confirm) the dedicated VQ Neon database on the UNPOOLED host, per §21.1, ideally
   via the already-authored `vq-infrastructure-separation` branch rather than continuing to share
   grading's connection string.
2. Apply migrations 0012–0014 to staging (`ep-purple-voice`), re-verify schema + constraint proofs
   there (the same 14/14-style check used for 0008–0011 in Phase 8A).
3. Confirm R2/B2 bucket identity for staging vs. production explicitly (currently unconfirmed) before
   running either the 10A-7 reconciler or the 10A-8 backup worker against a real bucket.
4. Deploy to a genuine 2-machine staging environment to close the INFRA-01 multi-machine proof for
   durable exports, and to observe the lease-reclaim gap under real conditions.
5. Only after 1–4: consider scheduling the 10A-8 B2 backup worker on a cron, and separately, begin
   the Higgsfield Cloud provider-integration task against the 12-item requirements list in §16 —
   both remain explicitly gated on owner approval, not automatic follow-ons to this report.
