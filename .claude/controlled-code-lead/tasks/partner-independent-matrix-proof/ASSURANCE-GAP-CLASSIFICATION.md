# Phase 6 — classification of the five surviving mutations

Each of the five PR #288 mutation survivors was re-examined against the Matrix A/B behavioural
suites and classified **A** (covered behaviourally elsewhere — mutation redundant), **B**
(defence-in-depth — unsafe state unreachable through the real application), or **C** (genuine
missing behavioural coverage). Every C was closed with the smallest behavioural regression test that
turns RED when the mutation is applied, and each of those was **verified by re-applying the exact
mutation and observing the RED**, then restoring the file byte-identically.

| # | Survivor | Class | Verdict |
| --- | --- | --- | --- |
| 1 | `WORKITEM1` | **C** | Genuine gap. Closed by `P14`. |
| 2 | `CERT1` behavioural | **C** | Genuine gap. Closed by `P15`. |
| 3 | `PRINT2` | **C** | Genuine gap. Closed by `T7`. |
| 4 | `CERT2` | **C** | Genuine gap. Closed by `T8`. |
| 5 | `GRADE1` | **C** | Genuine gap. Closed by `G1`. |

None classified A or B. All five were real coverage gaps, and all five are now behavioural.

---

## Mutation-kill verification (the tests are not vacuous)

Protocol per item: record SHA-256 → apply the exact mutation → confirm applied (`git diff --stat`)
→ run the targeted suite → observe RED → `git checkout --` → re-verify SHA-256 byte-identical.

| Mutation | Applied to | New test that turned RED | Restore |
| --- | --- | --- | --- |
| `WORKITEM1` — `if (approved.rows[0].n !== expectedUnits)` made unreachable | `server/partner/partner-submission-credit-lifecycle.ts` | **P14** and **P15** both failed (2 failed \| 12 passed) | byte-identical |
| `CERT1` — both certificate predicates deleted from the gate query | same file | **P15** failed alone (1 failed \| 13 passed) — correctly, since P14 targets the cardinality gate | byte-identical |
| `PRINT2` — batch-phase allow-list widened to admit `in_grading` / `received` | `server/print-workflow.ts` | **T7** failed (1 failed \| 8 passed) | byte-identical |
| `CERT2` — cross-tenant guard `size > 1` → `size > 99` | `server/print-workflow.ts` | **T8** failed (1 failed \| 8 passed) | byte-identical |
| `REVIEW1` — `review_required = true` → `false` | `server/partner/grading-routes.ts` | **G3** failed (1 failed \| 7 passed) | byte-identical |
| `GRADE1` — the **exact surviving mutation**: `applyCertGradeDraft(certId, partnerGradeBody(req.body))` → `applyCertGradeDraft(certId, (req.body ?? {}))` | `server/partner/grading-routes.ts` | **G1** failed (1 failed \| 7 passed) | byte-identical |

`REVIEW1` was previously catchable only at the contract layer and is included because the same new
suite now covers it behaviourally.

`server/grader.ts` was never modified at any point — SHA-256
`32b57f7e49de7f77fa1f9209b58c52c4fba34f7b81f594694b06e8c8adde439d` at Stage 0 and at Stage 7.

---

## Per-item reasoning

### 1. WORKITEM1 — class C

`assertPartnerGradingApprovedForSettlement`'s cardinality comparison is the second layer behind the
mirror's `bool_and` completeness check. The first layer *is* proven (pilot P2), so the product was
never at risk — but the second layer carried no evidence at all and could be deleted silently.

**Closed by P14** (`tests/partner-full-pilot-workflow.test.ts`): a submission whose work items are
still `pending_review` is driven straight into the real
`settlePartnerCreditForDestinationStatus(dest, 'ready_to_return')`. It must reject, write a durable
`partner_credit_accounting_exceptions` row with `reason_code='partner_grading_approval_missing'`,
leave the wallet at 8 / 2 / 0, and leave the destination at `in_grading`.

### 2. CERT1 behavioural — class C

The two certificate predicates (`cert.grader_status = 'approved'`, `cert.grade_approved_at IS NOT
NULL`) were held only by a source-string pin.

**Closed by P15**: work items forced to `approved` while the certificates stay unpublished — the
one state where the cardinality check alone passes and only the certificate predicates can refuse.
Includes a positive control: publishing both certificates makes the *same* call settle to 8 / 0 / 2,
so the test cannot pass by refusing everything.

### 3. PRINT2 — class C

`partner_settlement_required` appeared nowhere in `tests/`. It is the gate that stops labels being
rendered for a Partner submission whose credits have not settled.

**Closed by T7** (`tests/partner-completion-cascade.test.ts`): an unsettled destination
(`in_grading`) is refused at the `batch` phase for every certificate, is **not** refused for that
reason at the `complete` phase (the gate is deliberately phase-specific), and a settled destination
batches cleanly.

### 4. CERT2 — class C

`cross_tenant_partner_batch` appeared nowhere in `tests/`. Two partners' cards on one print sheet is
a physical mis-shipment risk.

**Closed by T8**: two genuinely different tenants' certificates in one call are refused, the refusal
covers **every** certificate in the batch rather than only the intruders, and each tenant's own set
alone is accepted.

### 5. GRADE1 — class C

This is the one that survived outright. The pin
`not.toMatch(/applyCertGradeDraft\(certId,\s*req\.body/)` does not match `(req.body ?? {})`, and the
companion `toContain("partnerGradeBody(req.body)")` stays satisfied by the two other call sites.

**Closed by G1** (`tests/partner-grading-http-routes.test.ts`, new): a real authenticated partner
`PUT /api/partner/grading/certificates/:id/grade` carrying `private_notes` must not land that value
in the certificate, while a legitimate field on the **same** request does change — so the test
cannot pass because the write failed. It asserts observed state, so no rewriting of the call site
can evade it.

**G2** (camelCase `privateNotes`) is labelled **defence-in-depth in the test itself**, because
mutation testing showed it stays green under the GRADE1 mutation: `applyCertGradeDraft` reads only
`body.private_notes`, so the camelCase spelling has no write path today.

---

## A-4 — the largest gap in the PR, now closed

> *"No suite issues an HTTP request to `/api/partner/grading/*`."*

Confirmed exactly: the only occurrence of that path anywhere in `tests/` was a source-string
assertion. `tests/partner-grading-http-routes.test.ts` is now the first and only behavioural
coverage: it boots the real `registerPartnerPublicRoutes` + `mountPartnerPortal` composition against
a self-provisioned PostgreSQL 17 and the disposable MinIO, logs a real partner user in, and drives
the queue, the draft save and the submit-for-review transition over HTTP (8 tests).

Building it immediately produced findings a source pin could never reach:

- `loadPartnerCert` and the queue both `LEFT JOIN cards`, so every grading route 500s with
  `relation "cards" does not exist` if that table is absent from the fixture.
- `applyCertGradeDraft` writes three columns — `private_notes`, `auth_status`, `auth_notes` — that
  **`shared/schema.ts` does not declare at all**. All three are present on the live table.
- and the open production defect below.
