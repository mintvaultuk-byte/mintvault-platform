# Canonical Partner pilot workflow map (verified against HEAD 46589030)

Purpose: the production-surface map that must exist BEFORE the full-pilot integration test is
written. Every row below was read from the source on this branch, not inferred. Two earlier attempts
to produce this map via sub-agents stalled; this was mapped directly.

**Why this document exists at all:** writing the pilot test by guessing entry points would have
produced a test that passes against invented behaviour. Finding F1 below is the proof that the risk
was real — the stated acceptance criteria do not match production.

---

## F1 (HIGH) — Approval does NOT consume credits. The submission status transition does.

The acceptance criteria have been stated repeatedly as:

> two Super Admin approvals → consume exactly two credits → wallet 8/0/2

**That is not what production does.** Verified:

- `server/routes/grader.ts:1074-1093` — `POST /api/admin/certificates/:id/approve-grader-grade`
  (`requireSuperAdmin`) calls `approveGraderCert(certId, adminUser)` then `mirrorPartnerApproval(certId, adminUser)`.
  Neither touches credits.
- Settlement is reached only from `server/storage.ts:781-789`, inside `updateSubmissionStatus`:
  ```ts
  if (["ready_to_return", "completed"].includes(status.toLowerCase())) {
    const { settlePartnerCreditForDestinationStatus } = await import("./partner/partner-submission-credit-lifecycle");
    const settled = await settlePartnerCreditForDestinationStatus(id, status, extra);
    if (settled) return settled;
  }
  ```
- `server/partner/partner-submission-credit-lifecycle.ts:30` —
  `const GRADE_COMPLETION_STATUSES = new Set(["ready_to_return", "completed"]);` and `:943` returns
  `null` for any other status.

So the wallet triple after approving both certificates is still **8 / 2 / 0**. It becomes
**8 / 0 / 2** only when the DESTINATION submission (the MintVault `submissions` row created by
connector import) is moved to `ready_to_return` or `completed`.

Consequences for the pilot test:
1. The step that must be asserted as "consume 2" is a submission-status transition, not an approval.
2. Settlement is keyed on the **destination submission**, so it is inherently once-per-submission,
   not once-per-certificate — which is why the atomicity tests in
   `tests/partner-per-card-credit-lifecycle.test.ts` are written against a destination id.
3. Any test asserting "approve → 8/0/2" would be asserting behaviour the product does not have.

This is a documentation/acceptance-criteria mismatch, **not** a product defect: settling on the
grading-complete status is the deliberate G6D design, recorded in the comment at `server/storage.ts:782-785`.

---

## Ordered map

| # | Stage | Production entry point | Auth | Writes |
|---|---|---|---|---|
| 1 | Draft / cards / images | `POST /api/partner/submissions`, `.../cards`, `.../cards/:cardId/images/:side` (`server/partner/submission-routes.ts:370`) | `partner.orders.edit`, mutation limiter | `partner_submissions`, `partner_submission_cards`, R2 objects |
| 2 | Submit + reserve | `submitSubmission` via `POST /api/partner/submissions/:id/submit` | `partner.orders.create` | `partner_submission_handoffs`, one `partner_credit_reservations` row per PHYSICAL unit (`card_reference = partner-submission-card:{cardId}:{ordinal}`) |
| 3 | Connector validate | `connector-validation-service` (sweep) | connector runtime role | `partner_connector_records`, `partner_connector_validation_runs`, findings |
| 4 | Connector import | `connector-import-service` | connector runtime role | `partner_connector_imports`, MintVault `submissions`/`submission_items`, `certificates` (via `cert_counter`), `partner_grading_work_items` (`:629`) |
| 5 | Assign to Partner grader | `POST /api/admin/graders/assign-partner` → `assignPartnerCerts(partnerUserId, certIds, adminUser)` (`server/partner/grading-assignment.ts:32`) | `requireAdmin` | work-item assignment + `assigned_at` |
| 6 | Read queue / images / grading | `GET /api/partner/grading/queue`, `.../certificates/:id/images`, `.../certificates/:id/grading` | `partner.cards.assess`, read limiter | — |
| 7 | Save draft grade | `PUT /api/partner/grading/certificates/:id/grade` (`server/partner/grading-routes.ts:415`) | `partner.cards.assess`, mutation limiter | grading evidence; MVGS computed server-side |
| 8 | Submit for review | `POST /api/partner/grading/certificates/:id/submit` (`:459`) | `partner.cards.assess` | → `pending_review` |
| 9 | **Super Admin approve** | `POST /api/admin/certificates/:id/approve-grader-grade` (`server/routes/grader.ts:1074`) | **`requireSuperAdmin`** | `approveGraderCert` (engine gates) **then** `mirrorPartnerApproval`; 409 on mirror conflict |
| 9b | Reject / return | `POST /api/admin/certificates/:id/reject-grade` (`:1094`) | `requireSuperAdmin` | `rejectCertGrade` + `mirrorPartnerRejection` |
| 10 | **Settle credits** | `updateSubmissionStatus(destinationSubmissionId, "ready_to_return"\|"completed")` (`server/storage.ts:781`) | admin surface | consumes EVERY active reservation, one `-1` ledger row each |
| 11 | Label / print / completion | `server/print-workflow.ts` — `createBatchAtomic` / `markBatchPrinted` / `requestReprint` / `markCompleted` | admin | `print_state`, `label_prints`, `print_events`, then the completion cascade (see Stage 11 below) |

---

## Structural findings the pilot test must respect

**F2 (MEDIUM) — stage 9 is two transactions, not one.** `approveGraderCert` commits, then
`mirrorPartnerApproval` runs separately. The code comment at `server/routes/grader.ts:1084-1087`
states this deliberately: the engine gates and commits first so partner cards pass exactly the same
publish gates as HQ cards, and a mirror conflict returns 409 rather than being swallowed. A crash
between the two leaves an approved certificate whose Partner work item has not moved. The 409 path
is the designed reconciliation signal; the pilot test should assert it exists rather than assume
atomicity across the pair.

**F3 (MEDIUM) — settlement is per-DESTINATION-SUBMISSION, approval is per-CERTIFICATE.** Two cards
produce two certificates but ONE destination submission. So "partial approval" (approve card 1, not
card 2) does not produce partial settlement — settlement has not run at all yet. The Phase 4A
scenario as specified ("approve both, card two's reservation invalid, card one must not remain
consumed") must therefore be driven through the STATUS TRANSITION, not through the approval route.

**F4 (LOW) — assignment is an admin route, not a Partner one.** `POST /api/admin/graders/assign-partner`
is `requireAdmin`, so a Partner user cannot self-assign. The harness needs an admin session for
stage 5 even though the grading itself is done by the Partner.

---

## Stage 11 — label, print and completion (NOW MAPPED, `server/print-workflow.ts`)

| Step | Entry point | Writes |
|---|---|---|
| Batch / label | `createBatchAtomic(...)` (`:448`) | `certificates.print_state = 'printing'` (`:666`), `label_prints (cert_id, sheet_ref, printed_at)` (`:714`), rollback to prior state on failure (`:726`) |
| Mark printed | `markBatchPrinted(batchId, identity)` (`:845`) | `certificates.print_state` (`:890`) + `print_events` |
| Reprint | `requestReprint({...})` (`:928`) | `certificates.print_state = 'reprint_required'` (`:968`) + `print_events` |
| **Complete** | `markCompleted({ certIds, identity })` (`:992`) | `print_events` action `'complete'`, then Partner completion cascade below |

**F5 — `print_events` is the authoritative print evidence, not `label_prints`.** `label_prints` is
written once by `createBatchAtomic` at `:714` and records the sheet. Every state transition
(`complete`, reprint, batch-printed) appends to `print_events` with `(cert_id, actor, actor_role,
action, from_state, to_state)` — that is the audited actor trail a print assertion must read.

**F6 — the completion cascade is a THREE-LEVEL, NOT-EXISTS-guarded cascade inside one transaction**
(`:1031-1081`), and it is the answer to "what completes a work item / card unit / submission":

1. Work item: `UPDATE partner_grading_work_items SET status='completed' … AND pgwi.status='approved'`,
   joined on the full triple `certificate_id` + `submission_item_id` + `destination_submission_id`.
   So a work item can only complete from `approved`, and only via its own certificate.
2. Physical card unit: there is no separate card-unit table — the unit IS the work item
   (one per `submission_item_id`, materialised per physical unit by connector import).
3. Partner submission: completed only where **NOT EXISTS** a sibling work item whose status is not
   in `('completed','void')` **AND NOT EXISTS** a `partner_credit_reservations` row for that
   submission whose status `<> 'consumed'`.

**F7 (HIGH, load-bearing for the acceptance flow) — completion requires settlement to have already
happened.** The second `NOT EXISTS` above means a Partner submission cannot complete while any
reservation is still `active`. Since settlement is what turns reservations `consumed` (stage 10),
the real production order is:

    approve both certs -> destination status -> SETTLE (8/0/2) -> print/complete -> submission completed

Printing before settlement therefore cannot complete the submission — the guard is in the SQL, not
in a service check. A test asserting "print then settle" would be asserting an order production does
not support.

**F8 — `requireCompletePartnerSubmissionSet(certIds, phase)` (`:323`)** gates both `"batch"` and
`"complete"` phases: a partial selection of a Partner submission's certificates is rejected before
either phase proceeds. This is the production mechanism behind the "partial print must not complete
the submission" requirement — it refuses the operation rather than allowing a half-complete state.

## Remaining gap

Public-visibility gates (lookup / slab / share / claim / transfer / cached artifact) are still
unmapped: specifically whether each reads certificate state directly or via a cached artifact, and
which of them key on `grade_approved_at` versus `print_state`. The full-pilot test can now be built
truthfully through stage 11; the public-gate assertions in Phase 8 still need that last map.


---

## Public / downstream gate table (PARTIAL — verified rows only)

| Route | File | Gate actually enforced |
|---|---|---|
| `GET /api/cert/:id` | `server/routes.ts:3030` | **NONE in the route.** `findCertByIdFlex` then `certToPublic` (`:610`). Neither checks `grade_approved_at`. |
| `GET /api/public/slab-image/:certNumber/:kind` | `:3187` | `cert.status !== "active"` OR `cert.gradeOverall == null` -> 404 |
| `GET /api/public/share/:certNumber/feed` | `:3302` | `shareImageHandler("feed")` |
| showcase / recent-graded / population | `:3120`, `:3134`, `:3164` | `grade_approved_at IS NOT NULL` in their SQL (`:1247`, `:3471`, `:12169`, `:12210`, `:12308`) |

**F9 (VERIFIED) — public visibility is NOT gated on settlement, print_state, work-item status, or
consumed-reservation evidence.** `grep print_state server/routes.ts` returns only admin/print-workflow
call sites, and `partner_grading_work_items` appears in `server/routes.ts` only at `:294`, `:2150`,
`:2156` (a join and two information_schema probes) — never in a public predicate.

Consequence for the Phase 9 checkpoints: at checkpoint B (approved but UNSETTLED) the aggregate
public surfaces are already OPEN, because `grade_approved_at` is set at approval and settlement is a
later, independent step. A test asserting "public stays closed until settlement" would fail against
correct production behaviour. Only checkpoints A and C differ, and they differ on APPROVAL, not on
settlement.

## RESOLVED (was an open question) — see F10 below

### Original question, kept for the record

`certToPublic` (`server/routes.ts:610-700`) maps `grade`, `gradeNumeric`, `gradeCentering`,
`gradeCorners`, `gradeEdges`, `gradeSurface` straight off the certificate row with no
`grade_approved_at` check, and `/api/cert/:id` adds none. So the exposure of an UNAPPROVED grade on
that route depends entirely on whether a draft grade is written to `certificates` at all.

The Partner draft route (`server/partner/grading-routes.ts:415`) calls
`applyCertGradeDraft(certId, partnerGradeBody(req.body))`. I did NOT trace where that function
persists to, so I am recording this as an OPEN QUESTION, not a finding.

Two possibilities, with very different consequences:
  * drafts land in a separate evidence/draft store and `certificates.grade_*` is written only at
    approval -> no exposure, and the CERT1 mutation target is the approval writer;
  * drafts land on `certificates` directly -> `/api/cert/:id` would surface an unapproved grade, and
    this would apply to HQ graders too (same shared drafting function), making it PRE-EXISTING and
    NOT partner-specific.

Do not write the checkpoint-A public assertions until this is traced. Claiming a public-exposure
defect without tracing it would be exactly the kind of unverified HIGH this map exists to prevent.


---

## F10 (RESOLVED) — Outcome B: draft grades ARE written to `certificates`. But it is PRE-EXISTING, not a PR #288 regression.

`applyCertGradeDraft` (`server/grader.ts:756`, PROTECTED and byte-identical to origin/main) writes
draft grade fields DIRECTLY onto the certificate row:

```
UPDATE certificates SET
  grade_type       = ...,
  centering_score  = ...,
  corners_score    = ...,
  edges_score      = ...,
  surface_score    = ...,
  auth_status      = ...,
  grade_explanation= ...
WHERE id = $certId AND grade_approved_at IS NULL
```

So Outcome B holds: unapproved grade data lives on `certificates` before approval.

And the public read path applies no approval predicate:
  * `GET /api/cert/:id` -> `findCertByIdFlex` -> `certToPublic`, with no `grade_approved_at` check
    in the handler;
  * `certToPublic` maps `grade`, `gradeNumeric`, `gradeCentering`, `gradeCorners`, `gradeEdges`,
    `gradeSurface` straight off the row — **0** occurrences of `grade_approved_at` inside it.

### Why this is NOT a PR #288 finding

Content-compared against `origin/main`, not by line number (routes.ts moved ~1300 lines on this
branch, so line-based comparison is meaningless):

  * `/api/cert/:id` handler body: IDENTICAL on main and branch (same three statements);
  * `certToPublic`: **0** `grade_approved_at` checks on main, **0** on branch;
  * `server/grader.ts` (the draft writer): byte-identical to main.

The aggregate surfaces (showcase, recent-graded, population, search) DO gate on
`grade_approved_at IS NOT NULL`, and slab-image gates on `status='active' AND gradeOverall != null`.
It is specifically the single-certificate lookup that carries no approval predicate — on both
branches, for HQ and Partner certificates alike.

### What I did NOT verify

Whether a certificate row is actually publicly REACHABLE before approval in practice — i.e. whether
`findCertByIdFlex` or the `status` column filters it out earlier, and what `certificates.status` is
between import and approval. Without that, "an anonymous caller can read an unapproved grade" is
plausible but UNPROVEN, and I am not asserting it.

### Recommendation — owner decision, not a unilateral change in this PR

Adding an approval predicate to `/api/cert/:id` would change PUBLIC CERTIFICATE BEHAVIOUR FOR EVERY
CERTIFICATE, including every legacy HQ certificate — the public trust surface CLAUDE.md lists as
business-critical. That is a product decision, and doing it inside a Partner pilot PR would be
exactly the "change production behaviour to satisfy a test" move this work has repeatedly refused.

Consequences for the pilot test, either way:
  * checkpoint-A assertions should pin the AGGREGATE surfaces (which do gate correctly) rather than
    `/api/cert/:id`;
  * CERT1 should target the approval predicate on an aggregate query, where one demonstrably exists.
