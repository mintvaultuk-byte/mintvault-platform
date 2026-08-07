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
