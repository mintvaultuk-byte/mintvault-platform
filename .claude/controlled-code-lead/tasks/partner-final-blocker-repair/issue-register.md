# Issue register — partner-final-blocker-repair

**Baseline** `ad6a68f1` · **current** `0aaf6386` · branch `opus/partner-final-integration`
**Staging** unchanged (max migration 0046) · **Production** unchanged (`6f182624`, verified live via
`/api/version` 2026-08-09) · **No push, no deploy, no migration applied to any Neon host.**

Every CLOSED item below was verified by the Lead against source at absolute paths, or executed on a
real disposable PostgreSQL 17 cluster. Everything else is marked OPEN with what is actually missing.

---

## Status summary

| | count |
|---|---|
| Closed and verified | 12 |
| Partially closed (real repair landed, proof or scope incomplete) | 2 |
| Open — not started | 7 |

**This remediation is INCOMPLETE against the brief's completion rule.** Phases 21 (full mutation
matrix), 22 (fresh ten-agent hostile panel), 23 (full local gates), 24 (docs), 25 (push/CI),
26 (staging preflight) and 27 (Codex handoff) have not been executed. Do not treat the closed items
below as release-approved: they are Local Proof, not Integration Proof.

---

## CLOSED

### B1 · The 180-day window dated abandoned units from connector import
**Reproduced by reading, exactly.** `server/grader.ts` `rejectCertGrade` sets `graded_at = NULL` in
the rejection CAS; `status_updated_at` is written by one route (the shipping-status endpoint) and
never by the grading lifecycle. So for a reviewed → returned → abandoned unit, every branch of
`COALESCE(grade_approved_at, graded_at, status_updated_at, issued_at)` was NULL except `issued_at`,
the connector import date. The gap between import and review is entirely the partner's to choose.

**Repair.** Migration `0063` adds `certificates.review_entered_at`, stamped `NOW()` inside the same
CAS that increments `redo_count`, so the V2 population predicate and the window clock move in one
statement and cannot disagree across a crash. The measurement uses
`COALESCE(GREATEST(grade_approved_at, review_entered_at), issued_at)` — **latest** review wins, so
continuing to rework a unit keeps its evidence inside the window (the direction that costs the shop).

**Protected file.** Founder DECISION 1. Signature **E** added to
`tests/variant-line-consolidation.test.ts`: two required tokens in two representations
(`export const REVIEW_LIFECYCLE_COLUMN` proven in JS mode, `review_entered_at = NOW()` proven in
guarded mode), so neither can fake the other.

**Proof the authorisation did not widen the gate** — mutation applied and reverted:
bundling `const mvgsCenteringWeight = 0.35; export function scoreMvgsV2Local(...)` alongside
signature E → **2 tests RED** (calculation-token assertion + per-line formula guard). Restored
byte-identically. Guard suite 40/40 green with the legitimate change alone.

⚠️ **Scope note, stated because it is a real limit.** `review_entered_at` is written by the
rejection CAS only. Submit-for-review does not write it. That is sufficient for the proven exploit
(the population is `grade_approved_at IS NOT NULL OR redo_count > 0`, and every member of it has
either an approval date or a rejection), but a unit that entered review and was never acted on has
no clock — it is also not in the population. **No dedicated `tests/partner-review-clock.test.ts`
has been written**, and two code comments reference it. Those comments are currently aspirational
and must be corrected or the test written before this is called proven.

### B2 · Anonymous slab-image proxy ran on the privileged main pool
`GET /api/public/slab-image/:certNumber/:kind` (unauthenticated) called
`storage.getCertificateByCertId` — a Drizzle `SELECT *` — and a raw `db.execute`, both on the owner,
BYPASSRLS, unbounded MintVault pool shared with every Super Admin operation.

**Repair.** Migration `0064` adds `public_slab_image_projection`: an owner-checked view exposing a
certificate number, one resolved storage key and a boolean, with the publication gate (not deleted,
active, graded, HQ-approved) in the view definition and assertions that it cannot reference any
private column. `GRANT SELECT` to `partner_public_reader` only; asserted that the reader has no
direct `SELECT` on `certificates` and that PUBLIC holds nothing. The route reads it via
`partnerPublicQuery` and **fails closed** — no fallback to the privileged pool.

⚠️ **DEPLOY PREREQUISITE, BLOCKING.** The public slab showcase is a live production surface today.
After this change it requires `PARTNER_PUBLIC_DATABASE_URL` to be set AND its login role to be a
member of `partner_public_reader`. Without both, every public slab image 503s. This must be
provisioned before the deploy, not after.

### B3 · HQ approve/reject awaited the rating refresh
`mirrorPartnerApproval` and `mirrorPartnerRejection` both `await refreshRatingForCert`, which
awaited `refreshRatingAfterCommit` — an aggregate over `certificates` plus a snapshot transaction on
`adminPool` (`max: 4`, no acquire/query/lock timeout). "Never throws" was true and irrelevant: a
promise that never settles blocks the caller identically.

**Repair, in the order it now runs.** (1) The durable dirty mark — one indexed UPDATE — is the only
awaited part. (2) `scheduleRatingRefresh` detaches the expensive half; it is not a floating promise
(a `.catch` is attached synchronously at creation and the promise is retained in an `inFlight` set,
which also gives tests `drainRatingRefreshes()` as a deterministic join point). (3) All rating DB
work moved to a new isolated pool (`max 2`, acquire 1s, query 8s, statement 8s, lock 2s) — owner
DECISION 3's narrow repair: **the shared admin pool is not modified**, only starved of rating work.

### B4 · A failed `SET ROLE` left a privileged connection in the public pool
The pool's `connect` handler ended in `.catch(err => console.error(...))`. node-postgres gives a
`connect` listener no way to reject a client, so on failure the client was returned to the pool
**still on the login role** — and because the three statements were one batch, `lock_timeout` and
`statement_timeout` were lost on exactly those over-privileged connections.

**Repair.** Handler removed. Every public query now opens a transaction and issues
`SET LOCAL ROLE partner_public_reader` + both timeouts, then reads back `current_user` and throws
`PartnerPublicDbUnavailable` on mismatch. Fail-closed (a failing `SET LOCAL` aborts the transaction,
so the caller's SELECT never runs) and **PgBouncer-safe**: transaction-local state is scoped to the
transaction the pooler pins, which session state was never guaranteed to survive on Neon's `-pooler`
endpoint. `needsRollback` is pessimistic from the first statement, so a late assertion failure
cannot leak an open transaction back to the pool.

### H2 · `markRatingClean` lost updates
Now a compare-and-swap on `rating_dirty_generation`, captured **before** the calculation starts.
`markRatingDirty` lost its `AND rating_dirty = false` guard — that guard silently swallowed the
generation bump on an already-dirty listing, which is precisely the case an in-flight recalculation
was about to erase. `rating_dirty_since` stays monotonic, so queue ordering is unaffected.
Behaviourally pinned: RATING-AUTO1 now asserts position is idempotent while generation is not.

### H3 · `FOR UPDATE SKIP LOCKED` in autocommit protected nothing
The candidate query ran through a bare `pool.query`; PostgreSQL's implicit transaction committed at
statement end, releasing every lock before the first row was processed. Replaced with a single
`UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` that writes a **durable** `rating_claimed_until`
lease in the same statement as the claim. Crash recovery is by clock — no liveness protocol, no
reaper. The `server/index.ts` advisory lock is no longer load-bearing.

### H4 · Poisoned-row head-of-line starvation
A permanently failing listing kept the oldest `rating_dirty_since` forever and was therefore first
in every bounded batch. `rating_next_attempt_at` added with deterministic capped exponential backoff
(60s × 2^failures, capped 1h). `rating_dirty_since` deliberately still does not move.

### H5 · New listings born clean
`DEFAULT true` **plus** a `BEFORE INSERT` trigger, because a default alone is overridden by
`INSERT (rating_dirty) VALUES (false)` — which is exactly what the mutation would do.

### H6 · Ratings decay by clock with nothing watching
`rating_next_recalc_at` = oldest evidence inside the window + 180 days (the earliest instant the
population can differ), clamped to a bounded staleness sweep so "no evidence yet" cannot mean "never
looked at again". `measureEvidence` now returns `oldestEvidenceInWindow`; the reconciler's candidate
set includes clean-but-due listings.

### H7 · 503 classifier matched our own prose
`msg.includes("fail closed")` is a phrase **this codebase writes into its own error messages** in at
least four places, several of which are application bugs (a malformed tenant id reaching
`withTenant`). Those were being served as 503 "please try again shortly" and alerting on nothing.
Removed — the genuine missing-configuration case was already covered by
`instanceof PartnerPublicDbUnavailable`. Neon's `57P01`/`57P02`/`57P03` added, so an ordinary
autosuspend stops being classified "unknown" → 500.

### H9 · Columns existing only through boot-time DDL / `drizzle-kit push`
`status_updated_at` (boot DDL), `grading_front_cropped` (boot DDL) and `grading_front_display`
(**no migration and no boot DDL at all** — four writers, created only by someone running
`drizzle-kit push`) are now created by migration. The rating engine's dependency on
`status_updated_at` is additionally removed: the review clock supersedes it.

### H10 · Rating measurement seq-scanned `certificates`
0058's index is partial on `grade_approved_at IS NOT NULL`, which excludes exactly the abandoned
units V2 added. `0065` builds the wider index **CONCURRENTLY** in its own `-- migrate:no-transaction`
file, following `0018`. Measured justification: a plain `CREATE INDEX` takes ShareLock, and
`scripts/db/migrate.ts:190` holds it for the whole file.

### H11 · Execution floors were vacuous
`partner-public-network-behavioural` was pinned at **19** against **63** — 44 tests deletable with
CI green, including the entire rating-lifecycle and public-reader least-privilege blocks.
`partner-grading-http-routes` 16 against 27. Four suites had **no floor at all**, including
`partner-rollback-integrity`, the only forward+rollback+re-apply proof for the whole series.
All re-measured and pinned (63/27/18/21/14, plus new floors 44/48/42/31); the connector manifest
gains the `skipped !== 0` check the other five already had; the pilot manifest stops matching suite
paths by suffix.

### H16 · Reconciler stampede at boot
Fired inline at process start on every machine after a rolling deploy. Now `trackTimeout(45_000)`,
matching `transfer-v2-sweep` (30s) and `embed-corpus` (60s).

---

## PARTIALLY CLOSED

### H1 · Durable `markRatingDirty` not wired into production
The exported `markRatingDirty(tx, locationId)` — the one that joins the **caller's transaction** —
still has **zero production callers**. `grading-review-mirror.ts` marks dirty on its own connection
immediately after the commit, and that write now correctly bumps the generation, so the H2 repair is
real. But the obligation is not yet atomic with the evidence: a crash in the window between commit
and mark loses it, and only the reconciler's clock-driven sweep would eventually notice.
**Remaining:** reshape the mirror transaction to carry the location so the mark can move inside it,
and add the return/redo and resubmission call sites. Mutation `RATING-DIRTY-WIRE1` not written.

### H15 · Migration lock windows
Measured statement-by-statement on disposable PG17 — this is real evidence, not an estimate:
**0049** ShareLock on `certificates` + `submission_items` and ShareRowExclusive via two FKs;
**0054** ShareRowExclusive on `cert_counter` (blocks the allocator write, i.e. certificate issuance;
reads unaffected — the earlier "ACCESS EXCLUSIVE" claim was the wrong lock name but the right blast
radius); **0058** ShareLock on `certificates`, held for the whole 62 KB file, blocking writes but
not the public read surface; **0063/0064** ACCESS EXCLUSIVE on `certificates` — the first in the
series that blocks reads — kept catalog-only with a tightened 2s `lock_timeout` and every slow
statement moved out. No file in 0047–0062 sets its own timeout; all inherit the runner's 5s default.
**Remaining:** none of this is written into a runbook yet (Phase 19/24).

---

## OPEN — NOT STARTED

| ID | What is still missing |
|---|---|
| **B5** | Override create/remove atomicity. `POST /:id/rating/override` inserts in a transaction then calls `recalculateRating` **outside** it; `DELETE` updates in autocommit then recalculates. A failure between the two leaves the override recorded but the denormalised listing columns not reflecting it, **and the listing not marked dirty**, so the reconciler never repairs it. Mutation `OVERRIDE-ATOMIC1` not written. |
| **H8** | Deploy ordering. Nothing enforces that 0061/0064 precede the application deploy. Today that is a comment, not a gate. |
| **H12** | `partnerPublicDbConfigured()` still has **zero callers**. No startup or readiness check validates the public DB configuration or the reader-role membership. A missing GRANT is still discovered on the first customer request. |
| **H13** | Out-of-band `partner_public_reader` membership is not documented or operationally enforced anywhere. |
| **H14** | `/api/shops` is still mounted unconditionally by `registerPartnerNetworkPublicRoutes(app)`. No kill switch, no default-OFF flag. |
| **Phase 21** | Mutation matrix. 2 of 27 executed (the signature-E scoping proof, and the constraint mutation that surfaced via the existing fixture). `RECENCY-REVIEWDATE1`, `PUBLIC-IMAGE-ADMIN1`, `RATING-AWAIT1`, `RATING-DIRTY-WIRE1`, `RATING-CAS1`, `RATING-HOL1`, `RATING-NEW1`, `RECENCY-CLOCK1`, `OVERRIDE-ATOMIC1`, `PUBLIC-SETROLE1`, `PUBLIC-5031` are all unwritten, as is re-running the 16 retained mutations. |
| **Phases 22–27** | Fresh ten-agent hostile panel; full local gates (`lint`, `build`, full suite, `gitleaks`, AMD64 boot); docs correction; push + terminal CI; staging preflight; Codex handoff SHA. |

---

## Verification actually performed

- `npm run check` — clean, repeatedly, including after every edit batch.
- `tests/variant-line-consolidation.test.ts` — 40/40, plus the scoping mutation (RED, reverted).
- `tests/partner-public-network-behavioural.test.ts` — 63/63 on real PG17 with 0063–0066 applied.
- `tests/partner-public-network-rating.test.ts` + `-validation` — 79/79.
- `tests/partner-rollback-integrity.test.ts` — 44/44, including apply → rollback → re-apply for
  0063, 0064, 0065, 0066 and the full **0066 → 0047 descending sequence**.
- Migration lock modes — measured on a disposable PostgreSQL 17.10 cluster. No Neon host contacted.
- Production SHA read from the live `/api/version`: `6f182624`, unchanged.

**Not performed:** full repository suite, lint, build, AMD64, gitleaks, CodeQL, any push.
