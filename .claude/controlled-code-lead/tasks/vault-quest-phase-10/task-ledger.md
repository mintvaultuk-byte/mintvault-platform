# Task ledger — vault-quest-phase-10

Program: Vault Quest production integration & activation (10A local wiring → 10B staging → 10C prod).
Governs under controlled-code-lead v1.1 (Phase-9-stabilised). NOT an inline-only ledger.

## Stage 0 — Baseline (recorded 2026-07-11)
- Repo: `/Users/cornelius/mintvault-platform`
- Session branch at recovery: `governance-phase-9` @ `cc7fd4b`
- Governance: v1.1; lock-set snapshot MATCH `894db0d2…` (no drift). Reviewer isolation ACTIVE
  (allowlists clean + last session's behavioural Write-probe proof).
- **VQ baseline commits verified present:** 1a2aeac…6439350 (Phases 1–7E on main),
  32f3f2b (8A on `vq-phase8-staging-integration`), cfe775a/2d98e38/cc7fd4b (Phase 9 governance).
- **Production commit:** `main` = `6439350` (Phase 7E); prod runs OLDER VQ behaviour; nothing
  from Phase 7/8 is active in prod.
- **Staging branch:** `vq-phase8-staging-integration` (`32f3f2b`) — migrations 0008–0011 APPLIED
  to the STAGING DB (`ep-purple-voice`) + schema-verified 14/14 (Phase 8A). NOT prod.
- **Current migrations:** 0008–0011 authored; applied to STAGING only.
- **Test count:** 427/427 Vitest.
- **KNOWN STATE — VERIFIED (not trusted):** the entire Phase-7 substrate is UNWIRED on the VQ
  branch — export-jobs not DB-backed; no generation route imports idempotency;
  no feature-flag guard mounted; approval does not use immutable revisions; higgsfield.ts does
  not import provider-status. Helpers/schemas exist; protections are NOT active.
- **Local .env DB identity:** STAGING (`ep-purple-voice`). Local Postgres `pg_ctl` present; no docker.

## PROTECTED / NOT AUTHORISED this phase (10A)
push to main; deploy (staging or prod); apply any migration (staging/prod); rotate/display
secrets; provision R2/B2; spend Higgsfield credits; mutate staging or production; activate any
production feature; complete 10B/10C.

## LOAD-BEARING DECISIONS (owner) — blocking the start of VQ implementation
### D1 — Branch strategy (the substrate and the governance are on divergent branches)
The Phase-7 substrate + 8A migration evidence live on `vq-phase8-staging-integration`; the
stabilised governance lives on `governance-phase-9`; both diverge from `6439350`. They cannot
both be present in one working tree without integration, and checking out the VQ branch STRIPS
the Phase-9 governance files from the tree. Options:
- **(A, recommended)** merge `governance-phase-9` → `main` (owner-authorised), then create
  `vault-quest-phase-10` off a base that carries governance + the 7E substrate, and bring 8A's
  migration-evidence forward. Clean single line; governance version-controlled on main.
- (B) create a Phase-10 integration branch that merges `vq-phase8` + `governance-phase-9`
  (mixes governance into VQ work — the owner said keep separate; only with explicit OK).
- (C) keep strictly separate: VQ code on a branch off `vq-phase8`, governance stays session-loaded
  only — but then the improved hook/agents/task-infra are absent from the working tree (regresses
  the Phase-9 win; risky mid-session).
### D2 — Local verification approach (local .env = STAGING)
Running wired DB-backed code locally writes to STAGING = prohibited. Real "locally verified"
therefore needs one of: **(a, recommended)** a throwaway LOCAL Postgres (`pg_ctl` present) that a
test env points at — genuine integration proof, zero staging impact; or **(b)** pure + mocked
tests only (achievable now, but proves logic, not the wiring against a real DB — must be honestly
labelled `Implemented`/`Locally verified (mock)`, never staging proof).

## Owner decisions applied (2026-07-11)
- **D1 branch:** created `vault-quest-phase-10` off `governance-phase-9` (cc7fd4b) + cherry-picked
  8A (32f3f2b → `01210bd`, clean, no conflict). Verified: governance Phase 9 + VQ 1–7 substrate +
  8A all present in the tree; main/governance-phase-9/vq-phase8 untouched; nothing pushed.
- **D2 local DB:** throwaway PG 16.13 `mintvault_vq_phase10_local` on 127.0.0.1:55432 (isolated
  scratchpad data dir, localhost-only, trust auth). Migrations 0008–0011 applied to it ONLY;
  4 tables verified; idempotency 23505 fires. Staging/prod NOT touched. See deployment-state.md.

## GATE STATUS: both GREEN. Reviewers dispatched.
6 read-only controlled-reviewers running (exports / idempotency-spend / provider / feature-controls-
observability / revisions-backup / reconciliation-migration-rollout). No unrestricted agents.

## Next authorised action
Verify the 6 reviewer reports personally → build the change manifest + implementation budget →
implement 10A.1…10A.8 subsystem-by-subsystem, one local commit each, regression after each, full
gate suite + governance self-tests at the end. Local integration tests point at TEST_DATABASE_URL
(local PG only) with a host-allowlist guard so they can never load `.env` staging. Do NOT edit
before the manifest is complete (framework rule). Local DB kept until all 10A evidence captured.

## Links
issue-register.md · change-manifest.md · reviewer-status.md · deployment-state.md · proof-map.md ·
architecture-before/after.md · rollout.md · rollback.md  (created when implementation is unblocked)
