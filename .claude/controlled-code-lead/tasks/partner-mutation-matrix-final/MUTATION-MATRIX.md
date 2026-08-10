# PR #288 — Remaining Mutation Matrix (final)

**Branch:** `opus/partner-mutation-matrix-final`
**Base / starting SHA:** `f6b840fe38e6cc9bde196993b1edec99fa491ec8` (PR #288 head, `codex/partner-grading-bridge-current-main`)
**Worktree:** `/Users/cornelius/mintvault-mutation-matrix-final` (new, isolated; PR #288 worktree untouched)
**Scope:** assurance only. No deploy, no merge, no production, migration 0045 NOT applied to staging,
`server/grader.ts` NOT modified, no MVGS guard weakened.

---

## Phase 0 — freeze

| Check | Result |
| --- | --- |
| Base SHA | `f6b840fe38e6cc9bde196993b1edec99fa491ec8` — confirmed = PR #288 head |
| Worktree clean at start | `git status --porcelain` empty |
| `server/grader.ts` SHA-256 | `32b57f7e49de7f77fa1f9209b58c52c4fba34f7b81f594694b06e8c8adde439d` — identical at start and end |
| MVGS guards | `tests/partner-shop-workflow-source.test.ts` MVGS tripwires green at start and end |
| Concurrent writer | none — dedicated worktree, `node_modules` symlinked read-only from the primary checkout |
| Baseline TypeScript | `tsc --noEmit` clean |
| Baseline suites | 457/457 passing across the 16 suites used below |

**Harness.** Local reproduction of the CI job: Docker `mv-ci-pg17` (PostgreSQL 17, :55433),
`mv-ci-pg16` (:55432), `mv-minio-proof` (MinIO, :9010). Environment variables extracted verbatim from
`.github/workflows/ci.yml`. `LC_ALL=C LANG=C` (without it 17 DB-backed files silently skip).
No staging or production credential was used at any point.

**Protocol applied to every mutation** (scripted, `runmut.sh`): record SHA-256 → apply exact-anchor
mutation (aborts unless the anchor matches exactly once) → prove applied (SHA changed + `git diff --stat`)
→ `tsc --noEmit` must stay clean → run targeted suite → classify RED → `git checkout --` restore →
re-verify SHA-256 byte-identical → residue scan → re-run GREEN.

---

## Phase 1 — redundancy analysis

No mutation from the requested list was dropped; all 16 were executed. The following *candidate*
mutations were considered and deliberately **not** used, because another layer already proves the
invariant:

| Candidate | Dropped because |
| --- | --- |
| Partner **tenant** isolation on customers | Enforced by PostgreSQL RLS below the application layer and already proven by `RLS1`. `CUSTOMER1` was re-pointed at the **location-scope** predicate, which is application-layer only and genuinely unproven. |
| Partner-origin auto-publish gate inside `server/grader.ts` | Target file is protected and out of scope by directive. `ORIGIN1` was re-pointed at the origin **writer** (`connector-import-service.ts`), which is partner-owned code. |
| `partner_grading_work_items` unique/FK cardinality | Enforced by migration 0045 constraints (`uq_partner_grading_work_items_source_unit`, `fk_..._certificate_scope`) below the application layer; already covered by `MIGRATION-CHECKSUM1` / `PARITY1`. |
| Mirror completeness `bool_and(status='approved')` | This is the exact target of the already-proven `APPROVAL-SETTLE1` (pilot P2). Re-running it would duplicate existing evidence. `WORKITEM1` was pointed at the independent **second-layer** settlement gate instead. |
| Certificate approval write itself | `approveGraderCert` is the single writer inside the protected engine; already covered by `FINAL-APPROVAL1`. |

---

## Phase 2 — results

Legend
**PROVEN (behavioural)** — a real runtime/DB assertion failed.
**PROVEN (contract)** — a source-contract pin failed; no behavioural coverage exists for that seam.
**SURVIVED** — no suite detected the mutation.

| # | Mutation | Target | Change | Outcome | Failing evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | `ROLE1` | `server/partner/team-service.ts` `requirePortalTeamRole` | `Object.prototype.hasOwnProperty.call(...)` → `raw in ...` | **PROVEN (behavioural)** | `partner-role-allowlist` — "rejects prototype keys for Partner Portal team roles" |
| 2 | `CUSTOMER1` | `server/partner/customer-service.ts` `visibleCustomerPredicate` | drop `ps.location_id = ANY(...)` scope | **PROVEN (behavioural)** | `partner-workflow-apis` — "location-scoped users cannot list or edit customers tied only to unassigned locations" |
| 3 | `TIER1` | `server/partner/submission-service.ts` submit-time tier revalidation | drop `AND is_active` | **PROVEN (behavioural)** | `partner-submission-workflow` — `service_tier_unavailable` no longer returned |
| 4 | `COUNT1` | `server/partner/submission-service.ts` credit-unit expansion | collapse the `quantity` ordinal loop to one unit per card row | **PROVEN (behavioural, financial)** | `partner-per-card-credit-lifecycle` — a quantity-5 card reserved **1** credit instead of 5 |
| 5 | `COMPLETE1` | `server/print-workflow.ts` `complete_partner_submissions` CTE | drop the unconsumed-reservation `NOT EXISTS` | **PROVEN (behavioural, financial)** | `partner-completion-cascade` T4 — an active reservation no longer blocked completion |
| 6 | `IMAGE1` | `server/partner/submission-service.ts` submit-time image verification | remove `headR2(front)/headR2(back)` | **PROVEN (behavioural)** | `partner-portal-mount-integration` — full lifecycle: unverifiable image accepted at submit |
| 7 | `ORIGIN1` | `server/partner/connector-import-service.ts` origin stamp | `'PARTNER'` → `'HQ'` | **PROVEN (behavioural)** | 8 DB-driven `partner-connector-import-service` tests + source pin. Immediate refusal came from migration 0035's CHECK constraint — recorded as **defence-in-depth** |
| 8 | `WIZARD1` | `client/src/pages/partner/submission-wizard.tsx` | remove `\|\| submitting` re-entry guard | **PROVEN (contract)** | `partner-submission-wizard-ui` — "guards handleSubmit against re-entry" |
| 9 | `RECROP1` | `server/routes.ts` recrop handler | `if (!partnerProxied) await writeCanonicalObjects()` → unconditional | **PROVEN (contract)** | `partner-shop-workflow-source` — "defers the partner canonical writes until after the guarded UPDATE" |
| 10 | `REVIEW1` | `server/partner/grading-routes.ts` `partnerSubmitForReview` | `review_required = true` → `false` | **PROVEN (contract)** | `partner-shop-workflow-source` — grading-adapter authorisation pin. **No behavioural coverage exists.** |
| 11 | `CERT1` | `server/partner/partner-submission-credit-lifecycle.ts` `assertPartnerGradingApprovedForSettlement` | drop `cert.grader_status='approved'` + `cert.grade_approved_at IS NOT NULL` | **PROVEN (contract) / SURVIVED behaviourally** | Source pin only. Re-run excluding the source suite: 78/78 green — no behavioural detection |
| 12 | `GRADE1` | `server/partner/grading-routes.ts` `/grade` | `partnerGradeBody(req.body)` → `(req.body ?? {})` | **SURVIVED** | The regex pin `not.toMatch(/applyCertGradeDraft\(certId,\s*req\.body/)` does not match this shape, and `toContain("partnerGradeBody(req.body)")` is satisfied by the two other call sites. Control probe `GRADE1-LITERAL` (literal `req.body`) **is** caught — so the pin exists but is evadable |
| 13 | `WORKITEM1` | same function, cardinality test | `n !== expectedUnits` → gate can never fire | **SURVIVED** | 104/104 green. The entire settlement-side work-item approval gate is untested |
| 14 | `PRINT2` | `server/print-workflow.ts` batch-phase settlement gate | admit `in_grading` / `received` destinations | **SURVIVED** | 73/73 green. `partner_settlement_required` has no test anywhere in `tests/` |
| 15 | `CERT2` | `server/print-workflow.ts` cross-tenant batch guard | `size > 1` → `size > 99` | **SURVIVED** | 45/45 green. `cross_tenant_partner_batch` has no test anywhere in `tests/` |
| 16 | `IMAGE2` | `server/partner/submission-service.ts` `cardImageKeyAllowed` | accept any `partner-submissions/` key | **SURVIVED (defence-in-depth)** | 133/133 green. Image keys are **always** server-generated by `cardImageKey(principal.tenantId, …)`; no client-supplied-key path exists, so no unsafe state is reachable through the application today |

Every run: `tsc` exit 0, restore byte-identical, residue scan empty, GREEN re-run exit 0.
No RED was compile-only, skipped, env-aborted, timeout-only, unrelated, or mutation-not-applied.

---

## New defects (assurance gaps in PR #288 — none are production defects)

1. **A-1 — The entire settlement-side partner grading approval gate is unproven.**
   `assertPartnerGradingApprovedForSettlement` can be disabled (`WORKITEM1`) or stripped of its
   approval predicate (`CERT1`) with zero behavioural detection. It is a genuine second layer behind
   the mirror's `bool_and` completeness check (which *is* proven by `APPROVAL-SETTLE1`), so the
   product is not currently at risk — but the layer itself carries no evidence.
   *Fix:* a test that drives `settlePartnerCreditForDestinationStatus` with a work item left
   `pending_review` and asserts `partner_grading_approval_missing`.

2. **A-2 — Two print-workflow partner gates have no test at all.**
   `partner_settlement_required` (`PRINT2`) and `cross_tenant_partner_batch` (`CERT2`) are reachable
   rejection codes with no coverage; only `partner_submission_incomplete` is tested.

3. **A-3 — The partner PII-strip pin is evadable.**
   `GRADE1` survived while `GRADE1-LITERAL` failed. The pin matches one literal token shape and a
   `toContain` that any of three call sites satisfies. A per-call-site assertion (or a behavioural
   test asserting `private_notes` never reaches `applyCertGradeDraft`) is needed.

4. **A-4 — No behavioural coverage exists for `server/partner/grading-routes.ts` at all.**
   No suite issues an HTTP request to `/api/partner/grading/*`. `REVIEW1`, `GRADE1` and the whole
   partner grading adapter rest on source-string pins. This is the single largest evidence gap in the
   PR, and it is why three of the sixteen mutations could only be proven at the contract layer.

## Production defects

**None found.** No mutation revealed an unsafe state reachable in the shipped code. `IMAGE2` and the
DB-CHECK refusal in `ORIGIN1` are recorded as defence-in-depth working as designed.

---

## Closing state

| Item | Value |
| --- | --- |
| Worktree | `git status --porcelain` empty; `git diff f6b840fe` empty |
| `server/grader.ts` | `32b57f7e49de7f77fa1f9209b58c52c4fba34f7b81f594694b06e8c8adde439d` (unchanged) |
| TypeScript | `tsc --noEmit` clean |
| Final suite run | 16 files, **457/457 passed** |
| Deploy / merge / staging migration | none performed |
