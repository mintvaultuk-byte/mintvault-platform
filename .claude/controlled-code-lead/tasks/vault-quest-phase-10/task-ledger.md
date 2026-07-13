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

---

## D10 — Double-pay / idempotency protection (2026-07-11, session resumed)

### Stage 0 — Baseline (session-recovery reconciliation)
- Working tree was on `main`@`2501456` at session start (unrelated concurrent work — label-fix
  PRs #186/#187 — landed on main between sessions; NOT a conflict, main untouched by this program).
- Reconciled per concurrent-session-discipline: checked out `vault-quest-phase-10`, HEAD =
  `8bdaffd` exactly as left (no drift, nothing pushed — no upstream configured). Local throwaway
  Postgres (127.0.0.1:55432/mintvault_vq_phase10_local) still up, prior VQ tables intact.
- `.claude/agents/*-reviewer.md` custom subagent types are unavailable this session (harness
  registry). `controlled-code-lead` SKILL.md confirms this is now the standing governance doc
  (this repo's `.claude/skills/controlled-code-lead/`). Per its own text ("For a small task ...
  the Lead can skip spawning a reviewer entirely and inspect directly"), given D10 is a single,
  well-bounded subsystem already exhaustively reviewed in the prior 3-reviewer pass (same table,
  same 4 routes), Stage 1–3 run as Lead-direct inspection, not a fresh reviewer fan-out.
- Scope: wire the ALREADY-BUILT Phase-7B pure module (`generation-idempotency.ts`, untouched,
  fully unit-tested) + the ALREADY-BUILT `vq_generation_requests` table (migration 0009, applied
  to local DB, unique index `vq_gen_req_idem_uq` + state CHECK already present) into the 4 paid
  routes. **No new migration** — existing schema has every column needed (candidateId,
  chargedCredits, requestFingerprint, state). Decision recorded: minimal-schema, lower protected-
  action surface, matches minimal-change-discipline.
- PROTECTED / NOT AUTHORISED (unchanged from phase-wide grant): push, deploy, any migration
  against staging/prod, secrets, real R2/B2, real Higgsfield calls, staging/prod mutation.
  Standing local-only migration authorship+LOCAL-apply grant (established D3-D9) covers this
  session IF a migration turns out to be needed — none was.

### Plan (file-level)
1. NEW `server/vault-quest/lib/generation-idempotency-store.ts` — DB adapter: `reserveOrDecide`
   (atomic INSERT ... ON CONFLICT, race-safe re-read on 23505, mirrors the proven
   `export-job-store.createOrGetExportJob` pattern), `resumeReservation` (failed_retryable→
   reserved), `finalizeSuccess`/`finalizeFailure`, `getByKey`. Degrades via
   `isUndefinedTableOrColumn` → proceed-without-reservation (spend ceiling still the backstop).
2. `server/routes/vault-quest-admin.ts` — wire into all 4 paid routes: accept client
   `idempotencyKey` (fallback server randomUUID if absent), fingerprint payload, reserve AFTER
   the spend gate passes, branch on action (proceed/resume/replay/accepted_pending/conflict/
   manual_review/terminal), finalize on the real outcome. REMOVE the now-superseded
   `recordGenerationAttempt` call-sites (folded into reserve+finalize on the SAME table — kept
   both would double-insert into the spend window).
3. Client `admin-vault-quest.tsx` — mint+persist a per-action-context idempotency key in
   localStorage (survives reload, shared across tabs); clear on any terminal response so a
   deliberate next click gets a fresh key (this is what distinguishes "reload of a pending
   action" from "user wants new art" — see D10 owner framing).
4. Tests: true-parallel N-concurrent-identical-request proof (spy: exactly 1 provider call),
   completed-replay, in-progress-replay, failed-then-fresh-key-retry, cross-machine (two DB
   pool handles), conflict-on-payload-drift-under-reused-key.
5. Full gates + durable evidence.

### Next authorised action
Implement per plan above (Lead-direct, no push/deploy/migration-to-non-local).

### Stage 5/6 — Implementation + regression complete (2026-07-13)
Delivered exactly per plan, no scope drift. NEW: `server/vault-quest/lib/generation-
idempotency-store.ts` (reserve/finalize/replay adapter over the pre-existing Phase-7B
table + pure module — no new migration), `client/src/lib/vq-idempotency.ts` (localStorage-
persisted per-action key, survives reload, shared across tabs, cleared on any terminal
response). MODIFIED: all 4 paid routes in `vault-quest-admin.ts` (reserve after the spend
gate, before any provider call; finalize on every exit path incl. the inline per-candidate
catch in the master/batch/family loops); `admin-vault-quest.tsx` (5 call sites incl. the
founder batch-queue loop) now mint/reuse/clear the key and handle a 202 pending response.
`recordGenerationAttempt` call-sites removed (superseded by reserve+finalize on the SAME
table — kept both would double-insert into the spend window); the function itself is
untouched/still exported (existing unit tests unaffected).

**Verification (Locally verified — isolated local Postgres + provider spy, NO real
Higgsfield/R2/staging/prod):**
- 10 pure tests (classifier + response-mapper), 5 client localStorage tests, 9 store
  integration tests (fresh/true-parallel-8-concurrent-1-winner/cross-machine-sim/replay/
  pending/failed-final-blocks-same-key/failed-retryable-resumes/different-payloads-
  independent/conflict-on-reused-key), 3 END-TO-END route tests mounting the REAL router
  (6 concurrent identical POSTs → provider spy called exactly ONCE, 1×201+5×202; distinct
  keys → 2 independent legitimate charges; replay after completion → 0 new calls).
- tsc clean; full Vitest **505/505 with local DB**, 469/505 without (36 correctly gated
  skip); ESLint 4452 == exact baseline (0 net new); build clean; governance self-tests
  4/4; DB constraint proofs (rollback-wrapped): UNIQUE(idempotency_key) fires, state
  CHECK fires; migrations-vq/ diff vs 8bdaffd is EMPTY (no new migration — reused the
  fully-built 0009 table). Secret scan 0 hits. Grading/payment/auth/shared-schema files
  untouched (targeted diff empty).

**Known, documented residual (not defects — inherent to the design, stated honestly):**
- The client-to-server hop itself dropping (not the provider hop) is NOT covered — on
  any error the client clears its stored key so the user can retry, which means a
  response lost after the server actually succeeded could double-charge on manual
  retry. Different from and much narrower than the provider-hop protection (which IS
  covered via classifyThrownGenerationError + classifyProviderError). Out of the
  owner's stated scope (reload/2nd-tab/cross-machine/retry-after-real-failure), noted
  for completeness per silent-failure-prevention discipline.
- Reservation lifecycle jumps reserved→completed/failed_* directly rather than walking
  every intermediate VQ_GENERATION_STATES hop (documented design simplification in the
  store module's header — safe because `state` has no DB-enforced transition graph,
  only a membership CHECK).
- A fallback server-minted key (no client key sent) gives NO cross-request protection
  by design — real protection requires the client to resend the same key, which is what
  the 5 wired call sites now do.

Proof level: **Locally verified**. Staging/production activation and a genuine 2-Fly-
machine run remain 10B/10C scope (same as every other 10A subsystem this phase).
