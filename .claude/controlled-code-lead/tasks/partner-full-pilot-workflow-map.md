# Canonical Partner pilot workflow map (verified against HEAD 21c8462d)

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
| 11 | Label / print / completion | print workflow (`print_state`, `label_prints`) | admin | not yet mapped in detail — see gaps |

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

## Gaps still to map before the test can be completed

- Label render + print authorisation + print-event rows: the exact route/service chain and which
  table carries the authoritative print event (`label_prints` vs `print_state` on `certificates`).
- Reprint reason/audit enforcement path.
- What marks a work item, a card unit and a Partner submission COMPLETE, and the cardinality between
  them (stage 11 above is the least-mapped stage).
- Whether any public-visibility gate reads certificate state directly or via a cached artifact.

Until these are mapped, the full-pilot test can be built truthfully as far as stage 10 and must stop
there rather than assert invented completion semantics.
