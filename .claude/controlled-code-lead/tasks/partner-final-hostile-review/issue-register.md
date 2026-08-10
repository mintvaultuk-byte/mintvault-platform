# Issue register — partner-final-hostile-review

Baseline `2ee13763`. Ten hostile read-only reviewers; **7 of 10 reported** at time of writing
(A8 RLS/RBAC, A9 migration 0045, A10 test vacuity still running).

Every BLOCKER/HIGH below has been **personally verified by the Lead** against the source at
absolute paths, or reproduced on a real PostgreSQL 17 cluster. Findings the Lead could not
confirm are marked as such.

> **Lead error, recorded for honesty.** An initial verification pass of A5-F1 and A6-F1 was run
> against a stale shell working directory and returned "code does not exist". That was wrong.
> Re-verified with absolute paths: both findings are real. No conclusion was drawn from the bad
> pass; it is recorded because a hostile review that hides its own misfires is not a hostile review.

---

## Confirmed HIGH — repairable outside protected files

### H1 · Partner certificates permanently record a NULL trading name (A6-F1)
**`server/partner/connector-import-service.ts:91`** — `NULL::text AS partner_trading_name`.

Verified by the Lead:
- `partner_profiles` is referenced **0 times** in the file (`grep -c` = 0), yet
  `partner_profiles.trading_name` is the documented customer-facing "Graded by ⟨X⟩"
  (`shared/schema.ts:1117`, rendered at `server/labels.ts:749-753`).
- The guard at `:101` — `if (!snapshot || !(snapshot.partner_trading_name || snapshot.partner_legal_name))` —
  is **dead code**: `migrations/0001_partner_foundation.sql:49` declares `legal_name text NOT NULL`,
  so the right operand is always truthy.
- `migrations/0035_partner_certificate_origin.sql` installs a set-once immutability trigger
  `ENABLE ALWAYS` covering `origin_partner_trading_name`. **Every certificate issued during the
  pilot is unfixable in place** — correcting it would require deleting and reissuing.

Impact: every partner slab and certificate PDF prints the **legal entity name** instead of the
shop's trading name. For a sole trader that publishes an individual's legal name on a permanent
physical product.

Fix (verified safe): `LEFT JOIN partner_profiles p ON p.tenant_id = o.id` and select
`p.trading_name`. `partner_profiles.tenant_id` is `NOT NULL UNIQUE REFERENCES partner_organisations(id)`
(`migrations/0015_partner_management.sql:26`), so the join cannot fan out.
**Classification A. Must land before any partner certificate is issued.**

### H2 · A mutating `GET` strands a submitted card permanently (A5-F1 = A1-F2 = A3-F1)
**`server/partner/grading-routes.ts:376-399`**, write at `:384-393`.

Three reviewers found this independently. Verified by the Lead, reading lines 376-399 and 147-156:
- `GET /api/partner/grading/certificates/:id/images` performs
  `UPDATE partner_grading_work_items SET … status = CASE WHEN assigned_partner_grader_id IS NULL
  THEN status ELSE 'assigned' END` with **no predicate on the current status**.
- `authorizeAssigned` (`:147-156`) rejects only `gradingStatus === "approved"`, so a
  `pending_review` card passes.
- `mirrorPartnerApproval` keys on `pgwi.status = 'pending_review'`
  (`grading-review-mirror.ts:43-56`), so after the regression it returns `not_partner`, and
  `server/routes/grader.ts` treats `not_partner` as **success** — the Super Admin sees `200 {ok:true}`.

Terminal state: certificate published; work item frozen at `assigned`; destination never reaches
`ready_to_return`; credits held for 365 days. No in-app recovery — every re-entry route 409s or
matches 0 rows. Reachable by an authenticated `GET`, so neither the CSRF origin check (safe methods
skipped) nor `SameSite=Lax` applies, and it is the only mutating handler in the file carrying
neither `requireNotViewOnly` nor `requireNotSensitiveFrozen`.

Fix: add `AND status IN ('ready_for_assignment','assigned','returned_for_change')` to the WHERE.
**Classification A/B.**

### H3 · Completion blocked forever after an authorised credit recovery (A1-F1 = A7-F2)
**`server/print-workflow.ts:1073, 1113, 1150`** — `AND r.status <> 'consumed'`, three copies.

Verified by the Lead: `migrations/0017_partner_credit_reservations.sql:51` defines four statuses
(`active`, `consumed`, `released`, `expired`). `released`/`expired` are **terminal settled**
states, and the authorised-recovery path deliberately leaves a released predecessor carrying the
same `submission_reference` as its live replacement. So after any recovery the predicate is
permanently true and the submission can never complete — while `cancelSubmission` independently
refuses the same mixed state (A2-F2), leaving no exit at all.

⚠ **The one-word fix both reviewers proposed (`r.status = 'active'`) is NOT obviously safe and has
NOT been applied.** A submission whose reservations are *all* `released` (an ordinary cancellation)
would then satisfy the predicate and could complete with zero credits consumed — free grading. The
correct repair must express "no live reservation remains **and** the expected units were consumed".
Deferred pending design + a test that pins the free-grading direction. **Classification A, designed
fix required.**

### H4 · Concurrent approval of two cards of one submission → neither settles (A4-F1)
**`server/partner/grading-review-mirror.ts:78-90`** — completeness read with no lock.

**Reproduced by the Lead** on real PostgreSQL 17 with a forced overlap
(`evidence/A4-F1-write-skew-repro.txt`):

```
T1 UPDATE cert 101 -> 1 row locked   T2 UPDATE cert 102 -> 1 row locked  (different rows, no block)
T1 completeness -> all_approved = false
T2 completeness -> all_approved = false
settles = 0        <- both approved, NEITHER settles
CONTROL (sequential) -> settles = 1  <- non-vacuity proof
```

Candidate fix also proven in the same harness (`SELECT … WHERE destination_submission_id = … ORDER BY id FOR UPDATE`
before the per-card UPDATE): T2 genuinely blocks, then exactly one settles. Double-settle is
provably impossible (cycle argument), so only the "neither" direction is live.
**Classification A.**

---

## Confirmed HIGH — requires OWNER APPROVAL (protected file)

### D-1 · Grading save destroys `private_notes` and resets the authenticity verdict
Reproduced independently on real PostgreSQL; **larger than previously reported** and
**pre-existing on `main`**, affecting the live HQ staff grading path as well as the partner path.
Full analysis, exact proposed lines, and why grading mathematics is unaffected:
[`D1-REPRODUCTION.md`](D1-REPRODUCTION.md). **OWNER APPROVAL REQUIRED.**

---

## HIGH — architectural, owner decision (not a repair)

### A5-F2 · No server-side MVGS authority on the partner write path
`server/grader.ts:761, 797-798, 805, 816-819` persist the client's `overall_grade` and all four
sub-grades **verbatim**; `grep` confirms no `computeMvgsScore`/`scoreMvgsV2` call on any partner
path. The reviewer framed this honestly and the Lead agrees: this is the **pre-existing** grader
trust model, not a regression introduced by PR #288. What changes is that the party inside that
trust boundary becomes an **external third-party business**. The sole residual control is mandatory
Super Admin review before publication (which this PR correctly tightens from `requireAdmin` to
`requireSuperAdmin`).

Not repaired here: fixing it is a Partner-platform architecture change, explicitly out of scope for
this pass, and the server-authority work already exists on a separate unmerged branch.
**Owner decision required before pilot: accept human review as the control, or block on server authority.**

---

## Confirmed MEDIUM (not repaired this pass)

| ID | Summary | File |
|---|---|---|
| A3-F2 | Nested pooled acquisition inside a held connector transaction → pool-starvation hang; **empirically reproduced by the reviewer**; no acquire/statement/lock timeout by default | `connector-reconciliation-service.ts:421` |
| A3-F3 | Source fingerprint not injective — unescaped `\|` join; **collision computed**; defeats the stale-source guard on printed identity fields | `connector-fingerprint.ts:111` |
| A7-F1 | B2 archival head-of-line blocks forever on any cert naming an absent R2 key; refusal changes no durable state; 50 such rows stall all backup | `workers/r2-to-b2-archival.ts:213, 333` |
| A7-F5 | Batched print artefact never invalidated when a grade is corrected after batching; serve-time guard checks printability, not freshness | `routes.ts:6217-6272` |
| A5-F3 | `partnerGradeBody()` is a two-key deny list; a partner can write `auth_status`/`auth_notes` as unvalidated free text | `grading-routes.ts:85-91` |
| A5-F4 | No zod validation on the partner grade body; malformed numerics 500; out-of-range sub-grades publish | `grading-routes.ts:440,482,553` |
| A5-F5 | Proxied `/identify` has no AI-specific rate limit — 60 paid vision calls/min/user | `routes.ts:9192` |
| A5-F6 | Six JSONB columns written unbounded from a 10 MB body | `grader.ts:824-829` |
| A2-F1 | Expiry sweep rethrows outside a 3-code allowlist and re-selects the same row every tick — the only automatic reservation-leak recovery | `partner-credit-reservation-service.ts:866` |
| A2-F2 | After an authorised recovery the submission can never be cancelled either (pairs with H3) | `partner-submission-credit-lifecycle.ts:619-624` |
| A6-F2 | Public cert page leaks tenant/submission/card UUIDs inside the presigned image URL when no recrop occurred | `connector-import-service.ts:116` |
| A6-F3 | Partner provenance printed on the slab but absent from every public verification surface | `routes.ts:628-670` |
| A6-F4 | Connector pool allocates `cert_counter` with no same-database topology assertion | `connector-db.ts` / `connector-import-service.ts:57-67` |
| A1-F5 | A cancelled, credit-refunded submission can still be graded and published; the hold gate sits only at settlement, after publication | `grading-routes.ts:93-145` |
| A1-F6 / A7-F3 / A2-F5 / A4-F4 | `'void'` is honoured by four guards and **written by nothing** — Lead-verified, `grep` returns no writer. One stuck card blocks its whole submission with no operator remedy | `0045` + 4 readers |
| A1-F7 | Partner-visible status reports nothing between submit and completion; `completed` renders as a raw unlabelled string counted by no tile | `submission-service.ts:1170-1181` |
| A1-F8 / A7-F4 | Single-card reprint impossible on a partner submission after first print | `print-workflow.ts:606-609` |
| A7-F7 | `requireCompletePartnerSubmissionSet` fails **open** on unnormalised cert ids | `print-workflow.ts:327-333` |

## LOW / observations
A1-F9 (dead branches), A1-F10 (`cancelSubmission` status guard weaker than its documented machine),
A2-F3/F4, A3-F4 (ABBA lock order, cancellation vs reconciliation), A3-F6/F7, A5-F7/F8/F9,
A6-F4b, A7-F6 (production orphan leak under `partner-submissions/`), A7-F8, A7-F9, A7-F10,
A7-F11 (`R2_FORCE_PATH_STYLE` test switch on the production client).

## Reviewer claims the Lead has NOT independently confirmed
- A3-F2's pool-starvation reproduction (reviewer ran it; Lead did not re-run).
- A3-F3's fingerprint collision (reviewer computed it; Lead did not re-run).
- All MEDIUM/LOW findings above are recorded on reviewer evidence only.

---

# ADDENDUM — Agents 9 and 10 (A8 RLS/RBAC still running)

## BLOCKER B1 · The reviewed code has never been through CI (A10-F2)
**Lead-verified with read-only `gh` calls:**
```
PR #288 head                = f6b840fe38e6cc9bde196993b1edec99fa491ec8   (OPEN)
check-runs for 2ee13763     = HTTP 422 "No commit found for SHA"
git diff --stat f6b840fe HEAD = 125 files changed, 13365 insertions(+), 34 deletions(-)
```
The last three commits do not exist on GitHub at all. **PR #288's green tick certifies a tree
13,365 lines behind the one under review.** Everything never executed by CI includes:
`tests/partner-grading-http-routes.test.ts` (+734 — the only behavioural coverage of
`/api/partner/grading/*`), the D-2 `ci.yml` wiring, the new `mintvault_partner_admin_shell`
database and CREATEROLE preflight, and every raised/new execution floor.

**This invalidates the premise of the assurance figures in the task brief.** "281 files / 5136
passed / all six CI execution floors pass" are *local-machine* results. Under the governance
Definition of Proof they are **Local Proof**, not Integration Proof. Resolving this needs a push —
a protected action the Lead cannot self-authorise.

## BLOCKER B2 · `main` has no branch protection; every execution floor is advisory (A10-F1)
**Lead-verified:**
```
gh api repos/:owner/:repo/branches/main/protection -> 404 "Branch not protected"
gh api repos/:owner/:repo/rulesets                 -> []
repo visibility                                    -> PUBLIC (mintvaultuk-byte/mintvault-platform)
```
Six assert-executed scripts, ~34 execution floors, the `if: always()` wiring and the amd64 boot
proof are enforced **only** by the CI job's exit code, and nothing converts that into a merge
block. A red build, a missing floor, a failed `tsc`, a failed amd64 proof — all mergeable today.
This is the load-bearing gate under every other assurance claim in the PR. Repository-settings
change; owner action.

## HIGH · A9-F1 — migration 0045 is a ONE-WAY DOOR on staging as reported
`rollback-0045-partner-grading-work-items.sql:53-60` refuses if **any** journal row is numbered
> 45. Staging is reported to have journalled `0046_partner_mfa_pending_lifecycle.sql`. The
reviewer reproduced the refusal on a disposable cluster (table survives — fails closed, correctly).
**One read-only query settles it and the Lead should run it on BOTH hosts before authorising:**
```sql
SELECT filename, status, completed_at FROM schema_migrations
 WHERE filename ~ '^[0-9]{4}_' AND left(filename,4)::integer >= 44 ORDER BY filename;
```

## HIGH · A9-F2 — 0045 write-blocks the PROTECTED `certificates` table for its whole transaction
Eleven non-`CONCURRENTLY` unique indexes on nine pre-existing tables, no `-- migrate:no-transaction`
marker, so the runner wraps the entire file in one transaction. `pg_locks` measured mid-flight:
`certificates`, `submission_items`, `submissions` all hold `ShareLock` + `ShareRowExclusiveLock`,
which conflict with the `RowExclusiveLock` every INSERT/UPDATE takes. No certificate can be issued
for the duration. Reads (the public trust surface) stay available. Likely sub-second at pilot
volume — but nothing bounds it, and it must be **measured**, not assumed.

## Also from A9/A10 (MEDIUM)
- A9-F3 — `partner-grading-bridge-migration.test.ts` (12 tests, the only forward+rollback+reapply
  proof) has **no execution floor and no in-file CI guard**. One line fixes it.
- A9-F4 — every main-pool write to the FORCE-RLS 0045 table depends on an unasserted `BYPASSRLS`
  attribute; the route tests connect as `postgres` (superuser) so they structurally cannot detect
  it. Silent failure mode is a permanent 409. Settle with
  `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;` on each host.
- A10-F4 — **15 gated partner suites (273 tests) have no execution floor**; 7 of them (101 tests)
  also have no in-file CI guard. Includes `partner-workflow-apis` (49 tests — the sole behavioural
  detector for mutation `CUSTOMER1`) and `partner-dashboard-integration` (28 tests, which `ci.yml`'s
  own prose calls load-bearing). This is the *fifth* instance of the repo's recurring failure class,
  and it is structural rather than a missing variable.
- A10-F5 — two floors sit **below** their real counts (`partner-management-integration` 24 vs 28,
  `partner-lockout-recovery` 13 vs 16), permitting silent test deletion. Two scripts carry
  contradictory floor policies.
- A10-F6/F7 — the "every grading route is rate limited" regex cannot see a named handler and its
  floor equals the exact current count; 155 source-text pins carry the grading adapter's contract
  and the PR's own matrix proves that class is evadable.
- A10-F8 — `G1b` (the D-1 characterisation test) is inside a must-pass floor asserting an open
  data-destroying defect as expected behaviour; fixing D-1 turns CI red.

## Agent 9's positive verdict on 0045 itself, recorded because it is signal
Applied + re-applied: a 6,611-object snapshot was **byte-identical**. Rollback: *"PERFECT REVERSAL —
zero schema residue across 6319 objects."* Grants least-privilege and column-scoped; no migration
other than 0045 grants to `partner_connector_runtime` on the affected tables; RLS `ENABLE`+`FORCE`
with `USING` and `WITH CHECK`; destructive-lint clean; duplicate migration *numbers* fail closed
before any DB contact. The reviewer could not break the SQL body. The two open questions are
external to it (A9-F1, A9-F2).

---

# ADDENDUM 2 — Agent 8 (RLS / RBAC / tenant isolation). ALL TEN REVIEWERS NOW REPORTED.

Agent 8 built a disposable local cluster, applied all 28 partner migrations as the **non-superuser**
`pn_migrator`, and probed as real `NOSUPERUSER NOBYPASSRLS` roles. No Neon host contacted.

## HIGH · A8-F1 — `partner_owner_invariant_tenants` has NO RLS and is granted to `partner_runtime`
**Lead-verified in `migrations/0032_partner_final_owner_invariant.sql`:**
- table created at `:9`; `GRANT SELECT, INSERT ON partner_owner_invariant_tenants TO partner_runtime` at `:117`
- the file's five `ROW LEVEL SECURITY` statements (`:26,27,38,39`) all concern
  `partner_users` / `partner_user_roles` — a FORCE toggle around a backfill. **This table never gets
  `ENABLE ROW LEVEL SECURITY` and never gets a policy.**

Reviewer's live probe as `partner_runtime` with a *correct* tenant-A GUC: `partner_organisations`
returns 1 row (isolated), `partner_owner_invariant_tenants` returns **both tenants**. With no GUC and
with a malformed GUC, every RLS table returns 0 and this one still returns 2 — it ignores tenant
context entirely.

Impact: any authenticated partner session that reaches SQL can enumerate every tenant UUID on the
network plus each one's onboarding timestamp; the `INSERT` grant lets one tenant pin another into the
owner invariant. **Pre-existing (0032), not introduced by PR #288**, but live on the partner surface.
It is the only tenant-keyed table that both lacks RLS *and* is granted to `partner_runtime`; the
other three RLS-less tenant tables are documented exceptions with no `partner_runtime` grant.

## HIGH · A8-F2 — 0044's location-snapshot trigger is `pg_temp`-shadowable
**Lead-verified**, `migrations/0044_…:131-158`: `CREATE OR REPLACE FUNCTION
partner_submissions_capture_location_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$` — **no
`SET search_path`** — and the body reads `FROM partner_locations l` **unqualified**.

Migration 0006 documents this exact attack and pins `search_path` on every definer function; 0044 did
not carry it forward. Reviewer's live probe: `CREATE TEMP TABLE partner_locations …` then an ordinary
insert produced `location_name_snapshot = 'FORGED ORIGIN — Tenant B Shop'`, bypassing the
`AND l.tenant_id = NEW.tenant_id` guard (evaluated against the attacker's temp table).

`SECURITY INVOKER`, so no privilege escalation — this is a **provenance/integrity** defeat of the
snapshot the migration header says exists so submission origin cannot disagree with the certificate's
`ENABLE ALWAYS` origin snapshot. One-line fix. `definer-guard.ts` does not cover INVOKER trigger
functions, so nothing detects it.

## HIGH · A8-F3 — six FORCE-RLS work-item writes never set `app.tenant_id`
Independently corroborates **A9-F4** from a second angle, and sharpens it: `grep` for
`set_config|app.tenant_id` across `grading-routes.ts`, `grading-assignment.ts` and
`grading-review-mirror.ts` returns **nothing**. Correctness rests entirely on `BYPASSRLS`, and
`partnerGradingRouter()` is the first tenant-facing router on the admin pool that does **not** call
`getPartnerAdminCapability()` — the gate every other admin router carries.

The repo contradicts itself on the production fact: `tests/partner-rls-isolation.test.ts:1475`
says the runtime role is `rolbypassrls = FALSE`, while `partner-submission-credit-lifecycle.ts:1042`
says the `MINTVAULT_DATABASE_URL` owner is **NOT** BYPASSRLS — and `db.ts` falls back to that URL while
`partnerAdminDbConfigured()` still returns true. Failure is silent at `grading-routes.ts:384` (result
discarded) and splits state at `grading-assignment.ts:93` (the `certificates` UPDATE succeeds, the
work-item mirror writes nothing).

## HIGH · A8-F4 — the "every partner table has RLS" sweep is an 11-entry allowlist
**Lead-verified** at `tests/partner-rls-isolation.test.ts:1059-1071`: `TENANT_TABLES` is a hardcoded
11-name list, and the sweep is scoped `AND c.relname = ANY($1::text[])`. Its own comment claims it
"catches a NEW tenant-scoped table landing in a future migration with the RLS block forgotten" — it
cannot. The reviewer's catalogue shows **34** tenant-keyed tables. This is exactly how A8-F1 survived.

Second half: `tests/partner-grading-http-routes.test.ts:455-457` and
`tests/partner-full-pilot-workflow.test.ts:514-517` assign the **superuser** cluster URL to
`MINTVAULT_DATABASE_URL`, `PARTNER_ADMIN_DATABASE_URL` and `PARTNER_CONNECTOR_DATABASE_URL`. So the
734-line grading suite and the 1,276-line pilot suite exercise every A8-F3 path with **RLS fully
bypassed**, and neither carries the `expect(rolsuper).toBe(false)` guard the RLS harness has.

## MEDIUM (A8)
- **A8-F5** — 0045 grants `partner_connector_runtime` table-level `UPDATE` on `cert_counter` and
  `USAGE, SELECT` on `certificates_id_seq`, reversing the policy 0001:273-277 states in writing
  ("an isolation leak — so it is deliberately omitted"). Reviewer rewound the counter 165 → 1 as that
  role. The grant is inside `IF to_regclass('public.cert_counter') IS NOT NULL`, so it is a **no-op in
  the test fixture** (which has no `cert_counter`) and **will fire on staging and prod**.
- **A8-F6** — the partner allocator holds the `cert_counter` row lock for the whole import
  transaction; the reviewer measured an HQ/scanner allocation timing out at 2s against it. Production
  has no `lock_timeout` on the HQ pool, so it would block indefinitely.
- **A8-F7** — `ensureDefaultGlobalServiceTiers()` inserts `tenant_id = NULL` against a policy whose
  `WITH CHECK` is `tenant_id = partner_current_tenant()`; `NULL = NULL` → not true → violation.
  First-use-only, so it surfaces when the pilot's first shop opens the wizard.
- **A8-F8 (LOW)** — `app.location_id` is set by `db.ts` and **read by nothing**: zero policies
  reference location. Location isolation is application-predicate-only. The app predicates are correct
  and fail-closed, but the GUC makes it look like a DB boundary exists when it does not.
- **A8-F9 (LOW)** — `definer-guard.ts:151-157` asserts `NOBYPASSRLS` for `partner_runtime` only, not
  `partner_connector_runtime`, whose attribute 0008 leans on and which 0045 now makes load-bearing twice.

## Agent 8's refuted hypothesis, recorded because it is signal
The reviewer suspected `withConnectorTx` never sets the tenant GUC, then **proved itself wrong**:
`connector-import-service.ts:402` sets `app.tenant_id` from the connector's own row before the
work-item insert, and `tests/partner-connector-import-service.test.ts:254-261` drives it as a real
restricted role. Claim withdrawn.

## Agent 8's clean findings
0045's RLS block is correct and self-proving; role attributes and the role graph are clean (no
membership of either runtime role in a definer role); all 8 SECURITY DEFINER functions pin
`search_path` with `pg_temp` last and revoke PUBLIC EXECUTE; fail-closed on missing/malformed tenant
context is real (0 rows, not all rows); `grading-routes.ts` carries explicit tenant **and** location
predicates everywhere RLS is bypassed; MVGS protected files byte-identical.
