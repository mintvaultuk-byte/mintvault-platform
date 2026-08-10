# Issue register — partner-final-blocker-repair

**Baseline** `ad6a68f1` · **current** `see git log` · branch `opus/partner-final-integration`
**Staging** unchanged (max migration 0046) · **Production** unchanged (`6f182624`, verified live via
`/api/version` 2026-08-09) · **No push, no deploy, no migration applied to any Neon host.**

Every CLOSED item below was verified by the Lead against source at absolute paths, or executed on a
real disposable PostgreSQL 17 cluster. Everything else is marked OPEN with what is actually missing.

---

## Status summary

| | count |
|---|---|
| Closed and verified | 18 |
| Partially closed (real repair landed, proof or scope incomplete) | 2 |
| Open — not started | 2 |

**Session 2 (from `e7703a66`) closed:** B1's missing proof, B5, H1, H12, H13, H14.
**Still open:** H8 (deploy-order gate), and the bulk of the mutation matrix / hostile panel /
full gates / push / staging package / Codex handoff.

**This remediation is INCOMPLETE against the brief's completion rule.** The full mutation matrix,
the fresh ten-agent hostile panel, the full local gates (lint/build/full suite/gitleaks/AMD64),
the docs correction, the push + terminal CI, the staging package and the Codex handoff have not
been executed. Do not treat the closed items
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
no clock — it is also not in the population.

**Behavioural proof: `tests/partner-review-clock.test.ts`, 8 cases, added in session 2.** See the
session-2 addendum at the foot of this file. The code comment that used to name a non-existent test
now describes what the suite actually contains.

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

---

# SESSION 2 ADDENDUM — closures from `e7703a66` to `97e9de5b`

## B1 · dedicated behavioural proof — CLOSED
`tests/partner-review-clock.test.ts` now exists (8 cases) against a real disposable PostgreSQL 17
estate with the full migration chain applied as the non-superuser migrator. It drives the real
`measureEvidence` rather than restating its SQL, and deliberately does NOT create
`review_entered_at` in the fixture — the column must arrive through 0063 or the suite fails.

Cases: the exploit itself (imported 200d ago, reviewed 5d ago → 12/20 first-pass, not 12/12); the
**non-vacuity control** (a genuinely dormant shop DOES fall out of the window and back to all-time);
the delayed-submission gaming attempt (pushing every import date to 400 days changes nothing);
approved vs abandoned comparability; GREATEST in **both** orders — bounced-then-approved and
approved-then-reopened, the second being the one `COALESCE` gets wrong; the window-boundary
reporting the reconciler needs; and the privilege assertions on the column.

**Mutation RECENCY-REVIEWDATE1** — clock reverted to `COALESCE(grade_approved_at, graded_at,
issued_at)`: type-clean, **4 tests RED**, restored byte-identically.
The stale comment in `public-network-service.ts` now describes what the suite actually contains.

## H1 · durable dirty mark inside the transaction — CLOSED (with a stated residual)
The mark is now the **last statement inside** the mirror transaction, on the caller's client.
`mirrorPartnerRejection` was a bare autocommit UPDATE and is now a transaction — the most important
one, since rejection is what puts a unit into the V2 population.

⚠️ **Residual window, stated rather than glossed.** `redo_count` and `grade_approved_at` are written
by `server/grader.ts` in statements of their own, BEFORE the mirror runs. Making the dirty mark
atomic with *those* would require wrapping the protected engine's CAS, which founder DECISION 1 does
not authorise. So the window is now `grader CAS commit → mirror transaction`, instead of
`mirror commit → post-commit mark`. It is bounded, not eliminated, and H6's clock-driven sweep
(`rating_next_recalc_at`, max 7 days) is what guarantees the obligation is never permanently lost.

## B5 · override atomicity — CLOSED
Create and remove are each one transaction: lock the listing, write the override, mark dirty, audit.
`auditAdminTx` deliberately does not catch — in a transaction there is something to undo.
`maybeFailForTest` provides the forced-failure point. ⚠️ **The forced-failure test itself is not yet
written**, so the rollback is proven by construction and by type, not behaviourally. Mutation
`OVERRIDE-ATOMIC1` outstanding.

## H12 / H13 · readiness and reader membership — CLOSED
`server/partner/public-network-gate.ts`. One probe settles both: `partnerPublicQuery` already does
`SET LOCAL ROLE` + a `current_user` assertion, so one successful query proves URL, role existence,
**membership**, and the drop. Proven with a real membership-less login role — not ready, code
`public_reader_role_unavailable`, and the query rejects rather than serving on the login role.
Reports at startup; does not fail the process (rationale documented in the module).

## H14 · default-OFF kill switch — CLOSED
`partner_public_network_enabled`, router-level middleware, fail-closed via the existing
`resolveGlobalFlag`. Proven: absent row is OFF; OFF answers 404 for finder and profile; ON exposes
an eligible shop; a SUSPENDED shop stays hidden with the flag ON.

---

## Mutation matrix — honest state

| Mutation | Result |
|---|---|
| Protected-engine scoping (bundled scoring alongside signature E) | **RED**, 2 guards, reverted |
| `RECENCY-REVIEWDATE1` | **RED**, 4 tests, reverted |
| `PUBLIC-SETROLE1` (as formulated) | **NOT DETECTED — see below** |
| 24 others | **not run** |

### ⚠️ Finding from my own mutation run, recorded because it is signal
`PUBLIC-SETROLE1` was formulated as "swallow the `current_user` assertion" and the suite stayed
GREEN. The reason is benign but worth stating precisely: when the login role lacks membership,
`SET LOCAL ROLE` itself fails with 42501 and aborts the transaction, so the caller's query never
runs regardless of the assertion. The assertion is therefore **redundant belt-and-braces with no
independent detector**. It is not dead — it would catch a role that exists, is grantable and yet
resolves to something unexpected — but nothing currently proves it. Either the mutation must be
reformulated to remove the whole transaction-local role drop (which *would* be caught), or a test
must exercise the assertion directly. **Not resolved.**

## Still open after session 2

| ID | Missing |
|---|---|
| **H8** | Deploy-order gate. The prerequisite is documented in code comments and enforced at runtime by fail-closed behaviour, but nothing *prevents* a deploy landing ahead of 0061/0064. |
| **Mutations** | 24 of 27 unrun; most have no detector yet (`RATING-CAS1`, `RATING-HOL1`, `RATING-NEW1`, `RECENCY-CLOCK1`, `OVERRIDE-ATOMIC1`, `PUBLIC-IMAGE-ADMIN1`, `RATING-AWAIT1`, `RATING-DIRTY-WIRE1` all need tests written first). An unrun mutation is not a passed mutation. |
| **Hostile panel** | Not launched. |
| **Gates** | `lint`, `build`, full repository suite, `gitleaks`, AMD64 boot — none run this session. Only `tsc` and targeted suites. |
| **Push / CI / staging package / Codex handoff** | Not started. Nothing pushed. |

---

# SESSION 3 ADDENDUM — `0c495df2` → `9b12358a`

## Mutation matrix — now RUN, not asserted

| Mutation | Detector | Result |
|---|---|---|
| Protected-engine scoping (scoring bundled with signature E) | `variant-line-consolidation` | **RED** ×2, reverted |
| `RECENCY-REVIEWDATE1` | `partner-review-clock` | **RED** ×4, reverted |
| `RATING-CAS1` | `partner-public-network-behavioural` | **RED**, reverted |
| `RATING-HOL1` | `partner-public-network-behavioural` | **RED**, reverted |
| `RECENCY-CLOCK1` | `partner-public-network-behavioural` | **RED**, reverted |
| `PUBLIC-5031` | `partner-public-network-validation` | **RED**, reverted |
| `RATING-NEW1` | born-dirty test (INSERT naming `rating_dirty=false`) | detector present; mutation **not run** |
| `PUBLIC-SETROLE1` | — | **DOES NOT FIRE** (see session 2 addendum) |
| `PUBLIC-IMAGE-ADMIN1`, `RATING-AWAIT1`, `RATING-DIRTY-WIRE1`, `OVERRIDE-ATOMIC1` | — | **no detector, not run** |
| The 16 retained mutations | — | **not re-run** |

Every mutation that ran was type-clean while applied and restored byte-identically.

## A duplicate that was hiding a defect — removed
`grading-review-mirror`'s post-commit `markRatingDirtyForLocation` was left as belt-and-braces
when the transactional mark landed. It made the transactional mark **untestable**: deleting the
in-transaction write changed no observable behaviour, because the duplicate still dirtied the
listing — non-durably. Removed. `RATING-DIRTY-WIRE1` can now go RED; it has not yet been run.

## Two defects a hostile agent found IN THIS REMEDIATION — both fixed

**`rollback-0065` executed two statements outside its own guard and transaction.** Prose
describing the manual CONCURRENTLY alternative had two lines that were not commented out. They
ran at top level in autocommit: `SET LOCAL` became a no-op, the `DROP INDEX` took AccessExclusive
on `certificates` unbounded, the order guard refused *after* the damage, and the journal still
read `applied` — so the runner would never rebuild the index and H10 returned silently on an
estate reporting fully migrated. Without `ON_ERROR_STOP`, psql continued past the refusal and
de-journalled 0065 anyway. Rewritten; 0063/0064/0066 checked and clean.

**`review_entered_at` / `status_updated_at` were absent from `shared/schema.ts`.** `certificates`
is drizzle-managed and the drift guard is table-granular, so both were one `drizzle-kit push`
from being proposed for DROP — including the review clock the rating engine reads. Both declared.

## Fresh-estate proof (Phase 16)
- All 53 numbered files apply cleanly, first time, in order — **on a base estate built from
  `shared/schema.ts`**.
- ⚠️ **The chain CANNOT build from zero.** A virgin cluster fails at
  `0010_partner_connector_import.sql` — `relation "users" does not exist`. There is no
  `0000_baseline`; the HQ schema is owned by `shared/schema.ts` + `drizzle-kit push`. Pre-existing
  and not introduced here, but it means "fresh database from the migration chain" is not an
  achievable state, and any claim phrased that way is really "schema.ts **plus** the chain".
- 0065 applies through the runner's no-transaction path; index `indisvalid = t`; journal `applied`.
- Round trip 0066→0063 then re-apply: `pg_dump -s` **identical** (only pg_dump's own random
  session token differs). 127 tables / 5 views / 1681 columns / 361 indexes before and after.
- **Boot-DDL audit: no missing column.** Every `certificates` column referenced in SQL by the five
  public-network files exists on the fresh estate, verified twice — by set-difference and by
  `EXPLAIN`-ing all seven queries, so no latent `42703` remains.

## Measured lock modes — 0063–0066 (400k-row `certificates`, PG17)
| Migration | `certificates` | `partner_public_listings` | duration |
|---|---|---|---|
| 0063 | **AccessExclusive** | none | 223 ms |
| 0064 | **AccessExclusive** | none | 10 ms |
| 0065 | **ShareUpdateExclusive only** | none | 179 ms |
| 0066 | **none** | AccessExclusive | 19 ms |

All three hypotheses CONFIRMED. 0063/0064 are the only files in the 0047+ series that block
`certificates` **reads**, i.e. the only ones that can 404 the public verification page.

## Docs — corrected
Eleven divergences found; two were operational hazards an operator would have executed. The
lock-safety runbook told them to expect "exactly 0047-0052, six files" (twenty are pending) and
step 5's bare `--apply` would have run fourteen unplanned migrations including both
AccessExclusive files. §12.8 of the 0058 doc — the list an operator applies from — stopped at
0062. Both fixed, with the out-of-band `GRANT` written out. Superseded claims struck through and
dated rather than deleted.

## Gates
`tsc` clean · `lint` 0 errors (2546 pre-existing warnings) · `build` green · `git diff --check`
clean on source (trailing whitespace only in pre-existing evidence text files) · full suite
**4501 passed / 16 failed / 1092 skipped**. One failure was mine (the no-transaction pin, fixed);
the other 15 pass in isolation and fail only under parallel load — wall-clock and canvas/PDF
assertions. **Not claimed as green.**

`gitleaks`: 91 findings across 2089 commits of history — **not triaged**, and not introduced by
this work. Needs a separate pass.

## Still open
H8 deploy-order **gate** (documented and runtime-fail-closed, but nothing prevents a bad order);
4 mutations with no detector + 16 unre-run; the ten-agent hostile panel; AMD64; push + CI;
staging package; Codex handoff.

---

# SESSION 4 ADDENDUM — `3e42bb08` → `878e4b79`

## H8 · deploy-order gate — CLOSED
`scripts/db/preflight-public-network.ts` (`npm run db:preflight-public`). Refuses the rollout on:
migration journal 0058–0066 `applied` (not `applying`); `certificates.review_entered_at` and the
six 0066 rating columns; all three public projections; reader role attributes; the reviewed-unit
index existing **and** `indisvalid`; the reader being able to read each projection and **not**
`certificates`; 0054's `cert_counter` guard; and the rollout flag being OFF
(`--expect-flag-off=false` for post-enable verification).

**Membership is proven by doing it** — the gate connects as the login role in
`PARTNER_PUBLIC_DATABASE_URL`, drops to the group role and reads `current_user` back. On 42501 it
prints the exact `GRANT` remedy. Read-only throughout via `withReadOnlySession`, and a test asserts
the session is left clean and that no URL/host/port/credential appears in the output.

**DEPLOY-ORDER1 → RED on both halves** (structural list pin + behavioural refusal), type-clean,
restored. 13/13 against a real disposable PG17 estate.

## PUBLIC-IMAGE-ADMIN1 — detector built, mutation RED
The lookup moved into `server/partner/public-slab-image.ts` (12 lines; SQL, projection and gate
unchanged) purely so it could be driven without standing up the app. The decisive test asserts
**failure**: with the public URL unset the correct code throws, while a mutation on the admin pool
would succeed. Mutation `partnerPublicQuery → partnerAdminQuery` → **RED ×2**, restored
byte-identically. Also covers the pre-repair leak (a partner-graded card awaiting HQ approval now
returns null) and re-asserts the reader has no direct `certificates` access.

## Parallel-only failures — mechanism identified, two fixed at source
Not flakiness. The mechanism is **work with inherently variable cost sitting inside vitest's
default 5s per-test budget**, competing with every other worker.

- `partner-public-network-validation` — my own classifier tests did `await import(...)` inside each
  `it()`; reproduced at 7825 ms and 5010 ms on module-graph cold start. Hoisted into `beforeAll`.
- `variant-line-consolidation` — the protected-engine guard shells out to `git diff` per protected
  file; given 60 s.

⚠️ **The distinction that matters:** both assert a PROPERTY, so a larger budget weakens nothing.
`project-control-hardening`'s "redaction is bounded, not quadratic" asserts a **duration** — it is
a real performance guard and raising its bound would delete what it protects. It needs a different
fix (measure scaling, or serialise that one test) and is **NOT** addressed.

Ten-suite matrix: **349/349 green**, first of two consecutive runs confirmed.

## Migration bootstrap contract — recorded
The numbered chain is a **partner overlay**, not a from-zero installer. A virgin cluster fails at
`0010` with `relation "users" does not exist`; the HQ base schema is owned by `shared/schema.ts`.
The real contract is **`shared/schema.ts` base → migration chain**, and any claim of "fresh
database from migrations" is wrong. Not a migration defect — it matches the architecture — but it
must not be mis-stated. On that base, all 53 numbered files apply cleanly first time, and the
0066→0063 round trip returns a byte-identical `pg_dump -s`.

## Still open
| Item | State |
|---|---|
| `RATING-AWAIT1`, `RATING-DIRTY-WIRE1`, `OVERRIDE-ATOMIC1` | no detector, not run |
| 13 remaining full-suite parallel failures | mechanism identified, **not individually fixed** |
| 16 retained mutations | not re-run |
| `PUBLIC-SETROLE1` | still does not fire (redundant assertion, no independent detector) |
| Ten-agent hostile panel | not launched |
| AMD64, push, CI, staging package, Codex handoff | not started |
| gitleaks 91 historical findings | not attributed new-vs-pre-existing |

---

# CORRECTION — the "parallel-only failures" were misdiagnosed TWICE. Root cause found.

I asserted two wrong causes before the evidence was in. Both are retracted here, because a register
that quietly replaces a wrong finding with a right one teaches nobody anything.

**Wrong #1 — "flakes."** Correctly rejected by the owner.

**Wrong #2 — "afterAll teardown budgets."** I raised 39 files' cluster teardowns from the default
10 s to 120 s and reported it as the fix on the strength of ONE clean run. The next run failed with
`Hook timed out in 120000ms` and `Hook timed out in 180000ms` — the budgets I had just raised were
themselves blown. That is a disproof, not a flake. **The change was reverted in full**, including a
revert script that over-matched and stripped pre-existing `120_000` timeouts from unrelated blocks;
`git checkout -- tests/` restored everything and only the one separately-reproduced fix was
re-applied.

## THE ACTUAL ROOT CAUSE: host resource starvation, not a repository defect

Measured on this machine during the runs:

```
PhysMem: 15G used, 93M unused          vm.swapusage: 17250M of 18432M used
Load Avg: 92.02 on 10 cores            CPU: 55.8% user, 44.2% sys, 0.0% idle
```

44 % SYSTEM time and 6.9 M cumulative swapins is page-fault thrashing. Three independent vitest
roots across two git worktrees were running concurrently, plus two `tsc --noEmit` processes and
several Electron apps. Each vitest root is entitled to 9 forks (`maxWorkers = max(cpus-1,1) = 9`).

**The clinching evidence:** `tests/printable-grade-safety.test.ts` failed a 5 s budget running
ENTIRELY ALONE — one file, one fork, no in-suite contention. No amount of test isolation can
explain that.

All 15 failures are wall-clock. **Zero are logic or value mismatches.** A pure-CPU regex over
200 000 characters was measured at 3 399 / 5 906 / 6 689 / 12 857 ms against a <3 000 ms bar that
passes trivially in isolation.

## AND CI NEVER RUNS THIS TOPOLOGY

`vitest.config.ts:15` — `fileParallelism: !process.env.TEST_DATABASE_URL`. CI sets
`TEST_DATABASE_URL` (`ci.yml:14`), so **CI runs test files strictly sequentially, one at a time**,
on a dedicated runner. `ci.yml:143-146` already documents this. Locally, with the variable unset,
up to 9 files run at once.

So the brief's requirement — "zero genuine failures under the same execution topology CI uses" — is
a run with `TEST_DATABASE_URL` set. **That run has NOT been performed** and is the outstanding
proof. The parallel local run is a harsher topology than the release gate, executed on a machine
that was thrashing.

### What was legitimately fixed, and what was not

| Change | Status |
|---|---|
| Hoisted `await import()` out of test bodies (validation suite) | Kept — separately reproduced at 7825 ms / 5010 ms |
| 60 s budget on four import-only `beforeAll` hooks | Kept — separately reproduced; explicitly NOT the class fix |
| 60 s on the protected-engine guard (shells out to `git diff`) | Kept — property assertion, no guarantee weakened |
| 120 s on 39 cluster teardowns | **REVERTED** — disproved by the next run |
| `project-control-hardening` bounded-redaction | **Untouched by design** — asserts a DURATION; raising it deletes the guard |

### Latent hazards found, not fixed
- `tests/helpers/postgres17-cluster.ts:42` — port allocated by bind-to-0 / close / hand to
  `initdb`, leaving a multi-second TOCTOU window on the ephemeral port space.
- sharp's libvips and node-canvas each load their own glib/gio into the same worker; macOS reports
  a duplicate-class warning that "may cause spurious casting failures and mysterious crashes".
- The affected population is larger than five files — at least eight more timed out during
  reproduction.

---

# SESSION 5 — `c758a7dd` → (see git log)

## OVERRIDE-ATOMIC1 — CLOSED, mutation RED
B5 made override create/remove atomic; nothing proved it, because the atomicity lived inside a
super-admin-gated HTTP handler. `createRatingOverride` / `removeRatingOverride` moved into
`public-network-service.ts`; the routes delegate and the SQL, lock, audit and dirty mark are
unchanged, so the tested code is the shipped code. The two dead in-route helpers were removed
rather than left as a second copy.

Injection point is after the override row, dirty mark AND audit are written, before commit — the
only window that produces B5's partial states. The detector asserts all four durable facts move
together on success and that NONE moved on failure: no orphan override, no phantom audit, no stale
dirty generation, and the listing still usable (so the rollback released its `FOR UPDATE`).
Remove is covered too, where the partial state is worse — a half-removed override keeps the public
profile publishing a value the audit trail says was retired.

**Mutation OVERRIDE-ATOMIC1** (split the transaction, audit + dirty mark back outside as pre-B5) →
**RED**, type-clean, restored byte-identically. Floor raised 80 → 84.

## gitleaks — PR scope, CLOSED
`gitleaks detect --log-opts="origin/main..HEAD"` over this branch's **156 commits**: *no leaks
found*. **Zero new secret findings introduced by this work.** The 91 findings from the earlier scan
are pre-existing repository history (2089 commits) and are not this release's gate.

## Mutation matrix — cumulative
| Mutation | Result |
|---|---|
| Protected-engine scoping | RED ×2 |
| `RECENCY-REVIEWDATE1` | RED ×4 |
| `RATING-CAS1` | RED |
| `RATING-HOL1` | RED |
| `RECENCY-CLOCK1` | RED |
| `PUBLIC-5031` | RED |
| `PUBLIC-IMAGE-ADMIN1` | RED ×2 |
| `DEPLOY-ORDER1` | RED ×2 (structural + behavioural) |
| `OVERRIDE-ATOMIC1` | RED |
| `RATING-AWAIT1` | **no detector — not built** |
| `RATING-DIRTY-WIRE1` | **no detector — not built** |
| `PUBLIC-SETROLE1` | does not fire (redundant assertion) |
| 16 retained | not re-run |

Every mutation run was type-clean while applied and restored byte-identically.

## RATING-AWAIT1 / RATING-DIRTY-WIRE1 — still open, and why
Both must drive `mirrorPartnerRejection` / `mirrorPartnerApproval`, the real production callers.
That needs a certificate-LINKED work item. Neither existing harness provides one:
`partner-public-network-behavioural`'s `seedWorkItem` inserts a work item with **no
`certificate_id`**, and `partner-full-pilot-workflow` — which does drive the real mirror — applies
migrations only to **0050**, so it has no `partner_public_listings` at all.

Closing them means extending one harness: linking a certificate through the 0049 composite FK
`(certificate_id, submission_item_id) → certificates(id, submission_item_id)`, and for
RATING-AWAIT1 additionally adding a rating-pool reset helper so the pool can be re-pointed and
exhausted to make an explicit latency contract measurable. Neither is conceptually hard; both are
real fixture work and were **not** attempted rather than half-done.

---

# CI-EQUIVALENT FULL SUITE — GREEN, and what it cost to get an honest number

**Final: 272 files passed, 28 skipped, 0 failed · 4850 tests passed, 828 skipped, 0 failed.**
Topology: file-sequential (`TEST_DATABASE_URL` set, as `ci.yml` does), against the same
`pgvector/pgvector:pg16` database and the same MinIO-on-9010 that `ci.yml` specifies. Zero
all-skipped files.

Getting there took three attempts, and each failure taught something:

1. **Invented `TEST_DATABASE_URL`.** The repo guard refused it — *"REFUSED: TEST_DATABASE_URL must
   be the local throwaway DB"*. 31 suites declined to START. Had I not read the error I would have
   reported 31 defects.
2. **Right database, no R2 proof env.** 1 real failure. I classified `partner-full-pilot-workflow`
   refusing to start as "an environment prerequisite, not a defect". **That was half right and the
   wrong half to act on** — the missing environment was HIDING a regression.
3. **Full CI environment.** 1 → **15** failures, and 14 of them were mine.

## The regression the missing environment was hiding
`markRatingDirtyForCertInTx` (the H1 repair) runs INSIDE the mirror transaction — the placement is
the point, because it makes the obligation commit with its evidence. It also means a failure there
does not degrade the rating: **it rolls back the HQ approval with it.** On an estate without 0058,
`partner_public_listings` does not exist, so every partner review 42P01s. That is the application-
first rollout window, and it is exactly the failure "a rating is SECONDARY" exists to prevent,
reintroduced by the repair meant to strengthen it. The reconciler already guarded against a
pre-0062 database; the in-transaction path did not. Fixed with a per-call `to_regclass` probe.

## A genuine sequential-topology test defect
`partner-public-network-migration` keyed listing slugs on `Date.now()`, and `"ME2 2NG"` /
`"ME2-2NG"` / `"me2 2ng"` all strip to the same stem — two cases in one millisecond collided on
`uq_partner_public_listings_slug`. It surfaced in the SEQUENTIAL run because that is where the
cases run fastest: the inverse of the starvation pattern. Replaced with a monotonic counter.

## ⚠️ TWO EXECUTION FLOORS COULD NOT BE VALIDATED HERE
Measured against the real run:

| Suite | Executed on my run | Declared floor |
|---|---|---|
| `partner-management-migration` | **0** | 14 |
| `partner-rls-isolation` | **33** | 85 |

Both are env-gated and this machine does not hold every gate variable CI sets, so they ran
partially or not at all. **In CI they should execute fully — but I have not proven that**, and the
earlier floor audit separately flagged `partner-rls-isolation` as possibly stale-HIGH by one
(static expansion = 84 vs a floor of 85), which would be a spurious red. Both need settling from a
real CI run, not from me. Every other critical floor matched its measured count EXACTLY: 84, 8, 13,
44, 48, 42, 37, 27, 21, 18.

---

# ALL THREE REMAINING DETECTORS BUILT — mutation matrix complete for changed surfaces

Governance note: this pass ran under `docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md`, installed at
`d1f426f9`. Findings were fixed in-pass rather than reported and deferred.

## RATING-DIRTY-WIRE1 — PROVEN (rejection AND approval)
Both had to drive the REAL mirror. No harness provided a certificate-LINKED work item:
`seedWorkItem` left `certificate_id` NULL and `pendingPartnerWorkItem` keys on exactly that, so a
test built on it would have exercised the `not_partner` early return and proved nothing. The
fixture now links one, satisfying 0049's composite FK and its `certificate_pair` CHECK
(`certificate_id` and `certificate_linked_at` together).

Removing BOTH transactional dirty writes → **RED on both tests**. Only detectable because the
redundant post-commit mark was deleted earlier in this programme; while it existed, deleting the
in-transaction write changed nothing observable.

The approval case asserts the **ordering**: `mirrorPartnerApproval` commits its work-item
transaction FIRST and drives settlement AFTER, so the approval and its rating obligation land
together and a later settlement refusal cannot un-record a review that happened. The fixture is
deliberately unfunded so settlement raises `credit_settlement_required` — honest behaviour, and
`partner-full-pilot-workflow` covers the funded path.

## RATING-AWAIT1 — PROVEN, on an explicit latency contract
Rating pool sized to 1, its single connection held by the test, acquire timeout raised to 8s.
Correct code: HQ rejection returns in **<1000 ms** because the heavy refresh is detached.
Mutated (restore the synchronous await): **5718 ms → RED on the stated bound**, not on a vitest
timeout. Also asserts primary state committed, rating still dirty, and the reconciler repairing it
once the pool is healthy. Required a `__resetPartnerRatingPoolForTests` helper — the proof needs a
deliberately unusable pool, impossible once healthy defaults are memoised.

## Mutation matrix — final
| Mutation | Result |
|---|---|
| Protected-engine scoping | RED ×2 |
| `RECENCY-REVIEWDATE1` | RED ×4 |
| `RATING-CAS1` · `RATING-HOL1` · `RECENCY-CLOCK1` · `PUBLIC-5031` | RED |
| `PUBLIC-IMAGE-ADMIN1` | RED ×2 |
| `DEPLOY-ORDER1` | RED ×2 (structural + behavioural) |
| `OVERRIDE-ATOMIC1` | RED |
| `RATING-DIRTY-WIRE1` | RED ×2 |
| `RATING-AWAIT1` | RED (5718 ms vs 1000 ms bound) |
| `PUBLIC-SETROLE1` | **FOLLOW_UP** — does not fire; the assertion is redundant belt-and-braces behind `SET LOCAL ROLE`, which already aborts the transaction. No independent detector. Not release-blocking: the fail-closed behaviour it guards IS proven, twice. |

All type-clean while applied; all restored byte-identically.

## FOLLOW_UP (not release-blocking, evidence recorded)
- `PUBLIC-SETROLE1` has no independent detector (above).
- `tests/helpers/postgres17-cluster.ts:42` — port allocated by bind-0/close/hand-off, a
  multi-second TOCTOU window. No observed failure.
- sharp's libvips and node-canvas each load their own glib/gio into one worker; macOS warns it
  "may cause spurious casting failures".
- Two execution floors unvalidated locally (`partner-management-migration` 0/14,
  `partner-rls-isolation` 33/85) — env-gated suites this machine cannot fully run; the RLS floor
  may additionally be stale-high by one.

---

# CONTINUATION STATE — pushed, CI RED, exact next action

**Pushed SHA `2c5d1f6b`** (branch `opus/partner-final-integration`; PR #288 head branch
`codex/partner-grading-bridge-current-main` fast-forwarded to the same SHA, no force). 24 commits
ahead of the previous remote tip; ancestry verified clean before pushing.

## CI on `c3668cf7` — terminal, and RED

| Check | Result |
|---|---|
| **linux/amd64 image build & boot** | **PASS** |
| Secret scan (gitleaks) | PASS |
| PR dependency review | PASS |
| CodeQL (SAST) javascript-typescript | PASS |
| CodeQL (aggregate) | FAIL |
| **Lint, Type Check, Test & Build** | **FAIL — 7 files / 14 tests** |

CI: `5667 passed | 14 failed (5681)`.
My CI-equivalent local run at the same SHA: `4853 passed | 0 failed`, same 5681 total.

**So these 14 are CI-ONLY and are NOT reproduced locally.** The environments differ in the gate
variables CI sets and this machine does not — the same reason
`partner-management-migration` (0/14) and `partner-rls-isolation` (33/85) could not be floor-checked
locally. Do not classify them from the log alone; reproduce with CI's env first.

Files implicated in the failing log (frequency-ranked, NOT yet confirmed as the 7):
`partner-user-management-ui-render`, `partner-grading-http-routes`, `print-approval-gate`,
`partner-full-pilot-workflow`, `admin-auth-reliability`, `grading-credit-owner-binding`,
`certificate-image-upload-audit`, `b2-archival-partner-coverage`, `partner-dashboard-ui-render`,
`estimate-credit-idempotency`, `set-library-postgres.integration`, `partner-public-network-behavioural`.

Two concrete signals from the log:
1. `tests/partner-security-repairs-0047-0048.test.ts:145` `restoreJournalAndSchema` —
   *"Migration … failed and was rolled back"*. **Most likely candidate for a genuine regression from
   this work**: that suite restores the journal and re-runs the chain, which now includes 0063–0066.
   **Start here.**
2. An unhandled `57P01 terminating connection due to administrator command` attributed to
   `partner-public-network-behavioural`. **FIXED in this commit** — the suite imports
   `server/partner/db`, which memoises five pools against the disposable cluster, and stopping the
   cluster underneath them made every one emit 57P01. `afterAll` now calls `closePartnerPools()`
   first. 87/87 locally with no unhandled error.

## EXACT NEXT ACTION
1. Push this commit; wait for CI on the new SHA.
2. Take the 7 failing files from `vitest-report.json` in the CI artefact — **not** from log
   frequency counts, which over-report.
3. Reproduce each with CI's environment before classifying. Start with
   `partner-security-repairs-0047-0048`: if 0063–0066 break its journal restore, that is a genuine
   regression from this work and is release-blocking.
4. The aggregate **CodeQL** check failed while `javascript-typescript` passed — check whether a
   second CodeQL language/config exists, or whether the aggregate is a required-status rollup that
   simply reflects the CI job failure.

## What IS proven at this SHA
Twelve mutations RED (matrix above) · CI-equivalent local suite 4853/0 · AMD64 PASS · gitleaks PASS
· dependency review PASS · CodeQL javascript-typescript PASS · lint 0 errors · build green ·
staging untouched (max 0046) · production untouched (`6f182624`) · MVGS maths unchanged.

---

# FOLLOW_UP — PRE-EXISTING SECURITY DEBT (owner-baselined 2026-08-10)

**30 HIGH/CRITICAL (rule, path) pairs are baselined in `security/codeql-baseline.json`**, pinned
from `refs/heads/main`. 25 of them are still reported on this branch; **0 are new**, proven by set
difference (PR ⧵ main = ∅). Do **not** reopen the Partner release for these.

Nothing is dismissed or suppressed. CodeQL still runs, every finding stays open in the Security
tab, and the only thing that changed is which findings fail a build.

## Why the aggregate `CodeQL` check was red — and why it never blocked the merge
Branch protection on `main` requires exactly five contexts:
`Lint, Type Check, Test & Build` · `linux/amd64 image build & boot` ·
`CodeQL (SAST) (javascript-typescript)` · `PR dependency review` · `Secret scan (gitleaks)`.

The aggregate `CodeQL` check (GitHub Advanced Security) is **not among them**. It flags any alert in
code a PR touches, so on a 125-file PR it reports long-standing repository debt as
*"new alerts in code changed by this pull request"*. **I called it release-blocking in the previous
pass; that was wrong** — it is advisory here.

## The real gap this closed
The required CodeQL context is the ANALYSIS JOB. It proves the analysis RAN and says nothing about
what it FOUND. So before this change a branch introducing a genuinely new HIGH would have gone
green on every required check. The aggregate check looks at findings but cannot tell inherited from
introduced. **Neither enforced the policy, from opposite directions.**

`scripts/ci/assert-codeql-delta.mjs` does, and it runs INSIDE `Lint, Type Check, Test & Build` —
already a required context — so a new HIGH blocks a merge with **no branch-protection change at
all**. `check` also gains an explicit minimal `permissions: {contents: read, security-events: read}`
where it previously inherited an unstated default.

Keyed on **(rule, path)**, not line numbers: the same finding sat at `server/storage.ts:1782` on main
and `:1784` here purely from unrelated edits. Keying on lines would expire the baseline constantly
and train people to re-baseline reflexively. Stated cost: a second instance of the same rule in an
already-baselined file is not distinguished. A new rule, or a known rule in a new file, always is.

## Governance proof — `tests/codeql-delta-gate.test.ts`, 9 tests
inherited HIGH → **passes** · new HIGH in a new file → **RED** · **new rule in an
already-baselined file → RED** (the likeliest real regression) · CRITICAL → RED · medium/low → not
blocking · **analysis did not run → RED even with zero alerts** (a vacuous green is unreachable:
`analysisRan` is a required input, never inferred from an empty list) · a fixed baselined finding
is reported, not failed.

Live dry-run against PR #288: `No new HIGH/CRITICAL. 25 inherited (baselined), 5 baselined
finding(s) no longer reported.` Those five are debt **this branch fixed** —
`js/missing-rate-limiting` on `routes/auth.ts`, `routes/grader.ts`, `routes/staff.ts`,
`routes/submissions.ts`, and `js/polynomial-redos` on `partner/customer-service.ts`.
